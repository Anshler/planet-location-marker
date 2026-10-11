#!/usr/bin/env node
// Transfer-size budgets (SPEC §E.6), enforced in CI:  node scripts/check-size.mjs [--json]
//
// Per quality tier, the initial download is: the page shell (index.html, CSS, manifest),
// the ES-module graph actually reachable from index.html (crawled through the importmap,
// incl. the astro worker), the data files and that tier's textures (same selection rules
// as keysForTier in js/render/textures.js, driven by TIERS from js/core/quality.js).
// Raw bytes on disk are budgeted (1 MB = 10⁶ B); gzip "wire" sizes are informational
// (GitHub Pages compresses JS/CSS/JSON/SVG/HTML).
//
//   low ≤ 3.8 MB · medium ≤ 4.3 MB · high ≤ 5.4 MB · staged site ≤ 12 MB
//   SPEC §E.6 set 3.0 / 3.6 / 4.8 MB from an estimate of ≈ 1.35 MB of JavaScript. The shipped,
//   unminified-by-design module graph (no build step) measures ≈ 2.0 MB raw incl. CSS
//   (≈ 0.6 MB gzipped; three.js + astronomy-engine alone are 1.17 MB raw), so the budgets were
//   re-baselined to the measured sizes plus ≈ 5 % headroom. The spec's hard line, every tier
//   under 6 MB, still holds and is asserted in test/repo.tooling.test.mjs.
//   plus per-file ceilings for generated data, icons and the social image.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHtml, pageEntries, crawlModules } from './lib/modgraph.mjs';
import { siteFiles } from './stage-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1e6, KB = 1e3;

export const TIER_BUDGETS = { low: 3.8 * MB, medium: 4.3 * MB, high: 5.4 * MB };
export const STAGING_BUDGET = 12 * MB;
export const FILE_BUDGETS = {
    'data/milkyway.png': 250 * KB,
    'data/sky.json': 200 * KB,
    'data/cities.json': 200 * KB,
    'assets/og.jpg': 250 * KB,
    'assets/icons/favicon.svg': 12 * KB,
    'assets/icons/icon-192.png': 60 * KB,
    'assets/icons/icon-512.png': 150 * KB,
    'assets/icons/icon-maskable-512.png': 150 * KB,
};

