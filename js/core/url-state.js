// Deep links in the URL hash (SPEC §C.3, §F.4).
//
//   #loc=21.0285,105.8542&n=Hanoi&cc=VN&tz=Asia/Ho_Chi_Minh&el=15&t=2027-08-02T10:07:00Z&r=3600&p=1
//    &view=orbit&lock=1&sel=moon&ly=bgoscCnmkazhldxwi&q=auto&sky=auto&cam=o:21.0,105.8,3.2|s:142.3,25.0,60&intro=0&debug=1
//
// `sky` is the Sky darkness setting: auto (light pollution estimated from nearby cities), pristine,
// or a Bortle class 1–9. `au` is the Aurora activity setting: quiet, typical (default) or storm.
// `trk` is sky-view tracking: b (the selected body) or s (the stars); absent = none. `vt` is a
// vantage point of the globe view: l1 (the sunlit Earth from L1) or moon (Earthrise from lunar
// orbit); it implies the globe view, and its `cam` is the orbit pose it returns to. A sky `cam`
// keeps its field to 0.2° (the telescope zoom) with three significant digits. An orbit `cam` past
// 150 Earth radii is the solar-system zoom (camera/rig.js; up to 80 AU, ≈ 1.88 million R, written
// in whole radii from 1000 R). `tour` starts a
// guided tour (core/tour-catalog.js) once the app is ready; it is read, never written back.
// `view=map` is the flat world map (the globe unrolled); its `cam` is `m:lat,lon,dist` (the map's
// centre and the camera's distance from the plane). `loc2` (with `n2`, `tz2`) is a second place to
// compare with (two-observers): its own pin and dashed beams on the globe, side by side in Sky now.
// `host=mars` stands on Mars (stand-on-mars: the sky view from an areographic site); `hloc` is that
// site, planetocentric °N,°E, written only when it is not Jezero Crater (the default). `tab` opens a
// panel tab (store PANELS, e.g. the install shortcut's `tab=events`, or an old tab's id from
// PANEL_ALIASES: `settings` and `about` also give `reveal`, the section to open); like `tour`, it is
// read, never written. `lang` (en, vi: core/i18n.js LOCALES) picks the interface's language for
// this visit without saving it (Display's Language saves a choice); like `debug=1`, the address bar
// keeps it.
//
// parseHash never throws: values are validated, clamped (time, elevation, camera) or dropped, and
// every key that was present but not usable as written is listed in `invalid` (for the
// "Some link settings were invalid." toast). Unknown keys are ignored; the first occurrence of a
// repeated key wins. serializeHash writes defaults implicitly (absent key = default), so links stay
// short; `t` is omitted while Live.

import { MIN_MS, MAX_MS, snapRate } from './clock.js';
import { DEFAULT_STATE, SKY_DARK_SETTINGS, AURORA_SETTINGS, VANTAGE_SETTINGS, VIEW_MODES, HOST_DEFAULT, PANELS, PANEL_ALIASES } from './store.js';
import { canonTz, daysInMonth } from './tz.js';
import { isTourId } from './tour-catalog.js';
import { normalizeSelectionId, isSelectionId } from './selection.js';
import { LOCALES } from './i18n.js';

const QUALITY_SETTINGS = Object.freeze(['auto', 'low', 'medium', 'high', 'max']);
/** `ly` letters in canonical order (SPEC §F.4). Case-sensitive: c = lines, C = names. */
export const LAYER_CODES = Object.freeze([
    ['b', 'beams'], ['g', 'ghostBeams'], ['o', 'sunMoonBeams'], ['s', 'stars'], ['c', 'constellations'],
    ['C', 'constellationNames'], ['n', 'starNames'], ['m', 'milkyWay'], ['k', 'clouds'], ['a', 'atmosphere'],
    ['e', 'ecliptic'], ['q', 'eqGrid'], ['z', 'altAzGrid'], ['h', 'horizon'], ['f', 'footprint'],
    ['p', 'subpoints'], ['t', 'trails'], ['l', 'labels'], ['d', 'landscape'], ['v', 'spacecraft'], ['x', 'deepSky'],
    ['r', 'precession'], ['y', 'sunPath'], ['w', 'meteors'], ['i', 'satellites'],
].map((pair) => Object.freeze(pair)));
const LAYER_BY_CODE = new Map(LAYER_CODES);
const KNOWN_KEYS = new Set(['loc', 'n', 'cc', 'tz', 'el', 't', 'r', 'p', 'view', 'lock', 'sel', 'ly', 'q', 'sky', 'au', 'cam', 'trk', 'vt', 'intro', 'debug', 'tour', 'tab',
    'loc2', 'n2', 'tz2', 'host', 'hloc', 'lang']);
