/**
 * The Sun's paths (ROADMAP analemma-sun-path), for render/sunpath.js and the Sun's card:
 *
 *  - today's path across the sky and the paths on this year's solstices and March equinox, every
 *    10 minutes over the observer's day, with hour ticks on today's;
 *  - the noon analemma: where the Sun stands at local mean noon (UT 12h − longitude/15) on each
 *    day of the year, the figure-8 traced by the equation of time and the declination;
 *  - the subsolar figure-8 on the globe: the point under the Sun at one UT time of day (the
 *    current one) on each day of the year. Sampling at a fixed UT is the same as sampling at a fixed
 *    standard-time clock reading anywhere, so no zone or daylight-saving logic is needed.
 *
 * Sky positions are apparent (refracted, AE.Horizon 'normal') in the observer's local frame,
 * x = east, y = up, z = south (render/sky.js altAzLocal), so they sit on the Sun's disc in sky view.
 * Sunrise and sunset azimuths come from where each path's geometric (unrefracted) altitude crosses
 * −0.833° (34′ of refraction plus the 16′ semi-diameter: the upper limb on the horizon).
 * About 7 ms in the worker.
 *
 * Pure: no DOM, no three.js; astronomy-engine only through ./ae.js.
 * @module astro/sunpath
 */
import { AE } from './ae.js';
import { aeObserverOf } from './almanac.js';

const DAY_MS = 86400000;
const DEG = Math.PI / 180;
/** Minutes between samples along a day's path. */
export const PATH_STEP_MIN = 10;
const PATH_SAMPLES = (24 * 60) / PATH_STEP_MIN + 1;
const RISE_ALT_DEG = -0.833;

/**
 * @typedef {{key:'today'|'june'|'december'|'march', startMs:number, stepMin:number, points:Float32Array,
 *   alt:Float32Array, riseAzDeg:number, setAzDeg:number, noonAltDeg:number}} SunArc
 * `points`: local unit vectors (x east, y up, z south), 3 per sample; `alt`: apparent altitude per sample.
 * @typedef {{tMs:number, year:number, arcs:SunArc[], hourTicks:Int16Array,
 *   analemma:{noonUtMin:number, days:number, firstMs:number, points:Float32Array, alt:Float32Array, az:Float32Array, monthStarts:Int16Array, markers:Int16Array},
 *   subsolar:{utMin:number, days:number, firstMs:number, latLon:Float32Array, todayIndex:number}}} SunFigures
 */

function localVector(alt, az, out, o) {
    const h = alt * DEG, A = az * DEG;
    out[o] = Math.sin(A) * Math.cos(h);
    out[o + 1] = Math.sin(h);
    out[o + 2] = -Math.cos(A) * Math.cos(h);
}

function horizonOf(time, obs) {
    const eq = AE.Equator('Sun', time, obs, true, true);
    return AE.Horizon(time, obs, eq.ra, eq.dec, 'normal');
}

/** A day's path from `startMs` over 24 h, with its rise and set azimuths and its highest altitude. */
function dayArc(key, startMs, obs) {
    const points = new Float32Array(PATH_SAMPLES * 3), alt = new Float32Array(PATH_SAMPLES), az = new Float64Array(PATH_SAMPLES);
    const geo = new Float64Array(PATH_SAMPLES);
    const t0 = AE.MakeTime(new Date(startMs));
    let noon = -90;
    for (let k = 0; k < PATH_SAMPLES; k++) {
        const time = t0.AddDays((k * PATH_STEP_MIN) / 1440);
        const eq = AE.Equator('Sun', time, obs, true, true);
        const hor = AE.Horizon(time, obs, eq.ra, eq.dec, 'normal');
        geo[k] = AE.Horizon(time, obs, eq.ra, eq.dec, null).altitude;
        alt[k] = hor.altitude;
        az[k] = hor.azimuth;
        noon = Math.max(noon, hor.altitude);
        localVector(hor.altitude, hor.azimuth, points, 3 * k);
    }
    let riseAzDeg = NaN, setAzDeg = NaN;
    for (let k = 1; k < PATH_SAMPLES; k++) {
        const a = geo[k - 1] - RISE_ALT_DEG, b = geo[k] - RISE_ALT_DEG;
        if ((a < 0) === (b < 0)) continue;
        const f = a / (a - b);
        let d = az[k] - az[k - 1];
        if (d > 180) d -= 360; else if (d < -180) d += 360;
        const at = (((az[k - 1] + d * f) % 360) + 360) % 360;
        if (a < 0 && Number.isNaN(riseAzDeg)) riseAzDeg = at;
        if (a >= 0 && Number.isNaN(setAzDeg)) setAzDeg = at;
    }
    return { key, startMs, stepMin: PATH_STEP_MIN, points, alt, riseAzDeg, setAzDeg, noonAltDeg: noon };
}

