/**
 * Coordinate-frame contract (SPEC §D). Every render group relies on these
 * exact conventions, so they are small, allocation-free when given `out`, and
 * covered by test/astro.frames.test.mjs.
 *
 * Frames:
 *  - EQJ   J2000 mean equator/equinox (astronomy-engine's native frame), +z = north celestial pole.
 *  - EF    Earth-fixed: +x = (lat 0, lon 0), +y = lon 90°E, +z = north pole.
 *  - Scene three.js world, +Y = J2000 north pole, 1 unit = Earth equatorial radius.
 *          scene = S·eqj, i.e. (x, y, z)_eqj → (x, z, −y)_scene.
 *  - Local THREE.SphereGeometry vertex frame of the Earth/Moon meshes; equals S·EF.
 *
 * Storage conventions (R7): vectors are Float64Array(3) (any indexable works),
 * 3×3 matrices are row-major Float64Array(9), matrices for three.js are
 * column-major Float64Array(16) ready for `Matrix4.fromArray`.
 *
 * @module astro/frames
 */
import { AE } from './ae.js';

/** Degrees → radians factor. */
export const DEG2RAD = Math.PI / 180;
/** Radians → degrees factor. */
export const RAD2DEG = 180 / Math.PI;
/**
 * Mean obliquity of the J2000 ecliptic in degrees: 84381.406″ (IAU 2006), the
 * value behind AE.Rotation_EQJ_ECL. (The IAU 1976 figure 23.4392911° differs
 * by 0.04″, far below anything visible.)
 */
export const OBLIQUITY_J2000_DEG = 84381.406 / 3600;

const COS_OBL = Math.cos(OBLIQUITY_J2000_DEG * DEG2RAD);
const SIN_OBL = Math.sin(OBLIQUITY_J2000_DEG * DEG2RAD);

/**
 * The EQJ → scene rotation, row-major: scene = S·eqj. A proper rotation
 * (−90° about X), so S⁻¹ = Sᵀ.
 * @type {Float64Array}
 */
export const S = new Float64Array([1, 0, 0, 0, 0, 1, 0, -1, 0]);

// ---------------------------------------------------------------------------
// Angles and small vector helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an angle into [0, 360).
 * @param {number} deg
 * @returns {number}
 */
export function wrap360(deg) {
    let x = deg % 360;
    if (x < 0) x += 360;
    // A tiny negative input rounds to exactly 360 after the addition; fold it back.
    return x >= 360 ? 0 : x;
}

/**
 * Wraps an angle into [−180, 180).
 * @param {number} deg
 * @returns {number}
 */
export function wrap180(deg) {
    return wrap360(deg + 180) - 180;
}

/**
 * Dot product of two 3-vectors.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Cross product a × b. Safe when `out` aliases an input.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function cross3(a, b, out = new Float64Array(3)) {
    const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}

/**
 * Euclidean length of a 3-vector.
 * @param {ArrayLike<number>} v
 * @returns {number}
 */
