// The solar-system zoom's pure geometry (js/astro/orrery.js) and the snapshot's heliocentric
// vectors: one linear scale (the Earth→body line is the geocentric direction), the camera pose and
// its pivot, the crossfade, the orbit polylines and the retrograde figure's sight lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../js/astro/orrery.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { AU_ER, BODY_INDEX } from '../js/astro/bodies.js';

const D2R = Math.PI / 180;
const HCMC = { latDeg: 10.82, lonDeg: 106.63, elevM: 0 };
const OPPOSITION = Date.parse('2027-02-19T12:00:00Z');   // Mars at opposition
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const len = (v) => Math.hypot(v[0], v[1], v[2]);

test('snapshot.helio: the Earth ~1 AU from the Sun, every body at the Earth plus its geocentric vector', () => {
    const s = createSnapshot();
    computeSnapshot(OPPOSITION, HCMC, s, { detail: 'frame' });
    const e = s.helio.earthS;
    near(len(e), 0.988, 0.01, '|earth| in February (near perihelion)');
    // The Sun sits at the origin; the Earth points away from it along −sunDirS.
    assert.deepEqual([...s.helio.posS.slice(0, 3)], [0, 0, 0]);
    const k = -(e[0] * s.sunDirS[0] + e[1] * s.sunDirS[1] + e[2] * s.sunDirS[2]) / len(e);
    near(k, 1, 1e-6, 'earth ∥ −sun direction');
    for (const id of ['moon', 'mars', 'jupiter', 'neptune']) {
        const i = BODY_INDEX[id], st = s.bodies[i];
        const d = [s.helio.posS[i * 3] - e[0], s.helio.posS[i * 3 + 1] - e[1], s.helio.posS[i * 3 + 2] - e[2]];
        const l = len(d);
        // distAU is topocentric: up to one Earth radius (4.3e-5 AU) off the geocentric length.
        near(l, st.distAU, 0.002 * st.distAU + 5e-5, `${id}: |line| = geocentric distance`);
        // The line runs along the geocentric direction (the beam's, to its ≤ 25″ parallax).
        const c = (d[0] * st.geoDirS[0] + d[1] * st.geoDirS[1] + d[2] * st.geoDirS[2]) / l;
        assert.ok(c > Math.cos(1e-6), `${id}: line along geoDirS (${Math.acos(Math.min(1, c)) / D2R * 3600}″)`);
        const t = (d[0] * st.dirS[0] + d[1] * st.dirS[1] + d[2] * st.dirS[2]) / l;
        assert.ok(t > Math.cos((id === 'moon' ? 1.1 : 30 / 3600) * D2R), `${id}: within parallax of the beam`);
    }
    // Mars at opposition: on the far side of the Earth from the Sun.
    const m = BODY_INDEX.mars;
    assert.ok(len(s.helio.posS.subarray(m * 3, m * 3 + 3)) > len(e) + 0.5, 'Mars beyond the Earth');
});

test('the crossfade and the pivot: 0 inside 80 R, 1 from 150 R; the pivot leaves the Earth slowly', () => {
    assert.equal(O.systemBlend(50), 0);
    assert.equal(O.systemBlend(80), 0);
    assert.equal(O.systemBlend(150), 1);
    assert.equal(O.systemBlend(1e6), 1);
    const mid = O.systemBlend(Math.sqrt(80 * 150));
    near(mid, 0.5, 1e-9, 'half-way in log distance');
    assert.equal(O.pivotWeight(0), 0);
    assert.equal(O.pivotWeight(O.PIVOT_FULL_R), 1);
    assert.equal(O.pivotWeight(10 * O.PIVOT_FULL_R), 1);
    // 150 R: well under a pixel's worth of pivot shift (0.1 R at 150 R).
    assert.ok(O.pivotWeight(150) * AU_ER < 0.2, `${O.pivotWeight(150) * AU_ER} R`);
    let prev = 0;
    for (let d = 100; d < O.PIVOT_FULL_R; d *= 1.3) {
        const w = O.pivotWeight(d);
        assert.ok(w >= prev, 'monotonic');
        // The Earth stays within ~2/3 of the half-frame (45° field): w·1 AU ≤ 0.67 · D tan 22.5°.
        assert.ok(w * AU_ER <= 0.67 * d * Math.tan(22.5 * D2R) + 1e-9, `Earth in frame at ${d.toFixed(0)} R`);
        prev = w;
    }
});

