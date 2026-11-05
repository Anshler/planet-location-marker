/**
 * Comets at infinity (astro/comets.js): each comet's coma and its two tails, drawn from the
 * comet's ExtraState (snap.extras, astro/extras.js). A render module.
 *
 * - The ion tail is a straight, narrow, bluish strip along the anti-Sun direction; the dust tail a
 *   wider, yellow-white fan that curves behind the motion. Both are billboards at infinity through
 *   the tail samples (directions from the observer, so foreshortening is the geometry's), with a
 *   gaussian cross-section, a glow that fades along the tail, and a floor of 1.5 px width.
 * - The coma is a soft point sized by its true angular size (≈ 120,000 km), never under 5 px.
 * - Brightness follows the comet's magnitude and the sky: the coma like a planet (exposure.planets),
 *   the tails like the faint sky (exposure.stars). Illustrative in length and glow (ASTRONOMY.md).
 *
 * Buffers are allocated once (R5) for up to MAX comets and refilled in apply(). Both hide through
 * their materials and stay in the scene graph: three uploads a geometry the first time it projects
 * the object, so one hidden until a comet's apparition came round in a time-lapse would upload then.
 *
 * @module render/comets
 */
import * as THREE from 'three';
import { INFINITY_VERT_CHUNK } from './shaders/sky.glsl.js';
import { TAIL_SAMPLES } from '../astro/comets.js';

const MAX = 2;
const K = TAIL_SAMPLES;
/** Vertices per comet: two tails × K samples × 2 sides. */
const VPC = 2 * K * 2;

const TAIL_VERT = /* glsl */ `
uniform float uMinW;      // radians: 1.5 px at the current zoom
attribute vec3 aPerp;
attribute float aW;
attribute vec3 aInfo;     // x: along (0 head … 1 tip), y: side (−1, +1), z: kind (0 ion, 1 dust)
attribute float aGain;
varying vec3 vInfo;
varying float vGain;
${INFINITY_VERT_CHUNK}
void main() {
    vInfo = aInfo;
    vGain = aGain;
    vec3 d = normalize(position + aPerp * (aInfo.y * max(aW, uMinW)));
    gl_Position = aGain > 0.0 ? infinityClip(d) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const TAIL_FRAG = /* glsl */ `
