// Planet Location Marker service worker (classic script; registered by js/main.js over https only).
//
// Strategies (SPEC §C.4):
//   vendor/ assets/ data/  cache-first          immutable within a VERSION
//   js/ css/               stale-while-revalidate
//   index.html / navigations to the app  network-first (4 s), falling back to the cached shell
// Everything else (other origins such as the optional geocoders, the manifest, sw.js itself)
// is left to the browser. Caches are named per VERSION; activating a new VERSION deletes the
// old ones. VERSION must equal js/version.js (checked by test/repo.assets.test.mjs). Bump both on
// every deploy that changes a shipped file: js/ and css/ are served stale-while-revalidate, so
// without a new VERSION a returning visitor keeps running the previous modules for one more visit.
//
// Optional warm-up: the page may post {type:'precache', urls:[…]} (e.g. the resource URLs it
// already loaded) so the very next visit works offline; {type:'version'} replies with VERSION
// on the supplied MessagePort.

const VERSION = '2.0.0';
const PREFIX = 'pc2-';
const CACHE = `${PREFIX}${VERSION}`;
const SCOPE = new URL('./', self.location).href;   // works under a GitHub Pages sub-path
const SHELL_KEY = new URL('index.html', SCOPE).href;
const NAV_TIMEOUT_MS = 4000;
const PRECACHE = ['index.html', 'manifest.webmanifest', 'assets/icons/favicon.svg', 'assets/icons/icon-192.png'];

/** Path of a same-scope URL relative to the scope, without query or hash ('' = the root). */
function scopedPath(url) {
    const href = url.origin + url.pathname;
    return href.startsWith(SCOPE) ? href.slice(SCOPE.length) : null;
}

function cacheable(res) {
    return res && res.ok && res.status === 200 && (res.type === 'basic' || res.type === 'default');
}

async function put(req, res) {
    try {
        const cache = await caches.open(CACHE);
        await cache.put(req, res);
    } catch {
        // Quota or storage errors must never break the page.
    }
}

async function cacheFirst(event) {
    const req = event.request;
    const hit = await caches.match(req, { cacheName: CACHE });
    if (hit) return hit;
    const res = await fetch(req);
    if (cacheable(res)) event.waitUntil(put(req, res.clone()));
    return res;
}

async function staleWhileRevalidate(event) {
    const req = event.request;
    const hit = await caches.match(req, { cacheName: CACHE });
    const update = fetch(req).then((res) => {
        if (cacheable(res)) return put(req, res.clone()).then(() => res);
        return res;
    });
    if (hit) {
        event.waitUntil(update.catch(() => {}));   // refresh in the background
        return hit;
    }
    return update;
}

async function networkFirstShell(event) {
    const req = event.request;
    try {
        const preload = await Promise.resolve(event.preloadResponse).catch(() => undefined);
        const res = preload ?? await Promise.race([
            fetch(req),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)),
        ]);
        const type = res.headers.get('content-type') ?? '';
        if (cacheable(res) && type.includes('text/html')) event.waitUntil(put(SHELL_KEY, res.clone()));
        return res;
    } catch {
        const cached = await caches.match(SHELL_KEY, { cacheName: CACHE });
        if (cached) return cached;
        return new Response('<!doctype html><meta charset="utf-8"><title>Planet Location Marker</title>'
            + '<body style="background:#03060d;color:#e8edf6;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">'
            + '<p>You are offline and Planet Location Marker has not been cached yet. Reconnect and reload.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        // One missing file must not fail the whole install.
        await Promise.allSettled(PRECACHE.map((p) => cache.add(new Request(new URL(p, SCOPE), { cache: 'reload' }))));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
        if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || req.headers.has('range')) return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // geocoders etc.: untouched
    const rel = scopedPath(url);
    if (rel === null || rel === 'sw.js') return;

    let handler = null;
    if (rel === '' || rel === 'index.html') handler = networkFirstShell;
    else if (/^(vendor|assets|data)\//.test(rel)) handler = cacheFirst;
    else if (/^(js|css)\//.test(rel)) handler = staleWhileRevalidate;
    if (!handler) return;

    event.respondWith(handler(event).catch(() => fetch(req)));
});

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg?.type === 'version') {
        event.ports?.[0]?.postMessage({ version: VERSION, cache: CACHE });
    } else if (msg?.type === 'precache' && Array.isArray(msg.urls)) {
        event.waitUntil((async () => {
            const cache = await caches.open(CACHE);
            const wanted = msg.urls
                .map((u) => {
                    try {
                        return new URL(u, SCOPE);
                    } catch {
                        return null;
                    }
                })
                .filter((u) => u && u.origin === self.location.origin && /^(vendor|assets|data|js|css)\//.test(scopedPath(u) ?? ''));
            await Promise.allSettled(wanted.slice(0, 300).map(async (u) => {
                if (!(await cache.match(u.href))) await cache.add(u.href);
            }));
        })());
    }
});
