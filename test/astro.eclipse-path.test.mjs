// Path of a central solar eclipse (js/astro/eclipse-path.js): centre line and limits against
// NASA's Five Millennium Canon values, the ends, annular and hybrid paths, the date line, cities in
// the band (AE local circumstances), the worker op and the client's main-thread fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    eclipsePath, citiesInPath, nearestCentrePoint, pathAt, shadowPoint, PATH_STRIDE, PATH_COL,
    shadowAxisPoint, pathFrameLocal, ribbonMesh, umbraNear, UMBRA_NEAR_RAD,
} from '../js/astro/eclipse-path.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { shadowPoint as actionsShadowPoint } from '../js/app/actions.js';
import { AE } from '../js/astro/ae.js';
import * as W from '../js/astro/worker.js';
import { createAstroClient } from '../js/astro/client.js';
import { distanceKm } from '../js/geo/coords.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const col = (p, i, c) => p.samples[i * p.stride + c];

// Each path once (≈ 10–40 ms apiece).
const aug2027 = eclipsePath(Date.parse('2027-08-02T10:07:00Z'));
const aug2026 = eclipsePath(Date.parse('2026-08-12T17:46:00Z'));
const feb2027 = eclipsePath(Date.parse('2027-02-06T16:00:00Z'));
const apr2023 = eclipsePath(Date.parse('2023-04-20T04:17:00Z'));
const jul2028 = eclipsePath(Date.parse('2028-07-22T02:56:00Z'));

function checkShape(p, label) {
    assert.equal(p.stride, PATH_STRIDE);
    assert.ok(p.samples instanceof Float64Array);
    assert.equal(p.samples.length, p.count * PATH_STRIDE);
    assert.ok(p.count > 50, `${label}: ${p.count} samples`);
    assert.ok(p.startMs < p.peakMs && p.peakMs < p.endMs, `${label}: start < peak < end`);
    assert.equal(col(p, 0, PATH_COL.T), p.startMs);
    assert.equal(col(p, p.count - 1, PATH_COL.T), p.endMs);
    for (let i = 0; i < p.count; i++) {
        if (i > 0) assert.ok(col(p, i, PATH_COL.T) > col(p, i - 1, PATH_COL.T), `${label}: times increase`);
        for (const [la, lo] of [[1, 2], [3, 4], [5, 6]]) {
            const lat = col(p, i, la), lon = col(p, i, lo);
            assert.ok(lat >= -90 && lat <= 90, `${label}: latitude ${lat}`);
            assert.ok(lon > -180 && lon <= 180, `${label}: longitude ${lon} wrapped to (−180, 180]`);
        }
        if (i > 0) {
            // Dense enough to draw: ≤ ~120 km between consecutive centre points, even at the ends.
            const km = distanceKm(col(p, i - 1, 1), col(p, i - 1, 2), col(p, i, 1), col(p, i, 2));
            assert.ok(km < 130, `${label}: centre step ${km.toFixed(0)} km at row ${i}`);
        }
    }
    // The ends are where the axis grazes the Earth: the Sun on the horizon.
    assert.ok(col(p, 0, PATH_COL.SUN_ALT) < 1 && col(p, p.count - 1, PATH_COL.SUN_ALT) < 1, `${label}: Sun on the horizon at the ends`);
}

