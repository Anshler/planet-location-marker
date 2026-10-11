// Offline city index (SPEC §C.3, §G; ADDENDUM A2).
//
// Input is data/cities.json:
//   {"v":1, "countries":{"VN":"Vietnam",…}, "fields":["name","ascii","cc","admin","lat","lon","tz","pop"], "rows":[[…],…]}
// Columns are located through `fields`, so the order may change without breaking this module.
//
// Search folds case and diacritics (NFD + a few letters NFD keeps, such as đ ø ł ß), and ranks
// exact > prefix > word-prefix > substring > fuzzy (one typo, two for long queries), ties broken by
// log(population). "name, country" / "name, region" / "name cc" narrow the match. A few
// historical names (Saigon, Bombay, Peking, …) resolve to today's city.
//
// byTz() compares CANONICAL zone ids (ADDENDUM A2): Chrome reports 'Asia/Saigon' while GeoNames
// says 'Asia/Ho_Chi_Minh'. The canonicaliser is injected so this module stays pure; the default
// is identity (pass tz.canonTz in the app).

import { distanceKm } from './coords.js';

/** @typedef {import('../core/types.js').Place} Place */

const DEFAULT_FIELDS = Object.freeze(['name', 'ascii', 'cc', 'admin', 'lat', 'lon', 'tz', 'pop']);

/** Letters that NFD does not decompose into base + mark. */
const SPECIAL_LETTERS = {
    đ: 'd', Đ: 'd', ð: 'd', Ð: 'd', ø: 'o', Ø: 'o', ł: 'l', Ł: 'l', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
    ß: 'ss', ı: 'i', þ: 'th', Þ: 'th', ħ: 'h', Ħ: 'h', ŧ: 't', Ŧ: 't',
};
const SPECIAL_RE = /[đĐðÐøØłŁæÆœŒßıþÞħĦŧŦ]/g;

/** Former or colloquial names → [GeoNames name, country code]. Targets missing from the data are ignored. */
const ALIASES = Object.freeze([
    ['saigon', 'Ho Chi Minh City', 'VN'], ['sai gon', 'Ho Chi Minh City', 'VN'], ['hcmc', 'Ho Chi Minh City', 'VN'],
    ['bombay', 'Mumbai', 'IN'], ['calcutta', 'Kolkata', 'IN'], ['madras', 'Chennai', 'IN'], ['bangalore', 'Bengaluru', 'IN'],
    ['peking', 'Beijing', 'CN'], ['canton', 'Guangzhou', 'CN'], ['kiev', 'Kyiv', 'UA'], ['rangoon', 'Yangon', 'MM'],
    ['leningrad', 'Saint Petersburg', 'RU'], ['st petersburg', 'Saint Petersburg', 'RU'], ['constantinople', 'Istanbul', 'TR'],
    ['nyc', 'New York City', 'US'], ['washington dc', 'Washington', 'US'], ['washington d c', 'Washington', 'US'],
    ['la', 'Los Angeles', 'US'], ['sf', 'San Francisco', 'US'], ['rio', 'Rio de Janeiro', 'BR'],
]);

/** Qualifier spellings people use for countries → ISO code (lower case). */
const QUALIFIER_ALIASES = Object.freeze({
    usa: 'us', america: 'us', uk: 'gb', britain: 'gb', 'great britain': 'gb', england: 'gb', scotland: 'gb', wales: 'gb',
    uae: 'ae', holland: 'nl', 'viet nam': 'vn',
});

/**
 * Search key for a string: lower case, no diacritics, apostrophes dropped (N'Djamena → ndjamena),
 * any other punctuation as single spaces. Non-Latin scripts are kept.
 * @param {unknown} s
 * @returns {string}
 */
export function foldText(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .normalize('NFD')
        .replace(/[\u0300-\u036F]/g, '')
        .replace(SPECIAL_RE, (c) => SPECIAL_LETTERS[c])
        .toLowerCase()
        .replace(/['’‘`´ʻʼ]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * Observer (store shape, plus `cc`) for a chosen place.
 * @param {Place} place
 * @param {import('../core/types.js').Observer['source']} [source]
 * @returns {import('../core/types.js').Observer & {cc:string}}
 */
export function placeToObserver(place, source = 'city') {
    return {
        latDeg: Number(place.lat), lonDeg: Number(place.lon), elevM: 0, name: String(place.name ?? ''),
        country: String(place.country || place.cc || ''), tz: place.tz || null, tzApprox: false, source, cc: String(place.cc ?? ''),
    };
}

/**
 * Display label: 'Lyon, France'; with `admin`: 'Springfield, Illinois, United States'.
 * @param {Place} place
 * @param {{admin?:boolean}} [opts]
 * @returns {string}
 */
export function placeLabel(place, { admin = false } = {}) {
    const parts = [place?.name];
    if (admin && place?.admin && place.admin !== place.name) parts.push(place.admin);
    if (place?.country) parts.push(place.country);
    return parts.filter(Boolean).join(', ');
}

// Bounded optimal-string-alignment distance with reusable rows (no allocation per comparison).
let rowA = new Int32Array(64), rowB = new Int32Array(64), rowC = new Int32Array(64);

/** OSA (Damerau) distance between a and b, or k+1 as soon as it must exceed k. */
function boundedDistance(a, b, k) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > k) return k + 1;
    if (lb + 1 > rowA.length) {
        rowA = new Int32Array(lb + 33);
        rowB = new Int32Array(lb + 33);
        rowC = new Int32Array(lb + 33);
    }
    let prev2 = rowA, prev = rowB, cur = rowC;
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
        cur[0] = i;
        let rowMin = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const cb = b.charCodeAt(j - 1);
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1));
            if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) v = Math.min(v, prev2[j - 2] + 1);
            cur[j] = v;
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > k) return k + 1;
        const t = prev2;
        prev2 = prev;
        prev = cur;
        cur = t;
    }
    return prev[lb];
}

