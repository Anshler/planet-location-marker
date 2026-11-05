// Display formatters (SPEC §C.3).
//
// In the interface's locale (core/i18n.js): English is deterministic, independent of the browser
// locale; Vietnamese has a decimal comma, dot grouping and Intl's dates. Never use these for
// machine formats (the URL hash, .ics, CSV, diagnostics). Negative numbers use the true minus
// sign U+2212; angles use ° ′ ″. Every function returns an em dash for unusable input instead of
// throwing or printing "NaN".

import { utcToZoned, toCalendar } from './tz.js';
import { t, N_, dec, intl, locale, dateText, timeText } from './i18n.js';

const MINUS = '\u2212';
const DASH = '\u2014';
const AU_KM = 149597870.7;
const SYNODIC_MONTH_D = 29.530589;
const COMPASS16 = [N_('N'), N_('NNE'), N_('NE'), N_('ENE'), N_('E'), N_('ESE'), N_('SE'), N_('SSE'), N_('S'), N_('SSW'), N_('SW'),
    N_('WSW'), N_('W'), N_('WNW'), N_('NW'), N_('NNW')];
const COMPASS8_WORDS = [N_('north'), N_('north-east'), N_('east'), N_('south-east'), N_('south'), N_('south-west'), N_('west'), N_('north-west')];

/** Scratch for utcToZoned: formatters run at UI rates, no need to allocate per call. */
const zbuf = {};
const cbuf = {};

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' ? v : Number(v));
const fin = Number.isFinite;

/** Day of week 0=Sun for a proleptic Gregorian date (Sakamoto's method). The Julian calendar's
 * dates fall on the same weekdays, so callers pass the Gregorian fields. */
function weekday(y, mo, d) {
    const k = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    const yy = mo < 3 ? y - 1 : y;
    const w = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + k[mo - 1] + d) % 7;
    return (w + 7) % 7;
}

/** Up to 3 significant digits, no trailing zeros: 2.5, 30, 0.25 (Vietnamese 2,5). */
function sig3(x) {
    const v = Number(x.toPrecision(3));
    return locale() === 'en' ? String(v) : intl(Intl.NumberFormat, { maximumFractionDigits: 20 }).format(v);
}

/**
 * Integer with thousands separators: 384400 → '384,400' (Vietnamese '384.400').
 * @param {number} n
 * @returns {string}
 */
export function fmtInt(n) {
    const x = num(n);
    if (!fin(x)) return DASH;
    const r = Math.round(Math.abs(x));
    const s = locale() === 'en' ? String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intl(Intl.NumberFormat).format(r);
    return r !== 0 && x < 0 ? MINUS + s : s;
}

/**
 * A decimal number in the interface's locale, true minus sign: fmtNum(-1.25, 1) → '−1.3'
 * (Vietnamese '−1,3'). Not grouped in English (as toFixed).
 * @param {number} n
 * @param {number} [digits]
 * @returns {string}
 */
export function fmtNum(n, digits = 0) {
    const x = num(n);
    if (!fin(x)) return DASH;
    const s = dec(Math.abs(x), digits);
    return x < 0 && Number(Math.abs(x).toFixed(digits)) !== 0 ? MINUS + s : s;
}

/**
 * 'Sun 11 Oct 2026' in `tz` (an invalid tz means UTC; Vietnamese 'CN, 11 thg 10, 2026'). Before
 * 15 Oct 1582 the date is Julian, as records of the time give it (tz.toCalendar): 'Thu 4 Jul 1054';
 * `{calendar:true}` then appends ' (Julian)'.
 * @param {number} ms
 * @param {unknown} tz
 * @param {{weekday?:boolean, year?:boolean, calendar?:boolean}} [opts]
 * @returns {string}
 */