test('2027-08-02 total: greatest eclipse at 25.5° N, 33.2° E and a 258 km path (NASA)', () => {
    const p = aug2027;
    assert.ok(p);
    checkShape(p, '2027-08-02');
    assert.equal(p.kind, 'total');
    // NASA: greatest eclipse 10:07:50 TD (10:06:39 UT) at 25°29.9′N 33°10.7′E, width 258 km, 6 m 23 s.
    const ge = AE.SearchGlobalSolarEclipse(AE.MakeTime(new Date('2027-07-20T00:00:00Z')));
    assert.equal(p.peakMs, ge.peak.date.getTime());
    near(p.peakMs, Date.parse('2027-08-02T10:06:39Z'), 60e3, 'greatest eclipse (UT)');
    assert.ok(distanceKm(p.greatest.latDeg, p.greatest.lonDeg, 25.498, 33.178) < 10, 'greatest point');
    assert.ok(distanceKm(p.greatest.latDeg, p.greatest.lonDeg, ge.latitude, ge.longitude) < 1, 'AE greatest point');
    near(p.widthKm, 258, 8, 'path width at greatest eclipse');
    near(p.widthKmMax, 258, 12, 'widest');
    // The central duration there is AE's own local result (≈ NASA's 6 m 23 s).
    near(p.greatest.durS, 386.9, 1, 'duration at greatest eclipse');
    near(p.greatest.sunAltDeg, 81.7, 0.3, 'Sun altitude');
    // The umbra on the centre line: ~129 km at greatest eclipse, smaller toward the ends.
    for (let i = 0; i < p.count; i++) assert.ok(col(p, i, PATH_COL.RADIUS_KM) > 90 && col(p, i, PATH_COL.RADIUS_KM) < 132);
    // From the Atlantic (sunrise) to the Indian Ocean (sunset).
    assert.ok(col(p, 0, 2) < -30 && col(p, p.count - 1, 2) > 60, 'west to east');
    // Luxor is well inside the band, ~28 km from the centre line, crossed at about 10:05 UT.
    const c = nearestCentrePoint(p, 25.7, 32.6);
    assert.ok(c.km < 40, `Luxor ${c.km.toFixed(0)} km from the centre line`);
    near(c.tMs, Date.parse('2027-08-02T10:05:30Z'), 120e3, 'centre line passes Luxor');
});

test('2026-08-12 total (Greenland, Iceland, Spain) and 2027-02-06 annular agree with NASA', () => {
    const t = aug2026;
    checkShape(t, '2026-08-12');
    assert.equal(t.kind, 'total');
    // NASA: 65°13′N 25°14′W, width 294 km, 2 m 18 s.
    assert.ok(distanceKm(t.greatest.latDeg, t.greatest.lonDeg, 65.22, -25.23) < 15, 'greatest point 2026');
    near(t.widthKm, 294, 10, 'width 2026');
    near(t.greatest.durS, 140, 4, 'duration 2026');
    // It ends at sunset over the Mediterranean, past Spain.
    const end = t.count - 1;
    assert.ok(col(t, end, 1) > 36 && col(t, end, 1) < 42 && col(t, end, 2) > -2 && col(t, end, 2) < 8, 'sunset end');

    const a = feb2027;
    checkShape(a, '2027-02-06');
    assert.equal(a.kind, 'annular');
    // NASA: 31°18′S 48°29′W, width 282 km, 7 m 51 s.
    assert.ok(distanceKm(a.greatest.latDeg, a.greatest.lonDeg, -31.30, -48.48) < 15, 'greatest point 2027-02');
    near(a.widthKm, 282, 10, 'width 2027-02');
    near(a.greatest.durS, 471, 10, 'duration 2027-02');
    for (let i = 0; i < a.count; i++) assert.ok(col(a, i, PATH_COL.RADIUS_KM) < 0, 'antumbra all along');
});

test('a hybrid eclipse (2023-04-20) changes from annular to total and back along the path', () => {
    const h = apr2023;
    checkShape(h, '2023-04-20');
    assert.equal(h.kind, 'hybrid');
    const r0 = col(h, 0, PATH_COL.RADIUS_KM), rMid = pathAt(h, h.peakMs).radiusKm, r1 = col(h, h.count - 1, PATH_COL.RADIUS_KM);
    assert.ok(r0 < 0 && rMid > 0 && r1 < 0, `annular ${r0.toFixed(1)}, total ${rMid.toFixed(1)}, annular ${r1.toFixed(1)}`);
    // NASA: 9°36′S 125°48′E, width 49 km, 1 m 16 s.
    assert.ok(distanceKm(h.greatest.latDeg, h.greatest.lonDeg, -9.6, 125.8) < 15, 'greatest point 2023');
    near(h.widthKm, 49, 6, 'width 2023');
});

