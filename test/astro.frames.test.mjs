// Frame contract (SPEC §D): conventions, helpers and every D.5 worked check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AE } from '../js/astro/ae.js';
import * as F from '../js/astro/frames.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import * as THREE from '../vendor/three/three.module.min.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ARCSEC = D2R / 3600;
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomUnit(r) {
    const z = 2 * r() - 1, a = 2 * Math.PI * r(), s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), s * Math.sin(a), z];
}

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const angle = (a, b) => F.angleBetween3(a, b);
const wrapDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

test('aeRotToM3 agrees with AE.RotateVector on random vectors to 1e-15', () => {
    const r = rng(1);
    for (let k = 0; k < 40; k++) {
        const time = AE.MakeTime(new Date(Date.UTC(1950, 0, 1) + r() * 3.2e12));
        const obs = new AE.Observer(180 * r() - 90, 360 * r() - 180, 0);
        for (const rot of [AE.Rotation_EQD_EQJ(time), AE.Rotation_EQJ_HOR(time, obs), AE.Rotation_EQJ_ECL(), AE.Rotation_ECL_EQD(time)]) {
            const M = F.aeRotToM3(rot);
            assert.deepEqual(F.aeRotToM3(rot.rot), M, 'raw rot array accepted too');
            for (let i = 0; i < 5; i++) {
                const v = randomUnit(r).map((x) => x * (0.1 + 3 * r()));
                const a = AE.RotateVector(rot, new AE.Vector(v[0], v[1], v[2], time));
                const b = F.m3vec(M, v);
                assert.ok(Math.abs(a.x - b[0]) <= 1e-15 && Math.abs(a.y - b[1]) <= 1e-15 && Math.abs(a.z - b[2]) <= 1e-15,
                    `mismatch ${a.x - b[0]}, ${a.y - b[1]}, ${a.z - b[2]}`);
            }
        }
    }
});

test('S is orthonormal with determinant +1, and S⁻¹ = Sᵀ maps scene back to EQJ', () => {
    const S = F.S;
    const StS = F.m3mul(F.m3T(S), S);
    for (let i = 0; i < 9; i++) assert.equal(StS[i], i % 4 === 0 ? 1 : 0);
    const det = S[0] * (S[4] * S[8] - S[5] * S[7]) - S[1] * (S[3] * S[8] - S[5] * S[6]) + S[2] * (S[3] * S[7] - S[4] * S[6]);
    assert.equal(det, 1);
    const r = rng(2);
    for (let i = 0; i < 50; i++) {
        const v = randomUnit(r);
        assert.deepEqual(Array.from(F.eqjToScene(v)), Array.from(F.m3vec(S, v)));
        const back = F.sceneToEqj(F.eqjToScene(v));
        for (let c = 0; c < 3; c++) close(back[c], v[c], 1e-15);
    }
    // (x, y, z)_eqj → (x, z, −y)_scene; AE vectors are accepted too.
    assert.deepEqual(Array.from(F.eqjToScene({ x: 1, y: 2, z: 3 })), [1, 3, -2]);
});

test('S·E·Sᵀ with E = Rz(θ) equals three.js rotation.y = θ (and the D.5 lon-0 row)', () => {
    for (const theta of [0, 0.3, 1.2, Math.PI / 2, 2.5, -1.7, 5.9]) {
        const m = F.m3ToSceneM4(F.rotZ(theta));
        const three = new THREE.Matrix4().makeRotationY(theta).elements;
        for (let i = 0; i < 16; i++) close(m[i], three[i], 1e-15, `element ${i}`);
        // D.5: earthMatrix · latLonToLocal(0, 0) = (cosθ, 0, −sinθ)
        const p = F.m4MulDir(m, F.latLonToLocal(0, 0));
        close(p[0], Math.cos(theta), 1e-15);
        close(p[1], 0, 1e-15);
        close(p[2], -Math.sin(theta), 1e-15);
    }
});

