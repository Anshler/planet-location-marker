/**
 * Aurora: the volumetric limb-curtain shell (high and max), plus the uniform driver the Earth's
 * surface and cloud shaders share for the face-on oval (every tier). The ovals come from
 * snap.aurora (js/astro/geomag.js); shaders/aurora.glsl.js explains the two renderings and how
 * they hand over.
 *
 * Shell: SphereGeometry(1.05), FrontSide, additive, depthWrite off, depth test on, renderOrder 15
 * (between the clouds and the atmosphere). The camera never comes inside it in orbit view
 * (minimum distance 1.08); in sky view it fades with the ground cover like the atmosphere.
 * Shown with the atmosphere layer.
 */
import * as THREE from 'three';
import { AURORA_SHADER } from './shaders/aurora.glsl.js';
import { groundCover } from './sky.js';

const SHELL_RADIUS = 1.05;

/** Linear-HDR strength of a bright arc seen face-on, per activity (illustrative, perceptual). */
const STRENGTH = { quiet: 0.16, typical: 0.26, storm: 0.55 };
/** Share of the low red (and violet fringe) aurora of strong storms. */
const STORM = { quiet: 0, typical: 0.15, storm: 1 };
/** Phase shown with reduced motion: the curtains hold still. */
const STILL_PHASE = 0.37;
/** Shell samples per view ray (split between the near and far halves of a grazing chord). */
const STEPS = { high: 24, max: 48 };

const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/** The uniforms of AURORA_CHUNK (one set per material group). */
export function createAuroraUniforms() {
    return {
        uAurPole: { value: new THREE.Vector3(0, 1, 0) },
        uAurNoon: { value: new THREE.Vector3(1, 0, 0) },
        uAurOval: { value: new Float32Array(48) },
        uAur: { value: new THREE.Vector4(0, 0, 1, 0) },
    };
}

/**
 * Feeds AURORA_CHUNK uniforms from snapshots and frames. Allocation-free.
 * @param {ReturnType<typeof createAuroraUniforms>} u
 * @param {{reducedMotion?:boolean}} [opts]
 */
export function createAuroraDriver(u, { reducedMotion = false } = {}) {
    let on = true;
    let strength = 0;
    let sinMin = 1;
    return {
        /** Lowest |sin(geomagnetic latitude)| with any emission (the shell's early-out). */
        get sinMin() { return sinMin; },
        apply(snap) {
            const a = snap?.aurora;
            if (!a || !Number.isFinite(a.kp)) return;
            const p = a.poleS, n = a.noonS;
            u.uAurPole.value.set(p[0], p[1], p[2]);
            u.uAurNoon.value.set(n[0], n[1], n[2]);
            u.uAurOval.value.set(a.ovals);
            strength = STRENGTH[a.activity] ?? STRENGTH.typical;
            u.uAur.value.x = on ? strength : 0;
            u.uAur.value.y = reducedMotion ? STILL_PHASE : a.phase;
            u.uAur.value.w = STORM[a.activity] ?? 0;
            // The diffuse glow reaches about one band width below the equatorward edge.
            sinMin = Math.sin(Math.max(0, a.minEqDeg - 10) * Math.PI / 180);
        },
        /**
         * Per rendered frame: fine structure fades out from about 400× to 15 000× real time,
         * where it would only flicker. @returns {boolean} whether a uniform changed
         */
        update(fi) {
            const r = Math.abs(fi?.simRate ?? 0);
            const d = 1 - smooth(2.6, 4.2, Math.log10(Math.max(r, 1)));
            if (d === u.uAur.value.z) return false;
            u.uAur.value.z = d;
            return true;
        },
        setOn(v) {
            on = !!v;
            u.uAur.value.x = on ? strength : 0;
        },
    };
}

function tierName(cfg) {
    return typeof cfg === 'string' ? cfg : cfg?.name;
}

/** Whether a tier draws the volumetric shell (and the surface shaders hand the limb over to it). */
export function auroraShellFor(cfg) {
    return STEPS[tierName(cfg)] !== undefined;
}

/**
 * Creates the aurora render module (the limb-curtain shell).
 * @param {{tier?:object|string, invalidate?:()=>void, size?:{w:number,h:number}}} rc RenderContext
 * @param {{reducedMotion?:boolean}} [opts]
 */
export function createAurora(rc, { reducedMotion = false } = {}) {
    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* never throw from a redraw request */ } };
    const au = createAuroraUniforms();
    const driver = createAuroraDriver(au, { reducedMotion });
    const uniforms = {
        ...au,
        uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
        uIntensity: { value: 1 },
        uPxAng: { value: 0.001 },
        uAurSinMin: { value: 0.8 },
    };
    let steps = STEPS[tierName(rc?.tier)] ?? 0;

    const material = new THREE.ShaderMaterial({
        name: 'aurora',
        uniforms,
        vertexShader: AURORA_SHADER.vertex,
        fragmentShader: AURORA_SHADER.fragment,
        defines: { STEPS: steps || 24 },
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SHELL_RADIUS, 96, 48), material);
    mesh.name = 'aurora';
    mesh.renderOrder = 15;

    let layerOn = true;
    let skyBlend = 0;
    function refresh() {
        const cover = groundCover(skyBlend);
        uniforms.uIntensity.value = 1 - cover;
        mesh.visible = layerOn && steps > 0 && cover < 0.999;
        driver.setOn(layerOn);
    }
    refresh();

    return {
        object3d: mesh,

        apply(snap) {
            driver.apply(snap);
            uniforms.uAurSinMin.value = driver.sinMin;
            const s = snap?.sunDirS;
            if (s) uniforms.uSunDirW.value.set(s[0], s[1], s[2]);
        },

        update(fi) {
            driver.update(fi);
            const sb = Math.min(1, Math.max(0, fi?.skyBlend ?? 0));
            if (sb !== skyBlend) {
                skyBlend = sb;
                refresh();
            }
            const cam = fi?.camera;
            const h = rc?.size?.h;
            if (cam && Number.isFinite(cam.fov) && h > 0) uniforms.uPxAng.value = (cam.fov * Math.PI / 180) / h;
        },

        setLayers(layers) {
            if (layers && 'atmosphere' in layers) {
                layerOn = !!layers.atmosphere;
                refresh();
                invalidate();
            }
        },

        setViewMode(mode, sb) {
            skyBlend = Math.min(1, Math.max(0, Number.isFinite(sb) ? sb : (mode === 'sky' ? 1 : 0)));
            refresh();
        },

        setQuality(cfg) {
            const next = STEPS[tierName(cfg)] ?? 0;
            if (next && next !== steps) {
                material.defines = { STEPS: next };
                material.needsUpdate = true;
            }
            steps = next;
            refresh();
            invalidate();
        },

        dispose() {
            mesh.geometry.dispose();
            material.dispose();
            mesh.removeFromParent();
        },
    };
}
