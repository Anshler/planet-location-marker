// Time-zone utilities (SPEC §C.3, ADDENDUM A2).
//
// Everything goes through Intl, which canonicalises IANA ids to ICU's (often legacy) names:
// Asia/Ho_Chi_Minh → Asia/Saigon, Asia/Kolkata → Asia/Calcutta, Europe/Kyiv → Europe/Kiev,
// Etc/UTC → UTC; and 'UTC' itself is NOT listed by Intl.supportedValuesOf('timeZone'). v1 died on
// UTC-configured systems because of this, so here:
//   - ids are compared only through canonTz();
//   - no function that takes a tz ever throws: an unusable tz silently means 'UTC'.
//
// Offsets are derived from formatToParts (wall clock vs instant), so historic local-mean-time
// offsets with seconds (Asia/Saigon 1900 = +7:06:30) come out exact.

const DAY_MS = 864e5;
/** 400 Gregorian years in ms: the calendar repeats exactly, used to dodge Date.UTC's 0..99 → 19xx rule. */
const GREGORIAN_CYCLE_MS = 146097 * DAY_MS;
/** Largest |ms| a Date can hold. */
const DATE_LIMIT_MS = 8.64e15;

/** About 60 zones spanning every offset, for engines without Intl.supportedValuesOf. */
const FALLBACK_ZONES = Object.freeze([
    'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Phoenix',
    'America/Chicago', 'America/Mexico_City', 'America/New_York', 'America/Bogota', 'America/Lima', 'America/Caracas',
    'America/Halifax', 'America/Santiago', 'America/St_Johns', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'America/Nuuk', 'Atlantic/South_Georgia', 'Atlantic/Azores', 'Atlantic/Cape_Verde', 'Europe/London', 'Europe/Lisbon',
    'Africa/Abidjan', 'Africa/Lagos', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Africa/Cairo',
    'Africa/Johannesburg', 'Europe/Athens', 'Europe/Kyiv', 'Europe/Istanbul', 'Europe/Moscow', 'Asia/Riyadh',
    'Africa/Nairobi', 'Asia/Tehran', 'Asia/Dubai', 'Asia/Kabul', 'Asia/Karachi', 'Asia/Tashkent', 'Asia/Kolkata',
    'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Yangon', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Jakarta', 'Asia/Shanghai',
    'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Manila', 'Australia/Perth', 'Australia/Eucla', 'Asia/Tokyo', 'Asia/Seoul',
    'Australia/Darwin', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney', 'Pacific/Guam',
    'Australia/Lord_Howe', 'Pacific/Noumea', 'Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Chatham', 'Pacific/Tongatapu',
    'Pacific/Kiritimati',
]);

/** @type {Map<string, string|null>} */
const canonMemo = new Map();
/** @type {Map<string, Intl.DateTimeFormat>} */
const partsFmtMemo = new Map();

/**
 * Canonical IANA id as the engine knows it (e.g. 'Asia/Ho_Chi_Minh' → 'Asia/Saigon' in Chrome
 * and Node), or null when the engine rejects it. Memoised; never throws.
 * @param {unknown} tz
 * @returns {string|null}
 */
export function canonTz(tz) {
    if (typeof tz !== 'string') return null;
    const key = tz.trim();
    if (!key || key.length > 64) return null;
    const hit = canonMemo.get(key);
    if (hit !== undefined) return hit;
    let out = null;
    try {
        out = new Intl.DateTimeFormat('en-US', { timeZone: key }).resolvedOptions().timeZone || null;
    } catch {
        out = null;
    }
    if (canonMemo.size > 512) canonMemo.clear();
    canonMemo.set(key, out);
    return out;
}

/**
 * True when the engine accepts `tz` as a time zone (any alias, any case).
 * @param {unknown} tz
 * @returns {boolean}
 */
export function isValidTz(tz) {
    return canonTz(tz) !== null;
}

/**
 * Canonical tz to compute with: `tz` when valid, otherwise 'UTC'.
 * @param {unknown} tz
 * @returns {string}
 */
export function resolveTz(tz) {
    return canonTz(tz) ?? 'UTC';
}

