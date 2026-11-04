// Which images each quality tier loads, and their early download (SPEC §C.5, tiers in §E.6).
//
// Pure (no three.js), so main.js can start the tier's maps while the render stack is still
// loading: boot() picks the keys right after the tier is known and hands the in-flight downloads
// to the texture store (js/render/textures.js), which decodes and uploads them. The store
// re-exports everything here, so render modules keep importing from './textures.js'.
//
// Load order per tier (keysForTier): the two previews (critical: the globe is a lit Earth from its
// first frame and the loader waits only for them), then the tier's day and night maps (primary:
// the earth shader sharpens into them), then the rest in idle time (deferred).

/**
 * Every image the app loads. `bytes` are the on-disk sizes used to weight loader progress;
 * `cs` is the colour space ('srgb' for colour, 'linear' for data); `keep`: the texture store keeps
 * its decoded image after the upload instead of closing it, because the CPU reads its pixels (the
 * ocean masks: render/ground.js's water sampler) or it is a 512 px preview (0.5 MB each), the
 * stand-in of a day or night map that cannot be fetched again after a context restore.
 *
 * The .webp maps are made from the vendored 4096 maps by scripts/build-textures.mjs
 * (vendor/DERIVED.json): day2k and night2k are those maps at half size, filtered like
 * their own mip 1, and clouds2k and roughness2k are the blue (cloud) and green (water)
 * channels of brc4k as grey, so every tier shows the same planet, water and weather.
 * dayPreview and nightPreview are the same maps at 512 px. Every browser that runs the 3D view
 * (it needs import maps) decodes WebP.
 *
 * The max tier's maps (day8k, night8k, clouds8k, moon4k) are loaded by that tier only. They are
 * Solar System Scope's 8192 px originals of the same imagery (clouds8k is their cloud map as
 * clamped grey WebP, moon4k their 8192 px Moon at half size), and while they download and decode
 * the slot shows its 4096 map (INTERIM), so max starts as fast as high and sharpens in place.
 */
export const ASSETS = {
    dayPreview: { url: 'assets/textures/earth_day_preview.webp', bytes: 12e3, cs: 'srgb', keep: true },
    nightPreview: { url: 'assets/textures/earth_night_preview.webp', bytes: 6e3, cs: 'srgb', keep: true },
    day8k: { url: 'assets/textures/earth_day_8192.jpg', bytes: 4565e3, cs: 'srgb' },
    night8k: { url: 'assets/textures/earth_night_8192.jpg', bytes: 3144e3, cs: 'srgb' },
    clouds8k: { url: 'assets/textures/earth_clouds_8192.webp', bytes: 4816e3, cs: 'linear' },
    moon4k: { url: 'assets/textures/moon_4096.webp', bytes: 2693e3, cs: 'srgb' },
    day4k: { url: 'assets/textures/earth_day_4096.jpg', bytes: 473e3, cs: 'srgb' },
    day2k: { url: 'assets/textures/earth_day_2048.webp', bytes: 144e3, cs: 'srgb' },
    night4k: { url: 'assets/textures/earth_night_4096.jpg', bytes: 267e3, cs: 'srgb' },
    night2k: { url: 'assets/textures/earth_night_2048.webp', bytes: 75e3, cs: 'srgb' },
    roughness2k: { url: 'assets/textures/earth_roughness_2048.webp', bytes: 56e3, cs: 'linear', keep: true },
    clouds2k: { url: 'assets/textures/earth_clouds_2048.webp', bytes: 235e3, cs: 'linear' },
    brc4k: { url: 'assets/textures/earth_bump_roughness_clouds_4096.jpg', bytes: 1508e3, cs: 'linear', keep: true },
    moon: { url: 'assets/textures/moon_1024.jpg', bytes: 238e3, cs: 'srgb' },
    milkyway: { url: 'data/milkyway.png', bytes: 200e3, cs: 'linear', mipmaps: false },
};

/**
 * The map a slot shows while its max-tier map loads: the same imagery at 4096 px (clouds8k's is
 * brc4k's blue channel, which the high tier draws).
 */
export const INTERIM = Object.freeze({ day8k: 'day4k', night8k: 'night4k', clouds8k: 'brc4k', moon4k: 'moon' });

/** The 512 px stand-in of every day and night map, shown until that map (or its INTERIM) is in. */
export const PREVIEW = Object.freeze({
    day2k: 'dayPreview', day4k: 'dayPreview', day8k: 'dayPreview',
    night2k: 'nightPreview', night4k: 'nightPreview', night8k: 'nightPreview',
});

/**
 * The stand-in for a key while it loads, or null when the key has none.
 * @param {string|null} key
 * @returns {string|null}
 */
export function interimKeyFor(key) {
    return (key && INTERIM[key]) || null;
}

/**
 * The preview of a day or night map, or null.
 * @param {string|null} key
 * @returns {'dayPreview'|'nightPreview'|null}
 */
export function previewKeyFor(key) {
    return (key && PREVIEW[key]) || null;
}

/** The GPU's max texture size (the probe's, then the renderer's); drives the day-map choice. */
let maxTextureSize = 16384;

/**
 * Tells the key choice what the GPU can hold (index.html's probe at boot, then the renderer).
 * @param {number} n MAX_TEXTURE_SIZE; ignored unless a positive number
 */
export function setMaxTextureSize(n) {
    if (Number.isFinite(n) && n > 0) maxTextureSize = n;
}

/**
 * Day-map key for a tier. SPEC risk 4: on medium, devices whose max texture
 * size is under 8192 (older iOS) keep the 2k map to save memory. A GPU that
 * cannot hold an 8192 texture keeps the 4k map on max.
 * @param {{name?:string, dayTex?:'day2k'|'day4k'|'day8k'}} cfg TierCfg
 * @returns {'day2k'|'day4k'|'day8k'}
 */
