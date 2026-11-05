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
 *
 * Memory: a decoded ImageBitmap is closed once its map is on the GPU (4096 × 2048 is 33.5 MB of
 * RAM, 8192 × 4096 134 MB), except a map marked ASSETS `keep` (the ocean masks, whose pixels
 * render/ground.js reads, and the two 512 px previews). The GPU copy is the only one then: a context restore or a new
 * anisotropy fetches the file again (from the HTTP or service-worker cache) and decodes it into the
 * same Texture before it is uploaded. An <img> (Safari) cannot be closed and stays.
 */
import * as THREE from 'three';
import {
    ASSETS, INTERIM, PREVIEW, interimKeyFor, previewKeyFor, setMaxTextureSize, dayKeyFor, nightKeyFor, moonKeyFor,
    maskKeyFor, cloudsKeyFor, keysForTier, download,
} from '../core/texture-plan.js';

// The plan (which keys each tier loads, and their URLs) is pure: js/core/texture-plan.js.
export {
    ASSETS, INTERIM, PREVIEW, interimKeyFor, previewKeyFor, dayKeyFor, nightKeyFor, moonKeyFor, maskKeyFor, cloudsKeyFor,
    keysForTier,
};

/** Placeholder colours (sRGB hex) shown until a key loads; everything else is black. */
const PLACEHOLDER_HEX = {
    day8k: 0x1b3a5c, day4k: 0x1b3a5c, day2k: 0x1b3a5c, dayPreview: 0x1b3a5c, moon: 0x888888, moon4k: 0x888888,
};

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

/** How long a restore waits for one closed map's file before it takes the 1 × 1 stand-in (ms). */
const RESTORE_WAIT_MS = 15000;

/** A closed ImageBitmap (its width and height read 0): its pixels are on the GPU only. */
const isClosed = (img) => !!img && typeof img.close === 'function' && !(img.width > 0);

/** The next task after the next animation frame (the frame is submitted by then); a task in Node. */
function afterFrame() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
        else setTimeout(resolve, 0);
    });
}

/**
 * Creates the texture store.
 *
 * `prefetched` (core/texture-plan.js prefetchTextures) holds downloads main.js started before the
 * render stack existed; a key whose URL is there takes that download over (once) instead of
 * fetching again, and its progress counts the bytes already in.
 *
 * Eager upload: a decoded map is uploaded at once (renderer.initTexture), out of the render frame,
 * except while `holdUploads(p)` holds them: from the start of rc.compile() until it settles and
 * one frame is out. An upload issued while the GPU process links the boot shaders waits for that
 * work on the main thread (≈ 360 ms measured on a desktop GPU); afterwards it takes a few ms. A
 * held map is still ready and bound: a frame drawn meanwhile uploads it itself. A tier switch
 * holds with `{bind: false}` instead: a map decoded meanwhile becomes ready (onReady) only once it
 * is on the GPU, so the first frame of the new tier never uploads one. The held uploads then go
 * out one per task, each after a frame, the re-uploads of maps already bound (setAnisotropy)
 * first: holdUploads' promise resolves once those are out, and the new maps follow.
 *
 * Previews: get(key) of a day or night map returns its 512 px preview (PREVIEW) while the map
 * loads, once the preview is in (state 'preview'); onReady(key) still fires for the map itself.
 * @param {THREE.WebGLRenderer|null} renderer used for anisotropy, max size and eager upload
 * @param {{onProgress?:(p:{loaded:number,total:number,key?:string,done?:boolean,error?:Error})=>void,
 *   prefetched?:Map<string, ReturnType<typeof download>>|null}} [opts]
 * @returns {{
 *   get:(key:string)=>THREE.Texture,
 *   onReady:(key:string, cb:(tex:THREE.Texture)=>void)=>(()=>void),
 *   load:(keys:string[])=>Promise<void>,
 *   progress:()=>{loaded:number,total:number},
 *   isReady:(key:string)=>boolean,
 *   state:(key:string)=>'idle'|'loading'|'preview'|'ready'|'failed',
 *   holdUploads:(until:Promise<unknown>, opts?:{bind?:boolean})=>Promise<void>,
 *   setAnisotropy:(n?:number, keys?:string[])=>void,
 *   restore:(keep?:Iterable<string>)=>Promise<void>,
 *   dispose:()=>void }}
 */
