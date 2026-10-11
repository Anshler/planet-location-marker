// Persistent user preferences (SPEC §C.3).
//
// localStorage under the 'pc2.' prefix, JSON-encoded. Storage can be missing (Node, some
// embedded browsers), throw on access (sandboxed iframes, blocked site data, Safari private mode)
// or reject writes (quota): every path is guarded and falls back to an in-memory copy, so the
// app behaves identically for the session and simply forgets on reload.
//
// This is the only pure-core module allowed to touch globalThis.localStorage (repo purity test).

/** Key prefix in localStorage. */
export const PREFIX = 'pc2.';
/** The preference keys used by the app. Other keys are accepted for forward compatibility. */
export const PREF_KEYS = Object.freeze(['observer', 'layers', 'quality', 'display', 'introSeen', 'geocache', 'recentPlaces']);

/** @type {Map<string, string>} key → JSON text; mirrors every successful or attempted save. */
const memory = new Map();

/** The storage object when usable, else null. Probed on each call (cheap; storage can vanish). */
function storage() {
    try {
        const ls = globalThis.localStorage;
        if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
    } catch {
        // Accessing localStorage itself throws when site data is blocked.
    }
    return null;
}

/** @param {unknown} v */
function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** @param {unknown} v */
function kindOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/**
 * Reconciles a loaded value with the fallback's shape so stale or corrupted data cannot crash
 * callers: a fallback of a given kind (boolean, number, string, array, object) rejects loaded
 * values of another kind; a plain-object fallback is used as defaults, loaded keys win when their
 * kind matches the default's. A null/undefined fallback accepts anything.
 */
function reconcile(loaded, fallback) {
    if (fallback === null || fallback === undefined) return loaded;
    if (kindOf(loaded) !== kindOf(fallback)) return fallback;
    if (typeof loaded === 'number' && !Number.isFinite(loaded)) return fallback;
    if (!isPlainObject(fallback) || !isPlainObject(loaded)) return loaded;
    const out = { ...fallback };
    for (const k of Object.keys(loaded)) {
        const dv = fallback[k];
        if (dv === undefined || dv === null || kindOf(loaded[k]) === kindOf(dv)) out[k] = loaded[k];
    }
    return out;
}

/**
 * Reads a preference. Returns `fallback` when absent, unreadable or of the wrong shape (see
 * above); objects come back as fresh copies, never shared with other callers.
 * @template T
 * @param {string} key
 * @param {T} [fallback]
 * @returns {T|any}
 */
export function load(key, fallback) {
    const k = String(key);
    // This session's saves win: a write that hit the quota lives only in memory.
    let text = memory.get(k) ?? null;
    const ls = text === null ? storage() : null;
    if (ls) {
        try {
            text = ls.getItem(PREFIX + k);
        } catch {
            text = null;
        }
    }
    if (text === null || text === undefined) return fallback;
    try {
        return reconcile(JSON.parse(text), fallback);
    } catch {
        return fallback;
    }
}

/**
 * Stores a preference (JSON). `undefined` removes it. Returns true when it reached localStorage,
 * false when it is only kept in memory for this session — or was not stored at all because JSON
 * cannot encode it (functions, cycles), in which case the previous value is left untouched.
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function save(key, value) {
    const k = String(key);
    if (value === undefined) return remove(k);
    let text;
    try {
        text = JSON.stringify(value);
    } catch {
        return false;
    }
    if (typeof text !== 'string') return false;
    memory.set(k, text);
    const ls = storage();
    if (!ls) return false;
    try {
        ls.setItem(PREFIX + k, text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Removes a preference. Returns true when localStorage was updated.
 * @param {string} key
 * @returns {boolean}
 */
export function remove(key) {
    const k = String(key);
    memory.delete(k);
    const ls = storage();
    if (!ls) return false;
    try {
        ls.removeItem(PREFIX + k);
        return true;
    } catch {
        return false;
    }
}

/**
 * Removes every 'pc2.' preference ("Reset all settings"). Keys of other apps are untouched.
 */
export function clearAll() {
    memory.clear();
    const ls = storage();
    if (!ls) return;
    try {
        const doomed = [];
        for (let i = 0; i < ls.length; i++) {
            const name = ls.key(i);
            if (name?.startsWith(PREFIX)) doomed.push(name);
        }
        for (const name of doomed) ls.removeItem(name);
    } catch {
        // Nothing more we can do; memory is already cleared.
    }
}

/**
 * True when preferences persist across reloads (localStorage is usable).
 * @returns {boolean}
 */
export function persistent() {
    const ls = storage();
    if (!ls) return false;
    try {
        const probe = `${PREFIX}__probe__`;
        ls.setItem(probe, '1');
        ls.removeItem(probe);
        return true;
    } catch {
        return false;
    }
}
