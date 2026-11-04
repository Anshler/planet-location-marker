// Sampling policies for the renderer, pure (no three.js, no DOM).
//
//   halton(i, base)                  the radical inverse: a low-discrepancy sequence in [0, 1)
//   createSupersampler({samples})    idle progressive supersampling (ROADMAP idle-supersampling):
//                                    which rendered frames accumulate, with what weight and which
//                                    sub-pixel jitter, and whether the loop should draw another
//   viewMotionPx(prev, cur, opts)    how far (device px) the view moved between two camera poses
//   streakShutter(o)                 fast-time star streaks (ROADMAP fast-time-star-streaks): the
//                                    fraction of a frame the "shutter" stays open, or 0 (off)
//   strobeDim(px)                    line art and the Milky Way dim when the sky jumps this far a frame
//
// Supersampling, in short: when nothing moves, the loop keeps drawing, each frame offset by a
// Halton(2,3) sub-pixel jitter, and postfx blends it into a running mean: acc ← mix(acc, frame, w),
// w = 1/(n+1). After `samples` frames it parks (render-on-demand idles again). A frame that only
// moved sim time a sub-pixel (Live 1×: one snapshot every 0.5 s) keeps the history and joins it as
// an EMA sample (w = 1/samples), so the image never flips between aliased and clean; a drift of a
// pixel or so keeps a short history (w ≥ ½) and refines again; real motion bypasses it, and any
// other change starts afresh. Twinkle frames blend with w ≥ ½, so scintillation stays visible.

/** Below this view motion (device px) since the last accumulated frame, the history stays. */
export const SS_STILL_PX = 0.25;
/** Below this, the history is kept short (weight ≥ SS_DRIFT_WEIGHT) and refined again. */
export const SS_DRIFT_PX = 1.5;
export const SS_DRIFT_WEIGHT = 0.5;
/** The weight floor of a twinkle frame (star scintillation must not be averaged away). */
export const SS_TWINKLE_WEIGHT = 0.5;
/** The jitter sequence index wraps here (Halton(2,3) stays well spread over 64 samples). */
const JITTER_PERIOD = 64;

/**
 * The radical inverse of `i` in `base` (Halton sequence): 1 → ½, 2 → ¼, 3 → ¾ … in base 2.
 * @param {number} i non-negative integer
 * @param {number} base integer ≥ 2
 * @returns {number} [0, 1)
 */
export function halton(i, base) {
    let f = 1, r = 0, n = Math.floor(i);
    while (n > 0) {
        f /= base;
        r += f * (n % base);
        n = Math.floor(n / base);
    }
    return r;
}

/**
 * Idle progressive supersampling: the accumulation policy (render/supersample.js is the pass).
 *
 * `next(kind, movedPx, out)` decides for the frame about to be drawn:
 * - 'motion'  the camera, a tween, fast time, the intro or a held pointer: no accumulation (null)
 * - 'fresh'   anything else changed (layers, selection, a texture, a time jump…): a new history
 * - 'idle'    an extra frame drawn only to refine the history (the loop asks while `wants`)
 * - 'drift'   only sim time moved (the frame snapshot, camera still); `movedPx` decides
 * - 'twinkle' a frame drawn for star twinkle
 * It returns `out` filled with {x, y} (the jitter, device px in −½…½, 0 for a fresh sample) and
 * {weight} (the blend of this frame into the history, 1 = replace), or null for no accumulation.
 * @param {{samples?:number}} [opts] samples: the cap (0 turns it off)
 */
