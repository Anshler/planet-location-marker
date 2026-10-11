// Architecture rules R1–R4 (SPEC §C): pure modules stay pure, three stays in the render layer,
// the UI goes through actions, and URLs stay relative. Comments and strings are ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanJs, findImports, lineAt } from '../scripts/lib/jsscan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PURE_DIRS = ['js/astro', 'js/core', 'js/geo', 'js/data'];
const V1_LEFTOVERS = new Set(['js/animation.js', 'js/astronomy.js', 'js/constants.js', 'js/planets.js', 'js/scene.js', 'js/state.js', 'js/ui.js']);

function jsFiles(dir) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'graphify-out' ? [] : jsFiles(rel);
        return /\.m?js$/.test(e.name) ? [rel] : [];
    });
}
const source = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const specifiers = (rel) => {
    const r = findImports(source(rel));
    return [...r.static, ...r.dynamic, ...r.urls];
};
const isThree = (s) => s === 'three' || s.startsWith('three/');
const pureFiles = PURE_DIRS.flatMap(jsFiles);
const allApp = jsFiles('js').filter((f) => !V1_LEFTOVERS.has(f));

test('R1: pure modules exist to be checked', () => {
    assert.ok(pureFiles.length >= 10, `found ${pureFiles.length} pure modules`);
});

test('R1: pure modules never import three and only use relative specifiers', () => {
    const bad = [];
    for (const f of pureFiles) {
        for (const s of specifiers(f)) {
            if (isThree(s)) bad.push(`${f}: imports ${s}`);
            else if (!s.startsWith('./') && !s.startsWith('../')) bad.push(`${f}: non-relative specifier "${s}" (import maps do not apply in workers/Node)`);
        }
    }
    assert.deepEqual(bad, []);
});

test('R1: astronomy-engine is imported only through js/astro/ae.js', () => {
    const bad = allApp.filter((f) => f !== 'js/astro/ae.js')
        .flatMap((f) => specifiers(f).filter((s) => /astronomy-engine|astronomy\.js$/.test(s)).map((s) => `${f}: ${s}`));
    assert.deepEqual(bad, []);
});

test('R1: pure modules do not touch window, document or (outside prefs.js) localStorage', () => {
    const bad = [];
    for (const f of pureFiles) {
        const src = source(f);
        const { code } = scanJs(src);
        for (const m of code.matchAll(/\b(window|document|localStorage)\b/g)) {
            if (m[1] === 'localStorage' && f === 'js/core/prefs.js') continue;
            bad.push(`${f}:${lineAt(src, m.index)} uses ${m[1]}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('R2: only js/render, js/camera, js/main.js and js/app import three', () => {
    const allowed = (f) => /^js\/(render|camera|app)\//.test(f) || f === 'js/main.js';
    const bad = allApp.filter((f) => !allowed(f)).flatMap((f) => specifiers(f).filter(isThree).map((s) => `${f}: ${s}`));
    assert.deepEqual(bad, []);
});

test('R3: js/ui never imports three, js/render or js/camera', () => {
    const bad = jsFiles('js/ui').flatMap((f) => specifiers(f)
        .filter((s) => isThree(s) || /(^|\/)(render|camera)\//.test(path.posix.join(path.posix.dirname(f), s)))
        .map((s) => `${f}: ${s}`));
    assert.deepEqual(bad, []);
});

test('R4: no root-absolute site URLs in modules', () => {
    const bad = [];
    for (const f of allApp) {
        const src = source(f);
        for (const s of specifiers(f)) if (s.startsWith('/')) bad.push(`${f}: import "${s}"`);
        // String literals that start at the site root ('/data/…', "/assets/…") break under /<repo>/.
        const { noComments } = scanJs(src);
        for (const m of noComments.matchAll(/(['"`])\/(assets|data|js|css|vendor|sw\.js|manifest\.webmanifest)\b/g)) {
            bad.push(`${f}:${lineAt(src, m.index)} root-absolute URL`);
        }
    }
    assert.deepEqual(bad, []);
});
