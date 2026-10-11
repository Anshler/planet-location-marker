// Offline-first: nothing the page loads may come from another origin (SPEC §H, ADDENDUM A6).
// Allowed: credit/provider links in js/geo/geocode.js, js/ui/about.js and the fixed
// js/version.js; XML namespace URIs; <meta> content, <link rel="canonical"> and <a href>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanJs, lineAt } from '../scripts/lib/jsscan.mjs';
import { parseHtml } from '../scripts/lib/modgraph.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ALLOWED_FILES = new Set(['js/geo/geocode.js', 'js/ui/about.js', 'js/version.js']);
const NAMESPACES = /^https?:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace|2000\/xmlns)\/?$/;
const URL_RE = /https?:\/\/[^\s'"`)<>\\]+/g;

function files(dir, ext) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === 'graphify-out' ? [] : files(rel, ext);
        return ext.test(e.name) ? [rel] : [];
    });
}
const externalUrls = (text) => [...text.matchAll(URL_RE)].filter((m) => !NAMESPACES.test(m[0]));

test('js/**: no external URLs in code or strings (comments may cite sources)', () => {
    const bad = [];
    for (const f of files('js', /\.m?js$/)) {
        if (ALLOWED_FILES.has(f)) continue;
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const m of externalUrls(scanJs(src).noComments)) bad.push(`${f}:${lineAt(src, m.index)} ${m[0]}`);
    }
    assert.deepEqual(bad, []);
});

test('css/**: no external URLs', () => {
    const bad = [];
    for (const f of files('css', /\.css$/)) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
        for (const m of externalUrls(src)) bad.push(`${f}:${lineAt(src, m.index)} ${m[0]}`);
    }
    assert.deepEqual(bad, []);
});

test('index.html: resource attributes, the import map and inline code stay on this origin', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const doc = parseHtml(html);
    const bad = [];
    for (const { tag, attrs } of doc.tags) {
        if (tag === 'meta' || tag === 'a') continue;
        if (tag === 'link' && (attrs.rel ?? '').toLowerCase().split(/\s+/).includes('canonical')) continue;
        for (const name of ['src', 'href', 'srcset', 'poster', 'data', 'action', 'formaction']) {
            if (attrs[name] && externalUrls(attrs[name]).length) bad.push(`<${tag} ${name}="${attrs[name]}">`);
            if (attrs[name] && /^\/\//.test(attrs[name])) bad.push(`<${tag} ${name}="${attrs[name]}"> (protocol-relative)`);
        }
    }
    for (const v of Object.values(doc.importMap?.imports ?? {})) if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(v)) bad.push(`importmap → ${v}`);
    for (const s of doc.scripts) {
        const type = (s.attrs.type ?? '').toLowerCase();
        if (type === 'importmap' || type === 'application/ld+json' || !s.inline.trim()) continue;
        for (const m of externalUrls(scanJs(s.inline).noComments)) bad.push(`inline <script>: ${m[0]}`);
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        for (const u of externalUrls(m[1])) bad.push(`inline <style>: ${u[0]}`);
    }
    assert.deepEqual(bad, []);
});
