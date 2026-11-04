#!/usr/bin/env node
// Transfer-size budgets (SPEC §E.6), enforced in CI:  node scripts/check-size.mjs [--json]
//
// Per quality tier, the initial download is: the page shell (index.html, CSS, manifest),
// the ES-module graph actually reachable from index.html (crawled through the importmap,
// incl. the astro worker), the data files and that tier's textures (same selection rules
// as keysForTier in js/core/texture-plan.js, driven by TIERS from js/core/quality.js).
// Raw bytes on disk are budgeted (1 MB = 10⁶ B); gzip "wire" sizes are informational
// (GitHub Pages compresses JS/CSS/JSON/SVG/HTML).
//
//   low ≤ 5.0 MB · medium ≤ 5.79 MB · high ≤ 8 MB · staged site ≤ 32 MB
//   (Phase 6 historic-skies, Halley and the spacecraft add ≈ 140 KB of shared JS: the extras
//   selection model, Julian calendar, guest stars, comets and craft, raised by that plus 5 %.)
//   SPEC §E.6 set 3.0 / 3.6 / 4.8 MB from an estimate of ≈ 1.35 MB of JavaScript. The shipped,
//   unminified-by-design module graph (no build step) measures ≈ 2.0 MB raw incl. CSS
//   (≈ 0.6 MB gzipped; three.js + astronomy-engine alone are 1.17 MB raw), so the budgets were
//   re-baselined to the measured sizes plus ≈ 5 % headroom. The derived 2k maps
//   (scripts/build-textures.mjs) then took low from 3.71 to 3.22 MB (incl. the 56 KB water
//   mask it shares with medium) and medium from 4.21 to 4.05 MB, and low and medium were
//   lowered to lock that in. The spec's hard line is asserted in test/repo.tooling.test.mjs: low and
//   medium stay under 6 MB; high may reach 8 MB (raised by the owner on 2026-11-05 to make room for
//   the v2.1 features, since high is the desktop/discrete-GPU tier).
//   plus per-file ceilings for generated data, icons and the social image.
//
//   max (manual only, "no budget") is reported for information and never fails the check. Its
//   8192 px maps (≈ 15.2 MB) took the staged site from ≈ 6.4 to ≈ 21.6 MB: the staging budget
//   went from 12 to 32 MB (≈ 10 MB headroom), still far inside GitHub Pages' 1 GB site limit.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHtml, pageEntries, pageModules } from './lib/modgraph.mjs';
import { siteFiles } from './stage-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1e6, KB = 1e3;

