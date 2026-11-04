/**
 * Comets (pure): Halley's Comet at five apparitions — 1066, 1456, 1910, 1986 and 2061 — by
 * two-body Kepler propagation from per-apparition osculating elements, with light time, a
 * magnitude law, and the geometry of an ion tail and a curved dust tail.
 *
 * Elements are heliocentric, referred to the ecliptic and equinox of J2000 (JPL Horizons:
 * DASTCOM records 90000018 [solution SAO/1066], 90000023 [1456], 90000029 [1910], and the 1986
 * and 2061 osculating elements at perihelion integrated from record 90000030). The SAO
 * solutions for the old apparitions go back to Yeomans & Kiang (1981, MNRAS 197, 633), whose
 * tables are referred to B1950.0; Horizons serves them rotated to J2000. `elementsB1950ToJ2000`
 * performs that rotation (FK4 → FK5) for elements quoted in B1950 — without it a medieval position
 * would be off by the 0.7° the equinox moved in 50 years, on top of the T and ΔT uncertainty.
 *
 * Accuracy: arcminutes for 1910 and 1986 (checked against Horizons in test/astro.comets.test.mjs),
 * about a degree for 1066 and 1456 (perihelion time and ΔT uncertainty). Outside ±1.5 years of a
 * perihelion there are no elements and the comet is not shown. The tails are a physically guided
 * model (direction and curvature from the geometry, length and brightness illustrative), not a
 * prediction (docs/ASTRONOMY.md §5b).
 *
 * @module astro/comets
 */

import { AE } from './ae.js';
import { topocentricScene } from './extras.js';
import { fmtDate } from '../core/format.js';
import { LIGHT_S_PER_AU, AU_KM } from './bodies.js';

const DEG = Math.PI / 180;
/** Gaussian gravitational constant, rad/day (heliocentric two-body motion). */
export const GAUSS_K = 0.01720209895;
/** Obliquity of the J2000 ecliptic used by Horizons' ecliptic elements (IAU 1976: 84381.448″). */
const EPS_J2000 = 84381.448 / 3600 * DEG;
/** Obliquity of the B1950 ecliptic (23°26′44.836″). */
const EPS_B1950 = 23.4457889 * DEG;
const LIGHT_DAY_PER_AU = LIGHT_S_PER_AU / 86400;
const JD_J2000 = 2451545.0;
/** Days either side of perihelion that an element set is used. */
export const VALID_DAYS = 548;
/** Samples along each tail (render/comets.js draws a strip through them). */
export const TAIL_SAMPLES = 12;
/** Drawn while brighter than this (a comet fainter than it is a telescopic smudge). */
const SHOW_MAG = 9;
const COMA_KM = 120000;

/**
 * FK4 (B1950.0) → FK5 (J2000.0) rotation for equatorial vectors (Standish 1982; the matrix used by
 * JPL and the Explanatory Supplement), row-major.
 */
const FK4_TO_FK5 = [
    0.9999256782, -0.0111820611, -0.0048579477,
    0.0111820610, 0.9999374784, -0.0000271765,
    0.0048579479, -0.0000271474, 0.9999881997,
];

/**
 * @typedef {{ year:number, q:number, e:number, iDeg:number, nodeDeg:number, periDeg:number, tpJd:number,
 *   M1:number, k1:number, approx:boolean, note:string, source:string }} Apparition
 */

