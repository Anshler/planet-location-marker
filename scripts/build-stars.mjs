#!/usr/bin/env node
// Builds the Hipparcos-derived star data from two pinned, gitignored build inputs
// (vendor/VENDOR.json `cache` entries, fetched by `npm run vendor` into data/raw/cache/):
//
//   heasarc_hipnewcat.tdat.gz  Hipparcos, the New Reduction (van Leeuwen 2007, A&A 474, 653;
//                              2007A&A...474..653V) as NASA HEASARC distributes it: parallaxes,
//                              proper motions and their errors for 117,955 stars.
//   stars.8.json               d3-celestial's Hipparcos stars to V = 8 (BSD-3, the same pinned
//                              commit as data/raw/stars.6.json): J2000 positions, V and B−V.
//
// Outputs (both committed):
//
//   data/raw/hip2.json   the astrometry of the base catalogue's 5,044 stars (stars.6.json ids):
//                        parallel integer arrays sorted by HIP — plx and e_plx (mas × 100), pmra
//                        (μα·cos δ) and pmde (mas/yr × 100). A small build input for
//                        scripts/build-sky.mjs, so data/sky.json and data/starinfo.json stay
//                        reproducible from committed files (test/data.sky.test.mjs).
//   data/stars8.json     the max tier's deeper stars (js/data/catalog.js mergeDeepStars): the
//                        36,367 stars of stars.8.json that stars.6.json does not have (V 6.01–8.00),
//                        sorted brightest first — hip, ra/dec (deg × 1000, J2000), mag (× 100),
//                        bv (× 1000) and plx (mas × 10, −1 when Hipparcos has none or ≤ 0).
//                        Fetched only on the max tier; not part of any tier budget.
//
//   node scripts/build-stars.mjs [--check]     --check: exit 1 if either output would change
//                                              (skipped, exit 0, when the cache is absent)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const CACHE = path.join(RAW, 'cache');
export const HIP_TDAT = path.join(CACHE, 'heasarc_hipnewcat.tdat.gz');
export const STARS8 = path.join(CACHE, 'stars.8.json');
const OUT_HIP = path.join(RAW, 'hip2.json');
const OUT_DEEP = path.join(ROOT, 'data', 'stars8.json');
const MISSING_BV = 600;

/** Packs RA (deg) × scale into [0, 360·scale). */
function packRa(lon, scale) {
    const full = 360 * scale;
    return ((Math.round(lon * scale) % full) + full) % full;
}

/**
 * Parses the HEASARC tdat table: HIP → {plx, eplx, pmra, pmde} (mas, mas/yr).
 * Columns per its `line[1]` header: hip_number name … ra dec lii bii parallax pm_ra pm_dec ra_error
 * dec_error parallax_error …
 * @param {string} text the decompressed table
 * @returns {Map<number, {plx:number, eplx:number, pmra:number, pmde:number}>}
 */
export function parseHipTdat(text) {
    const lines = text.split('\n');
    const header = lines.find((l) => l.startsWith('line[1] = '));
    if (!header) throw new Error('build-stars: no line[1] header in the tdat file');
    const cols = header.slice('line[1] = '.length).trim().split(/\s+/);
    const at = (name) => {
        const i = cols.indexOf(name);
        if (i < 0) throw new Error(`build-stars: column ${name} missing`);
        return i;
    };
    const iHip = at('hip_number'), iPlx = at('parallax'), iPmra = at('pm_ra'), iPmde = at('pm_dec'), iEplx = at('parallax_error');
    const out = new Map();
    let data = false;
    for (const l of lines) {
        if (l.startsWith('<DATA>')) { data = true; continue; }
        if (!data || !l.includes('|')) continue;
        const c = l.split('|');
        const hip = Number(c[iHip]);
        if (!Number.isInteger(hip) || hip <= 0) continue;
        out.set(hip, { plx: Number(c[iPlx]), eplx: Number(c[iEplx]), pmra: Number(c[iPmra]), pmde: Number(c[iPmde]) });
    }
    return out;
}

/**
 * data/raw/hip2.json for the given HIP ids (those Hipparcos has).
 * @param {Iterable<number>} ids
 * @param {Map<number, {plx:number, eplx:number, pmra:number, pmde:number}>} hip
 */