export function createSupersampler({ samples = 0 } = {}) {
    let K = Math.max(0, Math.floor(samples) || 0);
    let n = 0;
    let idx = 0;

    function jitter(out) {
        if (idx === 0) {
            out.x = 0;
            out.y = 0;
        } else {
            out.x = halton(idx, 2) - 0.5;
            out.y = halton(idx, 3) - 0.5;
        }
        idx = (idx + 1) % JITTER_PERIOD || 1;
        return out;
    }

    function fresh(out) {
        n = 1;
        idx = 0;
        out.weight = 1;
        return jitter(out);
    }

    return {
        /** The sample cap (the tier's). Setting it starts afresh. */
        get samples() { return K; },
        set samples(v) {
            K = Math.max(0, Math.floor(v) || 0);
            n = 0;
            idx = 0;
        },
        /** Samples in the history (0: none, the next frame starts one). */
        get count() { return n; },
        /** True while another idle frame would refine the history. */
        get wants() { return K > 1 && n > 0 && n < K; },
        /** Drops the history: the next accumulated frame starts a new one. */
        reset() {
            n = 0;
            idx = 0;
        },
        /**
         * @param {'motion'|'fresh'|'idle'|'drift'|'twinkle'} kind
         * @param {number} movedPx view motion since the last accumulated frame (device px)
         * @param {{x:number, y:number, weight:number}} out
         * @returns {{x:number, y:number, weight:number}|null}
         */
        next(kind, movedPx, out) {
            if (K <= 1 || kind === 'motion') {
                n = 0;
                idx = 0;
                return null;
            }
            if (n === 0 || kind === 'fresh' || !(movedPx <= SS_DRIFT_PX)) return fresh(out);
            let w;
            if (kind === 'idle') {
                w = 1 / (n + 1);
            } else if (movedPx > SS_STILL_PX) {
                // A pixel or so of drift: a short history (some motion blur), then refine again.
                w = Math.max(SS_DRIFT_WEIGHT, 1 / (Math.min(n, K - 1) + 1));
                n = Math.min(n, 1);
            } else {
                w = 1 / (Math.min(n, K - 1) + 1);
                if (kind === 'twinkle') w = Math.max(w, SS_TWINKLE_WEIGHT);
            }
            n = Math.min(n + 1, K);
            out.weight = w;
            return jitter(out);
        },
    };
}

/**
 * How far (device px) the view moved between two camera poses: the rotation (directions at
 * infinity) plus, away from the sky view, the parallax of the nearest surface (the globe, radius 1
 * at the origin). Any projection change counts as a cut (Infinity).
 * @param {ArrayLike<number>} prevW previous camera matrixWorld (column-major 4×4)
 * @param {ArrayLike<number>} curW current camera matrixWorld
 * @param {{prevP:ArrayLike<number>, curP:ArrayLike<number>, heightPx:number, sky?:boolean}} o
 *   projection matrices (column-major), the drawing buffer's height, sky view (no near parallax)
 * @returns {number}
 */
export function viewMotionPx(prevW, curW, { prevP, curP, heightPx, sky = false }) {
    for (let i = 0; i < 16; i++) {
        const a = prevP[i], b = curP[i];
        if (!(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)))) return Infinity;
    }
    // Chord lengths of the right and backward axes: the rotation angle for small turns.
    const dx = Math.hypot(curW[0] - prevW[0], curW[1] - prevW[1], curW[2] - prevW[2]);
    const dz = Math.hypot(curW[8] - prevW[8], curW[9] - prevW[9], curW[10] - prevW[10]);
    let rad = Math.max(dx, dz);
    if (!sky) {
        const px = curW[12], py = curW[13], pz = curW[14];
        const moved = Math.hypot(px - prevW[12], py - prevW[13], pz - prevW[14]);
        rad += moved / Math.max(Math.hypot(px, py, pz) - 1, 0.02);
    }
    const pxPerRad = Math.abs(curP[5]) * Math.max(1, heightPx) / 2;
    const out = rad * pxPerRad;
    return Number.isFinite(out) ? out : Infinity;
}

/** Fast time below this rate (sim s per s) never streaks: a drag at Live 1× stays crisp. */
export const STREAK_MIN_RATE = 600;
/** Streaks stop (and the previous pose is dropped) after a frame gap longer than this (ms). */
export const STREAK_MAX_DT_MS = 100;
/** A turn larger than this between two frames (rad, ≈ 34°) is a cut, not motion. */
export const STREAK_CUT_RAD = 0.6;

/**
 * The streak shutter for a frame: the fraction of the frame's motion a star is smeared over (a
 * 180° shutter, ½; a whole frame, 1, while a long exposure stacks, so the trails join up), or 0.
 * @param {{simRate:number, dtMs:number, capPx:number, reducedMotion?:boolean, exposing?:boolean}} o
 * @returns {number}
 */
export function streakShutter({ simRate, dtMs, capPx, reducedMotion = false, exposing = false }) {
    if (!(capPx > 0) || reducedMotion) return 0;
    if (!(Math.abs(simRate) >= STREAK_MIN_RATE)) return 0;
    if (!(dtMs > 0 && dtMs <= STREAK_MAX_DT_MS)) return 0;
    return exposing ? 1 : 0.5;
}

/**
 * Dimming of line art (constellation figures) and the Milky Way when the sky jumps `px` device
 * pixels per frame: steady up to 8 px, then ∝ 1/√px, never below ¼. A strobing figure drawn at
 * full strength reads as flicker; a faint one reads as motion.
 * @param {number} px
 * @returns {number} 0.25…1
 */
export function strobeDim(px) {
    if (!(px > 8)) return 1;
    return Math.max(0.25, Math.sqrt(8 / px));
}
