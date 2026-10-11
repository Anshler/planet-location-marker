// Photometry (SPEC §C.2, §H): colours, refraction, airmass, twilight and exposure curves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import * as P from '../js/astro/photometry.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('bvToRgb: Sun-like 0.65 is near white-yellow; −0.3 is blue-dominant; max component is 1', () => {
    const sun = P.bvToRgb(0.65);
    assert.equal(sun[0], 1);
    assert.ok(sun[1] > 0.8 && sun[2] > 0.7, `sun-like ${sun}`);
    assert.ok(sun[0] >= sun[1] && sun[1] >= sun[2], 'warm white');
    const blue = P.bvToRgb(-0.3);
    assert.equal(blue[2], 1);
    assert.ok(blue[2] > blue[1] && blue[1] > blue[0], `blue ${blue}`);
    let prevRatio = 0;
    for (let bv = -0.4; bv <= 2.0001; bv += 0.05) {
        const c = P.bvToRgb(bv);
        close(Math.max(...c), 1, 1e-12, `max at bv ${bv}`);
        assert.ok(c.every((x) => x >= 0 && x <= 1));
        const ratio = c[0] / c[2];
        assert.ok(ratio >= prevRatio - 1e-12, 'redder with increasing B−V');
        prevRatio = ratio;
    }
    // Missing catalogue values fall back to a Sun-like colour; out-of-range values clamp.
    assert.deepEqual(P.bvToRgb(NaN), P.bvToRgb(0.6));
    assert.deepEqual(P.bvToRgb(9), P.bvToRgb(2));
    const out = new Float32Array(3);
    assert.equal(P.bvToRgb(1.2, out), out);
});

test('bvToKelvin follows Ballesteros: 0.65 → ~5780 K, 0 → ~10100 K, 1.5 → ~3800 K', () => {
    close(P.bvToKelvin(0.65), 5778, 50);
    close(P.bvToKelvin(0), 10125, 50);
    close(P.bvToKelvin(1.5), 3794, 50);
    assert.ok(P.bvToKelvin(-0.3) > P.bvToKelvin(0.3));
});

test('kelvinToRgb is near-white around 6500 K and reddens below', () => {
    const d65 = P.kelvinToRgb(6504);
    assert.ok(d65.every((x) => x > 0.93), `6504 K ${d65}`);
    const cool = P.kelvinToRgb(3000);
    assert.ok(cool[0] === 1 && cool[2] < 0.25);
});

test('refractionDeg(0) ≈ 0.48° and the formula is identical to astronomy-engine Refraction("normal")', () => {
    close(P.refractionDeg(0), 0.48, 0.05);
    for (let h = -90; h <= 90; h += 0.25) assert.equal(P.refractionDeg(h), AE.Refraction('normal', h), `h = ${h}`);
    assert.equal(P.refractionDeg(NaN), 0);
    assert.equal(P.refractionDeg(91), 0);
    assert.ok(P.refractionDeg(45) < 0.02);
});

test('airmass (Kasten–Young): 1 at the zenith, ~2 at 30°, ~38 at the horizon, monotonic, never infinite', () => {
    close(P.airmass(90), 1, 1e-3);
    close(P.airmass(30), 1.994, 0.01);
    close(P.airmass(0), 37.92, 0.05);
    assert.equal(P.airmass(-10), P.airmass(0));
    for (let h = 1; h <= 90; h++) assert.ok(P.airmass(h) < P.airmass(h - 1));
    close(P.extinctionMag(90), 0.2, 1e-3);
});

test('magToFlux', () => {
    assert.equal(P.magToFlux(0), 1);
    close(P.magToFlux(5), 0.01, 1e-15);
    close(P.magToFlux(-2.5), 10, 1e-12);
});

test('twilightClass boundaries', () => {
    const cases = [[10, 'day'], [-0.833, 'day'], [-0.84, 'civil'], [-6, 'civil'], [-6.01, 'nautical'], [-12, 'nautical'],
        [-12.01, 'astronomical'], [-18, 'astronomical'], [-18.01, 'night'], [-90, 'night'], [NaN, 'night']];
    for (const [alt, cls] of cases) assert.equal(P.twilightClass(alt), cls, `alt ${alt}`);
});

test('exposureFor limits: orbit view is 1; deep night is full; daylight hides stars and the Milky Way; blends linearly', () => {
    assert.deepEqual(P.exposureFor(30, 0), { stars: 1, planets: 1, milkyWay: 1 });
    assert.deepEqual(P.exposureFor(-30, 1), { stars: 1, planets: 1, milkyWay: 1 });
    const day = P.exposureFor(30, 1);
    assert.equal(day.stars, 0);
    assert.equal(day.milkyWay, 0);
    close(day.planets, 0.15, 1e-12);
    const half = P.exposureFor(30, 0.5);
    close(half.stars, 0.5, 1e-12);
    close(half.planets, 0.575, 1e-12);
    // Monotonic fade with the Sun rising, in sky view.
    let prev = P.exposureFor(-30, 1);
    for (let a = -29; a <= 10; a++) {
        const e = P.exposureFor(a, 1);
        assert.ok(e.stars <= prev.stars && e.planets <= prev.planets && e.milkyWay <= prev.milkyWay);
        prev = e;
    }
    // Spec formulas at a twilight altitude.
    const t = P.exposureFor(-10, 1);
    close(t.stars, 1 - P.smoothstep(-18, -4, -10), 1e-12);
    close(t.milkyWay, 1 - P.smoothstep(-20, -10, -10), 1e-12);
    close(t.planets, Math.max(0.15, 1 - 0.85 * P.smoothstep(-8, 4, -10)), 1e-12);
    // Reuses an output object (per-frame callers) and tolerates bad input.
    const out = { stars: 0, planets: 0, milkyWay: 0 };
    assert.equal(P.exposureFor(-5, 1, out), out);
    assert.deepEqual(P.exposureFor(NaN, NaN), { stars: 1, planets: 1, milkyWay: 1 });
});

test('smoothstep matches GLSL', () => {
    assert.equal(P.smoothstep(0, 1, -1), 0);
    assert.equal(P.smoothstep(0, 1, 2), 1);
    assert.equal(P.smoothstep(0, 1, 0.5), 0.5);
    assert.equal(P.smoothstep(1, 0, 0.25), P.smoothstep(0, 1, 0.75));
});
