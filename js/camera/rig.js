/**
 * Camera rig (SPEC §C.6, §F.5): orbit around the globe with OrbitControls,
 * Earth-lock by quaternion delta, a sky-view look controller standing at the
 * observer, eased fly-to tweens and the globe ↔ sky transitions.
 *
 *   createRig(rc, {dom, reducedMotion}) → { camera, mode, skyBlend, tweening, dragging,
 *     setMode(mode, {animate, look}) → Promise, setEarthLock(on), flyToDir(dirS, {distance, animate, durationMs}) → Promise,
 *     frameDir(dirS, {animate, durationMs, point}) → Promise, centerAt(ndcX, ndcY, {animate, fovFactor}) → Promise,
 *     flyToLatLon(latDeg, lonDeg, {distance=3.2, animate, durationMs}) → Promise, home({animate}) → Promise,
 *     update(dtMs, snap) → boolean, getView() → CamView, setView(cam), onInteract(cb) → off, onClick(cb) → off,
 *     nudge(dxDeg, dyDeg), zoom(factor), zoomAt(factor, ndcX, ndcY), setViewInsets({left, right, top, bottom}),
 *     follow(targetFn, {altitude, backDeg, tiltDeg, approachMs}) → Promise, stopFollow(), following,
 *     setTracking('none'|'body'|'stars', id), tracking, telescope(fovDeg), onTrackEnd(cb) → off,
 *     setVantage('none'|'l1'|'moon', {animate}) → Promise, vantage, moonFront, onVantageEnd(cb) → off,
 *     mapK, mapFrame, frameSpan(dirS, lengthER, {animate}) → Promise,
 *     setReducedMotion(on), dispose() }
 *
 * The flat map (setMode('map'), ROADMAP globe-to-map-morph): the camera glides in ~1.1 s to face an
 * equirectangular plane (geo/mapview.js) while `mapK` runs 0 → 1, which the Earth's vertex shader
 * uses to unroll the globe onto it; the plane is oriented when the morph starts (north up, square
 * to the camera's direction) and stays fixed in the world. On the map a drag pans, the wheel and
 * pinch zoom about the cursor or the fingers, arrows pan and +/− zoom; the orbit controls are off.
 * Leaving it rolls the globe back up into the pose it was entered from (or, once the map was panned
 * or zoomed, over the place at the map's centre); sky view goes through the globe both ways.
 *
 * Vantage points (globe view): 'l1' looks back at the sunlit Earth from 1.5 million km sunward
 * (DSCOVR/EPIC), 'moon' rides a low lunar orbit with the Earth rising over the limb. The pose is
 * recomputed every frame from the snapshot (astro/vantage.js, loaded on first use), so time-lapse
 * moves it; the orbit controls are off, input does nothing, and the near plane follows the
 * distance (vantageNear) so the depth buffer still separates the Earth's shells. `moonFront` tells
 * the Moon to draw in front of everything while the camera is close to it. Entry and exit are
 * 4 s flights (log-distance over the Earth or, to and from lunar orbit, over the Moon, with the
 * field narrowing so the Earth keeps its size on screen); exit returns to the orbit pose the
 * vantage was entered from. Any other camera command takes over from a vantage, which then ends
 * and onVantageEnd listeners hear {reason, kind}.
 *
 * Sidereal tracking (sky view): 'body' re-aims at the body's refracted direction every frame
 * (zenith up), 'stars' holds a scene direction with the J2000 pole up, so the sky stands still and
 * the horizon swings. It bypasses the look's altitude clamp and releases itself below −8°.
 *
 * Follow (the eclipse chase): an open-ended tween in low orbit behind a moving point, cancelled by
 * any input; the orbit controls then take over with a 450 ms orientation blend, since they always
 * aim at the centre.
 *
 * Frames. Every tween runs in Earth geometry-local coordinates (the frame in
 * which the observer is fixed) and is mapped to world each frame with the
 * current Earth quaternion, so flights land on the right spot even while time
 * runs at a year per second. Orbit tweens that target a world direction
 * (flyToDir) are Earth-fixed only while Earth-lock is on.
 *
 * Earth-lock: before OrbitControls.update(), the camera position is rotated by
 * dq = q_t · q_prev⁻¹ (absolute quaternions from the snapshot, so there is no
 * drift); prev resets whenever the lock is toggled.
 *
 * Home view: straight above the observer at distance 3.4, north up — the
 * "compass" composition in which every beam projects along its azimuth. (The
 * spec's 37°-tilted direction puts the observer in the lower third with a
 * north-up camera and sends southern beams off the bottom edge; see the G6
 * report.) The intro ends in this same pose.
 *
 * Sky zoom: the wheel and pinch zoom about the cursor or the fingers' midpoint (the sky under
 * it stays put, solved in closed form by skyLookFor); keyboard +/− zoom about the centre.
 *
 * Reduced motion: every tween becomes a cut and sky-drag inertia is off.
 * Click vs drag: < 6 px and < 350 ms is a click; a second click within 320 ms
 * and 10 px is reported as `double: true`.
 *
 * No per-frame allocation (R5): all vectors/quaternions are module scratch.
 *
 * @module camera/rig
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { liftByRefraction } from '../astro/photometry.js';
import { MOON_RADIUS_ER } from '../astro/bodies.js';
import { createMapFrame, orientMapFrame, mapFitDistance, mapXY, MAP_HALF_W, MAP_HALF_H, MAP_SCALE } from '../geo/mapview.js';

const DEG = Math.PI / 180;
const ORBIT_FOV = 45;
const SKY_FOV = 70;
/** Sky-view field-of-view floor: the telescope zoom (Jupiter's disc ~45 px across at 0.2° on 900 px). */
export const SKY_FOV_MIN = 0.2;
const SKY_FOV_MAX = 100;
const SKY_ALT_MIN = -10;
const SKY_ALT_MAX = 89;
/** A look tracking left above SKY_ALT_MAX (a body near the zenith) may stay up to this (altCeil). */
const SKY_ALT_TRACKED_MAX = 89.99;
const EYE_R = 1.0005;            // sky-view eye height (≈ 3 km), SPEC F.5
const ABOVE_R = 1.15;            // the "above the observer" waypoint of the transitions
const HOME_DIST = 3.4;
const MIN_DIST = 1.08;
const MAX_DIST = 150;
const MODE_MS = 1800;
// Globe → sky descent, phase 2 (k = 0 … 1; stepToOrbit mirrors it with 1 − k). The render side
// replaces the globe with the sky-view ground by skyBlend 0.5 (render/sky.js groundCover) while
// the camera still looks straight down; only then does it pitch up to the horizon as the sky fades
// in. Up here the globe's rim sits several degrees below the sky-view horizon, so a half-faded
// globe in view showed a second, polygon-edged horizon (and the atmosphere's limb glow, white on
// the low tier). With these curves the rim stays out of view until the cover is complete, for any
// look altitude (−10° … 89°), sky FOV up to 100° and aspect up to 2.4. The pitch still starts as
// early as that allows, so at night (near-black ground) the horizon's glow follows within ~0.1 s.
const DESCENT_BLEND = [0, 0.9];
const DESCENT_PITCH = [0.31, 0.8];
const DESCENT_TURN = [0, 0.45];
const CLICK_PX = 6;
const CLICK_MS = 350;
const DOUBLE_MS = 320;
const DOUBLE_PX = 10;
// 'Center' framing (frameDir): the body sits this fraction of the way from the middle of the free
// screen area to its edge on the body's side, and the globe's limb at this fraction of the body's
// angle from the view axis; the globe's disc spans at most FRAME_FIT of the free area's narrower
// side (full screen, body above or below the globe: 16.2° and 13.8°, a distance of 4.2 R).
const FRAME_FILL = 0.7;
const FRAME_LIMB = 0.85;
const FRAME_FIT = 0.75;
// Sky view: a double-click on empty sky glides there and narrows the field by this factor.
const SKY_DBL_ZOOM = 0.6;
// follow(): the chase pose (altitude in Earth radii, angles in degrees), the approach from the
// current pose, the heading's low-pass rate (1/s) and the hand-back blend to OrbitControls.
const FOLLOW = Object.freeze({ altitude: 0.35, backDeg: 14, tiltDeg: 10, approachMs: 1600, turnRate: 2.5 });
const RELEASE_MS = 450;
// Sidereal tracking: the engage/release orientation blend, the altitude below which a tracked body
// or star field counts as set, the zoom's log-space easing time and the drag offset limit.
const TRACK_BLEND_MS = 600;
export const TRACK_SET_ALT = -8;
const TRACK_SET_SIN = Math.sin(TRACK_SET_ALT * Math.PI / 180);
const TRACK_ZOOM_MS = 200;
const TRACK_OFF_MAX = 60;
// Vantage flights (setVantage): duration; to and from lunar orbit the direction around the Moon
// leads the distance by this share of the flight (and trails it on the way back), so a camera that
// starts behind the Earth swings clear of it before closing in.
const VANTAGE_MS = 4000;
// The flat map: the morph's length, the closest zoom (plane units from the plane: ~5° of latitude
// across the view) and the farthest (× the whole-map fit).
const MAP_MS = 1100;
const MAP_D_MIN = 0.12;
const MAP_D_MAX_K = 1.6;
// frameSpan: the far end of the segment sits this far out of the free half-extent.
const SPAN_FILL = 0.86;
const VANTAGE_LEAD = 0.15;

const Y = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);

// ---- scratch (never reallocated) ----
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _bR = new THREE.Vector3();
const _bU = new THREE.Vector3();
const _bF = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _look = { az: 0, alt: 0 };
const _fF = new THREE.Vector3();
const _fG = new THREE.Vector3();
const _fR = new THREE.Vector3();
const _fU = new THREE.Vector3();
const _fP = new THREE.Vector3();
const _flC = new THREE.Vector3();
const _flD = new THREE.Vector3();
const _flF = new THREE.Vector3();
const _flR = new THREE.Vector3();
const _flU = new THREE.Vector3();
const _flQ = new THREE.Quaternion();
const _lift = new Float64Array(3);
const _flPos = new Float64Array(3);
const _flFwd = new Float64Array(3);
const _mN = new THREE.Vector3();
const _mU = new THREE.Vector3();
const _mPole = new Float64Array(3);
const _mView = new Float64Array(3);
const _mFall = new Float64Array(3);
const _mXY = new Float64Array(2);

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; }
function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
function wrap360(d) { return ((d % 360) + 360) % 360; }
function wrap180(d) { return wrap360(d + 180) - 180; }

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Camera orientation looking along `fwd` with screen-up as close as possible to `upHint`.
 * three cameras look down their local −Z: columns are (right, up, −forward).
 */
function basisQuat(fwd, upHint, out) {
    _bF.copy(fwd).normalize();
    _bR.crossVectors(_bF, upHint);
    if (_bR.lengthSq() < 1e-12) {
        // upHint parallel to the view: any perpendicular will do.
        _bR.set(1, 0, 0).cross(_bF);
        if (_bR.lengthSq() < 1e-12) _bR.set(0, 0, 1).cross(_bF);
    }
    _bR.normalize();
    _bU.crossVectors(_bR, _bF);
    _bF.negate();
    _m4.makeBasis(_bR, _bU, _bF);
    return out.setFromRotationMatrix(_m4);
}

/** Re-aims an orientation so its forward points along `fwdTarget` with the least rotation. */
function reaim(q, fwdTarget) {
    _v4.copy(FWD).applyQuaternion(q);
    _q2.setFromUnitVectors(_v4, _v3.copy(fwdTarget).normalize());
    return q.premultiply(_q2);
}

/** Slerp between unit vectors a and b (both left untouched) into out. */
function slerpDir(a, b, t, out) {
    const d = clamp(a.dot(b), -1, 1);
    const ang = Math.acos(d);
    if (ang < 1e-6) return out.copy(a).lerp(b, t).normalize();
    if (Math.PI - ang < 1e-4) {
        // Opposite: rotate about any perpendicular axis.
        _v4.set(1, 0, 0).cross(a);
        if (_v4.lengthSq() < 1e-8) _v4.set(0, 0, 1).cross(a);
        _v4.normalize();
        return out.copy(a).applyAxisAngle(_v4, ang * t);
    }
    const s = Math.sin(ang);
    const wa = Math.sin((1 - t) * ang) / s, wb = Math.sin(t * ang) / s;
    return out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb).normalize();
}

/**
 * Sky view: horizon coordinates (degrees, into out) of a camera-space ray (x right, y up, z < 0
 * ahead) for a camera looking at (azDeg, altDeg) with screen-up toward the zenith, the pose
 * applySkyCamera builds.
 * @returns {{az:number, alt:number}} out
 */
export function skyRayAzAlt(azDeg, altDeg, cx, cy, cz, out) {
    const n = Math.hypot(cx, cy, cz) || 1;
    const A = -cz / n, B = cy / n, h = altDeg * DEG;
    out.alt = Math.asin(clamp(A * Math.sin(h) + B * Math.cos(h), -1, 1)) / DEG;
    out.az = wrap360(azDeg + Math.atan2(cx / n, A * Math.cos(h) - B * Math.sin(h)) / DEG);
    return out;
}

/**
 * The inverse of skyRayAzAlt: the look (degrees, into out) that puts the sky direction (azDeg,
 * altDeg) on the camera-space ray (cx, cy, cz), following on from the current look (refAzDeg,
 * refAltDeg). Near the zenith two looks can; the one nearer the current altitude wins. When it
 * would tip over the zenith (or nadir), or no look can, the result saturates toward that pole at
 * the current azimuth, so the view never swings round. The caller clamps the altitude.
 * @returns {{az:number, alt:number}} out
 */
export function skyLookFor(azDeg, altDeg, cx, cy, cz, out, refAzDeg, refAltDeg) {
    const n = Math.hypot(cx, cy, cz) || 1;
    const A = -cz / n, B = cy / n;
    const rho = Math.hypot(A, B) || 1e-9, phi = Math.atan2(B, A);
    // A·sin h + B·cos h = ρ·sin(h + φ) = sin alt, so h + φ = s or π − s.
    const q = Math.sin(altDeg * DEG) / rho;
    const s = Math.asin(clamp(q, -1, 1));
    const h1 = s - phi, h2 = Math.PI - s - phi, ref = refAltDeg * DEG;
    const h = Math.abs(h2 - ref) < Math.abs(h1 - ref) ? h2 : h1;
    if (Math.abs(q) > 1 || Math.abs(h) > Math.PI / 2) {
        out.alt = clamp(h, -Math.PI / 2, Math.PI / 2) / DEG;
        out.az = wrap360(refAzDeg);
        return out;
    }
    out.alt = h / DEG;
    out.az = wrap360(azDeg - Math.atan2(cx / n, rho * Math.cos(h + phi)) / DEG);
    return out;
}

/**
 * Parses a CamView-ish value: {mode, latDeg|lat, lonDeg|lon, distance|dist} | {mode, azDeg|az, altDeg|alt, fovDeg|fov}
 * | 'o:lat,lon,d' | 's:az,alt,fov' | 'm:lat,lon,d' (the map: its centre and the distance from the plane).
 */
