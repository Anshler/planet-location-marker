/**
 * The path of a central solar eclipse on the Earth: the centre line and the northern and southern
 * limits of the umbra (total) or antumbra (annular), sampled in time, plus the largest cities
 * inside the band with their local central duration. Pure; runs in the astro worker
 * (`eclipsePath` op).
 *
 * Geometry (ASTRONOMY.md §7, "Path of a central eclipse"): Astronomy Engine's shadow model, so
 * the path agrees with its local circumstances. The shadow axis runs from the geocentric aberrated Sun
 * (`GeoVector(Sun, t, true)`) through the geometric Moon (`GeoMoon`). In the Earth-fixed frame
 * (E(t)ᵀ, frames.js) the axis is intersected with AE's ellipsoid (a = 6378.1366 km, b/a =
 * 0.996647…) by dilating z. The umbra's radius at axial distance τ from the Moon is
 * k(τ) = R☾ − τ·(R☉ − R☾)/|S→M| (negative: antumbra). Each limit is where the cone's edge ray, the
 * generator in the plane of the axis and ê, meets the ellipsoid; ê is square to the axis and to the
 * shadow's motion over the ground (the envelope of the moving footprint).
 *
 * @module astro/eclipse-path
 */
import { AE } from './ae.js';
import { AU_KM, SUN_RADIUS_KM } from './bodies.js';
import { earthRotationM3, RAD2DEG, DEG2RAD } from './frames.js';

const DAY_MS = 86400000;
/** Astronomy Engine's lunar radius for its shadow and contact computations (MOON_MEAN_RADIUS_KM). */
const MOON_R_KM = 1737.4;
/** Astronomy Engine's Earth ellipsoid: equatorial radius (km) and polar/equatorial ratio. */
const EARTH_A_KM = 6378.1366;
const EARTH_BA = 0.996647180302104;
const EARTH_BA2 = EARTH_BA * EARTH_BA;
/** The axis meets the Earth for at most ~3.6 h around greatest eclipse; scan a little wider. */
const SCAN_HALF_MS = 4.5 * 3600e3;
const SCAN_STEP_MS = 60e3;
const END_TOL_MS = 20;              // end bisection to 20 ms
const VEL_H_MS = 5000;              // ±5 s for the shadow's motion over the ground
const MAX_SEG_KM = 120;             // split intervals whose ground points are farther apart
const MIN_SEG_MS = 200;
const MAX_SAMPLES = 1200;

const WIDTH_MIN_ALT_DEG = 10;       // widthKmMax ignores the ends, where the footprint fans out
const SUN_LIMB_DEG = 0.27;          // AE altitudes are the refracted centre; the upper limb is this much higher

/** Columns of one `samples` row. */
export const PATH_STRIDE = 9;
/**
 * Column offsets in a `samples` row: time (UT ms); centre, northern and southern limit (geodetic
 * degrees, longitudes wrapped to (−180, 180]: unwrap or go through unit vectors before
 * interpolating, as pathAt does); the signed shadow radius on the centre line (km, positive
 * umbra = total, negative antumbra = annular); the Sun's geometric altitude on the centre line
 * (degrees, 0 at the ends).
 */
export const PATH_COL = Object.freeze({ T: 0, C_LAT: 1, C_LON: 2, N_LAT: 3, N_LON: 4, S_LAT: 5, S_LON: 6, RADIUS_KM: 7, SUN_ALT: 8 });

/**
 * @typedef {{
 *   kind:'total'|'annular'|'hybrid', peakMs:number, startMs:number, endMs:number,
 *   widthKm:number, widthKmMax:number,
 *   greatest:{tMs:number, latDeg:number, lonDeg:number, durS:number|null, widthKm:number, sunAltDeg:number|null},
 *   samples:Float64Array, count:number, stride:number,
 * }} EclipsePath
 *   `samples` holds `count` rows of PATH_STRIDE numbers (PATH_COL), in time order from the
 *   sunrise end (`startMs`, the axis first touches the Earth) to the sunset end (`endMs`). Rows are
 *   one minute apart, closer where the ground track speeds up toward the ends (no two consecutive
 *   points more than ~120 km apart). `peakMs` is AE's greatest eclipse (the axis closest to the
 *   Earth's centre) and `greatest` the axis point then, with the central duration there from
 *   AE.SearchLocalSolarEclipse. `widthKm` is the band's width square to the track at greatest
 *   eclipse; `widthKmMax` the largest along it where the Sun is at least 10° up. Near the ends the
 *   limits fan out: at grazing incidence the footprint stretches hundreds of km along the
 *   horizon, and a limit ray that misses the Earth is clamped to the limb.
 */

// ---- scratch (reused by every call; the module is synchronous) --------------------------------------

const E = new Float64Array(9);
/** Shadow state at one instant, Earth-fixed km: Moon position, unit axis (Sun → Moon), |S→M|. */
function makeState() {
    return { tMs: NaN, m: new Float64Array(3), d: new Float64Array(3), dLen: 0 };
}
const stA = makeState(), stB = makeState(), stC = makeState();
const pA = new Float64Array(3), pB = new Float64Array(3), pC = new Float64Array(3);
const eHat = new Float64Array(3), org = new Float64Array(3), dir = new Float64Array(3), hit = new Float64Array(3);

