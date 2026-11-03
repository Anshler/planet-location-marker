/**
 * Jupiter's Galilean moons, the Moon's libration and Saturn's ring-plane crossings (pure).
 *
 * - {@link computeGalilean}: AE.JupiterMoons (L1.2 theory) at the instant the light left Jupiter
 *   (t − Jupiter's light time, the same instant as the snapshot's astrometric `dirS`; without it
 *   Io is ~6° off along its orbit), as jovicentric offsets in the scene frame, in units of
 *   Jupiter's equatorial radius, with transit, occultation, eclipse and shadow-transit flags from
 *   the oblate globe against the observer's and the Sun's lines of sight (umbra only: the
 *   penumbra and the moons' own size are ignored, so a flag switches within ~1 min of the
 *   published contact).
 * - {@link lunarLibration}: AE.Libration, and {@link bestLimbFeature}: the limb feature that the
 *   libration presents best tonight.
 * - {@link saturnEdgeOn}: the next run of ring-plane crossings seen from the Earth.
 *
 * @module astro/moons
 */
import { AE } from './ae.js';
import { AU_KM } from './bodies.js';
import { SHAPES } from './disc.js';
import { DEG2RAD, RAD2DEG } from './frames.js';

/** The four Galilean moons, inner to outer (radii in km; `mag`: mean opposition V). */
export const GALILEAN = Object.freeze([
    Object.freeze({ id: 'io', name: 'Io', short: 'I', radiusKm: 1821.6, mag: 5.0 }),
    Object.freeze({ id: 'europa', name: 'Europa', short: 'E', radiusKm: 1560.8, mag: 5.3 }),
    Object.freeze({ id: 'ganymede', name: 'Ganymede', short: 'G', radiusKm: 2634.1, mag: 4.6 }),
    Object.freeze({ id: 'callisto', name: 'Callisto', short: 'C', radiusKm: 2410.3, mag: 5.7 }),
]);
/** State flags (bit mask) of a Galilean moon. */
export const MOON_TRANSIT = 1;   // in front of Jupiter's disc
export const MOON_OCCULTED = 2;  // behind the disc
export const MOON_ECLIPSED = 4;  // in Jupiter's shadow
export const MOON_SHADOW = 8;    // its shadow falls on the side of Jupiter that faces us

const JUP_R_KM = SHAPES.jupiter.eqRadiusKm;
const JUP_R_AU = JUP_R_KM / AU_KM;
const JUP_S = 1 / (1 - SHAPES.jupiter.flattening);   // stretch along the pole: spheroid → unit sphere
const AE_KEYS = ['io', 'europa', 'ganymede', 'callisto'];

/**
 * @typedef {{ offS:Float64Array, shadowS:Float64Array, state:Uint8Array }} Galilean
 *   `offS`: 4 × (x, y, z) jovicentric offsets, scene frame, Jupiter equatorial radii.
 *   `shadowS`: 4 × the point on Jupiter's surface where each moon's shadow falls (same units),
 *   (0, 0, 0) when the shadow misses Jupiter (read it when MOON_SHADOW is set: then it is on the
 *   side that faces us). `state`: MOON_* flags per moon.
 */

/** @returns {Galilean} */
export function createGalilean() {
    return { offS: new Float64Array(12), shadowS: new Float64Array(12), state: new Uint8Array(4) };
}

// Scratch (R5).
const Q = new Float64Array(3);
const E = new Float64Array(3);

/** v with its component along the unit pole p scaled by s, into out (spheroid → unit sphere). */
function stretch(v, p, s, out) {
    const k = (v[0] * p[0] + v[1] * p[1] + v[2] * p[2]) * (s - 1);
    out[0] = v[0] + k * p[0];
    out[1] = v[1] + k * p[1];
    out[2] = v[2] + k * p[2];
    return out;
}

/** A direction stretched like {@link stretch}, renormalised. */
function stretchDir(v, p, s, out) {
    stretch(v, p, s, out);
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
}

/**
 * Fills `out` with the Galilean moons for one instant (in place; AE's own temporaries aside, no
 * allocation).
 * @param {object} time astronomy-engine AstroTime of the snapshot (UT)
 * @param {{dirS:ArrayLike<number>, lightS:ArrayLike<number>, poleS:ArrayLike<number>, lightTimeS:number}} jup
 *   Jupiter's BodyState (observer → Jupiter, Jupiter → Sun, north pole; all scene unit vectors)
 * @param {Galilean} out
 * @returns {Galilean} out
 */
