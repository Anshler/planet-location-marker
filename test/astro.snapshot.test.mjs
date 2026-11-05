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
        snap.sunPoleS, snap.eclipse.beads, snap.eclipse.beads.flux, snap.eclipse.beads.dirS, snap.eclipse.beads.paDeg,
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
        snap.sunPoleS, snap.eclipse.beads, snap.eclipse.beads.flux, snap.eclipse.beads.dirS, snap.eclipse.beads.paDeg,
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

test('equatorial grid of date (render/sky.js): earthMatrix · RotY(−GAST) is S·PN·Sᵀ, so the grid pole is earthMatrix·ŷ', () => {
    // three's makeRotationY(θ), column-major; sky.js multiplies earthMatrix by it with θ = −GAST.
    const rotY16 = (t) => {
        const c = Math.cos(t), s = Math.sin(t);
        return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
    };
    const mul16 = (a, b) => {
        const o = new Array(16).fill(0);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
        return o;
    };
    const snap = createSnapshot();
    const r = rng(105);
    const cases = [Date.UTC(1066, 3, 24, 21), Date.UTC(2999, 11, 31), Date.UTC(1000, 0, 2), Date.UTC(2026, 10, 3)];
    for (let k = 0; k < 20; k++) cases.push(randomCase(r).tMs);
    for (const tMs of cases) {
        computeSnapshot(tMs, { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, snap, { detail: 'frame' });
        const time = AE.MakeTime(new Date(tMs));
        const grid = mul16(snap.earthMatrix, rotY16(-snap.gastDeg * D2R));
        const ref = F.m3ToSceneM4(F.aeRotToM3(AE.Rotation_EQD_EQJ(time)));
        for (let i = 0; i < 16; i++) close(grid[i], ref[i], 1e-12, `element ${i}`);
        const pole = F.m4MulDir(grid, [0, 1, 0]), axis = F.m4MulDir(snap.earthMatrix, [0, 1, 0]);
        for (let c = 0; c < 3; c++) close(pole[c], axis[c], 1e-9, 'pole of date');
        // A grid point at a star's RA/Dec of date lands on the star as drawn (J2000).
        const starS = F.raDecToScene(37.95, 89.264);               // Polaris, J2000
        const eqd = AE.EquatorFromVector(AE.RotateVector(AE.Rotation_EQJ_EQD(time), new AE.Vector(...F.sceneToEqj(starS), time)));
        const onGrid = F.m4MulDir(grid, F.raDecToScene(eqd.ra * 15, eqd.dec));
        assert.ok(F.angleBetween3(onGrid, starS) < 1e-9, `${new Date(tMs).toISOString()}: grid misses Polaris`);
    }
    // The fix matters at the ends of the range: the pole of 1066 is 5.2° from the J2000 pole.
    computeSnapshot(Date.UTC(1066, 3, 24, 21), { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, snap);
    const tilt = F.angleBetween3(F.m4MulDir(snap.earthMatrix, [0, 1, 0]), [0, 1, 0]) / D2R;
    assert.ok(tilt > 5.1 && tilt < 5.3, `1066 pole offset ${tilt.toFixed(2)}°`);
});

test('rendered directions are the topocentric astrometric J2000 vectors; J2000 RA/Dec and sub-points derive from them', () => {
    const snap = createSnapshot();
    const tMs = Date.parse('2026-10-11T13:00:00Z');
    const observer = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 };
    computeSnapshot(tMs, observer, snap, FULL);
    const time = AE.MakeTime(new Date(tMs));
    const obs = new AE.Observer(observer.latDeg, observer.lonDeg, observer.elevM);
    // The Moon: AE's geometric (≈ apparent) direction minus the annual aberration a star there has,
    // with v/c taken from the Sun's apparent − astrometric direction (see moonToAstrometric).
    const unit = (body, ab) => F.normalize3(F.eqjToScene(AE.Equator(body, time, obs, false, ab).vec));
    const sAst = unit('Sun', false), sApp = unit('Sun', true);
    const v = [0, 1, 2].map((k) => sApp[k] - sAst[k]);
    const mGeo = unit('Moon', false);
    const mv = F.dot3(mGeo, v);
    const moonAst = F.normalize3([0, 1, 2].map((k) => mGeo[k] - (v[k] - mGeo[k] * mv)));
    for (const [i, b] of BODIES.entries()) {
        const st = snap.bodies[i];
        const eq = AE.Equator(b.ae, time, obs, false, false);
        if (b.id === 'moon') {
            assert.ok(F.angleBetween3(st.dirS, moonAst) < 1e-12);
            const shift = F.angleBetween3(st.dirS, F.normalize3(F.eqjToScene(eq.vec))) / ARCSEC;
            assert.ok(shift > 1 && shift < 20.6, `aberration removed from the Moon: ${shift}″`);
            const rd = F.sceneToRaDec(st.dirS);
            close(st.raJ2000H, rd.raDeg / 15, 1e-9);
            close(st.decJ2000Deg, rd.decDeg, 1e-9);
        } else {
            assert.ok(F.angleBetween3(st.dirS, F.normalize3(F.eqjToScene(eq.vec))) < 1e-12);
            close(st.raJ2000H, eq.ra, 1e-9);
            close(st.decJ2000Deg, eq.dec, 1e-9);
        }
        close(st.distAU, eq.dist, 1e-15);
        const geo = b.id === 'moon' ? AE.GeoMoon(time) : AE.GeoVector(b.ae, time, true);
        assert.ok(F.angleBetween3(st.geoDirS, F.normalize3(F.eqjToScene(geo))) < 1e-12);
        const eqd = AE.Equator(b.ae, time, obs, true, true);
        close(st.raDateH, eqd.ra, 1e-12);
        close(st.decDateDeg, eqd.dec, 1e-12);
        const hor = AE.Horizon(time, obs, eqd.ra, eqd.dec, 'normal');
        close(st.altDeg, hor.altitude, 1e-12);
        close(st.azDeg, hor.azimuth, 1e-12);
        assert.equal(st.constellation.symbol, AE.Constellation(st.raJ2000H, st.decJ2000Deg).symbol);
        const ill = AE.Illumination(b.ae, time);
        close(st.mag, ill.mag, 1e-12);
        close(st.phaseFrac, ill.phase_fraction, 1e-12);
        if (i > 0) {
            close(st.elongDeg, AE.AngleFromSun(b.ae, time), 1e-9, `${b.id} elongation`);
            assert.equal(st.elongSide, AE.Elongation(b.ae, time).visibility, `${b.id} side`);
        }
        close(st.angDiamArcsec, 2 * Math.asin(b.radiusKm / (eq.dist * 149597870.7)) / ARCSEC, 1e-9);
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

// One eclipse geometry: obscurationAtObserver and the discs the sky view draws (render/bodies.js:
// the Sun at dirS with sunAngularRadius, the Moon mesh at eye + dirS·distER, so seen from the eye
// it sits at dirS with radius asin(R/d)) switch at AE.SearchLocalSolarEclipse's contacts. Before,
// the drawn discs reached totality 35 s late at Luxor and the obscuration 17.5 s early.
const CONTACT_CASES = [
    ['Burgos 2026-08-12', 42.34, -3.70, '2026-08-01'],
    ['Reykjavik 2026-08-12', 64.15, -21.94, '2026-08-01'],
    ['Luxor 2027-08-02', 25.7, 32.6, '2027-07-01'],
    ['Sydney 2028-07-22', -33.87, 151.21, '2028-07-01'],
    ['Accra 2027-02-06 (annular)', 5.6, -0.19, '2027-02-01'],
];
const EYE_R = 1.0005;

/** First time in (t0, t1] at which pred differs from pred(t0), to 1 ms (one switch assumed). */
function switchTime(pred, t0, t1) {
    const p0 = pred(t0);
    assert.notEqual(pred(t1), p0, 'no switch in the window');
    let a = t0, b = t1;
    while (b - a > 1) {
        const m = (a + b) / 2;
        if (pred(m) === p0) a = m; else b = m;
    }
    return b;
}

/** The sky view's drawn discs from a snapshot, as render/bodies.js builds them (arcseconds). */
function drawnDiscs(snap) {
    const s = snap.bodies[0], m = snap.bodies[1], p = snap.observer.posS;
    const eye = [p[0] * EYE_R, p[1] * EYE_R, p[2] * EYE_R];
    const mesh = [0, 1, 2].map((k) => eye[k] + m.dirS[k] * m.distER);
    const toMoon = [0, 1, 2].map((k) => mesh[k] - eye[k]);
    const d = Math.hypot(...toMoon);
    return {
        sep: F.angleBetween3(s.dirS, toMoon) / ARCSEC,
        rS: Math.asin(695700 / (s.distAU * 149597870.7)) / ARCSEC,
        rM: Math.asin((1737.4 / 6378.137) / d) / ARCSEC,
    };
}

test('eclipse contacts: obscuration and the drawn discs turn central within 1 s of AE C2/C3 (2026, 2027, 2028; annular 2027)', () => {
    const snap = createSnapshot();
    for (const [name, lat, lon, from] of CONTACT_CASES) {
        const o = { latDeg: lat, lonDeg: lon, elevM: 0 };
        const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date(from)), new AE.Observer(lat, lon, 0));
        assert.ok(ls.total_begin && ls.total_end, `${name}: AE finds a central phase`);
        const c2 = ls.total_begin.time.date.getTime(), c3 = ls.total_end.time.date.getTime();
        const central = (t) => {
            computeSnapshot(t, o, snap);
            const g = drawnDiscs(snap);
            // Panel geometry (angDiamArcsec) and drawn geometry are the same discs.
            assert.ok(Math.abs(g.rS - snap.bodies[0].angDiamArcsec / 2) < 1e-6 && Math.abs(g.rM - snap.bodies[1].angDiamArcsec / 2) < 1e-6);
            return g.sep <= Math.abs(g.rM - g.rS);
        };
        const total = (t) => {
            computeSnapshot(t, o, snap);
            return snap.eclipse.obscurationAtObserver >= 1;
        };
        const tag = (what, t, ref) => `${name} ${what} ${((t - ref) / 1000).toFixed(2)} s from AE`;
        const d2 = switchTime(central, c2 - 30e3, c2 + 30e3), d3 = switchTime(central, c3 - 30e3, c3 + 30e3);
        assert.ok(Math.abs(d2 - c2) < 1000, tag('drawn C2', d2, c2));
        assert.ok(Math.abs(d3 - c3) < 1000, tag('drawn C3', d3, c3));
        if (ls.kind === 'total') {
            const o2 = switchTime(total, c2 - 30e3, c2 + 30e3), o3 = switchTime(total, c3 - 30e3, c3 + 30e3);
            assert.ok(Math.abs(o2 - c2) < 1000, tag('obscuration C2', o2, c2));
            assert.ok(Math.abs(o3 - c3) < 1000, tag('obscuration C3', o3, c3));
            assert.ok(Math.abs(o2 - d2) < 50 && Math.abs(o3 - d3) < 50, `${name}: obscuration and drawn discs agree`);
        } else {
            // Annular: never total; inside the ring the obscuration is (rM/rS)², AE's value.
            computeSnapshot((c2 + c3) / 2, o, snap);
            const ob = snap.eclipse.obscurationAtObserver;
            assert.ok(ob < 1);
            close(ob, (snap.bodies[1].angDiamArcsec / snap.bodies[0].angDiamArcsec) ** 2, 1e-9, `${name} annular obscuration`);
            close(ob, ls.obscuration, 0.002, `${name} AE obscuration`);
        }
    }
});

test('eclipse geometry at Luxor greatest eclipse: the dirS separation is the apparent one (≈9″, not the astrometric 19″)', () => {
    const obs = new AE.Observer(25.7, 32.6, 0);
    const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-07-01')), obs);
    const time = ls.peak.time;
    const snap = createSnapshot();
    computeSnapshot(time.date.getTime(), { latDeg: 25.7, lonDeg: 32.6, elevM: 0 }, snap);
    const app = (body) => F.normalize3(F.eqjToScene(AE.Equator(body, time, obs, false, true).vec));
    const apparent = F.angleBetween3(app('Sun'), app('Moon')) / ARCSEC;
    const drawn = F.angleBetween3(snap.bodies[0].dirS, snap.bodies[1].dirS) / ARCSEC;
    assert.ok(apparent < 12, `apparent separation ${apparent}″`);
    assert.ok(Math.abs(drawn - apparent) < 0.1, `drawn ${drawn}″ vs apparent ${apparent}″`);
    assert.equal(snap.eclipse.obscurationAtObserver, 1);
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
