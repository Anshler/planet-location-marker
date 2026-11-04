/**
 * Vantage points (pure): where the camera stands for 'View from L1' and 'Earthrise', recomputed
 * from each snapshot by the camera rig (js/camera/rig.js setVantage), so time-lapse moves them.
 *
 * L1 (DSCOVR/EPIC): 235 Earth radii (1.5 million km) sunward, looking back at the sunlit disc with
 * celestial north up and a 0.7° field. The camera sits L1_OFFSET_DEG off the Sun–Earth line toward
 * ecliptic north, as DSCOVR's Lissajous orbit keeps 4–15° off it: exactly on the line, the Moon of
 * a solar eclipse would sit on top of its own shadow (it is 175 R from the camera, the shadow 235),
 * while 4° of parallax moves it 1.4° aside, out of the frame.
 *
 * Earthrise (Kaguya/Apollo 8): a circular orbit LUNAR_ALT_KM above the Moon in the plane through
 * the Earth direction closest to the ecliptic, rising over the sunlit limb. The plan fixes the orbit
 * in space at the moment of entry, with the phase chosen so that the Earth's centre stands
 * EARTHRISE_DEG above the lunar limb, rising; from there the spacecraft keeps orbiting with sim
 * time (period ≈ 122.6 min), so time-lapse makes the Earth rise and set once per orbit. The camera
 * holds a local-vertical attitude (as orbiters do): it looks along the track at the Earth, pitched
 * down so the limb crosses the frame at LIMB_NDC_Y below the centre, and the Earth climbs through it.
 *
 * Depth: from 60 or 235 R a near plane of 0.05 leaves a 24-bit depth buffer 0.004–0.07 R of
 * resolution, coarser than the 0.006 R cloud gap. vantageNear() puts the near plane at 0.8 of the
 * distance to whatever is nearest; when the camera is close to the Moon (moonInFront), the Moon is
 * left out of that and drawn in front of everything (render/bodies.js, FrameInfo.moonFront).
 *
 * Vectors are Float64Array(3) in the scene frame (+Y = J2000 north pole, Earth radii, Earth at the
 * origin).
 *
 * @module astro/vantage
 */
import { MOON_RADIUS_ER, EARTH_RADIUS_KM } from './bodies.js';

const DEG = Math.PI / 180;

/** Vantage kinds, as `view.vantage` and the URL's `vt` carry them ('none' = the ordinary globe). */
export const VANTAGE_KINDS = Object.freeze(['none', 'l1', 'moon']);

/** Sun–Earth L1, 1.5 million km sunward, in Earth radii. */
export const L1_DIST_ER = 1.5e6 / EARTH_RADIUS_KM;
/** The camera's angle from the Sun–Earth line (DSCOVR stays 4–15° off it). */
export const L1_OFFSET_DEG = 4;
/** L1 field of view across the narrower side of the view: the disc (0.49°) fills ~70 % of it. */
export const L1_FOV_DEG = 0.7;
/** Earthrise orbit: height above the Moon's mean radius, km (Kaguya flew at 100 km). */
export const LUNAR_ALT_KM = 150;
/** The Moon's GM, km³/s² (DE440). */
export const MOON_GM = 4902.800;
/** Earthrise field of view across the narrower side, and the most a tall portrait view may open to. */
export const EARTHRISE_FOV_DEG = 18;
const EARTHRISE_FOV_MAX = 32;
/** Height of the Earth's centre above the lunar limb when the vantage is entered, degrees. */
export const EARTHRISE_DEG = 2.2;
/** Where the limb crosses the frame: this fraction of the half-height below the centre. */
export const LIMB_NDC_Y = 0.5;
/** Within this distance of the Moon (and nearer to it than half the Earth's distance) it is drawn in front of everything. */
const MOON_FRONT_DIST = 8;
/** The aurora shell (render/aurora.js, 1.05 R) with a margin: nothing of the Earth reaches farther out. */
const EARTH_SHELL = 1.06;
const NEAR_MIN = 0.003;

// J2000 ecliptic north pole in the scene frame: EQJ (0, −sin ε, cos ε) → S(x, y, z) = (x, z, −y).
const OBLIQUITY = 23.4392911 * DEG;
const ECL_POLE_S = Object.freeze([0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY)]);

/** @param {unknown} k @returns {boolean} true for 'l1' and 'moon' */
export function isVantage(k) {
    return k === 'l1' || k === 'moon';
}

/** A vantage pose: camera position, forward and up (unit) in the scene frame, and the vertical field of view. */
export function createPose() {
    return { pos: new Float64Array(3), fwd: new Float64Array(3), up: new Float64Array(3), fovDeg: 45 };
}

/**
 * The vertical field of view (degrees) of a vantage for a view `aspect` (width / height): the
 * vantage's field spans the narrower side, so a portrait phone still holds the whole disc.
 * @param {'l1'|'moon'} kind
 * @param {number} aspect
 * @returns {number}
 */
