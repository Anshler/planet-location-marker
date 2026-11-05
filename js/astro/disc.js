/**
 * A body's disc as seen from the observer (pure): the sky-plane frame, and the pole, prime meridian
 * and Sun direction expressed in it. One construction shared by the globe's planet medallions
 * (render/planets.js, through the impostor shader in render/shaders/planets.glsl.js) and the body
 * card's eyepiece portrait (ui/eyepiece.js), so the two never disagree.
 *
 * The frame: `ez` points from the body toward the observer (−dirS), `ey` is the projection of an
 * "up" vector on the sky plane (the body's pole: planet north up; or a camera's up: the true view),
 * and `ex = ey × ez` is screen right. On a north-up sky, as seen with the naked eye, right is west.
 * A point of the body at (x, y, z) in units of its equatorial radius is drawn at (x, y); +z is
 * toward the viewer. Orthographic: every planet subtends far less than a degree.
 *
 * Inputs come from the snapshot's BodyState (`dirS`, `poleS`, `primeS`, `lightS`, all scene
 * frame). Shapes and ring radii are physical constants (IAU 2015 radii, Saturn's ring edges from
 * Voyager/Cassini); the medallions' log spacing of Jupiter's moons is a display choice (see
 * {@link compressRadius}).
 *
 * @module astro/disc
 */
import { RAD2DEG } from './frames.js';
import { AU_KM } from './bodies.js';

/**
 * Oblateness (1 − polar/equatorial radius) and equatorial radius (km) by body id. The Sun, the
 * Moon, Mercury and Venus are spheres to within a pixel of any drawing here.
 * @type {Readonly<Record<string, {flattening:number, eqRadiusKm:number}>>}
 */
export const SHAPES = Object.freeze({
    sun: { flattening: 0, eqRadiusKm: 695700 },
    moon: { flattening: 0, eqRadiusKm: 1738.1 },
    mercury: { flattening: 0, eqRadiusKm: 2440.5 },
    venus: { flattening: 0, eqRadiusKm: 6051.8 },
    mars: { flattening: 0.00589, eqRadiusKm: 3396.2 },
    jupiter: { flattening: 0.06487, eqRadiusKm: 71492 },
    saturn: { flattening: 0.09796, eqRadiusKm: 60268 },
    uranus: { flattening: 0.02293, eqRadiusKm: 25559 },
    neptune: { flattening: 0.01708, eqRadiusKm: 24764 },
});

/**
 * Saturn's main rings in units of its equatorial radius: [inner, outer, normal optical depth τ,
 * albedo] for the C ring, the B ring (τ rising from 1.4 to 2.4 over its inner part), the Cassini
 * division and the A ring (with the Encke gap at 2.215). Edges from Cassini; τ representative;
 * albedo relative to the B ring's peak. {@link ringAt} and PLANET_CHUNK's plRing evaluate it.
 * @type {ReadonlyArray<readonly [number, number, number, number]>}
 */
export const SATURN_RINGS = Object.freeze([
    Object.freeze([1.239, 1.527, 0.128, 0.32]),
    Object.freeze([1.527, 1.951, 2.4, 0.72]),
    Object.freeze([1.951, 2.027, 0.083, 0.22]),
    Object.freeze([2.027, 2.269, 0.80, 0.58]),
]);
/**
 * Mars's main albedo features, schematic: [east longitude °, latitude °, radius °, darkness
 * (negative: a bright area)] — Syrtis Major, Sinus Sabaeus/Meridiani, Mare Erythraeum, Acidalia,
 * Solis Lacus, Mare Sirenum, Mare Cimmerium, Mare Tyrrhenum, Utopia; Hellas, Argyre, Tharsis.
 * @type {ReadonlyArray<readonly [number, number, number, number]>}
 */
export const MARS_SPOTS = Object.freeze([
    [69, 8, 11, 0.95], [20, -8, 13, 0.75], [-40, -22, 15, 0.6], [-30, 45, 14, 0.75], [-88, -26, 7, 0.55],
    [-150, -30, 15, 0.55], [140, -22, 18, 0.7], [105, -15, 14, 0.6], [115, 45, 16, 0.35], [70, -42, 12, -0.45],
    [-60, -45, 13, -0.25], [-110, 5, 18, -0.2],
].map((s) => Object.freeze(s)));

