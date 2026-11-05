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
 *   (`display.tzMode`: observer / device / UTC) exactly as the copy in SPEC §F asks, in the
 *   interface's locale (core/i18n.js dateText / timeText);
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

import { BODIES, BODY_INDEX, hostBodies } from '../astro/bodies.js';
import { APP_NAME } from '../version.js';
import { createEmitter, prefersReducedMotion } from './dom.js';
import { mountShell } from './shell.js';
import { mountToasts } from './toast.js';
import { mountAnnouncer } from './announcer.js';
import { bindShortcuts } from './shortcuts.js';
import { mountInstallHint } from './install.js';
import { mountIntroCaption } from './intro-caption.js';
import { mountCoach } from './coach.js';
import { toCalendar, fromCalendar } from '../core/tz.js';
import { isExtraId } from '../core/selection.js';
import { t, N_, dateText, timeText } from '../core/i18n.js';

const HOUR = 3600e3;
const DAY = 86400e3;

/** The 16 compass points as words for sentences ("the south-east horizon"), from north clockwise. */
const COMPASS_WORDS = [N_('north'), N_('north-north-east'), N_('north-east'), N_('east-north-east'), N_('east'),
    N_('east-south-east'), N_('south-east'), N_('south-south-east'), N_('south'), N_('south-south-west'), N_('south-west'),
    N_('west-south-west'), N_('west'), N_('west-north-west'), N_('north-west'), N_('north-north-west')];
const point16 = (az) => Math.round((((az % 360) + 360) % 360) / 22.5) % 16;

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * Mounts the complete UI.
 * @param {HTMLElement} rootEl  `#ui-root`
 * @param {{store:any, bus:any, clock:any, actions:any, services:{cities?:any, geocoder?:any, astro?:any, tz:any, format:any},
 *          env?:{coarse?:boolean, reducedMotion?:boolean, firstRun?:boolean}}} ctx
 *   env.firstRun: a first visit on a plain link (main.js), when the coach marks follow the intro
 * @returns {{update(snapFull:any): void, openPanel(id:string, opts?:any): void, destroy(): void}}
 */
