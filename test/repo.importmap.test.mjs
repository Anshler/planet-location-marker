// The page's import map resolves the whole module graph to files that exist (SPEC §H, R4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHtml, pageEntries, crawlModules } from '../scripts/lib/modgraph.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const DOC = parseHtml(HTML);
const norm = (p) => p.replace(/^\.\//, '');

test('index.html has one valid import map that vendors three locally', () => {
    const maps = DOC.scripts.filter((s) => (s.attrs.type ?? '').toLowerCase() === 'importmap');
    assert.equal(maps.length, 1, 'exactly one <script type="importmap">');
    assert.equal(DOC.importMapError, null, 'import map is valid JSON');
    const imports = DOC.importMap?.imports ?? {};
    assert.equal(norm(imports.three ?? ''), 'vendor/three/three.module.min.js');
    assert.equal(norm(imports['three/addons/'] ?? ''), 'vendor/three/addons/');
    for (const [k, v] of Object.entries(imports)) {
        assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('/'), `"${k}" maps to a relative URL (${v})`);
    }
});

test('the import map comes before every module script and modulepreload', () => {
    const at = (re) => {
        const m = re.exec(HTML.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length)));
        return m ? m.index : Infinity;
    };
    const map = at(/<script\b[^>]*type\s*=\s*["']?importmap/i);
    assert.ok(map < at(/<script\b[^>]*type\s*=\s*["']?module/i), 'before the first module script');
    assert.ok(map < at(/<link\b[^>]*rel\s*=\s*["']?modulepreload/i), 'before the first modulepreload');
});

test('js/main.js is the module entry point', () => {
    const { entries, external, unresolved } = pageEntries(DOC);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(external, [], 'no module or modulepreload loads from another origin');
    assert.ok(entries.some((e) => e.path === 'js/main.js'), 'a module script loads js/main.js');
});

test('every module reachable from the page exists, locally, with no bare specifier in workers', () => {
    const { entries } = pageEntries(DOC);
    const g = crawlModules(ROOT, entries, DOC.importMap);
    const show = (list) => list.map((x) => JSON.stringify(x)).join('\n  ');
    assert.deepEqual(g.missing, [], `missing files:\n  ${show(g.missing)}`);
    assert.deepEqual(g.unresolved, [], `unresolvable specifiers:\n  ${show(g.unresolved)}`);
    assert.deepEqual(g.external, [], `external imports:\n  ${show(g.external)}`);
    assert.ok(g.modules.length > 20, `crawled ${g.modules.length} modules`);
    for (const m of g.modules) assert.ok(/^(js|vendor)\//.test(m), `${m} lives under js/ or vendor/`);
    assert.ok(g.modules.includes('vendor/three/three.module.min.js'), 'three is reached through the import map');
    assert.ok(g.modules.includes('vendor/astronomy-engine/astronomy.js'), 'astronomy-engine is reached');
});

// ---------------------------------------------------------------- boot modulepreload lists

test('index.html preloads the whole boot graph, and the lists are current (modgraph --write)', async () => {
    const { bootModules, withBootPreloads } = await import('../scripts/lib/modgraph.mjs');
    const lists = bootModules(ROOT);
    assert.equal(withBootPreloads(HTML, lists), HTML, 'stale: run node scripts/lib/modgraph.mjs --write');
    const { core, view3d } = lists;
    assert.equal(core[0], 'js/main.js');
    assert.ok(core.includes('js/ui/index.js') && core.includes('vendor/astronomy-engine/astronomy.js'));
    assert.equal(view3d[0], 'vendor/three/three.module.min.js', 'three.js first');
    for (const m of ['js/render/context.js', 'js/render/postfx.js', 'vendor/three/addons/shaders/CopyShader.js', 'js/camera/rig.js']) {
        assert.ok(view3d.includes(m), `${m} (the deepest import chain) is preloaded`);
    }
    // Text mode needs neither: main.js's and the UI's static graphs stay free of three.js.
    assert.ok(!core.some((p) => p.startsWith('vendor/three/') || p.startsWith('js/render/') || p.startsWith('js/camera/')),
        'the core list is three-free');
    assert.ok(!core.some((p) => view3d.includes(p)), 'no module in both lists');
    for (const p of [...core, ...view3d]) assert.ok(fs.existsSync(`${ROOT}/${p}`), `${p} exists`);
    // Lazy modules are not preloaded.
    for (const p of ['js/app/tours.js', 'js/app/recorder.js', 'js/app/mars-host.js']) {
        assert.ok(!core.includes(p) && !view3d.includes(p), `${p} loads on demand only`);
    }
});

test('three.js and the previews are preloaded only when the 3D view can run (text mode skips them)', async () => {
    const { ASSETS } = await import('../js/core/texture-plan.js');
    const staticPreloads = DOC.links.filter((l) => /modulepreload/i.test(l.rel ?? '')).map((l) => norm(l.href));
    assert.ok(!staticPreloads.some((h) => h.startsWith('vendor/three/')), 'no static three.js modulepreload');
    const detect = DOC.scripts.find((s) => s.inline.includes('w.__pcEnv = env'))?.inline ?? '';
    // Also behind the context-loss record: a tab whose 3D view gave up boots in text mode (main.js).
    const guard = detect.indexOf('if (env.webgl2 && env.importmap && !unstable) {');
    assert.ok(guard > detect.indexOf('w.__pcEnv = env'), 'after the probe, behind its result');
    const block = detect.slice(guard);
    assert.ok(block.indexOf("'vendor/three/three.module.min.js'") > 0);
    for (const key of ['dayPreview', 'nightPreview']) {
        assert.ok(block.includes(`preload('preload', '${ASSETS[key].url}', 'fetch')`), `${key} preloaded as fetch`);
    }
    // crossorigin (anonymous) + same-origin credentials = the mode fetch() uses, so the request is reused.
    assert.match(block, /l\.as = as; l\.crossOrigin = 'anonymous';/);
});
