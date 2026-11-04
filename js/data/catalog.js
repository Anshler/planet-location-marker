// Star / constellation catalog decoder (pure: no three.js, no DOM — SPEC R1).
//
// Turns the compact integer document data/sky.json (built by scripts/build-sky.mjs) into
// GPU-ready typed arrays in the SCENE frame (+Y = J2000 north pole, see SPEC §D):
//   stars.dirS / color are interleaved xyz / rgb Float32Arrays, sorted brightest first, so
//   a quality tier with a fainter magnitude limit is just a prefix (see starCountForMag).
//   cons.segments holds 2 unit vectors per line segment (6 floats), ready for LineSegments.

import { raDecToScene } from '../astro/frames.js';
import { bvToRgb } from '../astro/photometry.js';

/** Faintest magnitude decoded by default (the whole d3-celestial 6.0 catalog fits). */
export const DEFAULT_MAG_LIMIT = 6.5;

/** B−V used when a star has no colour index (≈ a G star, near white). */
const FALLBACK_BV = 0.6;

/**
 * @typedef {{count:number, dirS:Float32Array, mag:Float32Array, color:Float32Array, hip:Int32Array, bv:Float32Array,
 *   plx?:Float32Array|null, baseCount?:number, pm?:ProperMotions|null}} StarArrays
 *   dirS: 3·count unit vectors (scene frame) · mag: visual magnitude · color: 3·count linear RGB,
 *   max component 1 · hip: Hipparcos number · bv: B−V. Sorted by magnitude, brightest first.
 *   After mergeDeepStars (the max tier): the base catalogue's `baseCount` stars come first, then the
 *   deeper ones, and `plx` holds the deep stars' parallaxes (mas; NaN for the base stars, whose
 *   parallaxes are in data/starinfo.json).
 */
/**
 * The fast movers (sky.json `pm`): `idx` star indices; `base` their J2000 directions and `vel` their
 * tangential velocity in the scene frame (rad/yr, 3 per star); `seg` [float offset into
 * cons.segments, slot] pairs of constellation endpoints that sit on a mover; `names` [starNames
 * index, slot] pairs; `years` the epoch currently applied (years from J2000.0).
 * @typedef {{idx:Int32Array, base:Float32Array, vel:Float32Array, seg:Int32Array, names:Int32Array, years:number}} ProperMotions
 */
/** @typedef {{name:string, hip:number, con:string, dirS:number[], mag:number}} StarName */
/**
 * @typedef {{id:string, iau:string, name:string, rank:number, labelDirS:number[], segStart:number, segCount:number}} ConstellationInfo
 *   id: unique key ('Ori'; Serpens is split into 'Ser1' Caput / 'Ser2' Cauda) · iau: IAU code as
 *   returned by astronomy-engine's Constellation() ('Ser' for both halves) · rank: 1 (prominent)
 *   … 3 (faint) · segStart/segCount: this figure's range in cons.segments / segCon.
 */
/** @typedef {{segments:Float32Array, segCon:Uint16Array, list:ConstellationInfo[]}} Constellations */
/**
 * `srcHip`: sky.json's own star order (HIP per raw index; data/starinfo.json is aligned to it).
 * @typedef {{stars:StarArrays, starNames:StarName[], cons:Constellations, magLimit:number, srcHip?:number[]}} SkyCatalog
 */

/**
 * A valid catalog with nothing in it — what render modules get before sky.json arrives.
 * @returns {SkyCatalog}
 */
export function emptyCatalog() {
    return {
        stars: { count: 0, dirS: new Float32Array(0), mag: new Float32Array(0), color: new Float32Array(0), hip: new Int32Array(0), bv: new Float32Array(0), pm: null },
        starNames: [],
        cons: { segments: new Float32Array(0), segCon: new Uint16Array(0), list: [] },
        magLimit: DEFAULT_MAG_LIMIT,
        srcHip: [],
    };
}

