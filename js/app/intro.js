// First-visit cinematic (SPEC §F.6), about 4.5 s, skippable.
//
//   0.0 s  camera at 9 Earth radii on the night side, direction normalize(−0.7·sun + 0.7·up), so the
//          observer sits near the limb with city lights below and the Sun hidden behind the planet
//   0–4 s  an eased orbital arc over the terminator into daylight (lights → twilight band → glint),
//          dollying in to 3.4 Earth radii straight above the observer
//   2.6 s  the pin drops (ripple)
//   2.9 s  beams launch one by one (120 ms stagger); each body label appears as its beam lands
//   ≈4.6 s done
//
// The flight path is interpolated in Earth-fixed coordinates and mapped through the live Earth
// matrix every frame, so it composes with Earth-lock and with time passing during the intro.
// Any input (the caller aborts `signal`) jumps straight to the final state.
//
// The camera is driven by writing rig.camera.position each frame; OrbitControls re-reads the
// position on its next update. If the rig turns out to own the position (it moved the camera away
// from where the intro put it), the intro hands the remaining flight to rig.flyToLatLon instead.

import { BODIES } from '../astro/bodies.js';

export const INTRO_TIMING = Object.freeze({
    cameraMs: 4000,
    pinMs: 2600,
    beamsMs: 2900,
    staggerMs: 120,
    beamMs: 700,
    startDist: 9,
    endDist: 3.4,
    /** Safety net: the intro never holds the app longer than this. */
    maxMs: 8000,
});

/** Smooth start, long graceful settle: the arc should feel like an orbital approach. */
function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeOutQuart(x) {
    return 1 - Math.pow(1 - x, 4);
}

/** world = M·local for a column-major 4×4 rotation. */
function mulDir(m, x, y, z, out) {
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
}

/** local = Mᵀ·world. */
function mulDirT(m, x, y, z, out) {
    out[0] = m[0] * x + m[1] * y + m[2] * z;
    out[1] = m[4] * x + m[5] * y + m[6] * z;
    out[2] = m[8] * x + m[9] * y + m[10] * z;
    return out;
}

function normalize(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 0) {
        v[0] /= l; v[1] /= l; v[2] /= l;
    }
    return l;
}

/** Spherical interpolation of unit vectors a→b into out. */
function slerp(a, b, u, out) {
    const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const omega = Math.acos(d);
    if (omega < 1e-5) {
        out[0] = a[0] + (b[0] - a[0]) * u;
        out[1] = a[1] + (b[1] - a[1]) * u;
        out[2] = a[2] + (b[2] - a[2]) * u;
    } else {
        const s = Math.sin(omega);
        const ka = Math.sin((1 - u) * omega) / s, kb = Math.sin(u * omega) / s;
        out[0] = ka * a[0] + kb * b[0];
        out[1] = ka * a[1] + kb * b[1];
        out[2] = ka * a[2] + kb * b[2];
    }
    normalize(out);
    return omega;
}

/**
 * Start direction (scene frame) per SPEC F.6, with a fallback when the observer is near the
 * subsolar point and −sun + up degenerates.
 * @param {import('../core/types.js').Snapshot} snap
 * @returns {Float64Array}
 */
export function introStartDir(snap) {
    const s = snap.sunDirS, o = snap.observer;
    const v = new Float64Array(3);
    for (let i = 0; i < 3; i++) v[i] = -0.7 * s[i] + 0.7 * o.upS[i];
    if (Math.hypot(v[0], v[1], v[2]) < 0.35) {
        // Local noon: approach from the night side over the pole-ward horizon instead.
        const side = o.latDeg >= 0 ? 1 : -1;
        for (let i = 0; i < 3; i++) v[i] = -0.7 * s[i] + 0.7 * side * o.northS[i];
    }
    normalize(v);
    return v;
}

/**
 * Plays the intro. Resolves 'done', 'skipped' (aborted by input) or 'unavailable' (reduced motion,
 * no rig). Never rejects.
 *
 * @param {{rig:any, beams?:any, pin?:any, snap:import('../core/types.js').Snapshot, reducedMotion?:boolean,
 *          signal?:AbortSignal, labelsFeed?:any, now?:()=>number,
 *          raf?:(cb:(t:number)=>void)=>number, caf?:(h:number)=>void}} opts
 * @returns {Promise<'done'|'skipped'|'unavailable'>}
 */
