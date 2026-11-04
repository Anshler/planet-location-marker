// Planet Location Marker composition root (SPEC §E.8, §C.9).
//
// Boot order (no network on the critical path):
//   1. state from URL hash → saved prefs → timezone guess → Greenwich; tier detection
//   2. clock + first snapshot
//   3. UI mounted at once (panels work before WebGL exists); headless loop publishes readouts
//   4. render context + modules (each in try/catch), placeholders until textures arrive
//   5. sky.json / cities.json / critical textures in parallel
//   6. rc.compile()   7. loop renders   8. loader hides when the critical textures are ready or after 5 s
//   9. first-visit intro   10. idle: deferred textures, almanac push, service worker
//
// Static imports are limited to modules that need neither three.js nor the import map, so text
// mode still works in browsers without import maps or WebGL2. The render stack (three r170) and
// the UI are loaded with dynamic import() and isolated: a failing UI leaves the globe, a failing
// renderer leaves the panels.

import { APP_NAME, VERSION } from './version.js';
import { DEFAULT_STATE, SKY_DARK_SETTINGS, AURORA_SETTINGS, createStore } from './core/store.js';
import { createBus } from './core/bus.js';
import { createClock, scrubSpanMs } from './core/clock.js';
import { parseHash, bindUrl } from './core/url-state.js';
import { isTourId } from './core/tour-catalog.js';
import { detectTier, createGovernor, isTier, autoStartTier, learnedTierRecord } from './core/quality.js';
import * as prefs from './core/prefs.js';
import * as tz from './core/tz.js';
import * as format from './core/format.js';
import { loadCities, placeToObserver } from './geo/cities.js';
import { createGeocoder, createLruCache } from './geo/geocode.js';
import { createHorizon } from './geo/horizon.js';
import { mapPointOfDir } from './geo/mapview.js';
import { BODIES, isBodyId, bodyById } from './astro/bodies.js';
import { createSnapshot, computeSnapshot } from './astro/snapshot.js';
import { createExtras } from './astro/extras.js';
import { isSelectionId, isExtraId } from './core/selection.js';
import { registerExtras, registerStars } from './app/extras-setup.js';
import { createAstroClient } from './astro/client.js';
import { createSite, siteFor, manualSite } from './astro/skyglow.js';
import { liftByRefraction } from './astro/photometry.js';
import { guideRefs, separationDeg } from './astro/sky-guide.js';
import { decodeSky, emptyCatalog, mergeDeepStars } from './data/catalog.js';
import { createActions, normalizeObserver, selectionLook, viewModeLook, eclipseFocusExpired } from './app/actions.js';
import { ribbonPlan } from './app/eclipse-chase.js';
import { createLoop } from './app/loop.js';
import { createLabelsFeed } from './app/labels-feed.js';
import { createCapture } from './app/capture.js';
import { photoLayers } from './app/expose.js';
import { playIntro, INTRO_TIMING } from './app/intro.js';
import { showFallback, showContextLost, hideContextLost, showFatal } from './app/fallback.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** How long a first visit waits for cities.json before falling back to Greenwich (it is preloaded). */
const CITY_GUESS_WAIT_MS = 1500;
/** The loader hides this long after the loop starts even if the critical textures are still coming. */
const READY_MAX_WAIT_MS = 5000;
/** Never wait longer than this for shader compilation behind the loader. */
const COMPILE_MAX_WAIT_MS = 10000;
const DATA_TIMEOUT_MS = 20000;
const QUALITY_SETTINGS = ['auto', 'low', 'medium', 'high', 'max'];
const DOUBLE_CLICK_MS = 380;
const DOUBLE_CLICK_PX = 12;
/** Trail (apparent path) parameters per body. */
const TRAIL_SPAN = { moon: { halfSpanDays: 14, stepHours: 2, refreshDays: 3 }, default: { halfSpanDays: 180, stepHours: 24, refreshDays: 45 } };

const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;
const noop = () => {};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (p) => {
    if (p && typeof p.catch === 'function') p.catch(noop);
    return p;
};
const idle = (fn, timeout = 2000) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout });
    else setTimeout(fn, 200);
};

// The inline loader in index.html checks this to tell "modules failed to load" from "booting".
window.__pcBooted = true;

// ---------------------------------------------------------------------------------------------
// window.__app (SPEC §C.9): the handle smoke tests and curious developers use.
// ---------------------------------------------------------------------------------------------

const R = {
    /** @type {any} */ store: null,
    /** @type {any} */ clock: null,
    /** @type {any} */ actions: null,
    /** @type {any} */ loop: null,
    /** @type {any} */ rc: null,
    /** @type {any} */ rig: null,
    /** @type {Record<string, any>} */ mods: {},
    /** @type {any} */ labels: null,
    /** @type {any} */ labelsFeed: null,
    /** @type {any} */ textures: null,
    /** @type {any} */ governor: null,
    /** The sky view's illustrative landscape profile (geo/horizon.js), built by the ground module. */
    /** @type {any} */ horizon: null,
    /** WebGL renderer string: the key of the governor's learned tier. */
    rendererString: '',
    /** @type {any} */ catalog: null,
    /** @type {any} */ snapFull: null,
    /** @type {any} */ bus: null,
    /** @type {any} */ texMod: null,
    /** @type {any} */ astro: null,
    /** The extra-object registry (astro/extras.js): guest stars, comets, spacecraft, … */
    /** @type {any} */ extras: null,
    /** The guided-tour runner (js/app/tours.js), created on the first tour. */
    /** @type {any} */ tours: null,
    /** 'Point at the sky' (js/camera/aim.js), created on first use. */
    /** @type {any} */ aim: null,
    /** A video session's virtual time base (ms, app/recorder.js), or null: the rig reads real time. */
    /** @type {number|null} */ virtualNow: null,
    uiMounted: false,
};

const app = {
    ready: false,
    version: VERSION,
    get tier() { return R.store?.get().quality.active ?? null; },
    get store() { return R.store; },
    get clock() { return R.clock; },
    get actions() { return R.actions; },
    /** The extra-object registry (astro/extras.js). */
    get extras() { return R.extras; },
    /** The latest full-detail snapshot. */
    snapshot() { return R.loop?.snapFull ?? R.snapFull; },
    /** Frame and resource counters for smoke tests and the debug overlay. */
    stats() {
        const ls = R.loop?.stats?.() ?? {};
        let rs = {};
        try {
            rs = R.rc?.stats?.() ?? {};
        } catch {
            rs = {};
        }
        return {
            fps: ls.fps ?? 0,
            frames: ls.frames ?? 0,
            drawCalls: rs.drawCalls ?? 0,
            geometries: rs.geometries ?? 0,
            textures: rs.textures ?? 0,
            beamsVisible: countBeamsVisible(),
            labelsVisible: countLabelsVisible(),
            phase: R.store?.get().status.phase ?? 'boot',
            tier: R.store?.get().quality.active ?? null,
            disabled: ls.disabled ?? [],
        };
    },
    /** Internals for debugging from the console (not a stable API). */
    get internals() { return R; },
};
window.__app = app;

function countBeamsVisible() {
    const beams = R.mods.beams;
    const st = R.store?.get();
    if (!beams || !st || !R.loop || R.loop.isDisabled(beams) || !R.loop.rendering) return 0;
    if (typeof beams.visibleCount === 'number') return beams.visibleCount;
    // Sky view, the unrolled map and the orrery (render/beams.js hides the group at systemBlend 0.999) draw none.
    if (!st.layers.beams || (R.rig?.skyBlend ?? 0) > 0.5 || (R.rig?.mapK ?? 0) > 0.02 || (R.rig?.systemBlend ?? 0) >= 0.999) return 0;
    return BODIES.filter((b) => b.kind === 'planet' || st.layers.sunMoonBeams).length;
}

function countLabelsVisible() {
    if (typeof R.labels?.visibleCount === 'number') return R.labels.visibleCount;
    try {
        return document.querySelectorAll('#labels-root .lbl:not(.is-hidden)').length;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------------------------
// Inline loader bridge (index.html installs window.__pcLoader)
// ---------------------------------------------------------------------------------------------

const loader = {
    progress(f, label) {
        try {
            window.__pcLoader?.progress?.(f, label);
        } catch { /* cosmetic */ }
    },
    done() {
        try {
            if (window.__pcLoader?.done) window.__pcLoader.done();
            else document.getElementById('loader')?.remove();
        } catch {
            document.getElementById('loader')?.remove();
        }
    },
    /** Resolves when the user presses "continue with low detail" (or already has). */
    slow: new Promise((resolve) => {
        if (window.__pcSlow) resolve(true);
        else window.addEventListener('pc:slow', () => resolve(true), { once: true });
    }),
};

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

function mediaMatches(q) {
    try {
        return typeof matchMedia === 'function' && matchMedia(q).matches;
    } catch {
        return false;
    }
}

/** Probes WebGL2 directly (only when the inline probe in index.html did not run). */
function probeWebGL2() {
    const out = { webgl2: false, renderer: '', maxTex: 0 };
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (!gl) return out;
        out.webgl2 = true;
        out.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
        let r = String(gl.getParameter(gl.RENDERER) || '');
        if (!r || /^WebKit WebGL$/i.test(r)) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) r = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || r);
        }
        out.renderer = r;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* no WebGL2 */ }
    return out;
}

function readEnv() {
    const pre = window.__pcEnv && typeof window.__pcEnv === 'object' ? window.__pcEnv : null;
    const probe = pre && typeof pre.webgl2 === 'boolean' ? pre : probeWebGL2();
    let importmap = pre?.importmap;
    if (typeof importmap !== 'boolean') {
        try {
            importmap = typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('importmap');
        } catch {
            importmap = false;
        }
    }
    const nav = navigator;
    const env = {
        webgl2: !!probe.webgl2,
        importmap: !!importmap,
        rendererString: String(probe.renderer || ''),
        maxTextureSize: Number(probe.maxTex) || 0,
        dpr: Number(window.devicePixelRatio) || 1,
        deviceMemory: Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : undefined,
        cores: Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : undefined,
        coarse: mediaMatches('(pointer: coarse)'),
        reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
        screenW: Number(screen?.width) || window.innerWidth,
        screenH: Number(screen?.height) || window.innerHeight,
        saveData: !!nav.connection?.saveData,
        webdriver: !!nav.webdriver,
    };
    env.can3d = env.webgl2 && env.importmap;
    return env;
}

// ---------------------------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------------------------

