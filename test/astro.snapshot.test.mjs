// Per-frame snapshot (SPEC §C.2, §D.3–D.4, §H): accuracy, completeness,
// in-place reuse, robustness and cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import { BODIES, AU_ER } from '../js/astro/bodies.js';
import * as F from '../js/astro/frames.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

const D2R = Math.PI / 180;
const ARCSEC = D2R / 3600;
const FULL = { detail: 'full' };

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

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const wrapDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function randomCase(r) {
    return {
        tMs: Date.UTC(1900, 0, 1) + r() * (Date.UTC(2150, 0, 1) - Date.UTC(1900, 0, 1)),
        observer: { latDeg: Math.asin(2 * r() - 1) / D2R, lonDeg: 360 * r() - 180, elevM: Math.floor(r() * 3000) },
    };
}

test('200 random (t, observer, body) cases: altGeomDeg/azGeomDeg agree with unrefracted Horizon() within 30″', () => {
    const r = rng(101);
    const snap = createSnapshot();
    let worstAlt = 0, worstAz = 0;
    for (let k = 0; k < 200; k++) {
        const { tMs, observer } = randomCase(r);
        const i = Math.floor(r() * BODIES.length);
        computeSnapshot(tMs, observer, snap);
        const time = AE.MakeTime(new Date(tMs));
        const obs = new AE.Observer(observer.latDeg, observer.lonDeg, observer.elevM);
        const eqd = AE.Equator(BODIES[i].ae, time, obs, true, true);
        const hor = AE.Horizon(time, obs, eqd.ra, eqd.dec, undefined);
        const st = snap.bodies[i];
        worstAlt = Math.max(worstAlt, Math.abs(st.altGeomDeg - hor.altitude) * 3600);
        if (hor.altitude < 80) worstAz = Math.max(worstAz, wrapDiff(st.azGeomDeg, hor.azimuth) * 3600 * Math.cos(hor.altitude * D2R));
    }
    assert.ok(worstAlt < 30, `worst altitude error ${worstAlt.toFixed(2)}″`);
    assert.ok(worstAz < 30, `worst azimuth·cos(alt) error ${worstAz.toFixed(2)}″`);
});

test('zenith: the snapshot upS agrees with Rotation_EQJ_HOR within 0.05″; posS/upS/northS/eastS form a right-handed frame', () => {
    const r = rng(102);
    const snap = createSnapshot();
    let worst = 0;
    for (let k = 0; k < 200; k++) {
        const { tMs, observer } = randomCase(r);
        computeSnapshot(tMs, observer, snap);
        const H = F.aeRotToM3(AE.Rotation_EQJ_HOR(AE.MakeTime(new Date(tMs)), new AE.Observer(observer.latDeg, observer.lonDeg, 0)));
        const o = snap.observer;
        worst = Math.max(worst, F.angleBetween3(F.sceneToEqj(o.upS), [H[6], H[7], H[8]]));
        // HOR: x = north, y = west; the snapshot's north/east must match too.
        assert.ok(F.angleBetween3(F.sceneToEqj(o.northS), [H[0], H[1], H[2]]) < 0.05 * ARCSEC);
        assert.ok(F.angleBetween3(F.sceneToEqj(o.eastS), [-H[3], -H[4], -H[5]]) < 0.05 * ARCSEC);
        assert.deepEqual(Array.from(o.posS), Array.from(o.upS));
        const u2 = F.cross3(o.eastS, o.northS);
        for (let c = 0; c < 3; c++) close(u2[c], o.upS[c], 1e-12);
    }
    assert.ok(worst < 0.05 * ARCSEC, `worst zenith error ${worst / ARCSEC}″`);
});

