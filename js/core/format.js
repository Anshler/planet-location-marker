// Display formatters (SPEC §C.3).
//
// Deterministic English output, independent of the browser locale (the UI copy is English).
// Negative numbers use the true minus sign U+2212; angles use ° ′ ″. Every function returns an
// em dash for unusable input instead of throwing or printing "NaN".

import { utcToZoned } from './tz.js';

const MINUS = '\u2212';
const DASH = '\u2014';
const AU_KM = 149597870.7;
const SYNODIC_MONTH_D = 29.530589;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const COMPASS8_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Scratch for utcToZoned: formatters run at UI rates, no need to allocate per call. */
const zbuf = {};

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' ? v : Number(v));
const fin = Number.isFinite;

/** Day of week 0=Sun for a proleptic Gregorian date (Sakamoto's method). */
function weekday(y, mo, d) {
    const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    const yy = mo < 3 ? y - 1 : y;
    const w = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[mo - 1] + d) % 7;
    return (w + 7) % 7;
}

/** Up to 3 significant digits, no trailing zeros: 2.5, 30, 0.25. */
function sig3(x) {
    return String(Number(x.toPrecision(3)));
}

/**
 * Integer with thousands separators: 384400 → '384,400'.
 * @param {number} n
 * @returns {string}
 */
export function fmtInt(n) {
    const x = num(n);
    if (!fin(x)) return DASH;
    const r = Math.round(Math.abs(x));
    const s = String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return r !== 0 && x < 0 ? MINUS + s : s;
}

/**
 * 'Sun 11 Oct 2026' in `tz` (an invalid tz means UTC).
 * @param {number} ms
 * @param {unknown} tz
 * @param {{weekday?:boolean, year?:boolean}} [opts]
 * @returns {string}
 */
export function fmtDate(ms, tz, { weekday: withWeekday = true, year = true } = {}) {
    const z = utcToZoned(ms, tz, zbuf);
    if (!fin(z.y)) return DASH;
    const core = `${z.d} ${MONTHS[z.mo - 1]}${year ? ` ${z.y}` : ''}`;
    return withWeekday ? `${WEEKDAYS[weekday(z.y, z.mo, z.d)]} ${core}` : core;
}

/**
 * '20:14:05', or '8:14:05 PM' with `hour12`. `{seconds:false}` drops the seconds.
 * @param {number} ms
 * @param {unknown} tz
 * @param {boolean} [hour12]
 * @param {{seconds?:boolean}} [opts]
 * @returns {string}
 */
export function fmtTime(ms, tz, hour12 = false, { seconds = true } = {}) {
    const z = utcToZoned(ms, tz, zbuf);
    if (!fin(z.y)) return DASH;
    const sec = seconds ? `:${pad2(z.s)}` : '';
    if (hour12) return `${z.h % 12 || 12}:${pad2(z.mi)}${sec} ${z.h < 12 ? 'AM' : 'PM'}`;
    return `${pad2(z.h)}:${pad2(z.mi)}${sec}`;
}

/**
 * 'Sun 11 Oct 2026 · 20:14:05'.
 * @param {number} ms
 * @param {unknown} tz
 * @param {boolean} [hour12]
 * @param {{seconds?:boolean, weekday?:boolean}} [opts]
 * @returns {string}
 */
export function fmtDateTime(ms, tz, hour12 = false, { seconds = true, weekday: withWeekday = true } = {}) {
    const d = fmtDate(ms, tz, { weekday: withWeekday });
    return d === DASH ? DASH : `${d} · ${fmtTime(ms, tz, hour12, { seconds })}`;
}

/**
 * Right ascension from hours: 6.7525 → '6h 45m 09s' (wraps into 0..24 h).
 * @param {number} hours
 * @returns {string}
 */
export function fmtRA(hours) {
    const x = num(hours);
    if (!fin(x)) return DASH;
    let total = Math.round((((x % 24) + 24) % 24) * 3600);
    if (total >= 86400) total -= 86400;
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return `${h}h ${pad2(m)}m ${pad2(s)}s`;
}

