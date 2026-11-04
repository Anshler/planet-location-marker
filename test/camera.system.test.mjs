// The camera rig's system zoom (orrery-zoom-out, js/camera/rig.js): the real rig with three's
// vendored module on a stand-in RenderContext, as in camera.rig.test.mjs. Covers the hand-over at
// the globe's farthest orbit, deep links past 150 R, setSystem's flights and the crossfade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { AU_ER } from '../js/astro/bodies.js';
import * as ORR from '../js/astro/orrery.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createRig } = await import('../js/camera/rig.js');

const D = Math.PI / 180;
const HCMC = { latDeg: 10.82, lonDeg: 106.63, elevM: 0 };
const T_OPP = Date.parse('2027-02-19T15:00:00Z');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

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
    return { rig, camera, clock, el, run };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const sunAt = (s) => new THREE.Vector3(s.helio.earthS[0], s.helio.earthS[1], s.helio.earthS[2]).multiplyScalar(-AU_ER);

test('the wheel at the globe\'s farthest goes on out into the system; zooming back hands the controls back', () => {
    const h = makeRig({ dom: true });
    const s = snapAt(T_OPP, HCMC);
    let shown = 0;
    h.rig.onSystemChange((info) => { shown += info.shown ? 1 : -1; });
    h.rig.setView('o:10,100,150');
    h.rig.update(0, s);
    assert.equal(h.rig.system, false);
    h.run(32, s);
    assert.equal(shown, 1, 'past half the crossfade at 150 R');
    near(h.rig.systemBlend, 1, 1e-9, 'blend at 150 R');
    for (let i = 0; i < 10; i++) {
        const e = h.el.send('wheel', { deltaY: 300, clientX: 700, clientY: 400 });
        assert.ok(e.defaultPrevented, 'the rig owns the wheel out there');
        h.run(48, s);
    }
    h.run(1500, s);
    assert.equal(h.rig.system, true);
    near(h.rig.getView().distance, 150 * Math.exp(0.2 * 3 * 10), 1e-6, 'ten wheel steps of e^0.6');
    const r = h.camera.position.length();
    assert.ok(h.camera.far > r, 'the far plane reaches past the Earth');
    assert.ok(h.camera.near > 1 && h.camera.near < r - 61, 'the near plane stops short of the Moon');
    assert.equal(h.rig.controls.enabled, false);
    for (let i = 0; i < 60; i++) {
        h.el.send('wheel', { deltaY: -300, clientX: 700, clientY: 400 });
        h.run(48, s);
    }
    h.run(2000, s);
    assert.equal(h.rig.system, false, 'back in the globe range');
    assert.equal(h.rig.controls.enabled, true);
    assert.equal(h.camera.far, 4000);
    assert.ok(h.camera.position.length() <= 150 + 1e-6);
    assert.equal(shown, 0, 'the crossfade reported back');
});

test('a deep link past 150 R restores the system view, and getView round-trips it', () => {
    const h = makeRig();
    const s = snapAt(T_OPP, HCMC);
    h.rig.setView('o:38.44,151.18,140729');
    h.rig.update(0, s);
    assert.equal(h.rig.system, true);
    const v = h.rig.getView();
    near(v.latDeg, 38.44, 1e-6, 'lat');
    near(v.lonDeg, 151.18, 1e-6, 'lon');
    near(v.distance, 140729, 1e-6, 'distance');
    near(h.camera.position.distanceTo(sunAt(s)), 140729, 1, '6 AU out the pivot is the Sun');
    near(h.rig.systemBlend, 1, 1e-12, 'orrery');
    // Before the first snapshot it is queued like any view.
    const g = makeRig();
    g.rig.setView({ mode: 'orbit', latDeg: 20, lonDeg: 30, distance: 5e4 });
    g.rig.update(0, s);
    assert.equal(g.rig.system, true);
    near(g.rig.getView().distance, 5e4, 1e-6, 'queued');
    // An orbit view inside the globe range leaves it at once.
    h.rig.setView('o:10,100,3.4');
    h.rig.update(16, s);
    assert.equal(h.rig.system, false);
    near(h.camera.position.length(), 3.4, 1e-9, 'home distance');
    assert.equal(h.camera.far, 4000);
});

