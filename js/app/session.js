// sessionStorage for this tab's session, guarded (the context-loss record, core/context-loss.js).
//
// It survives a reload but not the tab, which is what a "for this session" step needs: iOS often
// reloads a page whose GPU context it took instead of restoring it. Storage can be missing or throw
// (blocked site data, sandboxed frames, Node): then nothing outlives the page, and every call
// still returns normally. Saved preferences live in core/prefs.js (localStorage) instead.

const PREFIX = 'pc2.';

function storage() {
    try {
        const s = globalThis.sessionStorage;
        return s && typeof s.getItem === 'function' ? s : null;
    } catch {
        return null;
    }
}

/**
 * Reads a JSON value saved this session, or null.
 * @param {string} key
 * @returns {any}
 */
export function sessionLoad(key) {
    try {
        const text = storage()?.getItem(PREFIX + key);
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

/**
 * Saves a JSON value for this session. Returns false when it could not be stored.
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function sessionSave(key, value) {
    try {
        const s = storage();
        if (!s) return false;
        s.setItem(PREFIX + key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}