test('systemPose: on the Earth at 150 R the camera is the orbit pose; far out it orbits the Sun with ecliptic north up', () => {
    const earth = [0.3, 0.1, -0.95];
    const p = O.createSystemPose();
    const u = O.eclipticDir(0.7, 0.4, new Float64Array(3));
    O.systemPose(150, 0.7, 0.4, earth, p);
    near(len(p.pos), 150, 0.2, '150 R from the Earth');
    for (let k = 0; k < 3; k++) near(p.fwd[k], -u[k], 1e-12, 'looks back along u');
    near(p.up[1], 1, 1e-12, 'celestial north up');
    O.systemPose(O.SYSTEM_VIEW_R, 0.7, 0.4, earth, p);
    // The pivot is the Sun: −earthS in Earth radii.
    for (let k = 0; k < 3; k++) near(p.pivot[k], -earth[k] * AU_ER, 1e-6, 'pivot on the Sun');
    for (let k = 0; k < 3; k++) near(p.up[k], O.ECL_NORTH_S[k], 1e-12, 'ecliptic north up');
    near(len(p.pos.map((v, k) => v - p.pivot[k])), O.SYSTEM_VIEW_R, 1e-6, 'distance from the pivot');
});

test('ecliptic directions round-trip; the ecliptic pole is 23.44° from the celestial one', () => {
    const v = O.eclipticDir(1.234, -0.321, new Float64Array(3));
    near(len(v), 1, 1e-12, 'unit');
    const e = O.eclipticOf(v, { lon: 0, lat: 0 });
    near(e.lon, 1.234, 1e-12, 'lon');
    near(e.lat, -0.321, 1e-12, 'lat');
    near(Math.acos(O.ECL_NORTH_S[1]) / D2R, 23.4393, 1e-3, 'obliquity');
});

test('liftLat: zooming out lifts a low view toward 35°, zooming in leaves it; it never overshoots', () => {
    const lat0 = 5 * D2R;
    const [a, b] = O.LIFT_R;
    assert.equal(O.liftLat(lat0, 200, 1000), lat0, 'below the lift band');
    const mid = O.liftLat(lat0, a, Math.sqrt(a * b));
    assert.ok(mid > lat0 && mid < O.LIFT_LAT_DEG * D2R, 'part way');
    near(O.liftLat(mid, Math.sqrt(a * b), b), O.LIFT_LAT_DEG * D2R, 1e-12, 'all the way at the band end');
    near(O.liftLat(-lat0, a, b), -O.LIFT_LAT_DEG * D2R, 1e-12, 'a southern view lifts south');
    assert.equal(O.liftLat(lat0, b, a), lat0, 'zooming in keeps it');
    assert.equal(O.liftLat(60 * D2R, a, b), 60 * D2R, 'already above');
});