const MAX_HASH_LEN = 4096;
const NAME_MAX = 80;
const ELEV_MIN = -500, ELEV_MAX = 9000;
// distMax: the solar-system zoom's 80 AU (astro/orrery.js SYSTEM_MAX_R ≈ 1.876e6 R) rounded up; the rig clamps.
const CAM = Object.freeze({ distMin: 1.08, distMax: 2e6, altMin: -10, altMax: 89, fovMin: 0.2, fovMax: 100, mapMin: 0.05, mapMax: 20 });
const TRACK_CODES = Object.freeze({ b: 'body', s: 'stars' });
// Unambiguous (the dot must be present to reach the fraction), so matching is linear even on
// pathological 4 KB digit runs.
const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/;
const ISO_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** The `ly` value for DEFAULT_STATE.layers ('bgoscCnmkazhldxwi'). */
export const DEFAULT_LAYER_CODE = layersToCode(DEFAULT_STATE.layers);

/** @param {string} s */
function strictNum(s) {
    const t = s.trim();
    return NUM_RE.test(t) ? Number(t) : Number.NaN;
}

/** @param {string} s */
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    } catch {
        return null;
    }
}

/** Percent-encodes a value but keeps characters that are safe and readable in a fragment. */
function enc(s) {
    return encodeURIComponent(s).replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%2C/gi, ',').replace(/%40/gi, '@');
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Wraps a longitude into (−180, 180]. In-range values pass through untouched (no float noise). */
function wrapLon(lon) {
    if (lon > -180 && lon <= 180) return lon || 0;
    let x = ((((lon + 180) % 360) + 360) % 360) - 180;
    if (x === -180) x = 180;
    return x || 0;
}

/** Fixed decimals without trailing zeros or "-0": fmtNum(3.20, 2) → '3.2'. */
function fmtNum(x, digits) {
    const s = Number(x.toFixed(digits));
    return String(s === 0 ? 0 : s);
}

/** Display name from a link: control characters stripped, whitespace collapsed, length capped. */
function cleanName(s) {
    return String(s)
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ') // eslint-disable-line no-control-regex
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX);
}

/**
 * Layers object → `ly` code ('bgoscCnmkazhld'), or null when `layers` is not an object.
 * @param {Partial<import('./types.js').Layers>|null|undefined} layers
 * @returns {string|null}
 */
export function layersToCode(layers) {
    if (!layers || typeof layers !== 'object') return null;
    let out = '';
    for (const [code, key] of LAYER_CODES) if (layers[key]) out += code;
    return out;
}

/**
 * `ly` code → complete Layers object (every known layer present, true iff its letter is there).
 * Unknown letters are ignored; `{layers, unknown}` reports whether any were seen.
 * @param {string} code
 * @returns {{layers:import('./types.js').Layers, unknown:boolean}}
 */
export function codeToLayers(code) {
    /** @type {any} */
    const layers = {};
    for (const [, key] of LAYER_CODES) layers[key] = false;
    let unknown = false;
    for (const ch of String(code)) {
        const key = LAYER_BY_CODE.get(ch);
        if (key) layers[key] = true;
        else unknown = true;
    }
    return { layers, unknown };
}

/**
 * Parses a `t` value: ISO 8601 (date, optional time, optional Z or ±hh:mm; no zone = UTC),
 * epoch milliseconds (9+ digits) or 'now'. Returns ms, 'now', or NaN.
 * @param {string} v
 * @returns {number|'now'}
 */
