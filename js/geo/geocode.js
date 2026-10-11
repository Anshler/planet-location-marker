// Optional online geocoding (SPEC §C.3, §B.14).
//
// Offline city search always comes first; this module only adds online results. Providers are
// tried in order (open-meteo → Photon → Nominatim) and the first non-empty answer wins.
//   - Every request has its own timeout (4 s) through an AbortController; the race against the
//     timeout does not rely on fetch honouring the signal.
//   - Circuit breaker: a provider that fails twice in a row (network, timeout, HTTP error, bad
//     JSON) is skipped for the rest of the session (reset() re-arms it, e.g. on 'online').
//   - Nominatim is `enterOnly` (its usage policy forbids autocomplete) and is limited to one
//     request per second.
//   - A newer search supersedes an older one: the older resolves at once with `stale: true` and
//     its results are never delivered.
//   - search() never rejects; failures resolve as `{places: [], provider: null, error}`.
//   - Successful non-empty results are cached in a 50-entry LRU keyed by the folded query.

import { foldText } from './cities.js';

/** @typedef {import('../core/types.js').Place} Place */
/** @typedef {{id:string, label:string, enterOnly:boolean, minIntervalMs?:number, url:(q:string)=>string, parse:(json:any)=>Place[]}} Provider */

const MAX_RESULTS = 8;
const MAX_QUERY = 120;

/** @param {unknown} v */
const text = (v) => (typeof v === 'string' ? v.trim() : '');
/** @param {unknown} v */
const finite = (v) => {
    const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
    return typeof v !== 'boolean' && v !== null && v !== '' && Number.isFinite(n) ? n : Number.NaN;
};

/**
 * Normalises one provider record into a Place, or null when unusable.
 * @returns {Place|null}
 */
