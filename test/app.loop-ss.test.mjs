// Tests for js/app/loop.js idle supersampling (ROADMAP idle-supersampling) and step(): the extra
// jittered frames after a settle stop at the tier's cap (render on demand idles again), Live 1×
// blends its 0.5 s snapshot steps into the history instead of resetting it, motion bypasses it, a
// tier without it draws nothing extra, and step() runs one whole frame on a given time base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop } from '../js/app/loop.js';
import { createStore } from '../js/core/store.js';
import { createClock } from '../js/core/clock.js';

const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, name: 'Luxor', country: 'Egypt', tz: 'Africa/Cairo', tzApprox: false, source: 'url' };
const NIGHT = Date.parse('2027-08-01T22:00:00Z');

function harness({ supersample = 8, rate = 1, playing = false, moving = () => false, rcSS = true, lockFollow = false } = {}) {
    let queue = [];
    const win = {
        requestAnimationFrame(fn) { queue.push(fn); return queue.length; },
        cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
    };
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    const store = createStore({ observer: LUXOR, layers: { stars: true }, status: { phase: 'ready', reducedMotion: false, introPlaying: false } });
    const clock = createClock({ tMs: NIGHT, playing, rate });
    const renders = [];
    const W = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3.4, 1];
    const P = [1.5, 0, 0, 0, 0, 2.4, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0];
    const camera = { fov: 45, matrixWorld: { elements: W }, projectionMatrix: { elements: P } };
    const rc = {
        renderer: null, camera, size: { w: 800, h: 600 }, dpr: 1, supersampling: rcSS,
        render(ss) { renders.push(ss ? { ...ss } : null); },
    };
    const rig = { mode: 'orbit', skyBlend: 0, tweening: false, camera, update: () => moving(), lockOnly: false };
    if (lockFollow) {
        // Earth-lock: each new frame snapshot turns the camera with the Earth (a sub-pixel move).
        let lastT = NaN;
        rig.update = (dt, snap) => {
            rig.lockOnly = snap.tMs !== lastT && Number.isFinite(lastT);
            lastT = snap.tMs;
            return rig.lockOnly;
        };
    }
    const updates = { n: 0 };
    const probe = { object3d: {}, update() { updates.n++; } };
    const loop = createLoop({
        clock, store, bus: { emit() {} }, win, doc, rc, rig, modules: [probe],
        getTierCfg: () => ({ twinkle: false, labelCap: 40, supersample }),
    });
    loop.start();
    let now = 1000;
    const tick = (n = 1) => {
        for (let i = 0; i < n; i++) {
            const fns = queue;
            queue = [];
            for (const fn of fns) fn(now);
            now += 1000 / 60;
        }
    };
    return { loop, clock, store, renders, updates, tick, dispose: () => loop.dispose() };
}

test('a settled view draws the cap of jittered samples, then idles', () => {
    const h = harness({ supersample: 8 });
    h.tick(120);
    const acc = h.renders.filter(Boolean);
    assert.equal(acc.length, 8, `${acc.length} accumulated frames`);
    assert.equal(acc[0].weight, 1, 'a fresh history first');
    assert.deepEqual(acc.slice(1).map((s) => Math.round(1 / s.weight)), [2, 3, 4, 5, 6, 7, 8]);
    const before = h.renders.length;
    h.tick(60);
    assert.equal(h.renders.length, before, 'parked: no frames while nothing changes');
    assert.equal(h.loop.supersample.samples, 8);
    h.dispose();
});

test('extra frames skip the module updates; a change starts a new history', () => {
    const h = harness({ supersample: 8 });
    h.tick(60);
    const u = h.updates.n;
    assert.ok(u <= 3, `module updates only on real frames (${u})`);
    h.renders.length = 0;
    h.store.set({ layers: { stars: false } }, 'test');
    h.tick(60);
    assert.equal(h.renders.length, 8);
    assert.equal(h.renders[0].weight, 1, 'the change replaced the history');
    h.dispose();
});

test('Live 1×: the 0.5 s snapshot steps join the history instead of resetting it', () => {
    const h = harness({ supersample: 8, playing: true, rate: 1 });
    h.tick(60);
    h.renders.length = 0;
    h.tick(180);   // 3 s: about six snapshot steps
    assert.ok(h.renders.length >= 5 && h.renders.length <= 8, `${h.renders.length} frames in 3 s`);
    for (const s of h.renders) assert.ok(s && s.weight === 1 / 8, 'an EMA sample each, no fresh history');
    h.dispose();
});

test('Live 1× with earth-lock: following the Earth turning is drift, not motion', () => {
    const h = harness({ supersample: 8, playing: true, rate: 1, lockFollow: true });
    h.tick(60);
    h.renders.length = 0;
    h.tick(180);
    assert.ok(h.renders.length >= 5 && h.renders.length <= 8, `${h.renders.length} frames in 3 s (not a re-refine each step)`);
    for (const s of h.renders) assert.ok(s && s.weight === 1 / 8, 'the history stays: an EMA sample each');
    h.dispose();
});

test('motion draws plain frames; a tier or chain without the pass draws nothing extra', () => {
    let move = true;
    const h = harness({ supersample: 8, moving: () => move });
    h.tick(30);
    assert.ok(h.renders.length >= 29 && h.renders.every((s) => s === null), 'no accumulation while moving');
    move = false;
    h.tick(30);
    assert.equal(h.renders.filter(Boolean).length, 8);
    h.dispose();
    for (const o of [{ supersample: 0 }, { rcSS: false }]) {
        const g = harness(o);
        g.tick(120);
        assert.ok(g.renders.length <= 2 && g.renders.every((s) => s === null), JSON.stringify(o));
        g.dispose();
    }
});

test('step(): one whole frame on the caller\'s time base, bracketed by before/after', () => {
    const h = harness({ supersample: 8 });
    h.tick(30);
    h.loop.stop();
    h.clock.setRange({ fromMs: NIGHT, toMs: NIGHT + 36e5, durationS: 1, loop: 'once' });
    h.clock.tick(5000);
    const order = [];
    h.renders.length = 0;
    const ok = h.loop.step(5000 + 200, 200, { before: () => order.push('before'), after: () => order.push('after') });
    assert.equal(ok, true);
    assert.deepEqual(order, ['before', 'after']);
    assert.deepEqual(h.renders, [null], 'a plain frame, never a supersampling sample');
    assert.equal(h.clock.tMs, NIGHT + 72e4, 'the clock advanced by exactly the step');
    assert.equal(h.loop.snap.tMs, NIGHT + 72e4, 'and the frame snapshot followed');
    h.dispose();
});
