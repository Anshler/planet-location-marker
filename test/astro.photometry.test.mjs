// Photometry (SPEC §C.2, §H): colours, refraction, airmass, twilight and exposure curves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import * as P from '../js/astro/photometry.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

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

test('starLimitMag mirrors STAR_VERT (lim = mix(−1, uMagLimit, √e)); starExposureForLimit inverts it', () => {
    close(P.starLimitMag(1, 6.5), 6.5, 1e-12);
    close(P.starLimitMag(0, 6.5), -1, 1e-12);
    // The old totality exposure 0.8 put the limit at 5.7 on high (the Beehive cluster in daylight).
    close(P.starLimitMag(0.8, 6.5), 5.708, 1e-3);
    for (const lim of [5, 6, 6.5]) {
        for (const m of [-0.5, 0, 1.3, 2, 4.4]) close(P.starLimitMag(P.starExposureForLimit(m, lim), lim), m, 1e-12);
        assert.equal(P.starExposureForLimit(-1, lim), 0);
        assert.equal(P.starExposureForLimit(-3, lim), 0);
        assert.equal(P.starExposureForLimit(lim + 1, lim), 1);
    }
    assert.equal(P.starLimitMag(NaN, 6), -1);
});

test('eclipseStarLimitMag: −∞ without an eclipse, about magnitude 2 in totality, brightening only in the last decades of sunlight', () => {
    for (const o of [0, -1, NaN, undefined]) assert.equal(P.eclipseStarLimitMag(o), -Infinity);
    assert.equal(P.eclipseStarLimitMag(1), P.TOTALITY_STAR_LIMIT_MAG);
    assert.ok(P.TOTALITY_STAR_LIMIT_MAG >= 1.5 && P.TOTALITY_STAR_LIMIT_MAG <= 2.5);
    // Remaining light (1 − o)^1.4 → limit: 1e-3 → no stars, 1e-4 → Sirius class, 1e-5 → first magnitude.
    const at = (light) => P.eclipseStarLimitMag(1 - Math.pow(light, 1 / 1.4));
    assert.ok(at(1e-3) < 0, `1e-3: ${at(1e-3)}`);
    assert.ok(at(1e-4) > 0 && at(1e-4) < 1, `1e-4: ${at(1e-4)}`);
    assert.ok(at(1e-5) > 1.4 && at(1e-5) < 2, `1e-5: ${at(1e-5)}`);
    let prev = -Infinity;
    for (let o = 0.9; o <= 1; o += 0.0005) {
        const m = P.eclipseStarLimitMag(o);
        assert.ok(m >= prev - 1e-12, `monotonic at ${o}`);
        prev = m;
    }
});

test('exposureFor: totality shows planets and stars to about magnitude 2 on every tier, never the old 4.4–5.7', () => {
    for (const lim of [5, 6, 6.5]) {
        const e = P.exposureFor(40, 1, undefined, 1, lim);
        const m = P.starLimitMag(e.stars, lim);
        close(m, P.TOTALITY_STAR_LIMIT_MAG, 1e-9, `tier limit ${lim}`);
        assert.ok(m <= 2.5);
        close(e.planets, 0.15, 1e-12, 'planets keep their daylight exposure');
        assert.equal(e.milkyWay, 0, 'no Milky Way by day, totality or not');
    }
    // At night the eclipse term never lowers the dark-sky exposure; orbit view stays 1.
    assert.deepEqual(P.exposureFor(-30, 1, undefined, 1, 6), { stars: 1, planets: 1, milkyWay: 1 });
    assert.deepEqual(P.exposureFor(40, 0, undefined, 1, 6), { stars: 1, planets: 1, milkyWay: 1 });
    // A partial eclipse at 90 % adds nothing; the defaults keep the old three-argument behaviour.
    assert.equal(P.exposureFor(40, 1, undefined, 0.9, 6).stars, 0);
    assert.deepEqual(P.exposureFor(40, 1), P.exposureFor(40, 1, undefined, 0, 6));
    const half = P.exposureFor(40, 0.5, undefined, 1, 6);
    close(half.stars, 0.5 + 0.5 * P.starExposureForLimit(P.TOTALITY_STAR_LIMIT_MAG, 6), 1e-12, 'blends with the view');
});