test('bodies: 9 entries in BODIES order with consistent distances and unit vectors; Moon distER in [55, 64.5]', () => {
    const r = rng(103);
    const snap = createSnapshot();
    assert.equal(snap.bodies.length, 9);
    for (let k = 0; k < 60; k++) {
        const { tMs, observer } = randomCase(r);
        computeSnapshot(tMs, observer, snap, k % 2 ? FULL : undefined);
        assert.deepEqual(snap.bodies.map((b) => b.id), BODIES.map((b) => b.id));
        for (const st of snap.bodies) {
            close(F.length3(st.dirS), 1, 1e-12);
            close(F.length3(st.geoDirS), 1, 1e-12);
            close(st.distER, st.distAU * AU_ER, 1e-9 * st.distER);
            close(st.lightTimeS, st.distAU * 499.004784, 1e-9 * st.lightTimeS);
        }
        const moon = snap.bodies[1];
        assert.ok(moon.distER >= 55 && moon.distER <= 64.5, `Moon distER ${moon.distER}`);
        close(F.length3(snap.moonPosS), Math.hypot(...Object.values(AE.GeoMoon(new Date(tMs))).slice(0, 3)) * AU_ER, 1e-9);
    }
});

function* numbersIn(value, path = 'snap', seen = new Set()) {
    if (typeof value === 'number') {
        yield [path, value];
    } else if (ArrayBuffer.isView(value)) {
        for (let i = 0; i < value.length; i++) yield [`${path}[${i}]`, value[i]];
    } else if (value && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        for (const [k, v] of Object.entries(value)) yield* numbersIn(v, `${path}.${k}`, seen);
    }
}

test('no NaN or Infinity anywhere after detail "full" (also at the poles, the date-line and the year range edges)', () => {
    const snap = createSnapshot();
    const cases = [
        [Date.parse('2026-10-11T12:00:00Z'), { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 }],
        [Date.parse('2026-06-21T00:00:00Z'), { latDeg: 90, lonDeg: 0, elevM: 0 }],
        [Date.parse('2026-12-21T00:00:00Z'), { latDeg: -90, lonDeg: 180, elevM: 2835 }],
        [Date.UTC(1000, 0, 1), { latDeg: 0, lonDeg: -180, elevM: 0 }],
        [Date.UTC(3000, 0, 1) - 1, { latDeg: 45, lonDeg: 179.9999, elevM: 8848 }],
    ];
    for (const [t, o] of cases) {
        computeSnapshot(t, o, snap, FULL);
        for (const [path, v] of numbersIn(snap)) assert.ok(Number.isFinite(v), `${path} = ${v} at ${new Date(t).toISOString()}`);
        for (const st of snap.bodies) {
            assert.equal(typeof st.above, 'boolean');
            assert.ok(st.constellation.symbol.length === 3, `${st.id} constellation ${st.constellation.symbol}`);
            assert.ok(st.elongSide === null || st.elongSide === 'morning' || st.elongSide === 'evening');
        }
        assert.ok(['day', 'civil', 'nautical', 'astronomical', 'night'].includes(snap.observer.twilight));
        assert.equal(snap.detail, 'full');
    }
});

test('computeSnapshot reuses `out` and every nested object and typed array (identity check)', () => {
    const snap = createSnapshot();
    const refs = [
        snap.earthMatrix, snap.earthQuat, snap.sunDirS, snap.moonPosS, snap.moonMatrix, snap.observer, snap.observer.posS,
        snap.observer.upS, snap.observer.northS, snap.observer.eastS, snap.bodies, snap.eclipse,
        ...snap.bodies.flatMap((b) => [b, b.dirS, b.geoDirS, b.constellation]),
    ];
    const t0 = Date.parse('2026-10-11T00:00:00Z');
    for (let i = 0; i < 20; i++) {
        const ret = computeSnapshot(t0 + i * 3.6e6, { latDeg: 10 * i - 80, lonDeg: 17 * i - 170, elevM: 0 }, snap, i % 3 ? undefined : FULL);
        assert.equal(ret, snap);
    }
    const after = [
        snap.earthMatrix, snap.earthQuat, snap.sunDirS, snap.moonPosS, snap.moonMatrix, snap.observer, snap.observer.posS,
        snap.observer.upS, snap.observer.northS, snap.observer.eastS, snap.bodies, snap.eclipse,
        ...snap.bodies.flatMap((b) => [b, b.dirS, b.geoDirS, b.constellation]),
    ];
    assert.equal(after.length, refs.length);
    for (let i = 0; i < refs.length; i++) assert.equal(after[i], refs[i], `reference ${i} replaced`);
    assert.ok(snap.earthMatrix instanceof Float64Array && snap.earthMatrix.length === 16);
    assert.ok(snap.earthQuat instanceof Float64Array && snap.earthQuat.length === 4);
    assert.ok(snap.moonMatrix instanceof Float64Array && snap.moonMatrix.length === 16);
});