/** Same-origin JSON fetch with a timeout. Resolves null on any failure (callers decide what to say). */
async function fetchJson(url, timeoutMs = DATA_TIMEOUT_MS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ac.signal, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.json();
    } catch (err) {
        console.warn(`[main] could not load ${url}`, err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function withTimeout(promise, ms) {
    return Promise.race([promise, delay(ms).then(() => null)]);
}

/**
 * The city index the UI and actions see. It answers (empty) before cities.json has loaded and
 * delegates to the real index afterwards, so nothing has to wait for the file.
 */
function createCitiesProxy() {
    let index = null;
    const proxy = {
        get list() { return index?.list ?? []; },
        get countries() { return index?.countries ?? {}; },
        get size() { return index?.size ?? 0; },
        get ready() { return !!index; },
        search(q, limit) { return index ? index.search(q, limit) : []; },
        nearest(lat, lon, maxKm) { return index ? index.nearest(lat, lon, maxKm) : { city: null, km: Infinity }; },
        byTz(zone) { return index ? index.byTz(zone) : null; },
        countryName(cc) { return index?.countryName ? index.countryName(cc) : (cc ?? ''); },
        /** @internal */
        set(i) { index = i; },
    };
    return proxy;
}

/** Saved observer, validated (anything malformed is ignored). */
function loadSavedObserver() {
    const o = prefs.load('observer', null);
    if (!o || typeof o !== 'object') return null;
    const lat = Number(o.latDeg), lon = Number(o.lonDeg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
    return { ...o, source: 'saved' };
}

function loadSavedLayers() {
    const l = prefs.load('layers', null);
    if (!l || typeof l !== 'object') return null;
    const out = {};
    for (const k of Object.keys(DEFAULT_STATE.layers)) if (typeof l[k] === 'boolean') out[k] = l[k];
    return out;
}

function loadSavedDisplay() {
    const d = prefs.load('display', null);
    const out = { ...DEFAULT_STATE.display };
    if (d && typeof d === 'object') {
        if (['observer', 'device', 'utc'].includes(d.tzMode)) out.tzMode = d.tzMode;
        if (typeof d.hour12 === 'boolean') out.hour12 = d.hour12;
        if (SKY_DARK_SETTINGS.includes(d.skyDark)) out.skyDark = d.skyDark;
        if (AURORA_SETTINGS.includes(d.aurora)) out.aurora = d.aurora;
    }
    return out;
}

/**
 * Feeds the loop the observer's light pollution (astro/skyglow.js): estimated from the cities
 * around the observer ('auto', once cities.json is in) or the chosen Sky darkness.
 */
function bindSkySite(store, loop, cities, cityIndexP) {
    const site = createSite();
    const refresh = () => {
        const st = store.get();
        try {
            siteFor(st.observer, cities.list, st.display?.skyDark ?? 'auto', site);
        } catch (err) {
            console.error('[main] light-pollution estimate failed', err);
            manualSite('pristine', site);
        }
        loop.setSkySite(site);
    };
    store.subscribe((s) => s.observer, refresh);
    store.subscribe((s) => s.display?.skyDark, refresh);
    cityIndexP.then(refresh);
    refresh();
}

// ---------------------------------------------------------------------------------------------
// Render stack loading
// ---------------------------------------------------------------------------------------------

/**
 * Imports the render stack in parallel. Each entry is the module namespace or null (its failure
 * is logged and the feature is skipped). Literal specifiers keep the import graph crawlable.
 */
async function importRenderStack() {
    const specs = {
        context: import('./render/context.js'),
        textures: import('./render/textures.js'),
        streaks: import('./render/streaks.js'),
        earth: import('./render/earth.js'),
        atmosphere: import('./render/atmosphere.js'),
        aurora: import('./render/aurora.js'),
        sky: import('./render/sky.js'),
        bodies: import('./render/bodies.js'),
        totality: import('./render/totality.js'),
        ground: import('./render/ground.js'),
        trails: import('./render/trails.js'),
        eclipsePath: import('./render/eclipse-path.js'),
        beams: import('./render/beams.js'),
        planets: import('./render/planets.js'),
        pin: import('./render/pin.js'),
        flare: import('./render/flare.js'),
        extras: import('./render/extras.js'),
        dso: import('./render/dso.js'),
        precession: import('./render/precession.js'),
        comets: import('./render/comets.js'),
        craft: import('./render/craft.js'),
        orrery: import('./render/orrery.js'),
        longExposure: import('./render/long-exposure.js'),
        ruler: import('./render/ruler.js'),
        edgeChips: import('./render/edge-chips.js'),
        labels: import('./render/labels.js'),
        rig: import('./camera/rig.js'),
        picking: import('./camera/picking.js'),
    };
    const keys = Object.keys(specs);
    const settled = await Promise.allSettled(keys.map((k) => specs[k]));
    /** @type {Record<string, any>} */
    const out = {};
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') out[keys[i]] = r.value;
        else {
            out[keys[i]] = null;
            console.error(`[main] render module '${keys[i]}' failed to load`, r.reason);
        }
    });
    return out;
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
    const env = readEnv();
    loader.progress(0.1, 'Computing the sky');

    // Start everything that does not depend on state right away.
    const uiModP = import('./ui/index.js');
    const renderModsP = env.can3d ? importRenderStack() : null;
    const citiesJsonP = fetchJson('data/cities.json');
    const skyJsonP = env.can3d ? fetchJson('data/sky.json') : null;

    const cities = createCitiesProxy();
    const cityIndexP = citiesJsonP.then((json) => {
        if (!json) return null;
        try {
            const index = loadCities(json, { canonTz: tz.canonTz });
            cities.set(index);
            return index;
        } catch (err) {
            console.error('[main] cities.json could not be indexed', err);
            return null;
        }
    });

    // ---- 1. State: hash → saved → timezone guess → Greenwich --------------------------------
    let hash = {};
    try {
        hash = parseHash(location.hash) ?? {};
    } catch {
        hash = {};
    }
    const savedObserver = loadSavedObserver();
    let observer = null;
    let observerFromDefault = false;
    if (hash.observer) {
        observer = normalizeObserver(hash.observer, { cities, tz });
    } else if (savedObserver) {
        observer = normalizeObserver(savedObserver, { cities, tz });
    } else {
        const index = await withTimeout(cityIndexP, CITY_GUESS_WAIT_MS);
        observer = guessObserver(index);
        observerFromDefault = observer.source === 'default' && !index;
    }

    let decision = { tier: 'low', ceiling: 'low', textMode: !env.can3d, reason: 'text' };
    try {
        decision = detectTier({
            webgl2: env.webgl2, rendererString: env.rendererString, maxTextureSize: env.maxTextureSize, dpr: env.dpr,
            deviceMemory: env.deviceMemory, cores: env.cores, coarse: env.coarse, screenW: env.screenW,
            screenH: env.screenH, saveData: env.saveData,
        });
    } catch (err) {
        console.error('[main] tier detection failed', err);
    }
    // Auto starts where the governor last settled on this GPU (if it dropped a tier recently), so
    // a device that cannot hold its detected tier does not pay the switch hitch on every visit.
    R.rendererString = env.rendererString;
    const governor = createGovernor({
        tier: autoStartTier(decision.ceiling, prefs.load('qualityLearned', null), env.rendererString, Date.now()),
        ceiling: decision.ceiling, coarse: env.coarse, dpr: env.dpr,
        maxTextureSize: env.maxTextureSize || undefined,
    });
    const savedQuality = prefs.load('quality', null);
    const qualitySetting = [hash.quality, savedQuality].find((q) => QUALITY_SETTINGS.includes(q)) ?? 'auto';
    let active = governor.pin(qualitySetting === 'auto' ? null : qualitySetting);
    if (window.__pcSlow && qualitySetting === 'auto') active = governor.pin('low');

    const layers = { ...DEFAULT_STATE.layers, ...(loadSavedLayers() ?? {}), ...(hash.layers ?? {}) };
    // A vantage point (vt=) is a globe-view pose, and needs the 3D view.
    const vantage = env.can3d && (hash.vantage === 'l1' || hash.vantage === 'moon') ? hash.vantage : 'none';
    const view = {
        mode: env.can3d && (hash.view === 'sky' || hash.view === 'map') && vantage === 'none' ? hash.view : 'orbit', earthLock: hash.earthLock ?? true,
        // Body tracking needs the body: trk=b without sel= tracks nothing.
        track: hash.track === 'stars' || (hash.track === 'body' && isSelectionId(hash.selection)) ? hash.track : 'none',
        vantage,
    };
    // A second place to compare with (loc2=): links only, never saved.
    let observer2 = null;
    if (hash.observer2) {
        try { observer2 = normalizeObserver(hash.observer2, { cities, tz }); } catch { observer2 = null; }
    }
    const store = createStore({
        observer,
        observer2,
        selection: isSelectionId(hash.selection) ? hash.selection : null,
        view,
        layers,
        display: {
            ...loadSavedDisplay(), ...(hash.skyDark ? { skyDark: hash.skyDark } : {}), ...(hash.aurora ? { aurora: hash.aurora } : {}),
        },
        quality: { setting: qualitySetting, active, ceiling: decision.ceiling },
        status: {
            phase: 'loading', progress: 0.1, webgl: env.can3d, onlineSearch: 'unknown',
            reducedMotion: env.reducedMotion, coarse: env.coarse, introPlaying: false,
        },
    });
    R.store = store;
    R.governor = governor;
    bindBodyClasses(store);
    bindPreferences(store);
    bindMedia(store);

    // ---- 2. Clock and the first snapshot ----------------------------------------------------
    const clockOpts = {};
    if (Number.isFinite(hash.tMs)) {
        clockOpts.tMs = hash.tMs;
        // A date outside 1000–3000 arrives clamped; it is shown paused (SPEC §E.8).
        clockOpts.playing = hash.playing === true && !timeClamped(hash);
    } else if (hash.playing === false) {
        clockOpts.playing = false;
    }
    if (Number.isFinite(hash.rate)) clockOpts.rate = hash.rate;
    const clock = createClock(clockOpts);
    R.clock = clock;

    const snap = createSnapshot();
    const snapFull = createSnapshot();
    R.snapFull = snapFull;
    try {
        computeSnapshot(clock.tMs, store.get().observer, snapFull, { detail: 'full' });
        computeSnapshot(clock.tMs, store.get().observer, snap, { detail: 'frame' });
    } catch (err) {
        console.error('[main] first snapshot failed', err);
    }

    // ---- Services ---------------------------------------------------------------------------
    const bus = createBus();
    R.bus = bus;
    const geoCache = createLruCache({
        max: 50,
        initial: prefs.load('geocache', []),
        onChange: debounce((entries) => prefs.save('geocache', entries), 1000),
    });
    const geocoder = createGeocoder({
        fetch: (...args) => fetch(...args),
        cache: geoCache,
        onStatus: (s) => {
            const st = store.get().status;
            if (st.onlineSearch !== s) store.set({ status: { ...st, onlineSearch: s } }, 'geocoder');
        },
    });
    let astro = null;
    try {
        astro = createAstroClient();
    } catch (err) {
        console.error('[main] astro client unavailable', err);
    }
    R.astro = astro;
    const services = { cities, geocoder, astro, tz, format };
    // Extra objects beyond the nine bodies: the registry, and the providers that need no download.
    const extras = createExtras();
    R.extras = extras;

    // ---- Actions (render objects are filled in later) ---------------------------------------
    const render = { rig: null, beams: null, pin: null, earth: null, governor };
    const actions = createActions({
        store, bus, clock, prefs, tz, cities, render, astro, extras,
        getSnap: () => snap,
        runIntro: (opts) => runIntro(opts),
        toggleDebug: () => toggleDebug(),
        tours: {
            start: (id) => startTour(id),
            stop: () => R.tours?.stop(),
            next: () => R.tours?.next(),
            resume: () => R.tours?.resume(),
        },
        aim: {
            start: () => startAim(),
            stop: (reason) => R.aim?.stop(reason ?? 'user'),
            align: () => alignAim(),
        },
    });
    R.actions = actions;
    // The eclipse in focus (ui.eclipse, set by an eclipse jump) lapses once the time leaves its day.
    bus.on('readout', (s) => {
        const ui = store.get().ui;
        if (eclipseFocusExpired(ui.eclipse, s?.tMs, clock.tweening)) store.set({ ui: { ...ui, eclipse: null } }, 'actions');
    });

    // ---- 3. Loop (headless until the renderer exists) and the UI ----------------------------
    settle(registerExtras(extras, {
        fetchJson,
        // The deep-sky objects' list goes to their sprites (render/dso.js), whenever both exist.
        onDso: (p) => { R.dsoProvider = p; R.mods.dso?.setProvider?.(p); R.loop?.invalidate?.(); },
    }));
    const loop = createLoop({
        clock, store, bus, snap, snapFull, extras,
        governor: env.webdriver ? null : governor,
        onGovernor: () => applyGovernorStep(),
        onRenderFailure: (err) => enterTextMode('context-failed', err),
    });
    R.loop = loop;
    bindSkySite(store, loop, cities, cityIndexP);
    loop.setAuroraActivity(store.get().display?.aurora ?? 'typical');
    store.subscribe((s) => s.display?.aurora, (a) => loop.setAuroraActivity(a ?? 'typical'));

    try {
        const { mountUI } = await uiModP;
        mountUI(document.getElementById('ui-root'), {
            store, bus, clock, actions, services, extras, env: { coarse: env.coarse, reducedMotion: env.reducedMotion },
        });
        R.uiMounted = true;
    } catch (err) {
        console.error('[main] the interface failed to load; the 3D view keeps running', err);
    }
    loader.progress(0.2, 'Preparing the interface');
    bus.emit('readout', snapFull);
    loop.refreshReadout();
    loop.start();

    // URL ↔ state.
    bindUrl({
        win: window, store, clock, getCam: () => R.rig?.getView?.() ?? null, onExternalChange: (p) => applyHash(p),
        suspended: () => !!store.get().ui.tour,
    });
    reportHashProblems(hash, bus);

    // Late city data: complete a provisional observer (default before cities.json, or a deep
    // link without a timezone) once the index is in.
    cityIndexP.then((index) => {
        if (!index) return;
        const cur = store.get().observer;
        if (observerFromDefault && cur.source === 'default') {
            const guess = guessObserver(index);
            if (guess.source === 'tzguess') store.set({ observer: guess }, 'boot');
        } else if ((cur.source === 'url' || cur.source === 'saved') && (cur.tzApprox || !cur.name || !cur.country)) {
            let refined = null;
            try {
                refined = normalizeObserver({ ...cur, tz: cur.tzApprox ? null : cur.tz }, { cities, tz });
            } catch {
                refined = null;
            }
            const changed = refined && ['name', 'country', 'tz', 'tzApprox'].some((k) => refined[k] !== cur[k]);
            if (changed) store.set({ observer: refined }, 'boot');
        }
    });

    // ---- 4–9. The 3D view -------------------------------------------------------------------
    if (!env.can3d) {
        enterTextMode(env.webgl2 ? 'no-importmap' : 'no-webgl2');
    } else {
        try {
            await bootRender({ env, hash, store, bus, clock, actions, render, loop, snap, governor, renderModsP, skyJsonP, astro, cities });
        } catch (err) {
            enterTextMode('context-failed', err);
        }
    }

    // A `#tour=` link plays once the view is ready (in text mode, as captions and time jumps).
    if (hash.tour) settle(startTour(hash.tour));

    // ---- 10. Idle work ----------------------------------------------------------------------
    idle(() => pushAlmanac({ store, bus, clock, astro }), 3000);
    idle(registerServiceWorker, 6000);
    console.info(`${APP_NAME} ${VERSION} · ${store.get().status.webgl ? `${store.get().quality.active} tier` : 'text mode'} · ready in ${Math.round(performance.now() - startedAt)} ms`);
}

/** Largest city in the device's timezone, else the default (Royal Observatory Greenwich). */
function guessObserver(index) {
    try {
        const place = index?.byTz?.(tz.deviceTz());
        if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) return placeToObserver(place, 'tzguess');
    } catch { /* fall through */ }
    return { ...DEFAULT_STATE.observer };
}