function makePlace({ name, admin, country, cc, lat, lon, tz, pop }, source) {
    const la = finite(lat), lo = finite(lon);
    const nm = text(name);
    if (!nm || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    const code = text(cc).toUpperCase();
    return {
        name: nm.slice(0, 120), admin: text(admin).slice(0, 120), country: text(country).slice(0, 120),
        cc: /^[A-Z]{2}$/.test(code) ? code : '', lat: la, lon: lo, tz: text(tz) || null,
        pop: Math.max(0, finite(pop) || 0), source,
    };
}

/** open-meteo geocoding: `{results:[{name, admin1, country, country_code, latitude, longitude, timezone, population}]}`. */
const openMeteo = Object.freeze({
    id: 'open-meteo',
    label: 'Open-Meteo',
    enterOnly: false,
    url: (q) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`,
    parse(json) {
        const rows = Array.isArray(json?.results) ? json.results : [];
        return rows.map((r) => r && makePlace({
            name: r.name, admin: r.admin1, country: r.country, cc: r.country_code,
            lat: r.latitude, lon: r.longitude, tz: r.timezone, pop: r.population,
        }, 'open-meteo'));
    },
});

/** Photon (komoot): GeoJSON FeatureCollection, `geometry.coordinates = [lon, lat]`. */
const photon = Object.freeze({
    id: 'photon',
    label: 'Photon',
    enterOnly: false,
    url: (q) => `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`,
    parse(json) {
        const feats = Array.isArray(json?.features) ? json.features : [];
        return feats.map((f) => {
            const p = f?.properties ?? {};
            const c = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : [];
            return makePlace({
                name: p.name || p.city || p.street, admin: p.state || p.county, country: p.country, cc: p.countrycode,
                lat: c[1], lon: c[0], tz: null, pop: 0,
            }, 'photon');
        });
    },
});

/** Nominatim (OSM): array of `{lat, lon, name, display_name, address?}`; Enter only, 1 request/s. */
const nominatim = Object.freeze({
    id: 'nominatim',
    label: 'OpenStreetMap',
    enterOnly: true,
    minIntervalMs: 1100,
    url: (q) => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=en&addressdetails=1&q=${encodeURIComponent(q)}`,
    parse(json) {
        const rows = Array.isArray(json) ? json : [];
        return rows.map((r) => {
            if (!r || typeof r !== 'object') return null;
            const parts = text(r.display_name).split(',').map((s) => s.trim()).filter(Boolean);
            const a = r.address && typeof r.address === 'object' ? r.address : {};
            return makePlace({
                name: r.name || parts[0], admin: a.state || a.region || a.county || '',
                country: a.country || (parts.length > 1 ? parts[parts.length - 1] : ''), cc: a.country_code,
                lat: r.lat, lon: r.lon, tz: null, pop: 0,
            }, 'nominatim');
        });
    },
});

/** The providers, in the order they are tried. */
export const PROVIDERS = Object.freeze([openMeteo, photon, nominatim]);

/**
 * Small LRU map for geocoder results.
 * `entries()` lists [key, value] pairs oldest first (handy for persisting through prefs: pass
 * them back as `initial`). `onChange(entries)` runs after every set.
 * @param {{max?:number, initial?:[string, any][], onChange?:(entries:[string, any][])=>void}} [opts]
 */
export function createLruCache({ max = 50, initial, onChange } = {}) {
    const limit = Math.max(1, Math.floor(Number(max)) || 50);
    /** @type {Map<string, any>} */
    const map = new Map();
    if (Array.isArray(initial)) {
        for (const pair of initial) if (Array.isArray(pair) && typeof pair[0] === 'string') map.set(pair[0], pair[1]);
        while (map.size > limit) map.delete(map.keys().next().value);
    }
    return {
        get(k) {
            if (!map.has(k)) return undefined;
            const v = map.get(k);
            map.delete(k);
            map.set(k, v);
            return v;
        },
        set(k, v) {
            map.delete(k);
            map.set(k, v);
            while (map.size > limit) map.delete(map.keys().next().value);
            if (typeof onChange === 'function') {
                try {
                    onChange([...map.entries()]);
                } catch {
                    // Persistence is best-effort.
                }
            }
        },
        has: (k) => map.has(k),
        delete: (k) => map.delete(k),
        clear: () => map.clear(),
        get size() { return map.size; },
        entries: () => [...map.entries()],
    };
}

/** Error raised when a request is cut short; `timeout` tells a timeout from a cancellation. */
class RequestAborted extends Error {
    constructor(timeout) {
        super(timeout ? 'timeout' : 'aborted');
        this.name = 'AbortError';
        this.timeout = timeout;
    }
}

/** Resolves/rejects with `p`, or rejects as soon as `signal` aborts (even if `p` ignores it). */
function raceAbort(p, signal, isTimeout) {
    if (signal.aborted) return Promise.reject(new RequestAborted(isTimeout()));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new RequestAborted(isTimeout()));
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(p).then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

/** Waits `ms`, rejecting early if `signal` aborts. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new RequestAborted(false));
            return;
        }
        const id = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(id); reject(new RequestAborted(false)); };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Drops nulls, near-duplicates (same name within ~1 km) and caps the list. */
function tidy(places) {
    const out = [];
    for (const p of Array.isArray(places) ? places : []) {
        if (!p) continue;
        const key = foldText(p.name);
        if (out.some((o) => foldText(o.name) === key && Math.abs(o.lat - p.lat) < 0.01 && Math.abs(o.lon - p.lon) < 0.01)) continue;
        out.push(p);
        if (out.length >= MAX_RESULTS) break;
    }
    return out;
}

/**
 * Creates the online geocoder.
 * @param {{fetch?:typeof globalThis.fetch, providers?:readonly Provider[], timeoutMs?:number,
 *          cache?:{get:(q:string)=>any, set:(q:string, v:any)=>void}|null, now?:()=>number,
 *          onStatus?:(status:'unknown'|'ok'|'down')=>void}} [opts]
 * @returns {import('../core/types.js').Geocoder}
 */
export function createGeocoder({ fetch: fetchImpl = globalThis.fetch, providers = PROVIDERS, timeoutMs = 4000, cache, now = () => Date.now(), onStatus } = {}) {
    const list = Array.isArray(providers) ? providers.filter((p) => p && typeof p.url === 'function' && typeof p.parse === 'function') : [];
    const store = cache && typeof cache.get === 'function' && typeof cache.set === 'function' ? cache : createLruCache({ max: 50 });
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 4000;
    /** @type {Map<string, number>} consecutive failures per provider id */
    const failures = new Map();
    /** @type {Map<string, number>} last request time per provider id */
    const lastRequestAt = new Map();
    /** @type {'unknown'|'ok'|'down'} */
    let status = 'unknown';
    /** @type {AbortController|null} */
    let current = null;

    const tripped = (p) => (failures.get(p.id) ?? 0) >= 2;

    function setStatus(s) {
        if (s === status) return;
        status = s;
        if (typeof onStatus === 'function') {
            try {
                onStatus(s);
            } catch (err) {
                console.error('[geocode] onStatus failed:', err);
            }
        }
    }

    /** One provider request: throttle, fetch with timeout, parse. Throws RequestAborted or Error. */
    async function query(p, q, outer) {
        const ctl = new AbortController();
        let timedOut = false;
        const onOuter = () => ctl.abort();
        outer.addEventListener('abort', onOuter, { once: true });
        try {
            const gap = Number(p.minIntervalMs) || 0;
            if (gap > 0) {
                const wait = (lastRequestAt.get(p.id) ?? -Infinity) + gap - now();
                if (wait > 0) await sleep(wait, ctl.signal);
            }
            lastRequestAt.set(p.id, now());
            const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
            try {
                const res = await raceAbort(fetchImpl.call(globalThis, p.url(q), { signal: ctl.signal }), ctl.signal, () => timedOut);
                if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? 'error'}`);
                const json = await raceAbort(res.json(), ctl.signal, () => timedOut);
                return tidy(p.parse(json));
            } finally {
                clearTimeout(timer);
            }
        } finally {
            outer.removeEventListener('abort', onOuter);
        }
    }

    async function search(q, { signal, enter = false } = {}) {
        const query0 = (typeof q === 'string' ? q : '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
        const key = foldText(query0);

        // Any newer call, even an empty one, supersedes the previous search: its promise resolves
        // as stale right away and its results are never delivered.
        if (current) {
            current.abort();
            current = null;
        }
        if (key.length < 2) return { places: [], provider: null };
        const ctl = new AbortController();
        current = ctl;
        const stale = () => ({ places: [], provider: null, error: 'aborted', stale: true });
        const onCaller = () => ctl.abort();
        if (signal?.aborted) ctl.abort();
        else signal?.addEventListener?.('abort', onCaller, { once: true });

        try {
            if (ctl.signal.aborted) return stale();
            let hit;
            try {
                hit = store.get(key);
            } catch {
                hit = undefined;
            }
            if (hit && Array.isArray(hit.places) && hit.places.length) {
                return { places: hit.places.map((p) => ({ ...p })), provider: hit.provider ?? null, cached: true };
            }
            if (typeof fetchImpl !== 'function') {
                setStatus('down');
                return { places: [], provider: null, error: 'no-fetch' };
            }

            let attempted = 0, answered = 0;
            let lastError = '';
            for (const p of list) {
                if ((p.enterOnly && !enter) || tripped(p)) continue;
                if (ctl.signal.aborted) return stale();
                attempted++;
                let places;
                try {
                    places = await raceAbort(query(p, query0, ctl.signal), ctl.signal, () => false);
                } catch (err) {
                    if (ctl.signal.aborted) return stale();
                    failures.set(p.id, (failures.get(p.id) ?? 0) + 1);
                    lastError = `${p.id}: ${err?.timeout ? 'timeout' : err?.message || 'failed'}`;
                    continue;
                }
                if (ctl.signal.aborted) return stale();
                answered++;
                failures.set(p.id, 0);
                if (places.length) {
                    setStatus('ok');
                    try {
                        store.set(key, { places, provider: p.id });
                    } catch {
                        // A broken cache must not break search.
                    }
                    return { places: places.map((x) => ({ ...x })), provider: p.id };
                }
            }
            if (answered > 0) {
                setStatus('ok');
                return { places: [], provider: null };
            }
            const everyAutoProviderDown = list.filter((p) => !p.enterOnly).every(tripped);
            if (attempted > 0 || everyAutoProviderDown) setStatus('down');
            return { places: [], provider: null, error: lastError || (everyAutoProviderDown ? 'unavailable' : 'enter-only') };
        } catch (err) {
            if (ctl.signal.aborted) return stale();
            return { places: [], provider: null, error: String(err?.message ?? err) };
        } finally {
            signal?.removeEventListener?.('abort', onCaller);
            if (current === ctl) current = null;
        }
    }

    return {
        search,
        status: () => status,
        reset() {
            failures.clear();
            setStatus('unknown');
        },
        providers: () => list.map((p) => ({ id: p.id, label: p.label, enterOnly: !!p.enterOnly, failures: failures.get(p.id) ?? 0, tripped: tripped(p) })),
    };
}
