#!/usr/bin/env node
// Derived textures: smaller or single-channel re-encodes of the vendored maps (zero npm deps).
//
//   node scripts/build-textures.mjs            rebuild every derived texture and vendor/DERIVED.json
//                                               (needs Chrome or Edge; CHROME_PATH overrides the search)
//   node scripts/build-textures.mjs --only=8192,moon_4096   rebuild only outputs whose path contains one
//                                               of those strings; the other lock entries are kept
//   node scripts/build-textures.mjs --check    offline: every output matches vendor/DERIVED.json, and
//                                               its source and recipe are the ones it was built from
//
// The vendored maps (vendor/VENDOR.json) keep their upstream bytes and hashes, so
// `fetch-vendor --check` keeps proving they are the pinned files. Everything made from them is
// listed in vendor/DERIVED.json instead: {path, from, fromSha256, recipe, sha256, bytes, license,
// encoder}. --check compares hashes only and never re-encodes, because the JPEG encoder's output
// differs between browser versions; CI runs it, and a rebuild is a deliberate, reviewed change.
//
// Pipeline, per recipe, inside headless Chrome (scripts/lib/chrome.mjs):
//   1. decode the source with createImageBitmap({colorSpaceConversion:'none'}), exactly as
//      js/render/textures.js decodes it in the app;
//   2. shrink by an integer factor with a box filter: colour maps are averaged in linear light,
//      data maps on their raw values. That is what the GPU's own mipmap chain does, so a 2048
//      map looks like mip 1 of the 4096 one and the tiers stay colour-matched;
//   3. optionally keep one channel as grey (cloud density and roughness, from the blue and
//      green channels of the bump/roughness/clouds map), clamped to the window over which the
//      shader's smoothstep actually varies: values outside it read the same, and flat areas
//      cost almost nothing to store;
//   4. encode with the canvas encoder (OffscreenCanvas.convertToBlob, JPEG or WebP).
//
// Lossy WebP is about 40 % smaller than JPEG at the same PSNR on these maps (measured: the
// 2048 day map is 144 KB at q0.8 against 243 KB for JPEG q0.85, and still closer to the
// unencoded image). Every browser that runs the 3D view decodes it: the view needs import maps
// (Safari 16.4, Firefox 108, Chrome 89), and WebP decoding is older in all of them.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome, CdpClient } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DERIVED_LOCK = 'vendor/DERIVED.json';
const VENDOR_LOCK = 'vendor/VENDOR.json';

/**
 * What is built, in the order written to vendor/DERIVED.json.
 *   colour: 'srgb' averages in linear light (colour maps), 'data' averages raw values;
 *   channel: 'rgb' keeps colour, 'r' | 'g' | 'b' writes that channel as grey;
 *   clamp: [lo, hi] limits of the grey values (optional, grey output only).
 * @type {{path:string, from:string, recipe:{size:[number,number], colour:'srgb'|'data',
 *   channel:'rgb'|'r'|'g'|'b', clamp?:[number,number], type:'image/jpeg'|'image/webp', quality:number}}[]}
 */