export function vantageFov(kind, aspect) {
    const a = aspect > 0 && Number.isFinite(aspect) ? Math.min(1, aspect) : 1;
    const f = kind === 'l1' ? L1_FOV_DEG : EARTHRISE_FOV_DEG;
    const v = 2 * Math.atan(Math.tan(f * DEG / 2) / a) / DEG;
    return kind === 'l1' ? v : Math.min(EARTHRISE_FOV_MAX, v);
}

/**
 * True when the Moon is the nearest thing to the camera by far (lunar orbit, or a flight there):
 * then it is drawn in front of everything and the near plane may ignore it.
 * @param {number} r camera distance from the Earth's centre (Earth radii)
 * @param {number} dm camera distance from the Moon's centre
 * @returns {boolean}
 */
export function moonInFront(r, dm) {
    return dm < MOON_FRONT_DIST && dm < 0.5 * r;
}

/**
 * Near-plane distance for a camera far out: 0.8 of the distance to the nearest drawn surface (the
 * Earth's outermost shell, or the Moon unless it is drawn in front, `front`), so a 24-bit depth
 * buffer keeps the Earth's cloud and atmosphere shells apart from 235 R.
 * @param {number} r camera distance from the Earth's centre
 * @param {number} dm camera distance from the Moon's centre
 * @param {boolean} front moonInFront(r, dm)
 * @returns {number}
 */
export function vantageNear(r, dm, front) {
    const toEarth = r - EARTH_SHELL;
    const toMoon = front || !Number.isFinite(dm) ? Infinity : dm - MOON_RADIUS_ER * 1.02;
    const n = 0.8 * Math.min(toEarth, toMoon);
    return Number.isFinite(n) && n > NEAR_MIN ? n : NEAR_MIN;
}

function norm3(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 0) { v[0] /= l; v[1] /= l; v[2] /= l; }
    return l;
}

/**
 * 'View from L1' at the snapshot: 235 R out, L1_OFFSET_DEG from the Sun toward ecliptic north,
 * looking at the Earth's centre with celestial north up.
 * @param {{sunDirS:ArrayLike<number>}} snap
 * @param {number} aspect view width / height
 * @param {ReturnType<typeof createPose>} out
 * @returns {ReturnType<typeof createPose>} out
 */
export function l1Pose(snap, aspect, out) {
    const s = snap.sunDirS;
    // Ecliptic north, square to the Sun (which never leaves the ecliptic by more than an arcsecond).
    const k = ECL_POLE_S[0] * s[0] + ECL_POLE_S[1] * s[1] + ECL_POLE_S[2] * s[2];
    const p = out.up;
    p[0] = ECL_POLE_S[0] - k * s[0]; p[1] = ECL_POLE_S[1] - k * s[1]; p[2] = ECL_POLE_S[2] - k * s[2];
    if (!(norm3(p) > 1e-9)) { p[0] = 0; p[1] = 1; p[2] = 0; }
    const c = Math.cos(L1_OFFSET_DEG * DEG), sn = Math.sin(L1_OFFSET_DEG * DEG);
    const d = out.fwd;
    d[0] = c * s[0] + sn * p[0]; d[1] = c * s[1] + sn * p[1]; d[2] = c * s[2] + sn * p[2];
    norm3(d);
    for (let i = 0; i < 3; i++) {
        out.pos[i] = d[i] * L1_DIST_ER;
        d[i] = -d[i];
    }
    // North up: the J2000 pole square to the view.
    const y = d[1];
    out.up[0] = -y * d[0]; out.up[1] = 1 - y * d[1]; out.up[2] = -y * d[2];
    if (!(norm3(out.up) > 1e-9)) { out.up[0] = 1; out.up[1] = 0; out.up[2] = 0; }
    out.fovDeg = vantageFov('l1', aspect);
    return out;
}

/** The Earthrise orbit's radius from the Moon's centre (Earth radii). */
const LUNAR_ORBIT_ER = MOON_RADIUS_ER + LUNAR_ALT_KM / EARTH_RADIUS_KM;
/** Depression of the lunar limb below the orbiter's horizontal (radians). */
export const LIMB_DIP_RAD = Math.acos(MOON_RADIUS_ER / LUNAR_ORBIT_ER);

/** Period of a circular orbit `altKm` above the Moon's mean radius, seconds. */
export function lunarPeriodS(altKm = LUNAR_ALT_KM) {
    const a = 1737.4 + altKm;
    return 2 * Math.PI * Math.sqrt(a * a * a / MOON_GM);
}

/** An empty Earthrise plan (planLunarOrbit fills it). */
export function createLunarPlan() {
    return { tMs: 0, phi0: 0, periodS: lunarPeriodS(), u: new Float64Array(3), q: new Float64Array(3) };
}

const _n = new Float64Array(3);
const _c = new Float64Array(3);

/** Orbiter direction from the Moon's centre at orbit angle phi: cos φ·(−u) + sin φ·q. */
function orbitDir(plan, phi, out) {
    const c = Math.cos(phi), s = Math.sin(phi);
    for (let i = 0; i < 3; i++) out[i] = -c * plan.u[i] + s * plan.q[i];
    return out;
}