function parseView(cam) {
    if (cam == null) return null;
    if (typeof cam === 'string') {
        const m = /^\s*([osm])\s*:\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*$/.exec(cam);
        if (!m) return null;
        const a = +m[2], b = +m[3], c = +m[4];
        // Through the object path, so a hand-written string is clamped like any other view.
        if (m[1] === 'm') return parseView({ mode: 'map', latDeg: a, lonDeg: b, distance: c });
        return parseView(m[1] === 'o' ? { mode: 'orbit', latDeg: a, lonDeg: b, distance: c } : { mode: 'sky', azDeg: a, altDeg: b, fovDeg: c });
    }
    if (typeof cam !== 'object') return null;
    if (cam.mode === 'm' || cam.mode === 'map') {
        const latDeg = Number(cam.latDeg ?? cam.lat), lonDeg = Number(cam.lonDeg ?? cam.lon);
        const distance = Number(cam.distance ?? cam.dist);
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
        return { mode: 'map', latDeg: clamp(latDeg, -90, 90), lonDeg: wrap180(lonDeg), distance: Number.isFinite(distance) ? clamp(distance, MAP_D_MIN, 20) : NaN };
    }
    const mode = cam.mode === 's' || cam.mode === 'sky' ? 'sky' : cam.mode === 'o' || cam.mode === 'orbit' ? 'orbit' : null;
    if (mode === 'orbit') {
        const latDeg = Number(cam.latDeg ?? cam.lat), lonDeg = Number(cam.lonDeg ?? cam.lon);
        const distance = Number(cam.distance ?? cam.dist ?? HOME_DIST);
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
        return { mode, latDeg: clamp(latDeg, -90, 90), lonDeg: wrap180(lonDeg), distance: Number.isFinite(distance) ? clamp(distance, MIN_DIST, MAX_DIST) : HOME_DIST };
    }
    if (mode === 'sky') {
        const azDeg = Number(cam.azDeg ?? cam.az), altDeg = Number(cam.altDeg ?? cam.alt);
        const fovDeg = Number(cam.fovDeg ?? cam.fov ?? SKY_FOV);
        if (!Number.isFinite(azDeg) || !Number.isFinite(altDeg)) return null;
        return { mode, azDeg: wrap360(azDeg), altDeg: clamp(altDeg, SKY_ALT_MIN, SKY_ALT_MAX), fovDeg: Number.isFinite(fovDeg) ? clamp(fovDeg, SKY_FOV_MIN, SKY_FOV_MAX) : SKY_FOV };
    }
    return null;
}

