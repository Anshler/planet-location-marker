// The camera rig's modes together (Phase 5 batch 2): the system zoom (orrery), the flat map, sky
// view with 'Point at the sky' and the vantage points must hand over to each other without one
// mode's guards breaking another. The real rig on a stand-in RenderContext, as in camera.system.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { labelMode, MAP_HIDE_K } from '../js/app/loop.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createRig } = await import('../js/camera/rig.js');

const HCMC = { latDeg: 10.82, lonDeg: 106.63, elevM: 0 };
const T = Date.parse('2027-02-19T15:00:00Z');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
/**
 * Lets promise continuations run (a chained second leg starts there), and a dynamic import land
 * (setVantage loads astro/vantage.js through the test's resolve hooks).
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function snapAt(tMs, observer) {
    const s = createSnapshot();
    computeSnapshot(tMs, observer, s, { detail: 'frame' });
    return s;
}

class FakeCanvas extends EventTarget {
    constructor(w, h) {
        super();
        this.w = w;
        this.h = h;
        this.style = {};
        this.clientWidth = w;
        this.clientHeight = h;
        this.ownerDocument = { defaultView: new EventTarget(), body: null, documentElement: null };
        this.root = new EventTarget();
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.w, height: this.h }; }
    getRootNode() { return this.root; }
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return false; }
    send(type, props) {
        const e = new Event(type, { cancelable: true });
        Object.assign(e, { button: 0, pointerType: 'mouse', deltaMode: 0, ...props });
        this.dispatchEvent(e);
        return e;
    }
}

function makeRig({ w = 1600, h = 900, dom = false } = {}) {
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 4000);
    camera.position.set(0, 0, 3.4);
    const clock = { t: 1000 };
    const rc = { camera, size: { w, h, insets: { left: 0, right: 0, top: 0, bottom: 0 } }, invalidate() {} };
    const el = dom ? new FakeCanvas(w, h) : null;
    const rig = createRig(rc, { dom: el, reducedMotion: false, now: () => clock.t });
    const run = (ms, snap) => {
        for (let t = 0; t < ms; t += 16) {
            clock.t += 16;
            rig.update(16, snap);
        }
    };
    /** Runs frames with promise turns between them until `done()` or the time is up. */
    const settle = async (ms, snap, done) => {
        for (let t = 0; t < ms; t += 160) {
            run(160, snap);
            await flush();
            if (done && done()) return true;
        }
        return !done || done();
    };
    return { rig, camera, clock, el, run, settle };
}

test('the flat map from the solar system: the zoom flies back to the globe first, then the globe unrolls', async () => {
    const h = makeRig();
    const s = snapAt(T, HCMC);
    h.rig.setView('o:20,60,140000');
    h.rig.update(0, s);
    assert.equal(h.rig.system, true);
    const p = h.rig.setMode('map', { animate: true });
    h.run(400, s);
    assert.equal(h.rig.system, true, 'still zooming back');
    assert.equal(h.rig.mapK, 0, 'no morph while out in the system');
    assert.equal(h.rig.mode, 'orbit');
    await h.settle(6000, s, () => h.rig.mode === 'map' && h.rig.mapK === 1);
    assert.equal(await p, true);
    assert.equal(h.rig.system, false);
    assert.equal(h.rig.mode, 'map');
    assert.equal(h.rig.mapK, 1);
    assert.equal(h.rig.systemBlend, 0, 'no orrery on the map');
    // The wheel on the map zooms the map, never on out into the solar system.
    for (let i = 0; i < 40; i++) h.rig.zoom(1.25);
    h.run(2000, s);
    assert.equal(h.rig.system, false);
    assert.equal(h.rig.mode, 'map');
    assert.equal(h.rig.systemBlend, 0);
    // The map's way back lands within the globe's range (the camera was at most 150 R out).
    const back = h.rig.setMode('orbit', { animate: true });
    h.run(1400, s);
    assert.equal(await back, true);
    assert.ok(h.camera.position.length() <= 150 + 1e-6, `globe range: ${h.camera.position.length()}`);
});

