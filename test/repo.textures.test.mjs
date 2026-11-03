// Derived textures (scripts/build-textures.mjs, vendor/DERIVED.json) and the texture choices that
// keep every quality tier showing the same planet: the same imagery, water and weather.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RECIPES, DERIVED_LOCK, checkDerived, imageSize, readLockFile } from '../scripts/build-textures.mjs';
import { readAssets, tierTextureKeys } from '../scripts/check-size.mjs';
import { TIERS, tierConfig } from '../js/core/quality.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = readLockFile('vendor/VENDOR.json');
const DERIVED = readLockFile(DERIVED_LOCK);
const { assets: ASSET_URLS } = readAssets();
const recipeFor = (key) => RECIPES.find((r) => r.path === ASSET_URLS[key]);
const stripComments = (g) => g.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('derived textures match vendor/DERIVED.json (build-textures --check)', () => {
    assert.deepEqual(checkDerived(), []);
});

test('derived textures come from vendored files, keep their licence and are not vendored themselves', () => {
    assert.equal(DERIVED.size, RECIPES.length);
    for (const r of RECIPES) {
        assert.match(r.path, /^assets\/textures\/[\w.-]+$/);
        assert.ok(VENDOR.has(r.from), `${r.from} is vendored`);
        assert.ok(!VENDOR.has(r.path), `${r.path} must not carry an upstream hash in VENDOR.json`);
        assert.equal(DERIVED.get(r.path).license, VENDOR.get(r.from).license, `${r.path} licence`);
    }
});

