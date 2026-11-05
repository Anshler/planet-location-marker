/**
 * The precessing sky (pure; no three.js, no DOM): where the celestial pole and the March equinox
 * point are among the J2000 stars at any date, for the time-machine sky's 'Precession' layer.
 *
 * - Of date (1000–3000, accurate): Astronomy Engine's Rotation_EQD_EQJ (IAU 2006 precession plus
 *   nutation) applied to the true pole and equinox of date. The snapshot's earthMatrix·ŷ is the
 *   same pole (render/precession.js uses that one live).
 * - The full 25,800-year circle (illustrative): the pole turning about the J2000 ecliptic pole at a
 *   fixed obliquity ε0 and a constant general precession of 50.29″/yr. Over millennia the obliquity
 *   swings between 22.1° and 24.5° and the ecliptic itself moves, so the circle's far side (Vega
 *   about 12,000 years from now) is good to a degree or two only, and the pole stars listed far
 *   from the clock's 1000–3000 range are labelled as illustrative.
 *
 * Directions are scene-frame unit vectors (frames.js: S maps EQJ (x, y, z) to (x, z, −y)).
 *
 * @module astro/precession
 */

import { AE } from './ae.js';
import { N_ } from '../core/i18n.js';

const DEG = Math.PI / 180;
/** Mean obliquity of the ecliptic at J2000, degrees (IAU 2006). */
export const OBLIQUITY_J2000_DEG = 23.4392911;
/** General precession in longitude, arcseconds per Julian year (IAU 2006, at J2000). */
export const PRECESSION_ARCSEC_PER_YEAR = 50.287;
/** One full turn of the pole, years (360° / 50.287″). */
export const PRECESSION_PERIOD_YEARS = 1296000 / PRECESSION_ARCSEC_PER_YEAR;
const YEAR_MS = 365.25 * 86400000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

/**
 * Stars near the pole's circle and when the pole passes closest (astronomical years; illustrative
 * outside 1000–3000). `hip` is the star's Hipparcos number.
 * @type {ReadonlyArray<{name:string, hip:number, year:number, label:string}>}
 */
export const POLE_STARS = Object.freeze([
    { name: 'Thuban', hip: 68756, year: -2830, label: N_('Thuban · 2830 BCE') },
    { name: 'Polaris', hip: 11767, year: 2102, label: N_('Polaris · closest 2102') },
    { name: 'Errai', hip: 116727, year: 4100, label: N_('Errai · ≈ 4100') },
    { name: 'Alderamin', hip: 105199, year: 7500, label: N_('Alderamin · ≈ 7500') },
    { name: 'Deneb', hip: 102098, year: 10200, label: N_('Deneb · ≈ 10,200') },
    { name: 'Vega', hip: 91262, year: 13700, label: N_('Vega · ≈ 13,700') },
]);

/** EQJ (x, y, z) → scene (x, z, −y), into out. */
function toScene(x, y, z, out) {
    out[0] = x; out[1] = z; out[2] = -y;
    return out;
}

/**
 * The true celestial north pole of date among the J2000 stars (scene unit vector).
 * @param {number} tMs UTC ms
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function poleOfDate(tMs, out = new Float64Array(3)) {
    const r = AE.Rotation_EQD_EQJ(AE.MakeTime(new Date(tMs))).rot;
    return toScene(r[2][0], r[2][1], r[2][2], out);
}

/**
 * The true March (vernal) equinox point of date among the J2000 stars (scene unit vector); the
 * September equinox is its opposite.
 * @param {number} tMs UTC ms
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function equinoxOfDate(tMs, out = new Float64Array(3)) {
    const r = AE.Rotation_EQD_EQJ(AE.MakeTime(new Date(tMs))).rot;
    return toScene(r[0][0], r[0][1], r[0][2], out);
}

/** UTC ms at the start of an astronomical year (proleptic Gregorian; Date handles years ≤ 0). */
export function yearToMs(year) {
    const d = new Date(Date.UTC(2000, 0, 1));
    d.setUTCFullYear(Math.trunc(year));
    return d.getTime() + (year - Math.trunc(year)) * YEAR_MS;
}

/**
 * The illustrative pole at astronomical year `year`: a fixed-rate turn about the J2000 ecliptic
 * pole (see the module note). In the J2000 ecliptic frame the pole of date sits at longitude
 * 90° − pA and colatitude ε0, pA = 50.287″·(year − 2000).
 * @param {number} year
 * @param {Float64Array|number[]} [out]
 * @returns {Float64Array|number[]}
 */
export function poleOnCircle(year, out = new Float64Array(3)) {
    const pA = PRECESSION_ARCSEC_PER_YEAR * ((yearToMs(year) - J2000_MS) / YEAR_MS) / 3600 * DEG;
    const e = OBLIQUITY_J2000_DEG * DEG;
    const se = Math.sin(e), ce = Math.cos(e);
    // Ecliptic (x toward the J2000 equinox, z the ecliptic pole) → EQJ: rotate about x by −ε.
    const xe = se * Math.sin(pA), ye = se * Math.cos(pA), ze = ce;
    return toScene(xe, ye * ce - ze * se, ye * se + ze * ce, out);
}

/**
 * The J2000 ecliptic north pole (the centre of the precession circle), scene unit vector.
 * @param {Float64Array|number[]} [out]
 */
export function eclipticPole(out = new Float64Array(3)) {
    const e = OBLIQUITY_J2000_DEG * DEG;
    return toScene(0, -Math.sin(e), Math.cos(e), out);
}

/**
 * The pole of date sampled from `fromYear` to `toYear` every `stepYears` (accurate; AE), as a flat
 * Float64Array of scene unit vectors (3 per sample). Built once, at load.
 * @param {number} fromYear
 * @param {number} toYear
 * @param {number} stepYears
 * @returns {Float64Array}
 */
export function poleTrack(fromYear, toYear, stepYears) {
    const n = Math.floor((toYear - fromYear) / stepYears) + 1;
    const out = new Float64Array(3 * n);
    const v = new Float64Array(3);
    for (let k = 0; k < n; k++) {
        poleOfDate(yearToMs(fromYear + k * stepYears), v);
        out.set(v, 3 * k);
    }
    return out;
}

/**
 * Angle between two scene directions, degrees.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function angleDeg(a, b) {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
    return Math.acos(Math.max(-1, Math.min(1, d / (la * lb || 1)))) / DEG;
}

/**
 * The constellation the March equinox point of date lies in (IAU boundaries): Pisces today,
 * Aquarius from about 2597.
 * @param {number} tMs
 * @returns {{symbol:string, name:string}|null}
 */
export function equinoxConstellation(tMs) {
    const v = equinoxOfDate(tMs);
    // scene → EQJ (x, −z, y) → RA/Dec, J2000 (the IAU boundaries are B1875, which AE handles).
    const x = v[0], y = -v[2], z = v[1];
    const ra = ((Math.atan2(y, x) / DEG) + 360) % 360;
    const dec = Math.asin(Math.max(-1, Math.min(1, z))) / DEG;
    try {
        const c = AE.Constellation(ra / 15, dec);
        return { symbol: c.symbol, name: c.name };
    } catch {
        return null;
    }
}