test('earthMatrix, earthQuat and the D.3 formula E = PN·Rz(GAST) agree', () => {
    const r = rng(104);
    const snap = createSnapshot();
    for (let k = 0; k < 50; k++) {
        const { tMs, observer } = randomCase(r);
        computeSnapshot(tMs, observer, snap);
        const time = AE.MakeTime(new Date(tMs));
        close(snap.gastDeg, AE.SiderealTime(time) * 15, 1e-9);
        close(snap.jdUT, tMs / 864e5 + 2440587.5, 1e-9);
        const E = F.m3mul(F.aeRotToM3(AE.Rotation_EQD_EQJ(time)), F.rotZ(snap.gastDeg * D2R));
        const ref = F.m3ToSceneM4(E);
        for (let i = 0; i < 16; i++) close(snap.earthMatrix[i], ref[i], 1e-14);
        // Quaternion rotates like the matrix.
        const [qx, qy, qz, qw] = snap.earthQuat;
        close(Math.hypot(qx, qy, qz, qw), 1, 1e-14);
        const v = [0.3, -0.4, 0.866];
        const t = [2 * (qy * v[2] - qz * v[1]), 2 * (qz * v[0] - qx * v[2]), 2 * (qx * v[1] - qy * v[0])];
        const rq = [v[0] + qw * t[0] + (qy * t[2] - qz * t[1]), v[1] + qw * t[1] + (qz * t[0] - qx * t[2]), v[2] + qw * t[2] + (qx * t[1] - qy * t[0])];
        const rm = F.m4MulDir(snap.earthMatrix, v);
        for (let c = 0; c < 3; c++) close(rq[c], rm[c], 1e-12);
        // Observer pin sits at the lat/lon on the rotated unit sphere.
        const ll = F.localToLatLon(F.m4MulDirT(snap.earthMatrix, snap.observer.posS));
        close(ll.latDeg, observer.latDeg, 1e-9);
        assert.ok(wrapDiff(ll.lonDeg, observer.lonDeg) < 1e-9);
    }
});

test('rendered directions are the topocentric astrometric J2000 vectors; J2000 RA/Dec and sub-points derive from them', () => {
    const snap = createSnapshot();
    const tMs = Date.parse('2026-10-11T13:00:00Z');
    const observer = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 };
    computeSnapshot(tMs, observer, snap, FULL);
    const time = AE.MakeTime(new Date(tMs));
    const obs = new AE.Observer(observer.latDeg, observer.lonDeg, observer.elevM);
    for (const [i, b] of BODIES.entries()) {
        const st = snap.bodies[i];
        const eq = AE.Equator(b.ae, time, obs, false, false);
        assert.ok(F.angleBetween3(st.dirS, F.normalize3(F.eqjToScene(eq.vec))) < 1e-12);
        close(st.raJ2000H, eq.ra, 1e-9);
        close(st.decJ2000Deg, eq.dec, 1e-9);
        close(st.distAU, eq.dist, 1e-15);
        const geo = b.id === 'moon' ? AE.GeoMoon(time) : AE.GeoVector(b.ae, time, true);
        assert.ok(F.angleBetween3(st.geoDirS, F.normalize3(F.eqjToScene(geo))) < 1e-12);
        const eqd = AE.Equator(b.ae, time, obs, true, true);
        close(st.raDateH, eqd.ra, 1e-12);
        close(st.decDateDeg, eqd.dec, 1e-12);
        const hor = AE.Horizon(time, obs, eqd.ra, eqd.dec, 'normal');
        close(st.altDeg, hor.altitude, 1e-12);
        close(st.azDeg, hor.azimuth, 1e-12);
        assert.equal(st.constellation.symbol, AE.Constellation(eq.ra, eq.dec).symbol);
        const ill = AE.Illumination(b.ae, time);
        close(st.mag, ill.mag, 1e-12);
        close(st.phaseFrac, ill.phase_fraction, 1e-12);
        if (i > 0) {
            close(st.elongDeg, AE.AngleFromSun(b.ae, time), 1e-9, `${b.id} elongation`);
            assert.equal(st.elongSide, AE.Elongation(b.ae, time).visibility, `${b.id} side`);
        }
        close(st.angDiamArcsec, 2 * Math.atan(b.radiusKm / (eq.dist * 149597870.7)) / ARCSEC, 1e-9);
        // Sub-point: geocentric declination of date and RA − GAST (within aberration/parallax noise).
        close(st.subLatDeg, AE.EquatorFromVector(AE.RotateVector(AE.Rotation_EQJ_EQD(time), geo)).dec, 1e-6);
    }
    close(snap.moonPhaseDeg, AE.MoonPhase(time), 1e-9);
    close(snap.observer.sunAltDeg, snap.bodies[0].altGeomDeg, 0);
});

