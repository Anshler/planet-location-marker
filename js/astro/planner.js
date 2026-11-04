/**
 * 'Best time to observe' (ROADMAP visibility-year-planner): a year of nights for the planets as
 * seen from one place, for the body card's 12-month chart (ui/year-planner.js).
 *
 * The grid: night i is centred on `firstMidnightMs + i` days (the caller's local midnight, in
 * standard time so the rows never jump at a DST change) and sampled every `stepMin` minutes from
 * `startMin` to `startMin + spanMin` around it (by default 15:00 to 09:00, every 20 min). For each
 * night the Sun, the Moon and each planet get one RA/Dec of date (GeoVector, rotated by
 * Rotation_EQJ_EQD, refreshed monthly); the Moon gets three nodes across the night, interpolated.
 * Altitudes then follow analytically from the sidereal clock: sin h = sin φ sin δ + cos φ cos δ cos H.
 * No refraction and no parallax (the Moon's is up to 1°): a planning chart, approximate to a degree
 * or so. Magnitudes come from AE.Illumination every third night, interpolated.
 *
 * A planet counts as visible when it is at least PLANNER_ALT_MIN up while the Sun is below −6°
 * (−12° for planets fainter than mag 4), the same darkness rule as almanac.tonight, and at least
 * 12° from the Sun.
 *
 * Cost: about 25 ms for 365 nights and seven planets in the worker.
 * Pure: no DOM, no three.js; astronomy-engine only through ./ae.js.
 * @module astro/planner
 */
import { AE } from './ae.js';
import { bodyById } from './bodies.js';
import { aeObserverOf } from './almanac.js';

const DAY_MS = 86400000;
const DEG = Math.PI / 180;
const SIDEREAL_RATE = 1.00273790935;

