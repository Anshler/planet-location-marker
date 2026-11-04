/**
 * Analytic picking (SPEC §C.6).
 *
 *   pickEarth(ndc, camera, earthMatrix16) → {latDeg, lonDeg} | null
 *   pickMap(ndc, camera, mapFrame) → {latDeg, lonDeg} | null       (the flat map: the plane's analytic inverse)
 *   pickDir(ndc, camera, candidates, viewport, maxPx = 18) → id | null
 *   pickPoint(ndc, camera, candidates, viewport, maxPx = 14) → id | null   (world points: the map's sub-points)
 *
 * No raycaster and no meshes: a ray from the camera through the NDC point is
 * intersected with the unit sphere, rotated into Earth geometry-local
 * coordinates with the transpose of the Earth matrix, and converted with
 * frames.localToLatLon. The module reads only `camera.position`,
 * `camera.matrixWorld`, `camera.projectionMatrixInverse` and (for pickDir)
 * `camera.matrixWorldInverse` / `camera.projectionMatrix`, so it works with any
 * three.js camera and in Node tests with plain objects.
 *
 * `ndc` may be {x, y}, {ndcX, ndcY} (a rig click) or [x, y].
 *
 * @module camera/picking
 */
import { localToLatLon, raySphere } from '../astro/frames.js';
import { mapRayHit } from '../geo/mapview.js';
import { liftByRefraction } from '../astro/photometry.js';

const _o = new Float64Array(3);
const _d = new Float64Array(3);
const _w = new Float64Array(3);
const _l = new Float64Array(3);
const _ll = { latDeg: 0, lonDeg: 0 };

function ndcXY(ndc) {
    if (!ndc) return null;
    let x, y;
    if (Array.isArray(ndc) || ArrayBuffer.isView(ndc)) {
        x = ndc[0];
        y = ndc[1];
    } else {
        x = ndc.x ?? ndc.ndcX;
        y = ndc.y ?? ndc.ndcY;
    }
    x = Number(x);
    y = Number(y);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * World-space ray through an NDC point: origin = camera position, unit direction.
 * @param {number} x NDC x (−1 left … +1 right)
 * @param {number} y NDC y (−1 bottom … +1 top)
 * @param {object} camera three.js camera (matrices current)
 * @param {Float64Array|number[]} outO
 * @param {Float64Array|number[]} outD
 * @returns {boolean} false when the camera matrices are unusable
 */
export function rayFromNdc(x, y, camera, outO, outD) {
    const pi = camera.projectionMatrixInverse.elements;
    const mw = camera.matrixWorld.elements;
    // Unproject a point on the far half of the frustum (z = 0.5) into view space.
    const z = 0.5;
    const vx = pi[0] * x + pi[4] * y + pi[8] * z + pi[12];
    const vy = pi[1] * x + pi[5] * y + pi[9] * z + pi[13];
    const vz = pi[2] * x + pi[6] * y + pi[10] * z + pi[14];
    const vw = pi[3] * x + pi[7] * y + pi[11] * z + pi[15];
    if (!(Math.abs(vw) > 1e-300)) return false;
    const px = vx / vw, py = vy / vw, pz = vz / vw;
    // Perspective camera: the ray starts at the eye (view origin).
    const dx = mw[0] * px + mw[4] * py + mw[8] * pz;
    const dy = mw[1] * px + mw[5] * py + mw[9] * pz;
    const dz = mw[2] * px + mw[6] * py + mw[10] * pz;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0)) return false;
    outO[0] = mw[12];
    outO[1] = mw[13];
    outO[2] = mw[14];
    outD[0] = dx / len;
    outD[1] = dy / len;
    outD[2] = dz / len;
    return true;
}

const _lift = new Float64Array(3);
const _app = new Float64Array(3);

/**
 * The true direction on the celestial sphere under a tap: the camera ray through it, with the
 * drawn refraction taken off (sky view lifts directions by `k`·R(altitude), REFRACT_CHUNK), found by
 * four fixed-point steps as the ruler does. Catalogue stars and deep-sky objects are then compared
 * with it on the sphere (render/sky.js pickStar, render/dso.js pick). No allocation.
 * @param {{x:number,y:number}|{ndcX:number,ndcY:number}|number[]} ndc
 * @param {object} camera
 * @param {ArrayLike<number>|null} up observer zenith (scene), or null in orbit view
 * @param {number} k refraction strength (the view blend)
 * @param {Float64Array} out
 * @returns {boolean}
 */