test("'frame' detail keeps the renderer fields fresh: altDeg/azDeg/above within 30″ of 'full', mag/phase exact", () => {
    const r = rng(105);
    const fast = createSnapshot();
    const full = createSnapshot();
    let worst = 0;
    for (let k = 0; k < 120; k++) {
        const { tMs, observer } = randomCase(r);
        computeSnapshot(tMs, observer, fast);
        computeSnapshot(tMs, observer, full, FULL);
        assert.equal(fast.detail, 'frame');
        for (let i = 0; i < 9; i++) {
            const a = fast.bodies[i], b = full.bodies[i];
            worst = Math.max(worst, Math.abs(a.altDeg - b.altDeg) * 3600);
            if (Math.abs(b.altDeg) > 0.02) assert.equal(a.above, b.above, `${a.id} above at alt ${b.altDeg}`);
            assert.equal(a.mag, b.mag);
            assert.equal(a.phaseAngleDeg, b.phaseAngleDeg);
            assert.equal(a.elongDeg, b.elongDeg);
            assert.equal(a.subLatDeg, b.subLatDeg);
        }
        assert.ok(Math.abs(((fast.moonPhaseDeg - full.moonPhaseDeg + 540) % 360) - 180) < 0.02);
        assert.deepEqual(fast.eclipse, full.eclipse);
    }
    // Refraction near the horizon differs slightly with the input altitude (aberration), hence 30″.
    assert.ok(worst < 30, `worst frame-vs-full altitude ${worst.toFixed(2)}″`);
});

test("'frame' detail leaves the of-date RA/Dec and constellation from the last full pass", () => {
    const snap = createSnapshot();
    const o = { latDeg: 48.85, lonDeg: 2.35, elevM: 35 };
    computeSnapshot(Date.parse('2026-10-11T20:00:00Z'), o, snap, FULL);
    const before = snap.bodies.map((b) => [b.raDateH, b.decDateDeg, b.constellation.name]);
    computeSnapshot(Date.parse('2027-03-01T20:00:00Z'), o, snap);
    assert.deepEqual(snap.bodies.map((b) => [b.raDateH, b.decDateDeg, b.constellation.name]), before);
});

test('above: Sun and Moon use the upper limb, so they are still up with the centre slightly below the horizon', () => {
    // Find a sunset at Greenwich and look just after the centre crosses the refracted horizon.
    const obs = new AE.Observer(51.4769, -0.0005, 0);
    const set = AE.SearchRiseSet('Sun', obs, -1, AE.MakeTime(new Date('2026-10-11T12:00:00Z')), 1);
    const snap = createSnapshot();
    const o = { latDeg: 51.4769, lonDeg: -0.0005, elevM: 0 };
    computeSnapshot(set.date.getTime() - 60e3, o, snap, FULL);
    assert.equal(snap.bodies[0].above, true, 'a minute before sunset');
    assert.ok(snap.bodies[0].altDeg < 0.3, 'centre close to the horizon');
    computeSnapshot(set.date.getTime() + 120e3, o, snap, FULL);
    assert.equal(snap.bodies[0].above, false, 'two minutes after sunset');
});