/** The planets the planner covers (the Sun and the Moon are not charted). */
export const PLANNER_BODIES = Object.freeze(['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
/** Lowest altitude (degrees) that counts as placed for observing. */
export const PLANNER_ALT_MIN = 10;
/** Closest elongation (degrees) at which a planet is not lost in the Sun's glare. */
export const PLANNER_GLARE_DEG = 12;

/**
 * @typedef {{alt:Int8Array, mag:Float32Array, elong:Uint8Array}} PlannerBody
 * `alt`: altitude (whole degrees) per night × sample, row-major by night; `mag` per night;
 * `elong`: angle from the Sun per night (whole degrees).
 * @typedef {{firstMidnightMs:number, nights:number, samples:number, stepMin:number, startMin:number,
 *   sun:Int8Array, moon:Int8Array, moonPct:Uint8Array, bodies:Record<string, PlannerBody>}} PlannerYear
 * Sample j of night i is at firstMidnightMs + i days + (startMin + j·stepMin) minutes.
 */

const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function raDecOfDate(rot, vec, out) {
    const r = rot.rot;
    const x = r[0][0] * vec.x + r[1][0] * vec.y + r[2][0] * vec.z;
    const y = r[0][1] * vec.x + r[1][1] * vec.y + r[2][1] * vec.z;
    const z = r[0][2] * vec.x + r[1][2] * vec.y + r[2][2] * vec.z;
    const l = Math.hypot(x, y, z);
    out.ra = Math.atan2(y, x) / (15 * DEG);
    out.dec = Math.asin(Math.max(-1, Math.min(1, z / l))) / DEG;
    out.ux = x / l; out.uy = y / l; out.uz = z / l;
    return out;
}

/**
 * A year of nights from `firstMidnightMs` (see the module docs).
 * @param {{latDeg:number, lonDeg:number, elevM?:number}} observer
 * @param {number} firstMidnightMs UT ms of the first night's (standard-time) local midnight
 * @param {{nights?:number, stepMin?:number, startMin?:number, spanMin?:number, bodyIds?:string[]}} [opts]
 * @returns {PlannerYear}
 */
export function visibilityYear(observer, firstMidnightMs, opts = {}) {
    const obs = aeObserverOf(observer);
    if (!Number.isFinite(firstMidnightMs)) throw new TypeError('firstMidnightMs must be a finite number of milliseconds');
    const nights = clampInt(opts.nights, 1, 400, 365);
    const stepMin = clampInt(opts.stepMin, 5, 60, 20);
    const startMin = clampInt(opts.startMin, -720, 0, -540);
    const spanMin = clampInt(opts.spanMin, stepMin, 1440, 1080);
    const S = Math.floor(spanMin / stepMin) + 1;
    const ids = (Array.isArray(opts.bodyIds) && opts.bodyIds.length ? opts.bodyIds : PLANNER_BODIES).filter((id) => PLANNER_BODIES.includes(id));
    const sun = new Int8Array(nights * S), moon = new Int8Array(nights * S), moonPct = new Uint8Array(nights);
    /** @type {Record<string, PlannerBody>} */
    const bodies = {};
    for (const id of ids) bodies[id] = { alt: new Int8Array(nights * S), mag: new Float32Array(nights).fill(NaN), elong: new Uint8Array(nights) };

    const slat = Math.sin(obs.latitude * DEG), clat = Math.cos(obs.latitude * DEG);
    const lonH = obs.longitude / 15;
    // Hour-angle offsets (hours of sidereal time) of each sample from the night's centre.
    const offH = new Float64Array(S);
    for (let j = 0; j < S; j++) offH[j] = ((startMin + j * stepMin) / 60) * SIDEREAL_RATE;
    const fillRow = (row, base, raH, decDeg, lst0) => {
        const sd = Math.sin(decDeg * DEG), cd = Math.cos(decDeg * DEG);
        for (let j = 0; j < S; j++) {
            const H = (lst0 + offH[j] - raH) * 15 * DEG;
            row[base + j] = Math.round(Math.asin(Math.max(-1, Math.min(1, slat * sd + clat * cd * Math.cos(H)))) / DEG);
        }
    };
    const eqS = { ra: 0, dec: 0, ux: 0, uy: 0, uz: 0 }, eqB = { ra: 0, dec: 0, ux: 0, uy: 0, uz: 0 };
    const mRa = [0, 0, 0], mDec = [0, 0, 0];
    let rot = null, rotNight = -Infinity;
    for (let i = 0; i < nights; i++) {
        const cMs = firstMidnightMs + i * DAY_MS;
        const tc = AE.MakeTime(new Date(cMs));
        if (i - rotNight >= 30) { rot = AE.Rotation_EQJ_EQD(tc); rotNight = i; }
        const lst0 = AE.SiderealTime(tc) + lonH;
        const base = i * S;
        raDecOfDate(rot, AE.GeoVector('Sun', tc, true), eqS);
        fillRow(sun, base, eqS.ra, eqS.dec, lst0);
        const sx = eqS.ux, sy = eqS.uy, sz = eqS.uz;

        // The Moon: three nodes across the night, Lagrange-interpolated in RA (unwrapped) and Dec.
        for (let k = 0; k < 3; k++) {
            const t = tc.AddDays((startMin + (k * spanMin) / 2) / 1440);
            raDecOfDate(rot, AE.GeoMoon(t), eqB);
            let ra = eqB.ra;
            if (k > 0) { while (ra - mRa[k - 1] > 12) ra -= 24; while (ra - mRa[k - 1] < -12) ra += 24; }
            mRa[k] = ra; mDec[k] = eqB.dec;
        }
        for (let j = 0; j < S; j++) {
            const x = (2 * j) / (S - 1) - 1;  // −1 … 1 across the night
            const l0 = (x * (x - 1)) / 2, l1 = 1 - x * x, l2 = (x * (x + 1)) / 2;
            const ra = mRa[0] * l0 + mRa[1] * l1 + mRa[2] * l2, dec = mDec[0] * l0 + mDec[1] * l1 + mDec[2] * l2;
            const H = (lst0 + offH[j] - ra) * 15 * DEG;
            moon[base + j] = Math.round(Math.asin(Math.max(-1, Math.min(1, slat * Math.sin(dec * DEG) + clat * Math.cos(dec * DEG) * Math.cos(H)))) / DEG);
        }
        moonPct[i] = Math.round(50 * (1 - Math.cos(AE.MoonPhase(tc) * DEG)));

        for (const id of ids) {
            const b = bodies[id];
            const ae = bodyById(id).ae;
            raDecOfDate(rot, AE.GeoVector(ae, tc, true), eqB);
            fillRow(b.alt, base, eqB.ra, eqB.dec, lst0);
            b.elong[i] = Math.round(Math.acos(Math.max(-1, Math.min(1, sx * eqB.ux + sy * eqB.uy + sz * eqB.uz))) / DEG);
            if (i % 3 === 0 || i === nights - 1) b.mag[i] = AE.Illumination(ae, tc).mag;
        }
    }
    // Fill the magnitudes between the sampled nights.
    for (const id of ids) {
        const mag = bodies[id].mag;
        let last = 0;
        for (let i = 1; i < nights; i++) {
            if (Number.isNaN(mag[i])) continue;
            for (let k = last + 1; k < i; k++) mag[k] = mag[last] + ((mag[i] - mag[last]) * (k - last)) / (i - last);
            last = i;
        }
    }
    return { firstMidnightMs, nights, samples: S, stepMin, startMin, sun, moon, moonPct, bodies };
}

/**
 * Whether sample j of night i shows the planet: up at least PLANNER_ALT_MIN, the Sun below −6°
 * (−12° when the planet is fainter than mag 4) and outside the Sun's glare.
 * @param {PlannerYear} year
 * @param {string} id
 * @param {number} i night
 * @param {number} j sample
 * @returns {boolean}
 */
export function plannerVisible(year, id, i, j) {
    const b = year.bodies[id];
    if (!b) return false;
    const k = i * year.samples + j;
    const dark = b.mag[i] > 4 ? -12 : -6;
    return b.alt[k] >= PLANNER_ALT_MIN && year.sun[k] <= dark && b.elong[i] >= PLANNER_GLARE_DEG;
}

/**
 * The planet's year in numbers: minutes visible per night, the best stretch (the longest run of
 * nights, after a 7-night running mean, with at least 60 % of the best night's visible time), the
 * highest it stands in darkness (night, sample, altitude) and its brightest night.
 * @param {PlannerYear} year
 * @param {string} id
 * @returns {{minutes:Uint16Array, visibleNights:number, bestFrom:number, bestTo:number,
 *   peakNight:number, peakSample:number, peakAltDeg:number, brightestNight:number, brightestMag:number}|null}
 */
export function plannerSummary(year, id) {
    const b = year?.bodies?.[id];
    if (!b) return null;
    const N = year.nights, S = year.samples;
    const minutes = new Uint16Array(N);
    let visibleNights = 0, peakNight = -1, peakSample = -1, peakAltDeg = -90, brightestNight = -1, brightestMag = Infinity;
    for (let i = 0; i < N; i++) {
        let n = 0;
        for (let j = 0; j < S; j++) {
            if (!plannerVisible(year, id, i, j)) continue;
            n++;
            const a = b.alt[i * S + j];
            if (a > peakAltDeg) { peakAltDeg = a; peakNight = i; peakSample = j; }
        }
        minutes[i] = n * year.stepMin;
        if (n) {
            visibleNights++;
            if (b.mag[i] < brightestMag) { brightestMag = b.mag[i]; brightestNight = i; }
        }
    }
    const smooth = new Float64Array(N);
    let best = 0;
    for (let i = 0; i < N; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - 3); k <= Math.min(N - 1, i + 3); k++) { s += minutes[k]; c++; }
        smooth[i] = s / c;
        best = Math.max(best, smooth[i]);
    }
    let bestFrom = -1, bestTo = -1;
    if (best > 0) {
        let runStart = -1;
        for (let i = 0; i <= N; i++) {
            const on = i < N && smooth[i] >= 0.6 * best;
            if (on && runStart < 0) runStart = i;
            if (!on && runStart >= 0) {
                if (bestFrom < 0 || i - 1 - runStart > bestTo - bestFrom) { bestFrom = runStart; bestTo = i - 1; }
                runStart = -1;
            }
        }
    }
    return {
        minutes, visibleNights, bestFrom, bestTo, peakNight, peakSample,
        peakAltDeg: peakNight >= 0 ? peakAltDeg : NaN, brightestNight, brightestMag: brightestNight >= 0 ? brightestMag : NaN,
    };
}
