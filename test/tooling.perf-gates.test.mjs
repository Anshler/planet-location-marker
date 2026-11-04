// Unit tests for scripts/lib/perf-gates.mjs: the judge, the in-page shim and the probe (the last
// two run in a node:vm context with a fake window and a fake app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { TIER_ORDER } from '../js/core/quality.js';
import {
    PERF_BUDGETS, PERF_SHIM, PERF_WINDOW_MS, TWINKLE_MAX_FPS, TWINKLE_MIN_INTERVAL_MS, PROBE_OPTIONS,
    perfProbe, judgePerf, perfScene, perfSummary,
} from '../scripts/lib/perf-gates.mjs';

/** A probe result that passes every gate for `tier`. */
function good(tier, over = {}) {
    return {
        tier, loaf: [3000, 1200, 80], shim: true, globeSettleMs: 4000, skyEnterMs: 3000,
        globe: { programs: 40, drawCalls: 10, pausedFrames: 0 },
        timelapse: { frames: 6, layoutReadsInFrame: 0, stacks: [] },
        sky: { programs: 40, drawCalls: 8, pausedFrames: 0, shortIntervals: 0, minIntervalMs: null },
        ...over,
    };
}
const failing = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test('perf gates: every automatic tier has a budget; the CI scene is paused and skips the intro', () => {
    for (const t of TIER_ORDER) {
        const b = PERF_BUDGETS[t];
        assert.ok(b && b.programs > 0 && b.drawCalls.globe > 0 && b.drawCalls.sky > 0, t);
    }
    const url = perfScene('high');
    assert.match(url, /^\/#/);
    for (const k of ['p=0', 'intro=0', 'q=high', 't=2026-11-04T15:00:00Z']) assert.ok(url.includes(k), k);
    assert.equal(PROBE_OPTIONS.windowMs, PERF_WINDOW_MS);
    assert.ok(TWINKLE_MIN_INTERVAL_MS > 1000 / 60 && TWINKLE_MIN_INTERVAL_MS < 1000 / 30, 'between a 60 Hz tick and the 30 Hz cap');
});

test('perf gates: a healthy run passes; each regression fails its own gate', () => {
    assert.deepEqual(failing(judgePerf(good('low'))), []);
    assert.deepEqual(failing(judgePerf(good('high'))), []);
    const over = (o) => failing(judgePerf(good('low', o)));
    assert.deepEqual(over({ globe: { programs: 99, drawCalls: 10, pausedFrames: 0 } }), ['perf: programs (low)']);
    assert.deepEqual(over({ globe: { programs: 40, drawCalls: 99, pausedFrames: 0 } }), ['perf: draw calls, globe (low)']);
    assert.deepEqual(over({ sky: { programs: 99, drawCalls: 99, pausedFrames: 0, shortIntervals: 0 } }),
        ['perf: programs (low)', 'perf: draw calls, sky (low)']);
    assert.deepEqual(over({ globe: { programs: 40, drawCalls: 10, pausedFrames: 2 } }), ['perf: paused globe: no frames']);
    assert.deepEqual(over({ timelapse: { frames: 6, layoutReadsInFrame: 3, stacks: ['getBoundingClientRect at x'] } }),
        ['perf: time-lapse layout reads in rAF']);
    assert.deepEqual(over({ timelapse: { frames: 6, layoutReadsInFrame: null, stacks: [] } }), ['perf: time-lapse layout reads in rAF'],
        'no shim is a failure, not a pass');
    assert.deepEqual(over({ globeSettleMs: null }), ['perf: globe settles']);
    assert.deepEqual(over({ skyEnterMs: null }), ['perf: sky view entered']);
    const err = judgePerf({ error: 'no render context (text mode?)' });
    assert.equal(err.length, 1);
    assert.equal(err[0].ok, false);
    assert.match(err[0].detail, /text mode/);
    assert.equal(judgePerf(null)[0].ok, false);
});

test('perf gates: a paused sky view may draw only on a twinkling tier, at most 32/s and never faster than the cap', () => {
    const sky = (tier, pausedFrames, shortIntervals = 0) => failing(judgePerf(good(tier, {
        sky: { programs: 40, drawCalls: 8, pausedFrames, shortIntervals, minIntervalMs: 33 },
    })));
    assert.deepEqual(sky('low', 1), ['perf: paused sky: no frames']);
    assert.deepEqual(sky('medium', 3), ['perf: paused sky: no frames']);
    const max = Math.floor(TWINKLE_MAX_FPS * PERF_WINDOW_MS / 1000);
    assert.deepEqual(sky('high', max), []);
    assert.deepEqual(sky('high', max + 1), [`perf: paused sky: twinkle ≤ ${TWINKLE_MAX_FPS}/s`]);
    assert.deepEqual(sky('high', 20, 1), [`perf: paused sky: twinkle ≤ ${TWINKLE_MAX_FPS}/s`], 'two frames one tick apart');
});

test('perf gates: a tier without a budget skips the counts but keeps the frame gates', () => {
    const checks = judgePerf(good('max', { globe: { programs: 999, drawCalls: 999, pausedFrames: 0 } }));
    assert.deepEqual(failing(checks), []);
    assert.ok(checks.some((c) => c.name === 'perf: budgets' && /none for tier max/.test(c.detail)));
    assert.deepEqual(failing(judgePerf(good('max', { globe: { programs: 1, drawCalls: 1, pausedFrames: 1 } }))), ['perf: paused globe: no frames']);
    assert.match(perfSummary(good('low')), /programs=40\/40 drawCalls=10\/8 .*boot LoAF: 3000 ms longest, 2 ≥ 1 s/);
    assert.match(perfSummary({ error: 'x' }), /perf: x/);
});

/** A minimal window for the shim: rAF callbacks run when `flush()` is called. */
function fakeWindow() {
    const queue = [];
    class Element { getBoundingClientRect() { return { left: 0 }; } getClientRects() { return []; } }
    class Range { getBoundingClientRect() { return { left: 0 }; } }
    const win = {
        Element, Range,
        requestAnimationFrame(cb) { queue.push(cb); return queue.length; },
        flush(t = 16) { for (const cb of queue.splice(0)) cb(t); },
    };
    win.window = win;
    return win;
}

test('perf shim: counts layout reads inside rAF callbacks only, nested ones included', () => {
    const win = fakeWindow();
    vm.runInNewContext(PERF_SHIM, win);
    const P = win.__perf;
    const el = new win.Element();
    el.getBoundingClientRect();
    assert.deepEqual([P.reads, P.inRaf], [1, 0], 'outside a frame');
    win.requestAnimationFrame(() => {
        el.getBoundingClientRect();
        el.getClientRects();
        win.requestAnimationFrame(() => new win.Range().getBoundingClientRect());
    });
    win.flush();
    assert.deepEqual([P.reads, P.inRaf], [3, 2]);
    win.flush();
    assert.deepEqual([P.reads, P.inRaf], [4, 3], 'a callback scheduled from a callback is wrapped too');
    assert.equal(P.stacks.length, 3);
    assert.match(P.stacks[0], /^getBoundingClientRect/);
    // A throwing callback must not leave the depth raised.
    win.requestAnimationFrame(() => { throw new Error('boom'); });
    assert.throws(() => win.flush(), /boom/);
    el.getBoundingClientRect();
    assert.equal(P.inRaf, 3);
    assert.equal(P.loaf.length, 0, 'no PerformanceObserver: no LoAF, no error');
});

test('perf probe: self-contained, pauses and restores the clock, counts frames in each window', async () => {
    let frames = 100, view = 'orbit', tMs = 1.7e12, rate = 1, playing = false;
    const calls = [];
    const clock = {
        get tMs() { return tMs; }, get live() { return false; }, get playing() { return playing; }, get rate() { return rate; },
        pause() { playing = false; calls.push('pause'); }, play() { playing = true; calls.push('play'); },
        setRate(r) { rate = r; calls.push(`rate ${r}`); }, setTime(t) { tMs = t; calls.push('setTime'); }, goLive() { calls.push('live'); },
    };
    const rig = { skyBlend: 0, tweening: false };
    const app = {
        tier: 'high', clock,
        stats: () => ({ frames, programs: 33, drawCalls: view === 'sky' ? 7 : 12 }),
        store: { get: () => ({ view: { mode: view } }) },
        actions: { setViewMode(m) { view = m; rig.skyBlend = 1; } },
        internals: { rc: {}, loop: { supersample: { cap: 8, samples: 8 } }, rig },
    };
    const perf = { inRaf: 0, reads: 0, stacks: [], loaf: [500, 1500] };
    const ctx = {
        __app: app, __perf: perf, setTimeout, performance,
        requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 5),
    };
    ctx.window = ctx;
    // A few frames drawn once the sky view is on (its supersampling, here before the count starts).
    const probe = vm.runInNewContext(`(${perfProbe})`, ctx);
    const pending = probe({ windowMs: 60, quietMs: 20, settleMs: 2000, shortMs: TWINKLE_MIN_INTERVAL_MS });
    const bump = setInterval(() => { if (view === 'sky' && frames < 102) frames++; }, 8);
    const m = await pending;
    clearInterval(bump);
    assert.equal(m.error, undefined);
    assert.equal(m.tier, 'high');
    assert.deepEqual(m.loaf, [1500, 500]);
    assert.equal(m.globe.pausedFrames, 0);
    assert.equal(m.globe.drawCalls, 12);
    assert.equal(m.sky.drawCalls, 7);
    assert.equal(m.timelapse.layoutReadsInFrame, 0);
    assert.ok(m.globeSettleMs >= 20 && m.skyEnterMs !== null);
    assert.ok(calls.includes('rate 3600'), 'the time-lapse ran');
    assert.equal(tMs, 1.7e12, 'time put back');
    assert.equal(rate, 1, 'rate put back');
    assert.equal(playing, false, 'still paused');
    const noRc = await vm.runInNewContext(`(${perfProbe})`, { window: { __app: { internals: {} } } })({ windowMs: 1, shortMs: 1 });
    assert.match(noRc.error, /text mode/);
});