/** Halley's Comet: elements per apparition (J2000 ecliptic; tpJd in TDB), magnitude law M1 + 5 log Δ + k1 log r. */
export const HALLEY = Object.freeze([
    { year: 1066, q: 0.5745, e: 0.96887, iDeg: 163.112, nodeDeg: 47.624, periDeg: 102.473, tpJd: 2110493.434, approx: true,
        note: 'The Anglo-Saxon Chronicle saw “a sign such as men never saw before” from 24 April 1066; months later William won at Hastings, and the Bayeux Tapestry shows the star with the words ISTI MIRANT STELLA.',
        source: 'JPL Horizons, DASTCOM record 90000018 (solution SAO/1066, after Yeomans & Kiang 1981)' },
    { year: 1456, q: 0.5797, e: 0.968, iDeg: 162.89, nodeDeg: 51.866, periDeg: 105.835, tpJd: 2253022.133, approx: true,
        note: 'Paolo Toscanelli measured its path from Florence in June 1456. The story of a pope excommunicating the comet is a later invention.',
        source: 'JPL Horizons, DASTCOM record 90000023' },
    { year: 1910, q: 0.587208, e: 0.967302, iDeg: 162.2186, nodeDeg: 58.5629, periDeg: 111.7371, tpJd: 2418781.6785, approx: false,
        note: 'On 19 May 1910 the Earth passed through its tail; newspapers sold “comet pills”. Its dawn tail stretched across a third of the sky.',
        source: 'JPL Horizons, DASTCOM record 90000029' },
    { year: 1986, q: 0.5871034489, e: 0.9672792272, iDeg: 162.2422243, nodeDeg: 58.8599364, periDeg: 111.8655481, tpJd: 2446470.958961, approx: false,
        note: 'The poorest showing in two thousand years from the ground, but five spacecraft met it; Giotto photographed the nucleus from 600 km.',
        source: 'JPL Horizons, osculating elements at 1986-02-09 from record 90000030' },
    { year: 2061, q: 0.5927819456, e: 0.9665767671, iDeg: 161.9651213, nodeDeg: 59.3923157, periDeg: 112.0521038, tpJd: 2474034.220125, approx: false,
        note: 'Its next return: perihelion on 28 July 2061, on the same side of the Sun as the Earth this time, so a far better view than 1986.',
        source: 'JPL Horizons, osculating elements at 2061-07-28 from record 90000030 (a prediction)' },
].map((a) => Object.freeze({ ...a, M1: 5.5, k1: 8 })));

// ───────────────────────────────── Kepler's equation ─────────────────────────────────

/**
 * Solves Kepler's equation for the eccentric anomaly: E − e sin E = M (e < 1), Newton's method from
 * Danby's starter; converges for every e < 1 and M.
 * @param {number} M mean anomaly, rad
 * @param {number} e
 * @returns {number} E, rad
 */
export function solveKeplerElliptic(M, e) {
    const m = M - 2 * Math.PI * Math.round(M / (2 * Math.PI));
    let E = m + 0.85 * e * Math.sign(Math.sin(m) || 1);
    for (let k = 0; k < 50; k++) {
        const f = E - e * Math.sin(E) - m;
        const d = f / (1 - e * Math.cos(E));
        E -= d;
        if (Math.abs(d) < 1e-14) break;
    }
    return E + (M - m);
}

/**
 * Hyperbolic Kepler equation e sinh H − H = M (e > 1), Newton's method.
 * @param {number} M
 * @param {number} e
 * @returns {number} H
 */
export function solveKeplerHyperbolic(M, e) {
    let H = Math.asinh(M / e);
    for (let k = 0; k < 80; k++) {
        const f = e * Math.sinh(H) - H - M;
        const d = f / (e * Math.cosh(H) - 1);
        H -= d;
        if (Math.abs(d) < 1e-14) break;
    }
    return H;
}

/**
 * Barker's equation for a parabola (e = 1): the true anomaly ν after `dtDays` from perihelion
 * distance q (AU): tan(ν/2) = s with s³/3 + s = W, W = 3k·dt / √(2q³)… solved in closed form.
 * @param {number} dtDays
 * @param {number} q
 * @returns {number} ν, rad
 */
export function solveBarker(dtDays, q) {
    const W = 3 * GAUSS_K * dtDays / Math.sqrt(2 * q * q * q);
    const Y = Math.cbrt(W / 2 + Math.sqrt(W * W / 4 + 1));
    const s = Y - 1 / Y;
    return 2 * Math.atan(s);
}

/**
 * Heliocentric position and velocity in the orbit's own plane (x toward perihelion), AU and
 * AU/day, `dtDays` after perihelion, for any conic.
 * @returns {{x:number, y:number, vx:number, vy:number, r:number}}
 */
