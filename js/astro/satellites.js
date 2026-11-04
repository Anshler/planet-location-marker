/**
 * Bright satellites (pure): the ISS, Tiangong, Hubble and a few big rocket bodies, from two-line
 * element sets (data/tle.json, written by scripts/fetch-tle.mjs from CelesTrak at build/deploy
 * time; the page itself never goes online for them) propagated by near-Earth SGP4 (astro/sgp4.js).
 *
 * Geometry, all Earth-fixed (km): SGP4's TEME position turned by GMST (sgp4.temeToEf), the
 * observer on the WGS-84 ellipsoid, a low-precision Sun (Astronomical Almanac, ≈ 0.01°). From
 * these: altitude/azimuth, range, the sunlit fraction of the Sun's disc seen from the satellite
 * (shadow.discVisibleFraction against the Earth's disc: a penumbra-correct fade into the shadow),
 * and the visual magnitude from a standard magnitude (1000 km, half lit) with the range and the
 * phase angle (the McCants / Heavens-Above convention).
 *
 * Honesty: element sets age. Positions drift by a few km a day (and jump after a reboost), so a
 * satellite is shown only within TLE_VALID_DAYS of its elements' epoch, approximate after
 * TLE_APPROX_DAYS, and the card says how old the elements are. Standard magnitudes are rough
 * (±0.5 mag; attitude and solar-panel glints change the real brightness by more).
 *
 * The extras provider (kind 'sat', layer 'satellites') fills an ExtraState per snapshot like the
 * others, and also implements `advance`: the frame loop moves the states to the frame's own
 * instant every rendered frame (microseconds), so the ISS glides at 1× instead of stepping
 * every 0.5 s. `findPasses` (run in the astro worker) lists the next visible passes.
 *
 * @module astro/satellites
 */

import { parseTle, sgp4init, sgp4, gstime, temeToEf, jdOfMs } from './sgp4.js';
import { discVisibleFraction } from './shadow.js';
import { AU_KM, EARTH_RADIUS_KM, SUN_RADIUS_KM } from './bodies.js';
import { m4MulDir } from './frames.js';

const DEG = Math.PI / 180;
const DAY_MS = 86400000;
/** Element sets are used this many days either side of their epoch, and no further. */
export const TLE_VALID_DAYS = 14;
/** Past this age (days) a satellite is drawn but labelled approximate. */
export const TLE_APPROX_DAYS = 3;
/** A pass counts as visible from this altitude up (degrees)… */
export const PASS_MIN_ALT_DEG = 10;
/** …with the Sun at least this far below the observer's horizon (degrees: civil twilight's end)… */
export const PASS_SUN_MAX_DEG = -6;
/** …and at least this much of the Sun's disc lighting the satellite. */
export const PASS_MIN_LIT = 0.5;
/** Visible for less than this (ms), a pass is a glimpse, not listed. */
export const PASS_MIN_MS = 60000;

/**
 * What the app tracks, by key (`sat:<key>`): NORAD number, names, colour, standard magnitude
 * (1000 km, half lit; approximate) and a line of history. scripts/fetch-tle.mjs fetches these
 * NORAD numbers.
 */
