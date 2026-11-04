/**
 * The screen wake lock, shared by everything that wants the screen to stay on while someone stands
 * under the sky (ROADMAP night-vision-mode, ar-sky-pointing): night vision, the sky view on a
 * touch-first device and 'Point at the sky' (camera/aim.js) each hold a named reason, and the one
 * lock is held while any reason is and the page is visible.
 *
 * The browser drops a screen lock whenever the page is hidden, so it is asked for again when the
 * page shows. A refused request (no API, a permissions policy, battery saver) stays quiet and is not
 * retried until a reason is added or the page shows again. Twenty minutes without a tap or a key
 * let the lock go (a phone forgotten in a pocket), until the next one. No three.js, no allocation
 * after setup.
 *
 *   createWakeLock({nav, doc, win, idleMs, now}) → { hold(reason, on), locked, reasons, dispose() }
 *
 * @module app/wake-lock
 */

/** Without a tap or a key for this long, the lock is let go until the next one. */
export const WAKE_IDLE_MS = 20 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;
const noop = () => {};
const INPUT = /** @type {const} */ (['pointerdown', 'keydown']);
const LISTEN = { capture: true, passive: true };

/**
 * @param {{nav?: any, doc?: any, win?: any, idleMs?: number, now?: () => number}} [deps]
 *   nav: has `wakeLock.request('screen')` (default globalThis.navigator); doc: `visibilityState` and
 *   'visibilitychange' (default globalThis.document); win: the input events (default globalThis).
 */
export function createWakeLock(deps = {}) {
    const nav = deps.nav === undefined ? globalThis.navigator : deps.nav;
    const doc = deps.doc === undefined ? globalThis.document : deps.doc;
    const win = deps.win === undefined ? globalThis : deps.win;
    const idleMs = deps.idleMs ?? WAKE_IDLE_MS;
    const now = deps.now ?? (() => Date.now());
    /** @type {Set<string>} */
    const reasons = new Set();
    let sentinel = null;
    let pending = false;
    let refused = false;
    let bound = false;
    let lastInput = now();
    let timer = null;

    const visible = () => !doc || doc.visibilityState !== 'hidden';
    const idle = () => now() - lastInput > idleMs;
    const wanted = () => reasons.size > 0 && visible() && !idle();

    function drop(s) {
        try { s?.release?.()?.catch?.(noop); } catch { /* already released */ }
    }

    function sync() {
        if (!wanted()) {
            const s = sentinel;
            sentinel = null;
            drop(s);
            return;
        }
        if (sentinel || pending || refused || typeof nav?.wakeLock?.request !== 'function') return;
        pending = true;
        let p;
        try { p = nav.wakeLock.request('screen'); } catch (err) { p = Promise.reject(err); }
        Promise.resolve(p).then((s) => {
            pending = false;
            if (!s) return;
            if (!wanted()) { drop(s); return; }
            sentinel = s;
            // The browser's own release (the page hid): forget it, the next show asks again.
            s.addEventListener?.('release', () => { if (sentinel === s) sentinel = null; });
        }, () => { pending = false; refused = true; });
    }

    const onVisibility = () => {
        if (visible()) refused = false;
        sync();
    };
    const onInput = () => {
        const wasIdle = idle();
        lastInput = now();
        if (wasIdle) sync();
    };

    function bind(on) {
        if (on === bound) return;
        bound = on;
        const m = on ? 'addEventListener' : 'removeEventListener';
        doc?.[m]?.('visibilitychange', onVisibility);
        for (const name of INPUT) win?.[m]?.(name, onInput, LISTEN);
        if (on) {
            timer = setInterval(() => { if (sentinel && idle()) sync(); }, IDLE_CHECK_MS);
            timer?.unref?.();   // Node (tests): never keeps the process alive
        } else {
            clearInterval(timer);
            timer = null;
        }
    }

    return {
        /**
         * Holds (or lets go of) the lock for one reason ('red', 'sky', 'aim', …). Idempotent.
         * @param {string} reason
         * @param {boolean} [on]
         */
        hold(reason, on = true) {
            const k = String(reason);
            if (!!on === reasons.has(k)) return;
            if (on) {
                reasons.add(k);
                refused = false;
                lastInput = now();   // turning something on is activity
            } else {
                reasons.delete(k);
            }
            bind(reasons.size > 0);
            sync();
        },
        /** True while the browser holds the lock for us. */
        get locked() { return !!sentinel; },
        /** The reasons held, in the order they came. */
        get reasons() { return [...reasons]; },
        /** Lets everything go (tests). */
        dispose() {
            reasons.clear();
            bind(false);
            sync();
        },
    };
}