uniform float uExp;
varying vec3 vInfo;
varying float vGain;
void main() {
    float s = clamp(vInfo.x, 0.0, 1.0);
    float x = vInfo.y;
    float dust = step(0.5, vInfo.z);
    // Gaussian across, reaching zero at the strip's edge; a glow that fades out before the tip.
    float across = exp(-x * x * mix(3.0, 2.2, dust)) * (1.0 - x * x);
    float along = mix(exp(-2.2 * s), exp(-3.0 * s), dust) * smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.6, 1.0, s));
    vec3 col = mix(vec3(0.62, 0.78, 1.0), vec3(1.0, 0.93, 0.8), dust);
    float a = across * along * vGain * uExp * mix(0.9, 1.15, dust);
    gl_FragColor = vec4(col * a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const COMA_VERT = /* glsl */ `
uniform float uPxPerRad;
uniform float uPx;
attribute float aRad;
attribute float aGain;
varying float vGain;
${INFINITY_VERT_CHUNK}
void main() {
    vGain = aGain;
    gl_PointSize = clamp(aRad * uPxPerRad * 2.0, 5.0 * uPx, 160.0 * uPx) * 2.2;
    gl_Position = aGain > 0.0 ? infinityClip(normalize(position)) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const COMA_FRAG = /* glsl */ `
uniform float uExp;
varying float vGain;
void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    // A bright false nucleus in a soft coma.
    float c = exp(-r2 * 9.0) * 0.8 + exp(-r2 * 40.0) * 1.6;
    vec3 col = mix(vec3(0.75, 0.95, 0.85), vec3(1.0), 0.5);
    gl_FragColor = vec4(col * (c * vGain * uExp), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/**
 * Creates the comets module.
 * @param {object} rc RenderContext
 * @param {{extras:any}} deps the extras registry
 * @returns {object} RenderModule
 */
export function createComets(rc, { extras } = {}) {
    const group = new THREE.Group();
    group.name = 'comets';
    const upS = new THREE.Vector3(0, 1, 0);
    const refr = { uRefrUp: { value: upS }, uRefrK: { value: 0 } };

    // --- tails ---
    const n = MAX * VPC;
    const pos = new Float32Array(n * 3), perp = new Float32Array(n * 3), w = new Float32Array(n), info = new Float32Array(n * 3);
    const gain = new Float32Array(n);
    const idx = [];
    for (let c = 0; c < MAX; c++) {
        for (let t = 0; t < 2; t++) {
            const base = c * VPC + t * K * 2;
            for (let k = 0; k < K; k++) {
                const v = base + k * 2;
                info[v * 3] = k / (K - 1); info[v * 3 + 1] = -1; info[v * 3 + 2] = t;
                info[(v + 1) * 3] = k / (K - 1); info[(v + 1) * 3 + 1] = 1; info[(v + 1) * 3 + 2] = t;
                if (k < K - 1) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
            }
        }
    }
    const tg = new THREE.BufferGeometry();
    const posA = new THREE.BufferAttribute(pos, 3), perpA = new THREE.BufferAttribute(perp, 3);
    const wA = new THREE.BufferAttribute(w, 1), gainA = new THREE.BufferAttribute(gain, 1);
    tg.setAttribute('position', posA);
    tg.setAttribute('aPerp', perpA);
    tg.setAttribute('aW', wA);
    tg.setAttribute('aInfo', new THREE.BufferAttribute(info, 3));
    tg.setAttribute('aGain', gainA);
    tg.setIndex(idx);
    const tailU = { uMinW: { value: 1e-4 }, uExp: { value: 1 }, ...refr };
    const tailMat = new THREE.ShaderMaterial({
        name: 'comets.tails', uniforms: tailU, vertexShader: TAIL_VERT, fragmentShader: TAIL_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const tails = new THREE.Mesh(tg, tailMat);
    tails.name = 'comets.tails';
    tails.frustumCulled = false;
    tails.matrixAutoUpdate = false;
    tails.renderOrder = -60;
    group.add(tails);

    // --- comae ---
    const cPos = new Float32Array(MAX * 3), cRad = new Float32Array(MAX), cGain = new Float32Array(MAX);
    const cg = new THREE.BufferGeometry();
    const cPosA = new THREE.BufferAttribute(cPos, 3), cRadA = new THREE.BufferAttribute(cRad, 1), cGainA = new THREE.BufferAttribute(cGain, 1);
    cg.setAttribute('position', cPosA);
    cg.setAttribute('aRad', cRadA);
    cg.setAttribute('aGain', cGainA);
    const comaU = { uPxPerRad: { value: 1000 }, uPx: { value: 1 }, uExp: { value: 1 }, uRefrUp: refr.uRefrUp, uRefrK: refr.uRefrK };
    const comaMat = new THREE.ShaderMaterial({
        name: 'comets.coma', uniforms: comaU, vertexShader: COMA_VERT, fragmentShader: COMA_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const comae = new THREE.Points(cg, comaMat);
    comae.name = 'comets.coma';
    comae.frustumCulled = false;
    comae.matrixAutoUpdate = false;
    comae.renderOrder = -59;
    group.add(comae);

    let slots = [];
    let builtVersion = -1;
    const rebuild = () => {
        builtVersion = extras ? extras.version : 0;
        slots = extras ? extras.ids('comet') : [];
    };
    rebuild();
    const off = extras?.onChange?.(rebuild) ?? null;
    let any = false;
    let skyBlend = 0;
    const tmp = new Float64Array(3);

    /** The perpendicular at sample k of a tail (unit, in the sky plane at that sample). */
    function perpAt(arr, k, out) {
        const a = Math.max(0, k - 1), b = Math.min(K - 1, k + 1);
        const tx = arr[b * 3] - arr[a * 3], ty = arr[b * 3 + 1] - arr[a * 3 + 1], tz = arr[b * 3 + 2] - arr[a * 3 + 2];
        const dx = arr[k * 3], dy = arr[k * 3 + 1], dz = arr[k * 3 + 2];
        let px = dy * tz - dz * ty, py = dz * tx - dx * tz, pz = dx * ty - dy * tx;
        const l = Math.hypot(px, py, pz);
        if (l < 1e-12) {
            // A tail seen end-on: any perpendicular will do.
            px = -dy; py = dx; pz = 0;
            const l2 = Math.hypot(px, py, pz) || 1;
            out[0] = px / l2; out[1] = py / l2; out[2] = pz / l2;
            return;
        }
        out[0] = px / l; out[1] = py / l; out[2] = pz / l;
    }

    function apply(snap) {
        if (!snap) return;
        if (extras && builtVersion !== extras.version) rebuild();
        const up = snap.observer?.upS;
        if (up) upS.set(up[0], up[1], up[2]);
        any = false;
        gain.fill(0);
        cGain.fill(0);
        for (let c = 0; c < MAX; c++) {
            const st = c < slots.length ? extras.state(snap, slots[c]) : null;
            if (!st || !st.present || !st.data) continue;
            const D = st.data;
            const mag = Number.isFinite(st.mag) ? st.mag : 9;
            // Flux against a mag-1 comet, compressed so a faint one still reads as a smudge.
            const F = Math.min(4, Math.pow(10, -0.4 * (mag - 1)) ** 0.6);
            cPos[c * 3] = st.dirS[0]; cPos[c * 3 + 1] = st.dirS[1]; cPos[c * 3 + 2] = st.dirS[2];
            cRad[c] = D.comaRad;
            cGain[c] = Math.max(0.05, F) * 1.6;
            const tailGain = D.activity * Math.max(0.03, Math.min(2.5, F)) * 0.3;
            for (let t = 0; t < 2; t++) {
                const arr = t === 0 ? D.ion : D.dust;
                const ws = t === 0 ? D.wIon : D.wDust;
                const base = c * VPC + t * K * 2;
                for (let k = 0; k < K; k++) {
                    perpAt(arr, k, tmp);
                    for (let side = 0; side < 2; side++) {
                        const v = base + k * 2 + side;
                        pos[v * 3] = arr[k * 3]; pos[v * 3 + 1] = arr[k * 3 + 1]; pos[v * 3 + 2] = arr[k * 3 + 2];
                        perp[v * 3] = tmp[0]; perp[v * 3 + 1] = tmp[1]; perp[v * 3 + 2] = tmp[2];
                        w[v] = ws[k];
                        gain[v] = tailGain;
                    }
                }
            }
            any = true;
        }
        if (any) {
            posA.needsUpdate = perpA.needsUpdate = wA.needsUpdate = gainA.needsUpdate = true;
            cPosA.needsUpdate = cRadA.needsUpdate = cGainA.needsUpdate = true;
        }
        tailMat.visible = comaMat.visible = any;
    }

    return {
        object3d: group,
        apply,
        update(fi) {
            if (!fi || !any) return;
            if (Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
            refr.uRefrK.value = Math.max(0, Math.min(1, skyBlend));
            const P = fi.camera?.projectionMatrix?.elements;
            const H = (rc?.size?.h || 800) * (rc?.dpr || 1);
            const pxPerRad = P ? 0.5 * H * P[5] : 1000;
            comaU.uPxPerRad.value = pxPerRad;
            comaU.uPx.value = Math.max(1, rc?.dpr || 1);
            tailU.uMinW.value = 1.5 * Math.max(1, rc?.dpr || 1) / Math.max(pxPerRad, 1);
            const e = fi.exposure || {};
            tailU.uExp.value = Math.sqrt(Math.max(0, Math.min(1, Number.isFinite(e.stars) ? e.stars : 1)));
            comaU.uExp.value = Math.max(0.15, Math.min(1, Number.isFinite(e.planets) ? e.planets : 1));
        },
        setLayers() {},
        setSelection() {},
        setQuality() {},
        dispose() {
            off?.();
            tg.dispose(); tailMat.dispose(); cg.dispose(); comaMat.dispose();
        },
    };
}
