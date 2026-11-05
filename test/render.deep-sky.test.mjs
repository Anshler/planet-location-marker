// Deep-sky sprites (render/dso.js), the precession layer (render/precession.js), star picking and
// proper motion in the star field (render/sky.js), the tap direction (camera/picking.js
// skyTapDir), and the label feed's deep-sky and guide-mark anchors — in Node with the real three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { decodeSky, yearsFromJ2000 } from '../js/data/catalog.js';
import { decodeDso, createDsoProvider } from '../js/astro/dso.js';
import { createExtras } from '../js/astro/extras.js';
import { liftByRefraction } from '../js/astro/photometry.js';
import { angleDeg, poleOfDate } from '../js/astro/precession.js';
import { buildAnchors } from '../js/app/labels-feed.js';
import { telescopeFov } from '../js/app/actions.js';
import { parseHash, layersToCode } from '../js/core/url-state.js';
import { DEFAULT_STATE } from '../js/core/store.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createDsoLayer } = await import('../js/render/dso.js');
const { createPrecession } = await import('../js/render/precession.js');
const { createSky } = await import('../js/render/sky.js');
const { skyTapDir } = await import('../js/camera/picking.js');

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const DARK = { latDeg: 37, lonDeg: -118.2, elevM: 0 };
const snapAt = (iso, obs = DARK, detail = 'frame') => {
    const s = createSnapshot();
    computeSnapshot(Date.parse(iso), obs, s, { detail });
    return s;
};
const rc = { invalidate() {}, tier: { name: 'high', starMagLimit: 6.5 }, size: { w: 1440, h: 900 } };

test('dso layer: one instance per object, picks a visible object inside its outline, never an invisible one', () => {
    const p = createDsoProvider(decodeDso(read('data/dso.json')));
    const layer = createDsoLayer(rc, { provider: p });
    const mesh = layer.object3d.children[0];
    assert.equal(mesh.geometry.instanceCount, 140);
    layer.setLayers({ deepSky: true, stars: true });
    layer.setQuality({ name: 'high', starMagLimit: 6.5 });
    layer.apply(snapAt('2026-10-15T05:30:00Z'));
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
    layer.update({ skyBlend: 1, exposure: { stars: 1 }, camera: cam });
    assert.equal(mesh.material.visible, true);
    assert.equal(mesh.visible, true, 'it hides through its material: never out of the scene graph');
    const m31 = p.byId.get('dso:m31');
    const radPerPx = (60 * Math.PI / 180) / 900;
    assert.equal(layer.pick(m31.dirS, radPerPx), 'dso:m31', 'the centre');
    // 1.2° from the centre is still inside M31's 3.2° outline (the pick reach is 0.8 × the semi-major axis).
    const d0 = new THREE.Vector3(...m31.dirS);
    const off = d0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0).cross(d0).normalize(), 1.2 * Math.PI / 180);
    assert.equal(layer.pick([off.x, off.y, off.z], radPerPx), 'dso:m31');
    // M57 (V 8.8) is invisible at 60°: not pickable; at a 1° field the aperture gain shows it.
    const m57 = p.byId.get('dso:m57');
    assert.equal(layer.pick(m57.dirS, radPerPx), null);
    cam.fov = 1;
    layer.update({ skyBlend: 1, exposure: { stars: 1 }, camera: cam });
    assert.equal(layer.pick(m57.dirS, (1 * Math.PI / 180) / 900), 'dso:m57');
    // Daylight: nothing.
    layer.update({ skyBlend: 1, exposure: { stars: 0 }, camera: cam });
    assert.equal(mesh.material.visible, false);
    assert.equal(mesh.visible, true);
    layer.setLayers({ deepSky: false });
    layer.update({ skyBlend: 1, exposure: { stars: 1 }, camera: cam });
    assert.equal(mesh.material.visible, false, 'the layer toggle');
    layer.dispose();
});

