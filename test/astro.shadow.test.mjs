// Eclipse geometry (SPEC §E.2, §H): disc overlap against brute-force integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { discVisibleFraction, solarObscurationAt, lunarEclipseLight, EARTH_SHADOW_RADIUS_ER, UMBRA_EDGE_LIGHT } from '../js/astro/shadow.js';
import { MOON_RADIUS_ER, SUN_ANG_RADIUS_RAD, EARTH_RADIUS_KM } from '../js/astro/bodies.js';

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Fraction of the luminous disc (radius rs at the origin) not covered by the
// occulter (radius ro at (sep, 0)), sampled on an N×N grid over the disc's box.
function integrate(rs, ro, sep, N = 400) {
    let inside = 0, visible = 0;
    for (let i = 0; i < N; i++) {
        const x = -rs + (2 * rs * (i + 0.5)) / N;
        for (let j = 0; j < N; j++) {
            const y = -rs + (2 * rs * (j + 0.5)) / N;
            if (x * x + y * y > rs * rs) continue;
            inside++;
            const dx = x - sep;
            if (dx * dx + y * y > ro * ro) visible++;
        }
    }
    return visible / inside;
}

test('discVisibleFraction matches numerical integration on a 400×400 grid for 20 random configurations (±0.01)', () => {
    const r = rng(301);
    let worst = 0;
    for (let k = 0; k < 20; k++) {
        const rs = 0.2 + r();
        const ro = rs * (0.3 + 1.4 * r());
        const sep = (rs + ro) * 1.1 * r();
        const err = Math.abs(discVisibleFraction(rs, ro, sep) - integrate(rs, ro, sep));
        worst = Math.max(worst, err);
        assert.ok(err <= 0.01, `rs ${rs} ro ${ro} sep ${sep}: error ${err}`);
    }
    assert.ok(worst < 0.01);
});

test('discVisibleFraction exact cases: disjoint = 1, fully covered = 0, annular = 1 − ro²/rs², symmetric in sign of sep', () => {
    assert.equal(discVisibleFraction(1, 0.5, 1.5), 1);
    assert.equal(discVisibleFraction(1, 0.5, 3), 1);
    assert.equal(discVisibleFraction(1, 1, 0), 0);
    assert.equal(discVisibleFraction(1, 1.2, 0.1), 0);
    assert.equal(discVisibleFraction(1, 0.5, 0), 0.75);
    assert.equal(discVisibleFraction(1, 0.5, 0.3), 0.75);
    assert.equal(discVisibleFraction(1, 0.7, -0.4), discVisibleFraction(1, 0.7, 0.4));
    // Two equal unit discs one radius apart: lens area = 2π/3 − √3/2.
    assert.ok(Math.abs(discVisibleFraction(1, 1, 1) - (1 - (2 * Math.PI / 3 - Math.sqrt(3) / 2) / Math.PI)) < 1e-12);
    // Continuity at the contact and annular boundaries.
    assert.ok(Math.abs(discVisibleFraction(1, 0.5, 1.5 - 1e-9) - 1) < 1e-6);
    assert.ok(Math.abs(discVisibleFraction(1, 0.5, 0.5 + 1e-9) - 0.75) < 1e-6);
    // Degenerate input never yields NaN.
    for (const args of [[0, 1, 0], [1, 0, 0], [1, 1, NaN], [NaN, 1, 0]]) assert.ok(Number.isFinite(discVisibleFraction(...args)));
});

test('solarObscurationAt: total, annular, partial and clear geometries', () => {
    const sun = [1, 0, 0];
    const pos = [1, 0, 0]; // observer on the sub-solar point
    // Moon 54 ER from the observer looks bigger than the Sun → total.
    assert.equal(solarObscurationAt(pos, [55, 0, 0], sun), 1);
    // Moon 63 ER away is smaller → annular, obscuration (ro/rs)².
    const ro = Math.asin(MOON_RADIUS_ER / 62);
    assert.ok(Math.abs(solarObscurationAt(pos, [63, 0, 0], sun) - (ro / SUN_ANG_RADIUS_RAD) ** 2) < 1e-9);
    // Offset by about one solar radius → partial.
    const partial = solarObscurationAt(pos, [61, 61 * SUN_ANG_RADIUS_RAD, 0], sun);
    assert.ok(partial > 0.2 && partial < 0.8, `partial ${partial}`);
    // Far off-axis → nothing.
    assert.equal(solarObscurationAt(pos, [0, 60, 0], sun), 0);
    // A larger true solar radius reduces the obscuration of the same annular geometry.
    assert.ok(solarObscurationAt(pos, [63, 0, 0], sun, SUN_ANG_RADIUS_RAD * 1.02) < solarObscurationAt(pos, [63, 0, 0], sun));
    // Degenerate: observer inside the Moon.
    assert.equal(solarObscurationAt([60, 0, 0], [60, 0, 0], sun), 0);
});

// --- Lunar eclipse light ------------------------------------------------------------------------

const SUN_DIR = [1, 0, 0];
const SUN_DIST_ER = 23455;
const SUN_R_ER = 695700 / EARTH_RADIUS_KM;
// Moon `distER` from the Earth, `offDeg` from the antisun direction (geocentric).
const moonAt = (distER, offDeg) => [-distER * Math.cos(offDeg * Math.PI / 180), distER * Math.sin(offDeg * Math.PI / 180), 0];

