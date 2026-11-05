/**
 * Mars time and places (pure; no three.js, no DOM): the Mars Sol Date, Coordinated Mars Time and
 * local mean and true solar time, after Allison & McEwen (2000), *A post-Pathfinder evaluation of
 * areocentric solar coordinates…*, Planet. Space Sci. 48, 215, as implemented by NASA GISS's Mars24
 * ("Mars24 Sunclock — Algorithm and Worked Examples"). The landing sites the 'Stand on Mars' view
 * offers live here too, with the mission clocks of the three that count sols from 0.
 *
 * Time base: astronomy-engine's TT (AE.MakeTime(…).tt, days from J2000 TT), the same ΔT the rest of
 * the app uses; Mars24 adds TT − UTC from its leap-second table, so the two agree to about a second.
 *
 * Longitudes are planetocentric, east-positive, −180…180 (the IAU/IAG frame of AE.RotationAxis('Mars'),
 * whose prime meridian passes through Airy-0). LMST = MTC + λE/15 h (Mars24's west longitudes, with
 * the sign turned).
 *
 * @module astro/mars-clock
 */
import { AE } from './ae.js';
import { t, N_ } from '../core/i18n.js';
import { fmtInt } from '../core/format.js';

const DEG = Math.PI / 180;
/** Mean radius of Mars, km (IAU WGCCRE 2015: 3389.5). */
export const MARS_RADIUS_KM = 3389.5;
/** Mars's sol (mean solar day), in Earth days (Allison & McEwen 2000). */
export const SOL_DAYS = 1.0274912517;

/**
 * Landing sites, planetocentric (°N, °E). `missionUtc`: the landing as the spacecraft lived it
 * (spacecraft event time, UTC, from each mission's landing release minus the one-way light time),
 * for missions that number their sols from 0 at landing (MSL, InSight, Mars 2020); the sol then
 * changes at local mean midnight of the landing site, as the mission clocks count them.
 * @type {ReadonlyArray<{id:string, name:string, short:string, mission:string, latDeg:number, lonDeg:number, missionUtc?:string}>}
 */
export const MARS_SITES = Object.freeze([
    { id: 'jezero', name: N_('Jezero Crater'), short: 'Jezero', mission: 'Perseverance (2021)', latDeg: 18.4447, lonDeg: 77.4508, missionUtc: '2021-02-18T20:44:00Z' },
    { id: 'gale', name: N_('Gale Crater'), short: 'Gale', mission: 'Curiosity (2012)', latDeg: -4.5895, lonDeg: 137.4417, missionUtc: '2012-08-06T05:04:00Z' },
    { id: 'elysium', name: 'Elysium Planitia', short: 'Elysium', mission: 'InSight (2018)', latDeg: 4.5024, lonDeg: 135.6234, missionUtc: '2018-11-26T19:45:00Z' },
    { id: 'utopia', name: 'Utopia Planitia', short: 'Utopia', mission: 'Zhurong (2021)', latDeg: 25.066, lonDeg: 109.925 },
    { id: 'chryse', name: 'Chryse Planitia', short: 'Chryse', mission: 'Viking 1 (1976)', latDeg: 22.27, lonDeg: -47.95 },
    { id: 'ares', name: 'Ares Vallis', short: 'Ares Vallis', mission: 'Pathfinder (1997)', latDeg: 19.33, lonDeg: -33.55 },
    { id: 'meridiani', name: 'Meridiani Planum', short: 'Meridiani', mission: 'Opportunity (2004)', latDeg: -1.9462, lonDeg: -5.5267 },
]);

/** The default site: Jezero Crater, where Perseverance landed. */
export const DEFAULT_MARS_SITE = MARS_SITES[0];

/**
 * The landing site within `maxDeg` (great-circle) of a point, or null.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} [maxDeg]
 */
export function marsSiteNear(latDeg, lonDeg, maxDeg = 1) {
    let best = null, bestD = maxDeg;
    for (const s of MARS_SITES) {
        const c = Math.sin(latDeg * DEG) * Math.sin(s.latDeg * DEG)
            + Math.cos(latDeg * DEG) * Math.cos(s.latDeg * DEG) * Math.cos((lonDeg - s.lonDeg) * DEG);
        const d = Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
        if (d <= bestD) { best = s; bestD = d; }
    }
    return best;
}

/**
 * @typedef {{ jdTT:number, msd:number, mtcH:number, lmstH:number, ltstH:number, eotDeg:number,
 *   lsDeg:number, meanAnomDeg:number, solarDecDeg:number, sunDistAU:number, subsolarLonDeg:number }} MarsTime
 */

/** @returns {MarsTime} */
export function createMarsTime() {
    return { jdTT: 0, msd: 0, mtcH: 0, lmstH: 0, ltstH: 0, eotDeg: 0, lsDeg: 0, meanAnomDeg: 0, solarDecDeg: 0, sunDistAU: 1.52, subsolarLonDeg: 0 };
}

// Allison & McEwen (2000) Table 5: the perturbers' amplitudes (deg), periods (Julian years) and phases (deg).
const PBS_A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018];
const PBS_TAU = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
const PBS_PHI = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];

const mod = (x, m) => ((x % m) + m) % m;

/**
 * Mars time from TT days since J2000 (Mars24 steps B-1 … D-5), into `out` (no allocation).
 * @param {number} ttDays TT days from J2000.0 (AstroTime.tt)
 * @param {number} lonEastDeg planetocentric east longitude of the site
 * @param {MarsTime} out
 * @returns {MarsTime} out
 */