test('m3ToSceneM4 embeds translation and equals S·M·Sᵀ for arbitrary rotations', () => {
    const r = rng(3);
    for (let i = 0; i < 20; i++) {
        const M = F.m3mul(F.rotZ(r() * 6), F.m3mul(F.rotX(r() * 6), F.rotZ(r() * 6)));
        const ref = F.m3mul(F.S, F.m3mul(M, F.m3T(F.S)));
        const m4 = F.m3ToSceneM4(M, undefined, 1, 2, 3);
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) close(m4[col * 4 + row], ref[row * 3 + col], 1e-15);
        assert.deepEqual([m4[3], m4[7], m4[11], m4[12], m4[13], m4[14], m4[15]], [0, 0, 0, 1, 2, 3, 1]);
        // Same rotation applied through the EQJ path and the scene path.
        const v = randomUnit(r);
        const viaEqj = F.eqjToScene(F.m3vec(M, v));
        const viaScene = F.m4MulDir(m4, F.eqjToScene(v));
        for (let c = 0; c < 3; c++) close(viaScene[c], viaEqj[c], 1e-14);
        const inv = F.m4MulDirT(m4, viaScene);
        const s = F.eqjToScene(v);
        for (let c = 0; c < 3; c++) close(inv[c], s[c], 1e-14);
    }
});

test('m4ToQuat matches three.js Quaternion.setFromRotationMatrix (up to sign) and rotates identically', () => {
    const r = rng(4);
    const q3 = new THREE.Quaternion();
    for (let i = 0; i < 200; i++) {
        const M = F.m3mul(F.rotZ(r() * 7 - 3), F.m3mul(F.rotX(r() * 7 - 3), F.rotY(r() * 7 - 3)));
        const m4 = F.m3ToSceneM4(M);
        const q = F.m4ToQuat(m4);
        q3.setFromRotationMatrix(new THREE.Matrix4().fromArray(Array.from(m4)));
        const sign = q3.w < 0 ? -1 : 1;
        close(q[0], q3.x * sign, 1e-12);
        close(q[1], q3.y * sign, 1e-12);
        close(q[2], q3.z * sign, 1e-12);
        close(q[3], q3.w * sign, 1e-12);
        assert.ok(q[3] >= 0);
        const v = new THREE.Vector3(...randomUnit(r));
        const a = v.clone().applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
        const b = F.m4MulDir(m4, [v.x, v.y, v.z]);
        close(a.x, b[0], 1e-12);
        close(a.y, b[1], 1e-12);
        close(a.z, b[2], 1e-12);
    }
});

test('matrix helpers are alias-safe', () => {
    const a = F.rotX(0.4), b = F.rotZ(1.1);
    const ref = F.m3mul(a, b);
    const a2 = Float64Array.from(a);
    F.m3mul(a2, b, a2);
    assert.deepEqual(Array.from(a2), Array.from(ref));
    const b2 = Float64Array.from(b);
    F.m3mul(a, b2, b2);
    assert.deepEqual(Array.from(b2), Array.from(ref));
    const t = Float64Array.from(ref);
    F.m3T(t, t);
    assert.deepEqual(Array.from(t), Array.from(F.m3T(ref)));
    const v = Float64Array.from([0.3, -0.5, 0.8]);
    const expect = F.m3vec(ref, v);
    F.m3vec(ref, v, v);
    assert.deepEqual(Array.from(v), Array.from(expect));
    const c = Float64Array.from([1, 2, 3]);
    F.cross3(c, [0, 0, 1], c);
    assert.deepEqual(Array.from(c), [2, -1, 0]);
});

test('latLonToLocal / localToLatLon round trip and match S·EF', () => {
    const r = rng(5);
    for (let i = 0; i < 500; i++) {
        const lat = Math.asin(2 * r() - 1) * R2D, lon = 360 * r() - 180;
        const v = F.latLonToLocal(lat, lon);
        close(F.length3(v), 1, 1e-15);
        const ll = F.localToLatLon(v);
        close(ll.latDeg, lat, 1e-9);
        assert.ok(wrapDiff(ll.lonDeg, lon) < 1e-9);
        const ef = F.latLonToEarthFixed(lat, lon);
        const s = F.eqjToScene(ef); // S·EF (S is frame-agnostic)
        for (let c = 0; c < 3; c++) close(v[c], s[c], 1e-15);
    }
    // SphereGeometry: u = 0.5 (lon 0) at local +X, u = 0.75 (lon 90°E) at local −Z.
    const g = new THREE.SphereGeometry(1, 8, 4);
    const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (Math.abs(y) > 0.99) continue;
        const ll = F.localToLatLon([pos.getX(i), y, pos.getZ(i)]);
        const u = ll.lonDeg / 360 + 0.5;
        assert.ok(Math.abs(((u - uv.getX(i) + 1.5) % 1) - 0.5) < 1e-6, `u mismatch at vertex ${i}`);
        close(ll.latDeg, (uv.getY(i) - 0.5) * 180, 1e-4, 'v ↔ latitude');
    }
});