test('orbitPolylines: closed loops at the right radii, the Moon 0.0026 AU round the Earth', () => {
    const r = O.orbitPolylines(OPPOSITION, 64, 32);
    assert.equal(r.n, 64);
    assert.deepEqual(r.ids, [...O.ORBIT_IDS]);
    assert.equal(r.points.length, O.ORBIT_IDS.length * 64 * 3);
    const radii = { mercury: [0.30, 0.47], venus: [0.71, 0.73], earth: [0.98, 1.02], mars: [1.38, 1.67], jupiter: [4.94, 5.46], neptune: [29.7, 30.4] };
    for (const [id, [lo, hi]] of Object.entries(radii)) {
        const b = r.ids.indexOf(id);
        for (let i = 0; i < 64; i++) {
            const j = (b * 64 + i) * 3;
            const d = Math.hypot(r.points[j], r.points[j + 1], r.points[j + 2]);
            assert.ok(d > lo && d < hi, `${id}[${i}] at ${d} AU`);
        }
    }
    for (let i = 0; i < 32; i++) {
        const d = Math.hypot(r.moon[i * 3], r.moon[i * 3 + 1], r.moon[i * 3 + 2]);
        assert.ok(d > 0.0023 && d < 0.0028, `moon[${i}] ${d}`);
    }
    // The snapshot's Earth lies on its sampled orbit (within one chord's sagitta).
    const s = createSnapshot();
    computeSnapshot(OPPOSITION, HCMC, s, { detail: 'frame' });
    const b = r.ids.indexOf('earth');
    let best = Infinity;
    for (let i = 0; i < 64; i++) {
        const j = (b * 64 + i) * 3;
        best = Math.min(best, Math.hypot(r.points[j] - s.helio.earthS[0], r.points[j + 1] - s.helio.earthS[1], r.points[j + 2] - s.helio.earthS[2]));
    }
    assert.ok(best < 0.1, `Earth ${best} AU from its nearest sample`);
    assert.throws(() => O.orbitPolylines(NaN), RangeError);
});

test('moonOrbitPolyline: the Moon stays on its ring within the refresh window, not a half-year on', () => {
    const c = OPPOSITION;
    const ring = O.moonOrbitPolyline(c);
    assert.equal(ring.nMoon, O.MOON_SAMPLES);
    assert.deepEqual(Array.from(ring.moon), Array.from(O.orbitPolylines(c, 16).moon), 'the same samples as orbitPolylines');
    const s = createSnapshot();
    const fromRing = (tMs) => {
        computeSnapshot(tMs, HCMC, s, { detail: 'frame' });
        const m = BODY_INDEX.moon;
        const mx = s.helio.posS[m * 3] - s.helio.earthS[0], my = s.helio.posS[m * 3 + 1] - s.helio.earthS[1], mz = s.helio.posS[m * 3 + 2] - s.helio.earthS[2];
        const p = ring.moon, n = p.length / 3;
        let best = Infinity;
        for (let i = 0; i < n; i++) {
            const j = ((i + 1) % n) * 3, ax = p[i * 3], ay = p[i * 3 + 1], az = p[i * 3 + 2];
            const bx = p[j] - ax, by = p[j + 1] - ay, bz = p[j + 2] - az;
            const t = Math.max(0, Math.min(1, ((mx - ax) * bx + (my - ay) * by + (mz - az) * bz) / (bx * bx + by * by + bz * bz)));
            best = Math.min(best, Math.hypot(mx - ax - t * bx, my - ay - t * by, mz - az - t * bz));
        }
        return best * AU_ER;
    };
    for (const dt of [0, 0.5, -0.5, 1].map((k) => k * O.MOON_ORBIT_REFRESH_MS)) {
        assert.ok(fromRing(c + dt) < 0.05, `${(dt / 864e5).toFixed(1)} d from the centre: ${fromRing(c + dt).toFixed(3)} R off the ring`);
    }
    assert.ok(fromRing(c + 182 * 864e5) > 0.5, 'a half-year on, a stale ring is visibly off (hence the refresh)');
    assert.throws(() => O.moonOrbitPolyline(NaN), RangeError);
});