// Phase 1 (Eclipse 2027): eclipse path, contacts and framing (≈ 35 KB), totality (≈ 48 KB), and the globe's path ribbon,
// shadow chase and eclipse-aware pin (≈ 46 KB) raise every tier.
// Phase 2 (sky view 2.0): the illustrative landscape, twilight-lit ground and drawn refraction (≈ 45 KB of JS) plus the
// night-sky model (skyglow, ≈ 40 KB) on every tier; medium and high also dropped the two lens-flare textures (68 KB).
// Phase 3 (planets): medallions, the shared impostor shader, the eyepiece card, Galilean moons and libration (≈ 80 KB of JS)
// and Phase 4 (globe): aurora, moonlight, close-zoom lights and sculpted clouds (≈ 48 KB of JS and GLSL, no textures).
// Phase 3 (sky): sidereal tracking, the telescope zoom (true-scale impostors, Jupiter's moons, aperture gain) and the retrograde time-lapse (≈ 43 KB of JS).
// High: 5.73 → 8 MB, the owner's new ceiling for that tier (low and medium keep tight budgets).
// Phase 5 (capture): long-exposure stacking (accum pass, controller, presets) and the postcard / Save image path
// (capture, band, dialogs; ≈ 86 KB of JS and CSS on every tier): low 3.76 → 3.86, medium 4.52 → 4.62 MB (high has room).
// Phase 5 (guided tours): the tour runner and builders (loaded on demand, but crawled), the catalogue, the lower third,
// the Events-tab entry and CSS (≈ 57 KB) raise low and medium by 60 KB (+5 %).
// Phase 5 (vantage points): View from L1 and Earthrise (astro/vantage.js, the rig's vantage flights, the lunar close-up
// relief, menu and caption; ≈ 46 KB of JS, GLSL and CSS) raise low and medium by ≈ 48 KB.
// Phase 5 (find it in the real sky): off-screen pointers, the angle ruler, 'find it' guidance and 'Point at the sky'
// (sky-guide, edge chips, ruler, aim, sky tools and CSS; ≈ 85 KB of JS and CSS) raise low and medium by 90 KB (+5 %).
// Phase 5 (quality): idle supersampling, fast-time star streaks and the time-lapse video export (recorder and MP4
// muxer loaded on demand, but crawled; ≈ 93 KB of JS, GLSL and CSS) raise low and medium by 0.10 MB (+5 %).
// Phase 5 (views): the globe → world-map morph (geo/mapview.js, the rig's map mode, the map shaders' twilight
// lines, picking, map labels) and two observers (astro/parallax.js, the second pin and beams, Sky now's comparison,
// the palette's compare mode; ≈ 80 KB of JS, GLSL and CSS on every tier) raise low and medium by 80 KB + 5 %.
// Phase 5 (solar-system zoom): the orrery (render/orrery.js + GLSL, astro/orrery.js, the rig's system mode, overlay
// pass, labels and UI; ≈ 101 KB of JS).
// Phase 5 batch 2 re-baseline (find it in the real sky, quality, views, solar-system zoom, all four merged): measured low 4.30 / medium 5.06 MB, budgets + ~2.5 %.
// Phase 6 (deep sky): catalogue-star picking and cards, deep-sky objects and sprites, proper motion and the precession layer
// (≈ 95 KB of JS plus 16 KB of proper motions in sky.json, ≈ 110 KB on every tier) raise low and medium by 120 KB (+5 %).
// Phase 6 (events, meteors, year planner, Sun paths): more event sources, the meteor-shower table and generator, the year
// planner and the Sun's paths (astro/meteors.js, planner.js, sunpath.js, render/meteors.js, sunpath.js, ui/year-planner.js; ≈ 117 KB
// of JS and CSS on every tier) raise low and medium by 125 KB (+5 %).
// Phase 6 (live satellites): near-Earth SGP4, the satellite provider and pass search, their render module and the
// passes UI (astro/sgp4.js, astro/satellites.js, render/satellites.js, ui/sat-passes.js; ≈ 90 KB of JS and CSS on every
// tier) raise low and medium by 95 KB (+5 %).
// Phase 6 (stand on Mars): the Mars sky snapshot, clock and landing sites, Phobos and Deimos, the Mars dome and home
// beam (astro/host-mars.js, mars-clock.js, render/mars-sky.js + GLSL, app/mars-host.js; lazy, but crawled) and the
// host-aware UI (≈ 101 KB of JS, GLSL and CSS on every tier) raise low and medium by 105 KB (+5 %).
export const TIER_BUDGETS = { low: 5000 * KB, medium: 5790 * KB, high: 8 * MB };
/** Tiers that are measured and printed but have no budget (max: a deliberate, manual choice). */
export const INFO_TIERS = ['max'];
// The max tier's 8192 px maps (≈ 15.2 MB) ship with the site; 32 MB keeps headroom (Pages allows 1 GB).
export const STAGING_BUDGET = 32 * MB;
export const FILE_BUDGETS = {
    'data/milkyway.png': 250 * KB,
    'data/sky.json': 200 * KB,
    'data/cities.json': 200 * KB,
    // The spacecraft ephemerides (scripts/build-craft.mjs; fetched after boot, precached by sw.js).
    'data/craft.json': 48 * KB,
    // The satellites' element sets (scripts/fetch-tle.mjs; fetched after boot, network-first in sw.js).
    'data/tle.json': 4 * KB,
    // The deep-sky showpieces (scripts/build-dso.mjs; fetched after boot, precached by sw.js).
    'data/dso.json': 16 * KB,
    // Star designations and parallaxes (scripts/build-sky.mjs; fetched on the first star selection, precached).
    'data/starinfo.json': 160 * KB,
    // The max tier's deeper stars (scripts/build-stars.mjs; fetched on max only, outside every tier budget).
    'data/stars8.json': 1300 * KB,
    // The 512 px Earth previews (scripts/build-textures.mjs): they ride ahead of the module graph, so they stay tiny.
    'assets/textures/earth_day_preview.webp': 16 * KB,
    'assets/textures/earth_night_preview.webp': 10 * KB,
    'assets/og.jpg': 250 * KB,
    'assets/icons/favicon.svg': 12 * KB,
    'assets/icons/icon-192.png': 60 * KB,
    'assets/icons/icon-512.png': 150 * KB,
    'assets/icons/icon-maskable-512.png': 150 * KB,
};