/**
 * How far the Earth's centre stands above the lunar limb, degrees, seen from orbit angle phi with
 * the Moon at moonPosS: its elevation over the orbiter's horizontal plus the limb's dip.
 */
function aboveLimbDeg(plan, phi, m) {
    orbitDir(plan, phi, _n);
    for (let i = 0; i < 3; i++) _c[i] = -(m[i] + LUNAR_ORBIT_ER * _n[i]);
    norm3(_c);
    const el = Math.asin(Math.max(-1, Math.min(1, _c[0] * _n[0] + _c[1] * _n[1] + _c[2] * _n[2])));
    return (el + LIMB_DIP_RAD) / DEG;
}

/**
 * Plans the Earthrise orbit at the snapshot: its plane holds the Earth direction and lies as close
 * to the ecliptic as that allows; the orbiter rises over the limb on the Sun's side, so the
 * foreground is lit whenever the Moon's limb can be; and at snap.tMs the Earth's centre stands
 * EARTHRISE_DEG above the limb, climbing.
 * @param {{tMs:number, moonPosS:ArrayLike<number>, sunDirS:ArrayLike<number>}} snap
 * @param {ReturnType<typeof createLunarPlan>} [out]
 * @returns {ReturnType<typeof createLunarPlan>} out
 */
export function planLunarOrbit(snap, out = createLunarPlan()) {
    const m = snap.moonPosS, s = snap.sunDirS;
    const u = out.u, q = out.q;
    u[0] = m[0]; u[1] = m[1]; u[2] = m[2];
    norm3(u);
    // In the ecliptic, square to the Earth–Moon line: pole × u.
    q[0] = ECL_POLE_S[1] * u[2] - ECL_POLE_S[2] * u[1];
    q[1] = ECL_POLE_S[2] * u[0] - ECL_POLE_S[0] * u[2];
    q[2] = ECL_POLE_S[0] * u[1] - ECL_POLE_S[1] * u[0];
    if (!(norm3(q) > 1e-9)) { q[0] = u[2]; q[1] = 0; q[2] = -u[0]; norm3(q); }
    // The rise happens over the limb at −q: put it on the Sun's side.
    if (q[0] * s[0] + q[1] * s[1] + q[2] * s[2] > 0) { q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; }
    out.tMs = snap.tMs;
    out.periodS = lunarPeriodS();
    // Rising point: elevation −dip + EARTHRISE_DEG, approached from the far side (φ < −90°);
    // d(height)/dφ ≈ 1, so a few fixed-point steps settle it to well under an arcsecond.
    let phi = -(Math.PI / 2 + LIMB_DIP_RAD - EARTHRISE_DEG * DEG);
    for (let k = 0; k < 5; k++) phi += (EARTHRISE_DEG - aboveLimbDeg(out, phi, m)) * DEG;
    out.phi0 = phi;
    return out;
}

/**
 * The Earthrise pose at the snapshot: the orbiter's place (it keeps orbiting with sim time from
 * the plan), looking along its track with the limb at LIMB_NDC_Y below the centre.
 * @param {ReturnType<typeof createLunarPlan>} plan
 * @param {{tMs:number, moonPosS:ArrayLike<number>}} snap
 * @param {number} aspect view width / height
 * @param {ReturnType<typeof createPose>} out
 * @returns {ReturnType<typeof createPose>} out
 */
export function lunarOrbitPose(plan, snap, aspect, out) {
    const phi = lunarPhase(plan, snap.tMs);
    const n = orbitDir(plan, phi, _n);
    const c = Math.cos(phi), s = Math.sin(phi);
    const m = snap.moonPosS;
    const fov = vantageFov('moon', aspect);
    const pitch = -LIMB_DIP_RAD + Math.atan(LIMB_NDC_Y * Math.tan(fov * DEG / 2));
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (let i = 0; i < 3; i++) {
        out.pos[i] = m[i] + LUNAR_ORBIT_ER * n[i];
        const v = s * plan.u[i] + c * plan.q[i];   // along the track, toward the rising Earth
        out.fwd[i] = cp * v + sp * n[i];
        out.up[i] = -sp * v + cp * n[i];
    }
    out.fovDeg = fov;
    return out;
}

/** Orbit angle at tMs (radians, from the sub-Earth direction toward q). */
export function lunarPhase(plan, tMs) {
    return plan.phi0 + 2 * Math.PI * ((tMs - plan.tMs) / 1000) / plan.periodS;
}

/**
 * The Earth's centre above the lunar limb (degrees) seen from a plan at tMs with the Moon at
 * moonPosS: positive once it has risen. For tests and the Earthrise caption.
 * @param {ReturnType<typeof createLunarPlan>} plan
 * @param {number} tMs
 * @param {ArrayLike<number>} moonPosS
 * @returns {number}
 */
export function earthAboveLimbDeg(plan, tMs, moonPosS) {
    return aboveLimbDeg(plan, lunarPhase(plan, tMs), moonPosS);
}
