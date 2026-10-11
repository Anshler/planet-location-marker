// Tests for js/geo/geocode.js — every request goes to a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGeocoder, createLruCache, PROVIDERS } from '../js/geo/geocode.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/geocode/${name}.json`, import.meta.url), 'utf8'));
const OPEN_METEO = fixture('open-meteo');
const PHOTON = fixture('photon');
const NOMINATIM = fixture('nominatim');
const EMPTY = { 'open-meteo': { generationtime_ms: 0.1 }, photon: { type: 'FeatureCollection', features: [] }, nominatim: [] };

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const http = (status) => ({ ok: false, status, json: async () => ({}) });
const hostOf = (url) => (url.includes('open-meteo') ? 'open-meteo' : url.includes('photon') ? 'photon' : url.includes('nominatim') ? 'nominatim' : 'other');

/** Fake fetch: `routes[provider]` is a function (url, init) → response | Promise, or a JSON payload. */
function fakeFetch(routes = {}) {
    const calls = [];
    const fn = (url, init) => {
        const host = hostOf(url);
        calls.push({ host, url, signal: init?.signal });
        const r = routes[host];
        if (typeof r === 'function') return r(url, init);
        if (r === undefined) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(ok(r));
    };
    fn.calls = calls;
    fn.hosts = () => calls.map((c) => c.host);
    return fn;
}

/** A response that never arrives and ignores the abort signal. */
const hang = () => new Promise(() => {});
/** A response that only settles when the signal aborts (like real fetch). */
const hangUntilAbort = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});

test('PROVIDERS: order, flags and URLs', () => {
    assert.deepEqual(PROVIDERS.map((p) => p.id), ['open-meteo', 'photon', 'nominatim']);
    assert.deepEqual(PROVIDERS.map((p) => p.enterOnly), [false, false, true]);
    assert.ok(Object.isFrozen(PROVIDERS));
    const [om, ph, nm] = PROVIDERS;
    assert.equal(om.url('São Paulo & co'), 'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo%20%26%20co&count=8&language=en&format=json');
    assert.equal(ph.url('Lyon'), 'https://photon.komoot.io/api/?q=Lyon&limit=8&lang=en');
    assert.match(nm.url('Paris'), /^https:\/\/nominatim\.openstreetmap\.org\/search\?format=jsonv2&limit=8&accept-language=en&.*q=Paris$/);
});

test('open-meteo parser', () => {
    const places = PROVIDERS[0].parse(OPEN_METEO).filter(Boolean);
    assert.equal(places.length, 3, 'unusable records dropped');
    assert.deepEqual(places[0], {
        name: 'Paris', admin: 'Île-de-France', country: 'France', cc: 'FR', lat: 48.85341, lon: 2.3488, tz: 'Europe/Paris',
        pop: 2138551, source: 'open-meteo',
    });
    assert.equal(places[1].admin, 'Texas');
    assert.equal(places[1].tz, 'America/Chicago');
    assert.deepEqual(PROVIDERS[0].parse({}), []);
    assert.deepEqual(PROVIDERS[0].parse(null), []);
});

test('photon parser (GeoJSON, [lon, lat])', () => {
    const places = PROVIDERS[1].parse(PHOTON).filter(Boolean);
    assert.equal(places.length, 3);
    assert.deepEqual(places[0], {
        name: 'Lyon', admin: 'Auvergne-Rhône-Alpes', country: 'France', cc: 'FR', lat: 45.7578137, lon: 4.8320114, tz: null, pop: 0, source: 'photon',
    });
    assert.equal(places[1].name, 'Lyon Street', 'streets fall back to the street name');
    assert.equal(places[1].admin, 'Kansas');
    assert.deepEqual(PROVIDERS[1].parse({ features: 'x' }), []);
});

test('nominatim parser (jsonv2, string coordinates, display_name fallback)', () => {
    const places = PROVIDERS[2].parse(NOMINATIM).filter(Boolean);
    assert.equal(places.length, 2, 'latitude 95 dropped');
    assert.deepEqual(places[0], {
        name: 'Paris', admin: 'Île-de-France', country: 'France', cc: 'FR', lat: 48.8588897, lon: 2.320041, tz: null, pop: 0, source: 'nominatim',
    });
    assert.equal(places[1].name, 'Sydney', 'name from display_name');
    assert.equal(places[1].country, 'Australia', 'country from display_name');
    assert.equal(places[1].cc, '');
    assert.deepEqual(PROVIDERS[2].parse({}), []);
});