export const RECIPES = [
    // Low tier (and medium on GPUs under 8192 px): the 4096 day map at half size.
    {
        path: 'assets/textures/earth_day_2048.webp', from: 'assets/textures/earth_day_4096.jpg',
        recipe: { size: [2048, 1024], colour: 'srgb', channel: 'rgb', type: 'image/webp', quality: 0.8 },
    },
    // Its night-lights partner, so low no longer loads (and keeps in VRAM) a 4096 map.
    {
        path: 'assets/textures/earth_night_2048.webp', from: 'assets/textures/earth_night_4096.jpg',
        recipe: { size: [2048, 1024], colour: 'srgb', channel: 'rgb', type: 'image/webp', quality: 0.8 },
    },
    // Medium-tier clouds: the high tier's own cloud field (brc4k blue), so both show the same
    // weather. Density is smoothstep(0.2, 1, v), so everything under 0.2 is clear sky either
    // way (about half the map); flattening it there saves about a fifth of the bytes.
    {
        path: 'assets/textures/earth_clouds_2048.webp', from: 'assets/textures/earth_bump_roughness_clouds_4096.jpg',
        recipe: { size: [2048, 1024], colour: 'data', channel: 'b', clamp: [0.2, 1], type: 'image/webp', quality: 0.7 },
    },
    // Low- and medium-tier water mask: the high tier's own (brc4k green, roughness), read as
    // 1 - smoothstep(0.25, 0.45, v). Clamped to that window it is almost flat: 57 KB.
    {
        path: 'assets/textures/earth_roughness_2048.webp', from: 'assets/textures/earth_bump_roughness_clouds_4096.jpg',
        recipe: { size: [2048, 1024], colour: 'data', channel: 'g', clamp: [0.25, 0.45], type: 'image/webp', quality: 0.9 },
    },
    // Previews (every tier): the day and night maps at 512 px, about 18 KB together. They arrive with
    // the first bytes of the page, so the globe is a recognisable, lit Earth in its first frame and
    // sharpens into the tier's maps (render/earth.js uSharpen) instead of showing a flat blue ball.
    {
        path: 'assets/textures/earth_day_preview.webp', from: 'assets/textures/earth_day_4096.jpg',
        recipe: { size: [512, 256], colour: 'srgb', channel: 'rgb', type: 'image/webp', quality: 0.7 },
    },
    {
        path: 'assets/textures/earth_night_preview.webp', from: 'assets/textures/earth_night_4096.jpg',
        recipe: { size: [512, 256], colour: 'srgb', channel: 'rgb', type: 'image/webp', quality: 0.7 },
    },
    // Max-tier clouds: Solar System Scope's 8192 cloud map (the field brc4k.b was made from), grey,
    // clamped to the same density window. As a 3-channel JPEG it is 11.6 MB.
    {
        path: 'assets/textures/earth_clouds_8192.webp', from: 'data/raw/textures/8k_earth_clouds.jpg',
        recipe: { size: [8192, 4096], colour: 'data', channel: 'r', clamp: [0.2, 1], type: 'image/webp', quality: 0.8 },
    },
    // Max-tier Moon: the 8192 map at half size. 4096 px puts ~2000 texels across the disc, more
    // than the screen shows at the narrowest sky-view field (5 deg); 8192 would only add bytes.
    {
        path: 'assets/textures/moon_4096.webp', from: 'data/raw/textures/8k_moon.jpg',
        recipe: { size: [4096, 2048], colour: 'srgb', channel: 'rgb', type: 'image/webp', quality: 0.85 },
    },
];

/** Sources that are gitignored downloads (fetch-vendor `cache` entries): --check skips them when absent. */
const isCachedSource = (rel) => rel.startsWith('data/raw/textures/');

/** @param {Buffer} buf @returns {string} hex sha256 */
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const abs = (rel, root = ROOT) => path.join(root, rel);
const readOrNull = (rel, root = ROOT) => (fs.existsSync(abs(rel, root)) ? fs.readFileSync(abs(rel, root)) : null);

/**
 * Reads a lock file (a JSON array of entries with a `path`) → Map(path → entry); empty when absent.
 * @param {string} rel @param {string} [root]
 */
export function readLockFile(rel, root = ROOT) {
    try {
        return new Map(JSON.parse(fs.readFileSync(abs(rel, root), 'utf8')).map((e) => [e.path, e]));
    } catch {
        return new Map();
    }
}

/**
 * Pixel size from a WebP (VP8, VP8L, VP8X) or baseline/progressive JPEG header.
 * @param {Buffer} buf
 * @returns {{type:'image/webp'|'image/jpeg', width:number, height:number}|null}
 */
