#!/usr/bin/env node
// Lists / stages exactly the files that make up the deployed site.
//
//   node scripts/stage-site.mjs <outDir>     copy the site into <outDir> (used by pages.yml), write
//                                            <outDir>/sw-manifest.json and stamp its version into
//                                            <outDir>/sw.js
//   node scripts/stage-site.mjs --list       print the file list with sizes
//   node scripts/stage-site.mjs --manifest   print the version and what the service worker precaches
//
// Everything in the repo ships EXCEPT development material (SPEC §C.4): test/, scripts/,
// docs/, data/raw/, .github/, node_modules/, graphify-out/ (at any depth), .claude/, plus
// .git/, .scratch/, dotfiles (but .nojekyll), package*.json and CLAUDE.md.
// scripts/check-size.mjs measures the same list, so the 32 MB staging budget is real.
//
// The service worker's version (sw-atomic-updates-offline-ci) is the only deploy-time step; the
// repo itself stays no-build, and its sw.js runs in dev mode (VERSION = js/version.js, no manifest).
// sw-manifest.json is {version, sha256, precache:[path], fresh:[path], files:[[path, sha256]]}:
//   files     every shipped file and its sha256, except sw.js (stamped; its source is hashed into
//             the version instead) and `fresh` files;
//   sha256    over those lines plus sw.js's source, so any change to any shipped file is a new
//             version; `version` is js/version.js's VERSION + '+' + its first 16 hex digits;
//   precache  what an install fetches before the version may activate: index.html and its local
//             links (stylesheet, manifest, icons), the whole module graph check-size budgets
//             (static and dynamic imports, the astro worker's graph), the data the app fetches at
//             boot or soon after, and the two Earth previews. Other textures stay lazy (cached on
//             first use, checked against `files`);
//   fresh     files a deploy rewrites after staging (pages.yml: fetch-tle.mjs writes today's
//             data/tle.json): outside the version and network-first in sw.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageModules, resolveDocumentUrl } from './lib/modgraph.mjs';
import { ASSETS } from '../js/core/texture-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top-level (or nested, for data/raw) paths that never ship. */
export const EXCLUDED_PATHS = ['test', 'scripts', 'docs', 'data/raw', '.github', 'node_modules', '.claude', '.git', '.scratch'];
/** Directory names excluded wherever they appear. */
export const EXCLUDED_DIR_NAMES = ['graphify-out', 'node_modules', '__pycache__'];
/** Root files that are development-only. */
export const EXCLUDED_ROOT_FILES = ['package.json', 'package-lock.json', 'CLAUDE.md'];
/** Dotfiles that DO ship. */
export const ALLOWED_DOTFILES = ['.nojekyll'];

/** The service worker's manifest, written next to sw.js in the staged site. */
export const SW_MANIFEST = 'sw-manifest.json';
/** Files the deploy rewrites after staging (data/tle.json: pages.yml, daily): never part of a version. */
export const FRESH_FILES = ['data/tle.json'];
/**
 * Data the app fetches at boot (sky.json, cities.json) or soon after (the spacecraft, deep-sky
 * objects, star details and satellites), precached with the shell. data/stars8.json (the max tier's
 * deeper stars, ≈ 1.1 MB) is not: like the textures, it is cached on first use.
 */
export const PRECACHE_DATA = ['data/sky.json', 'data/cities.json', 'data/craft.json', 'data/dso.json', 'data/starinfo.json', 'data/tle.json'];

/**
 * Site-relative paths (forward slashes, sorted) of every file that ships.
 * @param {string} [root]
 * @returns {string[]}
 */
export function siteFiles(root = ROOT) {
    const out = [];
    const walk = (rel) => {
        const abs = path.join(root, rel);
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
            const p = rel ? `${rel}/${ent.name}` : ent.name;
            if (EXCLUDED_PATHS.includes(p)) continue;
            if (ent.isDirectory()) {
                if (EXCLUDED_DIR_NAMES.includes(ent.name) || ent.name.startsWith('.')) continue;
                walk(p);
            } else if (ent.isFile()) {
                if (ent.name.startsWith('.') && !ALLOWED_DOTFILES.includes(ent.name)) continue;
                if (!rel && EXCLUDED_ROOT_FILES.includes(ent.name)) continue;
                if (/\.test\.m?js$/.test(ent.name)) continue;
                out.push(p);
            }
        }
    };
    walk('');
    return out.sort();
}

/** @param {Buffer|string} data @returns {string} sha256, lower-case hex */
export function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/** js/version.js's VERSION. */
function appVersion(root) {
    const v = fs.readFileSync(path.join(root, 'js/version.js'), 'utf8').match(/export const VERSION\s*=\s*'([^']+)'/)?.[1];
    if (!v) throw new Error('js/version.js: no VERSION');
    return v;
}

/**
 * What a service-worker install fetches before its version may activate, shell first: index.html
 * and its local links, the page's whole module graph (scripts/lib/modgraph.mjs pageModules, the
 * crawl check-size budgets), PRECACHE_DATA and the two Earth previews.
 * @param {string} [root]
 * @returns {string[]}
 */