test("'Solar system' from the map rolls the globe back up, then flies out; a map link cuts out of the system", async () => {
    const h = makeRig();
    const s = snapAt(T, HCMC);
    h.rig.update(0, s);
    h.rig.setMode('map', { animate: false });
    h.run(32, s);
    assert.equal(h.rig.mapK, 1);
    const p = h.rig.setSystem(true);
    h.run(400, s);
    assert.ok(h.rig.mapK > 0 && h.rig.mapK < 1, `rolling up: ${h.rig.mapK}`);
    assert.equal(h.rig.system, false, 'not before the globe is back');
    await h.settle(9000, s, () => h.rig.system && !h.rig.tweening);
    assert.equal(await p, true);
    assert.equal(h.rig.mode, 'orbit');
    assert.equal(h.rig.mapK, 0);
    near(h.rig.systemBlend, 1, 1e-9, 'the orrery is shown');
    // A map link while out there: the system zoom ends at once and the map is up.
    h.rig.setView('m:10,100,1.2');
    h.rig.update(16, s);
    assert.equal(h.rig.system, false);
    assert.equal(h.rig.mode, 'map');
    assert.equal(h.rig.mapK, 1);
    h.run(32, s);
    assert.equal(h.rig.systemBlend, 0);
    near(h.rig.getView().distance, 1.2, 1e-9, 'map distance');
});

test('aiming steers only sky view: from the system zoom sky view comes through the globe, then setSkyAim applies', async () => {
    const h = makeRig({ dom: true });
    const s = snapAt(T, HCMC);
    h.rig.setView('o:20,60,140000');
    h.rig.update(0, s);
    h.rig.setAiming(true);
    assert.equal(h.rig.setSkyAim(120, 30), false, 'not in the solar system');
    // A drag out there still turns the system view (aiming is a sky-view matter).
    const v0 = h.rig.getView();
    h.el.send('pointerdown', { pointerId: 1, clientX: 800, clientY: 450 });
    h.el.send('pointermove', { pointerId: 1, clientX: 900, clientY: 450 });
    h.el.send('pointerup', { pointerId: 1, clientX: 900, clientY: 450 });
    h.run(32, s);
    assert.ok(Math.abs(h.rig.getView().lonDeg - v0.lonDeg) > 1, 'the drag turned the view');
    const p = h.rig.setMode('sky', { animate: true });
    await h.settle(8000, s, () => h.rig.mode === 'sky' && h.rig.skyBlend === 1 && !h.rig.tweening);
    assert.equal(await p, true);
    assert.equal(h.rig.system, false);
    assert.equal(h.rig.systemBlend, 0);
    assert.equal(h.rig.setSkyAim(120, 30), true);
    h.run(2000, s);
    const v = h.rig.getView();
    near(v.azDeg, 120, 1e-3, 'aimed az');
    near(v.altDeg, 30, 1e-3, 'aimed alt');
    // While aiming, the wheel zooms the field, never the system.
    h.el.send('wheel', { deltaY: 300, clientX: 700, clientY: 400 });
    h.run(500, s);
    assert.equal(h.rig.system, false);
    assert.ok(h.rig.getView().fovDeg > v.fovDeg, 'the field widened');
});

test('a vantage from the system zooms back first; the system zoom is never shown from a vantage', async () => {
    const h = makeRig();
    const s = snapAt(T, HCMC);
    h.rig.setView('o:20,60,140000');
    h.rig.update(0, s);
    const p = h.rig.setVantage('l1', { animate: true });
    h.run(400, s);
    assert.equal(h.rig.system, true, 'zooming back');
    await h.settle(12000, s, () => h.rig.vantage === 'l1' && !h.rig.tweening);
    assert.equal(await p, true);
    assert.equal(h.rig.system, false);
    h.run(32, s);
    assert.equal(h.rig.systemBlend, 0, 'L1 is 235 R out, but a vantage shows no orrery');
});

test('labelMode covers the four views: the map first, then sky, then the orrery', () => {
    assert.equal(labelMode(0, 0, 0), 'orbit');
    assert.equal(labelMode(0, 0, 0.4), 'orbit');
    assert.equal(labelMode(0, 0, 0.6), 'system');
    assert.equal(labelMode(0.6, 0, 0.6), 'sky');
    assert.equal(labelMode(0, MAP_HIDE_K * 2, 0.6), 'map');
    assert.equal(labelMode(0, 0.5), 'map', 'two arguments still work');
});
