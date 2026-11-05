// Planet Location Marker service worker (classic script). js/main.js registers it on https hosts,
// or with #sw=1 on any secure origin (localhost included, which is how the smoke test runs it);
// #sw=0 unregisters it. SPEC §C.4; docs/ARCHITECTURE.md §9 'The service worker'.
//
// Staged (the deployed site): scripts/stage-site.mjs stamps VERSION (js/version.js's VERSION, '+',
// 16 hex digits of a sha256 over every shipped file) and STAGED = true into this file, and writes
// sw-manifest.json {version, sha256, precache:[path], fresh:[path], files:[[path, sha256]]}. Each
// version is atomic:
//   install   reads the manifest (its version must be VERSION), copies the files an older
//             version's cache holds with the same hash, then fetches the rest of `precache` (the
//             shell, the whole module graph with the astro worker's, sky.json, cities.json and the
//             other boot data, the Earth previews) and every other file an older version's cache
//             holds whose hash changed (data/i18n/vi.json, a texture: what worked offline still
//             does), each checked against its hash. Anything missing or from another deploy fails
//             the install; the browser tries again on a later visit, and a retry keeps what
//             already arrived. There is no skipWaiting: an update waits, and open pages get
//             {type:'update-ready'}; the page's toast posts {type:'skip-waiting'} and reloads
//             once the new version controls it.
//   activate  deletes every other version's cache (only now: until then the old version serves
//             its pages) and claims open pages.
//   fetch     every file in the manifest is cache-first within the version, the shell and js/ and
//             css/ included. A miss (the textures, which stay lazy) is fetched and kept only when
//             its bytes match the manifest, so a file of a newer deploy never enters this
//             version's cache. `fresh` files are network-first (3 s), then the cache: data/tle.json
//             is rewritten by every daily deploy (pages.yml) without a new version.
// Dev (the repo as served by npm start, or a branch deploy without staging): VERSION is
// js/version.js's (test/repo.assets.test.mjs) and there is no manifest. Everything in scope is
// network-first and cached as it arrives, so an edit shows on reload and the last copy works
// offline.
//
// Messages: {type:'version'} replies {type:'version', version, staged} on the given port;
// {type:'precache', urls} caches what the page loaded before this worker controlled it (the first
// visit's textures; staged, only this version's bytes), then replies {type:'precached', version};
// {type:'skip-waiting'} activates a waiting version.
// Other origins (the optional geocoders), sw.js and sw-manifest.json are left to the browser.

const VERSION = '2.0.0';
const STAGED = false;
const PREFIX = 'pc2-';
const CACHE = `${PREFIX}${VERSION}`;
const SCOPE = new URL('./', self.location).href;   // works under a GitHub Pages sub-path
const MANIFEST_URL = new URL('sw-manifest.json', SCOPE).href;
const NAV_TIMEOUT_MS = 4000;
const DATA_TIMEOUT_MS = 3000;
/** Network-first without a manifest (staged: the manifest's `fresh`, the same list). */
const FRESH_DEFAULT = ['data/tle.json'];
/** Dev install: the shell and the data fetched soon after boot (staged: the manifest's `precache`). */
const DEV_PRECACHE = ['index.html', 'manifest.webmanifest', 'assets/icons/favicon.svg', 'assets/icons/icon-192.png',
    'data/sky.json', 'data/cities.json', 'data/craft.json', 'data/dso.json', 'data/starinfo.json', 'data/tle.json'];
const SITE_PATH = /^(?:(?:js|css|vendor|assets|data)\/|manifest\.webmanifest$)/;
const PARALLEL = 6;

/** Path of a same-scope URL relative to the scope, without query or hash ('' = the root). */
function scopedPath(url) {
    const href = url.origin + url.pathname;
    return href.startsWith(SCOPE) ? href.slice(SCOPE.length) : null;
}

/** The cache key of a site path (no query: these are static files). */
const keyOf = (rel) => new URL(rel, SCOPE).href;
const lookup = (rel) => caches.match(keyOf(rel), { cacheName: CACHE, ignoreVary: true });

function cacheable(res) {
    return res && res.ok && res.status === 200 && !res.redirected && (res.type === 'basic' || res.type === 'default');
}

function withTimeout(p, ms) {
    if (!ms) return p;
    return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function sha256Hex(res) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
}

