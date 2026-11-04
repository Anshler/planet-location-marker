// Static analysis of the shipped page: index.html references and the ES-module graph.
// Used by scripts/check-size.mjs and the repo tests (importmap closure, external URLs), and as a
// command it keeps index.html's boot modulepreload lists current (end of this file).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImports, scanJs } from './jsscan.mjs';

const SITE = 'http://site/';   // fake origin: resolution happens in URL space, like a browser

/** Attribute map of one tag's attribute text (names lower-cased). */
export function parseAttrs(text) {
    const attrs = {};
    for (const m of text.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
}

/**
 * Pulls the parts of an HTML document the checks care about. Comments are ignored.
 * @param {string} html
 * @returns {{scripts:{attrs:object, inline:string}[], links:object[], tags:{tag:string, attrs:object}[], importMap:object|null, importMapError:string|null}}
 */
export function parseHtml(html) {
    const clean = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    const scripts = [];
    for (const m of clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        scripts.push({ attrs: parseAttrs(m[1]), inline: m[2] });
    }
    const tags = [];
    for (const m of clean.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
        tags.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2]) });
    }
    const links = tags.filter((t) => t.tag === 'link').map((t) => t.attrs);
    let importMap = null, importMapError = null;
    const im = scripts.find((s) => (s.attrs.type ?? '').toLowerCase() === 'importmap');
    if (im) {
        try {
            importMap = JSON.parse(im.inline);
        } catch (err) {
            importMapError = err.message;
        }
    }
    return { scripts, links, tags, importMap, importMapError };
}

/**
 * Resolves a module specifier the way a browser would.
 * @param {string} spec
 * @param {string} fromPath site-relative path of the importing file ('' = the document)
 * @param {object|null} importMap parsed importmap (applies only in window context)
 * @param {'window'|'worker'} [context]
 * @returns {{kind:'local', path:string}|{kind:'external', url:string}|{kind:'unresolved', reason:string}}
 */
export function resolveSpecifier(spec, fromPath, importMap, context = 'window') {
    let url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
        url = new URL(spec);
    } else if (/^(\.{0,2}\/)/.test(spec)) {
        url = new URL(spec, SITE + fromPath);
    } else {
        // Bare specifier: import maps do not apply inside workers (or Node).
        if (context === 'worker') return { kind: 'unresolved', reason: `bare specifier "${spec}" inside a worker` };
        const imports = importMap?.imports ?? {};
        let target = imports[spec];
        if (target === undefined) {
            const key = Object.keys(imports).filter((k) => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
            if (key) target = imports[key] + spec.slice(key.length);
        }
        if (target === undefined) return { kind: 'unresolved', reason: `bare specifier "${spec}" not in the importmap` };
        url = new URL(target, SITE + 'index.html');
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return { kind: 'external', url: url.href };
    if (url.origin + '/' !== SITE) return { kind: 'external', url: url.href };
    return { kind: 'local', path: decodeURIComponent(url.pathname.slice(1)) };
}

/**
 * Crawls the module graph from entry files.
 * @param {string} root repo root
 * @param {{path:string, context?:'window'|'worker'}[]} entries site-relative entry modules
 * @param {object|null} importMap
 * @returns {{modules:string[], assets:string[], missing:{path:string, from:string}[], unresolved:{spec:string, from:string, reason:string}[], external:{url:string, from:string}[]}}
 */
export function crawlModules(root, entries, importMap) {
    const seen = new Map();   // path → context
    const queue = entries.map((e) => ({ path: e.path, context: e.context ?? 'window', from: '(entry)' }));
    const out = { modules: [], assets: [], missing: [], unresolved: [], external: [] };
    while (queue.length) {
        const { path: p, context, from } = queue.shift();
        if (seen.has(`${context}:${p}`)) continue;
        seen.set(`${context}:${p}`, true);
        const abs = path.join(root, p);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            out.missing.push({ path: p, from });
            continue;
        }
        if (!out.modules.includes(p)) out.modules.push(p);
        const refs = findImports(fs.readFileSync(abs, 'utf8'));
        const follow = (spec, ctx) => {
            const r = resolveSpecifier(spec, p, importMap, ctx);
            if (r.kind === 'local') queue.push({ path: r.path, context: ctx, from: p });
            else if (r.kind === 'external') out.external.push({ url: r.url, from: p });
            else out.unresolved.push({ spec, from: p, reason: r.reason });
        };
        for (const s of [...refs.static, ...refs.dynamic]) follow(s, context);
        for (const u of refs.urls) {
            // new URL('./worker.js', import.meta.url) → a module worker; anything else is an asset.
            if (/\.m?js$/.test(u)) {
                follow(u, 'worker');
                continue;
            }
            const r = resolveSpecifier(u, p, null);
            if (r.kind !== 'local') {
                out.external.push({ url: u, from: p });
            } else if (fs.existsSync(path.join(root, r.path))) {
                if (!out.assets.includes(r.path)) out.assets.push(r.path);
            } else {
                out.missing.push({ path: r.path, from: p });
            }
        }
    }
    return out;
}