test('enuLocal is orthonormal, right-handed, north = up × east, defined at the poles', () => {
    const r = rng(6);
    const cases = [[90, 0], [-90, 0], [90, 123], [-90, -45], [0, 0], [0, 180]];
    for (let i = 0; i < 300; i++) cases.push([Math.asin(2 * r() - 1) * R2D, 360 * r() - 180]);
    for (const [lat, lon] of cases) {
        const { east, north, up } = F.enuLocal(lat, lon);
        for (const v of [east, north, up]) close(F.length3(v), 1, 1e-14);
        close(F.dot3(east, north), 0, 1e-14);
        close(F.dot3(east, up), 0, 1e-14);
        close(F.dot3(north, up), 0, 1e-14);
        const n2 = F.cross3(up, east);
        const u2 = F.cross3(east, north);
        for (let c = 0; c < 3; c++) {
            close(n2[c], north[c], 1e-14, 'north = up × east');
            close(u2[c], up[c], 1e-14, 'east × north = up (right-handed)');
        }
        // up equals latLonToLocal; north points toward increasing latitude.
        const p = F.latLonToLocal(lat, lon);
        for (let c = 0; c < 3; c++) close(up[c], p[c], 1e-15);
        if (Math.abs(lat) < 89) {
            const p2 = F.latLonToLocal(lat + 0.5, lon);
            assert.ok(F.dot3([p2[0] - p[0], p2[1] - p[1], p2[2] - p[2]], north) > 0);
            const p3 = F.latLonToLocal(lat, lon + 0.5);
            assert.ok(F.dot3([p3[0] - p[0], p3[1] - p[1], p3[2] - p[2]], east) > 0);
        }
    }
    // Reuses the given output object.
    const o = { east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) };
    assert.equal(F.enuLocal(10, 20, o), o);
});

test('raDecToScene / sceneToRaDec round trip; the pole is +Y; RA 90° is −Z', () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
        const ra = 360 * r(), dec = Math.asin(2 * r() - 1) * R2D;
        const v = F.raDecToScene(ra, dec);
        const rd = F.sceneToRaDec(v);
        assert.ok(wrapDiff(rd.raDeg, ra) < 1e-9);
        close(rd.decDeg, dec, 1e-9);
        assert.ok(rd.raDeg >= 0 && rd.raDeg < 360);
        // Same as converting the EQJ unit vector through S.
        const e = [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];
        const s = F.eqjToScene(e);
        for (let c = 0; c < 3; c++) close(v[c], s[c], 1e-15);
    }
    const pole = F.raDecToScene(0, 90);
    close(pole[0], 0, 1e-15);
    close(pole[1], 1, 1e-15);
    close(pole[2], 0, 1e-15);
    const v90 = F.raDecToScene(90, 0);
    close(v90[2], -1, 1e-15);
    // A Float32Array out works (catalog decoding writes straight into packed buffers).
    const f32 = new Float32Array(6);
    F.raDecToScene(45, 10, f32.subarray(3, 6));
    close(f32[3], Math.cos(10 * D2R) * Math.cos(45 * D2R), 1e-7);
});

test('eclipticToScene: λ = 90° lies 23.44° north of the equator; the ecliptic pole is at RA 18h, Dec 66.56°', () => {
    const rd = F.sceneToRaDec(F.eclipticToScene(90, 0));
    close(rd.raDeg, 90, 1e-9);
    close(rd.decDeg, F.OBLIQUITY_J2000_DEG, 1e-9);
    const pole = F.sceneToRaDec(F.eclipticToScene(0, 90));
    close(pole.raDeg, 270, 1e-9);
    close(pole.decDeg, 90 - F.OBLIQUITY_J2000_DEG, 1e-9);
    // Matches astronomy-engine's ECL→EQJ rotation exactly (same J2000 obliquity).
    const rot = F.aeRotToM3(AE.Rotation_ECL_EQJ());
    const l = 123 * D2R, b = 4 * D2R;
    const ref = F.eqjToScene(F.m3vec(rot, [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)]));
    const got = F.eclipticToScene(123, 4);
    for (let c = 0; c < 3; c++) close(got[c], ref[c], 1e-11); // AE hard-codes cos/sin to 16 digits
    close(F.OBLIQUITY_J2000_DEG, 23.4392911, 0.05 / 3600, 'within 0.05″ of the IAU 1976 value');
});

