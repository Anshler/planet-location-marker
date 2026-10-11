#!/usr/bin/env node
// Rasterises the d3-celestial Milky Way outlines (data/raw/mw.json) into data/milkyway.png.
//
//   node scripts/build-milkyway.mjs [--check]
//
// Output (SPEC §G): 2048×1024 8-bit greyscale, equirectangular in J2000 RA/Dec:
//   column x ↔ RA  = 360·(x + 0.5)/2048        (RA increases to the right)
//   row    y ↔ Dec = 90 − 180·(y + 0.5)/1024   (north at the top)
// which is exactly what `sceneDirToRaDecUv` samples with three's default flipY.
//
// The five contour levels ol1..ol5 are isophotes of increasing surface brightness. Filling
// them and summing (the first version) gives flat terraces with polygon edges, which read as
// blotches once the sky view zooms in. Instead every pixel gets a continuous "level" L:
//
//   * between isophote k and k+1:  L = k + a / (a + b), where a is the distance to contour k
//     (behind the pixel) and b the distance to contour k+1 (ahead of it), so brightness
//     ramps smoothly from one isophote to the next and the contours become level lines;
//   * outside ol1:                 L = (1 − d/OUTER_FADE_DEG)², a soft outer edge;
//   * inside ol5:                  L = 5 + a / (a + CORE_RISE_DEG), still rising toward the
//     middle of the brightest star clouds.
//
// Distances come from exact Euclidean distance transforms (Felzenszwalb–Huttenlocher) of the
// level masks, in degrees on the sky: rows are 180/H° apart and columns 360/W°·cos δ, and RA
// wraps. A Gaussian blur (σ = 2.5 px ≈ 0.44°, wrapping in RA) removes the remaining kinks, and
// the result is stored as v = L / L_MAX. The shader maps v to brightness (a power curve), so
// the 8-bit code values are spent evenly across the faint and the bright parts of the band.
//
// Ring handling:
//   * d3 longitudes are RA in −180..180; rings are unwrapped wherever |ΔRA| > 180° and
//     every ring is filled at −360°, 0° and +360° offsets so seam-crossing rings are whole.
//   * The faint outer level (ol1) is a band around the whole sky: its two edge rings each
//     wind once around a celestial pole (net ΔRA = ±360°) and are not closed in the plane.
//     Both are closed through the SOUTH pole; under even-odd the two "south of edge"
//     regions cancel outside the band, leaving exactly the band.
//
// --check rebuilds in memory and exits 1 if data/milkyway.png differs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'raw', 'mw.json');
const OUT = path.join(ROOT, 'data', 'milkyway.png');

export const W = 2048;
export const H = 1024;
/** Number of isophote levels in mw.json (ol1..ol5). */
export const LEVELS = 5;
/** Level value stored as 255. */
export const L_MAX = LEVELS + 0.6;
const PX_DEG = 180 / H;             // row spacing (and column spacing at the equator), degrees
const OUTER_FADE_DEG = 4;           // below ol1 the glow fades to zero over this distance
const CORE_RISE_DEG = 1.5;          // inside ol5, half of the extra rise is reached this deep
const SUBROWS = 4;                  // vertical supersampling; horizontal coverage is exact per span
const SIGMA_PX = 2.5;               // final smoothing of distance-field kinks
const BIG = 1e20;                   // "no feature" in the distance transforms

/** Wraps an RA difference into (−180, 180]. */
function wrapDelta(d) {
    if (d > 180) return d - 360;
    if (d <= -180) return d + 360;
    return d;
}

/**
 * Unwraps one GeoJSON ring into a closed polygon in (RA°, Dec°) space.
 * @param {number[][]} ring [[lon, lat], …] (first point repeated last, per GeoJSON)
 * @returns {{ra:Float64Array, dec:Float64Array, winding:number}} vertices (implicitly closed)
 */
export function unwrapRing(ring) {
    const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
        ? ring.slice(0, -1) : ring.slice();
    const ra = [], dec = [];
    let cur = ((pts[0][0] % 360) + 360) % 360;
    ra.push(cur); dec.push(pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
        cur += wrapDelta(pts[i][0] - pts[i - 1][0]);
        ra.push(cur); dec.push(pts[i][1]);
    }
    // Closing step back to the first vertex decides the winding around the pole.
    const closeTo = cur + wrapDelta(pts[0][0] - pts.at(-1)[0]);
    const winding = Math.round((closeTo - ra[0]) / 360);
    if (winding !== 0) {
        // Snap the end exactly onto the start meridian (± 360·winding) and close via the
        // south pole so the polygon is "everything south of this edge".
        const endRa = ra[0] + 360 * winding;
        ra.push(endRa, endRa, ra[0]);
        dec.push(pts[0][1], -90, -90);
    }
    return { ra: Float64Array.from(ra), dec: Float64Array.from(dec), winding };
}

