/**
 * Humanity's emissaries (pure): Voyager 1 and 2, New Horizons and JWST, from compact ephemerides
 * (data/craft.json, built by scripts/build-craft.mjs from JPL Horizons heliocentric ICRF states).
 *
 * The file holds knots chosen adaptively (dense near the flybys, sparse on the cruise legs): each
 * knot is a time (TDB Julian date) with position (1e-6 AU) and velocity (1e-8 AU/day), and the
 * position between knots is a cubic Hermite interpolation of the two neighbours. Past the last
 * knot the Voyagers and New Horizons coast in straight lines ('projected'; JPL's trajectories end
 * in 2100 and 2050); JWST, whose orbit after 2031 is unknown, is not shown then.
 *
 * Per snapshot (the extras provider): the topocentric astrometric direction (light-time corrected:
 * where its signal comes from now), the distance, and the one-way radio time ('a message sent now
 * arrives in 23 h 08 min'). For the card: which Deep Space Network complex has it above 6°
 * (a visibility test, not the DSN schedule: 'in view of Canberra').
 *
 * @module astro/craft
 */

import { AE } from './ae.js';
import { AU_KM, AU_ER, LIGHT_S_PER_AU } from './bodies.js';
import { topocentricScene } from './extras.js';
import { latLonToLocal, m4MulDir } from './frames.js';
import { fmtDate } from '../core/format.js';

const JD_J2000 = 2451545.0;
const LIGHT_DAY_PER_AU = LIGHT_S_PER_AU / 86400;
const POS_UNIT = 1e-6;   // AU
const VEL_UNIT = 1e-8;   // AU/day
/** Days a JWST position may be extrapolated past its data (none: its halo orbit after 2031 is unknown). */
const KM_S_PER_AU_DAY = AU_KM / 86400;
/** A DSN dish needs its target this high (degrees). */
export const DSN_MIN_ELEV_DEG = 6;

/** The Deep Space Network's three complexes (geodetic). */
export const DSN = Object.freeze([
    { id: 'goldstone', name: 'Goldstone', latDeg: 35.4267, lonDeg: -116.8900 },
    { id: 'madrid', name: 'Madrid', latDeg: 40.4314, lonDeg: -4.2481 },
    { id: 'canberra', name: 'Canberra', latDeg: -35.4014, lonDeg: 148.9817 },
].map((s) => Object.freeze({ ...s, fixed: latLonToLocal(s.latDeg, s.lonDeg) })));

/** Presentation and history per craft id (data/craft.json supplies the trajectory). */
export const CRAFT_INFO = Object.freeze({
    voyager1: { name: 'Voyager 1', color: '#9fe6ff', extrapolate: true,
        note: 'Flew past Jupiter (1979) and Saturn and Titan (1980); the first human-made object in interstellar space, since 25 August 2012.',
        silent: 2030 },
    voyager2: { name: 'Voyager 2', color: '#c0a8ff', extrapolate: true,
        note: 'The only visitor to Uranus (1986) and Neptune (1989), after Jupiter and Saturn; in interstellar space since 5 November 2018.',
        silent: 2030 },
    newhorizons: { name: 'New Horizons', color: '#ffd59a', extrapolate: true,
        note: 'Flew past Pluto on 14 July 2015 and Arrokoth on 1 January 2019, the most distant world yet visited.',
        silent: 2040 },
    jwst: { name: 'JWST', color: '#ffe27a', extrapolate: false,
        note: 'The James Webb Space Telescope circles the Sun–Earth L2 point, 1.5 million km beyond the Moon, its sunshield keeping the mirror near −233 °C.',
        silent: null },
});

/**
 * @typedef {{ id:string, name:string, color:string, launchMs:number, t:Float64Array, pos:Float64Array, vel:Float64Array,
 *   extrapolate:boolean, note:string, silent:number|null }} Craft
 */

/**
 * Decodes data/craft.json: {v:1, craft:[{id, launch, t0, k:[[dt, x, y, z, vx, vy, vz], …]}]}, where
 * `dt` is days after `t0` (TDB JD) and the rest are integers in 1e-6 AU and 1e-8 AU/day.
 * @param {any} json
 * @returns {Craft[]}
 */
export function decodeCraft(json) {
    if (!json || json.v !== 1 || !Array.isArray(json.craft)) throw new TypeError('craft.json: unexpected format');
    const out = [];
    for (const c of json.craft) {
        const info = CRAFT_INFO[c.id];
        if (!info || !Array.isArray(c.k) || c.k.length < 2) continue;
        const n = c.k.length;
        const t = new Float64Array(n), pos = new Float64Array(n * 3), vel = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const r = c.k[i];
            t[i] = c.t0 + r[0];
            for (let k = 0; k < 3; k++) {
                pos[i * 3 + k] = r[1 + k] * POS_UNIT;
                vel[i * 3 + k] = r[4 + k] * VEL_UNIT;
            }
            if (i > 0 && !(t[i] > t[i - 1])) throw new TypeError(`craft.json: ${c.id} knots out of order`);
        }
        out.push({ id: `craft:${c.id}`, name: info.name, color: info.color, launchMs: Date.parse(c.launch), t, pos, vel,
            extrapolate: info.extrapolate, note: info.note, silent: info.silent });
    }
    return out;
}

