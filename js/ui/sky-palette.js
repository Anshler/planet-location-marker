/**
 * The sky's colour by the Sun's altitude (SPEC F.2; ROADMAP sky-ribbon-scrubber), shared by the
 * time bar's scrubber and the Tonight chart: day blues that brighten toward noon, a subtle
 * golden-hour amber from about +6° down to sunset (−0.833°), rose turning violet through civil
 * twilight, indigo for nautical, a deeper indigo for astronomical twilight and near-black night.
 * Saturation stays low so the strip reads as sky rather than decoration, and every colour keeps
 * the bar's light text (#e8edf6) at 4.5:1 or better (test/ui.timebar.test.mjs).
 *
 * @module ui/sky-palette
 */

export const C_DAY = [0x2d, 0x4a, 0x6b];
export const C_NOON = [0x3a, 0x62, 0x8e];
export const C_GOLD = [0x6e, 0x55, 0x3c];
export const C_ROSE = [0x5a, 0x3a, 0x52];
export const C_VIOLET = [0x37, 0x2c, 0x5a];
export const C_NAUT = [0x1d, 0x21, 0x4a];
export const C_ASTRO = [0x10, 0x13, 0x2c];
export const C_NIGHT = [0x07, 0x09, 0x12];

/** The lookup covers −30°…+60° in 0.1° steps. */
export const LUT_MIN = -30, LUT_STEP = 0.1, LUT_N = 901;

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Smoothstep from e0 to e1 (either order). */
export function smooth(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/** The colour of one twilight zone (−18, −12, −6 and −0.833° bound them). */
function zone(alt) {
    if (alt < -18) return C_NIGHT;
    if (alt < -12) return C_ASTRO;
    if (alt < -6) return C_NAUT;
    if (alt < -0.833) return mix(C_ROSE, C_VIOLET, smooth(-0.833, -6, alt));
    if (alt < 6.5) return mix(C_GOLD, C_DAY, smooth(1, 6.5, alt));
    return mix(C_DAY, C_NOON, smooth(6.5, 50, alt));
}

/**
 * Altitude → RGB, LUT_N entries, with short blends across the zone boundaries.
 * @returns {Uint8ClampedArray}
 */
export function buildLut() {
    const lut = new Uint8ClampedArray(LUT_N * 3);
    for (let i = 0; i < LUT_N; i += 1) {
        const alt = LUT_MIN + i * LUT_STEP;
        const c = mix(zone(alt - 0.6), zone(alt + 0.6), 0.5);
        lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
    }
    return lut;
}

/** The shared lookup (built once). */
export const SKY_LUT = buildLut();

/**
 * Offset of a Sun altitude's colour in SKY_LUT (clamped to the table; NaN reads as night).
 * @param {number} alt degrees
 * @returns {number}
 */
export function skyLutIndex(alt) {
    const a = alt > LUT_MIN ? Math.min(alt, LUT_MIN + (LUT_N - 1) * LUT_STEP) : LUT_MIN;
    return Math.round((a - LUT_MIN) / LUT_STEP) * 3;
}