test('longitudes are date-line safe: wrapped samples, and pathAt interpolates across ±180°', () => {
    // 2028-07-22 ends south-east of New Zealand, across the date line.
    const p = jul2028;
    checkShape(p, '2028-07-22');
    let cross = -1;
    for (let i = 1; i < p.count; i++) if (Math.abs(col(p, i, 2) - col(p, i - 1, 2)) > 180) cross = i;
    assert.ok(cross > 0, 'the centre line crosses the date line');
    const tMid = (col(p, cross - 1, 0) + col(p, cross, 0)) / 2;
    const at = pathAt(p, tMid);
    assert.ok(Math.abs(at.lonDeg) > 170, `interpolated across the date line, not through 0°: ${at.lonDeg}`);
    const dA = distanceKm(at.latDeg, at.lonDeg, col(p, cross - 1, 1), col(p, cross - 1, 2));
    const dB = distanceKm(at.latDeg, at.lonDeg, col(p, cross, 1), col(p, cross, 2));
    assert.ok(dA < 130 && dB < 130, 'between its neighbours');
    // Outside the path's time span there is no shadow on the Earth.
    assert.equal(pathAt(p, p.startMs - 1000), null);
    assert.equal(pathAt(p, p.endMs + 1000), null);
    // Sydney (in the path) is near the centre line.
    assert.ok(nearestCentrePoint(p, -33.87, 151.21).km < 30, 'Sydney');
});

test('no path for a partial eclipse, no eclipse near the time, or a bad time', () => {
    assert.equal(eclipsePath(Date.parse('2025-09-21T19:42:00Z')), null, 'partial everywhere');
    assert.equal(eclipsePath(Date.parse('2027-05-01T00:00:00Z')), null, 'no eclipse within a day');
    assert.throws(() => eclipsePath(NaN), TypeError);
    // A local maximum works as well as the global peak.
    const local = eclipsePath(Date.parse('2027-08-02T10:05:02Z'));
    assert.equal(local.peakMs, aug2027.peakMs);
    assert.equal(nearestCentrePoint(null, 0, 0), null);
});

test('citiesInPath: the largest cities in the band, with AE durations, bounded and sorted by size', () => {
    const list = [
        { name: 'Cairo', lat: 30.06, lon: 31.25, pop: 9.6e6 },       // outside: partial only
        { name: 'Luxor', lat: 25.70, lon: 32.60, pop: 5e5 },
        { name: 'Aswan', lat: 24.09, lon: 32.90, pop: 3e5 },         // just south of the band: 99.8% partial
        { name: 'Qena', lat: 26.16, lon: 32.72, pop: 2e5 },
        { name: 'Jeddah', lat: 21.49, lon: 39.19, pop: 4.7e6 },
        { name: 'Paris', lat: 48.85, lon: 2.35, pop: 2.1e6 },        // far away
        { name: 'bad', lat: NaN, lon: 0, pop: 1e9 },
    ];
    const got = citiesInPath(aug2027, list, 12);
    assert.deepEqual(got.map((c) => list[c.index].name), ['Jeddah', 'Luxor', 'Qena']);
    const luxor = got.find((c) => list[c.index].name === 'Luxor');
    near(luxor.durS, 384.7, 0.5, 'Luxor totality (as the event card)');
    near(luxor.c2Ms, Date.parse('2027-08-02T10:01:49.6Z'), 1000, 'Luxor C2');
    assert.equal(luxor.kind, 'total');
    assert.ok(luxor.km < 40 && luxor.sunAltDeg > 80);
    assert.equal(citiesInPath(aug2027, list, 1).length, 1);
    assert.deepEqual(citiesInPath(aug2027, list, 0), []);
    assert.deepEqual(citiesInPath(null, list, 5), []);
    // The real offline list: Spanish cities in the 2026 band, but not Madrid (99% partial).
    const j = JSON.parse(fs.readFileSync(new URL('../data/cities.json', import.meta.url), 'utf8'));
    const iLat = j.fields.indexOf('lat'), iLon = j.fields.indexOf('lon'), iPop = j.fields.indexOf('pop'), iName = j.fields.indexOf('name');
    const cities = j.rows.map((r) => ({ name: r[iName], lat: r[iLat], lon: r[iLon], pop: r[iPop] }));
    const t0 = performance.now();
    const spain = citiesInPath(aug2026, cities, 12).map((c) => ({ ...c, name: cities[c.index].name }));
    assert.ok(performance.now() - t0 < 1000, 'bounded cost');
    assert.ok(spain.some((c) => c.name === 'Zaragoza' || c.name === 'Valencia'), spain.map((c) => c.name).join(', '));
    assert.ok(!spain.some((c) => c.name === 'Madrid'), 'Madrid sees a partial eclipse');
    for (const c of spain) assert.ok(c.durS > 0 && c.durS < 150);
});

