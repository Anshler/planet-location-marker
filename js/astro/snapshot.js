/**
 * Per-frame astronomy snapshot (SPEC §C.2, §D.3–D.4).
 *
 * `createSnapshot()` preallocates every typed array once; `computeSnapshot()`
 * rewrites them in place and allocates no typed arrays or containers of its
 * own (astronomy-engine's internal temporaries are unavoidable). Measured cost
 * in Node 22 on a desktop CPU: about 0.14 ms for 'frame', 0.23 ms for 'full'.
 *
 * Detail levels:
 *  - 'frame' fills everything the renderers need. Beyond the spec's per-frame
 *    list it also refreshes mag/phase, angular size, J2000 RA/Dec, elongation,
 *    sub-points, moonPhaseDeg and the eclipse flags (all cheap), and sets
 *    altDeg/azDeg/above from the astrometric direction plus refraction, which
 *    stays within ~21″ (annual aberration) of the 'full' values.
 *  - 'full' (4 Hz, UI readout) replaces altDeg/azDeg with AE.Horizon of the
 *    apparent of-date position and also fills raDateH/decDateDeg and the
 *    constellation; those two are otherwise left from the last full pass.
 *
 * Magnitudes are AE.Illumination's, dimmed during eclipses (both details):
 * the Sun by the obscuration at the observer, −2.5·log10(max(1 − obsc, 1e-6)),
 * and the Moon by the sunlight left on its disc, −2.5·log10(flux) from
 * `lunarEclipseLight` (shadow.js); `eclipse.moonLitFraction` is that disc's
 * direct-sunlight fraction (1 outside lunar eclipses, 0 in totality).
 *
 * @module astro/snapshot
 */
import { AE } from './ae.js';
import { BODIES, AU_ER, AU_KM, LIGHT_S_PER_AU } from './bodies.js';
import {
    DEG2RAD, RAD2DEG, OBLIQUITY_J2000_DEG, wrap180, wrap360,
    earthRotationM3, m3ToSceneM4, m4ToQuat, m4MulDir, m4MulDirT,
    enuLocal, dirToAltAz, sceneToRaDec, localToLatLon, iauBodyMatrix,
} from './frames.js';
import { refractionDeg, twilightClass } from './photometry.js';
import { solarObscurationAt, lunarEclipseLight } from './shadow.js';

const N_BODIES = BODIES.length;
const SUN = 0;
const MOON = 1;
const RAD2ARCSEC = RAD2DEG * 3600;
const ECLIPSE_SEP_RAD = 1.6 * DEG2RAD;
// Penumbral contact of a perigee lunar eclipse is ≈1.603° from the antisun.
const LUNAR_ECLIPSE_SEP_RAD = 1.65 * DEG2RAD;
const SUN_RADIUS_KM = BODIES[SUN].radiusKm;
// Brightness floor of a totally eclipsed Sun, relative to the full disc: +15 mag,
// about the integrated corona (≈ −12, like a full Moon).
const SUN_ECLIPSE_FLOOR = 1e-6;
const MOON_ECLIPSE_FLOOR = 1e-6;
const COS_OBL = Math.cos(OBLIQUITY_J2000_DEG * DEG2RAD);
const SIN_OBL = Math.sin(OBLIQUITY_J2000_DEG * DEG2RAD);

// Module-level scratch, reused by every call (R5).
const E3 = new Float64Array(9);                 // EF → EQJ, row-major
const MOON_R3 = new Float64Array(9);            // Moon body-fixed → EQJ
const GEO = new Float64Array(3 * N_BODIES);     // geocentric EQJ vectors (AU), as GeoVector(…, true)
const LOCAL = { east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) };
const SUB_LOCAL = new Float64Array(3);
const ALTAZ = { altDeg: 0, azDeg: 0 };
const RADEC = { raDeg: 0, decDeg: 0 };
const LATLON = { latDeg: 0, lonDeg: 0 };
const LUNAR = { lit: 1, flux: 1 };

/**
 * @typedef {import('../core/types.js').Snapshot} Snapshot
 * @typedef {import('../core/types.js').BodyState} BodyState
 */