function prefersReducedMotion() {
    try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/**
 * Creates the camera rig.
 * @param {object} rc RenderContext (SPEC §C.6)
 * @param {{dom?:HTMLElement, reducedMotion?:boolean, now?:()=>number}} [opts]
 * @returns {object} Rig (see module docs)
 */
export function createRig(rc, { dom = null, reducedMotion, now = nowMs } = {}) {
    const camera = rc.camera;
    camera.up.set(0, 1, 0);
    let reduced = reducedMotion ?? prefersReducedMotion();
    const el = dom || rc.renderer?.domElement || null;

    // ---- OrbitControls (globe) ----
    let controls = null;
    if (el) {
        controls = new OrbitControls(camera, el);
        controls.enablePan = false;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.5;
        controls.zoomSpeed = 1.1;
        controls.minDistance = MIN_DIST;
        controls.maxDistance = MAX_DIST;
        controls.target.set(0, 0, 0);
    }

    // ---- state ----
    let mode = 'orbit';
    let skyBlend = 0;
    let earthLock = true;
    let initialized = false;
    let hasSnap = false;
    const qE = new THREE.Quaternion();       // Earth local → world
    const qEInv = new THREE.Quaternion();
    const qPrev = new THREE.Quaternion();
    let hasPrev = false;
    const dq = new THREE.Quaternion();
    const obsLat = { v: 0 }, obsLon = { v: 0 };
    // Observer frame in world and Earth-local coordinates.
    const posW = new THREE.Vector3(1, 0, 0), upW = new THREE.Vector3(1, 0, 0);
    const northW = new THREE.Vector3(0, 1, 0), eastW = new THREE.Vector3(0, 0, -1);
    const upL = new THREE.Vector3(1, 0, 0), northL = new THREE.Vector3(0, 1, 0), eastL = new THREE.Vector3(0, 0, -1);

    // Sky look (degrees) with targets for smoothing and velocities for inertia.
    const sky = { az: 180, alt: 15, fov: SKY_FOV, azT: 180, altT: 15, fovT: SKY_FOV, vAz: 0, vAlt: 0 };
    // Zoom about a screen point: the sky direction (az, alt) held under NDC (x, y) while the
    // field of view eases (wheel), or follows the fingers (pinch).
    const anchor = { on: false, az: 0, alt: 0, x: 0, y: 0 };
    let skyDefaulted = false;
    // Orbit zoom smoothing (keyboard/API zoom); OrbitControls handles wheel/pinch itself.
    let zoomTarget = null;
    // The orbit pose to return to from sky view, in Earth-local coordinates.
    const orbitReturnL = new THREE.Vector3();
    let hasOrbitReturn = false;

    let tween = null;
    let pendingView = null;
    // Hand-back from a follow(): OrbitControls re-aims at the centre on its next update, so the
    // chase's oblique orientation is kept as an offset that decays over RELEASE_MS.
    const release = { on: false, pending: false, t0: 0, from: new THREE.Quaternion(), q: new THREE.Quaternion() };
    const insets = { left: 0, right: 0, top: 0, bottom: 0 };
    let insetsDirty = true;
    let offsetW = 0;
    let offsetH = 0;

    const interactCbs = new Set();
    const clickCbs = new Set();
    const pointers = new Map();
    let downInfo = null;      // first pointer of a gesture: {id, x, y, t}
    let lastClick = null;     // {x, y, t}
    let skyDrag = null;       // {id, x, y, t}
    let pinch = null;         // {d, fov}; the anchor holds the direction under the fingers
    let lastT = now();

    // Sidereal tracking (sky view): 'body' keeps a body centred (at its refracted, drawn place)
    // with zenith up; 'stars' holds a scene direction (the static sky) with celestial north up, so
    // the horizon swings instead. Engaging and releasing blend the orientation over TRACK_BLEND_MS.
    const track = {
        kind: 'none', id: null, index: -1,
        dirW: new THREE.Vector3(0, 0, -1),   // stars: the held direction
        ox: 0, oy: 0,                        // body: aim offset, degrees left / up of the body
        engaged: false, cut: false, fov: NaN,
        blend: false, t0: 0, q0: new THREE.Quaternion(), last: new THREE.Quaternion(),
    };
    const trackEndCbs = new Set();

    // Vantage points (setVantage). `kind` is the vantage shown or being flown to ('none' while
    // flying back); `ret` the orbit pose to return to (Earth-local while Earth-lock is on);
    // `front` the Moon-in-front flag for the renderers. vlib is astro/vantage.js once loaded.
    const vant = {
        kind: 'none', plan: null, front: false,
        ret: new THREE.Vector3(), retLocal: true, hasRet: false,
        pending: null,
    };
    const vantEndCbs = new Set();

    // The flat map (setMode('map')). `k` is the morph (0 globe … 1 map: FrameInfo.mapK), `frame` the
    // plane (geo/mapview.js; oriented as the morph starts), (x, y) the view's centre on it and `d` the
    // camera's distance from it (plane units), eased toward the *T targets. `retL` is the globe pose
    // to return to (Earth-local) unless the map was panned or zoomed since (`moved`).
    const mapv = {
        k: 0, frame: createMapFrame(),
        x: 0, y: 0, d: 4, xT: 0, yT: 0, dT: 4,
        retL: new THREE.Vector3(), hasRet: false, moved: false,
        drag: null, pinch: null,
    };
    // setMode requests: a newer one stops an older one's second leg (sky → globe → map and back).
    let modeReq = 0;
    let vlib = null;
    let vlibP = null;
    let vpose = null;
    let vantReq = 0;
    let curSnap = null;

    // ---- helpers: frames ----------------------------------------------------------------------

    function toLocal(vW, out) { return out.copy(vW).applyQuaternion(qEInv); }
    function toWorld(vL, out) { return out.copy(vL).applyQuaternion(qE); }

    /** Horizontal unit vector at the observer for an azimuth (world or local frame). */
    function headingVec(azDeg, north, east, out) {
        const a = azDeg * DEG;
        return out.copy(north).multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a)).normalize();
    }

    /** Azimuth of a vector projected on the observer's tangent plane (local frame). */
    function headingOf(vL) {
        return wrap360(Math.atan2(vL.dot(eastL), vL.dot(northL)) / DEG);
    }

    function setNearFor(r) {
        const near = clamp((r - 1) * 0.05, 0.003, 0.05);
        if (Math.abs(camera.near - near) > near * 0.01) {
            camera.near = near;
            camera.updateProjectionMatrix();
        }
    }

    function setFov(f) {
        if (Math.abs(camera.fov - f) > 1e-6 * f) {   // relative: the telescope zoom reaches 0.2°
            camera.fov = f;
            camera.updateProjectionMatrix();
        }
    }

    function syncControls() {
        if (!controls) return;
        controls.target.set(0, 0, 0);
        // Drop any residual damping/zoom so the hand-over is seamless.
        controls._sphericalDelta?.set(0, 0, 0);
        if ('_scale' in controls) controls._scale = 1;
        controls._panOffset?.set(0, 0, 0);
        controls.update();
    }

    function setControlsEnabled(on) {
        if (controls) controls.enabled = on;
    }

    // ---- snapshot ------------------------------------------------------------------------------

    function readSnap(snap) {
        const q = snap.earthQuat;
        if (q && q.length >= 4) qE.set(q[0], q[1], q[2], q[3]);
        else if (snap.earthMatrix) qE.setFromRotationMatrix(_m4.fromArray(snap.earthMatrix));
        qE.normalize();
        qEInv.copy(qE).invert();
        const o = snap.observer;
        if (o) {
            posW.fromArray(o.posS);
            upW.fromArray(o.upS);
            northW.fromArray(o.northS);
            eastW.fromArray(o.eastS);
            obsLat.v = o.latDeg;
            obsLon.v = o.lonDeg;
            toLocal(upW, upL);
            toLocal(northW, northL);
            toLocal(eastW, eastL);
        }
        hasSnap = true;
    }

    // ---- poses -----------------------------------------------------------------------------------

    /** Home: straight above the observer, north up. Writes the local camera position. */
    function homePosL(out) {
        return out.copy(upL).multiplyScalar(HOME_DIST);
    }

    /**
     * Orbit orientation for a camera at world position pW: look at the centre with
     * world +Y up, exactly what OrbitControls.update() produces, so hand-overs between
     * tweens and the controls never snap. (Straight over a pole basisQuat picks a
     * deterministic perpendicular.)
     */
    function orbitQuat(pW, out) {
        _v1.copy(pW).negate();
        return basisQuat(_v1, Y, out);
    }

    function placeOrbitLocal(pL) {
        toWorld(pL, camera.position);
        orbitQuat(camera.position, camera.quaternion);
        camera.up.copy(Y);
        setNearFor(camera.position.length());
    }

    function applySkyCamera() {
        camera.position.copy(posW).multiplyScalar(EYE_R);
        const a = sky.az * DEG, h = sky.alt * DEG;
        _v1.copy(northW).multiplyScalar(Math.cos(a)).addScaledVector(eastW, Math.sin(a)).multiplyScalar(Math.cos(h))
            .addScaledVector(upW, Math.sin(h));
        basisQuat(_v1, upW, camera.quaternion);
        camera.up.copy(upW);
        if (Math.abs(camera.near - 0.01) > 1e-6) {
            camera.near = 0.01;
            camera.updateProjectionMatrix();
        }
        setFov(sky.fov);
    }

    // Default sky look: toward the equator, 15° up; 25° on a portrait screen, where the tall field
    // would otherwise give the ground almost half the view (only without a cam in the link).
    function defaultLook(out) {
        out.az = obsLat.v >= 0 ? 180 : 0;
        out.alt = camera.aspect > 0 && camera.aspect < 1 ? 25 : 15;
        return out;
    }

    /**
     * Camera-space ray through a point of the canvas (NDC) for a vertical field of view, with the
     * view offset of the insets: three's PerspectiveCamera.updateProjectionMatrix frustum.
     */
    function camRay(ndcX, ndcY, fovDeg, out) {
        let top = Math.tan(fovDeg * DEG / 2) / (camera.zoom || 1);
        let height = 2 * top, width = camera.aspect * height, left = -0.5 * width;
        const v = camera.view;
        if (v && v.enabled) {
            left += v.offsetX * width / v.fullWidth;
            top -= v.offsetY * height / v.fullHeight;
            width *= v.width / v.fullWidth;
            height *= v.height / v.fullHeight;
        }
        return out.set(left + (ndcX + 1) / 2 * width, top - (1 - ndcY) / 2 * height, -1);
    }

    /** Sky view: the direction (az, alt) under a point of the canvas in the current, eased pose. */
    function skyDirAt(ndcX, ndcY, out) {
        camRay(ndcX, ndcY, sky.fov, _ray);
        return skyRayAzAlt(sky.az, sky.alt, _ray.x, _ray.y, _ray.z, out);
    }

    /**
     * The look that keeps the anchored direction under its screen point at field of view fov,
     * following on from the look (refAz, refAlt).
     */
    function anchoredLook(fov, out, refAz = sky.az, refAlt = sky.alt) {
        camRay(anchor.x, anchor.y, fov, _ray);
        skyLookFor(anchor.az, anchor.alt, _ray.x, _ray.y, _ray.z, out, refAz, refAlt);
        out.alt = clamp(out.alt, SKY_ALT_MIN, altCeil());
        return out;
    }

    /** Anchors the sky direction under (ndcX, ndcY) for a zoom or pinch about that point. */
    function setAnchor(ndcX, ndcY) {
        skyDirAt(ndcX, ndcY, _look);
        anchor.az = _look.az;
        anchor.alt = _look.alt;
        anchor.x = ndcX;
        anchor.y = ndcY;
    }

    /**
     * Sky view: changes the field of view about a point of the canvas, so the sky under it stays
     * put (Stellarium, map apps). The targets are set here; stepSky eases toward them with the
     * anchor held exactly under the point on every frame.
     */
    function zoomSkyAt(fovNext, ndcX, ndcY) {
        if (track.kind !== 'none') {
            // Tracking holds the aim: the zoom stays about the centre (stepTrack eases it).
            sky.fovT = clamp(fovNext, SKY_FOV_MIN, SKY_FOV_MAX);
            return;
        }
        setAnchor(ndcX, ndcY);
        anchor.on = true;
        sky.vAz = sky.vAlt = 0;
        sky.fovT = clamp(fovNext, SKY_FOV_MIN, SKY_FOV_MAX);
        // Targets (getView): where the eased zoom ends, followed in a few steps the way stepSky
        // follows it, so near the zenith both pick the same of the two possible looks.
        let az = sky.az, alt = sky.alt;
        for (let i = 1; i <= 6; i++) {
            anchoredLook(sky.fov * (sky.fovT / sky.fov) ** (i / 6), _look, az, alt);
            az = _look.az;
            alt = _look.alt;
        }
        sky.azT = az;
        sky.altT = alt;
    }

    function applyViewNow(v) {
        if (v.mode === 'map') {
            // The globe pose to return to: this one, or (a deep link, before any pose) home.
            if (mode === 'orbit' && initialized) toLocal(camera.position, mapv.retL);
            else homePosL(mapv.retL);
            mapv.hasRet = true;
            dropVantage('view');
            if (mode === 'sky') camera.position.copy(posW).multiplyScalar(HOME_DIST);
            captureMapFrame();
            mode = 'map';
            skyBlend = 0;
            mapv.k = 1;
            mapXY(v.latDeg, v.lonDeg, _mXY);
            mapv.x = mapv.xT = _mXY[0];
            mapv.y = mapv.yT = _mXY[1];
            mapv.d = mapv.dT = clamp(Number.isFinite(v.distance) ? v.distance : mapFit(), MAP_D_MIN, mapDMax());
            mapv.moved = true;
            setControlsEnabled(false);
            applyMapCamera();
            initialized = true;
            return;
        }
        mapv.k = 0;
        if (v.mode === 'orbit') {
            mode = 'orbit';
            skyBlend = 0;
            const p = v.latDeg * DEG, l = v.lonDeg * DEG, cp = Math.cos(p);
            _v2.set(cp * Math.cos(l), Math.sin(p), -cp * Math.sin(l)).multiplyScalar(v.distance);
            placeOrbitLocal(_v2);
            setFov(ORBIT_FOV);
            setControlsEnabled(true);
            syncControls();
        } else {
            // A deep link applies its sky view before the camera was ever placed in orbit: then
            // there is no pose to return to, and 'Globe' homes over the observer (startToOrbit).
            if (mode === 'orbit' && initialized) rememberOrbitPose();
            dropVantage('view');
            mode = 'sky';
            skyBlend = 1;
            anchor.on = false;
            sky.az = sky.azT = v.azDeg;
            sky.alt = sky.altT = v.altDeg;
            sky.fov = sky.fovT = v.fovDeg;
            sky.vAz = sky.vAlt = 0;
            skyDefaulted = true;
            setControlsEnabled(false);
            applySkyCamera();
            // A tracked deep link re-engages on this pose without a blend (a cut, like the view).
            track.engaged = false;
            track.cut = true;
        }
        initialized = true;
    }

    function rememberOrbitPose() {
        // From a vantage, 'Globe' later returns to the orbit pose the vantage was entered from.
        if (vantageOwns() && vant.hasRet) toLocal(vantageReturn(_v4), orbitReturnL);
        else toLocal(camera.position, orbitReturnL);
        hasOrbitReturn = true;
    }

    // ---- tweens ----------------------------------------------------------------------------------

    function finishTween(done) {
        const t = tween;
        tween = null;
        if (t && t.kind === 'follow' && !reduced) {
            // Whatever places the camera next (the controls, a flight) starts from this orientation.
            release.from.copy(camera.quaternion);
            release.pending = true;
            release.on = true;
        }
        if (t && t.resolve) t.resolve(done);
    }

    /** The follow → orbit hand-back: the old orientation as a decaying offset on the new one. */
    function applyRelease(tNow) {
        if (mode !== 'orbit' || (tween && tween.kind === 'follow') || vantageOwns()) {
            release.on = false;
            return false;
        }
        if (release.pending) {
            release.q.copy(release.from).multiply(_q1.copy(camera.quaternion).invert());
            release.pending = false;
            release.t0 = tNow;
        }
        const u = clamp((tNow - release.t0) / RELEASE_MS, 0, 1);
        if (u >= 1) {
            release.on = false;
            return true;
        }
        camera.quaternion.premultiply(_q2.identity().slerp(release.q, 1 - easeInOutCubic(u)));
        return true;
    }

    function cancelTween() {
        if (!tween || !tween.cancellable) return false;
        finishTween(false);
        if (mode === 'orbit') {
            setControlsEnabled(true);
            syncControls();
        }
        return true;
    }

    function startTween(t) {
        // Any other camera move takes over from a vantage (and from a flight to or from one).
        if (t.kind !== 'vantage' && vantageOwns()) dropVantage('camera');
        if (tween) finishTween(false);
        anchor.on = false;
        // A tracked view takes over again, blended, once the flight or transition is done.
        track.engaged = false;
        track.ox = track.oy = 0;
        tween = t;
        t.t0 = null; // set on the first update (after a snapshot exists)
        t.promise = new Promise((resolve) => { t.resolve = resolve; });
        return t.promise;
    }

    /** Orbit flight to a local (Earth-fixed) or world target position. */
    function startFly(targetL, { earthFixed, durationMs, animate }) {
        const fromL = toLocal(camera.position, new THREE.Vector3());
        const r0 = fromL.length(), r1 = targetL.length();
        const d0 = fromL.clone().normalize(), d1 = targetL.clone().normalize();
        const arc = Math.acos(clamp(d0.dot(d1), -1, 1));
        if (!earthFixed) {
            // World-fixed: keep the endpoints in world coordinates instead.
            toWorld(d0, d0);
            toWorld(d1, d1);
        }
        const dur = !animate || reduced ? 0 : Number.isFinite(durationMs) ? Math.max(0, durationMs) : 600 + 900 * arc / Math.PI;
        mode = 'orbit';
        setControlsEnabled(false);
        return startTween({ kind: 'fly', cancellable: true, earthFixed, d0, d1, r0, r1, arc, dur, fov0: camera.fov });
    }

    function stepFly(t, u) {
        const e = easeInOutCubic(u);
        // From a vantage's narrow field (0.7° at L1) back to the orbit field, in log space.
        if (t.fov0 !== ORBIT_FOV) setFov(Math.exp(Math.log(t.fov0) + (Math.log(ORBIT_FOV) - Math.log(t.fov0)) * e));
        slerpDir(t.d0, t.d1, e, _v2);
        // Log-altitude interpolation glides smoothly to and from the surface; the lift
        // arcs long flights outward so the globe stays in view.
        const a0 = Math.max(t.r0 - 1, 1e-4), a1 = Math.max(t.r1 - 1, 1e-4);
        let r = 1 + Math.exp(Math.log(a0) + (Math.log(a1) - Math.log(a0)) * e);
        r *= 1 + 0.35 * Math.sin(Math.PI * e) * t.arc / Math.PI;
        _v2.multiplyScalar(r);
        if (t.earthFixed) placeOrbitLocal(_v2);
        else {
            camera.position.copy(_v2);
            orbitQuat(camera.position, camera.quaternion);
            camera.up.copy(Y);
            setNearFor(r);
        }
        if (u >= 1) {
            setControlsEnabled(true);
            syncControls();
        }
    }

    function startToSky({ look, animate }) {
        const L = look && Number.isFinite(look.azDeg) && Number.isFinite(look.altDeg)
            ? { az: wrap360(look.azDeg), alt: clamp(look.altDeg, SKY_ALT_MIN, SKY_ALT_MAX) }
            : defaultLook({ az: 0, alt: 0 });
        rememberOrbitPose();
        mode = 'sky';
        setControlsEnabled(false);
        const t = {
            kind: 'toSky', cancellable: false, look: L,
            p0L: toLocal(camera.position, new THREE.Vector3()),
            q0L: camera.quaternion.clone().premultiply(qEInv),
            fov0: camera.fov,
            dur: !animate || reduced ? 0 : MODE_MS,
            // A field of view of its own (an event framing) is a zoom chained after the descent,
            // which always lands at SKY_FOV: the look is reached first, then the field narrows onto
            // it (stepTween hands over in the same frame; the promise resolves after the zoom).
            thenFov: Number(look?.fovDeg), animate,
        };
        return startTween(t);
    }

    function stepToSky(t, u) {
        const e = easeInOutCubic(u);
        // Heading of the start view's screen-up projected at the observer: phase 1 keeps it,
        // phase 2 turns to the look azimuth while pitching up to the horizon.
        if (t.hd0 === undefined) {
            _v1.set(0, 1, 0).applyQuaternion(t.q0L);
            _v1.addScaledVector(upL, -_v1.dot(upL));
            t.hd0 = _v1.lengthSq() > 1e-8 ? headingOf(_v1) : 0;
        }
        if (e < 0.6) {
            const k = e / 0.6;
            // Position: slerp toward the zenith with log-altitude.
            _v3.copy(t.p0L).normalize();
            slerpDir(_v3, upL, k, _v2);
            const a0 = Math.max(t.p0L.length() - 1, 1e-4), a1 = ABOVE_R - 1;
            _v2.multiplyScalar(1 + Math.exp(Math.log(a0) + (Math.log(a1) - Math.log(a0)) * k));
            // Orientation: slerp to "looking down, heading up-screen", re-aimed at the centre.
            headingVec(t.hd0, northL, eastL, _v4);
            basisQuat(_v1.copy(upL).negate(), _v4, _q1);
            camera.quaternion.copy(t.q0L).slerp(_q1, k);
            reaim(camera.quaternion, _v1.copy(_v2).negate());
            camera.quaternion.premultiply(qE);
            toWorld(_v2, camera.position);
            setFov(t.fov0 + (ORBIT_FOV - t.fov0) * k);
            setNearFor(camera.position.length());
            skyBlend = 0;
        } else {
            const k = (e - 0.6) / 0.4;
            const alt = Math.exp(Math.log(ABOVE_R - 1) + (Math.log(EYE_R - 1) - Math.log(ABOVE_R - 1)) * k);
            _v2.copy(upL).multiplyScalar(1 + alt);
            // Turn and cover the globe while still looking down, then pitch up (DESCENT_*).
            const dh = wrap180(t.look.az - t.hd0);
            const hd = t.hd0 + dh * smoothstep(DESCENT_TURN[0], DESCENT_TURN[1], k);
            const pitch = (-90 + (t.look.alt + 90) * smoothstep(DESCENT_PITCH[0], DESCENT_PITCH[1], k)) * DEG;
            headingVec(hd, northL, eastL, _v4);
            _v1.copy(_v4).multiplyScalar(Math.cos(pitch)).addScaledVector(upL, Math.sin(pitch));
            _v3.copy(_v4).multiplyScalar(-Math.sin(pitch)).addScaledVector(upL, Math.cos(pitch));
            basisQuat(_v1, _v3, camera.quaternion);
            camera.quaternion.premultiply(qE);
            toWorld(_v2, camera.position);
            setFov(ORBIT_FOV + (SKY_FOV - ORBIT_FOV) * k);
            camera.near = clamp(alt * 0.5, 0.0004, 0.05);
            camera.updateProjectionMatrix();
            skyBlend = smoothstep(DESCENT_BLEND[0], DESCENT_BLEND[1], k);
        }
        if (u >= 1) {
            skyBlend = 1;
            sky.az = sky.azT = t.look.az;
            sky.alt = sky.altT = t.look.alt;
            sky.fov = sky.fovT = SKY_FOV;
            sky.vAz = sky.vAlt = 0;
            skyDefaulted = true;
            applySkyCamera();
        }
    }

    function startToOrbit({ targetL, animate }) {
        const dest = targetL ? targetL.clone()
            : hasOrbitReturn ? orbitReturnL.clone() : homePosL(new THREE.Vector3());
        mode = 'orbit';
        setControlsEnabled(false);
        return startTween({
            kind: 'toOrbit', cancellable: false, destL: dest,
            az0: sky.az, alt0: sky.alt, fov0: sky.fov,
            dur: !animate || reduced ? 0 : MODE_MS,
        });
    }

    function stepToOrbit(t, u) {
        const e = easeInOutCubic(u);
        if (t.hdT === undefined) {
            // Heading of the destination view's screen-up, projected at the observer.
            toWorld(t.destL, _v2);
            orbitQuat(_v2, _q1);
            _v1.set(0, 1, 0).applyQuaternion(_q1);
            toLocal(_v1, _v1);
            _v1.addScaledVector(upL, -_v1.dot(upL));
            t.hdT = _v1.lengthSq() > 1e-8 ? headingOf(_v1) : 0;
        }
        if (e < 0.4) {
            const k = e / 0.4;
            const alt = Math.exp(Math.log(EYE_R - 1) + (Math.log(ABOVE_R - 1) - Math.log(EYE_R - 1)) * k);
            _v2.copy(upL).multiplyScalar(1 + alt);
            // The mirror of stepToSky's descent (DESCENT_*, with 1 − k): the sky fades while the
            // camera pitches down, and the globe returns only once its rim is out of view.
            const dh = wrap180(t.hdT - t.az0);
            const hd = t.az0 + dh * smoothstep(1 - DESCENT_TURN[1], 1 - DESCENT_TURN[0], k);
            const pitch = (t.alt0 + (-90 - t.alt0) * smoothstep(1 - DESCENT_PITCH[1], 1 - DESCENT_PITCH[0], k)) * DEG;
            headingVec(hd, northL, eastL, _v4);
            _v1.copy(_v4).multiplyScalar(Math.cos(pitch)).addScaledVector(upL, Math.sin(pitch));
            _v3.copy(_v4).multiplyScalar(-Math.sin(pitch)).addScaledVector(upL, Math.cos(pitch));
            basisQuat(_v1, _v3, camera.quaternion);
            camera.quaternion.premultiply(qE);
            toWorld(_v2, camera.position);
            setFov(t.fov0 + (ORBIT_FOV - t.fov0) * k);
            camera.near = clamp(alt * 0.5, 0.0004, 0.05);
            camera.updateProjectionMatrix();
            skyBlend = 1 - smoothstep(1 - DESCENT_BLEND[1], 1 - DESCENT_BLEND[0], k);
        } else {
            const k = (e - 0.4) / 0.6;
            _v3.copy(upL);
            _v1.copy(t.destL).normalize();
            slerpDir(_v3, _v1, k, _v2);
            const a0 = ABOVE_R - 1, a1 = Math.max(t.destL.length() - 1, 1e-4);
            _v2.multiplyScalar(1 + Math.exp(Math.log(a0) + (Math.log(a1) - Math.log(a0)) * k));
            // From "looking down, destination heading up-screen" to the orbit orientation.
            headingVec(t.hdT, northL, eastL, _v4);
            basisQuat(_v1.copy(upL).negate(), _v4, _q1);
            toWorld(t.destL, _v1);
            orbitQuat(_v1, _q2);
            _q2.premultiply(qEInv);
            _q1.slerp(_q2, k);
            reaim(_q1, _v1.copy(_v2).negate());
            camera.quaternion.copy(_q1).premultiply(qE);
            toWorld(_v2, camera.position);
            setFov(ORBIT_FOV);
            setNearFor(camera.position.length());
            skyBlend = 0;
        }
        if (u >= 1) {
            skyBlend = 0;
            placeOrbitLocal(t.destL);
            setFov(ORBIT_FOV);
            camera.up.copy(Y);
            setControlsEnabled(true);
            syncControls();
        }
    }

    // ---- the flat map ----------------------------------------------------------------------------

    /** The camera's distance from the plane that fits the whole map into the free area. */
    function mapFit() {
        const W = rc.size?.w || 1, H = rc.size?.h || 1;
        return mapFitDistance(ORBIT_FOV, H, Math.max(1, W - insets.left - insets.right), Math.max(1, H - insets.top - insets.bottom));
    }

    function mapDMax() {
        return Math.max(MAP_D_MIN * 2, mapFit() * MAP_D_MAX_K);
    }

    /** The map camera over plane point (x, y), d from the plane, looking straight at it, north up. */
    function mapPose(x, y, d, outP, outQ) {
        const f = mapv.frame, c = f.center, r = f.right, u = f.up, n = f.normal;
        outP.set(c[0] + r[0] * x + u[0] * y + n[0] * d, c[1] + r[1] * x + u[1] * y + n[1] * d, c[2] + r[2] * x + u[2] * y + n[2] * d);
        basisQuat(_mN.set(-n[0], -n[1], -n[2]), _mU.set(u[0], u[1], u[2]), outQ);
        return outP;
    }

    function setMapNear(d) {
        const near = clamp(d * 0.05, 0.0005, 0.05);
        if (Math.abs(camera.near - near) > near * 0.01) {
            camera.near = near;
            camera.updateProjectionMatrix();
        }
    }

    function applyMapCamera() {
        mapPose(mapv.x, mapv.y, mapv.d, camera.position, camera.quaternion);
        const u = mapv.frame.up;
        camera.up.set(u[0], u[1], u[2]);
        setFov(ORBIT_FOV);
        setMapNear(mapv.d);
    }

    /** Orients the plane: north up, square to the camera's direction (fallback: longitude 0). */
    function captureMapFrame() {
        toWorld(_v1.set(0, 1, 0), _v2);
        _mPole[0] = _v2.x; _mPole[1] = _v2.y; _mPole[2] = _v2.z;
        _mView[0] = camera.position.x; _mView[1] = camera.position.y; _mView[2] = camera.position.z;
        toWorld(_v1.set(1, 0, 0), _v2);
        _mFall[0] = _v2.x; _mFall[1] = _v2.y; _mFall[2] = _v2.z;
        orientMapFrame(mapv.frame, _mPole, _mView, _mFall);
    }

    function clampMapTargets() {
        mapv.xT = clamp(mapv.xT, -MAP_HALF_W, MAP_HALF_W);
        mapv.yT = clamp(mapv.yT, -MAP_HALF_H, MAP_HALF_H);
        mapv.dT = clamp(mapv.dT, MAP_D_MIN, mapDMax());
    }

    /** The globe unrolls into the map: the whole map, fitted to the free area. */
    function startToMap({ animate }) {
        if (!hasSnap) return Promise.resolve(false);
        captureMapFrame();
        toLocal(camera.position, mapv.retL);
        mapv.hasRet = true;
        mapv.moved = false;
        mapv.x = mapv.xT = 0;
        mapv.y = mapv.yT = 0;
        mapv.d = mapv.dT = mapFit();
        mapv.drag = mapv.pinch = null;
        zoomTarget = null;
        mode = 'map';
        skyBlend = 0;
        setControlsEnabled(false);
        return startTween({
            kind: 'toMap', cancellable: false, p0: camera.position.clone(), q0: camera.quaternion.clone(), fov0: camera.fov,
            dur: !animate || reduced ? 0 : MAP_MS,
        });
    }

    function stepToMap(t, u) {
        const e = easeInOutCubic(u);
        mapPose(mapv.x, mapv.y, mapv.d, _v2, _q1);
        camera.position.copy(t.p0).lerp(_v2, e);
        camera.quaternion.copy(t.q0).slerp(_q1, e);
        setFov(t.fov0 + (ORBIT_FOV - t.fov0) * e);
        setNearFor(Math.min(camera.position.length(), 1 + mapv.d));
        mapv.k = e;
        if (u >= 1) {
            mapv.k = 1;
            applyMapCamera();
        }
    }

    /** The globe pose to roll back up into (Earth-local): where the map was entered, or over its centre. */
    function mapReturnL(out) {
        if (mapv.hasRet && !mapv.moved) return out.copy(mapv.retL);
        const lat = clamp(mapv.yT / MAP_SCALE, -Math.PI / 2, Math.PI / 2), lon = mapv.xT / MAP_SCALE, cp = Math.cos(lat);
        const r = clamp(1 + mapv.dT * 0.8, 1.6, HOME_DIST * 1.8);
        return out.set(cp * Math.cos(lon), Math.sin(lat), -cp * Math.sin(lon)).multiplyScalar(r);
    }

    /** The map rolls back up into the globe. */
    function startFromMap({ animate }) {
        const destL = mapReturnL(new THREE.Vector3());
        mapv.drag = mapv.pinch = null;
        mode = 'orbit';
        setControlsEnabled(false);
        return startTween({
            kind: 'fromMap', cancellable: false, destL, p0: camera.position.clone(), q0: camera.quaternion.clone(),
            dur: !animate || reduced ? 0 : MAP_MS,
        });
    }

    function stepFromMap(t, u) {
        const e = easeInOutCubic(u);
        toWorld(t.destL, _v2);
        orbitQuat(_v2, _q1);
        camera.position.copy(t.p0).lerp(_v2, e);
        camera.quaternion.copy(t.q0).slerp(_q1, e);
        setFov(ORBIT_FOV);
        setNearFor(Math.min(camera.position.length(), 1 + mapv.d));
        mapv.k = 1 - e;
        if (u >= 1) {
            mapv.k = 0;
            placeOrbitLocal(t.destL);
            setFov(ORBIT_FOV);
            camera.up.copy(Y);
            setControlsEnabled(true);
            syncControls();
        }
    }

    /** On the map: eases the view toward its targets. Returns true while it moves (or is held). */
    function stepMap(dt) {
        const m = mapv;
        let moved = false;
        // Until the map is panned or zoomed it keeps fitting the free area (panels open and close).
        if (!m.moved && !m.drag && !m.pinch) {
            const fit = mapFit();
            if (Math.abs(fit - m.dT) > 1e-6 * fit || m.xT !== 0 || m.yT !== 0) {
                m.dT = fit;
                m.xT = m.yT = 0;
            }
        }
        if (m.x !== m.xT || m.y !== m.yT || m.d !== m.dT) {
            const k = reduced ? 1 : 1 - Math.exp(-dt / 90);
            m.x += (m.xT - m.x) * k;
            m.y += (m.yT - m.y) * k;
            m.d = Math.exp(Math.log(m.d) + (Math.log(m.dT) - Math.log(m.d)) * k);
            if (Math.abs(m.x - m.xT) < 1e-5 * m.d && Math.abs(m.y - m.yT) < 1e-5 * m.d && Math.abs(Math.log(m.dT / m.d)) < 1e-4) {
                m.x = m.xT;
                m.y = m.yT;
                m.d = m.dT;
            }
            moved = true;
        }
        applyMapCamera();
        return moved || !!m.drag || !!m.pinch;
    }

    /**
     * Map zoom about a point of the canvas: the place under it stays under it (targets, so a wheel
     * zoom still easing keeps its point). `now` applies it at once (pinch).
     */
    function mapZoomAt(dNext, ndcX, ndcY, now = false) {
        const m = mapv;
        const d1 = clamp(dNext, MAP_D_MIN, mapDMax());
        // The camera looks straight at the plane: a camera-space ray (x, y, −1) meets it x·d, y·d off centre.
        camRay(ndcX, ndcY, camera.fov, _ray);
        const px = m.xT + _ray.x * m.dT, py = m.yT + _ray.y * m.dT;
        m.xT = px - _ray.x * d1;
        m.yT = py - _ray.y * d1;
        m.dT = d1;
        clampMapTargets();
        if (now) {
            m.x = m.xT;
            m.y = m.yT;
            m.d = m.dT;
        }
        m.moved = true;
        rc.invalidate?.();
    }

    /** Pans the map to a place (keeping the zoom). */
    function mapPanTo(latDeg, lonDeg, animate) {
        mapXY(latDeg, lonDeg, _mXY);
        mapv.xT = _mXY[0];
        mapv.yT = _mXY[1];
        clampMapTargets();
        if (!animate || reduced) {
            mapv.x = mapv.xT;
            mapv.y = mapv.yT;
        }
        mapv.moved = true;
        rc.invalidate?.();
        return Promise.resolve(true);
    }

    /** Pans the map to where a world direction from the Earth's centre stands overhead. */
    function mapPanToDir(dirS, animate) {
        toLocal(_v1.set(dirS[0], dirS[1], dirS[2]), _v1);
        if (!(_v1.lengthSq() > 0)) return Promise.resolve(false);
        return mapPanTo(Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z)) / DEG, Math.atan2(-_v1.z, _v1.x) / DEG, animate);
    }

    function startLook(azDeg, altDeg, { animate, durationMs, fovDeg }) {
        const az1 = wrap360(azDeg), alt1 = clamp(altDeg, SKY_ALT_MIN, SKY_ALT_MAX);
        _v1.copy(northW).multiplyScalar(Math.cos(sky.az * DEG)).addScaledVector(eastW, Math.sin(sky.az * DEG))
            .multiplyScalar(Math.cos(sky.alt * DEG)).addScaledVector(upW, Math.sin(sky.alt * DEG));
        _v2.copy(northW).multiplyScalar(Math.cos(az1 * DEG)).addScaledVector(eastW, Math.sin(az1 * DEG))
            .multiplyScalar(Math.cos(alt1 * DEG)).addScaledVector(upW, Math.sin(alt1 * DEG));
        const arc = Math.acos(clamp(_v1.dot(_v2), -1, 1));
        const fov1 = Number.isFinite(fovDeg) ? clamp(fovDeg, SKY_FOV_MIN, SKY_FOV_MAX) : sky.fov;
        // A deep zoom (70° → 5° is ~3.8 octaves) gets 250 ms per octave on top of the turn.
        const zoomMs = 250 * Math.abs(Math.log2(fov1 / Math.max(sky.fov, 1e-6)));
        const dur = !animate || reduced ? 0 : Number.isFinite(durationMs) ? Math.max(0, durationMs) : 600 + 900 * arc / Math.PI + zoomMs;
        sky.vAz = sky.vAlt = 0;
        return startTween({
            kind: 'look', cancellable: true, az0: sky.az, alt0: sky.alt, fov0: sky.fov,
            az1, alt1, fov1, dur,
        });
    }

    function stepLook(t, u) {
        const e = easeInOutCubic(u);
        sky.az = sky.azT = wrap360(t.az0 + wrap180(t.az1 - t.az0) * e);
        sky.alt = sky.altT = t.alt0 + (t.alt1 - t.alt0) * e;
        sky.fov = sky.fovT = t.fov0 + (t.fov1 - t.fov0) * e;
        applySkyCamera();
    }

    /**
     * follow(): an open-ended, cancellable tween in low orbit behind a moving point of the globe.
     * targetFn(snap, posL, fwdL) writes the point (geometry-local unit vector) and its direction
     * of motion over the ground (unit, square to it) into the two Float64Array(3) and returns true,
     * or false to hold the pose.
     */
    function followNow(targetFn, opts) {
        if (typeof targetFn !== 'function' || !hasSnap) return Promise.resolve(false);
        const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
        const t = {
            kind: 'follow', cancellable: true, dur: Infinity, fn: targetFn,
            alt: clamp(num(opts.altitude, FOLLOW.altitude), 0.05, 3),
            back: clamp(num(opts.backDeg, FOLLOW.backDeg), 0, 60) * DEG,
            tilt: clamp(num(opts.tiltDeg, FOLLOW.tiltDeg), -30, 30) * DEG,
            approachMs: reduced || opts.animate === false ? 0 : Math.max(0, num(opts.approachMs, FOLLOW.approachMs)),
            p0L: toLocal(camera.position, new THREE.Vector3()),
            q0L: camera.quaternion.clone().premultiply(qEInv),
            target: new THREE.Vector3(), heading: new THREE.Vector3(), has: false, last: null,
            onArrive: typeof opts.onArrive === 'function' ? opts.onArrive : null, arrived: false,
        };
        mode = 'orbit';
        zoomTarget = null;
        setControlsEnabled(false);
        return startTween(t);
    }

    /** The chase pose for the follow's smoothed target and heading (Earth-local) into pos and q. */
    function followPose(t, pos, q) {
        // Above a ground point `back` behind the target along its track, looking at it, tilted up
        // so the target sits low in the frame and the limb shows above.
        _flD.copy(t.target).multiplyScalar(Math.cos(t.back)).addScaledVector(t.heading, -Math.sin(t.back)).normalize();
        pos.copy(_flD).multiplyScalar(1 + t.alt);
        _flF.copy(t.target).sub(pos).normalize();
        _flR.crossVectors(_flF, _flD);
        if (_flR.lengthSq() < 1e-12) return basisQuat(_flF, t.heading, q);   // straight down
        _flR.normalize();
        _flU.crossVectors(_flR, _flF);
        _flF.multiplyScalar(Math.cos(t.tilt)).addScaledVector(_flU, Math.sin(t.tilt));
        return basisQuat(_flF, _flD, q);
    }

    function stepFollow(t, tNow, snap) {
        const dt = t.last === null ? 0 : clamp(tNow - t.last, 0, 100);
        t.last = tNow;
        let ok = false;
        try {
            ok = !!t.fn(snap, _flPos, _flFwd);
        } catch {
            ok = false;
        }
        if (ok) {
            _flC.set(_flPos[0], _flPos[1], _flPos[2]);
            _flF.set(_flFwd[0], _flFwd[1], _flFwd[2]);
            if (_flC.lengthSq() > 1e-12 && _flF.lengthSq() > 1e-12) {
                _flC.normalize();
                // The heading turns smoothly (the track bends fast near its ends); the target is exact.
                if (!t.has) t.heading.copy(_flF);
                else t.heading.lerp(_flF, 1 - Math.exp(-dt / 1000 * FOLLOW.turnRate));
                t.heading.addScaledVector(_flC, -t.heading.dot(_flC));
                if (t.heading.lengthSq() < 1e-12) t.heading.copy(_flF).addScaledVector(_flC, -_flF.dot(_flC));
                t.heading.normalize();
                t.target.copy(_flC);
                t.has = true;
            }
        }
        if (!t.has) return;
        followPose(t, _v2, _q1);
        const u = t.approachMs > 0 ? clamp((tNow - t.t0) / t.approachMs, 0, 1) : 1;
        if (u < 1) {
            // Approach from the starting pose: a flight's log-altitude glide and an orientation slerp.
            const e = easeInOutCubic(u);
            const r0 = t.p0L.length(), r1 = _v2.length();
            _v3.copy(t.p0L).normalize();
            _flD.copy(_v2).normalize();
            slerpDir(_v3, _flD, e, _v2);
            const a0 = Math.max(r0 - 1, 1e-4), a1 = Math.max(r1 - 1, 1e-4);
            _v2.multiplyScalar(1 + Math.exp(Math.log(a0) + (Math.log(a1) - Math.log(a0)) * e));
            _q1.copy(_q2.copy(t.q0L).slerp(_q1, e));
        } else if (!t.arrived) {
            t.arrived = true;
            try {
                t.onArrive?.();
            } catch { /* the caller's problem; the follow carries on */ }
        }
        toWorld(_v2, camera.position);
        camera.quaternion.copy(_q1).premultiply(qE);
        camera.up.copy(Y);
        setFov(ORBIT_FOV);
        setNearFor(camera.position.length());
        skyBlend = 0;
    }

    // ---- vantage points ------------------------------------------------------------------------

    /** True while a vantage holds the camera: shown, or flown to or from. */
    function vantageOwns() {
        return vant.kind !== 'none' || (!!tween && tween.kind === 'vantage');
    }

    /** The world position of the orbit pose a vantage returns to. */
    function vantageReturn(out) {
        return vant.retLocal ? toWorld(vant.ret, out) : out.copy(vant.ret);
    }

    /** Remembers the current orbit pose as the vantage's way back. */
    function rememberVantageReturn() {
        vant.retLocal = earthLock;
        if (earthLock) toLocal(camera.position, vant.ret);
        else vant.ret.copy(camera.position);
        vant.hasRet = true;
    }

    /** Ends a vantage without a flight of its own (another camera move took over); listeners hear why. */
    function dropVantage(reason) {
        const kind = vant.kind;
        vant.kind = 'none';
        vant.front = false;
        vant.hasRet = false;
        vant.pending = null;
        if (kind === 'none') return;
        const info = { reason, kind };
        for (const cb of vantEndCbs) {
            try { cb(info); } catch (err) { setTimeout(() => { throw err; }); }
        }
    }

    function loadVantageLib() {
        if (vlib) return Promise.resolve(vlib);
        vlibP ??= import('../astro/vantage.js').then((m) => {
            vlib = m;
            vpose = m.createPose();
            return m;
        });
        return vlibP;
    }

    /** The vantage pose of `kind` for the snapshot, into vpose (world frame). */
    function vantagePoseNow(kind, snap) {
        const aspect = camera.aspect > 0 ? camera.aspect : 16 / 9;
        return kind === 'l1' ? vlib.l1Pose(snap, aspect, vpose) : vlib.lunarOrbitPose(vant.plan, snap, aspect, vpose);
    }

    /** Near plane (and the Moon-in-front flag) for the camera far out: see astro/vantage.js. */
    function setVantageNear(snap) {
        const r = camera.position.length();
        const m = snap && snap.moonPosS;
        const dm = m ? Math.hypot(camera.position.x - m[0], camera.position.y - m[1], camera.position.z - m[2]) : Infinity;
        vant.front = vlib.moonInFront(r, dm);
        const near = vlib.vantageNear(r, dm, vant.front);
        if (Math.abs(camera.near - near) > near * 0.01) {
            camera.near = near;
            camera.updateProjectionMatrix();
        }
    }

    /** Places the camera on a vantage pose. */
    function applyVantagePose(p, snap) {
        camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
        _v1.set(p.fwd[0], p.fwd[1], p.fwd[2]);
        _v2.set(p.up[0], p.up[1], p.up[2]);
        basisQuat(_v1, _v2, camera.quaternion);
        camera.up.copy(_v2);
        setFov(p.fovDeg);
        setVantageNear(snap);
        skyBlend = 0;
    }

    /** A vantage held (no flight): this frame's pose. @returns {boolean} moved */
    function stepVantage(snap) {
        _v3.copy(camera.position);
        _q1.copy(camera.quaternion);
        const f0 = camera.fov;
        applyVantagePose(vantagePoseNow(vant.kind, snap), snap);
        return camera.position.distanceToSquared(_v3) > 1e-14 || Math.abs(camera.fov - f0) > 1e-9
            || 1 - Math.abs(_q1.dot(camera.quaternion)) > 1e-15;
    }

    /**
     * Starts the flight to vantage `to` ('none': back to the remembered orbit pose). Flights to or
     * from lunar orbit are measured from the Moon, all others from the Earth.
     */
    function startVantage(to, animate) {
        const from = vant.kind;
        if (to !== 'none' && from === 'none' && !(tween && tween.kind === 'vantage')) rememberVantageReturn();
        if (to === 'moon') vant.plan = vlib.planLunarOrbit(curSnap, vant.plan ?? undefined);
        const moon = to === 'moon' || from === 'moon' || (!!tween && tween.kind === 'vantage' && tween.moon);
        vant.kind = to;
        mode = 'orbit';
        skyBlend = 0;
        zoomTarget = null;
        setControlsEnabled(false);
        return startTween({
            kind: 'vantage', cancellable: false, to, moon,
            p0: camera.position.clone(), q0: camera.quaternion.clone(), fov0: camera.fov,
            dur: !animate || reduced ? 0 : VANTAGE_MS,
        });
    }

    function stepVantageTween(t, u, snap) {
        // Destination: the vantage pose (it moves with time), or the orbit pose to return to.
        let fov1 = ORBIT_FOV;
        if (t.to === 'none') {
            vantageReturn(_flC);
            _flD.copy(_flC).negate();
            _flU.copy(Y);
        } else {
            const p = vantagePoseNow(t.to, snap);
            _flC.set(p.pos[0], p.pos[1], p.pos[2]);
            _flD.set(p.fwd[0], p.fwd[1], p.fwd[2]);
            _flU.set(p.up[0], p.up[1], p.up[2]);
            fov1 = p.fovDeg;
        }
        // Log-altitude over the centre body along a slerped direction (stepFly's glide). Around the
        // Moon the direction leads on the way out (clearing the Earth first) and trails coming back.
        const m = snap.moonPosS;
        const rc = t.moon ? MOON_RADIUS_ER : 1;
        if (t.moon) _flR.set(m[0], m[1], m[2]);
        else _flR.set(0, 0, 0);
        const lead = t.moon ? VANTAGE_LEAD : 0;
        const out = t.to === 'moon';
        const eD = easeInOutCubic(clamp(out ? u / (1 - lead) : (u - lead) / (1 - lead), 0, 1));
        const eR = easeInOutCubic(clamp(out ? (u - lead) / (1 - lead) : u / (1 - lead), 0, 1));
        _v1.copy(t.p0).sub(_flR);
        const rho0 = _v1.length() || 1;
        _v1.multiplyScalar(1 / rho0);
        _v2.copy(_flC).sub(_flR);
        const rho1 = _v2.length() || 1;
        _v2.multiplyScalar(1 / rho1);
        slerpDir(_v1, _v2, eD, _v3);
        const a0 = Math.max(rho0 - rc, 1e-4), a1 = Math.max(rho1 - rc, 1e-4);
        camera.position.copy(_v3).multiplyScalar(rc + Math.exp(Math.log(a0) + (Math.log(a1) - Math.log(a0)) * eR)).add(_flR);
        // Orientation: from the start pose to looking at the Earth's centre (north up, the orbit
        // controls' own pose), then into the destination's attitude (the lunar orbiter's).
        const e = easeInOutCubic(u);
        _v4.copy(camera.position).negate();
        basisQuat(_v4, Y, _q1);
        if (e < 0.5) camera.quaternion.copy(t.q0).slerp(_q1, smoothstep(0, 0.35, e));
        else {
            basisQuat(_flD, _flU, _q2);
            camera.quaternion.copy(_q1).slerp(_q2, smoothstep(0.65, 1, e));
        }
        camera.up.copy(Y);
        // Field of view: the Earth's share of the frame eases from start to end, so a flight out to
        // L1 reads as a dolly zoom (the stars narrow 60× while the globe keeps its size).
        const tanE = (rr) => Math.tan(Math.asin(Math.min(1, 1 / Math.max(rr, 1))));
        const fr0 = tanE(t.p0.length()) / Math.tan(t.fov0 * DEG / 2);
        const fr1 = tanE(_flC.length()) / Math.tan(fov1 * DEG / 2);
        const fr = fr0 + (fr1 - fr0) * e;
        const fov = 2 * Math.atan(tanE(camera.position.length()) / Math.max(fr, 1e-6)) / DEG;
        setFov(clamp(fov, Math.min(t.fov0, fov1), Math.max(t.fov0, fov1)));
        setVantageNear(snap);
        skyBlend = 0;
        if (u >= 1) {
            if (t.to === 'none') {
                // Home: the orbit pose, the orbit field, the controls back.
                vant.front = false;
                vant.hasRet = false;
                camera.position.copy(_flC);
                orbitQuat(camera.position, camera.quaternion);
                camera.fov = ORBIT_FOV;
                camera.updateProjectionMatrix();
                setNearFor(camera.position.length());
                setControlsEnabled(true);
                syncControls();
            } else {
                applyVantagePose(vantagePoseNow(t.to, snap), snap);
            }
        }
    }

    /** Leaves a vantage (or a flight to or from one) by cutting to the orbit pose it returns to. */
    function cutVantageHome() {
        if (tween && tween.kind === 'vantage') finishTween(false);
        if (vant.hasRet) vantageReturn(camera.position);
        else toWorld(homePosL(_v2), camera.position);
        orbitQuat(camera.position, camera.quaternion);
        camera.up.copy(Y);
        camera.fov = ORBIT_FOV;
        camera.updateProjectionMatrix();
        setNearFor(camera.position.length());
        vant.kind = 'none';
        vant.front = false;
        vant.hasRet = false;
        vant.pending = null;
        mode = 'orbit';
        skyBlend = 0;
        setControlsEnabled(true);
        syncControls();
        rc.invalidate?.();
    }

    /** setVantage once astro/vantage.js is loaded and any globe/sky transition is over. */
    function setVantageNow(kind, { animate = true } = {}) {
        const k = kind === 'l1' || kind === 'moon' ? kind : 'none';
        if (!curSnap || !hasSnap) {
            vant.pending = { kind: k, animate };
            return Promise.resolve(true);
        }
        if (k === vant.kind) return Promise.resolve(true);
        if (k === 'none') {
            if (!vantageOwns()) return Promise.resolve(true);
            if (!vant.hasRet) {
                // Nothing to return to (a vantage from a deep link before the camera had a pose).
                vant.retLocal = true;
                homePosL(vant.ret);
                vant.hasRet = true;
            }
            return startVantage('none', animate);
        }
        if (mode === 'sky' || mode === 'map') {
            // From sky view or the map: back to the globe first, then out to the vantage.
            const req = vantReq;
            const back = mode === 'sky' ? startToOrbit({ animate }) : startFromMap({ animate });
            return back.then((ok) => (ok && req === vantReq ? setVantageNow(k, { animate }) : false));
        }
        return startVantage(k, animate);
    }

    function stepTween(tNow, snap) {
        const t = tween;
        if (t.t0 === null) t.t0 = tNow;
        if (t.kind === 'follow') {
            stepFollow(t, tNow, snap);
            return true;
        }
        const u = t.dur > 0 ? clamp((tNow - t.t0) / t.dur, 0, 1) : 1;
        if (t.kind === 'fly') stepFly(t, u);
        else if (t.kind === 'toSky') stepToSky(t, u);
        else if (t.kind === 'toOrbit') stepToOrbit(t, u);
        else if (t.kind === 'look') stepLook(t, u);
        else if (t.kind === 'vantage') stepVantageTween(t, u, snap);
        else if (t.kind === 'toMap') stepToMap(t, u);
        else if (t.kind === 'fromMap') stepFromMap(t, u);
        if (u >= 1 && t.kind === 'toSky' && Number.isFinite(t.thenFov) && tween === t) {
            // Hand the finished descent over to its zoom; the caller's promise follows the zoom.
            tween = null;
            startLook(t.look.az, t.look.alt, { animate: t.animate, fovDeg: t.thenFov }).then(t.resolve);
        } else if (u >= 1) {
            finishTween(true);
        }
        return true;
    }

    // ---- sky look controller ------------------------------------------------------------------------

    // ---- sidereal tracking ------------------------------------------------------------------------

    /**
     * The free look's ceiling: SKY_ALT_MAX, or the higher altitude tracking released it at (a body
     * passing near the zenith stays centred), which the look can then only come down from.
     */
    function altCeil() {
        return Math.max(SKY_ALT_MAX, Math.min(sky.alt, SKY_ALT_TRACKED_MAX));
    }

    /** Sky look (az/alt targets included) from the camera's current forward, e.g. after tracking. */
    function lookFromForward() {
        _v1.copy(FWD).applyQuaternion(camera.quaternion);
        sky.az = sky.azT = wrap360(Math.atan2(_v1.dot(eastW), _v1.dot(northW)) / DEG);
        sky.alt = sky.altT = clamp(Math.asin(clamp(_v1.dot(upW), -1, 1)) / DEG, SKY_ALT_MIN, SKY_ALT_TRACKED_MAX);
        sky.vAz = sky.vAlt = 0;
    }

    function startBlend() {
        track.q0.copy(camera.quaternion);
        track.t0 = now();
        track.blend = !reduced;
    }

    /** Ends tracking from inside the rig (the target set): back to an upright look, listeners told. */
    function endTrack(reason) {
        const info = { reason, kind: track.kind, id: track.id };
        track.kind = 'none';
        track.id = null;
        track.index = -1;
        lookFromForward();
        startBlend();
        for (const cb of trackEndCbs) {
            try { cb(info); } catch (err) { setTimeout(() => { throw err; }); }
        }
    }

    /** Applies a drag or nudge to the tracked aim: dl degrees turning left, du up (screen axes). */
    function trackTurn(dl, du) {
        if (track.kind === 'body') {
            track.ox = clamp(track.ox + dl, -TRACK_OFF_MAX, TRACK_OFF_MAX);
            track.oy = clamp(track.oy + du, -TRACK_OFF_MAX, TRACK_OFF_MAX);
        } else {
            // The held direction turns about the camera's own up and right axes.
            _v2.set(0, 1, 0).applyQuaternion(camera.quaternion);
            _v3.set(1, 0, 0).applyQuaternion(camera.quaternion);
            track.dirW.applyAxisAngle(_v2, dl * DEG).applyAxisAngle(_v3, du * DEG).normalize();
        }
    }

    /**
     * The tracked pose for this frame (sky view, no tween). 'body': forward on the body's refracted
     * direction (plus the drag offset), zenith up. 'stars': forward on the held direction, the J2000
     * pole up (on the pole itself, the last pose's up). Releases when the aim sinks below TRACK_SET_ALT.
     * @returns {boolean} moved
     */
    function stepTrack(dt, snap) {
        let moved = false;
        if (!track.engaged) {
            track.engaged = true;
            if (track.cut) track.blend = false;
            else startBlend();
            track.cut = false;
            if (track.kind === 'stars') track.dirW.copy(FWD).applyQuaternion(camera.quaternion);
            track.last.copy(camera.quaternion);
            if (Number.isFinite(track.fov)) sky.fovT = clamp(track.fov, SKY_FOV_MIN, SKY_FOV_MAX);
            track.fov = NaN;
            anchor.on = false;
            sky.vAz = sky.vAlt = 0;
            moved = true;
        }
        // The field of view eases in log space, so a 70° → 0.3° telescope zoom reads as one move.
        const dF = Math.log(sky.fovT / sky.fov);
        if (!pinch && Math.abs(dF) > 1e-6) {
            sky.fov *= Math.exp(dF * (reduced ? 1 : 1 - Math.exp(-dt / TRACK_ZOOM_MS)));
            moved = true;
        } else if (!pinch) sky.fov = sky.fovT;
        const F = _v1;
        if (track.kind === 'body') {
            const bs = snap && snap.bodies;
            if (bs && !(track.index >= 0 && bs[track.index] && bs[track.index].id === track.id)) {
                track.index = -1;
                for (let i = 0; i < bs.length; i++) if (bs[i].id === track.id) { track.index = i; break; }
            }
            const b = track.index >= 0 && bs ? bs[track.index] : null;
            if (!b) { endTrack('lost'); return true; }
            const d = b.dirS;
            if (d[0] * upW.x + d[1] * upW.y + d[2] * upW.z < TRACK_SET_SIN) { endTrack('set'); return true; }
            liftByRefraction(d, snap.observer.upS, 1, _lift);
            _v3.set(_lift[0], _lift[1], _lift[2]);
            // Screen axes at the body (right, up), then the offset: turn left by ox, up by oy.
            _v2.crossVectors(_v3, upW);
            if (_v2.lengthSq() < 1e-12) _v2.set(1, 0, 0).cross(_v3);
            _v2.normalize();
            _v4.crossVectors(_v2, _v3);
            const ox = track.ox * DEG, oy = track.oy * DEG;
            F.copy(_v3).multiplyScalar(Math.cos(ox)).addScaledVector(_v2, -Math.sin(ox))
                .multiplyScalar(Math.cos(oy)).addScaledVector(_v4, Math.sin(oy)).normalize();
            basisQuat(F, upW, camera.quaternion);
        } else {
            F.copy(track.dirW);
            if (F.dot(upW) < TRACK_SET_SIN) { endTrack('set'); return true; }
            // On the pole itself the pole leaves the roll undefined: the last pose's up (fixed in
            // the sky as well) keeps it. Anywhere else the pole: a zenith hint would turn the field.
            _v2.crossVectors(F, Y);
            basisQuat(F, _v2.lengthSq() > 1e-10 ? Y : _v2.set(0, 1, 0).applyQuaternion(track.last), camera.quaternion);
        }
        camera.position.copy(posW).multiplyScalar(EYE_R);
        camera.up.copy(upW);
        if (Math.abs(camera.near - 0.01) > 1e-6) {
            camera.near = 0.01;
            camera.updateProjectionMatrix();
        }
        setFov(sky.fov);
        // The look in horizon terms, for getView() (the URL), labels and the hand-back on release.
        sky.az = sky.azT = wrap360(Math.atan2(F.dot(eastW), F.dot(northW)) / DEG);
        sky.alt = sky.altT = Math.asin(clamp(F.dot(upW), -1, 1)) / DEG;
        if (1 - Math.abs(track.last.dot(camera.quaternion)) > 1e-15) moved = true;
        track.last.copy(camera.quaternion);
        return applyBlend() || moved;
    }

    /** The engage/release blend: the old orientation slerped into this frame's pose. */
    function applyBlend() {
        if (!track.blend) return false;
        const u = clamp((now() - track.t0) / TRACK_BLEND_MS, 0, 1);
        if (u >= 1) {
            track.blend = false;
            return true;
        }
        _q1.copy(track.q0).slerp(camera.quaternion, easeInOutCubic(u));
        camera.quaternion.copy(_q1);
        return true;
    }

    function stepSky(dt, snap) {
        if (track.kind !== 'none') return stepTrack(dt, snap);
        if (track.blend) {
            // Released: the upright look, blended in from the tracked (possibly rolled) pose.
            stepSkyLook(dt);
            applyBlend();
            return true;
        }
        return stepSkyLook(dt);
    }

    function stepSkyLook(dt) {
        let moved = false;
        if (!skyDrag && !pinch && (sky.vAz !== 0 || sky.vAlt !== 0)) {
            sky.azT = wrap360(sky.azT + sky.vAz * dt);
            sky.altT = clamp(sky.altT + sky.vAlt * dt, SKY_ALT_MIN, altCeil());
            const decay = Math.exp(-dt / 220);
            sky.vAz *= decay;
            sky.vAlt *= decay;
            if (Math.abs(sky.vAz) < 1e-4 && Math.abs(sky.vAlt) < 1e-4) sky.vAz = sky.vAlt = 0;
            moved = true;
        }
        // Ease the look toward its targets (keyboard nudges, wheel zoom).
        const k = reduced ? 1 : 1 - Math.exp(-dt / 70);
        if (anchor.on) {
            // Zoom about a point: only the field of view eases; the look follows it so the
            // anchored direction stays exactly under the cursor on every frame.
            const dF = sky.fovT - sky.fov;
            const done = Math.abs(dF) <= 1e-5 * sky.fovT;
            sky.fov = done ? sky.fovT : sky.fov + dF * k;
            anchoredLook(sky.fov, _look);
            sky.az = _look.az;
            sky.alt = _look.alt;
            if (done) {
                anchor.on = false;
                sky.azT = sky.az;
                sky.altT = sky.alt;
            }
            applySkyCamera();
            return true;
        }
        const dAz = wrap180(sky.azT - sky.az), dAlt = sky.altT - sky.alt, dF = sky.fovT - sky.fov;
        // Settled to well under a pixel at any field (1e-4° is half a pixel at the 0.2° floor).
        const eps = Math.min(1e-4, 2e-6 * sky.fov);
        if (Math.abs(dAz) > eps || Math.abs(dAlt) > eps || Math.abs(dF) > eps) {
            sky.az = wrap360(sky.az + dAz * k);
            sky.alt += dAlt * k;
            sky.fov += dF * k;
            moved = true;
        } else {
            sky.az = sky.azT;
            sky.alt = sky.altT;
            sky.fov = sky.fovT;
        }
        applySkyCamera();
        return moved;
    }

    // ---- orbit -------------------------------------------------------------------------------------------

    function stepOrbit(dt, lockApplied) {
        if (!controls) {
            orbitQuat(camera.position, camera.quaternion);
            return lockApplied;
        }
        let moved = lockApplied;
        const r = camera.position.length();
        if (zoomTarget !== null) {
            const k = reduced ? 1 : 1 - Math.exp(-dt / 90);
            const nr = Math.exp(Math.log(r) + (Math.log(zoomTarget) - Math.log(r)) * k);
            camera.position.multiplyScalar(nr / r);
            if (Math.abs(Math.log(zoomTarget / nr)) < 1e-4) zoomTarget = null;
            moved = true;
        }
        // Slower rotation near the surface, so a drag moves the ground at a sane rate.
        controls.rotateSpeed = 0.5 * clamp((camera.position.length() - 1) / 2.4, 0.06, 1);
        if (controls.update()) moved = true;
        setNearFor(camera.position.length());
        return moved;
    }

    // ---- per-frame -----------------------------------------------------------------------------------------

    /**
     * Advances the rig one frame. Call every frame with the current snapshot.
     * @param {number} dtMs
     * @param {object} snap Snapshot (SPEC §C.1)
     * @returns {boolean} true when the camera moved (render needed)
     */
    function update(dtMs, snap) {
        let moved = advance(dtMs, snap);
        if (release.on && applyRelease(now())) moved = true;
        // Every module's update() runs before the renderer refreshes the camera's world
        // matrices; doing it here keeps CPU projections (label anchors) on this frame's pose.
        camera.updateMatrixWorld();
        return moved;
    }

    function advance(dtMs, snap) {
        const tNow = now();
        const dt = Number.isFinite(dtMs) ? clamp(dtMs, 0, 100) : clamp(tNow - lastT, 0, 100);
        lastT = tNow;
        if (!snap) return !!tween;
        readSnap(snap);
        curSnap = snap;

        // Earth rotation since the last frame (absolute quaternions: no drift).
        let lockApplied = false;
        if (hasPrev) {
            dq.copy(qE).multiply(_q1.copy(qPrev).invert());
        } else {
            dq.identity();
        }
        qPrev.copy(qE);
        hasPrev = true;

        applyInsets();

        if (pendingView) {
            const v = pendingView;
            pendingView = null;
            if (tween) finishTween(false);
            applyViewNow(v);
            return true;
        }
        if (!initialized) {
            placeOrbitLocal(homePosL(_v2));
            setFov(ORBIT_FOV);
            syncControls();
            initialized = true;
            return true;
        }
        if (!skyDefaulted) {
            // Until sky view has been used, keep its look at the equator-facing default.
            defaultLook(sky);
            sky.azT = sky.az;
            sky.altT = sky.alt;
        }

        if (vant.pending && vlib) {
            const p = vant.pending;
            vant.pending = null;
            setVantageNow(p.kind, { animate: p.animate });
        }
        // The morph only runs on the map and in the flights to and from it.
        if (mapv.k !== 0 && mode !== 'map' && !(tween && tween.kind === 'fromMap')) mapv.k = 0;
        if (tween) return stepTween(tNow, snap);
        if (vant.kind !== 'none') return stepVantage(snap);

        if (mode === 'map') return stepMap(dt);
        if (mode === 'orbit') {
            if (earthLock && dq.w < 1 - 1e-15) {
                camera.position.applyQuaternion(dq);
                lockApplied = true;
            }
            return stepOrbit(dt, lockApplied);
        }
        return stepSky(dt, snap) || !!skyDrag || !!pinch;
    }

    // ---- view insets (UI panels) -----------------------------------------------------------------------

    function applyInsets() {
        const W = rc.size?.w || 1, H = rc.size?.h || 1;
        if (!insetsDirty && W === offsetW && H === offsetH) return;
        insetsDirty = false;
        offsetW = W;
        offsetH = H;
        const cx = (insets.left + W - insets.right) / 2, cy = (insets.top + H - insets.bottom) / 2;
        const ox = W / 2 - cx, oy = H / 2 - cy;
        if (Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5) camera.clearViewOffset();
        else camera.setViewOffset(W, H, ox, oy, W, H);
        camera.updateProjectionMatrix();
    }

    // ---- input ---------------------------------------------------------------------------------------------

    function emitInteract(type) {
        for (const cb of interactCbs) {
            try { cb({ type }); } catch (err) { setTimeout(() => { throw err; }); }
        }
    }

    function emitClick(info) {
        for (const cb of clickCbs) {
            try { cb(info); } catch (err) { setTimeout(() => { throw err; }); }
        }
    }

    function ndcOf(clientX, clientY) {
        const r = el.getBoundingClientRect();
        const w = r.width || 1, h = r.height || 1;
        return { x: ((clientX - r.left) / w) * 2 - 1, y: -(((clientY - r.top) / h) * 2 - 1) };
    }

    const onPointerDown = (e) => {
        emitInteract('pointer');
        cancelTween();
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            downInfo = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now(), moved: false };
        } else if (downInfo) {
            downInfo.moved = true; // multi-touch is never a click
        }
        if (mode === 'map' && !tween) {
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            if (pointers.size === 1) {
                mapv.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
                mapv.pinch = null;
            } else if (pointers.size === 2) {
                mapv.drag = null;
                const [a, b] = [...pointers.values()];
                mapv.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, d0: mapv.d };
                mapv.xT = mapv.x;
                mapv.yT = mapv.y;
                mapv.dT = mapv.d;
            }
            rc.invalidate?.();
        }
        if (mode === 'sky' && !tween) {
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            sky.vAz = sky.vAlt = 0;
            // A wheel zoom still easing stops where it is (az/alt/fov are consistent mid-ease).
            if (anchor.on) {
                anchor.on = false;
                sky.azT = sky.az;
                sky.altT = sky.alt;
                sky.fovT = sky.fov;
            }
            if (pointers.size === 1) {
                skyDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now() };
                pinch = null;
            } else if (pointers.size === 2) {
                skyDrag = null;
                const [a, b] = [...pointers.values()];
                pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, fov: sky.fov };
                // The sky under the fingers' midpoint stays under it as they spread and move.
                const m = ndcOf((a.x + b.x) / 2, (a.y + b.y) / 2);
                setAnchor(m.x, m.y);
            }
            rc.invalidate?.();
        }
    };

    const onPointerMove = (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        p.x = e.clientX;
        p.y = e.clientY;
        if (downInfo && e.pointerId === downInfo.id && !downInfo.moved
            && Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) >= CLICK_PX) downInfo.moved = true;
        if (mode === 'map' && !tween) {
            const m = mapv;
            if (m.drag && e.pointerId === m.drag.id) {
                // The map follows the finger: plane units per pixel at the camera's distance.
                const h = el.clientHeight || rc.size?.h || 800;
                const upp = 2 * m.d * Math.tan(camera.fov * DEG / 2) / h;
                m.x = m.xT = clamp(m.x - (e.clientX - m.drag.x) * upp, -MAP_HALF_W, MAP_HALF_W);
                m.y = m.yT = clamp(m.y + (e.clientY - m.drag.y) * upp, -MAP_HALF_H, MAP_HALF_H);
                m.drag.x = e.clientX;
                m.drag.y = e.clientY;
                m.moved = true;
                rc.invalidate?.();
            } else if (m.pinch && pointers.size >= 2) {
                const [a, b] = [...pointers.values()];
                const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
                const n = ndcOf((a.x + b.x) / 2, (a.y + b.y) / 2);
                mapZoomAt(m.pinch.d0 * m.pinch.dist / dist, n.x, n.y, true);
            }
            return;
        }
        if (mode !== 'sky' || tween) return;
        if (skyDrag && e.pointerId === skyDrag.id) {
            const dx = e.clientX - skyDrag.x, dy = e.clientY - skyDrag.y;
            const tm = now(), dtm = Math.max(1, tm - skyDrag.t);
            const h = el.clientHeight || rc.size?.h || 800;
            const k = sky.fov / h;                              // degrees per pixel
            const kAz = k / Math.max(Math.cos(sky.alt * DEG), 0.25);
            const dAz = -dx * kAz, dAlt = dy * k;
            skyDrag.x = e.clientX;
            skyDrag.y = e.clientY;
            skyDrag.t = tm;
            rc.invalidate?.();
            if (track.kind !== 'none') {
                // Tracking: the drag moves the tracked aim (the sky follows the finger).
                trackTurn(dx * k, dy * k);
                return;
            }
            sky.az = sky.azT = wrap360(sky.az + dAz);
            sky.alt = sky.altT = clamp(sky.alt + dAlt, SKY_ALT_MIN, altCeil());
            // Velocity (deg/ms) for inertia, smoothed.
            sky.vAz = 0.6 * sky.vAz + 0.4 * (dAz / dtm);
            sky.vAlt = 0.6 * sky.vAlt + 0.4 * (dAlt / dtm);
        } else if (pinch && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            sky.fov = sky.fovT = clamp(pinch.fov * (pinch.d / d), SKY_FOV_MIN, SKY_FOV_MAX);
            rc.invalidate?.();
            if (track.kind !== 'none') return;     // tracking: the zoom stays about the centre
            const m = ndcOf((a.x + b.x) / 2, (a.y + b.y) / 2);
            anchor.x = m.x;
            anchor.y = m.y;
            anchoredLook(sky.fov, _look);
            sky.az = sky.azT = _look.az;
            sky.alt = sky.altT = _look.alt;
        }
    };

    const onPointerUp = (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        pointers.delete(e.pointerId);
        try { el.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
        const info = downInfo;
        if (info && e.pointerId === info.id && pointers.size === 0) {
            downInfo = null;
            const tUp = now();
            if (e.type === 'pointerup' && !info.moved && tUp - info.t < CLICK_MS
                && Math.hypot(e.clientX - info.x, e.clientY - info.y) < CLICK_PX) {
                const n = ndcOf(e.clientX, e.clientY);
                let double = false;
                if (lastClick && tUp - lastClick.t < DOUBLE_MS && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < DOUBLE_PX) {
                    double = true;
                    lastClick = null;
                } else {
                    lastClick = { x: e.clientX, y: e.clientY, t: tUp };
                }
                emitClick({ ndcX: n.x, ndcY: n.y, clientX: e.clientX, clientY: e.clientY, double, pointerType: e.pointerType || 'mouse' });
            }
        }
        if (skyDrag && e.pointerId === skyDrag.id) {
            // Inertia only when the release follows recent motion.
            if (reduced || now() - skyDrag.t > 80) sky.vAz = sky.vAlt = 0;
            skyDrag = null;
        }
        if (pointers.size < 2) pinch = null;
        if (mapv.drag && e.pointerId === mapv.drag.id) mapv.drag = null;
        if (pointers.size < 2) mapv.pinch = null;
        if (pointers.size === 1 && mode === 'map' && !tween) {
            const [id, q] = [...pointers.entries()][0];
            mapv.drag = { id, x: q.x, y: q.y };
        }
        if (pointers.size === 1 && mode === 'sky' && !tween) {
            const [id, q] = [...pointers.entries()][0];
            skyDrag = { id, x: q.x, y: q.y, t: now() };
        }
        rc.invalidate?.();
    };

    const onWheel = (e) => {
        emitInteract('wheel');
        cancelTween();
        if ((mode === 'sky' || mode === 'map') && !tween) {
            e.preventDefault();
            const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
            const dy = clamp(e.deltaY * scale / 100, -3, 3);
            const n = ndcOf(e.clientX, e.clientY);
            if (mode === 'map') mapZoomAt(mapv.dT * Math.exp(0.12 * dy), n.x, n.y);
            else zoomSkyAt(sky.fovT * Math.exp(0.1 * dy), n.x, n.y);
            rc.invalidate?.();
        }
    };

    const onContext = (e) => { if (mode === 'sky' || mode === 'map') e.preventDefault(); };

    const onKeyDown = (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        const tgt = e.target;
        const doc = el?.ownerDocument;
        const okTarget = !tgt || tgt === doc?.body || tgt === doc?.documentElement || tgt === el || tgt === doc;
        if (!okTarget) return;
        let handled = true;
        const step = e.shiftKey ? 15 : 5;
        switch (e.code) {
            case 'ArrowLeft': nudge(-step, 0); break;
            case 'ArrowRight': nudge(step, 0); break;
            case 'ArrowUp': nudge(0, step); break;
            case 'ArrowDown': nudge(0, -step); break;
            case 'Equal': case 'NumpadAdd': zoom(1 / 1.25); break;
            case 'Minus': case 'NumpadSubtract': zoom(1.25); break;
            default: handled = false;
        }
        if (handled) {
            e.preventDefault();
            emitInteract('key');
        }
    };

    if (el) {
        el.addEventListener('pointerdown', onPointerDown, { capture: true });
        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', onPointerUp);
        el.addEventListener('pointercancel', onPointerUp);
        el.addEventListener('wheel', onWheel, { capture: true, passive: false });
        el.addEventListener('contextmenu', onContext);
    }
    const win = el?.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
    win?.addEventListener('keydown', onKeyDown);

    // ---- API implementations -----------------------------------------------------------------------------

    function inTransition() {
        return !!tween && (tween.kind === 'toSky' || tween.kind === 'toOrbit' || tween.kind === 'toMap' || tween.kind === 'fromMap');
    }

    /** Runs fn now, or after the running globe/sky transition finishes. */
    function afterTransition(fn) {
        if (inTransition()) return tween.promise.then(() => fn());
        return fn();
    }

    function setModeNow(target, { animate = true, look } = {}, req = modeReq) {
        if (target === mode) {
            if (target === 'sky' && look && Number.isFinite(look.azDeg) && Number.isFinite(look.altDeg)) {
                return startLook(look.azDeg, look.altDeg, { animate, fovDeg: Number(look.fovDeg) });
            }
            return Promise.resolve(true);
        }
        emitInteract('mode');
        // Sky view and the map pass through the globe: the second leg runs unless a newer request came.
        const next = (fn) => (ok) => (ok && req === modeReq ? fn() : false);
        if (mode === 'map') {
            if (target === 'sky') return startFromMap({ animate }).then(next(() => startToSky({ look, animate })));
            return startFromMap({ animate });
        }
        if (target === 'map') {
            if (mode === 'sky') return startToOrbit({ animate }).then(next(() => startToMap({ animate })));
            return startToMap({ animate });
        }
        if (target === 'sky') return startToSky({ look, animate });
        return startToOrbit({ animate });
    }

    function flyToDirNow(dirS, { distance, animate = true, durationMs } = {}) {
        if (!dirS || !hasSnap) return Promise.resolve(false);
        _v1.set(dirS[0], dirS[1], dirS[2]);
        if (!(_v1.lengthSq() > 0)) return Promise.resolve(false);
        _v1.normalize();
        if (mode === 'map') return mapPanToDir(dirS, animate);
        if (mode === 'sky') {
            const alt = Math.asin(clamp(_v1.dot(upW), -1, 1)) / DEG;
            const az = Math.atan2(_v1.dot(eastW), _v1.dot(northW)) / DEG;
            return startLook(az, alt, { animate, durationMs });
        }
        const r = clamp(Number.isFinite(distance) ? distance : camera.position.length(), MIN_DIST, MAX_DIST);
        // Earth-fixed (local) endpoints while locked; startFly converts back to world otherwise.
        const targetL = toLocal(_v1, new THREE.Vector3()).multiplyScalar(r);
        return startFly(targetL, { earthFixed: earthLock, durationMs, animate });
    }

    /**
     * World camera position of the 'Center' framing for a body in direction dirW (unit): on the
     * far side of the globe, the view axis tilted from the body toward the observer's zenith, so
     * the body sits just past the limb on the side of the screen away from the observer, and the
     * observer's beam crosses the globe to it. FRAME_* are measured in the free area the panels
     * leave, along the body's side of the screen: on a portrait phone a body above or below the
     * globe gets the tall side, not the width.
     *
     * pointW (world, Earth radii) is where the body is drawn when it is not at infinity: the Moon,
     * ~60 R out, seen from a camera 4–9 R behind the globe, is pulled 1–1.5° toward the view axis
     * by parallax, behind the limb on a phone. The tilt is then solved so that the point, not the
     * direction, sits at the framing angle.
     * @param {THREE.Vector3} dirW
     * @param {THREE.Vector3} out
     * @param {THREE.Vector3|null} [pointW]
     */
    function framePos(dirW, out, pointW = null) {
        const W = rc.size?.w || 1, H = rc.size?.h || 1;
        const hx = Math.max(1, W - insets.left - insets.right) / 2, hy = Math.max(1, H - insets.top - insets.bottom) / 2;
        const px = (H / 2) / Math.tan(ORBIT_FOV * DEG / 2);    // pixels per unit tangent off the axis
        // Tilt axis: the observer's zenith, else world north, square to the body's direction.
        const perp = _v3.copy(upW).addScaledVector(dirW, -upW.dot(dirW));
        if (perp.lengthSq() < 1e-8) perp.copy(Y).addScaledVector(dirW, -dirW.y);
        if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0);
        perp.normalize();
        // The body's angle from the axis: FRAME_FILL of the free half-extent along its direction on
        // screen (_fG in the camera's north-up basis, as orbitQuat builds it), which turns a little
        // with the angle itself, so two passes; capped so that the globe fits across.
        const bMax = Math.atan(FRAME_FIT * Math.min(hx, hy) / px) / FRAME_LIMB;
        let beta = Math.atan(FRAME_FILL * Math.min(hx, hy) / px);
        for (let pass = 0; pass < 2; pass++) {
            tiltAxis(dirW, perp, beta);
            _fR.crossVectors(_fF, Y);
            if (_fR.lengthSq() < 1e-10) break;     // looking along the pole: keep the narrower side
            _fR.normalize();
            _fU.crossVectors(_fR, _fF);
            const ux = Math.abs(_fG.dot(_fR)), uy = Math.abs(_fG.dot(_fU));
            const e = Math.min(ux > 1e-9 ? hx / ux : Infinity, uy > 1e-9 ? hy / uy : Infinity);
            if (!Number.isFinite(e)) break;
            beta = Math.min(Math.atan(FRAME_FILL * e / px), bMax);
        }
        const dist = clamp(1 / Math.sin(FRAME_LIMB * beta), MIN_DIST, MAX_DIST);
        let tilt = beta;
        if (pointW) {
            // Fixed point on the tilt: the point's angle grows ~0.9° per degree, so four steps
            // leave well under 0.01°.
            for (let k = 0; k < 4; k++) {
                tiltAxis(dirW, perp, tilt);
                _fR.copy(pointW).addScaledVector(_fF, dist);   // point − camera
                const len = _fR.length();
                if (!(len > 1e-6)) break;
                tilt = clamp(tilt + beta - Math.acos(clamp(_fR.dot(_fF) / len, -1, 1)), 0, Math.PI / 2);
            }
        }
        tiltAxis(dirW, perp, tilt);
        return out.copy(_fF).multiplyScalar(-dist);
    }

    /** framePos: the view axis _fF, tilted by b from dirW toward perp, and its in-plane normal _fG. */
    function tiltAxis(dirW, perp, b) {
        const c = Math.cos(b), s = Math.sin(b);
        _fF.copy(dirW).multiplyScalar(c).addScaledVector(perp, s);
        _fG.copy(perp).multiplyScalar(c).addScaledVector(dirW, -s);
    }

    function frameDirNow(dirS, { animate = true, durationMs, point } = {}) {
        if (!dirS || !hasSnap) return Promise.resolve(false);
        _v1.set(dirS[0], dirS[1], dirS[2]);
        if (!(_v1.lengthSq() > 0)) return Promise.resolve(false);
        _v1.normalize();
        if (mode === 'sky' || mode === 'map') return flyToDirNow(dirS, { animate, durationMs });
        const p = point && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2])
            ? _fP.set(point[0], point[1], point[2]) : null;
        // Earth-fixed (local) endpoints while locked; startFly converts back to world otherwise.
        const targetL = toLocal(framePos(_v1, _v2, p), new THREE.Vector3());
        return startFly(targetL, { earthFixed: earthLock, durationMs, animate });
    }

    /** Sky view: glides the look to the sky under a point of the canvas, narrowing the field. */
    function centerAtNow(ndcX, ndcY, { animate = true, fovFactor = SKY_DBL_ZOOM } = {}) {
        if (mode !== 'sky' || !hasSnap || !Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return Promise.resolve(false);
        if (track.kind !== 'none') {
            // Tracking keeps its aim: a double-click only narrows the field.
            sky.fovT = clamp(sky.fovT * (fovFactor > 0 ? fovFactor : 1), SKY_FOV_MIN, SKY_FOV_MAX);
            rc.invalidate?.();
            return Promise.resolve(true);
        }
        skyDirAt(ndcX, ndcY, _look);
        return startLook(_look.az, _look.alt, { animate, fovDeg: sky.fovT * (fovFactor > 0 ? fovFactor : 1) });
    }

    function flyToLatLonNow(latDeg, lonDeg, { distance = 3.2, animate = true, durationMs } = {}) {
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return Promise.resolve(false);
        const dist = clamp(Number.isFinite(distance) ? distance : 3.2, MIN_DIST, MAX_DIST);
        if (!hasSnap) {
            pendingView = { mode: 'orbit', latDeg: clamp(latDeg, -90, 90), lonDeg: wrap180(lonDeg), distance: dist };
            return Promise.resolve(true);
        }
        if (mode === 'map') return mapPanTo(latDeg, lonDeg, animate);
        const p = clamp(latDeg, -90, 90) * DEG, l = lonDeg * DEG, cp = Math.cos(p);
        const targetL = new THREE.Vector3(cp * Math.cos(l), Math.sin(p), -cp * Math.sin(l)).multiplyScalar(dist);
        if (mode === 'sky') return startToOrbit({ targetL, animate });
        return startFly(targetL, { earthFixed: true, durationMs, animate });
    }

    function homeNow({ animate = true } = {}) {
        if (!hasSnap) {
            initialized = false;
            return Promise.resolve(true);
        }
        if (mode === 'sky') {
            const L = defaultLook({ az: 0, alt: 0 });
            return startLook(L.az, L.alt, { animate, fovDeg: SKY_FOV });
        }
        if (mode === 'map') {
            // The whole map again.
            mapv.xT = mapv.yT = 0;
            mapv.dT = mapFit();
            if (!animate || reduced) {
                mapv.x = mapv.y = 0;
                mapv.d = mapv.dT;
            }
            mapv.moved = true;
            rc.invalidate?.();
            return Promise.resolve(true);
        }
        return startFly(homePosL(new THREE.Vector3()), { earthFixed: true, animate });
    }

    /**
     * frameSpan: an orbit pose square to a segment from the Earth's centre along dirS (and to world
     * north), on the observer's side, far enough out that the segment's end fits the free area. The
     * Earth–Moon line (two-observers: the beams of two places converging on the Moon) reads only at
     * this scale, about 100 Earth radii out.
     */
    function frameSpanNow(dirS, lengthER, { animate = true, durationMs } = {}) {
        if (!dirS || !hasSnap || mode !== 'orbit' || !(lengthER > 0)) return Promise.resolve(false);
        _v1.set(dirS[0], dirS[1], dirS[2]);
        if (!(_v1.lengthSq() > 0)) return Promise.resolve(false);
        _v1.normalize();
        _v2.crossVectors(_v1, Y);
        if (_v2.lengthSq() < 1e-8) _v2.set(1, 0, 0).cross(_v1);
        _v2.normalize();
        if (_v2.dot(posW) < 0) _v2.negate();
        // Seen from _v2·d with north up, the end sits (along screen-right, along screen-up)·len/d off centre.
        _v3.crossVectors(Y, _v2).normalize();
        const W = rc.size?.w || 1, H = rc.size?.h || 1;
        const hx = Math.max(1, W - insets.left - insets.right) / 2, hy = Math.max(1, H - insets.top - insets.bottom) / 2;
        const px = (H / 2) / Math.tan(ORBIT_FOV * DEG / 2);
        const ex = Math.abs(_v1.dot(_v3)) * lengthER, ey = Math.abs(_v1.y) * lengthER;
        const dist = clamp(Math.max(ex * px / (SPAN_FILL * hx), ey * px / (SPAN_FILL * hy), HOME_DIST), MIN_DIST, MAX_DIST);
        const targetL = toLocal(_v2.multiplyScalar(dist), new THREE.Vector3());
        return startFly(targetL, { earthFixed: earthLock, durationMs, animate });
    }

    // ---- public API ------------------------------------------------------------------------------------------

    /**
     * Rotates the view: orbit → swings the camera around the globe; sky → turns the look.
     * Positive dx turns right / east, positive dy tilts up.
     * @param {number} dxDeg
     * @param {number} dyDeg
     */
    function nudge(dxDeg, dyDeg) {
        if (vantageOwns()) return;     // a vantage is a fixed point of view
        cancelTween();
        anchor.on = false;
        // Sky view: steps shrink with a narrow field (a 5° step at the 0.2° floor loses the target).
        const kf = Math.min(1, sky.fov / SKY_FOV);
        if (mode === 'map') {
            // Pans: a 5° step moves 5° of longitude at the whole-map zoom, less when zoomed in.
            const k = DEG * MAP_SCALE * clamp(mapv.dT / mapFit(), 0.05, 1);
            mapv.xT += dxDeg * k;
            mapv.yT += dyDeg * k;
            clampMapTargets();
            mapv.moved = true;
        } else if (mode === 'sky' && track.kind !== 'none') {
            trackTurn(-dxDeg * kf, dyDeg * kf);
        } else if (mode === 'sky') {
            sky.azT = wrap360(sky.azT + dxDeg * kf);
            sky.altT = clamp(sky.altT + dyDeg * kf, SKY_ALT_MIN, altCeil());
        } else if (controls) {
            // Positive dx swings the camera west so the globe turns east-to-west under the view.
            controls._rotateLeft?.(dxDeg * DEG);
            controls._rotateUp?.(-dyDeg * DEG);
        }
        rc.invalidate?.();
    }

    /**
     * Zooms by a factor (< 1 zooms in): orbit distance, or sky field of view.
     * @param {number} factor
     */
    function zoom(factor) {
        if (!(factor > 0) || vantageOwns()) return;
        cancelTween();
        anchor.on = false;
        if (mode === 'sky') sky.fovT = clamp(sky.fovT * factor, SKY_FOV_MIN, SKY_FOV_MAX);
        else if (mode === 'map') {
            mapv.dT = clamp(mapv.dT * factor, MAP_D_MIN, mapDMax());
            mapv.moved = true;
        } else zoomTarget = clamp((zoomTarget ?? camera.position.length()) * factor, MIN_DIST, MAX_DIST);
        rc.invalidate?.();
    }

    return {
        camera,
        get controls() { return controls; },
        /** Logical mode: switches at the start of a transition. */
        get mode() { return mode; },
        get skyBlend() { return skyBlend; },
        /** The globe → flat map morph, 0 … 1 (FrameInfo.mapK). */
        get mapK() { return mapv.k; },
        /** The map plane's frame (geo/mapview.js; live, rewritten as each morph starts). */
        get mapFrame() { return mapv.frame; },
        get tweening() { return !!tween; },
        get dragging() { return pointers.size > 0; },
        get earthLock() { return earthLock; },
        get reducedMotion() { return reduced; },

        /**
         * Switches between globe and sky view. A call made during a running
         * transition waits for it (a transition is never abandoned halfway).
         * `look.fovDeg` (clamped to 0.2–100°) also sets the field: in sky view the turn and the zoom
         * are one look tween; from the globe the zoom follows the descent, which lands at 70°.
         * @param {'orbit'|'sky'} next
         * @param {{animate?:boolean, look?:{azDeg:number, altDeg:number, fovDeg?:number}}} [opts]
         * @returns {Promise<boolean>}
         */
        setMode(next, opts = {}) {
            const target = next === 'sky' ? 'sky' : next === 'map' ? 'map' : 'orbit';
            if (inTransition() && mode === target && !opts?.look) return tween.promise.then(() => true);
            const req = ++modeReq;
            return afterTransition(() => (req === modeReq ? setModeNow(target, opts, req) : false));
        },

        /** @param {boolean} on */
        setEarthLock(on) {
            earthLock = !!on;
            hasPrev = false;
        },

        /**
         * Orbit: flies the camera to look at the Earth from direction dirS. Sky: aims the view at dirS.
         * @param {ArrayLike<number>} dirS world unit vector (read when the flight starts)
         * @param {{distance?:number, animate?:boolean, durationMs?:number}} [opts]
         * @returns {Promise<boolean>}
         */
        flyToDir(dirS, opts = {}) {
            return afterTransition(() => flyToDirNow(dirS, opts));
        },

        /**
         * Brings direction dirS into view ('Center'). Orbit: flies to the far side of the globe so
         * dirS sits just past the limb, the observer's beam crossing the globe toward it. Sky: aims
         * the view at dirS. `point` is where the body is drawn when it is not at infinity (the
         * Moon's snap.moonPosS): orbit framing then places that point, parallax included.
         * @param {ArrayLike<number>} dirS world unit vector (read when the flight starts)
         * @param {{animate?:boolean, durationMs?:number, point?:ArrayLike<number>|null}} [opts]
         *   point: world position in Earth radii (read when the flight starts)
         * @returns {Promise<boolean>}
         */
        frameDir(dirS, opts = {}) {
            return afterTransition(() => frameDirNow(dirS, opts));
        },

        /**
         * Sky view: glides the look to the sky under a point of the canvas and narrows the field
         * (double-click on empty sky). Resolves false in globe view.
         * @param {number} ndcX
         * @param {number} ndcY
         * @param {{animate?:boolean, fovFactor?:number}} [opts]
         * @returns {Promise<boolean>}
         */
        centerAt(ndcX, ndcY, opts = {}) {
            if (inTransition()) return Promise.resolve(false);
            return centerAtNow(Number(ndcX), Number(ndcY), opts);
        },

        /**
         * Flies to look straight down on a lat/lon (Earth-fixed). Accepts (lat, lon, opts) or ({latDeg, lonDeg}, opts).
         * From sky view this is the sky → globe transition ending over the point.
         * @returns {Promise<boolean>}
         */
        flyToLatLon(latDeg, lonDeg, opts) {
            if (latDeg && typeof latDeg === 'object') {
                opts = lonDeg;
                lonDeg = latDeg.lonDeg ?? latDeg.lon;
                latDeg = latDeg.latDeg ?? latDeg.lat;
            }
            return afterTransition(() => flyToLatLonNow(Number(latDeg), Number(lonDeg), opts || {}));
        },

        /**
         * Resets the camera: orbit → straight above the observer at 3.4, north up;
         * sky → equator-facing horizon at 15°, 70° field of view.
         * @param {{animate?:boolean}} [opts]
         * @returns {Promise<boolean>}
         */
        home(opts = {}) {
            return afterTransition(() => homeNow(opts));
        },

        /**
         * Follows a moving point of the globe from low orbit (the eclipse shadow chase): the camera
         * glides over `approachMs` into a pose `altitude` Earth radii up, `backDeg` behind the point
         * along its direction of motion, looking at it with the view tilted `tiltDeg` up (the limb
         * in the top of the frame), then keeps that pose as the point moves. The heading is
         * low-passed, the point followed exactly. Earth-fixed, so it holds whatever the clock does.
         * Any pointer, wheel or key input cancels it (resolving false), and stopFollow() ends it
         * (true); either way the orbit controls take over with a short orientation blend. From sky
         * view it first returns to the globe.
         * @param {(snap:object, posL:Float64Array, fwdL:Float64Array)=>boolean} targetFn writes the point
         *   (Earth geometry-local unit vector) and its unit direction of motion; false holds the pose
         * @param {{altitude?:number, backDeg?:number, tiltDeg?:number, approachMs?:number, animate?:boolean,
         *          onArrive?:()=>void}} [opts] onArrive: called once, from update(), when the
         *   approach is done and the camera is in the chase pose
         * @returns {Promise<boolean>}
         */
        follow(targetFn, opts = {}) {
            return afterTransition(() => {
                if (mode === 'orbit') return followNow(targetFn, opts || {});
                const back = mode === 'sky' ? startToOrbit({ animate: opts?.animate !== false }) : startFromMap({ animate: opts?.animate !== false });
                return back.then((ok) => (ok ? followNow(targetFn, opts || {}) : false));
            });
        },

        /**
         * Ends a running follow() (its promise resolves true) and hands the camera to the orbit
         * controls. Returns false when not following.
         * @returns {boolean}
         */
        stopFollow() {
            if (!tween || tween.kind !== 'follow') return false;
            finishTween(true);
            setControlsEnabled(true);
            syncControls();
            rc.invalidate?.();
            return true;
        },

        /** True while follow() drives the camera. */
        get following() { return !!tween && tween.kind === 'follow'; },

        /**
         * Sidereal tracking in sky view (applied whenever the rig is in sky view and not in a
         * flight): 'body' keeps body `id` centred at its refracted place, zenith up; 'stars' holds
         * the star field still with celestial north up, so the horizon and landscape swing; 'none'
         * returns to the upright look. Engaging and releasing blend over 600 ms (a cut under reduced
         * motion). A drag or arrow key moves the tracked aim; the wheel and pinch zoom about the
         * centre. When the aim sinks below −8° tracking ends by itself and onTrackEnd listeners hear
         * {reason: 'set'|'lost', kind, id}.
         * @param {'none'|'body'|'stars'} kind
         * @param {string|null} [id] the body, for 'body'
         */
        setTracking(kind, id = null) {
            let k = kind === 'body' || kind === 'stars' ? kind : 'none';
            const nid = k === 'body' && id ? String(id) : null;
            if (k === 'body' && !nid) k = 'none';
            if (k === track.kind && nid === track.id) return;
            const was = track.kind;
            track.kind = k;
            track.id = nid;
            track.index = -1;
            track.ox = track.oy = 0;
            track.engaged = false;
            if (k === 'none' && was !== 'none' && mode === 'sky' && !tween) {
                lookFromForward();
                startBlend();
            }
            rc.invalidate?.();
        },

        /** The tracking mode: 'none' | 'body' | 'stars'. */
        get tracking() { return track.kind; },

        /**
         * The telescope framing: the field the next tracking engage zooms to (log-eased), and a
         * re-engage now if already tracking, so a 'Telescope' on the tracked body re-centres it.
         * @param {number} fovDeg clamped to 0.2–100°
         */
        telescope(fovDeg) {
            if (!Number.isFinite(fovDeg)) return;
            track.fov = clamp(fovDeg, SKY_FOV_MIN, SKY_FOV_MAX);
            track.engaged = false;
            track.ox = track.oy = 0;
            rc.invalidate?.();
        },

        /** @param {(info:{reason:string, kind:string, id:string|null})=>void} cb @returns {()=>boolean} off */
        onTrackEnd(cb) {
            trackEndCbs.add(cb);
            return () => trackEndCbs.delete(cb);
        },

        /**
         * Vantage points (globe view): 'l1' (the sunlit Earth from 1.5 million km sunward, DSCOVR's
         * view), 'moon' (Earthrise from a low lunar orbit) or 'none' (back to the orbit pose the
         * vantage was entered from). The camera flies there over 4 s (a cut under reduced motion or
         * with animate: false); from sky view it first returns to the globe. Resolves when the flight
         * is done (false when another camera move took over, or astro/vantage.js failed to load).
         * @param {'none'|'l1'|'moon'} kind
         * @param {{animate?:boolean}} [opts]
         * @returns {Promise<boolean>}
         */
        setVantage(kind, opts = {}) {
            const k = kind === 'l1' || kind === 'moon' ? kind : 'none';
            // The latest call wins: one still waiting for the module or a transition is dropped.
            const req = ++vantReq;
            if (k === 'none' && !vantageOwns()) {
                vant.pending = null;
                return Promise.resolve(true);
            }
            if (k === 'none' && (opts?.animate === false || reduced)) {
                // A cut, now: the intro (which then writes the camera itself) needs it synchronous.
                cutVantageHome();
                return Promise.resolve(true);
            }
            return loadVantageLib().then(
                () => afterTransition(() => (req === vantReq ? setVantageNow(k, opts || {}) : false)),
                (err) => {
                    console.error('[rig] vantage points unavailable', err);
                    for (const cb of vantEndCbs) {
                        try { cb({ reason: 'failed', kind: k }); } catch { /* ignore */ }
                    }
                    return false;
                });
        },

        /** The vantage shown or being flown to: 'none' | 'l1' | 'moon'. */
        get vantage() { return vant.kind; },

        /**
         * True while the camera is so close to the Moon that it must draw in front of everything
         * (lunar orbit, or a flight there): the near plane then ignores it (FrameInfo.moonFront).
         */
        get moonFront() { return vant.front; },

        /** @param {(info:{reason:string, kind:string})=>void} cb @returns {()=>boolean} off */
        onVantageEnd(cb) {
            vantEndCbs.add(cb);
            return () => vantEndCbs.delete(cb);
        },

        update,

        /**
         * Current camera view in the URL's CamView shape.
         * @returns {{mode:'orbit', latDeg:number, lonDeg:number, distance:number}|{mode:'sky', azDeg:number, altDeg:number, fovDeg:number}}
         */
        getView() {
            if (mode === 'sky') {
                return { mode: 'sky', azDeg: wrap360(sky.azT), altDeg: sky.altT, fovDeg: sky.fovT };
            }
            if (mode === 'map') {
                return { mode: 'map', latDeg: mapv.yT / MAP_SCALE / DEG, lonDeg: wrap180(mapv.xT / MAP_SCALE / DEG), distance: mapv.dT };
            }
            // A vantage (url `vt`) reports the orbit pose it returns to.
            if (vantageOwns() && vant.hasRet) toLocal(vantageReturn(_v1), _v1);
            else toLocal(camera.position, _v1);
            const r = _v1.length() || 1;
            return {
                mode: 'orbit',
                latDeg: Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z)) / DEG,
                lonDeg: Math.atan2(-_v1.z, _v1.x) / DEG,
                distance: r,
            };
        },

        /**
         * Applies a CamView instantly (deep links, restoring state). Before the first
         * snapshot the view is queued and applied on the first update.
         * @param {object|string} cam
         */
        setView(cam) {
            const v = parseView(cam);
            if (!v) return false;
            if (!hasSnap) {
                pendingView = v;
                return true;
            }
            if (v.mode === 'orbit' && vantageOwns()) {
                // A vantage stays; the view becomes the orbit pose it returns to.
                const p = v.latDeg * DEG, l = v.lonDeg * DEG, cp = Math.cos(p);
                _v2.set(cp * Math.cos(l), Math.sin(p), -cp * Math.sin(l)).multiplyScalar(v.distance);
                vant.retLocal = true;
                vant.ret.copy(_v2);
                vant.hasRet = true;
                return true;
            }
            if (tween) finishTween(false);
            applyViewNow(v);
            rc.invalidate?.();
            return true;
        },

        onInteract(cb) {
            interactCbs.add(cb);
            return () => interactCbs.delete(cb);
        },

        onClick(cb) {
            clickCbs.add(cb);
            return () => clickCbs.delete(cb);
        },

        nudge,
        zoom,

        /**
         * Zooms by a factor about a point of the canvas: sky view keeps the sky under it in place
         * (the wheel and pinch path); the globe zooms about its centre, like zoom().
         * @param {number} factor < 1 zooms in
         * @param {number} ndcX
         * @param {number} ndcY
         */
        zoomAt(factor, ndcX, ndcY) {
            if (!(factor > 0) || vantageOwns()) return;
            cancelTween();
            if (mode === 'sky' && !tween && Number.isFinite(ndcX) && Number.isFinite(ndcY)) {
                zoomSkyAt(sky.fovT * factor, ndcX, ndcY);
                rc.invalidate?.();
            } else if (mode === 'map' && !tween && Number.isFinite(ndcX) && Number.isFinite(ndcY)) {
                mapZoomAt(mapv.dT * factor, ndcX, ndcY);
            } else zoom(factor);
        },

        /**
         * Globe view: flies to an orbit pose square to the segment from the Earth's centre along
         * dirS, `lengthER` long (the Earth–Moon line), with its far end inside the free area.
         * Resolves false outside the globe view.
         * @param {ArrayLike<number>} dirS world unit vector
         * @param {number} lengthER
         * @param {{animate?:boolean, durationMs?:number}} [opts]
         * @returns {Promise<boolean>}
         */
        frameSpan(dirS, lengthER, opts = {}) {
            return afterTransition(() => frameSpanNow(dirS, Number(lengthER), opts || {}));
        },

        /**
         * Keeps the globe centred in the area not covered by UI (CSS px from each edge).
         * @param {{left?:number, right?:number, top?:number, bottom?:number}} next
         */
        setViewInsets(next) {
            insets.left = Math.max(0, Number(next?.left) || 0);
            insets.right = Math.max(0, Number(next?.right) || 0);
            insets.top = Math.max(0, Number(next?.top) || 0);
            insets.bottom = Math.max(0, Number(next?.bottom) || 0);
            // Shared with the beam label anchors and the DOM labels (rc.size.insets).
            const shared = rc.size?.insets;
            if (shared) {
                shared.left = insets.left;
                shared.right = insets.right;
                shared.top = insets.top;
                shared.bottom = insets.bottom;
            }
            insetsDirty = true;
            applyInsets();
            rc.invalidate?.();
        },

        /** @param {boolean} on */
        setReducedMotion(on) {
            reduced = !!on;
            if (reduced) sky.vAz = sky.vAlt = 0;
        },

        dispose() {
            if (tween) finishTween(false);
            if (el) {
                el.removeEventListener('pointerdown', onPointerDown, { capture: true });
                el.removeEventListener('pointermove', onPointerMove);
                el.removeEventListener('pointerup', onPointerUp);
                el.removeEventListener('pointercancel', onPointerUp);
                el.removeEventListener('wheel', onWheel, { capture: true });
                el.removeEventListener('contextmenu', onContext);
            }
            win?.removeEventListener('keydown', onKeyDown);
            controls?.dispose();
            interactCbs.clear();
            clickCbs.clear();
            trackEndCbs.clear();
            vantEndCbs.clear();
        },
    };
}