test('worker op eclipsePath: packed cities in, samples transferred, and the client maps records back', async () => {
    const list = [{ name: 'Luxor', lat: 25.7, lon: 32.6, pop: 5e5 }, { name: 'Cairo', lat: 30.06, lon: 31.25, pop: 9.6e6 }];
    const packed = new Float64Array([25.7, 32.6, 5e5, 30.06, 31.25, 9.6e6]);
    const r = W.runOp('eclipsePath', { peakMs: Date.parse('2027-08-02T10:07:00Z'), cities: packed, nCities: 5 });
    assert.equal(r.kind, 'total');
    assert.deepEqual(r.cities.map((c) => c.index), [0]);
    assert.ok(W.transferablesOf(r).includes(r.samples.buffer), 'samples are transferred');
    assert.equal(W.runOp('eclipsePath', { peakMs: Date.parse('2025-09-21T19:42:00Z') }), null);
    const client = createAstroClient({ forceFallback: true });
    try {
        const res = await client.eclipsePath(Date.parse('2027-08-02T10:07:00Z'), { cities: list, n: 3 });
        assert.equal(res.cities.length, 1);
        assert.equal(res.cities[0].city, list[0], 'the caller’s own record');
        assert.equal(res.count, aug2027.count);
    } finally {
        client.dispose();
    }
});

test('shadowPoint moved to js/astro (actions.js re-exports it)', () => {
    assert.equal(actionsShadowPoint, shadowPoint);
});

// ---- render support: shadowAxisPoint, pathFrameLocal, ribbonMesh -------------------------------------

/** Geometry-local unit vector → lat/lon (frames.localToLatLon). */
const toLatLon = (v) => ({ latDeg: Math.atan2(v[1], Math.hypot(v[0], v[2])) * 180 / Math.PI, lonDeg: Math.atan2(-v[2], v[0]) * 180 / Math.PI });

test('shadowAxisPoint: the axis ground point in the scene frame, and whether the axis hits', () => {
    const s = createSnapshot();
    computeSnapshot(Date.parse('2027-08-02T10:07:00Z'), { latDeg: 25.7, lonDeg: 32.6, elevM: 0 }, s, { detail: 'frame' });
    const out = new Float64Array(3);
    const miss = shadowAxisPoint(s.moonPosS, s.sunDirS, out);
    assert.ok(miss < 1, `the axis hits the Earth (closest ${miss.toFixed(3)} R)`);
    near(Math.hypot(out[0], out[1], out[2]), 1, 1e-12, 'unit vector');
    // Same point as shadowPoint, through the Earth matrix (geometry-local = Eᵀ·P).
    const e = s.earthMatrix;
    const l = [e[0] * out[0] + e[1] * out[1] + e[2] * out[2], e[4] * out[0] + e[5] * out[1] + e[6] * out[2], e[8] * out[0] + e[9] * out[1] + e[10] * out[2]];
    const a = toLatLon(l), b = shadowPoint(s);
    assert.ok(distanceKm(a.latDeg, a.lonDeg, b.latDeg, b.lonDeg) < 0.01, 'agrees with shadowPoint');
    // And with the path: within the band of its own instant.
    const p = pathAt(aug2027, s.tMs);
    assert.ok(distanceKm(a.latDeg, a.lonDeg, p.latDeg, p.lonDeg) < 40, 'on the path (sphere vs ellipsoid)');
    // A day later the axis misses.
    computeSnapshot(Date.parse('2027-08-03T10:07:00Z'), { latDeg: 25.7, lonDeg: 32.6, elevM: 0 }, s, { detail: 'frame' });
    assert.ok(shadowAxisPoint(s.moonPosS, s.sunDirS, out) > 1, 'misses a day later');
});

