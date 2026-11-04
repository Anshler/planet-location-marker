// The texture store (instant-earth-progressive-textures, boot-critical-path-diet): a prefetched
// download is taken over, uploads wait while the shaders compile, and a day or night map shows its
// preview while it loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { ASSETS, download } from '../js/core/texture-plan.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const { createTextureStore } = await import('../js/render/textures.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Node has no image decoder: a 2:1 stand-in bitmap is enough for the store's bookkeeping. */
function withFakeDecoder(fn) {
    const had = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 2, height: 1, close() {} });
    return Promise.resolve().then(fn).finally(() => {
        if (had) globalThis.createImageBitmap = had;
        else delete globalThis.createImageBitmap;
    });
}

/** fetch stand-in serving `size` bytes for every URL (in two chunks), recording calls. */
function fakeFetch(calls, { status = 200, size = 10 } = {}) {
    return async (url) => {
        calls.push(url);
        if (status !== 200) return { ok: false, status, headers: new Map(), body: null };
        const parts = [new Uint8Array(size >> 1), new Uint8Array(size - (size >> 1))];
        let i = 0;
        return {
            ok: true, status, headers: new Map(),
            body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) }) },
        };
    };
}

function fakeRenderer(uploads) {
    return {
        capabilities: { maxTextureSize: 16384, getMaxAnisotropy: () => 16 },
        initTexture: (t) => uploads.push(t.name),
    };
}

test('store: a prefetched download is taken over once, with the bytes already in', () => withFakeDecoder(async () => {
    const calls = [];
    const had = globalThis.fetch;
    globalThis.fetch = fakeFetch(calls);
    try {
        const prefetched = new Map([[ASSETS.day2k.url, download(ASSETS.day2k.url, fakeFetch(calls, { size: 144 }))]]);
        await prefetched.get(ASSETS.day2k.url).promise;
        const events = [];
        const store = createTextureStore(fakeRenderer([]), { prefetched, onProgress: (e) => events.push(e) });
        await store.load(['day2k']);
        assert.equal(store.isReady('day2k'), true);
        assert.deepEqual(calls, [ASSETS.day2k.url], 'not fetched a second time');
        assert.equal(prefetched.size, 0, 'claimed');
        assert.ok(events.some((e) => e.key === 'day2k' && e.done));
        assert.deepEqual(store.progress(), { loaded: ASSETS.day2k.bytes, total: ASSETS.day2k.bytes });
        // A later load of another key fetches normally.
        await store.load(['night2k']);
        assert.deepEqual(calls, [ASSETS.day2k.url, ASSETS.night2k.url]);
    } finally {
        globalThis.fetch = had;
    }
}));

test('store: uploads wait while held, then go out one per task; the map is ready meanwhile', () => withFakeDecoder(async () => {
    const had = globalThis.fetch;
    globalThis.fetch = fakeFetch([]);
    try {
        const uploads = [];
        const store = createTextureStore(fakeRenderer(uploads), {});
        await store.load(['dayPreview']);
        assert.deepEqual(uploads, ['dayPreview'], 'eager upload before the compile starts');
        let release;
        store.holdUploads(new Promise((r) => { release = r; }));
        await store.load(['day2k', 'night2k']);
        assert.equal(store.isReady('day2k'), true, 'bound at once (a frame would upload it itself)');
        assert.deepEqual(uploads, ['dayPreview'], 'no upload while the shaders compile');
        release();
        for (let i = 0; i < 10 && uploads.length < 3; i++) await tick(5);
        assert.deepEqual(uploads, ['dayPreview', 'day2k', 'night2k']);
        await store.load(['moon']);
        assert.deepEqual(uploads.at(-1), 'moon', 'eager again once released');
    } finally {
        globalThis.fetch = had;
    }
}));

test('store: a day or night map shows its preview while it loads, or after it failed', () => withFakeDecoder(async () => {
    const had = globalThis.fetch;
    const calls = [];
    const ok = fakeFetch(calls), gone = fakeFetch(calls, { status: 404 });
    globalThis.fetch = (url) => (url === ASSETS.night2k.url ? gone(url) : ok(url));
    try {
        const store = createTextureStore(fakeRenderer([]), {});
        assert.equal(store.state('day2k'), 'idle');
        assert.match(store.get('day2k').name, /^placeholder:/);
        await store.load(['dayPreview', 'nightPreview']);
        assert.equal(store.state('day2k'), 'preview');
        assert.equal(store.get('day2k'), store.get('dayPreview'), 'get() falls back to the preview');
        assert.equal(store.get('day4k'), store.get('dayPreview'), 'every day map shares it');
        assert.equal(store.isReady('day2k'), false);
        await store.load(['day2k', 'night2k']);
        assert.equal(store.state('day2k'), 'ready');
        assert.equal(store.get('day2k').name, 'day2k');
        assert.equal(store.state('night2k'), 'preview', 'a failed map keeps its preview');
        assert.equal(store.get('night2k'), store.get('nightPreview'));
        assert.equal(store.state('moon'), 'idle', 'only day and night maps have previews');
    } finally {
        globalThis.fetch = had;
    }
}));
