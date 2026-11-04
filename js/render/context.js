/**
 * Render context (SPEC §C.6, §E.6): the single WebGL2 renderer, scene and
 * camera shared by every render module, plus tier switching in place, DPR cap,
 * render-on-demand bookkeeping, context-loss handling and stats.
 *
 *   createRenderContext(canvas, {tierCfg}) → rc
 *
 * `rc.size` is `{w, h, insets}` in CSS px. `size.insets` ({left, right, top,
 * bottom}) is the part of the canvas covered by UI chrome; the camera rig's
 * `setViewInsets` keeps it current, and the beam label anchors and the DOM
 * labels keep clear of it.
 *
 * `rc.invalidate()` marks the frame dirty (`rc.dirty = true`) and calls every
 * `rc.onInvalidate` listener, so the frame loop can either poll `rc.dirty` or
 * subscribe. `rc.render()` clears the flag.
 *
 * Long exposure: `rc.setAccumulation(on)` adds the stacking pass (postfx.js, render/accum.js);
 * `rc.accum` is that pass or null. A low tier booted on the direct path gets the lean composer
 * chain (no bloom) while it is on. A restored context rebuilds the chain with a fresh stack.
 *
 * Capture: `rc.capture(w, h, scale, draw, read)` renders one frame at another size in one task
 * (postcards, the exposure's 'Save image'); see capture() below. A video session
 * (`beginCapture` … `endCapture`) keeps that size for many frames: each frame brackets its draw with
 * `captureCamera()` / `releaseCamera()`, and screen resizes wait until it ends.
 *
 * Idle supersampling (tiers with `supersample` > 1 and a composer): `rc.render(ss)` with
 * ss = {x, y, weight} offsets this frame's projection by (x, y) device px (projectionMatrix
 * elements 8 and 9, on top of the rig's view offset, restored right after the draw: picking and CPU
 * projections never see it) and blends it into postfx's running mean; `rc.supersampling` says
 * whether the chain has the pass. The policy lives in core/sampling.js and the loop.
 *
 * Overlay: `rc.setOverlay(scene, camera)` registers a second scene drawn over the main one into the
 * same target, with its own camera and a cleared depth buffer (the solar-system zoom's orrery,
 * render/orrery.js: astronomical units with a depth range of its own). It is drawn only while
 * `scene.visible`; through the composer it sits before the bloom, so its Sun glows like the other.
 *
 * Throws only from the constructor, when a WebGL2 context cannot be created
 * (three r170 has no WebGL1 path); main.js turns that into text mode.
 *
 * @module render/context
 */
import * as THREE from 'three';
import { createPostFx } from './postfx.js';

/**
 * Fallback tier table (SPEC §E.6). Used when the caller passes a tier name or a
 * partial config; js/core/quality.js `TIERS` is the source of truth.
 * @type {Record<'low'|'medium'|'high'|'max', object>}
 */
export const FALLBACK_TIERS = Object.freeze({
    low: Object.freeze({
        name: 'low', dprCap: 1.0, composer: false, msaa: 0, bloom: null, earthSegments: [64, 32], dayTex: 'day2k',
        oceanMask: 'roughness2k', clouds: 'none', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0,
        starMagLimit: 5.0, flare: false, labelCap: 12, twinkle: false, beamGlowPx: 8, finalPass: false,
        supersample: 0, streakPx: 0,
    }),
    medium: Object.freeze({
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4,
        bloom: Object.freeze({ strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 }),
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'roughness2k', clouds: 'clouds2k', cloudShadows: false,
        bump: false, atmosphere: 'analytic', atmoSteps: 0, starMagLimit: 6.0, flare: true, labelCap: 24, twinkle: false,
        beamGlowPx: 12, finalPass: true, supersample: 8, streakPx: 14,
    }),
    high: Object.freeze({
        name: 'high', dprCap: 2.0, composer: true, msaa: 4,
        bloom: Object.freeze({ strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 }),
        earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', cloudShadows: true,
        bump: true, atmosphere: 'raymarch', atmoSteps: 8, starMagLimit: 6.5, flare: true, labelCap: 40, twinkle: true,
        beamGlowPx: 14, finalPass: true, supersample: 16, streakPx: 24,
    }),
    max: Object.freeze({
        name: 'max', dprCap: Infinity, composer: true, msaa: 16, supersample: 16, streakPx: 32,
        bloom: Object.freeze({ strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 }),
        earthSegments: [256, 128], dayTex: 'day8k', oceanMask: 'roughness', clouds: 'clouds8k', cloudShadows: true,
        bump: true, atmosphere: 'raymarch', atmoSteps: 32, starMagLimit: 6.5, flare: true, labelCap: 80, twinkle: true,
        beamGlowPx: 14, finalPass: true, moonTex: 'moon4k', anisotropy: 16, cloudShadowTaps: 5,
    }),
});

