/**
 * The geomagnetic frame and the auroral ovals (docs/ASTRONOMY.md "Aurora").
 *
 *  - Dipole axis: the centred dipole of IGRF-14 (g10, g11, h11), linear between the 5-year
 *    epochs 1900–2025 and extrapolated with the 2025–2030 secular variation. Outside 1900–2030
 *    the nearest end is held: the field is not modelled for the clock's full 1000–3000 range, so
 *    the pole of 1900 or 2030 is drawn instead. 2025: 80.8° N, 72.8° W.
 *  - Oval boundaries: Starkov (1994, Geomagn. Aeron. 34, 331) as tabulated by Sigernes et al.
 *    (2011, Opt. Pura Apl. 44, 599, Table 1): the poleward and equatorward edges of the auroral
 *    oval in corrected geomagnetic colatitude, θ = A0 + Σ Ai·cos(15°·(i·t + αi)) over magnetic
 *    local time t, each Ai and αi a cubic in log10|AL|, with AL = 18 − 12.3·Kp + 27.2·Kp² − 2·Kp³.
 *    The centred dipole stands in for corrected geomagnetic coordinates (a few degrees off in
 *    places), and the same oval is mirrored into the south.
 *
 * Activity is a setting (quiet / typical / storm → Kp 1 / 3 / 7), never live data: the app is
 * offline-first and fetches no space-weather feed. The oval sits where the statistical model puts
 * it for that Kp, UTC and season; the curtains drawn inside it are illustrative.
 *
 * Pure: no DOM, no three.js. computeAurora allocates nothing.
 *
 * @module astro/geomag
 */
import { DEG2RAD, RAD2DEG, latLonToLocal, m4MulDir } from './frames.js';

/** IGRF-14 dipole coefficients (nT): [year, g10, g11, h11]. DGRF through 2020, IGRF 2025. */
export const IGRF_DIPOLE = Object.freeze([
    [1900, -31543, -2298, 5922], [1905, -31464, -2298, 5909], [1910, -31354, -2297, 5898],
    [1915, -31212, -2306, 5875], [1920, -31060, -2317, 5845], [1925, -30926, -2318, 5817],
    [1930, -30805, -2316, 5808], [1935, -30715, -2306, 5812], [1940, -30654, -2292, 5821],
    [1945, -30594, -2285, 5810], [1950, -30554, -2250, 5815], [1955, -30500, -2215, 5820],
    [1960, -30421, -2169, 5791], [1965, -30334, -2119, 5776], [1970, -30220, -2068, 5737],
    [1975, -30100, -2013, 5675], [1980, -29992, -1956, 5604], [1985, -29873, -1905, 5500],
    [1990, -29775, -1848, 5406], [1995, -29692, -1784, 5306], [2000, -29619.4, -1728.2, 5186.1],
    [2005, -29554.63, -1669.05, 5077.99], [2010, -29496.57, -1586.42, 4944.26],
    [2015, -29441.46, -1501.77, 4795.99], [2020, -29403.41, -1451.37, 4653.35],
    [2025, -29350.0, -1410.3, 4545.5],
].map((r) => Object.freeze(r)));
/** IGRF-14 secular variation 2025–2030 (nT/yr) of g10, g11, h11. */
export const IGRF_SV = Object.freeze([12.6, 10.0, -21.5]);
/** The years the dipole is modelled for; outside them the nearest end is used. */
export const IGRF_FIRST_YEAR = 1900;
export const IGRF_LAST_YEAR = 2030;

/** Activity setting → Kp (display.aurora; 'Aurora activity' in Settings, `au=` in the URL). */
export const AURORA_KP = Object.freeze({ quiet: 1, typical: 3, storm: 7 });
export const AURORA_SETTINGS = Object.freeze(Object.keys(AURORA_KP));

/** Bins of magnetic local time in the boundary table (one per hour). */
export const OVAL_BINS = 24;
/** Period (simulated seconds) of the curtains' animation phase. */
export const AURORA_PERIOD_S = 65536;

