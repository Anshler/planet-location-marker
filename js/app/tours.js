/**
 * Guided tours (ROADMAP Phase 5, guided-tours): short narrated sequences played with the app's own
 * controls: the clock (sweeps, ranges, rates), the actions (event jumps, the shadow chase), the
 * store (view, selection, layers, tracking) and the rig (sky looks, globe flights, the telescope
 * framing). main.js loads this module on demand (actions.startTour); the catalogue the UI lists and
 * the URL accepts (`#tour=<id>`) is core/tour-catalog.js.
 *
 * A tour is a list of steps: plain data built by the pure `*Steps` functions below from the
 * observer, the time and, for 'Tonight from here', the worker's tonight() report. The runner plays
 * them in order. For each step it shows the caption (store `ui.tour`, drawn by ui/tour-bar.js and
 * mirrored to the announcer), applies the observer, clock, selection, layers and camera, waits for
 * the camera (and for a clock target, a day-by-day sweep or the shadow chase), then holds.
 *
 * - Esc or 'End tour' ends a tour. Any other pointer, wheel or key input pauses it: Resume replays
 *   the step and Next skips it. The Ambient tour ends on input.
 * - While a tour plays (`ui.tour` set), main.js saves no layers to prefs and writes no URL hash. The
 *   observer it places has source 'tour', which is never persisted. At the end the runner restores
 *   the observer, selection, view, layers, cinema, the sheet, the eclipse in focus, the clock and,
 *   unless input ended it, the camera.
 * - Text mode (no rig): camera steps are skipped; captions, the observer and time jumps still play.
 * - Reduced motion: the rig turns flights into cuts, the clock jumps instead of sweeping, and the
 *   Ambient tour holds still between cuts.
 *
 * No three.js here.
 * @module app/tours
 */
import { BODIES, BODY_INDEX, isBodyId } from '../astro/bodies.js';
import { createSnapshot, computeSnapshot } from '../astro/snapshot.js';
import { tonight as tonightReport } from '../astro/almanac.js';
import { localSolarEclipseAt } from '../astro/events.js';
import { AE } from '../astro/ae.js';
import { fmtTime, compassWord } from '../core/format.js';
import { isTourId, tourById } from '../core/tour-catalog.js';
import { telescopeFov } from './actions.js';

/** @typedef {import('../core/types.js').Observer} Observer */

/**
 * One step of a tour. Every field but `caption` and `holdMs` is optional.
 * @typedef {{caption:string, holdMs:number, captionMs?:number,
 *   observer?:Partial<Observer>&{latDeg:number, lonDeg:number},
 *   time?:TimeCue, then?:{time?:TimeCue, track?:'none'|'body'|'stars'},
 *   view?:'orbit'|'sky', look?:{azDeg:number, altDeg:number, fovDeg?:number},
 *   fly?:{latDeg:number, lonDeg:number, distance?:number, durationMs?:number},
 *   earthLock?:boolean, select?:string|null, layers?:Record<string, boolean>, cinema?:boolean,
 *   eclipse?:object|null, track?:'none'|'body'|'stars', telescope?:string, event?:object, chase?:number,
 *   sweep?:{fromMs:number, stepMs:number, count:number, wallMs:number}, untilMs?:number}} TourStep
 * `holdMs` is the dwell after the moves settle; with `untilMs` (a simulated time) it is the longest
 * wait for the clock to get there, and with `chase` the longest wait for the chase to end.
 * `captionMs` hides the caption after that long (Ambient). `then` applies after the camera arrives.
 */
/** @typedef {{tMs?:number, animateMs?:number, play?:boolean, rate?:number, live?:boolean, range?:object}} TimeCue */

const MIN = 6e4;
const HOUR = 36e5;
const DAY = 864e5;
const OBLIQUITY_DEG = 23.44;
/** Longest wait for a camera move before the step goes on (the move itself carries on). */
const MOVE_CAP_MS = 5000;
/** The worker's tonight() report, else the same computation here. */
const TONIGHT_TIMEOUT_MS = 4000;
const POLL_MS = 120;

/** The total solar eclipse of 2 August 2027 and the tour's viewpoint in the path, Luxor (6 min 25 s). */
export const ECLIPSE_2027_MS = Date.parse('2027-08-02T10:07:00Z');
export const ECLIPSE_2027_SITE = Object.freeze({
    latDeg: 25.6872, lonDeg: 32.6396, elevM: 80, name: 'Luxor', country: 'Egypt', cc: 'EG', tz: 'Africa/Cairo',
});