/**
 * Normalises a TierCfg, a tier name, or nothing into a complete TierCfg.
 * @param {object|string|undefined|null} tier
 * @returns {object}
 */
export function resolveTier(tier) {
    const name = typeof tier === 'string' ? tier : tier && typeof tier === 'object' ? tier.name : null;
    const base = FALLBACK_TIERS[name] || FALLBACK_TIERS.medium;
    return tier && typeof tier === 'object' ? { ...base, ...tier, name: base === FALLBACK_TIERS[name] ? name : base.name } : { ...base };
}

function deviceDpr() {
    const d = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
    return Number.isFinite(d) && d > 0 ? d : 1;
}

/**
 * Creates the renderer, scene and camera.
 * @param {HTMLCanvasElement} canvas The #scene canvas.
 * @param {{tierCfg?:object|string}} [opts]
 * @returns {object} RenderContext — see module docs and SPEC §C.6.
 */
export function createRenderContext(canvas, { tierCfg } = {}) {
    let cfg = resolveTier(tierCfg);
    /** The context was created for the direct path: canvas MSAA requested, no composer. */
    const createdLow = cfg.name === 'low';
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: createdLow,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        depth: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
    });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 1);
    // Count every draw of a frame (the composer issues several render() calls).
    renderer.info.autoReset = false;

    const scene = new THREE.Scene();
    scene.name = 'planet-location-marker';
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 4000);
    camera.position.set(0, 0, 3.4);
    camera.name = 'camera';

    const size = { w: 1, h: 1, insets: { left: 0, right: 0, top: 0, bottom: 0 } };
    let dpr = 1;
    let dprOverride = null;
    let postfx = null;
    let lost = false;
    let frames = 0;
    let forceResize = true;
    let presentQueued = false;
    let postfxFailed = false;
    /** Long-exposure stacking requested (setAccumulation); re-applied to every new chain. */
    let accumWanted = false;
    /** The overlay scene (setOverlay): {scene, camera} or null. */
    let overlay = null;
    const lostCbs = new Set();
    const restoredCbs = new Set();
    const invalidateCbs = new Set();
    const cleanups = [];
    let disposed = false;
    /** A video session (beginCapture … endCapture): the screen state it restores, or null. */
    let session = null;

    // The canvas's own MSAA is fixed when the context is created, and only a 'low' boot asks for it.
    // A context created for a composer tier has none, so a later switch to low (governor or
    // Settings) would render with no anti-aliasing at all. Such a low tier keeps a lean chain
    // instead: no MSAA, no bloom, and the final pass with FXAA (postfx.js). A low boot keeps the
    // direct path whatever the driver granted: those are the weakest GPUs, and the lean chain
    // costs a half-float target and a depth texture.
    // Long-exposure stacking needs a composer, so a low boot takes the lean chain while it is on.
    /** The post chain a tier actually gets (see above). Called on tier and Expose changes only. */
    function chainCfg(c) {
        if (c.composer || postfxFailed || (createdLow && !accumWanted)) return c;
        return { ...c, composer: true, msaa: 0, bloom: null, finalPass: true };
    }

    const maxBuffer = Math.max(1024, Math.min(
        renderer.capabilities?.maxTextureSize || 4096,
        (() => { try { return renderer.getContext().getParameter(renderer.getContext().MAX_RENDERBUFFER_SIZE) || 4096; } catch { return 4096; } })(),
    ));

    function targetDpr() {
        let d = Math.min(deviceDpr(), cfg.dprCap || 1);
        if (dprOverride != null) d = Math.min(d, dprOverride);
        // Never ask for a drawing buffer larger than the GPU can render into.
        const longest = Math.max(size.w, size.h, 1);
        d = Math.min(d, maxBuffer / longest);
        return Math.max(0.5, d);
    }

    function measure() {
        let w = canvas.clientWidth;
        let h = canvas.clientHeight;
        if (!(w > 0 && h > 0) && typeof window !== 'undefined') {
            w = window.innerWidth;
            h = window.innerHeight;
        }
        return { w: Math.max(1, Math.round(w || 1)), h: Math.max(1, Math.round(h || 1)) };
    }

    /** The tier supersamples when idle: a pass in a full composer chain (never the lean low one). */
    const ssWanted = (chain) => chain === cfg && !!chain.composer && chain.supersample > 1;

    function ensurePostFx() {
        const chain = chainCfg(cfg);
        if (chain.composer && !postfx) {
            try {
                postfx = createPostFx(renderer, scene, camera, chain, { w: size.w, h: size.h, dpr });
                if (accumWanted) postfx.setAccumulation(true);
                postfx.setSupersample(ssWanted(chain));
                postfx.setOverlay?.(overlay);
            } catch (err) {
                // A broken composer must not blank the screen: render directly instead.
                console.warn('Planet Location Marker: post-processing unavailable, rendering directly.', err);
                postfx = null;
            }
        } else if (!chain.composer && postfx) {
            postfx.dispose();
            postfx = null;
        }
        return chain;
    }

    /** Re-reads the canvas size and DPR; cheap no-op when nothing changed. */
    function resize() {
        if (disposed) return;
        // A video session owns the drawing buffer: apply the screen's size when it ends.
        if (session) {
            forceResize = true;
            return;
        }
        const m = measure();
        const changedSize = m.w !== size.w || m.h !== size.h;
        size.w = m.w;
        size.h = m.h;
        const nd = targetDpr();
        const changedDpr = nd !== dpr;
        dpr = nd;
        if (!changedSize && !changedDpr && !forceResize) return;
        forceResize = false;
        renderer.setPixelRatio(dpr);
        renderer.setSize(size.w, size.h, false);
        camera.aspect = size.w / size.h;
        camera.updateProjectionMatrix();
        postfx?.setSize(size.w, size.h, dpr);
        invalidate();
    }

    /** Marks the next frame dirty and notifies the loop. */
    function invalidate() {
        rc.dirty = true;
        for (const cb of invalidateCbs) {
            try { cb(); } catch { /* listeners must not break rendering */ }
        }
    }

    /**
     * Switches the tier in place: DPR, composer on/off, MSAA, bloom, final pass.
     * Modules are told separately (main calls module.setQuality(cfg)).
     * @param {object|string} next TierCfg or tier name
     */
    function setTier(next) {
        prepareTier(next);
        commitTier();
    }

    /**
     * A staged switch's first half (main.js, app/tier-switch.js): the tier's post chain (composer
     * on or off, MSAA, bloom, final pass, supersampling) at the current size. Nothing is resized or
     * presented, so compile() can warm the chain's variants before any frame draws them.
     * @param {object|string} next TierCfg or tier name
     */
    function prepareTier(next) {
        compileGen++;
        cfg = resolveTier(next);
        const chain = ensurePostFx();
        postfx?.setTier(chain);
        postfx?.setSupersample(ssWanted(chain));
        invalidate();
    }

    /**
     * Its second half: the tier's DPR and the composer sized to it. A resize clears the drawing
     * buffer, so the canvas is redrawn before the task ends (presentIfCleared).
     */
    function commitTier() {
        const gl = renderer.getContext();
        const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
        forceResize = true; // re-apply sizes to a freshly built composer
        resize();
        presentIfCleared(bw, bh);
        invalidate();
    }

    /**
     * Caps the pixel ratio below the tier's dprCap (governor step); null restores the tier cap.
     * @param {number|null} cap
     */
    function setDprCap(cap) {
        const gl = renderer.getContext();
        const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
        dprOverride = Number.isFinite(cap) && cap > 0 ? cap : null;
        resize();
        presentIfCleared(bw, bh);
    }

    /**
     * Resizing the drawing buffer clears it. The governor steps right after the loop has drawn a
     * frame, in the same task, so the browser would present that cleared buffer: a one-frame blank
     * flash. Redraw before the task ends instead; the microtask runs after the caller has also
     * applied the new tier to every module.
     * @param {number} bw drawing-buffer width before the change
     * @param {number} bh drawing-buffer height before the change
     */
    function presentIfCleared(bw, bh) {
        if (frames === 0 || presentQueued) return;
        const gl = renderer.getContext();
        if (gl.drawingBufferWidth === bw && gl.drawingBufferHeight === bh) return;
        presentQueued = true;
        queueMicrotask(() => {
            presentQueued = false;
            try { render(); } catch { /* the loop redraws on its next frame */ }
        });
    }

    /**
     * Sets the tone-mapping exposure (sky view darkens the daylight dome).
     * Accepts a number or {exposure}.
     * @param {number|{exposure:number}} e
     */
    function setExposure(e) {
        const v = typeof e === 'number' ? e : Number(e?.exposure ?? e?.value);
        if (!Number.isFinite(v) || v <= 0) return;
        if (Math.abs(renderer.toneMappingExposure - v) < 1e-4) return;
        renderer.toneMappingExposure = v;
        invalidate();
    }

    /**
     * Night-vision grade strength (postfx FinalPass uScotopic), 0…1. A no-op on the direct path
     * (low tier): that grade needs the final pass.
     * @param {number} s
     */
    function setVision(s) {
        postfx?.setVision?.(s);
    }

    /**
     * Long-exposure stacking on or off (the Expose mode). On the low tier's direct path this
     * switches to the lean composer chain and back. Never per frame.
     * @param {boolean} on
     * @returns {boolean} true when stacking is active (false: no post chain could be built)
     */
    function setAccumulation(on) {
        const want = !!on;
        if (want === accumWanted && (!want || postfx?.accum)) return !!postfx?.accum;
        accumWanted = want;
        const had = postfx;
        ensurePostFx();
        if (postfx && postfx === had) postfx.setAccumulation(want);
        if (postfx !== had && session) {
            // A new chain inside a video session takes the session's size (resize() waits for its end).
            postfx?.setCapture(true, session.opts);
            postfx?.setSize(session.cw, session.ch, session.s);
        } else if (postfx !== had) {
            forceResize = true;
            resize();
        }
        invalidate();
        return !!postfx?.accum;
    }

    /**
     * Renders one frame at `w`×`h` device pixels and hands the canvas to `read`, all in one task:
     * the drawing buffer is not preserved (preserveDrawingBuffer: false), so it must be read before
     * the task yields, and because the screen size is restored and redrawn before returning, the
     * capture is never presented and nothing flashes. `scale` is the capture's pixel ratio (its CSS
     * size is w/scale × h/scale), which sizes lines, points and labels as on a screen of that
     * density. The camera keeps its pose; its vertical field is set so the capture's shorter side
     * spans the same angle as the screen's shorter side, and the UI's view offset is replaced by the
     * capture's own `insetBottom` (CSS px kept for a caption band: the view centres above it, as the
     * rig centres it beside the UI). `rc.size` (w, h, insets) describes the capture meanwhile. A
     * stack (Expose) is kept and bypassed. At the screen's own size nothing is resized and the frame
     * is the screen's.
     * `draw()` runs the module updates and rc.render() (loop.redraw), once for the capture and once
     * after the restore.
     * @param {number} w device px
     * @param {number} h device px
     * @param {number} scale capture pixel ratio (> 0)
     * @param {()=>void} draw
     * @param {(canvas:HTMLCanvasElement, info:{cssW:number, cssH:number, scale:number, camera:THREE.PerspectiveCamera})=>void} read
     * @param {{insetBottom?:number}} [opts]
     * @returns {boolean} false when nothing could be captured (context lost, disposed)
     */
    function capture(w, h, scale, draw, read, opts) {
        if (lost || disposed || session) return false;
        const gl = renderer.getContext();
        const W = Math.max(16, Math.min(maxBuffer, Math.round(w)));
        const H = Math.max(16, Math.min(maxBuffer, Math.round(h)));
        if (W === gl.drawingBufferWidth && H === gl.drawingBufferHeight) {
            draw();
            read(renderer.domElement, { cssW: size.w, cssH: size.h, scale: dpr, camera });
            return true;
        }
        beginCapture(W, H, scale, opts);
        try {
            captureCamera();
            draw();
            read(renderer.domElement, { cssW: size.w, cssH: size.h, scale: session.s, camera });
        } finally {
            endCapture();
            // The resize cleared the drawing buffer: draw the screen frame before the task ends.
            try { draw(); } catch { /* the loop redraws on its next frame */ }
            invalidate();
        }
        return true;
    }

    /**
     * Starts a video session: the drawing buffer, the composer and `rc.size` take the capture's size
     * (as capture() does for one frame) until endCapture(); `scale` is its pixel ratio and
     * `opts.insetBottom` its caption band (CSS px). Screen resizes wait. `opts.stack` keeps a long
     * exposure stacking at the capture's size (postfx setCapture).
     * @param {number} w device px
     * @param {number} h device px
     * @param {number} scale capture pixel ratio
     * @param {{insetBottom?:number, stack?:boolean}} [opts]
     * @returns {boolean} false when the context is lost, disposed or a session runs
     */
    function beginCapture(w, h, scale, opts) {
        if (lost || disposed || session) return false;
        const W = Math.max(16, Math.min(maxBuffer, Math.round(w)));
        const H = Math.max(16, Math.min(maxBuffer, Math.round(h)));
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
        // CSS sizes whose product with s floors to exactly W and H.
        const cw = (W + 0.25) / s, ch = (H + 0.25) / s;
        session = {
            s, cw, ch, opts: { stack: !!opts?.stack }, inset: Math.min(ch * 0.6, Math.max(0, Number(opts?.insetBottom) || 0)), rigFov: NaN, view: null,
            w: size.w, h: size.h, aspect: camera.aspect,
            l: size.insets.left, r: size.insets.right, t: size.insets.top, b: size.insets.bottom,
        };
        renderer.setPixelRatio(s);
        renderer.setSize(cw, ch, false);
        postfx?.setCapture(true, opts);
        postfx?.setSize(cw, ch, s);
        size.w = cw;
        size.h = ch;
        size.insets.left = size.insets.right = size.insets.top = 0;
        size.insets.bottom = session.inset;
        return true;
    }

    /**
     * Gives the camera the session's projection, from the field the rig set: the screen's shorter
     * side → the capture's shorter side, the capture's aspect and its own view offset (the caption
     * band). releaseCamera() hands the rig its own values back.
     */
    function captureCamera() {
        if (!session || Number.isFinite(session.rigFov)) return;
        const v = camera.view && camera.view.enabled ? camera.view : null;
        session.rigFov = camera.fov;
        session.view = v ? [v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height] : null;
        const tanV = Math.tan((camera.fov * Math.PI) / 360);
        const tanShort = Math.min(tanV, tanV * session.aspect);
        const aspect = session.cw / session.ch;
        const tanV2 = aspect >= 1 ? tanShort : tanShort / aspect;
        // Capped: a story card from a wide desktop sky view would otherwise stretch past 120°.
        camera.fov = Math.min(110, (Math.atan(tanV2) * 360) / Math.PI);
        camera.aspect = aspect;
        if (session.inset > 0.5) camera.setViewOffset(session.cw, session.ch, 0, session.inset / 2, session.cw, session.ch);
        else camera.clearViewOffset();
        camera.updateProjectionMatrix();
    }

    /** Hands the rig its own field, aspect and view offset back (after a session frame's draw). */
    function releaseCamera() {
        if (!session || !Number.isFinite(session.rigFov)) return;
        camera.fov = session.rigFov;
        camera.aspect = session.aspect;
        const v = session.view;
        if (v) camera.setViewOffset(v[0], v[1], v[2], v[3], v[4], v[5]);
        else camera.clearViewOffset();
        camera.updateProjectionMatrix();
        session.rigFov = NaN;
    }

    /** Ends a video session: the screen's size, insets and composer come back (not yet redrawn). */
    function endCapture() {
        if (!session) return;
        releaseCamera();
        const sv = session;
        session = null;
        size.w = sv.w;
        size.h = sv.h;
        size.insets.left = sv.l;
        size.insets.right = sv.r;
        size.insets.top = sv.t;
        size.insets.bottom = sv.b;
        renderer.setPixelRatio(dpr);
        renderer.setSize(size.w, size.h, false);
        postfx?.setSize(size.w, size.h, dpr);
        postfx?.setCapture(false);
        if (forceResize) resize();
        invalidate();
    }

    /**
     * Registers (or with null clears) the overlay scene drawn after the main one; see the module notes.
     * @param {THREE.Scene|null} sceneO
     * @param {THREE.Camera|null} cameraO
     */
    function setOverlay(sceneO, cameraO) {
        overlay = sceneO && cameraO ? { scene: sceneO, camera: cameraO } : null;
        postfx?.setOverlay?.(overlay);
        invalidate();
    }

    /** The direct path's overlay: over the main scene, its depth cleared. */
    function renderOverlay() {
        if (!overlay || !overlay.scene.visible) return;
        const ac = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(overlay.scene, overlay.camera);
        renderer.autoClear = ac;
    }

    /**
     * Renders one frame (composer or direct). Never throws. `ss` ({x, y, weight}: jitter in device
     * px and blend weight, core/sampling.js) makes it an idle-supersampling sample when the chain has
     * the pass; otherwise it is ignored. A shown overlay (the orrery) takes the same jitter, so its
     * lines and sprites join the running mean in register with the globe.
     * @param {{x:number, y:number, weight:number}|null} [ss]
     */
    function render(ss) {
        if (lost || disposed) return;
        renderer.info.reset();
        const jitter = ss && postfx?.supersample && !postfx.accum ? ss : null;
        const e = camera.projectionMatrix.elements;
        const e8 = e[8], e9 = e[9];
        const oe = jitter && overlay && overlay.scene.visible ? overlay.camera.projectionMatrix.elements : null;
        const o8 = oe ? oe[8] : 0, o9 = oe ? oe[9] : 0;
        try {
            if (jitter) {
                // ndc.x = … − e8 (clip.w = −z): shifting by x px takes e8 − 2x/W.
                const gl = renderer.getContext();
                const jx = (2 * jitter.x) / Math.max(1, gl.drawingBufferWidth);
                const jy = (2 * jitter.y) / Math.max(1, gl.drawingBufferHeight);
                e[8] = e8 - jx;
                e[9] = e9 - jy;
                if (oe) {
                    oe[8] = o8 - jx;
                    oe[9] = o9 - jy;
                }
            }
            if (postfx) postfx.render(jitter);
            else {
                renderer.render(scene, camera);
                renderOverlay();
            }
        } catch (err) {
            if (postfx) {
                // Fall back to direct rendering for the rest of the session.
                console.warn('Planet Location Marker: post-processing failed, rendering directly.', err);
                try { postfx.dispose(); } catch { /* ignore */ }
                postfx = null;
                postfxFailed = true;
                cfg = { ...cfg, composer: false };
                renderer.render(scene, camera);
                renderOverlay();
            } else {
                throw err;
            }
        } finally {
            if (jitter) {
                e[8] = e8;
                e[9] = e9;
            }
            if (oe) {
                oe[8] = o8;
                oe[9] = o9;
            }
        }
        rc.dirty = false;
        frames++;
    }

    /** Stand-in for a full-screen quad, to compile the post chain's pass materials (never drawn). */
    let quad = null;
    /** Bumped by each paced compile and each staged tier: a paced compile still running stops. */
    let compileGen = 0;
    function passQuad() {
        if (!quad) {
            const mesh = new THREE.Mesh(new THREE.BufferGeometry());
            quad = { mesh, basic: mesh.material, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
        }
        return quad;
    }

    /**
     * What compile() covers, as [root, camera, scene, toCanvas, …]: the scene (and the overlay) drawn
     * into the post chain's input target (the canvas on the direct path), then each pass material
     * (postfx passMaterials) on the stand-in quad, which is the root and the scene in one.
     * @param {boolean} perObject one entry per object with a material instead of one per scene
     */
    function compileUnits(perObject) {
        const units = [];
        const toCanvas = !postfx?.inputTarget;
        const scenes = overlay ? [[scene, camera], [overlay.scene, overlay.camera]] : [[scene, camera]];
        for (const [sc, cam] of scenes) {
            if (!perObject) units.push(sc, cam, sc, toCanvas);
            else sc.traverse((o) => { if (o.material) units.push(o, cam, sc, toCanvas); });
        }
        const pass = postfx?.passMaterials?.() ?? [];
        for (let i = 0; i < pass.length; i += 2) units.push(pass[i], null, null, pass[i + 1]);
        return units;
    }

    /** renderer.compile for one unit at its target; a material unit compiles on the stand-in quad. */
    function compileUnit(units, i, run) {
        const prev = renderer.getRenderTarget();
        const q = units[i + 1] ? null : passQuad();
        try {
            renderer.setRenderTarget(units[i + 3] ? null : postfx?.inputTarget ?? null);
            if (q) {
                q.mesh.material = units[i];
                return run(q.mesh, q.camera, q.mesh);
            }
            return run(units[i], units[i + 1], units[i + 2]);
        } catch {
            return null; // compile errors surface at first render
        } finally {
            if (q) q.mesh.material = q.basic;
            renderer.setRenderTarget(prev);
        }
    }

    /**
     * Compiles every material for the variant actually drawn (composer target vs. canvas),
     * including objects that are currently hidden, so entering sky view or toggling a layer does not
     * hitch, and the post chain's pass materials (bloom, supersampling, stacking, the final pass).
     * With KHR_parallel_shader_compile everything compiles at once off the main thread. Without it
     * the programs link on first use, in the first frame (boot), or with `paced` (tier switches)
     * here, one new program per task: each is issued alone and linked before the next, so the
     * main thread waits for one link at a time instead of for the whole batch at once.
     * Resolves early when the context is lost.
     * @param {{paced?:boolean}} [opts]
     * @returns {Promise<void>} never rejects
     */
    async function compile({ paced = false } = {}) {
        if (lost || disposed) return;
        const parallel = !!renderer.extensions?.has?.('KHR_parallel_shader_compile');
        let offLost = null;
        const lostP = new Promise((resolve) => { offLost = onContextLost(() => resolve()); });
        try {
            await Promise.race([lostP, paced && !parallel ? compilePaced() : compileAll(parallel)]);
        } catch { /* compile errors surface at first render */ }
        offLost();
        invalidate();
    }

    function compileAll(parallel) {
        const hidden = [];
        const scenes = overlay ? [scene, overlay.scene] : [scene];
        for (const sc of scenes) sc.traverse((o) => { if (o.visible === false) { hidden.push(o); o.visible = true; } });
        const run = (root, cam, sc) => (parallel && typeof renderer.compileAsync === 'function'
            ? renderer.compileAsync(root, cam, sc)
            : (renderer.compile(root, cam, sc), null));
        const pending = [];
        try {
            const units = compileUnits(false);
            for (let i = 0; i < units.length; i += 4) pending.push(compileUnit(units, i, run));
        } finally {
            for (const o of hidden) o.visible = false;
        }
        return Promise.all(pending);
    }

    async function compilePaced() {
        const gl = renderer.getContext();
        const programs = renderer.info.programs;
        const run = (root, cam, sc) => renderer.compile(root, cam, sc);
        const gen = ++compileGen;
        const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));
        // Not in the task that asked for the tier (a click, a governor step): it has staged it.
        await nextTask();
        const units = compileUnits(true);
        let t0 = performance.now();
        for (let i = 0; i < units.length; i += 4) {
            // Lost, or a newer tier staged meanwhile (its chain may have disposed these materials).
            if (lost || disposed || gen !== compileGen) return;
            const n0 = programs ? programs.length : 0;
            compileUnit(units, i, run);
            const fresh = programs ? programs.length > n0 : false;
            // Wait for this link alone (nothing else is queued), then let the main thread breathe.
            if (fresh) for (let k = n0; k < programs.length; k++) gl.getProgramParameter(programs[k].program, gl.LINK_STATUS);
            if (fresh || performance.now() - t0 > 8) {
                await nextTask();
                t0 = performance.now();
            }
        }
    }

    function onContextLost(cb) {
        lostCbs.add(cb);
        return () => lostCbs.delete(cb);
    }

    function onContextRestored(cb) {
        restoredCbs.add(cb);
        return () => restoredCbs.delete(cb);
    }

    function onInvalidate(cb) {
        invalidateCbs.add(cb);
        return () => invalidateCbs.delete(cb);
    }

    /** @returns {{drawCalls:number, triangles:number, points:number, lines:number, geometries:number, textures:number, programs:number, frames:number}} */
    function stats() {
        const info = renderer.info;
        return {
            drawCalls: info.render.calls,
            triangles: info.render.triangles,
            points: info.render.points,
            lines: info.render.lines,
            geometries: info.memory.geometries,
            textures: info.memory.textures,
            programs: info.programs ? info.programs.length : 0,
            frames,
        };
    }

    function dispose() {
        if (disposed) return;
        for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
        postfx?.dispose();
        postfx = null;
        quad?.mesh.geometry.dispose();
        quad?.basic.dispose();
        renderer.dispose();
        disposed = true;
    }

    // ---- context loss -------------------------------------------------------------------------
    const onLost = (e) => {
        e.preventDefault(); // allows the browser to restore the context
        lost = true;
        for (const cb of lostCbs) { try { cb(e); } catch { /* ignore */ } }
    };
    const onRestored = () => {
        lost = false;
        // three re-creates GL state lazily; rebuild the composer targets explicitly. Its own
        // restore listener (added with the renderer, so it runs first) has already reset its GL
        // bookkeeping: the old composer's framebuffers, textures and vertex arrays died with the
        // lost context, and dispose() would delete them on the new one (INVALID_OPERATION, one
        // warning each). Drop it unreleased instead.
        postfx = null;
        ensurePostFx();
        forceResize = true;
        resize();
        for (const cb of restoredCbs) { try { cb(); } catch { /* ignore */ } }
        invalidate();
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
    cleanups.push(() => {
        canvas.removeEventListener('webglcontextlost', onLost, false);
        canvas.removeEventListener('webglcontextrestored', onRestored, false);
    });

    // ---- automatic resize: element size, window size, and DPR changes (monitor moves) --------
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => resize());
        ro.observe(canvas);
        cleanups.push(() => ro.disconnect());
    }
    if (typeof window !== 'undefined') {
        const onWin = () => resize();
        window.addEventListener('resize', onWin);
        cleanups.push(() => window.removeEventListener('resize', onWin));
        let mq = null;
        const watchDpr = () => {
            try {
                mq?.removeEventListener('change', onDpr);
                mq = window.matchMedia(`(resolution: ${deviceDpr()}dppx)`);
                mq.addEventListener('change', onDpr);
            } catch { /* matchMedia unsupported */ }
        };
        const onDpr = () => { resize(); watchDpr(); };
        watchDpr();
        cleanups.push(() => { try { mq?.removeEventListener('change', onDpr); } catch { /* ignore */ } });
    }

    const rc = {
        THREE,
        renderer,
        scene,
        camera,
        size,
        dirty: true,
        /** Current TierCfg. */
        get tier() { return cfg; },
        /** Current pixel ratio. */
        get dpr() { return dpr; },
        /** True between webglcontextlost and webglcontextrestored. */
        get lost() { return lost; },
        /** Active post-processing chain, or null on the direct (low tier) path. */
        get postfx() { return postfx; },
        /** The long-exposure stacking pass while Expose is on (render/accum.js), else null. */
        get accum() { return postfx?.accum ?? null; },
        /** True when render(ss) can supersample: the tier wants it, the chain has the pass, no Expose. */
        get supersampling() { return !!postfx?.supersample && !postfx.accum; },
        /** True during a video session (beginCapture … endCapture). */
        get capturing() { return session !== null; },
        invalidate,
        setAccumulation,
        setOverlay,
        capture,
        beginCapture,
        captureCamera,
        releaseCamera,
        endCapture,
        onInvalidate,
        setTier,
        prepareTier,
        commitTier,
        setDprCap,
        setExposure,
        setVision,
        resize,
        render,
        compile,
        onContextLost,
        onContextRestored,
        stats,
        dispose,
    };

    dpr = targetDpr();
    ensurePostFx();
    resize();
    return rc;
}