function assertSky(json) {
    const s = json?.stars;
    const ok = json?.v === 1 && s && Number.isInteger(s.n)
        && ['hip', 'ra', 'dec', 'mag', 'bv'].every((k) => Array.isArray(s[k]) && s[k].length === s.n);
    if (!ok) throw new TypeError('decodeSky: not a v1 sky.json document');
}

// Scratch vector for raDecToScene (frames.js works in Float64Array(3), SPEC R7) and scratch
// colour for bvToRgb (which accepts an optional `out`).
const tmp = new Float64Array(3);
const rgbTmp = [0, 0, 0];

/** Scene-frame unit vector for RA/Dec in degrees, as [x, y, z] (fresh array). */
function dirArray(raDeg, decDeg) {
    const v = raDecToScene(raDeg, decDeg, tmp) || tmp;
    return [v[0], v[1], v[2]];
}

/** Indices of the stars to keep (mag ≤ limit), ordered brightest first. */
function selectStars(stars, magLimit) {
    const keep = [];
    let sorted = true;
    for (let i = 0; i < stars.n; i++) {
        const m = stars.mag[i] / 100;
        if (!(m <= magLimit)) continue;   // written this way so NaN magnitudes are dropped too
        if (keep.length && m < stars.mag[keep.at(-1)] / 100) sorted = false;
        keep.push(i);
    }
    // build-sky.mjs emits sorted data; tolerate hand-edited files anyway (stable sort).
    if (!sorted) keep.sort((a, b) => stars.mag[a] - stars.mag[b] || a - b);
    return keep;
}

function decodeStars(src, magLimit) {
    const keep = selectStars(src, magLimit);
    const n = keep.length;
    const out = {
        count: n,
        dirS: new Float32Array(3 * n),
        mag: new Float32Array(n),
        color: new Float32Array(3 * n),
        hip: new Int32Array(n),
        bv: new Float32Array(n),
        pm: null,
    };
    const newIndex = new Map();
    for (let j = 0; j < n; j++) {
        const i = keep[j];
        newIndex.set(i, j);
        const v = raDecToScene(src.ra[i] / 1000, src.dec[i] / 1000, tmp) || tmp;
        out.dirS[3 * j] = v[0];
        out.dirS[3 * j + 1] = v[1];
        out.dirS[3 * j + 2] = v[2];
        out.mag[j] = src.mag[i] / 100;
        const bv = Number.isFinite(src.bv[i]) ? src.bv[i] / 1000 : FALLBACK_BV;
        out.bv[j] = bv;
        const rgb = bvToRgb(bv, rgbTmp) || rgbTmp;
        // Renormalise so the brightest channel is exactly 1 (a LUT-interpolated fit can
        // dip a fraction of a percent below it near the blue/red crossover).
        const peak = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
        out.color[3 * j] = rgb[0] / peak;
        out.color[3 * j + 1] = rgb[1] / peak;
        out.color[3 * j + 2] = rgb[2] / peak;
        out.hip[j] = src.hip[i];
    }
    return { stars: out, newIndex };
}

function decodeNames(names, src, stars, newIndex) {
    if (!Array.isArray(names)) return [];
    let byHip = null;   // built lazily, only if a starIndex turns out stale
    const result = [];
    for (const entry of names) {
        if (!Array.isArray(entry) || entry.length < 3) continue;
        const [hip, name, con = '', starIndex] = entry;
        let i = Number.isInteger(starIndex) && src.hip[starIndex] === hip ? starIndex : -1;
        if (i < 0) {
            byHip ??= new Map(src.hip.map((h, k) => [h, k]));
            i = byHip.get(hip) ?? -1;
        }
        const j = newIndex.get(i);
        if (j === undefined) continue;   // fainter than magLimit (or unknown)
        result.push({
            name: String(name),
            hip,
            con: String(con),
            dirS: [stars.dirS[3 * j], stars.dirS[3 * j + 1], stars.dirS[3 * j + 2]],
            mag: src.mag[i] / 100,   // exact decimal (the Float32 copy would print as 1.9700000286)
        });
    }
    return result;
}