export function orbitPlaneState(q, e, dtDays, out = { x: 0, y: 0, vx: 0, vy: 0, r: 0 }) {
    if (Math.abs(e - 1) < 1e-9) {
        const nu = solveBarker(dtDays, q);
        const p = 2 * q;
        const r = p / (1 + Math.cos(nu));
        out.x = r * Math.cos(nu); out.y = r * Math.sin(nu); out.r = r;
        out.vx = -GAUSS_K / Math.sqrt(p) * Math.sin(nu);
        out.vy = GAUSS_K / Math.sqrt(p) * (1 + Math.cos(nu));
        return out;
    }
    const a = q / (1 - e);   // negative for a hyperbola
    const n = GAUSS_K / Math.sqrt(Math.abs(a) ** 3);
    const M = n * dtDays;
    if (e < 1) {
        const E = solveKeplerElliptic(M, e);
        const c = Math.cos(E), s = Math.sin(E), b = Math.sqrt(1 - e * e);
        const den = 1 - e * c;
        out.x = a * (c - e); out.y = a * b * s; out.r = a * den;
        out.vx = -a * n * s / den; out.vy = a * n * b * c / den;
    } else {
        const H = solveKeplerHyperbolic(M, e);
        const ch = Math.cosh(H), sh = Math.sinh(H), b = Math.sqrt(e * e - 1), A = -a;
        const den = e * ch - 1;
        out.x = A * (e - ch); out.y = A * b * sh; out.r = A * den;
        out.vx = -A * n * sh / den; out.vy = A * n * b * ch / den;
    }
    return out;
}

/** The P, Q unit vectors (perihelion, and 90° ahead) of an orbit in its reference ecliptic. */
function orientation(iDeg, nodeDeg, periDeg, P, Q) {
    const ci = Math.cos(iDeg * DEG), si = Math.sin(iDeg * DEG);
    const cO = Math.cos(nodeDeg * DEG), sO = Math.sin(nodeDeg * DEG);
    const cw = Math.cos(periDeg * DEG), sw = Math.sin(periDeg * DEG);
    P[0] = cw * cO - sw * sO * ci; P[1] = cw * sO + sw * cO * ci; P[2] = sw * si;
    Q[0] = -sw * cO - cw * sO * ci; Q[1] = -sw * sO + cw * cO * ci; Q[2] = cw * si;
}

/** Ecliptic (obliquity eps) → equatorial, in place. */
function eclToEq(v, eps) {
    const c = Math.cos(eps), s = Math.sin(eps);
    const y = v[1], z = v[2];
    v[1] = y * c - z * s;
    v[2] = y * s + z * c;
}

/** Equatorial → ecliptic (obliquity eps), in place. */
function eqToEcl(v, eps) {
    const c = Math.cos(eps), s = Math.sin(eps);
    const y = v[1], z = v[2];
    v[1] = y * c + z * s;
    v[2] = -y * s + z * c;
}

/** i, Ω, ω (degrees) from an orbit's P and Q in an ecliptic frame. */
function anglesOf(P, Q) {
    const W = [P[1] * Q[2] - P[2] * Q[1], P[2] * Q[0] - P[0] * Q[2], P[0] * Q[1] - P[1] * Q[0]];
    const i = Math.acos(Math.max(-1, Math.min(1, W[2])));
    const node = Math.atan2(W[0], -W[1]);
    const peri = Math.atan2(P[2] / Math.sin(i), P[0] * Math.cos(node) + P[1] * Math.sin(node));
    const w360 = (x) => ((x / DEG) % 360 + 360) % 360;
    return { iDeg: i / DEG, nodeDeg: w360(node), periDeg: w360(peri) };
}

/**
 * Rotates orbital angles referred to the B1950.0 ecliptic and equinox (Yeomans & Kiang 1981, the
 * older catalogues) into the J2000.0 ecliptic frame: B1950 ecliptic → B1950 equator → FK5 J2000
 * equator (FK4_TO_FK5) → J2000 ecliptic. q, e and T are unchanged.
 * @param {{iDeg:number, nodeDeg:number, periDeg:number}} el
 * @returns {{iDeg:number, nodeDeg:number, periDeg:number}}
 */
export function elementsB1950ToJ2000(el) {
    const P = [0, 0, 0], Q = [0, 0, 0];
    orientation(el.iDeg, el.nodeDeg, el.periDeg, P, Q);
    const rot = (v) => {
        eclToEq(v, EPS_B1950);
        const m = FK4_TO_FK5;
        const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
        const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
        const z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
        v[0] = x; v[1] = y; v[2] = z;
        eqToEcl(v, EPS_J2000);
    };
    rot(P); rot(Q);
    return anglesOf(P, Q);
}