/** True when the link's `t` was out of range and arrived clamped (an unreadable `t` is just invalid). */
function timeClamped(hash) {
    return Array.isArray(hash.invalid) && hash.invalid.includes('t') && Number.isFinite(hash.tMs);
}

function reportHashProblems(hash, bus) {
    const invalid = Array.isArray(hash.invalid) ? hash.invalid : [];
    if (!invalid.length) return;
    const clamped = timeClamped(hash);
    if (clamped) bus.emit('toast', { message: `${APP_NAME} covers years 1000–3000.`, kind: 'warn' });
    if (invalid.some((k) => k !== 't' || !clamped)) {
        bus.emit('toast', { message: 'Some link settings were invalid.', kind: 'warn' });
    }
}

function debounce(fn, ms) {
    let timer = 0;
    let lastArgs = null;
    return (...args) => {
        lastArgs = args;
        clearTimeout(timer);
        timer = setTimeout(() => fn(...lastArgs), ms);
    };
}

// ---------------------------------------------------------------------------------------------
// Store → DOM / prefs bindings
// ---------------------------------------------------------------------------------------------

function bindBodyClasses(store) {
    const b = document.body;
    const sub = (sel, fn) => store.subscribe(sel, fn, { immediate: true });
    sub((s) => s.status.phase, (phase) => b.classList.toggle('is-ready', phase === 'ready'));
    sub((s) => s.ui.cinema, (v) => b.classList.toggle('is-cinema', !!v));
    sub((s) => s.ui.expose, (v) => b.classList.toggle('is-exposing', !!v));
    sub((s) => !!s.ui.tour, (v) => b.classList.toggle('is-touring', v));
    sub((s) => s.view.mode, (m) => {
        b.classList.toggle('is-sky', m === 'sky');
        b.classList.toggle('is-map', m === 'map');
    });
    sub((s) => s.status.coarse, (v) => b.classList.toggle('is-coarse', !!v));
    sub((s) => s.status.reducedMotion, (v) => b.classList.toggle('is-reduced-motion', !!v));
    sub((s) => s.status.webgl, (v) => b.classList.toggle('no-webgl', !v));
    sub((s) => s.quality.active, (t) => {
        b.classList.remove('tier-low', 'tier-medium', 'tier-high', 'tier-max');
        if (isTier(t)) b.classList.add(`tier-${t}`);
    });
    let fadeTimer = 0;
    sub((s) => s.status.introPlaying, (v, prev) => {
        b.classList.toggle('is-intro', !!v);
        if (!v && prev) {
            // The interface fades in as the intro hands over.
            b.classList.add('is-intro-out');
            clearTimeout(fadeTimer);
            fadeTimer = setTimeout(() => b.classList.remove('is-intro-out'), 1000);
        }
    });
}

/**
 * Layers, display and the quality setting persist across visits (the observer is saved by actions).
 * A guided tour's layers are its own: they are not saved, and the tour restores the user's.
 */
function bindPreferences(store) {
    store.subscribe((s) => s.layers, (l) => {
        if (!store.get().ui.tour) prefs.save('layers', l);
    });
    store.subscribe((s) => s.display, (d) => prefs.save('display', d));
    store.subscribe((s) => s.quality.setting, (q) => prefs.save('quality', q));
}

function bindMedia(store) {
    const watch = (query, key) => {
        try {
            const mq = matchMedia(query);
            mq.addEventListener('change', (e) => {
                const st = store.get().status;
                if (st[key] !== e.matches) store.set({ status: { ...st, [key]: e.matches } }, 'media');
            });
        } catch { /* matchMedia unsupported */ }
    };
    watch('(prefers-reduced-motion: reduce)', 'reducedMotion');
    watch('(pointer: coarse)', 'coarse');
}

function setPhase(phase, progress) {
    const store = R.store;
    if (!store) return;
    const st = store.get().status;
    const next = { ...st, phase };
    if (Number.isFinite(progress)) next.progress = progress;
    store.set({ status: next }, 'boot');
    if (phase === 'ready') {
        app.ready = true;
        loader.progress(1, 'Ready');
        loader.done();
    }
}

// ---------------------------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------------------------

let textMode = false;

/**
 * Switches to text mode: banner, no canvas, panels stay live (the loop keeps publishing readouts).
 * @param {'no-webgl2'|'no-importmap'|'context-failed'} reason
 * @param {unknown} [err]
 */
function enterTextMode(reason, err) {
    if (err) console.error(`[main] 3D view unavailable (${reason})`, err);
    if (textMode) return;
    textMode = true;
    try {
        R.loop?.setRenderPaused(true);
    } catch { /* already headless */ }
    showFallback(reason);
    const store = R.store;
    if (store) {
        const st = store.get().status;
        store.set({ status: { ...st, webgl: false } }, 'boot');
        if (st.phase !== 'ready') setPhase('ready', 1);
    } else {
        loader.done();
    }
}

// ---------------------------------------------------------------------------------------------
// The 3D view
// ---------------------------------------------------------------------------------------------

/** The eclipse ribbon's request state (ribbonPlan): the path shown, a request in flight, a known miss. */
const ribbonState = { path: null, pendingMs: NaN, missMs: NaN, seq: 0, retryAt: 0 };
/** Wall-clock wait (ms) before asking again after a failed path request. */
const RIBBON_RETRY_MS = 5000;

/** Shows, loads or clears the globe's eclipse path (render/eclipse-path.js) for the current state. */
function syncEclipseRibbon(store, loop, s) {
    const mod = R.mods.eclipsePath;
    if (!mod || !R.actions?.eclipsePath || !s) return;
    const plan = ribbonPlan(ribbonState, store.get().ui.eclipse, s.tMs, !!s.eclipse?.solar);
    if (plan.action === 'keep') return;
    if (plan.action !== 'clear' && performance.now() < ribbonState.retryAt) return;
    const seq = ++ribbonState.seq;
    if (ribbonState.path) loop.callModule(mod, 'clear');
    ribbonState.path = null;
    ribbonState.pendingMs = NaN;
    if (plan.action === 'clear') return;
    ribbonState.pendingMs = plan.atMs;
    const settleMiss = () => {
        if (seq !== ribbonState.seq) return;
        ribbonState.pendingMs = NaN;
        ribbonState.missMs = plan.atMs;
    };
    R.actions.eclipsePath(plan.atMs).then((path) => {
        if (seq !== ribbonState.seq) return;
        if (!path) return settleMiss();
        ribbonState.pendingMs = NaN;
        ribbonState.missMs = NaN;
        ribbonState.path = path;
        loop.callModule(mod, 'show', path);
    }, () => {
        // A failed request (worker error) is not a known miss: drop it so a later readout retries.
        if (seq !== ribbonState.seq) return;
        ribbonState.pendingMs = NaN;
        ribbonState.retryAt = performance.now() + RIBBON_RETRY_MS;
    });
}

/** Readout-driven housekeeping that needs the render stack (trails refresh). */
let trailsState = { id: '', centerMs: NaN, ac: null };
let introAbort = null;
let debugOverlay = null;
let debugLoading = false;
let currentCfg = null;
let readyFlag = false;

