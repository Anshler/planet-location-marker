/**
 * Meteor showers (ROADMAP meteor-showers): the annual showers of the IMO working list, when they
 * peak, how active they are on a given date, where their radiants stand, how many meteors an
 * observer can expect, and a deterministic generator for the illustrative meteors that sky view
 * draws (render/meteors.js).
 *
 * Data. SHOWERS is the International Meteor Organization's calendar (IMO Meteor Shower Calendar,
 * working list; credited in the About tab and THIRD_PARTY_NOTICES) for the thirteen showers it lists as
 * annual and naked-eye: the solar longitude of maximum λ☉ (J2000.0, as the IMO publishes it), the
 * activity window, the radiant at maximum (J2000.0) with its daily drift, the entry velocity V∞,
 * the population index r and the ZHR. Activity profiles ZHR(λ) = ZHRmax·10^(−B·|λ − λmax|) use the
 * slopes B of Jenniskens (1994, A&A 287, 990) where he gives them and broad illustrative slopes
 * otherwise; the drift is the IMO table reduced to a linear rate.
 *
 * Time. Meteor streams are fixed relative to the stars, not to the equinox, so the solar longitude
 * of a peak is constant in J2000 and moves through the calendar with precession. The peak instant
 * is AE.SearchSunLongitude (equinox of date) of λ☉ + p_A(T), the IAU 2006 general precession in
 * longitude (Capitaine et al. 2003): 5028.796″·T + 1.105″·T². Without it a peak would be up to two
 * weeks off at the ends of the 1000–3000 range. Checked against the IMO calendars: Geminids
 * 2023-12-14 19h and 2024-12-14 01h UT, Perseids 2024-08-12 13–16h UT, Quadrantids 2025-01-03 15h UT.
 *
 * History. `validFrom`/`validTo` bound the years in which a shower is shown: the Geminids were
 * first recorded about 1862, the Quadrantids about 1835, the Ursids around 1900 and the Draconids
 * in 1926 (their comet was found in 1900); the Quadrantid stream is young and is being moved off
 * Earth's path by Jupiter, so it is cut off (illustratively) after 2400. Outbursts (the Leonid storms
 * of 1833 and 1966, Draconid storms) are not modelled.
 *
 * Rates. The expected hourly rate is HR = ZHR·sin(h)·r^(lm − 6.5) (the IMO's definition of the ZHR
 * turned around), h the radiant's altitude and lm the limiting magnitude of the sky, from its
 * zenith brightness (astro/skyglow.js: airglow, moonlight, light pollution) plus twilight. Values are
 * for one observer with a clear, unobstructed sky and are rounded in the text; the drawn meteors
 * are illustrative.
 *
 * Pure: no DOM, no three.js; astronomy-engine only through ./ae.js.
 * @module astro/meteors
 */
import { AE } from './ae.js';
import { adaptingLuminance, limitingMag, NL_TO_CDM2 } from './photometry.js';
import { nlToSqm } from './skyglow.js';

const DAY_MS = 86400000;
const DEG = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const OBLIQUITY_J2000_DEG = 23.4392911;

/**
 * @typedef {{id:string, iau:number, name:string, peak:number, from:number, to:number,
 *   ra:number, dec:number, dRa:number, dDec:number, zhr:number, v:number, r:number,
 *   bPlus:number, bMinus:number, parent:string, validFrom:number|null, validTo:number|null}} Shower
 * `peak`, `from`, `to`: solar longitudes (J2000, degrees) of maximum and of the activity window
 * (`from` > `to` across 0°); `ra`, `dec`: the radiant at maximum (J2000, degrees) and `dRa`, `dDec`
 * its drift per degree of solar longitude (≈ per day); `v`: entry velocity (km/s); `r`: population
 * index; `bPlus`, `bMinus`: activity slopes before and after maximum (per degree).
 */

