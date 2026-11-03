// Vendored third-party files match their lock (vendor/VENDOR.json) and nothing unlisted ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, sha256 } from '../scripts/fetch-vendor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/VENDOR.json'), 'utf8'));
/** Re-encoded textures (scripts/build-textures.mjs) have their own lock; see repo.textures.test.mjs. */
const DERIVED = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/DERIVED.json'), 'utf8'));

test('lock entries have the documented shape and pinned https URLs', () => {
    assert.ok(Array.isArray(LOCK) && LOCK.length >= 25);
    for (const e of LOCK) {
        for (const k of ['name', 'version', 'url', 'path', 'sha256', 'license']) assert.equal(typeof e[k], 'string', `${e.path}: ${k}`);
        assert.match(e.sha256, /^[0-9a-f]{64}$/);
        if (e.version === 'Solar System Scope 8k') {
            // The max tier's 8192 maps come from their author, whose URLs are not versioned: the
            // sha256 is the pin (fetch-vendor refuses a download that does not match it).
            assert.match(e.url, /^https:\/\/www\.solarsystemscope\.com\/textures\/download\/8k_[\w]+\.jpg$/, `${e.path}: source URL`);
            assert.match(e.license, /^CC-BY-4\.0 \(Solar System Scope\)$/);
            continue;
        }
        assert.match(e.url, /^https:\/\/cdn\.jsdelivr\.net\/(npm\/[^/]+@\d[^/]*|gh\/[^/]+\/[^/@]+@[^/]+)\//, `${e.path}: pinned URL`);
    }
});

test('cache entries are gitignored build inputs that never ship', () => {
    const cached = LOCK.filter((e) => e.cache);
    assert.deepEqual(cached.map((e) => e.path), ['data/raw/textures/8k_earth_clouds.jpg', 'data/raw/textures/8k_moon.jpg']);
    assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^data\/raw\/textures\/$/m);
    for (const e of cached) assert.ok(DERIVED.some((d) => d.from === e.path), `${e.path} feeds a derived texture`);
});

test('the lock lists exactly the pinned manifest, in order', () => {
    assert.deepEqual(LOCK.map((e) => e.path), MANIFEST.map((m) => m.path));
    assert.deepEqual(LOCK.map((e) => e.url), MANIFEST.map((m) => m.url));
});

test('every vendored file matches its sha256 and size', () => {
    for (const e of LOCK) {
        const abs = path.join(ROOT, e.path);
        if (e.cache && !fs.existsSync(abs)) continue;   // a gitignored download, verified when present
        assert.ok(fs.existsSync(abs), `${e.path} exists`);
        const buf = fs.readFileSync(abs);
        assert.equal(buf.length, e.bytes, `${e.path} size`);
        assert.equal(sha256(buf), e.sha256, `${e.path} sha256`);
    }
});

test('no unlisted files under vendor/ or assets/textures/ (unused addons stay deleted)', () => {
    const listed = new Set([...LOCK.map((e) => e.path), ...DERIVED.map((e) => e.path), 'vendor/VENDOR.json', 'vendor/DERIVED.json']);
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
    const extra = [...walk('vendor'), ...walk('assets/textures')].filter((f) => !listed.has(f));
    assert.deepEqual(extra, []);
});

test('licences ship next to the code and data', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert.match(read('vendor/three/LICENSE'), /MIT License/);
    assert.match(read('vendor/astronomy-engine/LICENSE'), /MIT License/);
    assert.match(read('data/raw/LICENSE-d3-celestial'), /Redistribution and use in source and binary forms/);
});
