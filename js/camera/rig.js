/**
 * Camera rig (SPEC §C.6, §F.5): orbit around the globe with OrbitControls,
 * Earth-lock by quaternion delta, a sky-view look controller standing at the
 * observer, eased fly-to tweens and the globe ↔ sky transitions.
 *
 *   createRig(rc, {dom, reducedMotion}) → { camera, mode, skyBlend, tweening, dragging,
 *     setMode(mode, {animate, look}) → Promise, setEarthLock(on), flyToDir(dirS, {distance, animate, durationMs}) → Promise,
 *     flyToLatLon(latDeg, lonDeg, {distance=3.2, animate, durationMs}) → Promise, home({animate}) → Promise,
 *     update(dtMs, snap) → boolean, getView() → CamView, setView(cam), onInteract(cb) → off, onClick(cb) → off,
 *     nudge(dxDeg, dyDeg), zoom(factor), setViewInsets({left, right, top, bottom}), setReducedMotion(on), dispose() }
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

const DEG = Math.PI / 180;
const ORBIT_FOV = 45;
const SKY_FOV = 70;
const SKY_FOV_MIN = 5;
const SKY_FOV_MAX = 100;
const SKY_ALT_MIN = -10;
const SKY_ALT_MAX = 89;
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

/** Parses a CamView-ish value: {mode, latDeg|lat, lonDeg|lon, distance|dist} | {mode, azDeg|az, altDeg|alt, fovDeg|fov} | 'o:lat,lon,d' | 's:az,alt,fov'. */
function parseView(cam) {
    if (cam == null) return null;
    if (typeof cam === 'string') {
        const m = /^\s*([os])\s*:\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*$/.exec(cam);
        if (!m) return null;
        const a = +m[2], b = +m[3], c = +m[4];
        return m[1] === 'o' ? { mode: 'orbit', latDeg: a, lonDeg: b, distance: c } : { mode: 'sky', azDeg: a, altDeg: b, fovDeg: c };
    }
    if (typeof cam !== 'object') return null;
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
    let skyDefaulted = false;
    // Orbit zoom smoothing (keyboard/API zoom); OrbitControls handles wheel/pinch itself.
    let zoomTarget = null;
    // The orbit pose to return to from sky view, in Earth-local coordinates.
    const orbitReturnL = new THREE.Vector3();
    let hasOrbitReturn = false;

    let tween = null;
    let pendingView = null;
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
    let pinch = null;         // {d, fov}
    let lastT = now();

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
        if (Math.abs(camera.fov - f) > 1e-4) {
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

    function defaultLook(out) {
        out.az = obsLat.v >= 0 ? 180 : 0;
        out.alt = 15;
        return out;
    }

    function applyViewNow(v) {
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
            if (mode === 'orbit') rememberOrbitPose();
            mode = 'sky';
            skyBlend = 1;
            sky.az = sky.azT = v.azDeg;
            sky.alt = sky.altT = v.altDeg;
            sky.fov = sky.fovT = v.fovDeg;
            sky.vAz = sky.vAlt = 0;
            skyDefaulted = true;
            setControlsEnabled(false);
            applySkyCamera();
        }
        initialized = true;
    }

    function rememberOrbitPose() {
        toLocal(camera.position, orbitReturnL);
        hasOrbitReturn = true;
    }

    // ---- tweens ----------------------------------------------------------------------------------

    function finishTween(done) {
        const t = tween;
        tween = null;
        if (t && t.resolve) t.resolve(done);
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
        if (tween) finishTween(false);
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
        return startTween({ kind: 'fly', cancellable: true, earthFixed, d0, d1, r0, r1, arc, dur });
    }

    function stepFly(t, u) {
        const e = easeInOutCubic(u);
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

    function startLook(azDeg, altDeg, { animate, durationMs, fovDeg }) {
        const az1 = wrap360(azDeg), alt1 = clamp(altDeg, SKY_ALT_MIN, SKY_ALT_MAX);
        _v1.copy(northW).multiplyScalar(Math.cos(sky.az * DEG)).addScaledVector(eastW, Math.sin(sky.az * DEG))
            .multiplyScalar(Math.cos(sky.alt * DEG)).addScaledVector(upW, Math.sin(sky.alt * DEG));
        _v2.copy(northW).multiplyScalar(Math.cos(az1 * DEG)).addScaledVector(eastW, Math.sin(az1 * DEG))
            .multiplyScalar(Math.cos(alt1 * DEG)).addScaledVector(upW, Math.sin(alt1 * DEG));
        const arc = Math.acos(clamp(_v1.dot(_v2), -1, 1));
        const dur = !animate || reduced ? 0 : Number.isFinite(durationMs) ? Math.max(0, durationMs) : 600 + 900 * arc / Math.PI;
        sky.vAz = sky.vAlt = 0;
        return startTween({
            kind: 'look', cancellable: true, az0: sky.az, alt0: sky.alt, fov0: sky.fov,
            az1, alt1, fov1: Number.isFinite(fovDeg) ? clamp(fovDeg, SKY_FOV_MIN, SKY_FOV_MAX) : sky.fov, dur,
        });
    }

    function stepLook(t, u) {
        const e = easeInOutCubic(u);
        sky.az = sky.azT = wrap360(t.az0 + wrap180(t.az1 - t.az0) * e);
        sky.alt = sky.altT = t.alt0 + (t.alt1 - t.alt0) * e;
        sky.fov = sky.fovT = t.fov0 + (t.fov1 - t.fov0) * e;
        applySkyCamera();
    }

    function stepTween(tNow) {
        const t = tween;
        if (t.t0 === null) t.t0 = tNow;
        const u = t.dur > 0 ? clamp((tNow - t.t0) / t.dur, 0, 1) : 1;
        if (t.kind === 'fly') stepFly(t, u);
        else if (t.kind === 'toSky') stepToSky(t, u);
        else if (t.kind === 'toOrbit') stepToOrbit(t, u);
        else if (t.kind === 'look') stepLook(t, u);
        if (u >= 1) finishTween(true);
        return true;
    }

    // ---- sky look controller ------------------------------------------------------------------------

    function stepSky(dt) {
        let moved = false;
        if (!skyDrag && !pinch && (sky.vAz !== 0 || sky.vAlt !== 0)) {
            sky.azT = wrap360(sky.azT + sky.vAz * dt);
            sky.altT = clamp(sky.altT + sky.vAlt * dt, SKY_ALT_MIN, SKY_ALT_MAX);
            const decay = Math.exp(-dt / 220);
            sky.vAz *= decay;
            sky.vAlt *= decay;
            if (Math.abs(sky.vAz) < 1e-4 && Math.abs(sky.vAlt) < 1e-4) sky.vAz = sky.vAlt = 0;
            moved = true;
        }
        // Ease the look toward its targets (keyboard nudges, wheel zoom).
        const k = reduced ? 1 : 1 - Math.exp(-dt / 70);
        const dAz = wrap180(sky.azT - sky.az), dAlt = sky.altT - sky.alt, dF = sky.fovT - sky.fov;
        if (Math.abs(dAz) > 1e-4 || Math.abs(dAlt) > 1e-4 || Math.abs(dF) > 1e-4) {
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
        const moved = advance(dtMs, snap);
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

        if (tween) return stepTween(tNow);

        if (mode === 'orbit') {
            if (earthLock && dq.w < 1 - 1e-15) {
                camera.position.applyQuaternion(dq);
                lockApplied = true;
            }
            return stepOrbit(dt, lockApplied);
        }
        return stepSky(dt) || !!skyDrag || !!pinch;
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
        if (mode === 'sky' && !tween) {
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
            sky.vAz = sky.vAlt = 0;
            if (pointers.size === 1) {
                skyDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: now() };
                pinch = null;
            } else if (pointers.size === 2) {
                skyDrag = null;
                const [a, b] = [...pointers.values()];
                pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, fov: sky.fovT };
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
        if (mode !== 'sky' || tween) return;
        if (skyDrag && e.pointerId === skyDrag.id) {
            const dx = e.clientX - skyDrag.x, dy = e.clientY - skyDrag.y;
            const tm = now(), dtm = Math.max(1, tm - skyDrag.t);
            const h = el.clientHeight || rc.size?.h || 800;
            const k = sky.fov / h;                              // degrees per pixel
            const kAz = k / Math.max(Math.cos(sky.alt * DEG), 0.25);
            const dAz = -dx * kAz, dAlt = dy * k;
            sky.az = sky.azT = wrap360(sky.az + dAz);
            sky.alt = sky.altT = clamp(sky.alt + dAlt, SKY_ALT_MIN, SKY_ALT_MAX);
            // Velocity (deg/ms) for inertia, smoothed.
            sky.vAz = 0.6 * sky.vAz + 0.4 * (dAz / dtm);
            sky.vAlt = 0.6 * sky.vAlt + 0.4 * (dAlt / dtm);
            skyDrag.x = e.clientX;
            skyDrag.y = e.clientY;
            skyDrag.t = tm;
            rc.invalidate?.();
        } else if (pinch && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            sky.fov = sky.fovT = clamp(pinch.fov * (pinch.d / d), SKY_FOV_MIN, SKY_FOV_MAX);
            rc.invalidate?.();
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
        if (pointers.size === 1 && mode === 'sky' && !tween) {
            const [id, q] = [...pointers.entries()][0];
            skyDrag = { id, x: q.x, y: q.y, t: now() };
        }
        rc.invalidate?.();
    };

    const onWheel = (e) => {
        emitInteract('wheel');
        cancelTween();
        if (mode === 'sky' && !tween) {
            e.preventDefault();
            const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
            const dy = clamp(e.deltaY * scale / 100, -3, 3);
            sky.fovT = clamp(sky.fovT * Math.exp(0.1 * dy), SKY_FOV_MIN, SKY_FOV_MAX);
            rc.invalidate?.();
        }
    };

    const onContext = (e) => { if (mode === 'sky') e.preventDefault(); };

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
        return !!tween && (tween.kind === 'toSky' || tween.kind === 'toOrbit');
    }

    /** Runs fn now, or after the running globe/sky transition finishes. */
    function afterTransition(fn) {
        if (inTransition()) return tween.promise.then(() => fn());
        return fn();
    }

    function setModeNow(target, { animate = true, look } = {}) {
        if (target === mode) {
            if (target === 'sky' && look && Number.isFinite(look.azDeg) && Number.isFinite(look.altDeg)) {
                return startLook(look.azDeg, look.altDeg, { animate });
            }
            return Promise.resolve(true);
        }
        emitInteract('mode');
        if (target === 'sky') return startToSky({ look, animate });
        return startToOrbit({ animate });
    }

    function flyToDirNow(dirS, { distance, animate = true, durationMs } = {}) {
        if (!dirS || !hasSnap) return Promise.resolve(false);
        _v1.set(dirS[0], dirS[1], dirS[2]);
        if (!(_v1.lengthSq() > 0)) return Promise.resolve(false);
        _v1.normalize();
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

    function flyToLatLonNow(latDeg, lonDeg, { distance = 3.2, animate = true, durationMs } = {}) {
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return Promise.resolve(false);
        const dist = clamp(Number.isFinite(distance) ? distance : 3.2, MIN_DIST, MAX_DIST);
        if (!hasSnap) {
            pendingView = { mode: 'orbit', latDeg: clamp(latDeg, -90, 90), lonDeg: wrap180(lonDeg), distance: dist };
            return Promise.resolve(true);
        }
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
        return startFly(homePosL(new THREE.Vector3()), { earthFixed: true, animate });
    }

    // ---- public API ------------------------------------------------------------------------------------------

    /**
     * Rotates the view: orbit → swings the camera around the globe; sky → turns the look.
     * Positive dx turns right / east, positive dy tilts up.
     * @param {number} dxDeg
     * @param {number} dyDeg
     */
    function nudge(dxDeg, dyDeg) {
        cancelTween();
        if (mode === 'sky') {
            sky.azT = wrap360(sky.azT + dxDeg);
            sky.altT = clamp(sky.altT + dyDeg, SKY_ALT_MIN, SKY_ALT_MAX);
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
        if (!(factor > 0)) return;
        cancelTween();
        if (mode === 'sky') sky.fovT = clamp(sky.fovT * factor, SKY_FOV_MIN, SKY_FOV_MAX);
        else zoomTarget = clamp((zoomTarget ?? camera.position.length()) * factor, MIN_DIST, MAX_DIST);
        rc.invalidate?.();
    }

    return {
        camera,
        get controls() { return controls; },
        /** Logical mode: switches at the start of a transition. */
        get mode() { return mode; },
        get skyBlend() { return skyBlend; },
        get tweening() { return !!tween; },
        get dragging() { return pointers.size > 0; },
        get earthLock() { return earthLock; },
        get reducedMotion() { return reduced; },

        /**
         * Switches between globe and sky view. A call made during a running
         * transition waits for it (a transition is never abandoned halfway).
         * @param {'orbit'|'sky'} next
         * @param {{animate?:boolean, look?:{azDeg:number, altDeg:number}}} [opts]
         * @returns {Promise<boolean>}
         */
        setMode(next, opts = {}) {
            const target = next === 'sky' ? 'sky' : 'orbit';
            if (inTransition() && mode === target && !opts?.look) return tween.promise.then(() => true);
            return afterTransition(() => setModeNow(target, opts));
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

        update,

        /**
         * Current camera view in the URL's CamView shape.
         * @returns {{mode:'orbit', latDeg:number, lonDeg:number, distance:number}|{mode:'sky', azDeg:number, altDeg:number, fovDeg:number}}
         */
        getView() {
            if (mode === 'sky') {
                return { mode: 'sky', azDeg: wrap360(sky.azT), altDeg: sky.altT, fovDeg: sky.fovT };
            }
            toLocal(camera.position, _v1);
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
        },
    };
}
