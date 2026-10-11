/**
 * Promise client for the astro worker, with a transparent main-thread
 * fallback: if `Worker` is missing, its constructor throws, or the worker
 * fires an error (e.g. no module-worker support), every pending and future
 * call runs `runOp` from a dynamically imported worker.js on the main thread,
 * one call per setTimeout(0) tick so the page stays responsive.
 *
 * The worker is created lazily on the first call, so it never competes with
 * the critical boot path.
 *
 * @module astro/client
 */

/**
 * @typedef {{
 *   call: (op:string, args?:object, opts?:{signal?:AbortSignal}) => Promise<any>,
 *   dispose: () => void,
 *   readonly mode: 'idle'|'worker'|'fallback'|'disposed'
 * }} AstroClient
 */

function abortError() {
    try {
        return new DOMException('The operation was aborted.', 'AbortError');
    } catch {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        return e;
    }
}

function toError(e) {
    if (e instanceof Error) return e;
    const err = new Error(e && typeof e === 'object' && e.message ? e.message : String(e));
    if (e && typeof e === 'object' && e.name) err.name = e.name;
    return err;
}

/**
 * Creates an astro client.
 * @param {{forceFallback?:boolean, workerUrl?:URL|string}} [options]
 *   `forceFallback` skips the worker entirely (tests, debugging);
 *   `workerUrl` overrides the worker script location.
 * @returns {AstroClient}
 */
export function createAstroClient(options = {}) {
    const workerUrl = options.workerUrl ?? new URL('./worker.js', import.meta.url);
    /** @type {'idle'|'worker'|'fallback'|'disposed'} */
    let mode = options.forceFallback ? 'fallback' : 'idle';
    let worker = null;
    let seq = 0;
    let pumping = false;
    let fallbackModule = null;
    const pending = new Map(); // id → {op, args, resolve, reject, signal, onAbort}
    const queue = [];          // ids waiting for the main-thread fallback

    function settle(id, ok, value) {
        const p = pending.get(id);
        if (!p) return; // aborted or disposed meanwhile: drop the late reply
        pending.delete(id);
        if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
        if (ok) p.resolve(value);
        else p.reject(toError(value));
    }

    function onMessage(ev) {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // 'ready' handshake
        settle(msg.id, msg.ok === true, msg.ok === true ? msg.result : msg.error);
    }

    function switchToFallback(ev) {
        // Keep the console clean: the fallback takes over silently.
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (mode !== 'worker') return;
        mode = 'fallback';
        try {
            worker.terminate();
        } catch {
            // already gone
        }
        worker = null;
        for (const id of pending.keys()) queue.push(id);
        pump();
    }

    function ensureWorker() {
        if (mode !== 'idle') return;
        if (typeof Worker !== 'function') {
            mode = 'fallback';
            return;
        }
        try {
            worker = new Worker(workerUrl, { type: 'module', name: 'astro' });
        } catch {
            worker = null;
            mode = 'fallback';
            return;
        }
        mode = 'worker';
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', switchToFallback);
        worker.addEventListener('messageerror', switchToFallback);
    }

    async function runNext() {
        const id = queue.shift();
        if (id === undefined) {
            pumping = false;
            return;
        }
        const p = pending.get(id);
        if (p) {
            try {
                fallbackModule ??= await import('./worker.js');
                if (pending.has(id)) settle(id, true, fallbackModule.runOp(p.op, p.args));
            } catch (e) {
                settle(id, false, e);
            }
        }
        setTimeout(runNext, 0);
    }

    function pump() {
        if (pumping || mode === 'disposed') return;
        pumping = true;
        setTimeout(runNext, 0);
    }

    /**
     * Runs an op (see worker.js OPS). Rejects with an AbortError when `signal`
     * aborts first; a late worker reply is then ignored.
     * @param {string} op
     * @param {object} [args]
     * @param {{signal?:AbortSignal}} [opts]
     * @returns {Promise<any>}
     */
    function call(op, args = {}, { signal } = {}) {
        if (mode === 'disposed') return Promise.reject(new Error('Astro client has been disposed'));
        if (signal?.aborted) return Promise.reject(abortError());
        ensureWorker();
        return new Promise((resolve, reject) => {
            const id = ++seq;
            const entry = { op, args, resolve, reject, signal, onAbort: null };
            if (signal) {
                entry.onAbort = () => {
                    if (pending.delete(id)) reject(abortError());
                };
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            pending.set(id, entry);
            if (mode === 'worker') {
                try {
                    worker.postMessage({ id, op, args });
                    return;
                } catch {
                    // Arguments that cannot be cloned still work on the main thread.
                }
            }
            queue.push(id);
            pump();
        });
    }

    /** Terminates the worker and rejects every pending call with an AbortError. */
    function dispose() {
        if (mode === 'disposed') return;
        mode = 'disposed';
        if (worker) {
            try {
                worker.terminate();
            } catch {
                // already gone
            }
            worker = null;
        }
        queue.length = 0;
        const entries = [...pending.values()];
        pending.clear();
        for (const p of entries) {
            if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
            p.reject(abortError());
        }
    }

    return {
        call,
        dispose,
        get mode() {
            return mode;
        },
    };
}