test('dirToAltAz: zenith, horizon points and azimuth convention (N = 0, E = 90)', () => {
    const { east, north, up } = F.enuLocal(35, 20);
    close(F.dirToAltAz(up, up, north, east).altDeg, 90, 1e-9);
    const n = F.dirToAltAz(north, up, north, east);
    close(n.altDeg, 0, 1e-12);
    close(n.azDeg, 0, 1e-12);
    close(F.dirToAltAz(east, up, north, east).azDeg, 90, 1e-12);
    close(F.dirToAltAz([-east[0], -east[1], -east[2]], up, north, east).azDeg, 270, 1e-12);
    const d = [north[0] + up[0], north[1] + up[1], north[2] + up[2]];
    close(F.dirToAltAz(d, up, north, east).altDeg, 45, 1e-12, 'non-unit input');
});

test('iauBodyMatrix: body pole → (α0, δ0); prime meridian at W = 0 → node at α0 + 90°; proper rotation', () => {
    const r = rng(8);
    for (let i = 0; i < 100; i++) {
        const raH = 24 * r(), dec = 180 * r() - 90, w = 720 * r() - 360;
        const R = F.iauBodyMatrix(raH, dec, w);
        const pole = F.m3vec(R, [0, 0, 1]);
        const pe = [Math.cos(dec * D2R) * Math.cos(raH * 15 * D2R), Math.cos(dec * D2R) * Math.sin(raH * 15 * D2R), Math.sin(dec * D2R)];
        for (let c = 0; c < 3; c++) close(pole[c], pe[c], 1e-14);
        const RtR = F.m3mul(F.m3T(R), R);
        for (let k = 0; k < 9; k++) close(RtR[k], k % 4 === 0 ? 1 : 0, 1e-14);
        const ref = F.m3mul(F.rotZ((90 + raH * 15) * D2R), F.m3mul(F.rotX((90 - dec) * D2R), F.rotZ(w * D2R)));
        for (let k = 0; k < 9; k++) close(R[k], ref[k], 1e-14);
        const node = F.m3vec(F.iauBodyMatrix(raH, dec, 0), [1, 0, 0]);
        const a = (raH * 15 + 90) * D2R;
        close(node[0], Math.cos(a), 1e-14);
        close(node[1], Math.sin(a), 1e-14);
        close(node[2], 0, 1e-14);
    }
});

test('raySphere: front hit, miss, inside, tangent and degenerate direction', () => {
    close(F.raySphere([0, 0, 5], [0, 0, -1], 1), 4, 1e-15);
    close(F.raySphere([0, 0, 5], [0, 0, -2], 1), 2, 1e-15, 'non-unit direction scales t');
    assert.equal(F.raySphere([0, 0, 5], [0, 0, 1], 1), -1, 'pointing away');
    assert.equal(F.raySphere([0, 2, 5], [0, 0, -1], 1), -1, 'miss');
    close(F.raySphere([0, 0, 0.5], [0, 0, 1], 1), 0.5, 1e-15, 'inside → exit');
    close(F.raySphere([1, 0, 5], [0, 0, -1], 1), 5, 1e-7, 'tangent');
    assert.equal(F.raySphere([0, 0, 5], [0, 0, 0], 1), -1);
    // Moon-distance ray grazing Earth, as the flare/eclipse code uses it.
    const t = F.raySphere([0, 0.99, 60], [0, 0, -1], 1);
    close(t, 60 - Math.sqrt(1 - 0.99 * 0.99), 1e-12);
});

test('wrap helpers', () => {
    assert.equal(F.wrap360(-1e-17), 0);
    assert.equal(F.wrap360(720), 0);
    close(F.wrap360(-90), 270, 0);
    close(F.wrap180(190), -170, 1e-12);
    close(F.wrap180(-190), 170, 1e-12);
    assert.equal(F.wrap180(180), -180);
});

test('toAeTime accepts Unix ms, Date and AstroTime', () => {
    const ms = Date.UTC(2026, 9, 11, 12);
    const a = F.toAeTime(ms), b = F.toAeTime(new Date(ms));
    assert.equal(a.ut, b.ut);
    assert.equal(F.toAeTime(a), a);
    close(a.ut, (ms - Date.UTC(2000, 0, 1, 12)) / 864e5, 1e-12);
    assert.throws(() => F.toAeTime(NaN), TypeError);
    assert.throws(() => F.toAeTime('2026'), TypeError);
});

