// Frame loop and render-on-demand (SPEC §E.7).
//
//   frame(now): dt = min(now − last, 100)
//     t = clock.tick(now)
//     snapshot ('frame' detail) when the observer changed, the clock jumped or sim time moved ≥ 0.5 s
//         → every module.apply(snap)
//     readout ('full' detail) at most every 250 ms when sim time or the observer changed → bus 'readout'
//     moving = rig.update(dt, snap)
//     render when something is dirty or continuously animating (camera motion, tweens, time-lapse,
//     intro, pointer held, twinkle in sky view): module.update(fi) → rc.render() → labels
//     governor.sample(dt) on consecutive rendered frames only
//
// Live 1× therefore redraws about twice a second; a paused, idle app draws nothing. The loop stops
// on visibilitychange:hidden and resumes dirty.
//
// Robustness: every module call is guarded. A module that throws three times is switched off
// (object3d hidden, one toast) instead of taking the frame down. A renderer that keeps throwing
// hands over to text mode through `onRenderFailure`.
//
// The loop also runs headless (no render context yet, or text mode): it then only ticks the
// clock and publishes the 4 Hz readout that drives the panels. `attach()` adds the render stack
// once it exists.
//
// Allocation: the per-frame path reuses one FrameInfo, one exposure object, frozen option objects
// and indexed loops (R5).

import { createSnapshot, computeSnapshot } from '../astro/snapshot.js';
import { exposureFor } from '../astro/photometry.js';

/** Recompute the 'frame' snapshot when simulated time has moved this far (ms). */
export const SNAP_STALE_MS = 500;
/** Readout period (ms): the panels refresh at 4 Hz. */
export const FULL_INTERVAL_MS = 250;
/** Frame dt cap (ms): long gaps (tab switches, hitches) never produce giant steps. */
export const MAX_DT_MS = 100;
/** Failures before a module is switched off. */
export const STRIKES_TO_DISABLE = 3;
/** Orbit view keeps the globe uncluttered: at most this many labels, whatever the tier allows. */
export const ORBIT_LABEL_CAP = 18;

const OPT_FRAME = Object.freeze({ detail: 'frame' });
const OPT_FULL = Object.freeze({ detail: 'full' });

/** Human names for strike toasts. */
const FEATURE_NAMES = Object.freeze({
    earth: 'The Earth surface',
    atmosphere: 'The atmosphere glow',
    sky: 'The star field',
    bodies: 'The Sun, Moon and planet markers',
    ground: 'The sky-view ground',
    trails: 'Planet paths',
    beams: 'The beams',
    pin: 'The location pin',
    flare: 'The lens flare',
    labels: 'Sky labels',
    rig: 'Camera motion',
    debug: 'The debug overlay',
});

/**
 * @typedef {import('../core/types.js').Snapshot} Snapshot
 * @typedef {import('../core/types.js').FrameInfo} FrameInfo
 * @typedef {import('../core/types.js').RenderModule} RenderModule
 */

/**
 * Creates the frame loop.
 *
 * @param {{clock:any, store:any, bus:any,
 *          rc?:any, rig?:any, modules?:RenderModule[], moduleNames?:Map<RenderModule,string>,
 *          labels?:any, labelsFeed?:any, governor?:any, getTierCfg?:()=>any,
 *          snap?:Snapshot, snapFull?:Snapshot,
 *          onApply?:(snap:Snapshot)=>void, onGovernor?:(result:any)=>void, onRenderFailure?:(err:unknown)=>void,
 *          win?:Window, doc?:Document}} deps
 *   `rc`…`getTierCfg` may be omitted here and supplied later through `attach()`.
 * @returns {{start():void, stop():void, invalidate():void, snap:Snapshot, snapFull:Snapshot,
 *            attach(renderDeps:object):void, broadcast(method:string, a?:any, b?:any):void,
 *            callModule(m:RenderModule, method:string, a?:any, b?:any, c?:any):boolean, isDisabled(m:RenderModule):boolean,
 *            replaceModule(prev:RenderModule|null, next:RenderModule, name?:string):void,
 *            setDebug(overlay:any):void, setRenderPaused(paused:boolean):void, refreshReadout():void,
 *            stats():object, dispose():void, readonly running:boolean, readonly rendering:boolean}}
 */
