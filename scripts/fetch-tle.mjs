#!/usr/bin/env node
// Writes data/tle.json: current two-line element sets for the satellites in js/astro/satellites.js
// (SAT_INFO: the ISS, Tiangong, Hubble and three Zenit-2 stages), from CelesTrak's GP service.
//
//   node scripts/fetch-tle.mjs [--out=path] [--timeout=ms]
//
// The page never fetches CelesTrak: this runs at build time, and daily in the Pages deploy
// workflow (.github/workflows/pages.yml), which writes the fresh file into the staged site
// (`--out=_site/data/tle.json`) without committing it. The committed data/tle.json is the
// fallback when CelesTrak is unreachable.
//
// Source: CelesTrak (T.S. Kelso), https://celestrak.org/NORAD/elements/gp.php?CATNR=<n>&FORMAT=TLE,
// the 18th Space Defense Squadron's general-perturbations element sets as CelesTrak redistributes
// them. One request per object, once a day at most, as CelesTrak asks.
//
// Every set is checked before it is written: both checksums, the catalogue number, a near-Earth
// orbit that SGP4 initialises, and an epoch less than 30 days old. A set that fails (or a request
// that fails) keeps that object's entry from the existing file. Exit code 2 when nothing new could
// be fetched (the output is then left untouched).
//
// Output: {"v":1,"source":…,"retrieved":"YYYY-MM-DDTHH:MMZ","sats":[{"key","norad","name","l1","l2"},…]}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAT_INFO } from '../js/astro/satellites.js';
import { parseTle, sgp4init } from '../js/astro/sgp4.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'tle.json');
const API = 'https://celestrak.org/NORAD/elements/gp.php';
const MAX_AGE_DAYS = 30;
export const SOURCE = 'CelesTrak GP element sets (celestrak.org, T.S. Kelso; 18th Space Defense Squadron data)';

/**
 * Picks and validates one element set from a CelesTrak FORMAT=TLE response (name line + 2 lines).
 * @param {string} text
 * @param {number} norad
 * @param {number} [nowMs]
 * @returns {{name:string, l1:string, l2:string}}
 * @throws {Error} when no valid set for `norad` is found
 */
export function pickTle(text, norad, nowMs = Date.now()) {
    const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
    for (let i = 0; i + 1 < lines.length; i++) {
        if (!lines[i].startsWith('1 ') || !lines[i + 1].startsWith('2 ')) continue;
        const el = parseTle(lines[i], lines[i + 1]);   // throws on a checksum mismatch
        if (el.satnum !== norad) continue;
        const rec = sgp4init(el);
        if (rec.error) throw new Error(`NORAD ${norad}: SGP4 cannot use it (${rec.error})`);
        const ageDays = (nowMs - el.epochMs) / 86400000;
        if (ageDays > MAX_AGE_DAYS) throw new Error(`NORAD ${norad}: elements are ${ageDays.toFixed(1)} days old`);
        const name = i > 0 && lines[i - 1] && !/^[12] /.test(lines[i - 1]) ? lines[i - 1].trim() : '';
        return { name, l1: lines[i], l2: lines[i + 1] };
    }
    throw new Error(`NORAD ${norad}: no element set in the response`);
}

async function fetchText(url, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'planet-location-marker fetch-tle (daily)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
    const out = path.resolve(arg('out', DEFAULT_OUT));
    const timeoutMs = Number(arg('timeout', 20000));
    let previous = null;
    for (const p of [out, DEFAULT_OUT]) {
        try { previous = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch { /* none yet */ }
    }
    const prevByKey = new Map((previous?.sats ?? []).map((s) => [s.key, s]));
    const sats = [];
    let fresh = 0;
    for (const [key, info] of Object.entries(SAT_INFO)) {
        try {
            const text = await fetchText(`${API}?CATNR=${info.norad}&FORMAT=TLE`, timeoutMs);
            const t = pickTle(text, info.norad);
            sats.push({ key, norad: info.norad, name: t.name || info.full, l1: t.l1, l2: t.l2 });
            fresh++;
        } catch (err) {
            const old = prevByKey.get(key);
            console.warn(`[fetch-tle] ${key} (NORAD ${info.norad}): ${err.message}${old ? '; keeping the previous elements' : '; left out'}`);
            if (old) sats.push(old);
        }
    }
    if (!fresh) {
        console.error('[fetch-tle] nothing could be fetched; the output is unchanged');
        process.exit(2);
    }
    const json = { v: 1, source: SOURCE, retrieved: new Date().toISOString().slice(0, 16) + 'Z', sats };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(json, null, 1) + '\n');
    const epochs = sats.map((s) => `${s.key} ${s.l1.slice(18, 32).trim()}`).join(', ');
    console.log(`[fetch-tle] ${fresh}/${Object.keys(SAT_INFO).length} fresh → ${path.relative(ROOT, out)} (${epochs})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error('[fetch-tle]', err); process.exit(1); });
}