// ---------------------------------------------------------------------------
// D.5 worked sanity checks
// ---------------------------------------------------------------------------

test('D.5 SiderealTime(2026-06-21T12:00Z) = 5.98009 h, and earthFixedToEqj reports the same GAST', () => {
    const t = Date.parse('2026-06-21T12:00:00Z');
    close(AE.SiderealTime(new Date(t)), 5.98009, 1e-4);
    const E = new Float64Array(9);
    const { gastDeg } = F.earthFixedToEqj(t, E);
    close(gastDeg / 15, 5.98009, 1e-4);
    const EtE = F.m3mul(F.m3T(E), E);
    for (let k = 0; k < 9; k++) close(EtE[k], k % 4 === 0 ? 1 : 0, 1e-14);
});

for (const [iso, lat, lon, tolLat, tolLon] of [
    ['2026-06-21T12:00:00Z', 23.438, 0.454, 0.01, 0.01],
    ['2026-03-20T14:46:00Z', 0.0, -39.65, 0.01, 0.02],
    ['2026-12-21T00:00:00Z', -23.434, 179.454, 0.01, 0.01],
]) {
    test(`D.5 subsolar point ${iso}: localToLatLon(earthMatrixᵀ·sunDirS) = ${lat}°, ${lon}°`, () => {
        const snap = computeSnapshot(Date.parse(iso), { latDeg: 51.4769, lonDeg: -0.0005, elevM: 0 }, createSnapshot());
        const ll = F.localToLatLon(F.m4MulDirT(snap.earthMatrix, snap.sunDirS));
        close(ll.latDeg, lat, tolLat, 'latitude');
        assert.ok(wrapDiff(ll.lonDeg, lon) <= tolLon, `longitude expected ${lon} ± ${tolLon}, got ${ll.lonDeg}`);
        // The snapshot's own sub-point fields agree.
        close(snap.bodies[0].subLatDeg, ll.latDeg, 1e-12);
        close(snap.bodies[0].subLonDeg, ll.lonDeg, 1e-12);
    });
}

// Shared random cases: 300 samples, 1900–2150, random observers, 5 bodies.
function* randomSkyCases(seed, n) {
    const r = rng(seed);
    const bodies = ['Sun', 'Moon', 'Mars', 'Jupiter', 'Venus'];
    for (let k = 0; k < n; k++) {
        const ms = Date.UTC(1900, 0, 1) + r() * (Date.UTC(2150, 0, 1) - Date.UTC(1900, 0, 1));
        yield { ms, lat: Math.asin(2 * r() - 1) * R2D, lon: 360 * r() - 180, body: bodies[k % 5] };
    }
}

test('D.5 zenith: |E·EF_up − zenith(Rotation_EQJ_HOR)| < 0.05″ over 300 random samples', () => {
    const E = new Float64Array(9);
    let worst = 0;
    for (const c of randomSkyCases(11, 300)) {
        const time = AE.MakeTime(new Date(c.ms));
        F.earthFixedToEqj(time, E);
        const up = F.m3vec(E, F.latLonToEarthFixed(c.lat, c.lon));
        const H = F.aeRotToM3(AE.Rotation_EQJ_HOR(time, new AE.Observer(c.lat, c.lon, 0)));
        worst = Math.max(worst, angle(up, [H[6], H[7], H[8]]));
    }
    assert.ok(worst < 0.05 * ARCSEC, `worst ${worst / ARCSEC}″`);
});

test('D.5 rendered alt/az: asin(dirS·upS) vs unrefracted Horizon() < 30″; az·cos(alt) < 30″ for alt < 80°', () => {
    const E = new Float64Array(9);
    const m4 = new Float64Array(16);
    const enu = { east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) };
    const up = new Float64Array(3), north = new Float64Array(3), east = new Float64Array(3);
    let worstAlt = 0, worstAz = 0;
    for (const c of randomSkyCases(12, 300)) {
        const time = AE.MakeTime(new Date(c.ms));
        const obs = new AE.Observer(c.lat, c.lon, 0);
        F.earthFixedToEqj(time, E);
        F.m3ToSceneM4(E, m4);
        F.enuLocal(c.lat, c.lon, enu);
        F.m4MulDir(m4, enu.up, up);
        F.m4MulDir(m4, enu.north, north);
        F.m4MulDir(m4, enu.east, east);
        const eq = AE.Equator(c.body, time, obs, false, false);
        const dirS = F.normalize3(F.eqjToScene(eq.vec));
        const aa = F.dirToAltAz(dirS, up, north, east);
        const eqd = AE.Equator(c.body, time, obs, true, true);
        const hor = AE.Horizon(time, obs, eqd.ra, eqd.dec, undefined);
        worstAlt = Math.max(worstAlt, Math.abs(aa.altDeg - hor.altitude) * 3600);
        if (hor.altitude < 80) worstAz = Math.max(worstAz, wrapDiff(aa.azDeg, hor.azimuth) * 3600 * Math.cos(hor.altitude * D2R));
    }
    assert.ok(worstAlt < 30, `worst altitude error ${worstAlt.toFixed(2)}″`);
    assert.ok(worstAz < 30, `worst azimuth·cos(alt) error ${worstAz.toFixed(2)}″`);
});

