// The flat world map's projection (js/geo/mapview.js, ROADMAP globe-to-map-morph): the plane's frame,
// the forward projection the Earth's vertex shader shares, and the analytic inverse picking uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createMapFrame, orientMapFrame, mapXY, mapPoint, mapPointXY, mapPointOfDir, mapXYToLatLon, mapRayHit,
    mapFitDistance, clampMapCenter, MAP_LIFT, MAP_HALF_W, MAP_HALF_H, MAP_SCALE,
} from '../js/geo/mapview.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { latLonToLocal } from '../js/astro/frames.js';

const D = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

function frameFor(pole, view, fallback = [1, 0, 0]) {
    return orientMapFrame(createMapFrame(), pole, view, fallback);
}

test('the plane is north up, square to the view, east to the right, and clear of the globe', () => {
    const pole = [0.03, 0.999, -0.02];
    const f = frameFor(pole, [2.1, 1.4, -2.5]);
    const pl = Math.hypot(...pole);
    for (const v of [f.right, f.up, f.normal]) near(Math.hypot(...v), 1, 1e-12, 'unit');
    near(dot(f.up, pole) / pl, 1, 1e-12, 'up is the pole');
    near(dot(f.normal, f.up), 0, 1e-12, 'normal square to the pole');
    near(dot(f.normal, [2.1, 1.4, -2.5]) > 0 ? 1 : 0, 1, 0, 'normal toward the camera');
    const ux = cross(f.up, f.normal);
    for (let k = 0; k < 3; k++) near(f.right[k], ux[k], 1e-12, 'right = up × normal');
    // Seen from the camera (looking along −normal, up = up), right is screen-right: right × up = normal.
    const ru = cross(f.right, f.up);
    for (let k = 0; k < 3; k++) near(ru[k], f.normal[k], 1e-12, 'right-handed');
    for (let k = 0; k < 3; k++) near(f.center[k], f.normal[k] * MAP_LIFT, 1e-12, 'centre');
    assert.ok(MAP_LIFT > 1, 'every map point lies outside the unit sphere');
});

test('a view along the pole falls back, and a degenerate fallback still gives a valid frame', () => {
    const a = frameFor([0, 1, 0], [0, 5, 0], [1, 0, 0]);
    assert.deepEqual([...a.normal].map((x) => Math.round(x * 1e9) / 1e9), [1, 0, 0]);
    const b = frameFor([0, 1, 0], [0, 5, 0], [0, -2, 0]);
    near(Math.hypot(...b.normal), 1, 1e-12, 'unit normal');
    near(dot(b.normal, b.up), 0, 1e-12, 'square to the pole');
});

test('places land where the sphere uv puts them: longitude east, latitude north, 2π × π units', () => {
    const f = frameFor([0, 1, 0], [0, 0, 1]);
    assert.deepEqual([...mapXY(0, 0, [0, 0])], [0, 0]);
    const xy = mapXY(45, -90, [0, 0]);
    near(xy[0], -Math.PI / 2 * MAP_SCALE, 1e-12, 'x');
    near(xy[1], Math.PI / 4 * MAP_SCALE, 1e-12, 'y');
    near(MAP_HALF_W, Math.PI * MAP_SCALE, 1e-12, 'width');
    near(MAP_HALF_H, Math.PI / 2 * MAP_SCALE, 1e-12, 'height');
    // The vertex shader: uMapO + uMapR·(u − ½)·2π + uMapU·(v − ½)·π, with u = λ/360 + ½, v = φ/180 + ½.
    const lat = -33.9, lon = 151.2;
    const u = lon / 360 + 0.5, v = lat / 180 + 0.5;
    const shader = mapPointXY(f, (u - 0.5) * 2 * Math.PI * MAP_SCALE, (v - 0.5) * Math.PI * MAP_SCALE, [0, 0, 0]);
    const p = mapPoint(f, lat, lon, [0, 0, 0]);
    for (let k = 0; k < 3; k++) near(p[k], shader[k], 1e-12, 'shader projection');
    // A longitude past 180 wraps.
    const w = mapPoint(f, 10, 200, [0, 0, 0]), w2 = mapPoint(f, 10, -160, [0, 0, 0]);
    for (let k = 0; k < 3; k++) near(w[k], w2[k], 1e-9, 'wrap');
});

