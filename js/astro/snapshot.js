/**
 * Per-frame astronomy snapshot (SPEC §C.2, §D.3–D.4).
 *
 * `createSnapshot()` preallocates every typed array once; `computeSnapshot()`
 * rewrites them in place and allocates no typed arrays or containers of its
 * own (astronomy-engine's internal temporaries are unavoidable). Measured cost
 * in Node 22 on a desktop CPU: about 0.15 ms for 'frame', 0.22 ms for 'full'.
 *
 * Disc drawing (render/planets.js, ui/eyepiece.js, via astro/disc.js) gets, at both details:
 * each planet's IAU pole `poleS`, prime meridian `primeS` and `spinDeg` at the instant its light
 * left (AE.RotationAxis at t − light time; seven cheap calls, ~6 µs, so the renderers' 'frame'
 * snapshot has them too), every body's `lightS` toward the Sun, Saturn's `ringTiltDeg` (from the
 * Illumination already computed) and Jupiter's moons (`galilean`, astro/moons.js, ~20 µs). The
 * Moon's libration (`libration`, AE.Libration) only feeds the panels, so it is 'full' only.
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
 * One eclipse geometry. The Moon's `dirS` is made astrometric like every other
 * direction (see {@link computeSnapshot}), so the Sun–Moon separation between
 * the `dirS` vectors is the apparent one. `obscurationAtObserver`, the drawn
 * sky-view discs, the lens flare and the Sky panel all use that pair with the
 * true angular radii, asin(R / d) at the topocentric distances; their second
 * and third contacts fall within 0.1 s of AE.SearchLocalSolarEclipse.
 *
 * @module astro/snapshot
 */
import { AE } from './ae.js';
import { BODIES, AU_ER, AU_KM, LIGHT_S_PER_AU, sunAngularRadius } from './bodies.js';
import {
    DEG2RAD, RAD2DEG, OBLIQUITY_J2000_DEG, wrap180, wrap360,
    earthRotationM3, m3ToSceneM4, m4ToQuat, m4MulDir, m4MulDirT,
    enuLocal, dirToAltAz, sceneToRaDec, localToLatLon, iauBodyMatrix, angleBetween3,
} from './frames.js';
import { refractionDeg, twilightClass } from './photometry.js';
import { discVisibleFraction, lunarEclipseLight } from './shadow.js';
import { bailysBeads, createBeads, NO_GAP } from './totality.js';
import { createSkyglow } from './skyglow.js';
import { createGalilean, computeGalilean, lunarLibration } from './moons.js';
import { createAurora } from './geomag.js';

const N_BODIES = BODIES.length;
const SUN = 0;
const MOON = 1;
const JUPITER = BODIES.findIndex((b) => b.id === 'jupiter');
const RAD2ARCSEC = RAD2DEG * 3600;
const ECLIPSE_SEP_RAD = 1.6 * DEG2RAD;
// Penumbral contact of a perigee lunar eclipse is ≈1.603° from the antisun.
const LUNAR_ECLIPSE_SEP_RAD = 1.65 * DEG2RAD;
// Brightness floor of a totally eclipsed Sun, relative to the full disc: +15 mag,
// about the integrated corona (≈ −12, like a full Moon).
const SUN_ECLIPSE_FLOOR = 1e-6;
const MOON_ECLIPSE_FLOOR = 1e-6;
const COS_OBL = Math.cos(OBLIQUITY_J2000_DEG * DEG2RAD);
const SIN_OBL = Math.sin(OBLIQUITY_J2000_DEG * DEG2RAD);

