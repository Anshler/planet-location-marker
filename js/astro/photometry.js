/**
 * Photometry and sky-brightness helpers: star colours, magnitudes,
 * refraction, airmass, twilight classes and the exposure curves that the
 * renderers use to fade stars/planets/Milky Way with the Sun's altitude.
 *
 * The refraction formula mirrors astronomy-engine's 'normal' model exactly so
 * that numbers printed in the UI and any GLSL port agree with AE.Horizon.
 *
 * @module astro/photometry
 */

const DEG = Math.PI / 180;

/**
 * Hermite smoothstep, as in GLSL. Works for edge0 > edge1 too (reversed ramp).
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number} 0..1
 */
export function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * B−V colour index → effective temperature in kelvin (Ballesteros 2012):
 * T = 4600·(1/(0.92·bv + 1.7) + 1/(0.92·bv + 0.62)).
 * The index is clamped to [−0.4, 2.0], the range where the fit is meaningful
 * (and well clear of its pole at bv ≈ −0.67). B−V 0.65 gives ≈ 5780 K.
 * @param {number} bv
 * @returns {number}
 */
export function bvToKelvin(bv) {
    const b = Number.isFinite(bv) ? Math.min(2.0, Math.max(-0.4, bv)) : 0.6;
    return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

// Multi-lobe Gaussian fit of the CIE 1931 2° colour-matching functions
// (Wyman, Sloan & Shirley 2013); accurate to a few per cent, no tables needed.
function lobe(l, mu, s1, s2) {
    const t = (l - mu) / (l < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
}
function cieX(l) { return 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2); }
function cieY(l) { return 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1); }
function cieZ(l) { return 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8); }

const C2_NM_K = 1.438776877e7; // second radiation constant hc/k in nm·K

/**
 * Blackbody colour at temperature K, in linear sRGB (D65), scaled so the
 * largest component is 1. Integrates Planck's law against the CIE 1931
 * observer over 380–780 nm.
 * @param {number} kelvin Clamped to [1000, 40000].
 * @param {number[]|Float32Array|Float64Array} [out]
 * @returns {number[]|Float32Array|Float64Array} [r, g, b]
 */
export function kelvinToRgb(kelvin, out = [0, 0, 0]) {
    const T = Math.min(40000, Math.max(1000, Number.isFinite(kelvin) ? kelvin : 5800));
    let X = 0, Y = 0, Z = 0;
    for (let l = 380; l <= 780; l += 5) {
        // Planck spectral radiance up to a constant factor; λ in nm.
        const b = 1 / (Math.pow(l / 500, 5) * Math.expm1(C2_NM_K / (l * T)));
        X += b * cieX(l);
        Y += b * cieY(l);
        Z += b * cieZ(l);
    }
    let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    let g = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
    let bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    // Very hot or cool blackbodies fall slightly outside the sRGB gamut.
    r = Math.max(0, r); g = Math.max(0, g); bl = Math.max(0, bl);
    const m = Math.max(r, g, bl) || 1;
    out[0] = r / m;
    out[1] = g / m;
    out[2] = bl / m;
    return out;
}

// B−V → RGB lookup table, built on first use (decodeSky colours ~5000 stars).
const BV_MIN = -0.4, BV_MAX = 2.0, BV_STEP = 0.01;
const BV_N = Math.round((BV_MAX - BV_MIN) / BV_STEP) + 1;
let bvLut = null;
function buildBvLut() {
    const lut = new Float64Array(BV_N * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < BV_N; i++) {
        kelvinToRgb(bvToKelvin(BV_MIN + i * BV_STEP), tmp);
        lut[i * 3] = tmp[0];
        lut[i * 3 + 1] = tmp[1];
        lut[i * 3 + 2] = tmp[2];
    }
    return lut;
}

/**
 * B−V colour index → linear sRGB star colour with max component 1, via the
 * Ballesteros temperature and a blackbody fit (interpolated lookup table).
 * Non-finite input (missing catalogue value) is treated as 0.6 (Sun-like).
 * @param {number} bv
 * @param {number[]|Float32Array|Float64Array} [out]
 * @returns {number[]|Float32Array|Float64Array} [r, g, b]
 */
export function bvToRgb(bv, out = [0, 0, 0]) {
    if (!bvLut) bvLut = buildBvLut();
    const b = Number.isFinite(bv) ? Math.min(BV_MAX, Math.max(BV_MIN, bv)) : 0.6;
    const f = (b - BV_MIN) / BV_STEP;
    const i = Math.min(BV_N - 2, Math.floor(f));
    const t = f - i;
    const a = i * 3, c = a + 3;
    out[0] = bvLut[a] + (bvLut[c] - bvLut[a]) * t;
    out[1] = bvLut[a + 1] + (bvLut[c + 1] - bvLut[a + 1]) * t;
    out[2] = bvLut[a + 2] + (bvLut[c + 2] - bvLut[a + 2]) * t;
    return out;
}

