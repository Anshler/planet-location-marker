/**
 * Radio beams to the spacecraft (astro/craft.js): a faint, finely dashed ribbon from the observer's
 * pin toward each craft present in snap.extras, drawn with the signature beams' shaders under
 * `#define RADIO` (shaders/beam.glsl.js), x-ray pass included where the Earth hides it. The nine
 * body beams and their instance order are untouched: this is its own small instanced set.
 * Shown with the 'spacecraft' layer (off by default), in the globe view only; static (no pulses),
 * so it never keeps the frame loop awake. A render module.
 *
 * @module render/craft
 */
import * as THREE from 'three';
import { BEAM_VERT, BEAM_FRAG } from './shaders/beam.glsl.js';
import { AU_ER } from '../astro/bodies.js';

const MAX = 8;
const SEGMENTS = 24;
const FAR_LEN = 2000;
const ORIGIN_LIFT = 1.002;
const GLOW_PX = 7;

function buildStrip() {
    const g = new THREE.InstancedBufferGeometry();
    const rows = SEGMENTS + 1;
    const pos = new Float32Array(rows * 2 * 3);
    for (let i = 0; i < rows; i++) {
        const s = i / SEGMENTS;
        pos[i * 6] = s; pos[i * 6 + 1] = -1; pos[i * 6 + 3] = s; pos[i * 6 + 4] = 1;
    }
    const idx = new Uint16Array(SEGMENTS * 6);
    for (let i = 0; i < SEGMENTS; i++) {
        const a = i * 2;
        idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.instanceCount = 0;
    return g;
}

/**
 * Creates the spacecraft beams.
 * @param {object} rc RenderContext
 * @param {{extras:any, reducedMotion?:boolean}} deps
 * @returns {object} RenderModule
 */
export function createCraftBeams(rc, { extras } = {}) {
    const geometry = buildStrip();
    const aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    const aDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    const aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    const aLen = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    const aState = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    for (const a of [aOrigin, aDir, aColor, aLen, aState]) a.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iOrigin', aOrigin);
    geometry.setAttribute('iDir', aDir);
    geometry.setAttribute('iColor', aColor);
    geometry.setAttribute('iLen', aLen);
    geometry.setAttribute('iState', aState);

    const uniforms = {
        uNear: { value: 0.05 }, uViewport: { value: new THREE.Vector2(1, 1) }, uGlowPx: { value: GLOW_PX },
        uDpr: { value: 1 }, uPulses: { value: 0 }, uPhase: { value: 0 }, uFade: { value: 1 }, uSelActive: { value: 0 },
        uRootClear: { value: 0 }, uTint: { value: new THREE.Color('#ffffff') },
    };
    const common = {
        uniforms, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false,
        depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    };
    const matA = new THREE.ShaderMaterial({ ...common, name: 'craft.A', defines: { RADIO: '' } });
    const matB = new THREE.ShaderMaterial({ ...common, name: 'craft.B.xray', defines: { RADIO: '', XRAY: '' } });
    matB.depthFunc = THREE.GreaterDepth;
    const meshA = new THREE.Mesh(geometry, matA);
    const meshB = new THREE.Mesh(geometry, matB);
    meshA.name = 'craft.A';
    meshB.name = 'craft.B';
    meshA.renderOrder = 32;
    meshB.renderOrder = 33;
    for (const m of [meshA, meshB]) { m.frustumCulled = false; m.matrixAutoUpdate = false; }
    const group = new THREE.Group();
    group.name = 'craft';
    group.add(meshA, meshB);

    let layers = { spacecraft: false, ghostBeams: true };
    let selection = null;
    let skyBlend = 0;
    let systemBlend = 0;
    let count = 0;
    let lastSnap = null;
    const _size = new THREE.Vector2();
    // Linear colours per craft id, read once per registry change.
    const colors = new Map();
    const readColors = () => {
        colors.clear();
        for (const id of extras?.ids?.('craft') ?? []) colors.set(id, new THREE.Color(extras.meta(id)?.color ?? '#ffffff'));
    };
    readColors();
    const offChange = extras?.onChange?.(readColors) ?? null;
    const WHITE = new THREE.Color('#ffffff');

    function apply(snap) {
        if (!snap) return;
        lastSnap = snap;
        count = 0;
        const xs = snap.extras;
        const p = snap.observer?.posS;
        if (!xs || !p || !extras) { geometry.instanceCount = 0; return; }
        const o = aOrigin.array, d = aDir.array, l = aLen.array, c = aColor.array, s = aState.array;
        let sel = false;
        for (let i = 0; i < xs.length && count < MAX; i++) {
            const st = xs[i];
            if (st.kind !== 'craft' || !st.present) continue;
            const k = count++;
            o[k * 3] = p[0] * ORIGIN_LIFT; o[k * 3 + 1] = p[1] * ORIGIN_LIFT; o[k * 3 + 2] = p[2] * ORIGIN_LIFT;
            d[k * 3] = st.dirS[0]; d[k * 3 + 1] = st.dirS[1]; d[k * 3 + 2] = st.dirS[2];
            // JWST (1.5 million km ≈ 235 R) ends at the craft; the others are at infinity.
            const er = st.distAU * AU_ER;
            l[k] = Number.isFinite(er) && er < FAR_LEN ? Math.max(2, er) : FAR_LEN;
            const col = colors.get(st.id) ?? WHITE;
            c[k * 3] = col.r; c[k * 3 + 1] = col.g; c[k * 3 + 2] = col.b;
            const isSel = st.id === selection;
            if (isSel) sel = true;
            s[k * 4] = isSel ? 1 : 0;
            s[k * 4 + 1] = st.above ? 0 : 1;
            s[k * 4 + 2] = 1;
            s[k * 4 + 3] = 1;
        }
        geometry.instanceCount = count;
        uniforms.uSelActive.value = sel ? 1 : 0;
        for (const a of [aOrigin, aDir, aColor, aLen, aState]) a.needsUpdate = true;
        sync();
    }

    function sync() {
        group.visible = layers.spacecraft === true && count > 0 && skyBlend < 0.5 && systemBlend < 0.999;
        meshB.visible = layers.ghostBeams !== false;
    }

    return {
        object3d: group,
        apply,
        update(fi) {
            if (fi && Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
            systemBlend = fi && Number.isFinite(fi.systemBlend) ? fi.systemBlend : 0;
            const fade = (1 - Math.min(1, Math.max(0, (skyBlend - 0.2) / 0.3))) * (1 - systemBlend);
            uniforms.uFade.value = fade;
            sync();
            if (!group.visible) return;
            const cam = (fi && fi.camera) || rc?.camera;
            if (cam) uniforms.uNear.value = cam.near;
            const r = rc?.renderer;
            if (r) {
                r.getDrawingBufferSize(_size);
                uniforms.uViewport.value.copy(_size);
                const dpr = r.getPixelRatio();
                uniforms.uDpr.value = dpr;
                uniforms.uGlowPx.value = GLOW_PX * dpr;
            }
        },
        setLayers(l) {
            if (!l) return;
            layers = { spacecraft: l.spacecraft === true, ghostBeams: l.ghostBeams !== false };
            sync();
        },
        setSelection(id) { selection = id || null; if (lastSnap) apply(lastSnap); },
        setViewMode(_m, blend) { if (Number.isFinite(blend)) skyBlend = blend; },
        setQuality() {},
        dispose() { offChange?.(); geometry.dispose(); matA.dispose(); matB.dispose(); },
    };
}