export const SAT_INFO = Object.freeze({
    iss: { norad: 25544, name: 'ISS', full: 'International Space Station', kindLabel: 'Space station', color: '#9ff0d0', stdMag: -1.8, priority: 86,
        note: 'Crewed without a break since November 2000; about 109 m across its solar-array truss, the largest thing humans have built in space.' },
    tiangong: { norad: 48274, name: 'Tiangong', full: 'Tiangong (China Space Station, Tianhe core)', kindLabel: 'Space station', color: '#ffc78f', stdMag: -0.6, priority: 84,
        note: 'China’s space station: the Tianhe core module (2021) with the Wentian and Mengtian laboratories, crewed since 2021.' },
    hubble: { norad: 20580, name: 'Hubble', full: 'Hubble Space Telescope', kindLabel: 'Space telescope', color: '#b9c8ff', stdMag: 2.2, priority: 82,
        note: 'Launched in 1990 and serviced five times by Space Shuttle crews; its 28.5° orbit keeps it below the horizon north of about 50° latitude (and south of 50° S).' },
    'sl16-22285': { norad: 22285, name: 'Zenit stage (1992)', full: 'SL-16 R/B: a Zenit-2 second stage', kindLabel: 'Rocket body', color: '#d7c3a6', stdMag: 2.3, priority: 64,
        note: 'An 11 m spent Zenit-2 upper stage, one of the brightest pieces of debris in orbit; it tumbles, so it can flicker.' },
    'sl16-25407': { norad: 25407, name: 'Zenit stage (1998)', full: 'SL-16 R/B: a Zenit-2 second stage', kindLabel: 'Rocket body', color: '#d7c3a6', stdMag: 2.3, priority: 63,
        note: 'An 11 m spent Zenit-2 upper stage, left in an 840 km orbit; it tumbles, so it can flicker.' },
    'sl16-31793': { norad: 31793, name: 'Zenit stage (2007)', full: 'SL-16 R/B: a Zenit-2 second stage', kindLabel: 'Rocket body', color: '#d7c3a6', stdMag: 2.3, priority: 62,
        note: 'An 11 m spent Zenit-2 upper stage, left in an 840 km orbit; it tumbles, so it can flicker.' },
});

/**
 * @typedef {{ id:string, key:string, norad:number, name:string, full:string, kindLabel:string, color:string,
 *   stdMag:number, priority:number, note:string, l1:string, l2:string, epochMs:number, intlDes:string,
 *   periodMin:number, rec:import('./sgp4.js').Satrec }} Sat
 */

/**
 * Decodes data/tle.json: {v:1, retrieved, source, sats:[{key, norad, l1, l2}]}. Unknown keys,
 * malformed lines and deep-space orbits are skipped (never thrown), so one bad entry costs only
 * itself.
 * @param {any} json
 * @returns {Sat[]}
 */
export function decodeTle(json) {
    if (!json || json.v !== 1 || !Array.isArray(json.sats)) throw new TypeError('tle.json: unexpected format');
    const out = [];
    for (const e of json.sats) {
        const info = SAT_INFO[e?.key];
        if (!info) continue;
        let el;
        try { el = parseTle(e.l1, e.l2); } catch { continue; }
        if (el.satnum !== info.norad) continue;
        const rec = sgp4init(el);
        if (rec.error) continue;
        out.push({ id: `sat:${e.key}`, key: e.key, ...info, l1: e.l1, l2: e.l2, epochMs: el.epochMs, intlDes: el.intlDes,
            periodMin: rec.periodMin, rec });
    }
    return out;
}

/** Days from the elements' epoch to `tMs` (negative: before the epoch). */
export function tleAgeDays(sat, tMs) {
    return (tMs - sat.epochMs) / DAY_MS;
}

/** True when `tMs` is inside the window the elements are trusted for. */
export function inTleWindow(sat, tMs) {
    return Math.abs(tleAgeDays(sat, tMs)) <= TLE_VALID_DAYS;
}

// ---------------------------------------------------------------- geometry (Earth-fixed, km)

const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/**
 * An observer on the WGS-84 ellipsoid: Earth-fixed position (km) and east/north/up unit vectors.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} [elevM]
 * @param {{ef:Float64Array, east:Float64Array, north:Float64Array, up:Float64Array}} [out]
 */
export function observerEf(latDeg, lonDeg, elevM = 0, out = { ef: new Float64Array(3), east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) }) {
    const p = latDeg * DEG, l = lonDeg * DEG;
    const sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sp * sp);
    const h = (Number.isFinite(elevM) ? elevM : 0) / 1000;
    out.ef[0] = (N + h) * cp * cl;
    out.ef[1] = (N + h) * cp * sl;
    out.ef[2] = (N * (1 - WGS84_E2) + h) * sp;
    out.up[0] = cp * cl; out.up[1] = cp * sl; out.up[2] = sp;
    out.east[0] = -sl; out.east[1] = cl; out.east[2] = 0;
    out.north[0] = -sp * cl; out.north[1] = -sp * sl; out.north[2] = cp;
    return out;
}

