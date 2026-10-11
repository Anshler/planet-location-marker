/**
 * Apparent geocentric paths across the sky (retrograde loops) and their
 * stationary points, for the "Path ±6 months" trail of the selected body.
 *
 * Paths are geocentric: topocentric parallax only matters for the Moon, and a
 * trail spanning months is a geocentric concept anyway.
 *
 * @module astro/paths
 */
import { AE } from './ae.js';
import { bodyById } from './bodies.js';
import { wrap180 } from './frames.js';

const HOUR_MS = 3600000;
const MAX_SAMPLES = 20000;
const REFINE_MS = 10 * 60000;   // bisect stationary points to 10 minutes
const RATE_PROBE_MS = HOUR_MS;  // dλ/dt from a central difference over ±30 min

/**
 * @typedef {{bodyId:string|null, centerMs:number, stepHours:number,
 *            tMs:Float64Array, dirS:Float32Array, eclLonDeg:Float64Array}} ApparentPath
 * @typedef {{tMs:number, kind:'retrograde-start'|'retrograde-end', dirS:number[], eclLonDeg:number}} StationaryPoint
 */

function requireBody(id) {
    const b = bodyById(id);
    if (!b) throw new RangeError(`Unknown body id: ${String(id)}`);
    return b;
}

function geoVector(b, tMs) {
    const time = AE.MakeTime(new Date(tMs));
    return b.id === 'moon' ? AE.GeoMoon(time) : AE.GeoVector(b.ae, time, true);
}

function eclLonAt(b, tMs) {
    return AE.Ecliptic(geoVector(b, tMs)).elon;
}

// Signed ecliptic-longitude rate (degrees per probe interval) at tMs.
function lonRate(b, tMs) {
    return wrap180(eclLonAt(b, tMs + RATE_PROBE_MS / 2) - eclLonAt(b, tMs - RATE_PROBE_MS / 2));
}

/**
 * Samples a body's apparent geocentric position every `stepHours` across
 * centerMs ± halfSpanDays: `GeoVector(body, t, true)` (GeoMoon for the Moon)
 * mapped through S to unit scene directions, plus the true ecliptic longitude
 * of date from `AE.Ecliptic()`.
 * @param {string} bodyId
 * @param {number} centerMs
 * @param {number} [halfSpanDays=180]
 * @param {number} [stepHours=24]
 * @returns {ApparentPath} dirS is packed xyz (3 floats per sample).
 */
export function apparentPath(bodyId, centerMs, halfSpanDays = 180, stepHours = 24) {
    const b = requireBody(bodyId);
    if (!Number.isFinite(centerMs)) throw new TypeError('centerMs must be a finite number of milliseconds');
    if (!(halfSpanDays > 0) || !(stepHours > 0)) throw new RangeError('halfSpanDays and stepHours must be positive');
    const stepMs = stepHours * HOUR_MS;
    const n = Math.min(MAX_SAMPLES, Math.floor((2 * halfSpanDays * 24) / stepHours + 1e-9) + 1);
    const startMs = centerMs - halfSpanDays * 86400000;
    const tMs = new Float64Array(n);
    const dirS = new Float32Array(3 * n);
    const eclLonDeg = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const t = startMs + i * stepMs;
        const g = geoVector(b, t);
        const len = Math.hypot(g.x, g.y, g.z);
        tMs[i] = t;
        dirS[3 * i] = g.x / len;
        dirS[3 * i + 1] = g.z / len;
        dirS[3 * i + 2] = -g.y / len;
        eclLonDeg[i] = AE.Ecliptic(g).elon;
    }
    return { bodyId: b.id, centerMs, stepHours, tMs, dirS, eclLonDeg };
}

// Without a known body (a path built elsewhere), interpolate the zero of the
// discrete rate between the two midpoints that bracket it.
function interpolatedStation(path, i, dPrev, d) {
    const { tMs } = path;
    const mPrev = (tMs[i - 1] + tMs[i]) / 2;
    const m = (tMs[i] + tMs[i + 1]) / 2;
    return mPrev + (m - mPrev) * (dPrev / (dPrev - d));
}

function interpolatedDir(path, tMs) {
    const t = path.tMs;
    let i = 0;
    while (i < t.length - 2 && t[i + 1] < tMs) i++;
    const f = Math.min(1, Math.max(0, (tMs - t[i]) / (t[i + 1] - t[i])));
    const d = path.dirS;
    const v = [0, 1, 2].map((c) => d[3 * i + c] + (d[3 * i + 3 + c] - d[3 * i + c]) * f);
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return v.map((x) => x / len);
}

// Bisect the sign change of dλ/dt in [a, b] down to REFINE_MS.
function bisectStation(b, a, z, rateA) {
    let lo = a, hi = z, rLo = rateA;
    while (hi - lo > REFINE_MS) {
        const mid = (lo + hi) / 2;
        const r = lonRate(b, mid);
        if (r === 0) return mid;
        if (Math.sign(r) === Math.sign(rLo)) {
            lo = mid;
            rLo = r;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}

/**
 * Stationary points of an apparent path: sign changes of dλ/dt (ecliptic
 * longitude rate). Prograde → retrograde is 'retrograde-start', retrograde →
 * prograde is 'retrograde-end'. When the path knows its body, each point is
 * refined by bisection to 10 minutes and its direction recomputed exactly;
 * otherwise the sampled data are interpolated.
 * @param {ApparentPath} path
 * @returns {StationaryPoint[]}
 */
export function stationaryPoints(path) {
    const lon = path?.eclLonDeg;
    if (!lon || lon.length < 3) return [];
    const b = path.bodyId ? bodyById(path.bodyId) : null;
    const out = [];
    let dPrev = wrap180(lon[1] - lon[0]);
    for (let i = 1; i < lon.length - 1; i++) {
        const d = wrap180(lon[i + 1] - lon[i]);
        // A zero rate inherits the previous sign so one station is not reported twice.
        if (d !== 0 && dPrev !== 0 && Math.sign(d) !== Math.sign(dPrev)) {
            const kind = dPrev > 0 ? 'retrograde-start' : 'retrograde-end';
            let tMs, dirS, eclLonDeg;
            if (b) {
                const a = (path.tMs[i - 1] + path.tMs[i]) / 2;
                const z = (path.tMs[i] + path.tMs[i + 1]) / 2;
                tMs = bisectStation(b, a, z, lonRate(b, a));
                const g = geoVector(b, tMs);
                const len = Math.hypot(g.x, g.y, g.z);
                dirS = [g.x / len, g.z / len, -g.y / len];
                eclLonDeg = AE.Ecliptic(g).elon;
            } else {
                tMs = interpolatedStation(path, i, dPrev, d);
                dirS = interpolatedDir(path, tMs);
                eclLonDeg = lon[i];
            }
            out.push({ tMs, kind, dirS, eclLonDeg });
        }
        if (d !== 0) dPrev = d;
    }
    return out;
}