/** Planets worth a stop tonight: the naked-eye ones with these verdicts. */
const PLANET_VERDICTS = new Set(['excellent', 'good', 'low', 'twilight']);
const MOON_VERDICTS = PLANET_VERDICTS;
const DIM_PLANETS = new Set(['uranus', 'neptune']);
const MAX_PLANET_STOPS = 5;
const TELESCOPE_CAPTION = Object.freeze({
    jupiter: 'Through a small telescope: Jupiter’s cloud belts and its four Galilean moons, lined up along its equator.',
    saturn: 'Through a small telescope: Saturn and its rings.',
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const noop = () => {};
const settle = (p) => {
    if (p && typeof p.catch === 'function') p.catch(noop);
    return p;
};
const nameOf = (id) => BODIES[BODY_INDEX[id]]?.name ?? id;

/** '6 min 25 s' (durations under an hour, to the second). */
export function minSec(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m} min ${s % 60} s` : `${s} s`;
}

// ---------------------------------------------------------------------------------------------
// Step builders (pure)
// ---------------------------------------------------------------------------------------------

/**
 * 'Tonight from here' from a tonight() report: sunset and the fading twilight toward the sunset
 * point, then each well-placed planet at its best moment (time order), tracked while the sky turns
 * at 5 min/s, with a telescope view for a well-placed Jupiter or Saturn, then the Moon.
 * @param {{twilight?:any, nightStartMs?:number|null, reports?:any[]}|null} res
 * @param {{place:string, fmt:(ms:number)=>string, sunAt:(ms:number)=>{azDeg:number, altDeg:number}, latDeg:number}} ctx
 * @returns {TourStep[]}
 */
export function tonightSteps(res, { place, fmt, sunAt, latDeg }) {
    const steps = [];
    const tw = res?.twilight ?? {};
    const reports = Array.isArray(res?.reports) ? res.reports : [];
    const sunset = tw.sunsetMs;
    const dark = [tw.astroDuskMs, tw.nauticalDuskMs, tw.civilDuskMs].find((x) => fin(x) && fin(sunset) && x > sunset) ?? null;
    if (fin(sunset)) {
        const s = sunAt(sunset);
        steps.push({
            caption: `Tonight from ${place}. The Sun sets at ${fmt(sunset)} in the ${compassWord(s.azDeg)}.`,
            time: { tMs: sunset - 4 * MIN, animateMs: 1600, play: false }, view: 'sky', select: null, track: 'none',
            look: { azDeg: s.azDeg, altDeg: 6, fovDeg: 70 }, then: { time: { rate: 60, play: true } }, holdMs: 6000,
        });
        if (dark !== null) {
            steps.push({
                caption: fin(tw.astroDuskMs) && dark === tw.astroDuskMs
                    ? `Twilight fades. The sky is fully dark by ${fmt(dark)}.`
                    : `Twilight fades, but the sky stays bright tonight: the Sun never sinks far below the horizon.`,
                time: { range: { fromMs: sunset, toMs: dark, durationS: 6, loop: 'once', ease: 'inOut' } },
                look: { azDeg: s.azDeg, altDeg: 22, fovDeg: 95 }, holdMs: 6500,
            });
        }
    } else {
        steps.push({
            caption: res && res.nightStartMs === null
                ? `Tonight from ${place}: the Sun does not set, so the sky never gets dark.`
                : `Tonight from ${place}.`,
            holdMs: 4500,
        });
    }

    const ok = (r) => r && fin(r.bestMs) && fin(r.bestAzDeg) && fin(r.bestAltDeg);
    const planets = reports
        .filter((r) => ok(r) && r.id !== 'moon' && !DIM_PLANETS.has(r.id) && PLANET_VERDICTS.has(r.verdict))
        .sort((a, b) => a.bestMs - b.bestMs)
        .slice(0, MAX_PLANET_STOPS);
    for (const p of planets) {
        steps.push({
            caption: p.sentence || `${nameOf(p.id)} tonight.`,
            time: { tMs: p.bestMs, animateMs: 1400, play: false }, view: 'sky', select: p.id, track: 'none',
            look: { azDeg: p.bestAzDeg, altDeg: Math.max(4, p.bestAltDeg), fovDeg: 40 },
            then: { track: 'body', time: { rate: 300, play: true } }, holdMs: 6500,
        });
        if (TELESCOPE_CAPTION[p.id] && (p.verdict === 'excellent' || p.verdict === 'good')) {
            steps.push({ caption: TELESCOPE_CAPTION[p.id], telescope: p.id, time: { rate: 60, play: true }, holdMs: 7000 });
        }
    }
    if (!planets.length) {
        const at = fin(dark) ? dark + HOUR : fin(sunset) ? sunset + 2 * HOUR : null;
        steps.push({
            caption: 'No bright planets are well placed tonight, but the stars are out.',
            ...(at !== null ? { time: { tMs: at, animateMs: 1400, play: false } } : {}),
            view: 'sky', select: null, track: 'none', look: { azDeg: latDeg >= 0 ? 180 : 0, altDeg: 40, fovDeg: 80 },
            then: { time: { rate: 300, play: true } }, holdMs: 6000,
        });
    }

    const moon = reports.find((r) => r?.id === 'moon');
    if (ok(moon) && MOON_VERDICTS.has(moon.verdict)) {
        steps.push({
            caption: moon.sentence || 'The Moon tonight.',
            time: { tMs: moon.bestMs, animateMs: 1400, play: false }, view: 'sky', select: 'moon', track: 'none',
            look: { azDeg: moon.bestAzDeg, altDeg: Math.max(4, moon.bestAltDeg), fovDeg: 30 },
            then: { track: 'body', time: { rate: 300, play: true } }, holdMs: 6000,
        });
        const lit = fin(moon.phaseFrac) ? `, ${Math.round(moon.phaseFrac * 100)}% lit` : '';
        steps.push({ caption: `Up close: the Moon${lit}. Craters stand out best along the line between day and night.`, telescope: 'moon', time: { rate: 60, play: true }, holdMs: 6500 });
    } else if (moon?.sentence) {
        steps.push({ caption: moon.sentence, holdMs: 4500 });
    }
    steps.push({ caption: `That’s tonight from ${place}. Clear skies!`, holdMs: 3500 });
    return steps;
}

/**
 * The instant of local mean solar time `hour` on the UT day of `ms` at longitude `lonDeg`
 * (whole days apart from one date to the next, so the Earth faces the Sun the same way).
 */
export function localMeanTime(ms, hour, lonDeg) {
    return Math.floor(ms / DAY) * DAY + (hour - lonDeg / 15) * HOUR;
}

/** The noon altitude of the Sun at declination decDeg seen from latitude latDeg (no refraction). */
const noonAlt = (latDeg, decDeg) => 90 - Math.abs(latDeg - decDeg);

/**
 * 'A year in a minute': the globe held at the observer's local dawn each day while a year passes
 * in four sweeps, equinox to solstice (the dawn line through the observer's meridian tilts with the
 * seasons, the subsolar point swings between the tropics), then the year again in sky view at local
 * noon, where the Sun climbs and sinks and weaves its figure-eight.
 * @param {{observer:{latDeg:number, lonDeg:number}, place:string,
 *          seasons:{marMs:number, junMs:number, sepMs:number, decMs:number, nextMarMs:number}}} ctx
 * @returns {TourStep[]}
 */
export function yearSteps({ observer, place, seasons }) {
    const lat = observer.latDeg, lon = observer.lonDeg;
    const dawn = (ms) => localMeanTime(ms, 6, lon);
    const noon = (ms) => localMeanTime(ms, 12, lon);
    const days = (a, b) => Math.max(2, Math.round((b - a) / DAY) + 1);
    const { marMs, junMs, sepMs, decMs, nextMarMs } = seasons;
    const sweep = (from, to, wallMs) => ({ fromMs: dawn(from), stepMs: DAY, count: days(dawn(from), dawn(to)), wallMs });
    const north = lat >= 0;
    const steps = [
        {
            caption: `A year in a minute. The globe holds still at dawn in ${place} each day: watch the line between day and night.`,
            // Side-on to the dawn line, without beams: it turns about the disc centre like a clock hand.
            view: 'orbit', earthLock: true, select: null, track: 'none', layers: { beams: false, ghostBeams: false, sunMoonBeams: false },
            fly: { latDeg: north ? 10 : -10, lonDeg: lon, distance: 3.9 },
            time: { tMs: dawn(marMs), animateMs: 1800, play: false }, holdMs: 3500,
        },
        { caption: 'March equinox: the Sun stands over the equator, and day and night are equal everywhere.', sweep: sweep(marMs, junMs, 7000), holdMs: 700 },
        { caption: 'June solstice: the Sun is over the Tropic of Cancer, and the Arctic has the midnight sun.', sweep: sweep(junMs, sepMs, 7000), holdMs: 700 },
        { caption: 'September equinox: the Sun crosses the equator again, heading south.', sweep: sweep(sepMs, decMs, 7000), holdMs: 700 },
        { caption: 'December solstice: the Sun is over the Tropic of Capricorn. Now it is the Antarctic’s turn.', sweep: sweep(decMs, nextMarMs, 7000), holdMs: 900 },
    ];
    const hi = Math.round(Math.min(90, noonAlt(lat, north ? OBLIQUITY_DEG : -OBLIQUITY_DEG)));
    const lo = Math.round(noonAlt(lat, north ? -OBLIQUITY_DEG : OBLIQUITY_DEG));
    const [hiMonth, loMonth] = north ? ['June', 'December'] : ['December', 'June'];
    const tropics = Math.abs(lat) < OBLIQUITY_DEG;
    const low = lo > 0 ? `sinks to ${lo}° in ${loMonth}` : `stays below the horizon in ${loMonth}`;
    steps.push({
        caption: tropics
            ? `The same year at noon in ${place}: the Sun passes straight overhead twice, ${low}, and weaves east and west in a figure-eight.`
            : `The same year at noon in ${place}: the Sun rides ${hi}° high in ${hiMonth}, ${low}, and weaves east and west in a figure-eight.`,
        view: 'sky', select: 'sun', track: 'none',
        // The horizon stays in the frame below the lowest noon Sun.
        look: { azDeg: north ? 180 : 0, altDeg: clamp((hi + Math.max(lo, 0)) / 2 - 10, 12, 50), fovDeg: 84 },
        time: { tMs: noon(marMs), animateMs: 0, play: false },
        sweep: { fromMs: noon(marMs), stepMs: DAY, count: days(noon(marMs), noon(nextMarMs)), wallMs: 15000 }, holdMs: 1200,
    });
    steps.push({ caption: 'All of it from the 23.4° tilt of Earth’s axis.', holdMs: 3000 });
    return steps;
}

/**
 * 'Eclipse 2027' from the local eclipse event at the tour's site (events.localSolarEclipseAt): the
 * path on the globe with the Eclipse Companion, the jump to 20 s before second contact in sky view,
 * totality and the 360° sunset, the second diamond ring, then the shadow chase across the Earth.
 * @param {any} ev a local-solar-eclipse event with c2Ms/c3Ms, or null
 * @param {{site:object, sunAt:(ms:number)=>{azDeg:number, altDeg:number}}} ctx
 * @returns {TourStep[]}
 */
export function eclipseSteps(ev, { site, sunAt }) {
    const chase = {
        caption: 'Now ride the Moon’s shadow: three hours from the Atlantic to the Indian Ocean in forty seconds.',
        chase: fin(ev?.tMs) ? ev.tMs : ECLIPSE_2027_MS, holdMs: 60000,
    };
    const end = { caption: 'Mark the date: 2 August 2027. Clear skies!', holdMs: 3500 };
    if (!ev || !fin(ev.c2Ms) || !fin(ev.c3Ms)) return [chase, end];
    const c2 = ev.c2Ms, c3 = ev.c3Ms, dur = minSec(c3 - c2);
    const mid = sunAt((c2 + c3) / 2);
    const out = sunAt(c3);
    return [
        {
            caption: `2 August 2027: the Moon’s shadow crosses Spain, North Africa and Arabia. From ${site.name}, ${site.country}, totality lasts ${dur}, one of the longest of the century.`,
            observer: site, view: 'orbit', select: 'sun', track: 'none',
            fly: { latDeg: site.latDeg, lonDeg: site.lonDeg, distance: 2.6 },
            time: { tMs: c2 - 30 * MIN, animateMs: 1800, play: false },
            eclipse: { peakMs: ev.tMs, kind: ev.eclipseKind ?? 'total', local: true, eventId: ev.id ?? null }, holdMs: 6500,
        },
        { caption: 'Twenty seconds to totality. The last sliver of Sun breaks into Baily’s beads, then the diamond ring.', event: ev, untilMs: c2 + 1500, holdMs: 30000 },
        { caption: `Totality: ${dur} of night at midday. The corona streams out, and the brightest planets and stars appear.`, holdMs: 11000 },
        { caption: 'Look around: a 360° sunset glows on every horizon.', view: 'sky', look: { azDeg: mid.azDeg, altDeg: clamp(mid.altDeg - 40, 25, 42), fovDeg: 100 }, holdMs: 8000 },
        {
            caption: `${dur.replace(/ \d+ s$/, '')} later the Moon moves on, and the Sun returns in a second diamond ring.`,
            time: { tMs: c3 - 15e3, animateMs: 1500, play: true, rate: 1 }, view: 'sky',
            look: { azDeg: out.azDeg, altDeg: Math.min(88, out.altDeg), fovDeg: 5 }, untilMs: c3 + 5000, holdMs: 26000,
        },
        chase,
        end,
    ];
}

/**
 * One Ambient cycle: a slow 30 s drift around the live globe, then a cut to the sky view on the
 * highest bright body (the Moon, or a planet brighter than magnitude 1.6), its caption fading out.
 * @param {{observer:{latDeg:number, lonDeg:number}, place:string, snap:any, cycle:number}} ctx
 *   `snap`: a full-detail snapshot of now (or null)
 * @returns {TourStep[]}
 */
export function ambientSteps({ observer, place, snap, cycle }) {
    const shift = cycle % 2 ? -40 : 40;
    const steps = [{
        caption: `Live from ${place}: the Sun, the Moon and the planets in their true directions.`, captionMs: 7000,
        time: { live: true }, view: 'orbit', earthLock: true, select: null, track: 'none', cinema: true,
        fly: { latDeg: clamp(observer.latDeg, -60, 60) * 0.7, lonDeg: observer.lonDeg + shift, distance: 3.8, durationMs: 30000 },
        holdMs: 30000,
    }];
    const best = highestBright(snap);
    steps.push(best
        ? {
            caption: `${nameOf(best.id)}, ${Math.round(best.altDeg)}° up in the ${compassWord(best.azDeg)}.`, captionMs: 7000,
            view: 'sky', select: best.id, track: 'none', look: { azDeg: best.azDeg, altDeg: best.altDeg, fovDeg: 50 },
            then: { track: 'stars' }, holdMs: 30000,
        }
        : {
            caption: 'The sky overhead, live.', captionMs: 7000, view: 'sky', select: null, track: 'none',
            look: { azDeg: observer.latDeg >= 0 ? 180 : 0, altDeg: 45, fovDeg: 90 }, then: { track: 'stars' }, holdMs: 30000,
        });
    return steps;
}

/** The highest of the Moon and the planets brighter than mag 1.6 that stand at least 8° up, or null. */
export function highestBright(snap) {
    const bodies = snap?.bodies;
    if (!bodies) return null;
    let best = null;
    for (const b of bodies) {
        if (!b || b.id === 'sun' || !fin(b.altDeg) || b.altDeg < 8) continue;
        if (b.id !== 'moon' && !(fin(b.mag) && b.mag < 1.6)) continue;
        if (!best || b.altDeg > best.altDeg) best = b;
    }
    return best && { id: best.id, azDeg: best.azDeg, altDeg: best.altDeg };
}

/** The equinoxes and solstices of the year of `tMs` and next March (AE.Seasons), or mean dates. */
export function seasonsOf(tMs) {
    const y = new Date(tMs).getUTCFullYear();
    try {
        const s = AE.Seasons(y), n = AE.Seasons(y + 1);
        return {
            marMs: s.mar_equinox.date.getTime(), junMs: s.jun_solstice.date.getTime(), sepMs: s.sep_equinox.date.getTime(),
            decMs: s.dec_solstice.date.getTime(), nextMarMs: n.mar_equinox.date.getTime(),
        };
    } catch {
        return {
            marMs: Date.UTC(y, 2, 20), junMs: Date.UTC(y, 5, 21), sepMs: Date.UTC(y, 8, 22), decMs: Date.UTC(y, 11, 21),
            nextMarMs: Date.UTC(y + 1, 2, 20),
        };
    }
}

// ---------------------------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------------------------

/** Resolves after `ms`, or at once when `signal` aborts. Never rejects. */
export function wait(ms, signal, timers = globalThis) {
    return new Promise((resolve) => {
        if (signal?.aborted || !(ms > 0)) {
            resolve();
            return;
        }
        let id = 0;
        const done = () => {
            timers.clearTimeout(id);
            signal?.removeEventListener?.('abort', done);
            resolve();
        };
        id = timers.setTimeout(done, ms);
        signal?.addEventListener?.('abort', done, { once: true });
    });
}

/** Resolves when `p` settles, after `ms`, or when `signal` aborts, whichever is first. */
function within(p, ms, signal, timers) {
    if (!p || typeof p.then !== 'function') return Promise.resolve();
    return Promise.race([p.then(noop, noop), wait(ms, signal, timers)]);
}

/** Polls `done()` every POLL_MS until it is true, `ms` passed or `signal` aborted. */
function until(done, ms, signal, timers) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
            if (signal?.aborted || Date.now() - t0 >= ms) {
                resolve(false);
                return;
            }
            let ok = false;
            try {
                ok = !!done();
            } catch {
                ok = true;
            }
            if (ok) resolve(true);
            else timers.setTimeout(tick, POLL_MS);
        };
        tick();
    });
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

/**
 * Creates the tour runner (one per app; main.js keeps it).
 * @param {{store:any, bus?:any, clock:any, actions:any, astro?:any, getRig?:()=>any, getSnap?:()=>any,
 *          win?:any, timers?:{setTimeout:Function, clearTimeout:Function},
 *          raf?:(cb:(t:number)=>void)=>number, now?:()=>number}} deps
 *   getRig: the rig in the 3D view, null in text mode; win: the window (input listeners)
 * @returns {{start(id:string):Promise<boolean>, stop(reason?:string):void, next():void, resume():void,
 *            pause():void, readonly active:boolean, readonly id:string|null}}
 */
export function createTourRunner(deps) {
    const { store, clock, actions } = deps;
    const bus = deps.bus ?? null;
    const getRig = deps.getRig ?? (() => null);
    const getSnap = deps.getSnap ?? (() => null);
    const win = deps.win ?? null;
    const timers = deps.timers ?? globalThis;
    const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const raf = deps.raf ?? (typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => timers.setTimeout(() => cb(now()), 16));
    const scratch = createSnapshot();
    /** @type {any} */
    let run = null;

    const reduced = () => !!store.get().status?.reducedMotion;
    const say = (text) => {
        if (text) bus?.emit?.('announce', text);
    };

    function sunAt(observer, ms) {
        computeSnapshot(ms, observer, scratch, { detail: 'frame' });
        const b = scratch.bodies[BODY_INDEX.sun];
        return { azDeg: b.azGeomDeg, altDeg: b.altGeomDeg };
    }

    function placeOf(o) {
        const n = typeof o?.name === 'string' ? o.name.trim() : '';
        return n || 'your location';
    }

    async function tonightFor(observer, tMs, signal) {
        const o = { latDeg: observer.latDeg, lonDeg: observer.lonDeg, elevM: observer.elevM || 0 };
        const opts = { tz: observer.tz || 'UTC', hour12: !!store.get().display?.hour12 };
        if (deps.astro?.call) {
            try {
                const res = await Promise.race([
                    deps.astro.call('tonight', { observer: o, nearMs: tMs, ...opts }, { signal }),
                    wait(TONIGHT_TIMEOUT_MS, signal, timers).then(() => null),
                ]);
                if (res) return res;
            } catch { /* computed below */ }
        }
        if (signal.aborted) return null;
        return tonightReport(o, tMs, opts);
    }

    /** The steps of tour `id` for the current observer and time (Ambient: one cycle). */
    async function build(id, r) {
        const st = store.get();
        const observer = st.observer;
        const place = placeOf(observer);
        const tMs = clock.tMs;
        if (id === 'tonight') {
            const res = await tonightFor(observer, tMs, r.ac.signal);
            const tz = observer.tz || 'UTC', h12 = !!st.display?.hour12;
            return tonightSteps(res, {
                place, latDeg: observer.latDeg, sunAt: (ms) => sunAt(observer, ms),
                fmt: (ms) => fmtTime(ms, tz, h12, { seconds: false }),
            });
        }
        if (id === 'year') return yearSteps({ observer, place, seasons: seasonsOf(tMs) });
        if (id === 'eclipse-2027') {
            const site = ECLIPSE_2027_SITE;
            let ev = null;
            try {
                ev = localSolarEclipseAt(site, ECLIPSE_2027_MS, { tz: site.tz, hour12: !!st.display?.hour12 });
            } catch {
                ev = null;
            }
            return eclipseSteps(ev, { site, sunAt: (ms) => sunAt(site, ms) });
        }
        // Ambient: the highest bright body right now.
        let snap = null;
        try {
            computeSnapshot(Date.now(), observer, scratch, { detail: 'full' });
            snap = scratch;
        } catch {
            snap = null;
        }
        return ambientSteps({ observer, place, snap, cycle: r.cycle++ });
    }

    // ---- store helpers ---------------------------------------------------------------------

    function publish(r, patch) {
        if (run !== r) return;
        r.view = { ...r.view, ...patch };
        store.set({ ui: { ...store.get().ui, tour: r.view } }, 'tour');
    }

    function setView(patch, source = 'tour') {
        const view = store.get().view;
        store.set({ view: { ...view, ...patch } }, source);
    }

    function applyTime(cue) {
        if (!cue) return;
        const animateMs = reduced() ? 0 : Math.max(0, Number(cue.animateMs) || 0);
        if (cue.live) {
            clock.goLive?.({ animateMs: reduced() ? 0 : 900 });
            return;
        }
        if (cue.range) {
            clock.setRange?.(cue.range);
            return;
        }
        if (fin(cue.tMs)) {
            clock.pause();
            clock.setTime(cue.tMs, { animateMs });
        }
        if (fin(cue.rate)) clock.setRate?.(cue.rate);
        if (cue.play === true) clock.play();
        else if (cue.play === false) clock.pause();
    }

    /** Applies everything a step sets before its camera move; returns the move's promise (or null). */
    function applyStep(r, step) {
        const rig = getRig();
        const animate = !reduced();
        if (step.observer) actions.setObserver?.({ ...step.observer, source: 'tour' }, { fly: false });
        applyTime(step.time);
        const ui = store.get().ui;
        const uiPatch = {};
        if (step.cinema !== undefined) uiPatch.cinema = !!step.cinema;
        if (step.eclipse !== undefined) uiPatch.eclipse = step.eclipse;
        if (Object.keys(uiPatch).length) store.set({ ui: { ...ui, ...uiPatch } }, 'tour');
        if (step.select !== undefined && (step.select === null || isBodyId(step.select)) && store.get().selection !== step.select) {
            store.set({ selection: step.select }, 'tour');
        }
        if (step.layers) store.set({ layers: { ...store.get().layers, ...step.layers } }, 'tour');
        if (typeof step.earthLock === 'boolean' && store.get().view.earthLock !== step.earthLock) setView({ earthLock: step.earthLock });
        if (step.track && (store.get().view.track ?? 'none') !== step.track && !(step.track === 'body' && !store.get().selection)) {
            setView({ track: step.track });
        }
        if (step.event) {
            actions.jumpToEvent?.(step.event);
            return rig ? wait(reduced() ? 0 : 1800, r.stepAc.signal, timers) : null;
        }
        if (step.telescope) return telescope(step.telescope);
        if (!rig) return null;
        let move = null;
        const mode = step.view ?? store.get().view.mode;
        if (mode === 'sky' && step.look) {
            move = settle(rig.setMode?.('sky', { animate, look: step.look }));
        } else if (mode === 'orbit' && step.fly) {
            const f = step.fly;
            const opts = { distance: f.distance ?? 3.4, animate };
            if (fin(f.durationMs) && animate) opts.durationMs = f.durationMs;
            move = settle(rig.flyToLatLon?.(f.latDeg, f.lonDeg, opts));
        }
        // The rig is already heading for the step's mode: the 'event' source keeps main.js's view
        // subscriber from adding a look of its own (actions.viewModeLook).
        if (step.view && store.get().view.mode !== step.view) setView({ mode: step.view }, move ? 'event' : 'tour');
        return move;
    }

    /** The telescope framing on body `id` (sky view, tracking it), when it is up. */
    function telescope(id) {
        const rig = getRig();
        if (!rig || !isBodyId(id)) return null;
        const snap = getSnap();
        const b = snap?.bodies?.[BODY_INDEX[id]];
        if (!b || !(b.altGeomDeg > -1)) return null;
        const fov = telescopeFov(id, snap, rig.camera?.aspect);
        if (fov === null) return null;
        if (store.get().selection !== id) store.set({ selection: id }, 'tour');
        rig.telescope?.(fov);
        setView({ mode: 'sky', track: 'body' });
        return null;
    }

    /** Runs a day-by-day clock sweep, one frame at a time. Resolves when done or aborted. */
    function sweep(cue, signal) {
        const count = Math.max(1, Math.round(cue.count));
        if (reduced()) {
            // No strobing: land on the end of the sweep.
            clock.pause();
            clock.setTime(cue.fromMs + (count - 1) * cue.stepMs);
            return wait(Math.min(cue.wallMs, 2500), signal, timers);
        }
        return new Promise((resolve) => {
            clock.pause();
            const t0 = now();
            let last = -1;
            const frame = () => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                const u = Math.min(1, (now() - t0) / cue.wallMs);
                const k = Math.round(u * (count - 1));
                if (k !== last) {
                    last = k;
                    clock.setTime(cue.fromMs + k * cue.stepMs);
                }
                if (u >= 1) resolve();
                else raf(frame);
            };
            frame();
        });
    }

    async function playStep(r, step) {
        const sc = new AbortController();
        r.stepAc = sc;
        const onRunAbort = () => sc.abort();
        r.ac.signal.addEventListener('abort', onRunAbort, { once: true });
        const signal = sc.signal;
        try {
            publish(r, { step: r.index + 1, steps: r.steps.length, caption: step.caption || '', paused: false });
            const move = applyStep(r, step);
            say(step.caption);
            if (step.captionMs > 0) {
                const ref = r.view;
                timers.setTimeout(() => {
                    if (run === r && r.view === ref) publish(r, { caption: '' });
                }, step.captionMs);
            }
            const animMs = reduced() ? 0 : Math.max(0, Number(step.time?.animateMs) || 0);
            await Promise.all([within(move, MOVE_CAP_MS, signal, timers), wait(animMs, signal, timers)]);
            if (signal.aborted) return;
            if (step.then) {
                applyTime(step.then.time);
                if (step.then.track && !(step.then.track === 'body' && !store.get().selection)) setView({ track: step.then.track });
            }
            if (step.sweep) {
                await sweep(step.sweep, signal);
                await wait(step.holdMs, signal, timers);
            } else if (fin(step.chase)) {
                const ok = getRig() ? await Promise.resolve(actions.chaseEclipse?.(step.chase)).catch(() => false) : false;
                if (signal.aborted) return;
                if (ok) await until(() => !actions.chasing, step.holdMs, signal, timers);
                else await wait(Math.min(step.holdMs, 5000), signal, timers);
            } else if (fin(step.untilMs)) {
                await until(() => clock.tMs >= step.untilMs && !clock.tweening, step.holdMs, signal, timers);
            } else {
                await wait(step.holdMs, signal, timers);
            }
        } finally {
            r.ac.signal.removeEventListener('abort', onRunAbort);
            if (signal.aborted && fin(step.chase) && actions.chasing) actions.stopChase?.();
        }
    }

    // ---- input ------------------------------------------------------------------------------

    const PASS_KEYS = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'OS']);

    function bindInput(r) {
        if (typeof win?.addEventListener !== 'function') return noop;
        const inBar = (e) => {
            const t = e?.target;
            return !!(t && typeof t.closest === 'function' && t.closest('[data-tour-ui]'));
        };
        const onPointer = (e) => {
            if (!inBar(e)) interrupt(r);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                // Esc is the tour's: the global handler (ui/shortcuts.js) must not act on the
                // state the tour has just restored (leave a restored map, cinema or selection).
                e.preventDefault?.();
                e.stopImmediatePropagation?.();
                stop('esc');
                return;
            }
            if (PASS_KEYS.has(e.key) || inBar(e)) return;
            interrupt(r);
        };
        const ptr = { capture: true, passive: true };
        win.addEventListener('pointerdown', onPointer, ptr);
        win.addEventListener('wheel', onPointer, ptr);
        win.addEventListener('keydown', onKey, { capture: true });
        return () => {
            win.removeEventListener('pointerdown', onPointer, ptr);
            win.removeEventListener('wheel', onPointer, ptr);
            win.removeEventListener('keydown', onKey, { capture: true });
        };
    }

    function interrupt(r) {
        if (run !== r) return;
        if (r.ambient) stop('input');
        else pause();
    }

    // ---- state capture and restore -------------------------------------------------------------

    function capture() {
        const s = store.get();
        let cam = null;
        try {
            cam = getRig()?.getView?.() ?? null;
        } catch {
            cam = null;
        }
        return {
            observer: s.observer, selection: s.selection, view: s.view, layers: s.layers,
            cinema: s.ui.cinema, sheet: s.ui.sheet, eclipse: s.ui.eclipse, cam,
            clock: {
                tMs: clock.tMs, rate: clock.baseRate ?? clock.rate, playing: clock.playing, live: clock.live,
                range: clock.range ? { ...clock.range } : null, progress: clock.progress?.() ?? null,
            },
        };
    }

    function restore(saved, reason) {
        const rig = getRig();
        const animate = !reduced();
        const st = store.get();
        const ui = st.ui;
        // Slices merge key by key: keys the tour's observer added (cc, …) are cleared with null.
        const observer = { ...saved.observer };
        for (const k of Object.keys(st.observer)) if (!Object.hasOwn(observer, k)) observer[k] = null;
        store.set({
            observer, selection: saved.selection, layers: saved.layers,
            ui: { ...ui, cinema: saved.cinema, sheet: saved.sheet, eclipse: saved.eclipse },
        }, 'tour');
        if ((store.get().view.track ?? 'none') !== 'none') setView({ track: 'none' });
        const cam = saved.cam;
        let aimed = false;
        if (rig && cam && reason !== 'input') {
            try {
                if (cam.mode === 'sky') settle(rig.setMode?.('sky', { animate, look: { azDeg: cam.azDeg, altDeg: cam.altDeg, fovDeg: cam.fovDeg } }));
                else settle(rig.flyToLatLon?.(cam.latDeg, cam.lonDeg, { distance: cam.distance, animate }));
                aimed = true;
            } catch { /* the view mode below still returns */ }
        }
        store.set({ view: { ...saved.view } }, aimed ? 'event' : 'tour');
        const c = saved.clock;
        if (clock.range) clock.setRange(null);
        if (c.live) {
            clock.goLive?.({ animateMs: animate ? 900 : 0 });
        } else if (c.range) {
            clock.setRange(c.range);
            if (fin(c.progress)) clock.seek?.(c.progress);
            if (!c.playing) clock.pause();
        } else {
            clock.pause();
            clock.setTime(c.tMs, { animateMs: animate ? 1200 : 0 });
            if (fin(c.rate)) clock.setRate?.(c.rate);
            if (c.playing) clock.play();
        }
    }

    /** Ends run `r`. 'restart' hands its saved state to the next tour instead of restoring it. */
    function finish(r, reason) {
        if (run !== r) return;
        run = null;
        r.ac.abort();
        r.offInput();
        r.wake?.();
        try {
            if (actions.chasing) actions.stopChase?.();
        } catch { /* ignore */ }
        if (reason === 'restart') return;
        try {
            restore(r.saved, reason);
        } catch (err) {
            console.error('[tours] restoring the view failed', err);
        }
        store.set({ ui: { ...store.get().ui, tour: null } }, 'tour');
        say(reason === 'done' ? `${r.info.title}: the end` : 'Tour ended');
    }

    // ---- API ----------------------------------------------------------------------------------

    /**
     * Starts tour `id` (ending one that plays). Resolves true once it plays, false for an unknown
     * id, a failed build, or when a newer start or a stop superseded it.
     * @param {string} id
     */
    async function start(id) {
        if (!isTourId(id)) return false;
        // A tour started from another keeps the state the first one found.
        const saved = run ? run.saved : capture();
        if (run) finish(run, 'restart');
        const info = tourById(id);
        const ambient = id === 'ambient';
        try {
            if (actions.chasing) actions.stopChase?.();
        } catch { /* ignore */ }
        const r = {
            id, info, ambient, ac: new AbortController(), stepAc: null, saved,
            steps: [], index: 0, cycle: 0, paused: false, held: false, wake: null, advance: false, view: null, offInput: noop,
        };
        run = r;
        r.view = { id, title: info.title, step: 0, steps: 0, caption: 'Preparing the tour…', paused: false, ambient };
        store.set({ ui: { ...store.get().ui, tour: r.view, sheet: 'peek' } }, 'tour');
        r.offInput = bindInput(r);
        try {
            r.steps = await build(id, r);
        } catch (err) {
            console.error('[tours] the tour could not be prepared', err);
            r.steps = [];
        }
        if (run !== r) return false;
        if (!r.steps.length) {
            finish(r, 'failed');
            return false;
        }
        settle(play(r));
        return true;
    }

    async function play(r) {
        while (run === r) {
            if (r.index >= r.steps.length) {
                if (!r.ambient) break;
                try {
                    r.steps = await build(r.id, r);
                } catch {
                    r.steps = [];
                }
                if (run !== r || !r.steps.length) break;
                r.index = 0;
            }
            try {
                await playStep(r, r.steps[r.index]);
            } catch (err) {
                console.error('[tours] a step failed', err);
            }
            if (run !== r) return;
            if (r.held) {
                // Interrupted by a pause (perhaps already resumed): replay the step, or skip it after Next.
                r.held = false;
                if (r.paused) await new Promise((resolve) => { r.wake = resolve; });
                r.wake = null;
                if (run !== r) return;
                if (r.advance) r.index++;
                r.advance = false;
                continue;
            }
            r.index++;
        }
        finish(r, 'done');
    }

    /** Ends the tour that plays and restores the state it found. */
    function stop(reason = 'stop') {
        if (run) finish(run, reason);
    }

    /** Pauses the tour where it is (input does this); the camera and clock are left to the user. */
    function pause() {
        const r = run;
        if (!r || r.paused) return;
        r.paused = true;
        r.held = true;
        r.stepAc?.abort();
        publish(r, { paused: true });
        say('Tour paused. Resume or end it from the caption bar.');
    }

    function wakeUp(r, advance) {
        r.paused = false;
        r.advance = advance;
        const w = r.wake;
        if (w) w();
    }

    /** Skips to the next step (from a pause too). */
    function next() {
        const r = run;
        if (!r) return;
        if (r.paused) wakeUp(r, true);
        else r.stepAc?.abort();
    }

    /** Replays the paused step and carries on. */
    function resume() {
        const r = run;
        if (r?.paused) wakeUp(r, false);
    }

    return {
        start, stop, next, resume, pause,
        get active() { return run !== null; },
        get id() { return run?.id ?? null; },
    };
}