test('umbraNear: 1 with the umbra on the observer, easing to 0 by UMBRA_NEAR_RAD.far, 0 without an eclipse', () => {
    const at = (iso, latDeg, lonDeg, ...r) => {
        const s = createSnapshot();
        computeSnapshot(Date.parse(iso), { latDeg, lonDeg, elevM: 0 }, s, { detail: 'frame' });
        return umbraNear(s, ...r);
    };
    near(at('2027-08-02T10:07:00Z', 25.7, 32.6), 1, 1e-12, 'Luxor in totality');
    assert.equal(at('2027-08-02T10:07:00Z', 48.85, 2.35), 0, 'Paris: the umbra is ~3 000 km away');
    assert.equal(at('2027-08-03T10:07:00Z', 25.7, 32.6), 0, 'no eclipse a day later');
    // Aswan is ~180 km from Luxor: still fully cleared; the tighter reach of the beams' roots less so.
    near(at('2027-08-02T10:07:00Z', 24.09, 32.9), 1, 1e-12, 'Aswan');
    const k = at('2027-08-02T10:07:00Z', 24.09, 32.9, 0.02, 0.05);
    assert.ok(k > 0 && k < 1, `partial weight ${k}`);
    // Half-way between near and far: about one half.
    const mid = (UMBRA_NEAR_RAD.near + UMBRA_NEAR_RAD.far) / 2;
    const p = pathAt(aug2027, Date.parse('2027-08-02T10:07:00Z'));
    const lat = p.latDeg + mid * 180 / Math.PI;
    near(at('2027-08-02T10:07:00Z', lat, p.lonDeg), 0.5, 0.1, 'half-way');
});

test('pathFrameLocal: the centre line in the globe frame, its direction of motion, NaN outside', () => {
    const p = aug2027;
    const pos = new Float64Array(3), fwd = new Float64Array(3);
    for (const t of [p.startMs, p.startMs + 600e3, p.peakMs, p.endMs - 600e3, p.endMs]) {
        const r = pathFrameLocal(p, t, pos, fwd);
        const at = pathAt(p, t);
        near(r, at.radiusKm, 1e-9, 'radius');
        const ll = toLatLon(pos);
        assert.ok(distanceKm(ll.latDeg, ll.lonDeg, at.latDeg, at.lonDeg) < 0.01, `same point as pathAt at ${new Date(t).toISOString()}`);
        near(Math.hypot(...fwd), 1, 1e-9, 'unit heading');
        near(pos[0] * fwd[0] + pos[1] * fwd[1] + pos[2] * fwd[2], 0, 1e-9, 'heading square to the point');
        // The heading points to where the shadow goes next.
        if (t < p.endMs) {
            const next = new Float64Array(3);
            pathFrameLocal(p, Math.min(p.endMs, t + 120e3), next);
            const d = [next[0] - pos[0], next[1] - pos[1], next[2] - pos[2]];
            assert.ok(d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2] > 0, 'heading along the motion');
        }
    }
    // West → east across Africa at greatest eclipse: east component positive.
    pathFrameLocal(p, p.peakMs, pos, fwd);
    const ll = toLatLon(pos), lon = ll.lonDeg * Math.PI / 180;
    const east = [-Math.sin(lon), 0, -Math.cos(lon)];
    assert.ok(fwd[0] * east[0] + fwd[2] * east[2] > 0.5, 'moves east');
    pos.fill(7);
    assert.ok(Number.isNaN(pathFrameLocal(p, p.startMs - 1, pos, fwd)), 'NaN before the start');
    assert.ok(Number.isNaN(pathFrameLocal(p, p.endMs + 1, pos)), 'NaN after the end');
    assert.deepEqual([...pos], [7, 7, 7], 'out untouched');
    assert.ok(Number.isNaN(pathFrameLocal(null, p.peakMs, pos)), 'no path');
    // Annular: the sign of the antumbra.
    assert.ok(pathFrameLocal(feb2027, feb2027.peakMs, pos) < 0, 'annular: negative radius');
});

