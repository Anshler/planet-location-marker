/**
 * Illustrative landscape for the sky view (the 'landscape' layer): one horizon profile per place,
 * built once per observer change and shared by everything that asks "is it behind the hills?" —
 * the ground shader (uploaded as a HORIZON_SAMPLES×1 float texture by js/render/ground.js), the lens
 * flare, body picking and the labels — so nothing disagrees with what is drawn.
 *
 * The profile is invented, not surveyed:
 *   - a low far ridge, at most FAR_RIDGE_MAX_DEG (a 1.5° ridge would delay sunset by minutes
 *     against the Sky panel's time), from periodic value noise;
 *   - a near band of tree crowns, or of rooftops where cities are dense (urbanIndex over
 *     data/cities.json), at most NEAR_BAND_MAX_DEG; no trees beyond the tree line (the high Arctic,
 *     everything south of 60° S), where the far ridge of ice or rock is the horizon;
 *   - flat sea in the sectors that look out over water (`water`, sampled by the caller from the
 *     ocean mask the globe already loads), where the shader draws a sky reflection and glitter.
 * Everything random is seeded by the place rounded to 0.1° (horizonSeed), so a place keeps its own
 * horizon across visits and devices. The almanac, the Sky panel and the bodies' `above` flags keep
 * the mathematical horizon (altitude 0); with the layer off the sky view does too.
 *
 * Sample i lies at azimuth i·360°/HORIZON_SAMPLES (from north through east). Between samples the
 * profile is linear, in GLSL (ground.glsl.js horizonAt) exactly as in horizonAltDeg.
 *
 * Pure: no DOM, no three.js. Building allocates (a few small arrays per observer change); the
 * queries do not.
 * @module geo/horizon
 */
import { refractionDeg } from '../astro/photometry.js';
import { distanceKm } from './coords.js';

/** Azimuth samples around the horizon (0.18° apart: tree crowns and roof steps need about that; 2048 is WebGL2's minimum texture width). */
export const HORIZON_SAMPLES = 2048;
/** Highest point of the far ridge, degrees. */
export const FAR_RIDGE_MAX_DEG = 0.5;
/** Highest tree crown or roof, degrees. */
export const NEAR_BAND_MAX_DEG = 1.2;
/** Sea detection: azimuth sectors, and the distances (km) sampled along each. */
export const SEA_SECTORS = 64;
const SEA_DIST_KM = [6, 10, 15, 22, 30];
const URBAN_RADIUS_KM = 30;
const KM_PER_DEG = 111.195;
const DEG = Math.PI / 180;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * @typedef {object} HorizonProfile
 * @property {number} n samples (HORIZON_SAMPLES)
 * @property {Float32Array} far far-ridge altitude per sample, degrees
 * @property {Float32Array} near tree/roof band altitude per sample, degrees
 * @property {Float32Array} sea water fraction per sample, 0…1
 * @property {Float32Array} alt the silhouette: max(far, near), degrees (what every test reads)
 * @property {boolean} enabled the layer is on: queries return the profile, otherwise 0
 * @property {string} key what the profile was built for (horizonKey)
 * @property {number} version bumped by every build
 * @property {number} latDeg
 * @property {number} lonDeg
 * @property {number} urban 0 (trees) … 1 (rooftops)
 * @property {number} seaFrac share of the horizon that is sea, 0…1
 */

/**
 * An empty (flat, disabled) profile.
 * @returns {HorizonProfile}
 */
export function createHorizon() {
    const n = HORIZON_SAMPLES;
    return {
        n,
        far: new Float32Array(n),
        near: new Float32Array(n),
        sea: new Float32Array(n),
        alt: new Float32Array(n),
        enabled: false,
        key: '',
        version: 0,
        latDeg: NaN,
        lonDeg: NaN,
        urban: 0,
        seaFrac: 0,
    };
}

/**
 * 32-bit seed of a place rounded to 0.1° (longitude wrapped, so 180° and −180° agree).
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number} uint32
 */
