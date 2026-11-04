// The service worker's deploy-time version (sw-atomic-updates-offline-ci): scripts/stage-site.mjs
// writes sw-manifest.json and stamps its version into the staged sw.js; the repo's sw.js stays the
// dev worker (its VERSION is js/version.js's: test/repo.assets.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildManifest, stampServiceWorker, stageSite, precacheList, sha256, siteFiles, SW_MANIFEST, FRESH_FILES, PRECACHE_DATA,
} from '../scripts/stage-site.mjs';
import { bootModules } from '../scripts/lib/modgraph.mjs';
import { ASSETS } from '../js/core/texture-plan.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-swm-'));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const SW_SRC = "// worker\nconst VERSION = '1.2.3';\nconst STAGED = false;\nself.x = VERSION;\n";

/** A minimal site: a page with a module, a lazy module and a worker, the precached data and previews. */
function fixture() {
    const dir = tmpDir();
    write(dir, 'index.html', '<!doctype html><link rel="stylesheet" href="css/app.css"><link rel="icon" href="assets/icons/i.svg">'
        + '<link rel="canonical" href="https://example.org/"><script type="module" src="js/main.js"></script>');
    write(dir, 'css/app.css', 'body{}');
    write(dir, 'assets/icons/i.svg', '<svg/>');
    write(dir, 'js/version.js', "export const VERSION = '1.2.3';\n");
    write(dir, 'js/main.js', "import { VERSION } from './version.js';\nimport('./lazy.js');\nnew Worker(new URL('./w.js', import.meta.url), { type: 'module' });\n");
    write(dir, 'js/lazy.js', 'export const lazy = 1;\n');
    write(dir, 'js/w.js', "import './w-dep.js';\n");
    write(dir, 'js/w-dep.js', 'export {};\n');
    write(dir, 'sw.js', SW_SRC);
    for (const d of PRECACHE_DATA) write(dir, d, '{}');
    for (const k of ['dayPreview', 'nightPreview']) write(dir, ASSETS[k].url, k);
    write(dir, 'assets/textures/big.jpg', 'lazy texture');
    write(dir, 'test/a.test.mjs', 'never ships');
    return dir;
}

test('sw-manifest: every shipped file hashed, one version over all of them', () => {
    const dir = fixture();
    const m = buildManifest(dir);
    assert.match(m.version, /^1\.2\.3\+[0-9a-f]{16}$/);
    assert.equal(m.version.slice(-16), m.sha256.slice(0, 16));
    const paths = m.files.map(([p]) => p);
    assert.ok(!paths.includes('sw.js'), 'the stamped worker is not a cached file');
    for (const f of FRESH_FILES) assert.ok(!paths.includes(f), `${f} is outside the version`);
    assert.ok(!paths.some((p) => p.startsWith('test/')), 'only shipped files');
    assert.deepEqual(m.fresh, FRESH_FILES);
    for (const [p, h] of m.files) assert.equal(h, sha256(fs.readFileSync(path.join(dir, p))), p);
    assert.deepEqual(buildManifest(dir), m, 'deterministic');

    // The whole graph (static, dynamic, worker) and the shell's links are precached; lazy textures are not.
    for (const p of ['index.html', 'css/app.css', 'assets/icons/i.svg', 'js/main.js', 'js/version.js', 'js/lazy.js', 'js/w.js', 'js/w-dep.js',
        ...PRECACHE_DATA, ASSETS.dayPreview.url, ASSETS.nightPreview.url]) {
        assert.ok(m.precache.includes(p), `precaches ${p}`);
    }
    assert.equal(m.precache[0], 'index.html');
    assert.ok(!m.precache.includes('assets/textures/big.jpg'));

    // Any shipped byte (the worker's source too) is a new version; the daily data/tle.json is not.
    const versionAfter = (rel, text) => {
        const before = fs.readFileSync(path.join(dir, rel));
        fs.writeFileSync(path.join(dir, rel), text);
        const v = buildManifest(dir).version;
        fs.writeFileSync(path.join(dir, rel), before);
        return v;
    };
    assert.notEqual(versionAfter('js/lazy.js', 'export const lazy = 2;\n'), m.version);
    assert.notEqual(versionAfter('assets/textures/big.jpg', 'other bytes'), m.version);
    assert.notEqual(versionAfter('sw.js', `${SW_SRC}// edited\n`), m.version);
    assert.equal(versionAfter('data/tle.json', '{"fresh":1}'), m.version);
    assert.equal(buildManifest(dir).version, m.version);
});