/**
 * The device's time zone (canonical engine name), or 'UTC' when unknown.
 * @returns {string}
 */
export function deviceTz() {
    try {
        return canonTz(new Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * Date.UTC with 1-based month that also works for years 0..99 (which Date.UTC maps to 19xx).
 * Out-of-range fields overflow naturally (h = 24 → next day).
 */
function utcMs(y, mo, d, h, mi, s) {
    if (y >= 0 && y < 100) return Date.UTC(y + 400, mo - 1, d, h, mi, s) - GREGORIAN_CYCLE_MS;
    return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** @param {string} tz canonical */
function partsFormatter(tz) {
    let f = partsFmtMemo.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short',
        });
        if (partsFmtMemo.size > 128) partsFmtMemo.clear();
        partsFmtMemo.set(tz, f);
    }
    return f;
}

/**
 * Wall-clock fields of a whole-second instant in a canonical tz. Writes into `out`.
 * @param {number} ts  whole seconds, ms units
 * @param {string} tz
 * @param {Record<string, any>} out
 */
function readParts(ts, tz, out) {
    out.y = Number.NaN; out.mo = Number.NaN; out.d = Number.NaN;
    out.h = 0; out.mi = 0; out.s = 0; out.abbr = '';
    let bc = false;
    for (const p of partsFormatter(tz).formatToParts(new Date(ts))) {
        switch (p.type) {
            case 'year': out.y = Number(p.value); break;
            case 'month': out.mo = Number(p.value); break;
            case 'day': out.d = Number(p.value); break;
            case 'hour': out.h = Number(p.value) % 24; break; // some engines print midnight as 24
            case 'minute': out.mi = Number(p.value); break;
            case 'second': out.s = Number(p.value); break;
            case 'timeZoneName': out.abbr = p.value; break;
            case 'era': bc = /^b/i.test(p.value); break;
            default: break;
        }
    }
    if (bc) out.y = 1 - out.y;
    return out;
}

const scratch = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0, abbr: '' };

/** UTC offset (ms, local − UTC) in force at instant `t` in canonical tz `tz`. */
function offsetMs(t, tz) {
    const ts = Math.floor(t / 1000) * 1000;
    readParts(ts, tz, scratch);
    return utcMs(scratch.y, scratch.mo, scratch.d, scratch.h, scratch.mi, scratch.s) - ts;
}

/**
 * Wall-clock time of instant `ms` in `tz`: `{y, mo (1-12), d, h, mi, s, offsetMin, abbr}`.
 * `offsetMin` is local − UTC in minutes (fractional for historic LMT offsets). An invalid tz
 * means UTC; a non-finite `ms` yields NaN date fields. Pass `out` to reuse an object.
 * @param {number} ms
 * @param {unknown} tz
 * @param {Record<string, any>} [out]
 * @returns {import('./types.js').ZonedTime}
 */
export function utcToZoned(ms, tz, out) {
    const o = out ?? {};
    const x = Number(ms);
    if (!Number.isFinite(x) || Math.abs(x) > DATE_LIMIT_MS) {
        o.y = Number.NaN; o.mo = Number.NaN; o.d = Number.NaN; o.h = Number.NaN; o.mi = Number.NaN; o.s = Number.NaN;
        o.offsetMin = 0; o.abbr = '';
        return o;
    }
    const ts = Math.floor(x / 1000) * 1000;
    try {
        readParts(ts, resolveTz(tz), o);
        o.offsetMin = (utcMs(o.y, o.mo, o.d, o.h, o.mi, o.s) - ts) / 6e4;
    } catch {
        const dt = new Date(ts);
        o.y = dt.getUTCFullYear(); o.mo = dt.getUTCMonth() + 1; o.d = dt.getUTCDate();
        o.h = dt.getUTCHours(); o.mi = dt.getUTCMinutes(); o.s = dt.getUTCSeconds();
        o.offsetMin = 0; o.abbr = 'UTC';
    }
    return o;
}