test('checkDerived reports a changed output, source or recipe, and a missing file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-textures-'));
    const files = [DERIVED_LOCK, ...new Set(RECIPES.flatMap((r) => [r.from, r.path]))];
    for (const f of files) {
        if (!fs.existsSync(path.join(ROOT, f)) && VENDOR.get(f)?.cache) continue;   // gitignored 8192 source, not fetched
        fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    }
    const at = (f) => path.join(tmp, f);
    const flipLastByte = (f) => {
        const b = fs.readFileSync(at(f));
        b[b.length - 1] ^= 0xff;
        fs.writeFileSync(at(f), b);
    };
    try {
        assert.deepEqual(checkDerived(tmp), [], 'a faithful copy passes');
        const r = RECIPES[0];

        flipLastByte(r.path);
        assert.match(checkDerived(tmp).join('\n'), new RegExp(`${r.path} does not match`));
        flipLastByte(r.path);

        flipLastByte(r.from);
        assert.match(checkDerived(tmp).join('\n'), /source .* changed since it was built/);
        flipLastByte(r.from);

        const lock = fs.readFileSync(at(DERIVED_LOCK), 'utf8');
        fs.writeFileSync(at(DERIVED_LOCK), lock.replace(/"quality":([\d.]+)/, (m, q) => `"quality":${Number(q) / 2}`));
        assert.match(checkDerived(tmp).join('\n'), /recipe changed since it was built/);
        fs.writeFileSync(at(DERIVED_LOCK), lock);

        fs.rmSync(at(r.path));
        assert.match(checkDerived(tmp).join('\n'), new RegExp(`missing ${r.path}`));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('a cached 8192 source may be absent (CI), but a present one must match', () => {
    const r = RECIPES.find((x) => VENDOR.get(x.from)?.cache);
    assert.ok(r, 'the max tier has a derived map from a cached source');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-textures-'));
    try {
        for (const f of [DERIVED_LOCK, ...RECIPES.flatMap((x) => [x.from, x.path])]) {
            if (VENDOR.get(f)?.cache || !fs.existsSync(path.join(ROOT, f))) continue;
            fs.mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true });
            fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
        }
        assert.deepEqual(checkDerived(tmp), [], 'absent cached sources are not problems');
        fs.mkdirSync(path.join(tmp, path.dirname(r.from)), { recursive: true });
        fs.writeFileSync(path.join(tmp, r.from), 'not the pinned file');
        assert.match(checkDerived(tmp).join('\n'), /source .* changed since it was built/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('imageSize reads JPEG and WebP headers', () => {
    assert.deepEqual(imageSize(fs.readFileSync(path.join(ROOT, 'assets/textures/earth_day_4096.jpg'))),
        { type: 'image/jpeg', width: 4096, height: 2048 });
    for (const r of RECIPES) {
        assert.deepEqual(imageSize(fs.readFileSync(path.join(ROOT, r.path))),
            { type: r.recipe.type, width: r.recipe.size[0], height: r.recipe.size[1] }, r.path);
    }
    assert.equal(imageSize(Buffer.from('not an image')), null);
});

test('the 2k maps are the 4k maps of the same slot, so a tier switch keeps colour, water and weather', () => {
    const same = (key, fromKey, channel) => {
        const r = recipeFor(key);
        assert.ok(r, `${key} (${ASSET_URLS[key]}) is a derived texture`);
        assert.equal(r.from, ASSET_URLS[fromKey], `${key} is made from ${fromKey}`);
        assert.equal(r.recipe.channel, channel, `${key} channel`);
    };
    same('day2k', 'day4k', 'rgb');
    same('night2k', 'night4k', 'rgb');
    same('clouds2k', 'brc4k', 'b');        // high reads clouds from brc4k.b
    same('roughness2k', 'brc4k', 'g');     // high reads the water mask from brc4k.g
    for (const key of ['day2k', 'night2k']) assert.equal(recipeFor(key).recipe.colour, 'srgb', `${key} is filtered in linear light`);
    for (const r of RECIPES) assert.ok(r.recipe.size[0] === 2 * r.recipe.size[1], `${r.path} stays equirectangular`);
});

test('every tier, and every device adjustment of it, loads only shipped textures', () => {
    const cfgs = Object.keys(TIERS).flatMap((t) => [TIERS[t], tierConfig(t, { maxTextureSize: 4096 }), tierConfig(t, { maxTextureSize: 2048 })]);
    for (const cfg of cfgs) {
        for (const key of tierTextureKeys(cfg)) {
            assert.ok(ASSET_URLS[key], `${cfg.name}: ASSETS has "${key}"`);
            assert.ok(fs.existsSync(path.join(ROOT, ASSET_URLS[key])), `${cfg.name}: ${ASSET_URLS[key]} exists`);
        }
        const keys = tierTextureKeys(cfg);
        assert.equal(keys[0] === 'day2k', keys[1] === 'night2k', `${cfg.name}: the night map follows the day map`);
        // The mask derived from the day map runs on chroma, which the lossy 2k day map stores
        // at 1024 px: most islands of a few texels read as sea. So every tier loads the real
        // water mask, and the derived one only stands in while it loads.
        assert.ok(keys.includes('roughness2k') || keys.includes('brc4k'), `${cfg.name}: loads a water mask`);
    }
    for (const r of RECIPES) assert.ok(Object.values(ASSET_URLS).includes(r.path), `${r.path} is used by the app`);
});

test('max: 8192 maps of the same imagery, each after its 4096 stand-in; only max loads them; never precached', () => {
    const MAX_ONLY = ['day8k', 'night8k', 'clouds8k', 'moon4k'];
    const dims = { day8k: [8192, 4096], night8k: [8192, 4096], clouds8k: [8192, 4096], moon4k: [4096, 2048] };
    for (const key of MAX_ONLY) {
        const dim = imageSize(fs.readFileSync(path.join(ROOT, ASSET_URLS[key])));
        assert.deepEqual([dim.width, dim.height], dims[key], `${key} size`);
    }
    // The cloud map goes through the same density window as every other cloud map.
    assert.deepEqual(recipeFor('clouds8k').recipe.clamp, [0.2, 1]);
    assert.equal(recipeFor('moon4k').recipe.colour, 'srgb', 'the Moon is filtered in linear light');
    const keys = tierTextureKeys(TIERS.max);
    assert.deepEqual(keys, ['day4k', 'night4k', 'brc4k', 'moon', 'milkyway', 'flare0', 'flare3', 'day8k', 'night8k', 'clouds8k', 'moon4k']);
    for (const [big, small] of [['day8k', 'day4k'], ['night8k', 'night4k'], ['clouds8k', 'brc4k'], ['moon4k', 'moon']]) {
        assert.ok(keys.indexOf(small) < keys.indexOf(big), `${small} shows while ${big} loads`);
    }
    // A GPU under 8192 px keeps the 4096 Earth maps on max, and the 4096 Moon.
    assert.deepEqual(tierTextureKeys(tierConfig('max', { maxTextureSize: 4096 })),
        ['day4k', 'night4k', 'brc4k', 'moon', 'milkyway', 'flare0', 'flare3', 'moon4k']);
    for (const t of ['low', 'medium', 'high']) {
        for (const cfg of [TIERS[t], tierConfig(t, { maxTextureSize: 4096 })]) {
            for (const key of MAX_ONLY) assert.ok(!tierTextureKeys(cfg).includes(key), `${t} never loads ${key}`);
        }
    }
    // Cache on first use only (sw.js cache-first): the install step precaches the shell, never these.
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const precache = sw.match(/const PRECACHE = (\[[^\]]*\])/)?.[1] ?? '';
    assert.ok(precache.length > 2, 'PRECACHE found');
    for (const key of MAX_ONLY) assert.ok(!precache.includes(path.basename(ASSET_URLS[key])), `${key} not precached`);
    assert.ok(!/textures/.test(precache), 'no textures precached at all');
});

test('the cloud and water maps are clamped to the windows the earth shader reads them through', async () => {
    const { CLOUD_LOOKUP, EARTH_SHADER } = await import(pathToFileURL(path.join(ROOT, 'js/render/shaders/earth.glsl.js')).href);
    const clouds = stripComments(CLOUD_LOOKUP);
    // One density curve for both cloud maps: mode 1 (clouds2k, grey) and mode 2 (brc4k.b).
    assert.equal(clouds.match(/smoothstep\(0\.2, 1\.0,/g)?.length, 1);
    assert.equal(clouds.match(/cloudDensity\(/g)?.length, 3, 'defined once, used by both modes');
    assert.match(clouds, /cloudDensity\(texture\(tex, st\)\.b\)/);
    assert.match(clouds, /pcTextureBSpline\(tex, st\)\.r/);
    assert.deepEqual(recipeFor('clouds2k').recipe.clamp, [0.2, 1]);
    // One water mask for every tier: roughness in .g through the same window.
    assert.match(stripComments(EARTH_SHADER.fragment), /1\.0 - smoothstep\(0\.25, 0\.45, maskTex\.g\)/);
    assert.deepEqual(recipeFor('roughness2k').recipe.clamp, [0.25, 0.45]);
    assert.ok(!/uDayGain/.test(EARTH_SHADER.fragment), 'both day maps are one image: no per-map gain');
});