test('D.5 Sirius (HIP 32349): raw d3-celestial position round-trips through the scene frame to 0.001°', () => {
    const raw = JSON.parse(fs.readFileSync(root('data/raw/stars.6.json'), 'utf8'));
    const sirius = raw.features.find((f) => f.id === 32349);
    const [lon, lat] = sirius.geometry.coordinates;
    const rd = F.sceneToRaDec(F.raDecToScene((lon + 360) % 360, lat));
    close(rd.raDeg, 101.287, 0.001);
    close(rd.decDeg, -16.716, 0.001);
});

test('D.5 Sirius via decodeSky(data/sky.json) → sceneToRaDec = RA 101.287°, Dec −16.716°', async (t) => {
    if (!fs.existsSync(root('js/data/catalog.js')) || !fs.existsSync(root('data/sky.json'))) {
        t.skip('js/data/catalog.js or data/sky.json not present yet');
        return;
    }
    const { decodeSky } = await import('../js/data/catalog.js');
    const sky = decodeSky(JSON.parse(fs.readFileSync(root('data/sky.json'), 'utf8')));
    const i = Array.from(sky.stars.hip).indexOf(32349);
    assert.ok(i >= 0, 'Sirius present');
    const d = sky.stars.dirS;
    const rd = F.sceneToRaDec([d[3 * i], d[3 * i + 1], d[3 * i + 2]]);
    close(rd.raDeg, 101.287, 0.001);
    close(rd.decDeg, -16.716, 0.001);
});

test('D.5 Constellation(5.919 h, 7.407°) = Ori', () => {
    assert.equal(AE.Constellation(5.919, 7.407).symbol, 'Ori');
});

test('D.5 next global solar eclipse after 2026-10-11: annular, 2027-02-06 ~16:00Z near −31.3°, −48.5°; the snapshot shadow lands there', () => {
    const ge = AE.SearchGlobalSolarEclipse(AE.MakeTime(new Date('2026-10-11T00:00:00Z')));
    assert.equal(ge.kind, 'annular');
    assert.ok(Math.abs(ge.peak.date.getTime() - Date.parse('2027-02-06T16:00:00Z')) < 3600e3);
    close(ge.latitude, -31.3, 0.5);
    close(ge.longitude, -48.5, 0.5);
    // Frame consistency: the Moon's shadow axis (moonPosS along −sunDirS) hits the
    // rendered unit sphere within 0.5° of astronomy-engine's greatest-eclipse point.
    const snap = computeSnapshot(ge.peak.date.getTime(), { latDeg: ge.latitude, lonDeg: ge.longitude, elevM: 0 }, createSnapshot(), { detail: 'full' });
    const d = [-snap.sunDirS[0], -snap.sunDirS[1], -snap.sunDirS[2]];
    const t = F.raySphere(snap.moonPosS, d, 1);
    assert.ok(t > 0, 'shadow axis hits the Earth');
    const hit = [snap.moonPosS[0] + d[0] * t, snap.moonPosS[1] + d[1] * t, snap.moonPosS[2] + d[2] * t];
    const ll = F.localToLatLon(F.m4MulDirT(snap.earthMatrix, hit));
    close(ll.latDeg, ge.latitude, 0.5);
    close(ll.lonDeg, ge.longitude, 0.5);
    assert.equal(snap.eclipse.solar, true);
    assert.ok(snap.eclipse.obscurationAtObserver > 0.8 && snap.eclipse.obscurationAtObserver < 1, `annular obscuration ${snap.eclipse.obscurationAtObserver}`);
});