export function buildHip2(ids, hip) {
    const sorted = [...new Set(ids)].filter((h) => hip.has(h)).sort((a, b) => a - b);
    const r100 = (x) => Math.round(x * 100);
    return {
        source: 'Hipparcos, the New Reduction (van Leeuwen 2007, A&A 474, 653), via NASA HEASARC hipnewcat',
        units: 'plx, eplx: mas x 100; pmra (mu_alpha cos delta), pmde: mas/yr x 100',
        n: sorted.length,
        hip: sorted,
        plx: sorted.map((h) => r100(hip.get(h).plx)),
        eplx: sorted.map((h) => r100(hip.get(h).eplx)),
        pmra: sorted.map((h) => r100(hip.get(h).pmra)),
        pmde: sorted.map((h) => r100(hip.get(h).pmde)),
    };
}

/** One array per line (readable diffs). */
export function serializeColumns(obj, arrays) {
    const head = Object.entries(obj).filter(([k]) => !arrays.includes(k)).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
    return `{${head.join(',')},\n${arrays.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`).join(',\n')}}\n`;
}

/**
 * data/stars8.json: the stars of stars.8 that the base catalogue lacks, brightest first.
 * @param {object} stars8 d3-celestial GeoJSON
 * @param {Set<number>} baseIds stars.6.json ids
 * @param {Map<number, {plx:number}>} hip
 */
export function buildDeep(stars8, baseIds, hip) {
    const feats = stars8.features
        .filter((f) => !baseIds.has(f.id) && Number.isFinite(f?.properties?.mag) && Array.isArray(f?.geometry?.coordinates))
        .sort((a, b) => a.properties.mag - b.properties.mag || a.id - b.id);
    const out = { v: 1, epoch: 'J2000', source: 'd3-celestial stars.8 (BSD-3), Hipparcos; parallax: Hipparcos New Reduction (van Leeuwen 2007)',
        n: feats.length, hip: [], ra: [], dec: [], mag: [], bv: [], plx: [] };
    for (const f of feats) {
        const [lon, lat] = f.geometry.coordinates;
        const b = Number.parseFloat(f.properties.bv);
        const p = hip.get(f.id)?.plx;
        out.hip.push(f.id);
        out.ra.push(packRa(lon, 1000));
        out.dec.push(Math.round(lat * 1000));
        out.mag.push(Math.round(f.properties.mag * 100));
        out.bv.push(Number.isFinite(b) ? Math.round(b * 1000) : MISSING_BV);
        out.plx.push(Number.isFinite(p) && p > 0 ? Math.round(p * 10) : -1);
    }
    return out;
}

function main() {
    const check = process.argv.includes('--check');
    if (!fs.existsSync(HIP_TDAT) || !fs.existsSync(STARS8)) {
        const msg = 'build-stars: the cache inputs are missing (data/raw/cache/); run npm run vendor first';
        if (check) { console.log(`${msg} — check skipped`); return; }
        console.error(msg);
        process.exit(1);
    }
    const hip = parseHipTdat(zlib.gunzipSync(fs.readFileSync(HIP_TDAT)).toString('latin1'));
    const stars6 = JSON.parse(fs.readFileSync(path.join(RAW, 'stars.6.json'), 'utf8'));
    const baseIds = new Set(stars6.features.map((f) => f.id));
    const hip2 = serializeColumns(buildHip2(baseIds, hip), ['hip', 'plx', 'eplx', 'pmra', 'pmde']);
    const deep = serializeColumns(buildDeep(JSON.parse(fs.readFileSync(STARS8, 'utf8')), baseIds, hip), ['hip', 'ra', 'dec', 'mag', 'bv', 'plx']);
    if (check) {
        const same = (f, t) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === t;
        if (!same(OUT_HIP, hip2) || !same(OUT_DEEP, deep)) {
            console.error('data/raw/hip2.json or data/stars8.json is out of date — run node scripts/build-stars.mjs');
            process.exit(1);
        }
        console.log('data/raw/hip2.json and data/stars8.json are up to date');
        return;
    }
    fs.writeFileSync(OUT_HIP, hip2);
    fs.writeFileSync(OUT_DEEP, deep);
    console.log(`data/raw/hip2.json: ${(hip2.length / 1024).toFixed(1)} KB; data/stars8.json: ${(deep.length / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