export function mountUI(rootEl, ctx) {
    const ui = createUiHub(ctx, rootEl);
    const uctx = { ...ctx, ui };
    const offs = [];

    rootEl.classList.add('ui');
    const shell = mountShell(rootEl, uctx);
    const overlay = shell.overlay;

    const toasts = mountToasts(overlay, ctx.bus);
    const announcer = mountAnnouncer(overlay, ctx.bus);
    offs.push(bindShortcuts(uctx));

    const narrator = startNarrator(uctx);
    const summary = startSceneSummary(uctx);
    const installHint = mountInstallHint(uctx);
    const introCap = mountIntroCaption(uctx);
    const coach = mountCoach(overlay, uctx);

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
        openPanel: (id, opts) => ui.openPanel(id, opts),
        destroy() {
            offs.forEach((off) => off());
            narrator();
            summary();
            installHint();
            introCap.destroy();
            coach.destroy();
            ui.dispose();
            toasts.destroy();
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
     * Wall-clock fields of `ms` in a zone, months 1-based, plus weekday `wd` (0 = Sunday). The date
     * is in the display calendar: Julian before 15 Oct 1582 (`cal: 'julian'`, core/tz.js
     * toCalendar), Gregorian after; weekdays are the same in both. Pass the fields (with `cal`) back
     * to toUtc, even with an overflowing day.
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
        const c = toCalendar({ y: z.y, mo: z.mo, d: z.d });
        return { y: c.y, mo: c.mo, d: c.d, cal: c.cal, h: z.h, mi: z.mi, s: Math.floor(z.s || 0), offsetMin: z.offsetMin || 0, abbr: z.abbr || '', wd };
    }

    /**
     * Wall-clock fields (months 1-based; day may overflow, e.g. 32) in a zone → UTC ms.
     * Uses `services.tz.zonedToUtc` (DST-safe); falls back to a two-pass offset correction. The
     * date is in the calendar `f.cal` (as zoned() gives it); without one, a date on or before
     * 4 Oct 1582 is read as Julian.
     * @param {{y:number, mo:number, d:number, h?:number, mi?:number, s?:number, cal?:'julian'|'gregorian'}} f
     * @param {string} [tzName]
     */
    function toUtc(f, tzName = displayTz()) {
        // The calendar date → proleptic Gregorian, then overflowing time fields through Date.UTC.
        const gd = fromCalendar(f.y, f.mo, f.d, f.cal);
        const n = new Date(Date.UTC(gd.y, gd.mo - 1, gd.d, f.h || 0, f.mi || 0, f.s || 0));
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
        return timeText(zoned(ms, tzName), { seconds, hour12: !!ctx.store.get().display?.hour12 });
    }

    /**
     * The date of `ms` in the display zone and calendar, in the locale: Intl's weekday, day, month
     * and year options ("Sat 11 Oct 2026", "Tue 14", "October 2026"; core/i18n.js dateText).
     * @param {number} ms
     * @param {{weekday?:any, day?:any, month?:any, year?:any}} opts
     * @param {string} [tzName]
     */
    function fmtDate(ms, opts, tzName) {
        return Number.isFinite(ms) ? dateText(zoned(ms, tzName), opts) : '—';
    }

    /** "Sat 11 Oct 2026" (or without weekday / year). */
    function fmtDay(ms, { weekday = true, year = true, tzName } = {}) {
        return fmtDate(ms, { weekday: weekday && 'short', day: 'numeric', month: 'short', year: year && 'numeric' }, tzName);
    }

    /** "Sat 11 Oct 2026 · 20:14:05" — the time-bar stamp. */
    function fmtStamp(ms) {
        if (!Number.isFinite(ms)) return '—';
        return `${fmtDay(ms)} · ${fmtClock(ms, { seconds: true })}`;
    }

    /** "12 Oct 2026, 21:00" — used in announcements. */
    function fmtSpoken(ms) {
        if (!Number.isFinite(ms)) return '';
        return t('{date}, {time}', { date: fmtDay(ms, { weekday: false }), time: fmtClock(ms) });
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
        if (Math.abs(ms - refMs) < 6 * DAY) return `${dateText(a, { weekday: 'short' })} ${clock}`;
        return `${dateText(a, { day: 'numeric', month: 'short', year: a.y !== b.y && 'numeric' })} ${clock}`;
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
        if (near) return t('near {place}', { place: near });
        return latLonText(o.latDeg, o.lonDeg, 2);
    }

    /** Short place name for the clock's zone and summaries ("Hanoi"). */
    function placeShort(o) {
        const name = String(o?.name || '').trim();
        // "near Lyon" (actions' English, or the locale's "gần Lyon") → "Lyon".
        const pre = t('near {place}', { place: '' }).trim();
        if (name) return name.replace(/^near\s+/i, '').replace(name.startsWith(pre + ' ') ? pre + ' ' : '', '');
        const near = nearestCityText(o?.latDeg, o?.lonDeg);
        return near ? near.split(',')[0] : latLonText(o?.latDeg, o?.lonDeg, 1);
    }

    // -- bodies -------------------------------------------------------------
    // Extra objects (astro/extras.js; ctx.extras, the registry) answer the same three questions.
    const extras = ctx.extras ?? null;
    // Standing on Mars (store.host, ROADMAP stand-on-mars) slot 4 is the Earth (astro/bodies.js hostBodies).
    const onMars = () => ctx.store?.get?.().host?.id === 'mars';
    /** A body's name in the locale ('Mặt Trăng'); extra objects' names go through t() too. */
    const bodyName = (id) => {
        const name = hostBodies(onMars() ? 'mars' : 'earth')[BODY_INDEX[id]]?.name ?? (isExtraId(id) ? extras?.meta?.(id)?.name : null);
        return name ? t(name) : String(id);
    };
    /** "The Sun" / "the Moon" / "Mars". */
    const bodySubject = (id, capital = true) => (id === 'sun' || id === 'moon'
        ? capital ? t('The {body}', { body: bodyName(id) }) : t('the {body}', { body: bodyName(id) }) : bodyName(id));
    /** A body's BodyState, or an extra object's ExtraState while it is present. */
    const bodyOf = (snap, id) => {
        if (!snap) return null;
        if (id in BODY_INDEX) return snap.bodies?.[BODY_INDEX[id]] ?? null;
        if (!isExtraId(id)) return null;
        const st = extras?.state?.(snap, id) ?? null;
        return st && st.present ? st : null;
    };

    /** Compass point ("SE", Vietnamese "ĐN") from services.format. */
    function compass(az) {
        return Number.isFinite(az) ? fmt('compass16', az) : '—';
    }
    /** "south-east" (Vietnamese "đông nam"). */
    const compassWords = (az) => (Number.isFinite(az) ? t(COMPASS_WORDS[point16(az)]) : '—');

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
        pending: { next: null, day: null, night: null, events: null, passes: null },
        // passes: no wait at boot (data/tle.json may arrive while the clock is paused, with no readout to retry on).
        lastReq: { next: 0, day: 0, night: 0, events: 0, passes: -Infinity },
        fails: { next: 0, day: 0, night: 0, events: 0, passes: 0 },
    };
    const events = { list: null, fromMs: NaN, toMs: NaN, key: '', lp: 0, source: '' };
    /** The satellites' next visible passes (astro/satellites.js SatPass[], the worker's 'satPasses'). */
    const passes = { list: null, fromMs: NaN, toMs: NaN, key: '', tle: null };

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
    function checkAlmanac(tm) {
        if (!Number.isFinite(tm) || !services.astro?.call) return;
        const st = ctx.store.get();
        const key = observerKey(st.observer);
        const now = performance.now();
        if (key !== alm.key) { alm.key = key; }

        // Next rise / set for Sky Now: window [t, t+26 h]; stale once any listed event has happened.
        const nx = alm.next;
        const staleNext = !nx || nx.key !== key || tm < nx.fromMs || tm > nx.fromMs + 30 * 60e3 || tm >= nx.firstEventMs;
        if (staleNext && !alm.pending.next && now - alm.lastReq.next > gapFor('next', 700)) {
            const fromMs = tm, toMs = tm + 26 * HOUR;
            request('next', 'riseSet', { bodyIds: RTS_IDS, observer: astroObserver(st.observer), fromMs, toMs }, (data) => {
                alm.next = { data: data || {}, fromMs, toMs, key, firstEventMs: firstEvent(data, fromMs) };
                em.emit('almanac', alm);
            });
        }

        // Today's rise / transit / set for the body card: the observer's local calendar day.
        const dy = alm.day;
        const staleDay = !dy || dy.key !== key || tm < dy.fromMs || tm >= dy.toMs;
        if (staleDay && !alm.pending.day && now - alm.lastReq.day > gapFor('day', 900)) {
            let fromMs = tm - (tm % DAY);
            try { fromMs = services.tz?.localDayStart?.(tm, observerTz(st.observer)) ?? fromMs; } catch { /* keep UTC day */ }
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
            || (Number.isFinite(end) ? (tm > end + 30 * 60e3 || tm < start - 20 * HOUR) : Math.abs(tm - ng.reqMs) > 12 * HOUR);
        if (staleNight && !alm.pending.night && now - alm.lastReq.night > gapFor('night', 1500)) {
            const obs = astroObserver(st.observer);
            const reqMs = tm;
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

        // Event list (scrubber ticks + Events tab): keep [t − 1 yr, t + 1 yr] covered. skyLp, this
        // site's light pollution, sets the meteor-shower rates "under this sky"; a coarse change of it
        // (the city estimate arriving after boot, the Sky darkness setting) refreshes the list.
        const skyLp = ui.snap?.skyglow?.lpZenith;
        const lpBucket = Number.isFinite(skyLp) ? Math.round(2 * Math.log10(1 + Math.max(0, skyLp))) : 0;
        const evStale = !events.list || events.key !== key || events.lp !== lpBucket
            || tm < events.fromMs + 20 * DAY || tm > events.toMs - 300 * DAY;
        if (evStale && !alm.pending.events && now - alm.lastReq.events > gapFor('events', 2500)) {
            const fromMs = tm - 365 * DAY;
            const evArgs = { observer: astroObserver(st.observer), fromMs, days: 730, tz: observerTz(st.observer), hour12: !!st.display?.hour12,
                skyLp: Number.isFinite(skyLp) ? skyLp : undefined };
            request('events', 'events', evArgs, (list) => {
                if (!Array.isArray(list)) return;
                events.list = list.slice().sort((a, b) => a.tMs - b.tMs);
                events.fromMs = fromMs;
                events.toMs = fromMs + 730 * DAY;
                events.key = key;
                events.lp = lpBucket;
                events.source = 'ui';
                em.emit('events', events);
            });
        }

        // Satellite passes (Events, the satellite's card): the next 10 days of the simulated time,
        // once data/tle.json is in; again when the place or the elements change, or time leaves the window.
        const tle = ctx.actions?.satelliteElements?.() ?? null;
        const pStale = tle && (!passes.list || passes.key !== key || passes.tle !== tle
            || tm < passes.fromMs || tm > passes.fromMs + 2 * DAY);
        if (pStale && !alm.pending.passes && now - alm.lastReq.passes > gapFor('passes', 3000)) {
            const fromMs = tm - 20 * 60e3;
            request('passes', 'satPasses', { tle, observer: astroObserver(st.observer), fromMs, days: 10 }, (list) => {
                if (!Array.isArray(list)) return;
                passes.list = list;
                passes.fromMs = fromMs;
                passes.toMs = fromMs + 10 * DAY;
                passes.key = key;
                passes.tle = tle;
                em.emit('passes', passes);
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
        const tm = ui.snap?.tMs ?? ctx.clock?.tMs ?? Date.now();
        if (p.riseSet && !alm.next) {
            alm.next = { data: p.riseSet, fromMs: tm, toMs: tm + 24 * HOUR, key, firstEventMs: firstEvent(p.riseSet, tm) };
        }
        if ((p.tonight || p.twilight) && (!alm.night || alm.night.key !== key)) {
            alm.night = { tonight: p.tonight || null, twilight: p.twilight || null, reqMs: tm, key };
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
        const tm = ui.snap?.tMs ?? ctx.clock?.tMs ?? Date.now();
        events.list = sorted;
        events.fromMs = Math.min(tm, sorted[0]?.tMs ?? tm);
        events.toMs = Math.max(tm + 365 * DAY, sorted.at(-1)?.tMs ?? tm);
        events.key = key;
        events.source = 'app';
        em.emit('events', events);
    }

    function invalidateAlmanac() {
        for (const k of ['next', 'day', 'night', 'events', 'passes']) {
            alm.pending[k]?.abort(); alm.pending[k] = null; alm.lastReq[k] = k === 'passes' ? -Infinity : 0; alm.fails[k] = 0;
        }
        alm.next = alm.day = alm.night = null;
        em.emit('almanac', alm);
        const tm = ui.snap?.tMs ?? ctx.clock?.tMs;
        if (Number.isFinite(tm)) queueMicrotask(() => checkAlmanac(tm));
    }

    /**
     * Rise/set info for one body relative to time t:
     * `{up, nextRiseMs, nextSetMs, status}` from the "next" window, and today's
     * `{riseMs, transitMs, setMs}` from the "day" window.
     */
    function riseSetFor(id, tm) {
        // The almanac (astro worker) is the Earth observer's: from Mars there is none (phase 1).
        if (onMars()) return { status: null, nextRiseMs: null, nextSetMs: null, riseMs: null, transitMs: null, setMs: null, transitAltDeg: null, known: false };
        const nx = alm.next?.data?.[id] || null;
        const dy = alm.day?.data?.[id] || null;
        const valid = (v) => Number.isFinite(v) && v >= tm - 60e3;
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
        if (onMars()) return null;   // the Earth observer's night (astro worker)
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
        passes,
        layout: 'desktop',
        scrubbing: false,
        on: em.on,
        emit: em.emit,
        fmt, act,
        displayTz, observerTz, zoned, toUtc, fmtClock, fmtDate, fmtDay, fmtStamp, fmtSpoken, fmtWhen, offsetText,
        latLonText, placeLabel, placeShort, nearestCityText,
        bodyName, bodySubject, bodyOf, compass, compassWords, altAz, extras, onMars,
        checkAlmanac, ingestAlmanac, ingestEvents, invalidateAlmanac, riseSetFor, tonightFor, observerKey, astroObserver,
        /** True when transitions should be cuts. */
        reducedMotion: () => !!(ctx.store.get().status?.reducedMotion || ctx.env?.reducedMotion || prefersReducedMotion()),
        // Navigation hooks, replaced by the shell / view switch / toast modules.
        openPanel: (_tab, _opts) => {},
        openPalette: () => { ctx.store.set({ ui: { ...ctx.store.get().ui, palette: true } }); },
        closePalette: () => { ctx.store.set({ ui: { ...ctx.store.get().ui, palette: false } }); },
        toggleHelp: (force) => {
            const u = ctx.store.get().ui;
            ctx.store.set({ ui: { ...u, help: typeof force === 'boolean' ? force : !u.help } });
        },
        share: async () => act('share'),
        // The coach marks (ui/coach.js): replay them; are they on screen?
        showTips: () => {},
        coachOpen: () => false,
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
 * The announcer throttles them (one per 2 s, latest wins). Quiet while a guided tour plays: its
 * captions are the narration (store ui.tour; a paused tour hands narration back).
 * @param {any} ctx
 * @returns {() => void} stop
 */
function startNarrator(ctx) {
    const { store, bus, clock, ui } = ctx;
    const touring = () => { const tour = store.get().ui?.tour; return !!tour && !tour.paused; };
    const say = (text) => { if (text && !touring()) bus.emit('announce', text); };
    const offs = [];
    let timeTimer = 0;

    offs.push(store.subscribe((s) => s.observer, (o, prev) => {
        if (!o || !prev) return;
        say(t('Observer set to {place}', { place: ui.placeLabel(o) }));
        if (o.source === 'click') {
            // The click-placement Undo toast (SPEC F.2). Only one Undo toast is kept on screen.
            bus.emit('toast', {
                message: t('Observer moved to {place}', { place: ui.placeLabel(o) }), kind: 'info', actionLabel: t('Undo'), actionIcon: 'undo',
                onAction: () => ui.act('undoObserver'), timeoutMs: 8000,
            });
        }
    }));

    offs.push(store.subscribe((s) => s.selection, (id) => {
        if (!id) { say(t('Selection cleared')); return; }
        const body = ui.bodyName(id);
        const b = ui.bodyOf(ui.snap, id);
        const { alt, az } = ui.altAz(b);
        if (!b || !Number.isFinite(alt)) { say(t('{body} selected', { body })); return; }
        say(alt >= 0
            ? t('{body} selected, {deg} degrees up in the {dir}', { body, deg: Math.round(alt), dir: ui.compassWords(az) })
            : t('{body} selected, below the horizon', { body }));
    }));

    if (clock?.onChange) {
        let once = false;
        offs.push(clock.onChange((ev) => {
            const type = ev?.type;
            if (type === 'clamp') {
                bus.emit('toast', { message: t('{app} covers years 1000–3000.', { app: APP_NAME }), kind: 'warn' });
                say(t('{app} covers years 1000 to 3000. Time paused.', { app: APP_NAME }));
                return;
            }
            if (ui.scrubbing) return;
            if (type === 'live') { say(t('Live: showing the sky right now')); return; }
            if (type === 'rate') { say(t('Speed {rate}', { rate: ui.fmt('fmtRate', clock.rate) })); return; }
            if (type === 'range') {
                const r = clock.range;
                if (r) once = r.loop === 'once';
                say(r ? (once ? t('Playing.') : t('Loop started.')) : once ? t('Playback stopped.') : t('Loop stopped.'));
                return;
            }
            if (type === 'pause' || type === 'jump' || type === 'play') {
                // Debounced so a burst of steps reads out once, with the final time.
                clearTimeout(timeTimer);
                timeTimer = setTimeout(() => {
                    const time = ui.fmtSpoken(clock.tMs);
                    if (!clock.playing) say(t('Time: {time}, paused', { time }));
                    else if (type === 'play') say(clock.live ? t('Playing, live') : t('Playing at {rate}', { rate: ui.fmt('fmtRate', clock.rate) }));
                    else say(t('Time: {time}', { time }));
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
            ? t('Up now: {list}.', { list: up.map((u) => `${ui.bodyName(u.id)} ${Math.round(u.alt)}° ${ui.compass(u.az)}`).join(', ') })
            : t('Nothing is above the horizon.'));
        if (!moonUp) parts.push(t('Moon set.'));
        const text = parts.join(' ');
        if (text !== last) { last = text; canvas.setAttribute('aria-label', text); }
    };
    const id = setInterval(tick, 4000);
    const off = ui.on('snap', () => { if (!last) tick(); });
    return () => { clearInterval(id); off(); };
}