function aeTime(ms) {
    return AE.MakeTime(new Date(ms));
}

/** Fills `st` for instant tMs. */
function shadowState(tMs, st) {
    const time = aeTime(tMs);
    const s = AE.GeoVector('Sun', time, true);
    const m = AE.GeoMoon(time);
    earthRotationM3(time, E);
    // Earth-fixed = Eᵀ·v (E maps Earth-fixed to EQJ, row-major).
    const mx = m.x * AU_KM, my = m.y * AU_KM, mz = m.z * AU_KM;
    st.m[0] = E[0] * mx + E[3] * my + E[6] * mz;
    st.m[1] = E[1] * mx + E[4] * my + E[7] * mz;
    st.m[2] = E[2] * mx + E[5] * my + E[8] * mz;
    const dx = (m.x - s.x) * AU_KM, dy = (m.y - s.y) * AU_KM, dz = (m.z - s.z) * AU_KM;
    const len = Math.hypot(dx, dy, dz);
    st.d[0] = (E[0] * dx + E[3] * dy + E[6] * dz) / len;
    st.d[1] = (E[1] * dx + E[4] * dy + E[7] * dz) / len;
    st.d[2] = (E[2] * dx + E[5] * dy + E[8] * dz) / len;
    st.dLen = len;
    st.tMs = tMs;
    return st;
}

/**
 * Nearer intersection of the line p + τ·u (Earth-fixed km) with the ellipsoid, written into out.
 * Returns τ, or NaN when the line misses; with `limb`, a miss writes the ellipsoid point under the
 * line's closest approach instead (still returning NaN).
 */
function hitEllipsoid(p, u, out, limb = false) {
    const pz = p[2] / EARTH_BA, uz = u[2] / EARTH_BA;
    const A = u[0] * u[0] + u[1] * u[1] + uz * uz;
    const B = 2 * (p[0] * u[0] + p[1] * u[1] + pz * uz);
    const C = p[0] * p[0] + p[1] * p[1] + pz * pz - EARTH_A_KM * EARTH_A_KM;
    const disc = B * B - 4 * A * C;
    if (disc < 0 && !limb) return NaN;
    const tau = disc >= 0 ? (-B - Math.sqrt(disc)) / (2 * A) : -B / (2 * A);
    let x = p[0] + tau * u[0], y = p[1] + tau * u[1], z = pz + tau * uz;
    if (disc < 0) {
        const s = EARTH_A_KM / Math.hypot(x, y, z);
        x *= s; y *= s; z *= s;
    }
    out[0] = x; out[1] = y; out[2] = z * EARTH_BA;
    return disc >= 0 ? tau : NaN;
}

function latOf(p) {
    const rho = Math.hypot(p[0], p[1]);
    return rho === 0 ? (p[2] > 0 ? 90 : -90) : Math.atan(p[2] / (EARTH_BA2 * rho)) * RAD2DEG;
}

function lonOf(p) {
    const lon = Math.atan2(p[1], p[0]) * RAD2DEG;
    return lon <= -180 ? lon + 360 : lon;
}

/** Signed umbra radius (km) at axial distance tau from the Moon. */
function umbraKm(st, tau) {
    return MOON_R_KM - tau * (SUN_RADIUS_KM - MOON_R_KM) / st.dLen;
}

/** Where the axis meets the Earth at tMs (into out), or NaN τ when it misses. */
function axisHit(tMs, st, out) {
    shadowState(tMs, st);
    return hitEllipsoid(st.m, st.d, out);
}

/**
 * One sample row at tMs into `row` (length PATH_STRIDE), side "a" = +ê in the north columns.
 * Returns false when the axis misses the Earth at tMs.
 */
