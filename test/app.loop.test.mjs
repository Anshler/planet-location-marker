// Tests for js/app/loop.js render-on-demand: star twinkle (only while stars are visible, at most
// ~30 Hz). Driven by a fake requestAnimationFrame, a stub render context and the real store,
// clock and snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop, TWINKLE_FRAME_MS } from '../js/app/loop.js';
import { createStore } from '../js/core/store.js';
import { createClock } from '../js/core/clock.js';

const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, name: 'Luxor', country: 'Egypt', tz: 'Africa/Cairo', tzApprox: false, source: 'url' };
const NIGHT = Date.parse('2027-08-01T22:00:00Z'); // Sun −46°
const DAY = Date.parse('2027-08-02T08:00:00Z'); // Sun +62°
const TOTALITY = Date.parse('2027-08-02T10:07:00Z'); // Sun +82°, fully covered

/**
 * A paused app on a display ticking every `frameMs`. Returns counters after `ms`.
 * @param {{tMs:number, frameMs?:number, ms?:number, twinkle?:boolean, mode?:'sky'|'orbit',
 *          reducedMotion?:boolean, stars?:boolean}} o
 */
function run({ tMs, frameMs = 1000 / 60, ms = 2000, twinkle = true, mode = 'sky', reducedMotion = false, stars = true }) {
    let queue = [];
    const win = {
        requestAnimationFrame(fn) { queue.push(fn); return queue.length; },
        cancelAnimationFrame() {},
        addEventListener() {},
        removeEventListener() {},
    };
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    const store = createStore({
        observer: LUXOR,
        layers: { stars },
        status: { phase: 'ready', reducedMotion, introPlaying: false },
    });
    const clock = createClock({ tMs, playing: false });
    const counts = { renders: 0, samples: [] };
    const governor = { sample(dt) { counts.samples.push(dt); return null; } };
    const rc = { renderer: null, camera: {}, size: { w: 100, h: 100 }, render() { counts.renders++; } };
    const rig = { mode, skyBlend: mode === 'sky' ? 1 : 0, tweening: false, camera: {}, update() { return false; } };
    const loop = createLoop({
        clock, store, bus: { emit() {} }, win, doc,
        rc, rig, modules: [], governor, getTierCfg: () => ({ twinkle, labelCap: 40 }),
    });
    loop.start();
    // Let the boot frames (first snapshot, view mode) settle, then count.
    let now = 1000;
    const step = () => {
        const fns = queue;
        queue = [];
        for (const fn of fns) fn(now);
        now += frameMs;
    };
    for (let i = 0; i < 5; i++) step();
    counts.renders = 0;
    counts.samples.length = 0;
    const ticks = Math.round(ms / frameMs);
    for (let i = 0; i < ticks; i++) step();
    loop.dispose();
    return { ...counts, ticks, perSecond: counts.renders / (ms / 1000) };
}

test('twinkle at night in sky view renders at ~30 Hz, whatever the display rate', () => {
    for (const hz of [60, 120, 144, 165]) {
        const r = run({ tMs: NIGHT, frameMs: 1000 / hz });
        assert.ok(r.perSecond >= 27 && r.perSecond <= 34, `${hz} Hz display: ${r.perSecond} frames/s`);
        assert.deepEqual(r.samples, [], `${hz} Hz: throttled frames are never consecutive, so never governor samples`);
    }
    assert.ok(TWINKLE_FRAME_MS > 1000 / 60 && TWINKLE_FRAME_MS <= 1000 / 30);
});

test('a 30 Hz display draws twinkle on every tick and feeds the governor its consecutive frames', () => {
    const r = run({ tMs: NIGHT, frameMs: 1000 / 30 });
    assert.equal(r.renders, r.ticks);
    assert.equal(r.samples.length, r.ticks);
});

test('no twinkle frames when no star is visible or twinkle is off', () => {
    assert.equal(run({ tMs: DAY }).renders, 0, 'daytime sky view, Sun 62° up: idle like the orbit view');
    assert.equal(run({ tMs: NIGHT, twinkle: false }).renders, 0, 'tier without twinkle');
    assert.equal(run({ tMs: NIGHT, mode: 'orbit' }).renders, 0, 'orbit view');
    assert.equal(run({ tMs: NIGHT, reducedMotion: true }).renders, 0, 'reduced motion');
    assert.equal(run({ tMs: NIGHT, stars: false }).renders, 0, 'star layer off');
});

test('totality brings the stars, and their twinkle, out in a daytime sky', () => {
    const r = run({ tMs: TOTALITY });
    assert.ok(r.perSecond >= 27 && r.perSecond <= 34, `${r.perSecond} frames/s`);
});