// Starkov (1994) via Sigernes et al. (2011) Table 1: rows A0, A1, A2, A3, α1, α2, α3, each b0…b3.
const STARKOV_POLEWARD = Object.freeze([
    [-0.07, 24.54, -12.53, 2.15], [-10.06, 19.83, -9.33, 1.24], [-4.44, 7.47, -3.01, 0.25], [-3.77, 7.90, -4.73, 0.91],
    [-6.61, 10.17, -5.80, 1.19], [6.37, -1.10, 0.34, -0.38], [-4.48, 10.16, -5.87, 0.98],
]);
const STARKOV_EQUATORWARD = Object.freeze([
    [1.61, 23.21, -10.97, 2.03], [-9.59, 17.78, -7.20, 0.96], [-12.07, 17.49, -7.96, 1.15], [-6.56, 11.44, -6.73, 1.31],
    [-2.22, 1.50, -0.58, 0.08], [-23.98, 42.79, -26.96, 5.56], [-20.07, 36.67, -24.20, 5.11],
]);

const MS_PER_YEAR = 365.25 * 86400e3;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const COEF = new Float64Array(7);
const LOCAL = new Float64Array(3);
const DIPOLE = { latDeg: 0, lonDeg: 0 };

/**
 * AL index (nT, magnitude) for a Kp value (Starkov 1994b, as used by Sigernes et al. 2011).
 * @param {number} kp 0…9
 * @returns {number}
 */
export function kpToAL(kp) {
    const k = Math.min(9, Math.max(0, Number.isFinite(kp) ? kp : 0));
    return 18 - 12.3 * k + 27.2 * k * k - 2 * k * k * k;
}

/** Decimal year of a UTC instant (Julian years from J2000: plenty for a field that drifts ~0.05°/yr). */
export function decimalYear(tMs) {
    return 2000 + (tMs - J2000_MS) / MS_PER_YEAR;
}

/**
 * The geomagnetic north pole (the boreal end of the centred dipole axis) at a UTC instant,
 * clamped to the IGRF years 1900–2030.
 * @param {number} tMs
 * @param {{latDeg:number, lonDeg:number}} [out]
 * @returns {{latDeg:number, lonDeg:number}}
 */
export function dipolePole(tMs, out = { latDeg: 0, lonDeg: 0 }) {
    const y = Math.min(IGRF_LAST_YEAR, Math.max(IGRF_FIRST_YEAR, Number.isFinite(tMs) ? decimalYear(tMs) : 2025));
    let g10, g11, h11;
    const last = IGRF_DIPOLE[IGRF_DIPOLE.length - 1];
    if (y >= last[0]) {
        const dy = y - last[0];
        g10 = last[1] + IGRF_SV[0] * dy;
        g11 = last[2] + IGRF_SV[1] * dy;
        h11 = last[3] + IGRF_SV[2] * dy;
    } else {
        const i = Math.min(IGRF_DIPOLE.length - 2, Math.floor((y - IGRF_FIRST_YEAR) / 5));
        const a = IGRF_DIPOLE[i], b = IGRF_DIPOLE[i + 1];
        const f = (y - a[0]) / (b[0] - a[0]);
        g10 = a[1] + (b[1] - a[1]) * f;
        g11 = a[2] + (b[2] - a[2]) * f;
        h11 = a[3] + (b[3] - a[3]) * f;
    }
    // The dipole moment points south; its boreal pole is at −(g11, h11, g10)/B0 (Earth-fixed x, y, z).
    out.latDeg = Math.atan2(-g10, Math.hypot(g11, h11)) * RAD2DEG;
    out.lonDeg = Math.atan2(-h11, -g11) * RAD2DEG;
    return out;
}

function starkovCoefs(table, lgAL) {
    const l2 = lgAL * lgAL, l3 = l2 * lgAL;
    for (let i = 0; i < 7; i++) {
        const b = table[i];
        COEF[i] = b[0] + b[1] * lgAL + b[2] * l2 + b[3] * l3;
    }
    return COEF;
}

function boundaryLat(c, mltH) {
    const d = 15 * DEG2RAD;
    const colat = c[0] + c[1] * Math.cos(d * (mltH + c[4])) + c[2] * Math.cos(d * (2 * mltH + c[5]))
        + c[3] * Math.cos(d * (3 * mltH + c[6]));
    return 90 - Math.max(colat, 0);
}