/**
 * The Sun's direction, Earth-fixed (unit vector into `out`), from the Astronomical Almanac's
 * low-precision formulae (≈ 0.01° from 1950 to 2050; mean equinox of date, as TEME). Returns the
 * Earth–Sun distance in AU.
 * @param {number} tMs
 * @param {number} gmst radians
 * @param {Float64Array} out
 * @returns {number}
 */
export function sunEf(tMs, gmst, out) {
    const n = jdOfMs(tMs) - 2451545.0;
    const L = (280.460 + 0.9856474 * n) * DEG;
    const g = (357.528 + 0.9856003 * n) * DEG;
    const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 4e-7 * n) * DEG;
    const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
    out[0] = x; out[1] = y; out[2] = z;
    temeToEf(out, gmst, out);
    return 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
}

/**
 * The fraction of the Sun's disc a satellite sees past the Earth (1 sunlit, 0 in the umbra; the
 * penumbra in between), from its Earth-fixed position (km) and the Sun's direction.
 * @param {ArrayLike<number>} ef
 * @param {ArrayLike<number>} sunHat
 * @param {number} sunAU
 * @returns {number}
 */
export function sunlitFraction(ef, sunHat, sunAU) {
    const r = Math.hypot(ef[0], ef[1], ef[2]);
    if (!(r > EARTH_RADIUS_KM)) return 0;
    const ro = Math.asin(EARTH_RADIUS_KM / r);
    const rs = Math.asin(SUN_RADIUS_KM / (sunAU * AU_KM));
    // Separation between the Sun and the Earth's centre, as seen from the satellite.
    const c = -(ef[0] * sunHat[0] + ef[1] * sunHat[1] + ef[2] * sunHat[2]) / r;
    const sep = Math.acos(Math.max(-1, Math.min(1, c)));
    return discVisibleFraction(rs, ro, sep);
}

/**
 * Visual magnitude: standard magnitude (1000 km, half lit) + 5·log10(range/1000 km) with the
 * illuminated fraction (1 + cos φ)/2 of a diffuse sphere, φ the Sun–satellite–observer angle,
 * dimmed by the sunlit fraction. NaN in the umbra.
 * @param {number} stdMag
 * @param {number} rangeKm
 * @param {number} cosPhase cos φ
 * @param {number} lit sunlitFraction
 * @returns {number}
 */
export function satMagnitude(stdMag, rangeKm, cosPhase, lit) {
    if (!(lit > 0) || !(rangeKm > 0)) return NaN;
    const frac = Math.max(1e-3, (1 + cosPhase) / 2);
    return stdMag - 15.75 + 2.5 * Math.log10(rangeKm * rangeKm / frac) - 2.5 * Math.log10(lit);
}

/**
 * @typedef {{ ef:Float64Array, vel:Float64Array, topo:Float64Array, sun:Float64Array, rangeKm:number,
 *   altDeg:number, azDeg:number, heightKm:number, speedKmS:number, lit:number, mag:number, sunAltDeg:number,
 *   cosPhase:number, latDeg:number, lonDeg:number, gmst:number }} Look
 */

/** A fresh Look (preallocated buffers). @returns {Look} */
export function createLook() {
    return { ef: new Float64Array(3), vel: new Float64Array(3), topo: new Float64Array(3), sun: new Float64Array(3), rangeKm: NaN,
        altDeg: NaN, azDeg: NaN, heightKm: NaN, speedKmS: NaN, lit: 0, mag: NaN, sunAltDeg: NaN, cosPhase: 0, latDeg: NaN, lonDeg: NaN, gmst: 0 };
}

const _teme = new Float64Array(3);
const _vteme = new Float64Array(3);

/**
 * Where a satellite is at `tMs` for an observer (Earth-fixed): fills `out`. `full` adds the
 * Sun, the shadow, the magnitude, the sub-point and the speed (alt/az alone is enough for the
 * pass search's coarse steps).
 * @param {Sat} sat
 * @param {number} tMs
 * @param {ReturnType<typeof observerEf>} obs
 * @param {Look} out
 * @param {boolean} [full]
 * @returns {boolean} false when SGP4 failed (decayed, …)
 */