/**
 * Declination (signed, always with a sign): −16.7194 → '−16° 43′ 10″', 7.4 → '+7° 24′ 00″'.
 * @param {number} deg
 * @returns {string}
 */
export function fmtDec(deg) {
    const x = num(deg);
    if (!fin(x)) return DASH;
    const total = Math.round(Math.abs(x) * 3600);
    const d = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return `${x < 0 && total > 0 ? MINUS : '+'}${d}° ${pad2(m)}′ ${pad2(s)}″`;
}

/**
 * Signed decimal degrees: fmtDeg(-5.27) → '−5.3°'.
 * @param {number} deg
 * @param {number} [digits]
 * @returns {string}
 */
export function fmtDeg(deg, digits = 1) {
    const x = num(deg);
    if (!fin(x)) return DASH;
    const s = Math.abs(x).toFixed(digits);
    return `${x < 0 && Number(s) !== 0 ? MINUS : ''}${s}°`;
}

/**
 * Altitude: 34.21 → '34.2°', −5.27 → '−5.3°'.
 * @param {number} deg
 * @returns {string}
 */
export function fmtAlt(deg) {
    return fmtDeg(deg, 1);
}

/**
 * 16-point compass abbreviation for an azimuth (0 = N, 90 = E): 118 → 'ESE'.
 * @param {number} azDeg
 * @returns {string}
 */
export function compass16(azDeg) {
    const x = num(azDeg);
    if (!fin(x)) return DASH;
    return COMPASS16[((Math.round(x / 22.5) % 16) + 16) % 16];
}

/**
 * 8-point compass word for sentences: 135 → 'south-east'.
 * @param {number} azDeg
 * @returns {string}
 */
export function compassWord(azDeg) {
    const x = num(azDeg);
    if (!fin(x)) return DASH;
    return COMPASS8_WORDS[((Math.round(x / 45) % 8) + 8) % 8];
}

/**
 * Azimuth with compass point: 118 → '118° ESE', 359.7 → '0° N'.
 * @param {number} deg
 * @returns {string}
 */
export function fmtAz(deg) {
    const x = num(deg);
    if (!fin(x)) return DASH;
    const a = ((Math.round(x) % 360) + 360) % 360;
    return `${a}° ${compass16(x)}`;
}

/**
 * Distance in km: '384,400 km', '228.0 million km', '1.43 billion km'.
 * @param {number} km
 * @returns {string}
 */
export function fmtDistKm(km) {
    const x = num(km);
    if (!fin(x) || x < 0) return DASH;
    // Thresholds sit where the smaller unit would round up to "1000.0 million" / "1,000,000".
    if (x >= 999.95e6) return `${(x / 1e9).toFixed(2)} billion km`;
    if (x >= 999999.5) return `${(x / 1e6).toFixed(1)} million km`;
    return `${fmtInt(x)} km`;
}

/**
 * Distance in AU with km: 1.524 → '1.524 AU · 228.0 million km'; the Moon → '0.00257 AU · 384,400 km'.
 * @param {number} au
 * @returns {string}
 */
export function fmtDistAU(au) {
    const x = num(au);
    if (!fin(x) || x < 0) return DASH;
    let a;
    if (x >= 9.995) a = x.toFixed(2);
    else if (x >= 0.0995) a = x.toFixed(3);
    else a = x.toFixed(5);
    return `${a} AU · ${fmtDistKm(x * AU_KM)}`;
}

/**
 * Human duration from ms, rounded to the minute and showing the two largest units:
 * '45 min', '3 h 12 min', '2 d 4 h', '5 mo', '2.5 yr'. Under a minute: '40 s'.
 * @param {number} ms
 * @returns {string}
 */