/**
 * Builds the offline city index.
 * @param {unknown} json  parsed data/cities.json (anything else gives an empty, working index)
 * @param {{canonTz?:(tz:string)=>string|null}} [opts]  zone canonicaliser for byTz (default identity)
 * @returns {import('../core/types.js').CityIndex}
 */
export function loadCities(json, { canonTz = (tz) => tz } = {}) {
    const doc = json && typeof json === 'object' ? /** @type {any} */ (json) : {};
    const fields = Array.isArray(doc.fields) && doc.fields.length ? doc.fields : DEFAULT_FIELDS;
    const col = (name) => fields.indexOf(name);
    const iName = col('name'), iAscii = col('ascii'), iCc = col('cc'), iAdmin = col('admin');
    const iLat = col('lat'), iLon = col('lon'), iTz = col('tz'), iPop = col('pop');
    /** @type {Record<string,string>} */
    const countries = {};
    if (doc.countries && typeof doc.countries === 'object') {
        for (const [cc, name] of Object.entries(doc.countries)) if (typeof name === 'string') countries[cc.toUpperCase()] = name;
    }
    const str = (v) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

    /** @type {Place[]} */
    const list = [];
    const entries = [];
    for (const row of Array.isArray(doc.rows) ? doc.rows : []) {
        if (!Array.isArray(row)) continue;
        const name = str(row[iName]);
        const lat = Number(row[iLat]), lon = Number(row[iLon]);
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        const cc = str(row[iCc]).toUpperCase();
        const admin = str(row[iAdmin]);
        const pop = Math.max(0, Number(row[iPop]) || 0);
        /** @type {Place} */
        const place = { name, admin, country: countries[cc] || cc, cc, lat, lon, tz: str(row[iTz]) || null, pop, source: 'offline' };
        list.push(place);
        const nameF = foldText(name), asciiF = foldText(str(row[iAscii]) || name);
        const adminF = foldText(admin), countryF = foldText(place.country);
        entries.push({
            place, nameF, asciiF, nameS: ` ${nameF}`, asciiS: ` ${asciiF}`, adminS: ` ${adminF}`, countryF, countryS: ` ${countryF}`,
            ccF: cc.toLowerCase(), popW: Math.log10(pop + 1),
        });
    }

    /** 5 exact, 4 prefix, 3 word-prefix, 2 substring, 0 none. */
    function tierOf(e, q) {
        if (e.nameF === q || e.asciiF === q) return 5;
        if (e.nameF.startsWith(q) || e.asciiF.startsWith(q)) return 4;
        const wq = ` ${q}`;
        if (e.nameS.includes(wq) || e.asciiS.includes(wq)) return 3;
        if (e.nameF.includes(q) || e.asciiF.includes(q)) return 2;
        return 0;
    }

    /** Does the qualifier (folded) name this entry's country, country code or region? */
    function qualifies(e, qual) {
        if (!qual) return false;
        const code = QUALIFIER_ALIASES[qual] ?? qual;
        if (e.ccF === code) return true;
        if (qual.length < 2) return false;
        const wq = ` ${qual}`;
        return e.countryF.startsWith(qual) || e.countryS.includes(wq) || e.adminS.includes(wq);
    }

    function fuzzyDistance(q, e, k) {
        let best = k + 1;
        const n = q.length;
        for (const target of e.nameF === e.asciiF ? [e.nameF] : [e.nameF, e.asciiF]) {
            best = Math.min(best, boundedDistance(q, target.slice(0, 63), k));
            if (target.length > n) best = Math.min(best, boundedDistance(q, target.slice(0, n), k));
            if (target.length > n + 1) best = Math.min(best, boundedDistance(q, target.slice(0, n + 1), k));
            if (best === 0) break;
        }
        return best;
    }

    /** Index of entries by "folded name|cc" for alias resolution (built on first use). */
    let byNameCc = null;
    function aliasTargets(q) {
        if (!byNameCc) {
            byNameCc = new Map();
            for (const e of entries) {
                const key = `${e.nameF}|${e.ccF}`;
                const cur = byNameCc.get(key);
                if (!cur || e.place.pop > cur.place.pop) byNameCc.set(key, e);
            }
        }
        const out = [];
        for (const [alias, name, cc] of ALIASES) {
            const exact = alias === q;
            if (!exact && !(q.length >= 3 && alias.startsWith(q))) continue;
            const e = byNameCc.get(`${foldText(name)}|${cc.toLowerCase()}`);
            if (e) out.push([e, exact]);
        }
        return out;
    }

    function search(q, limit = 8) {
        const lim = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 8));
        const raw = typeof q === 'string' ? q.slice(0, 100) : '';
        const qf = foldText(raw);
        if (!qf || !entries.length) return [];
        /** @type {Map<object, number>} */
        const scores = new Map();
        const consider = (e, s) => {
            const prev = scores.get(e);
            if (prev === undefined || s > prev) scores.set(e, s);
        };

        let strong = false;
        for (const e of entries) {
            const tier = tierOf(e, qf);
            if (tier) {
                consider(e, tier * 10 + e.popW);
                if (tier >= 3) strong = true;
            }
        }
        for (const [e, exact] of aliasTargets(qf)) consider(e, (exact ? 50 : 40) + e.popW - 0.5);

        // "name, qualifier" — or, when the whole query found nothing good, "name qualifier".
        const splits = [];
        const comma = raw.lastIndexOf(',');
        if (comma > 0) {
            const nq = foldText(raw.slice(0, comma)), qual = foldText(raw.slice(comma + 1));
            if (nq && qual) splits.push([nq, qual]);
            else if (nq && !scores.size) splits.push([nq, '']);
        } else if (!strong) {
            const words = qf.split(' ');
            for (let k = 1; k < words.length; k++) splits.push([words.slice(0, k).join(' '), words.slice(k).join(' ')]);
        }
        for (const [nq, qual] of splits) {
            for (const e of entries) {
                if (qual && !qualifies(e, qual)) continue;
                const tier = tierOf(e, nq);
                if (tier) consider(e, tier * 10 + e.popW + (qual ? 1 : -1));
            }
        }
        // A qualifier nobody matched (typo in the country): fall back to the name alone.
        if (!scores.size && comma > 0) {
            const nq = foldText(raw.slice(0, comma));
            if (nq) for (const e of entries) {
                const tier = tierOf(e, nq);
                if (tier) consider(e, tier * 10 + e.popW - 1);
            }
        }

        if (scores.size < lim && qf.length >= 4) {
            const k = qf.length >= 8 ? 2 : 1;
            for (const e of entries) {
                if (scores.has(e)) continue;
                const d = fuzzyDistance(qf, e, k);
                if (d <= k) consider(e, 10 - (d - 1) * 4 + e.popW);
            }
        }

        return [...scores.entries()]
            .sort((a, b) => b[1] - a[1] || b[0].place.pop - a[0].place.pop || a[0].place.name.localeCompare(b[0].place.name))
            .slice(0, lim)
            .map(([e, s]) => ({ ...e.place, score: Math.round(s * 100) / 100 }));
    }

    function nearest(lat, lon, maxKm = Infinity) {
        const la = Number(lat), lo = Number(lon);
        let best = null, bestKm = Infinity;
        if (Number.isFinite(la) && Number.isFinite(lo)) {
            for (const p of list) {
                const km = distanceKm(la, lo, p.lat, p.lon);
                if (km < bestKm) {
                    bestKm = km;
                    best = p;
                }
            }
        }
        if (!best || bestKm > maxKm) return { city: null, km: bestKm };
        return { city: best, km: bestKm };
    }

    const canon = (tz) => {
        try {
            const c = canonTz(tz);
            return typeof c === 'string' && c ? c : null;
        } catch {
            return null;
        }
    };
    /** canonical zone → most populous city (built on first use: canonicalising ~400 zones once). */
    let tzIndex = null;
    function byTz(tz) {
        if (typeof tz !== 'string' || !tz.trim()) return null;
        if (!tzIndex) {
            tzIndex = new Map();
            const rawBest = new Map();
            for (const p of list) {
                if (!p.tz) continue;
                const cur = rawBest.get(p.tz);
                if (!cur || p.pop > cur.pop) rawBest.set(p.tz, p);
            }
            for (const [zone, p] of rawBest) {
                const key = canon(zone);
                if (!key) continue;
                const cur = tzIndex.get(key);
                if (!cur || p.pop > cur.pop) tzIndex.set(key, p);
            }
        }
        const key = canon(tz.trim());
        return key ? tzIndex.get(key) ?? null : null;
    }

    return {
        list,
        countries,
        get size() { return list.length; },
        search,
        nearest,
        byTz,
        countryName(cc) {
            const code = typeof cc === 'string' ? cc.trim().toUpperCase() : '';
            return countries[code] ?? code;
        },
    };
}