export function lookAt(sat, tMs, obs, out, full = true) {
    if (sgp4(sat.rec, (tMs - sat.epochMs) / 60000, _teme, _vteme) !== null) return false;
    const gmst = gstime(jdOfMs(tMs));
    out.gmst = gmst;
    temeToEf(_teme, gmst, out.ef);
    const t = out.topo, e = out.ef;
    t[0] = e[0] - obs.ef[0]; t[1] = e[1] - obs.ef[1]; t[2] = e[2] - obs.ef[2];
    const range = Math.hypot(t[0], t[1], t[2]);
    out.rangeKm = range;
    const u = (t[0] * obs.up[0] + t[1] * obs.up[1] + t[2] * obs.up[2]) / range;
    const n = t[0] * obs.north[0] + t[1] * obs.north[1] + t[2] * obs.north[2];
    const ea = t[0] * obs.east[0] + t[1] * obs.east[1] + t[2] * obs.east[2];
    out.altDeg = Math.asin(Math.max(-1, Math.min(1, u))) / DEG;
    let az = Math.atan2(ea, n) / DEG;
    if (az < 0) az += 360;
    out.azDeg = az;
    if (!full) return true;
    const r = Math.hypot(e[0], e[1], e[2]);
    out.heightKm = r - EARTH_RADIUS_KM;
    out.latDeg = Math.atan2(e[2], Math.hypot(e[0], e[1])) / DEG;
    out.lonDeg = Math.atan2(e[1], e[0]) / DEG;
    // Inertial speed (TEME velocity).
    out.speedKmS = Math.hypot(_vteme[0], _vteme[1], _vteme[2]);
    temeToEf(_vteme, gmst, out.vel);
    const sunAU = sunEf(tMs, gmst, out.sun);
    const s = out.sun;
    out.sunAltDeg = Math.asin(Math.max(-1, Math.min(1, s[0] * obs.up[0] + s[1] * obs.up[1] + s[2] * obs.up[2]))) / DEG;
    out.lit = sunlitFraction(e, s, sunAU);
    out.cosPhase = -(s[0] * t[0] + s[1] * t[1] + s[2] * t[2]) / range;
    out.mag = satMagnitude(sat.stdMag, range, out.cosPhase, out.lit);
    return true;
}

const _ef = new Float64Array(3);

/**
 * A satellite's ground track: `n` sub-satellite points (geocentric) evenly over
 * [centerMs − spanMs, centerMs + spanMs], on a sphere of `radius` in Earth geometry-local
 * coordinates (S·EF, render/earth.js's frame), with each point's offset in minutes from
 * `centerMs`. Points SGP4 cannot reach (decayed) repeat the previous one. No allocation.
 * @param {Sat} sat
 * @param {number} centerMs
 * @param {number} spanMs
 * @param {number} n ≥ 2
 * @param {number} radius
 * @param {Float32Array|Float64Array} outPos n·3
 * @param {Float32Array|Float64Array} outMin n
 * @returns {number} points SGP4 placed
 */
export function groundTrack(sat, centerMs, spanMs, n, radius, outPos, outMin) {
    let ok = 0;
    for (let k = 0; k < n; k++) {
        const t = centerMs + spanMs * (2 * k / (n - 1) - 1);
        outMin[k] = (t - centerMs) / 60000;
        if (sgp4(sat.rec, (t - sat.epochMs) / 60000, _teme) === null) {
            temeToEf(_teme, gstime(jdOfMs(t)), _ef);
            const s = radius / Math.hypot(_ef[0], _ef[1], _ef[2]);
            outPos[k * 3] = _ef[0] * s;
            outPos[k * 3 + 1] = _ef[2] * s;
            outPos[k * 3 + 2] = -_ef[1] * s;
            ok++;
        } else if (k > 0) {
            outPos[k * 3] = outPos[k * 3 - 3]; outPos[k * 3 + 1] = outPos[k * 3 - 2]; outPos[k * 3 + 2] = outPos[k * 3 - 1];
        } else {
            outPos[0] = outPos[1] = outPos[2] = 0;
        }
    }
    return ok;
}

// ---------------------------------------------------------------- the extras provider