test('precession layer: static circle and track, live pole and equinox marks, labels only with the layer on', () => {
    const prec = createPrecession(rc);
    const s = snapAt('1066-04-24T21:00:00Z', { latDeg: 48.85, lonDeg: 2.35, elevM: 0 });
    prec.apply(s);
    assert.deepEqual(prec.anchors(), [], 'off by default');
    prec.setLayers({ precession: true });
    const list = prec.anchors();
    const ids = list.map((a) => a.id);
    for (const id of ['prec:1000', 'prec:1500', 'prec:2000', 'prec:2500', 'prec:3000', 'prec:Thuban', 'prec:Vega', 'prec:pole', 'prec:march']) {
        assert.ok(ids.includes(id), id);
    }
    assert.ok(!ids.includes('prec:Polaris'), 'Polaris (2102) sits on the accurate track');
    const pole = list.find((a) => a.id === 'prec:pole').dirS;
    assert.ok(angleDeg(pole, poleOfDate(s.tMs)) < 1e-6, 'the live pole is the pole of date');
    const lines = prec.object3d.children[0];
    assert.ok(lines.geometry.instanceCount > 400);
    // The live marks follow the date (re-applied once per day).
    prec.apply(snapAt('2999-06-01T21:00:00Z', { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }));
    assert.ok(angleDeg(pole, poleOfDate(Date.UTC(2999, 5, 1, 21))) < 1e-6);
    prec.dispose();
});

test('star field: proper motion moves the drawn fast stars with the snapshot epoch; pickStar finds a visible star', () => {
    const cat = decodeSky(read('data/sky.json'));
    const sky = createSky(rc, { catalog: cat });
    sky.setLayers({ stars: true });
    const i = cat.stars.hip.indexOf(69673);
    const j2000 = [cat.stars.dirS[3 * i], cat.stars.dirS[3 * i + 1], cat.stars.dirS[3 * i + 2]];
    const s = snapAt('1066-04-24T21:00:00Z');
    sky.apply(s);
    assert.equal(cat.stars.pm.years, Math.round(yearsFromJ2000(s.tMs)));
    const pts = sky.object3d.children.find((c) => c.name === 'sky.stars');
    const pos = pts.geometry.attributes.position.array;
    let k = -1;
    for (let n = 0; n < pos.length / 3; n++) {
        if (Math.abs(pos[3 * n] - cat.stars.dirS[3 * i]) < 1e-7 && Math.abs(pos[3 * n + 1] - cat.stars.dirS[3 * i + 1]) < 1e-7) { k = n; break; }
    }
    assert.ok(k >= 0, 'the drawn Arcturus is the moved one');
    assert.ok(angleDeg([pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]], j2000) > 0.5);
    // pickStar: a tap 5 px from Betelgeuse picks it; one 40 px away picks nothing there.
    sky.update({ skyBlend: 1, exposure: { stars: 1, milkyWay: 1 }, camera: { fov: 60, position: new THREE.Vector3() } });
    const b = cat.stars.hip.indexOf(27989);
    const bd = new THREE.Vector3(cat.stars.dirS[3 * b], cat.stars.dirS[3 * b + 1], cat.stars.dirS[3 * b + 2]);
    const radPerPx = (60 * Math.PI / 180) / 900;
    const axis = new THREE.Vector3(0, 1, 0).cross(bd).normalize();
    const near = bd.clone().applyAxisAngle(axis, 5 * radPerPx);
    assert.equal(sky.pickStar([near.x, near.y, near.z], radPerPx, 14)?.hip, 27989);
    const far = bd.clone().applyAxisAngle(axis, 40 * radPerPx);
    assert.notEqual(sky.pickStar([far.x, far.y, far.z], radPerPx, 14)?.hip, 27989);
    // By day nothing is pickable.
    sky.update({ skyBlend: 1, exposure: { stars: 0, milkyWay: 0 }, camera: { fov: 60, position: new THREE.Vector3() } });
    assert.equal(sky.pickStar([near.x, near.y, near.z], radPerPx, 14), null);
    sky.dispose();
});

test('skyTapDir: the camera ray, with the drawn refraction taken back off', () => {
    const cam = new THREE.PerspectiveCamera(50, 1.5, 0.01, 100);
    cam.position.set(0, 1.0001, 0);
    cam.lookAt(new THREE.Vector3(1, 1.05, 0));
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const up = [0, 1, 0];
    const raw = new Float64Array(3), tap = new Float64Array(3), lifted = new Float64Array(3);
    assert.equal(skyTapDir({ x: 0.1, y: -0.2 }, cam, null, 0, raw), true);
    assert.equal(skyTapDir({ x: 0.1, y: -0.2 }, cam, up, 1, tap), true);
    liftByRefraction(tap, up, 1, lifted);
    assert.ok(angleDeg(lifted, raw) < 1e-4, 'lifting the tap direction gives the ray back');
    assert.ok(angleDeg(tap, raw) > 0.05, 'near the horizon refraction matters');
    assert.equal(skyTapDir(null, cam, up, 1, tap), false);
});