function sampleAt(tMs, tLo, tHi, row) {
    const tau = axisHit(tMs, stA, pA);
    if (!Number.isFinite(tau)) return false;
    // The shadow's motion over the ground: the centre point a little before and after, projected
    // square to the axis (one-sided at the ends of the path).
    const t0 = Math.max(tLo, tMs - VEL_H_MS), t1 = Math.min(tHi, tMs + VEL_H_MS);
    let q0 = pA, q1 = pA;
    if (t0 < tMs && Number.isFinite(axisHit(t0, stB, pB))) q0 = pB;
    if (t1 > tMs && Number.isFinite(axisHit(t1, stC, pC))) q1 = pC;
    const d = stA.d;
    let vx = q1[0] - q0[0], vy = q1[1] - q0[1], vz = q1[2] - q0[2];
    const vd = vx * d[0] + vy * d[1] + vz * d[2];
    vx -= vd * d[0]; vy -= vd * d[1]; vz -= vd * d[2];
    // ê = d × v (the side of the track); with no motion (never in practice), the local north.
    let ex = d[1] * vz - d[2] * vy, ey = d[2] * vx - d[0] * vz, ez = d[0] * vy - d[1] * vx;
    let el = Math.hypot(ex, ey, ez);
    if (!(el > 1e-9)) {
        ex = -d[2] * d[0]; ey = -d[2] * d[1]; ez = 1 - d[2] * d[2];
        el = Math.hypot(ex, ey, ez) || 1;
    }
    eHat[0] = ex / el; eHat[1] = ey / el; eHat[2] = ez / el;

    const k = umbraKm(stA, tau);
    const lat = latOf(pA), lon = lonOf(pA);
    row[0] = tMs;
    row[1] = lat;
    row[2] = lon;
    row[7] = k;
    // On the axis the Sun's centre lies exactly along −d: its altitude over the geodetic normal.
    const cp = Math.cos(lat * DEG2RAD);
    const up = -(d[0] * cp * Math.cos(lon * DEG2RAD) + d[1] * cp * Math.sin(lon * DEG2RAD) + d[2] * Math.sin(lat * DEG2RAD));
    row[8] = Math.asin(Math.max(-1, Math.min(1, up))) * RAD2DEG;
    // Edge rays of the cone: origin on the Moon's limb (side σ·ê), direction tilted by the cone's
    // half-angle, so that at axial distance τ the ray is |k(τ)| from the axis.
    const sigma = k >= 0 ? 1 : -1, g = (SUN_RADIUS_KM - MOON_R_KM) / stA.dLen;
    for (let side = 0; side < 2; side++) {
        const f = (side === 0 ? 1 : -1) * sigma;     // +ê for side "a", −ê for side "b"
        for (let i = 0; i < 3; i++) {
            org[i] = stA.m[i] + f * MOON_R_KM * eHat[i];
            dir[i] = d[i] - f * g * eHat[i];
        }
        hitEllipsoid(org, dir, hit, true);
        row[3 + 2 * side] = latOf(hit);
        row[4 + 2 * side] = lonOf(hit);
    }
    return true;
}

