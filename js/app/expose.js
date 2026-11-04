// Long-exposure presets (ROADMAP lighten-stacking-exposure). Pure: the actions apply them (clock,
// rig, store) and render/long-exposure.js does the stacking.
//
//   'trails'    star trails: tonight once the Sun is 12° down, 10 min/s, tracking off, the view on
//               the visible celestial pole with the landscape in the lower part of the frame.
//   'analemma'  the Sun at the same mean solar time every day for a year: a one-year range with a
//               one-day stride (clock.setRange strideMs, frame-paced), framed on the figure-8 with
//               the horizon in view where it fits.
//   'free'      stack whatever the user does with the clock and the view.
//
// While exposing, the line art (constellation figures, grids, the ecliptic, planet paths) is hidden
// from the renderers (photoLayers): it turns with the sky and would smear into the stack. The store's
// layers are untouched, so the URL, the Layers panel and the prefs keep the user's choice.

import { BODY_INDEX } from '../astro/bodies.js';
import { computeSnapshot } from '../astro/snapshot.js';

export const EXPOSE_KINDS = Object.freeze(['trails', 'analemma', 'free']);
/** Star trails run at 10 min/s: a ten-hour night in a minute, ~0.7 px of arc per frame at 60 fps. */
export const TRAILS_RATE = 600;
export const TRAILS_FOV_DEG = 80;
/** Star trails start once the Sun is this far down (nautical twilight's end). */
export const DARK_SUN_DEG = -12;
/** The analemma: days stacked (0…364) and the timelapse length. */
export const ANALEMMA_DAYS = 365;
export const ANALEMMA_S = 20;
/** Layers the renderers do not draw while exposing. */
export const EXPOSE_HIDDEN_LAYERS = Object.freeze(['constellations', 'eqGrid', 'ecliptic', 'altAzGrid', 'trails', 'subpoints', 'footprint', 'sunPath']);

const DAY = 864e5;
const MIN = 6e4;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * The layers the renderers get while exposing (a new object; the input is not modified).
 * @param {Record<string, boolean>} layers
 * @returns {Record<string, boolean>}
 */
export function photoLayers(layers) {
    const out = { ...layers };
    for (const k of EXPOSE_HIDDEN_LAYERS) if (k in out) out[k] = false;
    return out;
}

/**
 * The star-trails framing: the visible celestial pole (north of the equator the north pole, south
 * of it the south pole) about a fifth of the field above the centre, so the arcs circle it over the
 * landscape.
 * @param {number} latDeg
 * @param {number} [fovDeg]
 * @returns {{azDeg:number, altDeg:number, fovDeg:number}}
 */
export function trailsLook(latDeg, fovDeg = TRAILS_FOV_DEG) {
    const lat = Number.isFinite(latDeg) ? latDeg : 0;
    return { azDeg: lat < 0 ? 180 : 0, altDeg: clamp(Math.abs(lat) - fovDeg * 0.22, 10, 75), fovDeg };
}

/**
 * The first moment at or after `tMs` (10-min steps, up to `maxHours`) with the Sun below
 * DARK_SUN_DEG, or null when it never gets that dark (polar summer).
 * @param {number} tMs
 * @param {import('../core/types.js').Observer} observer
 * @param {import('../core/types.js').Snapshot} scratch a preallocated snapshot to compute into
 * @param {number} [maxHours]
 * @returns {number|null}
 */
export function nextDarkMs(tMs, observer, scratch, maxHours = 30) {
    for (let t = tMs, end = tMs + maxHours * 36e5; t <= end; t += 10 * MIN) {
        computeSnapshot(t, observer, scratch, { detail: 'frame' });
        if (scratch.observer.sunAltDeg < DARK_SUN_DEG) return t;
    }
    return null;
}

/**
 * Mean solar noon (UTC ms, whole minute) of the observer's local solar day containing `tMs`.
 * @param {number} tMs
 * @param {number} lonDeg
 */
export function meanNoonMs(tMs, lonDeg) {
    const shift = (lonDeg / 15) * 36e5;
    const d = new Date(tMs + shift);
    const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) - shift;
    return Math.round(noon / MIN) * MIN;
}

/**
 * The analemma: a one-year, one-day-stride range at mean solar noon from the day of `tMs`, and a
 * sky look framing the Sun's figure-8 (sampled every 14 days), widened down to the horizon when the
 * figure sits low enough for the landscape to fit.
 * @param {number} tMs
 * @param {import('../core/types.js').Observer} observer
 * @param {import('../core/types.js').Snapshot} scratch
 * @returns {{range:{fromMs:number, toMs:number, durationS:number, loop:'once', strideMs:number},
 *   look:{azDeg:number, altDeg:number, fovDeg:number}}}
 */
export function analemmaPlan(tMs, observer, scratch) {
    const fromMs = meanNoonMs(tMs, observer.lonDeg);
    const toMs = fromMs + (ANALEMMA_DAYS - 1) * DAY;
    let lo = Infinity, hi = -Infinity, sx = 0, sy = 0;
    for (let k = 0; k < ANALEMMA_DAYS; k += 14) {
        computeSnapshot(fromMs + k * DAY, observer, scratch, { detail: 'frame' });
        const sun = scratch.bodies[BODY_INDEX.sun];
        lo = Math.min(lo, sun.altDeg);
        hi = Math.max(hi, sun.altDeg);
        // Azimuths averaged as vectors, weighted toward the low part of the figure (high up the
        // azimuth swings fast and means little).
        const w = Math.cos(sun.altDeg * Math.PI / 180);
        sx += w * Math.cos(sun.azDeg * Math.PI / 180);
        sy += w * Math.sin(sun.azDeg * Math.PI / 180);
    }
    // Room for the Sun's glow and the UI's share of the screen above and below.
    const bottom = lo < 40 ? Math.min(lo - 6, -4) : lo - 6;
    const top = Math.min(90, hi + 10);
    const fovDeg = clamp(top - bottom, 30, 100);
    const azDeg = Math.hypot(sx, sy) > 1e-6 ? ((Math.atan2(sy, sx) * 180 / Math.PI) + 360) % 360 : (observer.latDeg >= 0 ? 180 : 0);
    return {
        range: { fromMs, toMs, durationS: ANALEMMA_S, loop: 'once', strideMs: DAY },
        look: { azDeg, altDeg: clamp((top + bottom) / 2, -5, 85), fovDeg },
    };
}
