/**
 * Post-processing chain (SPEC §C.6, §E.6): HDR scene target (half float, MSAA)
 * → UnrealBloom (optional, at `bloom.scale` resolution) → FinalPass
 * (ACES tone mapping + sRGB + vignette + blue-noise dither) or OutputPass.
 *
 * The bloom input and the final pass scrub NaN/Inf (`pcFinite`), so one bad scene pixel stays
 * one pixel instead of being blurred into a screen-sized black block.
 *
 * Only one scene render target is ever bound: every pass is configured with
 * `needsSwap = false`, so EffectComposer's second buffer is never allocated on
 * the GPU (an MSAA half-float buffer at 1.5× DPR is ~150 MB on a 1080p screen).
 *
 * @module render/postfx
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FINITE_CHUNK } from './shaders/common.glsl.js';

/**
 * Brightest value a scene pixel may feed into the bloom (the Sun core peaks near 30). With
 * `pcFinite` this bounds what any single bad pixel can do to the frame: an Inf becomes a small
 * glow, never a screen-sized block.
 */
const BLOOM_INPUT_MAX = 1024;

/**
 * Final full-screen pass. A ShaderMaterial (not Raw) rendered to the canvas, so
 * three injects the tone-mapping and colour-space chunks for the renderer's
 * ACES/sRGB settings and keeps `toneMappingExposure` live (rc.setExposure).
 * Vignette is applied in linear HDR before tone mapping; the ±0.5/255 dither is
 * applied after encoding, using interleaved gradient noise (a cheap blue-ish
 * noise that needs no texture), to break up banding in the dark sky gradients.
 */
const FINAL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FINAL_FRAG = /* glsl */ `
${FINITE_CHUNK}
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uVignette;
uniform float uDither;
varying vec2 vUv;

float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
    vec3 c = pcFinite(texture2D(tDiffuse, vUv).rgb);
    vec2 q = vUv - 0.5;
    q.x *= uResolution.x / max(uResolution.y, 1.0);
    float r = length(q) / length(vec2(0.5 * uResolution.x / max(uResolution.y, 1.0), 0.5));
    c *= 1.0 - uVignette * smoothstep(0.35, 1.0, r);
    gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb += (ign(gl_FragCoord.xy) - 0.5) * uDither;
}
`;

function createFinalPass() {
    const material = new THREE.ShaderMaterial({
        name: 'FinalPass',
        uniforms: {
            tDiffuse: { value: null },
            uResolution: { value: new THREE.Vector2(1, 1) },
            uVignette: { value: 0.12 },
            uDither: { value: 1 / 255 },
        },
        vertexShader: FINAL_VERT,
        fragmentShader: FINAL_FRAG,
        depthTest: false,
        depthWrite: false,
    });
    const pass = new ShaderPass(material);
    pass.needsSwap = false;
    return pass;
}

/** True when the context can render into RGBA16F targets. */
function halfFloatRenderable(renderer) {
    try {
        const ext = renderer.extensions;
        return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    } catch {
        return false;
    }
}

/**
 * UnrealBloomPass (r170) builds each mip's blur with σ equal to the kernel
 * radius, truncated at ±1σ: almost a box filter, so a bright point (pin head,
 * Sun core) blooms into a visible square at the coarse mips. Re-weight every
 * kernel as a Gaussian with σ = radius / 2.2 (edge weight ≈ 0.09) so blooms
 * are round; the mip chain still provides the wide falloff.
 * @param {object} pass UnrealBloomPass
 */
function roundBloomKernels(pass) {
    const mats = pass.separableBlurMaterials;
    if (!Array.isArray(mats)) return;
    for (const m of mats) {
        const u = m?.uniforms?.gaussianCoefficients;
        const kr = Number(m?.defines?.KERNEL_RADIUS);
        if (!u || !Array.isArray(u.value) || !(kr > 0)) continue;
        const sigma = kr / 2.2;
        const coeffs = new Array(kr);
        for (let i = 0; i < kr; i++) coeffs[i] = Math.exp(-0.5 * (i * i) / (sigma * sigma));
        u.value = coeffs; // the shader normalises by the summed weights
    }
}

/**
 * Scrubs the bloom's input. UnrealBloom's high pass, five-mip blur and additive composite turn a
 * single NaN or Inf scene pixel into a block hundreds of pixels wide, which tone mapping shows
 * as a black rectangle. The high-pass material is the pass's own instance, so patching its
 * fragment shader leaves the vendored LuminosityHighPassShader untouched.
 * @param {object} pass UnrealBloomPass
 */
function sanitizeBloomInput(pass) {
    const m = pass.materialHighPassFilter;
    const from = 'vec4 texel = texture2D( tDiffuse, vUv );';
    if (!m || typeof m.fragmentShader !== 'string' || !m.fragmentShader.includes(from)) {
        console.warn('postfx: bloom input not sanitised (LuminosityHighPassShader changed)');
        return;
    }
    m.fragmentShader = FINITE_CHUNK + m.fragmentShader.replace(from,
        `vec4 texel = min( pcFinite( texture2D( tDiffuse, vUv ) ), vec4( ${BLOOM_INPUT_MAX.toFixed(1)} ) );`);
    m.needsUpdate = true;
}

function bloomEquals(a, b) {
    if (!a || !b) return a === b;
    return a.strength === b.strength && a.radius === b.radius && a.threshold === b.threshold && a.scale === b.scale;
}