test('Luxor 2027-08-02: star limit ≤ 2.5 at 10:05Z; the stars come out only in the last ~30 s before second contact', () => {
    const o = { latDeg: 25.7, lonDeg: 32.6, elevM: 0 };
    const snap = createSnapshot();
    const limitAt = (tMs, tier) => {
        computeSnapshot(tMs, o, snap);
        const e = P.exposureFor(snap.observer.sunAltDeg, 1, undefined, snap.eclipse.obscurationAtObserver, tier);
        return { e: e.stars, lim: P.starLimitMag(e.stars, tier) };
    };
    for (const tier of [5, 6, 6.5]) {
        const { lim } = limitAt(Date.parse('2027-08-02T10:05:00Z'), tier);
        assert.ok(lim <= 2.5 && lim >= 1.5, `tier ${tier}: limit ${lim} in totality`);
    }
    const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-07-01')), new AE.Observer(o.latDeg, o.lonDeg, 0));
    const c2 = ls.total_begin.time.date.getTime();
    // The old ramp started at 97 % obscuration, 2.8 min before C2.
    assert.equal(limitAt(c2 - 170e3, 6.5).e, 0, 'C2 − 170 s: no stars');
    assert.ok(limitAt(c2 - 60e3, 6.5).e < 0.01, 'C2 − 60 s: below the shader\'s visibility ramp');
    assert.ok(limitAt(c2 - 15e3, 6.5).lim < 1.2, 'C2 − 15 s: only the brightest few');
    close(limitAt(c2 + 1e3, 6.5).lim, P.TOTALITY_STAR_LIMIT_MAG, 1e-9, 'second contact');
});

test('smoothstep matches GLSL', () => {
    assert.equal(P.smoothstep(0, 1, -1), 0);
    assert.equal(P.smoothstep(0, 1, 2), 1);
    assert.equal(P.smoothstep(0, 1, 0.5), 0.5);
    assert.equal(P.smoothstep(1, 0, 0.25), P.smoothstep(0, 1, 0.75));
});

test('starLimitMag / starVisibility mirror STAR_VERT: lim = mix(−1, magLimit, √e); vis = smoothFall(lim+0.35, lim−0.45, mag)·smoothstep(0, 0.04, e)', () => {
    assert.equal(P.starLimitMag(1, 6), 6);
    assert.equal(P.starLimitMag(0, 6), -1);
    close(P.starLimitMag(0.25, 6), 2.5, 1e-12);
    assert.equal(P.starVisibility(5.55, 1, 6), 1, 'mag ≤ lim − 0.45 is fully drawn');
    assert.equal(P.starVisibility(6.35, 1, 6), 0, 'mag ≥ lim + 0.35 is gone');
    close(P.starVisibility(5.95, 1, 6), 0.5, 1e-12, 'midway');
    assert.equal(P.starVisibility(-1.46, 0, 6), 0, 'no star at all at zero exposure, even Sirius');
    assert.ok(P.starVisibility(-1.46, 0.1, 6) > 0.99, 'Sirius early in twilight');
    assert.equal(P.starVisibility(2.43, 0.1, 6), 0, 'mag 2.4 still invisible at e = 0.1 (lim ≈ 1.2)');
    let prev = -1;
    for (let e = 0; e <= 1.0001; e += 0.05) {
        const v = P.starVisibility(1.5, e, 6);
        assert.ok(v >= prev - 1e-12, `non-decreasing in e at ${e}`);
        prev = v;
    }
});

test('skyBrightness: 0 from orbit and at night, 1 by day in sky view, dark again in totality', () => {
    assert.equal(P.skyBrightness(40, 0, 0), 0);
    assert.equal(P.skyBrightness(40, 0, 1), 1);
    assert.equal(P.skyBrightness(-10, 0, 1), 0);
    close(P.skyBrightness(2, 0, 1), 0.5, 1e-12);
    assert.equal(P.skyBrightness(60, 1, 1), 0);
    assert.ok(P.skyBrightness(60, 0.8, 1) > 0.99, 'a partial eclipse keeps a bright sky');
    assert.equal(P.skyBrightness(NaN, NaN, NaN), 0);
});