test('labels: deep-sky names only in sky view and gated like stars; the selected star replaces its name; guide marks', () => {
    const extras = createExtras();
    extras.register(createDsoProvider(decodeDso(read('data/dso.json'))));
    const s = snapAt('2026-10-15T05:30:00Z');
    extras.fill(s);
    const layers = { ...DEFAULT_STATE.layers };
    const st = { observer: DARK, selection: null, view: { mode: 'sky' }, layers };
    const sky = buildAnchors(st, s, null, null, { mode: 'sky', extras });
    const m31 = sky.find((a) => a.id === 'dso:m31');
    assert.ok(m31 && m31.night === true && Number.isFinite(m31.mag), 'M31 is labelled, night-gated');
    assert.ok(!sky.find((a) => a.id === 'dso:m57'), 'a telescope object only when selected');
    assert.ok(!buildAnchors(st, s, null, null, { mode: 'orbit', extras }).find((a) => a.id === 'dso:m31'), 'not around the globe');
    assert.ok(!buildAnchors({ ...st, layers: { ...layers, deepSky: false } }, s, null, null, { mode: 'sky', extras }).find((a) => a.id === 'dso:m31'));
    const sel = buildAnchors({ ...st, selection: 'dso:m57' }, s, null, null, { mode: 'orbit', extras }).find((a) => a.id === 'dso:m57');
    assert.ok(sel && sel.priority === 100 && !sel.night, 'a selected object is labelled anywhere, ungated');
    const catalog = { starNames: [{ hip: 27989, name: 'Betelgeuse', mag: 0.45, dirS: [1, 0, 0] }], cons: { list: [] } };
    assert.ok(buildAnchors(st, s, catalog, null, { mode: 'sky' }).find((a) => a.id === 'star:27989'));
    assert.ok(!buildAnchors({ ...st, selection: 'star:27989' }, s, catalog, null, { mode: 'sky' }).find((a) => a.kind === 'star' && a.id === 'star:27989'),
        'the star name gives way to the selection label');
    const marks = { anchors: () => [{ id: 'prec:pole', text: 'Pole of date', kind: 'trail', dirS: [0, 1, 0] }] };
    assert.ok(buildAnchors(st, s, null, null, { mode: 'sky', skyMarks: [marks] }).find((a) => a.id === 'prec:pole'));
});

test('telescope field for extras: a deep-sky object\'s whole outline, a star\'s neighbourhood', () => {
    const extras = createExtras();
    extras.register(createDsoProvider(decodeDso(read('data/dso.json'))));
    const s = snapAt('2026-10-15T05:30:00Z');
    extras.fill(s);
    assert.ok(Math.abs(telescopeFov('dso:m31', s, 1.6) - 2.2 * 190 / 60) < 1e-9);
    assert.ok(Math.abs(telescopeFov('dso:m31', s, 0.5) - 2.2 * 190 / 60 / 0.5) < 1e-9, 'portrait fits the width');
    assert.equal(telescopeFov('dso:m57', s, 1.6), 0.5);
    assert.ok(Math.abs(telescopeFov('dso:lmc', s, 1.6) - 23.65) < 1e-9, 'the LMC: a wide field');
    assert.equal(telescopeFov('dso:nope', s, 1.6), null);
});

test('URL: the deep-sky (x) and precession (r) layers round-trip', () => {
    const on = { ...DEFAULT_STATE.layers, precession: true };
    const code = layersToCode(on);
    assert.equal(code, 'bgoscCnmkazhldxrwi');
    assert.deepEqual(parseHash(`#ly=${code}`).layers, on);
    assert.equal(parseHash('#ly=bgoscCnmkazhld').layers.deepSky, false);
    assert.equal(parseHash('#sel=dso:M31').selection, 'dso:m31');
    assert.equal(parseHash('#sel=star:27989').selection, 'star:27989');
});
