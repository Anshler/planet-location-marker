#!/usr/bin/env node
// Builds data/cities.json (the offline city list) from GeoNames.
//
//   node scripts/build-cities.mjs [--refresh] [--offline]
//
// Sources (cached in data/raw/geonames/, which is gitignored):
//   cities15000.zip       all places with population > 15 000 (and capitals)
//   countryInfo.txt       ISO code → country name
//   admin1CodesASCII.txt  "CC.code" → first-level admin name (state/province)
//   timeZones.txt         IANA zone → country code and current offsets
// GeoNames data is © GeoNames, licensed CC BY 4.0 (https://www.geonames.org/).
//
// Selection (SPEC §G) is the union of:
//   * capitals (feature code PPLC)
//   * every city with population ≥ 500 000
//   * the 3 most populous cities of each country
//   * the most populous city of each IANA time zone (so a time-zone guess always lands
//     on a real, recognisable city — e.g. Asia/Ho_Chi_Minh → Ho Chi Minh City)
//
// Zone normalisation: GeoNames follows tzdata's zone1970 merges, so e.g. Hanoi carries
// Asia/Bangkok — which would make Hanoi the "largest city" of Thailand's zone and greet
// Thai users with Vietnam. Before selection, a city whose zone belongs to another country
// (per timeZones.txt) is moved to its own country's zone when that country has exactly one
// zone with identical current offsets (Hanoi → Asia/Ho_Chi_Minh, as in the spec example).
//
// Output: {"v":1,"source":…,"retrieved":"YYYY-MM-DD","countries":{CC:name},
//          "fields":["name","ascii","cc","admin","lat","lon","tz","pop"], "rows":[…]}
// Rows are sorted by population (descending); coordinates have 4 decimals.
//
// --refresh  re-download the cached sources      --offline  never download (fail if missing)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntry } from './lib/zip.mjs';
import { download } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'raw', 'geonames');
const OUT = path.join(ROOT, 'data', 'cities.json');
const BASE_URL = 'https://download.geonames.org/export/dump/';
export const SOURCES = ['cities15000.zip', 'countryInfo.txt', 'admin1CodesASCII.txt', 'timeZones.txt'];

export const POP_THRESHOLD = 500000;
export const TOP_PER_COUNTRY = 3;
export const FIELDS = ['name', 'ascii', 'cc', 'admin', 'lat', 'lon', 'tz', 'pop'];

/**
 * Parses GeoNames cities*.txt (tab-separated, 19 columns).
 * @param {string} text
 * @returns {{id:number,name:string,ascii:string,lat:number,lon:number,fcode:string,cc:string,admin1:string,pop:number,tz:string}[]}
 */
export function parseCities(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const c = line.split('\t');
        if (c.length < 18) continue;
        out.push({
            id: Number(c[0]),
            name: c[1],
            ascii: c[2] || c[1],
            lat: Number(c[4]),
            lon: Number(c[5]),
            fcode: c[7],
            cc: c[8],
            admin1: c[10],
            pop: Number(c[14]) || 0,
            tz: c[17],
        });
    }
    return out;
}

/** Parses countryInfo.txt → {ISO2: name}. */
export function parseCountries(text) {
    const map = {};
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const c = line.split('\t');
        if (c[0]?.length === 2 && c[4]) map[c[0]] = c[4].trim();
    }
    return map;
}

/** Parses admin1CodesASCII.txt → {"CC.code": name}. */
export function parseAdmin1(text) {
    const map = {};
    for (const line of text.split('\n')) {
        const c = line.split('\t');
        if (c.length >= 2 && c[0]) map[c[0]] = c[1].trim();
    }
    return map;
}

/**
 * Parses timeZones.txt → {zone: {cc, gmt, dst}} (header line skipped).
 * @param {string} text
 * @returns {Record<string, {cc:string, gmt:number, dst:number}>}
 */
export function parseTimeZones(text) {
    const map = {};
    for (const line of text.split('\n').slice(1)) {
        const c = line.split('\t');
        if (c.length >= 4 && c[1]) map[c[1].trim()] = { cc: c[0], gmt: Number(c[2]), dst: Number(c[3]) };
    }
    return map;
}

/**
 * Moves cities off a foreign country's zone onto their own country's single zone (see
 * header). Returns new objects; input is not mutated.
 * @param {ReturnType<typeof parseCities>} cities
 * @param {ReturnType<typeof parseTimeZones>} zones
 * @returns {{cities:ReturnType<typeof parseCities>, moved:{name:string, cc:string, from:string, to:string}[]}}
 */
export function normaliseZones(cities, zones) {
    const zonesByCountry = new Map();
    for (const [tz, z] of Object.entries(zones)) {
        if (!zonesByCountry.has(z.cc)) zonesByCountry.set(z.cc, []);
        zonesByCountry.get(z.cc).push(tz);
    }
    const moved = [];
    const out = cities.map((c) => {
        const z = zones[c.tz];
        if (!z || z.cc === c.cc) return c;
        const own = zonesByCountry.get(c.cc);
        if (own?.length !== 1) return c;
        const target = zones[own[0]];
        if (target.gmt !== z.gmt || target.dst !== z.dst) return c;
        moved.push({ name: c.name, cc: c.cc, from: c.tz, to: own[0] });
        return { ...c, tz: own[0] };
    });
    return { cities: out, moved };
}

