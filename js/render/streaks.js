/**
 * Fast-time star streaks (ROADMAP fast-time-star-streaks): at fast clock rates the sky turns
 * degrees per frame and stars strobe (the wagon-wheel effect). This module measures the camera's
 * turn since the previous rendered frame and publishes it as one set of shared uniforms, which the
 * star field (sky.js, STAR_VERT) and the planet glyphs (bodies.js, GLYPH_VERT) use to smear each
 * point along its own apparent motion over a "shutter" (½ a frame; a whole frame while a long
 * exposure stacks, so trails join up), conserving (softened) light. Past the tier's cap a streak
 * stops growing and dims instead, so 1 day/s and faster fade the strobing sky. Constellation
 * figures and the Milky Way dim by `streakState.dim` (core/sampling.js strobeDim).
 *
 *   createStreaks(rc, {store}) → RenderModule
 *
 * Only directions at infinity move with the camera's rotation, so its world quaternion is enough:
 * the shutter's opening is slerp(now, previous, shutter), uploaded as a world → view mat3. Off on
 * the low tier (`streakPx` 0), under reduced motion, below 10 min/s (a drag at Live stays crisp),
 * after a frame gap (render on demand: the previous pose is stale) and across cuts (> 34° a frame).
 * Captures (dt 0) are never streaked.
 *
 * A render module for its per-frame hook only (an empty group); main.js adds it before the sky.
 * @module render/streaks
 */
import * as THREE from 'three';
import { streakShutter, strobeDim, STREAK_CUT_RAD } from '../core/sampling.js';

/**
 * Shared uniform objects (three uploads them per material; one renderer per page). Spread into a
 * material's uniforms with STREAK_VERT_CHUNK (shaders/sky.glsl.js) in its vertex shader.
 */
export const STREAK_UNIFORMS = Object.freeze({
    /** World → view rotation when the shutter opened. */
    uStreakView: { value: new THREE.Matrix3() },
    /** Longest streak (device px); 0 = off. */
    uStreakMax: { value: 0 },
    /** Largest point sprite the GPU draws (device px). */
    uStreakPoint: { value: 256 },
    /** Drawing-buffer size (device px). */
    uStreakRes: { value: new THREE.Vector2(1, 1) },
});

/** Line art and the Milky Way are multiplied by `dim` (1 = steady sky). */
export const streakState = { dim: 1, px: 0 };

/**
 * @param {any} rc render context
 * @param {{store?:any, reducedMotion?:boolean}} [deps]
 */
export function createStreaks(rc, { store = null, reducedMotion = false } = {}) {
    const group = new THREE.Group();
    group.name = 'streaks';
    const qPrev = new THREE.Quaternion();
    const qCur = new THREE.Quaternion();
    const qOpen = new THREE.Quaternion();
    const m4 = new THREE.Matrix4();
    const buf = new THREE.Vector2();
    let hasPrev = false;
    let capPx = 0;
    let rm = !!reducedMotion;
    try {
        const gl = rc.renderer.getContext();
        const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
        if (range && range[1] > 0) STREAK_UNIFORMS.uStreakPoint.value = range[1];
    } catch { /* keep 256 */ }

    function off() {
        STREAK_UNIFORMS.uStreakMax.value = 0;
        streakState.dim = 1;
        streakState.px = 0;
    }

    function update(fi) {
        const cam = fi?.camera;
        if (!cam || typeof cam.getWorldQuaternion !== 'function') {
            off();
            hasPrev = false;
            return;
        }
        cam.getWorldQuaternion(qCur);
        const st = store?.get?.();
        const shutter = streakShutter({
            simRate: fi.simRate, dtMs: fi.dtMs, capPx,
            reducedMotion: rm || !!st?.status?.reducedMotion, exposing: !!st?.ui?.expose,
        });
        const angle = hasPrev ? qPrev.angleTo(qCur) : 0;
        if (!hasPrev || shutter <= 0 || !(angle <= STREAK_CUT_RAD)) {
            off();
        } else {
            qOpen.copy(qCur).slerp(qPrev, shutter).invert();
            m4.makeRotationFromQuaternion(qOpen);
            STREAK_UNIFORMS.uStreakView.value.setFromMatrix4(m4);
            rc.renderer.getDrawingBufferSize(buf);
            STREAK_UNIFORMS.uStreakRes.value.copy(buf);
            STREAK_UNIFORMS.uStreakMax.value = capPx;
            // The sky's own jump per frame at the centre of the view (device px).
            const px = angle * Math.abs(cam.projectionMatrix.elements[5]) * buf.y / 2;
            streakState.px = px;
            streakState.dim = strobeDim(px);
        }
        qPrev.copy(qCur);
        hasPrev = true;
    }

    return {
        object3d: group,
        update,
        setQuality(cfg) {
            capPx = cfg && cfg.streakPx > 0 ? cfg.streakPx : 0;
            if (!capPx) off();
        },
        setReducedMotion(on) { rm = !!on; },
        dispose() {
            off();
        },
    };
}
