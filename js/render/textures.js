/**
 * Texture registry and loader (SPEC §C.5, tiers in §E.6).
 *
 * Every consumer asks the store for a key and immediately gets a usable texture:
 * a 1x1 placeholder until the real image arrives, at which point `onReady`
 * listeners swap their uniform to the new Texture object. Textures are never
 * resized or re-pointed in place (three uses immutable texStorage), so a swap
 * is always a new object.
 *
 * Images are streamed with fetch() so the loader can report byte-accurate
 * progress, then decoded with createImageBitmap (flipped at decode time, since
 * WebGL ignores UNPACK_FLIP_Y for bitmaps) or, where bitmap options are not
 * honoured (Safari, Firefox < 98), with an <img> element.
 */
import * as THREE from 'three';

/**
 * Every image the app loads. `bytes` are the on-disk sizes used to weight
 * loader progress; `cs` is the colour space ('srgb' for colour, 'linear' for data).
 *
 * The .webp maps are made from the vendored 4096 maps by scripts/build-textures.mjs
 * (vendor/DERIVED.json): day2k and night2k are those maps at half size, filtered like
 * their own mip 1, and clouds2k and roughness2k are the blue (cloud) and green (water)
 * channels of brc4k as grey, so every tier shows the same planet, water and weather.
 * Every browser that runs the 3D view (it needs import maps) decodes WebP.
 *
 * The max tier's maps (day8k, night8k, clouds8k, moon4k) are loaded by that tier only. They are
 * Solar System Scope's 8192 px originals of the same imagery (clouds8k is their cloud map as
 * clamped grey WebP, moon4k their 8192 px Moon at half size), and while they download and decode
 * the slot shows its 4096 map (INTERIM), so max starts as fast as high and sharpens in place.
 */
export const ASSETS = {
    day8k: { url: 'assets/textures/earth_day_8192.jpg', bytes: 4565e3, cs: 'srgb' },
    night8k: { url: 'assets/textures/earth_night_8192.jpg', bytes: 3144e3, cs: 'srgb' },
    clouds8k: { url: 'assets/textures/earth_clouds_8192.webp', bytes: 4816e3, cs: 'linear' },
    moon4k: { url: 'assets/textures/moon_4096.webp', bytes: 2693e3, cs: 'srgb' },
    day4k: { url: 'assets/textures/earth_day_4096.jpg', bytes: 473e3, cs: 'srgb' },
    day2k: { url: 'assets/textures/earth_day_2048.webp', bytes: 144e3, cs: 'srgb' },
    night4k: { url: 'assets/textures/earth_night_4096.jpg', bytes: 267e3, cs: 'srgb' },
    night2k: { url: 'assets/textures/earth_night_2048.webp', bytes: 75e3, cs: 'srgb' },
    roughness2k: { url: 'assets/textures/earth_roughness_2048.webp', bytes: 56e3, cs: 'linear' },
    clouds2k: { url: 'assets/textures/earth_clouds_2048.webp', bytes: 235e3, cs: 'linear' },
    brc4k: { url: 'assets/textures/earth_bump_roughness_clouds_4096.jpg', bytes: 1508e3, cs: 'linear' },
    moon: { url: 'assets/textures/moon_1024.jpg', bytes: 238e3, cs: 'srgb' },
    flare0: { url: 'assets/textures/lensflare0.png', bytes: 65e3, cs: 'srgb' },
    flare3: { url: 'assets/textures/lensflare3.png', bytes: 3e3, cs: 'srgb' },
    milkyway: { url: 'data/milkyway.png', bytes: 200e3, cs: 'linear', mipmaps: false },
};

/** Placeholder colours (sRGB hex) shown until a key loads; everything else is black. */
const PLACEHOLDER_HEX = {
    day8k: 0x1b3a5c, day4k: 0x1b3a5c, day2k: 0x1b3a5c, moon: 0x888888, moon4k: 0x888888,
};

/**
 * The map a slot shows while its max-tier map loads: the same imagery at 4096 px (clouds8k's is
 * brc4k's blue channel, which the high tier draws).
 */
export const INTERIM = Object.freeze({ day8k: 'day4k', night8k: 'night4k', clouds8k: 'brc4k', moon4k: 'moon' });

/**
 * The stand-in for a key while it loads, or null when the key has none.
 * @param {string|null} key
 * @returns {string|null}
 */
export function interimKeyFor(key) {
    return (key && INTERIM[key]) || null;
}