export function fmtDuration(ms) {
    const x = Math.abs(num(ms));
    if (!fin(x)) return DASH;
    if (x < 59.5e3) return `${Math.round(x / 1e3)} s`;
    const totalMin = Math.round(x / 6e4);
    if (totalMin < 60) return `${totalMin} min`;
    if (totalMin < 1440) {
        const h = Math.floor(totalMin / 60), m = totalMin % 60;
        return m ? `${h} h ${m} min` : `${h} h`;
    }
    const totalH = Math.round(x / 36e5);
    const days = Math.floor(totalH / 24);
    if (days < 60) {
        const h = totalH % 24;
        return h ? `${days} d ${h} h` : `${days} d`;
    }
    const dExact = x / 864e5;
    if (dExact < 365.25) return `${Math.round(dExact / 30.436875)} mo`;
    return `${sig3(dExact / 365.25)} yr`;
}

/**
 * Light travel time from seconds: 1.28 → '1.3 s', 499 → '8 min 19 s', 4860 → '1 h 21 min'.
 * @param {number} sec
 * @returns {string}
 */
export function fmtLightTime(sec) {
    const x = num(sec);
    if (!fin(x) || x < 0) return DASH;
    if (x < 9.95) return `${x.toFixed(1)} s`;
    if (x < 59.5) return `${Math.round(x)} s`;
    const total = Math.round(x);
    if (total < 3600) {
        const m = Math.floor(total / 60), s = total % 60;
        return s ? `${m} min ${s} s` : `${m} min`;
    }
    const tm = Math.round(x / 60);
    if (tm < 1440) {
        const h = Math.floor(tm / 60), m = tm % 60;
        return m ? `${h} h ${m} min` : `${h} h`;
    }
    return fmtDuration(x * 1000);
}

/**
 * Simulation rate (sim-seconds per wall-second): 1 → 'Real time', 10 → '10×', 60 → '1 min/s',
 * 3600 → '1 h/s', −86400 → '−1 d/s', 31557600 → '1 yr/s'. Off-ladder rates (timelapse) work too.
 * @param {number} rate
 * @returns {string}
 */
export function fmtRate(rate) {
    const x = num(rate);
    if (!fin(x)) return DASH;
    if (x === 1) return 'Real time';
    if (x === 0) return 'Paused';
    const a = Math.abs(x), sign = x < 0 ? MINUS : '';
    if (a >= 31557600 * 0.9995) return `${sign}${sig3(a / 31557600)} yr/s`;
    if (a >= 86400 * 0.9995) return `${sign}${sig3(a / 86400)} d/s`;
    if (a >= 3600 * 0.9995) return `${sign}${sig3(a / 3600)} h/s`;
    if (a >= 60 * 0.9995) return `${sign}${sig3(a / 60)} min/s`;
    return `${sign}${sig3(a)}×`;
}

/**
 * Magnitude with one decimal: −4.3 → '−4.3', 0.6 → '0.6'.
 * @param {number} m
 * @returns {string}
 */
export function fmtMag(m) {
    const x = num(m);
    if (!fin(x)) return DASH;
    const s = Math.abs(x).toFixed(1);
    return `${x < 0 && Number(s) !== 0 ? MINUS : ''}${s}`;
}

/**
 * Fraction as a percentage: 0.62 → '62%'; tiny non-zero → '<1%'; almost 1 → '>99%'.
 * @param {number} frac
 * @returns {string}
 */
export function fmtPct(frac) {
    const x = num(frac);
    if (!fin(x)) return DASH;
    const v = x * 100;
    if (v > 0 && v < 0.5) return '<1%';
    if (v >= 99.5 && v < 100) return '>99%';
    return `${Math.round(v)}%`;
}

/**
 * Angular size from arcseconds: 45.2 → '45.2″', 1890 → '31′ 30″'.
 * @param {number} arcsec
 * @returns {string}
 */