/** Great-circle distance (km, mean radius) between two lat/lon points. */
function gcKm(lat1, lon1, lat2, lon2) {
    const a1 = lat1 * DEG2RAD, a2 = lat2 * DEG2RAD, dl = (lon2 - lon1) * DEG2RAD;
    const h = Math.sin((a2 - a1) / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bisects the axis' first (rising = true) or last contact with the Earth between a miss and a hit. */
function bisectEdge(tMiss, tHit) {
    let a = tMiss, b = tHit;
    while (Math.abs(b - a) > END_TOL_MS) {
        const m = (a + b) / 2;
        if (Number.isFinite(axisHit(m, stA, pA))) b = m; else a = m;
    }
    return b;
}

/** The global solar eclipse within a day of tMs (AE GlobalSolarEclipseInfo), or null. */
function globalEclipseNear(tMs) {
    const ge = AE.SearchGlobalSolarEclipse(aeTime(tMs - 10 * DAY_MS));
    return Math.abs(ge.peak.date.getTime() - tMs) <= DAY_MS ? ge : null;
}

/** AE local circumstances at a site for the eclipse peaking near peakMs, or null. */
function localNear(latDeg, lonDeg, peakMs) {
    const ls = AE.SearchLocalSolarEclipse(aeTime(peakMs - DAY_MS), new AE.Observer(latDeg, lonDeg, 0));
    return Math.abs(ls.peak.time.date.getTime() - peakMs) <= DAY_MS ? ls : null;
}

/** Central duration (s) from AE local circumstances, or null for a partial eclipse there. */
function centralDurS(ls) {
    if (!ls || ls.kind === 'partial' || !ls.total_begin || !ls.total_end) return null;
    return (ls.total_end.time.date.getTime() - ls.total_begin.time.date.getTime()) / 1000;
}

/**
 * Width (km) of the band square to the track at row i: the limit-to-limit chord with its
 * along-track part removed (the track direction from the neighbouring centre points).
 */
function widthAt(rows, i) {
    const r = rows[i];
    const a = rows[Math.max(0, i - 1)], b = rows[Math.min(rows.length - 1, i + 1)];
    const ua = unitOf(a[1], a[2]), ub = unitOf(b[1], b[2]);
    const un = unitOf(r[3], r[4]), us = unitOf(r[5], r[6]);
    let tx = ub[0] - ua[0], ty = ub[1] - ua[1], tz = ub[2] - ua[2];
    const tl = Math.hypot(tx, ty, tz);
    let wx = un[0] - us[0], wy = un[1] - us[1], wz = un[2] - us[2];
    if (tl > 0) {
        tx /= tl; ty /= tl; tz /= tl;
        const w = wx * tx + wy * ty + wz * tz;
        wx -= w * tx; wy -= w * ty; wz -= w * tz;
    }
    return Math.hypot(wx, wy, wz) * 6371.0088;
}

function unitOf(latDeg, lonDeg) {
    const p = latDeg * DEG2RAD, l = lonDeg * DEG2RAD, c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
}

/**
 * The path of the central solar eclipse whose greatest eclipse is within a day of `peakMs` (the
 * time of an event: the global peak or a local maximum both work).
 * Typical cost: 5–15 ms. Returns null when there is no solar eclipse near `peakMs`, or when its
 * shadow axis misses the Earth (a partial eclipse everywhere).
 * @param {number} peakMs
 * @param {{stepS?:number}} [opts] stepS: base sampling interval (default 60 s).
 * @returns {EclipsePath|null}
 */
export function eclipsePath(peakMs, opts = {}) {
    if (!Number.isFinite(peakMs)) throw new TypeError('peakMs must be a finite number of milliseconds');
    const ge = globalEclipseNear(peakMs);
    if (!ge || !Number.isFinite(ge.latitude)) return null;
    const gMs = ge.peak.date.getTime();
    if (!Number.isFinite(axisHit(gMs, stA, pA))) return null;
    const step = Math.max(5e3, Math.min(600e3, (Number(opts.stepS) || 60) * 1000));

    // The ends: scan out from greatest eclipse until the axis misses, then bisect.
    let tS = gMs, tE = gMs;
    while (tS - gMs > -SCAN_HALF_MS && Number.isFinite(axisHit(tS - SCAN_STEP_MS, stA, pA))) tS -= SCAN_STEP_MS;
    const startMs = bisectEdge(tS - SCAN_STEP_MS, tS);
    while (tE - gMs < SCAN_HALF_MS && Number.isFinite(axisHit(tE + SCAN_STEP_MS, stA, pA))) tE += SCAN_STEP_MS;
    const endMs = bisectEdge(tE + SCAN_STEP_MS, tE);

    // Uniform rows, then intervals split wherever the ground points are far apart (the ends).
    const n = Math.max(2, Math.ceil((endMs - startMs) / step));
    /** @type {number[][]} */
    let rows = [];
    for (let i = 0; i <= n; i++) {
        const t = i === n ? endMs : startMs + ((endMs - startMs) * i) / n;
        const row = new Array(PATH_STRIDE).fill(NaN);
        if (sampleAt(t, startMs, endMs, row)) rows.push(row);
    }
    for (let pass = 0; pass < 12 && rows.length < MAX_SAMPLES; pass++) {
        const next = [rows[0]];
        let split = false;
        for (let i = 1; i < rows.length; i++) {
            const a = rows[i - 1], b = rows[i];
            const far = gcKm(a[1], a[2], b[1], b[2]) > MAX_SEG_KM || gcKm(a[3], a[4], b[3], b[4]) > MAX_SEG_KM
                || gcKm(a[5], a[6], b[5], b[6]) > MAX_SEG_KM;
            if (far && b[0] - a[0] > MIN_SEG_MS && next.length + rows.length - i < MAX_SAMPLES) {
                const row = new Array(PATH_STRIDE).fill(NaN);
                if (sampleAt((a[0] + b[0]) / 2, startMs, endMs, row)) {
                    next.push(row);
                    split = true;
                }
            }
            next.push(b);
        }
        rows = next;
        if (!split) break;
    }

    // Side "a" (+ê) is the northern limit when it lies north on average; otherwise swap.
    let dLat = 0;
    for (const r of rows) dLat += r[3] - r[5];
    if (dLat < 0) {
        for (const r of rows) {
            [r[3], r[5]] = [r[5], r[3]];
            [r[4], r[6]] = [r[6], r[4]];
        }
    }

    let pos = 0, neg = 0, widthKmMax = 0;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i][7] >= 0) pos++; else neg++;
        if (rows[i][8] >= WIDTH_MIN_ALT_DEG) widthKmMax = Math.max(widthKmMax, widthAt(rows, i));
    }
    const kind = neg === 0 ? 'total' : pos === 0 ? 'annular' : 'hybrid';

    // Greatest eclipse: the axis point at AE's peak, its width and AE's local central duration.
    const gRow = new Array(PATH_STRIDE).fill(NaN);
    sampleAt(gMs, startMs, endMs, gRow);
    if (dLat < 0) {
        [gRow[3], gRow[5]] = [gRow[5], gRow[3]];
        [gRow[4], gRow[6]] = [gRow[6], gRow[4]];
    }
    let gi = 0;
    while (gi < rows.length - 1 && rows[gi + 1][0] <= gMs) gi++;
    const withG = rows.slice(Math.max(0, gi - 1), gi + 1).concat([gRow], rows.slice(gi + 1, gi + 2));
    const widthKm = widthAt(withG, withG.indexOf(gRow));
    const ls = localNear(gRow[1], gRow[2], gMs);

    const samples = new Float64Array(rows.length * PATH_STRIDE);
    rows.forEach((r, i) => samples.set(r, i * PATH_STRIDE));
    return {
        kind,
        peakMs: gMs,
        startMs,
        endMs,
        widthKm,
        widthKmMax: Math.max(widthKmMax, widthKm),
        greatest: {
            tMs: gMs, latDeg: gRow[1], lonDeg: gRow[2], durS: centralDurS(ls), widthKm,
            sunAltDeg: ls ? ls.peak.altitude : null,
        },
        samples,
        count: rows.length,
        stride: PATH_STRIDE,
    };
}

/**
 * The point of the centre line nearest a place (on the polyline between samples), with the time
 * the axis passes there. Null for an empty path.
 * @param {EclipsePath} path
 * @param {number} latDeg
 * @param {number} lonDeg
 * @returns {{latDeg:number, lonDeg:number, tMs:number, km:number}|null}
 */