// ───────────────────────────────── positions ─────────────────────────────────

/** Scratch (no allocation per call). */
const _P = new Float64Array(3), _Q = new Float64Array(3), _plane = { x: 0, y: 0, vx: 0, vy: 0, r: 0 };
const _tail = new Float64Array(3);

/**
 * Heliocentric position and velocity of a comet (EQJ, AU and AU/day) at TT days since J2000.
 * @param {Apparition} el
 * @param {number} ttDays
 * @param {Float64Array} pos out, 3
 * @param {Float64Array} [vel] out, 3
 * @returns {number} heliocentric distance r, AU
 */
export function cometHelioEqj(el, ttDays, pos, vel) {
    orientation(el.iDeg, el.nodeDeg, el.periDeg, _P, _Q);
    const s = orbitPlaneState(el.q, el.e, ttDays - (el.tpJd - JD_J2000), _plane);
    for (let k = 0; k < 3; k++) pos[k] = s.x * _P[k] + s.y * _Q[k];
    eclToEq(pos, EPS_J2000);
    if (vel) {
        for (let k = 0; k < 3; k++) vel[k] = s.vx * _P[k] + s.vy * _Q[k];
        eclToEq(vel, EPS_J2000);
    }
    return s.r;
}

/** The apparition whose perihelion is nearest `ttDays` (TT days since J2000), within VALID_DAYS, or null. */
export function apparitionAt(list, ttDays) {
    let best = null, bd = Infinity;
    for (const a of list) {
        const d = Math.abs(ttDays - (a.tpJd - JD_J2000));
        if (d < bd) { bd = d; best = a; }
    }
    return bd <= VALID_DAYS ? best : null;
}

/**
 * Total visual magnitude: m = M1 + 5 log₁₀ Δ + k1 log₁₀ r (Δ, r in AU; JPL's T-mag law).
 * @param {Apparition} el
 * @param {number} r heliocentric distance
 * @param {number} delta distance from the observer
 */
export function cometMagnitude(el, r, delta) {
    return el.M1 + 5 * Math.log10(Math.max(delta, 1e-6)) + el.k1 * Math.log10(Math.max(r, 1e-6));
}

/**
 * Geocentric astrometric position of a comet (EQJ AU, light-time corrected) at UTC `tMs`, given
 * the Earth's heliocentric EQJ position at t. Iterates the light time twice.
 * @param {Apparition} el
 * @param {number} tMs
 * @param {ArrayLike<number>} earthEqj heliocentric Earth, EQJ AU
 * @param {{geo:Float64Array, helio:Float64Array, vel:Float64Array}} out
 * @returns {{r:number, delta:number, tauDays:number}}
 */
export function cometGeocentric(el, tMs, earthEqj, out) {
    const tt = AE.MakeTime(new Date(tMs)).tt;
    let tau = 0, r = 0;
    for (let k = 0; k < 3; k++) {
        r = cometHelioEqj(el, tt - tau, out.helio, out.vel);
        out.geo[0] = out.helio[0] - earthEqj[0];
        out.geo[1] = out.helio[1] - earthEqj[1];
        out.geo[2] = out.helio[2] - earthEqj[2];
        tau = Math.hypot(out.geo[0], out.geo[1], out.geo[2]) * LIGHT_DAY_PER_AU;
    }
    return { r, delta: Math.hypot(out.geo[0], out.geo[1], out.geo[2]), tauDays: tau };
}

// ───────────────────────────────── tails ─────────────────────────────────

/**
 * Tail lengths (AU) and activity from the heliocentric distance: an illustrative model in which
 * the tails grow as r⁻² inside 2.5 AU (sunlight and solar wind), capped at 0.15 AU (ion) and
 * 0.08 AU (dust): about 0.1 AU near perihelion, as Halley's tail measured in 1910 (its visible
 * part; the plasma tail reached further).
 * @param {number} r
 * @returns {{ion:number, dust:number, activity:number}}
 */