/** Earth-fixed (km) → Earth geometry-local (S·EF, Earth radii). */
function efToLocal(ef, k, out) {
    out[0] = ef[0] * k;
    out[1] = ef[2] * k;
    out[2] = -ef[1] * k;
    return out;
}

function createSatData() {
    return { look: createLook(), posS: new Float64Array(3), local: new Float64Array(3), ageDays: NaN, tMs: NaN, ok: false };
}

/**
 * The extras provider for the satellites (kind 'sat', layer 'satellites').
 * @param {Sat[]} sats decodeTle's output
 * @param {{json?:any}} [opts] the raw data/tle.json, handed to the worker for pass predictions
 * @returns {import('./extras.js').ExtraProvider & {advance:(snap:any, id:string, out:any, tMs:number)=>void,
 *   elements:()=>any, sats:()=>Sat[], sat:(id:string)=>Sat|null}}
 */
export function createSatProvider(sats, { json = null } = {}) {
    const byId = new Map(sats.map((s) => [s.id, s]));
    const ids = sats.map((s) => s.id);
    // The observer's WGS-84 frame, rebuilt when the place changes.
    const obs = observerEf(0, 0, 0);
    let oLat = NaN, oLon = NaN, oElev = NaN;
    const local = new Float64Array(3);
    const dir = new Float64Array(3);

    function advance(snap, id, out, tMs) {
        out.present = false;
        // The data (its posS above all: the globe label's anchor) exists from the first fill on.
        if (!out.data) out.data = createSatData();
        const D = out.data;
        D.ok = false;
        // Earth satellites, seen from the Earth only (standing on Mars, the observer is a Mars site).
        if (snap?.host && snap.host !== 'earth') return;
        const sat = byId.get(id);
        const o = snap?.observer;
        if (!sat || !o || !snap.earthMatrix || !Number.isFinite(tMs) || !inTleWindow(sat, tMs)) return;
        if (o.latDeg !== oLat || o.lonDeg !== oLon || o.elevM !== oElev) {
            observerEf(o.latDeg, o.lonDeg, o.elevM, obs);
            oLat = o.latDeg; oLon = o.lonDeg; oElev = o.elevM;
        }
        D.ok = lookAt(sat, tMs, obs, D.look, true);
        if (!D.ok) return;
        D.tMs = tMs;
        D.ageDays = tleAgeDays(sat, tMs);
        // Scene: the Earth's orientation of this snapshot (the drawn globe), the satellite where it is now.
        efToLocal(D.look.ef, 1 / EARTH_RADIUS_KM, D.local);
        m4MulDir(snap.earthMatrix, D.local, D.posS);
        const L = D.look;
        efToLocal(L.topo, 1 / L.rangeKm, local);
        m4MulDir(snap.earthMatrix, local, dir);
        const k = 1 / Math.hypot(dir[0], dir[1], dir[2]);
        out.dirS[0] = dir[0] * k; out.dirS[1] = dir[1] * k; out.dirS[2] = dir[2] * k;
        out.distAU = L.rangeKm / AU_KM;
        out.mag = L.mag;
        out.approx = Math.abs(D.ageDays) > TLE_APPROX_DAYS;
        out.present = true;
    }

    return {
        kind: 'sat',
        kindLabel: 'Satellite',
        // Earth satellites: their geometry is from Earth, so they are not present from Mars.
        host: 'earth',
        ids: () => ids,
        meta(id) {
            const s = byId.get(id);
            return s ? { name: s.name, color: s.color, glyph: 'sat', label: 'always', layer: 'satellites', priority: s.priority } : null;
        },
        fill(snap, id, out) { advance(snap, id, out, snap?.tMs); },
        advance,
        elements: () => json,
        /** Days either side of an element set's epoch that it is used for. */
        validDays: TLE_VALID_DAYS,
        sats: () => sats,
        sat: (id) => byId.get(id) ?? null,
        card(id, st) {
            const s = byId.get(id);
            const D = st.data;
            if (!s || !D?.ok) return null;
            const L = D.look;
            const age = D.ageDays;
            const ageText = `${Math.abs(age) < 1 ? `${Math.round(Math.abs(age) * 24)} h` : `${Math.abs(age).toFixed(1)} days`} ${age < 0 ? 'before' : 'old'}`;
            const lat = `${Math.abs(L.latDeg).toFixed(1)}° ${L.latDeg >= 0 ? 'N' : 'S'}`;
            const lon = `${Math.abs(L.lonDeg).toFixed(1)}° ${L.lonDeg >= 0 ? 'E' : 'W'}`;
            const lit = L.lit >= 0.999 ? 'In sunlight' : L.lit <= 0.001 ? 'In the Earth’s shadow: dark' : `Entering or leaving the Earth’s shadow (${Math.round(L.lit * 100)} % of the Sun)`;
            return {
                kindLabel: s.kindLabel,
                subtitle: `${s.full} · NORAD ${s.norad}`,
                lines: [
                    `${Math.round(L.heightKm)} km up, moving at ${L.speedKmS.toFixed(2)} km/s: once around the Earth every ${Math.round(s.periodMin)} min.`,
                    `${lit} now${st.above ? '' : ', below your horizon'}.`,
                    s.note,
                ],
                facts: [
                    ['Distance', `${Math.round(L.rangeKm).toLocaleString('en-US')} km`],
                    ['Below it', `${lat}, ${lon}`],
                    ['Orbital elements', `${new Date(s.epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${ageText}`],
                ],
                caveat: `Positions from orbital elements ${ageText}: they drift by a few km a day (more after a reboost), so times can be off by tens of seconds${st.approx ? ' — these are past their best' : ''}. Not shown more than ${TLE_VALID_DAYS} days from the elements. Brightness is approximate (attitude and panel glints change it).`,
                sources: ['CelesTrak GP element sets (data/tle.json)', 'SGP4 (Vallado et al., AIAA 2006-6753)'],
            };
        },
    };
}

