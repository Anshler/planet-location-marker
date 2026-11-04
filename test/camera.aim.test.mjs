// 'Point at the sky' (camera/aim.js): device orientation → a level look, the vector low-pass, and
// the controller's life cycle (first reading, deadband, Align, idle / hidden stops).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    deviceVectors, lookOf, turnAzimuth, createAimFilter, aimFilterStep, createAim, AIM_IDLE_MS,
} from '../js/camera/aim.js';

const F = () => new Float64Array(3);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} vs ${b}`);
const nearAz = (a, b, eps, msg) => near(((a - b + 540) % 360) - 180, 0, eps, msg);

test('deviceVectors: flat, upright portrait, landscape', () => {
    const f = F(), u = F();
    // Flat, face up: the rear camera looks at the ground; the top of the screen points north.
    deviceVectors(0, 0, 0, 0, f, u);
    near(f[0], 0, 1e-12); near(f[1], 0, 1e-12); near(f[2], -1, 1e-12);
    near(u[1], 1, 1e-12);
    // Upright portrait, alpha 0: looking north at the horizon, screen up = zenith.
    deviceVectors(0, 90, 0, 0, f, u);
    near(f[1], 1, 1e-12, 'north');
    near(u[2], 1, 1e-12, 'zenith');
    // Alpha grows counter-clockwise: alpha 90 turns the camera to the west.
    deviceVectors(90, 90, 0, 0, f, u);
    near(f[0], -1, 1e-12, 'west');
    // Tilted back 30° from upright (beta 120): 30° up.
    deviceVectors(0, 120, 0, 0, f, u);
    near(Math.asin(f[2]) * 180 / Math.PI, 30, 1e-9);
    // Landscape (screen turned 90°, the phone upright on its side, top to the west): north again, the screen's
    // up is the device's +x, standing straight up (alpha 90, beta 0, gamma −90).
    deviceVectors(90, 0, -90, 90, f, u);
    near(f[1], 1, 1e-12, 'landscape looks north');
    near(u[2], 1, 1e-12, 'landscape up');
});

test('lookOf: altitude and azimuth, stable at the zenith, horizon level', () => {
    const f = F(), u = F(), out = { azDeg: 0, altDeg: 0 };
    for (const [alpha, beta] of [[0, 90], [300, 100], [45, 150], [200, 170]]) {
        deviceVectors(alpha, beta, 0, 0, f, u);
        lookOf(f, u, out);
        near(out.altDeg, beta - 90, 1e-9, 'alt');
        nearAz(out.azDeg, (360 - alpha) % 360, 1e-6, `az for alpha ${alpha}, beta ${beta}`);
    }
    // At the zenith the forward has no azimuth; the screen's down direction still names it.
    deviceVectors(30, 179.99, 0, 0, f, u);
    lookOf(f, u, out);
    nearAz(out.azDeg, 330, 0.01, 'near zenith');
    // Roll (gamma) does not move a near-horizon look's azimuth.
    deviceVectors(0, 100, 0, 0, f, u);
    const az0 = lookOf(f, u, out).azDeg;
    const fr = F(), ur = F();
    // Same forward, the screen rolled 20° about it.
    deviceVectors(0, 100, 0, 0, fr, ur);
    const c = Math.cos(0.35), s = Math.sin(0.35);
    const rx = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
    for (let i = 0; i < 3; i++) ur[i] = u[i] * c + rx[i] * s;
    nearAz(lookOf(fr, ur, out).azDeg, az0, 1e-9, 'roll-free');
    assert.equal(turnAzimuth(Float64Array.from([0, 1, 0]), 90)[0].toFixed(9), '1.000000000');
});

test('aimFilterStep: smooths vectors across 359° ↔ 0° and settles', () => {
    const st = createAimFilter(), f = F(), u = F(), out = { azDeg: 0, altDeg: 0 };
    deviceVectors(1, 100, 0, 0, f, u);           // az 359
    assert.equal(aimFilterStep(st, f, u, 16), 1);
    deviceVectors(359, 100, 0, 0, f, u);         // az 1, across north
    for (let i = 0; i < 4; i++) {
        aimFilterStep(st, f, u, 16);
        const az = lookOf(st.f, st.u, out).azDeg;
        assert.ok(az > 358.9 || az < 1.1, `stays between 359° and 1°: ${az}`);
    }
    for (let i = 0; i < 200; i++) aimFilterStep(st, f, u, 16);
    nearAz(lookOf(st.f, st.u, out).azDeg, 1, 1e-3, 'settled');
    near(st.f[0] * st.u[0] + st.f[1] * st.u[1] + st.f[2] * st.u[2], 0, 1e-12, 'up square to forward');
    // A big turn is followed quickly, a tremor slowly.
    const big = createAimFilter(), small = createAimFilter();
    deviceVectors(0, 90, 0, 0, f, u);
    aimFilterStep(big, f, u, 16);
    aimFilterStep(small, f, u, 16);
    const f2 = F(), u2 = F();
    deviceVectors(330, 90, 0, 0, f2, u2);
    const kBig = aimFilterStep(big, f2, u2, 16);
    deviceVectors(359.7, 90, 0, 0, f2, u2);
    const kSmall = aimFilterStep(small, f2, u2, 16);
    assert.ok(kBig > 3 * kSmall, `${kBig} vs ${kSmall}`);
});

/** A minimal window with an event target, a document and a clock. */
function fakeEnv({ absolute = true } = {}) {
    const listeners = new Map();
    const docListeners = new Map();
    let t = 0;
    const win = {
        DeviceOrientationEvent: function DeviceOrientationEvent() {},
        screen: { orientation: { angle: 0 } },
        document: {
            visibilityState: 'visible',
            addEventListener: (n, fn) => docListeners.set(n, fn),
            removeEventListener: (n) => docListeners.delete(n),
        },
        addEventListener: (n, fn) => listeners.set(n, fn),
        removeEventListener: (n) => listeners.delete(n),
    };
    if (absolute) win.ondeviceorientationabsolute = null;
    const calls = [];
    const rig = {
        aiming: false,
        camera: { fov: 60 },
        setAiming(on) { this.aiming = on; },
        setSkyAim(az, alt) { calls.push([az, alt]); return true; },
    };
    let released = 0;
    const nav = { wakeLock: { request: () => Promise.resolve({ release: () => { released++; return Promise.resolve(); } }) } };
    return {
        win, rig, calls, nav, listeners, docListeners,
        now: () => t, advance: (ms) => { t += ms; },
        fire: (name, e) => listeners.get(name)?.(e),
        get released() { return released; },
    };
}

test('createAim: first reading, deadband, Align, stops', async () => {
    const env = fakeEnv();
    const stops = [];
    const aim = createAim({ win: env.win, nav: env.nav, rig: env.rig, now: env.now, onStop: (r) => stops.push(r) });
    const started = aim.start();
    assert.ok(env.rig.aiming, 'drags suspended');
    assert.ok(env.listeners.has('deviceorientationabsolute'));
    env.advance(16);
    env.fire('deviceorientationabsolute', { alpha: 0, beta: 110, gamma: 0, absolute: true });
    assert.equal(await started, 'ok');
    assert.equal(aim.source, 'compass');
    assert.equal(env.calls.length, 1);
    near(env.calls[0][1], 20, 1e-9, 'alt');
    // The same reading again: under the deadband, nothing sent.
    env.advance(16);
    env.fire('deviceorientationabsolute', { alpha: 0, beta: 110, gamma: 0, absolute: true });
    assert.equal(env.calls.length, 1);
    // Align on a body at azimuth 12°: the offset makes the centre land there.
    assert.ok(Math.abs(aim.align(12) - 12) < 1e-9);
    for (let i = 0; i < 100; i++) {
        env.advance(16);
        env.fire('deviceorientationabsolute', { alpha: 0, beta: 110, gamma: 0, absolute: true });
    }
    nearAz(aim.look.azDeg, 12, 0.1, 'aligned');
    nearAz(env.calls.at(-1)[0], 12, 0.15, 'sent');
    // Hidden page: stops, wake lock released, rig free.
    await Promise.resolve();
    env.win.document.visibilityState = 'hidden';
    env.docListeners.get('visibilitychange')();
    assert.deepEqual(stops, ['hidden']);
    assert.equal(env.rig.aiming, false);
    assert.ok(!env.listeners.has('deviceorientationabsolute'));
    assert.equal(env.released, 1);
    aim.stop('user');
    assert.deepEqual(stops, ['hidden'], 'idempotent');
});

test('createAim: no sensor data, and the idle stop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const env = fakeEnv({ absolute: false });
    const stops = [];
    const aim = createAim({ win: env.win, nav: null, rig: env.rig, now: env.now, onStop: (r) => stops.push(r) });
    const p = aim.start();
    // Desktop Chrome: one event with nulls, then nothing.
    env.fire('deviceorientation', { alpha: null, beta: null, gamma: null });
    t.mock.timers.tick(3100);
    assert.equal(await p, 'nodata');
    assert.deepEqual(stops, ['nodata']);

    const env2 = fakeEnv({ absolute: false });
    const stops2 = [];
    const aim2 = createAim({ win: env2.win, rig: env2.rig, now: env2.now, onStop: (r) => stops2.push(r) });
    const p2 = aim2.start();
    env2.fire('deviceorientation', { alpha: 10, beta: 95, gamma: 0 });
    assert.equal(await p2, 'ok');
    assert.equal(aim2.source, 'relative');
    // A still phone for over two minutes stops aiming.
    env2.advance(AIM_IDLE_MS + 6000);
    t.mock.timers.tick(10000);
    assert.deepEqual(stops2, ['idle']);
});

test('createAim: iOS learns the compass correction while upright', async () => {
    const env = fakeEnv({ absolute: false });
    const aim = createAim({ win: env.win, rig: env.rig, now: env.now });
    const p = aim.start();
    // Relative alpha 0 is really north-east: the compass reads 45° for an upright phone facing it.
    for (let i = 0; i < 60; i++) {
        env.advance(16);
        env.fire('deviceorientation', { alpha: 0, beta: 95, gamma: 0, webkitCompassHeading: 45 });
    }
    assert.equal(await p, 'ok');
    assert.equal(aim.source, 'ios');
    nearAz(aim.look.azDeg, 45, 0.05, 'corrected');
    // Raised high toward the zenith side: the learned correction is kept (the compass is not trusted there).
    for (let i = 0; i < 120; i++) {
        env.advance(16);
        env.fire('deviceorientation', { alpha: 0, beta: 150, gamma: 0, webkitCompassHeading: 225 });
    }
    nearAz(aim.look.azDeg, 45, 0.5, 'kept');
    aim.stop();
});