async function bootRender(ctx) {
    const { env, hash, store, bus, clock, render, loop, snap, governor, renderModsP, skyJsonP, astro, cities } = ctx;
    const m = await renderModsP;
    if (!m?.context?.createRenderContext) throw new Error('The 3D engine could not be loaded.');
    loader.progress(0.35, 'Building the globe');

    // Render context.
    const canvas = document.getElementById('scene');
    currentCfg = governor.config();
    const rc = m.context.createRenderContext(canvas, { tierCfg: currentCfg });
    R.rc = rc;
    rc.onInvalidate?.(() => loop.invalidate());

    // Textures (placeholders until loaded).
    let textures = null;
    let texWarned = false;
    try {
        textures = m.textures.createTextureStore(rc.renderer, {
            onProgress: (ev) => {
                if (ev?.error && !texWarned) {
                    texWarned = true;
                    bus.emit('toast', { message: "Some imagery couldn't load.", kind: 'warn' });
                }
                updateLoaderProgress();
                loop.invalidate();
            },
        });
    } catch (err) {
        console.error('[main] texture store unavailable', err);
        textures = null;
    }
    R.textures = textures;
    R.texMod = m.textures;
    textures?.setAnisotropy?.(currentCfg.anisotropy);

    // Star catalog (already decoded if sky.json beat the 3D engine here).
    let catalog = null;
    const catalogP = (skyJsonP ?? Promise.resolve(null)).then((json) => {
        if (!json) return null;
        try {
            return decodeSky(json);
        } catch (err) {
            console.error('[main] sky.json could not be decoded', err);
            return null;
        }
    });
    catalog = await withTimeout(catalogP, 0);

    // Modules, each isolated: a failure skips that feature only.
    const names = new Map();
    const modules = [];
    // The observer's furniture (beams, pin, medallions, paths, the eclipse ribbon, the flare) sits in
    // one group that a vantage point hides: L1 and lunar orbit show the Earth as a camera would.
    const furniture = new rc.THREE.Group();
    furniture.name = 'furniture';
    rc.scene.add(furniture);
    R.furniture = furniture;
    // What the flat map has no place for (the loop hides both groups while the globe is unrolled): the
    // bodies in space, and the furniture that points into it (beams, medallions, paths, the eclipse
    // ribbon, the flare). The pins stay: they ride the morph onto the map.
    const space = new rc.THREE.Group();
    space.name = 'space';
    rc.scene.add(space);
    const furnitureSpace = new rc.THREE.Group();
    furnitureSpace.name = 'furniture.space';
    furniture.add(furnitureSpace);
    const create = (name, factory, parent = rc.scene) => {
        if (!factory) return null;
        try {
            const mod = factory();
            if (!mod || !mod.object3d) throw new Error(`${name}: factory returned no object3d`);
            parent.add(mod.object3d);
            modules.push(mod);
            names.set(mod, name);
            R.mods[name] = mod;
            return mod;
        } catch (err) {
            console.error(`[main] ${name} could not be created; continuing without it`, err);
            return null;
        }
    };
    const rm = env.reducedMotion;
    // One landscape profile for the whole stack: the ground builds and draws it; bodies (picking),
    // the flare and the labels test against it, so they all agree with the silhouette.
    const horizon = createHorizon();
    R.horizon = horizon;
    // Fast-time streaks: shared uniforms for the stars and planet glyphs, set by its update().
    create('streaks', m.streaks && (() => m.streaks.createStreaks(rc, { store, reducedMotion: rm })));
    const earth = create('earth', m.earth && (() => m.earth.createEarth(rc, { textures, reducedMotion: rm })));
    create('aurora', m.aurora && (() => m.aurora.createAurora(rc, { reducedMotion: rm })));
    create('atmosphere', m.atmosphere && (() => m.atmosphere.createAtmosphere(rc)));
    const sky = create('sky', m.sky && (() => m.sky.createSky(rc, { catalog: catalog ?? emptyCatalog(), textures, reducedMotion: rm })));
    // Deep-sky objects (astro/dso.js, data/dso.json) as faint true-size sprites; the precession
    // circle, the pole of date and the equinox points (the 'precession' layer).
    create('dso', m.dso && (() => m.dso.createDsoLayer(rc, { provider: R.dsoProvider ?? null })));
    create('precession', m.precession && (() => m.precession.createPrecession(rc)));
    create('bodies', m.bodies && (() => m.bodies.createBodies(rc, { textures, horizon })), space);
    create('totality', m.totality && (() => m.totality.createTotality(rc)), space);
    create('ground', m.ground && (() => m.ground.createGround(rc, { textures, horizon, cities })));
    const trails = create('trails', m.trails && (() => m.trails.createTrails(rc)), furnitureSpace);
    const eclipseRibbon = create('eclipsePath', m.eclipsePath && (() => m.eclipsePath.createEclipsePath(rc)), furnitureSpace);
    const beams = create('beams', m.beams && (() => m.beams.createBeams(rc, { reducedMotion: rm })), furnitureSpace);
    // The second place's beams (two-observers: dashed, amber), from snap.second.
    create('beams2', m.beams && (() => m.beams.createBeams(rc, { reducedMotion: rm, second: true })), furnitureSpace);
    // After the beams: the medallions sit on the label anchors the beams compute each frame.
    create('planets', m.planets && (() => m.planets.createPlanets(rc, { beams, isLabelShown: (id) => R.labels?.isShown?.(id) ?? null })), furnitureSpace);
    const pin = create('pin', m.pin && (() => m.pin.createPin(rc)), furniture);
    create('pin2', m.pin && (() => m.pin.createPin(rc, { second: true, reducedMotion: rm })), furniture);
    create('flare', m.flare && (() => m.flare.createFlare(rc, { horizon })), furnitureSpace);
    // Extra objects (astro/extras.js): their glyphs and reticle at infinity, Halley's tails, the
    // spacecraft's radio beams from the pin.
    create('extras', m.extras && (() => m.extras.createExtrasLayer(rc, { extras: R.extras, sky })), space);
    create('comets', m.comets && (() => m.comets.createComets(rc, { extras: R.extras })), space);
    create('craft', m.craft && (() => m.craft.createCraftBeams(rc, { extras: R.extras, reducedMotion: rm })), furnitureSpace);
    // The angle ruler (sky view): its reading goes to ui.ruler and, as a label, to the feed.
    create('ruler', m.ruler && (() => m.ruler.createRuler(rc, { onChange: (r) => onRulerChange(r) })));
    // The solar-system zoom's orrery: its own scene and camera, drawn over the main scene.
    const orrery = create('orrery', m.orrery && (() => m.orrery.createOrrery(rc, {
        requestOrbits: (centerMs) => (R.astro ? R.astro.call('orbits', { centerMs }) : Promise.reject(new Error('no astro client'))),
        requestMoonOrbit: (centerMs) => (R.astro ? R.astro.call('moonOrbit', { centerMs }) : Promise.reject(new Error('no astro client'))),
    })));
    if (orrery) rc.setOverlay?.(orrery.scene, orrery.camera);

    // Labels and camera rig.
    let labels = null;
    try {
        labels = m.labels?.createLabels(document.getElementById('labels-root'), { cap: currentCfg.labelCap });
    } catch (err) {
        console.error('[main] labels unavailable', err);
        labels = null;
    }
    // A time-lapse recording drives the rig's tweens on its own (virtual) time base.
    const rig = m.rig?.createRig ? m.rig.createRig(rc, { dom: canvas, reducedMotion: rm, now: () => R.virtualNow ?? performance.now() }) : null;
    if (!rig) throw new Error('The camera rig could not be created.');
    R.rig = rig;
    R.labels = labels;
    // Long exposure (Expose in sky view): stacks rendered frames while ui.expose is set.
    render.longExposure = create('longExposure', m.longExposure && (() => m.longExposure.createLongExposure(rc, { rig, store, clock })));
    // Off-screen pointers (sky view): chips at the edge for bodies outside the field; a tap turns there.
    create('edgeChips', m.edgeChips && (() => m.edgeChips.createEdgeChips(rc, {
        root: document.getElementById('labels-root'),
        onActivate: (id) => { if (isBodyId(id)) R.actions.select(id, { fly: true }); },
    })));
    render.capture = createCapture({ getRc: () => R.rc, getLoop: () => R.loop, getFeed: () => R.labelsFeed });
    // The time-lapse recorder (app/recorder.js, loaded by actions.recordVideo).
    render.video = { getRc: () => R.rc, getLoop: () => R.loop, setNow: (ms) => { R.virtualNow = Number.isFinite(ms) ? ms : null; } };
    render.rig = rig;
    render.beams = beams;
    render.pin = pin;
    render.earth = earth;
    render.eclipsePath = eclipseRibbon;

    const labelsFeed = labels ? createLabelsFeed({
        labels, store, snap,
        getCatalog: () => R.catalog,
        getTrails: () => R.mods.trails ?? null,
        getBeams: () => R.mods.beams ?? null,
        getPin: () => R.mods.pin ?? null,
        getPlanets: () => (R.mods.planets && !R.loop?.isDisabled?.(R.mods.planets) ? R.mods.planets : null),
        getRuler: () => (R.mods.ruler && !R.loop?.isDisabled?.(R.mods.ruler) ? R.mods.ruler : null),
        getOrrery: () => (R.mods.orrery && !R.loop?.isDisabled?.(R.mods.orrery) ? R.mods.orrery : null),
        // Sky-view guide labels with their own anchors (render/precession.js: years, pole stars, equinoxes).
        getSkyMarks: () => (R.mods.precession && !R.loop?.isDisabled?.(R.mods.precession) ? [R.mods.precession] : []),
        extras: R.extras,
    }) : null;
    R.labelsFeed = labelsFeed;
    loader.progress(0.45, 'Loading imagery');

    // Initial module state.
    const st0 = store.get();
    for (const mod of modules) {
        loop.callModule(mod, 'setQuality', currentCfg);
        loop.callModule(mod, 'setLayers', drawnLayers(st0));
        loop.callModule(mod, 'setSelection', st0.selection);
        loop.callModule(mod, 'apply', snap);
    }
    if (pin) loop.callModule(pin, 'setObserver', st0.observer.latDeg, st0.observer.lonDeg);
    rig.setEarthLock?.(st0.view.earthLock);
    rig.setTracking?.(st0.view.track, st0.selection);

    // Catalog: install now or when it arrives.
    const installCatalog = (cat) => {
        if (!cat) {
            bus.emit('toast', { message: "The star catalogue couldn't load — stars and constellations are hidden.", kind: 'warn' });
            return;
        }
        R.catalog = cat;
        R.baseCatalog = cat;
        if (sky && typeof sky.setCatalog === 'function') loop.callModule(sky, 'setCatalog', cat);
        else if (sky && m.sky) replaceSky(m.sky, rc, cat, textures, rm);
        labelsFeed?.markDirty();
        loop.invalidate();
        afterCatalog();
    };
    // Catalogue stars become selectable (astro/stars.js) and the max tier's deeper stars load.
    const afterCatalog = () => {
        if (!R.starExtras && R.extras) {
            try {
                R.starExtras = registerStars(R.extras, {
                    getCatalog: () => R.catalog,
                    fetchJson,
                    onInfo: () => { labelsFeed?.markDirty(); loop.invalidate(); },
                });
                R.starExtras.sync(store.get().selection);
                store.subscribe((s) => s.selection, (sel) => R.starExtras?.sync(sel));
            } catch (err) {
                console.error('[main] catalogue stars could not be made selectable', err);
            }
        }
        syncDeepStars(currentCfg);
    };
    if (catalog) {
        R.catalog = catalog;
        R.baseCatalog = catalog;
        afterCatalog();
    } else catalogP.then(installCatalog);

    // 5. Critical textures, 6. compile.
    const keys = textures && m.textures.keysForTier ? m.textures.keysForTier(currentCfg) : { critical: [], deferred: [] };
    const criticalP = textures ? textures.load(keys.critical) : Promise.resolve();
    updateLoaderProgress();
    await withTimeout(rc.compile(), COMPILE_MAX_WAIT_MS);
    compiled = true;
    updateLoaderProgress();

    // Camera: a deep-link view, or sky view; otherwise the rig homes itself on its first snapshot
    // (straight above the observer, north up), which is also where the intro ends.
    const introWanted = wantIntro(env, hash, store);
    try {
        if (hash.cam) rig.setView?.(hash.cam);
        rig.update?.(0, snap);
        if (!hash.cam && st0.view.mode === 'sky') settle(rig.setMode?.('sky', { animate: false, look: selectionLook(store.get().selection, snap) }));
        // The flat map from the link (view=map): unrolled at once (its `cam` is m:lat,lon,dist).
        if (st0.view.mode === 'map' && hash.cam?.mode !== 'map') settle(rig.setMode?.('map', { animate: false }));
        // A vantage point from the link (vt=): cut there; `cam` is the orbit pose it returns to.
        if (st0.view.vantage !== 'none') settle(rig.setVantage?.(st0.view.vantage, { animate: false }));
    } catch (err) {
        console.error('[main] initial camera placement failed', err);
    }
    bindViewInsets(rig, store);

    // 7. Render.
    loop.attach({
        rc, rig, modules, moduleNames: names, labels, labelsFeed, governor: env.webdriver ? null : governor,
        getTierCfg: () => currentCfg, horizon, mapHidden: [space, furnitureSpace],
    });
    bindRenderState({ store, bus, clock, rc, rig, loop, snap, astro, m, labels, labelsFeed, textures });

    // 8. Ready: critical imagery, or 5 s, or "continue with low detail".
    const slowP = loader.slow.then(() => 'slow');
    const outcome = await Promise.race([criticalP.then(() => 'textures'), delay(READY_MAX_WAIT_MS).then(() => 'timeout'), slowP]);
    if (outcome === 'slow' && store.get().quality.setting === 'auto') {
        governor.pin('low');
        store.set({ quality: { ...store.get().quality, active: 'low' } }, 'boot');
    }
    readyFlag = true;
    setPhase('ready', 1);

    // 9. Intro (first visit) or a quick launch.
    if (introWanted) {
        settle(runIntro({ preRoll: true }));
    } else if (st0.view.mode === 'orbit' && !hash.cam && st0.view.vantage === 'none') {
        try {
            settle(beams?.launch?.({ staggerMs: rm ? 0 : 90 }));
            if (!rm) settle(pin?.drop?.());
        } catch { /* cosmetic */ }
    }

    // 10. Deferred imagery once the first frames are out.
    idle(() => {
        if (textures) settle(textures.load(m.textures.keysForTier(currentCfg).deferred));
    }, 1500);
    if (hash.debug) settle(setDebug(true));
}

