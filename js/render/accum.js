/**
 * Long-exposure stacking pass (ROADMAP lighten-stacking-exposure): the 'lighten' blend of
 * astrophotography. Sits between the RenderPass and the bloom (postfx.js) while Expose is on:
 *
 *   stack ← max(stack, scene)        (only when `add` is true: a gated frame is shown, not kept;
 *                                     `brightOnly`: after the first frame, only HDR highlights)
 *   scene ← stack                    (the composer's single scene target, so bloom and the final
 *                                     pass see the stacked image)
 *
 * Two RGBA16F targets (8-bit without half-float rendering) at the drawing-buffer size ping-pong,
 * so a frame reads the committed stack and writes the next one. They are allocated when the pass is
 * created (postfx.setAccumulation(true)) or resized, never per frame, and released by dispose(); a
 * lost context drops the whole composer (render/context.js), pass included.
 *
 * `reset()` starts a fresh stack: the next frame shows the scene alone. A resize does the same.
 * `frozen` (a capture at another size, render/context.js) keeps the stack and its size untouched.
 * Values are scrubbed (pcFinite) and capped before they enter the stack: a NaN there would stay
 * for the rest of the exposure.
 *
 * @module render/accum
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FINITE_CHUNK } from './shaders/common.glsl.js';

/** Brightest value the stack keeps (postfx.js BLOOM_INPUT_MAX: the Sun core peaks near 30). */
const STACK_MAX = 1024;
/**
 * Bright-only stacking (the analemma): scene values between these (max channel, linear HDR) fade
 * into the stack. The daylight sky stays below ~2, the Sun's core is far above.
 */
const BRIGHT_LO = 2.0;
const BRIGHT_HI = 4.0;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Both fragments write a render target, where three compiles the tone-mapping and colour-space
// chunks as no-ops; they are included for the project's shader rule.
const STACK_FRAG = /* glsl */ `
${FINITE_CHUNK}
uniform sampler2D tScene;
uniform sampler2D tStack;
uniform float uFresh;
uniform float uBright;
varying vec2 vUv;
void main() {
    vec3 c = clamp(pcFinite(texture2D(tScene, vUv).rgb), vec3(0.0), vec3(${STACK_MAX.toFixed(1)}));
    if (uFresh < 0.5) {
        vec3 s = texture2D(tStack, vUv).rgb;
        vec3 m = max(c, s);
        // Bright-only: after the first frame only HDR highlights (the Sun's core) join the stack.
        if (uBright > 0.5) m = mix(s, m, smoothstep(${BRIGHT_LO.toFixed(1)}, ${BRIGHT_HI.toFixed(1)}, max(c.r, max(c.g, c.b))));
        c = m;
    }
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tStack;
varying vec2 vUv;
void main() {
    gl_FragColor = vec4(texture2D(tStack, vUv).rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

function makeMaterial(name, fragmentShader, uniforms) {
    return new THREE.ShaderMaterial({
        name, uniforms, vertexShader: VERT, fragmentShader, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
}

export class AccumPass extends Pass {
    /** @param {number} type THREE.HalfFloatType or THREE.UnsignedByteType */
    constructor(type) {
        super();
        this.needsSwap = false;
        this.type = type;
        /** False shows the frame (max with the stack) without keeping it: the gate (daylight). */
        this.add = true;
        /**
         * True: the first frame is the base and later frames add only their HDR highlights, like a
         * multiple exposure through a solar filter over one landscape shot (the analemma).
         */
        this.brightOnly = false;
        /** True keeps the stack and its size while a capture renders at another size. */
        this.frozen = false;
        /** Frames in the current stack. */
        this.frames = 0;
        this._w = 0;
        this._h = 0;
        this._cur = 0;
        this._fresh = true;
        /** @type {THREE.WebGLRenderTarget[]} */
        this._targets = [];
        this._stackMat = makeMaterial('accum.stack', STACK_FRAG, {
            tScene: { value: null }, tStack: { value: null }, uFresh: { value: 1 }, uBright: { value: 0 },
        });
        this._copyMat = makeMaterial('accum.copy', COPY_FRAG, { tStack: { value: null } });
        this._stackQuad = new FullScreenQuad(this._stackMat);
        this._copyQuad = new FullScreenQuad(this._copyMat);
    }

    /** Starts a fresh stack: the next frame shows the scene alone. */
    reset() {
        this._fresh = true;
        this.frames = 0;
    }

    /** True until a frame has been kept since the last reset. */
    get fresh() { return this._fresh; }

    setSize(width, height) {
        if (this.frozen) return;
        // The composer passes w·dpr unrounded; GL truncates a fractional size, so match that.
        const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
        if (w === this._w && h === this._h && this._targets.length) return;
        this._w = w;
        this._h = h;
        this._disposeTargets();
        for (let i = 0; i < 2; i++) {
            const rt = new THREE.WebGLRenderTarget(w, h, {
                type: this.type, depthBuffer: false, stencilBuffer: false,
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
            });
            rt.texture.name = `accum.stack${i}`;
            this._targets.push(rt);
        }
        this.reset();
    }

    render(renderer, _writeBuffer, readBuffer) {
        if (!this._targets.length) this.setSize(readBuffer.width, readBuffer.height);
        const prev = this._targets[this._cur], next = this._targets[1 - this._cur];
        const u = this._stackMat.uniforms;
        u.tScene.value = readBuffer.texture;
        u.tStack.value = prev.texture;
        u.uFresh.value = this._fresh ? 1 : 0;
        u.uBright.value = this.brightOnly ? 1 : 0;
        renderer.setRenderTarget(next);
        this._stackQuad.render(renderer);
        this._copyMat.uniforms.tStack.value = next.texture;
        renderer.setRenderTarget(readBuffer);
        this._copyQuad.render(renderer);
        if (this.add) {
            this._cur = 1 - this._cur;
            this._fresh = false;
            this.frames++;
        }
    }

    _disposeTargets() {
        for (const rt of this._targets) rt.dispose();
        this._targets.length = 0;
        this._cur = 0;
    }

    dispose() {
        this._disposeTargets();
        this._stackMat.dispose();
        this._copyMat.dispose();
        // Not the quads: FullScreenQuad.dispose() releases three's one full-screen triangle, shared by
        // every pass (bloom, the final pass); after a context restore it still holds the lost
        // context's buffers and vertex arrays, and deleting them warns (render/context.js onRestored).
    }
}