/**
 * Creates the composer for a tier that has `composer: true`.
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {object} cfg TierCfg (SPEC §C.1)
 * @param {{w:number, h:number, dpr:number}} [size] CSS size and pixel ratio
 * @returns {{render():void, setSize(w:number,h:number,dpr:number):void, setTier(cfg:object):void, dispose():void,
 *   readonly inputTarget:THREE.WebGLRenderTarget, readonly bloomPass:any, readonly finalPass:any}}
 */
export function createPostFx(renderer, scene, camera, cfg, size) {
    const sz = new THREE.Vector2();
    renderer.getSize(sz);
    let w = size?.w ?? sz.x ?? 1;
    let h = size?.h ?? sz.y ?? 1;
    let dpr = size?.dpr ?? renderer.getPixelRatio();
    const hdr = halfFloatRenderable(renderer);
    const maxSamples = renderer.capabilities?.maxSamples ?? 4;

    let msaa = 0;
    let bloomCfg = null;
    let useFinal = true;

    /** @type {EffectComposer} */
    let composer = null;
    let renderPass = null;
    let bloomPass = null;
    let finalPass = null;

    function makeTarget(samples) {
        const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)), {
            type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
            samples: Math.min(samples, maxSamples),
            depthBuffer: true,
            stencilBuffer: false,
        });
        rt.texture.name = 'postfx.scene';
        return rt;
    }

    function makeBloom(b) {
        const scale = Number.isFinite(b.scale) ? Math.max(0.1, Math.min(1, b.scale)) : 0.5;
        const pass = new UnrealBloomPass(new THREE.Vector2(w * dpr * scale, h * dpr * scale), b.strength, b.radius, b.threshold);
        // Soft knee above the threshold. The stock 0.01 makes the bright-pass nearly binary,
        // and at half resolution its boundary shows as 2-px stair steps along beam glows.
        if (pass.highPassUniforms?.smoothWidth) pass.highPassUniforms.smoothWidth.value = 0.5;
        sanitizeBloomInput(pass);
        roundBloomKernels(pass);
        // The composer hands passes full drawing-buffer sizes; run the bloom mips at `scale`.
        const baseSetSize = pass.setSize.bind(pass);
        pass.setSize = (pw, ph) => baseSetSize(Math.max(2, Math.round(pw * scale)), Math.max(2, Math.round(ph * scale)));
        pass.needsSwap = false;
        return pass;
    }

    function makeFinal(final) {
        if (final) return createFinalPass();
        const p = new OutputPass();
        p.needsSwap = false;
        return p;
    }

    /** Rebuilds the pass list from the current settings (only on tier changes). */
    function rebuildPasses() {
        composer.passes.length = 0;
        composer.addPass(renderPass);
        if (bloomPass) composer.addPass(bloomPass);
        composer.addPass(finalPass);
        applySize();
    }

    function applySize() {
        composer.setPixelRatio(dpr);
        composer.setSize(w, h);
        if (finalPass?.uniforms?.uResolution) finalPass.uniforms.uResolution.value.set(w * dpr, h * dpr);
    }

    function build(nextCfg) {
        msaa = Math.max(0, Math.round(nextCfg?.msaa ?? 0));
        bloomCfg = nextCfg?.bloom ? { ...nextCfg.bloom } : null;
        useFinal = nextCfg?.finalPass !== false;
        composer = new EffectComposer(renderer, makeTarget(msaa));
        renderPass = new RenderPass(scene, camera);
        bloomPass = bloomCfg ? makeBloom(bloomCfg) : null;
        finalPass = makeFinal(useFinal);
        rebuildPasses();
    }

    build(cfg);

    return {
        /** Renders the scene through the chain to the canvas. */
        render() {
            composer.render(0);
        },
        /**
         * @param {number} nw CSS width
         * @param {number} nh CSS height
         * @param {number} ndpr pixel ratio
         */
        setSize(nw, nh, ndpr) {
            w = Math.max(1, nw);
            h = Math.max(1, nh);
            if (Number.isFinite(ndpr) && ndpr > 0) dpr = ndpr;
            applySize();
        },
        /** Applies a new tier in place: MSAA, bloom and final-pass changes only. */
        setTier(nextCfg) {
            const nextMsaa = Math.max(0, Math.round(nextCfg?.msaa ?? 0));
            const nextBloom = nextCfg?.bloom ? { ...nextCfg.bloom } : null;
            const nextFinal = nextCfg?.finalPass !== false;
            if (nextMsaa !== msaa) {
                msaa = nextMsaa;
                composer.reset(makeTarget(msaa));
            }
            if (!bloomEquals(bloomCfg, nextBloom)) {
                if (bloomPass && nextBloom && bloomCfg && bloomCfg.scale === nextBloom.scale) {
                    bloomPass.strength = nextBloom.strength;
                    bloomPass.radius = nextBloom.radius;
                    bloomPass.threshold = nextBloom.threshold;
                } else {
                    bloomPass?.dispose();
                    bloomPass = nextBloom ? makeBloom(nextBloom) : null;
                }
                bloomCfg = nextBloom;
            }
            if (nextFinal !== useFinal) {
                finalPass?.dispose();
                useFinal = nextFinal;
                finalPass = makeFinal(useFinal);
            }
            rebuildPasses();
        },
        dispose() {
            bloomPass?.dispose();
            finalPass?.dispose();
            renderPass?.dispose?.();
            composer?.dispose();
            composer = null;
        },
        /** The HDR target the scene is rendered into (used to compile matching shader variants). */
        get inputTarget() { return composer ? composer.readBuffer : null; },
        get bloomPass() { return bloomPass; },
        get finalPass() { return finalPass; },
        get hdr() { return hdr; },
    };
}
