/**
 * Post-processing chain (SPEC §C.6, §E.6): HDR scene target (half float, MSAA)
 * → UnrealBloom (optional, at `bloom.scale` resolution) → FinalPass
 * (FXAA when the target has no MSAA + ACES tone mapping + sRGB + vignette + blue-noise dither)
 * or OutputPass. While Expose (long-exposure stacking) is on, an AccumPass (render/accum.js) sits
 * between the scene and the bloom: `setAccumulation(on)`, `accum` (its flags and frame count).
 * Otherwise, on tiers that supersample when idle, a SupersamplePass (render/supersample.js) sits
 * there: `setSupersample(on)`, and `render(ss)` with ss = {weight} blends the frame into its running
 * mean (ss = null skips the pass). Once a few samples are in, FXAA steps aside (uFxaa).
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
import { AccumPass } from './accum.js';
import { SupersamplePass } from './supersample.js';

/** Accumulated samples after which the final pass's FXAA steps aside (the mean is already smooth). */
const SS_NO_FXAA_SAMPLES = 4;

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

/**
 * FXAA 3.11 "console" (Lottes) for scene targets without MSAA (touch Medium, SPEC §E.6), on depth
 * silhouettes only: the Earth's limb, the Moon's disc, the pin. Stars, lines and beams are drawn
 * anti-aliased and write no depth, and FXAA would turn a 3-px star into an X; texture detail stays
 * sharp too. Four depth taps gate it (w = 1 − depth ∝ 1/distance, background 0); past the gate,
 * centre and diagonal taps give the contrast and edge direction and 2–4 taps along the edge are
 * blended. The input is HDR, so taps are tone-mapped first with an invertible max-channel
 * Reinhard, t = c / (1 + max c): the Sun and beams cannot saturate the edge metric (√ luma) or
 * the blend, and t / (1 − max t) maps the result back. PC_FXAA is set on tier changes only.
 */
const FXAA_CHUNK = /* glsl */ `
#ifdef PC_FXAA
#define FXAA_EDGE 0.125
#define FXAA_EDGE_MIN 0.03125
#define FXAA_REDUCE_MUL 0.125
#define FXAA_REDUCE_MIN 0.0078125
#define FXAA_SPAN_MAX 8.0
uniform sampler2D tDepth;
uniform float uFxaa;
bool fxaaSilhouette(vec2 uv, vec2 px) {
    float a = 1.0 - texture2D(tDepth, uv + vec2(-1.0, -1.0) * px).r;
    float b = 1.0 - texture2D(tDepth, uv + vec2(1.0, -1.0) * px).r;
    float c = 1.0 - texture2D(tDepth, uv + vec2(-1.0, 1.0) * px).r;
    float d = 1.0 - texture2D(tDepth, uv + vec2(1.0, 1.0) * px).r;
    float wMax = max(max(a, b), max(c, d));
    return wMax - min(min(a, b), min(c, d)) > 0.02 * wMax;
}
vec3 fxaaTone(vec3 c) {
    c = max(c, vec3(0.0));
    return c / (1.0 + max(c.r, max(c.g, c.b)));
}
vec3 fxaaTap(vec2 uv) {
    return fxaaTone(pcFinite(texture2D(tDiffuse, uv).rgb));
}
float fxaaLuma(vec3 t) {
    return sqrt(dot(t, vec3(0.299, 0.587, 0.114)));
}
vec3 pcFxaa(vec3 hdrM, vec2 uv, vec2 px) {
    if (!fxaaSilhouette(uv, px)) return hdrM;
    vec3 rgbM = fxaaTone(hdrM);
    float lM = fxaaLuma(rgbM);
    float lNW = fxaaLuma(fxaaTap(uv + vec2(-1.0, -1.0) * px));
    float lNE = fxaaLuma(fxaaTap(uv + vec2(1.0, -1.0) * px));
    float lSW = fxaaLuma(fxaaTap(uv + vec2(-1.0, 1.0) * px));
    float lSE = fxaaLuma(fxaaTap(uv + vec2(1.0, 1.0) * px));
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin < max(FXAA_EDGE_MIN, lMax * FXAA_EDGE)) return hdrM;
    // Along the edge: perpendicular to the luma gradient.
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float reduce = max((lNW + lNE + lSW + lSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
    float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcpMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * px;
    vec3 rgbA = 0.5 * (fxaaTap(uv + dir * (1.0 / 3.0 - 0.5)) + fxaaTap(uv + dir * (2.0 / 3.0 - 0.5)));
    vec3 rgbB = 0.5 * rgbA + 0.25 * (fxaaTap(uv - 0.5 * dir) + fxaaTap(uv + 0.5 * dir));
    float lB = fxaaLuma(rgbB);
    // The wide blend crossed another edge: keep the narrow one.
    vec3 t = (lB < lMin || lB > lMax) ? rgbA : rgbB;
    return t / max(1.0 - max(t.r, max(t.g, t.b)), 1.0 / 4096.0);
}
#endif
`;