/** Builds the edge list (a → b) of all rings of one level, with dec-sorted row buckets. */
function buildEdges(polys) {
    const ax = [], ay = [], bx = [], by = [];
    for (const poly of polys) {
        for (const ring of poly) {
            if (ring.length < 3) continue;
            const { ra, dec } = unwrapRing(ring);
            const n = ra.length;
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                if (dec[i] === dec[j]) continue;   // horizontal edges never cross a scanline
                ax.push(ra[i]); ay.push(dec[i]); bx.push(ra[j]); by.push(dec[j]);
            }
        }
    }
    // Bucket edges by the pixel rows they span so each scanline only tests nearby edges.
    const rows = Array.from({ length: H }, () => []);
    const rowOf = (d) => (90 - d) / 180 * H;   // continuous row coordinate
    for (let e = 0; e < ax.length; e++) {
        const r0 = Math.max(0, Math.floor(rowOf(Math.max(ay[e], by[e]))));
        const r1 = Math.min(H - 1, Math.floor(rowOf(Math.min(ay[e], by[e]))));
        for (let r = r0; r <= r1; r++) rows[r].push(e);
    }
    return { ax, ay, bx, by, rows };
}

/** Adds `amount` × the coverage of the span [u0, u1) (pixel units, clipped) into `row`. */
function addSpan(row, u0, u1, amount) {
    const a = Math.max(0, u0), b = Math.min(W, u1);
    if (b <= a) return;
    const ia = Math.floor(a), ib = Math.floor(b);
    if (ia === ib) { row[ia] += (b - a) * amount; return; }
    row[ia] += (ia + 1 - a) * amount;
    for (let x = ia + 1; x < ib; x++) row[x] += amount;
    if (ib < W) row[ib] += (b - ib) * amount;
}

/**
 * Even-odd fill of one contour level into `acc` (adds `weight` × coverage).
 * @param {number[][][]} polys MultiPolygon coordinates
 * @param {Float32Array} acc W×H accumulator
 * @param {number} weight
 */
export function fillLevel(polys, acc, weight) {
    const { ax, ay, bx, by, rows } = buildEdges(polys);
    const xs = [];
    const scale = W / 360;
    const sub = weight / SUBROWS;
    for (let y = 0; y < H; y++) {
        const bucket = rows[y];
        if (!bucket.length) continue;
        const row = acc.subarray(y * W, (y + 1) * W);
        for (let s = 0; s < SUBROWS; s++) {
            const d = 90 - 180 * (y + (s + 0.5) / SUBROWS) / H;
            xs.length = 0;
            for (const e of bucket) {
                const y0 = ay[e], y1 = by[e];
                if ((y0 > d) === (y1 > d)) continue;
                const x = ax[e] + (d - y0) * (bx[e] - ax[e]) / (y1 - y0);
                xs.push(x - 360, x, x + 360);
            }
            if (xs.length < 2) continue;
            xs.sort((p, q) => p - q);
            for (let k = 0; k + 1 < xs.length; k += 2) addSpan(row, xs[k] * scale, xs[k + 1] * scale, sub);
        }
    }
}

/**
 * 1-D squared distance transform (Felzenszwalb & Huttenlocher 2012):
 * d[q] = min_p a·(q − p)² + f[p] over p in [0, n).
 * @param {Float64Array} f samples (BIG where there is no feature)
 * @param {number} n
 * @param {number} a metric scale (> 0)
 * @param {Float64Array} d output
 * @param {Int32Array} v scratch, length ≥ n
 * @param {Float64Array} z scratch, length ≥ n + 1
 */
function dt1d(f, n, a, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
        const fq = f[q] + a * q * q;
        let p = v[k];
        let s = (fq - (f[p] + a * p * p)) / (2 * a * (q - p));
        while (s <= z[k]) {
            k--;
            p = v[k];
            s = (fq - (f[p] + a * p * p)) / (2 * a * (q - p));
        }
        k++;
        v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const p = v[k];
        d[q] = a * (q - p) * (q - p) + f[p];
    }
}

/**
 * Euclidean distance on the sky, in degrees, from every pixel to the nearest pixel where
 * `feature(i)` is true (0 on feature pixels). Columns are scaled by cos δ of the target row and
 * RA wraps; pixels with no feature anywhere get Infinity.
 * @param {(i:number) => boolean} feature
 * @returns {Float32Array} W×H
 */
export function distanceField(feature) {
    const g = new Float64Array(W * H);
    const n = Math.max(3 * W, H);
    const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
    const v = new Int32Array(n);
    // Pass 1: columns (Dec), in row units.
    for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) f[y] = feature(y * W + x) ? 0 : BIG;
        dt1d(f, H, 1, d, v, z);
        for (let y = 0; y < H; y++) g[y * W + x] = d[y];
    }
    // Pass 2: rows (RA), three periods so the transform wraps; keep the middle one.
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        const c = Math.cos((90 - (y + 0.5) * PX_DEG) * Math.PI / 180);
        const o = y * W;
        for (let i = 0; i < 3 * W; i++) f[i] = g[o + (i % W)];
        dt1d(f, 3 * W, c * c, d, v, z);
        for (let x = 0; x < W; x++) {
            const sq = d[W + x];
            out[o + x] = sq >= BIG / 2 ? Infinity : Math.sqrt(sq) * PX_DEG;
        }
    }
    return out;
}

