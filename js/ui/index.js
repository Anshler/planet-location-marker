/**
 * UI entry point: `mountUI(rootEl, ctx)` builds the whole interface inside `#ui-root`.
 *
 * The UI talks to the app only through `ctx.store`, `ctx.clock`, `ctx.actions`,
 * `ctx.bus` and `ctx.services` (rule R3). Internally it adds a private `ctx.ui`
 * hub that every UI module receives:
 *
 * - shared data: the latest full Snapshot, almanac results (rise/set, tonight,
 *   twilight, sun-altitude series) and the event list, each kept fresh for the
 *   *simulated* time and current observer (requests go through `services.astro`);
 * - formatting helpers that print times in the display timezone
 *   (`display.tzMode`: observer / device / UTC) exactly as the copy in SPEC §F asks;
 * - navigation hooks filled in by the shell (open a tab, the palette, help, share…).
 *
 * It also runs the narrator (polite announcements for observer / selection / time
 * changes) and refreshes the canvas `aria-label` summary every 4 s.
 *
 * G8 should call only `mountUI`; it mounts toasts, the announcer and keyboard
 * shortcuts itself (those mount functions are idempotent per bus / ctx anyway).
 *
 * @module ui/index
 */

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { APP_NAME } from '../version.js';
import { createEmitter, prefersReducedMotion } from './dom.js';
import { mountShell } from './shell.js';
import { mountToasts, mountFlash } from './toast.js';
import { mountAnnouncer } from './announcer.js';
import { bindShortcuts } from './shortcuts.js';

const HOUR = 3600e3;
const DAY = 86400e3;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];

/** Compass abbreviations → words used in sentences ("the south-east horizon"). */
const COMPASS_WORDS = {
    N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east', E: 'east',
    ESE: 'east-south-east', SE: 'south-east', SSE: 'south-south-east', S: 'south', SSW: 'south-south-west',
    SW: 'south-west', WSW: 'west-south-west', W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west',
};
const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * Mounts the complete UI.
 * @param {HTMLElement} rootEl  `#ui-root`
 * @param {{store:any, bus:any, clock:any, actions:any, services:{cities?:any, geocoder?:any, astro?:any, tz:any, format:any},
 *          env?:{coarse?:boolean, reducedMotion?:boolean}}} ctx
 * @returns {{update(snapFull:any): void, destroy(): void}}
 */
export function mountUI(rootEl, ctx) {
    const ui = createUiHub(ctx, rootEl);
    const uctx = { ...ctx, ui };
    const offs = [];

    rootEl.classList.add('ui');
    const shell = mountShell(rootEl, uctx);
    const overlay = shell.overlay;

    const toasts = mountToasts(overlay, ctx.bus);
    const flash = mountFlash(overlay);
    const announcer = mountAnnouncer(overlay, ctx.bus);
    ui.flash = (text) => flash.show(text);
    offs.push(bindShortcuts(uctx));

    const narrator = startNarrator(uctx);
    const summary = startSceneSummary(uctx);

    // ---- data from the app ------------------------------------------------
    offs.push(ctx.bus.on('readout', (snap) => update(snap)));
    offs.push(ctx.bus.on('almanac', (payload) => ui.ingestAlmanac(payload)));
    offs.push(ctx.bus.on('events', (list) => ui.ingestEvents(list)));
    offs.push(ctx.store.subscribe((st) => st.observer, () => ui.invalidateAlmanac()));
    offs.push(ctx.store.subscribe((st) => st.display, () => { ui.emit('display'); }));

    let failed = false;
    /** @param {any} snap Full-detail Snapshot (the same preallocated object every time). */
    function update(snap) {
        if (!snap) return;
        ui.snap = snap;
        try {
            ui.checkAlmanac(snap.tMs);
            shell.update(snap);
            ui.emit('snap', snap);
        } catch (err) {
            // Report once: a UI bug must never stop the render loop or spam the console.
            if (!failed) { failed = true; console.error('[ui] update failed', err); }
        }
    }

    return {
        update,
        destroy() {
            offs.forEach((off) => off());
            narrator();
            summary();
            ui.dispose();
            toasts.destroy();
            flash.destroy();
            announcer.destroy();
            shell.destroy();
            rootEl.classList.remove('ui');
        },
    };
}

