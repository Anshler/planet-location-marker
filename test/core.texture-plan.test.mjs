// Tests for js/core/texture-plan.js: which maps each tier loads, in what order, and the early
// download main.js hands to the texture store (instant-earth-progressive-textures).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ASSETS, PREVIEW, keysForTier, previewKeyFor, dayKeyFor, setMaxTextureSize, download, prefetchTextures,
} from '../js/core/texture-plan.js';
import { TIERS, tierConfig } from '../js/core/quality.js';
import { tierTextureKeys } from '../scripts/check-size.mjs';

/** A fetch stand-in: `bodies` maps URL → array of chunks (Uint8Array), or a number for an HTTP error. */
function fakeFetch(bodies, calls = []) {
    return async (url, init) => {
        calls.push({ url, init });
        const b = bodies[url];
        if (b === undefined) throw new TypeError('network error');
        if (typeof b === 'number') return { ok: false, status: b, headers: new Map(), body: null };
        let i = 0;
        return {
            ok: true,
            status: 200,
            headers: new Map([['Content-Type', 'image/webp']]),
            body: { getReader: () => ({ read: async () => (i < b.length ? { done: false, value: b[i++] } : { done: true }) }) },
        };
    };
}

test('every tier: the previews gate the loader, the day and night maps come next', () => {
    for (const name of Object.keys(TIERS)) {
        for (const cfg of [TIERS[name], tierConfig(name, { maxTextureSize: 4096 })]) {
            const k = keysForTier(cfg);
            assert.deepEqual(k.critical, ['dayPreview', 'nightPreview'], `${name}: critical`);
            assert.equal(k.primary.length, 2, `${name}: primary is the day and night map`);
            assert.match(k.primary[0], /^day[248]k$/);
            assert.match(k.primary[1], /^night[248]k$/);
            for (const key of k.primary) assert.ok(previewKeyFor(key), `${key} has a preview`);
            for (const key of [...k.critical, ...k.primary, ...k.deferred]) assert.ok(ASSETS[key], `${name}: ASSETS has ${key}`);
            assert.ok(!k.deferred.some((key) => k.primary.includes(key) || k.critical.includes(key)), 'no key twice');
        }
    }
    // Max starts with its 4096 stand-ins; the 8192 maps are deferred.
    assert.deepEqual(keysForTier(TIERS.max).primary, ['day4k', 'night4k']);
    assert.ok(keysForTier(TIERS.max).deferred.includes('day8k'));
});

test('check-size counts exactly what keysForTier loads', () => {
    const cfgs = Object.keys(TIERS).flatMap((t) => [TIERS[t], tierConfig(t, { maxTextureSize: 4096 })]);
    for (const cfg of cfgs) {
        const k = keysForTier(cfg);
        assert.deepEqual(tierTextureKeys(cfg), [...k.critical, ...k.primary, ...k.deferred], cfg.name);
    }
});

test('previews: the day maps share one, the night maps another; nothing else has one', () => {
    assert.equal(previewKeyFor('day2k'), 'dayPreview');
    assert.equal(previewKeyFor('day8k'), 'dayPreview');
    assert.equal(previewKeyFor('night4k'), 'nightPreview');
    for (const key of ['moon', 'brc4k', 'clouds2k', 'milkyway', 'dayPreview', null, undefined]) assert.equal(previewKeyFor(key), null);
    assert.ok(Object.isFrozen(PREVIEW));
    for (const key of ['dayPreview', 'nightPreview']) {
        assert.match(ASSETS[key].url, /^assets\/textures\/earth_(day|night)_preview\.webp$/);
        assert.equal(ASSETS[key].cs, 'srgb');
        assert.ok(ASSETS[key].bytes < 20e3, `${key} is tiny`);
    }
});

test('setMaxTextureSize drives the medium day map (and ignores junk)', () => {
    try {
        setMaxTextureSize(4096);
        assert.equal(dayKeyFor(TIERS.medium), 'day2k');
        setMaxTextureSize(NaN);
        setMaxTextureSize(0);
        assert.equal(dayKeyFor(TIERS.medium), 'day2k', 'junk keeps the last real value');
        setMaxTextureSize(16384);
        assert.equal(dayKeyFor(TIERS.medium), 'day4k');
    } finally {
        setMaxTextureSize(16384);
    }
});

test('download streams the body at once, counts bytes and reports chunks to a late listener', async () => {
    const calls = [];
    const fetchFn = fakeFetch({ 'a.webp': [new Uint8Array(3), new Uint8Array(5)] }, calls);
    const d = download('a.webp', fetchFn);
    const seen = [];
    d.onChunk = (n) => seen.push(n);
    const blob = await d.promise;
    assert.equal(blob.size, 8);
    assert.equal(blob.type, 'image/webp');
    assert.equal(d.received, 8);
    assert.deepEqual(seen, [3, 8]);
    // Same mode and credentials as the page's <link rel=preload as=fetch crossorigin>.
    assert.deepEqual(calls, [{ url: 'a.webp', init: { credentials: 'same-origin' } }]);
});

test('download rejects on HTTP errors and network errors, never unhandled', async () => {
    const fetchFn = fakeFetch({ 'gone.webp': 404 });
    await assert.rejects(download('gone.webp', fetchFn).promise, /HTTP 404 for gone\.webp/);
    await assert.rejects(download('offline.webp', fetchFn).promise, /network error/);
    // An unclaimed failed download must not trip 'unhandledRejection' (the page would log it).
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    try {
        download('offline.webp', fetchFn);
        await new Promise((r) => setTimeout(r, 20));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(unhandled, 0);
});

test('prefetchTextures: one download per URL, unknown keys skipped', async () => {
    const calls = [];
    const one = [new Uint8Array(1)];
    const fetchFn = fakeFetch({ [ASSETS.dayPreview.url]: one, [ASSETS.day4k.url]: one }, calls);
    const m = prefetchTextures(['dayPreview', 'day4k', 'dayPreview', 'nope'], fetchFn);
    assert.deepEqual([...m.keys()], [ASSETS.dayPreview.url, ASSETS.day4k.url]);
    await Promise.all([...m.values()].map((d) => d.promise));
    assert.equal(calls.length, 2);
});
