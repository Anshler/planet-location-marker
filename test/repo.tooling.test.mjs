// Unit tests for the zero-dependency build/CI tooling in scripts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng, crc32 } from '../scripts/lib/png.mjs';
import { readZipEntry, listZipEntries } from '../scripts/lib/zip.mjs';
import { createStaticServer, resolveRequest, mimeFor, download } from '../scripts/lib/http.mjs';
import { scanJs, findImports } from '../scripts/lib/jsscan.mjs';
import { parseHtml, resolveSpecifier, resolveDocumentUrl, crawlModules } from '../scripts/lib/modgraph.mjs';
import { siteFiles } from '../scripts/stage-site.mjs';
import { tierTextureKeys, TIER_BUDGETS } from '../scripts/check-size.mjs';
import { iconShapes, rasterize, toSvg } from '../scripts/build-icons.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-tooling-'));

// ---------------------------------------------------------------- png

test('png: CRC-32 reference value', () => {
    assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('png: round-trips every channel count, through every filter', () => {
    for (const channels of [1, 2, 3, 4]) {
        const w = 33, h = 17;
        const data = new Uint8Array(w * h * channels);
        for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i % w) * 11 + (i >> 5)) & 255;
        for (const filter of ['adaptive', 0, 1, 2, 3, 4]) {
            const png = encodePng(w, h, data, { channels, filter });
            const out = decodePng(png);
            assert.equal(out.width, w);
            assert.equal(out.height, h);
            assert.equal(out.channels, channels);
            assert.deepEqual(Buffer.from(out.data), Buffer.from(data), `channels=${channels} filter=${filter}`);
        }
    }
});

test('png: rejects mismatched sizes and corrupt files', () => {
    assert.throws(() => encodePng(4, 4, new Uint8Array(15)), RangeError);
    const png = encodePng(2, 2, new Uint8Array(4));
    const bad = Buffer.from(png);
    bad[40] ^= 0xff;
    assert.throws(() => decodePng(bad), /CRC|not a PNG|data/);
    assert.throws(() => decodePng(Buffer.from('nope')), /not a PNG/);
});

// ---------------------------------------------------------------- zip

/** Builds a minimal ZIP (deflated + stored entries) for the reader under test. */
function makeZip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const { name, data, store } of entries) {
        const body = store ? data : zlib.deflateRawSync(data);
        const nameBuf = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(store ? 0 : 8, 8);
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(store ? 0 : 8, 10);
        central.writeUInt32LE(crc32(data), 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, body);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

test('zip: lists and inflates deflated and stored entries, verifying CRCs', () => {
    const text = Buffer.from('Hà Nội\t21.0245\t105.8412\n'.repeat(200));
    const zip = makeZip([{ name: 'cities.txt', data: text }, { name: 'readme.txt', data: Buffer.from('hello'), store: true }]);
    assert.deepEqual(listZipEntries(zip).map((e) => e.name), ['cities.txt', 'readme.txt']);
    assert.ok(readZipEntry(zip, 'cities.txt').equals(text));
    assert.equal(readZipEntry(zip, 'readme.txt').toString(), 'hello');
    assert.throws(() => readZipEntry(zip, 'missing.txt'), /not found/);
    const corrupt = Buffer.from(zip);
    corrupt[30 + 'cities.txt'.length + 5] ^= 0x55;
    assert.throws(() => readZipEntry(corrupt, 'cities.txt'));
});

// ---------------------------------------------------------------- http

function rawGet(port, p) {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let d = '';
        s.on('data', (c) => { d += c; });
        s.on('end', () => resolve(Number(d.split(' ')[1])));
        s.on('error', reject);
    });
}

