// The app's action API (SPEC §C.9): the only way the UI changes the app besides `store` and `clock`.
//
// Actions validate input, update the store, and steer the render stack when it exists. Render
// objects (rig, beams, pin, …) arrive after the UI has mounted, so they are read lazily from the
// mutable `render` holder that main.js fills in; every action degrades to a sensible no-op in text
// mode.
//
// Division of labour with the UI (G7 js/ui/index.js): the UI's narrator already announces observer,
// selection and time changes, shows the Undo toast for click placements and the 1000–3000 clamp
// toast. Actions therefore only emit feedback the UI cannot infer from state (share result,
// geolocation errors, Undo for non-click moves, failures).

import { APP_NAME } from '../version.js';
import { BODY_INDEX, isBodyId } from '../astro/bodies.js';
import { createSnapshot, computeSnapshot } from '../astro/snapshot.js';
import { eclipsePath, citiesInPath, nearestCentrePoint, shadowPoint } from '../astro/eclipse-path.js';
import { localSolarEclipseAt } from '../astro/events.js';
import { serializeHash } from '../core/url-state.js';

export { shadowPoint };

/** @typedef {import('../core/types.js').Observer} Observer */
/** @typedef {import('../core/types.js').AstroEvent} AstroEvent */

/** A clicked point takes the timezone (and "near …" name) of a city at most this far away. */
export const NEAR_CITY_KM = 300;
/** Within this distance the observer simply takes the city's name. */
const AT_CITY_KM = 15;
/** Sources that represent a deliberate user choice (persisted, remembered in recent places). */
export const USER_SOURCES = Object.freeze(['click', 'city', 'search', 'geo', 'manual']);
const OBSERVER_SOURCES = new Set(['default', 'url', 'saved', 'tzguess', 'click', 'city', 'search', 'geo', 'manual']);
const VIEW_MODES = new Set(['orbit', 'sky']);
const TZ_MODES = new Set(['observer', 'device', 'utc']);
const QUALITY_SETTINGS = new Set(['auto', 'low', 'medium', 'high']);
const MAX_UNDO = 12;
const MAX_RECENT = 8;
const JUMP_ANIMATE_MS = 1400;
/** An event flight lasts the time sweep plus this (the globe ↔ sky transitions take 1.8 s). */
const EVENT_FLY_EXTRA_MS = 400;
const DAY_MS = 864e5;
/** A total or annular eclipse jump lands this long before second contact, playing at 1×. */
export const ECLIPSE_LEAD_MS = 20e3;
/** Sky-view fields of view of eclipse framings: the central phase and lunar eclipses fill 5°. */
export const ECLIPSE_FOV_DEG = 5;
export const PARTIAL_ECLIPSE_FOV_DEG = 10;
/** AE eclipse altitudes are the refracted centre; the Sun's upper limb is this much higher. */
const SUN_LIMB_DEG = 0.27;
const MAX_PATHS = 4;

