import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    dipolePole, kpToAL, ovalBoundaries, createAurora, computeAurora, magCoords, ovalAt, auroraText, ovalSummary,
    AURORA_KP, AURORA_SETTINGS, OVAL_BINS, AURORA_PERIOD_S,
} from '../js/astro/geomag.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('the IGRF dipole pole sits where published (2020: 80.6° N 72.7° W; 2025: 80.8° N 72.8° W)', () => {
    const p20 = dipolePole(Date.UTC(2020, 0, 1));
    near(p20.latDeg, 80.6, 0.1, 'lat 2020');
    near(p20.lonDeg, -72.7, 0.1, 'lon 2020');
    const p25 = dipolePole(Date.UTC(2025, 0, 1));
    near(p25.latDeg, 80.8, 0.1, 'lat 2025');
    near(p25.lonDeg, -72.8, 0.1, 'lon 2025');
    // 1900: 78.6° N 68.8° W.
    const p00 = dipolePole(Date.UTC(1900, 0, 1));
    near(p00.latDeg, 78.6, 0.1);
    near(p00.lonDeg, -68.8, 0.1);
});

test('the dipole is held at its 1900 and 2030 values outside the IGRF years', () => {
    assert.deepEqual(dipolePole(Date.UTC(1000, 0, 1)), dipolePole(Date.UTC(1899, 6, 1)));
    assert.deepEqual(dipolePole(Date.UTC(2999, 0, 1)), dipolePole(Date.UTC(2030, 6, 1)));
    const a = dipolePole(Date.UTC(2027, 6, 1)), b = dipolePole(Date.UTC(2029, 6, 1));
    assert.ok(b.latDeg > a.latDeg, 'the 2025–2030 secular variation keeps moving the pole north');
    assert.ok(Number.isFinite(dipolePole(NaN).latDeg));
});

test('Kp → AL (Starkov): 18 nT at Kp 0, rising monotonically', () => {
    assert.equal(kpToAL(0), 18);
    let prev = 0;
    for (let k = 0; k <= 9; k += 0.5) {
        const al = kpToAL(k);
        assert.ok(al > prev, `AL(${k})`);
        prev = al;
    }
    assert.equal(kpToAL(12), kpToAL(9), 'clamped');
});

test('oval boundaries: a band that widens and moves equatorward with Kp, lowest near midnight', () => {
    const tabs = [1, 3, 7].map((kp) => ovalBoundaries(kp));
    for (const t of tabs) {
        assert.equal(t.length, 2 * OVAL_BINS);
        for (let h = 0; h < OVAL_BINS; h++) {
            assert.ok(t[h] > 50 && t[h] < 80, `eq ${t[h]}`);
            assert.ok(t[OVAL_BINS + h] >= t[h] + 1, 'poleward of the equatorward edge');
        }
        // Midnight sector lower than noon (the oval is displaced antisunward).
        assert.ok(t[0] < t[12] - 5, 'midnight edge well below noon edge');
    }
    // Kp 3 near midnight: about 64° (Starkov / Sigernes et al. 2011 Fig. 1).
    near(tabs[1][0], 64, 1.5, 'Kp 3 midnight equatorward edge');
    // Higher activity: lower edge, every hour.
    for (let h = 0; h < OVAL_BINS; h++) {
        assert.ok(tabs[0][h] >= tabs[1][h] - 0.3 && tabs[1][h] >= tabs[2][h] - 0.3, `monotone at ${h} h`);
    }
    near(Math.min(...tabs[2].slice(0, OVAL_BINS)), 60, 1.5, 'storm (Kp 7) reaches ~60°');
});

test('computeAurora fills the snapshot slot without allocating: pole, noon, table, phase', () => {
    const snap = createSnapshot();
    assert.ok(snap.aurora, 'createSnapshot provides an aurora slot');
    const t = Date.UTC(2026, 11, 21, 22);
    computeSnapshot(t, { latDeg: 69.65, lonDeg: 18.96, elevM: 0 }, snap, { detail: 'frame' });
    const aur = computeAurora(snap, 'typical', snap.aurora);
    assert.equal(aur, snap.aurora);
    const { poleS, noonS, ovals } = aur;
    assert.equal(aur.kp, 3);
    near(Math.hypot(...poleS), 1, 1e-12);
    near(Math.hypot(...noonS), 1, 1e-12);
    near(poleS[0] * noonS[0] + poleS[1] * noonS[1] + poleS[2] * noonS[2], 0, 1e-12, 'noon ⟂ pole');
    // Noon leans toward the Sun.
    assert.ok(noonS[0] * snap.sunDirS[0] + noonS[1] * snap.sunDirS[1] + noonS[2] * snap.sunDirS[2] > 0);
    assert.ok(aur.phase >= 0 && aur.phase < 1);
    near(aur.phase, ((t / 1000) / AURORA_PERIOD_S) % 1, 1e-9);
    assert.ok(Number.isFinite(aur.minEqDeg) && aur.minEqDeg < 66);
    // The same arrays are refilled.
    const ref = [poleS, noonS, ovals];
    computeAurora(snap, 'storm', snap.aurora);
    assert.deepEqual([snap.aurora.poleS, snap.aurora.noonS, snap.aurora.ovals], ref);
    assert.equal(snap.aurora.kp, 7);
    computeAurora(snap, 'bogus', snap.aurora);
    assert.equal(snap.aurora.kp, AURORA_KP.typical);
});

test('magnetic coordinates: Tromsø at 22 UT is near magnetic midnight, inside the Kp 3 oval', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(2026, 11, 21, 22), { latDeg: 69.65, lonDeg: 18.96, elevM: 0 }, snap, { detail: 'frame' });
    computeAurora(snap, 'typical', snap.aurora);
    const mc = magCoords(snap.observer.posS, snap.aurora);
    near(mc.magLatDeg, 67, 1.5, 'Tromsø dipole latitude');
    assert.ok(mc.mltH > 22.5 || mc.mltH < 1.5, `MLT ${mc.mltH}`);
    const { eqDeg, poleDeg } = ovalAt(snap.aurora, mc.mltH);
    assert.ok(mc.magLatDeg > eqDeg && mc.magLatDeg < poleDeg);
    assert.match(auroraText(snap), /^Under the aurora oval \(modelled Kp 3, not a forecast\)$/);
    // By day nothing is said.
    computeSnapshot(Date.UTC(2026, 5, 21, 11), { latDeg: 69.65, lonDeg: 18.96, elevM: 0 }, snap, { detail: 'frame' });
    computeAurora(snap, 'typical', snap.aurora);
    assert.equal(auroraText(snap), '');
});

test('auroraText: far from the oval says nothing; just equatorward says "low in the north"', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(2026, 11, 21, 23), { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, snap, { detail: 'frame' });
    computeAurora(snap, 'storm', snap.aurora);
    assert.equal(auroraText(snap), '', 'Paris: too far even in the storm model');
    computeSnapshot(Date.UTC(2026, 11, 21, 23), { latDeg: 59.9, lonDeg: 10.75, elevM: 0 }, snap, { detail: 'frame' });
    computeAurora(snap, 'typical', snap.aurora);
    assert.match(auroraText(snap), /^Aurora oval low in the north/);
    assert.equal(auroraText({}), '');
});

test('settings vocabulary and summary', () => {
    assert.deepEqual(AURORA_SETTINGS, ['quiet', 'typical', 'storm']);
    assert.match(ovalSummary('typical'), /^Kp 3: .* 64° .*not live space weather\.$/);
    assert.match(ovalSummary('nope'), /^Kp 3/);
    const fresh = createAurora();
    assert.equal(fresh.ovals.length, 48);
});
