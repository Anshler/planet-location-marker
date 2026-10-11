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
import { DEFAULT_STATE, createStore } from './core/store.js';
import { createBus } from './core/bus.js';
import { createClock, scrubSpanMs } from './core/clock.js';
import { parseHash, bindUrl } from './core/url-state.js';
import { detectTier, createGovernor, isTier } from './core/quality.js';
import * as prefs from './core/prefs.js';
import * as tz from './core/tz.js';
import * as format from './core/format.js';
import { loadCities, placeToObserver } from './geo/cities.js';
import { createGeocoder, createLruCache } from './geo/geocode.js';
import { BODIES, BODY_INDEX, isBodyId, bodyById } from './astro/bodies.js';
import { createSnapshot, computeSnapshot } from './astro/snapshot.js';
import { createAstroClient } from './astro/client.js';
import { decodeSky, emptyCatalog } from './data/catalog.js';
import { createActions, normalizeObserver } from './app/actions.js';
import { createLoop } from './app/loop.js';
import { createLabelsFeed } from './app/labels-feed.js';
import { playIntro } from './app/intro.js';
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
const QUALITY_SETTINGS = ['auto', 'low', 'medium', 'high'];
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
    /** @type {any} */ catalog: null,
    /** @type {any} */ snapFull: null,
    /** @type {any} */ bus: null,
    /** @type {any} */ texMod: null,
    uiMounted: false,
};