// ===========================================================================
// The private UI hub
// ===========================================================================

/**
 * Builds `ctx.ui`: shared data, formatting helpers and navigation hooks.
 * @param {any} ctx
 * @param {HTMLElement} rootEl
 */
function createUiHub(ctx, rootEl) {
    const em = createEmitter();
    const services = ctx.services || {};
    let monthBase = null;

    // -- safe service calls --------------------------------------------------
    /** Calls `services.format[name]`, returning '—' on a missing function or a throw. */
    function fmt(name, ...args) {
        const fn = services.format?.[name];
        if (typeof fn !== 'function') return '—';
        try {
            const out = fn(...args);
            return out == null || out === '' ? '—' : out;
        } catch { return '—'; }
    }

    /** Calls `ctx.actions[name]` defensively; async failures are reported, never thrown. */
    function act(name, ...args) {
        const fn = ctx.actions?.[name];
        if (typeof fn !== 'function') return undefined;
        try {
            const r = fn.apply(ctx.actions, args);
            if (r && typeof r.then === 'function') r.catch((err) => console.error(`[ui] ${name} failed`, err));
            return r;
        } catch (err) {
            console.error(`[ui] ${name} failed`, err);
            return undefined;
        }
    }

    // -- time in the display timezone ---------------------------------------
    /** IANA zone used for every printed time. */
    function displayTz() {
        const st = ctx.store.get();
        const mode = st.display?.tzMode || 'observer';
        if (mode === 'utc') return 'UTC';
        if (mode === 'device') {
            try { return services.tz?.deviceTz?.() || 'UTC'; } catch { return 'UTC'; }
        }
        return observerTz(st.observer);
    }

    /** The observer's zone (approximate Etc/GMT zone from longitude when unknown). */
    function observerTz(o) {
        if (o?.tz) return o.tz;
        try { return services.tz?.approxTzForLon?.(o?.lonDeg ?? 0) || 'UTC'; } catch { return 'UTC'; }
    }

    /**
     * Wall-clock fields of `ms` in a zone, months 1-based, plus weekday `wd` (0 = Sunday).
     * @param {number} ms
     * @param {string} [tzName]
     */
    function zoned(ms, tzName = displayTz()) {
        let z = null;
        try { z = services.tz?.utcToZoned?.(ms, tzName) || null; } catch { z = null; }
        if (!z || !Number.isFinite(z.y)) {
            const d = new Date(ms);
            z = { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(),
                mi: d.getUTCMinutes(), s: d.getUTCSeconds(), offsetMin: 0, abbr: 'UTC' };
        } else {
            if (monthBase === null) {
                // Guard against a 0-based month convention without assuming it.
                try { monthBase = services.tz.utcToZoned(Date.UTC(2000, 0, 15, 12), 'UTC').mo === 0 ? 0 : 1; } catch { monthBase = 1; }
            }
            if (monthBase === 0) z = { ...z, mo: z.mo + 1 };
        }
        const wd = new Date(Date.UTC(z.y, z.mo - 1, z.d)).getUTCDay();
        return { y: z.y, mo: z.mo, d: z.d, h: z.h, mi: z.mi, s: Math.floor(z.s || 0), offsetMin: z.offsetMin || 0, abbr: z.abbr || '', wd };
    }

    /**
     * Wall-clock fields (months 1-based; day may overflow, e.g. 32) in a zone → UTC ms.
     * Uses `services.tz.zonedToUtc` (DST-safe); falls back to a two-pass offset correction.
     * @param {{y:number, mo:number, d:number, h?:number, mi?:number, s?:number}} f
     * @param {string} [tzName]
     */
    function toUtc(f, tzName = displayTz()) {
        // Normalise overflowing fields through Date.UTC first (e.g. 31 Oct + 1 day).
        const n = new Date(Date.UTC(f.y, f.mo - 1, f.d, f.h || 0, f.mi || 0, f.s || 0));
        const g = { y: n.getUTCFullYear(), mo: n.getUTCMonth() + 1, d: n.getUTCDate(), h: n.getUTCHours(), mi: n.getUTCMinutes(), s: n.getUTCSeconds() };
        if (monthBase === null) zoned(Date.UTC(2000, 0, 15), 'UTC');
        try {
            const ms = services.tz?.zonedToUtc?.({ ...g, mo: monthBase === 0 ? g.mo - 1 : g.mo }, tzName);
            if (Number.isFinite(ms)) return ms;
        } catch { /* fall through */ }
        const naive = n.getTime();
        let guess = naive;
        for (let i = 0; i < 2; i += 1) guess = naive - zoned(guess, tzName).offsetMin * 60e3;
        return guess;
    }

    /** "20:14" / "20:14:05" / "8:14 PM" in the display zone. */
    function fmtClock(ms, { seconds = false, tzName } = {}) {
        if (!Number.isFinite(ms)) return '—';
        const z = zoned(ms, tzName);
        const mm = pad2(z.mi), ss = pad2(z.s);
        if (ctx.store.get().display?.hour12) {
            const hh = z.h % 12 || 12;
            return `${hh}:${mm}${seconds ? ':' + ss : ''} ${z.h < 12 ? 'AM' : 'PM'}`;
        }
        return `${pad2(z.h)}:${mm}${seconds ? ':' + ss : ''}`;
    }

    /** "Sat 11 Oct 2026" (or without weekday / year). */
    function fmtDay(ms, { weekday = true, year = true, tzName } = {}) {
        if (!Number.isFinite(ms)) return '—';
        const z = zoned(ms, tzName);
        return `${weekday ? WEEKDAYS[z.wd] + ' ' : ''}${z.d} ${MONTHS[z.mo - 1]}${year ? ' ' + z.y : ''}`;
    }

    /** "Sat 11 Oct 2026 · 20:14:05" — the time-bar stamp. */
    function fmtStamp(ms) {
        if (!Number.isFinite(ms)) return '—';
        return `${fmtDay(ms)} · ${fmtClock(ms, { seconds: true })}`;
    }

    /** "12 Oct 2026, 21:00" — used in announcements. */
    function fmtSpoken(ms) {
        if (!Number.isFinite(ms)) return '';
        return `${fmtDay(ms, { weekday: false })}, ${fmtClock(ms)}`;
    }

    /**
     * Compact time relative to a reference: same local day → "21:14";
     * within ±6 days → "Tue 21:14"; otherwise "12 Oct 21:14" (year added when it differs).
     */
    function fmtWhen(ms, refMs) {
        if (!Number.isFinite(ms)) return '—';
        const a = zoned(ms), b = zoned(Number.isFinite(refMs) ? refMs : ms);
        const clock = fmtClock(ms);
        if (a.y === b.y && a.mo === b.mo && a.d === b.d) return clock;
        if (Math.abs(ms - refMs) < 6 * DAY) return `${WEEKDAYS[a.wd]} ${clock}`;
        return `${a.d} ${MONTHS[a.mo - 1]}${a.y !== b.y ? ' ' + a.y : ''} ${clock}`;
    }

    /** "UTC+7" for the display zone at `ms`. */
    function offsetText(ms, tzName = displayTz()) {
        const z = zoned(ms, tzName);
        try { return services.tz?.offsetLabel?.(z.offsetMin) || utcLabel(z.offsetMin); } catch { return utcLabel(z.offsetMin); }
    }

    // -- places -------------------------------------------------------------
    /** "21.03° N 105.85° E" (digits = 2) or "48.8600° N, 2.3500° E" (digits = 4, sep ', '). */
    function latLonText(lat, lon, digits = 2, sep = ' ') {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
        const viaFormat = fmt('fmtLatLon', lat, lon, 'dec', { digits, sep });
        if (viaFormat !== '—') return viaFormat;
        const la = `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}`;
        const lo = `${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`;
        return `${la}${sep}${lo}`;
    }

    /** Nearest offline city within 300 km as "Lyon, France", else null. */
    function nearestCityText(lat, lon) {
        const cities = services.cities;
        if (!cities?.nearest) return null;
        try {
            const r = cities.nearest(lat, lon);
            if (r && r.city && r.km <= 300) return r.city.country ? `${r.city.name}, ${r.city.country}` : r.city.name;
        } catch { /* ignore */ }
        return null;
    }

    /**
     * Human label for an observer: "Hanoi, Vietnam", "near Lyon, France" or coordinates.
     * @param {any} o Observer
     * @param {{country?: boolean}} [opts]
     */
    function placeLabel(o, { country = true } = {}) {
        if (!o) return '';
        const name = String(o.name || '').trim();
        const ctry = String(o.country || '').trim();
        if (name) {
            if (country && ctry && !name.toLowerCase().includes(ctry.toLowerCase())) return `${name}, ${ctry}`;
            return name;
        }
        const near = nearestCityText(o.latDeg, o.lonDeg);
        if (near) return `near ${near}`;
        return latLonText(o.latDeg, o.lonDeg, 2);
    }

    /** Short place name for the tz chip and summaries ("Hanoi"). */
    function placeShort(o) {
        const name = String(o?.name || '').trim();
        if (name) return name.replace(/^near\s+/i, '');
        const near = nearestCityText(o?.latDeg, o?.lonDeg);
        return near ? near.split(',')[0] : latLonText(o?.latDeg, o?.lonDeg, 1);
    }

    // -- bodies -------------------------------------------------------------
    const bodyName = (id) => BODIES[BODY_INDEX[id]]?.name ?? String(id);
    /** "The Sun" / "the Moon" / "Mars". */
    const bodySubject = (id, capital = true) => (id === 'sun' || id === 'moon'
        ? `${capital ? 'The' : 'the'} ${bodyName(id)}` : bodyName(id));
    const bodyOf = (snap, id) => (snap && id in BODY_INDEX ? snap.bodies?.[BODY_INDEX[id]] ?? null : null);

    /** Compass point ("SE") — from services.format when present, else local. */
    function compass(az) {
        if (!Number.isFinite(az)) return '—';
        const c = fmt('compass16', az);
        return c === '—' ? COMPASS16[Math.round((((az % 360) + 360) % 360) / 22.5) % 16] : c;
    }
    const compassWords = (az) => COMPASS_WORDS[compass(az)] || compass(az);

    /** Apparent (refracted) altitude/azimuth, falling back to geometric on frame-detail snapshots. */
    function altAz(b) {
        if (!b) return { alt: NaN, az: NaN };
        const fullOk = Number.isFinite(b.altDeg) && Number.isFinite(b.azDeg) && !(b.altDeg === 0 && b.azDeg === 0 && b.altGeomDeg !== 0);
        return fullOk ? { alt: b.altDeg, az: b.azDeg } : { alt: b.altGeomDeg, az: b.azGeomDeg };
    }

    // -- almanac freshness (all keyed to SIMULATED time) --------------------
    const alm = {
        key: '',
        next: null,      // {data:{[id]:RTS}, fromMs, toMs, key, firstEventMs}
        day: null,       // {data, fromMs, toMs, key}
        night: null,     // {tonight, twilight, reqMs, key}
        sun: null,       // {fromMs, toMs, values, key}  (the app's boot-time series; the time bar keeps its own)
        pending: { next: null, day: null, night: null, events: null },
        lastReq: { next: 0, day: 0, night: 0, events: 0 },
        fails: { next: 0, day: 0, night: 0, events: 0 },
    };
    const events = { list: null, fromMs: NaN, toMs: NaN, key: '', source: '' };

    const observerKey = (o = ctx.store.get().observer) =>
        `${(+o.latDeg).toFixed(4)},${(+o.lonDeg).toFixed(4)},${Math.round(+o.elevM || 0)}`;
    const astroObserver = (o = ctx.store.get().observer) => ({ latDeg: +o.latDeg, lonDeg: +o.lonDeg, elevM: +o.elevM || 0 });

    /** Minimum wall-clock gap before retrying a kind: grows 2× per consecutive failure (max 60 s). */
    const gapFor = (kind, base) => Math.min(60e3, base * 2 ** alm.fails[kind]);

    /**
     * Starts (or restarts) one astro worker request, aborting any older one of the same kind.
     * Failures back off exponentially so an unsupported op can never become a retry storm.
     */
    function request(kind, op, args, onResult, onError) {
        const astro = services.astro;
        if (!astro?.call) return;
        alm.pending[kind]?.abort();
        const ac = new AbortController();
        alm.pending[kind] = ac;
        alm.lastReq[kind] = performance.now();
        const fail = () => {
            if (alm.pending[kind] === ac) alm.pending[kind] = null;
            if (!ac.signal.aborted) { alm.fails[kind] += 1; onError?.(); }
        };
        let p;
        try { p = astro.call(op, args, { signal: ac.signal }); } catch { fail(); return; }
        Promise.resolve(p).then((res) => {
            if (ac.signal.aborted) return;
            alm.pending[kind] = null;
            alm.fails[kind] = 0;
            onResult(res);
        }, fail);
    }

    const RTS_IDS = BODIES.map((b) => b.id);

    /** Refreshes whatever almanac data no longer describes the simulated time `t`. */
    function checkAlmanac(t) {
        if (!Number.isFinite(t) || !services.astro?.call) return;
        const st = ctx.store.get();
        const key = observerKey(st.observer);
        const now = performance.now();
        if (key !== alm.key) { alm.key = key; }

        // Next rise / set for Sky Now: window [t, t+26 h]; stale once any listed event has happened.
        const nx = alm.next;
        const staleNext = !nx || nx.key !== key || t < nx.fromMs || t > nx.fromMs + 30 * 60e3 || t >= nx.firstEventMs;
        if (staleNext && !alm.pending.next && now - alm.lastReq.next > gapFor('next', 700)) {
            const fromMs = t, toMs = t + 26 * HOUR;
            request('next', 'riseSet', { bodyIds: RTS_IDS, observer: astroObserver(st.observer), fromMs, toMs }, (data) => {
                alm.next = { data: data || {}, fromMs, toMs, key, firstEventMs: firstEvent(data, fromMs) };
                em.emit('almanac', alm);
            });
        }

        // Today's rise / transit / set for the body card: the observer's local calendar day.
        const dy = alm.day;
        const staleDay = !dy || dy.key !== key || t < dy.fromMs || t >= dy.toMs;
        if (staleDay && !alm.pending.day && now - alm.lastReq.day > gapFor('day', 900)) {
            let fromMs = t - (t % DAY);
            try { fromMs = services.tz?.localDayStart?.(t, observerTz(st.observer)) ?? fromMs; } catch { /* keep UTC day */ }
            const toMs = fromMs + DAY;
            request('day', 'riseSet', { bodyIds: RTS_IDS, observer: astroObserver(st.observer), fromMs, toMs }, (data) => {
                alm.day = { data: data || {}, fromMs, toMs, key };
                em.emit('almanac', alm);
            });
        }

        // Tonight's verdicts and twilight times (two ops, one slot; partial results are kept).
        const ng = alm.night;
        const end = ng?.tonight?.nightEndMs;
        const start = ng?.tonight?.nightStartMs;
        const staleNight = !ng || ng.key !== key
            || (Number.isFinite(end) ? (t > end + 30 * 60e3 || t < start - 20 * HOUR) : Math.abs(t - ng.reqMs) > 12 * HOUR);
        if (staleNight && !alm.pending.night && now - alm.lastReq.night > gapFor('night', 1500)) {
            const obs = astroObserver(st.observer);
            const reqMs = t;
            const publish = (tonightRes, twilightRes) => {
                if (!tonightRes && !twilightRes) return;
                alm.night = { tonight: tonightRes || null, twilight: twilightRes || tonightRes?.twilight || null, reqMs, key };
                em.emit('almanac', alm);
            };
            // 'tonight' carries the twilight times too; ask for them separately only if it fails.
            const twilightOnly = () => {
                try {
                    Promise.resolve(services.astro.call('twilight', { observer: obs, nearMs: reqMs }))
                        .then((tw) => publish(null, tw), () => { /* nothing to show */ });
                } catch { /* astro unavailable */ }
            };
            request('night', 'tonight', { observer: obs, nearMs: reqMs, tz: observerTz(st.observer), hour12: !!st.display?.hour12 },
                (r) => publish(r, r?.twilight || null), twilightOnly);
        }

        // Event list (scrubber ticks + Events tab): keep [t − 1 yr, t + 1 yr] covered.
        const evStale = !events.list || events.key !== key || t < events.fromMs + 20 * DAY || t > events.toMs - 300 * DAY;
        if (evStale && !alm.pending.events && now - alm.lastReq.events > gapFor('events', 2500)) {
            const fromMs = t - 365 * DAY;
            request('events', 'events', { observer: astroObserver(st.observer), fromMs, days: 730 }, (list) => {
                if (!Array.isArray(list)) return;
                events.list = list.slice().sort((a, b) => a.tMs - b.tMs);
                events.fromMs = fromMs;
                events.toMs = fromMs + 730 * DAY;
                events.key = key;
                events.source = 'ui';
                em.emit('events', events);
            });
        }
    }

    function firstEvent(data, fromMs) {
        let first = Infinity;
        if (data) for (const id in data) {
            const r = data[id];
            if (!r) continue;
            for (const k of ['riseMs', 'setMs']) { const v = r[k]; if (Number.isFinite(v) && v > fromMs && v < first) first = v; }
        }
        return first;
    }

    /** Accepts the app's own almanac push (computed for "now" at boot) as a starting point. */
    function ingestAlmanac(p) {
        if (!p) return;
        const key = observerKey();
        const t = ui.snap?.tMs ?? ctx.clock?.tMs ?? Date.now();
        if (p.riseSet && !alm.next) {
            alm.next = { data: p.riseSet, fromMs: t, toMs: t + 24 * HOUR, key, firstEventMs: firstEvent(p.riseSet, t) };
        }
        if ((p.tonight || p.twilight) && (!alm.night || alm.night.key !== key)) {
            alm.night = { tonight: p.tonight || null, twilight: p.twilight || null, reqMs: t, key };
        }
        if (p.sunSeries?.values?.length) {
            alm.sun = { fromMs: p.sunSeries.fromMs, toMs: p.sunSeries.toMs, values: p.sunSeries.values, key };
        }
        em.emit('almanac', alm);
    }

    /** Accepts the app's event list push. */
    function ingestEvents(list) {
        if (!Array.isArray(list)) return;
        const key = observerKey();
        // Our own request covers a wider span (±1 yr around the simulated time); keep it.
        if (events.list && events.key === key && events.source === 'ui') return;
        const sorted = list.slice().sort((a, b) => a.tMs - b.tMs);
        const t = ui.snap?.tMs ?? ctx.clock?.tMs ?? Date.now();
        events.list = sorted;
        events.fromMs = Math.min(t, sorted[0]?.tMs ?? t);
        events.toMs = Math.max(t + 365 * DAY, sorted.at(-1)?.tMs ?? t);
        events.key = key;
        events.source = 'app';
        em.emit('events', events);
    }

    function invalidateAlmanac() {
        for (const k of ['next', 'day', 'night', 'events']) {
            alm.pending[k]?.abort(); alm.pending[k] = null; alm.lastReq[k] = 0; alm.fails[k] = 0;
        }
        alm.next = alm.day = alm.night = null;
        em.emit('almanac', alm);
        const t = ui.snap?.tMs ?? ctx.clock?.tMs;
        if (Number.isFinite(t)) queueMicrotask(() => checkAlmanac(t));
    }

    /**
     * Rise/set info for one body relative to time t:
     * `{up, nextRiseMs, nextSetMs, status}` from the "next" window, and today's
     * `{riseMs, transitMs, setMs}` from the "day" window.
     */
    function riseSetFor(id, t) {
        const nx = alm.next?.data?.[id] || null;
        const dy = alm.day?.data?.[id] || null;
        const valid = (v) => Number.isFinite(v) && v >= t - 60e3;
        return {
            status: nx?.status || dy?.status || null,
            nextRiseMs: nx && valid(nx.riseMs) ? nx.riseMs : null,
            nextSetMs: nx && valid(nx.setMs) ? nx.setMs : null,
            riseMs: Number.isFinite(dy?.riseMs) ? dy.riseMs : null,
            transitMs: Number.isFinite(dy?.transitMs) ? dy.transitMs : null,
            setMs: Number.isFinite(dy?.setMs) ? dy.setMs : null,
            transitAltDeg: Number.isFinite(dy?.transitAltDeg) ? dy.transitAltDeg : (Number.isFinite(nx?.transitAltDeg) ? nx.transitAltDeg : null),
            known: !!(nx || dy),
        };
    }

    /** Tonight report for a body, if available. */
    function tonightFor(id) {
        const reps = alm.night?.tonight?.reports;
        if (!Array.isArray(reps)) return null;
        return reps.find((r) => r && r.id === id) || null;
    }

    const ui = {
        root: rootEl,
        /** @type {any} latest full Snapshot */
        snap: null,
        almanac: alm,
        events,
        layout: 'desktop',
        scrubbing: false,
        on: em.on,
        emit: em.emit,
        fmt, act,
        displayTz, observerTz, zoned, toUtc, fmtClock, fmtDay, fmtStamp, fmtSpoken, fmtWhen, offsetText,
        latLonText, placeLabel, placeShort, nearestCityText,
        bodyName, bodySubject, bodyOf, compass, compassWords, altAz,
        checkAlmanac, ingestAlmanac, ingestEvents, invalidateAlmanac, riseSetFor, tonightFor, observerKey, astroObserver,
        MONTHS, MONTHS_LONG, WEEKDAYS,
        /** True when transitions should be cuts. */
        reducedMotion: () => !!(ctx.store.get().status?.reducedMotion || ctx.env?.reducedMotion || prefersReducedMotion()),
        // Navigation hooks, replaced by the shell / view switch / toast modules.
        openPanel: (_tab) => {},
        openPalette: () => { ctx.store.set({ ui: { ...ctx.store.get().ui, palette: true } }); },
        closePalette: () => { ctx.store.set({ ui: { ...ctx.store.get().ui, palette: false } }); },
        toggleHelp: (force) => {
            const u = ctx.store.get().ui;
            ctx.store.set({ ui: { ...u, help: typeof force === 'boolean' ? force : !u.help } });
        },
        share: async () => act('share'),
        flash: (_text) => {},
        pickHint: (_on) => {},
        dispose() {
            for (const k of Object.keys(alm.pending)) alm.pending[k]?.abort();
            em.clear();
        },
    };
    return ui;
}