/** @type {ReadonlyArray<Readonly<Shower>>} IMO calendar (working list), J2000.0. */
export const SHOWERS = Object.freeze([
    { id: 'QUA', iau: 10, name: 'Quadrantids', peak: 283.15, from: 276.6, to: 291.1, ra: 230, dec: 49, dRa: 0, dDec: 0, zhr: 80, v: 41, r: 2.1, bPlus: 1.8, bMinus: 1.8, parent: 'asteroid 2003 EH1', validFrom: 1835, validTo: 2400 },
    { id: 'LYR', iau: 6, name: 'Lyrids', peak: 32.32, from: 24.4, to: 40.0, ra: 271, dec: 34, dRa: 1.1, dDec: 0, zhr: 18, v: 49, r: 2.1, bPlus: 0.4, bMinus: 0.4, parent: 'comet C/1861 G1 Thatcher', validFrom: null, validTo: null },
    { id: 'ETA', iau: 31, name: 'Eta Aquariids', peak: 45.5, from: 29.2, to: 67.0, ra: 338, dec: -1, dRa: 0.9, dDec: 0.4, zhr: 50, v: 66, r: 2.4, bPlus: 0.08, bMinus: 0.08, parent: 'comet 1P/Halley', validFrom: null, validTo: null },
    { id: 'SDA', iau: 5, name: 'Southern Delta Aquariids', peak: 127, from: 110.0, to: 150.2, ra: 340, dec: -16, dRa: 0.75, dDec: 0.27, zhr: 25, v: 41, r: 2.5, bPlus: 0.09, bMinus: 0.09, parent: 'comet 96P/Machholz', validFrom: null, validTo: null },
    { id: 'CAP', iau: 1, name: 'Alpha Capricornids', peak: 127, from: 101.4, to: 142.5, ra: 307, dec: -10, dRa: 0.6, dDec: 0.25, zhr: 5, v: 23, r: 2.5, bPlus: 0.1, bMinus: 0.1, parent: 'comet 169P/NEAT', validFrom: null, validTo: null },
    { id: 'PER', iau: 7, name: 'Perseids', peak: 140.0, from: 114.7, to: 151.1, ra: 48, dec: 58, dRa: 1.4, dDec: 0.2, zhr: 100, v: 59, r: 2.2, bPlus: 0.2, bMinus: 0.4, parent: 'comet 109P/Swift–Tuttle', validFrom: null, validTo: null },
    { id: 'DRA', iau: 9, name: 'Draconids', peak: 195.4, from: 193.0, to: 197.0, ra: 262, dec: 54, dRa: 0, dDec: 0, zhr: 10, v: 20, r: 2.6, bPlus: 1.0, bMinus: 1.0, parent: 'comet 21P/Giacobini–Zinner', validFrom: 1926, validTo: null },
    { id: 'STA', iau: 2, name: 'Southern Taurids', peak: 197, from: 167.6, to: 238.0, ra: 32, dec: 9, dRa: 0.8, dDec: 0.3, zhr: 5, v: 27, r: 2.3, bPlus: 0.03, bMinus: 0.03, parent: 'comet 2P/Encke', validFrom: null, validTo: null },
    { id: 'ORI', iau: 8, name: 'Orionids', peak: 208, from: 189.1, to: 224.9, ra: 95, dec: 16, dRa: 0.8, dDec: 0.1, zhr: 20, v: 66, r: 2.5, bPlus: 0.12, bMinus: 0.12, parent: 'comet 1P/Halley', validFrom: null, validTo: null },
    { id: 'NTA', iau: 17, name: 'Northern Taurids', peak: 230, from: 206.9, to: 258.2, ra: 58, dec: 22, dRa: 0.9, dDec: 0.2, zhr: 5, v: 29, r: 2.3, bPlus: 0.03, bMinus: 0.03, parent: 'comet 2P/Encke', validFrom: null, validTo: null },
    { id: 'LEO', iau: 13, name: 'Leonids', peak: 235.27, from: 223.9, to: 248.1, ra: 152, dec: 22, dRa: 1.0, dDec: -0.4, zhr: 15, v: 71, r: 2.5, bPlus: 0.4, bMinus: 0.4, parent: 'comet 55P/Tempel–Tuttle', validFrom: null, validTo: null },
    { id: 'GEM', iau: 4, name: 'Geminids', peak: 262.2, from: 252.1, to: 268.4, ra: 112, dec: 33, dRa: 1.0, dDec: -0.1, zhr: 150, v: 35, r: 2.6, bPlus: 0.39, bMinus: 0.81, parent: 'asteroid 3200 Phaethon', validFrom: 1862, validTo: null },
    { id: 'URS', iau: 15, name: 'Ursids', peak: 270.7, from: 265.3, to: 274.5, ra: 217, dec: 76, dRa: 0, dDec: 0, zhr: 10, v: 33, r: 3.0, bPlus: 0.6, bMinus: 0.6, parent: 'comet 8P/Tuttle', validFrom: 1900, validTo: null },
].map((s) => Object.freeze(s)));