/**
 * Instant (ms) at which the wall clock in `tz` reads `{y, mo, d, h, mi, s}` (mo is 1-based;
 * missing fields default to the start of the day/month; overflowing fields roll over).
 *
 * Two passes: (1) the offsets in force a day before and after the wall time bracket any
 * transition near it; (2) each bracketing offset o yields a candidate W − o that is kept only if
 * the zone really shows offset o at that instant.
 *   - DST overlap (both valid) → the EARLIER instant.
 *   - DST gap (neither valid) → shifted forward by the gap (02:30 in a 02:00→03:00 jump = 03:30).
 * Never throws: an invalid tz means UTC; unusable fields give NaN.
 * @param {Partial<import('./types.js').ZonedFields>} fields
 * @param {unknown} tz
 * @returns {number}
 */
export function zonedToUtc(fields, tz) {
    const f = fields ?? {};
    const num = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : Number(v));
    const y = num(f.y, Number.NaN), mo = num(f.mo, 1), d = num(f.d, 1);
    const h = num(f.h, 0), mi = num(f.mi, 0), s = num(f.s, 0);
    if (![y, mo, d, h, mi, s].every(Number.isFinite)) return Number.NaN;
    const W = utcMs(Math.trunc(y), mo, d, h, mi, s);
    if (!Number.isFinite(W) || Math.abs(W) > DATE_LIMIT_MS - 2 * DAY_MS) return Number.NaN;
    const z = resolveTz(tz);
    try {
        const oA = offsetMs(W - DAY_MS, z);
        const oB = offsetMs(W + DAY_MS, z);
        let best = Number.NaN;
        for (const o of oA === oB ? [oA] : [oA, oB]) {
            const t = W - o;
            if (offsetMs(t, z) === o && !(t >= best)) best = t;
        }
        if (Number.isFinite(best)) return best;
        // Gap: no instant shows this wall time. The pre-transition (smaller) offset lands just as
        // far past the end of the gap as the wall time was past its start.
        return W - Math.min(oA, oB);
    } catch {
        return W;
    }
}

/**
 * Start (ms) of the local calendar day containing `ms` in `tz`. When midnight falls in a DST gap
 * (e.g. Asia/Beirut, America/Santiago) the day starts at the first existing instant (01:00).
 * @param {number} ms
 * @param {unknown} tz
 * @returns {number}
 */
export function localDayStart(ms, tz) {
    const z = utcToZoned(ms, tz);
    if (!Number.isFinite(z.y)) return Number.NaN;
    return zonedToUtc({ y: z.y, mo: z.mo, d: z.d, h: 0, mi: 0, s: 0 }, tz);
}

/**
 * Nautical time zone for a longitude, as an IANA Etc id. The Etc sign is inverted by convention:
 * 105° E → 'Etc/GMT-7' (UTC+7). Longitude 0 (±7.5°) → 'Etc/GMT'. Never throws.
 * @param {number} lonDeg
 * @returns {string}
 */
export function approxTzForLon(lonDeg) {
    let lon = Number(lonDeg);
    if (!Number.isFinite(lon)) return 'Etc/GMT';
    if (lon > 180 || lon < -180) lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const n = Math.max(-12, Math.min(12, Math.round(lon / 15))) || 0;
    if (n === 0) return 'Etc/GMT';
    return `Etc/GMT${n > 0 ? '-' : '+'}${Math.abs(n)}`;
}

/**
 * Short UTC offset label: 420 → 'UTC+7', −210 → 'UTC−3:30' (U+2212 minus), 345 → 'UTC+5:45',
 * 0 → 'UTC+0'. Rounds to whole minutes.
 * @param {number} min
 * @returns {string}
 */
