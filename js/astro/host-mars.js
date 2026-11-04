/**
 * Standing on Mars (ROADMAP stand-on-mars, phase 1: the sky view; pure, no three.js or DOM).
 *
 * `computeMarsSnapshot(tMs, site, out, opts)` fills the same preallocated Snapshot the frame loop
 * draws, for an observer at an areographic site, so the renderers, labels and panels work unchanged:
 *
 *  - Directions. Every body comes from `AE.BackdatePosition(t, 'Mars', target, true)`: the
 *    Mars-centred vector corrected for light time and aberration (the Moon included), less the
 *    site's own position on a sphere of Mars's mean radius (13″ of parallax for the Earth at its
 *    closest). The BODIES contract keeps its nine slots: slot 4 ('mars', key 5) holds the Earth
 *    (astro/bodies.js hostBodies), so beams, glyphs, the 1–9 keys and URL ids stay valid.
 *  - The local frame. Up, north and east come from Mars's IAU rotation model
 *    (AE.RotationAxis('Mars') → frames.iauBodyMatrix, planetocentric lat/lon on a sphere); alt/az
 *    from frames.dirToAltAz. No refraction: Mars's air bends a horizon ray by ~0.01°.
 *  - Magnitudes, phases and angular sizes from the Mars-centred geometry, with astronomy-engine's own
 *    phase laws (Mallama & Hilton 2018 for the Earth). The Sun is two thirds of its size from Earth.
 *  - Phobos and Deimos (`snap.mars.moons`) from JPL's mean elements in their Laplace planes
 *    (Brozović, Jacobson & Park 2025, MAR099; mean longitude rates of Jacobson 2010, Phobos's
 *    secular acceleration) — good to a degree or so over decades: an illustrative badge. Phobos
 *    rises in the west twice a sol and crosses the Sun as a dark fleck (Perseverance, sol 397).
 *  - `snap.mars`: the Mars clock (astro/mars-clock.js), the site, the light time from the Earth.
 *  - The scene is still the Earth's: the camera stands on the unit sphere at the point whose normal
 *    is the Martian zenith (observer.posS = upS), so the hidden globe lies under the ground. The
 *    Earth's rotation (earthMatrix) is left as it is for the modules that read it.
 *
 * No typed arrays are allocated per call (`snap.mars` is created once per snapshot).
 *
 * @module astro/host-mars
 */
import { AE } from './ae.js';
import { BODIES, BODY_INDEX, AU_KM, AU_ER, LIGHT_S_PER_AU } from './bodies.js';
import {
    DEG2RAD, RAD2DEG, wrap360, earthRotationM3, m3ToSceneM4, m4ToQuat, dirToAltAz, sceneToRaDec, iauBodyMatrix,
} from './frames.js';
import { twilightClass } from './photometry.js';
import { computeGalilean } from './moons.js';
import { NO_GAP } from './totality.js';
import { MARS_RADIUS_KM, DEFAULT_MARS_SITE, createMarsTime, marsTimeTT, marsSiteNear } from './mars-clock.js';

/** The BODIES slot that holds the Earth when the observer stands on Mars. */
export const EARTH_SLOT = BODY_INDEX.mars;
const N = BODIES.length;
const SUN = 0, MOON = 1;
const JUPITER = BODY_INDEX.jupiter;
const SATURN = BODY_INDEX.saturn;
const TARGET = BODIES.map((b, i) => (i === EARTH_SLOT ? 'Earth' : b.ae));
const RADIUS_KM = BODIES.map((b, i) => (i === EARTH_SLOT ? 6371.0 : b.radiusKm));
const RAD2ARCSEC = RAD2DEG * 3600;
const KM_PER_AU = AU_KM;
const SUN_MAG_1AU = -26.74;
const MOON_MEAN_AU = 385000.6 / AU_KM;
const COS_OBL = 0.9174820621, SIN_OBL = 0.3977771559;   // J2000 mean obliquity