/** Index of each shower by id. */
export const SHOWER_INDEX = Object.freeze(Object.fromEntries(SHOWERS.map((s, i) => [s.id, i])));

/** Sporadic background: hourly rate under a perfect sky (illustrative), its population index. */
export const SPORADIC_HR = 8;
export const SPORADIC_R = 3.0;
/** Showers with a lower ZHR get no Events entry (they are still drawn and listed as active). */
export const EVENT_MIN_ZHR = 10;
/** A radiant is marked in sky view while its shower is within this fraction of its maximum. */
export const RADIANT_MARK_FRACTION = 0.25;

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;

/**
 * General precession in longitude since J2000 (degrees): IAU 2006, p_A = 5028.796195″·T + 1.1054348″·T²
 * with T in Julian centuries of TT (UT is close enough here).
 * @param {number} ms
 * @returns {number}
 */
export function precessionDeg(ms) {
    const T = (ms - J2000_MS) / (36525 * DAY_MS);
    return (5028.796195 * T + 1.1054348 * T * T) / 3600;
}

/**
 * Whether a shower is shown in a calendar year (its validFrom / validTo).
 * @param {Shower} s
 * @param {number} year
 * @returns {boolean}
 */
export function showerValid(s, year) {
    return !(s.validFrom !== null && year < s.validFrom) && !(s.validTo !== null && year > s.validTo);
}

/**
 * The J2000 ecliptic longitude (degrees, 0…360) of an EQJ direction (the Sun's, for λ☉).
 * @param {ArrayLike<number>} v
 * @returns {number}
 */
export function eclipticLonJ2000(v) {
    const ce = Math.cos(OBLIQUITY_J2000_DEG * DEG), se = Math.sin(OBLIQUITY_J2000_DEG * DEG);
    return wrap360(Math.atan2(v[1] * ce + v[2] * se, v[0]) / DEG);
}

/**
 * The Sun's J2000 solar longitude from a scene-frame direction (frames.js S: eqj = (x, −z, y)).
 * @param {ArrayLike<number>} dirS
 * @returns {number}
 */
export function solarLonFromScene(dirS) {
    const ce = Math.cos(OBLIQUITY_J2000_DEG * DEG), se = Math.sin(OBLIQUITY_J2000_DEG * DEG);
    const x = dirS[0], y = -dirS[2], z = dirS[1];
    return wrap360(Math.atan2(y * ce + z * se, x) / DEG);
}

/** True when λ (J2000) lies inside the shower's activity window. */
function inWindow(s, lam) {
    const a = wrap360(lam - s.from), span = wrap360(s.to - s.from);
    return a <= span;
}

/**
 * The shower's ZHR at solar longitude λ (J2000): ZHRmax·10^(−B·|Δλ|) inside its activity window,
 * 0 outside it.
 * @param {Shower} s
 * @param {number} lamJ2000
 * @returns {number}
 */
export function zhrAt(s, lamJ2000) {
    if (!inWindow(s, lamJ2000)) return 0;
    const d = wrap180(lamJ2000 - s.peak);
    return s.zhr * Math.pow(10, -(d < 0 ? s.bPlus : s.bMinus) * Math.abs(d));
}

