// Tests for js/app/loop.js render-on-demand: star twinkle (only while stars are visible, at most
// ~30 Hz) and the display-cadence feed to the governor. Driven by a fake requestAnimationFrame,
// a stub render context and the real store, clock and snapshot.
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
 * An app on a display ticking every `frameMs` (paused unless `rate` ≠ 1). Returns counters after
 * `ms`. `headless`: no render stack yet (boot); `probeTicks`: the governor's probe() answers true
 * that many times.
 * @param {{tMs:number, frameMs?:number, ms?:number, twinkle?:boolean, mode?:'sky'|'orbit',
 *          reducedMotion?:boolean, stars?:boolean, headless?:boolean, rate?:number, probeTicks?:number}} o
 */
function run({
    tMs, frameMs = 1000 / 60, ms = 2000, twinkle = true, mode = 'sky', reducedMotion = false, stars = true, headless = false,
    rate = 1, probeTicks = 0,
}) {
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
    const clock = createClock({ tMs, playing: rate !== 1, rate });
    const counts = { renders: 0, idle: [], samples: [] };
    let probeLeft = 0;
    const governor = {
        idle(dt) { counts.idle.push(dt); },
        sample(dt) { counts.samples.push(dt); return null; },
        probe() { return probeLeft-- > 0; },
    };
    const rc = { renderer: null, camera: {}, size: { w: 100, h: 100 }, render() { counts.renders++; } };
    const rig = { mode, skyBlend: mode === 'sky' ? 1 : 0, tweening: false, camera: {}, update() { return false; } };
    const render = headless ? {} : { rc, rig, modules: [], getTierCfg: () => ({ twinkle, labelCap: 40 }) };
    const loop = createLoop({ clock, store, bus: { emit() {} }, win, doc, governor, ...render });
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
    counts.idle.length = 0;
    counts.samples.length = 0;
    probeLeft = probeTicks;
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
        // The tick right after a render may carry its cost; only later idle ticks are cadence.
        if (hz === 60) assert.deepEqual(r.idle, [], '60 Hz: every idle tick follows a render');
        for (const dt of r.idle) assert.ok(Math.abs(dt - 1000 / hz) < 1e-6, `${hz} Hz: ${dt}`);
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

test('idle ticks feed the governor the display cadence', () => {
    for (const hz of [30, 48, 60, 144]) {
        const r = run({ tMs: DAY, frameMs: 1000 / hz });
        assert.equal(r.renders, 0);
        assert.equal(r.idle.length, r.ticks, `${hz} Hz: every tick is idle`);
        for (const dt of r.idle) assert.ok(Math.abs(dt - 1000 / hz) < 1e-6, `${hz} Hz: ${dt}`);
        assert.deepEqual(r.samples, []);
    }
    const boot = run({ tMs: NIGHT, frameMs: 1000 / 30, headless: true });
    assert.equal(boot.idle.length, boot.ticks, 'the headless boot ticks count too (before the intro renders)');
});

test('the governor\'s cadence probe holds frames back even while animating', () => {
    const lapse = run({ tMs: DAY, mode: 'orbit', rate: 3600 });
    assert.equal(lapse.renders, lapse.ticks, 'a time-lapse draws every tick');
    assert.equal(lapse.idle.length, 0);
    const probed = run({ tMs: DAY, mode: 'orbit', rate: 3600, probeTicks: 8 });
    assert.equal(probed.renders, probed.ticks - 8, 'eight ticks held back');
    assert.equal(probed.idle.length, 7, 'the first held tick follows a render; the other seven are cadence');
    assert.equal(probed.samples.length, lapse.samples.length - 9, 'and the first frame after them is not consecutive');
});