export function dayKeyFor(cfg) {
    const want = cfg?.dayTex === 'day2k' ? 'day2k' : cfg?.dayTex === 'day8k' ? 'day8k' : 'day4k';
    if (want === 'day8k' && maxTextureSize < 8192) return 'day4k';
    if (want === 'day4k' && cfg?.name === 'medium' && maxTextureSize < 8192) return 'day2k';
    return want;
}

/**
 * Night-lights key for a tier: it follows the day map, so a tier that saves memory
 * with the 2k day map does not hold a 4k night map either.
 * @param {{name?:string, dayTex?:'day2k'|'day4k'|'day8k'}} cfg TierCfg
 * @returns {'night2k'|'night4k'|'night8k'}
 */
export function nightKeyFor(cfg) {
    const day = dayKeyFor(cfg);
    return day === 'day2k' ? 'night2k' : day === 'day8k' ? 'night8k' : 'night4k';
}

/**
 * Moon-map key for a tier: the 4096 map on max (when the GPU takes 4096), else the 1024 one.
 * @param {{moonTex?:'moon'|'moon4k'}} cfg TierCfg
 * @returns {'moon'|'moon4k'}
 */
export function moonKeyFor(cfg) {
    return cfg?.moonTex === 'moon4k' && maxTextureSize >= 4096 ? 'moon4k' : 'moon';
}

/**
 * Ocean-mask key for a tier, or null when the mask is derived from the day map. Both
 * masks are the same roughness data (water ~ 0): brc4k's green channel, or its 2k copy.
 * Every tier ships one: the derived mask (the stand-in while a mask loads) reads the day
 * map's chroma, which WebP and JPEG store at half resolution, so it loses small islands.
 * @param {{oceanMask?:'derived'|'roughness2k'|'roughness'}} cfg
 * @returns {'roughness2k'|'brc4k'|null}
 */
export function maskKeyFor(cfg) {
    if (cfg?.oceanMask === 'roughness2k') return 'roughness2k';
    if (cfg?.oceanMask === 'roughness') return 'brc4k';
    return null;
}

/**
 * Cloud-map key for a tier, or null when the tier has no clouds.
 * @param {{clouds?:'none'|'clouds2k'|'brc4k'|'clouds8k'}} cfg
 * @returns {'clouds2k'|'brc4k'|'clouds8k'|null}
 */
export function cloudsKeyFor(cfg) {
    if (cfg?.clouds === 'clouds2k') return 'clouds2k';
    if (cfg?.clouds === 'brc4k') return 'brc4k';
    if (cfg?.clouds === 'clouds8k') return maxTextureSize < 8192 ? 'brc4k' : 'clouds8k';
    return null;
}

/**
 * Which keys a tier needs: the previews gate the loader (critical), the day and night maps
 * follow at once (primary) and everything else streams in during idle time (deferred), most
 * visible first. A max-tier map gates nothing: its 4096 stand-in (INTERIM) takes its place in
 * that order, and the max maps themselves come last.
 * @param {object} cfg TierCfg
 * @returns {{critical:string[], primary:string[], deferred:string[]}}
 */
export function keysForTier(cfg) {
    const day = dayKeyFor(cfg), night = nightKeyFor(cfg), clouds = cloudsKeyFor(cfg), moon = moonKeyFor(cfg);
    const stand = (k) => interimKeyFor(k) ?? k;
    const deferred = [];
    const push = (k) => { if (k && !deferred.includes(k)) deferred.push(k); };
    push(maskKeyFor(cfg));
    push(stand(clouds));
    push(stand(moon));
    push('milkyway');
    for (const k of [day, night, clouds, moon]) if (interimKeyFor(k)) push(k);
    return { critical: ['dayPreview', 'nightPreview'], primary: [stand(day), stand(night)], deferred };
}

/**
 * Starts streaming one image now. `received` counts the bytes so far and `onChunk` (settable
 * later, e.g. by the texture store that takes the download over) hears each chunk. The body is
 * read at once, so a download nobody has claimed yet never stalls on a full pipe.
 * @param {string} url relative URL
 * @param {typeof fetch} fetchFn
 * @returns {{url:string, received:number, onChunk:((received:number)=>void)|null, promise:Promise<Blob>}}
 *   promise rejects on a network error or an HTTP error status
 */
export function download(url, fetchFn) {
    const d = { url, received: 0, onChunk: null, promise: null };
    d.promise = (async () => {
        // Same mode and credentials as <link rel=preload as=fetch crossorigin>, so a preload is reused.
        const res = await fetchFn(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        if (!res.body || typeof res.body.getReader !== 'function') {
            const blob = await res.blob();
            d.received = blob.size;
            return blob;
        }
        const reader = res.body.getReader();
        const chunks = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            d.received += value.byteLength;
            try { d.onChunk?.(d.received); } catch { /* progress is cosmetic */ }
        }
        return new Blob(chunks, { type: res.headers.get('Content-Type') || '' });
    })();
    // Claimed or not, a failed download must not surface as an unhandled rejection.
    d.promise.catch(() => {});
    return d;
}

/**
 * Starts the downloads of some texture keys (unknown keys are skipped).
 * @param {string[]} keys
 * @param {typeof fetch} fetchFn
 * @returns {Map<string, ReturnType<typeof download>>} url → download, for createTextureStore({prefetched})
 */
export function prefetchTextures(keys, fetchFn) {
    const out = new Map();
    for (const k of keys) {
        const url = ASSETS[k]?.url;
        if (url && !out.has(url)) out.set(url, download(url, fetchFn));
    }
    return out;
}