test('eclipse flags: annular 2027-02-06, total 2027-08-02 at Luxor, total lunar 2026-03-03, none on an ordinary day', () => {
    const snap = createSnapshot();
    // Total solar eclipse of 2027-08-02: Luxor is near the central line.
    const ge = AE.SearchGlobalSolarEclipse(AE.MakeTime(new Date('2027-07-01T00:00:00Z')));
    assert.equal(ge.kind, 'total');
    const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-07-01T00:00:00Z')), new AE.Observer(25.69, 32.64, 80));
    computeSnapshot(ls.peak.time.date.getTime(), { latDeg: 25.69, lonDeg: 32.64, elevM: 80 }, snap, FULL);
    assert.equal(snap.eclipse.solar, true);
    assert.equal(snap.eclipse.lunar, false);
    close(snap.eclipse.obscurationAtObserver, 1, 1e-9, 'totality at Luxor');
    // Total lunar eclipse of 2026-03-03.
    const le = AE.SearchLunarEclipse(AE.MakeTime(new Date('2026-02-20T00:00:00Z')));
    assert.equal(le.kind, 'total');
    computeSnapshot(le.peak.date.getTime(), { latDeg: 35, lonDeg: -120, elevM: 0 }, snap);
    assert.equal(snap.eclipse.lunar, true);
    assert.equal(snap.eclipse.solar, false);
    assert.equal(snap.eclipse.obscurationAtObserver, 0);
    computeSnapshot(Date.parse('2026-10-20T12:00:00Z'), { latDeg: 35, lonDeg: -120, elevM: 0 }, snap);
    assert.equal(snap.eclipse.solar || snap.eclipse.lunar, false);
});

test('Moon orientation: the sub-Earth point lies near the texture centre (u = 0.5) within libration limits', () => {
    const r = rng(106);
    const snap = createSnapshot();
    for (let k = 0; k < 100; k++) {
        computeSnapshot(Date.UTC(1950, 0, 1) + r() * 3.2e12, { latDeg: 0, lonDeg: 0, elevM: 0 }, snap);
        const m = snap.moonMatrix;
        assert.deepEqual([m[12], m[13], m[14]], Array.from(snap.moonPosS));
        const toEarth = F.normalize3([-snap.moonPosS[0], -snap.moonPosS[1], -snap.moonPosS[2]]);
        const ll = F.localToLatLon(F.m4MulDirT(m, toEarth));
        assert.ok(Math.abs(ll.latDeg) < 8, `libration in latitude ${ll.latDeg}`);
        assert.ok(Math.abs(ll.lonDeg) < 9, `libration in longitude ${ll.lonDeg}`);
    }
});

test('moonPhaseDeg tracks AE.MoonPhase (2026-10-11T00:00Z = 4.07°) and the Moon lit fraction', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.parse('2026-10-11T00:00:00Z'), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap, FULL);
    close(snap.moonPhaseDeg, 4.07, 0.01);
    computeSnapshot(Date.parse('2026-10-11T00:00:00Z'), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap);
    close(snap.moonPhaseDeg, 4.07, 0.02, 'frame-detail approximation');
    assert.ok(snap.bodies[1].phaseFrac < 0.01);
});

