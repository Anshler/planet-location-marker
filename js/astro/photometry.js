/**
 * Photometry and sky-brightness helpers: star colours, magnitudes,
 * refraction, airmass, twilight classes, the naked-eye limiting magnitude, the
 * eye's adapting luminance (night vision) and the exposure curves that the
 * renderers use to fade stars/planets/Milky Way with the Sun's altitude and
 * the night sky's brightness (js/astro/skyglow.js).
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
 * Refraction for an apparent altitude (Bennett 1982): R = 1′ / tan(h + 7.31/(h + 4.4)), in degrees,
 * clamped at h = −1°. The inverse of {@link refractionDeg} to 0.1′ for true altitudes above −0.6°
 * (0.4′ at −0.9°); DISC_FRAG (bodies.glsl.js)
 * uses it to map a fragment's apparent altitude back to true altitude, which flattens a low disc.
 * @param {number} appAltDeg
 * @returns {number} Degrees to subtract from the apparent altitude.
 */
export function refractionFromApparentDeg(appAltDeg) {
    if (!(appAltDeg >= -90 && appAltDeg <= 90)) return 0;
    const h = appAltDeg < -1 ? -1 : appAltDeg;
    return 1 / Math.tan((h + 7.31 / (h + 4.4)) * DEG) / 60;
}

/**
 * Lifts a direction by atmospheric refraction: its altitude above the plane normal to `up` grows by
 * k·{@link refractionDeg}(altitude), its azimuth is kept. This is what the sky view draws (k = the
 * view blend; INFINITY_VERT_CHUNK's refractLift in GLSL), so a setting Sun sits on the horizon at
 * the almanac's sunset. The zenith and nadir are returned unchanged.
 * @param {ArrayLike<number>} dir unit vector
 * @param {ArrayLike<number>} up unit zenith
 * @param {number} k strength, 0 (none) … 1 (full refraction)
 * @param {Float64Array|number[]} out may alias `dir`
 * @returns {Float64Array|number[]} out
 */
export function liftByRefraction(dir, up, k, out) {
    const x = dir[0], y = dir[1], z = dir[2];
    const s = Math.min(1, Math.max(-1, x * up[0] + y * up[1] + z * up[2]));
    const hx = x - up[0] * s, hy = y - up[1] * s, hz = z - up[2] * s;
    const l = Math.hypot(hx, hy, hz);
    if (!(k > 0) || !(l > 1e-9)) {
        out[0] = x; out[1] = y; out[2] = z;
        return out;
    }
    const alt = Math.asin(s) / DEG;
    const a = Math.min(90, alt + k * refractionDeg(alt)) * DEG;
    const c = Math.cos(a) / l, sn = Math.sin(a);
    out[0] = hx * c + up[0] * sn;
    out[1] = hy * c + up[1] * sn;
    out[2] = hz * c + up[2] * sn;
    return out;
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
 * The star shader's limiting magnitude at star exposure `e` on a tier whose dark-sky limit is
 * `tierMagLimit` (TierCfg.starMagLimit): STAR_VERT's lim = mix(−1, uMagLimit, √e)
 * (js/render/shaders/sky.glsl.js). Stars within about 0.4 mag of it fade out.
 * @param {number} e Star exposure 0..1 (clamped).
 * @param {number} tierMagLimit
 * @returns {number}
 */
export function starLimitMag(e, tierMagLimit) {
    const x = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 0));
    return -1 + (tierMagLimit + 1) * Math.sqrt(x);
}

/**
 * Inverse of {@link starLimitMag}: the star exposure at which the shader's limit is `mag`
 * (0 for a limit at or brighter than −1, 1 at the tier's own limit or fainter).
 * @param {number} mag
 * @param {number} tierMagLimit
 * @returns {number} 0..1
 */
export function starExposureForLimit(mag, tierMagLimit) {
    const r = (mag + 1) / (tierMagLimit + 1);
    return r > 0 ? Math.min(1, r * r) : 0;
}

/**
 * Naked-eye limiting magnitude in mid-totality: the planets and roughly the first- and
 * second-magnitude stars. Real totality skies reach about 1.5 to 3 depending on the size of the
 * umbra and the haze; this is a mid value.
 */
export const TOTALITY_STAR_LIMIT_MAG = 2.0;
// Light of the totality sky (corona, light scattered in from outside the umbra) relative to the
// uneclipsed daylight sky, and how much the limit brightens per decade of sky light: against a
// bright background the threshold flux grows about as √B, i.e. 1.25 mag per decade.
const TOTALITY_SKY_LIGHT = 1e-5;
const MAG_PER_DECADE = 1.25;

