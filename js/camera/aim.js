/**
 * 'Point at the sky' (ROADMAP ar-sky-pointing, part 2): on a phone in sky view the look follows the
 * phone. Loaded on demand by main.js; the caller asks for iOS's motion permission inside the tap.
 *
 * Sensors. Android Chrome: 'deviceorientationabsolute' (alpha from magnetic north). iOS Safari:
 * 'deviceorientation' with `webkitCompassHeading`; its alpha is relative, so a heading correction is
 * learned (circularly smoothed) while the phone is within 40° of upright, where the compass heading
 * is the camera's. Anything else: relative alpha, and the user is asked to Align.
 *
 * Maths (pure, exported): the W3C rotation R = Rz(α)·Rx(β)·Ry(γ) takes device axes to east-north-up.
 * The rear camera looks along the device's −z (`fwd`, independent of screen rotation); the screen's up
 * is the device axis given by `screen.orientation.angle` (`up`). Both are low-passed as vectors in
 * ENU (an adaptive exponential filter, heavier while the phone is still), never as angles, so there
 * is no 359°↔0° glitch. The look keeps the horizon level (roll is ignored): altitude from the
 * forward vector; azimuth from its horizontal part, handing over to the screen's down direction near
 * the zenith, where the forward's own azimuth is ill-conditioned. 'Align' adds a user azimuth
 * offset (magnetic declination, a phone case, a car roof): centre a bright body and tap.
 *
 * Phone compasses are good to 5–15°: the UI says 'approximate'. The look goes to rig.setSkyAim only
 * when it moved by more than a fraction of a pixel, so a phone on a table stops drawing frames.
 * Aiming stops after 2 minutes without movement, when the page is hidden, or when asked (leaving
 * sky view is the caller's); a screen wake lock is held while it runs.
 *
 *   createAim({win, nav, rig, offsetDeg, onStop, now}) → { start() → Promise<'ok'|'nodata'|'unsupported'>,
 *     stop(reason), align(azDeg) → number, look, source, active, offsetDeg }
 *
 * @module camera/aim
 */

const DEG = Math.PI / 180;
/** Filter time constants (ms): still and moving, blended by how far the phone turned. */
export const AIM_TAU_STILL_MS = 320;
export const AIM_TAU_MOVING_MS = 45;
/** Idle auto-stop. */
export const AIM_IDLE_MS = 120000;
/** Movement that counts as activity (degrees). */
const IDLE_MOVE_DEG = 3;
/** No usable sensor event within this time: give up. */
const FIRST_EVENT_MS = 3000;
/** iOS: learn the compass correction only while the forward is within this of the horizon. */
const UPRIGHT_SIN = Math.sin(40 * DEG);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => wrap360(d + 180) - 180;
function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 1e-12) { v[0] /= l; v[1] /= l; v[2] /= l; }
    return v;
}

/**
 * The rear camera's direction and the screen's up for a device orientation, in ENU (x east,
 * y north, z up): R = Rz(α)·Rx(β)·Ry(γ) (W3C DeviceOrientation), fwd = −R·ẑ, up = R·(sin θ, cos θ, 0)
 * for a screen rotated by θ = screen.orientation.angle.
 * @param {number} alphaDeg
 * @param {number} betaDeg
 * @param {number} gammaDeg
 * @param {number} screenDeg 0, 90, 180 or 270
 * @param {Float64Array} fwd out
 * @param {Float64Array} up out
 */
export function deviceVectors(alphaDeg, betaDeg, gammaDeg, screenDeg, fwd, up) {
    const a = alphaDeg * DEG, b = betaDeg * DEG, g = gammaDeg * DEG, t = (screenDeg || 0) * DEG;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    // Columns of R: device x, y and z in ENU.
    const x0 = cA * cG - sA * sB * sG, x1 = sA * cG + cA * sB * sG, x2 = -cB * sG;
    const y0 = -sA * cB, y1 = cA * cB, y2 = sB;
    const z0 = cA * sG + sA * sB * cG, z1 = sA * sG - cA * sB * cG, z2 = cB * cG;
    fwd[0] = -z0; fwd[1] = -z1; fwd[2] = -z2;
    const st = Math.sin(t), ct = Math.cos(t);
    up[0] = st * x0 + ct * y0; up[1] = st * x1 + ct * y1; up[2] = st * x2 + ct * y2;
}