export function precacheList(root = ROOT) {
    const { doc, modules, missing } = pageModules(root);
    if (missing.length) throw new Error(`module graph: missing ${missing.map((m) => `${m.path} (from ${m.from})`).join(', ')}`);
    const shell = ['index.html'];
    for (const l of doc.links) {
        const rel = (l.rel ?? '').toLowerCase().split(/\s+/);
        if (!l.href || rel.includes('modulepreload')) continue;
        const r = resolveDocumentUrl(l.href);
        if (r.kind === 'local' && r.path) shell.push(r.path);
    }
    const previews = [ASSETS.dayPreview.url, ASSETS.nightPreview.url];
    return [...new Set([...shell, ...modules, ...PRECACHE_DATA, ...previews])];
}

/**
 * The service worker's manifest for the site at `root` (see the header).
 * @param {string} [root]
 * @returns {{version:string, sha256:string, precache:string[], fresh:string[], files:[string, string][]}}
 */
export function buildManifest(root = ROOT) {
    const all = siteFiles(root);
    const files = all.filter((f) => f !== 'sw.js' && f !== SW_MANIFEST && !FRESH_FILES.includes(f))
        .map((f) => [f, sha256(fs.readFileSync(path.join(root, f)))]);
    const lines = files.map(([f, h]) => `${h}  ${f}\n`).join('') + `${sha256(fs.readFileSync(path.join(root, 'sw.js')))}  sw.js\n`;
    const digest = sha256(lines);
    const precache = precacheList(root);
    const shipped = new Set(all);
    const unshipped = precache.filter((p) => !shipped.has(p));
    if (unshipped.length) throw new Error(`precache lists files that do not ship: ${unshipped.join(', ')}`);
    return {
        version: `${appVersion(root)}+${digest.slice(0, 16)}`,
        sha256: digest,
        precache,
        fresh: FRESH_FILES.filter((f) => shipped.has(f)),
        files,
    };
}

/**
 * sw.js with the staged version stamped in (`const VERSION = '…';`, `const STAGED = true;`).
 * @param {string} src sw.js as in the repo
 * @param {string} version
 * @returns {string}
 */
export function stampServiceWorker(src, version) {
    if (!/^[\w.+-]+$/.test(version)) throw new Error(`not a version: ${version}`);
    const VERSION_RE = /^const VERSION = '[^'\n]*';$/m, STAGED_RE = /^const STAGED = false;$/m;
    if (!VERSION_RE.test(src) || !STAGED_RE.test(src)) {
        throw new Error("sw.js: the lines \"const VERSION = '…';\" and \"const STAGED = false;\" are needed for the stamp");
    }
    return src.replace(VERSION_RE, `const VERSION = '${version}';`).replace(STAGED_RE, 'const STAGED = true;');
}

/**
 * Copies the site into `outDir` (emptied first), writes sw-manifest.json and stamps sw.js.
 * @param {string} outDir
 * @param {string} [root]
 * @returns {{files:number, bytes:number, version:string, precache:number}}
 */
export function stageSite(outDir, root = ROOT) {
    const dest = path.resolve(outDir);
    if (dest === path.resolve(root) || path.resolve(root).startsWith(dest + path.sep)) {
        throw new Error('refusing to stage into the repo root or one of its parents');
    }
    fs.rmSync(dest, { recursive: true, force: true });
    let bytes = 0;
    const files = siteFiles(root);
    for (const f of files) {
        const to = path.join(dest, f);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(root, f), to);
        bytes += fs.statSync(to).size;
    }
    const manifest = buildManifest(root);
    fs.writeFileSync(path.join(dest, SW_MANIFEST), `${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(dest, 'sw.js'), stampServiceWorker(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), manifest.version));
    bytes += fs.statSync(path.join(dest, SW_MANIFEST)).size;
    return { files: files.length + 1, bytes, version: manifest.version, precache: manifest.precache.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = process.argv[2];
    if (!arg) {
        console.error('usage: node scripts/stage-site.mjs <outDir> | --list | --manifest');
        process.exit(2);
    }
    if (arg === '--list') {
        let total = 0;
        for (const f of siteFiles()) {
            const size = fs.statSync(path.join(ROOT, f)).size;
            total += size;
            console.log(`${String(size).padStart(9)}  ${f}`);
        }
        console.log(`${String(total).padStart(9)}  total`);
    } else if (arg === '--manifest') {
        const m = buildManifest();
        const bytes = m.precache.reduce((a, f) => a + fs.statSync(path.join(ROOT, f)).size, 0);
        console.log(`version ${m.version}\nprecache ${m.precache.length} files, ${(bytes / 1e6).toFixed(2)} MB`
            + ` (of ${m.files.length} hashed; fresh: ${m.fresh.join(', ') || 'none'})`);
    } else {
        const { files, bytes, version, precache } = stageSite(arg);
        console.log(`staged ${files} files, ${(bytes / 1e6).toFixed(2)} MB → ${path.resolve(arg)}`
            + `\nservice worker ${version}: ${precache} files precached on install`);
    }
}
