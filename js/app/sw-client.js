// The service worker from the page's side (sw-atomic-updates-offline-ci): registration, the
// "A new version is ready" toast and window.__app.sw. The worker's side is sw.js.
//
// - It registers when the origin is secure and the site comes over https from a real host (the
//   deploy), or the hash says `sw=1` (localhost: the smoke test). `sw=0` unregisters it and drops
//   its caches; otherwise a worker registered earlier keeps serving and is only listened to.
// - A new version installs in the background and waits. The worker posts {type:'update-ready'}
//   (or the page finds one waiting at start), and the sticky toast offers Reload: it posts
//   {type:'skip-waiting'} and reloads once the new version controls the page (at most 4 s later).
// - A version activated from another tab: a hidden tab reloads at once, a visible one gets the toast
//   (its state is in the URL hash, so a reload keeps the view).
// - Once a worker is active it gets the URLs this visit loaded ({type:'precache'}: the first visit
//   ran before the worker controlled it), and `precached` turns true on its reply.
//
// Loaded with import() at idle time (main.js), so it is not on the boot path.

const CACHE_PREFIX = 'pc2-';
const RELOAD_FALLBACK_MS = 4000;
const VERSION_TIMEOUT_MS = 3000;

/**
 * Whether this page registers the worker: 'on', 'off' (`sw=0`: unregister) or null (leave it).
 * @param {{protocol?:string, hostname?:string, hash?:string}} loc
 * @returns {'on'|'off'|null}
 */
export function swMode(loc) {
    const flag = /(?:^#?|&)sw=([01])(?:&|$)/.exec(String(loc?.hash ?? ''));
    if (flag) return flag[1] === '1' ? 'on' : 'off';
    const host = String(loc?.hostname ?? '').toLowerCase();
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    return loc?.protocol === 'https:' && !local ? 'on' : null;
}

/**
 * @typedef {object} SwState
 * @property {'on'|'off'|null} mode
 * @property {boolean} registered
 * @property {boolean} controlled  a worker serves this page
 * @property {string|null} version  the version serving the page (or installed for it)
 * @property {boolean} staged  that version has a deploy manifest (false: the dev worker)
 * @property {boolean} precached  the worker replied to this visit's warm-up: an offline reload works
 * @property {string|null} waiting  a newer version, installed and waiting
 */

/**
 * @param {{nav?:any, win?:any, bus?:{emit:(t:string, p:any)=>void}, urls?:()=>string[], reload?:()=>void,
 *          secure?:boolean, loc?:{protocol?:string, hostname?:string, hash?:string}}} deps
 *   `nav` is navigator, `win` window (location, document, caches, MessageChannel, setTimeout);
 *   `loc` the location to judge (default win.location; main.js passes the hash the page opened with).
 * @returns {{state:SwState, start:()=>Promise<SwState>}}
 */
export function createSwClient({ nav, win, bus, urls, reload, secure, loc } = {}) {
    const sw = nav?.serviceWorker ?? null;
    /** @type {SwState} */
    const state = {
        mode: swMode(loc ?? win?.location), registered: false, controlled: !!sw?.controller, version: null, staged: false,
        precached: false, waiting: null,
    };
    let reg = null;
    let reloading = false, reloaded = false, offered = false;
    const later = (fn, ms) => (win?.setTimeout ?? setTimeout)(fn, ms);
    const doReload = () => {
        if (reloaded) return;
        reloaded = true;
        (reload ?? (() => win?.location?.reload()))();
    };

    /** {version, staged} from a worker, or null (no reply within 3 s). */
    function askVersion(worker) {
        if (!worker || typeof win?.MessageChannel !== 'function') return Promise.resolve(null);
        return new Promise((resolve) => {
            const ch = new win.MessageChannel();
            const t = later(() => resolve(null), VERSION_TIMEOUT_MS);
            ch.port1.onmessage = (e) => {
                clearTimeout(t);
                resolve(e.data?.version ? { version: String(e.data.version), staged: !!e.data.staged } : null);
            };
            try {
                worker.postMessage({ type: 'version' }, [ch.port2]);
            } catch {
                resolve(null);
            }
        });
    }

    async function readVersion(worker) {
        const v = await askVersion(worker);
        if (v) Object.assign(state, v);
    }

    function activate() {
        const next = reg?.waiting ?? reg?.installing ?? null;
        if (!next) {
            doReload();
            return;
        }
        reloading = true;
        try {
            next.postMessage({ type: 'skip-waiting' });
        } catch { /* fall back to the timer */ }
        later(doReload, RELOAD_FALLBACK_MS);
    }

    function offer(version) {
        if (version) state.waiting = String(version);
        else if (reg?.waiting && !state.waiting) askVersion(reg.waiting).then((v) => { state.waiting ??= v?.version ?? null; });
        if (offered || reloaded) return;
        offered = true;
        bus?.emit('toast', { message: 'A new version is ready', kind: 'info', actionLabel: 'Reload', timeoutMs: 0, onAction: activate });
    }

    function onMessage(e) {
        const d = e?.data;
        if (d?.type === 'update-ready') {
            offer(d.version);
        } else if (d?.type === 'precached') {
            state.precached = true;
            state.version ??= d.version ? String(d.version) : null;
        }
    }

    function onControllerChange() {
        const had = state.controlled;
        state.controlled = !!sw.controller;
        if (reloading) {
            doReload();
            return;
        }
        // The first install claimed this page (start() warms that worker up): nothing to do.
        if (!had) return;
        // Another tab activated a new version: this page's lazy modules would now mix versions.
        state.precached = false;
        if (win?.document?.hidden) doReload();
        else offer(null);
    }

    function warm(worker) {
        try {
            worker?.postMessage({ type: 'precache', urls: urls?.() ?? [] });
        } catch { /* offline support is a bonus */ }
    }

    async function unregister() {
        const r = await sw.getRegistration?.().catch(() => null);
        await r?.unregister?.().catch(() => false);
        const keys = (await win?.caches?.keys?.().catch(() => [])) ?? [];
        await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => win.caches.delete(k).catch(() => false)));
        state.registered = false;
    }

    async function start() {
        if (!sw || secure === false) return state;
        if (state.mode === 'off') {
            await unregister();
            return state;
        }
        sw.addEventListener?.('message', onMessage);
        sw.addEventListener?.('controllerchange', onControllerChange);
        try {
            reg = state.mode === 'on' ? await sw.register('sw.js') : sw.controller ? await sw.getRegistration?.() : null;
        } catch {
            return state;   // offline support is a bonus
        }
        if (!reg) return state;
        state.registered = true;
        // A version installed on an earlier visit and still waiting for this tab.
        if (reg.waiting && sw.controller) offer(null);
        const ready = await sw.ready;
        reg = ready ?? reg;
        const active = sw.controller ?? reg.active;
        await readVersion(active);
        warm(active);
        return state;
    }

    return { state, start };
}
