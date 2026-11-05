// Count-based performance gates for the smoke test (`node scripts/smoke.mjs --perf`).
//
// Shared CI runners are noisy and SwiftShader is slow, so nothing here is judged in milliseconds.
// What is judged is a count that a regression changes on any machine running the same code:
//
//   - shader programs and draw calls, globe and sky view, per tier (PERF_BUDGETS);
//   - frames drawn in 3 s while nothing moves: none on the paused globe, none in a paused sky view
//     either unless the tier twinkles the stars, and then at most TWINKLE_MAX_FPS, never two
//     frames sooner than the loop's twinkle interval (js/app/loop.js TWINKLE_FRAME_MS);
//   - layout reads (getBoundingClientRect, getClientRects) made inside a requestAnimationFrame
//     callback during a 3 s time-lapse: none.
//
// The boot's long animation frames are reported, not judged: on SwiftShader the longest one is
// the shader compile, 2.5–9 s here depending on the tier and the machine's load.
//
// PERF_SHIM runs before the page's own scripts (CDP Page.addScriptToEvaluateOnNewDocument);
// perfProbe runs in the page once the app is ready; judgePerf turns its result into checks.

import { TIERS } from '../../js/core/quality.js';
import { TWINKLE_FRAME_MS } from '../../js/app/loop.js';

/**
 * Per tier: shader programs (three's program cache once the views have been drawn) and draw
 * calls of a settled frame, globe and sky view. Measured on the CI scene (perfScene) at
 * 1440×900 with SwiftShader, plus about 10 %; raise one deliberately, with a dated note.
 *
 * 2026-11-04 baseline (measured → budget): low 48 programs → 52, 21 / 12 draws → 24 / 14;
 * medium 59 → 64, 38 / 28 → 42 / 31; high 59 → 64, 40 / 29 → 44 / 32.
 */
export const PERF_BUDGETS = Object.freeze({
    low: Object.freeze({ programs: 52, drawCalls: Object.freeze({ globe: 24, sky: 14 }) }),
    medium: Object.freeze({ programs: 64, drawCalls: Object.freeze({ globe: 42, sky: 31 }) }),
    high: Object.freeze({ programs: 64, drawCalls: Object.freeze({ globe: 44, sky: 32 }) }),
});

/** The quiet windows (ms): frames are counted over this long with nothing moving. */
export const PERF_WINDOW_MS = 3000;
/** A twinkling sky view may draw at most this many frames a second (the loop aims at 30). */
export const TWINKLE_MAX_FPS = 32;
/** Two frames of a paused sky view closer than this (ms) mean the twinkle cap is gone. */
export const TWINKLE_MIN_INTERVAL_MS = TWINKLE_FRAME_MS - 2;

/**
 * The scene the CI perf runs open (and the budgets were measured on): Ho Chi Minh City at
 * 22:00 local on 4 Nov 2026, paused, no intro. Night, so a twinkling tier has stars to twinkle.
 * @param {string} q quality setting
 * @returns {string} a --url for smoke
 */
export function perfScene(q) {
    return `/#loc=10.8231,106.6297&n=Ho%20Chi%20Minh%20City&tz=Asia/Ho_Chi_Minh&t=2026-11-04T15:00:00Z&p=0&intro=0&q=${q}`;
}

/**
 * The in-page shim (a string for addScriptToEvaluateOnNewDocument). `window.__perf` counts layout
 * reads made inside requestAnimationFrame callbacks (`inRaf`, with a few call sites in `stacks`)
 * and collects long-animation-frame durations (`loaf`).
 */
export const PERF_SHIM = `(() => {
    const P = window.__perf = { inRaf: 0, reads: 0, stacks: [], loaf: [] };
    let depth = 0;
    const raf = window.requestAnimationFrame;
    if (typeof raf === 'function') {
        window.requestAnimationFrame = function (cb) {
            return raf.call(window, function (t) { depth++; try { return cb(t); } finally { depth--; } });
        };
    }
    const protos = [window.Element && window.Element.prototype, window.Range && window.Range.prototype];
    for (const proto of protos) {
        if (!proto) continue;
        for (const k of ['getBoundingClientRect', 'getClientRects']) {
            const f = proto[k];
            if (typeof f !== 'function') continue;
            proto[k] = function () {
                P.reads++;
                if (depth > 0) {
                    P.inRaf++;
                    if (P.stacks.length < 8) P.stacks.push(k + ' ' + String(new Error().stack || '').split('\\n').slice(2, 4).map((s) => s.trim()).join(' < '));
                }
                return f.apply(this, arguments);
            };
        }
    }
    try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) P.loaf.push(Math.round(e.duration)); })
            .observe({ type: 'long-animation-frame', buffered: true });
    } catch (e) { /* no LoAF in this browser */ }
})();`;

