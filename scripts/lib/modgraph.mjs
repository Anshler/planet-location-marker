// Static analysis of the shipped page: index.html references and the ES-module graph.
// Used by scripts/check-size.mjs and the repo tests (importmap closure, external URLs).

import fs from 'node:fs';
import path from 'node:path';
import { findImports } from './jsscan.mjs';

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