/**
 * Magnitude → relative flux, 10^(−0.4·m) (magnitude 0 → 1).
 * @param {number} m
 * @returns {number}
 */
export function magToFlux(m) {
    return Math.pow(10, -0.4 * m);
}

/**
 * Atmospheric refraction lift in degrees for a true (geometric) altitude:
 * Saemundsson's formula R = 1.02′ / tan(h + 10.3/(h + 5.11)), clamped at
 * h = −1° and tapered linearly to 0 at the nadir — identical to
 * astronomy-engine's Refraction('normal', h). refractionDeg(0) ≈ 0.483°.
 * @param {number} altDeg
 * @returns {number} Degrees to add to the true altitude.
 */
export function refractionDeg(altDeg) {
    if (!(altDeg >= -90 && altDeg <= 90)) return 0;
    const hd = altDeg < -1 ? -1 : altDeg;
    let r = (1.02 / Math.tan((hd + 10.3 / (hd + 5.11)) * DEG)) / 60;
    if (altDeg < -1) r *= (altDeg + 90) / 89;
    return r;
}

/**
 * Relative airmass (Kasten & Young 1989):
 * X = 1 / (sin h + 0.50572·(h + 6.07995°)^−1.6364). Altitudes below the
 * horizon are clamped to 0° (X ≈ 37.9) so callers never see Infinity.
 * @param {number} altDeg
 * @returns {number} 1 at the zenith.
 */
export function airmass(altDeg) {
    const h = Math.min(90, Math.max(0, Number.isFinite(altDeg) ? altDeg : 0));
    return 1 / (Math.sin(h * DEG) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

/**
 * Atmospheric extinction in magnitudes for an altitude, k·X(h).
 * @param {number} altDeg
 * @param {number} [k=0.2] Extinction coefficient (mag per airmass; ~0.2 at a good site in V).
 * @returns {number}
 */
export function extinctionMag(altDeg, k = 0.2) {
    return k * airmass(altDeg);
}

/** Sun-centre altitude (unrefracted) at sunrise/sunset: 34′ refraction + 16′ semi-diameter. */
export const SUNRISE_ALT_DEG = -0.833;

/**
 * Twilight class from the Sun's geometric (unrefracted, centre) altitude:
 * 'day' ≥ −0.833°, 'civil' ≥ −6°, 'nautical' ≥ −12°, 'astronomical' ≥ −18°,
 * otherwise 'night'. NaN is treated as night.
 * @param {number} sunAltDeg
 * @returns {'day'|'civil'|'nautical'|'astronomical'|'night'}
 */
export function twilightClass(sunAltDeg) {
    if (sunAltDeg >= SUNRISE_ALT_DEG) return 'day';
    if (sunAltDeg >= -6) return 'civil';
    if (sunAltDeg >= -12) return 'nautical';
    if (sunAltDeg >= -18) return 'astronomical';
    return 'night';
}

/**
 * Exposure multipliers for stars, planets and the Milky Way.
 * In orbit view (skyBlend 0) all three are 1. In sky view:
 *   stars    = 1 − smoothstep(−18, −4, sunAlt)
 *   planets  = max(0.15, 1 − 0.85·smoothstep(−8, 4, sunAlt))
 *   milkyWay = 1 − smoothstep(−20, −10, sunAlt)
 * and intermediate skyBlend values blend linearly between the two.
 * @param {number} sunAltDeg Sun altitude at the observer (NaN → night).
 * @param {number} skyBlend 0 = orbit view, 1 = sky view.
 * @param {{stars:number, planets:number, milkyWay:number}} [out] Reused when given (per-frame callers).
 * @returns {{stars:number, planets:number, milkyWay:number}}
 */
export function exposureFor(sunAltDeg, skyBlend, out) {
    const k = Math.min(1, Math.max(0, Number.isFinite(skyBlend) ? skyBlend : 0));
    const a = Number.isFinite(sunAltDeg) ? sunAltDeg : -90;
    const stars = 1 - smoothstep(-18, -4, a);
    const planets = Math.max(0.15, 1 - 0.85 * smoothstep(-8, 4, a));
    const milkyWay = 1 - smoothstep(-20, -10, a);
    const o = out || { stars: 1, planets: 1, milkyWay: 1 };
    o.stars = 1 + (stars - 1) * k;
    o.planets = 1 + (planets - 1) * k;
    o.milkyWay = 1 + (milkyWay - 1) * k;
    return o;
}
