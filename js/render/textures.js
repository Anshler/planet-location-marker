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
 */
export const ASSETS = {
    day4k: { url: 'assets/textures/earth_day_4096.jpg', bytes: 473e3, cs: 'srgb' },
    day2k: { url: 'assets/textures/earth_atmos_2048.jpg', bytes: 513e3, cs: 'srgb' },
    night: { url: 'assets/textures/earth_night_4096.jpg', bytes: 267e3, cs: 'srgb' },
    specular: { url: 'assets/textures/earth_specular_2048.jpg', bytes: 223e3, cs: 'linear' },
    clouds1k: { url: 'assets/textures/earth_clouds_1024.png', bytes: 226e3, cs: 'linear' },
    brc4k: { url: 'assets/textures/earth_bump_roughness_clouds_4096.jpg', bytes: 1434e3, cs: 'linear' },
    moon: { url: 'assets/textures/moon_1024.jpg', bytes: 238e3, cs: 'srgb' },
    flare0: { url: 'assets/textures/lensflare0.png', bytes: 65e3, cs: 'srgb' },
    flare3: { url: 'assets/textures/lensflare3.png', bytes: 3e3, cs: 'srgb' },
    milkyway: { url: 'data/milkyway.png', bytes: 200e3, cs: 'linear', mipmaps: false },
};

/** Placeholder colours (sRGB hex) shown until a key loads; everything else is black. */
const PLACEHOLDER_HEX = {
    day4k: 0x1b3a5c, day2k: 0x1b3a5c, night: 0x000000, specular: 0xffffff, moon: 0x888888,
};

/** Learned from the renderer by createTextureStore; drives the day-map choice on medium. */
let maxTextureSize = 16384;

/**
 * Day-map key for a tier. SPEC risk 4: on medium, devices whose max texture
 * size is under 8192 (older iOS) keep the 2k map to save memory.
 * @param {{name?:string, dayTex?:'day2k'|'day4k'}} cfg TierCfg
 * @returns {'day2k'|'day4k'}
 */
export function dayKeyFor(cfg) {
    const want = cfg?.dayTex === 'day2k' ? 'day2k' : 'day4k';
    if (want === 'day4k' && cfg?.name === 'medium' && maxTextureSize < 8192) return 'day2k';
    return want;
}

/**
 * Ocean-mask key for a tier, or null when the mask is derived from the day map.
 * @param {{oceanMask?:'derived'|'specular'|'roughness'}} cfg
 * @returns {'specular'|'brc4k'|null}
 */
export function maskKeyFor(cfg) {
    if (cfg?.oceanMask === 'specular') return 'specular';
    if (cfg?.oceanMask === 'roughness') return 'brc4k';
    return null;
}

/**
 * Cloud-map key for a tier, or null when the tier has no clouds.
 * @param {{clouds?:'none'|'clouds1k'|'brc4k'}} cfg
 * @returns {'clouds1k'|'brc4k'|null}
 */
export function cloudsKeyFor(cfg) {
    if (cfg?.clouds === 'clouds1k') return 'clouds1k';
    if (cfg?.clouds === 'brc4k') return 'brc4k';
    return null;
}

/**
 * Which keys a tier needs: the day and night maps gate the loader (critical);
 * everything else streams in during idle time (deferred), most visible first.
 * @param {object} cfg TierCfg
 * @returns {{critical:string[], deferred:string[]}}
 */
export function keysForTier(cfg) {
    const deferred = [];
    const mask = maskKeyFor(cfg);
    const clouds = cloudsKeyFor(cfg);
    if (mask) deferred.push(mask);
    if (clouds && clouds !== mask) deferred.push(clouds);
    deferred.push('moon', 'milkyway');
    if (cfg?.flare) deferred.push('flare0', 'flare3');
    return { critical: [dayKeyFor(cfg), 'night'], deferred };
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
 *   restore:()=>void,
 *   dispose:()=>void }}
 */
export function createTextureStore(renderer, { onProgress } = {}) {
    const caps = renderer?.capabilities;
    if (caps?.maxTextureSize) maxTextureSize = caps.maxTextureSize;
    const anisotropy = Math.max(1, Math.min(8, caps?.getMaxAnisotropy?.() ?? 1));
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
        tex.anisotropy = anisotropy;
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
