/**
 * Eclipse geometry: how much of one disc a second disc hides. Mirrored
 * exactly by `discVisible` in js/render/shaders/common.glsl.js (SPEC §E.2), so
 * the obscuration printed in the UI matches the shadow drawn on the globe.
 * Also the sunlight that reaches the Moon during a lunar eclipse, which dims
 * the Moon's magnitude in the snapshot.
 *
 * @module astro/shadow
 */
import { MOON_RADIUS_ER, SUN_ANG_RADIUS_RAD, EARTH_RADIUS_KM, BODIES } from './bodies.js';

function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Radius of the Earth's shadow-casting disc in Earth radii: the mean radius
 * plus 88 km of opaque atmosphere (6459 km), astronomy-engine's value for its
 * lunar eclipse contacts. That enlarges the umbra by about 2 % (Danjon/
 * Chauvenet), so the dimming starts and ends at the published contact times.
 */
export const EARTH_SHADOW_RADIUS_ER = (6371 + 88) / EARTH_RADIUS_KM;

/**
 * Fraction of full sunlight that still reaches a point in the umbra, refracted
 * (and reddened) through the Earth's atmosphere: 1e-4 at the umbra's edge
 * (+10 mag), falling to 1e-5 on the shadow axis (+12.5 mag). A totally
 * eclipsed Moon then lands near magnitude −2 to −0.5, typical of Danjon L 2–3.
 */
export const UMBRA_EDGE_LIGHT = 1e-4;

const SUN_RADIUS_ER = BODIES[0].radiusKm / EARTH_RADIUS_KM;

// Quadrature over the Moon's disc (unit radius, x toward the shadow axis):
// Gauss–Chebyshev (second kind) in x, which absorbs the chord length
// 2·√(1 − x²), times 3-point Gauss–Legendre along each chord. 24 × 3 nodes
// stay within ≈0.01 mag of a 600 × 600 grid through every phase, where an
// equal-area ring pattern of 128 points was off by up to 0.25 mag near second
// contact. Built once at load; [x, y, weight] per node, weights sum to 1.
const QX = 24;
const GL3 = [[-Math.sqrt(0.6), 5 / 9], [0, 8 / 9], [Math.sqrt(0.6), 5 / 9]];
const N_NODES = QX * GL3.length;
const NODES = new Float64Array(3 * N_NODES);
for (let i = 0, k = 0; i < QX; i++) {
    const th = ((i + 1) * Math.PI) / (QX + 1);
    const x = Math.cos(th), c = Math.sin(th);
    for (const [y, wy] of GL3) {
        NODES[k++] = x;
        NODES[k++] = c * y;
        NODES[k++] = (c * c * wy) / (QX + 1);
    }
}

/**
 * Sunlight reaching the Earth-facing disc of the Moon, for lunar eclipses.
 * Each quadrature point P on the disc sees the Sun (angular radius from P)
 * partly hidden by the Earth's shadow disc ({@link EARTH_SHADOW_RADIUS_ER},
 * angular radius from P); `discVisibleFraction` gives the direct sunlight
 * there, and the blocked part keeps {@link UMBRA_EDGE_LIGHT}·10^(−depth) of
 * refracted light (depth 0 at the umbra's edge, 1 on the shadow axis). The
 * Sun is a uniform disc (no limb darkening). Allocation-free; 72 points.
 *
 * Outside the penumbra every point sees the whole Sun and the result is
 * exactly `{lit: 1, flux: 1}`.
 * @param {ArrayLike<number>} moonPosS Geocentric Moon centre, Earth radii.
 * @param {ArrayLike<number>} sunDirS Unit vector from the Earth's centre toward the Sun.
 * @param {number} sunDistER Earth–Sun distance in Earth radii.
 * @param {{lit:number, flux:number}} out Receives `lit`, the disc-averaged fraction of
 *        direct sunlight (0 in totality), and `flux`, the Moon's brightness relative to
 *        uneclipsed, including the refracted light (≈1e-5…1e-4 in totality).
 * @returns {{lit:number, flux:number}} `out`
 */