let compiled = false;

function updateLoaderProgress() {
    if (readyFlag) return;
    const p = R.textures?.progress?.() ?? { loaded: 0, total: 0 };
    const tex = p.total > 0 ? Math.min(1, p.loaded / p.total) : 0;
    const f = 0.45 + 0.4 * tex + (compiled ? 0.1 : 0);
    loader.progress(Math.min(0.98, f), tex < 1 ? 'Loading imagery' : 'Warming up the shaders');
}

/** The max tier's deeper stars (scripts/build-stars.mjs; ≈ 1.1 MB, fetched only on that tier). */
const DEEP_STARS_URL = 'data/stars8.json';
let deepStarsP = null;

/**
 * The max tier draws the base catalogue plus data/stars8.json (V 6–8, catalog.js mergeDeepStars),
 * so the telescope's aperture gain has stars to reveal; any other tier goes back to the base
 * catalogue. Fetched once, the first time max is active (offline only after that first use).
 * @param {any} cfg the active TierCfg
 */
function syncDeepStars(cfg) {
    const base = R.baseCatalog;
    const sky = R.mods.sky;
    if (!base || !sky || typeof sky.setCatalog !== 'function') return;
    const want = cfg?.deepStars === true;
    if (!want) {
        if (R.catalog !== base) {
            R.catalog = base;
            R.loop?.callModule(sky, 'setCatalog', base);
            R.extras?.refresh();
            R.labelsFeed?.markDirty();
            R.loop?.invalidate();
        }
        return;
    }
    if (R.catalog !== base && R.catalog?.stars?.baseCount) return;   // already merged
    deepStarsP ??= fetchJson(DEEP_STARS_URL, 30000).then((json) => {
        if (!json) { deepStarsP = null; return null; }
        try {
            return mergeDeepStars(R.baseCatalog, json);
        } catch (err) {
            console.error('[main] data/stars8.json could not be decoded', err);
            return null;
        }
    });
    deepStarsP.then((merged) => {
        if (!merged || currentCfg?.deepStars !== true || R.catalog === merged) return;
        R.catalog = merged;
        R.loop?.callModule(R.mods.sky, 'setCatalog', merged);
        R.extras?.refresh();
        R.labelsFeed?.markDirty();
        R.loop?.invalidate();
    });
}

/** Scratch: the true direction under a tap (picking.js skyTapDir). */
const TAP_DIR = new Float64Array(3);

/**
 * A deep-sky object or catalogue star under a tap (sky view, or orbit view where the tap misses
 * the globe): render/dso.js pick, then render/sky.js pickStar, both on the sphere at the tap's
 * true direction. Returns a selection id or null.
 */
function pickSkyObject({ store, rc, rig, snap, pick, ndc, camera }) {
    if (!pick?.skyTapDir || !camera) return null;
    const sky = store.get().view.mode === 'sky';
    const k = sky ? Math.max(0, Math.min(1, rig.skyBlend ?? 1)) : 0;
    if (!sky && (rig.skyBlend ?? 0) < 0.5 && pick.pickEarth?.(ndc, camera, snap.earthMatrix)) return null;
    if (!pick.skyTapDir(ndc, camera, sky ? snap.observer.upS : null, k, TAP_DIR)) return null;
    const h = rc.size?.h || 800;
    const radPerPx = ((camera.fov || 45) * Math.PI / 180) / h;
    let id = null;
    try {
        id = R.mods.dso && !R.loop?.isDisabled?.(R.mods.dso) ? R.mods.dso.pick?.(TAP_DIR, radPerPx) ?? null : null;
        if (!id) {
            const s = R.mods.sky?.pickStar?.(TAP_DIR, radPerPx, 14) ?? null;
            if (s && s.hip > 0) id = `star:${s.hip}`;
        }
    } catch (err) {
        console.error('[main] sky-object picking failed', err);
        return null;
    }
    // A star gets its registry slot before the selection lands, so 'fly' finds it in this snapshot.
    if (id && id.startsWith('star:') && R.starExtras) {
        R.starExtras.sync(id);
        try { R.extras?.fill(snap); } catch { /* the loop fills it next frame */ }
    }
    return id;
}

/** The sky module without setCatalog(): rebuild it with the catalog and swap it in place. */
function replaceSky(skyMod, rc, catalog, textures, reducedMotion) {
    const prev = R.mods.sky;
    try {
        const next = skyMod.createSky(rc, { catalog, textures, reducedMotion });
        if (prev) {
            rc.scene.remove(prev.object3d);
            try { prev.dispose?.(); } catch { /* ignore */ }
        }
        rc.scene.add(next.object3d);
        R.mods.sky = next;
        R.loop.replaceModule(prev, next, 'sky');
        const st = R.store.get();
        R.loop.callModule(next, 'setQuality', currentCfg);
        R.loop.callModule(next, 'setLayers', drawnLayers(st));
        R.loop.callModule(next, 'setSelection', st.selection);
    } catch (err) {
        console.error('[main] sky rebuild failed', err);
    }
}

function wantIntro(env, hash, store) {
    if (env.reducedMotion || hash.intro === false || hash.tour || store.get().view.vantage !== 'none') return false;
    if (hash.intro === true) return true;
    if (hash.cam || store.get().view.mode !== 'orbit') return false;
    return !prefs.load('introSeen', false);
}

/**
 * The layers the renderers draw: the store's, minus the chart overlays (constellation figures, grids,
 * the ecliptic, the visibility footprint and sub-points) while a vantage point shows the Earth as a
 * camera out there would. The store keeps the user's choices.
 */
const VANTAGE_LAYERS_OFF = Object.freeze({ constellations: false, eqGrid: false, ecliptic: false, altAzGrid: false, footprint: false, subpoints: false });
/**
 * The flat map (view.mode 'map') is a map, not a sky: no star chart behind it, and the sub-points
 * (where each body stands overhead) always on, since they are what the map is for.
 */
const MAP_LAYERS = Object.freeze({ constellations: false, eqGrid: false, ecliptic: false, altAzGrid: false, subpoints: true });
function drawnLayers(st) {
    // Until the flight back has landed, the furniture (main's vantage subscriber) is still away too.
    let l = st.view.vantage !== 'none' || R.furniture?.visible === false ? { ...st.layers, ...VANTAGE_LAYERS_OFF } : st.layers;
    if (st.view.mode === 'map') l = { ...l, ...MAP_LAYERS };
    // A long exposure (ui.expose) draws the photo layers: no line art.
    return st.ui.expose ? photoLayers(l) : l;
}