export function skyTapDir(ndc, camera, up, k, out) {
    const p = ndcXY(ndc);
    if (!p || !camera || !rayFromNdc(p[0], p[1], camera, _o, _app)) return false;
    out[0] = _app[0]; out[1] = _app[1]; out[2] = _app[2];
    if (!up || !(k > 0)) return true;
    for (let it = 0; it < 4; it++) {
        liftByRefraction(out, up, k, _lift);
        for (let c = 0; c < 3; c++) out[c] += _app[c] - _lift[c];
        const n = Math.hypot(out[0], out[1], out[2]) || 1;
        out[0] /= n; out[1] /= n; out[2] /= n;
    }
    return true;
}

/**
 * Lat/lon of the point on the globe under an NDC position, or null if the ray misses.
 * @param {{x:number,y:number}|{ndcX:number,ndcY:number}|number[]} ndc
 * @param {object} camera three.js camera (matrices current: call after rendering, or updateMatrixWorld first)
 * @param {ArrayLike<number>} earthMatrix16 column-major Earth-local → world rotation (snap.earthMatrix)
 * @returns {{latDeg:number, lonDeg:number}|null}
 */
export function pickEarth(ndc, camera, earthMatrix16) {
    const p = ndcXY(ndc);
    if (!p || !camera || !earthMatrix16) return null;
    if (!rayFromNdc(p[0], p[1], camera, _o, _d)) return null;
    const t = raySphere(_o, _d, 1);
    if (t < 0) return null;
    _w[0] = _o[0] + _d[0] * t;
    _w[1] = _o[1] + _d[1] * t;
    _w[2] = _o[2] + _d[2] * t;
    // Earth-local = Rᵀ · world (rotation only).
    const m = earthMatrix16;
    _l[0] = m[0] * _w[0] + m[1] * _w[1] + m[2] * _w[2];
    _l[1] = m[4] * _w[0] + m[5] * _w[1] + m[6] * _w[2];
    _l[2] = m[8] * _w[0] + m[9] * _w[1] + m[10] * _w[2];
    localToLatLon(_l, _ll);
    if (!Number.isFinite(_ll.latDeg) || !Number.isFinite(_ll.lonDeg)) return null;
    return { latDeg: _ll.latDeg, lonDeg: _ll.lonDeg };
}

const _hit = { latDeg: 0, lonDeg: 0, x: 0, y: 0 };

/**
 * Lat/lon of the place on the flat map under an NDC position (geo/mapview.js mapRayHit: the ray
 * meets the plane inside the map), or null.
 * @param {{x:number,y:number}|{ndcX:number,ndcY:number}|number[]} ndc
 * @param {object} camera three.js camera (matrices current)
 * @param {object} mapFrame the rig's mapFrame
 * @returns {{latDeg:number, lonDeg:number}|null}
 */
export function pickMap(ndc, camera, mapFrame) {
    const p = ndcXY(ndc);
    if (!p || !camera || !mapFrame) return null;
    if (!rayFromNdc(p[0], p[1], camera, _o, _d)) return null;
    const hit = mapRayHit(mapFrame, _o, _d, _hit);
    return hit ? { latDeg: hit.latDeg, lonDeg: hit.lonDeg } : null;
}

/**
 * The candidate world point nearest to the click within maxPx (screen distance), in front of the
 * camera (no globe occlusion: the map's points lie on a plane clear of it).
 * @param {{x:number,y:number}|{ndcX:number,ndcY:number}|number[]} ndc
 * @param {object} camera
 * @param {{id:string, posS:ArrayLike<number>}[]} candidates
 * @param {{w:number, h:number}} viewport CSS px
 * @param {number} [maxPx=14]
 * @returns {string|null}
 */