test('http: static server MIME types, no-store, redirects, traversal and sub-path', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'js'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    fs.writeFileSync(path.join(dir, 'js', 'a.mjs'), 'export {};');
    fs.writeFileSync(path.join(dir, 'm.webmanifest'), '{}');
    fs.writeFileSync(path.join(dir, 'i.svg'), '<svg/>');
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
    const app = createStaticServer(dir);
    const base = await app.listen(0);
    try {
        const get = (p, init) => fetch(new URL(p, base), { redirect: 'manual', ...init });
        let r = await get('/');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/html/);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.match((await get('/js/a.mjs')).headers.get('content-type'), /text\/javascript/);
        assert.match((await get('/m.webmanifest')).headers.get('content-type'), /application\/manifest\+json/);
        assert.match((await get('/i.svg')).headers.get('content-type'), /image\/svg\+xml/);
        r = await get('/js');
        assert.equal(r.status, 301);
        assert.equal(r.headers.get('location'), '/js/');
        assert.equal((await get('/nope')).status, 404);
        assert.equal((await get('/.git/HEAD')).status, 404);
        assert.equal((await get('/', { method: 'POST' })).status, 405);
        r = await get('/js/a.mjs', { method: 'HEAD' });
        assert.equal(r.headers.get('content-length'), '10');
        const port = Number(new URL(base).port);
        assert.equal(await rawGet(port, '/..%2f..%2f..%2fetc%2fpasswd'), 404);
        assert.equal(await rawGet(port, '/%E0%A4%A'), 400);
    } finally {
        await app.close();
    }
    const sub = createStaticServer(dir, { prefix: '/repo/' });
    const subBase = await sub.listen(0);
    try {
        assert.ok(subBase.endsWith('/repo/'));
        const origin = new URL(subBase).origin;
        assert.equal((await fetch(`${origin}/repo/`)).status, 200);
        assert.equal((await fetch(`${origin}/index.html`)).status, 404, 'outside the prefix');
        assert.equal((await fetch(`${origin}/repo`, { redirect: 'manual' })).status, 301);
    } finally {
        await sub.close();
    }
});

test('http: resolveRequest and mimeFor', () => {
    assert.equal(resolveRequest(ROOT, '/', '/data/sky.json').status, 200);
    assert.equal(resolveRequest(ROOT, '/', '/does-not-exist').status, 404);
    assert.equal(mimeFor('a.webmanifest'), 'application/manifest+json; charset=utf-8');
    assert.equal(mimeFor('a.PNG'), 'image/png');
    assert.equal(mimeFor('a.unknown'), 'application/octet-stream');
});

test('http: download retries 5xx and fails fast on 4xx', async () => {
    let calls = 0;
    const flaky = async () => {
        calls++;
        return calls < 2 ? new Response('busy', { status: 503 }) : new Response('ok');
    };
    assert.equal((await download('https://x/y', { fetchImpl: flaky, retries: 2 })).toString(), 'ok');
    calls = 0;
    const gone = async () => {
        calls++;
        return new Response('no', { status: 404 });
    };
    await assert.rejects(download('https://x/y', { fetchImpl: gone, retries: 3 }), /HTTP 404/);
    assert.equal(calls, 1);
});

// ---------------------------------------------------------------- jsscan / modgraph

test('jsscan: comments, strings, templates and regexes are told apart', () => {
    const BT = '`';
    const src = [
        '// window in a comment https://a.example',
        "import { a } from './a.js'; import './side.js';",
        "export * from '../b.js';",
        'import {',
        '    c,',
        "} from './multi.js';",
        "const s = 'document \"x\" // not a comment https://s.example';",
        `const t = ${BT}x \${ window.y } https://t.example${BT};`,
        "const r = /'/.test(s) ? 4 / 2 : 1;",
        "const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
        "const m = import('./lazy.js'); // import('./no.js')",
    ].join('\n');
    const { code, noComments } = scanJs(src);
    assert.equal(code.length, src.length);
    assert.deepEqual([...code.matchAll(/\b(window|document)\b/g)].map((m) => m[1]), ['window'], 'only the template expression is code');
    assert.ok(noComments.includes('https://s.example') && noComments.includes('https://t.example'));
    assert.ok(!noComments.includes('a.example'));
    assert.deepEqual(findImports(src), {
        static: ['./a.js', './side.js', './multi.js', '../b.js'],
        dynamic: ['./lazy.js'],
        urls: ['./worker.js'],
    });
});

test('modgraph: specifier and document-URL resolution', () => {
    const im = { imports: { three: './vendor/three/three.module.min.js', 'three/addons/': './vendor/three/addons/' } };
    assert.deepEqual(resolveSpecifier('three', 'js/render/a.js', im), { kind: 'local', path: 'vendor/three/three.module.min.js' });
    assert.deepEqual(resolveSpecifier('three/addons/objects/Sky.js', 'js/render/a.js', im), { kind: 'local', path: 'vendor/three/addons/objects/Sky.js' });
    assert.deepEqual(resolveSpecifier('../core/x.js', 'js/render/a.js', im), { kind: 'local', path: 'js/core/x.js' });
    assert.equal(resolveSpecifier('three', 'js/astro/worker.js', im, 'worker').kind, 'unresolved');
    assert.equal(resolveSpecifier('lodash', 'js/a.js', im).kind, 'unresolved');
    assert.equal(resolveSpecifier('https://unpkg.com/three', 'js/a.js', im).kind, 'external');
    assert.deepEqual(resolveDocumentUrl('js/main.js'), { kind: 'local', path: 'js/main.js' });
    assert.equal(resolveDocumentUrl('//cdn.example/x.js').kind, 'external');
    const doc = parseHtml('<!-- <script type="module" src="old.js"></script> -->'
        + '<script type="importmap">{"imports":{"three":"./v/t.js"}}</script><script type="module" src="js/main.js"></script>');
    assert.equal(doc.scripts.length, 2, 'commented-out markup ignored');
    assert.deepEqual(doc.importMap, { imports: { three: './v/t.js' } });
});

