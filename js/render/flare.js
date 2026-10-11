/**
 * Custom lens flare (G5, SPEC C.7 / E.5, SHOULD): a starburst at the Sun's screen position and
 * four ghosts along the Sun→centre axis, as NDC quads drawn last (no depth test, additive).
 *
 * Occlusion is analytic: the visible fraction of the Sun's disc past the Earth's limb and the
 * Moon (so it fades smoothly as the Sun rises over the limb from orbit, and dims through a solar
 * eclipse), times the horizon in sky view and an off-screen fade; changes ease in over ~150 ms.
 */
import * as THREE from 'three';
import { MOON_RADIUS_ER, SUN_ANG_RADIUS_RAD } from '../astro/bodies.js';
import { FLARE_VERT, FLARE_FRAG } from './shaders/bodies.glsl.js';
import { extinctionRGB, limbTransmittance } from './bodies.js';

// [texture index, size (CSS px), axis distance (<0: at the Sun), ghost hue]
const ELEMENTS = [
    [0, 600, -1, 0],
    [1, 60, 0.6, 1],
    [1, 70, 0.7, 2],
    [1, 120, 0.9, 3],
    [1, 70, 1.0, 4],
];
/** Exponential fade time constant: occlusion changes reach 95 % in 3τ = 150 ms (SPEC §E.5). */
const FADE_TAU_MS = 50;
const SUN_COLOR = [1.0, 0.95, 0.85];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Visible fraction of a disc of angular radius rs behind an occulter ro at separation d (SPEC E.2). */
export function discVisible(rs, ro, d) {
    if (d >= rs + ro) return 1;
    if (d <= Math.abs(ro - rs)) return ro >= rs ? 0 : 1 - (ro * ro) / (rs * rs);
    const a = rs * rs * Math.acos(clamp((d * d + rs * rs - ro * ro) / (2 * d * rs), -1, 1))
        + ro * ro * Math.acos(clamp((d * d + ro * ro - rs * rs) / (2 * d * ro), -1, 1))
        - 0.5 * Math.sqrt(Math.max(0, (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro)));
    return 1 - a / (Math.PI * rs * rs);
}

/**
 * Creates the lens-flare module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @param {{textures?:object|null}} [deps]
 * @returns {object} RenderModule
 */