export function length3(v) {
    return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Normalises a 3-vector. A zero vector is returned unchanged (as zeros).
 * @param {ArrayLike<number>} v
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function normalize3(v, out = new Float64Array(3)) {
    const x = v[0], y = v[1], z = v[2];
    const len = Math.hypot(x, y, z);
    const k = len > 0 ? 1 / len : 0;
    out[0] = x * k;
    out[1] = y * k;
    out[2] = z * k;
    return out;
}

/**
 * Angle between two vectors in radians, using atan2(|a×b|, a·b), which keeps
 * full precision for tiny and near-180° angles (acos does not).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} Angle in [0, π].
 */
export function angleBetween3(a, b) {
    const cx = a[1] * b[2] - a[2] * b[1];
    const cy = a[2] * b[0] - a[0] * b[2];
    const cz = a[0] * b[1] - a[1] * b[0];
    return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

/**
 * Converts a time given as Unix milliseconds, a Date, or an AE.AstroTime into
 * an AE.AstroTime. Numbers are always Unix ms (the app-wide convention), never
 * astronomy-engine's "days since J2000".
 * @param {number|Date|object} t
 * @returns {object} AE.AstroTime
 */
export function toAeTime(t) {
    if (t instanceof AE.AstroTime) return t;
    if (t instanceof Date) return AE.MakeTime(t);
    if (typeof t === 'number' && Number.isFinite(t)) return AE.MakeTime(new Date(t));
    throw new TypeError(`Expected Unix ms, Date or AstroTime, got ${typeof t === 'number' ? t : typeof t}`);
}

// ---------------------------------------------------------------------------
// EQJ ⇄ scene, RA/Dec
// ---------------------------------------------------------------------------

/**
 * EQJ vector → scene vector: (x, y, z) → (x, z, −y). Accepts an indexable
 * vector or an object with x/y/z (e.g. an AE.Vector). Alias-safe.
 * @param {ArrayLike<number>|{x:number,y:number,z:number}} v
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function eqjToScene(v, out = new Float64Array(3)) {
    let x, y, z;
    if (v.x !== undefined) { x = v.x; y = v.y; z = v.z; } else { x = v[0]; y = v[1]; z = v[2]; }
    out[0] = x;
    out[1] = z;
    out[2] = -y;
    return out;
}

/**
 * Scene vector → EQJ vector: (xs, ys, zs) → (xs, −zs, ys). Alias-safe.
 * @param {ArrayLike<number>} v
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function sceneToEqj(v, out = new Float64Array(3)) {
    const x = v[0], y = v[1], z = v[2];
    out[0] = x;
    out[1] = -z;
    out[2] = y;
    return out;
}

/**
 * J2000 right ascension/declination (degrees) → scene unit vector
 * (cosδ·cosα, sinδ, −cosδ·sinα).
 * @param {number} raDeg
 * @param {number} decDeg
 * @param {Float64Array|Float32Array|number[]} [out]
 * @returns {Float64Array|Float32Array|number[]}
 */
export function raDecToScene(raDeg, decDeg, out = new Float64Array(3)) {
    const a = raDeg * DEG2RAD;
    const d = decDeg * DEG2RAD;
    const cd = Math.cos(d);
    out[0] = cd * Math.cos(a);
    out[1] = Math.sin(d);
    out[2] = -cd * Math.sin(a);
    return out;
}

/**
 * Scene direction → J2000 RA in [0, 360) and Dec in [−90, 90], degrees.
 * The vector need not be normalised.
 * @param {ArrayLike<number>} v
 * @param {{raDeg:number, decDeg:number}} [out]
 * @returns {{raDeg:number, decDeg:number}}
 */
export function sceneToRaDec(v, out = { raDeg: 0, decDeg: 0 }) {
    const x = v[0], y = v[1], z = v[2];
    out.raDeg = wrap360(Math.atan2(-z, x) * RAD2DEG);
    out.decDeg = Math.atan2(y, Math.hypot(x, z)) * RAD2DEG;
    return out;
}

/**
 * J2000 ecliptic longitude/latitude (degrees) → scene unit vector.
 * Handy for drawing the ecliptic great circle.
 * @param {number} lonDeg
 * @param {number} [latDeg=0]
 * @param {Float64Array|Float32Array|number[]} [out]
 * @returns {Float64Array|Float32Array|number[]}
 */
export function eclipticToScene(lonDeg, latDeg = 0, out = new Float64Array(3)) {
    const l = lonDeg * DEG2RAD, b = latDeg * DEG2RAD, cb = Math.cos(b);
    const xe = cb * Math.cos(l), ye = cb * Math.sin(l), ze = Math.sin(b);
    const y = ye * COS_OBL - ze * SIN_OBL; // ecliptic → EQJ is a rotation of +ε about X
    const z = ye * SIN_OBL + ze * COS_OBL;
    out[0] = xe;
    out[1] = z;
    out[2] = -y;
    return out;
}

// ---------------------------------------------------------------------------
// 3×3 row-major matrices
// ---------------------------------------------------------------------------

/**
 * Converts an astronomy-engine RotationMatrix (or its raw `rot` array) into a
 * row-major 3×3. AE's RotateVector computes x' = rot[0][0]x + rot[1][0]y + …,
 * so `rot` is indexed [column][row] and M[i*3+j] = rot[j][i].
 * @param {{rot:number[][]}|number[][]} aeRot
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function aeRotToM3(aeRot, out = new Float64Array(9)) {
    const r = aeRot && aeRot.rot ? aeRot.rot : aeRot;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) out[i * 3 + j] = r[j][i];
    }
    return out;
}

/**
 * Matrix product a·b of row-major 3×3 matrices. `out` may alias a or b.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function m3mul(a, b, out = new Float64Array(9)) {
    const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
    const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8];
    out[0] = a0 * b0 + a1 * b3 + a2 * b6;
    out[1] = a0 * b1 + a1 * b4 + a2 * b7;
    out[2] = a0 * b2 + a1 * b5 + a2 * b8;
    out[3] = a3 * b0 + a4 * b3 + a5 * b6;
    out[4] = a3 * b1 + a4 * b4 + a5 * b7;
    out[5] = a3 * b2 + a4 * b5 + a5 * b8;
    out[6] = a6 * b0 + a7 * b3 + a8 * b6;
    out[7] = a6 * b1 + a7 * b4 + a8 * b7;
    out[8] = a6 * b2 + a7 * b5 + a8 * b8;
    return out;
}

/**
 * Matrix–vector product m·v (row-major 3×3). `out` may alias v.
 * @param {ArrayLike<number>} m
 * @param {ArrayLike<number>} v
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function m3vec(m, v, out = new Float64Array(3)) {
    const x = v[0], y = v[1], z = v[2];
    out[0] = m[0] * x + m[1] * y + m[2] * z;
    out[1] = m[3] * x + m[4] * y + m[5] * z;
    out[2] = m[6] * x + m[7] * y + m[8] * z;
    return out;
}

/**
 * Transpose of a row-major 3×3. `out` may alias m.
 * @param {ArrayLike<number>} m
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function m3T(m, out = new Float64Array(9)) {
    const m1 = m[1], m2 = m[2], m5 = m[5];
    out[0] = m[0];
    out[4] = m[4];
    out[8] = m[8];
    out[1] = m[3];
    out[3] = m1;
    out[2] = m[6];
    out[6] = m2;
    out[5] = m[7];
    out[7] = m5;
    return out;
}

/**
 * Active rotation about Z: [c, −s, 0; s, c, 0; 0, 0, 1].
 * @param {number} rad
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function rotZ(rad, out = new Float64Array(9)) {
    const c = Math.cos(rad), s = Math.sin(rad);
    out[0] = c; out[1] = -s; out[2] = 0;
    out[3] = s; out[4] = c; out[5] = 0;
    out[6] = 0; out[7] = 0; out[8] = 1;
    return out;
}

/**
 * Active rotation about X: [1, 0, 0; 0, c, −s; 0, s, c].
 * @param {number} rad
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function rotX(rad, out = new Float64Array(9)) {
    const c = Math.cos(rad), s = Math.sin(rad);
    out[0] = 1; out[1] = 0; out[2] = 0;
    out[3] = 0; out[4] = c; out[5] = -s;
    out[6] = 0; out[7] = s; out[8] = c;
    return out;
}

/**
 * Active rotation about Y: [c, 0, s; 0, 1, 0; −s, 0, c] (three.js convention).
 * @param {number} rad
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function rotY(rad, out = new Float64Array(9)) {
    const c = Math.cos(rad), s = Math.sin(rad);
    out[0] = c; out[1] = 0; out[2] = s;
    out[3] = 0; out[4] = 1; out[5] = 0;
    out[6] = -s; out[7] = 0; out[8] = c;
    return out;
}

// ---------------------------------------------------------------------------
// Earth orientation
// ---------------------------------------------------------------------------

/**
 * Allocation-light core of {@link earthFixedToEqj}: writes E = PN·Rz(GAST)
 * (EF → EQJ, row-major) into `out` and returns GAST in degrees.
 * PN = Rotation_EQD_EQJ (inverse nutation then precession); GAST is the
 * apparent sidereal time, measured from the true equinox of date.
 * @param {object} time AE.AstroTime (UT-based)
 * @param {Float64Array} out
 * @returns {number} GAST in degrees, [0, 360).
 */
export function earthRotationM3(time, out) {
    const gastDeg = AE.SiderealTime(time) * 15;
    const r = AE.Rotation_EQD_EQJ(time).rot;
    const g = gastDeg * DEG2RAD;
    const c = Math.cos(g), s = Math.sin(g);
    // PN[i][k] = r[k][i];  E[i][0] = PN[i][0]c + PN[i][1]s;  E[i][1] = −PN[i][0]s + PN[i][1]c;  E[i][2] = PN[i][2]
    for (let i = 0; i < 3; i++) {
        const p0 = r[0][i], p1 = r[1][i], p2 = r[2][i];
        out[i * 3] = p0 * c + p1 * s;
        out[i * 3 + 1] = p1 * c - p0 * s;
        out[i * 3 + 2] = p2;
    }
    return gastDeg;
}

/**
 * Earth orientation matrix E(t) = PN·Rz(GAST), mapping Earth-fixed vectors to
 * EQJ. Polar motion is ignored.
 * @param {number|Date|object} time Unix ms, Date or AE.AstroTime (UT).
 * @param {Float64Array} [out] Row-major 3×3 receiving E.
 * @returns {{gastDeg:number}}
 */
export function earthFixedToEqj(time, out = new Float64Array(9)) {
    return { gastDeg: earthRotationM3(toAeTime(time), out) };
}

/**
 * Embeds S·M·Sᵀ (M given in EQJ terms, row-major) into a column-major 4×4 for
 * three.js, with an optional translation. For M = E(t) this is the Earth
 * group's matrix (geometry-local → world); with E = Rz(θ) it equals three's
 * `rotation.y = θ`.
 * @param {ArrayLike<number>} m Row-major 3×3 rotation expressed in EQJ.
 * @param {Float64Array} [out16]
 * @param {number} [tx=0]
 * @param {number} [ty=0]
 * @param {number} [tz=0]
 * @returns {Float64Array}
 */
export function m3ToSceneM4(m, out16 = new Float64Array(16), tx = 0, ty = 0, tz = 0) {
    // S rows pick (x, z, −y), so (S·M·Sᵀ)ij = s_iᵀ·M·s_j with s0 = e0, s1 = e2, s2 = −e1.
    const r00 = m[0], r01 = m[2], r02 = -m[1];
    const r10 = m[6], r11 = m[8], r12 = -m[7];
    const r20 = -m[3], r21 = -m[5], r22 = m[4];
    out16[0] = r00; out16[1] = r10; out16[2] = r20; out16[3] = 0;
    out16[4] = r01; out16[5] = r11; out16[6] = r21; out16[7] = 0;
    out16[8] = r02; out16[9] = r12; out16[10] = r22; out16[11] = 0;
    out16[12] = tx; out16[13] = ty; out16[14] = tz; out16[15] = 1;
    return out16;
}

/**
 * Rotation part of a column-major 4×4 → unit quaternion (x, y, z, w), using
 * the same branch structure as three's Quaternion.setFromRotationMatrix.
 * The sign is canonicalised to w ≥ 0.
 * @param {ArrayLike<number>} m16
 * @param {Float64Array} [out4]
 * @returns {Float64Array}
 */
export function m4ToQuat(m16, out4 = new Float64Array(4)) {
    const m11 = m16[0], m12 = m16[4], m13 = m16[8];
    const m21 = m16[1], m22 = m16[5], m23 = m16[9];
    const m31 = m16[2], m32 = m16[6], m33 = m16[10];
    const trace = m11 + m22 + m33;
    let x, y, z, w, s;
    if (trace > 0) {
        s = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / s;
        x = (m32 - m23) * s;
        y = (m13 - m31) * s;
        z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
        s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        w = (m32 - m23) / s;
        x = 0.25 * s;
        y = (m12 + m21) / s;
        z = (m13 + m31) / s;
    } else if (m22 > m33) {
        s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        w = (m13 - m31) / s;
        x = (m12 + m21) / s;
        y = 0.25 * s;
        z = (m23 + m32) / s;
    } else {
        s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        w = (m21 - m12) / s;
        x = (m13 + m31) / s;
        y = (m23 + m32) / s;
        z = 0.25 * s;
    }
    const k = (w < 0 ? -1 : 1) / Math.hypot(x, y, z, w);
    out4[0] = x * k;
    out4[1] = y * k;
    out4[2] = z * k;
    out4[3] = w * k;
    return out4;
}

/**
 * Applies the rotation part of a column-major 4×4 to a direction: R·v.
 * @param {ArrayLike<number>} m16
 * @param {ArrayLike<number>} v
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function m4MulDir(m16, v, out = new Float64Array(3)) {
    const x = v[0], y = v[1], z = v[2];
    out[0] = m16[0] * x + m16[4] * y + m16[8] * z;
    out[1] = m16[1] * x + m16[5] * y + m16[9] * z;
    out[2] = m16[2] * x + m16[6] * y + m16[10] * z;
    return out;
}

/**
 * Applies the inverse (transpose) of the rotation part of a column-major 4×4:
 * Rᵀ·v. With `snap.earthMatrix` this turns a scene direction into Earth
 * geometry-local coordinates (then {@link localToLatLon}).
 * @param {ArrayLike<number>} m16
 * @param {ArrayLike<number>} v
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function m4MulDirT(m16, v, out = new Float64Array(3)) {
    const x = v[0], y = v[1], z = v[2];
    out[0] = m16[0] * x + m16[1] * y + m16[2] * z;
    out[1] = m16[4] * x + m16[5] * y + m16[6] * z;
    out[2] = m16[8] * x + m16[9] * y + m16[10] * z;
    return out;
}

// ---------------------------------------------------------------------------
// Latitude/longitude on the unit sphere
// ---------------------------------------------------------------------------

/**
 * Geodetic lat/lon → Earth-fixed unit vector (cosφcosλ, cosφsinλ, sinφ).
 * On the rendered unit sphere this is also the WGS84 geodetic zenith.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function latLonToEarthFixed(latDeg, lonDeg, out = new Float64Array(3)) {
    const p = latDeg * DEG2RAD, l = lonDeg * DEG2RAD, cp = Math.cos(p);
    out[0] = cp * Math.cos(l);
    out[1] = cp * Math.sin(l);
    out[2] = Math.sin(p);
    return out;
}

/**
 * Lat/lon → Earth geometry-local unit vector (cosφ·cosλ, sinφ, −cosφ·sinλ),
 * i.e. S·EF. Matches THREE.SphereGeometry with an equirectangular texture
 * (u = 0.5 at lon 0, u = 0.75 at lon 90°E).
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function latLonToLocal(latDeg, lonDeg, out = new Float64Array(3)) {
    const p = latDeg * DEG2RAD, l = lonDeg * DEG2RAD, cp = Math.cos(p);
    out[0] = cp * Math.cos(l);
    out[1] = Math.sin(p);
    out[2] = -cp * Math.sin(l);
    return out;
}

/**
 * Earth geometry-local vector → lat in [−90, 90], lon in (−180, 180], degrees.
 * The vector need not be normalised.
 * @param {ArrayLike<number>} v
 * @param {{latDeg:number, lonDeg:number}} [out]
 * @returns {{latDeg:number, lonDeg:number}}
 */
export function localToLatLon(v, out = { latDeg: 0, lonDeg: 0 }) {
    const x = v[0], y = v[1], z = v[2];
    out.latDeg = Math.atan2(y, Math.hypot(x, z)) * RAD2DEG;
    out.lonDeg = Math.atan2(-z, x) * RAD2DEG;
    return out;
}

/**
 * Local east/north/up unit vectors at a lat/lon, in Earth geometry-local
 * coordinates. up = latLonToLocal(φ, λ); east = (−sinλ, 0, −cosλ), which is
 * normalize(up.z, 0, −up.x) and stays defined at the poles; north = up × east.
 * Multiply by the Earth matrix to get scene vectors.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {{east:Float64Array, north:Float64Array, up:Float64Array}} [out] Reused when given.
 * @returns {{east:Float64Array, north:Float64Array, up:Float64Array}}
 */
export function enuLocal(latDeg, lonDeg, out) {
    const o = out || { east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) };
    const p = latDeg * DEG2RAD, l = lonDeg * DEG2RAD;
    const sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    o.up[0] = cp * cl; o.up[1] = sp; o.up[2] = -cp * sl;
    o.east[0] = -sl; o.east[1] = 0; o.east[2] = -cl;
    o.north[0] = -sp * cl; o.north[1] = cp; o.north[2] = sp * sl;
    return o;
}

/**
 * Direction → altitude/azimuth against a local frame (all in the same frame,
 * e.g. scene). alt = asin(d·up) (computed via atan2 for robustness);
 * az = atan2(d·east, d·north), wrapped to [0, 360), measured from north
 * through east. No refraction.
 * @param {ArrayLike<number>} dirS
 * @param {ArrayLike<number>} upS
 * @param {ArrayLike<number>} northS
 * @param {ArrayLike<number>} eastS
 * @param {{altDeg:number, azDeg:number}} [out]
 * @returns {{altDeg:number, azDeg:number}}
 */
export function dirToAltAz(dirS, upS, northS, eastS, out = { altDeg: 0, azDeg: 0 }) {
    const du = dot3(dirS, upS), dn = dot3(dirS, northS), de = dot3(dirS, eastS);
    out.altDeg = Math.atan2(du, Math.hypot(dn, de)) * RAD2DEG;
    out.azDeg = wrap360(Math.atan2(de, dn) * RAD2DEG);
    return out;
}

/**
 * IAU body-fixed → EQJ rotation, row-major:
 * R = Rz(90° + α0)·Rx(90° − δ0)·Rz(W), from AE.RotationAxis (ra in hours).
 * Body-fixed +x is the prime meridian, +z the body's north pole.
 * @param {number} raH Right ascension of the north pole, hours.
 * @param {number} decDeg Declination of the north pole, degrees.
 * @param {number} spinDeg Prime-meridian angle W, degrees.
 * @param {Float64Array} [out9]
 * @returns {Float64Array}
 */
export function iauBodyMatrix(raH, decDeg, spinDeg, out9 = new Float64Array(9)) {
    const a = (90 + raH * 15) * DEG2RAD, b = (90 - decDeg) * DEG2RAD, w = spinDeg * DEG2RAD;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cw = Math.cos(w), sw = Math.sin(w);
    out9[0] = ca * cw - sa * cb * sw;
    out9[1] = -ca * sw - sa * cb * cw;
    out9[2] = sa * sb;
    out9[3] = sa * cw + ca * cb * sw;
    out9[4] = ca * cb * cw - sa * sw;
    out9[5] = -ca * sb;
    out9[6] = sb * sw;
    out9[7] = sb * cw;
    out9[8] = cb;
    return out9;
}

/**
 * Ray against a sphere centred at the origin: smallest t ≥ 0 with
 * |o + t·d| = r, or −1 on a miss. `d` need not be unit length (t then scales
 * with it). From inside the sphere this returns the exit distance.
 * @param {ArrayLike<number>} o Ray origin.
 * @param {ArrayLike<number>} d Ray direction.
 * @param {number} r Sphere radius.
 * @returns {number}
 */
export function raySphere(o, d, r) {
    const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
    const a = dx * dx + dy * dy + dz * dz;
    if (!(a > 0)) return -1;
    const b = ox * dx + oy * dy + oz * dz; // half of the usual b
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    // Numerically stable pair of roots (avoids cancellation in −b ± sq).
    const q = b > 0 ? -(b + sq) : sq - b;
    let t0, t1;
    if (q === 0) {
        t0 = t1 = 0;
    } else {
        t0 = q / a;
        t1 = c / q;
    }
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 >= 0) return t0;
    if (t1 >= 0) return t1;
    return -1;
}