/** Wires store changes, input and GPU events to the render stack. */
function bindRenderState({ store, bus, clock, rc, rig, loop, snap, astro, m, labels, labelsFeed, textures }) {
    // Layers / selection / observer → modules. While a long exposure runs (ui.expose) the renderers
    // get the photo layers (no line art, drawnLayers) and no selection (no reticle); the store keeps both.
    const exposing = () => !!store.get().ui.expose;
    store.subscribe((s) => s.layers, () => {
        loop.broadcast('setLayers', drawnLayers(store.get()));
        updateTrails({ store, clock, astro, loop, labelsFeed });
    });
    store.subscribe((s) => s.selection, (id) => {
        loop.broadcast('setSelection', exposing() ? null : id);
        updateTrails({ store, clock, astro, loop, labelsFeed });
    });
    store.subscribe((s) => !!s.ui.expose, (on) => {
        const st = store.get();
        loop.broadcast('setLayers', drawnLayers(st));
        loop.broadcast('setSelection', on ? null : st.selection);
        // No lens-flare ghosts in the stack, and steady stars (no twinkle beads along the trails).
        const flare = R.mods.flare;
        if (flare && !loop.isDisabled(flare)) flare.object3d.visible = !on;
        if (R.mods.sky) loop.callModule(R.mods.sky, 'setReducedMotion', on || !!st.status.reducedMotion);
    });
    store.subscribe((s) => s.observer, (o) => {
        const pin = R.mods.pin;
        if (pin) loop.callModule(pin, 'setObserver', o.latDeg, o.lonDeg);
    });
    // A new second place drops its pin (cosmetic; the loop's snapshot places it).
    store.subscribe((s) => s.observer2, (o2) => {
        const pin2 = R.mods.pin2;
        if (!pin2 || !o2 || store.get().status.reducedMotion) return;
        loop.callModule(pin2, 'setObserver', o2.latDeg, o2.lonDeg);
        try { settle(pin2.drop?.()); } catch { /* cosmetic */ }
    });
    store.subscribe((s) => s.view.earthLock, (on) => {
        try { rig.setEarthLock?.(on); } catch (err) { console.error('[main] earth-lock failed', err); }
    });
    // Sky-view tracking follows the store; body tracking follows the selection (and ends with it).
    store.subscribe((s) => `${s.view.track ?? 'none'}|${s.selection ?? ''}`, () => {
        const st = store.get();
        const kind = st.view.track ?? 'none';
        if (kind === 'body' && !st.selection) {
            store.set({ view: { ...st.view, track: 'none' } }, 'rig');
            return;
        }
        // Tracking (Telescope, K) takes the look: the phone no longer steers it.
        if (kind !== 'none' && R.aim?.active) R.aim.stop('track');
        try { rig.setTracking?.(kind, st.selection); } catch (err) { console.error('[main] tracking failed', err); }
    });
    rig.onTrackEnd?.(({ reason, kind, id }) => {
        const st = store.get();
        if ((st.view.track ?? 'none') !== 'none') store.set({ view: { ...st.view, track: 'none' } }, 'rig');
        const what = kind === 'body' && isBodyId(id) ? bodyById(id).name
            : kind === 'body' && isExtraId(id) ? R.extras?.meta(id)?.name ?? 'The tracked object' : 'The tracked field';
        if (reason === 'set') bus.emit('toast', { message: `Tracking stopped: ${what} set below the horizon.`, kind: 'info' });
    });
    store.subscribe((s) => s.view.mode, (mode, prev, _state, source) => {
        // A long exposure, the ruler and pointing are sky-view things: the globe ends them.
        if (mode !== 'sky' && store.get().ui.expose) R.actions?.expose?.(null);
        if (mode !== 'sky' && store.get().ui.ruler) R.actions?.setRuler?.(false);
        if (mode !== 'sky') R.aim?.stop('view');
        // The map draws its own layers (drawnLayers: sub-points on, no star chart).
        if (mode === 'map' || prev === 'map') loop.broadcast('setLayers', drawnLayers(store.get()));
        try {
            // No look of its own after an event jump, which has already aimed the rig (viewModeLook).
            const look = viewModeLook(mode, source, store.get().selection, snap);
            settle(rig.setMode?.(mode, { animate: !store.get().status.reducedMotion, look }));
        } catch (err) {
            console.error('[main] view change failed', err);
        }
    });
    // Vantage points (after the view.mode subscriber, so a switch to sky view leads): the rig flies
    // there and back; the observer's furniture and the labels go as the flight starts and return
    // once the camera is home. Another camera move ending a vantage clears it here.
    const showFurniture = (on) => {
        if (R.furniture) R.furniture.visible = on;
        document.body.classList.toggle('is-vantage', !on);
        loop.broadcast('setLayers', drawnLayers(store.get()));
    };
    showFurniture(store.get().view.vantage === 'none');
    store.subscribe((s) => s.view.vantage, (vt) => {
        if (vt !== 'none') showFurniture(false);
        let p = null;
        try {
            p = rig.setVantage?.(vt, { animate: !store.get().status.reducedMotion });
        } catch (err) {
            console.error('[main] vantage change failed', err);
        }
        Promise.resolve(p).catch(() => false).then(() => {
            if (store.get().view.vantage === 'none' && rig.vantage === 'none') showFurniture(true);
        });
    });
    // The solar-system zoom: view.system (the UI's caption) and a body class follow the crossfade.
    const showSystem = (shown) => {
        document.body.classList.toggle('is-system', shown);
        const st = store.get();
        if (!!st.view.system !== shown) store.set({ view: { ...st.view, system: shown } }, 'rig');
    };
    rig.onSystemChange?.(({ shown }) => showSystem(shown));
    // A link straight into the solar system has crossed over before anyone listened; a restored
    // view (a tour's end) cannot set it either way: the rig says.
    if (rig.systemShown) showSystem(true);
    store.subscribe((s) => !!s.view.system, (v) => {
        const shown = !!rig.systemShown;
        if (v !== shown) showSystem(shown);
    });
    rig.onVantageEnd?.(({ reason }) => {
        const st = store.get();
        if (st.view.vantage !== 'none') store.set({ view: { ...st.view, vantage: 'none' } }, 'rig');
        if (reason === 'failed') bus.emit('toast', { message: "That vantage point couldn't load.", kind: 'warn' });
    });
    // The ruler turned off: its arc and label go.
    store.subscribe((s) => !!s.ui.ruler, (on) => {
        if (on || !R.mods.ruler) return;
        loop.callModule(R.mods.ruler, 'clear');
        labelsFeed?.markDirty();
    });
    store.subscribe((s) => s.status.reducedMotion, (v) => {
        for (const mod of [R.mods.sky, R.mods.beams, R.mods.pin]) if (mod) loop.callModule(mod, 'setReducedMotion', v || (mod === R.mods.sky && exposing()));
        try { rig.setReducedMotion?.(v); } catch { /* the rig keeps its boot-time setting */ }
    });
    store.subscribe((s) => s.quality, () => applyTierCfg(R.governor.config()));

    // Trails follow simulated time (re-centred when the clock has moved far from the path centre).
    bus.on('readout', (s) => {
        if (!trailsState.id) return;
        const span = trailsState.id === 'moon' ? TRAIL_SPAN.moon : TRAIL_SPAN.default;
        if (Math.abs(s.tMs - trailsState.centerMs) > span.refreshDays * 864e5) updateTrails({ store, clock, astro, loop, labelsFeed, force: true });
    });
    if (store.get().layers.trails && store.get().selection) updateTrails({ store, clock, astro, loop, labelsFeed });

    // The globe's eclipse ribbon: the eclipse in focus, else one in progress (ribbonPlan).
    let lastReadout = null;
    bus.on('readout', (s) => {
        lastReadout = s;
        syncEclipseRibbon(store, loop, s);
    });
    store.subscribe((s) => s.ui.eclipse, () => syncEclipseRibbon(store, loop, lastReadout ?? snap));
    syncEclipseRibbon(store, loop, snap);

    // Clicks on the globe / glyphs; labels.
    const pick = m.picking;
    let lastClick = { t: 0, x: 0, y: 0 };
    const ndc = { x: 0, y: 0, ndcX: 0, ndcY: 0 };
    rig.onClick?.((ev) => {
        if (!ev || store.get().status.introPlaying) return;
        const now = performance.now();
        // The rig reports double clicks itself; fall back to timing them here.
        const dbl = typeof ev.double === 'boolean' ? ev.double
            : now - lastClick.t < DOUBLE_CLICK_MS && Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < DOUBLE_CLICK_PX;
        lastClick = { t: dbl ? 0 : now, x: ev.clientX, y: ev.clientY };
        ndc.x = ndc.ndcX = ev.ndcX;
        ndc.y = ndc.ndcY = ev.ndcY;
        handleSceneClick({ store, rc, rig, snap, pick, ndc, dbl });
    });
    labels?.onActivate?.((id) => {
        const s = store.get();
        if (id === 'observer') {
            store.set({ ui: { ...s.ui, palette: true } }, 'labels');
            return;
        }
        if (id === 'observer2') {
            store.set({ ui: { ...s.ui, palette: 'compare' } }, 'labels');
            return;
        }
        if (id === 'earth') {
            R.actions.setSystem?.(false);
            return;
        }
        if (isSelectionId(id)) {
            R.actions.select(id);
            store.set({ ui: { ...store.get().ui, panel: 'details' } }, 'labels');
            return;
        }
        const a = labelsFeed?.anchorById?.(id);
        if (a && Number.isFinite(a.tMs)) {
            clock.pause();
            clock.setTime(a.tMs, { animateMs: s.status.reducedMotion ? 0 : 900 });
        }
    });

    // GPU context loss.
    rc.onContextLost?.(() => {
        loop.setRenderPaused(true);
        showContextLost();
    });
    rc.onContextRestored?.(() => {
        try {
            textures?.restore?.();
        } catch (err) {
            console.error('[main] texture restore failed', err);
        }
        hideContextLost();
        loop.setRenderPaused(false);
        loop.invalidate();
    });
}

/**
 * Keeps the globe centred in the part of the screen the interface leaves free: left of the
 * desktop side panel and above the time bar, or above the mobile bottom sheet. Measured from
 * G7's layout (`#ui-root[data-layout]`, `.panel`, `.timebar`, `.sheet`) whenever it changes.
 * Cinema mode (UI hidden) uses the whole screen.
 * @param {any} rig
 * @param {any} store
 */
function bindViewInsets(rig, store) {
    if (typeof rig?.setViewInsets !== 'function') return;
    const root = document.getElementById('ui-root');
    if (!root) return;
    let frame = 0;
    let lastKey = '';
    let lastLayout = '';
    const clampPx = (v, max) => Math.round(Math.min(max, Math.max(0, v)));
    const measure = () => {
        frame = 0;
        const W = window.innerWidth, H = window.innerHeight;
        const ins = { left: 0, right: 0, top: 0, bottom: 0 };
        if (!store.get().ui.cinema) {
            const layout = root.dataset.layout;
            if (layout !== lastLayout) { lastLayout = layout; watch(); }
            if (layout === 'desktop') {
                const panel = root.querySelector('.panel')?.getBoundingClientRect();
                if (panel && panel.width > 0 && panel.left > W * 0.4) ins.right = clampPx(W - panel.left, W * 0.5);
                const bar = root.querySelector('.timebar')?.getBoundingClientRect();
                if (bar && bar.height > 0 && bar.top > H * 0.5) ins.bottom = clampPx(H - bar.top, H * 0.4);
            } else if (layout === 'mobile') {
                const sheet = root.querySelector('.sheet')?.getBoundingClientRect();
                if (sheet && sheet.height > 0) ins.bottom = clampPx(H - sheet.top, H * 0.55);
            }
        }
        const key = `${ins.left},${ins.right},${ins.top},${ins.bottom}`;
        if (key === lastKey) return;
        lastKey = key;
        try {
            rig.setViewInsets(ins);
        } catch (err) {
            console.error('[main] view insets failed', err);
        }
    };
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(measure);
    };
    // Classes and the layout anywhere in the UI; inline styles only where they move the sheet
    // (the root's --sheet-h and the sheet's drag transform). Watching `style` on the whole
    // subtree woke this up on every time-bar thumb and tooltip write.
    let styleObs = null;
    try {
        new MutationObserver(schedule).observe(root, { attributes: true, subtree: true, attributeFilter: ['class', 'data-layout'] });
        styleObs = new MutationObserver(schedule);
        styleObs.observe(root, { attributes: true, attributeFilter: ['style'] });
    } catch { /* very old browser: window resize still works */ }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const watched = new Set();
    // The sheet exists only in the phone layout, so the set is refreshed after layout switches.
    const watch = () => {
        for (const sel of ['.panel', '.timebar', '.sheet']) {
            const el = root.querySelector(sel);
            if (!el || watched.has(el)) continue;
            watched.add(el);
            ro?.observe(el);
            if (sel === '.sheet') styleObs?.observe(el, { attributes: true, attributeFilter: ['style'] });
        }
    };
    watch();
    window.addEventListener('resize', schedule);
    store.subscribe((s) => s.ui.cinema, schedule);
    schedule();
}

/**
 * A click (not a drag) on the canvas: a body glyph selects it (double-click flies to it);
 * the globe in orbit view moves the observer (double-click flies closer); in sky view a
 * double-click on empty sky centres it.
 */
function handleSceneClick({ store, rc, rig, snap, pick, ndc, dbl }) {
    // A vantage point is a camera, not a map: nothing to pick from 1.5 million km.
    if (store.get().view.vantage !== 'none' || (rig.vantage ?? 'none') !== 'none') return;
    const camera = rig.camera ?? rc.camera;
    if (store.get().ui.ruler && store.get().view.mode === 'sky' && R.mods.ruler) {
        rulerTap({ rc, camera, snap, pick, ndc });
        return;
    }
    if (store.get().view.mode === 'map' || (rig.mapK ?? 0) > 0) {
        handleMapClick({ store, rc, rig, snap, pick, ndc, dbl, camera });
        return;
    }
    let id = null;
    if ((rig.systemBlend ?? 0) >= 0.5) {
        // The solar-system zoom: the orrery's sprites and edge arrows; the Earth flies back home.
        try {
            id = R.mods.orrery?.pick?.(ndc.x, ndc.y) ?? null;
        } catch (err) {
            console.error('[main] orrery picking failed', err);
        }
        if (id === 'earth') settle(R.actions.setSystem?.(false));
        else if (id && isBodyId(id)) {
            R.actions.select(id);
            store.set({ ui: { ...store.get().ui, panel: 'details' } }, 'click');
        }
        return;
    }
    try {
        const cands = R.mods.bodies?.pickCandidates?.() ?? snap.bodies.map((b) => ({ id: b.id, dirS: b.dirS }));
        id = pick?.pickDir?.(ndc, camera, cands, rc.size, 18) ?? null;
    } catch (err) {
        console.error('[main] body picking failed', err);
    }
    if (!id) {
        // Extra objects (render/extras.js: guest stars, comets, spacecraft), at their drawn places.
        try {
            const cands = R.mods.extras?.pickCandidates?.() ?? null;
            if (cands && cands.length) id = pick?.pickDir?.(ndc, camera, cands, rc.size, 16) ?? null;
        } catch (err) {
            console.error('[main] extra-object picking failed', err);
        }
    }
    // Deep-sky objects and catalogue stars, on the sphere.
    if (!id) id = pickSkyObject({ store, rc, rig, snap, pick, ndc, camera });
    if (id && isSelectionId(id)) {
        R.actions.select(id, { fly: dbl });
        store.set({ ui: { ...store.get().ui, panel: 'details' } }, 'click');
        return;
    }
    if (store.get().view.mode === 'sky') {
        // Empty sky: a double-click glides there and zooms in a little (the rig ignores it mid-transition).
        if (dbl) settle(rig.centerAt?.(ndc.x, ndc.y));
        return;
    }
    if ((rig.skyBlend ?? 0) > 0.5) return;
    let ll = null;
    try {
        ll = pick?.pickEarth?.(ndc, camera, snap.earthMatrix) ?? null;
    } catch (err) {
        console.error('[main] globe picking failed', err);
    }
    if (!ll || !Number.isFinite(ll.latDeg) || !Number.isFinite(ll.lonDeg)) return;
    if (dbl) {
        const d = Math.hypot(camera.position.x, camera.position.y, camera.position.z);
        settle(rig.flyToLatLon?.(ll.latDeg, ll.lonDeg, { distance: Math.max(1.5, Math.min(d, 2.4)) }));
        return;
    }
    R.actions.setObserver({ latDeg: ll.latDeg, lonDeg: ll.lonDeg, source: 'click' }, { fly: false, undoable: true });
}