test('robustness: non-finite tMs leaves the snapshot untouched; bad observer fields are sanitised; a foreign `out` throws', () => {
    const snap = createSnapshot();
    const o = { latDeg: 21, lonDeg: 105.8, elevM: 15 };
    computeSnapshot(Date.parse('2026-10-11T12:00:00Z'), o, snap);
    const copy = JSON.stringify([...numbersIn(snap)]);
    assert.equal(computeSnapshot(NaN, o, snap), snap);
    assert.equal(computeSnapshot(Infinity, o, snap), snap);
    assert.equal(JSON.stringify([...numbersIn(snap)]), copy);
    computeSnapshot(Date.parse('2026-10-11T12:00:00Z'), { latDeg: 95, lonDeg: 365, elevM: -9999 }, snap);
    assert.equal(snap.observer.latDeg, 90);
    close(snap.observer.lonDeg, 5, 1e-12);
    assert.equal(snap.observer.elevM, -500);
    computeSnapshot(Date.parse('2026-10-11T12:00:00Z'), { latDeg: NaN, lonDeg: undefined }, snap);
    assert.equal(snap.observer.latDeg, 0);
    assert.equal(snap.observer.lonDeg, 0);
    for (const [path, v] of numbersIn(snap)) assert.ok(Number.isFinite(v), path);
    assert.throws(() => computeSnapshot(0, o, {}), TypeError);
});

test('createSnapshot gives an internally consistent placeholder before the first computation', () => {
    const s = createSnapshot();
    assert.equal(s.bodies.length, 9);
    assert.equal(s.detail, 'frame');
    for (const [path, v] of numbersIn(s)) assert.ok(Number.isFinite(v), path);
    assert.deepEqual(Array.from(s.earthQuat), [0, 0, 0, 1]);
    const u = F.cross3(s.observer.eastS, s.observer.northS);
    for (let c = 0; c < 3; c++) close(u[c], s.observer.upS[c], 0);
});

test('cost: computeSnapshot frame and full are well under 1 ms', () => {
    const snap = createSnapshot();
    const o = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 };
    const t0 = Date.parse('2026-10-11T00:00:00Z');
    for (let i = 0; i < 300; i++) computeSnapshot(t0 + i * 1000, o, snap, i % 2 ? FULL : undefined);
    const N = 1500;
    let s = performance.now();
    for (let i = 0; i < N; i++) computeSnapshot(t0 + i * 60000, o, snap);
    const frameMs = (performance.now() - s) / N;
    s = performance.now();
    for (let i = 0; i < N; i++) computeSnapshot(t0 + i * 60000, o, snap, FULL);
    const fullMs = (performance.now() - s) / N;
    console.log(`# computeSnapshot: frame ${frameMs.toFixed(3)} ms, full ${fullMs.toFixed(3)} ms (mean of ${N})`);
    // Generous bounds keep CI stable on slow runners; typical values are ~0.13 / ~0.23 ms.
    assert.ok(frameMs < 1, `frame ${frameMs} ms`);
    assert.ok(fullMs < 1.5, `full ${fullMs} ms`);
});

test('eclipse: no obscuration on the night side (the antipode of totality sees through the Earth)', () => {
    const snap = createSnapshot();
    const ge = AE.SearchGlobalSolarEclipse(AE.MakeTime(new Date('2027-07-01T00:00:00Z')));
    const t = ge.peak.date.getTime();
    computeSnapshot(t, { latDeg: ge.latitude, lonDeg: ge.longitude, elevM: 0 }, snap);
    assert.ok(snap.eclipse.obscurationAtObserver > 0.99);
    computeSnapshot(t, { latDeg: -ge.latitude, lonDeg: F.wrap180(ge.longitude + 180), elevM: 0 }, snap);
    assert.equal(snap.eclipse.solar, true);
    assert.ok(snap.bodies[0].altDeg < -80);
    assert.equal(snap.eclipse.obscurationAtObserver, 0);
});

test('eclipse: the lunar flag covers every lunar eclipse from first to last penumbral contact (2020–2040)', () => {
    const snap = createSnapshot();
    let le = AE.SearchLunarEclipse(AE.MakeTime(new Date('2020-01-01T00:00:00Z')));
    while (le.peak.date.getUTCFullYear() < 2040) {
        for (const sgn of [-1, 1]) {
            const t = le.peak.AddDays((sgn * (le.sd_penum - 0.25)) / 1440).date.getTime();
            computeSnapshot(t, { latDeg: 0, lonDeg: 0, elevM: 0 }, snap);
            assert.equal(snap.eclipse.lunar, true, `${le.kind} lunar eclipse ${le.peak.date.toISOString()}`);
        }
        le = AE.NextLunarEclipse(le.peak);
    }
});