export function offsetLabel(min) {
    const x = Number(min);
    if (!Number.isFinite(x)) return 'UTC';
    const total = Math.round(Math.abs(x));
    if (total === 0) return 'UTC+0';
    const h = Math.floor(total / 60), m = total % 60;
    return `UTC${x < 0 ? '\u2212' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * Offset label in force at an instant, e.g. offsetLabelAt(Date.now(), 'Asia/Kolkata') → 'UTC+5:30'.
 * @param {number} ms
 * @param {unknown} tz
 * @returns {string}
 */
export function offsetLabelAt(ms, tz) {
    return offsetLabel(utcToZoned(ms, tz).offsetMin);
}

/** @type {{ids:string[], canon:Set<string>}|null} */
let zoneListMemo = null;

/**
 * Time zones for a picker: always 'UTC' first, then the engine's list (or ~60 fallback zones),
 * alphabetical, and always including deviceTz(). Returns a fresh array.
 * @returns {string[]}
 */
export function listTimeZones() {
    if (!zoneListMemo) {
        let ids = [];
        try {
            if (typeof Intl.supportedValuesOf === 'function') ids = Intl.supportedValuesOf('timeZone');
        } catch {
            ids = [];
        }
        const canon = new Set(['UTC']);
        const out = [];
        if (ids?.length) {
            // Already canonical; skipping canonTz avoids building ~400 formatters.
            for (const id of ids) {
                if (canon.has(id)) continue;
                canon.add(id);
                out.push(id);
            }
        } else {
            for (const id of FALLBACK_ZONES) {
                const c = canonTz(id);
                if (!c || canon.has(c)) continue;
                canon.add(c);
                out.push(id);
            }
        }
        out.sort();
        zoneListMemo = { ids: ['UTC', ...out], canon };
    }
    const list = zoneListMemo.ids.slice();
    const dev = deviceTz();
    if (!zoneListMemo.canon.has(dev) && !list.includes(dev)) {
        let i = 1;
        while (i < list.length && list[i] < dev) i++;
        list.splice(i, 0, dev);
    }
    return list;
}

/**
 * The time zone used to display times, from the store's `display` and `observer` slices:
 * 'utc' → 'UTC'; 'device' → deviceTz(); 'observer' → observer.tz when valid, else the
 * longitude-based approximation. Never throws.
 * @param {{tzMode?:string}|null|undefined} display
 * @param {{tz?:string|null, lonDeg?:number}|null|undefined} observer
 * @returns {string}
 */
export function displayTz(display, observer) {
    const mode = display?.tzMode;
    if (mode === 'utc') return 'UTC';
    if (mode === 'device') return deviceTz();
    if (observer?.tz && isValidTz(observer.tz)) return observer.tz;
    if (Number.isFinite(observer?.lonDeg)) return approxTzForLon(observer.lonDeg);
    return 'UTC';
}

/**
 * Days in a month (mo 1-based), proleptic Gregorian.
 * @param {number} y
 * @param {number} mo
 * @returns {number}
 */
export function daysInMonth(y, mo) {
    if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Value for an `<input type="datetime-local">` showing instant `ms` in `tz`:
 * 'YYYY-MM-DDTHH:MM:SS' (or without seconds). Empty string for unusable input.
 * @param {number} ms
 * @param {unknown} tz
 * @param {{seconds?:boolean}} [opts]
 * @returns {string}
 */
export function toDatetimeLocal(ms, tz, { seconds = true } = {}) {
    const z = utcToZoned(ms, tz);
    if (!Number.isFinite(z.y) || z.y < 1 || z.y > 9999) return '';
    const base = `${String(z.y).padStart(4, '0')}-${pad2(z.mo)}-${pad2(z.d)}T${pad2(z.h)}:${pad2(z.mi)}`;
    return seconds ? `${base}:${pad2(z.s)}` : base;
}

/**
 * Parses a datetime-local value ('YYYY-MM-DDTHH:MM[:SS[.sss]]', 'T' or space) as wall time in
 * `tz`, DST-safe via zonedToUtc. Returns null for malformed or impossible dates (e.g. 31 April).
 * @param {unknown} str
 * @param {unknown} tz
 * @returns {number|null}
 */
export function fromDatetimeLocal(str, tz) {
    if (typeof str !== 'string') return null;
    const m = /^\s*(\d{4,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?\s*$/.exec(str);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const h = Number(m[4] ?? 0), mi = Number(m[5] ?? 0), s = Number(m[6] ?? 0);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return null;
    const ms = zonedToUtc({ y, mo, d, h, mi, s }, tz);
    return Number.isFinite(ms) ? ms : null;
}