export function pickPoint(ndc, camera, candidates, viewport, maxPx = 14) {
    const p = ndcXY(ndc);
    if (!p || !camera || !Array.isArray(candidates) || !viewport) return null;
    const vw = Number(viewport.w ?? viewport.width), vh = Number(viewport.h ?? viewport.height);
    if (!(vw > 0 && vh > 0)) return null;
    const m = camera.matrixWorldInverse.elements;
    const pm = camera.projectionMatrix.elements;
    const cx = (p[0] * 0.5 + 0.5) * vw, cy = (0.5 - p[1] * 0.5) * vh;
    let best = null;
    let bestD = Number.isFinite(maxPx) ? maxPx : 14;
    for (const cand of candidates) {
        const q = cand?.posS;
        if (!q || cand.id == null) continue;
        const vx = m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12];
        const vy = m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13];
        const vz = m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14];
        const X = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12];
        const Y = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13];
        const W = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15];
        if (!(W > 1e-9)) continue;
        const dist = Math.hypot((X / W * 0.5 + 0.5) * vw - cx, (0.5 - Y / W * 0.5) * vh - cy);
        if (dist > bestD) continue;
        best = cand.id;
        bestD = dist;
    }
    return best;
}

/**
 * Screen position (CSS px, origin top-left) of a direction at infinity seen from the camera.
 * @param {ArrayLike<number>} dir world unit vector
 * @param {object} camera three.js camera
 * @param {{w:number, h:number}} viewport CSS px
 * @param {Float64Array|number[]} out [x, y]
 * @returns {boolean} false when the direction is behind the camera
 */
export function projectDir(dir, camera, viewport, out) {
    const m = camera.matrixWorldInverse.elements;
    const pm = camera.projectionMatrix.elements;
    const dx = dir[0], dy = dir[1], dz = dir[2];
    const vx = m[0] * dx + m[4] * dy + m[8] * dz;
    const vy = m[1] * dx + m[5] * dy + m[9] * dz;
    const vz = m[2] * dx + m[6] * dy + m[10] * dz;
    const X = pm[0] * vx + pm[4] * vy + pm[8] * vz;
    const Y = pm[1] * vx + pm[5] * vy + pm[9] * vz;
    const W = pm[3] * vx + pm[7] * vy + pm[11] * vz;
    if (!(W > 1e-9)) return false;
    out[0] = (X / W * 0.5 + 0.5) * viewport.w;
    out[1] = (0.5 - Y / W * 0.5) * viewport.h;
    return true;
}

const _s = new Float64Array(2);

/**
 * The candidate direction nearest to the click within maxPx (screen distance),
 * ignoring directions behind the camera or hidden behind the globe.
 * @param {{x:number,y:number}|{ndcX:number,ndcY:number}|number[]} ndc
 * @param {object} camera
 * @param {{id:string, dirS:ArrayLike<number>}[]} candidates
 * @param {{w:number, h:number}} viewport CSS px
 * @param {number} [maxPx=18]
 * @returns {string|null}
 */
export function pickDir(ndc, camera, candidates, viewport, maxPx = 18) {
    const p = ndcXY(ndc);
    if (!p || !camera || !Array.isArray(candidates) || !viewport) return null;
    const vw = Number(viewport.w ?? viewport.width), vh = Number(viewport.h ?? viewport.height);
    if (!(vw > 0 && vh > 0)) return null;
    const vp = { w: vw, h: vh };
    const cx = (p[0] * 0.5 + 0.5) * vw, cy = (0.5 - p[1] * 0.5) * vh;
    const ex = camera.position.x, ey = camera.position.y, ez = camera.position.z;
    const c = ex * ex + ey * ey + ez * ez - 1;
    let best = null;
    let bestD = Number.isFinite(maxPx) ? maxPx : 18;
    for (const cand of candidates) {
        const d = cand?.dirS;
        if (!d || cand.id == null) continue;
        if (!projectDir(d, camera, vp, _s)) continue;
        const dist = Math.hypot(_s[0] - cx, _s[1] - cy);
        if (dist > bestD) continue;
        // Hidden behind the globe (the camera ray along d hits the unit sphere)?
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        const b = (ex * d[0] + ey * d[1] + ez * d[2]) / len;
        if (c <= 0 || (b < 0 && b * b - c > 0)) continue;
        best = cand.id;
        bestD = dist;
    }
    return best;
}