/**
 * Rotates an ENU vector about the vertical so its azimuth grows by dDeg (in place).
 * @param {Float64Array} v
 * @param {number} dDeg
 * @returns {Float64Array} v
 */
export function turnAzimuth(v, dDeg) {
    if (!dDeg) return v;
    const c = Math.cos(dDeg * DEG), s = Math.sin(dDeg * DEG);
    const x = v[0], y = v[1];
    v[0] = x * c + y * s;
    v[1] = y * c - x * s;
    return v;
}

/**
 * The level look for a forward and screen-up pair (ENU): altitude from the forward; azimuth from
 * its horizontal part, blended toward the screen's down direction (up when looking down) as the
 * forward nears the zenith, where its own azimuth is ill-conditioned. Keeps out.azDeg when no
 * heading can be found.
 * @param {ArrayLike<number>} fwd unit
 * @param {ArrayLike<number>} up unit
 * @param {{azDeg:number, altDeg:number}} out
 * @returns {{azDeg:number, altDeg:number}} out
 */
export function lookOf(fwd, up, out) {
    const fz = clamp(fwd[2], -1, 1);
    out.altDeg = Math.asin(fz) / DEG;
    const w = smoothstep(0.8, 0.97, Math.abs(fz));
    const s = fz >= 0 ? 1 : -1;
    const hx = fwd[0] * (1 - w) - s * up[0] * w, hy = fwd[1] * (1 - w) - s * up[1] * w;
    if (Math.hypot(hx, hy) > 1e-9) out.azDeg = wrap360(Math.atan2(hx, hy) / DEG);
    return out;
}

/**
 * The filter state: smoothed forward and up (ENU), and whether it has a value yet.
 * @returns {{f:Float64Array, u:Float64Array, has:boolean}}
 */
export function createAimFilter() {
    return { f: new Float64Array(3), u: new Float64Array(3), has: false };
}

/**
 * One step of the adaptive low-pass on the vectors (never on angles): the time constant runs from
 * AIM_TAU_STILL_MS (turned < 0.4°) to AIM_TAU_MOVING_MS (turned > 5°) with how far the raw forward
 * is from the smoothed one. The up vector is kept square to the forward.
 * @param {{f:Float64Array, u:Float64Array, has:boolean}} st
 * @param {ArrayLike<number>} rawF unit
 * @param {ArrayLike<number>} rawU unit
 * @param {number} dtMs
 * @returns {number} the blend factor used (1 on the first step)
 */
export function aimFilterStep(st, rawF, rawU, dtMs) {
    if (!st.has) {
        for (let i = 0; i < 3; i++) { st.f[i] = rawF[i]; st.u[i] = rawU[i]; }
        st.has = true;
        return 1;
    }
    const d = clamp(st.f[0] * rawF[0] + st.f[1] * rawF[1] + st.f[2] * rawF[2], -1, 1);
    const turned = Math.acos(d) / DEG;
    const m = smoothstep(0.4, 5, turned);
    const tau = AIM_TAU_STILL_MS + (AIM_TAU_MOVING_MS - AIM_TAU_STILL_MS) * m;
    const k = 1 - Math.exp(-Math.max(0, Math.min(dtMs, 200)) / tau);
    for (let i = 0; i < 3; i++) {
        st.f[i] += (rawF[i] - st.f[i]) * k;
        st.u[i] += (rawU[i] - st.u[i]) * k;
    }
    normalize(st.f);
    const fu = st.f[0] * st.u[0] + st.f[1] * st.u[1] + st.f[2] * st.u[2];
    for (let i = 0; i < 3; i++) st.u[i] -= st.f[i] * fu;
    normalize(st.u);
    return k;
}