// Module-level scratch, reused by every call (R5).
const E3 = new Float64Array(9);                 // EF → EQJ, row-major
const MOON_R3 = new Float64Array(9);            // Moon body-fixed → EQJ
const BODY_R3 = new Float64Array(9);            // a planet's body-fixed → EQJ
const GEO = new Float64Array(3 * N_BODIES);     // geocentric EQJ vectors (AU), as GeoVector(…, true)
const ABER = new Float64Array(3);               // the Sun's annual aberration: apparent − astrometric unit vector (scene)
const LOCAL = { east: new Float64Array(3), north: new Float64Array(3), up: new Float64Array(3) };
const SUB_LOCAL = new Float64Array(3);
const ALTAZ = { altDeg: 0, azDeg: 0 };
const RADEC = { raDeg: 0, decDeg: 0 };
const LATLON = { latDeg: 0, lonDeg: 0 };
const LUNAR = { lit: 1, flux: 1 };
const MOON_POLE = new Float64Array(3);

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
        poleS: new Float64Array([0, 1, 0]),
        primeS: new Float64Array([1, 0, 0]),
        spinDeg: 0,
        lightS: new Float64Array([-1, 0, 0]),
        ringTiltDeg: 0,
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
        sunPoleS: new Float64Array([0, 1, 0]),
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
        // Heliocentric positions, AU, scene axes, Sun at the origin (the solar-system zoom).
        helio: { earthS: new Float64Array([1, 0, 0]), posS: new Float64Array(3 * N_BODIES) },
        eclipse: { solar: false, lunar: false, obscurationAtObserver: 0, moonLitFraction: 1, beads: createBeads() },
        galilean: createGalilean(),
        libration: { elonDeg: 0, elatDeg: 0 },
        // Filled by the frame loop (computeSkyglow) after each computeSnapshot: it needs the site.
        skyglow: createSkyglow(),
        // Filled by the frame loop (computeAurora) after each computeSnapshot: it needs the activity setting.
        aurora: createAurora(),
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
 * Removes annual aberration from the Moon's direction `d` (scene unit vector, in place).
 *
 * astronomy-engine's Moon (GeoMoon, and Equator(Moon, …) with either aberration flag) is the
 * geometric position, which for the Moon is its apparent place: over the 1.3 s light time the
 * Earth's orbital motion and annual aberration cancel to 0.7″. Every other `dirS` is astrometric
 * (light-time corrected, no aberration), like the J2000 star catalogue, so the raw Moon sat ~20″
 * off against the Sun and the stars: at Luxor's greatest eclipse of 2027-08-02 the Sun–Moon
 * separation read 19″ instead of 9″, moving the contacts by ~50 s. Subtracting the aberration a
 * star in the Moon's direction has, Δ(u) = v − u·(u·v) with v ≈ ABER (the Earth's velocity over
 * c, from the Sun's apparent − astrometric direction; its unknown radial part is ≤ 0.35″),
 * restores the apparent Sun–Moon and star–Moon geometry inside the astrometric frame.
 * @param {Float64Array} d
 */
function moonToAstrometric(d) {
    const k = d[0] * ABER[0] + d[1] * ABER[1] + d[2] * ABER[2];
    const x = d[0] - (ABER[0] - d[0] * k);
    const y = d[1] - (ABER[1] - d[1] * k);
    const z = d[2] - (ABER[2] - d[2] * k);
    const s = 1 / Math.hypot(x, y, z);
    d[0] = x * s;
    d[1] = y * s;
    d[2] = z * s;
}