/**
 * Oval boundaries for a Kp value: out[h] is the equatorward edge and out[24 + h] the poleward edge,
 * geomagnetic latitude in degrees, at magnetic local time h = 0…23 hours.
 * @param {number} kp
 * @param {Float32Array|Float64Array|number[]} [out] 48 entries
 * @returns {Float32Array|Float64Array|number[]}
 */
export function ovalBoundaries(kp, out = new Float32Array(2 * OVAL_BINS)) {
    const lg = Math.log10(Math.max(Math.abs(kpToAL(kp)), 1));
    const eq = starkovCoefs(STARKOV_EQUATORWARD, lg);
    for (let h = 0; h < OVAL_BINS; h++) out[h] = boundaryLat(eq, h);
    const po = starkovCoefs(STARKOV_POLEWARD, lg);
    for (let h = 0; h < OVAL_BINS; h++) {
        // The fit can cross the equatorward edge at extreme activity: keep the band at least 1° wide.
        out[OVAL_BINS + h] = Math.max(boundaryLat(po, h), out[h] + 1);
    }
    return out;
}

/**
 * @typedef {{activity:string, kp:number, poleLatDeg:number, poleLonDeg:number,
 *   poleS:Float64Array, noonS:Float64Array, ovals:Float32Array, minEqDeg:number, phase:number}} Aurora
 * poleS: the geomagnetic north pole (unit, scene frame); noonS: unit, perpendicular to it, toward
 * the Sun (magnetic noon); ovals: {@link ovalBoundaries}; minEqDeg: the oval's lowest equatorward
 * edge; phase: simulated time in [0, 1) of an AURORA_PERIOD_S cycle (the curtains' animation).
 */

/**
 * A valid placeholder ('typical' ovals around the geographic pole) until computeAurora runs.
 * @returns {Aurora}
 */
export function createAurora() {
    const ovals = ovalBoundaries(AURORA_KP.typical, new Float32Array(2 * OVAL_BINS));
    let minEqDeg = 90;
    for (let h = 0; h < OVAL_BINS; h++) minEqDeg = Math.min(minEqDeg, ovals[h]);
    return {
        activity: 'typical', kp: AURORA_KP.typical, poleLatDeg: 90, poleLonDeg: 0,
        poleS: new Float64Array([0, 1, 0]), noonS: new Float64Array([1, 0, 0]),
        ovals, minEqDeg, phase: 0,
    };
}

/**
 * Fills `out` (snap.aurora) for a snapshot and an activity setting. Allocation-free; the boundary
 * table is only recomputed when the activity changes.
 * @param {import('../core/types.js').Snapshot} snap
 * @param {string} activity one of AURORA_SETTINGS (anything else reads as 'typical')
 * @param {Aurora} out
 * @returns {Aurora}
 */
export function computeAurora(snap, activity, out) {
    const act = AURORA_KP[activity] !== undefined ? activity : 'typical';
    if (act !== out.activity) {
        out.activity = act;
        out.kp = AURORA_KP[act];
        ovalBoundaries(out.kp, out.ovals);
        let m = 90;
        for (let h = 0; h < OVAL_BINS; h++) m = Math.min(m, out.ovals[h]);
        out.minEqDeg = m;
    }
    dipolePole(snap.tMs, DIPOLE);
    out.poleLatDeg = DIPOLE.latDeg;
    out.poleLonDeg = DIPOLE.lonDeg;
    latLonToLocal(DIPOLE.latDeg, DIPOLE.lonDeg, LOCAL);
    const p = m4MulDir(snap.earthMatrix, LOCAL, out.poleS);
    // Magnetic noon: the Sun's direction with its component along the pole removed.
    const s = snap.sunDirS;
    const k = s[0] * p[0] + s[1] * p[1] + s[2] * p[2];
    let nx = s[0] - k * p[0], ny = s[1] - k * p[1], nz = s[2] - k * p[2];
    const n = Math.hypot(nx, ny, nz);
    if (n > 1e-9) { nx /= n; ny /= n; nz /= n; } else { nx = 1; ny = 0; nz = 0; }
    out.noonS[0] = nx;
    out.noonS[1] = ny;
    out.noonS[2] = nz;
    const ts = Number.isFinite(snap.tMs) ? snap.tMs / 1000 : 0;
    const ph = ts / AURORA_PERIOD_S;
    out.phase = ph - Math.floor(ph);
    return out;
}