test('sw-manifest: a precached file that does not ship fails the build', () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, 'data/sky.json'));
    assert.throws(() => buildManifest(dir), /do not ship: data\/sky\.json/);
    const dir2 = fixture();
    write(dir2, 'js/main.js', "import './gone.js';\n");
    assert.throws(() => buildManifest(dir2), /missing js\/gone\.js/);
});

test('stampServiceWorker: VERSION and STAGED, or a clear error', () => {
    const out = stampServiceWorker(SW_SRC, '1.2.3+0123456789abcdef');
    assert.match(out, /^const VERSION = '1\.2\.3\+0123456789abcdef';$/m);
    assert.match(out, /^const STAGED = true;$/m);
    assert.equal(out.replace("'1.2.3+0123456789abcdef'", "'1.2.3'").replace('STAGED = true', 'STAGED = false'), SW_SRC, 'nothing else changes');
    assert.throws(() => stampServiceWorker("const VERSION = '1';\n", '1+a'), /STAGED/);
    assert.throws(() => stampServiceWorker(SW_SRC, "1'; evil()"), /not a version/);
    // The repo's worker carries both lines, unstamped.
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert.match(sw, /^const STAGED = false;$/m);
    assert.match(stampServiceWorker(sw, '9.9.9+ffffffffffffffff'), /^const VERSION = '9\.9\.9\+ffffffffffffffff';$/m);
});

test('stageSite: the staged worker carries the manifest version, the files their hashes', () => {
    const dir = fixture();
    const out = tmpDir();
    const r = stageSite(out, dir);
    const m = JSON.parse(fs.readFileSync(path.join(out, SW_MANIFEST), 'utf8'));
    assert.equal(r.version, m.version);
    assert.equal(fs.readFileSync(path.join(out, 'sw.js'), 'utf8'), stampServiceWorker(SW_SRC, m.version));
    assert.equal(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8'), SW_SRC, 'the source stays the dev worker');
    for (const [p, h] of m.files) assert.equal(sha256(fs.readFileSync(path.join(out, p))), h, p);
    assert.ok(!fs.existsSync(path.join(out, 'test')), 'test/ never ships');
    // Staging again gives the same version: a redeploy of the same commit (the daily one) is no update.
    assert.equal(stageSite(tmpDir(), dir).version, m.version);
});

test('stageSite into the site itself (pages.yml: _site): the copy is never part of the manifest', () => {
    for (const name of ['_site', 'out']) {
        const dir = fixture();
        const first = stageSite(path.join(dir, name), dir);
        const again = stageSite(path.join(dir, name), dir);   // over the earlier copy
        const m = JSON.parse(fs.readFileSync(path.join(dir, name, SW_MANIFEST), 'utf8'));
        assert.equal(m.files.filter(([p]) => p.startsWith(`${name}/`)).length, 0, name);
        assert.equal(again.version, first.version, name);
    }
    // A staged _site left in the repo does not count as site files (check-size's staging budget).
    const dir = fixture();
    stageSite(path.join(dir, '_site'), dir);
    assert.ok(!siteFiles(dir).some((f) => f.startsWith('_site/')));
});

test('the real site: precache = shell + boot graph + astro worker graph + boot data + previews', () => {
    const m = buildManifest(ROOT);
    const shipped = new Set(siteFiles(ROOT));
    const { core, view3d } = bootModules(ROOT);
    for (const p of [...core, ...view3d]) assert.ok(m.precache.includes(p), `boot module ${p}`);
    for (const p of ['index.html', 'css/app.css', 'manifest.webmanifest', 'js/astro/worker.js', 'js/render/debug.js', 'data/sky.json', 'data/cities.json']) {
        assert.ok(m.precache.includes(p), p);
    }
    for (const p of m.precache) assert.ok(shipped.has(p), `${p} ships`);
    // The worker's own copy of the fresh list and the dev install list.
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert.deepEqual(JSON.parse(sw.match(/const FRESH_DEFAULT = (\[[^\]]*\])/)[1].replace(/'/g, '"')), FRESH_FILES);
    const dev = JSON.parse(sw.match(/const DEV_PRECACHE = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
    for (const p of dev) assert.ok(shipped.has(p), `dev precache ${p} ships`);
    for (const p of PRECACHE_DATA) assert.ok(dev.includes(p), `dev precache has ${p}`);
});