/**
 * Cubic Hermite interpolation of one coordinate between two knots (times t0 < t1; values and
 * derivatives per unit time). Exact for cubics.
 */
export function hermite(t0, p0, v0, t1, p1, v1, t) {
    const h = t1 - t0;
    const s = (t - t0) / h;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * h * v0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * h * v1;
}

/** Derivative of {@link hermite} (per unit time). */
function hermiteRate(t0, p0, v0, t1, p1, v1, t) {
    const h = t1 - t0;
    const s = (t - t0) / h;
    const s2 = s * s;
    return ((6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * h * v0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * h * v1) / h;
}

/** Index i of the knot interval [t[i], t[i+1]] holding `jd` (binary search), or −1 outside. */
function interval(t, jd) {
    if (!(jd >= t[0]) || !(jd <= t[t.length - 1])) return -1;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= jd) lo = mid; else hi = mid;
    }
    return lo;
}

/**
 * Heliocentric ICRF (≈ EQJ) position (AU) and velocity (AU/day) of a craft at a TDB Julian date.
 * @param {Craft} c
 * @param {number} jd
 * @param {Float64Array} pos out
 * @param {Float64Array} [vel] out
 * @returns {'data'|'projected'|null} null before the first knot, or past the last for a craft that
 *   is not extrapolated
 */
export function craftStateAt(c, jd, pos, vel) {
    const n = c.t.length;
    const i = interval(c.t, jd);
    if (i >= 0) {
        const t0 = c.t[i], t1 = c.t[i + 1];
        for (let k = 0; k < 3; k++) {
            const p0 = c.pos[i * 3 + k], p1 = c.pos[(i + 1) * 3 + k], v0 = c.vel[i * 3 + k], v1 = c.vel[(i + 1) * 3 + k];
            pos[k] = hermite(t0, p0, v0, t1, p1, v1, jd);
            if (vel) vel[k] = hermiteRate(t0, p0, v0, t1, p1, v1, jd);
        }
        return 'data';
    }
    if (jd > c.t[n - 1] && c.extrapolate) {
        const dt = jd - c.t[n - 1];
        for (let k = 0; k < 3; k++) {
            pos[k] = c.pos[(n - 1) * 3 + k] + c.vel[(n - 1) * 3 + k] * dt;
            if (vel) vel[k] = c.vel[(n - 1) * 3 + k];
        }
        return 'projected';
    }
    return null;
}

const _station = new Float64Array(3);

/**
 * The DSN complexes with the craft at least DSN_MIN_ELEV_DEG above their horizon (geometric,
 * topocentric for each station), given its geocentric position (scene axes, AU).
 * @param {any} snap for the Earth's orientation (earthMatrix)
 * @param {ArrayLike<number>} geoS geocentric position, scene axes, AU
 * @returns {string[]} names, in DSN order
 */
export function dsnInView(snap, geoS) {
    const out = [];
    if (!snap?.earthMatrix) return out;
    const sinMin = Math.sin(DSN_MIN_ELEV_DEG * Math.PI / 180);
    for (const s of DSN) {
        m4MulDir(snap.earthMatrix, s.fixed, _station);
        const x = geoS[0] - _station[0] / AU_ER, y = geoS[1] - _station[1] / AU_ER, z = geoS[2] - _station[2] / AU_ER;
        const d = Math.hypot(x, y, z) || 1;
        if ((x * _station[0] + y * _station[1] + z * _station[2]) / d >= sinMin) out.push(s.name);
    }
    return out;
}

