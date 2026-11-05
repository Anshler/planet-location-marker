// The interface's words and Intl formatting (pure; docs/ARCHITECTURE.md §12 'Strings and locales').
//
// gettext style: the English source text is the key. t('Sky view') is the active locale's string,
// or the English one when the table has none (silently); {name} placeholders are then filled.
// tn(one, other, n) picks a plural form ({n} filled; the table's key is `other`, its value a string,
// or {one, few, many, other} by Intl.PluralRules for a locale with more forms). N_('…') only marks a
// string of a module-level table for test/repo.i18n.test.mjs: translate it with t(x) where it is
// shown, since tables are built before the locale is set. English needs no table.

/** The supported locales, each named in its own language (the Display control's labels). */
export const LOCALES = Object.freeze({ en: 'English', vi: 'Tiếng Việt' });
/** Intl tags: en-US keeps the designed English names ('Sep', 'PM'). */
const TAGS = { en: 'en-US', vi: 'vi-VN' };

let code = 'en';
/** @type {Record<string, any>|null} */
let table = null;
const cache = new Map();

/**
 * Makes `c` the active locale with its string table (an unknown code is English).
 * @param {string} c
 * @param {Record<string, any>|null} [tbl]
 */
export function setLocale(c, tbl = null) {
    code = Object.hasOwn(LOCALES, c) ? c : 'en';
    table = code === 'en' ? null : tbl;
    cache.clear();
}

/** The active locale's code ('en', 'vi'). */
export const locale = () => code;
/** The active locale's Intl tag ('en-US', 'vi-VN'). */
export const tag = () => TAGS[code];
/** The active table (posted to the astro worker), or null for English. */
export const strings = () => table;

/**
 * The first supported locale among a #lang= value, the saved choice and navigator.language
 * ('vi-VN' → 'vi'), else English.
 * @param {...unknown} wants
 */
export function pickLocale(...wants) {
    for (const w of wants) {
        const c = String(w ?? '').slice(0, 2).toLowerCase();
        if (Object.hasOwn(LOCALES, c)) return c;
    }
    return 'en';
}

const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m) : s);

/**
 * The active locale's text for the English source `en`, placeholders filled.
 * @param {string} en
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export const t = (en, vars) => fill(table?.[en] || en, vars);

/**
 * A count's phrase: tn('{n} world', '{n} worlds', n).
 * @param {string} one
 * @param {string} other
 * @param {number} n
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function tn(one, other, n, vars) {
    const tr = table?.[other];
    const s = !tr ? (n === 1 ? one : other) : typeof tr === 'string' ? tr : tr[intl(Intl.PluralRules).select(n)] ?? tr.other;
    return fill(s, { n, ...vars });
}

/** Marks a table's string for the extraction test; returns it unchanged. */
export const N_ = (s) => s;

/**
 * A cached Intl formatter of the active locale: intl(Intl.NumberFormat, {maximumFractionDigits: 1}).
 * @template T
 * @param {new (tag: string, opts?: any) => T} Ctor
 * @param {object} [opts]
 * @returns {T}
 */
export function intl(Ctor, opts) {
    const k = Ctor.name + JSON.stringify(opts);
    let f = cache.get(k);
    if (!f) cache.set(k, (f = new Ctor(TAGS[code], opts)));
    return f;
}

/**
 * `x` with exactly `digits` decimals in the locale's digits ('1.5' / '1,5'; never grouped in
 * English, as toFixed).
 * @param {number} x
 * @param {number} [digits]
 */
export const dec = (x, digits = 0) => (code === 'en' ? x.toFixed(digits)
    : intl(Intl.NumberFormat, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x));

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/**
 * A wall-clock date in the active locale. `f` holds the calendar's fields as printed (months
 * 1-based; a Julian date stays Julian: Intl formats the numbers as given) and `wd`, the weekday
 * (0 = Sunday). `o` takes Intl's weekday, day, month and year options. English keeps its designed
 * order with Intl's names ('Sat 11 Oct 2026', 'Tue 14', 'Oct 2026'); other locales use Intl's
 * pattern ('Thứ 7, 11 thg 10, 2026').
 * @param {{y:number, mo:number, d:number, wd:number}} f
 * @param {{weekday?:any, day?:any, month?:any, year?:any}} o
 * @returns {string}
 */
export function dateText(f, o) {
    const at = Date.UTC(f.y, f.mo - 1, f.d, 12);
    const opts = { timeZone: 'UTC' };
    for (const k in o) if (o[k]) opts[k] = o[k];
    // 1 Jan 2023 was a Sunday.
    const wd = () => intl(Intl.DateTimeFormat, { weekday: o.weekday, timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + f.wd));
    if (code === 'en') {
        const out = [];
        if (o.weekday) out.push(wd());
        if (o.day) out.push(f.d);
        if (o.month) out.push(intl(Intl.DateTimeFormat, { month: o.month, timeZone: 'UTC' }).format(at));
        if (o.year) out.push(f.y);
        return out.join(' ');
    }
    return intl(Intl.DateTimeFormat, opts).formatToParts(at).map((p) => (p.type === 'weekday' ? wd() : p.value)).join('');
}

/**
 * A wall-clock time ('20:14', '8:14:05 PM'; Vietnamese '8:14 CH'). The 24-hour clock is HH:mm
 * everywhere.
 * @param {{h:number, mi:number, s?:number}} f
 * @param {{seconds?:boolean, hour12?:boolean}} [o]
 * @returns {string}
 */
export function timeText(f, { seconds = false, hour12 = false } = {}) {
    const ss = seconds ? ':' + pad2(Math.floor(f.s || 0)) : '';
    if (!hour12) return `${pad2(f.h)}:${pad2(f.mi)}${ss}`;
    if (code === 'en') return `${f.h % 12 || 12}:${pad2(f.mi)}${ss} ${f.h < 12 ? 'AM' : 'PM'}`;
    return intl(Intl.DateTimeFormat, { hour: 'numeric', minute: '2-digit', second: seconds ? '2-digit' : undefined, hourCycle: 'h12', timeZone: 'UTC' })
        .format(Date.UTC(2000, 0, 1, f.h, f.mi, Math.floor(f.s || 0)));
}