function utcLabel(min) {
    if (!min) return 'UTC';
    const sign = min > 0 ? '+' : '−';
    const a = Math.abs(min), hh = Math.floor(a / 60), mm = a % 60;
    return `UTC${sign}${hh}${mm ? ':' + pad2(mm) : ''}`;
}

// ===========================================================================
// Narrator: polite announcements generated from state changes
// ===========================================================================

/**
 * Emits `bus 'announce'` strings for observer, selection and time changes.
 * The announcer throttles them (one per 2 s, latest wins).
 * @param {any} ctx
 * @returns {() => void} stop
 */
function startNarrator(ctx) {
    const { store, bus, clock, ui } = ctx;
    const say = (text) => { if (text) bus.emit('announce', text); };
    const offs = [];
    let timeTimer = 0;

    offs.push(store.subscribe((s) => s.observer, (o, prev) => {
        if (!o || !prev) return;
        say(`Observer set to ${ui.placeLabel(o)}`);
        if (o.source === 'click') {
            // The click-placement Undo toast (SPEC F.2). Only one Undo toast is kept on screen.
            bus.emit('toast', {
                message: `Observer moved to ${ui.placeLabel(o)}`, kind: 'info', actionLabel: 'Undo',
                onAction: () => ui.act('undoObserver'), timeoutMs: 8000,
            });
        }
    }));

    offs.push(store.subscribe((s) => s.selection, (id) => {
        if (!id) { say('Selection cleared'); return; }
        const b = ui.bodyOf(ui.snap, id);
        if (!b) { say(`${ui.bodyName(id)} selected`); return; }
        const { alt, az } = ui.altAz(b);
        if (!Number.isFinite(alt)) { say(`${ui.bodyName(id)} selected`); return; }
        say(alt >= 0
            ? `${ui.bodyName(id)} selected, ${Math.round(alt)} degrees up in the ${ui.compassWords(az)}`
            : `${ui.bodyName(id)} selected, below the horizon`);
    }));

    if (clock?.onChange) {
        offs.push(clock.onChange((ev) => {
            const type = ev?.type;
            if (type === 'clamp') {
                bus.emit('toast', { message: `${APP_NAME} covers years 1000–3000.`, kind: 'warn' });
                say(`${APP_NAME} covers years 1000 to 3000. Time paused.`);
                return;
            }
            if (ui.scrubbing) return;
            if (type === 'live') { say('Live: showing the sky right now'); return; }
            if (type === 'rate') { say(`Speed ${ui.fmt('fmtRate', clock.rate)}`); return; }
            if (type === 'range') { say(clock.range ? 'Timelapse started' : 'Timelapse stopped'); return; }
            if (type === 'pause' || type === 'jump' || type === 'play') {
                // Debounced so a burst of steps reads out once, with the final time.
                clearTimeout(timeTimer);
                timeTimer = setTimeout(() => {
                    const t = clock.tMs;
                    if (!clock.playing) say(`Time: ${ui.fmtSpoken(t)}, paused`);
                    else if (type === 'play') say(clock.live ? 'Playing, live' : `Playing at ${ui.fmt('fmtRate', clock.rate)}`);
                    else say(`Time: ${ui.fmtSpoken(t)}`);
                }, 700);
            }
        }));
    }
    return () => { offs.forEach((off) => off()); clearTimeout(timeTimer); };
}

