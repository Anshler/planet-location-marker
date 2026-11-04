// Tests for js/core/sampling.js: the Halton jitter, the idle-supersampling policy (weights, drift,
// motion, twinkle, the cap), the view-motion measure and the fast-time streak shutter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    halton, createSupersampler, viewMotionPx, streakShutter, strobeDim,
    SS_STILL_PX, SS_DRIFT_PX, SS_TWINKLE_WEIGHT, STREAK_MIN_RATE, STREAK_MAX_DT_MS,
} from '../js/core/sampling.js';

test('halton: radical inverse in bases 2 and 3', () => {
    assert.deepEqual([1, 2, 3, 4].map((i) => halton(i, 2)), [0.5, 0.25, 0.75, 0.125]);
    assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-12 && Math.abs(halton(5, 3) - 7 / 9) < 1e-12);
    assert.equal(halton(0, 2), 0);
});

test('supersampler: a fresh sample, then a running mean of jittered frames up to the cap', () => {
    const ss = createSupersampler({ samples: 8 });
    const out = { x: 0, y: 0, weight: 0 };
    assert.equal(ss.wants, false, 'nothing to refine before a first sample');
    const first = ss.next('fresh', Infinity, out);
    assert.deepEqual({ ...first }, { x: 0, y: 0, weight: 1 }, 'the first sample is unjittered and replaces the history');
    const weights = [];
    const seen = new Set();
    while (ss.wants) {
        const s = ss.next('idle', 0, out);
        weights.push(s.weight);
        assert.ok(Math.abs(s.x) <= 0.5 && Math.abs(s.y) <= 0.5, 'jitter stays within half a pixel');
        seen.add(`${s.x},${s.y}`);
    }
    assert.deepEqual(weights.map((w) => Math.round(1 / w)), [2, 3, 4, 5, 6, 7, 8], 'w = 1/(n+1): an exact mean');
    assert.equal(seen.size, 7, 'every sample has its own offset');
    assert.equal(ss.count, 8);
    assert.equal(ss.wants, false, 'parked at the cap: render on demand idles');
});

test('supersampler: a sub-pixel drift (Live 1×) keeps the history as an EMA sample', () => {
    const ss = createSupersampler({ samples: 16 });
    const out = { x: 0, y: 0, weight: 0 };
    ss.next('fresh', 0, out);
    while (ss.wants) ss.next('idle', 0, out);
    const s = ss.next('drift', SS_STILL_PX / 2, out);
    assert.equal(s.weight, 1 / 16, 'no reset: the frame joins the mean');
    assert.equal(ss.wants, false, 'and no extra frames follow');
});

test('supersampler: a pixel of drift keeps a short history and refines again; more is a new one', () => {
    const ss = createSupersampler({ samples: 8 });
    const out = { x: 0, y: 0, weight: 0 };
    ss.next('fresh', 0, out);
    while (ss.wants) ss.next('idle', 0, out);
    const s = ss.next('drift', (SS_STILL_PX + SS_DRIFT_PX) / 2, out);
    assert.ok(s.weight >= 0.5);
    assert.equal(ss.count, 2);
    assert.equal(ss.wants, true, 'refines again');
    const f = ss.next('drift', SS_DRIFT_PX * 2, out);
    assert.deepEqual({ x: f.x, y: f.y, weight: f.weight }, { x: 0, y: 0, weight: 1 }, 'large drift starts afresh');
});

test('supersampler: motion bypasses and resets; twinkle keeps a short history; off below two samples', () => {
    const ss = createSupersampler({ samples: 8 });
    const out = { x: 0, y: 0, weight: 0 };
    ss.next('fresh', 0, out);
    ss.next('idle', 0, out);
    assert.equal(ss.next('motion', 0, out), null);
    assert.equal(ss.count, 0);
    assert.equal(ss.next('twinkle', 0, out).weight, 1, 'after motion: a fresh sample');
    for (let i = 0; i < 10; i++) ss.next('idle', 0, out);
    assert.equal(ss.next('twinkle', 0, out).weight, SS_TWINKLE_WEIGHT, 'twinkle stays visible');
    ss.samples = 1;
    assert.equal(ss.next('fresh', 0, out), null, 'a cap of 1 is off (the low tier)');
    assert.equal(ss.wants, false);
});

test('viewMotionPx: rotation, parallax off the sky view, projection cuts', () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3.4, 1];
    const P = [1.5, 0, 0, 0, 0, 2.4, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0];
    const o = { prevP: P, curP: P, heightPx: 1000 };
    assert.equal(viewMotionPx(I, I, o), 0);
    const a = 1e-4; // a small turn about y
    const R = [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 3.4, 1];
    const px = viewMotionPx(I, R, { ...o, sky: true });
    assert.ok(Math.abs(px - a * 2.4 * 500) < 1e-3, `rotation → ${px} px`);
    const T = I.slice();
    T[12] = 0.0024;  // 1e-3 rad at 2.4 R above the surface
    assert.ok(Math.abs(viewMotionPx(I, T, o) - 0.001 * 1200) < 1e-6, 'parallax of the globe');
    assert.equal(viewMotionPx(I, T, { ...o, sky: true }), 0, 'no near parallax in sky view');
    const P2 = P.slice();
    P2[8] = 0.01;
    assert.equal(viewMotionPx(I, I, { ...o, curP: P2 }), Infinity, 'a projection change is a cut');
});

test('streakShutter: fast time only, never under reduced motion, after a gap or on low', () => {
    const base = { simRate: 86400, dtMs: 16, capPx: 24 };
    assert.equal(streakShutter(base), 0.5);
    assert.equal(streakShutter({ ...base, exposing: true }), 1, 'a long exposure joins the trails up');
    assert.equal(streakShutter({ ...base, simRate: -86400 }), 0.5, 'reverse time streaks too');
    assert.equal(streakShutter({ ...base, simRate: STREAK_MIN_RATE - 1 }), 0, 'a drag at Live stays crisp');
    assert.equal(streakShutter({ ...base, reducedMotion: true }), 0);
    assert.equal(streakShutter({ ...base, capPx: 0 }), 0, 'low tier');
    assert.equal(streakShutter({ ...base, dtMs: STREAK_MAX_DT_MS + 1 }), 0, 'stale previous pose');
    assert.equal(streakShutter({ ...base, dtMs: 0 }), 0, 'captures (dt 0) are never streaked');
});

test('strobeDim: steady up to 8 px a frame, then fades to a floor', () => {
    assert.equal(strobeDim(0), 1);
    assert.equal(strobeDim(8), 1);
    assert.ok(Math.abs(strobeDim(32) - 0.5) < 1e-12);
    assert.equal(strobeDim(1e6), 0.25);
    assert.equal(strobeDim(NaN), 1);
});