/** Learned from the renderer by createTextureStore; drives the day-map choice on medium. */
let maxTextureSize = 16384;

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
 * Which keys a tier needs: the day and night maps gate the loader (critical);
 * everything else streams in during idle time (deferred), most visible first.
 * A max-tier map gates nothing: its 4096 stand-in (INTERIM) takes its place in
 * that order, and the max maps themselves come last.
 * @param {object} cfg TierCfg
 * @returns {{critical:string[], deferred:string[]}}
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
    if (cfg?.flare) { push('flare0'); push('flare3'); }
    for (const k of [day, night, clouds, moon]) if (interimKeyFor(k)) push(k);
    return { critical: [stand(day), stand(night)], deferred };
}

/**
 * True where createImageBitmap honours {imageOrientation:'flipY'}. Safari and
 * Firefox < 98 ignore or reject it, which would silently flip the planet, so
 * they decode through <img> (same rule three's GLTFLoader uses).
 */
function bitmapDecodeUsable() {
    if (typeof createImageBitmap !== 'function') return false;
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/^((?!chrome|android).)*safari/i.test(ua)) return false;
    const ff = ua.match(/Firefox\/(\d+)/);
    if (ff && Number(ff[1]) < 98) return false;
    return true;
}

/**
 * Creates the texture store.
 * @param {THREE.WebGLRenderer|null} renderer used for anisotropy, max size and eager upload
 * @param {{onProgress?:(p:{loaded:number,total:number,key?:string,done?:boolean,error?:Error})=>void}} [opts]
 * @returns {{
 *   get:(key:string)=>THREE.Texture,
 *   onReady:(key:string, cb:(tex:THREE.Texture)=>void)=>(()=>void),
 *   load:(keys:string[])=>Promise<void>,
 *   progress:()=>{loaded:number,total:number},
 *   isReady:(key:string)=>boolean,
 *   setAnisotropy:(n?:number)=>void,
 *   restore:()=>void,
 *   dispose:()=>void }}
 */