/**
 * Longitude of Jupiter's Great Red Spot in System III (east longitude, degrees, −180…180) at a
 * UTC instant, schematic: the spot held near System II 55° W in 2025–26 and drifts ~1.5° a month,
 * so beyond a year or two it is only illustrative. Systems II and III differ by their IAU
 * prime-meridian rates (870.270 vs 870.536 °/day).
 * @param {number} tMs
 * @returns {number}
 */
export function grsLongitudeDeg(tMs) {
    const d = (tMs - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const lon = (43.3 + 870.270 * d) - (284.95 + 870.536 * d) - 55;
    return ((lon % 360) + 540) % 360 - 180;
}

/** Outer edge of the A ring, equatorial radii. */
export const RING_OUTER = 2.269;

/** Logarithmic spacing for moons outside the limb (medallions and the eyepiece strip). */
export const MOON_LOG_K = 0.6;

/** @typedef {{ex:Float64Array, ey:Float64Array, ez:Float64Array}} DiscFrame */
/**
 * Everything a disc drawing needs, in frame coordinates (see the module docs).
 * @typedef {{ pole:Float64Array, prime:Float64Array, light:Float64Array,
 *   subLatDeg:number, phaseAngleDeg:number, limbAngleDeg:number, cmDeg:number }} DiscView
 *   `pole`, `prime` (the prime meridian, on the equator) and `light` (toward the Sun) are unit
 *   vectors. `subLatDeg`: planetocentric latitude of the sub-observer point (for Saturn the ring
 *   opening B; negative: the south face is shown). `phaseAngleDeg`: Sun–body–observer angle.
 *   `limbAngleDeg`: direction of the bright limb on the drawing, from up toward the right.
 *   `cmDeg`: central meridian, planetocentric east longitude of the sub-observer point (−180…180).
 */

/** @returns {DiscFrame} */
export function createDiscFrame() {
    return { ex: new Float64Array([1, 0, 0]), ey: new Float64Array([0, 1, 0]), ez: new Float64Array([0, 0, 1]) };
}

/** @returns {DiscView} */
export function createDiscView() {
    return {
        pole: new Float64Array([0, 1, 0]), prime: new Float64Array([0, 0, 1]), light: new Float64Array([0, 0, 1]),
        subLatDeg: 0, phaseAngleDeg: 0, limbAngleDeg: 0, cmDeg: 0,
    };
}

/**
 * The sky-plane frame of a body seen along `dirS` with `upS` projected as up (in place).
 * When `upS` is (nearly) along the line of sight, J2000 north (scene +Y) stands in, then scene +X.
 * @param {ArrayLike<number>} dirS observer → body unit vector (scene)
 * @param {ArrayLike<number>} upS up reference (scene; need not be unit or perpendicular)
 * @param {DiscFrame} out
 * @returns {DiscFrame} out
 */
export function discFrame(dirS, upS, out) {
    const zx = -dirS[0], zy = -dirS[1], zz = -dirS[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    const ez = out.ez;
    ez[0] = zx / zl; ez[1] = zy / zl; ez[2] = zz / zl;
    let ok = projectUp(ez, upS[0], upS[1], upS[2], out.ey);
    if (!ok) ok = projectUp(ez, 0, 1, 0, out.ey);
    if (!ok) projectUp(ez, 1, 0, 0, out.ey);
    const ey = out.ey, ex = out.ex;
    ex[0] = ey[1] * ez[2] - ey[2] * ez[1];
    ex[1] = ey[2] * ez[0] - ey[0] * ez[2];
    ex[2] = ey[0] * ez[1] - ey[1] * ez[0];
    return out;
}

function projectUp(ez, ux, uy, uz, ey) {
    const k = ux * ez[0] + uy * ez[1] + uz * ez[2];
    const x = ux - k * ez[0], y = uy - k * ez[1], z = uz - k * ez[2];
    const l = Math.hypot(x, y, z);
    if (!(l > 1e-6 * Math.max(1, Math.hypot(ux, uy, uz)))) return false;
    ey[0] = x / l; ey[1] = y / l; ey[2] = z / l;
    return true;
}

/**
 * A scene vector in frame coordinates: out[k..k+2] = (v·ex, v·ey, v·ez), v read at v[j..j+2].
 * @param {DiscFrame} f
 * @param {ArrayLike<number>} v
 * @param {Float64Array|Float32Array|number[]} out
 * @param {number} [k] offset into `out`
 * @param {number} [j] offset into `v` (e.g. a moon of snapshot.galilean.offS)
 */
export function toFrame(f, v, out, k = 0, j = 0) {
    const x = v[j], y = v[j + 1], z = v[j + 2];
    out[k] = x * f.ex[0] + y * f.ex[1] + z * f.ex[2];
    out[k + 1] = x * f.ey[0] + y * f.ey[1] + z * f.ey[2];
    out[k + 2] = x * f.ez[0] + y * f.ez[1] + z * f.ez[2];
    return out;
}

/**
 * Fills a {@link DiscView} for a snapshot BodyState in the frame `f` (from {@link discFrame}).
 * @param {{dirS:ArrayLike<number>, poleS:ArrayLike<number>, primeS:ArrayLike<number>, lightS:ArrayLike<number>}} st
 * @param {DiscFrame} f
 * @param {DiscView} out
 * @returns {DiscView} out
 */
export function discView(st, f, out) {
    toFrame(f, st.poleS, out.pole);
    toFrame(f, st.primeS, out.prime);
    toFrame(f, st.lightS, out.light);
    const p = out.pole, q = out.prime, l = out.light;
    out.subLatDeg = Math.asin(Math.max(-1, Math.min(1, p[2]))) * RAD2DEG;
    out.phaseAngleDeg = Math.acos(Math.max(-1, Math.min(1, l[2]))) * RAD2DEG;
    out.limbAngleDeg = Math.atan2(l[0], l[1]) * RAD2DEG;
    // The viewer's direction (0, 0, 1) in body-fixed axes: x along the prime meridian, y = pole × prime.
    const yb = p[0] * q[1] - p[1] * q[0];
    out.cmDeg = Math.atan2(yb, q[2]) * RAD2DEG;
    return out;
}

/**
 * Display radius of a moon `r` equatorial radii from its planet's centre: true inside the limb,
 * then 1 + k·ln r, so Callisto's 26 radii fit beside a magnified disc while side and order stay
 * true. Monotonic and continuous at the limb.
 * @param {number} r
 * @param {number} [k]
 * @returns {number}
 */
export function compressRadius(r, k = MOON_LOG_K) {
    return r <= 1 ? r : 1 + k * Math.log(r);
}

/**
 * Normal optical depth and albedo of Saturn's rings at a radius (equatorial radii); [0, 0]
 * outside them. Mirrors PLANET_CHUNK's plRing (render/shaders/planets.glsl.js) term for term.
 * @param {number} r
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]} [τ, albedo]
 */
export function ringAt(r, out = [0, 0]) {
    const R = SATURN_RINGS;
    let tau = 0, alb = 0;
    if (r >= R[0][0] && r <= R[3][1]) {
        if (r < R[0][1]) { tau = R[0][2]; alb = R[0][3]; }
        else if (r < R[1][1]) {
            const t = Math.min(1, Math.max(0, (r - 1.55) / 0.2));
            tau = 1.4 + (R[1][2] - 1.4) * t * t * (3 - 2 * t);
            alb = R[1][3];
        } else if (r < R[2][1]) { tau = R[2][2]; alb = R[2][3]; }
        else { tau = r > 2.212 && r < 2.218 ? 0.05 : R[3][2]; alb = R[3][3]; }
    }
    out[0] = tau;
    out[1] = alb;
    return out;
}

/**
 * Sky-view telescope zoom: a planet's magnitude glyph hands over to its true-scale disc (the shared
 * impostor) while the disc's equatorial radius grows from SCOPE_FROM_PX to SCOPE_TO_PX device
 * pixels, about the glyph's own core. render/bodies.js fades the glyph by 1 − w and
 * render/planets.js the disc in by w.
 */
export const SCOPE_FROM_PX = 1.5;
export const SCOPE_TO_PX = 4;

/**
 * @param {number} radiusPx the disc's true equatorial radius on screen, device px
 * @returns {number} 0 (glyph) … 1 (disc), smoothstep
 */
export function scopeBlend(radiusPx) {
    if (!(radiusPx > SCOPE_FROM_PX)) return 0;
    const t = Math.min(1, (radiusPx - SCOPE_FROM_PX) / (SCOPE_TO_PX - SCOPE_FROM_PX));
    return t * t * (3 - 2 * t);
}

/**
 * True angular equatorial radius (radians) of body `id` at `distAU` ({@link SHAPES}), or 0.
 * @param {string} id
 * @param {number} distAU
 * @returns {number}
 */
export function eqAngRadius(id, distAU) {
    const s = SHAPES[id];
    return s && distAU > 0 ? Math.asin(Math.min(1, s.eqRadiusKm / (distAU * AU_KM))) : 0;
}