test('ribbonMesh: rows × cols vertices on the sphere, limits at the band edges, monotonic time', () => {
    const p = aug2027;
    const m = ribbonMesh(p, { radius: 1.007, cols: 9 });
    assert.equal(m.cols, 9);
    assert.equal(m.rows, p.count);
    assert.equal(m.vertexCount, p.count * 9);
    assert.equal(m.position.length, m.vertexCount * 3);
    assert.equal(m.attr.length, m.vertexCount * 4);
    assert.equal(m.index.length, (p.count - 1) * 8 * 6);
    assert.ok(m.index instanceof Uint16Array, 'small enough for 16-bit indices');
    near(m.durationS, (p.endMs - p.startMs) / 1000, 1e-6, 'duration');
    let maxIdx = 0;
    for (const i of m.index) maxIdx = Math.max(maxIdx, i);
    assert.ok(maxIdx < m.vertexCount);
    for (let i = 0; i < m.rows; i++) {
        for (let j = 0; j < 9; j++) {
            const k = i * 9 + j;
            const x = m.position[k * 3], y = m.position[k * 3 + 1], z = m.position[k * 3 + 2];
            assert.ok(Number.isFinite(x + y + z));
            near(Math.hypot(x, y, z), 1.007, 1e-5, 'radius');
            near(m.attr[k * 4], (j - 4) / 4, 1e-6, 'v across the band');
            if (i > 0) assert.ok(m.attr[k * 4 + 1] > m.attr[(k - 9) * 4 + 1], 'time increases along the rows');
            assert.ok(m.attr[k * 4 + 3] >= 1, 'total: positive w');
        }
        // Columns 0, 4, 8 are the southern limit, the centre line and the northern limit.
        for (const [j, la, lo] of [[0, 5, 6], [4, 1, 2], [8, 3, 4]]) {
            const k = i * 9 + j;
            const ll = toLatLon([m.position[k * 3], m.position[k * 3 + 1], m.position[k * 3 + 2]]);
            assert.ok(distanceKm(ll.latDeg, ll.lonDeg, col(p, i, la), col(p, i, lo)) < 0.05, `row ${i} column ${j}`);
        }
    }
    near(m.attr[1], 0, 1e-9, 't starts at 0');
    // The along-track distance: about 15 000 km for 2027-08-02 (Atlantic to the Indian Ocean).
    const along = m.attr[(m.vertexCount - 1) * 4 + 2];
    assert.ok(along > 10000 && along < 20000, `along-track ${along.toFixed(0)} km`);
    // At greatest eclipse the band is ~258 km across: the limit columns' separation.
    let gi = 0;
    while (gi + 1 < p.count && col(p, gi + 1, 0) <= p.peakMs) gi++;
    const a = toLatLon(m.position.slice(gi * 27, gi * 27 + 3)), b = toLatLon(m.position.slice(gi * 27 + 24, gi * 27 + 27));
    near(distanceKm(a.latDeg, a.lonDeg, b.latDeg, b.lonDeg), 260, 25, 'band width near greatest eclipse');
    // Annular: negative w all along; the default columns; nothing for no path.
    const f = ribbonMesh(feb2027);
    assert.equal(f.cols, 9);
    for (let k = 0; k < f.vertexCount; k++) assert.ok(f.attr[k * 4 + 3] <= -1, 'annular: negative w');
    assert.equal(ribbonMesh(null), null);
    assert.equal(ribbonMesh(p, { cols: 4 }).cols, 5, 'cols rounded up to odd');
});