test('sight lines: Mars turns back around its 2027 opposition (the retrograde figure), steps independent of the frame time', () => {
    const step = O.sightStepMs('Mars');
    near(step / 864e5, 7.09, 0.05, 'Mars step (days)');
    assert.ok(Number.isNaN(O.sightStepMs('Earth')), 'no synodic period for the Earth');
    assert.ok(Number.isNaN(O.sightStepMs('Pluto?')), 'unknown');
    const n = 40;
    const out = new Float64Array(n * 6);
    const k0 = O.sightLines('Mars', OPPOSITION + 40 * 864e5, n, out);
    assert.equal(k0, Math.floor((OPPOSITION + 40 * 864e5) / step));
    // The same step index from a slightly different time gives the same lines.
    const again = new Float64Array(n * 6);
    O.sightLines('Mars', k0 * step + 1000, n, again);
    assert.deepEqual([...again], [...out]);
    // Ecliptic longitude of each sight line, oldest first: it rises, falls (retrograde), rises.
    const lons = [];
    const e = { lon: 0, lat: 0 };
    for (let k = n - 1; k >= 0; k--) {
        const j = k * 6;
        O.eclipticOf([out[j + 3] - out[j], out[j + 4] - out[j + 1], out[j + 5] - out[j + 2]], e);
        lons.push(e.lon);
    }
    const d = lons.slice(1).map((v, i) => Math.atan2(Math.sin(v - lons[i]), Math.cos(v - lons[i])));
    assert.ok(d.some((x) => x < 0), 'some steps retrograde');
    assert.ok(d.slice(0, 3).every((x) => x > 0) || d.slice(-3).every((x) => x > 0) || d.some((x) => x > 0), 'and some prograde');
    // At opposition itself the line is retrograde.
    const pair = new Float64Array(12);
    O.sightAt('Mars', OPPOSITION, pair, 0);
    O.sightAt('Mars', OPPOSITION + 864e5, pair, 6);
    const l0 = O.eclipticOf([pair[3] - pair[0], pair[4] - pair[1], pair[5] - pair[2]], { lon: 0, lat: 0 }).lon;
    const l1 = O.eclipticOf([pair[9] - pair[6], pair[10] - pair[7], pair[11] - pair[8]], { lon: 0, lat: 0 }).lon;
    assert.ok(l1 < l0, 'retrograde at opposition');
});

test('edgeExit: the line from the Earth clipped to the free area, wherever the Earth is', () => {
    const rect = { x0: -0.9, x1: 0.8, y0: -0.7, y1: 0.9, aspect: 1.6 };
    const out = { x: 0, y: 0, angle: 0 };
    assert.equal(O.edgeExit(0, 0, 1, 0, rect, out), true);
    near(out.x, 0.8, 1e-12, 'right side');
    near(out.y, 0, 1e-12, 'level');
    near(out.angle, 0, 1e-12, 'pointing right');
    O.edgeExit(0.2, 0.1, -1, -1, rect, out);
    near(out.y, -0.7, 1e-12, 'bottom first');
    near(out.x, 0.2 - 0.8, 1e-12, 'along the diagonal');
    near(out.angle, Math.atan2(-1, -1.6), 1e-12, 'screen angle uses the aspect');
    // The segment to the body (tMax 1) ends where it leaves the area, short of the body.
    assert.equal(O.edgeExit(0, 0, 2, 0, rect, out, 1), true);
    near(out.x, 0.8, 1e-12, 'segment: right side');
    // An Earth off the area (a phone's right-hand strip): the line enters the area, and the arrow
    // goes where it leaves again on the way to the body, on the line, not from the area's centre.
    assert.equal(O.edgeExit(0.9, 0.2, -2.2, 0.2, rect, out, 1), true);
    near(out.x, -0.9, 1e-12, 'left side');
    near(out.y, 0.2 + 0.2 * (1.8 / 2.2), 1e-12, 'on the line');
    // A line that never crosses the area (the body off the same side as the Earth): no arrow.
    assert.equal(O.edgeExit(0.9, 0.2, 0.5, 0.1, rect, out, 1), false, 'away from the area');
    assert.equal(O.edgeExit(0.9, 1.2, -0.05, 0.3, rect, out, 1), false, 'past a corner');
    assert.equal(O.edgeExit(5, 5, 0, 1, rect, out), false, 'parallel, outside');
    assert.equal(O.edgeExit(0, 0, 0, 0, rect, out), false, 'no direction');
    assert.equal(O.edgeExit(0, 0, NaN, 1, rect, out), false, 'NaN');
});