export function fmtAngSize(arcsec) {
    const x = num(arcsec);
    if (!fin(x) || x < 0) return DASH;
    if (x < 59.95) return `${x.toFixed(1)}″`;
    const total = Math.round(x);
    return `${Math.floor(total / 60)}′ ${pad2(total % 60)}″`;
}

/** @param {number} v  absolute degrees → [d, m, s] rounded to the arcsecond */
function dms(v) {
    const total = Math.round(v * 3600);
    return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
}

/**
 * Latitude/longitude pair. 'dec' (default 2 decimals): '21.03° N 105.85° E';
 * with {digits:4, sep:', '}: '48.8600° N, 2.3500° E'. 'dms': '48°51′24″ N 2°21′08″ E'.
 * Longitude is wrapped into −180..180.
 * @param {number} lat
 * @param {number} lon
 * @param {'dec'|'dms'} [mode]
 * @param {{digits?:number, sep?:string}} [opts]
 * @returns {string}
 */
export function fmtLatLon(lat, lon, mode = 'dec', { digits = 2, sep = ' ' } = {}) {
    const la = num(lat);
    let lo = num(lon);
    if (!fin(la) || !fin(lo) || Math.abs(la) > 90) return DASH;
    if (lo > 180 || lo < -180) lo = ((((lo + 180) % 360) + 360) % 360) - 180;
    if (mode === 'dms') {
        const [ad, am, as] = dms(Math.abs(la));
        const [od, om, os] = dms(Math.abs(lo));
        const ns = la < 0 && ad + am + as > 0 ? 'S' : 'N';
        const ew = lo < 0 && od + om + os > 0 ? 'W' : 'E';
        return `${ad}°${pad2(am)}′${pad2(as)}″ ${ns}${sep}${od}°${pad2(om)}′${pad2(os)}″ ${ew}`;
    }
    const as = Math.abs(la).toFixed(digits), os = Math.abs(lo).toFixed(digits);
    const ns = la < 0 && Number(as) !== 0 ? 'S' : 'N';
    const ew = lo < 0 && Number(os) !== 0 ? 'W' : 'E';
    return `${as}° ${ns}${sep}${os}° ${ew}`;
}

/**
 * Time from `nowMs` to `ms`: 'in 3 h 12 min', '25 min ago', 'now' (within 30 s).
 * @param {number} ms
 * @param {number} nowMs
 * @returns {string}
 */
export function fmtRelative(ms, nowMs) {
    const d = num(ms) - num(nowMs);
    if (!fin(d)) return DASH;
    if (Math.abs(d) < 30e3) return 'now';
    const s = fmtDuration(d);
    return d > 0 ? `in ${s}` : `${s} ago`;
}

/**
 * Moon phase name from the Sun–Moon ecliptic elongation (astronomy-engine MoonPhase: 0 new,
 * 90 first quarter, 180 full, 270 last quarter). Principal phases are named within ±6° (≈ ±12 h).
 * @param {number} phaseDeg
 * @returns {string}
 */
export function moonPhaseName(phaseDeg) {
    const x = num(phaseDeg);
    if (!fin(x)) return DASH;
    const p = ((x % 360) + 360) % 360;
    const near = (c) => Math.abs(((p - c + 540) % 360) - 180) <= 6;
    if (near(0)) return 'New Moon';
    if (near(90)) return 'First quarter';
    if (near(180)) return 'Full Moon';
    if (near(270)) return 'Last quarter';
    if (p < 90) return 'Waxing crescent';
    if (p < 180) return 'Waxing gibbous';
    if (p < 270) return 'Waning gibbous';
    return 'Waning crescent';
}

/**
 * Approximate Moon age in days since New Moon from the phase angle (mean synodic month).
 * @param {number} phaseDeg
 * @returns {number}
 */
export function moonAgeDays(phaseDeg) {
    const x = num(phaseDeg);
    if (!fin(x)) return Number.NaN;
    return ((((x % 360) + 360) % 360) / 360) * SYNODIC_MONTH_D;
}