export function tailLengths(r) {
    const act = Math.max(0, Math.min(1, (2.5 - r) / 1.5));
    const a = act * act * (3 - 2 * act);
    return { ion: Math.min(0.15, 0.04 / (r * r)) * a, dust: Math.min(0.08, 0.025 / (r * r)) * a, activity: a };
}

/**
 * Fills a comet's tail samples as directions from the observer (scene unit vectors) and their
 * half-widths (radians): the ion tail straight along the anti-Sun direction (the heliocentric
 * radius vector at the light-time epoch), the dust tail curving in the orbit plane, lagging behind
 * the motion. The 3D tips are projected from the observer, so foreshortening comes out right
 * (in May 1910 the Earth was inside the ion tail).
 * @param {{geo:Float64Array, helio:Float64Array, vel:Float64Array}} pv the comet (cometGeocentric's out)
 * @param {number} r
 * @param {any} snap for the observer's place
 * @param {{ion:Float64Array, dust:Float64Array, wIon:Float64Array, wDust:Float64Array}} out
 * @returns {{ion:number, dust:number, activity:number}}
 */
export function fillTails(pv, r, snap, out) {
    const L = tailLengths(r);
    const h = pv.helio, v = pv.vel, g = pv.geo;
    const rh = Math.hypot(h[0], h[1], h[2]) || 1;
    const vn = Math.hypot(v[0], v[1], v[2]) || 1;
    const tmp = _tail;
    for (let k = 0; k < TAIL_SAMPLES; k++) {
        const s = k / (TAIL_SAMPLES - 1);
        // Ion: comet + L·s·r̂.
        let x = g[0] + L.ion * s * h[0] / rh, y = g[1] + L.ion * s * h[1] / rh, z = g[2] + L.ion * s * h[2] / rh;
        let d = topocentricScene(x, z, -y, snap, tmp);
        out.ion[k * 3] = tmp[0]; out.ion[k * 3 + 1] = tmp[1]; out.ion[k * 3 + 2] = tmp[2];
        out.wIon[k] = (0.0006 + 0.003 * s) / Math.max(d, 1e-4);
        // Dust: comet + L·(s·r̂ − 0.55·s²·v̂), in the orbit plane.
        x = g[0] + L.dust * (s * h[0] / rh - 0.55 * s * s * v[0] / vn);
        y = g[1] + L.dust * (s * h[1] / rh - 0.55 * s * s * v[1] / vn);
        z = g[2] + L.dust * (s * h[2] / rh - 0.55 * s * s * v[2] / vn);
        d = topocentricScene(x, z, -y, snap, tmp);
        out.dust[k * 3] = tmp[0]; out.dust[k * 3 + 1] = tmp[1]; out.dust[k * 3 + 2] = tmp[2];
        out.wDust[k] = (0.001 + 0.009 * s) / Math.max(d, 1e-4);
    }
    return L;
}

/**
 * The data a comet's ExtraState carries (preallocated once per state).
 * @returns {{ion:Float64Array, dust:Float64Array, wIon:Float64Array, wDust:Float64Array, comaRad:number,
 *   activity:number, r:number, delta:number, ionAU:number, dustAU:number, tpMs:number, year:number,
 *   pv:{geo:Float64Array, helio:Float64Array, vel:Float64Array}}}
 */
export function createCometData() {
    return {
        ion: new Float64Array(TAIL_SAMPLES * 3), dust: new Float64Array(TAIL_SAMPLES * 3),
        wIon: new Float64Array(TAIL_SAMPLES), wDust: new Float64Array(TAIL_SAMPLES),
        comaRad: 0, activity: 0, r: NaN, delta: NaN, ionAU: 0, dustAU: 0, tpMs: NaN, tpYear: 0, year: 0,
        pv: { geo: new Float64Array(3), helio: new Float64Array(3), vel: new Float64Array(3) },
    };
}

/** UTC ms of a TDB Julian date (TT ≈ TDB; ΔT from Astronomy Engine). */
function tdbJdToUtcMs(jd) {
    const approx = (jd - 2440587.5) * 86400e3;
    const t = AE.MakeTime(new Date(approx));
    return approx - (t.tt - t.ut) * 86400e3;
}

