// Camera rig behaviour (js/camera/rig.js) driven in Node: the real rig with three's vendored
// module (test/helpers/three-hooks.mjs supplies the page's import map), a stand-in RenderContext,
// a scripted clock and real snapshots. Covers the deep-link return pose, one-shot event jumps,
// the 'Center' framing and sky-view zoom about the cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODY_INDEX } from '../js/astro/bodies.js';
import { createStore } from '../js/core/store.js';
import { createActions, selectionLook, viewModeLook, eventFraming } from '../js/app/actions.js';
import { localSolarEclipseAt, upcomingEvents } from '../js/astro/events.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createRig, skyRayAzAlt, skyLookFor } = await import('../js/camera/rig.js');

const D = Math.PI / 180;
const PARIS = { latDeg: 48.85, lonDeg: 2.35, elevM: 0, name: 'Paris', country: 'France', tz: 'Europe/Paris', tzApprox: false, source: 'url' };
const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, name: 'Luxor', country: 'Egypt', tz: 'Africa/Cairo', tzApprox: false, source: 'url' };
const HCMC = { latDeg: 10.82, lonDeg: 106.63, elevM: 0, name: 'HCMC', country: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', tzApprox: false, source: 'url' };

function snapAt(tMs, observer) {
    const s = createSnapshot();
    computeSnapshot(tMs, observer, s, { detail: 'frame' });
    return s;
}

/** A canvas stand-in: enough of an element for OrbitControls and the rig's pointer/wheel input. */
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
        Object.assign(e, { button: 0, pointerType: 'touch', deltaMode: 0, ...props });
        this.dispatchEvent(e);
        return e;
    }
}

/** The real rig on a stand-in RenderContext with a scripted clock. */
function makeRig({ w = 1600, h = 900, dom = false } = {}) {
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 4000);
    camera.position.set(0, 0, 3.4);    // render/context.js: where the camera starts
    const clock = { t: 1000 };
    const rc = { camera, size: { w, h, insets: { left: 0, right: 0, top: 0, bottom: 0 } }, invalidate() {} };
    const el = dom ? new FakeCanvas(w, h) : null;
    const rig = createRig(rc, { dom: el, reducedMotion: false, now: () => clock.t });
    /** Advances `ms` of wall time in 16 ms frames; snap may be a function of the elapsed ms. */
    const run = (ms, snap, onFrame) => {
        for (let el = 0; el < ms; el += 16) {
            clock.t += 16;
            rig.update(16, typeof snap === 'function' ? snap(el + 16) : snap);
            onFrame?.(el + 16);
        }
    };
    return { rig, camera, clock, rc, el, run };
}

/** NDC of a world direction seen from the camera (a point far along it). */
function ndcOfDir(camera, dir) {
    camera.updateMatrixWorld();
    return new THREE.Vector3().copy(camera.position).addScaledVector(dir, 1e3).project(camera);
}

/** World direction under an NDC point of the camera. */
function dirAtNdc(camera, x, y) {
    camera.updateMatrixWorld();
    return new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
}

const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---- bug-skylink-return-pose ----------------------------------------------------------------------

test('a shared sky-view link returns to the globe over the observer, not the never-placed camera', () => {
    const { rig, run } = makeRig();
    const snap = snapAt(Date.parse('2026-11-03T20:00:00Z'), PARIS);
    // main.js: rig.setView(hash.cam) before the first snapshot, then the first update.
    rig.setView('s:180,20,70');
    rig.update(0, snap);
    assert.deepEqual(rig.getView(), { mode: 'sky', azDeg: 180, altDeg: 20, fovDeg: 70 });
    rig.setMode('orbit', { animate: false });
    run(32, snap);
    const v = rig.getView();
    assert.equal(v.mode, 'orbit');
    near(v.latDeg, PARIS.latDeg, 0.1, 'lat');
    near(v.lonDeg, PARIS.lonDeg, 0.1, 'lon');
    near(v.distance, 3.4, 1e-6, 'distance');
});

test('sky view entered from a placed globe still returns to that globe pose', () => {
    const { rig, run } = makeRig();
    const snap = snapAt(Date.parse('2026-11-03T20:00:00Z'), PARIS);
    rig.setView('o:-20,120,5');
    rig.update(0, snap);
    rig.setView('s:90,30,60');
    rig.setMode('orbit', { animate: true });
    run(2000, snap);
    const v = rig.getView();
    near(v.latDeg, -20, 1e-6, 'lat');
    near(v.lonDeg, 120, 1e-6, 'lon');
    near(v.distance, 5, 1e-6, 'distance');
});

// ---- bug-event-jump-double-flight ----------------------------------------------------------------