function parseTime(v) {
    const s = v.trim();
    if (/^now$/i.test(s)) return 'now';
    if (/^-?\d{9,16}$/.test(s)) return Number(s);
    const m = ISO_RE.exec(s);
    if (!m) return Number.NaN;
    const y = Number(m[1]), mo = Number(m[2] ?? 1), d = Number(m[3] ?? 1);
    const h = Number(m[4] ?? 0), mi = Number(m[5] ?? 0), sec = Number(m[6] ?? 0);
    const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || sec > 59) return Number.NaN;
    let offMin = 0;
    const z = m[8];
    if (z && z.toUpperCase() !== 'Z') {
        const zm = /^([+-])(\d{2}):?(\d{2})?$/.exec(z);
        if (!zm) return Number.NaN;
        const oh = Number(zm[2]), om = Number(zm[3] ?? 0);
        if (oh > 14 || om > 59) return Number.NaN;
        offMin = (zm[1] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    // Date.UTC maps years 0..99 to 19xx; shift by one 400-year Gregorian cycle instead.
    const cycle = y < 100 ? 400 : 0;
    const ms = Date.UTC(y + cycle, mo - 1, d, h, mi, sec, Math.round(frac)) - cycle * 31556952e3;
    return ms - offMin * 6e4;
}

/** First value of an alias list on an object that is a finite number. */
function pick(o, names) {
    for (const k of names) {
        const v = o[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return Number.NaN;
}

/**
 * One `cam` part → CamView, clamped; null when malformed.
 * @param {string} part  'o:lat,lon,dist' | 's:az,alt,fov' | 'm:lat,lon,dist'
 * @returns {import('./types.js').CamView|null}
 */
function parseCamPart(part) {
    const m = /^\s*([osm])\s*:(.*)$/i.exec(part);
    if (!m) return null;
    const nums = m[2].split(',').map(strictNum);
    if (nums.length !== 3 || !nums.every(Number.isFinite)) return null;
    if (m[1].toLowerCase() === 'o') {
        return { mode: 'orbit', latDeg: clamp(nums[0], -90, 90), lonDeg: wrapLon(nums[1]), distance: clamp(nums[2], CAM.distMin, CAM.distMax) };
    }
    if (m[1].toLowerCase() === 'm') {
        return { mode: 'map', latDeg: clamp(nums[0], -90, 90), lonDeg: wrapLon(nums[1]), distance: clamp(nums[2], CAM.mapMin, CAM.mapMax) };
    }
    const az = ((nums[0] % 360) + 360) % 360;
    return { mode: 'sky', azDeg: az || 0, altDeg: clamp(nums[1], CAM.altMin, CAM.altMax), fovDeg: clamp(nums[2], CAM.fovMin, CAM.fovMax) };
}

/**
 * CamView (or `{orbit, sky}`, or an already-encoded string) → `cam` value, or '' if unusable.
 * Field aliases are accepted: lat/latDeg, lon/lonDeg, distance/dist, az/azDeg, alt/altDeg, fov/fovDeg;
 * the mode may be given as mode/kind/type = 'orbit'|'o'|'sky'|'s'.
 * @param {unknown} cam
 * @returns {string}
 */
export function camToCode(cam) {
    if (!cam) return '';
    if (typeof cam === 'string') {
        return cam.split('|').map(parseCamPart).filter(Boolean).map((c) => camToCode(c)).join('|');
    }
    if (typeof cam !== 'object') return '';
    /** @type {any} */
    const c = cam;
    if ((c.orbit || c.sky) && !c.mode && !c.kind && !c.type) {
        return [camToCode(c.orbit), camToCode(c.sky)].filter(Boolean).join('|');
    }
    const mode = String(c.mode ?? c.kind ?? c.type ?? '').toLowerCase();
    if (mode === 'orbit' || mode === 'o') {
        const lat = pick(c, ['latDeg', 'lat', 'subLatDeg', 'subLat']);
        const lon = pick(c, ['lonDeg', 'lon', 'subLonDeg', 'subLon']);
        const dist = pick(c, ['distance', 'dist', 'd', 'r']);
        if (![lat, lon, dist].every(Number.isFinite)) return '';
        const d = clamp(dist, CAM.distMin, CAM.distMax);
        return `o:${fmtNum(clamp(lat, -90, 90), 2)},${fmtNum(wrapLon(lon), 2)},${fmtNum(d, d >= 1000 ? 0 : 2)}`;
    }
    if (mode === 'map' || mode === 'm') {
        const lat = pick(c, ['latDeg', 'lat']);
        const lon = pick(c, ['lonDeg', 'lon']);
        const dist = pick(c, ['distance', 'dist', 'd']);
        if (![lat, lon, dist].every(Number.isFinite)) return '';
        return `m:${fmtNum(clamp(lat, -90, 90), 2)},${fmtNum(wrapLon(lon), 2)},${fmtNum(clamp(dist, CAM.mapMin, CAM.mapMax), 3)}`;
    }
    if (mode === 'sky' || mode === 's') {
        const az = pick(c, ['azDeg', 'az', 'yawDeg', 'yaw']);
        const alt = pick(c, ['altDeg', 'alt', 'pitchDeg', 'pitch']);
        const fov = pick(c, ['fovDeg', 'fov']);
        if (![az, alt, fov].every(Number.isFinite)) return '';
        const a = ((az % 360) + 360) % 360;
        const f = clamp(fov, CAM.fovMin, CAM.fovMax);
        return `s:${fmtNum(a, 2)},${fmtNum(clamp(alt, CAM.altMin, CAM.altMax), 2)},${fmtNum(f, f < 1 ? 3 : f < 10 ? 2 : 1)}`;
    }
    return '';
}

/** Splits a hash into decoded key → value (first occurrence wins). */
function readParams(hash, invalid) {
    let s = typeof hash === 'string' ? hash : '';
    const hashAt = s.indexOf('#');
    if (hashAt >= 0) s = s.slice(hashAt + 1);
    else if (s.startsWith('?')) s = s.slice(1);
    if (s.length > MAX_HASH_LEN) s = s.slice(0, MAX_HASH_LEN);
    /** @type {Map<string, string>} */
    const params = new Map();
    for (const part of s.split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
        if (key === null || params.has(key)) continue;
        let raw = eq < 0 ? '' : part.slice(eq + 1);
        // In names a literal '+' means a space (form encoding); an encoded %2B stays a plus. Never
        // in other keys: zone ids such as Etc/GMT+5 contain a real '+'.
        if (key === 'n' || key === 'n2') raw = raw.replace(/\+/g, ' ');
        const val = safeDecode(raw);
        if (val === null) {
            if (KNOWN_KEYS.has(key)) invalid.push(key);
            continue;
        }
        params.set(key, val);
    }
    return params;
}

/** loc + n/cc/tz/el → Observer-shaped object (source 'url'), or undefined. */
function parseObserver(params, invalid) {
    if (!params.has('loc')) return undefined;
    const parts = params.get('loc').split(',');
    const lat = parts.length === 2 ? strictNum(parts[0]) : Number.NaN;
    const lon = parts.length === 2 ? strictNum(parts[1]) : Number.NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
        invalid.push('loc');
        return undefined;
    }
    const name = params.has('n') ? cleanName(params.get('n')) : '';
    let cc = '';
    if (params.has('cc')) {
        const v = params.get('cc').trim();
        if (/^[A-Za-z]{2}$/.test(v)) cc = v.toUpperCase();
        else invalid.push('cc');
    }
    let tz = null;
    if (params.has('tz')) {
        const v = params.get('tz').trim();
        if (canonTz(v)) tz = v;
        else invalid.push('tz');
    }
    let elevM = 0;
    if (params.has('el')) {
        const v = strictNum(params.get('el'));
        if (Number.isFinite(v)) {
            elevM = clamp(v, ELEV_MIN, ELEV_MAX);
            if (elevM !== v) invalid.push('el');
        } else {
            invalid.push('el');
        }
    }
    return {
        latDeg: lat, lonDeg: wrapLon(lon), elevM, name, country: '', cc, tz,
        tzApprox: tz ? /^Etc\//i.test(tz) : false, source: 'url',
    };
}

/** loc2 + n2/tz2 → the second place (source 'url'), or undefined. */
function parseObserver2(params, invalid) {
    if (!params.has('loc2')) return undefined;
    const parts = params.get('loc2').split(',');
    const lat = parts.length === 2 ? strictNum(parts[0]) : Number.NaN;
    const lon = parts.length === 2 ? strictNum(parts[1]) : Number.NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
        invalid.push('loc2');
        return undefined;
    }
    let tz = null;
    if (params.has('tz2')) {
        const v = params.get('tz2').trim();
        if (canonTz(v)) tz = v;
        else invalid.push('tz2');
    }
    return {
        latDeg: lat, lonDeg: wrapLon(lon), elevM: 0, name: params.has('n2') ? cleanName(params.get('n2')) : '', country: '', cc: '', tz,
        tzApprox: tz ? /^Etc\//i.test(tz) : false, source: 'url',
    };
}

/** t / r / p → out.tMs, out.rate, out.playing, out.live. */
function parseTimeKeys(params, out, invalid) {
    let explicitNow = false;
    if (params.has('t')) {
        const t = parseTime(params.get('t'));
        if (t === 'now') {
            explicitNow = true;
        } else if (Number.isFinite(t)) {
            out.tMs = clamp(t, MIN_MS, MAX_MS);
            if (out.tMs !== t) invalid.push('t');
        } else {
            invalid.push('t');
        }
    }
    if (params.has('r')) {
        const r = snapRate(strictNum(params.get('r')));
        if (r === null) invalid.push('r');
        else out.rate = r;
    }
    if (params.has('p')) {
        const v = params.get('p').trim().toLowerCase();
        if (v === '1' || v === 'true') out.playing = true;
        else if (v === '0' || v === 'false') out.playing = false;
        else invalid.push('p');
    }
    if (out.tMs !== undefined) out.live = false;
    else if (explicitNow || out.rate !== undefined || out.playing !== undefined) {
        out.live = (out.rate ?? 1) === 1 && out.playing !== false;
    }
}

/** A '0'/'1' style flag; undefined when malformed. */
function parseFlag(v, emptyMeans) {
    const s = v.trim().toLowerCase();
    if (s === '') return emptyMeans;
    if (s === '1' || s === 'true' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'off') return false;
    return undefined;
}

/** view, lock, sel, ly, q, sky, au, cam, trk, vt, intro, debug, tour, tab, lang. */
function parseViewKeys(params, out, invalid) {
    if (params.has('view')) {
        const v = params.get('view').trim().toLowerCase();
        if (v === 'orbit' || v === 'globe') out.view = 'orbit';
        else if (v === 'sky' || v === 'map') out.view = v;
        else invalid.push('view');
    }
    if (params.has('lock')) {
        const f = parseFlag(params.get('lock'), undefined);
        if (f === undefined) invalid.push('lock');
        else out.earthLock = f;
    }
    if (params.has('sel')) {
        // A body, or an extra object's namespaced id (core/selection.js: comet:halley, craft:voyager1).
        const v = normalizeSelectionId(params.get('sel'));
        if (v === undefined) invalid.push('sel');
        else out.selection = /** @type {any} */ (v);
    }
    if (params.has('ly')) {
        const code = params.get('ly').trim();
        const { layers, unknown } = codeToLayers(code);
        // Known letters apply; a code with no known letter at all (not even empty) is dropped
        // rather than read as "every layer off".
        if (!unknown || Object.values(layers).some(Boolean)) out.layers = layers;
        if (unknown) invalid.push('ly');
    }
    if (params.has('q')) {
        const v = params.get('q').trim().toLowerCase();
        if (QUALITY_SETTINGS.includes(v)) out.quality = /** @type {any} */ (v);
        else invalid.push('q');
    }
    if (params.has('sky')) {
        const v = params.get('sky').trim().toLowerCase();
        if (SKY_DARK_SETTINGS.includes(v)) out.skyDark = v;
        else invalid.push('sky');
    }
    if (params.has('au')) {
        const v = params.get('au').trim().toLowerCase();
        if (AURORA_SETTINGS.includes(v)) out.aurora = v;
        else invalid.push('au');
    }
    if (params.has('cam')) {
        const views = params.get('cam').split('|').map(parseCamPart).filter(Boolean);
        if (!views.length) invalid.push('cam');
        else {
            // A single camera without `view=` names the view, so a hand-written link cannot put the
            // rig in one view while the store keeps another.
            if (out.view === undefined && views.length === 1) out.view = views[0].mode;
            out.cam = views.find((c) => c.mode === (out.view ?? 'orbit')) ?? views[0];
        }
    }
    if (params.has('trk')) {
        const v = params.get('trk').trim().toLowerCase();
        if (Object.hasOwn(TRACK_CODES, v)) out.track = TRACK_CODES[v];
        else if (v !== '' && v !== '0' && v !== 'none') invalid.push('trk');
    }
    if (params.has('vt')) {
        const v = params.get('vt').trim().toLowerCase();
        if (v !== 'none' && VANTAGE_SETTINGS.includes(v)) out.vantage = v;
        else if (v !== '' && v !== '0' && v !== 'none') invalid.push('vt');
    }
    if (params.has('host')) {
        const v = params.get('host').trim().toLowerCase();
        if (v === 'mars') {
            out.host = { id: 'mars', latDeg: HOST_DEFAULT.latDeg, lonDeg: HOST_DEFAULT.lonDeg };
            if (params.has('hloc')) {
                const [la, lo] = params.get('hloc').split(',').map(strictNum);
                if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90) {
                    out.host = { id: 'mars', latDeg: la, lonDeg: wrapLon(lo) };
                } else invalid.push('hloc');
            }
        } else if (v !== 'earth' && v !== '') invalid.push('host');
    }
    if (params.has('intro')) {
        const f = parseFlag(params.get('intro'), undefined);
        if (f === undefined) invalid.push('intro');
        else out.intro = f;
    }
    if (params.has('debug')) {
        const f = parseFlag(params.get('debug'), true);
        if (f === undefined) invalid.push('debug');
        else out.debug = f;
    }
    if (params.has('tour')) {
        const v = params.get('tour').trim().toLowerCase();
        if (isTourId(v)) out.tour = v;
        else if (v !== '') invalid.push('tour');
    }
    if (params.has('tab')) {
        const v = params.get('tab').trim().toLowerCase();
        const to = PANELS.includes(v) ? [v] : Object.hasOwn(PANEL_ALIASES, v) ? PANEL_ALIASES[v] : null;
        if (to) { out.panel = to[0]; if (to[1]) out.reveal = to[1]; } else if (v !== '') invalid.push('tab');
    }
    if (params.has('lang')) {
        const v = params.get('lang').trim().toLowerCase();
        if (Object.hasOwn(LOCALES, v)) out.lang = v;
        else if (v !== '') invalid.push('lang');
    }
}