/** SPEC §C.5 ASSETS, used only if js/render/textures.js cannot be read. */
const FALLBACK_ASSETS = {
    dayPreview: 'assets/textures/earth_day_preview.webp', nightPreview: 'assets/textures/earth_night_preview.webp',
    day4k: 'assets/textures/earth_day_4096.jpg', day2k: 'assets/textures/earth_day_2048.webp',
    night4k: 'assets/textures/earth_night_4096.jpg', night2k: 'assets/textures/earth_night_2048.webp',
    roughness2k: 'assets/textures/earth_roughness_2048.webp', clouds2k: 'assets/textures/earth_clouds_2048.webp',
    brc4k: 'assets/textures/earth_bump_roughness_clouds_4096.jpg', moon: 'assets/textures/moon_1024.jpg',
    milkyway: 'data/milkyway.png',
    day8k: 'assets/textures/earth_day_8192.jpg', night8k: 'assets/textures/earth_night_8192.jpg',
    clouds8k: 'assets/textures/earth_clouds_8192.webp', moon4k: 'assets/textures/moon_4096.webp',
};
/** SPEC §E.6 tier table, used only if js/core/quality.js cannot be imported. */
const FALLBACK_TIERS = {
    low: { dayTex: 'day2k', oceanMask: 'roughness2k', clouds: 'none', flare: false },
    medium: { dayTex: 'day4k', oceanMask: 'roughness2k', clouds: 'clouds2k', flare: true },
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

/** key → url, parsed from js/core/texture-plan.js (read, not imported, so this stays synchronous). */
export function readAssets() {
    try {
        const src = fs.readFileSync(path.join(ROOT, 'js/core/texture-plan.js'), 'utf8');
        const block = src.slice(src.indexOf('export const ASSETS'));
        const map = {};
        for (const m of block.matchAll(/(\w+)\s*:\s*\{\s*url\s*:\s*['"]([^'"]+)['"]/g)) map[m[1]] ??= m[2];
        if (Object.keys(map).length >= 5) return { assets: map, source: 'js/core/texture-plan.js' };
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

/** A max-tier map's 4096 stand-in, loaded first (mirrors INTERIM in js/core/texture-plan.js). */
const INTERIM = { day8k: 'day4k', night8k: 'night4k', clouds8k: 'brc4k', moon4k: 'moon' };

/**
 * Texture keys loaded at boot + idle for a tier (mirrors keysForTier: the previews first, the night
 * map follows the day map, and a max map comes after its 4096 stand-in, which takes its place in
 * the order). test/repo.textures.test.mjs checks it against the real keysForTier.
 */
export function tierTextureKeys(cfg) {
    const day = cfg.dayTex === 'day2k' ? 'day2k' : cfg.dayTex === 'day8k' ? 'day8k' : 'day4k';
    const night = { day2k: 'night2k', day4k: 'night4k', day8k: 'night8k' }[day];
    const clouds = ['clouds2k', 'brc4k', 'clouds8k'].includes(cfg.clouds) ? cfg.clouds : null;
    const moon = cfg.moonTex === 'moon4k' ? 'moon4k' : 'moon';
    const stand = (k) => INTERIM[k] ?? k;
    const keys = ['dayPreview', 'nightPreview', stand(day), stand(night)];
    const push = (k) => { if (k && !keys.includes(k)) keys.push(k); };
    push({ roughness2k: 'roughness2k', roughness: 'brc4k' }[cfg.oceanMask]);
    push(stand(clouds));
    push(stand(moon));
    push('milkyway');
    for (const k of [day, night, clouds, moon]) if (INTERIM[k]) push(k);
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
    const { entries } = pageEntries(doc);
    if (entries.length && entries.every((e) => size(e.path) !== null)) {
        const g = pageModules(ROOT);
        return { shell, modules: g.modules, mode: 'module graph from index.html', missing: g.missing, external: g.external };
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
    for (const name of ['low', 'medium', 'high', ...INFO_TIERS]) {
        if (!tiers[name]) continue;
        const keys = tierTextureKeys(tiers[name]);
        const tex = keys.map((k) => assets[k]).filter(Boolean);
        for (const k of keys) if (!assets[k]) problems.push(`${name}: no ASSETS entry for texture key "${k}"`);
        for (const t of tex) if (size(t) === null) problems.push(`${name}: missing ${t}`);
        const raw = baseBytes + sum(tex);
        const gz = sumWire(base) + sumWire(tex);
        const budget = TIER_BUDGETS[name] ?? null;
        rows.push({ name, raw, gz, budget, keys });
        if (budget !== null && raw > budget) problems.push(`${name} tier: ${fmt(raw)} > budget ${fmt(budget)}`);
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
            const verdict = r.budget === null ? 'info' : r.raw <= r.budget ? 'ok  ' : 'FAIL';
            const limit = r.budget === null ? 'no budget' : fmt(r.budget);
            console.log(`  ${verdict}  ${r.name.padEnd(6)} ${fmt(r.raw).padStart(9)} raw / ${limit}`
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