export function lunarEclipseLight(moonPosS, sunDirS, sunDistER, out) {
    out.lit = 1;
    out.flux = 1;
    const mx = moonPosS[0], my = moonPosS[1], mz = moonPosS[2];
    const dm = Math.hypot(mx, my, mz);
    if (!(dm > 1 + MOON_RADIUS_ER) || !(sunDistER > dm)) return out; // degenerate geometry
    const ux = mx / dm, uy = my / dm, uz = mz / dm;
    // e1: the antisun direction projected onto the disc, so x runs toward the shadow axis.
    const ax = -sunDirS[0], ay = -sunDirS[1], az = -sunDirS[2];
    const d = ax * ux + ay * uy + az * uz;
    let e1x = ax - d * ux, e1y = ay - d * uy, e1z = az - d * uz;
    let l = Math.hypot(e1x, e1y, e1z);
    if (!(l > 1e-12)) {
        // Moon centred on the axis: the shadow is symmetric, any perpendicular will do.
        if (Math.abs(ux) < 0.9) { e1x = 0; e1y = uz; e1z = -uy; } else { e1x = -uz; e1y = 0; e1z = ux; }
        l = Math.hypot(e1x, e1y, e1z);
    }
    e1x /= l; e1y /= l; e1z /= l;
    const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
    const sx = sunDirS[0] * sunDistER, sy = sunDirS[1] * sunDistER, sz = sunDirS[2] * sunDistER;

    let blocked = 0, dark = 0;
    for (let k = 0; k < 3 * N_NODES; k += 3) {
        const x = NODES[k] * MOON_RADIUS_ER, y = NODES[k + 1] * MOON_RADIUS_ER;
        // P on the disc; toward the Earth's centre is −P, toward the Sun is S − P.
        const px = mx + x * e1x + y * e2x, py = my + x * e1y + y * e2y, pz = mz + x * e1z + y * e2z;
        const qx = sx - px, qy = sy - py, qz = sz - pz;
        const dp = Math.hypot(px, py, pz), dq = Math.hypot(qx, qy, qz);
        const rE = Math.asin(Math.min(1, EARTH_SHADOW_RADIUS_ER / dp));
        const rS = Math.asin(Math.min(1, SUN_RADIUS_ER / dq));
        const cx = qy * pz - qz * py, cy = qz * px - qx * pz, cz = qx * py - qy * px; // (−P) × Q
        const sep = Math.atan2(Math.hypot(cx, cy, cz), -(px * qx + py * qy + pz * qz));
        const hidden = 1 - discVisibleFraction(rS, rE, sep);
        if (hidden > 0) {
            const umbra = rE - rS;
            const depth = umbra > 0 && sep < umbra ? 1 - sep / umbra : 0;
            const w = NODES[k + 2];
            blocked += w * hidden;
            dark += w * hidden * (1 - UMBRA_EDGE_LIGHT * Math.pow(10, -depth));
        }
    }
    // Accumulating the deficit keeps an uneclipsed Moon at exactly 1.
    out.lit = clamp(1 - blocked, 0, 1);
    out.flux = clamp(1 - dark, 0, 1);
    return out;
}

/**
 * Visible fraction of a luminous disc of angular radius `rs` when an opaque
 * disc of angular radius `ro` sits at centre separation `sep` (all in the same
 * angular unit, typically radians). Flat-disc approximation (fine for discs
 * under a few degrees).
 *  - sep ≥ rs + ro           → 1 (no overlap)
 *  - sep ≤ |ro − rs|         → 0 if ro ≥ rs (total), else 1 − ro²/rs² (annular)
 *  - otherwise               → 1 − lens area / (π·rs²)
 * @param {number} rs Radius of the luminous disc (e.g. the Sun).
 * @param {number} ro Radius of the occulting disc (e.g. the Moon).
 * @param {number} sep Centre separation.
 * @returns {number} 0..1
 */
export function discVisibleFraction(rs, ro, sep) {
    if (!(rs > 0) || !(ro > 0)) return 1;
    const d = Math.abs(sep);
    if (!(d < rs + ro)) return 1; // also catches NaN separations
    if (d <= Math.abs(ro - rs)) return ro >= rs ? 0 : 1 - (ro * ro) / (rs * rs);
    const c1 = clamp((d * d + rs * rs - ro * ro) / (2 * d * rs), -1, 1);
    const c2 = clamp((d * d + ro * ro - rs * rs) / (2 * d * ro), -1, 1);
    const k = (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro);
    const lens = rs * rs * Math.acos(c1) + ro * ro * Math.acos(c2) - 0.5 * Math.sqrt(Math.max(0, k));
    return clamp(1 - lens / (Math.PI * rs * rs), 0, 1);
}

/**
 * Fraction of the Sun's disc hidden by the Moon for an observer at `posS`
 * (scene units = Earth radii; the pin sits on the unit sphere). The Sun is
 * treated as infinitely far (its 8.8″ parallax is negligible against its
 * 16′ radius).
 * @param {ArrayLike<number>} posS Observer position, Earth radii.
 * @param {ArrayLike<number>} moonPosS Geocentric Moon centre, Earth radii.
 * @param {ArrayLike<number>} sunDirS Unit vector toward the Sun.
 * @param {number} [sunAngRadiusRad=SUN_ANG_RADIUS_RAD] Apparent solar radius; pass
 *        asin(R☉/d☉) for the true value (it varies ±1.7 % over the year).
 * @returns {number} Obscuration 0..1 (1 = total).
 */
export function solarObscurationAt(posS, moonPosS, sunDirS, sunAngRadiusRad = SUN_ANG_RADIUS_RAD) {
    const mx = moonPosS[0] - posS[0], my = moonPosS[1] - posS[1], mz = moonPosS[2] - posS[2];
    const dm = Math.hypot(mx, my, mz);
    if (!(dm > MOON_RADIUS_ER)) return 0; // degenerate geometry (observer inside the Moon)
    const ro = Math.asin(MOON_RADIUS_ER / dm);
    const sx = sunDirS[0], sy = sunDirS[1], sz = sunDirS[2];
    // atan2 form keeps precision at the sub-degree separations that matter here.
    const cx = my * sz - mz * sy, cy = mz * sx - mx * sz, cz = mx * sy - my * sx;
    const sep = Math.atan2(Math.hypot(cx, cy, cz), mx * sx + my * sy + mz * sz);
    return 1 - discVisibleFraction(sunAngRadiusRad, ro, sep);
}