// --- Eclipse magnitudes ----------------------------------------------------------------------------

const HONOLULU = { latDeg: 21.3069, lonDeg: -157.8583, elevM: 0 };
const illMag = (body, tMs) => AE.Illumination(body, AE.MakeTime(new Date(tMs))).mag;

test('eclipse magnitudes: the totally eclipsed Moon of 2026-03-03 reads −4…+2, not the full-Moon −12.7; frame = full', () => {
    const le = AE.SearchLunarEclipse(AE.MakeTime(new Date('2026-02-20T00:00:00Z')));
    assert.equal(le.kind, 'total');
    const t = le.peak.date.getTime();
    assert.equal(new Date(t).toISOString().slice(0, 16), '2026-03-03T11:33');
    const fast = createSnapshot(), full = createSnapshot();
    computeSnapshot(t, HONOLULU, fast);
    computeSnapshot(t, HONOLULU, full, FULL);
    const moon = full.bodies[1];
    assert.ok(moon.mag > -4 && moon.mag < 2, `Moon mag in totality ${moon.mag}`);
    assert.ok(moon.mag - illMag('Moon', t) > 8, 'dimmed by more than 8 mag');
    assert.equal(full.eclipse.moonLitFraction, 0);
    assert.equal(fast.bodies[1].mag, moon.mag);
    assert.deepEqual(fast.eclipse, full.eclipse);
    // The Sun is untouched by a lunar eclipse.
    assert.equal(full.bodies[0].mag, illMag('Sun', t));
});

test('eclipse magnitudes: the deep penumbral phase dims by 0.1–1.5 mag; the penumbral eclipse of 2027-02-20 by a few tenths', () => {
    const snap = createSnapshot();
    const le = AE.SearchLunarEclipse(AE.MakeTime(new Date('2026-02-20T00:00:00Z')));
    // Three minutes before the umbra first touches the Moon.
    const t = le.peak.date.getTime() - (le.sd_partial + 3) * 60e3;
    computeSnapshot(t, HONOLULU, snap);
    const dm = snap.bodies[1].mag - illMag('Moon', t);
    assert.ok(dm > 0.1 && dm < 1.5, `deep penumbral dimming ${dm}`);
    assert.ok(snap.eclipse.moonLitFraction > 0.2 && snap.eclipse.moonLitFraction < 0.9, `lit ${snap.eclipse.moonLitFraction}`);
    const pe = AE.SearchLunarEclipse(AE.MakeTime(new Date('2027-01-01T00:00:00Z')));
    assert.equal(pe.kind, 'penumbral');
    const tp = pe.peak.date.getTime();
    computeSnapshot(tp, HONOLULU, snap, FULL);
    const dp = snap.bodies[1].mag - illMag('Moon', tp);
    assert.ok(dp > 0.1 && dp < 1, `penumbral eclipse dimming ${dp}`);
});

test('eclipse magnitudes: a full Moon outside eclipse season keeps the AE.Illumination magnitude exactly', () => {
    const snap = createSnapshot();
    const fm = AE.SearchMoonPhase(180, AE.MakeTime(new Date('2026-10-11T00:00:00Z')), 40);
    const t = fm.date.getTime();
    for (const opts of [undefined, FULL]) {
        computeSnapshot(t, HONOLULU, snap, opts);
        assert.equal(snap.eclipse.lunar, false);
        assert.equal(snap.eclipse.moonLitFraction, 1);
        assert.equal(snap.bodies[1].mag, illMag('Moon', t));
        assert.ok(snap.bodies[1].mag < -12);
    }
});

