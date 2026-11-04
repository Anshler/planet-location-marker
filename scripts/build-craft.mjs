#!/usr/bin/env node
// Builds data/craft.json: compact ephemerides of Voyager 1 and 2, New Horizons and JWST.
//
//   node scripts/build-craft.mjs [--refresh] [--offline]
//
// Source: JPL Horizons (NASA/JPL-Caltech; https://ssd.jpl.nasa.gov/horizons/), heliocentric
// geometric state vectors (CENTER 500@10, ICRF, AU and AU/day, TDB). The raw responses are cached
// in data/raw/horizons/ (gitignored). Horizons' coverage: Voyager 1 1977-09-05 → 2100,
// Voyager 2 1977-08-20 → 2100, New Horizons 2006-01-19 → 2050, JWST 2021-12-25 → 2031-11-02.
//
// Sampling: a dense grid (4 days on the cruise, 2 h within ±6 days of each planetary flyby,
// 1 day for JWST) is thinned to adaptive knots: the interval between two knots is split at its
// worst sample until cubic Hermite interpolation of the knots' positions and velocities
// (js/astro/craft.js `hermite`) stays within TOL of every sample: 1e-5 × the distance from the
// Earth (≈ 4″), but at least 1.2e-5 AU (1,800 km). Knots store days after t0 (5 decimals) and
// integers in 1e-6 AU and 1e-8 AU/day.
//
// Output: {"v":1,"source":…,"retrieved":"YYYY-MM-DD","units":…,"craft":[{"id","launch","t0","k":[[dt,x,y,z,vx,vy,vz],…]}]}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermite } from '../js/astro/craft.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'raw', 'horizons');
const OUT = path.join(ROOT, 'data', 'craft.json');
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/** Horizons ids, launch (UTC), coverage, and flybys (dense windows). */
export const CRAFT = [
    { id: 'voyager1', cmd: '-31', launch: '1977-09-05T12:56:00Z', start: '1977-09-06', stop: '2100-01-01', step: '4 d',
        flybys: ['1979-03-05', '1980-11-12'] },
    { id: 'voyager2', cmd: '-32', launch: '1977-08-20T14:29:00Z', start: '1977-08-21', stop: '2100-01-01', step: '4 d',
        flybys: ['1979-07-09', '1981-08-26', '1986-01-24', '1989-08-25'] },
    { id: 'newhorizons', cmd: '-98', launch: '2006-01-19T19:00:00Z', start: '2006-01-20', stop: '2050-01-01', step: '4 d',
        flybys: ['2007-02-28', '2015-07-14', '2019-01-01'] },
    { id: 'jwst', cmd: '-170', launch: '2021-12-25T12:20:00Z', start: '2021-12-26', stop: '2031-11-01', step: '1 d', flybys: [] },
];

const POS_UNIT = 1e-6;
const VEL_UNIT = 1e-8;

/** Parses Horizons CSV vectors (VEC_TABLE 2): rows of [jd, x, y, z, vx, vy, vz]. */
export function parseVectors(text) {
    const m = /\$\$SOE([\s\S]*?)\$\$EOE/.exec(text);
    if (!m) throw new Error(`Horizons: no ephemeris in the response:\n${text.slice(0, 600)}`);
    const rows = [];
    for (const line of m[1].split('\n')) {
        const c = line.split(',').map((s) => s.trim());
        if (c.length < 8) continue;
        const jd = Number(c[0]);
        const v = c.slice(2, 8).map(Number);
        if (Number.isFinite(jd) && v.every(Number.isFinite)) rows.push([jd, ...v]);
    }
    return rows;
}