export function nearestCentrePoint(path, latDeg, lonDeg) {
    const s = path?.samples, n = path?.count ?? 0, st = path?.stride ?? PATH_STRIDE;
    if (!s || n < 1) return null;
    const c = unitOf(latDeg, lonDeg);
    let best = null;
    for (let i = 0; i < n; i++) {
        const a = unitOf(s[i * st + 1], s[i * st + 2]);
        if (i + 1 < n) {
            // Closest point of the chord a→b to c, re-projected to the sphere.
            const b = unitOf(s[(i + 1) * st + 1], s[(i + 1) * st + 2]);
            const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            const f = L > 0 ? Math.min(1, Math.max(0, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / L)) : 0;
            const p = [a[0] + f * ab[0], a[1] + f * ab[1], a[2] + f * ab[2]];
            const pl = Math.hypot(p[0], p[1], p[2]) || 1;
            const dot = (p[0] * c[0] + p[1] * c[1] + p[2] * c[2]) / pl;
            if (!best || dot > best.dot) best = { dot, p: p.map((v) => v / pl), tMs: s[i * st] + f * (s[(i + 1) * st] - s[i * st]) };
        } else if (!best) {
            best = { dot: a[0] * c[0] + a[1] * c[1] + a[2] * c[2], p: a, tMs: s[i * st] };
        }
    }
    const [x, y, z] = best.p;
    let lon = Math.atan2(y, x) * RAD2DEG;
    if (lon <= -180) lon += 360;
    return {
        latDeg: Math.asin(Math.max(-1, Math.min(1, z))) * RAD2DEG, lonDeg: lon, tMs: best.tMs,
        km: Math.acos(Math.max(-1, Math.min(1, best.dot))) * 6371.0088,
    };
}

/**
 * The shadow at instant tMs, interpolated between samples through unit vectors (safe across the
 * date line and the poles), written into `out`. Null outside [startMs, endMs].
 * @param {EclipsePath} path
 * @param {number} tMs
 * @param {{latDeg:number, lonDeg:number, northLatDeg:number, northLonDeg:number, southLatDeg:number,
 *          southLonDeg:number, radiusKm:number, sunAltDeg:number}} [out]
 * @returns {typeof out|null}
 */
export function pathAt(path, tMs, out = {
    latDeg: 0, lonDeg: 0, northLatDeg: 0, northLonDeg: 0, southLatDeg: 0, southLonDeg: 0, radiusKm: 0, sunAltDeg: 0,
}) {
    const s = path?.samples, n = path?.count ?? 0, st = path?.stride ?? PATH_STRIDE;
    if (!s || n < 1 || !(tMs >= s[0] && tMs <= s[(n - 1) * st])) return null;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s[mid * st] <= tMs) lo = mid; else hi = mid;
    }
    const a = lo * st, b = hi * st;
    const f = s[b] > s[a] ? (tMs - s[a]) / (s[b] - s[a]) : 0;
    const blend = (iLat, iLon) => {
        const p = unitOf(s[a + iLat], s[a + iLon]), q = unitOf(s[b + iLat], s[b + iLon]);
        const x = p[0] + (q[0] - p[0]) * f, y = p[1] + (q[1] - p[1]) * f, z = p[2] + (q[2] - p[2]) * f;
        const l = Math.hypot(x, y, z) || 1;
        let lon = Math.atan2(y, x) * RAD2DEG;
        if (lon <= -180) lon += 360;
        return [Math.asin(Math.max(-1, Math.min(1, z / l))) * RAD2DEG, lon];
    };
    [out.latDeg, out.lonDeg] = blend(1, 2);
    [out.northLatDeg, out.northLonDeg] = blend(3, 4);
    [out.southLatDeg, out.southLonDeg] = blend(5, 6);
    out.radiusKm = s[a + 7] + (s[b + 7] - s[a + 7]) * f;
    out.sunAltDeg = s[a + 8] + (s[b + 8] - s[a + 8]) * f;
    return out;
}

/**
 * The largest cities inside the band of a central eclipse, with their local circumstances from
 * AE.SearchLocalSolarEclipse (the same numbers as the event card). Cities are first screened
 * against the band (cross-track distance to the centre line within the local half-width plus
 * 25 km), then checked with AE in descending population until `n` are found or 4·n + 8 have been
 * checked, so the cost stays bounded (≈ 1.4 ms per check). A city counts when AE gives it a total
 * or annular phase with the Sun's upper limb above the horizon at second or third contact.
 * @param {EclipsePath} path
 * @param {ArrayLike<{lat:number, lon:number, pop?:number}>} cities
 * @param {number} [n=12]
 * @returns {{index:number, durS:number, c2Ms:number, c3Ms:number, maxMs:number, sunAltDeg:number,
 *            kind:'total'|'annular', km:number}[]} sorted by population (largest first); `index` is
 *   the city's position in `cities`, `km` its distance from the centre line.
 */