test('providers are tried in order and the first non-empty answer wins', async () => {
    const fetch = fakeFetch({ 'open-meteo': EMPTY['open-meteo'], photon: PHOTON, nominatim: NOMINATIM });
    const g = createGeocoder({ fetch });
    const r = await g.search('lyon');
    assert.equal(r.provider, 'photon');
    assert.deepEqual(r.places.map((p) => p.name), ['Lyon', 'Lyon Street'], 'duplicates removed');
    assert.deepEqual(fetch.hosts(), ['open-meteo', 'photon'], 'nominatim not asked without Enter');
    assert.equal(r.error, undefined);

    const fetch2 = fakeFetch({ 'open-meteo': OPEN_METEO, photon: PHOTON });
    const r2 = await createGeocoder({ fetch: fetch2 }).search('paris');
    assert.equal(r2.provider, 'open-meteo');
    assert.deepEqual(fetch2.hosts(), ['open-meteo'], 'stops at the first non-empty answer');
    assert.equal(r2.places.length, 3);
});

test('enterOnly: nominatim only on Enter', async () => {
    const routes = { 'open-meteo': EMPTY['open-meteo'], photon: EMPTY.photon, nominatim: NOMINATIM };
    const f1 = fakeFetch(routes);
    const g1 = createGeocoder({ fetch: f1 });
    const typing = await g1.search('paris');
    assert.deepEqual(typing, { places: [], provider: null });
    assert.deepEqual(f1.hosts(), ['open-meteo', 'photon']);
    const f2 = fakeFetch(routes);
    const enter = await createGeocoder({ fetch: f2 }).search('paris', { enter: true });
    assert.equal(enter.provider, 'nominatim');
    assert.deepEqual(f2.hosts(), ['open-meteo', 'photon', 'nominatim']);
});

test('a provider that does not answer times out (AbortController) and the next one is tried', async () => {
    for (const slow of [hang, hangUntilAbort]) {
        const fetch = fakeFetch({ 'open-meteo': slow, photon: PHOTON });
        const g = createGeocoder({ fetch, timeoutMs: 40 });
        const t0 = Date.now();
        const r = await g.search('lyon');
        const took = Date.now() - t0;
        assert.equal(r.provider, 'photon', slow.name);
        assert.ok(took >= 35 && took < 1000, `${slow.name}: took ${took} ms`);
        assert.equal(fetch.calls[0].signal.aborted, true, 'the request was aborted');
        assert.equal(g.providers()[0].failures, 1, 'a timeout counts as a failure');
    }
});

test('the response body is covered by the timeout too', async () => {
    const fetch = fakeFetch({ 'open-meteo': () => Promise.resolve({ ok: true, status: 200, json: hang }), photon: PHOTON });
    const r = await createGeocoder({ fetch, timeoutMs: 40 }).search('lyon');
    assert.equal(r.provider, 'photon');
});

test('circuit breaker: two consecutive failures trip a provider for the session; reset() re-arms', async () => {
    let omStatus = 500;
    const fetch = fakeFetch({ 'open-meteo': () => Promise.resolve(omStatus === 200 ? ok(OPEN_METEO) : http(omStatus)), photon: PHOTON });
    const g = createGeocoder({ fetch });
    await g.search('lyon');
    await g.search('lyon ');
    assert.deepEqual(fetch.hosts(), ['open-meteo', 'photon'], 'second search was served from the cache');
    await g.search('marseille');
    assert.deepEqual(g.providers().map((p) => [p.id, p.failures, p.tripped]), [['open-meteo', 2, true], ['photon', 0, false], ['nominatim', 0, false]]);
    fetch.calls.length = 0;
    omStatus = 200;
    await g.search('toulouse');
    assert.deepEqual(fetch.hosts(), ['photon'], 'tripped provider skipped');
    g.reset();
    fetch.calls.length = 0;
    const r = await g.search('nice');
    assert.deepEqual(fetch.hosts(), ['open-meteo']);
    assert.equal(r.provider, 'open-meteo');
});

test('failures must be consecutive to trip the breaker', async () => {
    const answers = [http(503), ok(OPEN_METEO), http(503), ok(OPEN_METEO)];
    const fetch = fakeFetch({ 'open-meteo': () => Promise.resolve(answers.shift()), photon: EMPTY.photon });
    const g = createGeocoder({ fetch });
    for (const q of ['aa', 'bb', 'cc', 'dd']) await g.search(q);
    assert.equal(g.providers()[0].tripped, false);
    assert.equal(g.providers()[0].failures, 0);
});

