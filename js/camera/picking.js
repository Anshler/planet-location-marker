/**
 * Analytic picking (SPEC §C.6).
 *
 *   pickEarth(ndc, camera, earthMatrix16) → {latDeg, lonDeg} | null
 *   pickDir(ndc, camera, candidates, viewport, maxPx = 18) → id | null
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