/**
 * Limiting magnitude for stars during a solar eclipse, from the observer's obscuration. The
 * photosphere left shines (1 − obscuration)^1.4 of full (limb darkening makes the last crescent
 * dimmer than its area; the same light as js/render/ground.js ECL_ADAPT), on top of the totality
 * sky's own TOTALITY_SKY_LIGHT, and the limit is TOTALITY_STAR_LIMIT_MAG − 1.25·log10 of their
 * sum over the latter. So the stars come out in the last ~20 s before second contact: Sirius-class
 * stars at 1e-4 of the sunlight left (limit ≈ 0.7), the full totality set at second contact.
 * @param {number} obscuration 0..1 (snap.eclipse.obscurationAtObserver)
 * @returns {number} Magnitude; −Infinity without an eclipse.
 */
export function eclipseStarLimitMag(obscuration) {
    if (!(obscuration > 0)) return -Infinity;
    const light = Math.pow(1 - Math.min(1, obscuration), 1.4);
    return TOTALITY_STAR_LIMIT_MAG - MAG_PER_DECADE * Math.log10(1 + light / TOTALITY_SKY_LIGHT);
}

/**
 * Naked-eye limiting magnitude for a sky of `sqm` mag/arcsec² (V): the Schaefer-type fit
 * 7.93 − 5·log10(10^(4.316 − sqm/5) + 1) behind Unihedron's SQM → NELM conversion. A pristine
 * 22.0 gives 6.6, a rural 21.0 gives 6.1, a city's 18.2 gives 4.1 and a full-Moon sky (≈ 17.9)
 * 3.9. The sky shaders mirror it per direction (js/render/shaders/skyglow.glsl.js sgLimitMag).
 * @param {number} sqm Sky brightness in mag/arcsec² (non-finite → 22).
 * @returns {number}
 */
export function limitingMag(sqm) {
    const b = Number.isFinite(sqm) ? sqm : 22;
    return 7.93 - 5 * Math.log10(Math.pow(10, 4.316 - b / 5) + 1);
}

// log10 of the twilight sky's own zenith luminance (cd/m²) by solar altitude: about 150 cd/m² at
// sunset, 1 at the end of civil twilight, 2.5e-3 at nautical and a few 1e-5 at astronomical
// (horizontal illuminance over π: ≈ 500, 3, 0.008 lux…). Below −18° the slope continues, so the
// natural night sky (≈ 1.7e-4 cd/m²) takes over.
const TWILIGHT_LOG_LUM = [[-18, -4.6], [-12, -2.6], [-6, 0], [0, 2.2], [10, 3.5], [90, 4]];
/** One nanolambert in cd/m² (1e-9 lambert × 10⁴/π). */
export const NL_TO_CDM2 = 1e-5 / Math.PI;

/**
 * The luminance an observer's eyes adapt to (cd/m²): the twilight sky's zenith (table above),
 * dimmed by a solar eclipse like {@link eclipseStarLimitMag}'s light, plus the night sky's own
 * brightness (js/astro/skyglow.js: airglow, moonlight and light pollution).
 * @param {number} sunAltDeg
 * @param {number} [skyNl=54] Night-sky zenith brightness in nanolamberts.
 * @param {number} [obscuration=0] Solar-eclipse obscuration at the observer, 0..1.
 * @returns {number}
 */
export function adaptingLuminance(sunAltDeg, skyNl = 54, obscuration = 0) {
    const a = Number.isFinite(sunAltDeg) ? Math.min(90, sunAltDeg) : -90;
    const T = TWILIGHT_LOG_LUM;
    let i = 0;
    while (i < T.length - 2 && a > T[i + 1][0]) i++;
    const [a0, l0] = T[i], [a1, l1] = T[i + 1];
    let tw = Math.pow(10, l0 + ((l1 - l0) * (a - a0)) / (a1 - a0));
    if (obscuration > 0) tw *= Math.pow(1 - Math.min(1, obscuration), 1.4) + 1e-5;
    return tw + Math.max(0, Number.isFinite(skyNl) ? skyNl : 54) * NL_TO_CDM2;
}

/**
 * Adapting luminance (cd/m²) that lit surroundings add per natural-sky unit of artificial zenith
 * light (js/astro/skyglow.js lpZenith): a city centre (≈ 100 units) adapts the eye to ≈ 1 cd/m².
 * Illustrative.
 */
export const STREET_ADAPT_CDM2 = 0.01;

/**
 * Rod share of vision, 0 (photopic, cones) … 1 (scotopic): falls across the mesopic range
 * 0.005–3 cd/m² on a log scale (smoothstep in log10 L).
 * @param {number} cdm2 Adapting luminance (cd/m²).
 * @returns {number}
 */
export function scotopicWeight(cdm2) {
    const l = Math.log10(Math.max(1e-9, Number.isFinite(cdm2) ? cdm2 : 1e-9));
    return 1 - smoothstep(Math.log10(0.005), Math.log10(3), l);
}