/**
 * The actions API on a real store and rig, with main.js's view.mode subscriber mirrored (the same
 * viewModeLook decision; main.js is checked to call it below). `frames()` advances the loop with a
 * snapshot at the clock's current instant; the clock sweeps linearly over the action's animateMs.
 */
function makeApp({ observer, t0, view, cam }) {
    const h = makeRig();
    const store = createStore({ observer, view: { mode: view, earthLock: true } });
    const clockApi = {
        tMs: t0, from: t0, to: t0, dur: 0, el: 0,
        pause() {},
        setTime(t, { animateMs = 0 } = {}) { this.from = this.tMs; this.to = t; this.dur = animateMs; this.el = 0; if (!animateMs) this.tMs = t; },
        tick(dt) {
            if (this.dur > 0 && this.el < this.dur) {
                this.el = Math.min(this.dur, this.el + dt);
                this.tMs = this.from + (this.to - this.from) * (this.el / this.dur);
            }
        },
    };
    let snap = snapAt(t0, observer);
    store.subscribe((s) => s.view.mode, (mode, _prev, _state, source) => {
        h.rig.setMode(mode, { animate: true, look: viewModeLook(mode, source, store.get().selection, snap) });
    });
    const actions = createActions({
        store, clock: clockApi, bus: { emit() {} },
        prefs: { load: (_k, d) => d, save() {}, remove() {} },
        render: { rig: h.rig }, getSnap: () => snap,
    });
    if (cam) h.rig.setView(cam);
    h.rig.update(0, snap);
    if (!cam && view === 'sky') h.rig.setMode('sky', { animate: false });
    h.run(32, snap);
    const frames = (ms, onFrame) => h.run(ms, () => {
        clockApi.tick(16);
        snap = snapAt(clockApi.tMs, observer);
        return snap;
    }, onFrame);
    return { ...h, store, actions, frames };
}

test('viewModeLook: entering sky view turns to the selected body, except after an event jump', () => {
    const snap = snapAt(Date.parse('2027-08-02T10:05:00Z'), LUXOR);
    const jup = snap.bodies[BODY_INDEX.jupiter];
    assert.ok(jup.altGeomDeg > 0, 'Jupiter is up');
    assert.deepEqual(viewModeLook('sky', 'actions', 'jupiter', snap), { azDeg: jup.azDeg, altDeg: jup.altDeg },
        'the apparent (refracted) position the sky view draws');
    assert.deepEqual(viewModeLook('sky', undefined, 'jupiter', snap), selectionLook('jupiter', snap));
    // The jump has already aimed the rig at the event's instant: no second look from this frame.
    assert.equal(viewModeLook('sky', 'event', 'jupiter', snap), undefined);
    assert.equal(viewModeLook('orbit', 'actions', 'jupiter', snap), undefined);
    // Nothing selected, an unknown id, or a body below the horizon: the rig's default look.
    assert.equal(viewModeLook('sky', 'actions', null, snap), undefined);
    assert.equal(viewModeLook('sky', 'actions', 'pluto', snap), undefined);
    const down = ['sun', 'moon', 'mercury', 'venus', 'mars', 'saturn', 'uranus', 'neptune']
        .find((id) => !snap.bodies[BODY_INDEX[id]].above);
    assert.ok(down, 'some body is below the horizon');
    assert.equal(selectionLook(down, snap), undefined);
    assert.equal(selectionLook('jupiter', null), undefined);
});

test('main.js: the view.mode subscriber takes its look from viewModeLook (with the store source)', () => {
    const src = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
    assert.match(src, /s\.view\.mode,\s*\(mode,[^)]*\bsource\)\s*=>/);
    assert.match(src, /viewModeLook\(\s*mode,\s*source\b/);
});

test('an eclipse jump from sky view is one sky → globe flight that lands over the shadow', () => {
    const app = makeApp({ observer: LUXOR, t0: Date.parse('2027-08-02T08:00:00Z'), view: 'sky', cam: 's:195,60,20' });
    assert.equal(app.rig.getView().mode, 'sky');
    app.actions.jumpToEvent({
        kind: 'solar-eclipse', tMs: Date.parse('2027-08-02T10:07:50Z'), select: 'sun', view: 'orbit',
        geo: { latDeg: 25.5, lonDeg: 33.2 },
    });
    assert.equal(app.store.get().view.mode, 'orbit');
    let maxR = 0;
    app.frames(2200, () => { maxR = Math.max(maxR, app.camera.position.length()); });
    assert.equal(app.rig.tweening, false, 'no second leg queued after the transition');
    const v = app.rig.getView();
    near(v.latDeg, 25.5, 0.05, 'lat');
    near(v.lonDeg, 33.2, 0.05, 'lon');
    near(v.distance, 2.6, 0.01, 'distance');
    // A detour through the 3.4 R return pose would show here.
    assert.ok(maxR < 2.65, `camera rose to ${maxR.toFixed(2)} R`);
});

