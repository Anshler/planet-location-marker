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
 * (postcards, the exposure's 'Save image'); see capture() below.
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
    }),
    medium: Object.freeze({
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4,
        bloom: Object.freeze({ strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 }),
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'roughness2k', clouds: 'clouds2k', cloudShadows: false,
        bump: false, atmosphere: 'analytic', atmoSteps: 0, starMagLimit: 6.0, flare: true, labelCap: 24, twinkle: false,
        beamGlowPx: 12, finalPass: true,
    }),
    high: Object.freeze({
        name: 'high', dprCap: 2.0, composer: true, msaa: 4,
        bloom: Object.freeze({ strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 }),
        earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', cloudShadows: true,
        bump: true, atmosphere: 'raymarch', atmoSteps: 8, starMagLimit: 6.5, flare: true, labelCap: 40, twinkle: true,
        beamGlowPx: 14, finalPass: true,
    }),
    max: Object.freeze({
        name: 'max', dprCap: Infinity, composer: true, msaa: 16,
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
    const lostCbs = new Set();
    const restoredCbs = new Set();
    const invalidateCbs = new Set();
    const cleanups = [];
    let disposed = false;

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

    function ensurePostFx() {
        const chain = chainCfg(cfg);
        if (chain.composer && !postfx) {
            try {
                postfx = createPostFx(renderer, scene, camera, chain, { w: size.w, h: size.h, dpr });
                if (accumWanted) postfx.setAccumulation(true);
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
        const gl = renderer.getContext();
        const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
        cfg = resolveTier(next);
        const chain = ensurePostFx();
        postfx?.setTier(chain);
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
        if (postfx !== had) {
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
        if (lost || disposed) return false;
        const gl = renderer.getContext();
        const W = Math.max(16, Math.min(maxBuffer, Math.round(w)));
        const H = Math.max(16, Math.min(maxBuffer, Math.round(h)));
        if (W === gl.drawingBufferWidth && H === gl.drawingBufferHeight) {
            draw();
            read(renderer.domElement, { cssW: size.w, cssH: size.h, scale: dpr, camera });
            return true;
        }
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
        // CSS sizes whose product with s floors to exactly W and H.
        const cw = (W + 0.25) / s, ch = (H + 0.25) / s;
        const saved = {
            w: size.w, h: size.h, fov: camera.fov, aspect: camera.aspect,
            view: camera.view && camera.view.enabled ? { ...camera.view } : null,
            l: size.insets.left, r: size.insets.right, t: size.insets.top, b: size.insets.bottom,
        };
        // The screen's shorter side → the capture's shorter side.
        const tanV = Math.tan((saved.fov * Math.PI) / 360);
        const tanShort = Math.min(tanV, tanV * saved.aspect);
        const aspect = cw / ch;
        const tanV2 = aspect >= 1 ? tanShort : tanShort / aspect;
        // Capped: a story card from a wide desktop sky view would otherwise stretch past 120°.
        const fov = Math.min(110, (Math.atan(tanV2) * 360) / Math.PI);
        try {
            renderer.setPixelRatio(s);
            renderer.setSize(cw, ch, false);
            postfx?.setCapture(true);
            postfx?.setSize(cw, ch, s);
            const inset = Math.min(ch * 0.6, Math.max(0, Number(opts?.insetBottom) || 0));
            size.w = cw;
            size.h = ch;
            size.insets.left = size.insets.right = size.insets.top = 0;
            size.insets.bottom = inset;
            camera.fov = fov;
            camera.aspect = aspect;
            if (inset > 0.5) camera.setViewOffset(cw, ch, 0, inset / 2, cw, ch);
            else camera.clearViewOffset();
            camera.updateProjectionMatrix();
            draw();
            read(renderer.domElement, { cssW: cw, cssH: ch, scale: s, camera });
        } finally {
            size.w = saved.w;
            size.h = saved.h;
            size.insets.left = saved.l;
            size.insets.right = saved.r;
            size.insets.top = saved.t;
            size.insets.bottom = saved.b;
            renderer.setPixelRatio(dpr);
            renderer.setSize(size.w, size.h, false);
            postfx?.setSize(size.w, size.h, dpr);
            postfx?.setCapture(false);
            camera.fov = saved.fov;
            camera.aspect = saved.aspect;
            const v = saved.view;
            if (v) camera.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
            else camera.clearViewOffset();
            camera.updateProjectionMatrix();
            // The resize cleared the drawing buffer: draw the screen frame before the task ends.
            try { draw(); } catch { /* the loop redraws on its next frame */ }
            invalidate();
        }
        return true;
    }

    /** Renders one frame (composer or direct). Never throws. */
    function render() {
        if (lost || disposed) return;
        renderer.info.reset();
        try {
            if (postfx) postfx.render();
            else renderer.render(scene, camera);
        } catch (err) {
            if (postfx) {
                // Fall back to direct rendering for the rest of the session.
                console.warn('Planet Location Marker: post-processing failed, rendering directly.', err);
                try { postfx.dispose(); } catch { /* ignore */ }
                postfx = null;
                postfxFailed = true;
                cfg = { ...cfg, composer: false };
                renderer.render(scene, camera);
            } else {
                throw err;
            }
        }
        rc.dirty = false;
        frames++;
    }

    /**
     * Compiles every material in the scene for the variant actually used
     * (composer target vs. canvas), including objects that are currently
     * hidden, so entering sky view or toggling a layer does not hitch.
     * @returns {Promise<void>} never rejects
     */
    async function compile() {
        if (lost || disposed) return;
        const hidden = [];
        scene.traverse((o) => { if (o.visible === false) { hidden.push(o); o.visible = true; } });
        const prevTarget = renderer.getRenderTarget();
        let pending = null;
        try {
            if (postfx?.inputTarget) renderer.setRenderTarget(postfx.inputTarget);
            pending = typeof renderer.compileAsync === 'function'
                ? renderer.compileAsync(scene, camera)
                : (renderer.compile(scene, camera), null);
        } catch {
            pending = null;
        } finally {
            renderer.setRenderTarget(prevTarget);
            for (const o of hidden) o.visible = false;
        }
        try { await pending; } catch { /* compile errors surface at first render */ }
        invalidate();
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
        invalidate,
        setAccumulation,
        capture,
        onInvalidate,
        setTier,
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