/**
 * The radiant (J2000 RA/Dec, degrees) at solar longitude λ: the radiant at maximum plus the drift.
 * @param {Shower} s
 * @param {number} lamJ2000
 * @param {{raDeg:number, decDeg:number}} [out]
 * @returns {{raDeg:number, decDeg:number}}
 */
export function radiantAt(s, lamJ2000, out = { raDeg: 0, decDeg: 0 }) {
    const d = wrap180(lamJ2000 - s.peak);
    out.raDeg = wrap360(s.ra + s.dRa * d);
    out.decDeg = Math.max(-90, Math.min(90, s.dec + s.dDec * d));
    return out;
}

/**
 * Naked-eye limiting magnitude for meteors (≤ 6.5, the ZHR's reference): the sky's zenith
 * brightness (nanolamberts: airglow, moonlight, light pollution) plus twilight.
 * @param {number} sunAltDeg
 * @param {number} zenithNl night-sky zenith brightness (skyglow `zenithNl`; 54 = a pristine sky)
 * @returns {number}
 */
export function meteorLimitMag(sunAltDeg, zenithNl) {
    const cdm2 = adaptingLuminance(sunAltDeg, Number.isFinite(zenithNl) ? zenithNl : 54);
    return Math.min(6.5, limitingMag(nlToSqm(cdm2 / NL_TO_CDM2)));
}

/**
 * Expected hourly rate for one observer: ZHR·sin(h)·r^(lm − 6.5) (0 with the radiant down).
 * @param {number} zhr
 * @param {number} radiantAltDeg
 * @param {number} lm limiting magnitude (capped at 6.5)
 * @param {number} r population index
 * @returns {number}
 */
export function hourlyRate(zhr, radiantAltDeg, lm, r) {
    if (!(zhr > 0) || !(radiantAltDeg > 0)) return 0;
    return zhr * Math.sin(radiantAltDeg * DEG) * Math.pow(r, Math.min(6.5, lm) - 6.5);
}

/**
 * The instant (UT ms) of a shower's maximum in a calendar year: AE.SearchSunLongitude of the
 * precessed solar longitude, or null when the search fails.
 * @param {Shower} s
 * @param {number} year
 * @returns {number|null}
 */
export function showerPeakMs(s, year) {
    // Of date, λ 280° falls near 1 January in the Gregorian calendar (it follows the equinox).
    const approx0 = Date.UTC(year, 0, 1) + (wrap360(s.peak - 280) / 0.98565) * DAY_MS;
    const lam = wrap360(s.peak + precessionDeg(approx0));
    const approx = Date.UTC(year, 0, 1) + (wrap360(lam - 280) / 0.98565) * DAY_MS;
    const lamDate = wrap360(s.peak + precessionDeg(approx));
    const t = AE.SearchSunLongitude(lamDate, AE.MakeTime(new Date(approx - 20 * DAY_MS)), 40);
    return t ? t.date.getTime() : null;
}

/**
 * Shower maxima between fromMs and toMs, sorted by time (showers outside their validity years
 * are left out). `minZhr` drops the minor ones.
 * @param {number} fromMs
 * @param {number} toMs
 * @param {{minZhr?:number}} [opts]
 * @returns {{shower:Shower, peakMs:number}[]}
 */
export function showerPeaks(fromMs, toMs, { minZhr = 0 } = {}) {
    const out = [];
    const y0 = new Date(fromMs).getUTCFullYear() - 1, y1 = new Date(toMs).getUTCFullYear() + 1;
    for (const s of SHOWERS) {
        if (s.zhr < minZhr) continue;
        for (let y = y0; y <= y1; y++) {
            let ms = null;
            try { ms = showerPeakMs(s, y); } catch { ms = null; }
            if (ms === null || ms < fromMs || ms > toMs) continue;
            if (!showerValid(s, new Date(ms).getUTCFullYear())) continue;
            out.push({ shower: s, peakMs: ms });
        }
    }
    return out.sort((a, b) => a.peakMs - b.peakMs);
}

// ---------------------------------------------------------------------------------------------
// Deterministic meteors (render/meteors.js)
// ---------------------------------------------------------------------------------------------