export function imageSize(buf) {
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        const chunk = buf.toString('latin1', 12, 16);
        if (chunk === 'VP8 ') return { type: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (chunk === 'VP8L') {
            const b = buf.readUInt32LE(21);
            return { type: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X') return { type: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
        return null;
    }
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    for (let i = 2; i + 9 < buf.length && buf[i] === 0xff;) {
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xc3) return { type: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}

/** One entry per line: readable diffs, still valid JSON (same layout as vendor/VENDOR.json). */
function serializeLock(entries) {
    return `[\n${entries.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`;
}

/**
 * Offline verification (no browser): outputs present with the locked size and hash, built
 * from the current source bytes with the current recipe, and nothing stale in the lock.
 * @param {string} [root] repository root (tests point it at a copy)
 * @returns {string[]} problems (empty when everything is up to date)
 */
export function checkDerived(root = ROOT) {
    const problems = [];
    const lock = readLockFile(DERIVED_LOCK, root);
    if (!lock.size) return [`${DERIVED_LOCK} is missing or empty`];
    const rebuild = 'run: node scripts/build-textures.mjs';
    for (const r of RECIPES) {
        const e = lock.get(r.path);
        if (!e) {
            problems.push(`${r.path}: not in ${DERIVED_LOCK} (${rebuild})`);
            continue;
        }
        if (e.from !== r.from || JSON.stringify(e.recipe) !== JSON.stringify(r.recipe)) {
            problems.push(`${r.path}: recipe changed since it was built (${rebuild})`);
        }
        const src = readOrNull(r.from, root);
        if (!src) {
            // A cached 8192 source (gitignored) proves itself through its pinned hash in
            // VENDOR.json when it is fetched; here the output's own hash is the check.
            if (!isCachedSource(r.from)) problems.push(`${r.path}: source ${r.from} is missing`);
        } else if (sha256(src) !== e.fromSha256) problems.push(`${r.path}: source ${r.from} changed since it was built (${rebuild})`);
        const out = readOrNull(r.path, root);
        if (!out) {
            problems.push(`missing ${r.path} (${rebuild})`);
            continue;
        }
        if (out.length !== e.bytes || sha256(out) !== e.sha256) problems.push(`${r.path} does not match ${DERIVED_LOCK}`);
        const dim = imageSize(out);
        if (dim?.type !== r.recipe.type || dim.width !== r.recipe.size[0] || dim.height !== r.recipe.size[1]) {
            problems.push(`${r.path} is not a ${r.recipe.size.join('×')} ${r.recipe.type}`);
        }
    }
    const known = new Set(RECIPES.map((r) => r.path));
    for (const p of lock.keys()) if (!known.has(p)) problems.push(`${DERIVED_LOCK} lists ${p}, which no recipe builds`);
    const order = [...lock.keys()].filter((p) => known.has(p));
    if (!problems.length && order.join() !== RECIPES.map((r) => r.path).join()) problems.push(`${DERIVED_LOCK} is out of order (${rebuild})`);
    return problems;
}

/**
 * Page-side worker, evaluated in headless Chrome: decode, box-filter, pick a channel, encode.
 * Serialised with Function.prototype.toString, so it must be self-contained.
 * @param {{b64:string, w:number, h:number, colour:string, channel:string, clamp?:[number,number], type:string, quality:number}} job
 */
async function pageTransform({ b64, w, h, colour, channel, clamp = [0, 1], type, quality }) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const sw = bmp.width, sh = bmp.height;
    const fx = sw / w, fy = sh / h;
    if (!Number.isInteger(fx) || !Number.isInteger(fy) || fx < 1 || fy < 1) {
        throw new Error(`${sw}x${sh} does not shrink to ${w}x${h} by an integer factor`);
    }
    const srcCtx = new OffscreenCanvas(sw, sh).getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(bmp, 0, 0);
    bmp.close();
    const s = srcCtx.getImageData(0, 0, sw, sh).data;

    // sRGB transfer functions (IEC 61966-2-1).
    const toLin = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        toLin[i] = colour === 'srgb' ? (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) : c;
    }
    const encode = (v) => {
        const c = colour === 'srgb' ? (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) : v;
        return Math.max(0, Math.min(255, Math.round(c * 255)));
    };
    const grey = { r: 0, g: 1, b: 2 }[channel];
    const lo = Math.round(clamp[0] * 255), hi = Math.round(clamp[1] * 255);
    const n = fx * fy;
    const out = new ImageData(w, h);
    const d = out.data;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0;
            for (let j = 0; j < fy; j++) {
                let k = ((y * fy + j) * sw + x * fx) * 4;
                for (let i = 0; i < fx; i++, k += 4) {
                    r += toLin[s[k]];
                    g += toLin[s[k + 1]];
                    b += toLin[s[k + 2]];
                }
            }
            const o = (y * w + x) * 4;
            if (grey === undefined) {
                d[o] = encode(r / n);
                d[o + 1] = encode(g / n);
                d[o + 2] = encode(b / n);
            } else {
                const v = encode((grey === 0 ? r : grey === 1 ? g : b) / n);
                d[o] = d[o + 1] = d[o + 2] = Math.min(hi, Math.max(lo, v));
            }
            d[o + 3] = 255;
        }
    }
    const dst = new OffscreenCanvas(w, h);
    dst.getContext('2d').putImageData(out, 0, 0);
    const blob = await dst.convertToBlob({ type, quality });
    if (blob.type !== type) throw new Error(`this browser cannot encode ${type} (got ${blob.type || 'nothing'})`);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s64 = '';
    for (let i = 0; i < buf.length; i += 0x8000) s64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { b64: btoa(s64), srcW: sw, srcH: sh };
}