/**
 * Resolves an HTML attribute URL (src/href) against the document at the site root.
 * Unlike a module specifier, "js/main.js" here is a relative URL, never a bare name.
 * @param {string} href
 * @returns {{kind:'local', path:string}|{kind:'external', url:string}}
 */
export function resolveDocumentUrl(href) {
    const url = new URL(href, SITE + 'index.html');
    if (url.origin + '/' !== SITE) return { kind: 'external', url: url.href };
    return { kind: 'local', path: decodeURIComponent(url.pathname.slice(1)) };
}

/**
 * Entry modules of a page: module scripts (src), inline module imports and modulepreloads.
 * @param {ReturnType<typeof parseHtml>} doc
 * @returns {{entries:{path:string, context:'window'}[], external:string[], unresolved:string[]}}
 */
export function pageEntries(doc) {
    const entries = [], external = [], unresolved = [];
    const push = (r, label) => {
        if (r.kind === 'local') entries.push({ path: r.path, context: 'window' });
        else if (r.kind === 'external') external.push(r.url);
        else unresolved.push(`${label}: ${r.reason}`);
    };
    for (const s of doc.scripts) {
        if ((s.attrs.type ?? '').toLowerCase() !== 'module') continue;
        if (s.attrs.src) {
            push(resolveDocumentUrl(s.attrs.src), s.attrs.src);
        } else {
            const refs = findImports(s.inline);
            for (const spec of [...refs.static, ...refs.dynamic]) push(resolveSpecifier(spec, '', doc.importMap), spec);
        }
    }
    for (const l of doc.links) {
        if ((l.rel ?? '').toLowerCase().split(/\s+/).includes('modulepreload') && l.href) push(resolveDocumentUrl(l.href), l.href);
    }
    return { entries, external, unresolved };
}

/**
 * Every module the page can run: index.html's module scripts and modulepreloads, then their static
 * and dynamic imports and module workers, through the import map. The transfer budgets count this
 * graph (scripts/check-size.mjs) and the service worker precaches it (scripts/stage-site.mjs →
 * sw-manifest.json), so both see the same files.
 * @param {string} root site root
 * @returns {{doc:ReturnType<typeof parseHtml>, entries:{path:string, context:'window'}[], modules:string[], missing:{path:string, from:string}[], external:string[]}}
 */
export function pageModules(root) {
    const doc = parseHtml(fs.readFileSync(path.join(root, PRELOAD_HTML), 'utf8'));
    const { entries, external } = pageEntries(doc);
    const g = crawlModules(root, entries, doc.importMap);
    return { doc, entries, modules: g.modules, missing: g.missing, external: [...external, ...g.external.map((x) => x.url)] };
}

// ---------------------------------------------------------------------------------------------
// The boot graph's modulepreload lists in index.html (instant-earth-progressive-textures)
//
//   node scripts/lib/modgraph.mjs --write    regenerate both lists in index.html
//   node scripts/lib/modgraph.mjs --check    exit 1 when index.html's lists are stale (CI; the
//                                            repo tests check the same)
//
// A cold boot otherwise discovers its ~165 modules one import level at a time (main.js →
// render/context.js → postfx.js → EffectComposer.js → CopyShader.js: five round trips). The lists
// hold every module a boot runs, so they all download in parallel from the first bytes:
//   core  static <link rel=modulepreload> tags in <head>: main.js's static imports and the UI's
//         (text mode runs them too);
//   3d    three.js and the render stack main.js imports in importRenderStack(), injected by the
//         feature-detection script only when the 3D view can run, so text mode never downloads them.
// Modules imported later on demand (tours, the recorder, Mars, …) and the astro worker's graph (a
// worker has its own module map) are not listed.

export const PRELOAD_HTML = 'index.html';
const CORE_MARK = ['<!-- boot modules (node scripts/lib/modgraph.mjs --write) -->', '<!-- /boot modules -->'];
const THREE_MODULE = 'vendor/three/three.module.min.js';
const VIEW3D_MARK = ['/* 3d modules (node scripts/lib/modgraph.mjs --write) */', '/* /3d modules */'];