export function createLoop(deps) {
    const { clock, store, bus } = deps;
    const win = deps.win ?? (typeof window !== 'undefined' ? window : null);
    const doc = deps.doc ?? (typeof document !== 'undefined' ? document : null);
    const raf = win?.requestAnimationFrame?.bind(win) ?? ((fn) => setTimeout(() => fn(performance.now()), 16));
    const caf = win?.cancelAnimationFrame?.bind(win) ?? clearTimeout;

    const snap = deps.snap ?? createSnapshot();
    const snapFull = deps.snapFull ?? createSnapshot();

    // Render stack (attached later in the normal boot).
    let rc = null;
    let rig = null;
    /** @type {RenderModule[]} */
    let modules = [];
    /** @type {Map<RenderModule,string>} */
    const names = new Map();
    let labels = null;
    let labelsFeed = null;
    let governor = null;
    let getTierCfg = () => null;
    let debug = null;
    const hooks = {
        onApply: deps.onApply ?? null,
        onGovernor: deps.onGovernor ?? null,
        onRenderFailure: deps.onRenderFailure ?? null,
    };

    // Loop state.
    let running = false;
    let handle = 0;
    let last = 0;
    let dirty = true;
    let observerDirty = true;
    let jumped = true;
    let snapValid = false;
    let fullValid = false;
    let lastFull = -Infinity;
    let fullT = NaN;
    let renderedLastFrame = false;
    let renderPaused = false;
    let renderFailed = false;
    let renderStrikes = 0;
    let introPlaying = !!store.get().status?.introPlaying;
    let reducedMotion = !!store.get().status?.reducedMotion;
    let lastMode = '';
    let lastSkyBlend = -1;
    const pointers = new Set();

    // Strikes.
    /** @type {Map<object, number>} */
    const strikes = new Map();
    /** @type {Set<object>} */
    const disabled = new Set();
    const reported = new Set();

    // Stats.
    let frames = 0;
    let fps = 0;
    let fpsWindowStart = 0;
    let fpsWindowFrames = 0;
    let lastRenderMs = 0;

    // Preallocated per-frame objects.
    const exposure = { stars: 1, planets: 1, milkyWay: 1 };
    let expSunAlt = NaN;
    let expBlend = NaN;
    /** @type {FrameInfo} */
    const fi = {
        dtMs: 0, timeS: 0, camera: null, viewMode: 'orbit', skyBlend: 0, snap,
        pulsesActive: false, exposure,
    };
    // upS is the snapshot's live zenith: the label pool derives is-below for direction anchors from it,
    // and in sky view (horizon) hides star and constellation names that the ground covers.
    const labelOpts = { cap: 24, upS: snap.observer.upS, horizon: false };

    const offs = [];
    offs.push(store.subscribe((s) => s.observer, () => { observerDirty = true; dirty = true; }));
    offs.push(store.subscribe((s) => s.status.introPlaying, (v) => { introPlaying = !!v; dirty = true; }));
    offs.push(store.subscribe((s) => s.status.reducedMotion, (v) => { reducedMotion = !!v; dirty = true; }));
    // Any other state change may alter what is drawn (layers, selection, view, quality, ui).
    offs.push(store.subscribe(null, () => { dirty = true; }));
    offs.push(clock.onChange((ev) => {
        if (ev && ev.type !== 'play' && ev.type !== 'pause' && ev.type !== 'rate') jumped = true;
        dirty = true;
    }));

    /** Logs a non-module failure once per key (keeps the console readable under a persistent fault). */
    function reportOnce(key, err) {
        if (reported.has(key)) return;
        reported.add(key);
        console.error(`[loop] ${key} failed`, err);
    }

    function nameOf(m) {
        return names.get(m) ?? 'module';
    }

    function disable(m) {
        if (disabled.has(m)) return;
        disabled.add(m);
        const name = nameOf(m);
        try {
            if (m && m.object3d) m.object3d.visible = false;
        } catch { /* best effort */ }
        if (m === labels) {
            try { labels.dispose?.(); } catch { /* ignore */ }
        }
        bus.emit('toast', { message: `${FEATURE_NAMES[name] ?? 'A visual feature'} was turned off after repeated errors.`, kind: 'warn' });
        dirty = true;
    }

    function strike(m, method, err) {
        const n = (strikes.get(m) ?? 0) + 1;
        strikes.set(m, n);
        console.error(`[loop] ${nameOf(m)}.${method} failed (${n}/${STRIKES_TO_DISABLE})`, err);
        if (n >= STRIKES_TO_DISABLE) disable(m);
    }

    /**
     * Calls `m[method](a, b, c)` if present, counting failures. Returns false when the module is
     * disabled or the call threw. Fixed arity (not rest args): this runs per module per frame.
     */
    function callModule(m, method, a, b, c) {
        if (!m || disabled.has(m)) return false;
        const fn = m[method];
        if (typeof fn !== 'function') return true;
        try {
            fn.call(m, a, b, c);
            return true;
        } catch (err) {
            strike(m, method, err);
            return false;
        }
    }

    function broadcast(method, a, b) {
        for (let i = 0; i < modules.length; i++) callModule(modules[i], method, a, b);
        dirty = true;
    }

    function updateExposure(sunAlt, skyBlend) {
        if (sunAlt === expSunAlt && skyBlend === expBlend) return;
        expSunAlt = sunAlt;
        expBlend = skyBlend;
        const r = exposureFor(sunAlt, skyBlend, exposure);
        if (r !== exposure && r) {
            exposure.stars = r.stars;
            exposure.planets = r.planets;
            exposure.milkyWay = r.milkyWay;
        }
    }

    function frame(now) {
        handle = 0;
        if (!running) return;
        const dt = last > 0 ? Math.min(Math.max(now - last, 0), MAX_DT_MS) : 1000 / 60;
        last = now;

        let t;
        try {
            t = clock.tick(now);
        } catch (err) {
            reportOnce('clock.tick', err);
            t = clock.tMs;
        }
        const obs = store.get().observer;
        const rendering = rc !== null && !renderPaused && !renderFailed;

        // 1. Frame-detail snapshot for the renderers.
        if (rendering && (observerDirty || jumped || !snapValid || Math.abs(t - snap.tMs) >= SNAP_STALE_MS)) {
            try {
                computeSnapshot(t, obs, snap, OPT_FRAME);
                snapValid = true;
                for (let i = 0; i < modules.length; i++) callModule(modules[i], 'apply', snap);
                if (hooks.onApply) hooks.onApply(snap);
            } catch (err) {
                reportOnce('computeSnapshot(frame)', err);
            }
            dirty = true;
        }

        // 2. Full-detail readout for the panels (4 Hz, only when something moved).
        if (now - lastFull >= FULL_INTERVAL_MS && (!fullValid || t !== fullT || observerDirty)) {
            try {
                computeSnapshot(t, obs, snapFull, OPT_FULL);
                fullValid = true;
                fullT = t;
                lastFull = now;
                bus.emit('readout', snapFull);
            } catch (err) {
                reportOnce('computeSnapshot(full)', err);
                lastFull = now;
            }
            if (!rendering && !snapValid) {
                // Headless: keep the frame snapshot meaningful for snapshot() consumers.
                try {
                    computeSnapshot(t, obs, snap, OPT_FRAME);
                    snapValid = true;
                } catch { /* reported above */ }
            }
        }
        observerDirty = false;
        jumped = false;

        if (rendering) {
            // 3. Camera.
            let moving = false;
            let mode = 'orbit';
            let skyBlend = 0;
            if (rig && !disabled.has(rig)) {
                try {
                    moving = !!rig.update(dt, snap);
                } catch (err) {
                    strike(rig, 'update', err);
                }
                mode = rig.mode === 'sky' ? 'sky' : 'orbit';
                skyBlend = Number.isFinite(rig.skyBlend) ? rig.skyBlend : (mode === 'sky' ? 1 : 0);
            }
            if (mode !== lastMode || skyBlend !== lastSkyBlend) {
                lastMode = mode;
                lastSkyBlend = skyBlend;
                for (let i = 0; i < modules.length; i++) callModule(modules[i], 'setViewMode', mode, skyBlend);
                dirty = true;
            }

            const cfg = getTierCfg();
            const twinkle = !!(cfg && cfg.twinkle) && skyBlend > 0.5 && !reducedMotion;
            const continuous = moving || !!(rig && rig.tweening) || clock.isAnimating() || introPlaying
                || pointers.size > 0 || twinkle;

            if (dirty || continuous) {
                // Cleared before the updates so a module that calls rc.invalidate() while animating
                // (texture swap, launch tween, reticle) gets the next frame too.
                dirty = false;
                const camera = (rig && rig.camera) || rc.camera;
                fi.dtMs = dt;
                fi.timeS = now / 1000;
                fi.camera = camera;
                fi.viewMode = mode;
                fi.skyBlend = skyBlend;
                fi.snap = snap;
                fi.pulsesActive = (clock.playing && Math.abs(clock.rate) > 1) || introPlaying;
                updateExposure(snap.observer.sunAltDeg, skyBlend);

                for (let i = 0; i < modules.length; i++) callModule(modules[i], 'update', fi);

                const r0 = performance.now();
                try {
                    rc.render();
                    renderStrikes = 0;
                } catch (err) {
                    renderStrikes++;
                    console.error(`[loop] render failed (${renderStrikes}/${STRIKES_TO_DISABLE})`, err);
                    if (renderStrikes >= STRIKES_TO_DISABLE) {
                        renderFailed = true;
                        if (hooks.onRenderFailure) {
                            try { hooks.onRenderFailure(err); } catch (e) { reportOnce('onRenderFailure', e); }
                        }
                    }
                }
                lastRenderMs = performance.now() - r0;

                if (labels && !disabled.has(labels)) {
                    try {
                        if (labelsFeed) labelsFeed.sync(camera, skyBlend >= 0.5 ? 'sky' : 'orbit');
                        const tierCap = cfg && Number.isFinite(cfg.labelCap) ? cfg.labelCap : 24;
                        labelOpts.cap = skyBlend >= 0.5 ? tierCap : Math.min(tierCap, ORBIT_LABEL_CAP);
                        labelOpts.horizon = skyBlend >= 0.5;
                        labels.update(camera, rc.size, labelOpts);
                    } catch (err) {
                        strike(labels, 'update', err);
                    }
                }
                if (debug && !disabled.has(debug)) {
                    try { debug.update(dt); } catch (err) { strike(debug, 'update', err); }
                }

                frames++;
                fpsWindowFrames++;
                if (fpsWindowStart === 0) fpsWindowStart = now;
                if (now - fpsWindowStart >= 1000) {
                    fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
                    fpsWindowStart = now;
                    fpsWindowFrames = 0;
                }

                if (renderedLastFrame && governor) {
                    let result = null;
                    try {
                        result = governor.sample(dt);
                    } catch (err) {
                        reportOnce('governor.sample', err);
                    }
                    if (result != null && hooks.onGovernor) hooks.onGovernor(result);
                }
                renderedLastFrame = true;
            } else {
                renderedLastFrame = false;
                if (fpsWindowStart !== 0 && now - fpsWindowStart >= 1000) {
                    fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
                    fpsWindowStart = now;
                    fpsWindowFrames = 0;
                }
            }
        }

        handle = raf(frame);
    }

    // Pointer tracking: a held pointer keeps frames flowing (OrbitControls damping, drags).
    let canvas = null;
    const onPointerDown = (e) => { pointers.add(e.pointerId); dirty = true; };
    const onPointerUp = (e) => { pointers.delete(e.pointerId); dirty = true; };
    const onWheel = () => { dirty = true; };
    const clearPointers = () => { pointers.clear(); };
    const onVisibility = () => {
        if (!doc) return;
        if (doc.visibilityState === 'hidden') {
            pause();
        } else if (wantRunning) {
            resume();
        }
    };

    let wantRunning = false;

    function resume() {
        if (running) return;
        running = true;
        last = 0;
        dirty = true;
        jumped = true;
        renderedLastFrame = false;
        handle = raf(frame);
    }

    function pause() {
        running = false;
        if (handle) caf(handle);
        handle = 0;
        pointers.clear();
    }

    if (doc) doc.addEventListener('visibilitychange', onVisibility);
    if (win) win.addEventListener('blur', clearPointers);

    /**
     * Supplies (or replaces) the render stack.
     * @param {{rc:any, rig?:any, modules?:RenderModule[], moduleNames?:Map<RenderModule,string>, labels?:any,
     *          labelsFeed?:any, governor?:any, getTierCfg?:()=>any}} r
     */
    function attach(r) {
        rc = r.rc ?? null;
        rig = r.rig ?? null;
        modules = Array.isArray(r.modules) ? r.modules.slice() : [];
        if (r.moduleNames) for (const [m, n] of r.moduleNames) names.set(m, n);
        if (rig) names.set(rig, 'rig');
        labels = r.labels ?? null;
        if (labels) names.set(labels, 'labels');
        labelsFeed = r.labelsFeed ?? null;
        governor = r.governor ?? null;
        if (typeof r.getTierCfg === 'function') getTierCfg = r.getTierCfg;
        if (canvas) {
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('wheel', onWheel);
        }
        canvas = rc?.renderer?.domElement ?? null;
        if (canvas) {
            canvas.addEventListener('pointerdown', onPointerDown);
            canvas.addEventListener('wheel', onWheel, { passive: true });
            win?.addEventListener('pointerup', onPointerUp);
            win?.addEventListener('pointercancel', onPointerUp);
        }
        snapValid = false;
        observerDirty = true;
        lastMode = '';
        lastSkyBlend = -1;
        dirty = true;
    }

    if (deps.rc) attach(deps);

    return {
        get snap() { return snap; },
        get snapFull() { return snapFull; },
        get running() { return running; },
        get rendering() { return rc !== null && !renderPaused && !renderFailed; },

        start() {
            wantRunning = true;
            if (doc && doc.visibilityState === 'hidden') return;
            resume();
        },
        stop() {
            wantRunning = false;
            pause();
        },
        /** Requests a redraw on the next animation frame. */
        invalidate() {
            dirty = true;
        },
        attach,
        broadcast,
        callModule,
        isDisabled(m) {
            return disabled.has(m);
        },
        /**
         * Swaps one module for another in place (same update order), e.g. a rebuilt module.
         * The caller handles scene membership.
         */
        replaceModule(prev, next, name) {
            const i = prev ? modules.indexOf(prev) : -1;
            if (i >= 0) modules[i] = next;
            else modules.push(next);
            if (name) names.set(next, name);
            snapValid = false;
            dirty = true;
        },
        /** Installs or removes the debug overlay (`{update(dtMs)}`). */
        setDebug(overlay) {
            debug = overlay ?? null;
            if (debug) names.set(debug, 'debug');
            dirty = true;
        },
        /** Context loss: keep ticking the clock and readouts, but stop drawing. */
        setRenderPaused(paused) {
            renderPaused = !!paused;
            renderedLastFrame = false;
            dirty = true;
            if (!paused) {
                snapValid = false;
                observerDirty = true;
            }
        },
        /** Forces a full readout on the next frame (e.g. right after the UI mounts). */
        refreshReadout() {
            fullValid = false;
            lastFull = -Infinity;
        },
        stats() {
            return {
                fps: Math.round(fps * 10) / 10,
                frames,
                renderMs: Math.round(lastRenderMs * 100) / 100,
                rendering: rc !== null && !renderPaused && !renderFailed,
                disabled: [...disabled].map(nameOf),
            };
        },
        dispose() {
            pause();
            wantRunning = false;
            for (const off of offs) off();
            if (doc) doc.removeEventListener('visibilitychange', onVisibility);
            if (win) {
                win.removeEventListener('blur', clearPointers);
                win.removeEventListener('pointerup', onPointerUp);
                win.removeEventListener('pointercancel', onPointerUp);
            }
            if (canvas) {
                canvas.removeEventListener('pointerdown', onPointerDown);
                canvas.removeEventListener('wheel', onWheel);
            }
        },
    };
}