test('an eclipse jump in globe view flies once, overlapping the sweep, and lands with Earth-lock off', () => {
    for (const lock of [true, false]) {
        const app = makeApp({ observer: LUXOR, t0: Date.parse('2027-08-01T20:00:00Z'), view: 'orbit' });
        app.store.set({ view: { ...app.store.get().view, earthLock: lock } });
        app.rig.setEarthLock(lock);
        app.actions.jumpToEvent({
            kind: 'solar-eclipse', tMs: Date.parse('2027-08-02T10:07:50Z'), select: 'sun', view: 'orbit',
            geo: { latDeg: 25.5, lonDeg: 33.2 },
        });
        assert.equal(app.rig.tweening, true, 'the flight starts with the sweep');
        app.frames(2200);
        assert.equal(app.rig.tweening, false);
        const v = app.rig.getView();
        near(v.latDeg, 25.5, 0.05, `lat (lock ${lock})`);
        near(v.lonDeg, 33.2, 0.05, `lon (lock ${lock})`);
    }
});

test('a sky event jump from the globe ends on the body at the event, not at the pre-sweep frame', () => {
    const t0 = Date.parse('2027-08-02T07:05:00Z');
    const tMs = Date.parse('2027-08-02T10:05:00Z');
    const before = snapAt(t0, LUXOR).bodies[BODY_INDEX.jupiter];
    const at = snapAt(tMs, LUXOR).bodies[BODY_INDEX.jupiter];
    assert.ok(before.altGeomDeg > 10 && at.altGeomDeg > 10, 'Jupiter is up at both instants');
    assert.ok(angDiff(before.azGeomDeg, at.azGeomDeg) > 10, 'and has moved');
    const app = makeApp({ observer: LUXOR, t0, view: 'orbit' });
    app.actions.jumpToEvent({ kind: 'conjunction', tMs, select: 'jupiter', view: 'sky' });
    assert.equal(app.store.get().view.mode, 'sky');
    app.frames(2200);
    assert.equal(app.rig.tweening, false, 'no second look queued after the transition');
    const v = app.rig.getView();
    assert.equal(v.mode, 'sky');
    near(angDiff(v.azDeg, at.azGeomDeg), 0, 0.05, 'az');
    near(v.altDeg, at.altGeomDeg, 0.05, 'alt');
});

test('a sky event jump inside sky view turns once to the body at the event', () => {
    const t0 = Date.parse('2027-08-02T07:05:00Z');
    const tMs = Date.parse('2027-08-02T10:05:00Z');
    const at = snapAt(tMs, LUXOR).bodies[BODY_INDEX.jupiter];
    const app = makeApp({ observer: LUXOR, t0, view: 'sky' });
    app.actions.jumpToEvent({ kind: 'conjunction', tMs, select: 'jupiter', view: 'sky' });
    app.frames(2200);
    assert.equal(app.rig.tweening, false);
    const v = app.rig.getView();
    near(angDiff(v.azDeg, at.azGeomDeg), 0, 0.05, 'az');
    near(v.altDeg, at.altGeomDeg, 0.05, 'alt');
});

// ---- eclipse-local-circumstances-and-framing ------------------------------------------------------

test('a total eclipse jump from the globe descends to the Sun, then narrows the field to 5°', () => {
    const ev = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    const plan = eventFraming(ev);
    const app = makeApp({ observer: LUXOR, t0: Date.parse('2027-08-02T07:00:00Z'), view: 'orbit' });
    app.actions.jumpToEvent(ev);
    assert.equal(app.store.get().view.mode, 'sky');
    let atDescent = null;
    app.frames(5000, (ms) => {
        if (ms === 1808) atDescent = app.rig.getView();
    });
    assert.equal(app.rig.tweening, false, 'descent and zoom both done');
    // The descent still lands at the usual 70°; the zoom follows it.
    assert.equal(atDescent.mode, 'sky');
    near(atDescent.fovDeg, 70, 1, 'field at the end of the descent');
    const v = app.rig.getView();
    near(v.fovDeg, 5, 1e-6, 'framed at 5°');
    const sun = snapAt(plan.aimMs, LUXOR).bodies[BODY_INDEX.sun];
    near(angDiff(v.azDeg, sun.azGeomDeg) * Math.cos(sun.altGeomDeg * D), 0, 0.05, 'az (on the sky)');
    near(v.altDeg, sun.altGeomDeg, 0.05, 'alt');
});