/** "23 h 08 min", "4.9 s", "3 min 12 s", "1 day 2 h" */
export function fmtRadioTime(s) {
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return `${s.toFixed(1)} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h < 48) return m === 60 ? `${h + 1} h 00 min` : `${h} h ${String(m).padStart(2, '0')} min`;
    return `${Math.floor(h / 24)} days ${h % 24} h`;
}

/**
 * The one-way radio time from the Earth (seconds) for a message sent at `jd`: τ with
 * |craft(jd + τ) − Earth(jd)| = c·τ, by fixed-point iteration from the craft's place now.
 * @param {Craft} c
 * @param {number} jd TDB
 * @param {ArrayLike<number>} earthEqj heliocentric Earth at jd, AU
 * @returns {number}
 */
export function radioTimeS(c, jd, earthEqj) {
    const p = new Float64Array(3);
    let tau = 0;
    for (let k = 0; k < 4; k++) {
        if (!craftStateAt(c, jd + tau, p)) return NaN;
        tau = Math.hypot(p[0] - earthEqj[0], p[1] - earthEqj[1], p[2] - earthEqj[2]) * LIGHT_DAY_PER_AU;
    }
    return tau * 86400;
}

/**
 * Per-state data a craft carries (preallocated once per state).
 * @returns {{geoS:Float64Array, helio:Float64Array, vel:Float64Array, mode:string, speedKmS:number, sunAU:number}}
 */
function createCraftData() {
    return { geoS: new Float64Array(3), helio: new Float64Array(3), vel: new Float64Array(3), mode: 'data', speedKmS: NaN, sunAU: NaN };
}

/**
 * The extras provider for spacecraft (kind 'craft', the 'spacecraft' layer).
 * @param {Craft[]} list decodeCraft's output
 * @returns {import('./extras.js').ExtraProvider}
 */
export function createCraftProvider(list) {
    const byId = new Map(list.map((c) => [c.id, c]));
    const ids = list.map((c) => c.id);
    const earth = new Float64Array(3);
    const g = new Float64Array(3);
    return {
        kind: 'craft',
        kindLabel: 'Spacecraft',
        // Radio beams and parallax from the Earth: not drawn from Mars (astro/extras.js host).
        host: 'earth',
        ids: () => ids,
        meta(id) {
            const c = byId.get(id);
            return c ? { name: c.name, color: c.color, glyph: 'marker', label: 'always', layer: 'spacecraft' } : null;
        },
        fill(snap, id, out) {
            out.present = false;
            const c = byId.get(id);
            const he = snap?.helio?.earthS;
            if (!c || !he || !(snap.tMs >= c.launchMs)) return;
            if (!out.data) out.data = createCraftData();
            const D = out.data;
            const jd = AE.MakeTime(new Date(snap.tMs)).tt + JD_J2000;
            earth[0] = he[0]; earth[1] = -he[2]; earth[2] = he[1];
            // Light time: where its signal left from.
            let tau = 0, mode = null;
            for (let k = 0; k < 3; k++) {
                mode = craftStateAt(c, jd - tau, D.helio, D.vel);
                if (!mode) return;
                g[0] = D.helio[0] - earth[0]; g[1] = D.helio[1] - earth[1]; g[2] = D.helio[2] - earth[2];
                tau = Math.hypot(g[0], g[1], g[2]) * LIGHT_DAY_PER_AU;
            }
            D.geoS[0] = g[0]; D.geoS[1] = g[2]; D.geoS[2] = -g[1];
            out.distAU = topocentricScene(D.geoS[0], D.geoS[1], D.geoS[2], snap, out.dirS);
            out.mag = NaN;
            out.approx = mode === 'projected';
            out.present = true;
            D.mode = mode;
            D.speedKmS = Math.hypot(D.vel[0], D.vel[1], D.vel[2]) * KM_S_PER_AU_DAY;
            D.sunAU = Math.hypot(D.helio[0], D.helio[1], D.helio[2]);
        },
        card(id, st, snap) {
            const c = byId.get(id);
            const D = st.data;
            if (!c || !D) return null;
            const jd = AE.MakeTime(new Date(snap.tMs)).tt + JD_J2000;
            const he = snap.helio.earthS;
            const up = radioTimeS(c, jd, [he[0], -he[2], he[1]]);
            const dsn = dsnInView(snap, D.geoS);
            const year = new Date(snap.tMs).getUTCFullYear();
            const silent = c.silent && year >= c.silent;
            const km = st.distAU * AU_KM;
            const kmText = km >= 1e9 ? `${(km / 1e9).toFixed(2)} billion km` : `${(km / 1e6).toFixed(km < 1e7 ? 2 : 1)} million km`;
            return {
                kindLabel: 'Spacecraft',
                subtitle: `Launched ${fmtDate(c.launchMs, 'UTC', { weekday: false })}`,
                lines: [
                    `A message sent now arrives in ${fmtRadioTime(up)}; the signal you could hear now left it ${fmtRadioTime(st.lightTimeS)} ago.`,
                    dsn.length ? `In view of ${dsn.join(' and ')} right now (above ${DSN_MIN_ELEV_DEG}°).` : 'No Deep Space Network complex has it in view right now.',
                    c.note,
                ],
                facts: [
                    ['Distance', `${st.distAU.toFixed(st.distAU < 1 ? 4 : 2)} AU · ${kmText}`],
                    ['From the Sun', `${D.sunAU.toFixed(2)} AU`],
                    ['Speed', `${D.speedKmS.toFixed(1)} km/s relative to the Sun`],
                ],
                caveat: D.mode === 'projected'
                    ? `Projected: a straight-line coast beyond JPL’s trajectory. ${silent ? 'Its power will have run out long before; the radio is silent.' : ''}`.trim()
                    : silent ? 'Its power is expected to have run out by now: the dish would hear nothing.' : 'Trajectory from JPL Horizons; the DSN line is a visibility test, not the DSN schedule.',
                sources: ['JPL Horizons (NASA/JPL-Caltech), heliocentric ICRF vectors; data/craft.json'],
            };
        },
    };
}