/**
 * Runs in the page (smoke evaluates `(${perfProbe})(opts)`), so it must not close over anything.
 * Pauses the clock, waits for the globe to settle (supersampling done, no frame for quietMs),
 * counts; then a time-lapse at 1 h/s; then the sky view, settled, counted. The clock is put back.
 * @param {{windowMs:number, quietMs?:number, settleMs?:number, shortMs:number}} opts
 * @returns {Promise<object>} the measurements, or {error}
 */
export async function perfProbe({ windowMs, quietMs = 1500, settleMs = 90000, shortMs }) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const A = window.__app, R = A && A.internals, P = window.__perf || null;
    if (!R || !R.rc || !R.loop || !R.rig) return { error: 'no render context (text mode?)' };
    const c = A.clock;
    const frames = () => A.stats().frames;
    const ssDone = () => { const s = R.loop.supersample; return !(s && s.cap > 1) || s.samples >= s.cap; };
    const counts = () => { const s = A.stats(); return { programs: s.programs, drawCalls: s.drawCalls }; };
    const settle = async () => {
        const t0 = performance.now();
        let f = frames(), since = t0;
        while (performance.now() - t0 < settleMs) {
            await sleep(100);
            const g = frames(), now = performance.now();
            if (g !== f) { f = g; since = now; } else if (now - since >= quietMs && ssDone()) return Math.round(now - t0);
        }
        return null;
    };
    const t0 = c.tMs, wasLive = c.live, wasPlaying = c.playing, rate = c.rate;
    const out = { tier: A.tier, loaf: P ? P.loaf.slice().sort((a, b) => b - a) : null, shim: !!P };
    try {
        c.pause();
        out.globeSettleMs = await settle();
        out.globe = counts();
        let f0 = frames();
        await sleep(windowMs);
        out.globe.pausedFrames = frames() - f0;

        const g0 = P ? P.inRaf : 0;
        if (P) P.stacks.length = 0;
        f0 = frames();
        c.setRate(3600);
        c.play();
        await sleep(windowMs);
        c.pause();
        out.timelapse = { frames: frames() - f0, layoutReadsInFrame: P ? P.inRaf - g0 : null, stacks: P ? P.stacks.slice() : [] };
        c.setTime(t0);

        A.actions.setViewMode('sky');
        const ts = performance.now();
        const inSky = () => A.store.get().view.mode === 'sky' && R.rig.skyBlend === 1 && !R.rig.tweening;
        while (performance.now() - ts < 30000 && !inSky()) await sleep(100);
        out.skyEnterMs = inSky() ? Math.round(performance.now() - ts) : null;
        // The new view's supersampling history fills first; a twinkling tier then keeps drawing.
        const tq = performance.now();
        while (performance.now() - tq < settleMs && !ssDone()) await sleep(100);
        await sleep(500);
        out.sky = counts();
        const marks = [];
        let last = frames(), on = true;
        const tick = (t) => {
            const n = frames();
            if (n !== last) { marks.push(t); last = n; }
            if (on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        f0 = frames();
        await sleep(windowMs);
        on = false;
        out.sky.pausedFrames = frames() - f0;
        let short = 0, minIv = null;
        for (let i = 1; i < marks.length; i++) {
            const d = marks[i] - marks[i - 1];
            if (minIv === null || d < minIv) minIv = d;
            if (d < shortMs) short++;
        }
        out.sky.shortIntervals = short;
        out.sky.minIntervalMs = minIv === null ? null : Math.round(minIv * 10) / 10;
    } catch (e) {
        out.error = String((e && e.message) || e);
    } finally {
        if (wasLive) c.goLive();
        else { c.setTime(t0); c.setRate(rate); if (wasPlaying) c.play(); else c.pause(); }
    }
    return out;
}

/** The probe's options for a run: the windows, and the twinkle interval floor. */
export const PROBE_OPTIONS = Object.freeze({ windowMs: PERF_WINDOW_MS, shortMs: TWINKLE_MIN_INTERVAL_MS });

/**
 * Turns a probe result into smoke checks. Budgets apply to the tiers that have one; frame and
 * layout-read gates apply everywhere.
 * @param {object} m perfProbe's result
 * @param {{budgets?:object, windowMs?:number}} [opts]
 * @returns {{name:string, ok:boolean, detail:string}[]}
 */
export function judgePerf(m, { budgets = PERF_BUDGETS, windowMs = PERF_WINDOW_MS } = {}) {
    if (!m || m.error) return [{ name: 'perf', ok: false, detail: m?.error ?? 'no result' }];
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name: `perf: ${name}`, ok: !!ok, detail });
    const sec = windowMs / 1000;
    add('globe settles', m.globeSettleMs !== null, m.globeSettleMs === null ? 'still drawing' : `${(m.globeSettleMs / 1000).toFixed(1)} s`);
    add('sky view entered', m.skyEnterMs !== null, m.skyEnterMs === null ? 'no sky view within 30 s' : `${(m.skyEnterMs / 1000).toFixed(1)} s`);

    const b = budgets[m.tier];
    if (b) {
        const programs = Math.max(m.globe?.programs ?? 0, m.sky?.programs ?? 0);
        add(`programs (${m.tier})`, programs <= b.programs, `${programs} ≤ ${b.programs}`);
        add(`draw calls, globe (${m.tier})`, m.globe.drawCalls <= b.drawCalls.globe, `${m.globe.drawCalls} ≤ ${b.drawCalls.globe}`);
        add(`draw calls, sky (${m.tier})`, m.sky.drawCalls <= b.drawCalls.sky, `${m.sky.drawCalls} ≤ ${b.drawCalls.sky}`);
    } else {
        add('budgets', true, `none for tier ${m.tier}: counts not judged`);
    }

    add('paused globe: no frames', m.globe.pausedFrames === 0, `${m.globe.pausedFrames} frames in ${sec} s`);
    const twinkles = TIERS[m.tier]?.twinkle === true;
    const maxSky = twinkles ? Math.floor(TWINKLE_MAX_FPS * sec) : 0;
    const skyOk = m.sky.pausedFrames <= maxSky && !(m.sky.shortIntervals > 0);
    add(twinkles ? `paused sky: twinkle ≤ ${TWINKLE_MAX_FPS}/s` : 'paused sky: no frames', skyOk,
        `${m.sky.pausedFrames} frames in ${sec} s (max ${maxSky})`
        + (twinkles ? `, ${m.sky.shortIntervals ?? 0} under ${TWINKLE_MIN_INTERVAL_MS.toFixed(1)} ms apart` : ''));

    const reads = m.timelapse?.layoutReadsInFrame;
    add('time-lapse layout reads in rAF', reads === 0,
        reads === null || reads === undefined ? 'shim missing' : `${reads} in ${sec} s, ${m.timelapse.frames} frames`
            + (reads > 0 && m.timelapse.stacks?.length ? `: ${m.timelapse.stacks[0]}` : ''));
    return checks;
}

/**
 * A one-line summary of the numbers, for the smoke log (the boot LoAF is reported here only).
 * @param {object} m perfProbe's result
 * @returns {string}
 */
export function perfSummary(m) {
    if (!m || m.error) return `perf: ${m?.error ?? 'no result'}`;
    const loaf = Array.isArray(m.loaf) && m.loaf.length ? `${m.loaf[0]} ms longest, ${m.loaf.filter((d) => d >= 1000).length} ≥ 1 s` : 'none';
    return `tier=${m.tier} programs=${m.globe?.programs}/${m.sky?.programs} drawCalls=${m.globe?.drawCalls}/${m.sky?.drawCalls} `
        + `paused frames=${m.globe?.pausedFrames}/${m.sky?.pausedFrames} sky min interval=${m.sky?.minIntervalMs ?? '-'} ms `
        + `time-lapse frames=${m.timelapse?.frames} boot LoAF: ${loaf}`;
}