export function citiesInPath(path, cities, n = 12) {
    const s = path?.samples, cnt = path?.count ?? 0, st = path?.stride ?? PATH_STRIDE;
    const want = Math.max(0, Math.min(100, Math.floor(Number(n) || 0)));
    if (!s || cnt < 2 || !cities || !want) return [];
    // Unit vectors and half-widths of the centre samples.
    const cu = new Float64Array(cnt * 3), half = new Float64Array(cnt);
    for (let i = 0; i < cnt; i++) {
        const u = unitOf(s[i * st + 1], s[i * st + 2]);
        cu.set(u, i * 3);
        half[i] = gcKm(s[i * st + 3], s[i * st + 4], s[i * st + 5], s[i * st + 6]) / 2;
    }
    let maxHalf = 0;
    for (let i = 0; i < cnt; i++) maxHalf = Math.max(maxHalf, half[i]);
    const cosReach = Math.cos((maxHalf + 150) / 6371.0088);
    const candidates = [];
    for (let j = 0; j < cities.length; j++) {
        const c = cities[j];
        const lat = Number(c?.lat), lon = Number(c?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const u = unitOf(lat, lon);
        let bi = -1, bd = -2;
        for (let i = 0; i < cnt; i++) {
            const d = u[0] * cu[i * 3] + u[1] * cu[i * 3 + 1] + u[2] * cu[i * 3 + 2];
            if (d > bd) { bd = d; bi = i; }
        }
        if (bd < cosReach) continue;
        // Cross-track distance to the segments either side of the nearest sample.
        let km = Math.acos(Math.min(1, bd)) * 6371.0088;
        for (const k of [bi - 1, bi]) {
            if (k < 0 || k + 1 >= cnt) continue;
            const a = [cu[k * 3], cu[k * 3 + 1], cu[k * 3 + 2]], b = [cu[k * 3 + 3], cu[k * 3 + 4], cu[k * 3 + 5]];
            const nx = a[1] * b[2] - a[2] * b[1], ny = a[2] * b[0] - a[0] * b[2], nz = a[0] * b[1] - a[1] * b[0];
            const nl = Math.hypot(nx, ny, nz);
            if (!(nl > 0)) continue;
            const sn = (u[0] * nx + u[1] * ny + u[2] * nz) / nl;
            // Only when the foot of the perpendicular falls inside the segment.
            const fa = u[0] * a[0] + u[1] * a[1] + u[2] * a[2], fb = u[0] * b[0] + u[1] * b[1] + u[2] * b[2];
            const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            if (fa * ab <= fb + 1e-12 && fb * ab <= fa + 1e-12) km = Math.min(km, Math.abs(Math.asin(Math.max(-1, Math.min(1, sn)))) * 6371.0088);
        }
        if (km <= half[bi] + 25) candidates.push({ j, km, pop: Number(c.pop) || 0 });
    }
    candidates.sort((a, b) => b.pop - a.pop);
    const out = [];
    const budget = 4 * want + 8;
    for (let k = 0; k < candidates.length && k < budget && out.length < want; k++) {
        const { j, km } = candidates[k];
        let ls = null;
        try {
            ls = localNear(Number(cities[j].lat), Number(cities[j].lon), path.peakMs);
        } catch {
            ls = null;
        }
        const durS = centralDurS(ls);
        // In the band means the central phase is seen: the Sun's upper limb up at C2 or C3.
        if (durS === null || (ls.total_begin.altitude + SUN_LIMB_DEG <= 0 && ls.total_end.altitude + SUN_LIMB_DEG <= 0)) continue;
        out.push({
            index: j, durS, kind: ls.kind,
            c2Ms: ls.total_begin.time.date.getTime(), c3Ms: ls.total_end.time.date.getTime(),
            maxMs: ls.peak.time.date.getTime(), sunAltDeg: ls.peak.altitude, km,
        });
    }
    return out;
}

/**
 * Where the Moon's shadow axis meets the scene's unit sphere (the nearer root), as a unit vector
 * in the scene frame written into `out`; when the axis misses (a partial eclipse), the point
 * under its closest approach. Allocation-free (the pin calls it per snapshot).
 * @param {ArrayLike<number>} moonPosS geocentric Moon, Earth radii (snap.moonPosS)
 * @param {ArrayLike<number>} sunDirS geocentric unit vector to the Sun (snap.sunDirS)
 * @param {Float64Array|number[]} out
 * @returns {number} the axis' closest distance from the Earth's centre (Earth radii; < 1: it hits)
 */
export function shadowAxisPoint(moonPosS, sunDirS, out) {
    const m = moonPosS, s = sunDirS;
    // Axis: P(t) = m − t·s (from the Moon, away from the Sun). |P|² = 1 → t² − 2t(m·s) + |m|² − 1 = 0.
    const ms = m[0] * s[0] + m[1] * s[1] + m[2] * s[2];
    const mm = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
    const disc = ms * ms - mm + 1;
    const t = disc >= 0 ? ms - Math.sqrt(disc) : ms;
    const x = m[0] - t * s[0], y = m[1] - t * s[1], z = m[2] - t * s[2];
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return Math.sqrt(Math.max(0, mm - ms * ms));
}

const axisW = new Float64Array(3);

/** Default reach of umbraNear (radians from the observer): the pin's horizon disc is 0.22. */
export const UMBRA_NEAR_RAD = Object.freeze({ near: 0.28, far: 0.42 });

/**
 * How near the Moon's umbra is to the observer, as a 0…1 weight for getting out of its way (the
 * pin's disc and halo, the beams' roots): 1 while a solar eclipse's shadow axis meets the Earth
 * within `nearRad` of the observer, easing to 0 at `farRad`; 0 with no solar eclipse in progress or
 * when the axis misses the Earth. Allocation-free (per snapshot).
 * @param {import('../core/types.js').Snapshot} snap
 * @param {number} [nearRad]
 * @param {number} [farRad]
 * @returns {number}
 */
export function umbraNear(snap, nearRad = UMBRA_NEAR_RAD.near, farRad = UMBRA_NEAR_RAD.far) {
    const up = snap?.observer?.upS;
    if (!snap?.eclipse?.solar || !snap.moonPosS || !snap.sunDirS || !up) return 0;
    if (!(shadowAxisPoint(snap.moonPosS, snap.sunDirS, axisW) < 1)) return 0;
    const c = (up[0] * axisW[0] + up[1] * axisW[1] + up[2] * axisW[2]) / (Math.hypot(up[0], up[1], up[2]) || 1);
    const a = Math.acos(Math.max(-1, Math.min(1, c)));
    const t = Math.max(0, Math.min(1, (farRad - a) / (farRad - nearRad)));
    return t * t * (3 - 2 * t);
}

/**
 * Where the Moon's shadow axis meets the Earth at a snapshot instant (lat/lon), or the point of
 * closest approach when the axis misses (partial eclipse). On the scene's unit sphere, from the
 * snapshot's own vectors, for camera aiming; eclipsePath gives the ellipsoid track.
 * @param {import('../core/types.js').Snapshot} snap
 * @returns {{latDeg:number, lonDeg:number}}
 */
export function shadowPoint(snap) {
    shadowAxisPoint(snap.moonPosS, snap.sunDirS, axisW);
    const x = axisW[0], y = axisW[1], z = axisW[2];
    // Earth-fixed (geometry-local) direction: Eᵀ·P, then localToLatLon (SPEC §D.3).
    const e = snap.earthMatrix;
    const lx = e[0] * x + e[1] * y + e[2] * z;
    const ly = e[4] * x + e[5] * y + e[6] * z;
    const lz = e[8] * x + e[9] * y + e[10] * z;
    return { latDeg: Math.asin(Math.max(-1, Math.min(1, ly))) * RAD2DEG, lonDeg: Math.atan2(-lz, lx) * RAD2DEG };
}

// ---- render support: the globe's ribbon and the shadow chase ------------------------------------------
//
// The globe's geometry frame ("Earth geometry-local", frames.latLonToLocal): x = cos φ cos λ,
// y = sin φ, z = −cos φ sin λ. The ribbon and the pin sit there at the geodetic lat/lon on the
// sphere (≤ 21 km off the ellipsoid, a tenth of the band's width).

const EARTH_MEAN_KM = 6371.0088;

/** Geometry-local unit vector of a geodetic lat/lon into out[o..o+2]. */
function localUnit(latDeg, lonDeg, out, o = 0) {
    const p = latDeg * DEG2RAD, l = lonDeg * DEG2RAD, c = Math.cos(p);
    out[o] = c * Math.cos(l);
    out[o + 1] = Math.sin(p);
    out[o + 2] = -c * Math.sin(l);
}

/** Slerp of unit vectors a → b by f into out (all Float64Array(3); out may not alias a or b). */
function slerpUnit(a, b, f, out) {
    const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const ang = Math.acos(d);
    let wa = 1 - f, wb = f;
    if (ang > 1e-6) {
        const s = Math.sin(ang);
        wa = Math.sin((1 - f) * ang) / s;
        wb = Math.sin(f * ang) / s;
    }
    const x = a[0] * wa + b[0] * wb, y = a[1] * wa + b[1] * wb, z = a[2] * wa + b[2] * wb;
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
}

const cA = new Float64Array(3), cB = new Float64Array(3), cP = new Float64Array(3);

/** The centre line at tMs into out (geometry-local unit vector); NaN outside the path, else radius km. */
function centreAt(s, n, st, tMs, out) {
    if (!(tMs >= s[0] && tMs <= s[(n - 1) * st])) return NaN;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (s[mid * st] <= tMs) lo = mid; else hi = mid;
    }
    const a = lo * st, b = hi * st;
    const f = s[b] > s[a] ? (tMs - s[a]) / (s[b] - s[a]) : 0;
    localUnit(s[a + 1], s[a + 2], cA);
    localUnit(s[b + 1], s[b + 2], cB);
    const x = cA[0] + (cB[0] - cA[0]) * f, y = cA[1] + (cB[1] - cA[1]) * f, z = cA[2] + (cB[2] - cA[2]) * f;
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return s[a + 7] + (s[b + 7] - s[a + 7]) * f;
}

