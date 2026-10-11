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
 * @typedef {{count:number, dirS:Float32Array, mag:Float32Array, color:Float32Array, hip:Int32Array}} StarArrays
 *   dirS: 3·count unit vectors (scene frame) · mag: visual magnitude · color: 3·count linear RGB,
 *   max component 1 · hip: Hipparcos number. Sorted by magnitude, brightest first.
 */
/** @typedef {{name:string, hip:number, con:string, dirS:number[], mag:number}} StarName */
/**
 * @typedef {{id:string, iau:string, name:string, rank:number, labelDirS:number[], segStart:number, segCount:number}} ConstellationInfo
 *   id: unique key ('Ori'; Serpens is split into 'Ser1' Caput / 'Ser2' Cauda) · iau: IAU code as
 *   returned by astronomy-engine's Constellation() ('Ser' for both halves) · rank: 1 (prominent)
 *   … 3 (faint) · segStart/segCount: this figure's range in cons.segments / segCon.
 */
/** @typedef {{segments:Float32Array, segCon:Uint16Array, list:ConstellationInfo[]}} Constellations */
/** @typedef {{stars:StarArrays, starNames:StarName[], cons:Constellations, magLimit:number}} SkyCatalog */

/**
 * A valid catalog with nothing in it — what render modules get before sky.json arrives.
 * @returns {SkyCatalog}
 */
export function emptyCatalog() {
    return {
        stars: { count: 0, dirS: new Float32Array(0), mag: new Float32Array(0), color: new Float32Array(0), hip: new Int32Array(0) },
        starNames: [],
        cons: { segments: new Float32Array(0), segCon: new Uint16Array(0), list: [] },
        magLimit: DEFAULT_MAG_LIMIT,
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
    return {
        stars,
        starNames: decodeNames(doc.names, doc.stars, stars, newIndex),
        cons: decodeCons(doc.cons),
        magLimit,
    };
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