export function computeGalilean(time, jup, out) {
    const lt = Number.isFinite(jup.lightTimeS) ? jup.lightTimeS : 0;
    const jm = AE.JupiterMoons(time.AddDays(-lt / 86400));
    const p = jup.poleS, d = jup.dirS, L = jup.lightS;
    for (let k = 0; k < 4; k++) {
        const sv = jm[AE_KEYS[k]];
        const o = k * 3;
        // EQJ (x, y, z) → scene (x, z, −y), in Jupiter radii.
        const v = out.offS;
        v[o] = sv.x / JUP_R_AU;
        v[o + 1] = sv.z / JUP_R_AU;
        v[o + 2] = -sv.y / JUP_R_AU;
        Q[0] = v[o]; Q[1] = v[o + 1]; Q[2] = v[o + 2];
        stretch(Q, p, JUP_S, Q);
        const q2 = Q[0] * Q[0] + Q[1] * Q[1] + Q[2] * Q[2];
        let flags = 0;
        // The observer's line of sight (along +d, from the observer through the moon).
        stretchDir(d, p, JUP_S, E);
        let qe = Q[0] * E[0] + Q[1] * E[1] + Q[2] * E[2];
        if (q2 - qe * qe < 1) flags |= qe < 0 ? MOON_TRANSIT : MOON_OCCULTED;
        // The sunlight (toward the Sun along L): in Jupiter's shadow, or casting one on it.
        stretchDir(L, p, JUP_S, E);
        qe = Q[0] * E[0] + Q[1] * E[1] + Q[2] * E[2];
        const sh = out.shadowS;
        sh[o] = sh[o + 1] = sh[o + 2] = 0;
        if (q2 - qe * qe < 1) {
            if (qe < 0) flags |= MOON_ECLIPSED;
            else {
                // First hit of the ray from the moon away from the Sun: Q − s·E on the unit sphere.
                const s = qe - Math.sqrt(Math.max(0, qe * qe - q2 + 1));
                const hx = Q[0] - s * E[0], hy = Q[1] - s * E[1], hz = Q[2] - s * E[2];
                // Back to the spheroid; the unit-sphere normal (hx, hy, hz) faces the observer when h·d < 0.
                const hp = hx * p[0] + hy * p[1] + hz * p[2];
                const kp = hp * (1 / JUP_S - 1);
                sh[o] = hx + kp * p[0];
                sh[o + 1] = hy + kp * p[1];
                sh[o + 2] = hz + kp * p[2];
                // The spheroid's normal there is the unit-sphere normal stretched again.
                const kn = hp * (JUP_S - 1);
                if ((hx + kn * p[0]) * d[0] + (hy + kn * p[1]) * d[1] + (hz + kn * p[2]) * d[2] < 0) flags |= MOON_SHADOW;
            }
        }
        out.state[k] = flags;
    }
    return out;
}

/**
 * The Moon's optical + physical libration (AE.Libration): the selenographic longitude and
 * latitude of the sub-Earth point (geocentric). Positive `elonDeg` turns the east limb (Mare
 * Crisium) toward us, positive `elatDeg` the north pole.
 * @param {object} time AstroTime
 * @param {{elonDeg:number, elatDeg:number}} out
 */
export function lunarLibration(time, out) {
    const l = AE.Libration(time);
    out.elonDeg = l.elon;
    out.elatDeg = l.elat;
    return out;
}

/** Limb features that libration brings into or out of view (selenographic east longitude, latitude). */
export const LIMB_FEATURES = Object.freeze([
    Object.freeze({ name: 'Mare Crisium', lon: 59.1, lat: 17.0 }),
    Object.freeze({ name: 'Mare Marginis', lon: 86.5, lat: 13.3 }),
    Object.freeze({ name: 'Mare Smythii', lon: 87.1, lat: -1.7 }),
    Object.freeze({ name: 'Mare Humboldtianum', lon: 81.5, lat: 56.9 }),
    Object.freeze({ name: 'Mare Australe', lon: 84.1, lat: -38.6 }),
    Object.freeze({ name: 'Grimaldi', lon: -68.6, lat: -5.2 }),
    Object.freeze({ name: 'Mare Orientale', lon: -92.8, lat: -19.4 }),
    Object.freeze({ name: 'Bailly', lon: -69.1, lat: -66.5 }),
]);