export function fmtDate(ms, tz, { weekday: withWeekday = true, year = true, calendar = false } = {}) {
    const z = utcToZoned(ms, tz, zbuf);
    if (!fin(z.y)) return DASH;
    const c = toCalendar(z, cbuf);
    const date = dateText({ y: c.y, mo: c.mo, d: c.d, wd: weekday(z.y, z.mo, z.d) },
        { weekday: withWeekday && 'short', day: 'numeric', month: 'short', year: year && 'numeric' });
    return calendar && c.cal === 'julian' ? t('{date} (Julian)', { date }) : date;
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
    return timeText(z, { seconds, hour12 });
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
    const s = fmtNum(deg, digits);
    return s === DASH ? s : `${s}°`;
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
    return t(COMPASS16[((Math.round(x / 22.5) % 16) + 16) % 16]);
}

/**
 * 8-point compass word for sentences: 135 → 'south-east'.
 * @param {number} azDeg
 * @returns {string}
 */
export function compassWord(azDeg) {
    const x = num(azDeg);
    if (!fin(x)) return DASH;
    return t(COMPASS8_WORDS[((Math.round(x / 45) % 8) + 8) % 8]);
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
    if (x >= 999.95e6) return t('{n} billion km', { n: dec(x / 1e9, 2) });
    if (x >= 999999.5) return t('{n} million km', { n: dec(x / 1e6, 1) });
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
    const a = dec(x, x >= 9.995 ? 2 : x >= 0.0995 ? 3 : 5);
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
    if (x < 59.5e3) return t('{n} s', { n: Math.round(x / 1e3) });
    const totalMin = Math.round(x / 6e4);
    if (totalMin < 60) return t('{n} min', { n: totalMin });
    if (totalMin < 1440) return hm(Math.floor(totalMin / 60), totalMin % 60);
    const totalH = Math.round(x / 36e5);
    const d = Math.floor(totalH / 24);
    if (d < 60) {
        const h = totalH % 24;
        return h ? t('{d} d {h} h', { d, h }) : t('{n} d', { n: d });
    }
    const dExact = x / 864e5;
    if (dExact < 365.25) return t('{n} mo', { n: Math.round(dExact / 30.436875) });
    return t('{n} yr', { n: sig3(dExact / 365.25) });
}

/** '3 h 12 min', '3 h'. */
const hm = (h, m) => (m ? t('{h} h {m} min', { h, m }) : t('{n} h', { n: h }));

/**
 * Light travel time from seconds: 1.28 → '1.3 s', 499 → '8 min 19 s', 4860 → '1 h 21 min'.
 * @param {number} sec
 * @returns {string}
 */
export function fmtLightTime(sec) {
    const x = num(sec);
    if (!fin(x) || x < 0) return DASH;
    if (x < 59.5) return t('{n} s', { n: dec(x, x < 9.95 ? 1 : 0) });
    const total = Math.round(x);
    if (total < 3600) {
        const m = Math.floor(total / 60), s = total % 60;
        return s ? t('{m} min {s} s', { m, s }) : t('{n} min', { n: m });
    }
    const tm = Math.round(x / 60);
    if (tm < 1440) return hm(Math.floor(tm / 60), tm % 60);
    return fmtDuration(x * 1000);
}

/**
 * Simulation rate (sim-seconds per wall-second): 1 → 'Real time', 10 → '10×', 60 → '1 min/s',
 * 3600 → '1 h/s', −86400 → '−1 d/s', 31557600 → '1 yr/s'. Off-ladder rates (timelapse) work too.
 * `compact` (the phone time bar) writes real time as '1×', like the rest of the × ladder.
 * @param {number} rate
 * @param {{compact?: boolean}} [opts]
 * @returns {string}
 */