/**
 * Geomagnetic latitude (deg) and magnetic local time (hours, [0, 24)) of a scene-frame unit
 * vector on the Earth, from a filled Aurora.
 * @param {ArrayLike<number>} dirS
 * @param {Aurora} aur
 * @param {{magLatDeg:number, mltH:number}} [out]
 */
export function magCoords(dirS, aur, out = { magLatDeg: 0, mltH: 0 }) {
    const p = aur.poleS, n = aur.noonS;
    const m = dirS[0] * p[0] + dirS[1] * p[1] + dirS[2] * p[2];
    // dusk = pole × noon (90° east of noon, MLT 18).
    const ex = p[1] * n[2] - p[2] * n[1], ey = p[2] * n[0] - p[0] * n[2], ez = p[0] * n[1] - p[1] * n[0];
    const x = dirS[0] * n[0] + dirS[1] * n[1] + dirS[2] * n[2];
    const y = dirS[0] * ex + dirS[1] * ey + dirS[2] * ez;
    out.magLatDeg = Math.asin(Math.max(-1, Math.min(1, m))) * RAD2DEG;
    const h = 12 + Math.atan2(y, x) * (12 / Math.PI);
    out.mltH = h >= 24 ? h - 24 : h;
    return out;
}

/**
 * The oval's edges (deg) at a magnetic local time, interpolated like the shaders do.
 * @param {Aurora} aur
 * @param {number} mltH
 * @returns {{eqDeg:number, poleDeg:number}}
 */
export function ovalAt(aur, mltH) {
    const h = ((mltH % 24) + 24) % 24;
    const i0 = Math.floor(h), f = h - i0, i1 = (i0 + 1) % OVAL_BINS;
    const o = aur.ovals;
    return {
        eqDeg: o[i0] + (o[i1] - o[i0]) * f,
        poleDeg: o[OVAL_BINS + i0] + (o[OVAL_BINS + i1] - o[OVAL_BINS + i0]) * f,
    };
}

const MC = { magLatDeg: 0, mltH: 0 };

/**
 * One line about the modelled aurora at the observer for the Sky panel, or '' when there is
 * nothing to say: in daylight or twilight (Sun above −12°), or when the oval is out of sight
 * (more than about 8° of latitude, roughly 900 km, poleward of the observer).
 * @param {import('../core/types.js').Snapshot} snap
 * @returns {string}
 */
export function auroraText(snap) {
    if (snap?.host === 'mars') return '';   // the Earth's ovals mean nothing from Mars
    const aur = snap?.aurora, obs = snap?.observer;
    if (!aur || !obs || !obs.posS || !Number.isFinite(aur.kp)) return '';
    if (!(obs.sunAltDeg <= -12)) return '';
    magCoords(obs.posS, aur, MC);
    const lat = Math.abs(MC.magLatDeg);
    const { eqDeg, poleDeg } = ovalAt(aur, MC.mltH);
    const tag = `modelled Kp ${aur.kp}, not a forecast`;
    const side = MC.magLatDeg >= 0 ? 'north' : 'south';
    if (lat >= eqDeg - 1 && lat <= poleDeg + 1) return `Under the aurora oval (${tag})`;
    if (lat > poleDeg + 1) return lat - poleDeg < 8 ? `Aurora oval to the ${side === 'north' ? 'south' : 'north'} (${tag})` : '';
    if (eqDeg - lat < 8) return `Aurora oval low in the ${side} (${tag})`;
    return '';
}

/**
 * Settings hint for an activity: where the oval's equatorward edge reaches near midnight.
 * @param {string} activity
 * @returns {string}
 */
export function ovalSummary(activity) {
    const kp = AURORA_KP[activity] ?? AURORA_KP.typical;
    const t = ovalBoundaries(kp, new Float64Array(2 * OVAL_BINS));
    let m = 90;
    for (let h = 0; h < OVAL_BINS; h++) m = Math.min(m, t[h]);
    return `Kp ${kp}: the oval reaches down to about ${Math.round(m)}° geomagnetic latitude near midnight. `
        + 'A statistical model, not live space weather.';
}