/**
 * Computes the sky for one instant and one observer into `out` (in place).
 *
 * Calls (SPEC §D.4): per body `Equator(body, t, obs, false, false)` for the
 * rendered topocentric astrometric J2000 direction, `GeoVector(body, t, true)`
 * (GeoMoon for the Moon) for the geocentric direction, and `Illumination`;
 * per frame `SiderealTime`, `Rotation_EQD_EQJ`, `RotationAxis('Moon')`, and
 * `Equator(Sun, t, obs, false, true)` for the annual aberration that makes the
 * Moon's direction astrometric too (`moonToAstrometric`). Full detail adds
 * `Equator(…, true, true)` + `Horizon(…, 'normal')`, `Constellation` and
 * `MoonPhase`. `RotationAxis('Sun')` (→ `sunPoleS`, the corona's orientation)
 * runs at full detail and, during solar eclipses, at frame detail too; near
 * second and third contact `eclipse.beads` holds the open lunar-limb valleys
 * (astro/totality.js `bailysBeads`, from the same dirS pair as the obscuration).
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

        // Rendered direction: topocentric (WGS84), astrometric, J2000, light-time corrected.
        const eq = AE.Equator(b.ae, time, obs, false, false);
        const v = eq.vec;
        setSceneUnit(st.dirS, v.x, v.y, v.z);
        if (i === SUN) {
            const va = AE.Equator(b.ae, time, obs, false, true).vec;
            setSceneUnit(ABER, va.x, va.y, va.z);
            ABER[0] -= st.dirS[0];
            ABER[1] -= st.dirS[1];
            ABER[2] -= st.dirS[2];
        } else if (i === MOON) {
            // The Sun (index 0) is always processed first, so ABER is ready.
            moonToAstrometric(st.dirS);
        }
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
        st.ringTiltDeg = Number.isFinite(ill.ring_tilt) ? ill.ring_tilt : 0;

        // Toward the Sun from the body: the two topocentric astrometric vectors (the Sun, index 0,
        // comes first). The Sun itself faces the observer.
        const sun0 = out.bodies[SUN];
        if (i === SUN) {
            st.lightS[0] = -st.dirS[0]; st.lightS[1] = -st.dirS[1]; st.lightS[2] = -st.dirS[2];
        } else {
            const ds = sun0.distAU, db = st.distAU;
            const lx = sun0.dirS[0] * ds - st.dirS[0] * db;
            const ly = sun0.dirS[1] * ds - st.dirS[1] * db;
            const lz = sun0.dirS[2] * ds - st.dirS[2] * db;
            const ll = Math.hypot(lx, ly, lz) || 1;
            st.lightS[0] = lx / ll; st.lightS[1] = ly / ll; st.lightS[2] = lz / ll;
        }
        // A planet's IAU pole and prime meridian at the instant its light left (what is seen now).
        if (b.kind === 'planet') {
            const ax = AE.RotationAxis(b.ae, time.AddDays(-st.lightTimeS / 86400));
            iauBodyMatrix(ax.ra, ax.dec, ax.spin, BODY_R3);
            setSceneUnit(st.poleS, BODY_R3[2], BODY_R3[5], BODY_R3[8]);
            setSceneUnit(st.primeS, BODY_R3[0], BODY_R3[3], BODY_R3[6]);
            st.spinDeg = wrap360(ax.spin);
        }
        // A sphere's true angular size, asin(R / d) (for the Sun exactly sunAngularRadius).
        st.angDiamArcsec = 2 * Math.asin(Math.min(1, b.radiusKm / (eq.dist * AU_KM))) * RAD2ARCSEC;

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
    const mst = out.bodies[MOON];
    setSceneUnit(mst.poleS, MOON_R3[2], MOON_R3[5], MOON_R3[8]);
    setSceneUnit(mst.primeS, MOON_R3[0], MOON_R3[3], MOON_R3[6]);
    mst.spinDeg = wrap360(ax.spin);

    // Heliocentric positions (the solar-system zoom, astro/orrery.js), both details: the Earth's
    // geometric AE.HelioVector, and every other body at the Earth plus its geocentric vector, so
    // the orrery's Earth→body line is exactly the body's geocentric direction (the Sun stays at
    // the origin, 20″ of aberration from it). AU, scene axes.
    const he = AE.HelioVector('Earth', time);
    const hl = out.helio;
    hl.earthS[0] = he.x; hl.earthS[1] = he.z; hl.earthS[2] = -he.y;
    const hp = hl.posS;
    hp[0] = hp[1] = hp[2] = 0;
    for (let i = 1; i < N_BODIES; i++) {
        hp[i * 3] = he.x + GEO[i * 3];
        hp[i * 3 + 1] = he.z + GEO[i * 3 + 2];
        hp[i * 3 + 2] = -(he.y + GEO[i * 3 + 1]);
    }

    // Jupiter's moons follow Jupiter's light time (moons.js); the libration only feeds the panels.
    computeGalilean(time, out.bodies[JUPITER], out.galilean);
    if (full) lunarLibration(time, out.libration);

    out.moonPhaseDeg = full
        ? AE.MoonPhase(time)
        : wrap360(eclLonJ2000(MOON) - eclLonJ2000(SUN));

    // Eclipse flags from the geocentric Sun–Moon geometry.
    const sepSun = geoAngle(SUN, MOON);
    const ecl = out.eclipse;
    ecl.solar = sepSun < ECLIPSE_SEP_RAD;
    ecl.lunar = Math.PI - sepSun < LUNAR_ECLIPSE_SEP_RAD;
    // At the observer: the discs the sky view draws, i.e. the Sun's and the Moon's dirS (apparent
    // separation, WGS84 parallax) with their true topocentric radii. Only while the Sun is up: from
    // the night side the line of sight to the Sun runs through the Earth, and the geometry alone
    // would still report cover.
    const moon = out.bodies[MOON];
    ecl.obscurationAtObserver = ecl.solar && sun.above
        ? 1 - discVisibleFraction(sunAngularRadius(sun.distAU),
            Math.asin(Math.min(1, BODIES[MOON].radiusKm / (moon.distAU * AU_KM))),
            angleBetween3(sun.dirS, moon.dirS))
        : 0;

    // Totality (render: corona orientation, Baily's beads). The Sun's IAU rotation pole at 'full'
    // detail, and at 'frame' detail during solar eclipses, when the corona needs it.
    if (full || ecl.solar) {
        const pole = AE.RotationAxis('Sun', time).north;
        setSceneUnit(out.sunPoleS, pole.x, pole.y, pole.z);
        const sp = out.bodies[SUN].poleS;
        sp[0] = out.sunPoleS[0]; sp[1] = out.sunPoleS[1]; sp[2] = out.sunPoleS[2];
    }
    const mm = out.moonMatrix;
    if (ecl.solar && sun.above) {
        // Lunar position angles count from the Moon's north pole (its body +Z, moonMatrix column 2).
        MOON_POLE[0] = mm[8]; MOON_POLE[1] = mm[9]; MOON_POLE[2] = mm[10];
        bailysBeads(sun.dirS, moon.dirS, sunAngularRadius(sun.distAU),
            Math.asin(Math.min(1, BODIES[MOON].radiusKm / (moon.distAU * AU_KM))), MOON_POLE, ecl.beads);
    } else {
        ecl.beads.count = 0;
        ecl.beads.total = 0;
        ecl.beads.gapArcsec = NO_GAP;
    }

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
