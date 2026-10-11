// App-wide event bus (SPEC §C.3).
//
// Event types are fixed by the spec:
//   'readout'  Snapshot (full detail, 4 Hz)
//   'toast'    {message, kind:'info'|'warn'|'error', actionLabel?, onAction?, timeoutMs?}
//   'announce' string (screen-reader announcement)
//   'almanac'  {riseSet, twilight, tonight, sunSeries:{fromMs, toMs, values}}
//   'events'   AstroEvent[]
//   'intro'    'start'|'done'
// Other type strings are accepted (so a typo never crashes the app) but are not part of the contract.
//
// Handler lists are copy-on-write, so `emit` allocates nothing: the 4 Hz 'readout' stays free.

/** The event types defined by the spec. */
export const BUS_EVENTS = Object.freeze(['readout', 'toast', 'announce', 'almanac', 'events', 'intro']);

/**
 * Creates an event bus.
 *
 * - `on(type, fn)` → `off()`.
 * - `once(type, fn)` → `off()`; `once(type)` without a handler → Promise of the next payload.
 * - `off(type, fn)` removes a handler.
 * - `emit(type, payload)` calls handlers in registration order. A throwing handler is reported
 *   through `onError` and never stops the others. Handlers added during an emit run from the next
 *   emit; handlers removed during an emit are skipped if they have not run yet.
 * - `clear()` drops every handler.
 *
 * @param {{onError?:(err:unknown, type:string)=>void}} [opts]
 * @returns {import('./types.js').Bus}
 */
export function createBus({ onError } = {}) {
    const report = typeof onError === 'function' ? onError : (err, type) => console.error(`[bus] '${type}' handler failed:`, err);
    /** @type {Map<string, {fn:Function, live:boolean}[]>} */
    const handlers = new Map();

    function add(type, fn) {
        const entry = { fn, live: true };
        handlers.set(type, (handlers.get(type) ?? []).concat(entry));
        return entry;
    }

    function remove(type, entry) {
        if (!entry.live) return;
        entry.live = false;
        const list = handlers.get(type);
        if (!list) return;
        const next = list.filter((e) => e !== entry);
        if (next.length) handlers.set(type, next);
        else handlers.delete(type);
    }

    function on(type, fn) {
        if (typeof fn !== 'function') return () => {};
        const entry = add(String(type), fn);
        return () => remove(String(type), entry);
    }

    function once(type, fn) {
        const t = String(type);
        if (typeof fn !== 'function') {
            return new Promise((resolve) => {
                const entry = add(t, (payload) => {
                    remove(t, entry);
                    resolve(payload);
                });
            });
        }
        const entry = add(t, (payload) => {
            remove(t, entry);
            fn(payload);
        });
        return () => remove(t, entry);
    }

    function off(type, fn) {
        const t = String(type);
        const list = handlers.get(t);
        if (!list) return;
        for (const e of list) {
            if (e.fn === fn) remove(t, e);
        }
    }

    function emit(type, payload) {
        const t = String(type);
        const list = handlers.get(t);
        if (!list) return;
        // Indexed loop: no iterator object on the 4 Hz path.
        for (let i = 0; i < list.length; i++) { // NOSONAR
            const e = list[i];
            if (!e.live) continue;
            try {
                e.fn(payload);
            } catch (err) {
                report(err, t);
            }
        }
    }

    function clear() {
        for (const list of handlers.values()) for (const e of list) e.live = false;
        handlers.clear();
    }

    return { on, once, off, emit, clear };
}
