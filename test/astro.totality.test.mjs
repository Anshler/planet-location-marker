// Totality from the ground (js/astro/totality.js): the lunar limb profile, Baily's beads against
// AE's contacts at Luxor 2027-08-02, the corona's epoch parameters, the display adaptation and the
// horizon ring's azimuthal shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import {
    LIMB_PROFILE, LIMB_STEPS, LIMB_AMPLITUDE, LIMB_MIN, MAX_BEADS, NO_GAP, limbHeight, createBeads, bailysBeads,
    photosphereAdapt, coronaVisibility, coronaStretch, chromosphereFlash, coronaFlattening, coronaParams,
    createCoronaParams, umbraHorizonGlow, createHorizonGlow,
} from '../js/astro/totality.js';

const ARCSEC = Math.PI / 180 / 3600;
const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0 };
const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-07-01T00:00:00Z')), new AE.Observer(25.7, 32.6, 0));
const C2 = ls.total_begin.time.date.getTime();
const C3 = ls.total_end.time.date.getTime();
const MID = Date.parse('2027-08-02T10:05:00Z');

function beadsAt(tMs, detail = 'frame') {
    const snap = createSnapshot();
    computeSnapshot(tMs, LUXOR, snap, { detail });
    return snap;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('the lunar limb profile is fixed, zero-mean, ±2.2″ and periodic', () => {
    assert.equal(LIMB_PROFILE.length, LIMB_STEPS);
    let mean = 0, peak = 0;
    for (const h of LIMB_PROFILE) { mean += h; peak = Math.max(peak, Math.abs(h)); }
    assert.ok(Math.abs(mean / LIMB_STEPS) < 1e-12 * ARCSEC + 1e-15);
    assert.ok(Math.abs(peak - LIMB_AMPLITUDE) < 1e-15, 'scaled to the amplitude');
    assert.ok(LIMB_MIN < -1 * ARCSEC, `deepest valley ${LIMB_MIN / ARCSEC}″`);
    // Interpolation: exact at the nodes, periodic, continuous.
    assert.equal(limbHeight(0), LIMB_PROFILE[0]);
    assert.ok(Math.abs(limbHeight(2 * Math.PI) - LIMB_PROFILE[0]) < 1e-18);
    assert.ok(Math.abs(limbHeight(-1e-9) - LIMB_PROFILE[0]) < 1e-3 * ARCSEC);
    const step = (2 * Math.PI) / LIMB_STEPS;
    assert.ok(Math.abs(limbHeight(10.5 * step) - (LIMB_PROFILE[10] + LIMB_PROFILE[11]) / 2) < 1e-18);
});

test('Luxor 2027: beads open only around AE\'s second and third contacts, never in mid-totality', () => {
    const gaps = [];
    for (const [t, want] of [[C2 - 60000, 'none'], [C2 - 3000, 'some'], [C2 + 1000, 'some'], [MID, 'none'],
        [C3 + 1000, 'some'], [C3 + 60000, 'none']]) {
        const snap = beadsAt(t);
        const b = snap.eclipse.beads;
        gaps.push(b.gapArcsec);
        if (want === 'none') assert.equal(b.count, 0, new Date(t).toISOString());
        else assert.ok(b.count >= 1 && b.count <= MAX_BEADS, `${new Date(t).toISOString()}: ${b.count}`);
        // The smooth-limb gap and the obscuration describe the same discs.
        assert.equal(b.gapArcsec <= 0, snap.eclipse.obscurationAtObserver >= 1, `gap ${b.gapArcsec}`);
    }
    // The gap closes at ~0.39″/s: −60 s → +23″, mid-totality ≈ −66″.
    assert.ok(gaps[0] > 15 && gaps[0] < 30, `C2 − 60 s gap ${gaps[0]}`);
    assert.ok(gaps[3] < -50, `mid gap ${gaps[3]}`);
    // Zero crossing within 0.1 s of AE's C2.
    const g0 = beadsAt(C2 - 100).eclipse.beads.gapArcsec, g1 = beadsAt(C2 + 100).eclipse.beads.gapArcsec;
    assert.ok(g0 > 0 && g1 < 0, `${g0} ${g1}`);
});

test('beads: sorted by flux, on the Sun\'s limb, on the contact side, allocation-free', () => {
    const snap = beadsAt(C2 + 1000);
    const b = snap.eclipse.beads;
    const sun = snap.bodies[0], moon = snap.bodies[1];
    const sunR = Math.asin(695700 / (sun.distAU * 149597870.7));
    let sum = 0;
    for (let i = 0; i < b.count; i++) {
        if (i > 0) assert.ok(b.flux[i] <= b.flux[i - 1]);
        assert.ok(b.flux[i] > 0 && b.flux[i] < 1e-3);
        sum += b.flux[i];
        const d = b.dirS.subarray(3 * i, 3 * i + 3);
        assert.ok(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-12);
        const ang = Math.acos(Math.min(1, dot(d, sun.dirS)));
        assert.ok(Math.abs(ang - sunR) < 0.01 * sunR, 'on the limb');
        // Opposite the Moon's offset: closer to the Sun's far side from the Moon.
        assert.ok(dot(d, moon.dirS) < dot(sun.dirS, moon.dirS) + 1e-12, 'contact side');
        assert.ok(b.paDeg[i] >= 0 && b.paDeg[i] < 360);
    }
    assert.ok(sum <= b.total * (1 + 1e-12));
    // The diamond ring one second after C2 carries ~1e-5 of the Sun.
    assert.ok(b.flux[0] > 2e-6 && b.flux[0] < 1e-4, `${b.flux[0]}`);
    // The same out object, no new arrays.
    const out = createBeads();
    const f = out.flux, p = out.paDeg, ds = out.dirS;
    const pole = new Float64Array([0, 1, 0]);
    bailysBeads(sun.dirS, moon.dirS, sunR, sunR * 1.07, pole, out);
    assert.ok(out.flux === f && out.paDeg === p && out.dirS === ds);
});

test('beads: none for an annular geometry, a far Moon or degenerate input; NO_GAP is finite', () => {
    const out = createBeads();
    const s = new Float64Array([0, 0, 1]);
    const m = new Float64Array([0, Math.sin(2e-6), Math.cos(2e-6)]);
    const pole = new Float64Array([0, 1, 0]);
    bailysBeads(s, m, 4.6e-3, 4.4e-3, pole, out);               // annular
    assert.equal(out.count, 0);
    assert.ok(out.gapArcsec > 0);
    bailysBeads(s, new Float64Array([1, 0, 0]), 4.6e-3, 4.9e-3, pole, out);   // 90° away
    assert.equal(out.count, 0);
    assert.equal(out.gapArcsec, NO_GAP);
    bailysBeads(s, m, 4.6e-3, 4.9e-3, new Float64Array([0, 0, 1]), out);      // pole along the line of sight
    assert.ok(Number.isFinite(out.gapArcsec));
    assert.ok(Number.isFinite(NO_GAP));
});

test('display adaptation, corona visibility, stretch and the chromosphere flash', () => {
    assert.equal(photosphereAdapt(0), 1);
    assert.equal(photosphereAdapt(0.5), 1);
    assert.equal(photosphereAdapt(1), 40);
    assert.ok(photosphereAdapt(0.999) > photosphereAdapt(0.99) && photosphereAdapt(0.99) > 1);
    assert.equal(photosphereAdapt(NaN), 1);
    assert.equal(coronaVisibility(0.9), 0);
    assert.equal(coronaVisibility(1), 1);
    let prev = 0;
    for (const o of [0.95, 0.96, 0.99, 0.999, 0.9999, 1]) {
        const v = coronaVisibility(o);
        assert.ok(v >= prev && v <= 1, `${o}: ${v}`);
        prev = v;
    }
    assert.ok(coronaVisibility(0.99) < 0.2, 'still faint with 1 % of the Sun left');
    assert.equal(coronaStretch(50, 30), 1);
    assert.ok(Math.abs(coronaStretch(3, 30) - 4.5) < 1e-12);
    assert.equal(coronaStretch(0, 30), 1);
    assert.equal(chromosphereFlash(5), 0);
    assert.equal(chromosphereFlash(NO_GAP), 0);
    assert.ok(chromosphereFlash(0) > 0.9);
    assert.ok(chromosphereFlash(-5) < chromosphereFlash(-1));
    assert.ok(chromosphereFlash(-66) < 1e-3, 'gone by mid-totality');
});

test('corona epoch: Ludendorff flattening follows the cycle; the structure is seeded by date', () => {
    const eMax = coronaFlattening(Date.UTC(2024, 9, 15));
    const eMin = coronaFlattening(Date.UTC(2030, 3, 15));
    const e27 = coronaFlattening(Date.UTC(2027, 7, 2));
    assert.ok(eMax < 0.06 && eMin > 0.28, `${eMax} ${eMin}`);
    assert.ok(e27 > eMax && e27 < eMin, `${e27}`);
    const a = coronaParams(MID, createCoronaParams());
    const b = coronaParams(MID + 3 * 3600e3, createCoronaParams());   // same UTC day
    const c = coronaParams(Date.parse('2026-08-12T17:46:00Z'), createCoronaParams());
    assert.deepEqual([...a.streamerPA], [...b.streamerPA]);
    assert.notDeepEqual([...a.streamerPA], [...c.streamerPA]);
    for (let i = 0; i < 4; i++) {
        // Streamers near the equator (PA ±90° from the pole), prominences within 50° latitude.
        const lat = Math.PI / 2 - Math.abs(Math.atan2(Math.sin(a.streamerPA[i]), Math.cos(a.streamerPA[i])));
        assert.ok(Math.abs(lat) <= 56 * Math.PI / 180, `streamer ${i}`);
        assert.ok(a.streamerWidth[i] > 0 && a.streamerGain[i] > 0);
        assert.ok(a.promHeight[i] >= 0.04 && a.promHeight[i] <= 0.2 && a.promWidth[i] > 0);
    }
    assert.equal(a.promHeight.filter((h) => h >= 0.14).length, 1, 'one tall prominence');
    // Recomputes only when the day changes (same object back, untouched).
    const before = a.seed;
    a.seed = -1;
    coronaParams(MID + 1000, a);
    assert.equal(a.seed, -1);
    a.seed = before;
});

test('horizon ring: brightest toward the umbra\'s nearest edge; off outside the umbra', () => {
    // Sun at the zenith, Moon apparently 30″ north of it, 380 000 km away: the observer sits south
    // of the shadow axis, so the nearest edge is to the south.
    const up = new Float64Array([0, 0, 1]), north = new Float64Array([0, 1, 0]), east = new Float64Array([1, 0, 0]);
    const sunR = 4.6e-3, moonR = 4.95e-3;
    const a = 30 * ARCSEC;
    const moon = new Float64Array([0, Math.sin(a), Math.cos(a)]);
    const g = umbraHorizonGlow(up, moon, sunR, moonR, 380000, north, east, createHorizonGlow());
    assert.ok(g.inUmbra);
    assert.ok(dot(g.h1, north) < -0.2, `h1·N = ${dot(g.h1, north)}`);
    assert.ok(Math.abs(dot(g.h1, east)) < 1e-9);
    // The nearest edge: (ρ☾ − ρ☉ − 30″)·D.
    assert.ok(Math.abs(g.nearKm - (moonR - sunR - a) * 380000) < 1, `${g.nearKm}`);
    // Centred: round shadow, no first harmonic.
    const c = umbraHorizonGlow(up, up, sunR, moonR, 380000, north, east, createHorizonGlow());
    assert.ok(c.inUmbra && Math.hypot(...c.h1) < 1e-9 && c.a2 < 1e-9);
    // A low Sun stretches the shadow along its azimuth: the ring is darker there (second harmonic).
    const low = new Float64Array([0, Math.cos(0.4), Math.sin(0.4)]);
    const l = umbraHorizonGlow(low, low, sunR, moonR, 380000, north, east, createHorizonGlow());
    assert.ok(l.a2 > 0.05 && Math.abs(dot(l.d2, east)) > 0.99, `a2 ${l.a2}, d2 ${[...l.d2]}`);
    // Partial phase: no ring.
    const out = umbraHorizonGlow(up, new Float64Array([0, Math.sin(600 * ARCSEC), Math.cos(600 * ARCSEC)]),
        sunR, moonR, 380000, north, east, createHorizonGlow());
    assert.equal(out.inUmbra, false);
});

test('Luxor mid-totality: the ring\'s level and the Sun\'s pole from the snapshot', () => {
    const snap = beadsAt(MID, 'full');
    const s = snap.bodies[0], m = snap.bodies[1];
    const sunR = Math.asin(695700 / (s.distAU * 149597870.7)), moonR = Math.asin(1737.4 / (m.distAU * 149597870.7));
    const g = umbraHorizonGlow(s.dirS, m.dirS, sunR, moonR, m.distAU * 149597870.7, snap.observer.northS, snap.observer.eastS,
        createHorizonGlow());
    assert.ok(g.inUmbra && g.nearKm > 50 && g.nearKm < 140, `${g.nearKm}`);
    assert.ok(g.level >= 0.5 && g.level <= 1.6);
    // IAU pole RA 286.13°, Dec 63.87° (J2000) → scene (cosδcosα, sinδ, −cosδ sinα).
    const ra = 286.13 * Math.PI / 180, de = 63.87 * Math.PI / 180;
    const want = [Math.cos(de) * Math.cos(ra), Math.sin(de), -Math.cos(de) * Math.sin(ra)];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(snap.sunPoleS[i] - want[i]) < 1e-9);
});