/** Simulated time is cut into buckets of this length; each bucket's meteors are a pure function of it. */
export const BUCKET_MS = 10000;

/**
 * A deterministic hash of four integers to [0, 1) (murmur-style mixing). `a` may exceed 2³²
 * (bucket indices up to the year 3000); it is split into two words.
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @returns {number}
 */
export function hash01(a, b, c, d) {
    const hi = Math.floor(a / 4294967296);
    let h = 0x9e3779b9 ^ (a >>> 0);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (hi | 0) ^ (h >>> 13), 0xc2b2ae35);
    h = Math.imul(h ^ (b | 0) ^ (h >>> 16), 0x27d4eb2f);
    h = Math.imul(h ^ (c | 0) ^ (h >>> 15), 0x165667b1);
    h = Math.imul(h ^ (d | 0) ^ (h >>> 13), 0x85ebca6b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/**
 * A Poisson draw with mean `mean` from one uniform deviate `u` (inverse CDF, at most 40).
 * @param {number} mean
 * @param {number} u
 * @returns {number}
 */
export function poissonCount(mean, u) {
    if (!(mean > 0)) return 0;
    let p = Math.exp(-mean), cdf = p, k = 0;
    while (u > cdf && k < 40) {
        k++;
        p *= mean / k;
        cdf += p;
    }
    return k;
}

/** Brightest magnitude the generator draws (a fireball). */
export const BRIGHTEST_MAG = -4;

/**
 * A meteor magnitude from the population index: P(m) ∝ r^m between BRIGHTEST_MAG and the limit.
 * @param {number} u uniform deviate
 * @param {number} r population index
 * @param {number} lm limiting magnitude
 * @returns {number}
 */
export function sampleMagnitude(u, r, lm) {
    const span = Math.max(0.5, lm - BRIGHTEST_MAG);
    const lr = Math.log(r);
    return BRIGHTEST_MAG + Math.log(1 + u * (Math.exp(lr * span) - 1)) / lr;
}

/**
 * The shape of one meteor (all angles in degrees): where it starts (`psiDeg` from the radiant,
 * position angle `paDeg` around it), its length along the great circle away from the radiant, its
 * duration in seconds of wall-clock time (0.3–0.8 s; slow meteors last longer) and its offset in
 * its bucket (0…1). Pure in (bucket, source, j); `vKms` is the source's entry velocity.
 * @param {number} bucket
 * @param {number} src source index (shower index, or SHOWERS.length for the sporadic background)
 * @param {number} j meteor index in the bucket
 * @param {number} vKms
 * @param {{offset:number, psiDeg:number, paDeg:number, lenDeg:number, durS:number, u:number}} out
 * @returns {typeof out}
 */
export function meteorShape(bucket, src, j, vKms, out) {
    out.offset = hash01(bucket, src, j, 1);
    // Starting points uniform over the sphere around the radiant, 3°…100° from it.
    const c0 = Math.cos(3 * DEG), c1 = Math.cos(100 * DEG);
    out.psiDeg = Math.acos(c0 + (c1 - c0) * hash01(bucket, src, j, 2)) / DEG;
    out.paDeg = 360 * hash01(bucket, src, j, 3);
    // Foreshortened near the radiant (∝ sin ψ); a few long ones.
    const u = hash01(bucket, src, j, 4);
    out.lenDeg = Math.min(32, (3 + 22 * u * u) * Math.sin(out.psiDeg * DEG) + 0.6);
    const slow = Math.min(1, Math.max(0, (71 - vKms) / 60));
    out.durS = Math.min(0.8, Math.max(0.3, (0.32 + 0.42 * slow) * (0.8 + 0.4 * hash01(bucket, src, j, 5))));
    out.u = hash01(bucket, src, j, 6);
    return out;
}

/**
 * Display strength of a meteor of magnitude `m` (line alpha; ≈ 1 at mag 0.5, more for fireballs).
 * @param {number} m
 * @returns {number}
 */
export function meteorAlpha(m) {
    return Math.min(2, 0.9 * Math.pow(10, -0.2 * (m - 0.5)));
}