export function horizonSeed(latDeg, lonDeg) {
    const a = Math.round(clamp(Number(latDeg) || 0, -90, 90) * 10);
    const b = Math.round(((((Number(lonDeg) || 0) + 180) % 360 + 360) % 360) * 10) % 3600;
    let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
}

/** mulberry32: a small, fast, well-mixed PRNG; returns [0, 1). */
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Periodic 1-D value-noise fBm around the circle into out (about −1…1). */
function periodicFbm(rand, out, baseCells, octaves) {
    const n = out.length;
    out.fill(0);
    let amp = 1, norm = 0, m = baseCells;
    for (let o = 0; o < octaves; o++) {
        const lat = new Float64Array(m);
        for (let k = 0; k < m; k++) lat[k] = rand() * 2 - 1;
        for (let i = 0; i < n; i++) {
            const x = (i * m) / n;
            const i0 = Math.floor(x);
            const f = x - i0;
            const u = f * f * (3 - 2 * f);
            const a = lat[i0 % m], b = lat[(i0 + 1) % m];
            out[i] += amp * (a + (b - a) * u);
        }
        norm += amp;
        amp *= 0.5;
        m *= 2;
    }
    for (let i = 0; i < n; i++) out[i] /= norm;
}

/** Raises near[] to h over the samples whose azimuth lies in [a0, a1) (degrees, may pass 360). */
function raise(near, a0, a1, heightAt) {
    const n = near.length, step = 360 / n;
    for (let k = Math.ceil(a0 / step); k * step < a1; k++) {
        const h = heightAt(k * step);
        const i = ((k % n) + n) % n;
        if (h > near[i]) near[i] = h;
    }
}

/** A clump of tree crowns from a0, w degrees wide. */
function trees(near, rand, a0, w) {
    const top = 0.3 + 0.6 * rand();
    let c = a0;
    while (c < a0 + w) {
        const cw = 0.5 + 1.6 * rand();
        const ch = Math.min(NEAR_BAND_MAX_DEG, top * (0.65 + 0.35 * rand()));
        const mid = c + cw / 2, r = cw / 2;
        raise(near, c, c + cw, (az) => {
            const x = (az - mid) / r;
            return ch * Math.sqrt(Math.max(0, 1 - x * x));
        });
        c += cw * (0.55 + 0.35 * rand());
    }
}

/**
 * A building from a0, w degrees wide: a flat or gabled roof, sometimes a chimney, now and then a
 * narrow tower or dome above the roofline.
 */
function building(near, rand, a0, w) {
    const base = Math.min(NEAR_BAND_MAX_DEG - 0.35, 0.18 + 0.75 * rand() * rand());
    const gable = rand() < 0.35 ? Math.min(0.28, 0.16 * w) : 0;
    const mid = a0 + w / 2;
    raise(near, a0, a0 + w, (az) => base + gable * (1 - Math.abs(az - mid) / (w / 2)));
    const chimneys = rand() < 0.5 ? 1 + Math.floor(2 * rand()) : 0;
    for (let k = 0; k < chimneys; k++) {
        const cx = a0 + w * (0.1 + 0.8 * rand());
        const top = Math.min(NEAR_BAND_MAX_DEG, base + gable * 0.5 + 0.08 + 0.12 * rand());
        raise(near, cx, cx + 0.36, () => top);
    }
    if (rand() < 0.06) {
        const cx = a0 + w * rand(), tw = 0.5 + 0.6 * rand(), top = Math.min(NEAR_BAND_MAX_DEG, base + 0.35 + 0.35 * rand());
        const dome = rand() < 0.5;
        raise(near, cx, cx + tw, (az) => {
            const x = (az - cx) / tw * 2 - 1;
            return dome ? base + (top - base) * Math.sqrt(Math.max(0, 1 - x * x)) : top;
        });
    }
}

/**
 * How built-up a place is, 0 (open country) … 1 (city centre), from the populations of the cities
 * within 30 km, each weighted by exp(−d / 6 km).
 * @param {ArrayLike<{lat:number, lon:number, pop:number}>|null|undefined} list cities (data/cities.json)
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {number}
 */