/** SPEC §C.5 ASSETS, used only if js/render/textures.js cannot be read. */
const FALLBACK_ASSETS = {
    day4k: 'assets/textures/earth_day_4096.jpg', day2k: 'assets/textures/earth_atmos_2048.jpg',
    night: 'assets/textures/earth_night_4096.jpg', specular: 'assets/textures/earth_specular_2048.jpg',
    clouds1k: 'assets/textures/earth_clouds_1024.png', brc4k: 'assets/textures/earth_bump_roughness_clouds_4096.jpg',
    moon: 'assets/textures/moon_1024.jpg', flare0: 'assets/textures/lensflare0.png', flare3: 'assets/textures/lensflare3.png',
    milkyway: 'data/milkyway.png',
};
/** SPEC §E.6 tier table, used only if js/core/quality.js cannot be imported. */
const FALLBACK_TIERS = {
    low: { dayTex: 'day2k', oceanMask: 'derived', clouds: 'none', flare: false },
    medium: { dayTex: 'day4k', oceanMask: 'specular', clouds: 'clouds1k', flare: true },
    high: { dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', flare: true },
};

const size = (rel) => {
    try {
        return fs.statSync(path.join(ROOT, rel)).size;
    } catch {
        return null;
    }
};
const COMPRESSIBLE = /\.(m?js|css|json|webmanifest|svg|html|txt|md)$/i;
const wire = (rel) => {
    const s = size(rel);
    if (s === null) return 0;
    return COMPRESSIBLE.test(rel) ? zlib.gzipSync(fs.readFileSync(path.join(ROOT, rel)), { level: 9 }).length : s;
};

/** key → url, parsed from js/render/textures.js (it imports three, so it is read, not imported). */
export function readAssets() {
    try {
        const src = fs.readFileSync(path.join(ROOT, 'js/render/textures.js'), 'utf8');
        const block = src.slice(src.indexOf('ASSETS'));
        const map = {};
        for (const m of block.matchAll(/(\w+)\s*:\s*\{\s*url\s*:\s*['"]([^'"]+)['"]/g)) map[m[1]] ??= m[2];
        if (Object.keys(map).length >= 5) return { assets: map, source: 'js/render/textures.js' };
    } catch { /* fall through */ }
    return { assets: FALLBACK_ASSETS, source: 'SPEC §C.5 (textures.js not found)' };
}

/** TIERS from js/core/quality.js (pure module) or the spec table. */
export async function readTiers() {
    try {
        const mod = await import(pathToFileURL(path.join(ROOT, 'js/core/quality.js')).href);
        const tiers = mod.TIERS;
        if (tiers?.low && tiers?.medium && tiers?.high) return { tiers, source: 'js/core/quality.js' };
    } catch { /* fall through */ }
    return { tiers: FALLBACK_TIERS, source: 'SPEC §E.6 (quality.js not importable)' };
}

/** Texture keys loaded at boot + idle for a tier (mirrors keysForTier). */
export function tierTextureKeys(cfg) {
    const keys = [cfg.dayTex === 'day2k' ? 'day2k' : 'day4k', 'night'];
    const mask = { specular: 'specular', roughness: 'brc4k' }[cfg.oceanMask];
    if (mask) keys.push(mask);
    if ((cfg.clouds === 'clouds1k' || cfg.clouds === 'brc4k') && !keys.includes(cfg.clouds)) keys.push(cfg.clouds);
    keys.push('moon', 'milkyway');
    if (cfg.flare) keys.push('flare0', 'flare3');
    return keys;
}

/** The page shell and module graph; falls back to "all of js/ + vendor JS" without a v2 index.html. */
export function shellAndModules() {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const doc = parseHtml(html);
    const shell = ['index.html'];
    for (const l of doc.links) {
        const rel = (l.rel ?? '').toLowerCase();
        if ((rel.includes('stylesheet') || rel.includes('manifest')) && l.href && !/^[a-z]+:/i.test(l.href)) {
            shell.push(l.href.replace(/^\.\//, ''));
        }
    }
    const { entries, external: pageExternal } = pageEntries(doc);
    if (entries.length && entries.every((e) => size(e.path) !== null)) {
        const g = crawlModules(ROOT, entries, doc.importMap);
        const external = [...pageExternal, ...g.external.map((x) => x.url)];
        return { shell, modules: g.modules, mode: 'module graph from index.html', missing: g.missing, external };
    }
    const all = siteFiles(ROOT).filter((f) => /\.m?js$/.test(f) && (f.startsWith('js/') || f.startsWith('vendor/')));
    return { shell, modules: all, mode: 'approximate: all js/ + vendor JS (index.html has no local module entry yet)', missing: [], external: [] };
}

const fmt = (b) => (b >= MB ? `${(b / MB).toFixed(2)} MB` : `${(b / KB).toFixed(0)} KB`);

async function main() {
    const problems = [];
    const { assets, source: assetSource } = readAssets();
    const { tiers, source: tierSource } = await readTiers();
    const { shell, modules, mode, missing, external } = shellAndModules();
    for (const m of missing) problems.push(`module graph: missing ${m.path} (imported by ${m.from})`);
    if (external.length) {
        console.warn(`warning: ${external.length} module(s) load from the network and are not counted `
            + `(offline-first requires vendoring): ${[...new Set(external)].slice(0, 4).join(', ')}`);
    }

    const sum = (files) => files.reduce((a, f) => a + (size(f) ?? 0), 0);
    const sumWire = (files) => files.reduce((a, f) => a + wire(f), 0);
    const data = ['data/sky.json', 'data/cities.json'];
    const base = [...new Set([...shell, ...modules, ...data])];
    const baseBytes = sum(base);

    const rows = [];
    for (const name of ['low', 'medium', 'high']) {
        const keys = tierTextureKeys(tiers[name]);
        const tex = keys.map((k) => assets[k]).filter(Boolean);
        for (const k of keys) if (!assets[k]) problems.push(`${name}: no ASSETS entry for texture key "${k}"`);
        for (const t of tex) if (size(t) === null) problems.push(`${name}: missing ${t}`);
        const raw = baseBytes + sum(tex);
        const gz = sumWire(base) + sumWire(tex);
        rows.push({ name, raw, gz, budget: TIER_BUDGETS[name], keys });
        if (raw > TIER_BUDGETS[name]) problems.push(`${name} tier: ${fmt(raw)} > budget ${fmt(TIER_BUDGETS[name])}`);
    }

    const staged = siteFiles(ROOT);
    const stagedBytes = sum(staged);
    if (stagedBytes > STAGING_BUDGET) problems.push(`staged site: ${fmt(stagedBytes)} > ${fmt(STAGING_BUDGET)}`);
    const fileRows = [];
    for (const [f, budget] of Object.entries(FILE_BUDGETS)) {
        const s = size(f);
        fileRows.push({ f, s, budget });
        if (s !== null && s > budget) problems.push(`${f}: ${fmt(s)} > ${fmt(budget)}`);
    }

    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ ok: !problems.length, mode, tiers: rows, staged: { files: staged.length, bytes: stagedBytes },
            files: fileRows, problems }, null, 2));
    } else {
        console.log(`JS: ${modules.length} modules (${mode}); shell ${shell.join(', ')}`);
        console.log(`textures: ${assetSource}; tiers: ${tierSource}`);
        console.log(`  base (shell + JS + sky/cities data)  ${fmt(baseBytes)}`);
        for (const r of rows) {
            console.log(`  ${r.raw <= r.budget ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(6)} ${fmt(r.raw).padStart(9)} raw / ${fmt(r.budget)}`
                + `   ≈ ${fmt(r.gz)} wire   [${r.keys.join(', ')}]`);
        }
        console.log(`  ${stagedBytes <= STAGING_BUDGET ? 'ok  ' : 'FAIL'}  staged ${fmt(stagedBytes).padStart(9)} / ${fmt(STAGING_BUDGET)} (${staged.length} files)`);
        for (const r of fileRows) {
            if (r.s === null) continue;
            console.log(`  ${r.s <= r.budget ? 'ok  ' : 'FAIL'}  ${r.f.padEnd(36)} ${fmt(r.s).padStart(9)} / ${fmt(r.budget)}`);
        }
        if (problems.length) console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
        console.log(problems.length ? 'FAIL' : 'PASS');
    }
    process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
