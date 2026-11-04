// Vantage points in the camera rig (js/camera/rig.js setVantage), driven in Node like
// camera.rig.test.mjs: the flight out to L1 and back, the lunar-orbit Earthrise moving with sim
// time, the near plane and Moon-in-front flag, input in a vantage, and hand-over to other moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { MOON_RADIUS_ER } from '../js/astro/bodies.js';
import { L1_DIST_ER, LUNAR_ALT_KM } from '../js/astro/vantage.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createRig } = await import('../js/camera/rig.js');

const D = Math.PI / 180;
const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, name: 'Luxor', country: 'Egypt', tz: 'Africa/Cairo', tzApprox: false, source: 'url' };
const T_ECLIPSE = Date.parse('2027-08-02T10:07:00Z');
const T_ORDINARY = Date.parse('2026-11-04T12:00:00Z');

function snapAt(tMs) {
    const s = createSnapshot();
    computeSnapshot(tMs, LUXOR, s, { detail: 'frame' });
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
            rig.update(16, typeof snap === 'function' ? snap(el + 16) : snap);
        }
    };
    return { rig, camera, clock, run };
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
// setVantage loads astro/vantage.js with a dynamic import (through the test's resolve hooks), so a
// request lands a few ticks later: wait for the rig to report the vantage (at most 3 s).
const tick = () => new Promise((r) => setTimeout(r, 5));
async function settle(rig, want) {
    for (let i = 0; i < 600 && rig.vantage !== want; i++) await tick();
    assert.equal(rig.vantage, want, 'the request landed');
}

test('View from L1: a 4 s flight out to 235 R sunward, the field narrowing to 0.7°, then back to the same orbit pose', async () => {
    const { rig, camera, run } = makeRig();
    const snap = snapAt(T_ECLIPSE);
    rig.setView('o:20,40,3.4');
    rig.update(0, snap);
    const before = rig.getView();
    const p = rig.setVantage('l1');
    await settle(rig, 'l1');
    assert.equal(rig.vantage, 'l1');
    // Mid-flight: farther out, the field narrower, the Earth still filling a good part of it.
    run(2000, snap);
    const r = camera.position.length();
    assert.ok(r > 10 && r < L1_DIST_ER, `mid-flight distance ${r}`);
    assert.ok(camera.fov < 45 && camera.fov > 0.7, `mid-flight field ${camera.fov}`);
    const share = 2 * Math.asin(1 / r) / D / camera.fov;
    assert.ok(share > 0.6 && share < 0.85, `the globe keeps its share of the frame (${share.toFixed(2)})`);
    run(2200, snap);
    assert.equal(await p, true);
    near(camera.position.length(), L1_DIST_ER, 1e-6, 'at L1');
    near(camera.fov, 0.7, 1e-9, 'field');
    const sun = new THREE.Vector3(...snap.sunDirS);
    near(camera.position.clone().normalize().angleTo(sun) / D, 4, 1e-6, 'off the Sun–Earth line');
    // Looking at the Earth, north up; the near plane keeps the depth buffer fine at the Earth.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    near(fwd.dot(camera.position.clone().normalize()), -1, 1e-9, 'looks at the centre');
    assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).y > 0.9, 'north up');
    assert.ok(camera.near > 100, `near plane ${camera.near}`);
    assert.equal(rig.moonFront, false);
    // The URL keeps the orbit pose it came from.
    const kept = rig.getView();
    assert.equal(kept.mode, 'orbit');
    for (const k of ['latDeg', 'lonDeg', 'distance']) near(kept[k], before[k], 1e-9, k);
    // A held vantage idles while time stands still.
    assert.equal(rig.update(16, snap), false);
    // Input does nothing in a vantage.
    rig.zoom(0.5);
    rig.nudge(10, 10);
    run(100, snap);
    near(camera.position.length(), L1_DIST_ER, 1e-6, 'still at L1');
    // Back: the same orbit pose and field.
    const back = rig.setVantage('none');
    await settle(rig, 'none');
    assert.equal(rig.vantage, 'none');
    run(4200, snap);
    assert.equal(await back, true);
    const v = rig.getView();
    near(v.latDeg, 20, 1e-6, 'lat');
    near(v.lonDeg, 40, 1e-6, 'lon');
    near(v.distance, 3.4, 1e-6, 'distance');
    near(camera.fov, 45, 1e-9, 'orbit field');
    assert.ok(camera.near <= 0.05, 'orbit near plane');
});

