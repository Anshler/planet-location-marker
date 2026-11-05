/**
 * The flat world map (ROADMAP globe-to-map-morph): an equirectangular plane in the scene, its
 * frame, the projection and its analytic inverse. Pure: Float64Array(3) vectors, no three.js.
 *
 * The plane is fixed in the world while the map is shown (the Earth group turns with GAST and
 * precession; the map does not). `up` is the Earth's north pole, `normal` faces the camera that
 * entered the map (its direction made square to the pole) and `right` (east) is up × normal. The
 * plane passes MAP_LIFT along the normal, clear of the unit globe, so nothing drawn on it is ever
 * hidden by the sphere (labels and picking test against the globe).
 *
 * A place (lat, lon) is center + right·λ·s + up·φ·s (radians, s = MAP_SCALE plane units per
 * radian; longitude 0 in the middle). It is the projection the Earth's vertex shader applies to the
 * sphere's own uv (render/shaders/earth.glsl.js SURFACE_VERTEX), so lat/lon here are those of the
 * sphere point (localToLatLon), the latitudes the texture and the pin use.
 *
 * @module geo/mapview
 */

const DEG = Math.PI / 180;

/** Plane units per radian of longitude or latitude: the map is 2π × π units. */
export const MAP_SCALE = 1;
/** Distance of the plane from the Earth's centre, along its normal (just clear of the globe). */
export const MAP_LIFT = 1.02;
/** Half the map's width and height, plane units. */
export const MAP_HALF_W = Math.PI * MAP_SCALE;
export const MAP_HALF_H = Math.PI / 2 * MAP_SCALE;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Wraps a longitude into [−180, 180). */
function wrapLon(lon) {
    if (lon >= -180 && lon < 180) return lon;
    return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * A map frame (preallocated; orientMapFrame rewrites it in place).
 * @returns {{center:Float64Array, right:Float64Array, up:Float64Array, normal:Float64Array, scale:number}}
 */
export function createMapFrame() {
    return {
        center: new Float64Array([0, 0, MAP_LIFT]),
        right: new Float64Array([1, 0, 0]),
        up: new Float64Array([0, 1, 0]),
        normal: new Float64Array([0, 0, 1]),
        scale: MAP_SCALE,
    };
}

/**
 * Orients the plane: up = the pole, normal = `viewW` made square to it (toward the camera),
 * right = up × normal (east). A view along the pole falls back to `fallbackW` (any direction off
 * the pole, e.g. longitude 0 in world coordinates). All inputs are world vectors; none need be
 * normalised. No allocation.
 * @param {ReturnType<typeof createMapFrame>} frame written
 * @param {ArrayLike<number>} poleW the Earth's north pole (world)
 * @param {ArrayLike<number>} viewW the direction from the Earth's centre toward the camera
 * @param {ArrayLike<number>} fallbackW used when viewW is (nearly) along the pole
 * @returns {ReturnType<typeof createMapFrame>}
 */
export function orientMapFrame(frame, poleW, viewW, fallbackW) {
    const u = frame.up, n = frame.normal, r = frame.right, c = frame.center;
    let pl = Math.hypot(poleW[0], poleW[1], poleW[2]);
    if (!(pl > 0)) { poleW = [0, 1, 0]; pl = 1; }
    u[0] = poleW[0] / pl; u[1] = poleW[1] / pl; u[2] = poleW[2] / pl;
    for (let pass = 0; pass < 2; pass++) {
        const v = pass === 0 ? viewW : fallbackW;
        if (!v) continue;
        const k = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
        n[0] = v[0] - k * u[0]; n[1] = v[1] - k * u[1]; n[2] = v[2] - k * u[2];
        const l = Math.hypot(n[0], n[1], n[2]);
        const vl = Math.hypot(v[0], v[1], v[2]);
        if (l > 1e-3 * Math.max(vl, 1e-12)) {
            n[0] /= l; n[1] /= l; n[2] /= l;
            break;
        }
        // Last resort: any direction square to the pole (u × x̂, or u × ŷ near the x axis).
        if (pass === 1) {
            if (Math.abs(u[0]) < 0.9) { n[0] = 0; n[1] = u[2]; n[2] = -u[1]; } else { n[0] = -u[2]; n[1] = 0; n[2] = u[0]; }
            const m = Math.hypot(n[0], n[1], n[2]) || 1;
            n[0] /= m; n[1] /= m; n[2] /= m;
        }
    }
    r[0] = u[1] * n[2] - u[2] * n[1];
    r[1] = u[2] * n[0] - u[0] * n[2];
    r[2] = u[0] * n[1] - u[1] * n[0];
    c[0] = n[0] * MAP_LIFT; c[1] = n[1] * MAP_LIFT; c[2] = n[2] * MAP_LIFT;
    frame.scale = MAP_SCALE;
    return frame;
}

/**
 * Plane coordinates of a place: x east of longitude 0, y north of the equator (plane units).
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {Float64Array|number[]} out [x, y]
 */
export function mapXY(latDeg, lonDeg, out) {
    out[0] = wrapLon(lonDeg) * DEG * MAP_SCALE;
    out[1] = clamp(latDeg, -90, 90) * DEG * MAP_SCALE;
    return out;
}

/**
 * World point of plane coordinates (x, y), `lift` units toward the camera.
 * @param {ReturnType<typeof createMapFrame>} frame
 * @param {number} x
 * @param {number} y
 * @param {Float64Array|number[]} out
 * @param {number} [lift]
 */
export function mapPointXY(frame, x, y, out, lift = 0) {
    const c = frame.center, r = frame.right, u = frame.up, n = frame.normal;
    out[0] = c[0] + r[0] * x + u[0] * y + n[0] * lift;
    out[1] = c[1] + r[1] * x + u[1] * y + n[1] * lift;
    out[2] = c[2] + r[2] * x + u[2] * y + n[2] * lift;
    return out;
}

/**
 * World point of a place on the map.
 * @param {ReturnType<typeof createMapFrame>} frame
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {Float64Array|number[]} out
 * @param {number} [lift] toward the camera, plane units
 */
export function mapPoint(frame, latDeg, lonDeg, out, lift = 0) {
    const x = wrapLon(lonDeg) * DEG * MAP_SCALE, y = clamp(latDeg, -90, 90) * DEG * MAP_SCALE;
    return mapPointXY(frame, x, y, out, lift);
}

/**
 * World point on the map under a world direction from the Earth's centre (a sub-point's geoDirS):
 * the direction is turned into Earth-local coordinates with the transpose of the Earth matrix
 * (column-major, rotation only) and read as lat/lon on the sphere. No allocation.
 * @param {ReturnType<typeof createMapFrame>} frame
 * @param {ArrayLike<number>} earthMatrix16 snap.earthMatrix
 * @param {ArrayLike<number>} dirW
 * @param {Float64Array|number[]} out
 * @param {number} [lift]
 */
export function mapPointOfDir(frame, earthMatrix16, dirW, out, lift = 0) {
    const m = earthMatrix16;
    const lx = m[0] * dirW[0] + m[1] * dirW[1] + m[2] * dirW[2];
    const ly = m[4] * dirW[0] + m[5] * dirW[1] + m[6] * dirW[2];
    const lz = m[8] * dirW[0] + m[9] * dirW[1] + m[10] * dirW[2];
    const x = Math.atan2(-lz, lx) * MAP_SCALE;
    const y = Math.atan2(ly, Math.hypot(lx, lz)) * MAP_SCALE;
    return mapPointXY(frame, x, y, out, lift);
}

/**
 * Plane coordinates → {latDeg, lonDeg}; null outside the map.
 * @param {number} x
 * @param {number} y
 * @param {{latDeg:number, lonDeg:number}} [out]
 * @returns {{latDeg:number, lonDeg:number}|null}
 */
export function mapXYToLatLon(x, y, out = { latDeg: 0, lonDeg: 0 }) {
    if (!(Math.abs(x) <= MAP_HALF_W) || !(Math.abs(y) <= MAP_HALF_H)) return null;
    out.latDeg = y / MAP_SCALE / DEG;
    out.lonDeg = x / MAP_SCALE / DEG;
    if (out.lonDeg >= 180) out.lonDeg -= 360;
    return out;
}

/**
 * The place under a world ray (picking): the ray meets the plane in front of its origin, inside
 * the map. Returns lat/lon and the plane coordinates, or null.
 * @param {ReturnType<typeof createMapFrame>} frame
 * @param {ArrayLike<number>} o ray origin (world)
 * @param {ArrayLike<number>} d ray direction (world; need not be unit)
 * @param {{latDeg:number, lonDeg:number, x:number, y:number}} [out]
 * @returns {{latDeg:number, lonDeg:number, x:number, y:number}|null}
 */
export function mapRayHit(frame, o, d, out = { latDeg: 0, lonDeg: 0, x: 0, y: 0 }) {
    const c = frame.center, n = frame.normal, r = frame.right, u = frame.up;
    const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    if (!(Math.abs(den) > 1e-12)) return null;
    const t = ((c[0] - o[0]) * n[0] + (c[1] - o[1]) * n[1] + (c[2] - o[2]) * n[2]) / den;
    if (!(t > 0)) return null;
    const px = o[0] + d[0] * t - c[0], py = o[1] + d[1] * t - c[1], pz = o[2] + d[2] * t - c[2];
    const x = px * r[0] + py * r[1] + pz * r[2];
    const y = px * u[0] + py * u[1] + pz * u[2];
    if (!mapXYToLatLon(x, y, out)) return null;
    out.x = x;
    out.y = y;
    return out;
}

/**
 * Camera distance from the plane that fits the whole map into the free part of the screen with a
 * margin: the vertical field `fovDeg` spans `screenH` px; the free area is `freeW` × `freeH` px.
 * @param {number} fovDeg
 * @param {number} screenH
 * @param {number} freeW
 * @param {number} freeH
 * @param {number} [margin]
 * @returns {number}
 */
export function mapFitDistance(fovDeg, screenH, freeW, freeH, margin = 1.08) {
    const t = Math.tan(clamp(fovDeg, 1, 170) * DEG / 2);
    const H = screenH > 0 ? screenH : 1;
    const w = freeW > 0 ? freeW : H, h = freeH > 0 ? freeH : H;
    return margin * Math.max(MAP_HALF_W * H / (w * t), MAP_HALF_H * H / (h * t));
}

/**
 * Keeps a view centre on the map (plane units).
 * @param {{x:number, y:number}} v written
 */
export function clampMapCenter(v) {
    v.x = clamp(v.x, -MAP_HALF_W, MAP_HALF_W);
    v.y = clamp(v.y, -MAP_HALF_H, MAP_HALF_H);
    return v;
}
