#!/usr/bin/env node
// Builds data/sky.json from the vendored d3-celestial sources in data/raw/.
//
//   node scripts/build-sky.mjs [--check]
//
// Output format (SPEC §G): integers only, so the JSON stays small and gzips well.
//   stars: parallel arrays sorted brightest first — hip, ra (deg×1000, 0..359999),
//          dec (deg×1000), mag (×100), bv (B−V ×1000; missing → 600)
//   names: [hip, name, constellation, starIndex] for named stars with mag ≤ 3.0
//   cons:  [{id, name, rank, label:[ra×100, dec×100], lines:[[ra×100, dec×100, …], …]}]
//
// d3-celestial stores positions as GeoJSON [lon, lat] with lon = RA in −180..180.
// Serpens is the one constellation split in two (Caput/Cauda); both halves carry the
// d3 id "Ser", so they are emitted as "Ser1"/"Ser2" (the IAU boundary-file convention)
// to keep ids unique — js/data/catalog.js exposes the plain IAU code as `iau`.
//
// --check rebuilds in memory and exits 1 if data/sky.json differs (CI drift guard).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'data', 'sky.json');

const NAME_MAG_LIMIT = 3.0;
const MISSING_BV = 600;

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));

/** Rounds `RA·scale` and wraps into [0, 360·scale) so 359.9996° never becomes 360. */
function packRa(lon, scale) {
    const full = 360 * scale;
    return ((Math.round(lon * scale) % full) + full) % full;
}

/** Packs a GeoJSON polyline into the flat [ra×100, dec×100, …] integer form. */
const packPolyline = (pl) => pl.flatMap(([lon, lat]) => [packRa(lon, 100), Math.round(lat * 100)]);

/** Stars sorted brightest first, as parallel integer arrays. */
function buildStars(starsGeo) {
    const feats = starsGeo.features
        .filter((f) => Number.isFinite(f?.properties?.mag) && Array.isArray(f?.geometry?.coordinates))
        .sort((a, b) => a.properties.mag - b.properties.mag || a.id - b.id);
    const hip = [], ra = [], dec = [], mag = [], bv = [];
    for (const f of feats) {
        const [lon, lat] = f.geometry.coordinates;
        const b = Number.parseFloat(f.properties.bv);
        hip.push(f.id);
        ra.push(packRa(lon, 1000));
        dec.push(Math.round(lat * 1000));
        mag.push(Math.round(f.properties.mag * 100));
        bv.push(Number.isFinite(b) ? Math.round(b * 1000) : MISSING_BV);
    }
    return { feats, packed: { n: hip.length, hip, ra, dec, mag, bv } };
}

/** Proper names of the bright stars, in star (magnitude) order. */
function buildNames(feats, starnames) {
    const names = [];
    feats.forEach((f, i) => {
        if (f.properties.mag > NAME_MAG_LIMIT) return;
        const entry = starnames[String(f.id)];
        const name = entry?.name?.trim();
        if (name) names.push([f.id, name, entry.c || '', i]);
    });
    return names;
}

/**
 * Constellations: label points from constellations.json, figures from the lines file.
 * Both files list the two Serpens halves (same d3 id) in the same order, so figures are
 * matched per id in order of appearance.
 */
function buildCons(linesGeo, consGeo) {
    const figures = new Map();
    for (const lf of linesGeo.features) {
        if (!figures.has(lf.id)) figures.set(lf.id, []);
        figures.get(lf.id).push(lf);
    }
    const labelCount = new Map();
    for (const f of consGeo.features) labelCount.set(f.id, (labelCount.get(f.id) ?? 0) + 1);
    const used = new Map();
    return consGeo.features.map((f) => {
        const d3id = f.id;
        const n = (used.get(d3id) ?? 0) + 1;
        used.set(d3id, n);
        const lf = figures.get(d3id)?.[n - 1];
        if (!lf) throw new Error(`build-sky: no line figure #${n} for constellation ${d3id}`);
        const [lon, lat] = f.geometry.coordinates;
        const polylines = lf.geometry.type === 'LineString' ? [lf.geometry.coordinates] : lf.geometry.coordinates;
        return {
            id: labelCount.get(d3id) > 1 ? `${d3id}${n}` : d3id,
            name: f.properties.name,
            rank: Number.parseInt(f.properties.rank, 10) || 3,
            label: [packRa(lon, 100), Math.round(lat * 100)],
            lines: polylines.filter((pl) => pl.length >= 2).map(packPolyline),
        };
    });
}

/**
 * Builds the sky.json object from the four raw d3-celestial documents.
 * @param {{stars:object, starnames:object, lines:object, cons:object}} raw parsed GeoJSON/JSON
 * @returns {object} the sky.json document
 */
export function buildSky({ stars, starnames, lines, cons }) {
    const { feats, packed } = buildStars(stars);
    return {
        v: 1,
        epoch: 'J2000',
        source: 'd3-celestial (BSD-3), Hipparcos',
        stars: packed,
        names: buildNames(feats, starnames),
        cons: buildCons(lines, cons),
    };
}

/**
 * Serialises compactly, with one star array / constellation per line so diffs stay readable.
 * @param {object} sky
 * @returns {string}
 */
export function serializeSky(sky) {
    const s = sky.stars;
    const starArrays = ['hip', 'ra', 'dec', 'mag', 'bv'].map((k) => `${JSON.stringify(k)}:${JSON.stringify(s[k])}`);
    return [
        `{"v":${sky.v},"epoch":${JSON.stringify(sky.epoch)},"source":${JSON.stringify(sky.source)},`,
        `"stars":{"n":${s.n},`,
        starArrays.join(',\n'),
        '},',
        `"names":${JSON.stringify(sky.names)},`,
        '"cons":[',
        sky.cons.map((c) => JSON.stringify(c)).join(',\n'),
        ']}',
    ].join('\n') + '\n';
}

function main() {
    const sky = buildSky({
        stars: readJson('stars.6.json'),
        starnames: readJson('starnames.json'),
        lines: readJson('constellations.lines.json'),
        cons: readJson('constellations.json'),
    });
    const text = serializeSky(sky);
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (cur !== text) {
            console.error('data/sky.json is out of date — run: node scripts/build-sky.mjs');
            process.exit(1);
        }
        console.log('data/sky.json is up to date');
        return;
    }
    fs.writeFileSync(OUT, text);
    const segs = sky.cons.reduce((a, c) => a + c.lines.reduce((b, l) => b + l.length / 2 - 1, 0), 0);
    console.log(`data/sky.json: ${sky.stars.n} stars, ${sky.names.length} names, ${sky.cons.length} constellations, `
        + `${segs} segments, ${(text.length / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