/**
 * Phobos and Deimos: JPL SSD mean elements (epoch 2000-01-01.5 TDB, Laplace frame; MAR099,
 * Brozović, Jacobson & Park 2025) with the mean-longitude rates and Phobos's apsidal and nodal
 * periods of Jacobson (2010) — the table rounds those to 1.1 and 2.3 yr, which over two decades
 * swings Phobos's track 1.3° off the Sun at Perseverance's sol-397 transit — and its tidal secular
 * acceleration ṅ = 1.270e-3 °/yr² (Jacobson 2010). `lam0` = node + ω + M; `nDeg` the mean-longitude
 * rate (°/day, the sidereal period 360/n); H the absolute magnitude V(1, 0).
 */
export const MARS_MOONS = Object.freeze([
    Object.freeze({
        id: 'phobos', name: 'Phobos', aKm: 9375, e: 0.015, iDeg: 1.1, nodeDeg: 169.2, wDeg: 216.3, lam0: 169.2 + 216.3 + 189.7,
        nDeg: 1128.8445850, wYr: 1.1316, nodeYr: 2.2617, accel: 1.270e-3, poleRa: 317.7, poleDec: 52.9, radiusKm: 11.08, H: 11.8,
    }),
    Object.freeze({
        id: 'deimos', name: 'Deimos', aKm: 23457, e: 0.0002, iDeg: 1.8, nodeDeg: 54.3, wDeg: 0, lam0: 54.3 + 0 + 205.0,
        nDeg: 285.1618970, wYr: 0, nodeYr: 56.2, accel: 0, poleRa: 316.6, poleDec: 53.5, radiusKm: 6.27, H: 12.89,
    }),
]);

// Module scratch (R5).
const E3 = new Float64Array(9);
const M3 = new Float64Array(9);
const B3 = new Float64Array(9);
const UP = new Float64Array(3), NORTH = new Float64Array(3), EAST = new Float64Array(3);   // EQJ
const SITE = new Float64Array(3);    // the site's position from Mars's centre, AU, EQJ
const HELIO = new Float64Array(3 * N);
const ALTAZ = { altDeg: 0, azDeg: 0 };
const RADEC = { raDeg: 0, decDeg: 0 };
const MV = new Float64Array(3);
const MARS_H = new Float64Array(3);

/** EQJ (x, y, z) → normalised scene vector (x, z, −y). */
function setSceneUnit(out, x, y, z) {
    const len = Math.hypot(x, y, z);
    const k = len > 0 ? 1 / len : 0;
    out[0] = x * k;
    out[1] = z * k;
    out[2] = -y * k;
}

/** Row-major 3×3 times (x, y, z) into out. */
function m3apply(m, x, y, z, out) {
    out[0] = m[0] * x + m[1] * y + m[2] * z;
    out[1] = m[3] * x + m[4] * y + m[5] * z;
    out[2] = m[6] * x + m[7] * y + m[8] * z;
}

/**
 * A moon of Mars from its mean elements: the Mars-centred position, km, EQJ (into out).
 * @param {typeof MARS_MOONS[number]} el
 * @param {number} ttDays TT (≈ TDB) days from J2000
 * @param {Float64Array} out
 * @returns {Float64Array} out
 */