/**
 * The shadow on the path at tMs in the globe's geometry frame, allocation-free (per-frame use):
 * the centre point (unit vector, interpolated through unit vectors like pathAt) into `pos`, and the
 * shadow's direction of motion over the ground into `fwd` (unit, square to `pos`; from the centre
 * line ±halfMs, one-sided at the ends).
 * @param {EclipsePath} path
 * @param {number} tMs
 * @param {Float64Array} pos 3
 * @param {Float64Array} [fwd] 3
 * @param {number} [halfMs=30000]
 * @returns {number} the signed shadow radius (km; + umbra, − antumbra), or NaN outside
 *   [startMs, endMs] (pos and fwd untouched)
 */
export function pathFrameLocal(path, tMs, pos, fwd, halfMs = 30e3) {
    const s = path?.samples, n = path?.count ?? 0, st = path?.stride ?? PATH_STRIDE;
    if (!s || n < 2) return NaN;
    const r = centreAt(s, n, st, tMs, pos);
    if (!Number.isFinite(r) || !fwd) return r;
    const t0 = Math.max(s[0], tMs - halfMs), t1 = Math.min(s[(n - 1) * st], tMs + halfMs);
    centreAt(s, n, st, t0, cP);
    const px = cP[0], py = cP[1], pz = cP[2];
    centreAt(s, n, st, t1, cP);
    let x = cP[0] - px, y = cP[1] - py, z = cP[2] - pz;
    const d = x * pos[0] + y * pos[1] + z * pos[2];
    x -= d * pos[0]; y -= d * pos[1]; z -= d * pos[2];
    const l = Math.hypot(x, y, z);
    if (l > 1e-12) {
        fwd[0] = x / l; fwd[1] = y / l; fwd[2] = z / l;
    } else {
        // No motion (a degenerate path): any tangent, the local east.
        const e = Math.hypot(pos[0], pos[2]) || 1;
        fwd[0] = pos[2] / e; fwd[1] = 0; fwd[2] = -pos[0] / e;
    }
    return r;
}

