/**
 * Uniforms of SKYGLOW_CHUNK (js/render/shaders/skyglow.glsl.js) and their per-snapshot update from
 * snap.skyglow (js/astro/skyglow.js computeSkyglow) and the observer's basis. A module spreads one
 * set into each of its materials' uniforms (shared objects, so one update reaches them all) and
 * calls applySkyglow from its apply(snap). Nothing is allocated per call.
 */
import * as THREE from 'three';
import { K_V, LP_BINS } from '../astro/skyglow.js';

/** @returns {Record<string, {value:any}>} */
export function createSkyglowUniforms() {
    return {
        uSgMoon: { value: new THREE.Vector4(0, 1, 0, 0) },
        uSgK: { value: K_V },
        uSgLpZen: { value: 0 },
        uSgLp: { value: new Float32Array(LP_BINS) },
        uSgUp: { value: new THREE.Vector3(0, 1, 0) },
        uSgNorth: { value: new THREE.Vector3(0, 0, -1) },
        uSgEast: { value: new THREE.Vector3(1, 0, 0) },
        uSgDome: { value: 0 },
        uSgDark: { value: 1 },
    };
}

/**
 * @param {Record<string, {value:any}>} u from createSkyglowUniforms
 * @param {import('../core/types.js').Snapshot} snap
 */
export function applySkyglow(u, snap) {
    const sg = snap && snap.skyglow;
    const o = snap && snap.observer;
    if (!sg || !o) return;
    u.uSgMoon.value.set(sg.moonDirS[0], sg.moonDirS[1], sg.moonDirS[2], sg.moonW);
    u.uSgK.value = sg.k;
    u.uSgLpZen.value = sg.lpZenith;
    const lp = u.uSgLp.value;
    for (let k = 0; k < LP_BINS; k++) lp[k] = sg.lpDome[k];
    u.uSgUp.value.set(o.upS[0], o.upS[1], o.upS[2]);
    u.uSgNorth.value.set(o.northS[0], o.northS[1], o.northS[2]);
    u.uSgEast.value.set(o.eastS[0], o.eastS[1], o.eastS[2]);
    u.uSgDome.value = sg.domeGain;
    u.uSgDark.value = sg.darkness;
}