test('modgraph: crawl follows imports, workers and reports missing files', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'js'));
    fs.writeFileSync(path.join(dir, 'js/main.js'), "import './a.js';\nconst w = new Worker(new URL('./w.js', import.meta.url));\nimport('./gone.js');");
    fs.writeFileSync(path.join(dir, 'js/a.js'), "export * from './b.js';");
    fs.writeFileSync(path.join(dir, 'js/b.js'), 'export const b = 1;');
    fs.writeFileSync(path.join(dir, 'js/w.js'), "import 'three';");
    const g = crawlModules(dir, [{ path: 'js/main.js' }], { imports: { three: './v/three.js' } });
    assert.deepEqual(g.modules.sort(), ['js/a.js', 'js/b.js', 'js/main.js', 'js/w.js']);
    assert.deepEqual(g.missing, [{ path: 'js/gone.js', from: 'js/main.js' }]);
    assert.equal(g.unresolved.length, 1, 'bare "three" inside the worker is flagged');
});

// ---------------------------------------------------------------- staging & budgets

test('stage-site ships the site and nothing else', () => {
    const files = siteFiles(ROOT);
    for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', '.nojekyll', 'data/sky.json', 'vendor/VENDOR.json', 'THIRD_PARTY_NOTICES.md']) {
        assert.ok(files.includes(f), `ships ${f}`);
    }
    const leaked = files.filter((f) => /^(test|scripts|docs|\.github|\.claude|\.git|\.scratch|node_modules)\//.test(f)
        || f.startsWith('data/raw/') || f.includes('graphify-out/') || /(^|\/)\.(?!nojekyll$)/.test(f)
        || ['package.json', 'package-lock.json', 'CLAUDE.md'].includes(f));
    assert.deepEqual(leaked, []);
});

test('check-size: tier texture selection mirrors keysForTier', () => {
    assert.deepEqual(tierTextureKeys({ dayTex: 'day2k', oceanMask: 'derived', clouds: 'none', flare: false }), ['day2k', 'night', 'moon', 'milkyway']);
    assert.deepEqual(tierTextureKeys({ dayTex: 'day4k', oceanMask: 'specular', clouds: 'clouds1k', flare: true }),
        ['day4k', 'night', 'specular', 'clouds1k', 'moon', 'milkyway', 'flare0', 'flare3']);
    assert.deepEqual(tierTextureKeys({ dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', flare: true }),
        ['day4k', 'night', 'brc4k', 'moon', 'milkyway', 'flare0', 'flare3']);
    assert.deepEqual(TIER_BUDGETS, { low: 3.8e6, medium: 4.3e6, high: 5.4e6 });
    // SPEC §E.6: every tier stays under 6 MB, and the tiers grow with quality.
    assert.ok(TIER_BUDGETS.low < TIER_BUDGETS.medium && TIER_BUDGETS.medium < TIER_BUDGETS.high && TIER_BUDGETS.high < 6e6);
});

// ---------------------------------------------------------------- icons

test('icons: SVG and raster come from the same geometry', () => {
    const svg = toSvg(iconShapes({ tile: true }));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/);
    assert.ok((svg.match(/<(rect|circle|line|ellipse)\b/g) ?? []).length >= 15);
    const px = rasterize(iconShapes({ markScale: 0.9 }), 32, 3);
    assert.equal(px.length, 32 * 32 * 4);
    const alphaAt = (x, y) => px[(y * 32 + x) * 4 + 3];
    assert.equal(alphaAt(0, 0), 255, 'full-bleed background is opaque in the corner');
    const tile = rasterize(iconShapes({ tile: true }), 32, 3);
    assert.equal(tile[3], 0, 'rounded tile leaves the corner transparent');
});
