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
 * @type {Record<'low'|'medium'|'high', object>}
 */
export const FALLBACK_TIERS = Object.freeze({
    low: Object.freeze({
        name: 'low', dprCap: 1.0, composer: false, msaa: 0, bloom: null, earthSegments: [64, 32], dayTex: 'day2k',
        oceanMask: 'derived', clouds: 'none', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0,
        starMagLimit: 5.0, flare: false, labelCap: 12, twinkle: false, beamGlowPx: 8, finalPass: false,
    }),
    medium: Object.freeze({
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4,
        bloom: Object.freeze({ strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 }),
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'specular', clouds: 'clouds1k', cloudShadows: false,
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
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: cfg.name === 'low',
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
    const lostCbs = new Set();
    const restoredCbs = new Set();
    const invalidateCbs = new Set();
    const cleanups = [];
    let disposed = false;

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
        if (cfg.composer && !postfx) {
            try {
                postfx = createPostFx(renderer, scene, camera, cfg, { w: size.w, h: size.h, dpr });
            } catch (err) {
                // A broken composer must not blank the screen: render directly instead.
                console.warn('Planet Location Marker: post-processing unavailable, rendering directly.', err);
                postfx = null;
            }
        } else if (!cfg.composer && postfx) {
            postfx.dispose();
            postfx = null;
        }
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
        ensurePostFx();
        postfx?.setTier(cfg);
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
        // three re-creates GL state lazily; rebuild the composer targets explicitly.
        if (postfx) {
            try { postfx.dispose(); } catch { /* ignore */ }
            postfx = null;
        }
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
        invalidate,
        onInvalidate,
        setTier,
        setDprCap,
        setExposure,
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