async function put(rel, res) {
    try {
        const cache = await caches.open(CACHE);
        await cache.put(keyOf(rel), res);
    } catch {
        // Quota or storage errors must never break the page.
    }
}

/** Runs `fn` over `items`, PARALLEL at a time; rejects with the first failure. */
async function pool(items, fn) {
    let i = 0;
    const next = async () => {
        while (i < items.length) await fn(items[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, next));
}

// ------------------------------------------------------------------ the manifest ------------

/** {version, precache, fresh:Set, files:Map} when `json` is this version's manifest, else null. */
function parseManifest(json) {
    if (!json || json.version !== VERSION || !Array.isArray(json.files)) return null;
    return {
        version: json.version,
        precache: Array.isArray(json.precache) ? json.precache : [],
        fresh: new Set(Array.isArray(json.fresh) ? json.fresh : FRESH_DEFAULT),
        files: new Map(json.files),
    };
}

async function fetchManifest() {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`sw-manifest.json: HTTP ${res.status}`);
    const json = await res.json();
    const m = parseManifest(json);
    if (!m) throw new Error(`sw-manifest.json is version ${json?.version}, this worker ${VERSION}`);
    return { m, json };
}

let manifestP = null;
/** This version's manifest (its cache's copy, else the network's), or null: dev, or unreadable. */
function manifest() {
    if (!STAGED) return Promise.resolve(null);
    manifestP ??= (async () => {
        const hit = await caches.match(MANIFEST_URL, { cacheName: CACHE });
        const m = hit ? parseManifest(await hit.json().catch(() => null)) : null;
        return m ?? (await fetchManifest()).m;
    })().catch(() => {
        manifestP = null;   // try again on the next request
        return null;
    });
    return manifestP;
}

/** Fetches one file into this version's cache; with a hash, only bytes that match it. */
async function fetchInto(cache, rel, sha) {
    for (const mode of ['no-cache', 'reload']) {
        const res = await fetch(keyOf(rel), { cache: mode });
        if (!cacheable(res)) throw new Error(`${rel}: HTTP ${res.status}`);
        if (!sha || await sha256Hex(res.clone()) === sha) {
            await cache.put(keyOf(rel), res);
            return;
        }
        // Not this version's bytes: a stale HTTP cache (try once without it) or a newer deploy.
    }
    throw new Error(`${rel} does not match version ${VERSION}`);
}

/**
 * Copies what older versions cached with an unchanged hash: an update downloads only what changed.
 * Returns the files an older version held whose hash changed (a lazily cached data/i18n/vi.json or
 * texture): the install fetches them too, so what worked offline before the update still does.
 */
async function carryOver(cache, m) {
    const changed = new Set();
    for (const name of await caches.keys()) {
        if (!name.startsWith(PREFIX) || name === CACHE) continue;
        const old = await caches.open(name);
        let files;
        try {
            files = new Map((await (await old.match(MANIFEST_URL))?.json())?.files ?? []);
        } catch {
            continue;   // a dev cache, or no manifest: nothing is known about its bytes
        }
        for (const [rel, sha] of m.files) {
            if (await cache.match(keyOf(rel), { ignoreVary: true })) continue;
            const hit = await old.match(keyOf(rel), { ignoreVary: true });
            if (!hit) continue;
            if (files.get(rel) === sha) await cache.put(keyOf(rel), hit);
            else changed.add(rel);
        }
    }
    return changed;
}

// ------------------------------------------------------------------ lifecycle ---------------

async function installVersion() {
    const { m, json } = await fetchManifest();
    const cache = await caches.open(CACHE);
    const changed = await carryOver(cache, m);
    const todo = [];
    for (const rel of new Set([...m.precache, ...changed])) if (!(await cache.match(keyOf(rel), { ignoreVary: true }))) todo.push(rel);
    await pool(todo, async (rel) => {
        if (!m.fresh.has(rel)) return fetchInto(cache, rel, m.files.get(rel) ?? null);
        // A fresh file is not part of the version: a failure leaves it to the first request.
        return fetchInto(cache, rel, null).catch(() => {});
    });
    // Stored last: a cache with its manifest is complete (carryOver trusts it).
    await cache.put(MANIFEST_URL, new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } }));
    manifestP = Promise.resolve(m);
}