export function createFlare(rc, deps = {}) {
    const { textures = null } = deps;
    const group = new THREE.Group();
    group.name = 'flare';
    let cfg = rc && rc.tier && typeof rc.tier === 'object' ? rc.tier : null;

    const n = ELEMENTS.length;
    const pos = new Float32Array(n * 4 * 3);
    const elem = new Float32Array(n * 4 * 4);
    const idx = [];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let e = 0; e < n; e++) {
        for (let c = 0; c < 4; c++) {
            const v = e * 4 + c;
            pos[v * 3] = corners[c][0]; pos[v * 3 + 1] = corners[c][1];
            elem.set(ELEMENTS[e], v * 4);
        }
        const b = e * 4;
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aElem', new THREE.BufferAttribute(elem, 4));
    geometry.setIndex(idx);

    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    black.needsUpdate = true;
    const uniforms = {
        uFlare0: { value: textures ? textures.get('flare0') : black },
        uFlare3: { value: textures ? textures.get('flare3') : black },
        uSunNdc: { value: new THREE.Vector2(0, 0) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
        uTint: { value: new THREE.Color(1, 0.95, 0.85) },
        uIntensity: { value: 0 },
        // lensflare3.png peaks at 37/255; decoded as sRGB that is ~0.018, invisible at the spec's
        // 0.4 tint. This gain gives ghosts the faint visibility of three's Lensflare example.
        uGhosts: { value: 6 },
    };
    const material = new THREE.ShaderMaterial({
        name: 'flare', uniforms, vertexShader: FLARE_VERT, fragmentShader: FLARE_FRAG,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'flare';
    mesh.frustumCulled = false;
    mesh.renderOrder = 50;
    mesh.visible = false;
    group.add(mesh);

    const offs = [];
    if (textures) {
        try {
            offs.push(textures.onReady('flare0', (t) => { uniforms.uFlare0.value = t; }));
            offs.push(textures.onReady('flare3', (t) => { uniforms.uFlare3.value = t; }));
        } catch { /* placeholders stay black */ }
    }

    const sunDir = new THREE.Vector3(1, 0, 0);
    const moonPos = new THREE.Vector3(60, 0, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const tmp = new THREE.Vector3();
    const toMoon = new THREE.Vector3();
    const clip = new THREE.Vector4();
    const rot = new THREE.Matrix4();
    const tmpSize = new THREE.Vector2();
    const tint = [1, 1, 1];
    const limb = [1, 1, 1];
    let sunDistAU = 1;
    let vis = 0;
    let haveSnap = false;
    const invalidateSoon = () => { if (rc && rc.invalidate) rc.invalidate(); };

    function apply(snap) {
        if (!snap || !snap.bodies) return;
        const s = snap.bodies[0];
        sunDir.set(s.dirS[0], s.dirS[1], s.dirS[2]);
        sunDistAU = s.distAU > 0 ? s.distAU : 1;
        if (snap.moonPosS) moonPos.set(snap.moonPosS[0], snap.moonPosS[1], snap.moonPosS[2]);
        if (snap.observer) up.set(snap.observer.upS[0], snap.observer.upS[1], snap.observer.upS[2]);
        haveSnap = true;
    }

    function update(fi) {
        const enabled = !!cfg && !!cfg.flare && haveSnap;
        const cam = fi && (fi.camera || (rc && rc.camera));
        if (!enabled || !cam) { mesh.visible = false; vis = 0; return; }
        const skyBlend = Number.isFinite(fi.skyBlend) ? clamp(fi.skyBlend, 0, 1) : 0;
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }

        // Sun's NDC position at infinity: rotation-only view, as the sky shaders do.
        rot.extractRotation(cam.matrixWorldInverse);
        tmp.copy(sunDir).applyMatrix4(rot);
        clip.set(tmp.x, tmp.y, tmp.z, 1).applyMatrix4(cam.projectionMatrix);
        let target = 0;
        let nx = 0, ny = 0;
        if (clip.w > 1e-6) {
            nx = clip.x / clip.w; ny = clip.y / clip.w;
            const edge = Math.max(Math.abs(nx), Math.abs(ny));
            target = smooth(1.15, 0.95, edge);
            const sunR = SUN_ANG_RADIUS_RAD / sunDistAU;
            const c = cam.position;
            const dc = c.length();
            // Earth's limb (from orbit, and the dip of the horizon from the ground).
            if (dc > 1) {
                const earthR = Math.asin(1 / dc);
                tmp.copy(c).multiplyScalar(-1 / dc);
                const sep = Math.acos(clamp(tmp.dot(sunDir), -1, 1));
                target *= discVisible(sunR, earthR, sep);
                // From orbit, a Sun on the limb shines through the whole atmosphere: red and dim.
                if (sep < Math.PI / 2) limbTransmittance(dc * Math.sin(sep) - 1, limb);
                else limb[0] = limb[1] = limb[2] = 1;
            } else {
                target = 0;
            }
            // The Moon (eclipses).
            toMoon.copy(moonPos).sub(c);
            const dm = toMoon.length();
            if (dm > MOON_RADIUS_ER) {
                const moonR = Math.asin(MOON_RADIUS_ER / dm);
                const sepM = Math.acos(clamp(toMoon.multiplyScalar(1 / dm).dot(sunDir), -1, 1));
                target *= discVisible(sunR, moonR, sepM);
            } else {
                target = 0;
            }
            // Sky view: the ground hides the Sun below the astronomical horizon; extinction dims it.
            if (skyBlend > 0) {
                const sinAlt = sunDir.dot(up);
                target *= 1 - skyBlend * (1 - smooth(-sunR, sunR, sinAlt));
                extinctionRGB(sinAlt, tint);
                target *= 1 + skyBlend * (clamp(tint[1] * 3, 0.2, 1) - 1);
            } else {
                tint[0] = tint[1] = tint[2] = 1;
            }
        }
        const o = 1 - skyBlend;
        target *= 1 + (Math.sqrt(limb[1]) - 1) * o;
        const dt = fi && Number.isFinite(fi.dtMs) ? fi.dtMs : 16;
        const k = 1 - Math.exp(-dt / FADE_TAU_MS);
        vis += (target - vis) * k;
        if (Math.abs(target - vis) < 0.002) vis = target;
        else queueMicrotask(invalidateSoon);

        mesh.visible = vis > 0.003;
        if (!mesh.visible) return;
        uniforms.uSunNdc.value.set(nx, ny);
        uniforms.uViewport.value.set(w, h);
        uniforms.uDpr.value = dpr * (0.5 + 0.5 * vis);
        const g = Math.max(tint[1], 1e-4);
        const tb = skyBlend;
        const lr = Math.max(limb[0], 1e-4);
        uniforms.uTint.value.setRGB(
            SUN_COLOR[0] * (1 + (Math.min(tint[0] / g, 3) - 1) * tb),
            SUN_COLOR[1] * (1 + (limb[1] / lr - 1) * o),
            SUN_COLOR[2] * (1 + (tint[2] / g - 1) * tb) * (1 + (limb[2] / lr - 1) * o));
        uniforms.uIntensity.value = vis;
    }

    function setQuality(c) { if (c) cfg = c; }

    function dispose() {
        for (const off of offs) { try { off && off(); } catch { /* ignore */ } }
        geometry.dispose();
        material.dispose();
        black.dispose();
    }

    return { object3d: group, apply, update, setQuality, dispose };
}