test('every kind of failure is survivable and reported; search never rejects', async () => {
    const cases = {
        network: () => Promise.reject(new TypeError('Failed to fetch')),
        sync: () => { throw new Error('sync explosion'); },
        http: () => Promise.resolve(http(429)),
        badJson: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
        nullResponse: () => Promise.resolve(null),
    };
    for (const [name, route] of Object.entries(cases)) {
        const fetch = fakeFetch({ 'open-meteo': route, photon: route, nominatim: route });
        const g = createGeocoder({ fetch });
        const r = await g.search('paris', { enter: true });
        assert.deepEqual(r.places, [], name);
        assert.equal(r.provider, null);
        assert.equal(typeof r.error, 'string', name);
        assert.match(r.error, /^nominatim: /, `${name}: names the last provider`);
        assert.equal(g.status(), 'down', name);
    }
    const throwingParse = [{ id: 'x', label: 'X', enterOnly: false, url: () => 'https://other.example/x', parse: () => { throw new Error('parser bug'); } }];
    const r = await createGeocoder({ fetch: fakeFetch({ other: {} }), providers: throwingParse }).search('paris');
    assert.match(r.error, /parser bug/);
});

test('status: unknown → ok → down, with onStatus notifications', async () => {
    const seen = [];
    let up = true;
    const route = () => (up ? Promise.resolve(ok(OPEN_METEO)) : Promise.reject(new TypeError('offline')));
    const g = createGeocoder({ fetch: fakeFetch({ 'open-meteo': route, photon: route }), onStatus: (s) => seen.push(s) });
    assert.equal(g.status(), 'unknown');
    await g.search('paris');
    assert.equal(g.status(), 'ok');
    up = false;
    await g.search('london');
    assert.equal(g.status(), 'down');
    await g.search('berlin');
    assert.equal(g.status(), 'down', 'all automatic providers tripped');
    assert.deepEqual(seen, ['ok', 'down']);
    const empty = createGeocoder({ fetch: fakeFetch({ 'open-meteo': EMPTY['open-meteo'], photon: EMPTY.photon }) });
    await empty.search('qwertyuiop');
    assert.equal(empty.status(), 'ok', 'an empty answer is still an answer');
});

test('a newer search supersedes an older one (out-of-order protection)', async () => {
    let releaseSlow;
    const fetch = fakeFetch({
        'open-meteo': (url) => (url.includes('name=slow')
            ? new Promise((resolve) => { releaseSlow = () => resolve(ok(OPEN_METEO)); })
            : Promise.resolve(ok({ results: [{ name: 'Fast', latitude: 1, longitude: 2, country_code: 'FR' }] }))),
    });
    const g = createGeocoder({ fetch });
    const slow = g.search('slow');
    const fast = g.search('fast');
    const [a, b] = await Promise.all([slow, fast]);
    assert.equal(a.stale, true);
    assert.deepEqual(a.places, []);
    assert.equal(b.places[0].name, 'Fast');
    releaseSlow();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(g.providers()[0].failures, 0, 'a superseded request is not a provider failure');
    // Even an empty or too-short query cancels the one in flight.
    const fetch2 = fakeFetch({ 'open-meteo': hangUntilAbort });
    const g2 = createGeocoder({ fetch: fetch2 });
    const pending = g2.search('pending');
    const cleared = await g2.search('');
    assert.deepEqual(cleared, { places: [], provider: null });
    assert.equal((await pending).stale, true);
    assert.equal(fetch2.calls[0].signal.aborted, true, 'the network request itself was aborted');
});

test('caller cancellation via AbortSignal', async () => {
    const fetch = fakeFetch({ 'open-meteo': hangUntilAbort });
    const g = createGeocoder({ fetch });
    const ctl = new AbortController();
    const p = g.search('paris', { signal: ctl.signal });
    ctl.abort();
    const r = await p;
    assert.equal(r.stale, true);
    assert.equal(g.providers()[0].failures, 0, 'not counted against the provider');
    const pre = new AbortController();
    pre.abort();
    const fetch2 = fakeFetch({ 'open-meteo': OPEN_METEO });
    const r2 = await createGeocoder({ fetch: fetch2 }).search('paris', { signal: pre.signal });
    assert.equal(r2.stale, true);
    assert.equal(fetch2.calls.length, 0, 'an already-aborted search makes no request');
});