/**
 * Parses a location hash ('#…', '…', or a whole URL). Never throws.
 * @param {unknown} hash
 * @returns {import('./types.js').HashState}
 */
export function parseHash(hash) {
    /** @type {any} */
    const out = {};
    /** @type {string[]} */
    const invalid = [];
    try {
        const params = readParams(typeof hash === 'string' ? hash : '', invalid);
        const observer = parseObserver(params, invalid);
        if (observer) out.observer = observer;
        const observer2 = parseObserver2(params, invalid);
        if (observer2) out.observer2 = observer2;
        parseTimeKeys(params, out, invalid);
        parseViewKeys(params, out, invalid);
    } catch {
        // Defensive: parsing is total, but a deep link must never be able to break boot.
    }
    if (invalid.length) out.invalid = [...new Set(invalid)];
    return out;
}

/** ms → '2027-08-02T10:07:00Z' (rounded to the second). */
function isoSeconds(ms) {
    return new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Builds the hash for the current state: `'#loc=…&…'` ('' when there is nothing to say).
 * Keys at their default are omitted; `t` only appears off-Live.
 * @param {{state?:Partial<import('./types.js').AppState>, clock?:{tMs:number, rate:number, playing:boolean, live:boolean}|null,
 *          cam?:unknown, extra?:{intro?:boolean, debug?:boolean, lang?:string}}} [args]
 * @returns {string}
 */
export function serializeHash({ state, clock, cam, extra } = {}) {
    const parts = [];
    try {
        const s = state ?? {};
        const o = s.observer;
        if (o && Number.isFinite(o.latDeg) && Number.isFinite(o.lonDeg) && Math.abs(o.latDeg) <= 90) {
            parts.push(`loc=${fmtNum(o.latDeg, 4)},${fmtNum(wrapLon(o.lonDeg), 4)}`);
            const name = typeof o.name === 'string' ? cleanName(o.name) : '';
            if (name) parts.push(`n=${enc(name)}`);
            const cc = /** @type {any} */ (o).cc;
            if (typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc)) parts.push(`cc=${cc.toUpperCase()}`);
            if (typeof o.tz === 'string' && canonTz(o.tz)) parts.push(`tz=${enc(o.tz.trim())}`);
            if (Number.isFinite(o.elevM) && Math.round(o.elevM) !== 0) parts.push(`el=${Math.round(clamp(o.elevM, ELEV_MIN, ELEV_MAX))}`);
        }
        const o2 = s.observer2;
        if (o2 && Number.isFinite(o2.latDeg) && Number.isFinite(o2.lonDeg) && Math.abs(o2.latDeg) <= 90) {
            parts.push(`loc2=${fmtNum(o2.latDeg, 4)},${fmtNum(wrapLon(o2.lonDeg), 4)}`);
            const name2 = typeof o2.name === 'string' ? cleanName(o2.name) : '';
            if (name2) parts.push(`n2=${enc(name2)}`);
            if (typeof o2.tz === 'string' && canonTz(o2.tz)) parts.push(`tz2=${enc(o2.tz.trim())}`);
        }
        if (clock) {
            if (!clock.live && Number.isFinite(clock.tMs)) parts.push(`t=${isoSeconds(clamp(clock.tMs, MIN_MS, MAX_MS))}`);
            const r = snapRate(clock.rate);
            if (r !== null && r !== 1) parts.push(`r=${r}`);
            if (clock.playing === false) parts.push('p=0');
        }
        if (s.view?.mode !== 'orbit' && VIEW_MODES.includes(s.view?.mode)) parts.push(`view=${s.view.mode}`);
        if (s.view?.earthLock === false) parts.push('lock=0');
        const trk = s.view?.track;
        if (trk === 'body' || trk === 'stars') parts.push(`trk=${trk[0]}`);
        const vt = s.view?.vantage;
        if (s.view?.mode === 'orbit' && vt !== 'none' && VANTAGE_SETTINGS.includes(vt)) parts.push(`vt=${vt}`);
        const h = s.host;
        if (h?.id === 'mars') {
            parts.push('host=mars');
            if (Number.isFinite(h.latDeg) && Number.isFinite(h.lonDeg) && Math.abs(h.latDeg) <= 90
                && (Math.abs(h.latDeg - HOST_DEFAULT.latDeg) > 5e-5 || Math.abs(wrapLon(h.lonDeg) - HOST_DEFAULT.lonDeg) > 5e-5)) {
                parts.push(`hloc=${fmtNum(h.latDeg, 4)},${fmtNum(wrapLon(h.lonDeg), 4)}`);
            }
        }
        if (isSelectionId(s.selection)) parts.push(`sel=${s.selection}`);
        const ly = layersToCode(s.layers);
        if (ly !== null && ly !== DEFAULT_LAYER_CODE) parts.push(`ly=${ly}`);
        const q = s.quality?.setting;
        if (typeof q === 'string' && q !== 'auto' && QUALITY_SETTINGS.includes(q)) parts.push(`q=${q}`);
        const sky = s.display?.skyDark;
        if (typeof sky === 'string' && sky !== 'auto' && SKY_DARK_SETTINGS.includes(sky)) parts.push(`sky=${sky}`);
        const au = s.display?.aurora;
        if (typeof au === 'string' && au !== 'typical' && AURORA_SETTINGS.includes(au)) parts.push(`au=${au}`);
        const c = camToCode(cam);
        if (c) parts.push(`cam=${c}`);
        if (extra?.intro === false) parts.push('intro=0');
        if (extra?.debug) parts.push('debug=1');
        if (extra?.lang && Object.hasOwn(LOCALES, extra.lang)) parts.push(`lang=${extra.lang}`);
    } catch {
        // Serialisation is best-effort; whatever was built so far is still a valid link.
    }
    return parts.length ? `#${parts.join('&')}` : '';
}