test('Earthrise: low lunar orbit, the Moon drawn in front, the Earth climbing with sim time', async () => {
    const { rig, camera, run } = makeRig();
    const snap = snapAt(T_ORDINARY);
    rig.setView('o:-30,100,3.4');
    rig.update(0, snap);
    rig.setVantage('moon', { animate: false });
    await settle(rig, 'moon');
    run(16, snap);
    const m = new THREE.Vector3(...snap.moonPosS);
    near(camera.position.distanceTo(m) - MOON_RADIUS_ER, LUNAR_ALT_KM / 6378.137, 1e-9, 'orbit height');
    assert.equal(rig.moonFront, true);
    near(camera.fov, 18, 1e-9, 'field');
    // Near plane set by the Earth, ~60 R away (the Moon draws in front of it).
    assert.ok(camera.near > 40, `near ${camera.near}`);
    const earthY = () => {
        camera.updateMatrixWorld();
        return new THREE.Vector3(0, 0, 0).project(camera).y;
    };
    const y0 = earthY();
    assert.ok(y0 < 0 && y0 > -0.5, `the Earth just over the limb (${y0})`);
    // A minute of sim time later the orbiter has moved on and the Earth stands ~3° higher.
    run(16, snapAt(T_ORDINARY + 60e3));
    const y1 = earthY();
    const dy = Math.atan(y1 * Math.tan(9 * D)) / D - Math.atan(y0 * Math.tan(9 * D)) / D;
    near(dy, 2.94, 0.15, 'rise per minute');
});

test('a flight out to the Moon never enters the Earth or the Moon, from behind the Earth too', async () => {
    const snap = snapAt(T_ORDINARY);
    const m = new THREE.Vector3(...snap.moonPosS);
    // Start on the far side of the Earth from the Moon, and on the near side.
    for (const sign of [-1, 1]) {
        const { rig, camera, run } = makeRig();
        rig.update(0, snap);
        const d = m.clone().normalize().multiplyScalar(3.4 * sign);
        const lat = Math.asin(d.y / 3.4) / D, lon = Math.atan2(-d.z, d.x) / D;
        rig.setEarthLock(false);
        rig.setView(`o:${lat},${lon},3.4`);
        rig.update(0, snap);
        rig.setVantage('moon');
        await settle(rig, 'moon');
        let minE = Infinity, minM = Infinity;
        for (let i = 0; i < 270; i++) {
            run(16, snap);
            minE = Math.min(minE, camera.position.length());
            minM = Math.min(minM, camera.position.distanceTo(m));
        }
        assert.ok(minE > 1.05, `closest to the Earth ${minE} (start ${sign})`);
        assert.ok(minM > MOON_RADIUS_ER, `closest to the Moon ${minM} (start ${sign})`);
        near(camera.position.distanceTo(m) - MOON_RADIUS_ER, LUNAR_ALT_KM / 6378.137, 1e-6, 'arrived');
    }
});

test('another camera move ends a vantage, listeners hear it, and the flight starts from the vantage', async () => {
    const { rig, camera, run } = makeRig();
    const snap = snapAt(T_ORDINARY);
    rig.update(0, snap);
    const ends = [];
    rig.onVantageEnd((info) => ends.push(info));
    rig.setVantage('l1', { animate: false });
    await settle(rig, 'l1');
    run(16, snap);
    near(camera.position.length(), L1_DIST_ER, 1e-6, 'at L1');
    rig.home();
    run(16, snap);
    assert.deepEqual(ends, [{ reason: 'camera', kind: 'l1' }]);
    assert.equal(rig.vantage, 'none');
    assert.ok(camera.position.length() > 100, 'the flight starts out there');
    run(3000, snap);
    near(camera.position.length(), 3.4, 1e-6, 'home');
    near(camera.fov, 45, 1e-9, 'orbit field restored');
});

test('setVantage from sky view returns to the globe first; the latest request wins', async () => {
    const { rig, run } = makeRig();
    const snap = snapAt(T_ORDINARY);
    rig.update(0, snap);
    rig.setView('s:180,20,70');
    rig.update(0, snap);
    const p = rig.setVantage('l1');
    rig.setVantage('none');     // changed its mind before the module even loaded
    assert.equal(await p, false);
    run(100, snap);
    assert.equal(rig.vantage, 'none');
    assert.equal(rig.mode, 'sky');
    const q = rig.setVantage('moon', { animate: false });
    // Back to the globe (a cut, on the next frame), then out to lunar orbit.
    for (let i = 0; i < 600 && rig.vantage !== 'moon'; i++) {
        run(16, snap);
        await tick();
    }
    run(16, snap);
    assert.equal(await q, true);
    assert.equal(rig.mode, 'orbit');
    assert.equal(rig.vantage, 'moon');
});