// Independent brute force of the same model on an N×N grid over the Moon's disc (plane ⊥ Earth–Moon).
function bruteLight(m, N = 200) {
    const dm = Math.hypot(...m);
    const u = m.map((v) => v / dm);
    const e1 = [-u[1], u[0], 0].map((v) => v / Math.hypot(u[0], u[1]));
    const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
    const S = SUN_DIR.map((v) => v * SUN_DIST_ER);
    let n = 0, lit = 0, flux = 0;
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
            const x = -1 + (2 * (i + 0.5)) / N, y = -1 + (2 * (j + 0.5)) / N;
            if (x * x + y * y > 1) continue;
            const px = m[0] + MOON_RADIUS_ER * (x * e1[0] + y * e2[0]);
            const py = m[1] + MOON_RADIUS_ER * (x * e1[1] + y * e2[1]);
            const pz = m[2] + MOON_RADIUS_ER * (x * e1[2] + y * e2[2]);
            const qx = S[0] - px, qy = S[1] - py, qz = S[2] - pz;
            const dp = Math.sqrt(px * px + py * py + pz * pz), dq = Math.sqrt(qx * qx + qy * qy + qz * qz);
            const rE = Math.asin(EARTH_SHADOW_RADIUS_ER / dp);
            const rS = Math.asin(SUN_R_ER / dq);
            const sep = Math.acos(Math.min(1, -(px * qx + py * qy + pz * qz) / (dp * dq)));
            const vis = discVisibleFraction(rS, rE, sep);
            const depth = sep < rE - rS ? 1 - sep / (rE - rS) : 0;
            n++;
            lit += vis;
            flux += vis + (1 - vis) * UMBRA_EDGE_LIGHT * 10 ** -depth;
        }
    }
    return { lit: lit / n, flux: flux / n };
}

test('lunarEclipseLight: outside the penumbra exactly {lit: 1, flux: 1}; writes into and returns `out`', () => {
    const out = { lit: NaN, flux: NaN };
    for (const off of [1.7, 3, 20, 90, 180]) {
        assert.equal(lunarEclipseLight(moonAt(57, off), SUN_DIR, SUN_DIST_ER, out), out);
        assert.equal(out.lit, 1, `offset ${off}°`);
        assert.equal(out.flux, 1, `offset ${off}°`);
    }
});

test('lunarEclipseLight: totality on the shadow axis leaves only refracted light (1e-5…1e-4 of full)', () => {
    const out = { lit: 1, flux: 1 };
    lunarEclipseLight(moonAt(60, 0), SUN_DIR, SUN_DIST_ER, out);
    assert.equal(out.lit, 0);
    assert.ok(out.flux > 1e-5 && out.flux < UMBRA_EDGE_LIGHT, `flux ${out.flux}`);
    // Deeper in the umbra is darker.
    const edge = { lit: 1, flux: 1 };
    lunarEclipseLight(moonAt(60, 0.38), SUN_DIR, SUN_DIST_ER, edge);
    assert.equal(edge.lit, 0, 'still total 0.38° off the axis');
    assert.ok(edge.flux > out.flux);
});

test('lunarEclipseLight: the 72-point quadrature matches a 200×200 brute force within 0.03 mag', () => {
    let worst = 0;
    for (const dist of [56, 60, 63.5]) {
        for (let off = 0; off <= 1.65; off += 0.075) {
            const got = lunarEclipseLight(moonAt(dist, off), SUN_DIR, SUN_DIST_ER, { lit: 1, flux: 1 });
            const ref = bruteLight(moonAt(dist, off));
            const err = Math.abs(2.5 * Math.log10(got.flux / ref.flux));
            worst = Math.max(worst, err);
            assert.ok(err < 0.03, `dist ${dist} off ${off.toFixed(2)}°: ${got.flux} vs ${ref.flux}`);
            assert.ok(Math.abs(got.lit - ref.lit) < 0.003, `lit ${got.lit} vs ${ref.lit}`);
        }
    }
    assert.ok(worst < 0.03);
});

test('lunarEclipseLight: monotonic toward the axis; degenerate input stays finite and uneclipsed', () => {
    let prev = 1;
    for (let off = 1.7; off >= 0; off -= 0.02) {
        const { flux } = lunarEclipseLight(moonAt(60, off), SUN_DIR, SUN_DIST_ER, { lit: 1, flux: 1 });
        assert.ok(flux <= prev + 1e-12, `flux rose to ${flux} at ${off.toFixed(2)}°`);
        prev = flux;
    }
    for (const [m, s, d] of [[[0, 0, 0], SUN_DIR, SUN_DIST_ER], [[NaN, 0, 0], SUN_DIR, SUN_DIST_ER], [moonAt(60, 0), SUN_DIR, NaN], [moonAt(60, 0), SUN_DIR, 10]]) {
        const out = lunarEclipseLight(m, s, d, { lit: 0, flux: 0 });
        assert.deepEqual(out, { lit: 1, flux: 1 });
    }
});