// ===========================================================================
// Canvas summary (role="img" aria-label refreshed every 4 s)
// ===========================================================================

/**
 * Writes "Hanoi, 20:14. Up now: Saturn 38° SE, Jupiter 12° E. Moon set." to the
 * scene canvas's aria-label every 4 s.
 * @param {any} ctx
 * @returns {() => void} stop
 */
function startSceneSummary(ctx) {
    const { ui, store } = ctx;
    let last = '';
    const tick = () => {
        const canvas = document.getElementById('scene');
        const snap = ui.snap;
        if (!canvas || !snap?.bodies) return;
        const parts = [];
        const up = [];
        let moonUp = false;
        for (const b of snap.bodies) {
            const { alt, az } = ui.altAz(b);
            if (!Number.isFinite(alt)) continue;
            if (alt > 0) {
                up.push({ id: b.id, alt, az });
                if (b.id === 'moon') moonUp = true;
            }
        }
        up.sort((a, b) => b.alt - a.alt);
        parts.push(`${ui.placeShort(store.get().observer)}, ${ui.fmtClock(snap.tMs)}.`);
        parts.push(up.length
            ? `Up now: ${up.map((u) => `${ui.bodyName(u.id)} ${Math.round(u.alt)}° ${ui.compass(u.az)}`).join(', ')}.`
            : 'Nothing is above the horizon.');
        if (!moonUp) parts.push('Moon set.');
        const text = parts.join(' ');
        if (text !== last) { last = text; canvas.setAttribute('aria-label', text); }
    };
    const id = setInterval(tick, 4000);
    const off = ui.on('snap', () => { if (!last) tick(); });
    return () => { clearInterval(id); off(); };
}
