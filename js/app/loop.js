// Frame loop and render-on-demand (SPEC §E.7).
//
//   frame(now): dt = min(now − last, 100)
//     t = clock.tick(now)
//     snapshot ('frame' detail) when the observer or the sky site changed, the clock jumped or sim
//         time moved ≥ 0.5 s (any amount in a sky view narrower than FINE_FOV_DEG, where 0.5 s of
//         diurnal motion is pixels, and in lunar orbit) → snap.skyglow (the night sky at the site)
//         and snap.aurora (the auroral ovals for the activity setting) → every module.apply(snap)
//     readout ('full' detail) at most every 250 ms when sim time or the observer changed → bus 'readout'
//     moving = rig.update(dt, snap)
//     render when something is dirty or in motion (camera motion, tweens, time-lapse, intro,
//     pointer held, running time in a telescope-narrow sky view): module.update(fi) → rc.render() → labels
//     star twinkle alone (sky view, stars actually visible) renders at most at ~30 Hz
//     idle supersampling (tiers with `supersample`, core/sampling.js): once nothing moves, extra
//     frames each jittered by a Halton sub-pixel offset blend into a running mean until the cap,
//     then the loop idles again; a frame that only moved sim time a sub-pixel (Live 1Ã—) keeps the
//     history, motion bypasses it, any other change starts a new one. Extra frames skip the module
//     updates, the labels and the governor (nothing changed but the jitter)
//     governor.sample(dt) on consecutive rendered frames only; consecutive idle ticks feed
//     governor.idle(dt), its estimate of the display's own frame interval; while governor.probe()
//     says so (before a step, when that estimate is missing or stale) the tick draws nothing
//
// Live 1× therefore redraws about twice a second; a paused, idle app draws nothing. The loop stops
// on visibilitychange:hidden and resumes dirty.
//
// `step(now, dt, io)` runs one whole frame synchronously, whatever is dirty, for a video
// session (app/recorder.js): the caller supplies the (virtual) time base and brackets the draw.
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
import { exposureFor, skyBrightness } from '../astro/photometry.js';
import { computeSkyglow } from '../astro/skyglow.js';
import { computeAurora } from '../astro/geomag.js';
import { createSupersampler, viewMotionPx } from '../core/sampling.js';

/** Recompute the 'frame' snapshot when simulated time has moved this far (ms). */
export const SNAP_STALE_MS = 500;
/**
 * Sky views narrower than this (degrees) recompute the frame snapshot on every frame that sim time
 * moved, and keep drawing while the clock runs: the sky turns 7.5″ in 0.5 s, 4–15 px at 0.2–0.5°.
 */
export const FINE_FOV_DEG = 2;
/** Readout period (ms): the panels refresh at 4 Hz. */
export const FULL_INTERVAL_MS = 250;
/** Frame dt cap (ms): long gaps (tab switches, hitches) never produce giant steps. */
export const MAX_DT_MS = 100;
/** Failures before a module is switched off. */
export const STRIKES_TO_DISABLE = 3;
/** Orbit view keeps the globe uncluttered: at most this many labels, whatever the tier allows. */
export const ORBIT_LABEL_CAP = 18;
/**
 * Star exposure below which twinkle no longer keeps frames flowing. At 0.005 the star shader
 * shows only Sirius and Canopus, as faint dots whose scintillation cannot be seen. In daylight
 * (Sun above −4°) the exposure is 0, so a daytime sky view idles like the orbit view.
 */
export const TWINKLE_MIN_STARS = 0.005;
/**
 * Minimum interval (ms) between frames drawn only for twinkle: 30 Hz with 4 ms of vsync slack, so
 * a 60 Hz display draws every second frame and a 120/144 Hz display every fourth/fifth.
 */
export const TWINKLE_FRAME_MS = 1000 / 30 - 4;

/** The flat map's morph (rig.mapK) past which the scene's space objects are hidden (attach mapHidden). */
export const MAP_HIDE_K = 0.02;