function arcDeg(lon1, lat1, lon2, lat2) {
    const a = lat1 * DEG2RAD, b = lat2 * DEG2RAD, dl = (lon2 - lon1) * DEG2RAD;
    const c = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dl);
    return Math.acos(Math.max(-1, Math.min(1, c))) * RAD2DEG;
}

/**
 * The limb feature the libration presents best: the one whose distance from the sub-Earth point
 * shrank the most against the mean (0°, 0°).
 * @param {number} elonDeg
 * @param {number} elatDeg
 * @returns {{name:string, gainDeg:number, distDeg:number}} `distDeg` from the disc centre (≥ 90: past the limb)
 */
export function bestLimbFeature(elonDeg, elatDeg) {
    let best = null;
    for (const f of LIMB_FEATURES) {
        const dist = arcDeg(elonDeg, elatDeg, f.lon, f.lat);
        const gain = arcDeg(0, 0, f.lon, f.lat) - dist;
        if (!best || gain > best.gainDeg) best = { name: f.name, gainDeg: gain, distDeg: dist };
    }
    return best;
}

/**
 * Eight-point direction of the libration on the Moon's disc, in selenographic terms ('north-east':
 * the north-east limb is tipped toward us), or '' for under 0.5°.
 * @param {number} elonDeg
 * @param {number} elatDeg
 * @returns {string}
 */
export function librationDirection(elonDeg, elatDeg) {
    if (!(Math.hypot(elonDeg, elatDeg) >= 0.5)) return '';
    const a = (Math.atan2(elonDeg, elatDeg) * RAD2DEG + 360) % 360;
    return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8];
}

const DAY_MS = 86400000;
const EDGE_CACHE = new Map();

function ringTilt(ms) {
    return AE.Illumination('Saturn', AE.MakeTime(new Date(ms))).ring_tilt;
}

/** Bisects a sign change of the ring tilt in [a, b] (ms) to a day. */
function crossing(a, ta, b) {
    while (b - a > DAY_MS) {
        const m = (a + b) / 2;
        const tm = ringTilt(m);
        if ((tm > 0) === (ta > 0)) { a = m; ta = tm; } else b = m;
    }
    return (a + b) / 2;
}

/**
 * The next run of Saturn's ring-plane crossings seen from the Earth after `tMs` (the rings edge-on):
 * the first crossing and the last one of the same apparition run (one or three, ~15 years apart).
 * Adaptive steps bounded by the tilt's fastest drift (~0.07°/day), so ~200 Illumination calls;
 * memoised per 30-day bucket. null when none is found within 16 years (never, in practice).
 * @param {number} tMs
 * @returns {{firstMs:number, lastMs:number, count:number}|null}
 */
export function saturnEdgeOn(tMs) {
    if (!Number.isFinite(tMs)) return null;
    const key = Math.floor(tMs / (30 * DAY_MS));
    if (EDGE_CACHE.has(key)) return EDGE_CACHE.get(key);
    const t0 = key * 30 * DAY_MS;
    const limit = t0 + 16 * 365.25 * DAY_MS;
    let a = t0, ta = ringTilt(a);
    let first = NaN;
    while (a < limit) {
        const step = Math.max(5, Math.abs(ta) / 0.08) * DAY_MS;
        const b = a + step, tb = ringTilt(b);
        if ((tb > 0) !== (ta > 0)) { first = crossing(a, ta, b); break; }
        a = b; ta = tb;
    }
    let res = null;
    if (Number.isFinite(first)) {
        let last = first, count = 1;
        let c = first + 2 * DAY_MS, tc = ringTilt(c);
        for (let s = 0; s < 90; s++) {
            const e = c + 5 * DAY_MS, te = ringTilt(e);
            if ((te > 0) !== (tc > 0)) { last = crossing(c, tc, e); count++; }
            c = e; tc = te;
        }
        res = { firstMs: first, lastMs: last, count };
    }
    if (EDGE_CACHE.size > 64) EDGE_CACHE.clear();
    EDGE_CACHE.set(key, res);
    return res;
}