async function build() {
    const exe = findChrome();
    if (!exe) throw new Error('no Chrome/Edge found (set CHROME_PATH)');
    const vendor = readLockFile(VENDOR_LOCK);
    const chrome = await launchChrome({ executable: exe, width: 800, height: 600 });
    let cdp = null;
    try {
        cdp = await CdpClient.connect(chrome.wsUrl);
        const { product } = await cdp.send('Browser.getVersion');
        const { targetInfos } = await cdp.send('Target.getTargets');
        let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
        if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const evaluate = async (expression) => {
            const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
            return r.result.value;
        };

        const entries = [];
        // --only=a,b rebuilds the recipes whose output path contains one of those strings and
        // keeps every other lock entry as it is (a new map need not re-encode the old ones).
        const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean) ?? null;
        const prev = readLockFile(DERIVED_LOCK);
        for (const r of RECIPES) {
            if (only && !only.some((s) => r.path.includes(s))) {
                const kept = prev.get(r.path);
                if (!kept) throw new Error(`${r.path} has no lock entry to keep (include it in --only)`);
                entries.push(kept);
                continue;
            }
            const src = readOrNull(r.from);
            if (!src) throw new Error(`source ${r.from} is missing (run: node scripts/fetch-vendor.mjs)`);
            const pinned = vendor.get(r.from)?.sha256;
            if (pinned && sha256(src) !== pinned) throw new Error(`source ${r.from} does not match vendor/VENDOR.json`);
            const t0 = performance.now();
            const job = { b64: src.toString('base64'), w: r.recipe.size[0], h: r.recipe.size[1], ...r.recipe };
            delete job.size;
            const res = await evaluate(`(${pageTransform.toString()})(${JSON.stringify(job)})`);
            const out = Buffer.from(res.b64, 'base64');
            fs.writeFileSync(abs(r.path), out);
            entries.push({
                path: r.path, from: r.from, fromSha256: sha256(src), recipe: r.recipe,
                sha256: sha256(out), bytes: out.length,
                license: vendor.get(r.from)?.license ?? 'see THIRD_PARTY_NOTICES.md', encoder: product,
            });
            console.log(`${r.path}  ${res.srcW}×${res.srcH} → ${r.recipe.size.join('×')}  `
                + `${(src.length / 1e3).toFixed(0)} KB → ${(out.length / 1e3).toFixed(0)} KB  (${((performance.now() - t0) / 1e3).toFixed(1)} s)`);
        }
        fs.writeFileSync(abs(DERIVED_LOCK), serializeLock(entries));
        console.log(`${DERIVED_LOCK}: ${entries.length} files, ${product}`);
    } finally {
        try {
            if (cdp) await Promise.race([cdp.send('Browser.close').catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
        } catch { /* already gone */ }
        cdp?.close();
        await chrome.kill();
    }
}

async function main() {
    if (process.argv.includes('--check')) {
        const problems = checkDerived();
        if (problems.length) {
            console.error(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
            process.exit(1);
        }
        console.log(`derived textures OK: ${RECIPES.length} files match ${DERIVED_LOCK}`);
        return;
    }
    await build();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (err) {
        console.error(`build-textures: ${err.message}`);
        process.exit(1);
    }
}