export function fmtRate(rate, { compact = false } = {}) {
    const x = num(rate);
    if (!fin(x)) return DASH;
    if (x === 1) return compact ? '1×' : t('Real time');
    if (x === 0) return t('Paused');
    const a = Math.abs(x), sign = x < 0 ? MINUS : '';
    if (a >= 31557600 * 0.9995) return t('{n} yr/s', { n: sign + sig3(a / 31557600) });
    if (a >= 86400 * 0.9995) return t('{n} d/s', { n: sign + sig3(a / 86400) });
    if (a >= 3600 * 0.9995) return t('{n} h/s', { n: sign + sig3(a / 3600) });
    if (a >= 60 * 0.9995) return t('{n} min/s', { n: sign + sig3(a / 60) });
    return `${sign}${sig3(a)}×`;
}

/**
 * Magnitude with one decimal: −4.3 → '−4.3', 0.6 → '0.6'.
 * @param {number} m
 * @returns {string}
 */
export function fmtMag(m) {
    return fmtNum(m, 1);
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
    if (x < 59.95) return `${dec(x, 1)}″`;
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
        const ns = la < 0 && ad + am + as > 0 ? t('S') : t('N');
        const ew = lo < 0 && od + om + os > 0 ? t('W') : t('E');
        return pair(`${ad}°${pad2(am)}′${pad2(as)}″ ${ns}`, `${od}°${pad2(om)}′${pad2(os)}″ ${ew}`, sep);
    }
    const as = Math.abs(la).toFixed(digits), os = Math.abs(lo).toFixed(digits);
    const ns = la < 0 && Number(as) !== 0 ? t('S') : t('N');
    const ew = lo < 0 && Number(os) !== 0 ? t('W') : t('E');
    return pair(`${dec(Math.abs(la), digits)}° ${ns}`, `${dec(Math.abs(lo), digits)}° ${ew}`, sep);
}

/** ', ' is the locale's list separator (Vietnamese '; ', next to its decimal comma). */
const pair = (lat, lon, sep) => (sep === ', ' ? t('{lat}, {lon}', { lat, lon }) : lat + sep + lon);

/**
 * Time from `nowMs` to `ms`: 'in 3 h 12 min', '25 min ago', 'now' (within 30 s).
 * @param {number} ms
 * @param {number} nowMs
 * @returns {string}
 */
export function fmtRelative(ms, nowMs) {
    const d = num(ms) - num(nowMs);
    if (!fin(d)) return DASH;
    if (Math.abs(d) < 30e3) return t('now');
    const s = fmtDuration(d);
    return d > 0 ? t('in {time}', { time: s }) : t('{time} ago', { time: s });
}

/**
 * Names app/actions.js and core/store.js give places in English, and the cities (data/cities.json,
 * GeoNames' English) a locale names its own way: Vietnam's largest and the conventional exonyms.
 */
const NAMED = [N_('North Pole'), N_('South Pole'), N_('Royal Observatory Greenwich'),
    N_('Ho Chi Minh City'), N_('Hanoi'), N_('Haiphong'), N_('Da Nang'), N_('Qui Nhon'),
    N_('Beijing'), N_('Shanghai'), N_('Guangzhou'), N_('Hong Kong'), N_('Taipei'), N_('Moscow')];

/**
 * An observer's stored name in the locale. app/actions.js names places in English, since names
 * live in links and prefs: 'near Lyon' → 'gần Lyon', 'North Pole' → 'Bắc Cực' (and the default
 * observer), 'Hanoi' → 'Hà Nội'; others as given. Display only: links, prefs and the place search
 * keep the English.
 * @param {string} name
 * @returns {string}
 */
export function placeName(name) {
    const s = String(name ?? '');
    return s.startsWith('near ') ? t('near {place}', { place: placeName(s.slice(5)) }) : NAMED.includes(s) ? t(s) : s;
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
    if (near(0)) return t('New Moon');
    if (near(90)) return t('First quarter');
    if (near(180)) return t('Full Moon');
    if (near(270)) return t('Last quarter');
    if (p < 90) return t('Waxing crescent');
    if (p < 180) return t('Waxing gibbous');
    if (p < 270) return t('Waning gibbous');
    return t('Waning crescent');
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