/** Normalised 1-D Gaussian kernel with radius ⌈3σ⌉. */
function gaussianKernel(sigma) {
    const r = Math.ceil(3 * sigma);
    const k = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, r };
}

/**
 * Separable Gaussian blur in place: wraps horizontally (RA), clamps vertically (poles).
 * @param {Float32Array} img W×H
 * @param {number} sigma pixels
 */
export function blur(img, sigma) {
    const { k, r } = gaussianKernel(sigma);
    const tmp = new Float32Array(img.length);
    for (let y = 0; y < H; y++) {
        const o = y * W;
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let i = -r; i <= r; i++) s += k[i + r] * img[o + ((x + i + W) % W)];
            tmp[o + x] = s;
        }
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let s = 0;
            for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
            img[y * W + x] = s;
        }
    }
}

/**
 * Continuous isophote level for one pixel (see the header).
 * @param {number} c number of levels containing the pixel, 0..LEVELS
 * @param {number} a distance (°) back to contour c (the edge of the region the pixel is in)
 * @param {number} b distance (°) ahead to contour c+1 (Infinity when there is none)
 * @returns {number} L in [0, L_MAX)
 */
export function levelValue(c, a, b) {
    if (c <= 0) {
        const t = Math.min(1, Math.max(0, b / OUTER_FADE_DEG));
        return (1 - t) * (1 - t);
    }
    if (c >= LEVELS) return LEVELS + (L_MAX - LEVELS) * 0.999 * a / (a + CORE_RISE_DEG);
    if (!Number.isFinite(b)) return c;
    return c + a / Math.max(1e-9, a + b);
}

/**
 * Smooth level map L (before quantisation), for tests and diagnostics.
 * @param {object} mw parsed mw.json FeatureCollection
 * @returns {Float32Array} W×H level values in [0, L_MAX)
 */
export function levelMap(mw) {
    const levels = mw.features.filter((f) => /^ol\d$/.test(f.id)).sort((a, b) => a.id.localeCompare(b.id));
    // Inside/outside per level (coverage ≥ ½), then the count of levels containing each pixel.
    const count = new Uint8Array(W * H);
    const cov = new Float32Array(W * H);
    for (const f of levels) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        cov.fill(0);
        fillLevel(polys, cov, 1);
        for (let i = 0; i < cov.length; i++) if (cov[i] >= 0.5) count[i]++;
    }
    const n = levels.length;
    // Half a pixel: a pixel next to the boundary is ~½ px from the contour, not 1 px.
    const half = 0.5 * PX_DEG;
    const L = new Float32Array(W * H);
    const dBack = new Float32Array(W * H);      // distance back to the pixel's own contour
    for (let j = 1; j <= n + 1; j++) {
        // For pixels with count == j − 1: b = distance ahead to region {count ≥ j}.
        // For pixels with count == j:     a = distance back to region {count < j}.
        const ahead = j <= n ? distanceField((i) => count[i] >= j) : null;
        const back = j <= n ? distanceField((i) => count[i] < j) : null;
        for (let i = 0; i < L.length; i++) {
            const c = count[i];
            if (c === j - 1) {
                const b = ahead ? Math.max(0, ahead[i] - half) : Infinity;
                const a = c > 0 ? dBack[i] : 0;
                L[i] = levelValue(c, a, b);
            } else if (c === j && back) {
                dBack[i] = Math.max(0, back[i] - half);
            }
        }
    }
    return L;
}

/**
 * Renders the Milky Way raster.
 * @param {object} mw parsed mw.json FeatureCollection
 * @returns {Uint8Array} W×H grey pixels, v = L / L_MAX
 */
export function renderMilkyWay(mw) {
    const L = levelMap(mw);
    blur(L, SIGMA_PX);
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, L[i] / L_MAX)) * 255);
    return out;
}

/** Pixel value at a given RA/Dec (nearest), for diagnostics and tests. */
export function sampleRaDec(gray, raDeg, decDeg) {
    const x = Math.min(W - 1, Math.max(0, Math.floor((((raDeg % 360) + 360) % 360) / 360 * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor((90 - decDeg) / 180 * H)));
    return gray[y * W + x];
}

function main() {
    const t0 = performance.now();
    const gray = renderMilkyWay(JSON.parse(fs.readFileSync(SRC, 'utf8')));
    const png = encodePng(W, H, gray);
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
        if (!cur.equals(png)) {
            console.error('data/milkyway.png is out of date — run: node scripts/build-milkyway.mjs');
            process.exit(1);
        }
        console.log('data/milkyway.png is up to date');
        return;
    }
    fs.writeFileSync(OUT, png);
    const gc = sampleRaDec(gray, 266.40, -28.94), ngp = sampleRaDec(gray, 192.86, 27.13), sgp = sampleRaDec(gray, 12.86, -27.13);
    console.log(`data/milkyway.png: ${W}x${H}, ${(png.length / 1024).toFixed(1)} KB, galactic centre ${gc}, `
        + `poles ${ngp}/${sgp}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