function decodeCons(cons) {
    const valid = Array.isArray(cons) ? cons.filter((c) => c && typeof c.id === 'string') : [];
    let segTotal = 0;
    for (const c of valid) {
        for (const line of c.lines ?? []) segTotal += Math.max(0, (line.length >> 1) - 1);
    }
    const segments = new Float32Array(6 * segTotal);
    const segCon = new Uint16Array(segTotal);
    const list = [];
    let s = 0;
    valid.forEach((c, k) => {
        const segStart = s;
        for (const line of c.lines ?? []) {
            for (let p = 0; p + 3 < line.length; p += 2) {
                const a = raDecToScene(line[p] / 100, line[p + 1] / 100, tmp) || tmp;
                segments[6 * s] = a[0];
                segments[6 * s + 1] = a[1];
                segments[6 * s + 2] = a[2];
                const b = raDecToScene(line[p + 2] / 100, line[p + 3] / 100, tmp) || tmp;
                segments[6 * s + 3] = b[0];
                segments[6 * s + 4] = b[1];
                segments[6 * s + 5] = b[2];
                segCon[s] = k;
                s++;
            }
        }
        const label = Array.isArray(c.label) && c.label.length >= 2 ? c.label : null;
        list.push({
            id: c.id,
            iau: c.id.replace(/\d+$/, ''),
            name: String(c.name ?? c.id),
            rank: Number.isFinite(c.rank) ? c.rank : 3,
            labelDirS: label ? dirArray(label[0] / 100, label[1] / 100) : figureCentroid(segments, segStart, s),
            segStart,
            segCount: s - segStart,
        });
    });
    return { segments, segCon, list };
}

/** Normalised mean of a figure's segment endpoints (label fallback when none is given). */
function figureCentroid(segments, from, to) {
    let x = 0, y = 0, z = 0;
    for (let i = 6 * from; i < 6 * to; i += 3) {
        x += segments[i];
        y += segments[i + 1];
        z += segments[i + 2];
    }
    const len = Math.hypot(x, y, z);
    return len > 0 ? [x / len, y / len, z / len] : [1, 0, 0];
}

/**
 * Decodes data/sky.json into scene-frame typed arrays.
 *
 * Stars fainter than `magLimit` are dropped (as are names of dropped stars). The result is
 * sorted brightest first. Throws a TypeError if `json` is not a v1 sky document.
 *
 * @param {object|string} json parsed sky.json (or its text)
 * @param {{magLimit?:number}} [opts]
 * @returns {SkyCatalog}
 */
export function decodeSky(json, { magLimit = DEFAULT_MAG_LIMIT } = {}) {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    assertSky(doc);
    const { stars, newIndex } = decodeStars(doc.stars, magLimit);
    const starNames = decodeNames(doc.names, doc.stars, stars, newIndex);
    const cons = decodeCons(doc.cons);
    stars.pm = decodePm(doc.pm, stars, newIndex, starNames, cons);
    return { stars, starNames, cons, magLimit, srcHip: doc.stars.hip };
}

// ---------------------------------------------------------------------------------------------
// Proper motion (time-machine sky)
// ---------------------------------------------------------------------------------------------

const MAS_RAD = Math.PI / (180 * 3600 * 1000);
/** A constellation endpoint this close to a moving star (cos of 0.03°) is snapped to it. */
const LINK_COS = Math.cos(0.03 * Math.PI / 180);
/** Julian year, ms. */
const YEAR_MS = 365.25 * 86400000;
/** J2000.0 (2000-01-01T12:00 TT ≈ UTC), ms. */
const J2000_MS = Date.UTC(2000, 0, 1, 12);

/**
 * Years from J2000.0 at `tMs` (UTC ms; Julian years).
 * @param {number} tMs
 * @returns {number}
 */
export function yearsFromJ2000(tMs) {
    return (tMs - J2000_MS) / YEAR_MS;
}