const OPT_FRAME = Object.freeze({ detail: 'frame' });
const OPT_FULL = Object.freeze({ detail: 'full' });

/**
 * The label feed's mode for a frame: 'map' as soon as the globe starts to unroll (the labels ride
 * the morph to their places on the map), 'sky' once the sky view is past halfway, 'system' once the
 * solar-system zoom's crossfade into the orrery is (rig.systemBlend), else 'orbit'. The rig keeps the
 * map and the system zoom apart (systemBlend is 0 while mapK > 0).
 * @param {number} skyBlend
 * @param {number} mapK
 * @param {number} [systemBlend]
 * @returns {'orbit'|'sky'|'map'|'system'}
 */
export function labelMode(skyBlend, mapK, systemBlend = 0) {
    if (mapK > MAP_HIDE_K) return 'map';
    if (skyBlend >= 0.5) return 'sky';
    return systemBlend >= 0.5 ? 'system' : 'orbit';
}

/** Human names for strike toasts. */
const FEATURE_NAMES = Object.freeze({
    earth: 'The Earth surface',
    atmosphere: 'The atmosphere glow',
    aurora: 'The aurora curtains',
    sky: 'The star field',
    bodies: 'The Sun, Moon and planet markers',
    ground: 'The sky-view ground',
    trails: 'Planet paths',
    eclipsePath: 'The eclipse path',
    beams: 'The beams',
    beams2: 'The second place’s beams',
    planets: 'The planet medallions',
    pin: 'The location pin',
    pin2: 'The second place’s pin',
    flare: 'The lens flare',
    orrery: 'The solar-system view',
    longExposure: 'Long exposure',
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
 *   `rc`…`getTierCfg` may be omitted here and supplied later through `attach()`. A `governor` given
 *   here is fed idle ticks (display cadence) while the loop runs headless.
 * @returns {{start():void, stop():void, invalidate():void, redraw():boolean, readonly labelOptions:object, snap:Snapshot, snapFull:Snapshot,
 *            attach(renderDeps:object):void, broadcast(method:string, a?:any, b?:any):void,
 *            callModule(m:RenderModule, method:string, a?:any, b?:any, c?:any):boolean, isDisabled(m:RenderModule):boolean,
 *            replaceModule(prev:RenderModule|null, next:RenderModule, name?:string):void,
 *            setDebug(overlay:any):void, setRenderPaused(paused:boolean):void, setSkySite(site:object|null):void, setAuroraActivity(activity:string):void, refreshReadout():void,
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
    // The second place (store.observer2, ROADMAP two-observers): its own frame and full snapshots,
    // computed beside the first ones and hung on them as `.second` (null while there is none).
    const snap2 = createSnapshot();
    const snapFull2 = createSnapshot();
    // The observer's light pollution (astro/skyglow.js SkySite; null = pristine), set by setSkySite.
    let skySite = deps.skySite ?? null;
    // Aurora activity (astro/geomag.js AURORA_SETTINGS), set by setAuroraActivity.
    let auroraActivity = deps.auroraActivity ?? 'typical';
    // Extra objects beyond the nine bodies (astro/extras.js): snap.extras, filled per snapshot.
    const extras = deps.extras ?? null;

    // Render stack (attached later in the normal boot).
    let rc = null;
    let rig = null;
    /** @type {RenderModule[]} */
    let modules = [];
    /** @type {Map<RenderModule,string>} */
    const names = new Map();
    let labels = null;
    let labelsFeed = null;
    // Given up front, the governor already learns the display cadence from the headless boot ticks.
    let governor = deps.governor ?? null;
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
    // Scene groups hidden on the flat map (attach `mapHidden`: the bodies in space, the beams…).
    let mapHidden = [];
    let lastMapHide = false;
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
    let lastRenderAt = -Infinity;
    let idleLastFrame = false;

    // Preallocated per-frame objects.
    const exposure = { stars: 1, planets: 1, milkyWay: 1, vision: 0 };
    let expSunAlt = NaN;
    let expSkyLim = NaN;
    let expSkyNl = NaN;
    let expBlend = NaN;
    let expObsc = NaN;
    let expLimit = NaN;
    /** @type {FrameInfo} */
    const fi = {
        dtMs: 0, timeS: 0, camera: null, viewMode: 'orbit', skyBlend: 0, snap,
        pulsesActive: false, simRate: 0, exposure, moonFront: false, mapK: 0, map: null, systemBlend: 0,
    };
    // upS is the snapshot's live zenith: the label pool derives is-below for direction anchors from it,
    // and in sky view (horizon) hides star and constellation names that the ground covers — the
    // illustrative landscape's silhouette when that layer is on (landscape, with the observer's
    // north/east for its azimuths). refrK lifts direction labels by refraction as the sky view draws
    // them. skyLum is the brightness of the sky behind the labels (their halo style).
    const labelOpts = {
        cap: 24, upS: snap.observer.upS, northS: snap.observer.northS, eastS: snap.observer.eastS,
        horizon: false, skyLum: 0, refrK: 0, landscape: null,
    };
    // The label feed's per-frame inputs (labels-feed LabelView): star and constellation names follow
    // the drawn star field; body label offsets scale with the viewport; sky-view `below` flags follow
    // the landscape profile.
    const labelView = { starExposure: 1, magLimit: 6, viewportH: 0, horizon: null, mapK: 0, map: null };

    // Idle supersampling: the policy, its output and the camera pose of the last accumulated frame.
    const sampler = createSupersampler();
    const ssOut = { x: 0, y: 0, weight: 1 };
    const ssPoseW = new Float64Array(16);
    const ssPoseP = new Float64Array(16);
    let ssCount = 0;
    // The last drawn frame moved (no accumulation): the first still tick redraws and starts one.
    let ssSettle = false;

    const offs = [];
    offs.push(store.subscribe((s) => s.observer, () => { observerDirty = true; dirty = true; }));
    offs.push(store.subscribe((s) => s.observer2, () => { observerDirty = true; dirty = true; }));
    // A provider registering (its data arrived) recomputes both snapshots, so its objects appear.
    if (extras && typeof extras.onChange === 'function') offs.push(extras.onChange(() => { observerDirty = true; dirty = true; }));
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

    /**
     * fi.exposure from the Sun's altitude, the view blend, (totality's stars) the eclipse and the
     * night sky's own brightness (snap.skyglow: the Moon and light pollution).
     */
    function updateExposure(sunAlt, skyBlend, obscuration, tierMagLimit, sky) {
        const skyLim = sky ? sky.limitMag : NaN, skyNl = sky ? sky.zenithNl : NaN;
        if (sunAlt === expSunAlt && skyBlend === expBlend && obscuration === expObsc && tierMagLimit === expLimit
            && Object.is(skyLim, expSkyLim) && Object.is(skyNl, expSkyNl)) return;
        expSunAlt = sunAlt;
        expBlend = skyBlend;
        expObsc = obscuration;
        expLimit = tierMagLimit;
        expSkyLim = skyLim;
        expSkyNl = skyNl;
        const r = exposureFor(sunAlt, skyBlend, exposure, obscuration, tierMagLimit, sky ?? null);
        if (r !== exposure && r) {
            exposure.stars = r.stars;
            exposure.planets = r.planets;
            exposure.milkyWay = r.milkyWay;
            exposure.vision = r.vision ?? 0;
        }
    }

    /** The second place's snapshot (into `out`), or null when there is no second place. */
    function computeSecond(t, obs2, out, opt) {
        if (!obs2 || !Number.isFinite(obs2.latDeg) || !Number.isFinite(obs2.lonDeg)) return null;
        try {
            computeSnapshot(t, obs2, out, opt);
            return out;
        } catch (err) {
            reportOnce('computeSnapshot(second)', err);
            return null;
        }
    }

    /**
     * snap.skyglow, snap.aurora and snap.extras for a freshly computed snapshot (snapshots without
     * the first two are left alone; the extras registry adds its states).
     */
    function fillSkyglow(s) {
        if (s.skyglow) computeSkyglow(s, skySite, s.skyglow);
        if (s.aurora) computeAurora(s, auroraActivity, s.aurora);
        if (extras) {
            try {
                extras.fill(s);
            } catch (err) {
                reportOnce('extras.fill', err);
            }
        }
    }

    /** True when this tier and chain supersample idle frames (and keeps the sampler's cap in step). */
    function supersampling(cfg) {
        const k = cfg && cfg.supersample > 1 && rc && rc.supersampling === true ? cfg.supersample : 0;
        if (k !== sampler.samples) sampler.samples = k;
        return k > 1;
    }

    /**
     * The supersampling decision for the frame about to be drawn (null: draw it plainly). Remembers
     * the pose of an accumulated frame, so the next one can tell drift from motion.
     */
    function ssFor(kind, camera, skyBlend) {
        let moved = Infinity;
        const W = camera && camera.matrixWorld ? camera.matrixWorld.elements : null;
        const P = camera && camera.projectionMatrix ? camera.projectionMatrix.elements : null;
        if (kind !== 'motion' && kind !== 'fresh' && W && P && sampler.count > 0) {
            moved = viewMotionPx(ssPoseW, W, {
                prevP: ssPoseP, curP: P, heightPx: (rc.size?.h || 1) * (rc.dpr || 1), sky: skyBlend >= 1,
            });
        }
        const ss = sampler.next(W && P ? kind : 'motion', moved, ssOut);
        if (ss) {
            for (let i = 0; i < 16; i++) {
                ssPoseW[i] = W[i];
                ssPoseP[i] = P[i];
            }
            ssCount++;
        }
        return ss;
    }

    function frame(now) {
        handle = 0;
        if (!running) return;
        const dt = last > 0 ? Math.min(Math.max(now - last, 0), MAX_DT_MS) : 1000 / 60;
        last = now;
        // What was dirty before this frame's own snapshot step (supersampling: drift vs a change).
        const dirtyIn = dirty || observerDirty || jumped || !snapValid;

        let t;
        try {
            t = clock.tick(now);
        } catch (err) {
            reportOnce('clock.tick', err);
            t = clock.tMs;
        }
        const obs = store.get().observer;
        const obs2 = store.get().observer2 ?? null;
        const rendering = rc !== null && !renderPaused && !renderFailed;

        // 1. Frame-detail snapshot for the renderers. A telescope-narrow sky view and lunar orbit
        // (the Earthrise vantage: in 0.5 s the orbiter covers 0.8 km and the Earth climbs 1.5 px of
        // an 18° view) recompute it whenever sim time moved.
        const fine = rendering && rig !== null && !!rig.camera
            && ((rig.mode === 'sky' && rig.camera.fov < FINE_FOV_DEG) || rig.vantage === 'moon');
        if (rendering && (observerDirty || jumped || !snapValid
            || (fine ? t !== snap.tMs : Math.abs(t - snap.tMs) >= SNAP_STALE_MS))) {
            try {
                computeSnapshot(t, obs, snap, OPT_FRAME);
                fillSkyglow(snap);
                snap.second = computeSecond(t, obs2, snap2, OPT_FRAME);
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
                fillSkyglow(snapFull);
                snapFull.second = computeSecond(t, obs2, snapFull2, OPT_FULL);
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
                    fillSkyglow(snap);
                    snap.second = computeSecond(t, obs2, snap2, OPT_FRAME);
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
            let mapK = 0;
            if (rig && !disabled.has(rig)) {
                try {
                    moving = !!rig.update(dt, snap);
                    // Earth-lock following the Earth's turn (Live 1×: every snapshot) is a drift: the
                    // frame is drawn, and supersampling measures it instead of dropping the history.
                    if (moving && rig.lockOnly) {
                        moving = false;
                        dirty = true;
                    }
                } catch (err) {
                    strike(rig, 'update', err);
                }
                mode = rig.mode === 'sky' ? 'sky' : 'orbit';
                skyBlend = Number.isFinite(rig.skyBlend) ? rig.skyBlend : (mode === 'sky' ? 1 : 0);
                mapK = Number.isFinite(rig.mapK) ? rig.mapK : 0;
            }
            // The flat map: the bodies in space, the beams and the paths go as the globe unrolls.
            const hideForMap = mapK > MAP_HIDE_K;
            if (hideForMap !== lastMapHide) {
                lastMapHide = hideForMap;
                for (let i = 0; i < mapHidden.length; i++) mapHidden[i].visible = !hideForMap;
                dirty = true;
            }
            let viewChanged = false;
            if (mode !== lastMode || skyBlend !== lastSkyBlend) {
                lastMode = mode;
                lastSkyBlend = skyBlend;
                for (let i = 0; i < modules.length; i++) callModule(modules[i], 'setViewMode', mode, skyBlend);
                dirty = true;
                viewChanged = true;
            }

            const cfg = getTierCfg();
            updateExposure(snap.observer.sunAltDeg, skyBlend, snap.eclipse.obscurationAtObserver,
                cfg && Number.isFinite(cfg.starMagLimit) ? cfg.starMagLimit : 6, snap.skyglow);
            const motion = moving || !!(rig && rig.tweening) || clock.isAnimating() || introPlaying
                || pointers.size > 0 || (fine && clock.playing && clock.rate !== 0);
            // Idle supersampling: once motion stops, one more full frame starts the history.
            const ss = supersampling(cfg);
            if (ss && ssSettle && !motion) {
                ssSettle = false;
                dirty = true;
            }
            // Twinkle alone: only while stars are actually shown, and at most ~30 Hz.
            const twinkleDue = !motion && !dirty && now - lastRenderAt >= TWINKLE_FRAME_MS && twinkling(cfg, skyBlend);
            // Before a step with no fresh cadence, the governor holds a few frames back to measure it.
            const held = governor !== null && probeCadence();
            // Another jittered frame while the history wants one.
            const ssIdle = ss && !motion && !dirty && !twinkleDue && sampler.wants;

            if (!held && (dirty || motion || twinkleDue || ssIdle)) {
                const camera = (rig && rig.camera) || rc.camera;
                if (ssIdle) {
                    // Nothing changed but the jitter: no module updates, labels or governor sample.
                    try {
                        rc.render(ssFor('idle', camera, skyBlend));
                        renderStrikes = 0;
                    } catch (err) {
                        renderStrikes++;
                        console.error(`[loop] render failed (${renderStrikes}/${STRIKES_TO_DISABLE})`, err);
                    }
                    frames++;
                    fpsWindowFrames++;
                    renderedLastFrame = false;
                    idleLastFrame = false;
                    lastRenderAt = now;
                    handle = raf(frame);
                    return;
                }
                // Only sim time moved (the frame snapshot), the camera held: drift, not a change.
                const drift = !dirtyIn && !viewChanged;
                // Cleared before the updates so a module that calls rc.invalidate() while animating
                // (texture swap, launch tween, reticle) gets the next frame too.
                dirty = false;
                fi.dtMs = dt;
                fi.timeS = now / 1000;
                fi.camera = camera;
                fi.viewMode = mode;
                fi.skyBlend = skyBlend;
                fi.snap = snap;
                fi.pulsesActive = (clock.playing && Math.abs(clock.rate) > 1) || introPlaying;
                fi.simRate = clock.playing && Number.isFinite(clock.rate) ? clock.rate : 0;
                fi.moonFront = !!(rig && rig.moonFront);
                fi.mapK = mapK;
                fi.map = mapK > 0 && rig ? rig.mapFrame ?? null : null;
                fi.systemBlend = rig && Number.isFinite(rig.systemBlend) ? rig.systemBlend : 0;

                for (let i = 0; i < modules.length; i++) callModule(modules[i], 'update', fi);

                // Twinkle frames keep a short history (scintillation must stay visible).
                const ssKind = motion ? 'motion' : !drift && !twinkleDue ? 'fresh'
                    : twinkling(cfg, skyBlend) ? 'twinkle' : 'drift';
                if (ss && motion) ssSettle = true;
                const r0 = performance.now();
                try {
                    rc.render(ss ? ssFor(ssKind, camera, skyBlend) : null);
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
                        syncLabels(camera, cfg, skyBlend, mapK, fi.map, fi.systemBlend);
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
                idleLastFrame = false;
                lastRenderAt = now;
            } else {
                renderedLastFrame = false;
                if (fpsWindowStart !== 0 && now - fpsWindowStart >= 1000) {
                    fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
                    fpsWindowStart = now;
                    fpsWindowFrames = 0;
                }
                feedCadence(dt);
            }
        } else {
            feedCadence(dt);
        }

        handle = raf(frame);
    }

    /** The label feed's live points and the label pool's options for this frame's camera and view. */
    function syncLabels(camera, cfg, skyBlend, mapK = 0, map = null, systemBlend = 0) {
        if (labelsFeed) {
            labelView.starExposure = exposure.stars;
            labelView.magLimit = cfg && Number.isFinite(cfg.starMagLimit) ? cfg.starMagLimit : 6;
            labelView.viewportH = rc.size && rc.size.h > 0 ? rc.size.h : 0;
            labelView.mapK = mapK;
            labelView.map = map;
            labelsFeed.sync(camera, labelMode(skyBlend, mapK, systemBlend), labelView);
        }
        const obsc = snap.eclipse ? snap.eclipse.obscurationAtObserver : 0;
        const tierCap = cfg && Number.isFinite(cfg.labelCap) ? cfg.labelCap : 24;
        labelOpts.cap = skyBlend >= 0.5 || mapK > 0 ? tierCap : Math.min(tierCap, ORBIT_LABEL_CAP);
        labelOpts.horizon = skyBlend >= 0.5;
        labelOpts.refrK = skyBlend;
        labelOpts.skyLum = skyBrightness(snap.observer.sunAltDeg, obsc, skyBlend);
    }

    /**
     * One whole frame now, for a video session (app/recorder.js), whatever is dirty: the clock ticks
     * at `now` (the session's virtual time base), the frame snapshot and the 4 Hz readout follow,
     * the rig advances by `dtMs`, then `io.before()` (the capture projection), every module's
     * x (the
     * read). No DOM labels, governor or supersampling. The caller keeps the rAF loop stopped.
     * @param {number} now ms on the session's time base
     * @param {number} dtMs frame interval (ms)
     * @param {{before?:()=>void, after?:(camera:any)=>void}} [io]
     * @returns {boolean} false when nothing can be drawn
     */
    function step(now, dtMs, io) {
        if (rc === null || renderPaused || renderFailed) return false;
        const dt = Math.min(Math.max(Number(dtMs) || 0, 0), 1000);
        last = now;
        let t;
        try {
            t = clock.tick(now);
        } catch (err) {
            reportOnce('clock.tick', err);
            t = clock.tMs;
        }
        const obs = store.get().observer;
        const obs2 = store.get().observer2 ?? null;
        if (observerDirty || jumped || !snapValid || t !== snap.tMs) {
            try {
                computeSnapshot(t, obs, snap, OPT_FRAME);
                fillSkyglow(snap);
                // The second place's beams and pin follow the session's time as well.
                snap.second = computeSecond(t, obs2, snap2, OPT_FRAME);
                snapValid = true;
                for (let i = 0; i < modules.length; i++) callModule(modules[i], 'apply', snap);
                if (hooks.onApply) hooks.onApply(snap);
            } catch (err) {
                reportOnce('computeSnapshot(frame)', err);
            }
        }
        if (now - lastFull >= FULL_INTERVAL_MS || observerDirty) {
            try {
                computeSnapshot(t, obs, snapFull, OPT_FULL);
                fillSkyglow(snapFull);
                snapFull.second = computeSecond(t, obs2, snapFull2, OPT_FULL);
                fullValid = true;
                fullT = t;
                lastFull = now;
                bus.emit('readout', snapFull);
            } catch (err) {
                reportOnce('computeSnapshot(full)', err);
                lastFull = now;
            }
        }
        observerDirty = false;
        jumped = false;
        let mode = 'orbit';
        let skyBlend = 0;
        let mapK = 0;
        if (rig && !disabled.has(rig)) {
            try {
                rig.update(dt, snap);
            } catch (err) {
                strike(rig, 'update', err);
            }
            mode = rig.mode === 'sky' ? 'sky' : 'orbit';
            skyBlend = Number.isFinite(rig.skyBlend) ? rig.skyBlend : (mode === 'sky' ? 1 : 0);
            mapK = Number.isFinite(rig.mapK) ? rig.mapK : 0;
        }
        // As in frame(): the flat map hides the space groups while the globe is unrolled.
        const hideForMap = mapK > MAP_HIDE_K;
        if (hideForMap !== lastMapHide) {
            lastMapHide = hideForMap;
            for (let i = 0; i < mapHidden.length; i++) mapHidden[i].visible = !hideForMap;
        }
        if (mode !== lastMode || skyBlend !== lastSkyBlend) {
            lastMode = mode;
            lastSkyBlend = skyBlend;
            for (let i = 0; i < modules.length; i++) callModule(modules[i], 'setViewMode', mode, skyBlend);
        }
        const cfg = getTierCfg();
        updateExposure(snap.observer.sunAltDeg, skyBlend, snap.eclipse.obscurationAtObserver,
            cfg && Number.isFinite(cfg.starMagLimit) ? cfg.starMagLimit : 6, snap.skyglow);
        io?.before?.();
        const camera = (rig && rig.camera) || rc.camera;
        fi.dtMs = dt;
        fi.timeS = now / 1000;
        fi.camera = camera;
        fi.viewMode = mode;
        fi.skyBlend = skyBlend;
        fi.snap = snap;
        fi.pulsesActive = clock.playing && Math.abs(clock.rate) > 1;
        fi.simRate = clock.playing && Number.isFinite(clock.rate) ? clock.rate : 0;
        fi.moonFront = !!(rig && rig.moonFront);
        fi.mapK = mapK;
        fi.map = mapK > 0 && rig ? rig.mapFrame ?? null : null;
        // The orrery's update() shows its scene from this, so rc.render() draws it in the video too.
        fi.systemBlend = rig && Number.isFinite(rig.systemBlend) ? rig.systemBlend : 0;
        for (let i = 0; i < modules.length; i++) callModule(modules[i], 'update', fi);
        if (labels && !disabled.has(labels)) {
            try {
                syncLabels(camera, cfg, skyBlend, fi.mapK, fi.map, fi.systemBlend);
            } catch (err) {
                reportOnce('labelsFeed.sync(step)', err);
            }
        }
        rc.render();
        frames++;
        io?.after?.(camera);
        dirty = true;
        return true;
    }

    /**
     * A tick that drew nothing. When the tick before it drew nothing either, `dt` is the display's
     * own frame interval, free of render cost: the governor's budget follows it (30 Hz caps, 48 Hz
     * panels).
     */
    function feedCadence(dt) {
        if (idleLastFrame && governor) {
            try {
                governor.idle(dt);
            } catch (err) {
                reportOnce('governor.idle', err);
            }
        }
        idleLastFrame = true;
    }

    /** governor.probe(), guarded: true when this tick should draw nothing (cadence probe). */
    function probeCadence() {
        try {
            return governor.probe?.() === true;
        } catch (err) {
            reportOnce('governor.probe', err);
            return false;
        }
    }

    /**
     * True when star twinkle needs frames: the tier twinkles, sky view, no reduced motion, the star
     * layer on, and stars actually visible (the sky module's own exposure, totality included).
     */
    function twinkling(cfg, skyBlend) {
        if (!(cfg && cfg.twinkle) || skyBlend <= 0.5 || reducedMotion) return false;
        if (!store.get().layers?.stars) return false;
        return exposure.stars > TWINKLE_MIN_STARS;
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
        idleLastFrame = false;
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
     *          labelsFeed?:any, governor?:any, getTierCfg?:()=>any, horizon?:object|null, mapHidden?:object[]}} r `horizon`: the
     *          shared landscape profile (geo/horizon.js) for the labels; `mapHidden`, scene groups hidden
     *          while the globe is (being) unrolled into the flat map (rig.mapK)
     */
    function attach(r) {
        labelOpts.landscape = labelView.horizon = r.horizon ?? null;
        rc = r.rc ?? null;
        rig = r.rig ?? null;
        modules = Array.isArray(r.modules) ? r.modules.slice() : [];
        if (r.moduleNames) for (const [m, n] of r.moduleNames) names.set(m, n);
        if (rig) names.set(rig, 'rig');
        labels = r.labels ?? null;
        if (labels) names.set(labels, 'labels');
        labelsFeed = r.labelsFeed ?? null;
        mapHidden = Array.isArray(r.mapHidden) ? r.mapHidden.slice() : [];
        lastMapHide = false;
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
        /**
         * Draws one frame now, outside the frame cadence (rc.capture: postcards, Save image): the
         * label feed's live points, every module's update() with the current camera and the last
         * FrameInfo (dt 0), then rc.render(). The DOM labels, stats and the governor are left alone.
         * @returns {boolean} false when nothing can be drawn (no render stack, paused, failed)
         */
        redraw() {
            if (rc === null || renderPaused || renderFailed) return false;
            const camera = (rig && rig.camera) || rc.camera;
            fi.dtMs = 0;
            fi.camera = camera;
            fi.snap = snap;
            for (let i = 0; i < modules.length; i++) callModule(modules[i], 'update', fi);
            if (labelsFeed && labels && !disabled.has(labels)) {
                try {
                    labelView.viewportH = rc.size && rc.size.h > 0 ? rc.size.h : 0;
                    labelsFeed.sync(camera, labelMode(fi.skyBlend, fi.mapK, fi.systemBlend), labelView);
                } catch (err) {
                    reportOnce('labelsFeed.sync(redraw)', err);
                }
            }
            rc.render();
            return true;
        },
        /**
         * The label pool's per-frame options as last drawn (read-only): cap, horizon, refrK, skyLum,
         * upS/northS/eastS and the landscape. Captures reproject the label feed with them.
         */
        get labelOptions() { return labelOpts; },
        step,
        /** Accumulated supersampling frames so far, and the current history's sample count. */
        get supersample() { return { frames: ssCount, samples: sampler.count, cap: sampler.samples }; },
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
        /**
         * The observer's light pollution (astro/skyglow.js SkySite; null = pristine). Both snapshots'
         * skyglow is recomputed on the next frame; the caller may pass the same, refilled object.
         * @param {object|null} site
         */
        setSkySite(site) {
            skySite = site ?? null;
            snapValid = false;
            fullValid = false;
            lastFull = -Infinity;
            dirty = true;
        },
        /**
         * Aurora activity ('quiet' | 'typical' | 'storm'; astro/geomag.js). Both snapshots' aurora is
         * recomputed on the next frame.
         * @param {string} activity
         */
        setAuroraActivity(activity) {
            if (activity === auroraActivity) return;
            auroraActivity = activity;
            snapValid = false;
            fullValid = false;
            lastFull = -Infinity;
            dirty = true;
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
                cadenceMs: governor?.cadenceMs ?? null,
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