test('results are cached by folded query and returned as copies', async () => {
    const fetch = fakeFetch({ 'open-meteo': OPEN_METEO });
    const g = createGeocoder({ fetch });
    const a = await g.search('Paris');
    a.places[0].name = 'Mutated';
    const b = await g.search('  PARIS ');
    assert.equal(b.cached, true);
    assert.equal(b.provider, 'open-meteo');
    assert.equal(b.places[0].name, 'Paris', 'cache is not affected by callers');
    assert.equal(fetch.calls.length, 1);
    const c = await g.search('pàris');
    assert.equal(c.cached, true, 'diacritics fold to the same key');
});

test('short or junk queries make no requests', async () => {
    const fetch = fakeFetch({ 'open-meteo': OPEN_METEO });
    const g = createGeocoder({ fetch });
    for (const q of ['', ' ', 'a', '!!', null, undefined, 42]) assert.deepEqual(await g.search(q), { places: [], provider: null });
    assert.equal(fetch.calls.length, 0);
    const long = await g.search('x'.repeat(500));
    assert.ok(fetch.calls[0].url.length < 400, 'query capped');
    assert.deepEqual(long.places.length, 3);
});

test('no fetch available', async () => {
    const g = createGeocoder({ fetch: null });
    const r = await g.search('paris');
    assert.deepEqual(r, { places: [], provider: null, error: 'no-fetch' });
    assert.equal(g.status(), 'down');
});

test('per-provider minimum interval (Nominatim policy: 1 request per second)', async () => {
    const polite = [{ ...PROVIDERS[0], id: 'polite', minIntervalMs: 80 }];
    const times = [];
    const fetch = (url) => {
        times.push(Date.now());
        return Promise.resolve(ok(OPEN_METEO));
    };
    const g = createGeocoder({ fetch, providers: polite });
    await g.search('first');
    await g.search('second');
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 75, `spaced by ${times[1] - times[0]} ms`);
    assert.equal(PROVIDERS[2].minIntervalMs >= 1000, true, 'nominatim is throttled to ≤ 1 req/s');
});

test('LRU cache', () => {
    const changes = [];
    const lru = createLruCache({ max: 2, initial: [['a', 1], ['b', 2], ['c', 3], 'junk', [5, 'x']], onChange: (e) => changes.push(e.length) });
    assert.deepEqual(lru.entries(), [['b', 2], ['c', 3]], 'initial entries trimmed to max');
    assert.equal(lru.get('b'), 2);
    lru.set('d', 4);
    assert.deepEqual(lru.entries(), [['b', 2], ['d', 4]], 'least recently used (c) evicted');
    assert.equal(lru.has('c'), false);
    assert.equal(lru.get('zzz'), undefined);
    assert.equal(lru.size, 2);
    assert.deepEqual(changes, [2]);
    lru.delete('b');
    lru.clear();
    assert.equal(lru.size, 0);
    const def = createLruCache();
    for (let i = 0; i < 60; i++) def.set(`k${i}`, i);
    assert.equal(def.size, 50, 'default size 50');
    const bad = createLruCache({ onChange: () => { throw new Error('quota'); } });
    bad.set('x', 1);
    assert.equal(bad.get('x'), 1, 'a failing persistence hook is ignored');
});

test('an injected cache (e.g. persisted through prefs) is used', async () => {
    const store = new Map([['paris', { places: [{ name: 'Cached Paris', admin: '', country: 'France', cc: 'FR', lat: 48.85, lon: 2.35, tz: null, pop: 0, source: 'photon' }], provider: 'photon' }]]);
    const cache = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    const fetch = fakeFetch({ 'open-meteo': OPEN_METEO });
    const g = createGeocoder({ fetch, cache });
    const r = await g.search('Paris');
    assert.equal(r.places[0].name, 'Cached Paris');
    assert.equal(fetch.calls.length, 0);
    await g.search('lyon');
    assert.ok(store.has('lyon'));
    const broken = createGeocoder({ fetch: fakeFetch({ 'open-meteo': OPEN_METEO }), cache: { get() { throw new Error('x'); }, set() { throw new Error('y'); } } });
    assert.equal((await broken.search('paris')).places.length, 3, 'a broken cache never breaks search');
});