test('an eclipse jump inside sky view turns and zooms in one look (lunar eclipse at 5°)', () => {
    const HANOI = { latDeg: 21.03, lonDeg: 105.85, elevM: 0, name: 'Hanoi', country: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', tzApprox: false, source: 'url' };
    const ev = upcomingEvents(HANOI, Date.parse('2026-03-01T00:00:00Z'), 4).find((e) => e.kind === 'lunar-eclipse');
    assert.equal(ev.view, 'sky');
    const app = makeApp({ observer: HANOI, t0: Date.parse('2026-03-03T08:00:00Z'), view: 'sky', cam: 's:200,40,60' });
    app.actions.jumpToEvent(ev);
    app.frames(3500);
    assert.equal(app.rig.tweening, false);
    const v = app.rig.getView();
    near(v.fovDeg, 5, 1e-6, 'framed at 5°');
    const moon = snapAt(ev.visibleMs, HANOI).bodies[BODY_INDEX.moon];
    near(angDiff(v.azDeg, moon.azGeomDeg), 0, 0.05, 'az');
    near(v.altDeg, moon.altGeomDeg, 0.05, 'alt');
});

// ---- bug-center-behind-camera ---------------------------------------------------------------------

/**
 * Checks the 'Center' framing of body `id`, made the way the UI asks for it (actions.flyToBody).
 * Bodies are checked where they are drawn: the Moon's mesh at snap.moonPosS (~60 R, so parallax
 * from the camera counts), the others at infinity along dirS.
 * @returns {{off:number, r:number, px:number, py:number, cx:number, cy:number}} the body's angle
 *   off the view axis, the camera distance, and the body's and free area's centre in CSS px
 */
function checkFrame({ w, h, insets, observer, iso, id }) {
    const { rig, camera, run, rc } = makeRig({ w, h });
    const snap = snapAt(Date.parse(iso), observer);
    rig.update(0, snap);
    if (insets) rig.setViewInsets(insets);
    const store = createStore({ observer, view: { mode: 'orbit', earthLock: true }, status: { reducedMotion: true } });
    const actions = createActions({
        store, clock: { pause() {}, setTime() {} }, bus: { emit() {} },
        prefs: { load: (_k, d) => d, save() {}, remove() {} }, render: { rig }, getSnap: () => snap,
    });
    const b = snap.bodies[BODY_INDEX[id]];
    actions.flyToBody(id);
    run(32, snap);
    const dir = vec(b.dirS).normalize();
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const r = camera.position.length();
    const P = id === 'moon' ? vec(snap.moonPosS) : camera.position.clone().addScaledVector(dir, 1e3);
    const toP = P.clone().sub(camera.position);
    const radius = id === 'moon' ? Math.asin(0.2724 / toP.length()) / D : 0;
    const off = Math.acos(fwd.dot(toP.normalize())) / D;
    const limb = Math.asin(1 / r) / D;
    assert.ok(off - radius > limb + (id === 'moon' ? 0.5 : 1),
        `${id} ${off.toFixed(2)}° (radius ${radius.toFixed(2)}°) from the axis is past the ${limb.toFixed(2)}° limb`);
    near(limb, 0.85 * off, 0.02, `${id}: the limb at 0.85 of the body's angle`);
    // Inside the free area (the screen the panels leave), with a margin.
    const p = P.clone().project(camera);
    assert.ok(p.z < 1, `${id} is in front of the camera`);
    const px = (p.x + 1) / 2 * rc.size.w, py = (1 - p.y) / 2 * rc.size.h;
    const ins = { left: 0, right: 0, top: 0, bottom: 0, ...insets };
    assert.ok(px > ins.left + 20 && px < w - ins.right - 20 && py > ins.top + 20 && py < h - ins.bottom - 20,
        `${id} at (${px.toFixed(0)}, ${py.toFixed(0)}) px is inside the free area`);
    // 70% of the way from the free area's centre to its edge on the body's side, unless the globe
    // would then not fit across: its disc spans at most 75% of the free area's narrower side.
    const hx = (w - ins.left - ins.right) / 2, hy = (h - ins.top - ins.bottom) / 2;
    const cx = ins.left + hx, cy = ins.top + hy;
    const dx = Math.abs(px - cx), dy = Math.abs(py - cy), d = Math.hypot(dx, dy);
    const edge = Math.min(dx > 1e-6 ? hx * d / dx : Infinity, dy > 1e-6 ? hy * d / dy : Infinity);
    const rGlobe = Math.tan(limb * D) * (h / 2) / Math.tan(22.5 * D);
    const fit = 0.75 * Math.min(hx, hy);
    assert.ok(rGlobe < fit + 1, `${id}: the ${rGlobe.toFixed(0)} px globe fits across the free area`);
    if (rGlobe < fit - 1) near(d, 0.7 * edge, 2, `${id}: px from the centre, 70% of the way to the edge`);
    else assert.ok(d < 0.7 * edge + 2, `${id}: within 70% of the way to the edge`);
    // The observer's beam crosses the globe: from the observer's side of the disc (the far side
    // of the centre unless the body is within ~74° of the zenith) to the body past the limb.
    const toPx = (v) => ({ x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h });
    const o = toPx(vec(snap.observer.posS).project(camera)), c = toPx(new THREE.Vector3().project(camera)), q = toPx(p);
    const rDisc = Math.tan(limb * D) * (h / 2) / Math.tan(22.5 * D);
    assert.ok(Math.hypot(o.x - q.x, o.y - q.y) > 0.9 * rDisc, `${id}: the beam spans the globe on screen`);
    if (b.altGeomDeg < 70) {
        assert.ok((o.x - c.x) * (q.x - c.x) + (o.y - c.y) * (q.y - c.y) < 0, `${id}: observer and body on opposite sides of the globe`);
    }
    return { off, r, px, py, cx, cy };
}

test("'Center' puts the body just past the limb in view, not behind the camera (body below the horizon)", () => {
    // Mars is off to the lower left: the globe grows until it spans 75% of the screen height.
    const { r } = checkFrame({ w: 1600, h: 900, observer: HCMC, iso: '2026-11-03T14:00:00Z', id: 'mars' });
    near(r, 1 / Math.sin(Math.atan(0.75 * Math.tan(22.5 * D))), 0.01, 'distance');
});

test("'Center' on a body straight above the globe: 70% of the way to the screen edge, 4.2 R out", () => {
    // The Sun crosses the meridian at Paris at 11:34 UTC, so it sits straight above the centre.
    const { off, r, px, cx } = checkFrame({ w: 1600, h: 900, observer: PARIS, iso: '2026-11-03T11:34:00Z', id: 'sun' });
    near(px, cx, 1, 'x px');
    near(off, Math.atan(0.7 * Math.tan(22.5 * D)) / D, 0.01, 'angle from the view axis');
    near(r, 4.2, 0.01, 'distance');
});

test("'Center' frames bodies above the horizon and the Sun, with panels and on a phone", () => {
    checkFrame({ w: 1600, h: 900, observer: HCMC, iso: '2026-11-03T14:00:00Z', id: 'saturn' });
    checkFrame({ w: 1600, h: 900, insets: { right: 380, bottom: 110 }, observer: HCMC, iso: '2026-11-03T14:00:00Z', id: 'mars' });
    checkFrame({ w: 1600, h: 900, insets: { right: 380, bottom: 110 }, observer: PARIS, iso: '2026-11-03T12:00:00Z', id: 'sun' });
    checkFrame({ w: 390, h: 844, insets: { bottom: 340 }, observer: LUXOR, iso: '2027-08-02T10:05:00Z', id: 'jupiter' });
    checkFrame({ w: 390, h: 844, insets: { bottom: 340 }, observer: LUXOR, iso: '2027-08-02T10:05:00Z', id: 'sun' });
    checkFrame({ w: 390, h: 844, observer: HCMC, iso: '2026-11-03T14:00:00Z', id: 'mars' });
});

test("'Center' frames the Moon where its mesh is drawn: parallax never tucks it behind the limb", () => {
    // Its mesh sits ~60 R out; from a camera 4–9 R behind the globe it shows 1–1.5° nearer the
    // view axis than its direction, which on a phone was inside the limb (fully hidden).
    for (const c of [
        { w: 390, h: 844, observer: HCMC, iso: '2026-11-03T14:00:00Z' },
        { w: 390, h: 844, insets: { bottom: 340 }, observer: LUXOR, iso: '2027-08-02T10:05:00Z' },
        { w: 1600, h: 900, insets: { right: 380, bottom: 110 }, observer: HCMC, iso: '2026-11-03T14:00:00Z' },
        { w: 1600, h: 900, observer: LUXOR, iso: '2027-08-02T10:05:00Z' },
        { w: 1600, h: 900, insets: { right: 380, bottom: 110 }, observer: PARIS, iso: '2026-11-03T12:00:00Z' },
    ]) checkFrame({ ...c, id: 'moon' });
});

test("'Center' on a portrait phone uses the tall side for a body above or below the globe", () => {
    // The old framing sized everything from the 390 px width: 8.85 R out, the globe 60% of it.
    const { r, px, py, cx, cy } = checkFrame({ w: 390, h: 844, insets: { bottom: 340 }, observer: LUXOR, iso: '2027-08-02T10:05:00Z', id: 'sun' });
    assert.ok(Math.abs(py - cy) > 2 * Math.abs(px - cx), 'the Sun is above or below the globe');
    assert.ok(r < 7.1, `distance ${r.toFixed(2)}`);
});

test("'View from <body>' keeps the old pose: the camera on the body's direction", () => {
    const { rig, camera, run } = makeRig();
    const snap = snapAt(Date.parse('2026-11-03T14:00:00Z'), HCMC);
    rig.update(0, snap);
    const b = snap.bodies[BODY_INDEX.mars];
    rig.flyToDir(b.dirS, { animate: false });
    run(32, snap);
    near(camera.position.clone().normalize().dot(vec(b.dirS).normalize()), 1, 1e-9, 'camera on the body direction');
});

// ---- sky-zoom-to-cursor ----------------------------------------------------------------------------

test('skyLookFor inverts skyRayAzAlt', () => {
    const out = { az: 0, alt: 0 }, back = { az: 0, alt: 0 };
    let n = 0;
    for (let i = 0; i < 400; i++) {
        const az = (i * 37.3) % 360, alt = -10 + (i * 13.7) % 99;
        const cx = Math.sin(i) * 0.6, cy = Math.cos(i * 1.7) * 0.5, cz = -1;
        skyRayAzAlt(az, alt, cx, cy, cz, out);
        skyLookFor(out.az, out.alt, cx, cy, cz, back, az, alt);
        near(angDiff(back.az, az), 0, 1e-9, `az #${i}`);
        near(back.alt, alt, 1e-9, `alt #${i}`);
        n++;
    }
    assert.equal(n, 400);
});

/** A sky-view rig with a canvas, at a look, optionally with panel insets. */
function skyRig({ look = 's:150,30,60', insets } = {}) {
    const h = makeRig({ dom: true });
    const snap = snapAt(Date.parse('2026-11-03T20:00:00Z'), PARIS);
    h.rig.setView(look);
    h.rig.update(0, snap);
    if (insets) h.rig.setViewInsets(insets);
    h.run(32, snap);
    return { ...h, snap };
}

test('the wheel zooms about the cursor: the sky under it stays put on every frame', () => {
    for (const insets of [null, { right: 380, bottom: 110 }]) {
        for (const [deltaY, x, y] of [[-300, 1200, 250], [-300, 300, 700], [300, 1000, 600]]) {
            const h = skyRig({ insets });
            const ndc = { x: x / 800 - 1, y: 1 - y / 450 };
            const d0 = dirAtNdc(h.camera, ndc.x, ndc.y);
            const fov0 = h.rig.getView().fovDeg;
            const e = h.el.send('wheel', { deltaY, clientX: x, clientY: y, pointerType: 'mouse' });
            assert.equal(e.defaultPrevented, true);
            let worst = 0;
            h.run(1500, h.snap, () => {
                const p = ndcOfDir(h.camera, d0);
                worst = Math.max(worst, Math.hypot((p.x - ndc.x) * 800, (p.y - ndc.y) * 450));
            });
            assert.ok(worst < 0.01, `cursor anchor drifted ${worst.toFixed(4)} px`);
            near(h.rig.getView().fovDeg, fov0 * Math.exp(0.1 * Math.max(-3, Math.min(3, deltaY / 100))), 1e-9, 'fov');
            near(h.camera.fov, h.rig.getView().fovDeg, 1e-9, 'settled');
        }
    }
});

test('keyboard zoom stays about the centre of the view', () => {
    const h = skyRig();
    const before = h.rig.getView();
    h.rig.zoom(1 / 1.25);
    h.run(1500, h.snap);
    const v = h.rig.getView();
    near(v.azDeg, before.azDeg, 1e-9, 'az');
    near(v.altDeg, before.altDeg, 1e-9, 'alt');
    near(v.fovDeg, before.fovDeg / 1.25, 1e-9, 'fov');
});

test('zooming about sky past the zenith holds it where it can, and never swings the view', () => {
    const watch = (h, d0, x, y) => {
        const s = { drift: 0, step: 0, prev: h.camera.getWorldDirection(new THREE.Vector3()) };
        return [s, () => {
            const p = ndcOfDir(h.camera, d0);
            s.drift = Math.max(s.drift, Math.hypot((p.x - x) * 800, (p.y - y) * 450));
            const f = h.camera.getWorldDirection(new THREE.Vector3());
            s.step = Math.max(s.step, Math.acos(Math.min(1, f.dot(s.prev))) / D);
            s.prev = f;
        }];
    };
    // Zooming out about a point beyond the zenith tips the view down: the point stays put.
    let h = skyRig({ look: 's:0,75,60' });
    let d0 = dirAtNdc(h.camera, 0.2, 0.9);
    assert.ok(skyRayAzAlt(0, 75, 0.2 * 16 / 9 * Math.tan(30 * D), 0.9 * Math.tan(30 * D), -1, { az: 0, alt: 0 }).az > 90,
        'the anchor lies past the zenith');
    let [s, onFrame] = watch(h, d0, 0.2, 0.9);
    h.rig.zoomAt(1.3, 0.2, 0.9);
    h.run(1500, h.snap, onFrame);
    assert.ok(s.drift < 0.01, `anchor drifted ${s.drift.toFixed(4)} px`);
    assert.ok(s.step < 5, `the view jumped ${s.step.toFixed(1)}° in a frame`);
    // Zooming in there would tip the view over the zenith: it stops at the 89° limit instead of
    // swinging round to the other look that holds the point, without jumps or NaN.
    h = skyRig({ look: 's:0,85,90' });
    d0 = dirAtNdc(h.camera, 0, 0.95);
    [s, onFrame] = watch(h, d0, 0, 0.95);
    h.rig.zoomAt(0.2, 0, 0.95);
    h.run(1500, h.snap, onFrame);
    const v = h.rig.getView();
    assert.ok(Number.isFinite(v.azDeg) && Number.isFinite(v.altDeg));
    assert.ok(v.altDeg <= 89 && v.altDeg >= 80, `alt ${v.altDeg}`);
    near(angDiff(v.azDeg, 0), 0, 1e-9, 'az');
    assert.ok(s.step < 5, `the view jumped ${s.step.toFixed(1)}° in a frame`);
    near(v.fovDeg, 18, 1e-9, 'fov');
    assert.ok(ndcOfDir(h.camera, d0).y > 0, 'the anchored sky stays in the upper half');
});

test('a pinch zooms about the fingers and pans with their midpoint', () => {
    const h = skyRig({ insets: { bottom: 200 } });
    const a = { x: 600, y: 400 }, b = { x: 800, y: 500 };
    const mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d0 = dirAtNdc(h.camera, mid0.x / 800 - 1, 1 - mid0.y / 450);
    h.el.send('pointerdown', { pointerId: 1, clientX: a.x, clientY: a.y });
    h.el.send('pointerdown', { pointerId: 2, clientX: b.x, clientY: b.y });
    // Spread to twice the distance and move the midpoint 100 px right.
    h.el.send('pointermove', { pointerId: 1, clientX: 600, clientY: 350 });
    h.el.send('pointermove', { pointerId: 2, clientX: 1000, clientY: 550 });
    h.run(16, h.snap);
    const fovNow = h.rig.getView().fovDeg;
    near(fovNow, 30, 1e-6, 'fov halves');
    const p = ndcOfDir(h.camera, d0);
    near((p.x + 1) * 800, 800, 0.01, 'x px');
    near((1 - p.y) * 450, 450, 0.01, 'y px');
    h.el.send('pointerup', { pointerId: 1, clientX: 600, clientY: 350 });
    h.el.send('pointerup', { pointerId: 2, clientX: 1000, clientY: 550 });
});

test('double-click to centre: the sky under the point glides to the middle of the view', () => {
    const h = skyRig({ insets: { right: 380, bottom: 110 } });
    const x = 0.45, y = -0.3;
    const d0 = dirAtNdc(h.camera, x, y);
    const fov0 = h.rig.getView().fovDeg;
    h.rig.centerAt(x, y);
    h.run(2000, h.snap);
    assert.equal(h.rig.tweening, false);
    const fwd = h.camera.getWorldDirection(new THREE.Vector3());
    near(fwd.dot(d0), 1, 1e-9, 'centred');
    near(h.rig.getView().fovDeg, fov0 * 0.6, 1e-9, 'zoomed in a little');
});

test('centerAt is a no-op in globe view', async () => {
    const { rig, run } = makeRig();
    const snap = snapAt(Date.parse('2026-11-03T20:00:00Z'), PARIS);
    rig.update(0, snap);
    run(32, snap);
    assert.equal(await rig.centerAt(0.2, 0.2), false);
    assert.equal(rig.tweening, false);
});

// ---- eclipse-shadow-chase: follow() ---------------------------------------------------------------

/** A target sliding east along the equator of the globe's geometry frame from lon 0 at 0.5°/frame. */
function eastward() {
    let lon = 0;
    const fn = (_snap, pos, fwd) => {
        const l = lon * D;
        pos[0] = Math.cos(l); pos[1] = 0; pos[2] = -Math.sin(l);
        fwd[0] = -Math.sin(l); fwd[1] = 0; fwd[2] = -Math.cos(l);
        return true;
    };
    return { fn, step: (d = 0.5) => { lon += d; }, get lon() { return lon; } };
}

/** Earth-local vector of a world one (the snapshot's Earth rotation). */
function toLocalOf(snap, v) {
    const q = new THREE.Quaternion(...snap.earthQuat).invert();
    return v.clone().applyQuaternion(q);
}

test('follow: low orbit behind the moving point, looking at it with the limb above, horizon level', async () => {
    const h = makeRig({ dom: true });
    const snap = snapAt(Date.parse('2027-08-02T10:00:00Z'), LUXOR);
    h.rig.update(0, snap);
    h.run(32, snap);
    const tgt = eastward();
    let arrived = 0;
    const p = h.rig.follow(tgt.fn, { onArrive: () => arrived++ });
    assert.equal(h.rig.following, true);
    h.run(800, snap);
    assert.equal(arrived, 0, 'still approaching');
    h.run(1200, snap, () => tgt.step(0.05));
    assert.equal(arrived, 1, 'arrived once');
    h.run(500, snap, () => tgt.step(0.05));
    assert.equal(arrived, 1);
    const posL = toLocalOf(snap, h.camera.position);
    near(posL.length(), 1.35, 1e-6, 'altitude 0.35 R');
    // Behind the target along its motion (west of it), on its track (the equator).
    const lonCam = Math.atan2(-posL.z, posL.x) / D;
    near(tgt.lon - lonCam, 14, 0.5, 'backDeg behind');
    near(posL.y, 0, 1e-6, 'on the track');
    // The target is in view, below the centre; the limb (the horizon) is above it.
    const tL = new THREE.Vector3(Math.cos(tgt.lon * D), 0, -Math.sin(tgt.lon * D));
    const tW = tL.clone().applyQuaternion(new THREE.Quaternion(...snap.earthQuat));
    h.camera.updateMatrixWorld();
    const ndc = tW.clone().project(h.camera);
    near(ndc.x, 0, 1e-3, 'target centred horizontally');
    assert.ok(ndc.y < -0.2 && ndc.y > -0.8, `target in the lower half (ndc y ${ndc.y.toFixed(2)})`);
    // Level horizon: the camera's right vector is square to the local vertical.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(h.camera.quaternion);
    near(right.dot(h.camera.position.clone().normalize()), 0, 1e-6, 'no roll');
    // Pointer input hands the camera back (false) and the controls take over without a snap.
    const before = h.camera.getWorldDirection(new THREE.Vector3());
    h.el.send('pointerdown', { pointerId: 1, clientX: 800, clientY: 450 });
    assert.equal(h.rig.following, false);
    assert.equal(await p, false);
    h.rig.update(16, snap);
    const after = h.camera.getWorldDirection(new THREE.Vector3());
    assert.ok(after.dot(before) > 0.995, 'no orientation snap on the hand-over');
    h.el.send('pointerup', { pointerId: 1, clientX: 800, clientY: 450 });
    h.run(600, snap);
    const centre = h.camera.position.clone().negate().normalize();
    near(h.camera.getWorldDirection(new THREE.Vector3()).dot(centre), 1, 1e-6, 'then aims at the centre like the orbit controls');
});

test('follow: stopFollow resolves true; from sky view it returns to the globe first; a flight takes over smoothly', async () => {
    const h = makeRig();
    const snap = snapAt(Date.parse('2027-08-02T10:00:00Z'), LUXOR);
    h.rig.setView('s:180,20,70');
    h.rig.update(0, snap);
    const tgt = eastward();
    const p = h.rig.follow(tgt.fn, { approachMs: 0 });
    h.run(2500, snap);
    await new Promise((r) => setTimeout(r, 0));   // the transition's promise hands over
    h.run(32, snap);
    assert.equal(h.rig.mode, 'orbit');
    assert.equal(h.rig.following, true, 'following after the transition');
    assert.equal(h.rig.stopFollow(), true);
    assert.equal(await p, true);
    assert.equal(h.rig.stopFollow(), false, 'nothing to stop');
    // A follow replaced by a flight: the first frame keeps the chase orientation.
    const p2 = h.rig.follow(tgt.fn, { approachMs: 0 });
    h.run(64, snap);
    const before = h.camera.getWorldDirection(new THREE.Vector3());
    h.rig.flyToLatLon(25.7, 32.6, { distance: 2.4 });
    assert.equal(await p2, false);
    h.rig.update(16, snap);
    assert.ok(h.camera.getWorldDirection(new THREE.Vector3()).dot(before) > 0.99, 'no snap into the flight');
    h.run(3000, snap);
    assert.equal(h.rig.tweening, false);
    const v = h.rig.getView();
    near(v.distance, 2.4, 1e-6, 'the flight lands');
});