function identity16() {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function makeBodyState(b) {
    return {
        id: b.id,
        dirS: new Float64Array([1, 0, 0]),
        geoDirS: new Float64Array([1, 0, 0]),
        distAU: 0,
        distER: 0,
        lightTimeS: 0,
        altGeomDeg: 0,
        azGeomDeg: 0,
        altDeg: 0,
        azDeg: 0,
        raJ2000H: 0,
        decJ2000Deg: 0,
        raDateH: 0,
        decDateDeg: 0,
        mag: 0,
        phaseFrac: 1,
        phaseAngleDeg: 0,
        elongDeg: 0,
        elongSide: null,
        angDiamArcsec: 0,
        constellation: { symbol: '', name: '' },
        subLatDeg: 0,
        subLonDeg: 0,
        above: false,
    };
}

/**
 * Allocates a snapshot whose typed arrays are reused by every subsequent
 * {@link computeSnapshot} call. Before the first computation it holds a valid
 * but meaningless state (identity Earth, observer at 0°/0°, tMs 0).
 * @returns {Snapshot}
 */
export function createSnapshot() {
    const moonMatrix = identity16();
    moonMatrix[12] = 60.27;
    return {
        tMs: 0,
        jdUT: 2440587.5,
        detail: 'frame',
        gastDeg: 0,
        earthMatrix: identity16(),
        earthQuat: new Float64Array([0, 0, 0, 1]),
        sunDirS: new Float64Array([1, 0, 0]),
        moonPosS: new Float64Array([60.27, 0, 0]),
        moonMatrix,
        moonPhaseDeg: 0,
        observer: {
            latDeg: 0,
            lonDeg: 0,
            elevM: 0,
            posS: new Float64Array([1, 0, 0]),
            upS: new Float64Array([1, 0, 0]),
            northS: new Float64Array([0, 1, 0]),
            eastS: new Float64Array([0, 0, -1]),
            sunAltDeg: 0,
            twilight: 'day',
        },
        bodies: BODIES.map(makeBodyState),
        eclipse: { solar: false, lunar: false, obscurationAtObserver: 0, moonLitFraction: 1 },
    };
}

// The AE.Observer is cached: snapshot and snapFull share it, and it only
// changes when the user moves the pin.
let obsLat = NaN;
let obsLon = NaN;
let obsElev = NaN;
let aeObserver = null;

function observerFor(o) {
    let lat = o ? Number(o.latDeg) : NaN;
    let lon = o ? Number(o.lonDeg) : NaN;
    let elev = o ? Number(o.elevM) : NaN;
    // Sanitise rather than throw: this runs inside the render loop, and a
    // frozen app is a worse failure than a pin snapped to a valid value.
    lat = Number.isFinite(lat) ? Math.min(90, Math.max(-90, lat)) : 0;
    lon = Number.isFinite(lon) ? (lon >= -180 && lon <= 180 ? lon : wrap180(lon)) : 0;
    elev = Number.isFinite(elev) ? Math.min(100000, Math.max(-500, elev)) : 0;
    if (aeObserver === null || lat !== obsLat || lon !== obsLon || elev !== obsElev) {
        aeObserver = new AE.Observer(lat, lon, elev);
        obsLat = lat;
        obsLon = lon;
        obsElev = elev;
    }
    return aeObserver;
}

// EQJ (x, y, z) → normalised scene vector (x, z, −y).
function setSceneUnit(out, x, y, z) {
    const len = Math.hypot(x, y, z);
    const k = len > 0 ? 1 / len : 0;
    out[0] = x * k;
    out[1] = z * k;
    out[2] = -y * k;
}

// J2000 ecliptic longitude (degrees) of an EQJ vector stored at GEO[i*3].
function eclLonJ2000(i) {
    const x = GEO[i * 3], y = GEO[i * 3 + 1], z = GEO[i * 3 + 2];
    return Math.atan2(y * COS_OBL + z * SIN_OBL, x) * RAD2DEG;
}

// Angle (radians) between the geocentric vectors of bodies i and j.
function geoAngle(i, j) {
    const ax = GEO[i * 3], ay = GEO[i * 3 + 1], az = GEO[i * 3 + 2];
    const bx = GEO[j * 3], by = GEO[j * 3 + 1], bz = GEO[j * 3 + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + az * bz);
}

/**
 * Computes the sky for one instant and one observer into `out` (in place).
 *
 * Calls (SPEC §D.4): per body `Equator(body, t, obs, false, false)` for the
 * rendered topocentric astrometric J2000 direction, `GeoVector(body, t, true)`
 * (GeoMoon for the Moon) for the geocentric direction, and `Illumination`;
 * per frame `SiderealTime`, `Rotation_EQD_EQJ`, `RotationAxis('Moon')`. Full
 * detail adds `Equator(…, true, true)` + `Horizon(…, 'normal')`,
 * `Constellation` and `MoonPhase`.
 *
 * Elongation is the angle between GeoVector(Sun, t, true) and
 * GeoVector(body, t, true), i.e. exactly what AE.AngleFromSun computes, reusing
 * the vectors already in hand. Sub-points are taken from the geocentric
 * direction (Eᵀ·geoDirS), the same construction as the rendered sub-point
 * dots, so the Moon's parallax does not displace its sub-lunar point.
 *
 * Invalid input never throws: a non-finite tMs leaves `out` untouched, and
 * non-finite observer fields fall back to 0 (latitude is clamped to ±90°).
 *
 * @param {number} tMs UTC milliseconds.
 * @param {{latDeg:number, lonDeg:number, elevM?:number}} observer Geodetic WGS84 position.
 * @param {Snapshot} out A snapshot from {@link createSnapshot}.
 * @param {{detail?:'frame'|'full'}} [opts]
 * @returns {Snapshot} `out`
 */
export function computeSnapshot(tMs, observer, out, opts) {
    if (!out || !out.bodies || out.bodies.length !== N_BODIES) {
        throw new TypeError('computeSnapshot: `out` must come from createSnapshot()');
    }
    if (!Number.isFinite(tMs)) return out;
    const full = opts != null && opts.detail === 'full';
    const time = AE.MakeTime(new Date(tMs));
    const obs = observerFor(observer);

    out.tMs = tMs;
    out.jdUT = tMs / 86400000 + 2440587.5;
    out.detail = full ? 'full' : 'frame';

    // Earth orientation: E = PN·Rz(GAST); earthMatrix = embed(S·E·Sᵀ).
    out.gastDeg = earthRotationM3(time, E3);
    const em = m3ToSceneM4(E3, out.earthMatrix);
    m4ToQuat(em, out.earthQuat);

    // Observer frame. The pin sits on the unit sphere at the geodetic lat/lon,
    // so its normal is the WGS84 geodetic zenith that astronomy-engine uses.
    const o = out.observer;
    o.latDeg = obsLat;
    o.lonDeg = obsLon;
    o.elevM = obsElev;
    enuLocal(obsLat, obsLon, LOCAL);
    m4MulDir(em, LOCAL.up, o.posS);
    m4MulDir(em, LOCAL.up, o.upS);
    m4MulDir(em, LOCAL.north, o.northS);
    m4MulDir(em, LOCAL.east, o.eastS);

    for (let i = 0; i < N_BODIES; i++) {
        const b = BODIES[i];
        const st = out.bodies[i];

        // Rendered direction: topocentric, astrometric, J2000, light-time corrected.
        const eq = AE.Equator(b.ae, time, obs, false, false);
        const v = eq.vec;
        setSceneUnit(st.dirS, v.x, v.y, v.z);
        st.distAU = eq.dist;
        st.distER = eq.dist * AU_ER;
        st.lightTimeS = eq.dist * LIGHT_S_PER_AU;

        // Geocentric direction (sub-points, footprint, lighting).
        const g = i === MOON ? AE.GeoMoon(time) : AE.GeoVector(b.ae, time, true);
        GEO[i * 3] = g.x;
        GEO[i * 3 + 1] = g.y;
        GEO[i * 3 + 2] = g.z;
        setSceneUnit(st.geoDirS, g.x, g.y, g.z);

        dirToAltAz(st.dirS, o.upS, o.northS, o.eastS, ALTAZ);
        st.altGeomDeg = ALTAZ.altDeg;
        st.azGeomDeg = ALTAZ.azDeg;

        sceneToRaDec(st.dirS, RADEC);
        st.raJ2000H = RADEC.raDeg / 15;
        st.decJ2000Deg = RADEC.decDeg;

        const ill = AE.Illumination(b.ae, time);
        st.mag = ill.mag;
        st.phaseAngleDeg = ill.phase_angle;
        st.phaseFrac = ill.phase_fraction;
        st.angDiamArcsec = 2 * Math.atan(b.radiusKm / (eq.dist * AU_KM)) * RAD2ARCSEC;

        if (i === SUN) {
            st.elongDeg = 0;
            st.elongSide = null;
        } else {
            // The Sun (index 0) is always processed first, so GEO[0..2] is ready.
            st.elongDeg = geoAngle(SUN, i) * RAD2DEG;
            st.elongSide = wrap360(eclLonJ2000(i) - eclLonJ2000(SUN)) > 180 ? 'morning' : 'evening';
        }

        m4MulDirT(em, st.geoDirS, SUB_LOCAL);
        localToLatLon(SUB_LOCAL, LATLON);
        st.subLatDeg = LATLON.latDeg;
        st.subLonDeg = LATLON.lonDeg;

        if (full) {
            const eqd = AE.Equator(b.ae, time, obs, true, true);
            const hor = AE.Horizon(time, obs, eqd.ra, eqd.dec, 'normal');
            st.altDeg = hor.altitude;
            st.azDeg = hor.azimuth;
            st.raDateH = eqd.ra;
            st.decDateDeg = eqd.dec;
            const c = AE.Constellation(st.raJ2000H, st.decJ2000Deg);
            st.constellation.symbol = c.symbol;
            st.constellation.name = c.name;
        } else {
            st.altDeg = st.altGeomDeg + refractionDeg(st.altGeomDeg);
            st.azDeg = st.azGeomDeg;
        }
        // Sun and Moon count as up while their upper limb clears the horizon.
        const semiDeg = i === SUN || i === MOON ? st.angDiamArcsec / 7200 : 0;
        st.above = st.altDeg + semiDeg > 0;
    }

    const sun = out.bodies[SUN];
    out.sunDirS[0] = sun.geoDirS[0];
    out.sunDirS[1] = sun.geoDirS[1];
    out.sunDirS[2] = sun.geoDirS[2];
    o.sunAltDeg = sun.altGeomDeg;
    o.twilight = twilightClass(o.sunAltDeg);

    // Moon at true scale: centre in Earth radii, IAU orientation (libration).
    const mp = out.moonPosS;
    mp[0] = GEO[MOON * 3] * AU_ER;
    mp[1] = GEO[MOON * 3 + 2] * AU_ER;
    mp[2] = -GEO[MOON * 3 + 1] * AU_ER;
    const ax = AE.RotationAxis('Moon', time);
    iauBodyMatrix(ax.ra, ax.dec, ax.spin, MOON_R3);
    m3ToSceneM4(MOON_R3, out.moonMatrix, mp[0], mp[1], mp[2]);

    out.moonPhaseDeg = full
        ? AE.MoonPhase(time)
        : wrap360(eclLonJ2000(MOON) - eclLonJ2000(SUN));

    // Eclipse flags from the geocentric Sun–Moon geometry.
    const sepSun = geoAngle(SUN, MOON);
    const ecl = out.eclipse;
    ecl.solar = sepSun < ECLIPSE_SEP_RAD;
    ecl.lunar = Math.PI - sepSun < LUNAR_ECLIPSE_SEP_RAD;
    // Only while the Sun is up: from the night side the line of sight to the
    // Sun runs through the Earth, and the geometry alone would still report cover.
    ecl.obscurationAtObserver = ecl.solar && sun.above
        ? solarObscurationAt(o.posS, mp, out.sunDirS, Math.asin(SUN_RADIUS_KM / (sun.distAU * AU_KM)))
        : 0;

    // Eclipse dimming. AE.Illumination ignores shadows, so without this a
    // totally eclipsed Moon would still read about −12.7.
    if (ecl.obscurationAtObserver > 0) {
        sun.mag += -2.5 * Math.log10(Math.max(1 - ecl.obscurationAtObserver, SUN_ECLIPSE_FLOOR));
    }
    if (ecl.lunar) {
        lunarEclipseLight(mp, out.sunDirS, sun.distAU * AU_ER, LUNAR);
        ecl.moonLitFraction = LUNAR.lit;
        if (LUNAR.flux < 1) out.bodies[MOON].mag += -2.5 * Math.log10(Math.max(LUNAR.flux, MOON_ECLIPSE_FLOOR));
    } else {
        ecl.moonLitFraction = 1;
    }
    return out;
}