export function playIntro({ rig, beams = null, pin = null, snap, reducedMotion = false, signal, labelsFeed = null,
    now = () => performance.now(), raf = (cb) => requestAnimationFrame(cb), caf = (h) => cancelAnimationFrame(h) }) {
    if (reducedMotion || !rig?.camera || !snap) return Promise.resolve('unavailable');
    if (signal?.aborted) return Promise.resolve('skipped');
    const T = INTRO_TIMING;
    const cam = rig.camera;

    // Earth-fixed endpoints.
    const em = snap.earthMatrix;
    const startW = introStartDir(snap);
    const a = mulDirT(em, startW[0], startW[1], startW[2], new Float64Array(3));
    const up = snap.observer.upS;
    const b = mulDirT(em, up[0], up[1], up[2], new Float64Array(3));
    normalize(a);
    normalize(b);
    const arc = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    const dirL = new Float64Array(3);
    const dirW = new Float64Array(3);
    const lastSet = new Float64Array(3);     // last written position, world frame
    const lastSetL = new Float64Array(3);    // same, Earth-fixed frame
    const probeL = new Float64Array(3);
    const endLat = snap.observer.latDeg, endLon = snap.observer.lonDeg;

    labelsFeed?.beginIntro?.();
    // The pin waits above for its drop at 2.6 s; beams stay hidden until their launch at 2.9 s
    // (and their labels wait for each beam to land).
    try {
        pin?.prime?.();
        beams?.prime?.();
    } catch { /* cosmetic */ }

    return new Promise((resolve) => {
        const t0 = now();
        let handle = 0;
        let finished = false;
        let pinDropped = false;
        let launched = false;
        let beamsDone = !beams;
        let cameraDone = false;
        let handedOver = false;
        let wrote = false;
        let revealIdx = 0;
        const revealAt = BODIES.map((_, i) => T.beamsMs + i * T.staggerMs + T.beamMs);

        function placeCamera(u) {
            const e = easeInOutCubic(u);
            slerp(a, b, e, dirL);
            mulDir(snap.earthMatrix, dirL[0], dirL[1], dirL[2], dirW);
            // Log-distance dolly, front-loaded, with a gentle orbital lift mid-flight.
            const k = easeOutQuart(u);
            const dist = Math.exp(Math.log(T.startDist) + (Math.log(T.endDist) - Math.log(T.startDist)) * k)
                * (1 + 0.18 * Math.sin(Math.PI * e) * (arc / Math.PI));
            cam.position.set(dirW[0] * dist, dirW[1] * dist, dirW[2] * dist);
            lastSet[0] = cam.position.x;
            lastSet[1] = cam.position.y;
            lastSet[2] = cam.position.z;
            lastSetL[0] = dirL[0] * dist;
            lastSetL[1] = dirL[1] * dist;
            lastSetL[2] = dirL[2] * dist;
            wrote = true;
        }

        /**
         * True when something other than the intro moved the camera since the last write. Earth-lock
         * keeps the camera fixed in the Earth frame and an unlocked camera stays fixed in the world
         * frame, so only a move in BOTH frames means the rig is steering.
         */
        function cameraTakenOver() {
            if (!wrote) return false;
            const p = cam.position;
            const dx = p.x - lastSet[0], dy = p.y - lastSet[1], dz = p.z - lastSet[2];
            if (dx * dx + dy * dy + dz * dz <= 0.05 * 0.05) return false;
            mulDirT(snap.earthMatrix, p.x, p.y, p.z, probeL);
            const lx = probeL[0] - lastSetL[0], ly = probeL[1] - lastSetL[1], lz = probeL[2] - lastSetL[2];
            return lx * lx + ly * ly + lz * lz > 0.05 * 0.05;
        }

        function dropPin() {
            if (pinDropped) return;
            pinDropped = true;
            labelsFeed?.revealObserver?.();
            try {
                const p = pin?.drop?.();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch { /* cosmetic */ }
        }

        function launch(staggerMs) {
            if (launched) return;
            launched = true;
            try {
                const p = beams?.launch?.({ staggerMs });
                if (p && typeof p.then === 'function') {
                    p.then(() => { beamsDone = true; }, () => { beamsDone = true; });
                } else {
                    beamsDone = true;
                }
            } catch {
                beamsDone = true;
            }
        }

        function finish(result) {
            if (finished) return;
            finished = true;
            if (handle) caf(handle);
            handle = 0;
            signal?.removeEventListener?.('abort', onAbort);
            labelsFeed?.endIntro?.();
            resolve(result);
        }

        function onAbort() {
            if (finished) return;
            // Final state at once: camera above the observer, pin down, beams out, labels on.
            if (!handedOver) placeCamera(1);
            dropPin();
            if (typeof beams?.skipLaunch === 'function') {
                try {
                    beams.skipLaunch();
                } catch { /* cosmetic */ }
                launched = true;
                beamsDone = true;
            } else {
                launch(0);
            }
            finish('skipped');
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });

        /** Hands the rest of the flight to the rig (it turned out to own the camera position). */
        function handOver(elapsed) {
            handedOver = true;
            try {
                const p = rig.flyToLatLon?.(endLat, endLon, {
                    distance: T.endDist, durationMs: Math.max(600, T.cameraMs - elapsed), animate: true,
                });
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch { /* keep going without camera motion */ }
        }

        function stepCamera(elapsed) {
            if (cameraDone) return;
            if (!handedOver && cameraTakenOver()) handOver(elapsed);
            if (handedOver) {
                cameraDone = elapsed >= T.cameraMs;
                return;
            }
            const u = Math.min(1, elapsed / T.cameraMs);
            placeCamera(u);
            cameraDone = u >= 1;
        }

        function stepChoreography(elapsed) {
            if (elapsed >= T.pinMs) dropPin();
            if (elapsed >= T.beamsMs) launch(T.staggerMs);
            while (revealIdx < BODIES.length && elapsed >= revealAt[revealIdx]) {
                labelsFeed?.revealBody?.(BODIES[revealIdx].id);
                revealIdx++;
            }
        }

        function step() {
            handle = 0;
            if (finished) return;
            const elapsed = now() - t0;
            stepCamera(elapsed);
            stepChoreography(elapsed);
            const complete = cameraDone && beamsDone && revealIdx >= BODIES.length;
            if (complete || elapsed >= T.maxMs) {
                finish('done');
                return;
            }
            handle = raf(step);
        }

        if (rig.mode && rig.mode !== 'orbit') {
            try {
                const p = rig.setMode?.('orbit', { animate: false });
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch { /* stay where we are */ }
        }
        placeCamera(0);
        handle = raf(step);
    });
}