const app = {
    ready: false,
    version: VERSION,
    get tier() { return R.store?.get().quality.active ?? null; },
    get store() { return R.store; },
    get clock() { return R.clock; },
    get actions() { return R.actions; },
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
    if (!st.layers.beams || (R.rig?.skyBlend ?? 0) > 0.5) return 0;
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
    }
    return out;
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
        earth: import('./render/earth.js'),
        atmosphere: import('./render/atmosphere.js'),
        sky: import('./render/sky.js'),
        bodies: import('./render/bodies.js'),
        ground: import('./render/ground.js'),
        trails: import('./render/trails.js'),
        beams: import('./render/beams.js'),
        pin: import('./render/pin.js'),
        flare: import('./render/flare.js'),
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
    const governor = createGovernor({
        tier: decision.tier, ceiling: decision.ceiling, coarse: env.coarse, dpr: env.dpr,
        maxTextureSize: env.maxTextureSize || undefined,
    });
    const savedQuality = prefs.load('quality', null);
    const qualitySetting = [hash.quality, savedQuality].find((q) => QUALITY_SETTINGS.includes(q)) ?? 'auto';
    let active = governor.pin(qualitySetting === 'auto' ? null : qualitySetting);
    if (window.__pcSlow && qualitySetting === 'auto') active = governor.pin('low');

    const layers = { ...DEFAULT_STATE.layers, ...(loadSavedLayers() ?? {}), ...(hash.layers ?? {}) };
    const view = { mode: env.can3d && hash.view === 'sky' ? 'sky' : 'orbit', earthLock: hash.earthLock ?? true };
    const store = createStore({
        observer,
        selection: isBodyId(hash.selection) ? hash.selection : null,
        view,
        layers,
        display: loadSavedDisplay(),
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
    const services = { cities, geocoder, astro, tz, format };

    // ---- Actions (render objects are filled in later) ---------------------------------------
    const render = { rig: null, beams: null, pin: null, earth: null, governor };
    const actions = createActions({
        store, bus, clock, prefs, tz, cities, render,
        getSnap: () => snap,
        runIntro: (opts) => runIntro(opts),
        toggleDebug: () => toggleDebug(),
    });
    R.actions = actions;

    // ---- 3. Loop (headless until the renderer exists) and the UI ----------------------------
    const loop = createLoop({
        clock, store, bus, snap, snapFull,
        onGovernor: () => applyGovernorStep(),
        onRenderFailure: (err) => enterTextMode('context-failed', err),
    });
    R.loop = loop;

    try {
        const { mountUI } = await uiModP;
        mountUI(document.getElementById('ui-root'), {
            store, bus, clock, actions, services, env: { coarse: env.coarse, reducedMotion: env.reducedMotion },
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
    bindUrl({ win: window, store, clock, getCam: () => R.rig?.getView?.() ?? null, onExternalChange: (p) => applyHash(p) });
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
            await bootRender({ env, hash, store, bus, clock, actions, render, loop, snap, governor, renderModsP, skyJsonP, astro });
        } catch (err) {
            enterTextMode('context-failed', err);
        }
    }

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
    sub((s) => s.view.mode, (m) => b.classList.toggle('is-sky', m === 'sky'));
    sub((s) => s.status.coarse, (v) => b.classList.toggle('is-coarse', !!v));
    sub((s) => s.status.reducedMotion, (v) => b.classList.toggle('is-reduced-motion', !!v));
    sub((s) => s.status.webgl, (v) => b.classList.toggle('no-webgl', !v));
    sub((s) => s.quality.active, (t) => {
        b.classList.remove('tier-low', 'tier-medium', 'tier-high');
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

/** Layers, display and the quality setting persist across visits (the observer is saved by actions). */
function bindPreferences(store) {
    store.subscribe((s) => s.layers, (l) => prefs.save('layers', l));
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

/** Readout-driven housekeeping that needs the render stack (trails refresh). */
let trailsState = { id: '', centerMs: NaN, ac: null };
let introAbort = null;
let debugOverlay = null;
let debugLoading = false;
let currentCfg = null;
let readyFlag = false;

async function bootRender(ctx) {
    const { env, hash, store, bus, clock, render, loop, snap, governor, renderModsP, skyJsonP, astro } = ctx;
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
    const create = (name, factory) => {
        if (!factory) return null;
        try {
            const mod = factory();
            if (!mod || !mod.object3d) throw new Error(`${name}: factory returned no object3d`);
            rc.scene.add(mod.object3d);
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
    const earth = create('earth', m.earth && (() => m.earth.createEarth(rc, { textures })));
    create('atmosphere', m.atmosphere && (() => m.atmosphere.createAtmosphere(rc)));
    const sky = create('sky', m.sky && (() => m.sky.createSky(rc, { catalog: catalog ?? emptyCatalog(), textures, reducedMotion: rm })));
    create('bodies', m.bodies && (() => m.bodies.createBodies(rc, { textures })));
    create('ground', m.ground && (() => m.ground.createGround(rc)));
    const trails = create('trails', m.trails && (() => m.trails.createTrails(rc)));
    const beams = create('beams', m.beams && (() => m.beams.createBeams(rc, { reducedMotion: rm })));
    const pin = create('pin', m.pin && (() => m.pin.createPin(rc)));
    create('flare', m.flare && (() => m.flare.createFlare(rc, { textures })));

    // Labels and camera rig.
    let labels = null;
    try {
        labels = m.labels?.createLabels(document.getElementById('labels-root'), { cap: currentCfg.labelCap });
    } catch (err) {
        console.error('[main] labels unavailable', err);
        labels = null;
    }
    const rig = m.rig?.createRig ? m.rig.createRig(rc, { dom: canvas, reducedMotion: rm }) : null;
    if (!rig) throw new Error('The camera rig could not be created.');
    R.rig = rig;
    R.labels = labels;
    render.rig = rig;
    render.beams = beams;
    render.pin = pin;
    render.earth = earth;

    const labelsFeed = labels ? createLabelsFeed({
        labels, store, snap,
        getCatalog: () => R.catalog,
        getTrails: () => R.mods.trails ?? null,
        getBeams: () => R.mods.beams ?? null,
        getPin: () => R.mods.pin ?? null,
    }) : null;
    R.labelsFeed = labelsFeed;
    loader.progress(0.45, 'Loading imagery');

    // Initial module state.
    const st0 = store.get();
    for (const mod of modules) {
        loop.callModule(mod, 'setQuality', currentCfg);
        loop.callModule(mod, 'setLayers', st0.layers);
        loop.callModule(mod, 'setSelection', st0.selection);
        loop.callModule(mod, 'apply', snap);
    }
    if (pin) loop.callModule(pin, 'setObserver', st0.observer.latDeg, st0.observer.lonDeg);
    rig.setEarthLock?.(st0.view.earthLock);

    // Catalog: install now or when it arrives.
    const installCatalog = (cat) => {
        if (!cat) {
            bus.emit('toast', { message: "The star catalogue couldn't load — stars and constellations are hidden.", kind: 'warn' });
            return;
        }
        R.catalog = cat;
        if (sky && typeof sky.setCatalog === 'function') loop.callModule(sky, 'setCatalog', cat);
        else if (sky && m.sky) replaceSky(m.sky, rc, cat, textures, rm);
        labelsFeed?.markDirty();
        loop.invalidate();
    };
    if (catalog) R.catalog = catalog;
    else catalogP.then(installCatalog);

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
        if (!hash.cam && st0.view.mode === 'sky') settle(rig.setMode?.('sky', { animate: false, look: lookFor(store, snap) }));
    } catch (err) {
        console.error('[main] initial camera placement failed', err);
    }
    bindViewInsets(rig, store);

    // 7. Render.
    loop.attach({ rc, rig, modules, moduleNames: names, labels, labelsFeed, governor: env.webdriver ? null : governor, getTierCfg: () => currentCfg });
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
        settle(runIntro());
    } else if (st0.view.mode === 'orbit' && !hash.cam) {
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
        R.loop.callModule(next, 'setLayers', st.layers);
        R.loop.callModule(next, 'setSelection', st.selection);
    } catch (err) {
        console.error('[main] sky rebuild failed', err);
    }
}

function wantIntro(env, hash, store) {
    if (env.reducedMotion || hash.intro === false) return false;
    if (hash.intro === true) return true;
    if (hash.cam || store.get().view.mode !== 'orbit') return false;
    return !prefs.load('introSeen', false);
}

/** The selected body if it is above the horizon (sky view looks at it), else the rig's default. */
function lookFor(store, snap) {
    const id = store.get().selection;
    if (!id || !isBodyId(id)) return undefined;
    const b = snap.bodies[BODY_INDEX[id]];
    return b && b.altGeomDeg > 0 ? { azDeg: b.azGeomDeg, altDeg: b.altGeomDeg } : undefined;
}

/** Wires store changes, input and GPU events to the render stack. */
function bindRenderState({ store, bus, clock, rc, rig, loop, snap, astro, m, labels, labelsFeed, textures }) {
    // Layers / selection / observer → modules.
    store.subscribe((s) => s.layers, (l) => {
        loop.broadcast('setLayers', l);
        updateTrails({ store, clock, astro, loop, labelsFeed });
    });
    store.subscribe((s) => s.selection, (id) => {
        loop.broadcast('setSelection', id);
        updateTrails({ store, clock, astro, loop, labelsFeed });
    });
    store.subscribe((s) => s.observer, (o) => {
        const pin = R.mods.pin;
        if (pin) loop.callModule(pin, 'setObserver', o.latDeg, o.lonDeg);
    });
    store.subscribe((s) => s.view.earthLock, (on) => {
        try { rig.setEarthLock?.(on); } catch (err) { console.error('[main] earth-lock failed', err); }
    });
    store.subscribe((s) => s.view.mode, (mode) => {
        try {
            settle(rig.setMode?.(mode, { animate: !store.get().status.reducedMotion, look: mode === 'sky' ? lookFor(store, snap) : undefined }));
        } catch (err) {
            console.error('[main] view change failed', err);
        }
    });
    store.subscribe((s) => s.status.reducedMotion, (v) => {
        for (const mod of [R.mods.sky, R.mods.beams, R.mods.pin]) if (mod) loop.callModule(mod, 'setReducedMotion', v);
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
        if (isBodyId(id)) {
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
    const clampPx = (v, max) => Math.round(Math.min(max, Math.max(0, v)));
    const measure = () => {
        frame = 0;
        const W = window.innerWidth, H = window.innerHeight;
        const ins = { left: 0, right: 0, top: 0, bottom: 0 };
        if (!store.get().ui.cinema) {
            const layout = root.dataset.layout;
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
    try {
        new MutationObserver(schedule).observe(root, { attributes: true, subtree: true, attributeFilter: ['class', 'data-layout', 'style'] });
    } catch { /* very old browser: window resize still works */ }
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(schedule);
        for (const sel of ['.panel', '.timebar', '.sheet']) {
            const el = root.querySelector(sel);
            if (el) ro.observe(el);
        }
    }
    window.addEventListener('resize', schedule);
    store.subscribe((s) => s.ui.cinema, schedule);
    schedule();
}

/**
 * A click (not a drag) on the canvas: a body glyph selects it (double-click flies to it);
 * the globe in orbit view moves the observer (double-click flies closer).
 */
function handleSceneClick({ store, rc, rig, snap, pick, ndc, dbl }) {
    const camera = rig.camera ?? rc.camera;
    let id = null;
    try {
        const cands = R.mods.bodies?.pickCandidates?.() ?? snap.bodies.map((b) => ({ id: b.id, dirS: b.dirS }));
        id = pick?.pickDir?.(ndc, camera, cands, rc.size, 18) ?? null;
    } catch (err) {
        console.error('[main] body picking failed', err);
    }
    if (id && isBodyId(id)) {
        R.actions.select(id, { fly: dbl });
        store.set({ ui: { ...store.get().ui, panel: 'details' } }, 'click');
        return;
    }
    if (store.get().view.mode !== 'orbit' || (rig.skyBlend ?? 0) > 0.5) return;
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
    const t = R.textures;
    if (t && R.texMod?.keysForTier) {
        try {
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
    if (q.active !== gov.tier) store.set({ quality: { ...q, active: gov.tier } }, 'governor');
    applyTierCfg(gov.config());
}

// ---------------------------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------------------------

/**
 * Plays the first-visit cinematic (or a replay). Any pointer, wheel or key input skips to the end.
 * @param {{force?:boolean}} [opts]
 */
async function runIntro({ force = false } = {}) {
    const store = R.store;
    const rig = R.rig;
    if (!store || !rig || introAbort) return 'busy';
    if (store.get().status.reducedMotion && !force) return 'unavailable';
    if (store.get().view.mode !== 'orbit') {
        store.set({ view: { ...store.get().view, mode: 'orbit' } }, 'intro');
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
    try {
        result = await Promise.race([
            playIntro({
                rig, beams: R.mods.beams, pin: R.mods.pin, snap: R.loop.snap,
                reducedMotion: false, signal: ac.signal, labelsFeed: R.labelsFeed,
            }),
            delay(9000).then(() => 'timeout'),
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
    const rm = store.get().status.reducedMotion;
    if (p.observer) actions.setObserver({ ...p.observer, source: 'url' }, { fly: true });
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
    if (p.layers) store.set({ layers: { ...store.get().layers, ...p.layers } }, 'url');
    if (p.quality) actions.setQuality(p.quality);
    if (p.cam && R.rig) {
        try { R.rig.setView?.(p.cam); } catch (err) { console.error('[main] camera from link failed', err); }
    }
    if (typeof p.debug === 'boolean') settle(setDebug(p.debug));
    if (R.bus) reportHashProblems(p, R.bus);
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
        const list = await astro.call('events', { observer, fromMs: t - 2 * 864e5, days: 367 });
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