/** Breadth-first closure of static imports (window context; missing files are skipped). */
function staticClosure(root, entries, importMap) {
    const seen = [];
    const queue = [...entries];
    while (queue.length) {
        const p = queue.shift();
        if (seen.includes(p)) continue;
        const abs = path.join(root, p);
        if (!fs.existsSync(abs)) continue;
        seen.push(p);
        for (const spec of findImports(fs.readFileSync(abs, 'utf8')).static) {
            const r = resolveSpecifier(spec, p, importMap);
            if (r.kind === 'local') queue.push(r.path);
        }
    }
    return seen;
}

/** The source text of `function <name>(…) { … }` in a module (brace-matched on the code view). */
function functionSource(src, name) {
    const { code } = scanJs(src);
    const at = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
    if (at < 0) return '';
    let i = code.indexOf('{', code.indexOf(')', at));
    for (let depth = 0; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    return '';
}

/**
 * The modules a boot runs, in load order: `core` (main.js's and the UI's static graphs) and `view3d`
 * (what importRenderStack() adds: three.js and the render stack).
 * @param {string} root repo root
 * @returns {{core:string[], view3d:string[]}}
 */
export function bootModules(root) {
    const doc = parseHtml(fs.readFileSync(path.join(root, PRELOAD_HTML), 'utf8'));
    const core = staticClosure(root, ['js/main.js', 'js/ui/index.js'], doc.importMap);
    const stack = findImports(functionSource(fs.readFileSync(path.join(root, 'js/main.js'), 'utf8'), 'importRenderStack')).dynamic
        .map((s) => resolveSpecifier(s, 'js/main.js', doc.importMap))
        .filter((r) => r.kind === 'local').map((r) => r.path);
    const view3d = staticClosure(root, stack, doc.importMap).filter((p) => !core.includes(p));
    // three.js first: the largest file, and every render module waits for it.
    view3d.sort((a, b) => (b === THREE_MODULE) - (a === THREE_MODULE));
    return { core, view3d };
}

/** Replaces the text between two markers; throws when they are missing. */
function between(text, [open, close], body) {
    const a = text.indexOf(open), b = text.indexOf(close, a + open.length);
    if (a < 0 || b < 0) throw new Error(`${PRELOAD_HTML}: markers ${open} … ${close} not found`);
    return text.slice(0, a + open.length) + body + text.slice(b);
}

/**
 * index.html with both lists regenerated (unchanged text when they are current).
 * @param {string} html
 * @param {{core:string[], view3d:string[]}} lists
 * @returns {string}
 */
export function withBootPreloads(html, { core, view3d }) {
    const indentOf = (mark) => {
        const line = html.slice(html.lastIndexOf('\n', html.indexOf(mark)) + 1, html.indexOf(mark));
        return line.match(/^\s*/)[0];
    };
    const coreBody = `\n${core.map((p) => `<link rel="modulepreload" href="${p}">`).join('\n')}\n`;
    const pad = `${indentOf(VIEW3D_MARK[0])}  `;
    const rows = [];
    for (const p of view3d.map((x) => `'${x}'`)) {
        const last = rows.length ? rows[rows.length - 1] : null;
        if (last !== null && pad.length + last.length + p.length + 2 <= 120) rows[rows.length - 1] = `${last}, ${p}`;
        else rows.push(p);
    }
    const viewBody = `\n${rows.map((r) => `${pad}${r}`).join(',\n')}\n${pad.slice(2)}`;
    return between(between(html, CORE_MARK, coreBody), VIEW3D_MARK, viewBody);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const file = path.join(root, PRELOAD_HTML);
    const html = fs.readFileSync(file, 'utf8');
    const lists = bootModules(root);
    const next = withBootPreloads(html, lists);
    if (process.argv.includes('--check')) {
        if (next !== html) {
            console.error(`${PRELOAD_HTML}: the boot modulepreload lists are stale (run: node scripts/lib/modgraph.mjs --write)`);
            process.exit(1);
        }
        console.log(`boot modulepreload lists OK: ${lists.core.length} core + ${lists.view3d.length} 3D modules`);
    } else if (process.argv.includes('--write')) {
        if (next !== html) fs.writeFileSync(file, next);
        console.log(`${PRELOAD_HTML}: ${lists.core.length} core + ${lists.view3d.length} 3D modules${next === html ? ' (unchanged)' : ''}`);
    } else {
        console.log('usage: node scripts/lib/modgraph.mjs --write | --check');
    }
}