export function createTextureStore(renderer, { onProgress, prefetched = null } = {}) {
    const caps = renderer?.capabilities;
    if (caps?.maxTextureSize) setMaxTextureSize(caps.maxTextureSize);
    const maxAnisotropy = Math.max(1, caps?.getMaxAnisotropy?.() ?? 1);
    // 8x unless the tier asks for more (max: 16x, or whatever the GPU tops out at).
    let anisotropy = Math.min(8, maxAnisotropy);
    const useBitmap = bitmapDecodeUsable();

    /** @type {Map<string, {key:string, state:'idle'|'loading'|'ready'|'failed', tex:THREE.Texture|null,
     *   promise:Promise<void>|null, listeners:Set<Function>, received:number, bytes:number,
     *   reloading:Promise<void>|null}>} */
    const entries = new Map();
    const placeholders = new Map();
    let disposed = false;
    /** While uploads are held (holdUploads): the textures decoded or changed meanwhile, uploaded afterwards. */
    let gate = null;
    /** The gate's `bind` option: false keeps a map decoded meanwhile unready until its upload. */
    let gateBinds = true;
    /** @type {{tex:THREE.Texture, done:(()=>void)|null, bound?:boolean, bump?:boolean}[]} */
    const held = [];
    /** @type {Promise<void>|null} */
    let flushing = null;

    const glLost = () => {
        try { return !!renderer?.getContext?.()?.isContextLost?.(); } catch { return false; }
    };

    /**
     * Uploads one map now (renderer.initTexture; `bump`: as a new version, for an image just put
     * back), then closes its decoded bitmap in a later task, once its onReady listeners have read
     * it: not a map the CPU reads, nor one uploaded into a lost context (nothing reached a GPU).
     */
    function initTexture(tex, bump = false) {
        if (bump) tex.needsUpdate = true;
        try { renderer?.initTexture?.(tex); } catch { return; /* upload lazily on first use instead */ }
        if (!renderer || ASSETS[tex.name]?.keep || glLost()) return;
        setTimeout(() => {
            const img = tex.image;
            if (!disposed && !isClosed(img) && typeof img?.close === 'function' && !glLost()) img.close();
        }, 0);
    }

    /** Uploads now, or after the gate; `done` runs once the texture is on the GPU. */
    function upload(tex, done = null, bump = false) {
        if (gate) { held.push({ tex, done, bump }); return; }
        initTexture(tex, bump);
        done?.();
    }

    /**
     * Puts a closed map's pixels back: the file again (HTTP or service-worker cache), decoded into
     * the same Texture (same size, so the GPU storage fits) and uploaded. `restore`: after a context
     * loss, when the next frame would upload the closed image itself (and throw); if the file cannot
     * be had within RESTORE_WAIT_MS, its preview's image (day and night maps) or a 1 × 1 pixel of its
     * placeholder colour takes its place: the restored context allocates the GPU storage afresh, at
     * the stand-in's size, so it uploads cleanly.
     * @returns {Promise<void>} never rejects
     */
    function reload(e, restore = false) {
        if (e.reloading) return e.reloading;
        const p = (async () => {
            let got = null;
            try {
                got = download(ASSETS[e.key].url, fetch).promise.then(decode);
                let timer = 0;
                const decoded = !restore ? await got : await Promise.race([got, new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${ASSETS[e.key].url} timed out`)), RESTORE_WAIT_MS);
                })]).finally(() => clearTimeout(timer));
                if (disposed || !e.tex) { decoded.image.close?.(); return; }
                e.tex.image = decoded.image;
                e.tex.flipY = decoded.flipY;
                await new Promise((resolve) => upload(e.tex, resolve, true));
            } catch (err) {
                if (!restore || !e.tex || !isClosed(e.tex.image)) return;
                // A late arrival is no use any more: the stand-in sets the GPU storage's size.
                got?.then((d) => d.image.close?.(), () => {});
                const pv = entries.get(previewKeyFor(e.key))?.tex;
                if (pv?.image && !isClosed(pv.image)) {
                    e.tex.image = pv.image;
                    e.tex.flipY = pv.flipY;
                } else {
                    e.tex.image = standInPixel(e.key);
                }
                e.tex.needsUpdate = true;
                e.state = 'failed';
                emit({ key: e.key, error: err instanceof Error ? err : new Error(String(err)) });
            }
        })();
        e.reloading = p;
        return p.finally(() => { if (e.reloading === p) e.reloading = null; });
    }

    /** A 1 × 1 image of the key's placeholder colour, for a Texture whose decoded image is closed. */
    function standInPixel(key) {
        const hex = PLACEHOLDER_HEX[key] ?? 0;
        const px = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];
        return typeof ImageData === 'function' ? new ImageData(new Uint8ClampedArray(px), 1, 1) : { width: 1, height: 1 };
    }

    /**
     * Forgets a closed map that a context restore does not bring back (another tier's): its GPU copy
     * died with the context, so there is nothing to dispose. Its Texture takes the 1 × 1 stand-in, so
     * a material that still holds it draws the placeholder colour, never a closed image; a later
     * load() fetches the file afresh and fires onReady with a new Texture.
     */
    function drop(e) {
        e.tex.image = standInPixel(e.key);
        e.tex.flipY = false;
        e.tex.needsUpdate = true;
        e.tex = null;
        e.state = 'idle';
        e.promise = null;
        e.received = 0;
    }

    /** One held upload per task, each after a frame, so two large maps never share a long task. */
    function flushHeld() {
        flushing ??= (async () => {
            while (held.length && !gate && !disposed) {
                const h = held.shift();
                initTexture(h.tex, h.bump);
                h.done?.();
                if (held.length) await afterFrame();
            }
        })().finally(() => { flushing = null; });
        return flushing;
    }

    function entryOf(key) {
        let e = entries.get(key);
        if (!e) {
            e = { key, state: 'idle', tex: null, promise: null, listeners: new Set(), received: 0, bytes: ASSETS[key]?.bytes ?? 0, reloading: null };
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

    /** The key's image as a Blob: the prefetched download of its URL, or a new one. */
    function fetchBlob(url, e, key) {
        const dl = prefetched?.get(url) ?? download(url, fetch);
        prefetched?.delete(url);
        e.received = dl.received;
        dl.onChunk = (n) => {
            e.received = n;
            emit({ key });
        };
        return dl.promise;
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
                // A tier switch's hold: bound once on the GPU, so no frame uploads it.
                if (gate && !gateBinds) await new Promise((resolve) => upload(tex, resolve));
                else upload(tex);
                if (disposed) return;
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
        /** The loaded texture, else its preview once that is in (day and night maps), else the key's placeholder. */
        get(key) {
            const e = entries.get(key);
            if (e?.state === 'ready') return e.tex;
            const p = entries.get(previewKeyFor(key));
            return p?.state === 'ready' ? p.tex : placeholderFor(key);
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
        /** 'preview' while a day or night map loads (or failed) and get() returns its preview. */
        state(key) {
            const st = entries.get(key)?.state ?? 'idle';
            return st !== 'ready' && entries.get(previewKeyFor(key))?.state === 'ready' ? 'preview' : st;
        },
        /**
         * Holds eager uploads until `until` settles and one more frame is out (rc.compile() at boot,
         * a tier switch's compile). `bind: false` (tier switches): a map decoded meanwhile stays
         * unready until its upload. Resolves once the held uploads of maps already bound are out
         * (they go first: a frame would upload one itself), or at once when a newer hold takes
         * over (that one uploads them). The new maps follow, one per task.
         * @param {Promise<unknown>} until
         * @param {{bind?:boolean}} [opts]
         * @returns {Promise<void>}
         */
        holdUploads(until, { bind = true } = {}) {
            const g = Promise.resolve(until).then(() => {}, () => {}).then(afterFrame).then(() => {
                if (gate !== g) return undefined;
                gate = null;
                const bound = [];
                for (const h of held) {
                    if (h.done) continue;
                    h.bound = true;
                    bound.push(new Promise((resolve) => { h.done = resolve; }));
                }
                held.sort((a, b) => (b.bound ? 1 : 0) - (a.bound ? 1 : 0));
                flushHeld();
                return Promise.all(bound).then(() => {});
            });
            gate = g;
            gateBinds = bind !== false;
            return g;
        },
        /**
         * Sets the anisotropic filtering of the mipmapped maps (TierCfg.anisotropy; absent = 8x),
         * clamped to the GPU's limit: every loaded map, or only `keys` (the new tier's). A change
         * re-uploads the map (three sets sampler state on upload), through the hold if one is on:
         * tier changes only. A map left out keeps its filtering until a tier that uses it sets it.
         * @param {number} [n]
         * @param {string[]} [keys]
         */
        setAnisotropy(n, keys) {
            const next = Math.max(1, Math.min(maxAnisotropy, Number.isFinite(n) && n > 0 ? n : 8));
            anisotropy = next;
            const list = Array.isArray(keys) ? keys.map((k) => entries.get(k)) : entries.values();
            for (const e of list) {
                if (!e?.tex || !e.tex.generateMipmaps || e.tex.anisotropy === next) continue;
                e.tex.anisotropy = next;
                // A closed map is fetched and decoded again first; it keeps its filtering meanwhile.
                if (isClosed(e.tex.image)) { reload(e); continue; }
                e.tex.needsUpdate = true;
                upload(e.tex);
            }
            // Maps held unready (decoded during a hold) are uploaded anyway: just the new value.
            for (const h of held) {
                if (h.done && h.tex.generateMipmaps && (!Array.isArray(keys) || keys.includes(h.tex.name))) h.tex.anisotropy = next;
            }
        },
        /**
         * After a WebGL context restore: every loaded map goes back on the GPU, a kept image at its
         * first draw, a closed one fetched and decoded again first, one at a time (the loss was
         * likely memory pressure). Resolves once those are uploaded; nothing may draw before (a
         * frame would upload a closed image), so main.js holds the restore on it. `keep`: the keys
         * the current tier draws (keysForTier); a closed map outside it (a tier left behind, such
         * as max's 8192 px maps after a step down) is dropped instead of fetched and uploaded.
         * @param {Iterable<string>} [keep] every key when absent
         * @returns {Promise<void>} never rejects
         */
        restore(keep) {
            for (const t of placeholders.values()) t.needsUpdate = true;
            const wanted = keep ? new Set(keep) : null;
            let chain = Promise.resolve();
            for (const e of entries.values()) {
                if (!e.tex) continue;
                if (!isClosed(e.tex.image)) e.tex.needsUpdate = true;
                else if (wanted && !wanted.has(e.key)) drop(e);
                else chain = chain.then(() => reload(e, true));
            }
            return chain;
        },
        /** Frees GPU and decoded-image memory. The store is unusable afterwards. */
        dispose() {
            disposed = true;
            for (const h of held) h.done?.();
            held.length = 0;
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
