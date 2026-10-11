// Coordinate parsing for the location palette (SPEC §C.3).
//
// Accepts decimal and degree-minute-second input in the forms people actually paste:
//   48.8566, 2.3522        48.8566 2.3522        -33.9 151.2        48,8566 2,3522 (decimal commas)
//   48°51′24″N 2°21′8″E    48 51 24 N, 2 21 8 E   21.03N 105.85E     N 48°51.4′ E 2°21.1′
//   48:51:24N 2:21:08E     2.35E 48.85N (hemisphere letters make the order free)
// Rejects anything else (city names, single numbers, out-of-range values, minutes ≥ 60,
// conflicting signs such as "-33.9S").

/** @typedef {{k:'n', v:number, neg:boolean, unit:string|null}|{k:'h', v:'N'|'S'|'E'|'W'}|{k:'sep'}} Token */

const TOKEN_RE = /\s*(?:([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([°'"])?|([NSEW])(?![A-Z])|([,;]))/y;
const UNIT_ORDER = ['°', "'", '"'];

/** Folds the many look-alike symbols into ASCII ° ' " and '-'. */
function normalise(s) {
    const t = s
        .replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-')
        .replace(/[\u00BA\u02DA\u2218]/g, '°')
        .replace(/[\u2032\u2018\u2019\u00B4`\u02B9\u02BC]/g, "'")
        .replace(/[\u2033\u201C\u201D\u02DD]|''/g, '"')
        .replace(/(\d):(?=\d)/g, '$1 ') // 48:51:24 → 48 51 24
        .toUpperCase()
        .trim();
    // One pair of enclosing brackets is fine: "(48.85, 2.35)", "[-33.9; 151.2]".
    const open = '([{'.indexOf(t[0]);
    return open >= 0 && t.endsWith(')]}'[open]) ? t.slice(1, -1).trim() : t;
}

/**
 * @param {string} s normalised input
 * @returns {Token[]|null}
 */
function tokenize(s) {
    /** @type {Token[]} */
    const out = [];
    let i = 0;
    while (i < s.length) {
        TOKEN_RE.lastIndex = i;
        const m = TOKEN_RE.exec(s);
        if (!m || m[0].length === 0) return s.slice(i).trim() === '' ? out : null;
        i = TOKEN_RE.lastIndex;
        if (m[1] !== undefined) out.push({ k: 'n', v: Math.abs(Number(m[1])), neg: m[1].startsWith('-'), unit: m[2] ?? null });
        else if (m[3] !== undefined) out.push({ k: 'h', v: /** @type {'N'|'S'|'E'|'W'} */ (m[3]) });
        else out.push({ k: 'sep' });
    }
    return out;
}

/**
 * Degrees from 1–3 numeric tokens (d, d m, d m s). Only the degrees may carry a sign; minutes and
 * seconds must be under 60; a fractional part is only allowed on the last component.
 * @param {Token[]} nums
 * @returns {number}
 */
function groupValue(nums) {
    if (nums.length < 1 || nums.length > 3) return Number.NaN;
    for (let i = 0; i < nums.length; i++) {
        const t = nums[i];
        if (t.unit && t.unit !== UNIT_ORDER[i]) return Number.NaN;
        if (i > 0 && (t.neg || t.v >= 60)) return Number.NaN;
        if (i < nums.length - 1 && !Number.isInteger(t.v)) return Number.NaN;
    }
    const mag = nums[0].v + (nums[1]?.v ?? 0) / 60 + (nums[2]?.v ?? 0) / 3600;
    return nums[0].neg ? -mag : mag;
}

/**
 * Groups tokens when hemisphere letters are present (prefix "N 48 51" or suffix "48 51 N" style).
 * @param {Token[]} toks
 * @returns {{hemi:string, nums:Token[]}[]|null}
 */
function groupByHemisphere(toks) {
    const groups = [];
    const prefix = toks[0].k === 'h';
    let cur = { hemi: '', nums: [] };
    let wantHemi = false;
    for (const t of toks) {
        if (t.k === 'sep') {
            // A separator may only sit between the two coordinates.
            if (prefix ? cur.nums.length === 0 : cur.nums.length > 0) return null;
            if (prefix) wantHemi = true;
            continue;
        }
        if (t.k === 'h') {
            if (prefix) {
                if (cur.hemi) groups.push(cur);
                cur = { hemi: t.v, nums: [] };
                wantHemi = false;
            } else {
                if (!cur.nums.length) return null;
                cur.hemi = t.v;
                groups.push(cur);
                cur = { hemi: '', nums: [] };
            }
            continue;
        }
        if (wantHemi || (prefix && !cur.hemi)) return null;
        cur.nums.push(t);
    }
    if (prefix && cur.hemi) groups.push(cur);
    else if (!prefix && cur.nums.length) return null; // numbers after the last letter
    return groups.length === 2 ? groups : null;
}

/**
 * Groups tokens without hemisphere letters: by a single separator, by degree marks, or by count.
 * @param {Token[]} toks
 * @returns {Token[][]|null}
 */
function groupPlain(toks) {
    const sepAt = [];
    toks.forEach((t, i) => { if (t.k === 'sep') sepAt.push(i); });
    if (sepAt.length > 1) return null;
    if (sepAt.length === 1) return [toks.slice(0, sepAt[0]), toks.slice(sepAt[0] + 1)];
    if (toks.some((t) => t.unit)) {
        const groups = [];
        for (const t of toks) {
            if (t.unit === '°' || !groups.length) groups.push([]);
            groups[groups.length - 1].push(t);
        }
        return groups.length === 2 ? groups : null;
    }
    const n = toks.length;
    if (n !== 2 && n !== 4 && n !== 6) return null;
    return [toks.slice(0, n / 2), toks.slice(n / 2)];
}

/**
 * Lat/lon from two hemisphere-tagged groups: exactly one N/S and one E/W, in either order.
 * A sign together with a hemisphere letter ("-33.9 S", "-48 N") is contradictory and rejected.
 * @param {{hemi:string, nums:Token[]}[]} groups
 * @returns {{lat:number, lon:number}|null}
 */
function fromHemisphereGroups(groups) {
    const out = { lat: Number.NaN, lon: Number.NaN };
    for (const g of groups) {
        const v = groupValue(g.nums);
        if (!Number.isFinite(v) || v < 0 || g.nums[0].neg) return null;
        const axis = g.hemi === 'N' || g.hemi === 'S' ? 'lat' : 'lon';
        if (Number.isFinite(out[axis])) return null; // two latitudes or two longitudes
        out[axis] = g.hemi === 'S' || g.hemi === 'W' ? -v : v;
    }
    return out;
}

/** "48,8566 2,3522" / "48,8566; 2,3522" → "48.8566 2.3522"; anything else unchanged. */
function decimalCommas(s) {
    const parts = s.replace(/;/g, ' ').split(/\s+/);
    if (parts.length !== 2 || !parts.every((p) => /^[+-]?\d+,\d+$/.test(p))) return s;
    return parts.map((p) => p.replace(',', '.')).join(' ');
}

/**
 * Parses a latitude/longitude pair. Returns `{lat, lon}` in decimal degrees (lat −90..90,
 * lon −180..180), or null when the text is not a coordinate pair.
 * @param {unknown} str
 * @returns {{lat:number, lon:number}|null}
 */
export function parseLatLon(str) {
    if (typeof str !== 'string' || str.length > 120) return null;
    const s = str.trim();
    if (!s) return null;
    const toks = tokenize(normalise(decimalCommas(s)));
    if (!toks || toks.length < 2) return null;

    let pair = null;
    if (toks.some((t) => t.k === 'h')) {
        const groups = groupByHemisphere(toks);
        pair = groups && fromHemisphereGroups(groups);
    } else {
        const groups = groupPlain(toks);
        pair = groups && { lat: groupValue(groups[0]), lon: groupValue(groups[1]) };
    }
    if (!pair) return null;
    const { lat, lon } = pair;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat || 0, lon: lon || 0 };
}

/**
 * Wraps a longitude into −180..180. In-range values pass through untouched; wrapped values land
 * in (−180, 180], so 540 → 180.
 * @param {number} lon
 * @returns {number}
 */
export function wrapLon(lon) {
    const x = Number(lon);
    if (!Number.isFinite(x)) return Number.NaN;
    if (x >= -180 && x <= 180) return x || 0;
    const w = ((((x + 180) % 360) + 360) % 360) - 180;
    return w === -180 ? 180 : w || 0;
}

/**
 * Great-circle distance in km on a sphere of mean Earth radius (haversine).
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0088;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