/** @param {any} loc */
function readLocationHash(loc) {
    try {
        return String(loc.hash ?? '');
    } catch {
        return '';
    }
}

/**
 * Keeps the URL hash in sync with the app (history.replaceState, at most once per 500 ms).
 *
 * Writes when the observer, selection, view, layers, quality setting or clock changes, and polls
 * once a second for continuous changes (camera via getCam, running time). Nothing is written until
 * something differs from the state at bind time, so a fresh visit keeps a clean URL. `debug=1`
 * from the original link is preserved. When the user edits the hash by hand (hashchange),
 * `onExternalChange(parseHash(hash))` is called so the integrator can apply it.
 *
 * While `suspended()` is true (a guided tour plays) nothing is written; the first write after it
 * compares against the address bar itself, so a `tour=` link is replaced by the restored state.
 *
 * @param {{win?:any, store?:import('./types.js').Store, clock?:any, getCam?:()=>unknown,
 *          onExternalChange?:(parsed:import('./types.js').HashState)=>void, minIntervalMs?:number, pollMs?:number,
 *          suspended?:()=>boolean}} deps
 *   `win` is the browser global object (needs history, location and addEventListener).
 * @returns {()=>void} unbind
 */
export function bindUrl({ win, store, clock, getCam, onExternalChange, minIntervalMs = 500, pollMs = 1000, suspended } = {}) {
    const hist = win?.history;
    const loc = win?.location;
    if (!hist || !loc || typeof hist.replaceState !== 'function') return () => {};

    const extra = {};
    const launch = parseHash(readLocationHash(loc));
    if (launch.debug) extra.debug = true;
    if (launch.lang) extra.lang = launch.lang;
    const readCam = () => {
        try {
            return typeof getCam === 'function' ? getCam() : null;
        } catch {
            return null;
        }
    };
    const build = () => serializeHash({ state: store?.get?.(), clock, cam: readCam(), extra });

    let last = build();
    let lastWriteAt = -Infinity;
    /** @type {any} */
    let timer = null;
    let disposed = false;
    let held = false;
    const isSuspended = () => {
        try {
            return typeof suspended === 'function' && !!suspended();
        } catch {
            return false;
        }
    };

    function write() {
        timer = null;
        if (disposed) return;
        if (isSuspended()) {
            held = true;
            return;
        }
        if (held) {
            // Resuming: whatever the address bar shows now (a tour link, say) is what to replace.
            held = false;
            last = readLocationHash(loc);
        }
        const next = build();
        if (next === last) return;
        let url = next;
        if (!url) {
            try {
                url = `${loc.pathname ?? ''}${loc.search ?? ''}`;
            } catch {
                url = '#';
            }
        }
        try {
            hist.replaceState(hist.state ?? null, '', url);
            last = next;
            lastWriteAt = Date.now();
        } catch {
            // Browsers rate-limit history updates (SecurityError); the next change or poll retries.
        }
    }

    function schedule() {
        if (disposed || timer !== null) return;
        const wait = Math.max(0, minIntervalMs - (Date.now() - lastWriteAt));
        timer = setTimeout(write, wait);
    }

    const offs = [];
    if (store?.subscribe) {
        for (const sel of [(s) => s.observer, (s) => s.observer2, (s) => s.host, (s) => s.selection, (s) => s.view, (s) => s.layers, (s) => s.quality?.setting,
            (s) => s.display?.skyDark, (s) => s.display?.aurora]) {
            offs.push(store.subscribe(sel, schedule));
        }
    }
    if (typeof clock?.onChange === 'function') offs.push(clock.onChange(schedule));
    const poll = setInterval(schedule, Math.max(minIntervalMs, pollMs));

    const onHashChange = () => {
        if (disposed) return;
        const h = readLocationHash(loc);
        if (h === last) return;
        last = h;
        const parsed = parseHash(h);
        // The address bar's language from now on: a later write must not put the old one back.
        if (parsed.lang) extra.lang = parsed.lang;
        else delete extra.lang;
        if (typeof onExternalChange !== 'function') return;
        try {
            onExternalChange(parsed);
        } catch (err) {
            console.error('[url-state] onExternalChange failed:', err);
        }
    };
    if (typeof win.addEventListener === 'function') win.addEventListener('hashchange', onHashChange);

    return () => {
        if (disposed) return;
        disposed = true;
        if (timer !== null) clearTimeout(timer);
        clearInterval(poll);
        for (const off of offs) {
            try {
                off();
            } catch {
                // Unsubscribe failures are irrelevant once unbound.
            }
        }
        if (typeof win.removeEventListener === 'function') win.removeEventListener('hashchange', onHashChange);
    };
}
