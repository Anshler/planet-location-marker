// The flat world map and the second place in the app layer (ROADMAP globe-to-map-morph, two-observers):
// the rig's 'map' mode (morph, plane-facing camera, pan/zoom, picking, the way back), the label feed's
// map anchors and second pin, and the loop's label mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODY_INDEX } from '../js/astro/bodies.js';
import { mapPoint, mapPointOfDir, MAP_LIFT } from '../js/geo/mapview.js';
import { buildAnchors, parallaxText } from '../js/app/labels-feed.js';
import { labelMode, MAP_HIDE_K } from '../js/app/loop.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createRig } = await import('../js/camera/rig.js');
const { pickMap, pickPoint } = await import('../js/camera/picking.js');

const PARIS = { latDeg: 48.85, lonDeg: 2.35, elevM: 0, name: 'Paris', country: 'France', tz: 'Europe/Paris', tzApprox: false, source: 'url' };
const CAPE = { latDeg: -33.92, lonDeg: 18.42, elevM: 0, name: 'Cape Town', country: 'South Africa', tz: 'Africa/Johannesburg', tzApprox: false, source: 'url' };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
/** Lets promise continuations run (the browser does between frames; a chained second leg starts there). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function snapAt(iso, observer) {
    const s = createSnapshot();
    computeSnapshot(Date.parse(iso), observer, s, { detail: 'frame' });
    return s;
}

function makeRig({ w = 1600, h = 900 } = {}) {
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 4000);
    camera.position.set(0, 0, 3.4);
    const clock = { t: 1000 };
    const rc = { camera, size: { w, h, insets: { left: 0, right: 0, top: 0, bottom: 0 } }, invalidate() {} };
    const rig = createRig(rc, { dom: null, reducedMotion: false, now: () => clock.t });
    const run = (ms, snap) => {
        for (let el = 0; el < ms; el += 16) {
            clock.t += 16;
            rig.update(16, snap);
        }
    };
    return { rig, camera, rc, run };
}

test('the globe unrolls into the map in ~1 s: mapK runs 0 → 1, the camera ends square to the plane, north up', async () => {
    const { rig, camera, run } = makeRig();
    const snap = snapAt('2026-11-04T20:00:00Z', PARIS);
    rig.update(0, snap);
    const p = rig.setMode('map', { animate: true });
    assert.equal(rig.mode, 'map');
    run(32, snap);
    const k0 = rig.mapK;
    assert.ok(k0 > 0 && k0 < 0.2, `starts: ${k0}`);
    run(500, snap);
    assert.ok(rig.mapK > 0.3 && rig.mapK < 0.8, `half-way: ${rig.mapK}`);
    run(700, snap);
    assert.equal(await p, true);
    assert.equal(rig.mapK, 1);
    const f = rig.mapFrame;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    near(fwd.dot(new THREE.Vector3(...f.normal)), -1, 1e-9, 'looks straight at the plane');
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    near(up.dot(new THREE.Vector3(...f.up)), 1, 1e-9, 'north up');
    // The whole map fits the screen: centre (0, 0), the fit distance from the plane.
    const v = rig.getView();
    assert.equal(v.mode, 'map');
    near(v.latDeg, 0, 1e-9, 'centre lat');
    near(v.lonDeg, 0, 1e-9, 'centre lon');
    const d = camera.position.clone().sub(new THREE.Vector3(...f.center)).dot(new THREE.Vector3(...f.normal));
    near(d, v.distance, 1e-9, 'distance');
    // The plane faces the camera's old direction, made square to the pole.
    near(new THREE.Vector3(...f.normal).dot(new THREE.Vector3(...f.up)), 0, 1e-12, 'normal ⟂ pole');
});

test('on the map: picking inverts the projection, zoom keeps the point under the cursor, the way back rolls it up', async () => {
    const { rig, camera, rc, run } = makeRig();
    const snap = snapAt('2026-11-04T20:00:00Z', PARIS);
    rig.update(0, snap);
    rig.setView('o:30,40,4');
    rig.update(0, snap);
    rig.setMode('map', { animate: false });
    run(32, snap);
    camera.updateMatrixWorld();
    const f = rig.mapFrame;
    // Project a place and pick it back.
    const P = new THREE.Vector3(...mapPoint(f, -33.9, 151.2, [0, 0, 0])).project(camera);
    const ll = pickMap({ x: P.x, y: P.y }, camera, f);
    near(ll.latDeg, -33.9, 1e-6, 'lat');
    near(ll.lonDeg, 151.2, 1e-6, 'lon');
    // Sub-point picking on the map (world points).
    const sun = mapPointOfDir(f, snap.earthMatrix, snap.bodies[0].geoDirS, new Float64Array(3));
    const S = new THREE.Vector3(...sun).project(camera);
    assert.equal(pickPoint({ x: S.x + 0.002, y: S.y }, camera, [{ id: 'sun', posS: sun }], rc.size, 14), 'sun');
    assert.equal(pickPoint({ x: S.x + 0.3, y: S.y }, camera, [{ id: 'sun', posS: sun }], rc.size, 14), null);
    // Zoom about a point: the place under it stays under it.
    rig.zoomAt(0.4, P.x, P.y);
    run(1500, snap);
    camera.updateMatrixWorld();
    const after = pickMap({ x: P.x, y: P.y }, camera, f);
    near(after.latDeg, -33.9, 1e-3, 'lat under the cursor');
    near(after.lonDeg, 151.2, 1e-3, 'lon under the cursor');
    // Back to the globe: over the map's centre now (it was zoomed), mapK back to 0.
    const v = rig.getView();
    const p = rig.setMode('orbit', { animate: true });
    run(1300, snap);
    assert.equal(await p, true);
    assert.equal(rig.mapK, 0);
    assert.equal(rig.mode, 'orbit');
    const g = rig.getView();
    near(g.latDeg, v.latDeg, 1e-6, 'over the map centre (lat)');
    near(g.lonDeg, v.lonDeg, 1e-6, 'over the map centre (lon)');
});

test('an untouched map goes back to the very globe pose it came from; sky view passes through the globe', async () => {
    const { rig, run } = makeRig();
    const snap = snapAt('2026-11-04T20:00:00Z', PARIS);
    rig.setView('o:-20,120,5');
    rig.update(0, snap);
    rig.setMode('map', { animate: true });
    run(1300, snap);
    rig.setMode('orbit', { animate: true });
    run(1300, snap);
    const g = rig.getView();
    near(g.latDeg, -20, 1e-6, 'lat');
    near(g.lonDeg, 120, 1e-6, 'lon');
    near(g.distance, 5, 1e-6, 'distance');
    // Sky → map → sky: both legs run, mapK is 0 in sky view.
    const toSky = rig.setMode('sky', { animate: true });
    run(2000, snap);
    assert.equal(await toSky, true);
    const toMap = rig.setMode('map', { animate: true });
    run(1900, snap);
    await flush();
    assert.equal(rig.mode, 'map');
    run(1300, snap);
    assert.equal(await toMap, true);
    assert.equal(rig.mapK, 1);
    const back = rig.setMode('sky', { animate: true });
    run(1300, snap);
    await flush();
    run(2000, snap);
    assert.equal(await back, true);
    assert.equal(rig.mode, 'sky');
    assert.equal(rig.mapK, 0);
    assert.equal(rig.skyBlend, 1);
});

test('a map link (cam m:) applies at once; the deep-linked pose is the map view', () => {
    const { rig } = makeRig();
    const snap = snapAt('2026-11-04T20:00:00Z', PARIS);
    rig.setView('m:35,139.7,0.8');
    rig.update(0, snap);
    assert.equal(rig.mode, 'map');
    assert.equal(rig.mapK, 1);
    const v = rig.getView();
    near(v.latDeg, 35, 1e-9, 'lat');
    near(v.lonDeg, 139.7, 1e-9, 'lon');
    near(v.distance, 0.8, 1e-9, 'distance');
});

test('the label feed: on the map bodies sit on their sub-points and the pins on the map; no star names', () => {
    const snap = snapAt('2026-11-21T20:00:00Z', PARIS);
    snap.second = snapAt('2026-11-21T20:00:00Z', CAPE);
    const live = {
        bodyOrbit: snap.bodies.map(() => new Float64Array(3)), pinHead: new Float64Array(3),
        cardinal: [0, 1, 2, 3].map(() => new Float64Array(3)), rim: [0, 1, 2, 3].map(() => new Float64Array(3)),
        bodyMap: snap.bodies.map(() => new Float64Array(3)), pin2Head: new Float64Array(3), parallaxAt: new Float64Array(3),
    };
    const state = {
        observer: PARIS, observer2: CAPE, selection: 'moon', view: { mode: 'map' },
        layers: { labels: true, stars: true, starNames: true, constellationNames: true, horizon: true, trails: true, beams: true, sunMoonBeams: true },
    };
    const catalog = { starNames: [{ hip: 1, name: 'Sirius', mag: -1.4, dirS: new Float64Array([0, 0, 1]) }], cons: { list: [] } };
    const map = buildAnchors(state, snap, catalog, null, { mode: 'map', live, rimCardinals: true });
    const ids = map.map((a) => a.id);
    assert.ok(ids.includes('moon') && ids.includes('observer') && ids.includes('observer2'));
    assert.ok(!ids.includes('star:1') && !ids.some((id) => id.startsWith('N') && id.length < 3), 'no star or cardinal names');
    const moon = map.find((a) => a.id === 'moon');
    assert.equal(moon.posS, live.bodyMap[BODY_INDEX.moon]);
    assert.equal(moon.below, false, 'never dimmed by the observer’s horizon on the map');
    assert.equal(map.find((a) => a.id === 'observer2').posS, live.pin2Head);
    // In orbit view the second pin is labelled, and with both beams up the parallax note joins.
    const text = parallaxText(snap, { sepDeg: 0, baselineKm: 0, perpKm: 0, distKm: NaN });
    assert.match(text, /^Moon parallax \d\.\d\d° → [\d,]+ km$/);
    const orbit = buildAnchors({ ...state, view: { mode: 'orbit' } }, snap, catalog, null, { mode: 'orbit', live, parallax: text });
    assert.ok(orbit.some((a) => a.id === 'observer2'));
    const note = orbit.find((a) => a.id === 'parallax');
    assert.equal(note.text, text);
    assert.equal(note.posS, live.parallaxAt);
    const off = buildAnchors({ ...state, view: { mode: 'orbit' }, layers: { ...state.layers, beams: false } }, snap, catalog, null, { mode: 'orbit', live, parallax: text });
    assert.ok(!off.some((a) => a.id === 'parallax'), 'no beams, no note');
    const one = buildAnchors({ ...state, observer2: null, view: { mode: 'orbit' } }, snap, catalog, null, { mode: 'orbit', live, parallax: text });
    assert.ok(!one.some((a) => a.id === 'observer2' || a.id === 'parallax'));
    assert.equal(parallaxText({ ...snap, second: null }, {}), '');
});

test('the loop labels the map as soon as the globe starts to unroll', () => {
    assert.equal(labelMode(0, 0), 'orbit');
    assert.equal(labelMode(0.6, 0), 'sky');
    assert.equal(labelMode(0, MAP_HIDE_K / 2), 'orbit');
    assert.equal(labelMode(0, 0.5), 'map');
    assert.ok(MAP_LIFT > 1);
});