test('a sub-point maps through the Earth matrix to its own lat/lon', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.parse('2026-11-04T20:00:00Z'), { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, snap, { detail: 'frame' });
    const f = frameFor([snap.earthMatrix[4], snap.earthMatrix[5], snap.earthMatrix[6]], [0.3, 0.2, 1]);
    // The observer's zenith: a world direction whose sphere lat/lon is the observer's.
    const p = mapPointOfDir(f, snap.earthMatrix, snap.observer.upS, new Float64Array(3));
    const q = mapPoint(f, 48.85, 2.35, new Float64Array(3));
    for (let k = 0; k < 3; k++) near(p[k], q[k], 1e-9, 'observer');
    // The Sun's sub-point: its subLat/subLon (geocentric on the sphere) within a hair.
    const sun = snap.bodies[0];
    const s = mapPointOfDir(f, snap.earthMatrix, sun.geoDirS, new Float64Array(3));
    const hit = mapRayHit(f, [s[0] + f.normal[0], s[1] + f.normal[1], s[2] + f.normal[2]], [-f.normal[0], -f.normal[1], -f.normal[2]]);
    near(hit.lonDeg, sun.subLonDeg, 0.05, 'subsolar longitude');
    near(hit.latDeg, sun.subLatDeg, 0.25, 'subsolar latitude (geocentric vs geodetic)');
    // localToLatLon of a local direction round-trips through world.
    const local = latLonToLocal(-20, 100);
    const m = snap.earthMatrix;
    const world = [m[0] * local[0] + m[4] * local[1] + m[8] * local[2], m[1] * local[0] + m[5] * local[1] + m[9] * local[2],
        m[2] * local[0] + m[6] * local[1] + m[10] * local[2]];
    const r = mapPointOfDir(f, m, world, [0, 0, 0]), r2 = mapPoint(f, -20, 100, [0, 0, 0]);
    for (let k = 0; k < 3; k++) near(r[k], r2[k], 1e-9, 'round trip');
});

test('picking: a ray through any place returns it; rays that miss the map or look away return null', () => {
    const f = frameFor([0.1, 0.99, 0], [-1, 0.4, 2]);
    const cam = mapPointXY(f, 0.3, -0.2, [0, 0, 0], 4.5);
    for (const [lat, lon] of [[0, 0], [51.5, -0.1], [-33.9, 151.2], [70, -150], [-80, 179.5]]) {
        const p = mapPoint(f, lat, lon, [0, 0, 0]);
        const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
        const hit = mapRayHit(f, cam, d);
        assert.ok(hit, `${lat},${lon}`);
        near(hit.latDeg, lat, 1e-9, 'lat');
        near(hit.lonDeg, lon, 1e-9, 'lon');
    }
    const off = mapPointXY(f, MAP_HALF_W + 0.2, 0, [0, 0, 0]);
    assert.equal(mapRayHit(f, cam, [off[0] - cam[0], off[1] - cam[1], off[2] - cam[2]]), null, 'beyond the map');
    assert.equal(mapRayHit(f, cam, f.normal), null, 'looking away');
    assert.equal(mapRayHit(f, cam, f.right), null, 'parallel');
    assert.equal(mapXYToLatLon(0, MAP_HALF_H + 1e-6), null);
    assert.deepEqual(mapXYToLatLon(MAP_HALF_W, 0), { latDeg: 0, lonDeg: -180 });
});

test('the whole-map fit holds both the width and the height of the map in the free area', () => {
    const fov = 45, H = 900;
    for (const [w, h] of [[1440, 900], [1040, 770], [390, 500], [2000, 400]]) {
        const d = mapFitDistance(fov, H, w, h);
        const upp = 2 * d * Math.tan(fov * D / 2) / H;    // plane units per CSS pixel
        assert.ok(2 * MAP_HALF_W <= w * upp + 1e-9, `${w}×${h}: width fits`);
        assert.ok(2 * MAP_HALF_H <= h * upp + 1e-9, `${w}×${h}: height fits`);
        assert.ok(2 * MAP_HALF_W >= w * upp / 1.2 || 2 * MAP_HALF_H >= h * upp / 1.2, `${w}×${h}: and not much more`);
    }
    const c = clampMapCenter({ x: 9, y: -9 });
    assert.deepEqual(c, { x: MAP_HALF_W, y: -MAP_HALF_H });
});