test('setSystem flies out to 6 AU lifted above the ecliptic; a fly-to zooms back to the globe first', async () => {
    const h = makeRig();
    const s = snapAt(T_OPP, HCMC);
    h.rig.update(0, s);
    h.run(32, s);
    const p = h.rig.setSystem(true);
    assert.equal(h.rig.system, true, 'the controls hand over at once');
    assert.ok(h.rig.tweening, 'a flight');
    h.run(7000, s);
    assert.equal(await p, true);
    near(h.rig.getView().distance, ORR.SYSTEM_VIEW_R, 1e-6, 'landed');
    const dir = h.camera.position.clone().sub(sunAt(s)).normalize();
    const ecl = ORR.eclipticOf([dir.x, dir.y, dir.z], { lon: 0, lat: 0 });
    assert.ok(Math.abs(ecl.lat) >= ORR.LIFT_LAT_DEG * D - 1e-9, `lifted (${ecl.lat / D}°)`);
    const q = h.rig.flyToLatLon(48.85, 2.35, { distance: 3 });
    h.run(800, s);
    assert.equal(h.rig.system, true, 'still zooming back');
    h.run(1500, s);
    await tick();    // the landed zoom's promise hands over to the flight
    h.run(4000, s);
    assert.equal(await q, true);
    assert.equal(h.rig.system, false);
    near(h.camera.position.length(), 3, 1e-6, 'arrived');
    // Input cancels a flight out: the promise resolves false and the camera stays where it got to.
    const c = h.rig.setSystem(true);
    h.run(1000, s);
    h.rig.zoom(1.25);
    assert.equal(await c, false);
    // setSystem(false) without animation cuts home over the observer.
    const r = h.rig.setSystem(false, { animate: false });
    h.run(64, s);
    await tick();
    h.run(64, s);
    assert.equal(await r, true);
    assert.equal(h.rig.system, false);
    near(h.camera.position.length(), 3.4, 1e-6, 'home');
});

test('the crossfade follows the orbit distance and is 0 in sky view', () => {
    const h = makeRig();
    const s = snapAt(T_OPP, HCMC);
    h.rig.setView('s:180,30,60');
    h.rig.update(0, s);
    h.run(32, s);
    assert.equal(h.rig.systemBlend, 0);
    h.rig.setView('o:10,100,120');
    h.run(32, s);
    near(h.rig.systemBlend, ORR.systemBlend(120), 1e-9, 'orbit at 120 R');
    assert.equal(h.rig.system, false, 'still the orbit controls');
    h.rig.setView('o:10,100,60');
    h.run(32, s);
    assert.equal(h.rig.systemBlend, 0);
});

test('setSystem(false) also homes the orrery the orbit controls show (110–150 R, no system zoom)', async () => {
    const h = makeRig();
    const s = snapAt(T_OPP, HCMC);
    h.rig.setView('o:20,100,140');
    h.rig.update(0, s);
    h.run(32, s);
    assert.equal(h.rig.system, false, 'the orbit controls');
    assert.equal(h.rig.systemShown, true, 'yet the orrery is shown (the caption says Solar system)');
    const p = h.rig.setSystem(false);
    h.run(3000, s);
    assert.equal(await p, true);
    near(h.camera.position.length(), 3.4, 1e-6, 'home over the observer');
    assert.equal(h.rig.systemShown, false);
    // Inside the globe range with no orrery, it does nothing.
    h.rig.setView('o:20,100,40');
    h.run(32, s);
    assert.equal(await h.rig.setSystem(false), true);
    h.run(32, s);
    near(h.camera.position.length(), 40, 1e-6, 'left alone');
});

test('frameSpan (Show both beams) keeps the globe: no orrery at its pose on a desktop or a phone', async () => {
    for (const [w, h, insets] of [[1440, 900, { left: 0, right: 396, top: 0, bottom: 126 }], [390, 844, { left: 0, right: 0, top: 60, bottom: 300 }]]) {
        const r = makeRig({ w, h, dom: true });
        r.rig.setViewInsets?.(insets);
        const s = snapAt(T_OPP, HCMC);
        r.rig.update(0, s);
        r.run(32, s);
        const moon = s.bodies.find((b) => b.id === 'moon');
        const p = r.rig.frameSpan(moon.geoDirS, moon.distER, { animate: true });
        r.run(4000, s);
        assert.equal(await p, true, `${w}×${h}: landed`);
        const d = r.camera.position.length();
        assert.ok(d > ORR.SYSTEM_FADE_R[0], `${w}×${h}: out where the orrery would fade in (${d.toFixed(1)} R)`);
        assert.equal(r.rig.systemBlend, 0, `${w}×${h}: no crossfade at the span pose`);
        assert.equal(r.rig.systemShown, false, `${w}×${h}: the converging beams, not the orrery`);
        // Zooming in keeps the globe; inside the fade's start the usual fade is back.
        r.rig.zoom(0.85);
        r.run(1500, s);
        assert.equal(r.rig.systemBlend, 0, `${w}×${h}: zoomed in a little`);
        r.rig.zoom(0.5);
        r.run(1500, s);
        r.rig.zoom(1.5);
        r.run(1500, s);
        const d2 = r.camera.position.length();
        near(r.rig.systemBlend, ORR.systemBlend(d2), 1e-9, `${w}×${h}: the hold has ended (${d2.toFixed(1)} R)`);
    }
});