/**
 * Night vision (uScotopic, set through rc.setVision from photometry.exposureFor's `vision`: sky
 * view in low light only): as rods take over from cones the dim sky and land lose colour and shift
 * toward blue (the Purkinje shift), while bright pixels (stars, planets, the Moon) keep theirs. The
 * rod weighting (0.06, 0.56, 0.38) approximates the scotopic V′(λ) curve on the sRGB primaries, and
 * the grade is applied before tone mapping. Illustrative and deliberately subtle (≤ 50 %).
 */
const FINAL_FRAG = /* glsl */ `
${FINITE_CHUNK}
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uVignette;
uniform float uDither;
uniform float uScotopic;
varying vec2 vUv;
${FXAA_CHUNK}
float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
    vec3 c = pcFinite(texture2D(tDiffuse, vUv).rgb);
    #ifdef PC_FXAA
    if (uFxaa > 0.5) c = pcFxaa(c, vUv, 1.0 / max(uResolution, vec2(1.0)));
    #endif
    if (uScotopic > 0.0) {
        float s = uScotopic * (1.0 - smoothstep(0.03, 0.4, dot(c, vec3(0.2126, 0.7152, 0.0722))));
        c = mix(c, dot(c, vec3(0.06, 0.56, 0.38)) * vec3(0.86, 1.0, 1.40), s);
    }
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

/**
 * Turns the final pass's FXAA on or off (a define: one program per variant, switched only on tier
 * changes, never per frame).
 * @param {object|null} pass FinalPass (an OutputPass has no FXAA and is left alone)
 * @param {boolean} on
 */
function setFxaa(pass, on) {
    const m = pass?.material;
    if (!m || m.name !== 'FinalPass') return;
    if (('PC_FXAA' in m.defines) === on) return;
    if (on) m.defines.PC_FXAA = '';
    else delete m.defines.PC_FXAA;
    m.needsUpdate = true;
}

/** @param {boolean} fxaa */
function createFinalPass(fxaa) {
    const material = new THREE.ShaderMaterial({
        name: 'FinalPass',
        defines: fxaa ? { PC_FXAA: '' } : {},
        uniforms: {
            tDiffuse: { value: null },
            tDepth: { value: null },
            uFxaa: { value: 1 },
            uResolution: { value: new THREE.Vector2(1, 1) },
            uVignette: { value: 0.12 },
            uDither: { value: 1 / 255 },
            uScotopic: { value: 0 },
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
    let vision = 0;

    /** @type {EffectComposer} */
    let composer = null;
    let renderPass = null;
    let bloomPass = null;
    let finalPass = null;
    /** @type {AccumPass|null} */
    let accumPass = null;
    /** @type {SupersamplePass|null} */
    let ssPass = null;

    function makeTarget(samples) {
        const s = Math.min(samples, maxSamples);
        const rw = Math.max(1, Math.round(w * dpr)), rh = Math.max(1, Math.round(h * dpr));
        const rt = new THREE.WebGLRenderTarget(rw, rh, {
            type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
            samples: s,
            depthBuffer: true,
            stencilBuffer: false,
            // Without MSAA the final pass's FXAA reads depth to find silhouettes.
            depthTexture: s === 0 ? new THREE.DepthTexture(rw, rh) : null,
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

    /** FXAA stands in for MSAA when the scene target ends up with no samples. */
    function wantFxaa() {
        return Math.min(msaa, maxSamples) === 0;
    }

    function makeFinal(final) {
        if (final) return createFinalPass(wantFxaa());
        const p = new OutputPass();
        p.needsSwap = false;
        return p;
    }

    /** Rebuilds the pass list from the current settings (only on tier changes). */
    function rebuildPasses() {
        composer.passes.length = 0;
        composer.addPass(renderPass);
        // One or the other: a long exposure stacks, otherwise idle frames may supersample.
        if (accumPass) composer.addPass(accumPass);
        else if (ssPass) composer.addPass(ssPass);
        if (bloomPass) composer.addPass(bloomPass);
        composer.addPass(finalPass);
        // The scene renders into readBuffer (needsSwap is false everywhere); its depth, if any.
        if (finalPass?.uniforms?.tDepth) finalPass.uniforms.tDepth.value = composer.readBuffer.depthTexture ?? null;
        if (finalPass?.uniforms?.uScotopic) finalPass.uniforms.uScotopic.value = vision;
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
        /**
         * Renders the scene through the chain to the canvas. `ss` ({weight}) blends this frame into
         * the supersampling history; null or absent skips that pass.
         * @param {{weight:number}|null} [ss]
         */
        render(ss) {
            const fxaa = finalPass?.uniforms?.uFxaa;
            if (ssPass) {
                ssPass.enabled = !!ss && !accumPass;
                if (ssPass.enabled) ssPass.weight = ss.weight;
            }
            if (fxaa) fxaa.value = ssPass?.enabled && ssPass.samples + 1 >= SS_NO_FXAA_SAMPLES ? 0 : 1;
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
        /**
         * Night-vision strength for the final pass (0 = none). An OutputPass (finalPass: false)
         * has no grade. Cheap: called every rendered frame.
         * @param {number} s 0…1
         */
        setVision(s) {
            vision = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
            if (finalPass?.uniforms?.uScotopic) finalPass.uniforms.uScotopic.value = vision;
        },
        /**
         * Long-exposure stacking on or off: creates the AccumPass (its two targets are allocated
         * now, at the current size) or disposes it. Called on Expose changes only.
         * @param {boolean} on
         */
        setAccumulation(on) {
            if (!!on === !!accumPass) return;
            if (on) accumPass = new AccumPass(hdr ? THREE.HalfFloatType : THREE.UnsignedByteType);
            else {
                accumPass.dispose();
                accumPass = null;
            }
            rebuildPasses();
        },
        /**
         * Idle supersampling available or not (the tier's `supersample`): creates the pass (its target
         * is allocated by the first accumulated frame) or disposes it. Called on tier changes only.
         * @param {boolean} on
         */
        setSupersample(on) {
            if (!!on === !!ssPass) return;
            if (on) ssPass = new SupersamplePass(hdr ? THREE.HalfFloatType : THREE.UnsignedByteType);
            else {
                ssPass.dispose();
                ssPass = null;
            }
            rebuildPasses();
        },
        /** The supersampling pass (`samples` in its history), or null. */
        get supersample() { return ssPass; },
        /**
         * A one-off capture at another size (render/context.js capture): `true` bypasses the stack
         * and freezes it at its size, `false` brings it back. The caller resizes around it. A video
         * session's `stack` option keeps the long exposure running at the capture's size instead (a
         * star-trail time-lapse: it restarts there, and again back on screen).
         * @param {boolean} on
         * @param {{stack?:boolean}} [opts]
         */
        setCapture(on, opts) {
            if (ssPass) ssPass.frozen = !!on;
            if (!accumPass || (on && opts?.stack)) return;
            if (on) {
                accumPass.frozen = true;
                accumPass.enabled = false;
            } else {
                accumPass.frozen = false;
                accumPass.enabled = true;
            }
        },
        /** The stacking pass while Expose is on (flags `add`, `frames`, `reset()`), else null. */
        get accum() { return accumPass; },
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
            } else {
                setFxaa(finalPass, wantFxaa());
            }
            rebuildPasses();
        },
        dispose() {
            accumPass?.dispose();
            accumPass = null;
            ssPass?.dispose();
            ssPass = null;
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
        /** True when the final pass runs FXAA (no MSAA on the scene target). */
        get fxaa() { return !!finalPass?.material?.defines && 'PC_FXAA' in finalPass.material.defines; },
    };
}
