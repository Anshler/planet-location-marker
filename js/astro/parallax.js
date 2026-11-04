/**
 * Two places, one sky (ROADMAP two-observers): how a body's direction differs between two
 * observers at the same instant. For the Moon this is its parallax, the angle Lalande and Lacaille
 * measured from Berlin and the Cape of Good Hope in 1751–52 to find how far away it is: the part of
 * the baseline square to the line of sight, divided by the angle (small-angle triangulation).
 *
 * Pure: reads two snapshots (astro/snapshot.js) computed for the same instant; allocates nothing
 * when given `out`.
 *
 * @module astro/parallax
 */
import { EARTH_RADIUS_KM } from './bodies.js';
import { angleBetween3, RAD2DEG } from './frames.js';

/**
 * @typedef {{sepDeg:number, baselineKm:number, perpKm:number, distKm:number}} SightCompare
 *   sepDeg: angle between the two topocentric directions; baselineKm: the straight line between the
 *   two places (through the Earth); perpKm: its part square to the line of sight; distKm: perpKm /
 *   angle, the distance the two sightlines imply (NaN when the angle is too small to measure)
 */

/**
 * Compares body `index` (BODIES order) as seen from snapshot A's and snapshot B's observers.
 * @param {import('../core/types.js').Snapshot} snapA
 * @param {import('../core/types.js').Snapshot} snapB
 * @param {number} index
 * @param {SightCompare} [out]
 * @returns {SightCompare|null} null when either snapshot lacks the body
 */
export function compareSight(snapA, snapB, index, out = { sepDeg: 0, baselineKm: 0, perpKm: 0, distKm: NaN }) {
    const a = snapA?.bodies?.[index]?.dirS, b = snapB?.bodies?.[index]?.dirS;
    const pa = snapA?.observer?.posS, pb = snapB?.observer?.posS;
    if (!a || !b || !pa || !pb) return null;
    const sep = angleBetween3(a, b);
    // Baseline (Earth radii; the pins sit on the unit sphere) and the mean line of sight.
    const bx = pb[0] - pa[0], by = pb[1] - pa[1], bz = pb[2] - pa[2];
    let mx = a[0] + b[0], my = a[1] + b[1], mz = a[2] + b[2];
    const ml = Math.hypot(mx, my, mz) || 1;
    mx /= ml; my /= ml; mz /= ml;
    const along = bx * mx + by * my + bz * mz;
    const perp = Math.sqrt(Math.max(0, bx * bx + by * by + bz * bz - along * along));
    out.sepDeg = sep * RAD2DEG;
    out.baselineKm = Math.hypot(bx, by, bz) * EARTH_RADIUS_KM;
    out.perpKm = perp * EARTH_RADIUS_KM;
    // The two sightlines meet at the body: d = perp / (2 sin(θ/2)) for a baseline square to them.
    out.distKm = sep > 1e-7 ? out.perpKm / (2 * Math.sin(sep / 2)) : NaN;
    return out;
}
