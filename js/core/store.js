// Application state store (SPEC §C.3).
//
// A tiny observable store. State is a plain object of top-level slices; `set` merges each slice of
// the patch into a NEW slice object (slices are never mutated), so subscribers can detect change
// with `Object.is`. Unchanged slices keep their identity, which keeps selector-based subscriptions
// quiet when nothing they care about moved.

/** @typedef {import('./types.js').AppState} AppState */

/**
 * Deep-freezes plain objects and arrays (not typed arrays or class instances).
 * @template T
 * @param {T} o
 * @returns {T}
 */
function deepFreeze(o) {
    if (o && typeof o === 'object' && (Array.isArray(o) || isPlainObject(o)) && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

/** @param {unknown} v */
function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/**
 * The initial application state (SPEC §C.3). Frozen: copy before modifying.
 * @type {Readonly<AppState>}
 */
export const DEFAULT_STATE = deepFreeze({
    observer: { latDeg: 51.4769, lonDeg: -0.0005, elevM: 0, name: 'Royal Observatory Greenwich', country: 'United Kingdom', tz: 'Europe/London', tzApprox: false, source: 'default' },
    selection: null, view: { mode: 'orbit', earthLock: true },
    layers: {
        beams: true, ghostBeams: true, sunMoonBeams: true, stars: true, constellations: true, constellationNames: true, starNames: true,
        milkyWay: true, clouds: true, atmosphere: true, ecliptic: false, eqGrid: false, altAzGrid: true, horizon: true, footprint: false,
        subpoints: false, trails: false, labels: true,
    },
    display: { tzMode: 'observer', hour12: false }, quality: { setting: 'auto', active: 'medium', ceiling: 'medium' },
    ui: { panel: 'sky', sheet: 'peek', cinema: false, help: false, palette: false },
    status: { phase: 'boot', progress: 0, webgl: true, onlineSearch: 'unknown', reducedMotion: false, coarse: false, introPlaying: false },
});

/**
 * Merges one slice of a patch into the previous slice value.
 * Plain objects merge shallowly into a fresh frozen object; anything else replaces the value.
 * `undefined` means "not provided" (at slice and key level) so optional fields never wipe state;
 * use `null` to clear a value. Returns `prev` itself when the patch changes nothing, so identity
 * is preserved.
 * @param {unknown} prev
 * @param {unknown} patch
 * @returns {unknown}
 */
function mergeSlice(prev, patch) {
    if (patch === undefined) return prev;
    if (!isPlainObject(patch) || !isPlainObject(prev)) return Object.is(prev, patch) ? prev : freezeShallow(patch);
    let next = null;
    for (const k of Object.keys(patch)) {
        const v = patch[k];
        if (v === undefined || Object.is(prev[k], v)) continue;
        if (!next) next = { ...prev };
        next[k] = v;
    }
    return next ? Object.freeze(next) : prev;
}

/** @param {unknown} v */
function freezeShallow(v) {
    if (!isPlainObject(v)) return v;
    const out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = v[k];
    return Object.freeze(out);
}

/**
 * Builds a selector function from a function, a dotted path string ('view.mode') or nothing.
 * @param {Function|string|null|undefined} selector
 * @returns {(s:AppState)=>unknown}
 */
function toSelector(selector) {
    if (typeof selector === 'function') return selector;
    if (typeof selector === 'string' && selector) {
        const path = selector.split('.');
        return (s) => {
            let v = s;
            for (const k of path) {
                if (v == null) return undefined;
                v = v[k];
            }
            return v;
        };
    }
    return (s) => s;
}

/**
 * Top-level slices a selector reads: the first segment of a path, nothing (= the whole state) for
 * null, and for functions the keys touched during one probe run through a Proxy.
 * @param {Function|string|null|undefined} selector
 * @param {(s:AppState)=>unknown} sel
 * @param {AppState} state
 * @returns {Set<string>}
 */
function dependencies(selector, sel, state) {
    if (typeof selector === 'string' && selector) return new Set([selector.split('.')[0]]);
    const deps = new Set();
    if (typeof selector !== 'function') return deps;
    const probe = new Proxy(state, {
        get(target, key, receiver) {
            if (typeof key === 'string') deps.add(key);
            return Reflect.get(target, key, receiver);
        },
    });
    try {
        sel(probe);
    } catch {
        // A selector that throws on the probe still has the keys it read so far.
    }
    return deps;
}

/**
 * Creates the application store.
 *
 * `initial` may be partial: every slice is merged over `DEFAULT_STATE`, so
 * `createStore({observer:{...}, layers:{beams:false}})` is fine.
 *
 * - `get()` returns the current (frozen) state object.
 * - `set(patch, source?)` merges per top-level slice: `set({layers:{beams:false}})` replaces
 *   `layers` with a new object that differs only in `beams`. `patch` may also be a function
 *   `(state) => patch`. Returns true when anything changed.
 * - `subscribe(selector, cb, {immediate=false})` calls `cb(value, prev, state, source)` whenever
 *   `selector(state)` changes by `Object.is`. `selector` may be a function, a dotted path such as
 *   `'view.mode'`, or null for the whole state. Returns an unsubscribe function.
 *   `source` is the `source` of the most recent `set` that changed a slice the selector reads
 *   (so a change made by a nested `set(…, 'auto')` is reported as 'auto', not as the outer call).
 *
 * Re-entrant `set` calls made from inside a subscriber are applied immediately and notified in a
 * follow-up pass, so every subscriber always ends up seeing the latest state. A throwing selector
 * or subscriber is reported through `onError` and never breaks the others.
 *
 * @param {Partial<AppState>|null} [initial]
 * @param {{onError?:(err:unknown)=>void}} [opts]
 * @returns {import('./types.js').Store}
 */
export function createStore(initial, { onError } = {}) {
    const report = typeof onError === 'function' ? onError : (err) => console.error('[store] subscriber failed:', err);

    /** @type {any} */
    let state = {};
    for (const key of Object.keys(DEFAULT_STATE)) state[key] = DEFAULT_STATE[key];
    if (isPlainObject(initial)) {
        for (const key of Object.keys(initial)) state[key] = mergeSlice(state[key], initial[key]);
    }
    state = Object.freeze(state);

    /** @type {{sel:(s:AppState)=>unknown, deps:Set<string>, cb:Function, last:unknown, active:boolean}[]} */
    let subs = [];
    let notifying = false;
    let pending = false;
    // Source attribution: which set() last changed each top-level slice.
    let version = 0;
    /** @type {Map<string, number>} */
    const keyVersion = new Map();
    /** @type {Map<string, string|undefined>} */
    const keySource = new Map();
    /** @type {string|undefined} */
    let lastSource;

    /** Source of the most recent change among the slices in `deps` (all slices when empty). */
    function sourceFor(deps) {
        if (!deps.size) return lastSource;
        let best = 0;
        let src = lastSource;
        for (const k of deps) {
            const v = keyVersion.get(k) ?? 0;
            if (v > best) {
                best = v;
                src = keySource.get(k);
            }
        }
        return src;
    }

    /** Delivers the current state to one subscriber if its selected value changed. */
    function deliver(sub) {
        if (!sub.active) return;
        let v;
        try {
            v = sub.sel(state);
        } catch (err) {
            report(err);
            return;
        }
        if (Object.is(v, sub.last)) return;
        const prev = sub.last;
        sub.last = v;
        try {
            sub.cb(v, prev, state, sourceFor(sub.deps));
        } catch (err) {
            report(err);
        }
    }

    function notify() {
        if (notifying) {
            pending = true;
            return;
        }
        notifying = true;
        try {
            // Bounded so a pair of subscribers that keep setting each other cannot hang the app.
            for (let pass = 0; pass < 64; pass++) {
                pending = false;
                for (const sub of subs) deliver(sub);
                if (!pending) return;
            }
            report(new Error('[store] subscriptions kept changing state; gave up after 64 passes'));
        } finally {
            notifying = false;
            pending = false;
        }
    }

    return {
        get() {
            return state;
        },

        set(patch, source) {
            let p = patch;
            if (typeof p === 'function') {
                try {
                    p = p(state);
                } catch (err) {
                    report(err);
                    return false;
                }
            }
            if (!isPlainObject(p)) return false;
            let next = null;
            const changed = [];
            for (const key of Object.keys(p)) {
                if (p[key] === undefined) continue;
                const merged = mergeSlice(state[key], p[key]);
                if (merged !== state[key]) {
                    if (!next) next = { ...state };
                    next[key] = merged;
                    changed.push(key);
                }
            }
            if (!next) return false;
            state = Object.freeze(next);
            version++;
            for (const key of changed) {
                keyVersion.set(key, version);
                keySource.set(key, source);
            }
            lastSource = source;
            notify();
            return true;
        },

        subscribe(selector, cb, { immediate = false } = {}) {
            if (typeof cb !== 'function') return () => {};
            const sel = toSelector(selector);
            const sub = { sel, deps: dependencies(selector, sel, state), cb, last: undefined, active: true };
            try {
                sub.last = sub.sel(state);
            } catch (err) {
                report(err);
            }
            // Copy-on-write so an in-progress notification pass is never disturbed.
            subs = subs.concat(sub);
            if (immediate) {
                try {
                    cb(sub.last, undefined, state, undefined);
                } catch (err) {
                    report(err);
                }
            }
            return () => {
                if (!sub.active) return;
                sub.active = false;
                subs = subs.filter((s) => s !== sub);
            };
        },
    };
}
