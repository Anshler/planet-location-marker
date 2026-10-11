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
import { serializeHash } from '../core/url-state.js';

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

/** Human names of the layer switches (announcements). */
export const LAYER_LABELS = Object.freeze({
    beams: 'Beams', ghostBeams: 'Through-Earth beams', sunMoonBeams: 'Sun and Moon beams', stars: 'Stars',
    constellations: 'Constellation lines', constellationNames: 'Constellation names', starNames: 'Star names',
    milkyWay: 'Milky Way', clouds: 'Clouds', atmosphere: 'Atmosphere', ecliptic: 'Ecliptic', eqGrid: 'Equatorial grid',
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
 * Where the Moon's shadow axis meets the Earth at a snapshot instant (lat/lon), or the point of
 * closest approach when the axis misses (partial eclipse).
 * @param {import('../core/types.js').Snapshot} snap
 * @returns {{latDeg:number, lonDeg:number}}
 */
export function shadowPoint(snap) {
    const m = snap.moonPosS, s = snap.sunDirS;
    // Axis: P(t) = m − t·s (from the Moon, away from the Sun). |P|² = 1 → t² − 2t(m·s) + |m|² − 1 = 0.
    const ms = m[0] * s[0] + m[1] * s[1] + m[2] * s[2];
    const mm = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
    const disc = ms * ms - mm + 1;
    const t = disc >= 0 ? ms - Math.sqrt(disc) : ms;
    let x = m[0] - t * s[0], y = m[1] - t * s[1], z = m[2] - t * s[2];
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    // Earth-fixed (geometry-local) direction: Eᵀ·P, then localToLatLon (SPEC §D.3).
    const e = snap.earthMatrix;
    const lx = e[0] * x + e[1] * y + e[2] * z;
    const ly = e[4] * x + e[5] * y + e[6] * z;
    const lz = e[8] * x + e[9] * y + e[10] * z;
    return { latDeg: Math.asin(clamp(ly, -1, 1)) * 180 / Math.PI, lonDeg: Math.atan2(-lz, lx) * 180 / Math.PI };
}

/**
 * Creates the action API.
 *
 * @param {{store:any, bus:any, clock:any, prefs:any, tz?:any,
 *          cities?:any,
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
    let eventFlyTimer = 0;

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
     * Brings a body into view: in sky view the camera turns to it; in orbit view the camera flies
     * to look along its beam.
     * @param {string} id
     */
    function flyToBody(id) {
        if (!isBodyId(id)) return;
        const r = rig();
        const snap = getSnap();
        if (!r || !snap) return;
        const b = snap.bodies[BODY_INDEX[id]];
        if (!b) return;
        const animate = !reducedMotion();
        if (store.get().view.mode === 'sky') {
            settle(r.setMode?.('sky', { animate, look: { azDeg: b.azGeomDeg, altDeg: Math.max(-5, b.altGeomDeg) } }));
        } else {
            settle(r.flyToDir?.(b.dirS, { animate }));
        }
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
     * Jumps to an event: pauses, sweeps the clock there, applies the event's selection and view,
     * and for a solar eclipse flies the camera over the Moon's shadow.
     * @param {AstroEvent} ev
     */
    function jumpToEvent(ev) {
        const tMs = Number(ev?.tMs);
        if (!Number.isFinite(tMs)) return;
        const animateMs = reducedMotion() ? 0 : JUMP_ANIMATE_MS;
        clock.pause();
        clock.setTime(tMs, { animateMs });
        if (ev.select && isBodyId(ev.select)) select(ev.select);
        if (ev.view && VIEW_MODES.has(ev.view)) setViewMode(ev.view);
        clearTimeout(eventFlyTimer);
        if (!rig()) return;
        // Aim once the time sweep has landed, from a snapshot at the event's own instant (the
        // loop's may still be catching up), so the target is right with or without Earth-lock.
        eventFlyTimer = setTimeout(() => {
            try {
                const mode = store.get().view.mode;
                const animate = !reducedMotion();
                scratchSnap ??= createSnapshot();
                computeSnapshot(tMs, store.get().observer, scratchSnap, { detail: 'frame' });
                if (mode === 'orbit' && (ev.kind === 'solar-eclipse' || ev.kind === 'local-solar-eclipse')) {
                    // Over the Moon's shadow: greatest eclipse when known, else where the axis meets the Earth.
                    const g = ev.geo;
                    const p = g && Number.isFinite(g.latDeg) && Number.isFinite(g.lonDeg) ? g : shadowPoint(scratchSnap);
                    settle(rig()?.flyToLatLon?.(p.latDeg, p.lonDeg, { distance: 2.6, animate }));
                } else if (mode === 'sky' && ev.select && isBodyId(ev.select)) {
                    // Sky events: turn to the selected body as it stands at the event.
                    const b = scratchSnap.bodies[BODY_INDEX[ev.select]];
                    if (b && b.altGeomDeg > -5) {
                        settle(rig()?.setMode?.('sky', { animate, look: { azDeg: b.azGeomDeg, altDeg: b.altGeomDeg } }));
                    }
                }
            } catch { /* the jump itself already happened */ }
        }, animateMs + 60);
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
        toggleDebug, openPalette, shareUrl,
        /** True when an undo is available. */
        get canUndo() { return undoStack.length > 0; },
    };
}

