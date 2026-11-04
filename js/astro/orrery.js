/**
 * The solar-system zoom ('powers of ten'), pure parts: keep zooming out past the Moon and the
 * globe shrinks to a dot in a live orrery, each beam continuing as the true line from the Earth to
 * its body.
 *
 * One linear scale. The orrery's world is the scene frame (the S mapping of EQJ) in astronomical
 * units with the Sun at the origin; the globe scene (Earth radii, Earth at the origin) maps into it
 * by x_AU = earthS + x_R / AU_ER. A uniform scale keeps every direction, so the line from the
 * Earth to a body runs exactly along the body's geocentric direction (snapshot `helio.posS`
 * is the Earth plus the geocentric vector), within the beam's ≤ 25″ topocentric parallax. Nothing
 * is log-compressed: that would bend the Earth→planet lines away from the beams. Only the bodies
 * are enlarged (sprites with a minimum size), and a body off the screen gets an arrow at the edge.
 *
 * The camera (js/camera/rig.js, the 'system' zoom of the globe view). The view direction u (from
 * the pivot to the camera) is held in J2000 ecliptic longitude and latitude and is fixed in space,
 * not in the turning Earth. Its distance D (Earth radii) runs from the globe's 150 R out to
 * SYSTEM_MAX_R; the pivot slides from the Earth to the Sun as D grows (pivotWeight: still on the
 * Earth at 150 R, on the Sun from PIVOT_FULL_R), so the Earth stays in the frame on the way
 * out. Zooming out also lifts the view above the ecliptic (liftBlend, at least LIFT_LAT_DEG) and
 * turns the camera's up from celestial north to ecliptic north (upBlend), so the planets' plane
 * reads level. systemBlend is the crossfade: the orrery fades in between 80 and 150 R from the
 * Earth while the beams fade into its lines.
 *
 * Retrograde geometry: sightLines() samples the Earth→planet sight line at fixed sim-time steps
 * (a 110th of the synodic period), the textbook figure of the Earth overtaking an outer planet.
 *
 * Vectors are Float64Array(3) in the scene frame. No allocation except where an output is created
 * once (orbitPolylines' result, a missing `out`).
 *
 * @module astro/orrery
 */
import { AE } from './ae.js';
import { AU_ER } from './bodies.js';
import { OBLIQUITY_J2000_DEG, DEG2RAD } from './frames.js';

/** Crossfade from the globe to the orrery: camera distance from the Earth, Earth radii. */
export const SYSTEM_FADE_R = Object.freeze([80, 150]);
/** The globe view's farthest orbit (rig MAX_DIST): beyond it the system zoom takes over. */
export const GLOBE_MAX_R = 150;
/** The system zoom's farthest camera distance from the pivot: 80 AU, Neptune's orbit in view. */
export const SYSTEM_MAX_R = 80 * AU_ER;
/** The pivot reaches the Sun at this distance (4 AU). */
export const PIVOT_FULL_R = 4 * AU_ER;
/** The default system view ('Solar system' in the vantage menu): 6 AU from the Sun. */
export const SYSTEM_VIEW_R = 6 * AU_ER;
/** Zooming out lifts the view to at least this ecliptic latitude, between LIFT_R. */
export const LIFT_LAT_DEG = 35;
export const LIFT_R = Object.freeze([3000, 1.5 * AU_ER]);
/** The camera's up turns from celestial to ecliptic north between these distances. */
export const UP_R = Object.freeze([1000, 0.5 * AU_ER]);

