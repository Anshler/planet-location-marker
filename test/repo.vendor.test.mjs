// Vendored third-party files match their lock (vendor/VENDOR.json) and nothing unlisted ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, sha256 } from '../scripts/fetch-vendor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/VENDOR.json'), 'utf8'));

test('lock entries have the documented shape and pinned https URLs', () => {
    assert.ok(Array.isArray(LOCK) && LOCK.length >= 30);
    for (const e of LOCK) {
        for (const k of ['name', 'version', 'url', 'path', 'sha256', 'license']) assert.equal(typeof e[k], 'string', `${e.path}: ${k}`);
        assert.match(e.sha256, /^[0-9a-f]{64}$/);
        assert.match(e.url, /^https:\/\/cdn\.jsdelivr\.net\/(npm\/[^/]+@\d[^/]*|gh\/[^/]+\/[^/@]+@[^/]+)\//, `${e.path}: pinned URL`);
    }
});

test('the lock lists exactly the pinned manifest, in order', () => {
    assert.deepEqual(LOCK.map((e) => e.path), MANIFEST.map((m) => m.path));
    assert.deepEqual(LOCK.map((e) => e.url), MANIFEST.map((m) => m.url));
});

test('every vendored file matches its sha256 and size', () => {
    for (const e of LOCK) {
        const abs = path.join(ROOT, e.path);
        assert.ok(fs.existsSync(abs), `${e.path} exists`);
        const buf = fs.readFileSync(abs);
        assert.equal(buf.length, e.bytes, `${e.path} size`);
        assert.equal(sha256(buf), e.sha256, `${e.path} sha256`);
    }
});

test('no unlisted files under vendor/ or assets/textures/ (unused addons stay deleted)', () => {
    const listed = new Set([...LOCK.map((e) => e.path), 'vendor/VENDOR.json']);
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