async function installDev() {
    const cache = await caches.open(CACHE);
    // One missing file must not fail a dev install.
    await Promise.allSettled(DEV_PRECACHE.map((p) => cache.add(new Request(keyOf(p), { cache: 'reload' }))));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        await (STAGED ? installVersion() : installDev());
        // An older version still serves the open pages: tell them this one is ready.
        if (!self.registration.active) return;
        for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
            c.postMessage({ type: 'update-ready', version: VERSION });
        }
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
        // Staged, the shell comes from the cache: a navigation preload would be fetched for nothing.
        const np = self.registration.navigationPreload;
        if (np) await (STAGED ? np.disable() : np.enable()).catch(() => {});
        await self.clients.claim();
    })());
});

// ------------------------------------------------------------------ fetch -------------------

function offlinePage() {
    return new Response('<!doctype html><meta charset="utf-8"><title>Planet Location Marker</title>'
        + '<body style="background:#03060d;color:#e8edf6;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">'
        + '<p>You are offline and Planet Location Marker has not been cached yet. Reconnect and reload.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Network first (a navigation takes its preload), cached as it arrives; the cache when offline. */
async function networkFirst(event, rel, timeoutMs) {
    const req = event.request;
    const nav = req.mode === 'navigate';
    try {
        const preload = nav ? await Promise.resolve(event.preloadResponse).catch(() => undefined) : undefined;
        const res = preload ?? await withTimeout(nav ? fetch(req) : fetch(req, { cache: 'no-cache' }), timeoutMs);
        const html = (res.headers.get('content-type') ?? '').includes('text/html');
        if (cacheable(res) && (rel !== 'index.html' || html)) event.waitUntil(put(rel, res.clone()));
        if (res.ok) return res;
        return (await lookup(rel)) ?? res;   // a server error: the last good copy, if any
    } catch (err) {
        const hit = await lookup(rel);
        if (hit) return hit;
        if (nav) return offlinePage();
        throw err;
    }
}

async function route(event, rel) {
    const m = await manifest();
    if (!m) return networkFirst(event, rel, event.request.mode === 'navigate' ? NAV_TIMEOUT_MS : FRESH_DEFAULT.includes(rel) ? DATA_TIMEOUT_MS : 0);
    if (m.fresh.has(rel)) return networkFirst(event, rel, DATA_TIMEOUT_MS);
    const sha = m.files.get(rel);
    if (sha === undefined) return fetch(event.request);   // not part of this version
    const hit = await lookup(rel);
    if (hit) return hit;
    let res;
    try {
        res = await fetch(event.request);
    } catch (err) {
        if (event.request.mode === 'navigate') return offlinePage();
        throw err;
    }
    if (cacheable(res)) {
        const copy = res.clone();
        event.waitUntil((async () => {
            if (await sha256Hex(copy.clone()) === sha) await put(rel, copy);
        })().catch(() => {}));
    }
    return res;
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || req.headers.has('range')) return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // geocoders etc.: untouched
    const path = scopedPath(url);
    if (path === null) return;
    const rel = path === '' ? 'index.html' : path;
    if (rel !== 'index.html' && !SITE_PATH.test(rel)) return;
    event.respondWith(route(event, rel).catch(() => fetch(req)));
});

// ------------------------------------------------------------------ messages ----------------

/** Caches the site files the page loaded before this worker controlled it. */
async function warm(urls) {
    const m = await manifest();
    const cache = await caches.open(CACHE);
    const rels = new Set();
    for (const u of urls.slice(0, 400)) {
        let rel = null;
        try {
            const url = new URL(u, SCOPE);
            if (url.origin === self.location.origin) rel = scopedPath(url);
        } catch { /* not a URL */ }
        if (rel && SITE_PATH.test(rel) && (!m || m.files.has(rel) || m.fresh.has(rel))) rels.add(rel);
    }
    await pool([...rels], async (rel) => {
        if (await cache.match(keyOf(rel), { ignoreVary: true })) return;
        await fetchInto(cache, rel, m?.files.get(rel) ?? null).catch(() => {});   // best effort
    });
}

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg?.type === 'version') {
        event.waitUntil(manifest().then((m) => event.ports?.[0]?.postMessage({ type: 'version', version: VERSION, staged: !!m })));
    } else if (msg?.type === 'skip-waiting') {
        event.waitUntil(self.skipWaiting());
    } else if (msg?.type === 'precache' && Array.isArray(msg.urls)) {
        event.waitUntil(warm(msg.urls).catch(() => {}).then(() => event.source?.postMessage({ type: 'precached', version: VERSION })));
    }
});