/**
 * A tap while the ruler is on (sky view): the body under it (18 px, at its drawn place), else a
 * bright named star, else that point of the sky (unprojected, then refraction taken off, so the
 * ruler draws it back where it was tapped).
 */
function rulerTap({ rc, camera, snap, pick, ndc }) {
    const ruler = R.mods.ruler;
    const up = snap.observer.upS;
    let end = null;
    try {
        const cands = R.mods.bodies?.pickCandidates?.() ?? snap.bodies.map((b) => ({ id: b.id, dirS: b.dirS }));
        const id = pick?.pickDir?.(ndc, camera, cands, rc.size, 18) ?? null;
        if (id && isBodyId(id)) {
            const b = snap.bodies.find((x) => x.id === id);
            if (b) end = { kind: 'body', id, name: id === 'moon' || id === 'sun' ? `the ${bodyById(id).name}` : bodyById(id).name, dir: b.dirS };
        }
        if (!end && R.catalog?.starNames?.length && store0().layers.stars !== false) {
            const stars = R.catalog.starNames.filter((s) => s.mag <= RULER_STAR_MAG);
            const sc = stars.map((s, i) => ({ id: String(i), dirS: liftByRefraction(s.dirS, up, 1, new Float64Array(3)) }));
            const k = pick?.pickDir?.(ndc, camera, sc, rc.size, 14) ?? null;
            if (k !== null) {
                const s = stars[Number(k)];
                end = { kind: 'star', id: `star:${s.hip}`, name: s.name, dir: s.dirS };
            }
        }
        if (!end) {
            const v = new rc.THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
            const app = [v.x, v.y, v.z];
            // Undo the drawn lift: the true direction whose lifted place is the tapped one.
            const t = Float64Array.from(app), l = new Float64Array(3);
            for (let k = 0; k < 4; k++) {
                liftByRefraction(t, up, 1, l);
                for (let c = 0; c < 3; c++) t[c] += app[c] - l[c];
                const n = Math.hypot(t[0], t[1], t[2]) || 1;
                t[0] /= n; t[1] /= n; t[2] /= n;
            }
            end = { kind: 'point', id: null, name: null, dir: t };
        }
    } catch (err) {
        console.error('[main] ruler tap failed', err);
        return;
    }
    R.loop.callModule(ruler, 'tap', end);
    const r = ruler.reading?.();
    if (r && r.ends === 2 && r.text) R.bus?.emit('announce', `${r.from} to ${r.to}: ${r.text.replace(' · ', ', ')}`);
    else if (r && r.ends === 1) R.bus?.emit('announce', `From ${r.from}: now tap a second point`);
}
const RULER_STAR_MAG = 3.5;
const store0 = () => R.store.get();

/** The ruler's reading changed: into ui.ruler (the UI's pill) and a label rebuild. */
function onRulerChange(r) {
    const st = R.store?.get();
    if (!st?.ui.ruler || !r) return;
    R.store.set({ ui: { ...st.ui, ruler: { ends: r.ends, from: r.from, to: r.to, deg: r.deg, text: r.text, fists: r.fists } } }, 'ruler');
    R.labelsFeed?.markDirty();
}

/**
 * A click on the flat map (once it has fully unrolled): a sub-point dot selects its body, anywhere
 * else moves the observer there (Undo, like the globe); a double click zooms in about the point.
 */
function handleMapClick({ store, rc, rig, snap, pick, ndc, dbl, camera }) {
    if ((rig.mapK ?? 0) < 0.999 || rig.tweening || !rig.mapFrame) return;
    let id = null;
    try {
        const f = rig.mapFrame;
        const cands = snap.bodies.map((b) => ({ id: b.id, posS: mapPointOfDir(f, snap.earthMatrix, b.geoDirS, new Float64Array(3)) }));
        id = pick?.pickPoint?.(ndc, camera, cands, rc.size, 14) ?? null;
    } catch (err) {
        console.error('[main] map picking failed', err);
    }
    if (id && isBodyId(id) && !dbl) {
        R.actions.select(id);
        store.set({ ui: { ...store.get().ui, panel: 'details' } }, 'click');
        return;
    }
    if (dbl) {
        rig.zoomAt?.(0.5, ndc.x, ndc.y);
        return;
    }
    const ll = pick?.pickMap?.(ndc, camera, rig.mapFrame) ?? null;
    if (!ll || !Number.isFinite(ll.latDeg) || !Number.isFinite(ll.lonDeg)) return;
    R.actions.setObserver({ latDeg: ll.latDeg, lonDeg: ll.lonDeg, source: 'click' }, { fly: false, undoable: true });
}

/** Shows the selected body's apparent path (±6 months; the Moon: ±2 weeks) when the layer is on. */
function updateTrails({ store, clock, astro, loop, labelsFeed, force = false }) {
    const trails = R.mods.trails;
    if (!trails) return;
    const st = store.get();
    const id = st.selection;
    const wanted = st.layers.trails && id && id !== 'sun' && astro;
    if (!wanted) {
        trailsState.ac?.abort();
        if (trailsState.id) {
            loop.callModule(trails, 'clear');
            labelsFeed?.markDirty();
        }
        trailsState = { id: '', centerMs: NaN, ac: null };
        return;
    }
    if (!force && trailsState.id === id && Number.isFinite(trailsState.centerMs)) return;
    trailsState.ac?.abort();
    const ac = new AbortController();
    const centerMs = clock.tMs;
    const span = id === 'moon' ? TRAIL_SPAN.moon : TRAIL_SPAN.default;
    trailsState = { id, centerMs, ac };
    astro.call('path', { bodyId: id, centerMs, halfSpanDays: span.halfSpanDays, stepHours: span.stepHours }, { signal: ac.signal })
        .then((path) => {
            if (ac.signal.aborted || !path) return;
            const stations = Array.isArray(path.stations) ? path.stations : [];
            loop.callModule(trails, 'show', path, stations, bodyById(id)?.color ?? '#ffffff');
            labelsFeed?.markDirty();
            loop.invalidate();
        })
        .catch((err) => {
            if (err?.name !== 'AbortError') console.error('[main] path computation failed', err);
        });
}

// ---------------------------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------------------------

/** Applies a resolved TierCfg everywhere: renderer, modules, textures, label cap. Idempotent. */
function applyTierCfg(cfg) {
    if (!cfg || cfg === currentCfg) return;
    currentCfg = cfg;
    const rc = R.rc;
    if (!rc) return;
    try {
        rc.setTier(cfg);
    } catch (err) {
        console.error('[main] tier switch failed', err);
    }
    R.loop.broadcast('setQuality', cfg);
    syncDeepStars(cfg);
    const t = R.textures;
    if (t && R.texMod?.keysForTier) {
        try {
            t.setAnisotropy?.(cfg.anisotropy);
            const keys = R.texMod.keysForTier(cfg);
            settle(t.load(readyFlag ? [...keys.critical, ...keys.deferred] : keys.critical));
        } catch (err) {
            console.error('[main] texture set for the new tier failed', err);
        }
    }
    R.loop.invalidate();
}

/** The governor stepped down (DPR or tier): mirror it in the store and apply its config. */
function applyGovernorStep() {
    const gov = R.governor;
    const store = R.store;
    if (!gov || !store) return;
    const q = store.get().quality;
    if (q.active !== gov.tier) {
        store.set({ quality: { ...q, active: gov.tier } }, 'governor');
        // A tier drop is remembered for this GPU; the next visit starts there (autoStartTier).
        prefs.save('qualityLearned', learnedTierRecord(gov.tier, R.rendererString, Date.now()));
    }
    applyTierCfg(gov.config());
}

// ---------------------------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------------------------

/**
 * Plays the first-visit cinematic (or a replay). Any pointer, wheel or key input skips to the end.
 * `preRoll` (the first visit, started as the loader fades) holds the opening pose until it is gone.
 * @param {{force?:boolean, preRoll?:boolean}} [opts]
 */
