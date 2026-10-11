// Every file the app, the PWA and the page reference exists; versions agree (SPEC §H).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHtml, resolveDocumentUrl } from '../scripts/lib/modgraph.mjs';
import { readAssets } from '../scripts/check-size.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isFile();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VERSION_JS = read('js/version.js');
const VERSION = VERSION_JS.match(/export const VERSION\s*=\s*'([^']+)'/)?.[1];
const SITE_URL = VERSION_JS.match(/export const SITE_URL\s*=\s*'([^']+)'/)?.[1];

test('every texture in js/render/textures.js ASSETS exists', () => {
    const { assets, source } = readAssets();
    assert.equal(source, 'js/render/textures.js', 'ASSETS parsed from the real module');
    for (const [key, url] of Object.entries(assets)) {
        assert.ok(!url.startsWith('/') && !/^[a-z]+:/i.test(url), `${key}: relative URL`);
        assert.ok(exists(url), `${key}: ${url} exists`);
    }
});

test('sw.js VERSION equals js/version.js', () => {
    assert.ok(VERSION, 'js/version.js exports VERSION');
    const sw = read('sw.js').match(/const VERSION\s*=\s*'([^']+)'/)?.[1];
    assert.equal(sw, VERSION);
    assert.equal(JSON.parse(read('package.json')).version, VERSION, 'package.json version');
});

test('manifest.webmanifest is valid and its icons exist', () => {
    const m = JSON.parse(read('manifest.webmanifest'));
    assert.equal(m.name, 'Planet Location Marker');
    assert.equal(m.start_url, './');
    assert.equal(m.scope, './');
    assert.equal(m.display, 'standalone');
    assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
    assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
    for (const i of m.icons) assert.ok(exists(i.src), `${i.src} exists`);
});

test('icons are the right sizes', () => {
    const dims = (rel) => {
        const b = fs.readFileSync(path.join(ROOT, rel));
        return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    assert.deepEqual(dims('assets/icons/icon-192.png'), [192, 192]);
    assert.deepEqual(dims('assets/icons/icon-512.png'), [512, 512]);
    assert.deepEqual(dims('assets/icons/icon-maskable-512.png'), [512, 512]);
    assert.match(read('assets/icons/favicon.svg'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/);
});

test('every local resource referenced by index.html exists', () => {
    const doc = parseHtml(read('index.html'));
    const missing = [];
    for (const { tag, attrs } of doc.tags) {
        if (tag === 'a' || tag === 'meta') continue;
        for (const name of ['src', 'href']) {
            const v = attrs[name];
            if (!v || v.startsWith('#') || /^(data|blob|mailto|javascript):/i.test(v)) continue;
            const r = resolveDocumentUrl(v);
            if (r.kind === 'local' && r.path && !exists(r.path)) missing.push(`<${tag} ${name}="${v}">`);
        }
    }
    assert.deepEqual(missing, []);
});

test('social preview image declared in index.html exists and is small enough', () => {
    const doc = parseHtml(read('index.html'));
    const og = doc.tags.find((t) => t.tag === 'meta' && t.attrs.property === 'og:image')?.attrs.content;
    assert.ok(og, 'og:image declared');
    assert.ok(og.startsWith(SITE_URL), `og:image is absolute under SITE_URL (${og})`);
    const rel = og.slice(SITE_URL.length);
    assert.ok(exists(rel), `${rel} exists — render it with: node scripts/smoke.mjs --width=1200 --height=630 --format=jpeg --quality=85 --out=${rel}`);
    assert.ok(fs.statSync(path.join(ROOT, rel)).size <= 250e3, `${rel} ≤ 250 KB`);
});

test('deploy files: .nojekyll and third-party notices are present', () => {
    assert.ok(exists('.nojekyll'));
    const notices = read('THIRD_PARTY_NOTICES.md');
    for (const name of ['three.js', 'Astronomy Engine', 'd3-celestial', 'GeoNames', 'Solar System Scope', 'NASA']) {
        assert.ok(notices.includes(name), `notices mention ${name}`);
    }
});