/**
 * Creates the controller.
 * @param {{win?:any, nav?:any, rig:any, offsetDeg?:number, onStop?:(reason:string)=>void, now?:()=>number}} deps
 *   rig: setAiming(on), setSkyAim(azDeg, altDeg), camera.fov
 * @returns {object}
 */
export function createAim(deps) {
    const win = deps.win ?? (typeof window !== 'undefined' ? window : null);
    const nav = deps.nav ?? (typeof navigator !== 'undefined' ? navigator : null);
    const rig = deps.rig;
    const now = deps.now ?? (() => performance.now());
    let offsetDeg = Number.isFinite(deps.offsetDeg) ? wrap180(deps.offsetDeg) : 0;

    const rawF = new Float64Array(3), rawU = new Float64Array(3);
    const idleRef = new Float64Array(3);
    const filt = createAimFilter();
    const look = { azDeg: 0, altDeg: 0 };
    const sent = { azDeg: NaN, altDeg: NaN };
    let active = false;
    let source = 'none';
    let eventName = '';
    let lastT = 0;
    let idleT = 0;
    let idleTimer = 0;
    let firstTimer = 0;
    let lock = null;
    let resolveFirst = null;
    // iOS: correction from the relative alpha to the compass, as a smoothed unit vector (cos, sin).
    let corrC = 0, corrS = 0, corrN = 0;

    function screenAngle() {
        const a = win?.screen?.orientation?.angle ?? win?.orientation ?? 0;
        return Number.isFinite(a) ? a : 0;
    }

    function onOrientation(e) {
        if (!active) return;
        const alpha = e.alpha, beta = e.beta, gamma = e.gamma;
        if (alpha == null || beta == null || gamma == null || !Number.isFinite(alpha + beta + gamma)) return;
        const compass = Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : null;
        if (source === 'none') source = eventName === 'deviceorientationabsolute' || e.absolute === true ? 'compass' : compass !== null ? 'ios' : 'relative';
        deviceVectors(alpha, beta, gamma, screenAngle(), rawF, rawU);
        let turn = offsetDeg;
        if (source === 'ios' && compass !== null) {
            // The compass heading is the camera's while the phone is near upright: learn the
            // correction there, keep it while aiming high (the first guess: alpha's own frame).
            const hRel = Math.atan2(rawF[0], rawF[1]) / DEG;
            const corr = Math.abs(rawF[2]) < UPRIGHT_SIN ? compass - hRel : corrN ? NaN : compass + alpha;
            if (Number.isFinite(corr)) {
                const k = corrN < 10 ? 1 / (corrN + 1) : 0.05;
                corrC += (Math.cos(corr * DEG) - corrC) * k;
                corrS += (Math.sin(corr * DEG) - corrS) * k;
                corrN++;
            }
            if (corrN) turn += Math.atan2(corrS, corrC) / DEG;
        }
        turnAzimuth(rawF, turn);
        turnAzimuth(rawU, turn);
        const t = now();
        const dt = lastT ? t - lastT : 16;
        lastT = t;
        aimFilterStep(filt, rawF, rawU, dt);
        lookOf(filt.f, filt.u, look);
        // Activity: the phone turned by more than IDLE_MOVE_DEG since the last reference.
        if (idleRef[0] * rawF[0] + idleRef[1] * rawF[1] + idleRef[2] * rawF[2] < Math.cos(IDLE_MOVE_DEG * DEG)) {
            idleRef.set(rawF);
            idleT = t;
        }
        if (resolveFirst) {
            const r = resolveFirst;
            resolveFirst = null;
            clearTimeout(firstTimer);
            r('ok');
        }
        // Only a change of a fraction of a pixel goes to the rig (a still phone draws nothing).
        const fov = Number.isFinite(rig?.camera?.fov) ? rig.camera.fov : 60;
        const eps = fov / 1600;
        const dAz = Math.abs(wrap180(look.azDeg - sent.azDeg)) * Math.cos(look.altDeg * DEG);
        if (!(dAz < eps) || !(Math.abs(look.altDeg - sent.altDeg) < eps)) {
            sent.azDeg = look.azDeg;
            sent.altDeg = look.altDeg;
            try { rig.setSkyAim?.(look.azDeg, look.altDeg); } catch (err) { console.error('[aim] setSkyAim failed', err); }
        }
    }

    const onVisibility = () => { if (win?.document?.visibilityState === 'hidden') stop('hidden'); };

    function requestLock() {
        try {
            const p = nav?.wakeLock?.request?.('screen');
            if (p && typeof p.then === 'function') {
                p.then((l) => {
                    if (!active) { l.release?.().catch?.(() => {}); return; }
                    lock = l;
                }, () => { lock = null; });
            }
        } catch { lock = null; }
    }

    /**
     * Starts listening. Resolves 'ok' on the first usable reading, 'nodata' when none arrives
     * within 3 s (no sensor: aiming stops), 'unsupported' without the API.
     * @returns {Promise<'ok'|'nodata'|'unsupported'>}
     */
    function start() {
        if (active) return Promise.resolve('ok');
        if (!win || typeof win.addEventListener !== 'function' || !('DeviceOrientationEvent' in win)) return Promise.resolve('unsupported');
        active = true;
        source = 'none';
        filt.has = false;
        corrC = corrS = 0;
        corrN = 0;
        lastT = 0;
        sent.azDeg = sent.altDeg = NaN;
        idleRef.fill(0);
        idleT = now();
        eventName = 'ondeviceorientationabsolute' in win ? 'deviceorientationabsolute' : 'deviceorientation';
        win.addEventListener(eventName, onOrientation);
        win.document?.addEventListener?.('visibilitychange', onVisibility);
        try { rig.setAiming?.(true); } catch (err) { console.error('[aim] setAiming failed', err); }
        requestLock();
        idleTimer = setInterval(() => { if (active && now() - idleT > AIM_IDLE_MS) stop('idle'); }, 5000);
        idleTimer?.unref?.();   // Node (tests): never keeps the process alive
        return new Promise((resolve) => {
            resolveFirst = resolve;
            firstTimer = setTimeout(() => {
                if (!resolveFirst) return;
                resolveFirst = null;
                stop('nodata');
                resolve('nodata');
            }, FIRST_EVENT_MS);
            firstTimer?.unref?.();
        });
    }

    /**
     * Stops aiming (idempotent): listeners off, wake lock released, the rig's look free again.
     * @param {string} [reason] 'user' | 'idle' | 'hidden' | 'view' | 'nodata' | …, passed to onStop
     */
    function stop(reason = 'user') {
        if (!active) return;
        active = false;
        win?.removeEventListener?.(eventName, onOrientation);
        win?.document?.removeEventListener?.('visibilitychange', onVisibility);
        clearInterval(idleTimer);
        clearTimeout(firstTimer);
        if (resolveFirst) { const r = resolveFirst; resolveFirst = null; r('nodata'); }
        try { lock?.release?.()?.catch?.(() => {}); } catch { /* already released */ }
        lock = null;
        try { rig.setAiming?.(false); } catch { /* the rig keeps its look */ }
        try { deps.onStop?.(reason); } catch (err) { console.error('[aim] onStop failed', err); }
    }

    return {
        start,
        stop,
        /**
         * 'Align': turns the aim so its centre sits at azimuth azDeg (a body the user has centred
         * in the real sky). Returns the new offset in degrees (−180…180).
         * @param {number} azDeg
         * @returns {number}
         */
        align(azDeg) {
            if (!Number.isFinite(azDeg) || !filt.has) return offsetDeg;
            offsetDeg = wrap180(offsetDeg + wrap180(azDeg - look.azDeg));
            return offsetDeg;
        },
        /** The current (filtered, offset) look. */
        get look() { return look; },
        /** 'compass' (absolute events) | 'ios' (webkitCompassHeading) | 'relative' | 'none' (no reading yet). */
        get source() { return source; },
        get active() { return active; },
        get offsetDeg() { return offsetDeg; },
        set offsetDeg(v) { if (Number.isFinite(v)) offsetDeg = wrap180(v); },
    };
}