async function runIntro({ force = false, preRoll = false } = {}) {
    const store = R.store;
    const rig = R.rig;
    if (!store || !rig || introAbort) return 'busy';
    if (store.get().status.reducedMotion && !force) return 'unavailable';
    if (store.get().view.vantage !== 'none') {
        // The intro writes the camera itself: leave a vantage point at once (a cut home).
        try { settle(rig.setVantage?.('none', { animate: false })); } catch { /* the intro takes over anyway */ }
        store.set({ view: { ...store.get().view, vantage: 'none' } }, 'intro');
    }
    if (store.get().view.mode !== 'orbit') {
        store.set({ view: { ...store.get().view, mode: 'orbit' } }, 'intro');
    }
    // Likewise out of the solar-system zoom, at once.
    if (rig.system) {
        try { settle(rig.setSystem?.(false, { animate: false })); } catch { /* the intro takes over anyway */ }
    }
    const ac = new AbortController();
    introAbort = ac;
    const skip = () => ac.abort();
    const opts = { capture: true, passive: true };
    window.addEventListener('pointerdown', skip, opts);
    window.addEventListener('wheel', skip, opts);
    window.addEventListener('keydown', skip, { capture: true });
    const offInteract = rig.onInteract?.(skip) ?? noop;
    store.set({ status: { ...store.get().status, introPlaying: true } }, 'intro');
    const bus = R.bus;
    bus?.emit('intro', 'start');
    let result = 'unavailable';
    const preRollMs = preRoll ? INTRO_TIMING.preRollMs : 0;
    try {
        result = await Promise.race([
            playIntro({
                rig, beams: R.mods.beams, pin: R.mods.pin, snap: R.loop.snap,
                reducedMotion: false, signal: ac.signal, labelsFeed: R.labelsFeed, preRollMs,
            }),
            delay(9000 + preRollMs).then(() => 'timeout'),
        ]);
    } catch (err) {
        console.error('[main] intro failed', err);
    } finally {
        window.removeEventListener('pointerdown', skip, opts);
        window.removeEventListener('wheel', skip, opts);
        window.removeEventListener('keydown', skip, { capture: true });
        try { offInteract(); } catch { /* ignore */ }
        if (!ac.signal.aborted && result === 'timeout') ac.abort();
        introAbort = null;
        R.labelsFeed?.endIntro?.();
        store.set({ status: { ...store.get().status, introPlaying: false } }, 'intro');
        bus?.emit('intro', 'done');
        prefs.save('introSeen', true);
        R.loop?.invalidate();
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Debug overlay (?debug=1 or the Backquote shortcut via actions.toggleDebug)
// ---------------------------------------------------------------------------------------------

async function setDebug(on) {
    if (on && !debugOverlay && !debugLoading && R.rc) {
        debugLoading = true;
        try {
            const mod = await import('./render/debug.js');
            debugOverlay = mod.createDebugOverlay(R.rc, document.body);
            R.loop.setDebug(debugOverlay);
        } catch (err) {
            console.error('[main] debug overlay unavailable', err);
        } finally {
            debugLoading = false;
        }
    } else if (!on && debugOverlay) {
        try { debugOverlay.dispose?.(); } catch { /* ignore */ }
        debugOverlay = null;
        R.loop.setDebug(null);
    }
    return !!debugOverlay;
}

function toggleDebug() {
    settle(setDebug(!debugOverlay));
    return !debugOverlay;
}

// ---------------------------------------------------------------------------------------------
// Hash changes after boot (user edits the address bar or follows an in-page link)
// ---------------------------------------------------------------------------------------------

function applyHash(p) {
    const { store, clock, actions } = R;
    if (!p || !store) return;
    // A link opened during a tour ends it first (restoring the state it found), then applies.
    R.tours?.stop('link');
    const rm = store.get().status.reducedMotion;
    if (p.observer) actions.setObserver({ ...p.observer, source: 'url' }, { fly: true });
    if (p.observer2) actions.setObserver2?.({ ...p.observer2, source: 'url' });
    if (Number.isFinite(p.rate)) clock.setRate(p.rate);
    if (Number.isFinite(p.tMs)) {
        clock.setTime(p.tMs, { animateMs: rm ? 0 : 1200 });
        if (p.playing === true && !timeClamped(p)) clock.play();
        else clock.pause();
    } else if (p.live === true) {
        clock.goLive({ animateMs: rm ? 0 : 900 });
    } else if (p.playing === false) {
        clock.pause();
    } else if (p.playing === true) {
        clock.play();
    }
    if (p.view) actions.setViewMode(p.view);
    if (typeof p.earthLock === 'boolean') actions.setEarthLock(p.earthLock);
    if (p.selection !== undefined) actions.select(p.selection);
    actions.setTracking?.(p.track ?? 'none');
    if (p.layers) store.set({ layers: { ...store.get().layers, ...p.layers } }, 'url');
    if (p.quality) actions.setQuality(p.quality);
    if (p.skyDark) actions.setSkyDark(p.skyDark);
    if (p.aurora) actions.setAuroraActivity(p.aurora);
    if (p.cam && R.rig) {
        try { R.rig.setView?.(p.cam); } catch (err) { console.error('[main] camera from link failed', err); }
    }
    // After the view and camera: a vantage keeps `cam` as its way back (absent: back to the globe).
    actions.setVantage?.(p.view === 'sky' || p.view === 'map' ? 'none' : p.vantage ?? 'none');
    if (typeof p.debug === 'boolean') settle(setDebug(p.debug));
    if (R.bus) reportHashProblems(p, R.bus);
    if (p.tour) settle(startTour(p.tour));
}

// ---------------------------------------------------------------------------------------------
// Guided tours (js/app/tours.js, loaded on the first tour)
// ---------------------------------------------------------------------------------------------

let toursModP = null;

/**
 * Starts guided tour `id` (core/tour-catalog.js); a running intro yields to it.
 * @param {string} id
 * @returns {Promise<boolean>} true once it plays
 */
async function startTour(id) {
    if (!R.store || !isTourId(id)) return false;
    introAbort?.abort();
    toursModP ??= import('./app/tours.js');
    let mod;
    try {
        mod = await toursModP;
    } catch (err) {
        toursModP = null;
        console.error('[main] guided tours unavailable', err);
        R.bus?.emit('toast', { message: 'The tour could not be loaded.', kind: 'warn' });
        return false;
    }
    R.tours ??= mod.createTourRunner({
        store: R.store, bus: R.bus, clock: R.clock, actions: R.actions, astro: R.astro, win: window,
        getRig: () => (textMode ? null : R.rig), getSnap: () => R.loop?.snap ?? null,
    });
    return R.tours.start(id);
}

// ---------------------------------------------------------------------------------------------
// 'Point at the sky' (js/camera/aim.js, loaded on first use; actions.pointAtSky asked iOS first)
// ---------------------------------------------------------------------------------------------

let aimModP = null;
/** Align picks the body or star nearest the centre within this angle (the compass may be 15° out). */
const ALIGN_MAX_DEG = 35;
const AIM_STOP_TOASTS = Object.freeze({
    idle: 'Stopped following the phone after 2 minutes without movement.',
    track: 'Stopped following the phone: tracking holds the view now.',
    nodata: "This device doesn't report which way it is pointing.",
    unsupported: "This browser can't read the phone's orientation.",
});

/**
 * Starts following the phone in sky view: tracking and a long exposure end, ui.aim is set, and the
 * rig's look then comes from the sensors. Resolves true on the first reading.
 * @returns {Promise<boolean>}
 */
async function startAim() {
    const store = R.store, rig = R.rig;
    if (!store || !rig || textMode) return false;
    aimModP ??= import('./camera/aim.js');
    let mod;
    try {
        mod = await aimModP;
    } catch (err) {
        aimModP = null;
        console.error('[main] pointing unavailable', err);
        R.bus?.emit('toast', { message: "Pointing at the sky couldn't load.", kind: 'warn' });
        return false;
    }
    R.aim ??= mod.createAim({ rig, offsetDeg: Number(prefs.load('aimOffset', 0)) || 0, onStop: (reason) => onAimStop(reason) });
    if (R.aim.active) return true;
    const st = store.get();
    if (st.view.mode !== 'sky') return false;
    if ((st.view.track ?? 'none') !== 'none') store.set({ view: { ...st.view, track: 'none' } }, 'aim');
    if (st.ui.expose) R.actions?.expose?.(null);
    store.set({ ui: { ...store.get().ui, aim: { source: 'starting', offsetDeg: R.aim.offsetDeg, aligned: null } } }, 'aim');
    const res = await R.aim.start();
    if (res !== 'ok') {
        if (res === 'unsupported') onAimStop('unsupported');
        return false;
    }
    store.set({ ui: { ...store.get().ui, aim: { source: R.aim.source, offsetDeg: R.aim.offsetDeg, aligned: null } } }, 'aim');
    R.bus?.emit('announce', 'Pointing at the sky: move the phone to look around. Directions are approximate.');
    return true;
}

/** The aim stopped (by the user, idle, a hidden page, leaving sky view, no sensor). */
function onAimStop(reason) {
    const st = R.store?.get();
    if (st?.ui.aim) R.store.set({ ui: { ...st.ui, aim: null } }, 'aim');
    const msg = AIM_STOP_TOASTS[reason];
    if (msg) R.bus?.emit('toast', { message: msg, kind: 'info' });
    else if (reason === 'user') R.bus?.emit('announce', 'Stopped following the phone');
}

/**
 * 'Align': the selected body, or the brightest-looking thing nearest the centre (the Moon, a bright
 * planet, a bright star by night; never the Sun), is taken to be where the phone points. The
 * azimuth offset is saved for next time.
 * @returns {string|null} the name aligned on
 */
function alignAim() {
    const aim = R.aim, snap = R.loop?.snap, store = R.store;
    if (!aim?.active || !snap || !store) return null;
    const look = aim.look;
    const sel = store.get().selection;
    const refs = guideRefs(snap, null);
    const sb = sel && sel !== 'sun' ? snap.bodies.find((b) => b.id === sel) : null;
    if (sb && sb.above && !refs.some((r) => r.id === sel)) refs.push({ id: sel, name: bodyById(sel).name, azDeg: sb.azDeg, altDeg: sb.altDeg, mag: sb.mag });
    let best = null, bestSep = ALIGN_MAX_DEG;
    for (const r of refs) {
        // The selection wins ties: it is what the user is looking for.
        const sep = separationDeg(look.azDeg, look.altDeg, r.azDeg, r.altDeg) * (r.id === sel ? 0.6 : 1);
        if (sep < bestSep) { bestSep = sep; best = r; }
    }
    if (!best) {
        R.bus?.emit('toast', { message: 'Point the phone at the Moon, a bright planet or a bright star, centre it, then tap Align.', kind: 'info' });
        return null;
    }
    const off = aim.align(best.azDeg);
    try { prefs.save('aimOffset', Math.round(off * 10) / 10); } catch { /* storage is optional */ }
    const ui = store.get().ui;
    if (ui.aim) store.set({ ui: { ...ui, aim: { ...ui.aim, offsetDeg: off, aligned: best.name } } }, 'aim');
    const name = best.name.charAt(0).toUpperCase() + best.name.slice(1);
    const offTxt = `${off < 0 ? '−' : '+'}${Math.abs(Math.round(off))}°`;
    R.bus?.emit('toast', { message: `Aligned on ${best.name}: the compass is corrected by ${offTxt}.`, kind: 'info', timeoutMs: 3500 });
    R.bus?.emit('announce', `${name} centred: directions aligned`);
    return best.name;
}

// ---------------------------------------------------------------------------------------------
// Idle extras
// ---------------------------------------------------------------------------------------------

/**
 * One almanac push at boot (SPEC §E.8 step 10): rise/set for the next day, twilight, tonight's
 * verdicts, the scrubber's sun-altitude series and the next year of events, all from the worker.
 * The UI keeps these fresh for the simulated time itself and treats this as a head start.
 */
async function pushAlmanac({ store, bus, clock, astro }) {
    if (!astro?.call) return;
    const o = store.get().observer;
    const observer = { latDeg: o.latDeg, lonDeg: o.lonDeg, elevM: o.elevM || 0 };
    const t = clock.tMs;
    const half = scrubSpanMs(clock.rate);
    const ids = BODIES.map((b) => b.id);
    const [riseSet, twilight, tonight, sun] = await Promise.allSettled([
        astro.call('riseSet', { bodyIds: ids, observer, fromMs: t, toMs: t + 26 * 3600e3 }),
        astro.call('twilight', { observer, nearMs: t }),
        astro.call('tonight', { observer, nearMs: t }),
        astro.call('sunSeries', { observer, fromMs: t - half, toMs: t + half, n: 96 }),
    ]);
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    bus.emit('almanac', {
        riseSet: val(riseSet), twilight: val(twilight), tonight: val(tonight),
        sunSeries: val(sun) ? { fromMs: t - half, toMs: t + half, values: val(sun) } : null,
    });
    try {
        const list = await astro.call('events', {
            observer, fromMs: t - 2 * 864e5, days: 367, tz: o.tz || undefined, hour12: !!store.get().display?.hour12,
        });
        if (Array.isArray(list)) bus.emit('events', list);
    } catch (err) {
        if (err?.name !== 'AbortError') console.error('[main] event search failed', err);
    }
}

function registerServiceWorker() {
    if (location.protocol !== 'https:' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js')
        .then(() => navigator.serviceWorker.ready)
        .then((reg) => {
            // The first visit loaded everything before the worker existed: hand it those URLs so
            // the next visit already works offline (sw.js keeps only same-scope site files).
            const urls = performance.getEntriesByType('resource').map((e) => e.name);
            reg.active?.postMessage({ type: 'precache', urls });
        })
        .catch(() => { /* offline support is a bonus */ });
}

// ---------------------------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------------------------

boot().catch((err) => {
    console.error('[main] boot failed', err);
    if (R.uiMounted && R.store) {
        // The panels work: keep them, explain the missing globe. Never a blank screen.
        try {
            enterTextMode('context-failed');
            return;
        } catch { /* fall through to the fatal screen */ }
    }
    showFatal(err);
});