/** The angular length (degrees) of a tail from its first and last samples. */
function tailDeg(arr) {
    const n = TAIL_SAMPLES - 1;
    const c = arr[0] * arr[n * 3] + arr[1] * arr[n * 3 + 1] + arr[2] * arr[n * 3 + 2];
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/**
 * The extras provider for comets (kind 'comet'): Halley's Comet near its 1066, 1456, 1910, 1986
 * and 2061 perihelia.
 * @returns {import('./extras.js').ExtraProvider}
 */
export function createCometProvider() {
    const ids = ['comet:halley'];
    const earth = new Float64Array(3);
    return {
        kind: 'comet',
        kindLabel: 'Comet',
        // Geocentric orbits with the Earth's parallax: not drawn from Mars (astro/extras.js host).
        host: 'earth',
        ids: () => ids,
        meta(id) {
            return id === 'comet:halley' ? { name: 'Halley’s Comet', short: 'Halley', color: '#bfe9ff', glyph: 'coma', label: 'always' } : null;
        },
        fill(snap, id, out) {
            out.present = false;
            if (id !== 'comet:halley' || !snap) return;
            const tt = AE.MakeTime(new Date(snap.tMs)).tt;
            const el = apparitionAt(HALLEY, tt);
            if (!el) return;
            if (!out.data) out.data = createCometData();
            const D = out.data;
            // The snapshot's Earth (heliocentric, scene axes) back to EQJ: S⁻¹(x, y, z) = (x, −z, y).
            const he = snap.helio?.earthS;
            if (!he) return;
            earth[0] = he[0]; earth[1] = -he[2]; earth[2] = he[1];
            const { r } = cometGeocentric(el, snap.tMs, earth, D.pv);
            const g = D.pv.geo;
            const delta = topocentricScene(g[0], g[2], -g[1], snap, out.dirS);
            const mag = cometMagnitude(el, r, delta);
            out.distAU = delta;
            out.mag = mag;
            out.approx = el.approx || Math.abs(tt - (el.tpJd - JD_J2000)) > 365;
            out.present = mag <= SHOW_MAG;
            const L = fillTails(D.pv, r, snap, D);
            D.r = r; D.delta = delta; D.activity = L.activity; D.ionAU = L.ion; D.dustAU = L.dust;
            D.comaRad = COMA_KM / (delta * AU_KM);
            D.year = el.year;
            if (D.tpYear !== el.year) { D.tpMs = tdbJdToUtcMs(el.tpJd); D.tpYear = el.year; }
        },
        card(id, st, snap) {
            const D = st.data;
            if (!D) return null;
            const el = HALLEY.find((a) => a.year === D.year);
            if (!el) return null;
            const days = Math.round((snap.tMs - D.tpMs) / 86400e3);
            const when = days === 0 ? 'at perihelion today' : days < 0 ? `${-days} days before perihelion` : `${days} days after perihelion`;
            const ion = tailDeg(D.ion);
            return {
                kindLabel: `Comet · the ${el.year} apparition`,
                subtitle: `1P/Halley, ${when} (${fmtDate(D.tpMs, 'UTC', { weekday: false })})`,
                lines: [
                    `${D.delta.toFixed(D.delta < 1 ? 3 : 2)} AU from you and ${D.r.toFixed(2)} AU from the Sun; the light you see left it ${fmtLight(st.lightTimeS)} ago.`,
                    el.note,
                ],
                facts: [
                    ['Tails', D.activity > 0.01 ? `ion tail about ${ion < 1 ? ion.toFixed(1) : Math.round(ion)}° long, pointing away from the Sun; a curved dust tail` : 'no tail yet: too far from the Sun'],
                    ['Perihelion', `${el.q.toFixed(3)} AU from the Sun`],
                    ['Orbit', `about 76 years; retrograde, ${Math.round(el.iDeg)}° to the ecliptic`],
                ],
                caveat: `${el.approx ? 'Position approximate (about 1°): the perihelion time and ΔT are uncertain for this apparition. ' : ''}Brightness from JPL’s magnitude law; the tails’ length and glow are a physically guided model, not a prediction.`,
                sources: [el.source],
            };
        },
    };
}

function fmtLight(s) {
    if (!Number.isFinite(s)) return '—';
    if (s < 60) return `${Math.round(s)} s`;
    const m = Math.floor(s / 60), r = Math.round(s - m * 60);
    return m < 60 ? `${m} min ${r} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