export function marsMoonPosition(el, ttDays, out) {
    const d = ttDays;
    const yr = d / 365.25;
    const node = (el.nodeDeg - (el.nodeYr > 0 ? (360 * yr) / el.nodeYr : 0)) * DEG2RAD;
    const w = (el.wDeg + (el.wYr > 0 ? (360 * yr) / el.wYr : 0)) * DEG2RAD;
    // Mean longitude (node + ω + M) at the sidereal rate, plus the tidal acceleration ½·ṅ·T².
    const lam = (el.lam0 + el.nDeg * d + 0.5 * el.accel * yr * yr) * DEG2RAD;
    const M = lam - node - w;
    let E = M;
    for (let k = 0; k < 4; k++) E -= (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
    const xo = el.aKm * (Math.cos(E) - el.e);
    const yo = el.aKm * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    // Orbit plane → Laplace frame: Rz(node)·Rx(i)·Rz(ω).
    const cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(el.iDeg * DEG2RAD), si = Math.sin(el.iDeg * DEG2RAD);
    const cn = Math.cos(node), sn = Math.sin(node);
    const x1 = cw * xo - sw * yo, y1 = sw * xo + cw * yo;
    const y2 = ci * y1, z2 = si * y1;
    const xl = cn * x1 - sn * y2, yl = sn * x1 + cn * y2, zl = z2;
    // Laplace frame → EQJ: x toward the plane's ascending node on the ICRF equator (RA + 90°), z its pole.
    const a = el.poleRa * DEG2RAD, de = el.poleDec * DEG2RAD;
    const zx = Math.cos(de) * Math.cos(a), zy = Math.cos(de) * Math.sin(a), zz = Math.sin(de);
    const xx = -Math.sin(a), xy = Math.cos(a);
    const yx = zy * 0 - zz * xy, yy = zz * xx - zx * 0, yz = zx * xy - zy * xx;
    out[0] = xx * xl + yx * yl + zx * zl;
    out[1] = xy * xl + yy * yl + zy * zl;
    out[2] = yz * yl + zz * zl;
    return out;
}

/**
 * @typedef {{ id:string, name:string, dirS:Float64Array, distKm:number, altDeg:number, azDeg:number, above:boolean,
 *   angDiamArcsec:number, phaseFrac:number, phaseAngleDeg:number, mag:number, eclipsed:boolean, lightS:Float64Array }} MarsMoonState
 * @typedef {{ site:{latDeg:number, lonDeg:number, name:string, id:string|null}, time:import('./mars-clock.js').MarsTime,
 *   moons:MarsMoonState[], earthLightS:number, sunDistAU:number }} MarsInfo
 */

/** @returns {MarsInfo} */
export function createMarsInfo() {
    return {
        site: { latDeg: DEFAULT_MARS_SITE.latDeg, lonDeg: DEFAULT_MARS_SITE.lonDeg, name: DEFAULT_MARS_SITE.name, id: DEFAULT_MARS_SITE.id },
        time: createMarsTime(),
        moons: MARS_MOONS.map((m) => ({
            id: m.id, name: m.name, dirS: new Float64Array([1, 0, 0]), distKm: m.aKm, altDeg: 0, azDeg: 0, above: false,
            angDiamArcsec: 0, phaseFrac: 1, phaseAngleDeg: 0, mag: 0, eclipsed: false, lightS: new Float64Array([1, 0, 0]),
        })),
        earthLightS: 0,
        sunDistAU: 1.52,
    };
}

/** astronomy-engine's planet phase laws (VisualMagnitude, MIT), without the distance term. */
function phaseLaw(i, alphaDeg) {
    const x = alphaDeg / 100;
    switch (BODIES[i].id) {
        case 'mercury': return -0.60 + x * (4.98 + x * (-4.88 + x * 3.02));
        case 'venus': return alphaDeg < 163.6 ? -4.47 + x * (1.03 + x * (0.57 + x * 0.13)) : 0.98 - 1.02 * x;
        case 'jupiter': return -9.40 + 0.50 * x;
        case 'uranus': return -7.19 + 0.25 * x;
        case 'neptune': return -6.87;
        default: return 0;
    }
}

/** The Earth's V(1, α) (Mallama & Hilton 2018): −3.99 − 1.060e-3·α + 2.054e-4·α². */
function earthLaw(alphaDeg) { return -3.99 - 1.060e-3 * alphaDeg + 2.054e-4 * alphaDeg * alphaDeg; }

/** Saturn with its rings (astronomy-engine's SaturnMagnitude, Schlyter), for a viewing vector. */
function saturnMag(alphaDeg, r, d, vx, vy, vz, ttDays, out) {
    // The viewing vector's J2000 ecliptic latitude and longitude.
    const ey = vy * COS_OBL + vz * SIN_OBL, ez = -vy * SIN_OBL + vz * COS_OBL;
    const lat = Math.atan2(ez, Math.hypot(vx, ey)), lon = Math.atan2(ey, vx);
    const ir = 28.06 * DEG2RAD, Nr = (169.51 + 3.82e-5 * ttDays) * DEG2RAD;
    const tilt = Math.asin(Math.sin(lat) * Math.cos(ir) - Math.cos(lat) * Math.sin(ir) * Math.sin(lon - Nr));
    const st = Math.sin(Math.abs(tilt));
    out.ringTiltDeg = tilt * RAD2DEG;
    return -9.0 + 0.044 * alphaDeg + st * (-2.6 + 1.2 * st) + 5 * Math.log10(r * d);
}

/**
 * Computes the sky from a site on Mars into `out` (in place).
 * @param {number} tMs UTC milliseconds
 * @param {{latDeg:number, lonDeg:number, name?:string}|null} site planetocentric °N, °E
 * @param {import('../core/types.js').Snapshot} out a snapshot from createSnapshot()
 * @param {{detail?:'frame'|'full'}} [opts]
 * @returns {import('../core/types.js').Snapshot} out
 */
export function computeMarsSnapshot(tMs, site, out, opts) {
    if (!out || !out.bodies || out.bodies.length !== N) throw new TypeError('computeMarsSnapshot: `out` must come from createSnapshot()');
    if (!Number.isFinite(tMs)) return out;
    const full = opts != null && opts.detail === 'full';
    const time = AE.MakeTime(new Date(tMs));
    let lat = Number(site?.latDeg), lon = Number(site?.lonDeg);
    lat = Number.isFinite(lat) ? Math.min(90, Math.max(-90, lat)) : DEFAULT_MARS_SITE.latDeg;
    lon = Number.isFinite(lon) ? ((((lon + 180) % 360) + 360) % 360) - 180 : DEFAULT_MARS_SITE.lonDeg;

    out.tMs = tMs;
    out.jdUT = tMs / 86400000 + 2440587.5;
    out.detail = full ? 'full' : 'frame';
    out.host = 'mars';
    // The Earth keeps turning under the hidden globe (modules that read it stay consistent).
    out.gastDeg = earthRotationM3(time, E3);
    m4ToQuat(m3ToSceneM4(E3, out.earthMatrix), out.earthQuat);

    // The Martian local frame: body-fixed → EQJ from the IAU rotation model.
    const ax = AE.RotationAxis('Mars', time);
    iauBodyMatrix(ax.ra, ax.dec, ax.spin, M3);
    const cp = Math.cos(lat * DEG2RAD), sp = Math.sin(lat * DEG2RAD), cl = Math.cos(lon * DEG2RAD), sl = Math.sin(lon * DEG2RAD);
    m3apply(M3, cp * cl, cp * sl, sp, UP);
    m3apply(M3, -sp * cl, -sp * sl, cp, NORTH);
    m3apply(M3, -sl, cl, 0, EAST);
    const rAU = MARS_RADIUS_KM / KM_PER_AU;
    SITE[0] = UP[0] * rAU; SITE[1] = UP[1] * rAU; SITE[2] = UP[2] * rAU;
    const o = out.observer;
    o.latDeg = lat;
    o.lonDeg = lon;
    o.elevM = 0;
    setSceneUnit(o.upS, UP[0], UP[1], UP[2]);
    setSceneUnit(o.northS, NORTH[0], NORTH[1], NORTH[2]);
    setSceneUnit(o.eastS, EAST[0], EAST[1], EAST[2]);
    o.posS[0] = o.upS[0]; o.posS[1] = o.upS[1]; o.posS[2] = o.upS[2];

    const mh = AE.HelioVector('Mars', time);
    MARS_H[0] = mh.x; MARS_H[1] = mh.y; MARS_H[2] = mh.z;

    for (let i = 0; i < N; i++) {
        const st = out.bodies[i];
        const v = AE.BackdatePosition(time, 'Mars', TARGET[i], true);
        const gx = v.x, gy = v.y, gz = v.z;
        const x = gx - SITE[0], y = gy - SITE[1], z = gz - SITE[2];
        const dist = Math.hypot(x, y, z);
        setSceneUnit(st.dirS, x, y, z);
        setSceneUnit(st.geoDirS, gx, gy, gz);
        st.distAU = dist;
        st.distER = dist * AU_ER;
        st.lightTimeS = dist * LIGHT_S_PER_AU;
        dirToAltAz(st.dirS, o.upS, o.northS, o.eastS, ALTAZ);
        st.altGeomDeg = st.altDeg = ALTAZ.altDeg;
        st.azGeomDeg = st.azDeg = ALTAZ.azDeg;
        sceneToRaDec(st.dirS, RADEC);
        st.raJ2000H = st.raDateH = RADEC.raDeg / 15;
        st.decJ2000Deg = st.decDateDeg = RADEC.decDeg;
        // Heliocentric target (AU, EQJ): Mars + the Mars-centred vector.
        const hx = i === SUN ? 0 : MARS_H[0] + gx, hy = i === SUN ? 0 : MARS_H[1] + gy, hz = i === SUN ? 0 : MARS_H[2] + gz;
        HELIO[i * 3] = hx; HELIO[i * 3 + 1] = hy; HELIO[i * 3 + 2] = hz;
        const r = Math.hypot(hx, hy, hz);
        st.angDiamArcsec = 2 * Math.asin(Math.min(1, RADIUS_KM[i] / (dist * KM_PER_AU))) * RAD2ARCSEC;
        st.ringTiltDeg = 0;
        if (i === SUN) {
            st.mag = SUN_MAG_1AU + 5 * Math.log10(dist);
            st.phaseAngleDeg = 0;
            st.phaseFrac = 1;
            st.lightS[0] = -st.dirS[0]; st.lightS[1] = -st.dirS[1]; st.lightS[2] = -st.dirS[2];
            st.elongDeg = 0;
            st.elongSide = null;
        } else {
            // Phase angle: at the target, between the Sun (−h) and the observer (−v).
            const c = (hx * x + hy * y + hz * z) / (r * dist);
            const alpha = Math.acos(Math.max(-1, Math.min(1, c))) * RAD2DEG;
            st.phaseAngleDeg = alpha;
            st.phaseFrac = (1 + Math.cos(alpha * DEG2RAD)) / 2;
            setSceneUnit(st.lightS, -hx, -hy, -hz);
            if (i === MOON) {
                const a = alpha * DEG2RAD;
                st.mag = -12.717 + 1.49 * Math.abs(a) + 0.0431 * a * a * a * a + 5 * Math.log10(r * (dist / MOON_MEAN_AU));
            } else if (i === EARTH_SLOT) {
                st.mag = earthLaw(alpha) + 5 * Math.log10(r * dist);
            } else if (i === SATURN) {
                st.mag = saturnMag(alpha, r, dist, x, y, z, time.tt, st);
            } else {
                st.mag = phaseLaw(i, alpha) + 5 * Math.log10(r * dist);
            }
            const s0 = out.bodies[SUN].dirS;
            const ce = s0[0] * st.dirS[0] + s0[1] * st.dirS[1] + s0[2] * st.dirS[2];
            st.elongDeg = Math.acos(Math.max(-1, Math.min(1, ce))) * RAD2DEG;
            // East of the Sun (evening) when the body is ahead of it in ecliptic longitude.
            st.elongSide = wrap360(eclipticLon(st.dirS) - eclipticLon(s0)) > 180 ? 'morning' : 'evening';
        }
        // A planet's (and the Earth's) IAU pole and prime meridian when its light left.
        if (BODIES[i].kind === 'planet' || i === EARTH_SLOT) {
            try {
                const ra = AE.RotationAxis(TARGET[i], time.AddDays(-st.lightTimeS / 86400));
                iauBodyMatrix(ra.ra, ra.dec, ra.spin, B3);
                setSceneUnit(st.poleS, B3[2], B3[5], B3[8]);
                setSceneUnit(st.primeS, B3[0], B3[3], B3[6]);
                st.spinDeg = wrap360(ra.spin);
            } catch { /* keep the last */ }
        }
        st.subLatDeg = NaN;
        st.subLonDeg = NaN;
        if (full) {
            try {
                const cst = AE.Constellation(st.raJ2000H, st.decJ2000Deg);
                st.constellation.symbol = cst.symbol;
                st.constellation.name = cst.name;
            } catch { /* keep */ }
        }
        const semi = i === SUN ? st.angDiamArcsec / 7200 : 0;
        st.above = st.altDeg + semi > 0;
    }

    const sun = out.bodies[SUN];
    out.sunDirS[0] = sun.dirS[0]; out.sunDirS[1] = sun.dirS[1]; out.sunDirS[2] = sun.dirS[2];
    o.sunAltDeg = sun.altGeomDeg;
    o.twilight = twilightClass(o.sunAltDeg);

    // The Moon mesh (hidden on Mars) stays where the Earth's Moon is, at its own orientation.
    const g = AE.GeoMoon(time);
    const mp = out.moonPosS;
    mp[0] = g.x * AU_ER; mp[1] = g.z * AU_ER; mp[2] = -g.y * AU_ER;
    const mx = AE.RotationAxis('Moon', time);
    iauBodyMatrix(mx.ra, mx.dec, mx.spin, B3);
    m3ToSceneM4(B3, out.moonMatrix, mp[0], mp[1], mp[2]);
    out.moonPhaseDeg = wrap360(eclipticLon(out.bodies[MOON].dirS) - eclipticLon(sun.dirS));

    // Heliocentric positions (scene axes): Mars stands in for the observer's planet.
    const hl = out.helio;
    hl.earthS[0] = MARS_H[0]; hl.earthS[1] = MARS_H[2]; hl.earthS[2] = -MARS_H[1];
    for (let i = 0; i < N; i++) {
        hl.posS[i * 3] = HELIO[i * 3];
        hl.posS[i * 3 + 1] = HELIO[i * 3 + 2];
        hl.posS[i * 3 + 2] = -HELIO[i * 3 + 1];
    }

    computeGalilean(time, out.bodies[JUPITER], out.galilean);
    const ecl = out.eclipse;
    ecl.solar = false;
    ecl.lunar = false;
    ecl.obscurationAtObserver = 0;
    ecl.moonLitFraction = 1;
    ecl.beads.count = 0;
    ecl.beads.total = 0;
    ecl.beads.gapArcsec = NO_GAP;

    // Mars time, the moons of Mars, the light from home.
    const info = out.mars ?? (out.mars = createMarsInfo());
    const near = marsSiteNear(lat, lon, 0.5);
    info.site.latDeg = lat;
    info.site.lonDeg = lon;
    info.site.id = near ? near.id : null;
    info.site.name = site?.name || (near ? near.name : 'Mars');
    marsTimeTT(time.tt, lon, info.time);
    info.earthLightS = out.bodies[EARTH_SLOT].lightTimeS;
    info.sunDistAU = sun.distAU;
    for (let k = 0; k < MARS_MOONS.length; k++) fillMoon(MARS_MOONS[k], info.moons[k], time.tt, o, sun);
    return out;
}

function eclipticLon(d) {
    // Scene (x, y, z) = EQJ (x, z, −y): ecliptic longitude atan2(y·cosε + z·sinε, x) in EQJ.
    return Math.atan2(-d[2] * COS_OBL + d[1] * SIN_OBL, d[0]) * RAD2DEG;
}

function fillMoon(el, m, ttDays, o, sun) {
    marsMoonPosition(el, ttDays, MV);
    const rKm = MARS_RADIUS_KM;
    // Topocentric: less the site (UP is the EQJ zenith).
    const x = MV[0] - UP[0] * rKm, y = MV[1] - UP[1] * rKm, z = MV[2] - UP[2] * rKm;
    const d = Math.hypot(x, y, z);
    setSceneUnit(m.dirS, x, y, z);
    m.distKm = d;
    dirToAltAz(m.dirS, o.upS, o.northS, o.eastS, ALTAZ);
    m.altDeg = ALTAZ.altDeg;
    m.azDeg = ALTAZ.azDeg;
    m.above = m.altDeg > 0;
    m.angDiamArcsec = 2 * Math.asin(Math.min(1, el.radiusKm / d)) * RAD2ARCSEC;
    // Sunlight: toward the Sun from the moon (the Sun is at infinity for this purpose).
    const s = sun.dirS;
    m.lightS[0] = s[0]; m.lightS[1] = s[1]; m.lightS[2] = s[2];
    // Phase angle: between the Sun and the observer, seen from the moon.
    const cosA = -(s[0] * m.dirS[0] + s[1] * m.dirS[1] + s[2] * m.dirS[2]);
    const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
    m.phaseAngleDeg = a * RAD2DEG;
    m.phaseFrac = (1 + Math.cos(a)) / 2;
    // In Mars's shadow: behind Mars from the Sun and within its (cylindrical) shadow.
    const sx = s[0], sy = -s[2], sz = s[1];   // scene → EQJ
    const along = MV[0] * sx + MV[1] * sy + MV[2] * sz;
    const perp2 = MV[0] * MV[0] + MV[1] * MV[1] + MV[2] * MV[2] - along * along;
    m.eclipsed = along < 0 && perp2 < rKm * rKm;
    const rSun = sun.distAU;
    m.mag = el.H + 5 * Math.log10(rSun * (d / KM_PER_AU)) + 1.49 * a + 0.0431 * a * a * a * a + (m.eclipsed ? 12 : 0);
}

const MOON_FACTS = Object.freeze({
    phobos: { color: '#d9c3a8', size: '27 × 22 × 18 km', period: '7 h 39 min',
        note: 'It orbits faster than Mars turns, so it rises in the west and sets in the east, twice a sol.' },
    deimos: { color: '#cdbfae', size: '15 × 12 × 11 km', period: '30 h 18 min',
        note: 'It orbits just slower than Mars turns: it rises in the east and takes about 2.5 sols to cross the sky.' },
});

/**
 * The moons of Mars as extra objects (`sat:phobos`, `sat:deimos`; astro/extras.js): drawn by
 * render/mars-sky.js (glyph 'disc': picked like a glyph), labelled in sky view, present only in a Mars snapshot.
 * @returns {import('./extras.js').ExtraProvider}
 */
export function createMarsMoonsProvider() {
    const ids = MARS_MOONS.map((m) => `sat:${m.id}`);
    const index = new Map(MARS_MOONS.map((m, k) => [`sat:${m.id}`, k]));
    return {
        kind: 'sat',
        kindLabel: 'Moon of Mars',
        host: 'mars',
        ids: () => ids,
        meta(id) {
            const k = index.get(id);
            if (k === undefined) return null;
            const m = MARS_MOONS[k];
            return { name: m.name, color: MOON_FACTS[m.id].color, glyph: 'disc', label: 'always', skyOnly: true, priority: 82 };
        },
        fill(snap, id, st) {
            const k = index.get(id);
            const ms = snap && snap.host === 'mars' && snap.mars ? snap.mars.moons[k] : null;
            if (!ms) { st.present = false; return; }
            st.dirS[0] = ms.dirS[0]; st.dirS[1] = ms.dirS[1]; st.dirS[2] = ms.dirS[2];
            st.distAU = ms.distKm / KM_PER_AU;
            st.mag = ms.mag;
            st.present = true;
            st.approx = true;
        },
        card(id, st, snap) {
            const k = index.get(id);
            const ms = snap && snap.mars && k !== undefined ? snap.mars.moons[k] : null;
            if (!ms) return null;
            const m = MARS_MOONS[k], f = MOON_FACTS[m.id];
            const lines = [f.note];
            if (ms.eclipsed) lines.push('It is in Mars’s shadow now: eclipsed.');
            return {
                kindLabel: 'Moon of Mars',
                subtitle: `${Math.round(ms.distKm).toLocaleString('en-US')} km away · ${Math.round(ms.phaseFrac * 100)}% lit`,
                lines,
                facts: [
                    ['Size', f.size],
                    ['Orbit', `${m.aKm.toLocaleString('en-US')} km from Mars’s centre`],
                    ['Period', f.period],
                    ['Apparent size', `${(ms.angDiamArcsec / 60).toFixed(1)}′`],
                    ['Magnitude', ms.eclipsed ? 'eclipsed' : ms.mag.toFixed(1)],
                ],
                caveat: 'From mean orbital elements (JPL): its place is good to about a degree.',
                sources: ['Brozović, Jacobson & Park 2025 (JPL MAR099 mean elements)', 'Jacobson 2010, AJ 139, 668'],
            };
        },
    };
}