export function marsTimeTT(ttDays, lonEastDeg, out) {
    const dt = ttDays;
    const M = 19.3871 + 0.52402073 * dt;                 // B-1 mean anomaly
    const aFMS = 270.3871 + 0.524038496 * dt;            // B-2 angle of the fictitious mean Sun
    let pbs = 0;                                         // B-3 perturbers
    for (let i = 0; i < 7; i++) pbs += PBS_A[i] * Math.cos(((0.985626 * dt) / PBS_TAU[i] + PBS_PHI[i]) * DEG);
    const m = M * DEG;
    const nuM = (10.691 + 3.0e-7 * dt) * Math.sin(m) + 0.623 * Math.sin(2 * m) + 0.050 * Math.sin(3 * m)
        + 0.005 * Math.sin(4 * m) + 0.0005 * Math.sin(5 * m) + pbs;       // B-4 equation of centre
    const ls = mod(aFMS + nuM, 360);                     // B-5 areocentric solar longitude
    const l = ls * DEG;
    const eot = 2.861 * Math.sin(2 * l) - 0.071 * Math.sin(4 * l) + 0.002 * Math.sin(6 * l) - nuM;   // C-1
    const msd = (dt - 4.5) / SOL_DAYS + 44796.0 - 0.0009626;                                         // C-2
    const mtc = mod(24 * msd, 24);
    out.jdTT = dt + 2451545.0;
    out.msd = msd;
    out.mtcH = mtc;
    out.lmstH = mod(mtc + lonEastDeg / 15, 24);          // C-3
    out.ltstH = mod(out.lmstH + eot / 15, 24);           // C-4
    out.eotDeg = eot;
    out.lsDeg = ls;
    out.meanAnomDeg = mod(M, 360);
    out.solarDecDeg = Math.asin(0.42565 * Math.sin(l)) / DEG + 0.25 * Math.sin(l);   // D-5 (planetographic)
    out.sunDistAU = 1.52367934 * (1.00436 - 0.09309 * Math.cos(m) - 0.004336 * Math.cos(2 * m)
        - 0.00031 * Math.cos(3 * m) - 0.00003 * Math.cos(4 * m));                    // B-? heliocentric distance
    // D-1, east-positive: the subsolar point is where LTST is noon.
    out.subsolarLonDeg = mod(180 - (mtc * 15 + eot) + 180, 360) - 180;
    return out;
}

/**
 * Mars time at a UTC instant (astronomy-engine's ΔT).
 * @param {number} tMs UTC milliseconds
 * @param {number} lonEastDeg
 * @param {MarsTime} [out]
 * @returns {MarsTime}
 */
export function marsTime(tMs, lonEastDeg, out = createMarsTime()) {
    return marsTimeTT(AE.MakeTime(new Date(tMs)).tt, lonEastDeg, out);
}

const MISSION_SOL0 = new Map();

/**
 * The mission sol at a site (0 on the landing sol, changing at the site's local mean midnight), or
 * null for a site without a sol-0 mission clock or before its landing.
 * @param {{id?:string, lonDeg:number, missionUtc?:string}|null} site
 * @param {number} msd the Mars Sol Date (MarsTime.msd)
 * @returns {number|null}
 */
export function missionSol(site, msd) {
    if (!site || !site.missionUtc) return null;
    let sol0 = MISSION_SOL0.get(site.missionUtc);
    if (sol0 === undefined) {
        const ms = Date.parse(site.missionUtc);
        sol0 = Number.isFinite(ms) ? Math.floor(marsTime(ms, 0).msd + site.lonDeg / 360) : NaN;
        MISSION_SOL0.set(site.missionUtc, sol0);
    }
    const n = Math.floor(msd + site.lonDeg / 360) - sol0;
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 'hh:mm' of decimal hours. */
export function hhmm(h) {
    let m = Math.floor(mod(h, 24) * 60 + 1e-9);
    if (m >= 1440) m -= 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}


/**
 * The time bar's Mars clock: 'Sol 1,712 · 16:40 LMST' at a mission site, otherwise the local Mars
 * Sol Date, 'MSD 53,980 · 16:40 LMST'.
 * @param {MarsTime} mt
 * @param {{lonDeg:number, missionUtc?:string}|null} site
 * @returns {{text:string, sol:number|null, day:string, time:string}}
 */
export function marsClockText(mt, site) {
    const sol = missionSol(site, mt.msd);
    const day = sol !== null ? t('Sol {n}', { n: fmtInt(sol) }) : t('MSD {n}', { n: fmtInt(Math.floor(mt.msd + (site ? site.lonDeg : 0) / 360)) });
    const time = t('{time} LMST', { time: hhmm(mt.lmstH) });
    return { text: `${day} · ${time}`, sol, day, time };
}

/**
 * The Sun's altitude at a Mars site from the clock alone (no ephemeris): Mars24's planetographic
 * solar declination and the true solar hour angle. Within ~0.3° of the full geometry; used for the
 * time bar's day/night strip.
 * @param {MarsTime} mt computed for the site's longitude
 * @param {number} latDeg
 * @returns {number} degrees
 */
export function marsSunAltDeg(mt, latDeg) {
    const d = mt.solarDecDeg * DEG, p = latDeg * DEG, H = (mt.ltstH - 12) * 15 * DEG;
    return Math.asin(Math.max(-1, Math.min(1, Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H)))) / DEG;
}

const SEASONS_N = [N_('northern spring'), N_('northern summer'), N_('northern autumn'), N_('northern winter')];
const SEASONS_S = [N_('southern autumn'), N_('southern winter'), N_('southern spring'), N_('southern summer')];

/** The Martian season at a site's hemisphere for an Ls, in English ('northern spring'; shown with t()). */
export function marsSeason(lsDeg, latDeg = 0) {
    const q = Math.floor(mod(lsDeg, 360) / 90);
    return (latDeg >= 0 ? SEASONS_N : SEASONS_S)[q];
}