/**
 * Decodes sky.json `pm` ({i, ra, de}: raw star index, μα·cos δ and μδ in mas/yr) into scene-frame
 * velocities, and links the constellation endpoints and star names that sit on those stars.
 * @returns {ProperMotions|null}
 */
function decodePm(pm, stars, newIndex, starNames, cons) {
    if (!pm || !Array.isArray(pm.i) || !Array.isArray(pm.ra) || !Array.isArray(pm.de)) return null;
    const slots = [];
    for (let k = 0; k < pm.i.length; k++) {
        const j = newIndex.get(pm.i[k]);
        if (j !== undefined && Number.isFinite(pm.ra[k]) && Number.isFinite(pm.de[k])) slots.push([j, pm.ra[k], pm.de[k]]);
    }
    const n = slots.length;
    const idx = new Int32Array(n), base = new Float32Array(3 * n), vel = new Float32Array(3 * n);
    const bySlotHip = new Map();
    slots.forEach(([j, mra, mde], s) => {
        idx[s] = j;
        const x = stars.dirS[3 * j], y = stars.dirS[3 * j + 1], z = stars.dirS[3 * j + 2];
        base[3 * s] = x; base[3 * s + 1] = y; base[3 * s + 2] = z;
        // Scene (x, y, z) = EQJ (x, z, −y): α from (x, −z), δ from y. Unit vectors of increasing α and δ.
        const ra = Math.atan2(-z, x), dec = Math.asin(Math.max(-1, Math.min(1, y)));
        const ca = Math.cos(ra), sa = Math.sin(ra), cd = Math.cos(dec), sd = Math.sin(dec);
        const ea = [-sa, 0, -ca];                    // EQJ (−sin α, cos α, 0) in scene axes
        const ed = [-sd * ca, cd, sd * sa];          // EQJ (−sin δ cos α, −sin δ sin α, cos δ)
        const a = mra * MAS_RAD, d = mde * MAS_RAD;
        for (let c = 0; c < 3; c++) vel[3 * s + c] = a * ea[c] + d * ed[c];
        bySlotHip.set(stars.hip[j], s);
    });
    // Constellation endpoints on a moving star (the lines file's own J2000 RA/Dec, to 0.01°).
    const seg = [];
    const P = cons.segments;
    for (let o = 0; o + 2 < P.length; o += 3) {
        for (let s = 0; s < n; s++) {
            const dot = P[o] * base[3 * s] + P[o + 1] * base[3 * s + 1] + P[o + 2] * base[3 * s + 2];
            if (dot > LINK_COS) { seg.push(o, s); break; }
        }
    }
    const names = [];
    starNames.forEach((nm, k) => {
        const s = bySlotHip.get(nm.hip);
        if (s !== undefined) names.push(k, s);
    });
    return { idx, base, vel, seg: Int32Array.from(seg), names: Int32Array.from(names), years: 0 };
}

/**
 * Moves the fast stars to their place `years` from J2000.0 (linear proper motion in the tangent
 * plane, renormalised; no radial-velocity foreshortening), in place: the catalogue's directions,
 * the constellation endpoints on those stars and the star names' label directions. No allocation.
 * @param {SkyCatalog} catalog
 * @param {number} years years from J2000.0
 * @returns {boolean} whether anything moved
 */