/**
 * Mesh data for the globe's ribbon of a central eclipse, built once per eclipse (the render module
 * wraps it in a BufferGeometry). Each sample row gives `cols` vertices across the band, from the
 * southern limit through the centre line to the northern one, slerped on the sphere so the wide,
 * fanned ends stay on it, at `radius` (Earth radii) in the globe's geometry frame.
 * `attr` holds 4 floats per vertex: v (−1 south limit, 0 centre, +1 north limit), t (s since
 * startMs), the along-track distance of the centre line (km), and w = ±(1 + Sun altitude °) with the
 * sign of the shadow radius (+ total, − annular). `index` triangulates the rows (two per cell).
 * @param {EclipsePath} path
 * @param {{radius?:number, cols?:number}} [opts] cols: odd, ≥ 3 (default 9)
 * @returns {{position:Float32Array, attr:Float32Array, index:Uint16Array|Uint32Array,
 *            vertexCount:number, rows:number, cols:number, durationS:number}|null}
 */
export function ribbonMesh(path, { radius = 1.007, cols = 9 } = {}) {
    const s = path?.samples, n = path?.count ?? 0, st = path?.stride ?? PATH_STRIDE;
    if (!s || n < 2) return null;
    const C = Math.max(3, Math.floor(Number(cols) || 9) | 1);
    const half = (C - 1) / 2;
    const R = Number(radius) > 0 ? Number(radius) : 1.007;
    const vertexCount = n * C;
    const position = new Float32Array(vertexCount * 3), attr = new Float32Array(vertexCount * 4);
    const c = new Float64Array(3), prev = new Float64Array(3), lim = new Float64Array(3), q = new Float64Array(3);
    let along = 0;
    for (let i = 0; i < n; i++) {
        const r = i * st;
        localUnit(s[r + 1], s[r + 2], c);
        if (i > 0) along += Math.acos(Math.max(-1, Math.min(1, c[0] * prev[0] + c[1] * prev[1] + c[2] * prev[2]))) * EARTH_MEAN_KM;
        prev.set(c);
        const tS = (s[r] - s[0]) / 1000;
        const w = (s[r + 7] >= 0 ? 1 : -1) * (1 + Math.max(0, Math.min(89, s[r + 8] || 0)));
        for (let j = 0; j < C; j++) {
            const v = (j - half) / half;
            if (v === 0) q.set(c);
            else {
                const iLat = v > 0 ? 3 : 5;
                if (Number.isFinite(s[r + iLat]) && Number.isFinite(s[r + iLat + 1])) {
                    localUnit(s[r + iLat], s[r + iLat + 1], lim);
                    slerpUnit(c, lim, Math.abs(v), q);
                } else q.set(c);
            }
            const k = i * C + j;
            position[k * 3] = q[0] * R;
            position[k * 3 + 1] = q[1] * R;
            position[k * 3 + 2] = q[2] * R;
            attr[k * 4] = v;
            attr[k * 4 + 1] = tS;
            attr[k * 4 + 2] = along;
            attr[k * 4 + 3] = w;
        }
    }
    const index = vertexCount > 65535 ? new Uint32Array((n - 1) * (C - 1) * 6) : new Uint16Array((n - 1) * (C - 1) * 6);
    let o = 0;
    for (let i = 0; i + 1 < n; i++) {
        for (let j = 0; j + 1 < C; j++) {
            const a = i * C + j, b = a + 1, d = a + C, e = d + 1;
            index[o++] = a; index[o++] = d; index[o++] = b;
            index[o++] = b; index[o++] = d; index[o++] = e;
        }
    }
    return { position, attr, index, vertexCount, rows: n, cols: C, durationS: (s[(n - 1) * st] - s[0]) / 1000 };
}