/** Bodies with a heliocentric orbit drawn, and their astronomy-engine names. */
export const ORBIT_IDS = Object.freeze(['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
const ORBIT_AE = Object.freeze(['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);
/** Samples per heliocentric orbit (one sidereal period), and for the Moon's geocentric orbit. */
export const ORBIT_SAMPLES = 256;
export const MOON_SAMPLES = 128;
/** Sidereal month, days (the Moon's orbit polyline). */
const MOON_PERIOD_D = 27.321661;
/** Sight lines kept for the retrograde figure, and the step as a fraction of the synodic period. */
export const SIGHT_COUNT = 24;
const SIGHT_STEPS_PER_SYNODIC = 110;
const EARTH_PERIOD_D = 365.256363;

const COS_E = Math.cos(OBLIQUITY_J2000_DEG * DEG2RAD);
const SIN_E = Math.sin(OBLIQUITY_J2000_DEG * DEG2RAD);
/** The J2000 ecliptic basis in the scene frame: x toward the equinox, z the ecliptic north pole. */
export const ECL_X_S = Object.freeze([1, 0, 0]);
export const ECL_Y_S = Object.freeze([0, SIN_E, -COS_E]);
export const ECL_NORTH_S = Object.freeze([0, COS_E, SIN_E]);

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smooth(t) { return t * t * (3 - 2 * t); }
/** smoothstep over ln(distance). */
function logStep(d, range) {
    if (!(d > 0)) return 0;
    return smooth(clamp((Math.log(d) - Math.log(range[0])) / (Math.log(range[1]) - Math.log(range[0])), 0, 1));
}

/**
 * The globe → orrery crossfade for a camera `distR` Earth radii from the Earth's centre: 0 up to
 * 80 R, 1 from 150 R, smooth in log distance. `fromR` moves the start out (a pose that keeps the
 * globe, rig frameSpan): the fade then runs over what is left up to 150 R, or not at all inside it.
 * @param {number} distR
 * @param {number} [fromR]
 * @returns {number} 0…1
 */
export function systemBlend(distR, fromR = SYSTEM_FADE_R[0]) {
    if (!(fromR > SYSTEM_FADE_R[0])) return logStep(distR, SYSTEM_FADE_R);
    const b = SYSTEM_FADE_R[1];
    if (!(fromR < b)) return distR > b ? 1 : 0;
    if (!(distR > 0)) return 0;
    return smooth(clamp((Math.log(distR) - Math.log(fromR)) / (Math.log(b) - Math.log(fromR)), 0, 1));
}

/**
 * How far the pivot has slid from the Earth to the Sun at camera distance D (from the pivot):
 * 2u² − u⁴ with u = D / PIVOT_FULL_R. Quadratic at first (0.1 R off the Earth at 150 R, under a
 * pixel), level at the Sun. The Earth stays inside about two thirds of the half-frame on the way.
 * @param {number} distR
 * @returns {number} 0…1
 */
export function pivotWeight(distR) {
    const u = clamp(distR / PIVOT_FULL_R, 0, 1);
    return u * u * (2 - u * u);
}

/** @param {number} distR @returns {number} 0…1, the up vector's turn to ecliptic north. */
export function upBlend(distR) {
    return logStep(distR, UP_R);
}

/** @param {number} distR @returns {number} 0…1, the lift above the ecliptic plane. */
export function liftBlend(distR) {
    return logStep(distR, LIFT_R);
}

/**
 * Scene unit vector of J2000 ecliptic longitude/latitude (radians).
 * @param {number} lon @param {number} lat @param {Float64Array} out
 * @returns {Float64Array}
 */
export function eclipticDir(lon, lat, out) {
    const cl = Math.cos(lat), x = cl * Math.cos(lon), y = cl * Math.sin(lon), z = Math.sin(lat);
    out[0] = x * ECL_X_S[0] + y * ECL_Y_S[0] + z * ECL_NORTH_S[0];
    out[1] = x * ECL_X_S[1] + y * ECL_Y_S[1] + z * ECL_NORTH_S[1];
    out[2] = x * ECL_X_S[2] + y * ECL_Y_S[2] + z * ECL_NORTH_S[2];
    return out;
}

/**
 * J2000 ecliptic longitude and latitude (radians) of a scene vector.
 * @param {ArrayLike<number>} v
 * @param {{lon:number, lat:number}} out
 * @returns {{lon:number, lat:number}}
 */
export function eclipticOf(v, out) {
    const x = v[0] * ECL_X_S[0] + v[1] * ECL_X_S[1] + v[2] * ECL_X_S[2];
    const y = v[0] * ECL_Y_S[0] + v[1] * ECL_Y_S[1] + v[2] * ECL_Y_S[2];
    const z = v[0] * ECL_NORTH_S[0] + v[1] * ECL_NORTH_S[1] + v[2] * ECL_NORTH_S[2];
    out.lon = Math.atan2(y, x);
    out.lat = Math.atan2(z, Math.hypot(x, y));
    return out;
}

/**
 * @typedef {{pos:Float64Array, fwd:Float64Array, up:Float64Array, pivot:Float64Array, weight:number}} SystemPose
 *   pos: the camera in the globe scene (Earth radii, Earth at the origin); fwd: unit view
 *   direction; up: the up hint; pivot: the point it orbits (globe scene); weight: pivotWeight.
 */

/** @returns {SystemPose} */
export function createSystemPose() {
    return { pos: new Float64Array(3), fwd: new Float64Array(3), up: new Float64Array(3), pivot: new Float64Array(3), weight: 0 };
}

/**
 * The system zoom's camera: distance D from the pivot along the ecliptic direction (lon, lat),
 * the pivot pivotWeight(D) of the way from the Earth to the Sun, up blended from celestial to
 * ecliptic north. No allocation.
 * @param {number} distR camera distance from the pivot, Earth radii
 * @param {number} lon ecliptic longitude of the pivot → camera direction, radians
 * @param {number} lat ecliptic latitude, radians
 * @param {ArrayLike<number>} earthS the Earth's heliocentric position (snapshot helio.earthS), AU
 * @param {SystemPose} out
 * @returns {SystemPose}
 */
export function systemPose(distR, lon, lat, earthS, out) {
    const w = pivotWeight(distR);
    out.weight = w;
    const f = out.fwd;
    eclipticDir(lon, lat, f);
    // The pivot: −w × the Earth's heliocentric vector, in Earth radii from the Earth.
    const k = -w * AU_ER;
    out.pivot[0] = k * earthS[0];
    out.pivot[1] = k * earthS[1];
    out.pivot[2] = k * earthS[2];
    out.pos[0] = out.pivot[0] + f[0] * distR;
    out.pos[1] = out.pivot[1] + f[1] * distR;
    out.pos[2] = out.pivot[2] + f[2] * distR;
    f[0] = -f[0]; f[1] = -f[1]; f[2] = -f[2];
    const b = upBlend(distR);
    const ux = ECL_NORTH_S[0] * b, uy = 1 - b + ECL_NORTH_S[1] * b, uz = ECL_NORTH_S[2] * b;
    const ul = Math.hypot(ux, uy, uz) || 1;
    out.up[0] = ux / ul; out.up[1] = uy / ul; out.up[2] = uz / ul;
    return out;
}

/**
 * The lift above the ecliptic as the camera zooms out from distance `fromR` to `toR`: latitude
 * `lat` (radians) moves toward ±LIFT_LAT_DEG by the share of the remaining lift that liftBlend
 * gained. Zooming in leaves it alone, so the view the user chose is kept.
 * @param {number} lat
 * @param {number} fromR
 * @param {number} toR
 * @returns {number} the new latitude (radians)
 */
export function liftLat(lat, fromR, toR) {
    const k0 = liftBlend(fromR), k1 = liftBlend(toR);
    const target = LIFT_LAT_DEG * DEG2RAD;
    if (!(k1 > k0) || Math.abs(lat) >= target || k0 >= 1) return lat;
    const sign = lat < 0 ? -1 : 1;
    const a = Math.abs(lat);
    return sign * (a + (target - a) * (k1 - k0) / (1 - k0));
}

/** EQJ → scene into a Float32Array at index j (three floats). */
function put32(out, j, x, y, z) {
    out[j] = x;
    out[j + 1] = z;
    out[j + 2] = -y;
}

/**
 * One sidereal period of each planet's heliocentric orbit (ORBIT_IDS, the Earth included) and one
 * sidereal month of the Moon's geocentric orbit, centred on `centerMs`, as closed polylines for
 * the orrery (the last point joins the first). Geometric positions (AE.HelioVector, GeoMoon), AU,
 * scene axes. The worker's 'orbits' op; about 2,200 VSOP evaluations, a few ms.
 * @param {number} centerMs
 * @param {number} [n] samples per heliocentric orbit
 * @param {number} [nMoon] samples of the Moon's orbit
 * @returns {{centerMs:number, n:number, nMoon:number, ids:string[], points:Float32Array, moon:Float32Array}}
 *   points: ORBIT_IDS.length × n × 3; moon: nMoon × 3 (relative to the Earth)
 */
export function orbitPolylines(centerMs, n = ORBIT_SAMPLES, nMoon = MOON_SAMPLES) {
    if (!Number.isFinite(centerMs)) throw new RangeError('orbitPolylines: centerMs must be finite');
    const ns = Math.max(8, Math.min(2048, Math.round(n) || ORBIT_SAMPLES));
    const nm = Math.max(8, Math.min(1024, Math.round(nMoon) || MOON_SAMPLES));
    const points = new Float32Array(ORBIT_IDS.length * ns * 3);
    const t0 = AE.MakeTime(new Date(centerMs));
    for (let b = 0; b < ORBIT_AE.length; b++) {
        const P = AE.PlanetOrbitalPeriod(ORBIT_AE[b]);
        for (let i = 0; i < ns; i++) {
            const v = AE.HelioVector(ORBIT_AE[b], t0.AddDays(P * (i / ns - 0.5)));
            put32(points, (b * ns + i) * 3, v.x, v.y, v.z);
        }
    }
    const moon = new Float32Array(nm * 3);
    for (let i = 0; i < nm; i++) {
        const m = AE.GeoMoon(t0.AddDays(MOON_PERIOD_D * (i / nm - 0.5)));
        put32(moon, i * 3, m.x, m.y, m.z);
    }
    return { centerMs, n: ns, nMoon: nm, ids: [...ORBIT_IDS], points, moon };
}

/**
 * The sight-line step for a planet: a 110th of its synodic period (Mars 7.1 d, Jupiter 3.6 d,
 * Mercury 1.05 d), so a retrograde loop spans 8–20 lines.
 * @param {string} aeName astronomy-engine planet name ('Mars')
 * @returns {number} ms, or NaN for the Earth or an unknown name
 */
export function sightStepMs(aeName) {
    let P;
    try { P = AE.PlanetOrbitalPeriod(aeName); } catch { return NaN; }
    const f = Math.abs(1 / P - 1 / EARTH_PERIOD_D);
    return f > 1e-5 ? 1 / f / SIGHT_STEPS_PER_SYNODIC * 864e5 : NaN;
}

/**
 * One sight line of the retrograde figure: the Earth's and the planet's heliocentric positions (AU,
 * scene axes) at `tMs`, into out[j…j+5].
 * @param {string} aeName astronomy-engine planet name
 * @param {number} tMs
 * @param {Float64Array} out
 * @param {number} j
 */
export function sightAt(aeName, tMs, out, j) {
    const time = AE.MakeTime(new Date(tMs));
    const e = AE.HelioVector('Earth', time);
    const p = AE.HelioVector(aeName, time);
    out[j] = e.x; out[j + 1] = e.z; out[j + 2] = -e.y;
    out[j + 3] = p.x; out[j + 4] = p.z; out[j + 5] = -p.y;
}

/**
 * The Earth→planet sight lines of the retrograde figure: `count` pairs (Earth, planet) at
 * t_k = (⌊tMs / step⌋ − k)·step, k = 0 the newest, so the set changes only when sim time crosses a
 * step and never depends on the frame rate (render/orrery.js shifts it and fills in only the new
 * steps).
 * @param {string} aeName astronomy-engine planet name
 * @param {number} tMs
 * @param {number} count
 * @param {Float64Array} out count × 6: Ex, Ey, Ez, Px, Py, Pz per line
 * @returns {number} the index ⌊tMs / step⌋ of the newest line (NaN when there is none)
 */
export function sightLines(aeName, tMs, count, out) {
    const step = sightStepMs(aeName);
    if (!Number.isFinite(step) || !Number.isFinite(tMs)) return NaN;
    const k0 = Math.floor(tMs / step);
    const nmax = Math.min(count, Math.floor(out.length / 6));
    for (let k = 0; k < nmax; k++) sightAt(aeName, (k0 - k) * step, out, k * 6);
    return k0;
}

/**
 * Where a sight line leaves the free area: from (ox, oy), the Earth on screen (NDC; the area's
 * centre when the Earth is outside it), along the line's screen direction (dx, dy), to the first
 * side of the rectangle [x0, x1] × [y0, y1]. An off-screen body's edge arrow and label go there,
 * so they sit on its line, as a beam's label sits where the beam leaves the screen.
 * @param {number} ox
 * @param {number} oy
 * @param {number} dx
 * @param {number} dy
 * @param {{x0:number, x1:number, y0:number, y1:number, cx:number, cy:number, aspect?:number}} rect
 *   aspect: width / height, so `angle` is the arrow's direction on screen
 * @param {{x:number, y:number, angle:number}} out angle: radians from screen +x, up positive
 * @returns {boolean} false when the direction is degenerate (out unchanged)
 */
export function edgeExit(ox, oy, dx, dy, rect, out) {
    if (!(Math.abs(dx) + Math.abs(dy) > 1e-12) || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (!(ox >= rect.x0 && ox <= rect.x1 && oy >= rect.y0 && oy <= rect.y1)) {
        ox = rect.cx;
        oy = rect.cy;
    }
    let s = Infinity;
    if (dx > 0) s = Math.min(s, (rect.x1 - ox) / dx);
    else if (dx < 0) s = Math.min(s, (rect.x0 - ox) / dx);
    if (dy > 0) s = Math.min(s, (rect.y1 - oy) / dy);
    else if (dy < 0) s = Math.min(s, (rect.y0 - oy) / dy);
    if (!Number.isFinite(s)) return false;
    out.x = ox + dx * s;
    out.y = oy + dy * s;
    out.angle = Math.atan2(dy, dx * (rect.aspect || 1));
    return true;
}