async function fetchVectors(cmd, start, stop, step, { refresh, offline }) {
    const key = `${cmd}_${start}_${stop}_${step.replace(/\s+/g, '')}.txt`;
    const file = path.join(CACHE, key);
    if (!refresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    if (offline) throw new Error(`missing cached Horizons response ${file} (run without --offline)`);
    const p = new URLSearchParams({
        format: 'text', COMMAND: `'${cmd}'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS',
        CENTER: "'500@10'", START_TIME: `'${start}'`, STOP_TIME: `'${stop}'`, STEP_SIZE: `'${step}'`,
        VEC_TABLE: "'2'", REF_PLANE: "'FRAME'", REF_SYSTEM: "'ICRF'", OUT_UNITS: "'AU-D'", CSV_FORMAT: "'YES'",
        VEC_LABELS: "'NO'",
    });
    const res = await fetch(`${API}?${p}`);
    if (!res.ok) throw new Error(`Horizons HTTP ${res.status}`);
    const text = await res.text();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, text);
    return text;
}

/** Heliocentric Earth at a TDB JD, from Horizons too (for the distance-scaled tolerance). */
function earthNear(earthRows, jd) {
    let lo = 0, hi = earthRows.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (earthRows[mid][0] <= jd) lo = mid; else hi = mid;
    }
    return earthRows[lo];
}

/**
 * Adaptive knots: indices into `rows` such that Hermite interpolation between consecutive knots
 * reproduces every row within tol(row).
 * @param {number[][]} rows [jd, x, y, z, vx, vy, vz]
 * @param {(row:number[])=>number} tol AU
 * @returns {number[]} sorted indices
 */
export function adaptiveKnots(rows, tol) {
    const keep = new Set([0, rows.length - 1]);
    const stack = [[0, rows.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        if (b - a < 2) continue;
        const A = rows[a], B = rows[b];
        let worst = -1, wi = -1;
        for (let i = a + 1; i < b; i++) {
            const r = rows[i];
            let e2 = 0;
            for (let k = 0; k < 3; k++) {
                const p = hermite(A[0], A[1 + k], A[4 + k], B[0], B[1 + k], B[4 + k], r[0]);
                e2 += (p - r[1 + k]) ** 2;
            }
            const ratio = Math.sqrt(e2) / tol(r);
            if (ratio > worst) { worst = ratio; wi = i; }
        }
        if (worst > 1) {
            keep.add(wi);
            stack.push([a, wi], [wi, b]);
        }
    }
    return [...keep].sort((x, y) => x - y);
}

function addDays(iso, d) {
    return new Date(Date.parse(`${iso}T00:00:00Z`) + d * 864e5).toISOString().slice(0, 10);
}

async function main() {
    const refresh = process.argv.includes('--refresh');
    const offline = process.argv.includes('--offline');
    const opts = { refresh, offline };
    const earthRows = parseVectors(await fetchVectors('399', '1977-08-01', '2100-01-02', '4 d', opts));
    const craft = [];
    for (const c of CRAFT) {
        let rows = parseVectors(await fetchVectors(c.cmd, c.start, c.stop, c.step, opts));
        for (const f of c.flybys) {
            rows = rows.concat(parseVectors(await fetchVectors(c.cmd, addDays(f, -6), addDays(f, 6), '2 h', opts)));
        }
        rows.sort((a, b) => a[0] - b[0]);
        rows = rows.filter((r, i) => i === 0 || r[0] - rows[i - 1][0] > 1e-6);
        const tol = (r) => {
            const e = earthNear(earthRows, r[0]);
            const d = Math.hypot(r[1] - e[1], r[2] - e[2], r[3] - e[3]);
            return Math.max(1.2e-5, 2e-5 * d);
        };
        const knots = adaptiveKnots(rows, tol);
        const t0 = Math.floor(rows[0][0]) + 0.5;
        const k = knots.map((i) => {
            const r = rows[i];
            return [Number((r[0] - t0).toFixed(5)), ...r.slice(1, 4).map((v) => Math.round(v / POS_UNIT)), ...r.slice(4, 7).map((v) => Math.round(v / VEL_UNIT))];
        });
        craft.push({ id: c.id, launch: c.launch, t0, k });
        console.log(`${c.id}: ${rows.length} samples → ${k.length} knots`);
    }
    const out = {
        v: 1,
        source: 'JPL Horizons (NASA/JPL-Caltech), heliocentric geometric ICRF state vectors, TDB; https://ssd.jpl.nasa.gov/horizons/',
        retrieved: new Date().toISOString().slice(0, 10),
        units: 'k rows: [days after t0 (TDB JD), x, y, z in 1e-6 AU, vx, vy, vz in 1e-8 AU/day]',
        craft,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
    console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
