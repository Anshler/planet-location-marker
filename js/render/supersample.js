/**
 * Idle supersampling pass (ROADMAP idle-supersampling): the running mean of jittered frames.
 * Sits where the long exposure's AccumPass sits (between the RenderPass and the bloom, postfx.js);
 * the two never run together: while Expose stacks, this pass is out of the chain.
 *
 *   history ← history·(1 − w) + scene·w     (hardware blend, one target: no ping-pong)
 *   scene   ← history                       (bloom and the final pass see the mean)
 *
 * `enabled` is false on every frame that does not accumulate (motion, captures): the composer then
 * skips the pass and costs nothing. The policy (which frames, which weight, which jitter) is
 * core/sampling.js createSupersampler; the jitter itself is applied by render/context.js.
 *
 * One RGBA16F target (8-bit without half-float rendering) at the drawing-buffer size, allocated on
 * the first accumulated frame after a resize (never per frame) and released by dispose() or a
 * resize; a lost context drops the whole composer (render/context.js), pass included.
 *
 * @module render/supersample
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FINITE_CHUNK } from './shaders/common.glsl.js';

/** Brightest value the history keeps (postfx.js BLOOM_INPUT_MAX). */
const HISTORY_MAX = 1024;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Both fragments write a render target, where three compiles the tone-mapping and colour-space
// chunks as no-ops; they are included for the project's shader rule.
const BLEND_FRAG = /* glsl */ `
${FINITE_CHUNK}
uniform sampler2D tScene;
uniform float uWeight;
varying vec2 vUv;
void main() {
    vec3 c = clamp(pcFinite(texture2D(tScene, vUv).rgb), vec3(0.0), vec3(${HISTORY_MAX.toFixed(1)}));
    gl_FragColor = vec4(c, uWeight);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tHistory;
varying vec2 vUv;
void main() {
    gl_FragColor = vec4(texture2D(tHistory, vUv).rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

export class SupersamplePass extends Pass {
    /** @param {number} type THREE.HalfFloatType or THREE.UnsignedByteType */
    constructor(type) {
        super();
        this.needsSwap = false;
        this.enabled = false;
        this.type = type;
        /** This frame's blend into the history (1 = replace it). */
        this.weight = 1;
        /** Accumulated frames since the history was last replaced. */
        this.samples = 0;
        /** True keeps the history and its size while a capture renders at another size. */
        this.frozen = false;
        this._w = 0;
        this._h = 0;
        /** @type {THREE.WebGLRenderTarget|null} */
        this._target = null;
        this._blendMat = new THREE.ShaderMaterial({
            name: 'supersample.blend', uniforms: { tScene: { value: null }, uWeight: { value: 1 } },
            vertexShader: VERT, fragmentShader: BLEND_FRAG, depthTest: false, depthWrite: false,
            // history·(1 − a) + scene·a, alpha kept at 1.
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
            blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        });
        this._copyMat = new THREE.ShaderMaterial({
            name: 'supersample.copy', uniforms: { tHistory: { value: null } },
            vertexShader: VERT, fragmentShader: COPY_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        });
        this._blendQuad = new FullScreenQuad(this._blendMat);
        this._copyQuad = new FullScreenQuad(this._copyMat);
    }

    /** The history target's size changed: drop it (it is allocated again by the next accumulated frame). */
    setSize(width, height) {
        if (this.frozen) return;
        // The composer passes w·dpr unrounded; GL truncates a fractional size, so match that.
        const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
        if (w === this._w && h === this._h) return;
        this._w = w;
        this._h = h;
        this._disposeTarget();
    }

    render(renderer, _writeBuffer, readBuffer) {
        if (!this._target) {
            if (!this._w) this.setSize(readBuffer.width, readBuffer.height);
            this._target = new THREE.WebGLRenderTarget(this._w, this._h, {
                type: this.type, depthBuffer: false, stencilBuffer: false,
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
            });
            this._target.texture.name = 'supersample.history';
            this.weight = 1;
        }
        const w = this.samples === 0 ? 1 : Math.min(1, Math.max(0, this.weight));
        this._blendMat.uniforms.tScene.value = readBuffer.texture;
        this._blendMat.uniforms.uWeight.value = w;
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(this._target);
        this._blendQuad.render(renderer);
        renderer.autoClear = autoClear;
        this.samples = w >= 1 ? 1 : this.samples + 1;
        this._copyMat.uniforms.tHistory.value = this._target.texture;
        renderer.setRenderTarget(readBuffer);
        this._copyQuad.render(renderer);
    }

    _disposeTarget() {
        this._target?.dispose();
        this._target = null;
        this.samples = 0;
    }

    dispose() {
        this._disposeTarget();
        this._blendMat.dispose();
        this._copyMat.dispose();
        this._blendQuad.dispose();
        this._copyQuad.dispose();
    }
}