test('eclipse magnitudes 2020–2040: unchanged a minute outside the penumbral contacts, dimmed at greatest eclipse', () => {
    const snap = createSnapshot();
    const o = { latDeg: 0, lonDeg: 0, elevM: 0 };
    let le = AE.SearchLunarEclipse(AE.MakeTime(new Date('2020-01-01T00:00:00Z')));
    while (le.peak.date.getUTCFullYear() < 2040) {
        const tag = `${le.kind} ${le.peak.date.toISOString()}`;
        for (const sgn of [-1, 1]) {
            const t = le.peak.AddDays((sgn * (le.sd_penum + 1)) / 1440).date.getTime();
            computeSnapshot(t, o, snap);
            assert.equal(snap.bodies[1].mag, illMag('Moon', t), `${tag} outside contact`);
            assert.equal(snap.eclipse.moonLitFraction, 1, tag);
        }
        const t = le.peak.date.getTime();
        computeSnapshot(t, o, snap);
        const mag = snap.bodies[1].mag, dm = mag - illMag('Moon', t);
        if (le.kind === 'total') {
            assert.equal(snap.eclipse.moonLitFraction, 0, tag);
            assert.ok(mag > -4 && mag < 2, `${tag}: mag ${mag}`);
        } else if (le.kind === 'partial') {
            assert.ok(dm > 0.3, `${tag}: dimmed ${dm}`);
        } else {
            assert.ok(dm >= 0 && dm < 1, `${tag}: dimmed ${dm}`);
        }
        le = AE.NextLunarEclipse(le.peak);
    }
});

test('eclipse magnitudes: the Moon fades and recovers smoothly through 2026-03-03 (no step over 0.25 mag in 10 s)', () => {
    const snap = createSnapshot();
    const le = AE.SearchLunarEclipse(AE.MakeTime(new Date('2026-02-20T00:00:00Z')));
    const t0 = le.peak.date.getTime();
    let prev = null, worst = 0, deepest = 0;
    for (let s = -(le.sd_penum + 2) * 60; s <= (le.sd_penum + 2) * 60; s += 10) {
        const t = t0 + s * 1000;
        computeSnapshot(t, HONOLULU, snap);
        const dm = snap.bodies[1].mag - illMag('Moon', t);
        assert.ok(dm >= 0, `brightened by ${-dm} at ${s} s`);
        if (prev !== null) worst = Math.max(worst, Math.abs(dm - prev));
        deepest = Math.max(deepest, dm);
        prev = dm;
    }
    assert.ok(worst < 0.25, `largest 10 s step ${worst} mag`);
    assert.ok(deepest > 10, `deepest ${deepest}`);
});

test('eclipse magnitudes: the annular Sun of 2027-02-06 at greatest eclipse is dimmed by −2.5·log10(1 − obscuration)', () => {
    const snap = createSnapshot();
    const o = { latDeg: -31.29, lonDeg: -48.47, elevM: 0 };
    const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-01-01T00:00:00Z')), new AE.Observer(o.latDeg, o.lonDeg, 0));
    assert.equal(ls.kind, 'annular');
    const t = ls.peak.time.date.getTime();
    for (const opts of [undefined, FULL]) {
        computeSnapshot(t, o, snap, opts);
        const obsc = snap.eclipse.obscurationAtObserver;
        close(obsc, ls.obscuration, 0.01, 'obscuration');
        close(snap.bodies[0].mag, illMag('Sun', t) - 2.5 * Math.log10(1 - obsc), 1e-9, 'Sun mag');
        close(snap.bodies[0].mag - illMag('Sun', t), -2.5 * Math.log10(1 - 0.8615), 0.1, 'about 2.15 mag');
        assert.equal(snap.eclipse.moonLitFraction, 1);
    }
    // Totality (Luxor 2027-08-02) bottoms out at +15 mag, about the corona; the night side is untouched.
    const lx = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-07-01T00:00:00Z')), new AE.Observer(25.69, 32.64, 80));
    const tl = lx.peak.time.date.getTime();
    computeSnapshot(tl, { latDeg: 25.69, lonDeg: 32.64, elevM: 80 }, snap);
    close(snap.bodies[0].mag, illMag('Sun', tl) + 15, 1e-9, 'total');
    computeSnapshot(tl, { latDeg: -25.69, lonDeg: 32.64 - 180, elevM: 0 }, snap);
    assert.equal(snap.bodies[0].mag, illMag('Sun', tl));
});
