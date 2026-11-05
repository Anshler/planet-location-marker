// The staged service worker's update path, run in a sandbox (node:vm) with an in-memory Cache
// Storage and a fake network: an update keeps working offline what the older version held,
// including the files it cached lazily (data/i18n/vi.json, a texture) whose bytes changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { sha256, stampServiceWorker } from '../scripts/stage-site.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SW_SOURCE = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const SCOPE = 'https://example.test/app/';

/** In-memory CacheStorage: bodies are kept as bytes, every match is a fresh Response. */
function cacheStorage() {
    const store = new Map();
    const urlOf = (req) => (typeof req === 'string' ? req : req.url);
    const respond = (e) => new Response(e.body, { status: 200, headers: e.headers });
    const cacheOf = (entries) => ({
        async match(req) {
            const e = entries.get(urlOf(req));
            return e ? respond(e) : undefined;
        },
        async put(req, res) {
            entries.set(urlOf(req), { body: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] });
        },
        async add(req) {
            throw new Error(`unexpected add(${urlOf(req)})`);
        },
    });
    return {
        store,
        async open(name) {
            if (!store.has(name)) store.set(name, new Map());
            return cacheOf(store.get(name));
        },
        async keys() {
            return [...store.keys()];
        },
        async delete(name) {
            return store.delete(name);
        },
        async match(req, opts = {}) {
            for (const [name, entries] of store) {
                if (opts.cacheName && name !== opts.cacheName) continue;
                const e = entries.get(urlOf(req));
                if (e) return respond(e);
            }
            return undefined;
        },
        text(name, rel) {
            const e = store.get(name)?.get(SCOPE + rel);
            return e ? new TextDecoder().decode(e.body) : null;
        },
    };
}

/** A deployed version: its files, its manifest, and its stamped worker. */
function site(version, files, precache) {
    const lines = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, text]) => [p, sha256(text)]);
    const manifest = { version, sha256: sha256(JSON.stringify(lines)), precache, fresh: [], files: lines };
    return { version, files, manifest, sw: stampServiceWorker(SW_SOURCE, version) };
}

/** Boots a worker of `deployed` in a sandbox over `caches`; `net.site` is what the network serves. */
function worker(deployed, caches, net) {
    const handlers = {};
    const self = {
        location: new URL('sw.js', SCOPE),
        addEventListener: (type, fn) => { handlers[type] = fn; },
        registration: { active: null, navigationPreload: null },
        clients: { matchAll: async () => [], claim: async () => {} },
        skipWaiting: async () => {},
    };
    const fetch = async (req) => {
        const url = typeof req === 'string' ? req : req.url;
        if (net.offline) throw new TypeError('Failed to fetch');
        const rel = url.slice(SCOPE.length);
        net.log.push(rel);
        if (rel === 'sw-manifest.json') return new Response(JSON.stringify(net.site.manifest), { status: 200 });
        const text = net.site.files[rel];
        return text === undefined ? new Response('missing', { status: 404 }) : new Response(text, { status: 200 });
    };
    const ctx = vm.createContext({
        self, caches, fetch, Response, Request, URL, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, console,
    });
    vm.runInContext(deployed.sw, ctx, { filename: 'sw.js' });
    const run = (type, event = {}) => new Promise((resolve, reject) => {
        let done = Promise.resolve();
        handlers[type]({ ...event, waitUntil: (p) => { done = p; }, respondWith: (p) => { done = p; } });
        done.then(resolve, reject);
    });
    return {
        install: () => run('install'),
        activate: () => run('activate'),
        message: (data) => run('message', { data, source: { postMessage() {} } }),
        get: async (rel) => {
            const res = await run('fetch', { request: new Request(SCOPE + rel) });
            return res.text();
        },
    };
}

test('sw update: lazily cached files whose bytes changed are refreshed, so they still work offline', async () => {
    const precache = ['index.html', 'js/main.js'];
    const a = site('2.0.0+aaaaaaaaaaaaaaaa', {
        'index.html': 'page A', 'js/main.js': 'main', 'data/i18n/vi.json': '{"Up now":"Bây giờ"}',
        'assets/textures/big.jpg': 'texture A', 'assets/textures/other.jpg': 'never loaded',
    }, precache);
    const b = site('2.0.0+bbbbbbbbbbbbbbbb', {
        ...a.files, 'index.html': 'page B', 'data/i18n/vi.json': '{"Up now":"Lúc này"}', 'assets/textures/big.jpg': 'texture B',
    }, precache);
    const caches = cacheStorage();
    const net = { site: a, offline: false, log: [] };

    // Version A installs, and a Vietnamese visit caches vi.json and a texture lazily (the warm-up).
    const wa = worker(a, caches, net);
    await wa.install();
    await wa.activate();
    await wa.message({ type: 'precache', urls: [SCOPE + 'data/i18n/vi.json', SCOPE + 'assets/textures/big.jpg'] });
    assert.equal(caches.text(`pc2-${a.version}`, 'data/i18n/vi.json'), '{"Up now":"Bây giờ"}');

    // Version B is deployed and installs in the background.
    net.site = b;
    net.log = [];
    const wb = worker(b, caches, net);
    await wb.install();
    const cacheB = `pc2-${b.version}`;
    assert.equal(caches.text(cacheB, 'data/i18n/vi.json'), '{"Up now":"Lúc này"}', 'the changed table is refreshed');
    assert.equal(caches.text(cacheB, 'assets/textures/big.jpg'), 'texture B', 'the changed texture is refreshed');
    assert.equal(caches.text(cacheB, 'js/main.js'), 'main', 'an unchanged file is carried over');
    assert.ok(!net.log.includes('js/main.js'), 'and not downloaded again');
    assert.ok(!net.log.includes('assets/textures/other.jpg'), 'a file the user never had stays lazy');
    assert.equal(caches.text(cacheB, 'assets/textures/other.jpg'), null);

    // B activates (A's cache goes) and the next visit is offline: everything A had still loads.
    await wb.activate();
    assert.deepEqual(await caches.keys(), [cacheB]);
    net.offline = true;
    assert.equal(await wb.get('data/i18n/vi.json'), '{"Up now":"Lúc này"}');
    assert.equal(await wb.get('assets/textures/big.jpg'), 'texture B');
    assert.equal(await wb.get('index.html'), 'page B');
});

test('sw update: a refreshed file with another deploy\'s bytes fails the install', async () => {
    const precache = ['index.html'];
    const a = site('2.0.0+aaaaaaaaaaaaaaaa', { 'index.html': 'A', 'data/i18n/vi.json': 'vi A' }, precache);
    const b = site('2.0.0+bbbbbbbbbbbbbbbb', { 'index.html': 'B', 'data/i18n/vi.json': 'vi B' }, precache);
    const caches = cacheStorage();
    const net = { site: a, offline: false, log: [] };
    const wa = worker(a, caches, net);
    await wa.install();
    await wa.activate();
    await wa.message({ type: 'precache', urls: [SCOPE + 'data/i18n/vi.json'] });
    // B's manifest, but the network already serves a third deploy's vi.json.
    net.site = { ...b, files: { ...b.files, 'data/i18n/vi.json': 'vi C' } };
    await assert.rejects(worker(b, caches, net).install(), /does not match version/);
    assert.equal(caches.text(`pc2-${b.version}`, 'sw-manifest.json'), null, 'an incomplete version has no manifest');
});