export function applyProperMotion(catalog, years) {
    const pm = catalog?.stars?.pm;
    if (!pm || !Number.isFinite(years) || pm.years === years) return false;
    pm.years = years;
    const D = catalog.stars.dirS, P = catalog.cons.segments, N = catalog.starNames;
    const { idx, base, vel } = pm;
    for (let s = 0; s < idx.length; s++) {
        const x = base[3 * s] + vel[3 * s] * years;
        const y = base[3 * s + 1] + vel[3 * s + 1] * years;
        const z = base[3 * s + 2] + vel[3 * s + 2] * years;
        const l = Math.hypot(x, y, z) || 1;
        const j = 3 * idx[s];
        D[j] = x / l; D[j + 1] = y / l; D[j + 2] = z / l;
    }
    for (let k = 0; k < pm.seg.length; k += 2) {
        const o = pm.seg[k], j = 3 * idx[pm.seg[k + 1]];
        P[o] = D[j]; P[o + 1] = D[j + 1]; P[o + 2] = D[j + 2];
    }
    for (let k = 0; k < pm.names.length; k += 2) {
        const d = N[pm.names[k]].dirS, j = 3 * idx[pm.names[k + 1]];
        d[0] = D[j]; d[1] = D[j + 1]; d[2] = D[j + 2];
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Deeper stars (the max tier)
// ---------------------------------------------------------------------------------------------

/**
 * Appends data/stars8.json (scripts/build-stars.mjs: V 6.01–8.00, brightest first) to a decoded
 * catalogue, returning a new catalogue whose first `baseCount` stars are the original ones (same
 * indices, so proper motions and names keep pointing at them; the arrays are new).
 * @param {SkyCatalog} catalog
 * @param {object} json parsed data/stars8.json
 * @returns {SkyCatalog}
 */
export function mergeDeepStars(catalog, json) {
    const d = json;
    const ok = d?.v === 1 && Number.isInteger(d.n) && ['hip', 'ra', 'dec', 'mag', 'bv', 'plx'].every((k) => Array.isArray(d[k]) && d[k].length === d.n);
    if (!ok) throw new TypeError('mergeDeepStars: not a v1 stars8.json document');
    const b = catalog.stars;
    const nb = b.baseCount ?? b.count;
    const n = nb + d.n;
    const out = {
        count: n, dirS: new Float32Array(3 * n), mag: new Float32Array(n), color: new Float32Array(3 * n),
        hip: new Int32Array(n), bv: new Float32Array(n), plx: new Float32Array(n).fill(Number.NaN), baseCount: nb,
        // Its own epoch bookkeeping (the arrays are shared): each catalogue's dirS moves separately.
        pm: b.pm ? { ...b.pm } : null,
    };
    out.dirS.set(b.dirS.subarray(0, 3 * nb));
    out.mag.set(b.mag.subarray(0, nb));
    out.color.set(b.color.subarray(0, 3 * nb));
    out.hip.set(b.hip.subarray(0, nb));
    if (b.bv) out.bv.set(b.bv.subarray(0, nb));
    for (let k = 0; k < d.n; k++) {
        const j = nb + k;
        const v = raDecToScene(d.ra[k] / 1000, d.dec[k] / 1000, tmp) || tmp;
        out.dirS[3 * j] = v[0]; out.dirS[3 * j + 1] = v[1]; out.dirS[3 * j + 2] = v[2];
        out.mag[j] = d.mag[k] / 100;
        const bv = Number.isFinite(d.bv[k]) ? d.bv[k] / 1000 : FALLBACK_BV;
        out.bv[j] = bv;
        const rgb = bvToRgb(bv, rgbTmp) || rgbTmp;
        const peak = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
        out.color[3 * j] = rgb[0] / peak; out.color[3 * j + 1] = rgb[1] / peak; out.color[3 * j + 2] = rgb[2] / peak;
        out.hip[j] = d.hip[k];
        out.plx[j] = d.plx[k] > 0 ? d.plx[k] / 10 : Number.NaN;
    }
    return { ...catalog, stars: out };
}

/**
 * Number of leading stars with magnitude ≤ `magLimit` — the draw range for a quality tier
 * (stars are sorted brightest first). Binary search; O(log n), no allocation.
 * @param {StarArrays} stars
 * @param {number} magLimit
 * @returns {number}
 */
export function starCountForMag(stars, magLimit) {
    let lo = 0, hi = stars.count;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (stars.mag[mid] <= magLimit) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Index of a star by Hipparcos number, or −1.
 * @param {StarArrays} stars
 * @param {number} hip
 * @returns {number}
 */
export function starIndexByHip(stars, hip) {
    return stars.hip.indexOf(hip);
}
