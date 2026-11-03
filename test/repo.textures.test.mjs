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
    }
    for (const r of RECIPES) assert.ok(Object.values(ASSET_URLS).includes(r.path), `${r.path} is used by the app`);
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
    // One water mask for medium and high: roughness in .g through the same window.
    assert.match(stripComments(EARTH_SHADER.fragment), /1\.0 - smoothstep\(0\.25, 0\.45, maskTex\.g\)/);
    assert.deepEqual(recipeFor('roughness2k').recipe.clamp, [0.25, 0.45]);
    assert.ok(!/uDayGain/.test(EARTH_SHADER.fragment), 'both day maps are one image: no per-map gain');
});