/**
 * The Sun's figures for the observer around `tMs`.
 * @param {{latDeg:number, lonDeg:number, elevM?:number}} observer
 * @param {number} tMs
 * @param {{dayStartMs?:number}} [opts] `dayStartMs`: the local (zone) midnight that starts today, so
 *   today's hour ticks fall on the clock's hours; by default the local mean midnight.
 * @returns {SunFigures}
 */
export function sunFigures(observer, tMs, opts = {}) {
    const obs = aeObserverOf(observer);
    if (!Number.isFinite(tMs)) throw new TypeError('tMs must be a finite number of milliseconds');
    const lonMs = (obs.longitude / 360) * DAY_MS;
    const meanMidnight = Math.floor((tMs + lonMs) / DAY_MS) * DAY_MS - lonMs;
    const dayStart = Number.isFinite(opts.dayStartMs) && Math.abs(opts.dayStartMs - tMs) < 1.5 * DAY_MS ? opts.dayStartMs : meanMidnight;
    const year = new Date(tMs).getUTCFullYear();
    const seasons = AE.Seasons(year);
    // A season's day: the local mean day containing the solstice or equinox.
    const dayOf = (time) => {
        const ms = time.date.getTime();
        return Math.floor((ms + lonMs) / DAY_MS) * DAY_MS - lonMs;
    };
    const arcs = [
        dayArc('today', dayStart, obs),
        dayArc('june', dayOf(seasons.jun_solstice), obs),
        dayArc('december', dayOf(seasons.dec_solstice), obs),
        dayArc('march', dayOf(seasons.mar_equinox), obs),
    ];
    const hourTicks = new Int16Array(25);
    for (let h = 0; h <= 24; h++) hourTicks[h] = (h * 60) / PATH_STEP_MIN;

    // The noon analemma: local mean noon on every day of the year.
    const days = 365;
    const jan1 = Date.UTC(year, 0, 1);
    const noonUtMin = Math.round(((((12 - obs.longitude / 15) % 24) + 24) % 24) * 60);
    const aPts = new Float32Array(days * 3), aAlt = new Float32Array(days), aAz = new Float32Array(days);
    for (let d = 0; d < days; d++) {
        const hor = horizonOf(AE.MakeTime(new Date(jan1 + d * DAY_MS + noonUtMin * 60000)), obs);
        aAlt[d] = hor.altitude;
        aAz[d] = hor.azimuth;
        localVector(hor.altitude, hor.azimuth, aPts, 3 * d);
    }
    const monthStarts = new Int16Array(12);
    for (let mo = 0; mo < 12; mo++) monthStarts[mo] = Math.round((Date.UTC(year, mo, 1) - jan1) / DAY_MS);
    const markers = Int16Array.from([seasons.mar_equinox, seasons.jun_solstice, seasons.sep_equinox, seasons.dec_solstice]
        .map((t) => Math.min(days - 1, Math.max(0, Math.round((t.date.getTime() - jan1) / DAY_MS)))));

    // The subsolar figure-8 at the current UT time of day (to 5 minutes).
    const utMin = Math.round((((tMs % DAY_MS) + DAY_MS) % DAY_MS) / 300000) * 5;
    const latLon = new Float32Array(days * 2);
    const geocentre = new AE.Observer(0, 0, 0);
    for (let d = 0; d < days; d++) {
        const time = AE.MakeTime(new Date(jan1 + d * DAY_MS + utMin * 60000));
        const eq = AE.Equator('Sun', time, geocentre, true, true);
        const gast = AE.SiderealTime(time);
        latLon[2 * d] = eq.dec;
        latLon[2 * d + 1] = (((((eq.ra - gast) * 15) % 360) + 540) % 360) - 180;
    }
    const todayIndex = Math.min(days - 1, Math.max(0, Math.floor((tMs - jan1) / DAY_MS)));
    return {
        tMs, year, arcs, hourTicks,
        analemma: { noonUtMin, days, firstMs: jan1 + noonUtMin * 60000, points: aPts, alt: aAlt, az: aAz, monthStarts, markers },
        subsolar: { utMin, days, firstMs: jan1 + utMin * 60000, latLon, todayIndex },
    };
}
