// Tests for js/app/intro.js — the beam launch reaches the bus once, on the timeline, never on a skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { playIntro, INTRO_TIMING } from '../js/app/intro.js';

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A fake rig, beams, bus and frame clock driven by hand. */
function harness() {
    let t = 0;
    let pending = null;
    const pos = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
    const emitted = [];
    const launches = [];
    const snap = {
        earthMatrix: IDENTITY,
        sunDirS: new Float64Array([1, 0, 0]),
        observer: { upS: new Float64Array([0, 1, 0]), northS: new Float64Array([0, 0, -1]), latDeg: 10, lonDeg: 106 },
    };
    return {
        emitted, launches,
        opts: {
            rig: { camera: { position: pos }, mode: 'orbit' },
            beams: { launch: (o) => { launches.push(o.staggerMs); return Promise.resolve(); }, skipLaunch: () => launches.push('skip') },
            snap,
            bus: { emit: (type, payload) => emitted.push([type, payload]) },
            now: () => t,
            raf: (cb) => { pending = cb; return 1; },
            caf: () => { pending = null; },
        },
        /** Advances the clock to `ms` in 50-ms frames. */
        async run(ms) {
            while (t < ms && pending) {
                t += 50;
                const cb = pending;
                pending = null;
                cb(t);
                await Promise.resolve();
            }
        },
    };
}

test('playIntro emits intro/launch once, when the beams launch on the timeline', async () => {
    const hz = harness();
    const done = playIntro({ ...hz.opts, preRollMs: 700 });
    await hz.run(700 + INTRO_TIMING.beamsMs - 100);
    assert.deepEqual(hz.emitted, [], 'nothing before the launch (after the pre-roll)');
    await hz.run(700 + INTRO_TIMING.beamsMs + 100);
    assert.deepEqual(hz.emitted, [['intro', 'launch']]);
    assert.deepEqual(hz.launches, [INTRO_TIMING.staggerMs]);
    await hz.run(700 + INTRO_TIMING.maxMs + 500);
    assert.equal(await done, 'done');
    assert.deepEqual(hz.emitted, [['intro', 'launch']], 'once');
});

test('a skip before the launch jumps to the end without a title card', async () => {
    const hz = harness();
    const ac = new AbortController();
    const done = playIntro({ ...hz.opts, signal: ac.signal });
    await hz.run(1000);
    ac.abort();
    assert.equal(await done, 'skipped');
    assert.deepEqual(hz.emitted, []);
    assert.deepEqual(hz.launches, ['skip']);
});

test('reduced motion: no intro, no event', async () => {
    const hz = harness();
    assert.equal(await playIntro({ ...hz.opts, reducedMotion: true }), 'unavailable');
    assert.deepEqual(hz.emitted, []);
});