export function urbanIndex(list, latDeg, lonDeg) {
    if (!list || !list.length || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return 0;
    const dLat = URBAN_RADIUS_KM / KM_PER_DEG;
    const dLon = dLat / Math.max(Math.cos(latDeg * DEG), 0.05);
    let sum = 0;
    for (let k = 0; k < list.length; k++) {
        const p = list[k];
        if (!p || Math.abs(p.lat - latDeg) > dLat) continue;
        let dl = Math.abs(p.lon - lonDeg);
        if (dl > 180) dl = 360 - dl;
        if (dl > dLon) continue;
        const km = distanceKm(latDeg, lonDeg, p.lat, p.lon);
        if (km <= URBAN_RADIUS_KM) sum += (Number(p.pop) || 0) * Math.exp(-km / 6);
    }
    return smooth(4.3, 6.0, Math.log10(sum + 1));
}

/**
 * Water fraction per sea sector (SEA_SECTORS, sector s at azimuth s·360°/SEA_SECTORS): the mean of
 * `water` at 6, 10, 15, 22 and 30 km out (the far ground is what meets the sky), through
 * smooth(0.45, 0.8, ·), then a [1 2 1] circular blur.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {(latDeg:number, lonDeg:number) => number} water 0 land … 1 water
 * @param {Float64Array} [out]
 * @returns {Float64Array}
 */
export function seaSectors(latDeg, lonDeg, water, out = new Float64Array(SEA_SECTORS)) {
    const S = out.length;
    const raw = new Float64Array(S);
    const cl = Math.max(Math.cos(latDeg * DEG), 0.05);
    for (let s = 0; s < S; s++) {
        const az = (s * 360) / S * DEG;
        let sum = 0;
        for (const d of SEA_DIST_KM) {
            const la = clamp(latDeg + (d / KM_PER_DEG) * Math.cos(az), -90, 90);
            const lo = lonDeg + ((d / KM_PER_DEG) * Math.sin(az)) / cl;
            let w = 0;
            try { w = Number(water(la, lo)); } catch { w = 0; }
            sum += Number.isFinite(w) ? clamp(w, 0, 1) : 0;
        }
        raw[s] = smooth(0.45, 0.8, sum / SEA_DIST_KM.length);
    }
    for (let s = 0; s < S; s++) out[s] = 0.25 * raw[(s + S - 1) % S] + 0.5 * raw[s] + 0.25 * raw[(s + 1) % S];
    return out;
}

/**
 * The cache key of a profile: the place to 0.01°, whether water was known, and the urban index.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {{water?:Function|null, urban?:number}} [ctx]
 * @returns {string}
 */
export function horizonKey(latDeg, lonDeg, ctx = {}) {
    const u = Number.isFinite(ctx.urban) ? ctx.urban : 0;
    return `${Math.round(latDeg * 100)},${Math.round(lonDeg * 100)},${typeof ctx.water === 'function' ? 'w' : '-'},${u.toFixed(2)}`;
}

/**
 * Builds the profile for a place into `out` (see the module notes).
 * @param {HorizonProfile} out
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {{water?:((latDeg:number, lonDeg:number) => number)|null, urban?:number}} [ctx]
 * @returns {HorizonProfile} out
 */
export function buildHorizon(out, latDeg, lonDeg, ctx = {}) {
    const n = out.n;
    const rand = prng(horizonSeed(latDeg, lonDeg));
    const urban = clamp(Number.isFinite(ctx.urban) ? ctx.urban : 0, 0, 1);

    // Far ridge: a hazy line of hills, lower on average than its crests.
    const fbm = new Float64Array(n);
    periodicFbm(rand, fbm, 5, 6);
    const relief = 0.16 + 0.30 * rand();
    for (let i = 0; i < n; i++) out.far[i] = clamp(relief * (0.55 + 0.75 * fbm[i]), 0.02, FAR_RIDGE_MAX_DEG);

    // Near band: tree clumps across fields, or rooftops with narrow gaps in town. Trees thin out
    // past the Arctic tree line (66–72° N) and stop south of 60° S (Antarctica, ice and rock).
    out.near.fill(0);
    const treeK = (1 - smooth(66, 72, latDeg)) * smooth(-60, -56, latDeg);
    const start = rand() * 360;
    let az = start;
    while (az < start + 360) {
        const roof = rand() < urban;
        // Town: mostly wall to wall, with the odd street or yard; country: fields between woods.
        const gap = rand();
        az += roof ? (gap < 0.3 ? 0.2 + 2.2 * gap / 0.3 * (1 - 0.5 * urban) : 0) : 1 + 14 * gap;
        const w = roof ? 0.7 + 3.5 * rand() : 1.5 + 9 * rand();
        const end = Math.min(az + w, start + 360);
        if (end - az > 0.3) {
            if (roof) building(out.near, rand, az, end - az);
            else if (treeK >= 1 || rand() < treeK) trees(out.near, rand, az, end - az);
        }
        az += w;
    }

    // Sea: flat in the sectors over water, trees and hills fading out toward the shore.
    let seaSum = 0;
    if (typeof ctx.water === 'function') {
        const sec = seaSectors(latDeg, lonDeg, ctx.water);
        const S = sec.length;
        for (let i = 0; i < n; i++) {
            const x = (i * S) / n;
            const s0 = Math.floor(x);
            const f = x - s0;
            const v = sec[s0 % S] + (sec[(s0 + 1) % S] - sec[s0 % S]) * f;
            out.sea[i] = v;
            seaSum += v;
        }
    } else {
        out.sea.fill(0);
    }
    for (let i = 0; i < n; i++) {
        const land = 1 - out.sea[i];
        out.far[i] *= land;
        out.near[i] *= land;
        out.alt[i] = Math.max(out.far[i], out.near[i]);
    }

    out.latDeg = latDeg;
    out.lonDeg = lonDeg;
    out.urban = urban;
    out.seaFrac = seaSum / n;
    out.key = horizonKey(latDeg, lonDeg, ctx);
    out.version++;
    return out;
}

/**
 * The silhouette's altitude at an azimuth, linear between samples; 0 (the mathematical horizon)
 * when the profile is disabled or missing.
 * @param {HorizonProfile|null|undefined} h
 * @param {number} azDeg from north through east
 * @returns {number} degrees
 */
export function horizonAltDeg(h, azDeg) {
    if (!h || !h.enabled || !Number.isFinite(azDeg)) return 0;
    const n = h.n;
    let x = (azDeg / 360) * n;
    x -= Math.floor(x / n) * n;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = h.alt[i0 % n], b = h.alt[(i0 + 1) % n];
    return a + (b - a) * f;
}

/**
 * Azimuth of a direction (degrees from north through east, 0…360); 0 at the zenith and nadir.
 * @param {ArrayLike<number>} d
 * @param {ArrayLike<number>} north
 * @param {ArrayLike<number>} east
 * @returns {number}
 */
export function azimuthDeg(d, north, east) {
    const y = d[0] * east[0] + d[1] * east[1] + d[2] * east[2];
    const x = d[0] * north[0] + d[1] * north[1] + d[2] * north[2];
    if (x === 0 && y === 0) return 0;
    const a = Math.atan2(y, x) / DEG;
    return a < 0 ? a + 360 : a;
}

/**
 * How far a direction clears the silhouette as the sky view draws it: its altitude lifted by
 * k·refraction (liftByRefraction) minus the profile's altitude at its azimuth. Negative means
 * hidden by the ground or the landscape.
 * @param {HorizonProfile|null|undefined} h
 * @param {ArrayLike<number>} d unit direction
 * @param {ArrayLike<number>} up
 * @param {ArrayLike<number>} north
 * @param {ArrayLike<number>} east
 * @param {number} [k=1] refraction strength (the view blend)
 * @returns {number} degrees
 */
export function clearanceDeg(h, d, up, north, east, k = 1) {
    const s = clamp(d[0] * up[0] + d[1] * up[1] + d[2] * up[2], -1, 1);
    const alt = Math.asin(s) / DEG;
    const app = alt + (k > 0 ? k * refractionDeg(alt) : 0);
    return app - (h && h.enabled ? horizonAltDeg(h, azimuthDeg(d, north, east)) : 0);
}