// ---------------------------------------------------------------- pass predictions

/**
 * @typedef {{ id:string, name:string, color:string, riseMs:number, setMs:number,
 *   startMs:number, startAltDeg:number, startAzDeg:number, peakMs:number, peakAltDeg:number, peakAzDeg:number,
 *   endMs:number, endAltDeg:number, endAzDeg:number, mag:number, starts:'rises'|'shadow'|'twilight',
 *   ends:'sets'|'shadow'|'twilight', ageDays:number }} SatPass
 * `starts`/`ends`: how the visible part begins and ends — climbing past PASS_MIN_ALT_DEG
 * ('rises'/'sets'), out of or into the Earth's shadow, or as the twilight sky darkens or brightens.
 */

const COARSE_MS = 60000;
const FINE_MS = 5000;

/** Visible: high enough, sunlit, the sky dark enough. */
function visibleLook(L) {
    return L.altDeg >= PASS_MIN_ALT_DEG && L.lit >= PASS_MIN_LIT && L.sunAltDeg <= PASS_SUN_MAX_DEG;
}

/** Bisects a boolean predicate between a (pa) and b (!pa) to `tol` ms. */
function bisect(a, b, pa, pred, tol = 500) {
    let lo = a, hi = b;
    while (Math.abs(hi - lo) > tol) {
        const mid = (lo + hi) / 2;
        if (pred(mid) === pa) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * The visible passes of one satellite over [fromMs, toMs], clipped to its element window.
 * @param {Sat} sat
 * @param {{latDeg:number, lonDeg:number, elevM?:number}} observer
 * @param {number} fromMs
 * @param {number} toMs
 * @param {{max?:number}} [opts]
 * @returns {SatPass[]}
 */
export function satellitePasses(sat, observer, fromMs, toMs, { max = 40 } = {}) {
    const obs = observerEf(observer.latDeg, observer.lonDeg, observer.elevM ?? 0);
    const L = createLook();
    const lo = Math.max(fromMs, sat.epochMs - TLE_VALID_DAYS * DAY_MS);
    const hi = Math.min(toMs, sat.epochMs + TLE_VALID_DAYS * DAY_MS);
    const out = [];
    if (!(hi > lo)) return out;
    const altAt = (t) => (lookAt(sat, t, obs, L, false) ? L.altDeg : -90);
    const up = (t) => altAt(t) >= 0;
    const vis = (t) => lookAt(sat, t, obs, L, true) && visibleLook(L);
    let t0 = lo;
    let a0 = up(t0);
    let riseMs = a0 ? lo : NaN;
    for (let t = lo + COARSE_MS; t <= hi + COARSE_MS && out.length < max; t += COARSE_MS) {
        const t1 = Math.min(t, hi);
        const a1 = up(t1);
        if (!a0 && a1) riseMs = bisect(t0, t1, false, up);
        if (a0 && (!a1 || t1 >= hi)) {
            const setMs = a1 ? t1 : bisect(t0, t1, true, up);
            const p = analysePass(sat, riseMs, setMs, vis, L, obs);
            if (p) out.push(p);
            riseMs = NaN;
        }
        t0 = t1;
        a0 = a1;
        if (t1 >= hi) break;
    }
    return out;
}

/** The visible part of one pass above the horizon, refined to a second, or null. */
function analysePass(sat, riseMs, setMs, vis, L, obs) {
    if (!(setMs > riseMs)) return null;
    let first = NaN, last = NaN;
    for (let t = riseMs; t <= setMs; t += FINE_MS) {
        if (vis(t)) {
            if (!Number.isFinite(first)) first = t;
            last = t;
        }
    }
    if (!Number.isFinite(first)) return null;
    const startMs = first > riseMs ? bisect(first, Math.max(riseMs, first - FINE_MS), true, vis) : first;
    const endMs = last < setMs ? bisect(last, Math.min(setMs, last + FINE_MS), true, vis) : last;
    if (endMs - startMs < PASS_MIN_MS) return null;
    // Highest point of the visible part (golden-section on altitude; passes are unimodal).
    const alt = (t) => (lookAt(sat, t, obs, L, false) ? L.altDeg : -90);
    let a = startMs, b = endMs;
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    let fc = alt(c), fd = alt(d);
    while (b - a > 1000) {
        if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = alt(c); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = alt(d); }
    }
    let peakMs = (a + b) / 2;
    if (alt(startMs) > alt(peakMs)) peakMs = startMs;
    if (alt(endMs) > alt(peakMs)) peakMs = endMs;
    // Brightest along the visible part.
    let mag = Infinity;
    for (let t = startMs; t <= endMs; t += FINE_MS) if (lookAt(sat, t, obs, L, true) && L.mag < mag) mag = L.mag;
    const at = (t) => { lookAt(sat, t, obs, L, true); return { alt: L.altDeg, az: L.azDeg, lit: L.lit, sunAlt: L.sunAltDeg, mag: L.mag }; };
    const s = at(startMs), p = at(peakMs), e = at(endMs);
    if (lookAt(sat, peakMs, obs, L, true) && L.mag < mag) mag = L.mag;
    const how = (x) => (x.alt <= PASS_MIN_ALT_DEG + 0.3 ? 'rim' : x.lit < PASS_MIN_LIT + 0.05 ? 'shadow' : 'twilight');
    const hs = how(s), he = how(e);
    return {
        id: sat.id, name: sat.name, color: sat.color, riseMs, setMs,
        startMs, startAltDeg: s.alt, startAzDeg: s.az, peakMs, peakAltDeg: p.alt, peakAzDeg: p.az,
        endMs, endAltDeg: e.alt, endAzDeg: e.az, mag: Number.isFinite(mag) ? mag : NaN,
        starts: hs === 'rim' ? 'rises' : hs, ends: he === 'rim' ? 'sets' : he,
        ageDays: tleAgeDays(sat, peakMs),
    };
}

/**
 * The next visible passes of every satellite in data/tle.json (the astro worker's 'satPasses').
 * @param {any} json data/tle.json
 * @param {{latDeg:number, lonDeg:number, elevM?:number}} observer
 * @param {number} fromMs
 * @param {number} [days]
 * @returns {SatPass[]} sorted by start time
 */
export function allPasses(json, observer, fromMs, days = 10) {
    const sats = decodeTle(json);
    const toMs = fromMs + days * DAY_MS;
    const out = [];
    for (const s of sats) out.push(...satellitePasses(s, observer, fromMs, toMs));
    return out.sort((x, y) => x.startMs - y.startMs);
}