const byPopDesc = (a, b) => b.pop - a.pop || a.name.localeCompare(b.name) || a.id - b.id;

/**
 * Picks the city set (see header) from parsed GeoNames rows.
 * @param {ReturnType<typeof parseCities>} cities
 * @returns {ReturnType<typeof parseCities>} selected cities, most populous first
 */
export function selectCities(cities) {
    const valid = cities.filter((c) => c.name && c.cc && c.tz && Number.isFinite(c.lat) && Number.isFinite(c.lon)
        && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180);
    const sorted = valid.slice().sort(byPopDesc);
    const keep = new Set();
    const perCountry = new Map();
    const perTz = new Set();
    for (const c of sorted) {
        if (c.fcode === 'PPLC' || c.pop >= POP_THRESHOLD) keep.add(c);
        const n = perCountry.get(c.cc) ?? 0;
        if (n < TOP_PER_COUNTRY) {
            keep.add(c);
            perCountry.set(c.cc, n + 1);
        }
        if (!perTz.has(c.tz)) {
            keep.add(c);
            perTz.add(c.tz);
        }
    }
    return sorted.filter((c) => keep.has(c));
}

/** Rounds to 4 decimals (≈ 11 m), avoiding "-0". */
const r4 = (x) => Math.round(x * 1e4) / 1e4 || 0;

/**
 * Builds the cities.json document.
 * @param {{cities:ReturnType<typeof parseCities>, countries:Record<string,string>, admin1:Record<string,string>, retrieved?:string}} src
 * @returns {object}
 */
export function buildCities({ cities, countries, admin1, retrieved }) {
    const picked = selectCities(cities);
    const usedCountries = {};
    const rows = picked.map((c) => {
        usedCountries[c.cc] = countries[c.cc] ?? c.cc;
        const admin = admin1[`${c.cc}.${c.admin1}`] ?? '';
        return [c.name, c.ascii, c.cc, admin, r4(c.lat), r4(c.lon), c.tz, c.pop];
    });
    const sortedCountries = Object.fromEntries(Object.entries(usedCountries).sort(([a], [b]) => a.localeCompare(b)));
    return {
        v: 1,
        source: 'GeoNames cities15000 (CC BY 4.0)',
        ...(retrieved ? { retrieved } : {}),
        countries: sortedCountries,
        fields: FIELDS,
        rows,
    };
}

/** One row per line keeps the file diffable while staying compact. */
export function serializeCities(doc) {
    const head = { ...doc };
    delete head.rows;
    const headJson = JSON.stringify(head);
    return `${headJson.slice(0, -1)},\n"rows":[\n${doc.rows.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}

async function ensureSources({ refresh, offline }) {
    fs.mkdirSync(CACHE, { recursive: true });
    for (const name of SOURCES) {
        const file = path.join(CACHE, name);
        if (fs.existsSync(file) && !refresh) continue;
        if (offline) throw new Error(`missing ${path.relative(ROOT, file)} (run without --offline to download)`);
        process.stdout.write(`downloading ${BASE_URL}${name} … `);
        const buf = await download(BASE_URL + name);
        fs.writeFileSync(file, buf);
        console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    }
}

async function main() {
    const refresh = process.argv.includes('--refresh');
    const offline = process.argv.includes('--offline');
    await ensureSources({ refresh, offline });
    const zip = fs.readFileSync(path.join(CACHE, 'cities15000.zip'));
    const cities = parseCities(readZipEntry(zip, 'cities15000.txt').toString('utf8'));
    const countries = parseCountries(fs.readFileSync(path.join(CACHE, 'countryInfo.txt'), 'utf8'));
    const admin1 = parseAdmin1(fs.readFileSync(path.join(CACHE, 'admin1CodesASCII.txt'), 'utf8'));
    const zones = parseTimeZones(fs.readFileSync(path.join(CACHE, 'timeZones.txt'), 'utf8'));
    const retrieved = fs.statSync(path.join(CACHE, 'cities15000.zip')).mtime.toISOString().slice(0, 10);
    const norm = normaliseZones(cities, zones);
    const movedSummary = new Map();
    for (const m of norm.moved) {
        const key = `${m.cc} ${m.from} → ${m.to}`;
        movedSummary.set(key, (movedSummary.get(key) ?? 0) + 1);
    }
    for (const [key, n] of movedSummary) console.log(`  zone normalised: ${key} (${n} places)`);
    const doc = buildCities({ cities: norm.cities, countries, admin1, retrieved });
    const text = serializeCities(doc);
    fs.writeFileSync(OUT, text);
    const zoneCount = new Set(doc.rows.map((r) => r[6])).size;
    console.log(`data/cities.json: ${doc.rows.length} cities (of ${cities.length}), ${Object.keys(doc.countries).length} countries, `
        + `${zoneCount} time zones, ${(text.length / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(`build-cities: ${err.message}`);
        process.exit(1);
    });
}