export function createTextureStore(renderer, { onProgress } = {}) {
    const caps = renderer?.capabilities;
    if (caps?.maxTextureSize) maxTextureSize = caps.maxTextureSize;
    const maxAnisotropy = Math.max(1, caps?.getMaxAnisotropy?.() ?? 1);
    // 8x unless the tier asks for more (max: 16x, or whatever the GPU tops out at).
    let anisotropy = Math.min(8, maxAnisotropy);
    const useBitmap = bitmapDecodeUsable();

    /** @type {Map<string, {state:'idle'|'loading'|'ready'|'failed', tex:THREE.Texture|null,
     *   promise:Promise<void>|null, listeners:Set<Function>, received:number, bytes:number}>} */
    const entries = new Map();
    const placeholders = new Map();
    let disposed = false;

    function entryOf(key) {
        let e = entries.get(key);
        if (!e) {
            e = { state: 'idle', tex: null, promise: null, listeners: new Set(), received: 0, bytes: ASSETS[key]?.bytes ?? 0 };
            entries.set(key, e);
        }
        return e;
    }

    function placeholderFor(key) {
        const hex = PLACEHOLDER_HEX[key] ?? 0x000000;
        const srgb = ASSETS[key]?.cs === 'srgb';
        const id = `${hex}:${srgb}`;
        let tex = placeholders.get(id);
        if (!tex) {
            const data = new Uint8Array([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255]);
            tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
            tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            tex.wrapS = THREE.RepeatWrapping;
            tex.name = `placeholder:${key}`;
            tex.needsUpdate = true;
            placeholders.set(id, tex);
        }
        return tex;
    }

    function progress() {
        let loaded = 0, total = 0;
        for (const e of entries.values()) {
            if (e.state === 'idle') continue;
            total += e.bytes;
            loaded += e.state === 'loading' ? Math.min(e.received, e.bytes) : e.bytes;
        }
        return { loaded, total };
    }

    function emit(extra) {
        if (!onProgress) return;
        try { onProgress({ ...progress(), ...extra }); } catch { /* a UI callback must not break loading */ }
    }

    async function fetchBlob(url, e, key) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        if (!res.body || typeof res.body.getReader !== 'function') {
            const blob = await res.blob();
            e.received = blob.size;
            return blob;
        }
        const reader = res.body.getReader();
        const chunks = [];
        let n = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            n += value.byteLength;
            e.received = n;
            emit({ key });
        }
        return new Blob(chunks, { type: res.headers.get('Content-Type') || '' });
    }

    async function decode(blob) {
        if (useBitmap) {
            try {
                const image = await createImageBitmap(blob, {
                    imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
                });
                return { image, flipY: false };
            } catch { /* options unsupported here: fall through to <img> */ }
        }
        const url = URL.createObjectURL(blob);
        try {
            const img = new Image();
            img.decoding = 'async';
            img.src = url;
            await img.decode();
            return { image: img, flipY: true };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function makeTexture(key, { image, flipY }) {
        const asset = ASSETS[key];
        const tex = new THREE.Texture(image);
        tex.name = key;
        tex.flipY = flipY;
        tex.premultiplyAlpha = false;
        tex.colorSpace = asset.cs === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        // 2:1 maps are equirectangular: wrap in longitude so dateline lookups never clamp.
        const equirect = image.width === 2 * image.height;
        tex.wrapS = equirect ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = asset.mipmaps !== false;
        tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        if (tex.generateMipmaps) tex.anisotropy = anisotropy;
        tex.needsUpdate = true;
        return tex;
    }

    function startLoad(key) {
        const asset = ASSETS[key];
        const e = entryOf(key);
        if (e.promise) return e.promise;
        if (!asset) {
            e.state = 'failed';
            e.promise = Promise.resolve();
            emit({ key, error: new Error(`Unknown texture key "${key}"`) });
            return e.promise;
        }
        e.state = 'loading';
        e.promise = (async () => {
            try {
                const blob = await fetchBlob(asset.url, e, key);
                const decoded = await decode(blob);
                if (disposed) { decoded.image.close?.(); return; }
                const tex = makeTexture(key, decoded);
                try { renderer?.initTexture?.(tex); } catch { /* upload lazily on first use instead */ }
                e.tex = tex;
                e.state = 'ready';
                emit({ key, done: true });
                for (const cb of [...e.listeners]) {
                    try { cb(tex); } catch { /* one bad listener must not starve the others */ }
                }
                e.listeners.clear();
            } catch (err) {
                e.state = 'failed';
                emit({ key, error: err instanceof Error ? err : new Error(String(err)) });
            }
        })();
        emit({ key });
        return e.promise;
    }

    return {
        /** The loaded texture, or the key's placeholder until it is ready. */
        get(key) {
            const e = entries.get(key);
            return e?.state === 'ready' ? e.tex : placeholderFor(key);
        },
        /** Calls cb(tex) when the key is ready (synchronously if it already is). Returns off(). */
        onReady(key, cb) {
            const e = entryOf(key);
            if (e.state === 'ready') {
                try { cb(e.tex); } catch { /* caller's problem, but never ours to throw */ }
                return () => {};
            }
            e.listeners.add(cb);
            return () => e.listeners.delete(cb);
        },
        /** Starts loading keys not yet requested; resolves when all have settled. Never rejects. */
        load(keys) {
            const list = Array.isArray(keys) ? keys : [];
            return Promise.all(list.map(startLoad)).then(() => undefined, () => undefined);
        },
        /** Byte-weighted progress over every key requested so far. */
        progress,
        /** True once the key's real texture is available. */
        isReady(key) {
            return entries.get(key)?.state === 'ready';
        },
        /**
         * Sets the anisotropic filtering of every mipmapped map (TierCfg.anisotropy; absent = 8x),
         * clamped to the GPU's limit. A change re-uploads the loaded maps: tier changes only.
         * @param {number} [n]
         */
        setAnisotropy(n) {
            const next = Math.max(1, Math.min(maxAnisotropy, Number.isFinite(n) && n > 0 ? n : 8));
            if (next === anisotropy) return;
            anisotropy = next;
            for (const e of entries.values()) {
                if (!e.tex || !e.tex.generateMipmaps) continue;
                e.tex.anisotropy = next;
                e.tex.needsUpdate = true;
            }
        },
        /** After a WebGL context restore: re-upload every loaded texture from its retained image. */
        restore() {
            for (const e of entries.values()) if (e.tex) e.tex.needsUpdate = true;
            for (const t of placeholders.values()) t.needsUpdate = true;
        },
        /** Frees GPU and decoded-image memory. The store is unusable afterwards. */
        dispose() {
            disposed = true;
            for (const e of entries.values()) {
                if (e.tex) {
                    e.tex.dispose();
                    e.tex.image?.close?.();
                }
                e.listeners.clear();
            }
            for (const t of placeholders.values()) t.dispose();
            entries.clear();
            placeholders.clear();
        },
    };
}