/** Human names of the layer switches (announcements). */
export const LAYER_LABELS = Object.freeze({
    beams: 'Beams', ghostBeams: 'Through-Earth beams', sunMoonBeams: 'Sun and Moon beams', stars: 'Stars',
    constellations: 'Constellation lines', constellationNames: 'Constellation names', starNames: 'Star names',
    milkyWay: 'Milky Way', clouds: 'Clouds', atmosphere: 'Atmosphere', ecliptic: 'Ecliptic', eqGrid: 'Equatorial grid (of date)',
    altAzGrid: 'Horizon grid', horizon: 'Horizon disc', footprint: 'Visibility footprint', subpoints: 'Sub-points',
    trails: 'Path of selected body', labels: 'Labels',
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const wrap180 = (x) => {
    const w = ((((x + 180) % 360) + 360) % 360) - 180;
    return w === -180 && x > 0 ? 180 : w;
};
const noop = () => {};
/** Swallows the rejection of a fire-and-forget promise (camera flights, pin drops…). */
const settle = (p) => {
    if (p && typeof p.catch === 'function') p.catch(noop);
    return p;
};
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/** A usable IANA zone id, or null (validated through tz.canonTz when available). */
function validZone(zone, tz) {
    const z = trimmed(zone);
    if (!z) return null;
    if (!tz) return z;
    try {
        if (typeof tz.canonTz === 'function') return tz.canonTz(z) === null ? null : z;
        return tz.isValidTz?.(z) === false ? null : z;
    } catch {
        return null;
    }
}

/** Nearest offline city within NEAR_CITY_KM as {city, km}, or null. */
function nearestCity(cities, latDeg, lonDeg) {
    try {
        const r = cities?.nearest?.(latDeg, lonDeg, NEAR_CITY_KM);
        return r?.city && Number.isFinite(r.km) && r.km <= NEAR_CITY_KM ? r : null;
    } catch {
        return null;
    }
}

/** Zone from the nearby city, else the longitude's nautical zone (approximate). */
function zoneFor(near, lonDeg, tz) {
    if (near?.city?.tz) return { zone: near.city.tz, approx: false };
    let zone = null;
    try {
        zone = tz?.approxTzForLon?.(lonDeg) ?? null;
    } catch {
        zone = null;
    }
    return { zone, approx: true };
}

/** "Lyon" (within 15 km), "near Lyon" (within 300 km), the poles, or '' (the UI shows coordinates). */
function nameFor(near, latDeg) {
    if (near) return near.km <= AT_CITY_KM ? near.city.name : `near ${near.city.name}`;
    if (latDeg >= 89.5) return 'North Pole';
    if (latDeg <= -89.5) return 'South Pole';
    return '';
}

/** Country display name from the ISO code, the nearby city, or nothing. */
function countryFor(cc, near, cities) {
    let name = '';
    if (cc) {
        try {
            name = cities?.countryName?.(cc) || '';
        } catch {
            name = '';
        }
        if (name && name !== cc) return name;
        if (near?.city?.cc === cc) return near.city.country ?? cc;
        return name;
    }
    return near?.city?.country ?? '';
}

/**
 * Validates and completes an observer.
 *
 * - latitude is clamped to ±90°, longitude wrapped to ±180°, elevation clamped to −500…9000 m;
 * - a missing or invalid `tz` comes from the nearest city within 300 km, otherwise from
 *   `approxTzForLon` with `tzApprox: true`;
 * - a missing `name` becomes the city name (within 15 km), "near <city>" (within 300 km),
 *   "North Pole"/"South Pole", or stays empty (the UI then shows coordinates);
 * - a missing `country` comes from the ISO code (`cc`) or the nearby city.
 *
 * @param {Partial<Observer> & {latDeg:number, lonDeg:number, source?:string, cc?:string}} input
 * @param {{cities?:any, tz?:any}} services
 * @returns {Observer & {cc?:string}}
 * @throws {RangeError} when the coordinates are not finite numbers
 */
export function normalizeObserver(input, { cities = null, tz = null } = {}) {
    const lat = Number(input?.latDeg);
    const lon = Number(input?.lonDeg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RangeError('Observer coordinates must be finite numbers');
    const latDeg = clamp(lat, -90, 90);
    const lonDeg = wrap180(lon);
    const elev = Number(input.elevM);
    const elevM = Number.isFinite(elev) ? clamp(elev, -500, 9000) : 0;

    let name = trimmed(input.name);
    let country = trimmed(input.country);
    let cc = /^[A-Za-z]{2}$/.test(trimmed(input.cc)) ? trimmed(input.cc).toUpperCase() : '';
    let zone = validZone(input.tz, tz);
    let tzApprox = !!input.tzApprox;

    const near = !zone || !name || !country ? nearestCity(cities, latDeg, lonDeg) : null;
    if (!zone) ({ zone, approx: tzApprox } = zoneFor(near, lonDeg, tz));
    if (!name) {
        name = nameFor(near, latDeg);
        if (near && !cc && near.city.cc) cc = near.city.cc;
    }
    if (!country && (cc || near)) country = countryFor(cc, near, cities);

    const source = OBSERVER_SOURCES.has(input.source) ? input.source : 'manual';
    /** @type {Observer & {cc?:string}} */
    const obs = { latDeg, lonDeg, elevM, name, country, tz: zone, tzApprox: !!zone && tzApprox, source };
    if (cc) obs.cc = cc;
    return obs;
}

/** Observer → Place-like record for "Recent places". */
function toPlace(o) {
    return {
        name: o.name || '', admin: '', country: o.country || '', cc: o.cc || '',
        lat: Math.round(o.latDeg * 1e4) / 1e4, lon: Math.round(o.lonDeg * 1e4) / 1e4,
        tz: o.tz ?? null, pop: 0, source: 'offline',
    };
}

function sameSpot(a, b) {
    return !!a && !!b && Math.abs(a.latDeg - b.latDeg) < 1e-6 && Math.abs(a.lonDeg - b.lonDeg) < 1e-6
        && (a.elevM ?? 0) === (b.elevM ?? 0) && a.name === b.name && a.tz === b.tz;
}

/**
 * How an event jump frames its event (pure; jumpToEvent applies it):
 * - a local total or annular solar eclipse whose central phase is (partly) above the horizon
 *   lands 20 s before second contact (before third when only C3 is up: totality at sunrise) and
 *   plays at 1×, looking at the Sun mid-way through what follows at a 5° field;
 * - any other local solar eclipse lands paused on its `visibleMs` (maximum, or the visible part
 *   nearest it) at 10°; a lunar eclipse seen from here on its `visibleMs` at 5° on the Moon;
 * - everything else lands paused on its instant with the current field.
 * `aimMs` is the instant whose sky the look is aimed at (equal to `tMs` unless playing).
 * @param {AstroEvent & Record<string, any>} ev
 * @returns {{tMs:number, aimMs:number, play:boolean, fovDeg:number|undefined}|null}
 */
export function eventFraming(ev) {
    const t = Number(ev?.tMs);
    if (!Number.isFinite(t)) return null;
    const vis = Number.isFinite(ev.visibleMs) ? ev.visibleMs : t;
    if (ev.kind === 'local-solar-eclipse') {
        const c2 = ev.c2Ms, c3 = ev.c3Ms, alt = ev.sunAltDeg ?? {};
        const up = (a) => Number.isFinite(a) && a + SUN_LIMB_DEG > 0;
        if (ev.eclipseKind !== 'partial' && Number.isFinite(c2) && Number.isFinite(c3) && (up(alt.c2) || up(alt.c3))) {
            const land = (up(alt.c2) ? c2 : c3) - ECLIPSE_LEAD_MS;
            return { tMs: land, aimMs: (land + c3) / 2, play: true, fovDeg: ECLIPSE_FOV_DEG };
        }
        return { tMs: vis, aimMs: vis, play: false, fovDeg: PARTIAL_ECLIPSE_FOV_DEG };
    }
    if (ev.kind === 'lunar-eclipse' && ev.view === 'sky') return { tMs: vis, aimMs: vis, play: false, fovDeg: ECLIPSE_FOV_DEG };
    return { tMs: t, aimMs: t, play: false, fovDeg: undefined };
}

/**
 * The solar eclipse in focus (store `ui.eclipse`, set by an eclipse jump) lapses once simulated
 * time is more than a day from its peak, but never during the jump's own time sweep.
 * @param {{peakMs:number}|null|undefined} focus
 * @param {number} tMs
 * @param {boolean} tweening the clock is sweeping (clock.tweening)
 * @returns {boolean}
 */
export function eclipseFocusExpired(focus, tMs, tweening) {
    return !!focus && !tweening && Number.isFinite(tMs) && Math.abs(tMs - focus.peakMs) > DAY_MS;
}

/**
 * The sky look at the selected body when it is above the horizon, else undefined (the rig's
 * default look).
 * @param {string|null|undefined} selection
 * @param {import('../core/types.js').Snapshot|null|undefined} snap
 * @returns {{azDeg:number, altDeg:number}|undefined}
 */
export function selectionLook(selection, snap) {
    if (!selection || !isBodyId(selection)) return undefined;
    const b = snap?.bodies?.[BODY_INDEX[selection]];
    return b && b.altGeomDeg > 0 ? { azDeg: b.azGeomDeg, altDeg: b.altGeomDeg } : undefined;
}

/**
 * The look a view-mode change asks the rig for (main.js's view.mode subscriber): entering sky view
 * turns to the selected body. An event jump (store source 'event') has already aimed the rig at the
 * event's own instant (jumpToEvent); a look from the pre-sweep frame would queue a second move
 * after it, so it gets none.
 * @param {string} mode the new view.mode
 * @param {string|undefined} source the store.set source of the change
 * @param {string|null|undefined} selection
 * @param {import('../core/types.js').Snapshot|null|undefined} snap
 * @returns {{azDeg:number, altDeg:number}|undefined}
 */
export function viewModeLook(mode, source, selection, snap) {
    return mode === 'sky' && source !== 'event' ? selectionLook(selection, snap) : undefined;
}

/**
 * Creates the action API.
 *
 * @param {{store:any, bus:any, clock:any, prefs:any, tz?:any,
 *          cities?:any, astro?:import('../astro/client.js').AstroClient|null,
 *          render:{rig?:any, beams?:any, pin?:any, earth?:any, governor?:any},
 *          getSnap?:()=>import('../core/types.js').Snapshot|null,
 *          runIntro?:(opts?:{force?:boolean})=>Promise<unknown>,
 *          toggleDebug?:()=>boolean,
 *          win?:Window, doc?:Document, nav?:Navigator}} deps
 * @returns {object} Actions
 */
export function createActions(deps) {
    const { store, bus, clock, prefs, tz = null, cities = null } = deps;
    const render = deps.render ?? {};
    const win = deps.win ?? (typeof window !== 'undefined' ? window : null);
    const doc = deps.doc ?? (typeof document !== 'undefined' ? document : null);
    const nav = deps.nav ?? (typeof navigator !== 'undefined' ? navigator : null);
    const getSnap = deps.getSnap ?? (() => null);

    /** @type {Observer[]} */
    const undoStack = [];
    let scratchSnap = null;

    const toast = (message, kind = 'info', extra = {}) => bus.emit('toast', { message, kind, ...extra });
    const say = (text) => bus.emit('announce', text);
    const reducedMotion = () => !!store.get().status?.reducedMotion;
    const rig = () => render.rig ?? null;
    const has3d = () => !!render.rig && store.get().status?.webgl !== false;

    function camDistance(fallback = 3.4) {
        const p = rig()?.camera?.position;
        const d = p ? Math.hypot(p.x, p.y, p.z) : NaN;
        return Number.isFinite(d) && d > 1.05 ? d : fallback;
    }

    function openPalette() {
        const ui = store.get().ui;
        store.set({ ui: { ...ui, palette: true } }, 'actions');
    }

    function rememberPlace(obs) {
        let list = [];
        try {
            list = prefs.load('recentPlaces', []);
        } catch {
            list = [];
        }
        if (!Array.isArray(list)) list = [];
        const p = toPlace(obs);
        const next = [p, ...list.filter((q) => q && !(Math.abs(q.lat - p.lat) < 1e-3 && Math.abs(q.lon - p.lon) < 1e-3))]
            .slice(0, MAX_RECENT);
        try {
            prefs.save('recentPlaces', next);
        } catch { /* in-memory only */ }
    }

    function persistObserver(obs) {
        try {
            if (USER_SOURCES.includes(obs.source)) prefs.save('observer', obs);
            else if (obs.source === 'default' || obs.source === 'tzguess') prefs.remove?.('observer');
        } catch { /* storage is optional */ }
    }

    /**
     * Moves the observer. See normalizeObserver for the completion rules.
     * @param {Partial<Observer> & {latDeg:number, lonDeg:number, source:string}} obs
     * @param {{fly?:boolean, undoable?:boolean}} [opts]
     * @returns {Observer|null} the observer actually set
     */
    function setObserver(obs, { fly = true, undoable = false } = {}) {
        let next;
        try {
            next = normalizeObserver(obs, { cities, tz });
        } catch {
            toast('Those coordinates are not valid.', 'warn');
            return null;
        }
        const prev = store.get().observer;
        if (sameSpot(prev, next)) return prev;
        if (undoable && prev) {
            undoStack.push(prev);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
        }
        store.set({ observer: next }, 'actions');
        persistObserver(next);
        if (USER_SOURCES.includes(next.source)) rememberPlace(next);
        // The UI shows its own Undo toast for click placements; other undoable moves get one here.
        if (undoable && next.source !== 'click') {
            toast(`Observer moved to ${next.name || 'the new location'}${next.country ? ', ' + next.country : ''}`, 'info', {
                actionLabel: 'Undo', onAction: () => undoObserver(), timeoutMs: 8000,
            });
        }
        const r = rig();
        if (r && store.get().view.mode === 'orbit') {
            if (fly) settle(r.flyToLatLon?.(next.latDeg, next.lonDeg, { distance: clamp(camDistance(), 1.6, 150) }));
            if (!reducedMotion()) {
                try {
                    settle(render.pin?.drop?.());
                } catch { /* cosmetic */ }
            }
        }
        return next;
    }

    /** Restores the observer from before the last undoable move. */
    function undoObserver() {
        const prev = undoStack.pop();
        if (!prev) return;
        store.set({ observer: prev }, 'actions');
        persistObserver(prev);
        const r = rig();
        if (r && store.get().view.mode === 'orbit') settle(r.flyToLatLon?.(prev.latDeg, prev.lonDeg, { distance: clamp(camDistance(), 1.6, 150) }));
    }

    /** "Use my location": asks the browser (button only, never on load). */
    async function locateMe() {
        const geo = nav?.geolocation;
        if (!geo || typeof geo.getCurrentPosition !== 'function') {
            toast("Location isn't available in this browser.", 'warn');
            openPalette();
            return;
        }
        say('Finding your location…');
        try {
            const pos = await new Promise((resolve, reject) => {
                geo.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
            });
            const c = pos.coords;
            setObserver({ latDeg: c.latitude, lonDeg: c.longitude, elevM: Number.isFinite(c.altitude) ? c.altitude : 0, source: 'geo' },
                { fly: true, undoable: true });
        } catch (err) {
            if (err && err.code === 1) {
                toast('Location permission denied.', 'warn');
                openPalette();
            } else if (err && err.code === 3) {
                toast('Finding your location took too long. Try again, or search for a place.', 'warn');
            } else {
                toast("Couldn't determine your location. Search for a place instead.", 'warn');
            }
        }
    }

    /**
     * Selects a body (or clears the selection).
     * @param {string|null} id
     * @param {{fly?:boolean}} [opts]
     */
    function select(id, { fly = false } = {}) {
        const next = id == null || id === '' ? null : String(id);
        if (next !== null && !isBodyId(next)) return;
        store.set({ selection: next }, 'actions');
        if (next && fly) flyToBody(next);
    }

    /**
     * Brings a body into view ('Center'): in sky view the camera turns to it; in globe view the
     * camera moves to the far side of the globe, so the body sits just past the limb with the
     * observer's beam crossing the globe toward it. The Moon is framed where its mesh is drawn,
     * ~60 R out, so parallax from the camera cannot tuck it behind the limb.
     * @param {string} id
     */
    function flyToBody(id) {
        const b = bodyNow(id);
        if (!b) return;
        const animate = !reducedMotion();
        if (store.get().view.mode === 'sky') {
            settle(rig().setMode?.('sky', { animate, look: { azDeg: b.azGeomDeg, altDeg: Math.max(-5, b.altGeomDeg) } }));
        } else {
            const point = id === 'moon' ? getSnap()?.moonPosS ?? null : null;
            settle(rig().frameDir?.(b.dirS, { animate, point }));
        }
    }

    /**
     * 'View from <body>': the globe as the body sees it, the camera on the body's direction over
     * the place where it stands overhead (the body itself is behind the camera). In sky view it
     * turns to the body, like flyToBody.
     * @param {string} id
     */
    function viewFromBody(id) {
        const b = bodyNow(id);
        if (!b) return;
        if (store.get().view.mode === 'sky') {
            flyToBody(id);
            return;
        }
        settle(rig().flyToDir?.(b.dirS, { animate: !reducedMotion() }));
    }

    /** The body's entry in the current frame snapshot, when the 3D view is there to steer. */
    function bodyNow(id) {
        if (!isBodyId(id) || !rig()) return null;
        const snap = getSnap();
        return snap?.bodies?.[BODY_INDEX[id]] ?? null;
    }

    /** @param {'orbit'|'sky'} mode */
    function setViewMode(mode) {
        if (!VIEW_MODES.has(mode)) return;
        const view = store.get().view;
        if (view.mode === mode) return;
        store.set({ view: { ...view, mode } }, 'actions');
    }

    function cycleView() {
        setViewMode(store.get().view.mode === 'orbit' ? 'sky' : 'orbit');
    }

    /** @param {boolean} on */
    function setEarthLock(on) {
        const view = store.get().view;
        const next = on === undefined ? !view.earthLock : !!on;
        if (view.earthLock === next) return;
        store.set({ view: { ...view, earthLock: next } }, 'actions');
        say(next ? 'View locked to Earth' : 'View unlocked: the Earth turns beneath you');
    }

    /**
     * @param {string} key a Layers key
     * @param {boolean} [on] omitted → toggle
     */
    function toggleLayer(key, on) {
        const layers = store.get().layers;
        if (!Object.hasOwn(layers, key)) return;
        const next = on === undefined ? !layers[key] : !!on;
        if (layers[key] === next) return;
        store.set({ layers: { ...layers, [key]: next } }, 'actions');
        say(`${LAYER_LABELS[key] ?? key} ${next ? 'on' : 'off'}`);
    }

    /** @param {'auto'|'low'|'medium'|'high'} setting */
    function setQuality(setting) {
        if (!QUALITY_SETTINGS.has(setting)) return;
        const q = store.get().quality;
        const gov = render.governor ?? null;
        let active = q.active;
        if (gov && typeof gov.pin === 'function') {
            try {
                active = gov.pin(setting === 'auto' ? null : setting);
            } catch {
                active = setting === 'auto' ? q.ceiling : setting;
            }
        } else {
            active = setting === 'auto' ? q.ceiling : setting;
        }
        store.set({ quality: { ...q, setting, active } }, 'actions');
        say(setting === 'auto' ? `Quality: automatic (${active})` : `Quality: ${setting}`);
    }

    /** @param {'observer'|'device'|'utc'} m */
    function setTzMode(m) {
        if (!TZ_MODES.has(m)) return;
        const display = store.get().display;
        if (display.tzMode === m) return;
        store.set({ display: { ...display, tzMode: m } }, 'actions');
    }

    /** The shareable URL for the current state (camera included). */
    function shareUrl() {
        let cam = null;
        try {
            cam = render.rig?.getView?.() ?? null;
        } catch {
            cam = null;
        }
        const hash = serializeHash({ state: store.get(), clock, cam });
        const loc = win?.location;
        if (!loc) return hash;
        return `${loc.origin && loc.origin !== 'null' ? loc.origin : ''}${loc.pathname}${loc.search}${hash}`;
    }

    async function copyText(text) {
        try {
            if (nav?.clipboard?.writeText) {
                await nav.clipboard.writeText(text);
                return true;
            }
        } catch { /* fall through to the legacy path */ }
        if (!doc?.body) return false;
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        doc.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
            ok = doc.execCommand('copy');
        } catch {
            ok = false;
        }
        ta.remove();
        return ok;
    }

    /**
     * Shares a deep link to exactly this view (camera included): the native share sheet when
     * available, otherwise the clipboard. Resolves 'shared' | 'copied' | 'failed'. Feedback is the
     * caller's (the UI's view switch shows "Link copied" or a dialog with a selectable link), so
     * nothing is toasted here. A share sheet the user dismissed counts as 'shared': the system UI
     * was shown and there is nothing left to do.
     */
    async function share() {
        const url = shareUrl();
        const o = store.get().observer;
        const from = o.name ? o.name.replace(/^near /, '') : 'here';
        const data = { title: APP_NAME, text: `Where the planets are from ${from} — ${APP_NAME}`, url };
        if (typeof nav?.share === 'function') {
            let can = true;
            try {
                can = typeof nav.canShare === 'function' ? nav.canShare(data) : true;
            } catch {
                can = true;
            }
            if (can) {
                try {
                    await nav.share(data);
                    return 'shared';
                } catch (err) {
                    if (err && err.name === 'AbortError') return 'shared';
                    // Any other failure (no user activation, blocked): fall back to the clipboard.
                }
            }
        }
        return (await copyText(url)) ? 'copied' : 'failed';
    }

    function toggleFullscreen() {
        if (!doc) return;
        const el = doc.documentElement;
        const active = doc.fullscreenElement || doc.webkitFullscreenElement;
        try {
            if (active) {
                settle((doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc));
                return;
            }
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            if (typeof req !== 'function') {
                toast("Fullscreen isn't available on this device.", 'info');
                return;
            }
            const p = req.call(el, { navigationUI: 'hide' });
            if (p && typeof p.catch === 'function') p.catch(() => toast("Fullscreen isn't available here.", 'info'));
        } catch {
            toast("Fullscreen isn't available here.", 'info');
        }
    }

    function toggleCinema() {
        const ui = store.get().ui;
        const cinema = !ui.cinema;
        store.set({ ui: { ...ui, cinema } }, 'actions');
        say(cinema ? 'Interface hidden. Press H to show it again.' : 'Interface shown');
    }

    function resetCamera() {
        const r = rig();
        if (!r) return;
        settle(r.home?.());
    }

    function replayIntro() {
        if (!has3d() || typeof deps.runIntro !== 'function') {
            toast('The intro needs the 3D view.', 'info');
            return;
        }
        settle(deps.runIntro({ force: true }));
    }

    /**
     * Jumps to an event: sweeps the clock there (to the instant eventFraming picks, paused, or
     * playing at 1× for a central solar eclipse), applies the event's selection and view, and
     * moves the camera in one shot that overlaps the sweep: over the Moon's shadow for a solar
     * eclipse in globe view, toward the selected body in sky view (at the framing's field of
     * view). A solar eclipse becomes the eclipse in focus (`ui.eclipse`); any other event clears it.
     * @param {AstroEvent} ev
     */
    function jumpToEvent(ev) {
        const plan = eventFraming(ev);
        if (!plan) return;
        const animateMs = reducedMotion() ? 0 : JUMP_ANIMATE_MS;
        clock.pause();
        clock.setTime(plan.tMs, { animateMs });
        if (plan.play) {
            clock.setRate?.(1);
            clock.play?.();
        }
        if (ev.select && isBodyId(ev.select)) select(ev.select);
        setEclipseFocus(ev);
        const view = store.get().view;
        const mode = ev.view && VIEW_MODES.has(ev.view) ? ev.view : view.mode;
        // Aim before the view changes: the rig then already heads for the event's mode, and the
        // view.mode subscriber (main.js) joins that transition instead of queuing a second leg. The
        // 'event' source tells it not to add a look of its own from the pre-sweep frame.
        if (rig()) {
            try {
                aimAtEvent(ev, plan, mode, animateMs);
            } catch { /* the jump itself still happens */ }
        }
        if (view.mode !== mode) store.set({ view: { ...view, mode } }, 'event');
    }

    /** ui.eclipse = {peakMs, kind, local, eventId} for a solar eclipse event, else null. */
    function setEclipseFocus(ev) {
        const solar = ev.kind === 'solar-eclipse' || ev.kind === 'local-solar-eclipse';
        const ui = store.get().ui;
        const eclipse = solar
            ? { peakMs: Number(ev.tMs), kind: ev.eclipseKind ?? null, local: ev.kind === 'local-solar-eclipse', eventId: ev.id ?? null }
            : null;
        if (!eclipse && !ui.eclipse) return;
        store.set({ ui: { ...ui, eclipse } }, 'actions');
    }

    /**
     * The camera move of an event jump, aimed from a snapshot at the framing's aim instant (the
     * loop's frame still shows the start of the sweep). Rig flights are Earth-fixed and sky looks
     * are horizon-fixed, so both can run while the clock sweeps. An animated flight outlasts the
     * sweep, so that with Earth-lock off the turning Earth cannot carry the target away after it.
     */
    function aimAtEvent(ev, plan, mode, animateMs) {
        const r = rig();
        const animate = animateMs > 0;
        scratchSnap ??= createSnapshot();
        computeSnapshot(plan.aimMs, store.get().observer, scratchSnap, { detail: 'frame' });
        if (mode === 'orbit' && (ev.kind === 'solar-eclipse' || ev.kind === 'local-solar-eclipse')) {
            // Over the Moon's shadow: greatest eclipse when known, else where the axis meets the Earth.
            // From sky view this is the sky → globe transition itself, ending over the shadow.
            const g = ev.geo;
            const p = g && Number.isFinite(g.latDeg) && Number.isFinite(g.lonDeg) ? g : shadowPoint(scratchSnap);
            settle(r.flyToLatLon?.(p.latDeg, p.lonDeg, { distance: 2.6, animate, durationMs: animateMs + EVENT_FLY_EXTRA_MS }));
        } else if (mode === 'sky' && ev.select && isBodyId(ev.select)) {
            // Sky events: turn to the selected body as it stands at the event.
            const b = scratchSnap.bodies[BODY_INDEX[ev.select]];
            if (b && b.altGeomDeg > -5) {
                const look = { azDeg: b.azGeomDeg, altDeg: b.altGeomDeg };
                if (Number.isFinite(plan.fovDeg)) look.fovDeg = plan.fovDeg;
                settle(r.setMode?.('sky', { animate, look }));
            }
        }
    }

    /** In-flight or finished eclipse-path requests by minute of peak (small LRU). */
    const paths = new Map();

    /**
     * The path of the central solar eclipse near `peakMs` (eclipse-path.js: centre line, limits,
     * greatest eclipse) with `cities`, the largest offline cities inside the band
     * ({city: Place, durS, c2Ms, c3Ms, maxMs, sunAltDeg, kind, km, index}), computed in the astro
     * worker and cached, so the panel and the globe share one request. Resolves null for an
     * eclipse with no central line.
     * @param {number} peakMs
     * @returns {Promise<object|null>}
     */
    function eclipsePathFor(peakMs) {
        const t = Number(peakMs);
        if (!Number.isFinite(t)) return Promise.resolve(null);
        const list = cities?.list ?? [];
        const key = `${Math.round(t / 60000)}:${list.length}`;
        let p = paths.get(key);
        if (!p) {
            const astro = deps.astro;
            p = astro?.eclipsePath
                ? Promise.resolve(astro.eclipsePath(t, { cities: list, n: 12 }))
                : new Promise((resolve) => {
                    // No worker client: compute here (≈ 10–40 ms), after the current task.
                    setTimeout(() => {
                        try {
                            const path = eclipsePath(t);
                            if (path) path.cities = citiesInPath(path, list, 12).map((c) => ({ ...c, city: list[c.index] ?? null }));
                            resolve(path);
                        } catch {
                            resolve(null);
                        }
                    }, 0);
                });
            p = p.catch((err) => {
                paths.delete(key);
                throw err;
            });
            paths.set(key, p);
            if (paths.size > MAX_PATHS) paths.delete(paths.keys().next().value);
        }
        return p;
    }

    /**
     * 'Stand in the path': moves the observer onto the centre line of a central solar eclipse,
     * at the point nearest the current observer (or at greatest eclipse, `at: 'greatest'`), with
     * the usual observer-change semantics (named after the nearest city, saved, Undo toast), then
     * jumps to the eclipse as seen from there (eventFraming: 20 s before second contact, playing).
     * Resolves the new observer, or null when the eclipse has no path on Earth.
     * @param {number|AstroEvent} target an eclipse event or its peak time (ms)
     * @param {{at?:'nearest'|'greatest'}} [opts]
     * @returns {Promise<Observer|null>}
     */
    async function standInPath(target, { at = 'nearest' } = {}) {
        const peakMs = typeof target === 'number' ? target : Number(target?.tMs);
        if (!Number.isFinite(peakMs)) return null;
        let path = null;
        try {
            path = await eclipsePathFor(peakMs);
        } catch {
            path = null;
        }
        if (!path) {
            toast('This eclipse has no path of totality or annularity on Earth.', 'info');
            return null;
        }
        const o = store.get().observer;
        const p = (at !== 'greatest' && nearestCentrePoint(path, o.latDeg, o.lonDeg)) || path.greatest;
        const next = setObserver({ latDeg: p.latDeg, lonDeg: p.lonDeg, elevM: 0, source: 'manual' }, { fly: false, undoable: true });
        if (!next) return null;
        let ev = null;
        try {
            ev = localSolarEclipseAt(next, path.peakMs, { tz: next.tz || undefined, hour12: !!store.get().display?.hour12 });
        } catch {
            ev = null;
        }
        jumpToEvent(ev ?? {
            kind: 'solar-eclipse', tMs: path.peakMs, select: 'sun', view: 'orbit', eclipseKind: path.kind,
            geo: { latDeg: path.greatest.latDeg, lonDeg: path.greatest.lonDeg },
        });
        return next;
    }

    function toggleDebug() {
        if (typeof deps.toggleDebug !== 'function') return false;
        return deps.toggleDebug();
    }

    return {
        setObserver, undoObserver, locateMe,
        select, flyToBody, setViewMode, cycleView, setEarthLock,
        toggleLayer, setQuality, setTzMode, share,
        toggleFullscreen, toggleCinema, resetCamera, replayIntro, jumpToEvent,
        // Extensions beyond SPEC §C.9 (used by shortcuts / the shell when present).
        toggleDebug, openPalette, shareUrl, viewFromBody,
        // Eclipse 2027 (ROADMAP Phase 1): the shared path request and 'Stand in the path'.
        eclipsePath: eclipsePathFor, standInPath,
        /** True when an undo is available. */
        get canUndo() { return undoStack.length > 0; },
    };
}