/**
 * Exposure multipliers for stars, planets and the Milky Way, and the night-vision weight.
 * In orbit view (skyBlend 0) the three are 1 and `vision` is 0. In sky view:
 *   stars    = min(max(1 − smoothstep(−18, −4, sunAlt), eclipse term), sky term)
 *   planets  = max(0.15, 1 − 0.85·smoothstep(−8, 4, sunAlt))
 *   milkyWay = 1 − smoothstep(−20, −10, sunAlt)
 *   vision   = scotopicWeight(adaptingLuminance(sunAlt, sky.zenithNl, obscuration) + street light)
 * and intermediate skyBlend values blend linearly between the two. The eclipse term is the star
 * exposure that puts the tier's limit at {@link eclipseStarLimitMag}: about magnitude 2 in
 * totality on every tier, rising over the last ~20 s before second contact. The sky term puts it
 * at the night sky's own zenith limit, `sky.limitMag` ({@link limitingMag} of the moonlit and
 * light-polluted sky, js/astro/skyglow.js): about 4 under a full Moon or in a city. The Milky Way
 * stays a function of the Sun's altitude here (dark only at night, as in a real totality); the
 * sky shaders fade it by the local sky brightness themselves.
 * @param {number} sunAltDeg Sun altitude at the observer (NaN → night).
 * @param {number} skyBlend 0 = orbit view, 1 = sky view.
 * @param {{stars:number, planets:number, milkyWay:number, vision?:number}} [out] Reused when given (per-frame callers).
 * @param {number} [obscuration=0] Solar-eclipse obscuration at the observer, 0..1.
 * @param {number} [tierMagLimit=6] The tier's dark-sky star limit (TierCfg.starMagLimit).
 * @param {{limitMag:number, zenithNl:number, lpZenith?:number}|null} [sky] The night sky (snap.skyglow); none = pristine.
 * @returns {{stars:number, planets:number, milkyWay:number, vision:number}}
 */
export function exposureFor(sunAltDeg, skyBlend, out, obscuration = 0, tierMagLimit = 6, sky = null) {
    const k = Math.min(1, Math.max(0, Number.isFinite(skyBlend) ? skyBlend : 0));
    const a = Number.isFinite(sunAltDeg) ? sunAltDeg : -90;
    const lim = Number.isFinite(tierMagLimit) && tierMagLimit > -1 ? tierMagLimit : 6;
    const skyLim = sky && Number.isFinite(sky.limitMag) ? starExposureForLimit(sky.limitMag, lim) : 1;
    const stars = Math.min(skyLim, Math.max(1 - smoothstep(-18, -4, a), starExposureForLimit(eclipseStarLimitMag(obscuration), lim)));
    const planets = Math.max(0.15, 1 - 0.85 * smoothstep(-8, 4, a));
    const milkyWay = 1 - smoothstep(-20, -10, a);
    // In a town the eyes adapt to lit streets, not to the sky: STREET_ADAPT_CDM2 per unit of
    // artificial zenith light (≈ 1 cd/m², mesopic, in a city centre).
    const street = sky && sky.lpZenith > 0 ? STREET_ADAPT_CDM2 * sky.lpZenith : 0;
    const vision = scotopicWeight(adaptingLuminance(a, sky ? sky.zenithNl : undefined, obscuration) + street);
    const o = out || { stars: 1, planets: 1, milkyWay: 1, vision: 0 };
    o.stars = 1 + (stars - 1) * k;
    o.planets = 1 + (planets - 1) * k;
    o.milkyWay = 1 + (milkyWay - 1) * k;
    o.vision = vision * k;
    return o;
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/**
 * How visible a star of magnitude `mag` is drawn, 0…1: STAR_VERT's
 * smoothFall(lim + 0.35, lim − 0.45, mag) · smoothstep(0, 0.04, e).
 * @param {number} mag
 * @param {number} e star exposure, 0…1
 * @param {number} magLimit the tier's limiting magnitude
 * @returns {number}
 */
export function starVisibility(mag, e, magLimit) {
    const ee = clamp01(e);
    const lim = starLimitMag(ee, magLimit);
    return smoothstep(lim + 0.35, lim - 0.45, mag) * smoothstep(0, 0.04, ee);
}

/**
 * Brightness of the sky behind the labels, 0…1 (their halo style): smoothstep(−6°, 10°, h☉) in sky
 * view, dark again in totality (smoothstep(0.9, 1, obscuration)), 0 from orbit.
 * @param {number} sunAltDeg
 * @param {number} obscuration solar-eclipse obscuration at the observer, 0…1
 * @param {number} skyBlend 0 = orbit view, 1 = sky view
 * @returns {number}
 */
export function skyBrightness(sunAltDeg, obscuration, skyBlend) {
    const a = Number.isFinite(sunAltDeg) ? sunAltDeg : -90;
    const ecl = smoothstep(0.9, 1.0, Number.isFinite(obscuration) ? obscuration : 0);
    return smoothstep(-6, 10, a) * (1 - ecl) * clamp01(skyBlend);
}
