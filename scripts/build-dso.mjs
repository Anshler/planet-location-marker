#!/usr/bin/env node
// Builds data/dso.json: the deep-sky showpieces (js/astro/dso.js) — all 110 Messier objects plus
// southern and northern naked-eye or binocular classics that Messier never saw or skipped.
//
//   node scripts/build-dso.mjs [--check]
//
// Sources: positions, magnitudes and sizes of the Messier objects come from d3-celestial's
// messier.json (BSD-3, the pinned commit in vendor/VENDOR.json). Everything else — the extra
// objects' rows, distances, position angles, common names and the few corrections below — is
// hand-entered from public catalogue facts (SEDS Messier pages, NED/RC3 axis ratios and position
// angles, Harris 2010 for globular-cluster distances, the WEBDA / Cantat-Gaudin 2018 open-cluster
// distances), rounded. No OpenNGC (CC BY-SA) data is used.
//
// Output (one object per line): {v, source, fields, rows:[[id, name, type, ra, dec, mag, maj, min,
// pa, ly, desig], …]} with ra/dec J2000 in degrees × 1000, mag × 10, maj/min in arcminutes × 10,
// pa in degrees east of north, ly the distance in light-years (rounded), desig the NGC/IC/other
// designation. Types: sg spiral (and lenticular) galaxy, eg elliptical, ig irregular, gc globular
// cluster, oc open cluster, en emission nebula / star-forming region, rn reflection nebula,
// pn planetary nebula, snr supernova remnant, sc star cloud, ast asterism or double star.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'dso.json');

const D3_TYPE = { s: 'sg', e: 'eg', i: 'ig', gc: 'gc', oc: 'oc', sfr: 'en', rn: 'rn', pn: 'pn', snr: 'snr' };

/** Common names (d3-celestial's `alt`, tidied, plus a few classics). */
const NAMES = {
    M1: 'Crab Nebula', M6: 'Butterfly Cluster', M7: 'Ptolemy Cluster', M8: 'Lagoon Nebula', M11: 'Wild Duck Cluster',
    M13: 'Hercules Globular Cluster', M16: 'Eagle Nebula', M17: 'Omega Nebula', M20: 'Trifid Nebula', M22: 'Sagittarius Cluster',
    M24: 'Sagittarius Star Cloud', M27: 'Dumbbell Nebula', M31: 'Andromeda Galaxy', M33: 'Triangulum Galaxy', M40: 'Winnecke 4',
    M42: 'Orion Nebula', M43: 'De Mairan’s Nebula', M44: 'Beehive Cluster', M45: 'Pleiades', M51: 'Whirlpool Galaxy',
    M57: 'Ring Nebula', M63: 'Sunflower Galaxy', M64: 'Black Eye Galaxy', M76: 'Little Dumbbell Nebula', M77: 'Cetus A',
    M81: 'Bode’s Galaxy', M82: 'Cigar Galaxy', M83: 'Southern Pinwheel Galaxy', M87: 'Virgo A', M97: 'Owl Nebula',
    M101: 'Pinwheel Galaxy', M102: 'Spindle Galaxy', M104: 'Sombrero Galaxy',
};

/** Messier distances (light-years, rounded; SEDS / Harris 2010 / NED redshift-independent). */
const MESSIER_LY = {
    M1: 6500, M2: 37500, M3: 33900, M4: 7200, M5: 24500, M6: 1600, M7: 980, M8: 4100, M9: 25800, M10: 14300,
    M11: 6200, M12: 16400, M13: 22200, M14: 30300, M15: 33600, M16: 7000, M17: 5500, M18: 4900, M19: 28700, M20: 5200,
    M21: 4250, M22: 10600, M23: 2150, M24: 10000, M25: 2000, M26: 5000, M27: 1360, M28: 17900, M29: 4000, M30: 26100,
    M31: 2500000, M32: 2490000, M33: 2730000, M34: 1500, M35: 2800, M36: 4100, M37: 4500, M38: 4200, M39: 1000, M40: 510,
    M41: 2300, M42: 1344, M43: 1600, M44: 577, M45: 444, M46: 5400, M47: 1600, M48: 1500, M49: 56000000, M50: 3200,
    M51: 23000000, M52: 5000, M53: 58000, M54: 87400, M55: 17600, M56: 32900, M57: 2300, M58: 62000000, M59: 60000000, M60: 55000000,
    M61: 52500000, M62: 22500, M63: 29300000, M64: 17300000, M65: 35000000, M66: 36000000, M67: 2700, M68: 33600, M69: 29700, M70: 29400,
    M71: 13000, M72: 54600, M73: 2500, M74: 32000000, M75: 67500, M76: 2500, M77: 47000000, M78: 1600, M79: 41000, M80: 32600,
    M81: 11800000, M82: 12000000, M83: 15000000, M84: 60000000, M85: 60000000, M86: 52000000, M87: 53500000, M88: 47000000, M89: 50000000, M90: 58700000,
    M91: 63000000, M92: 26700, M93: 3600, M94: 16000000, M95: 33000000, M96: 31000000, M97: 2030, M98: 44400000, M99: 50200000, M100: 55000000,
    M101: 21000000, M102: 50000000, M103: 10000, M104: 31100000, M105: 32000000, M106: 23700000, M107: 20900, M108: 46000000, M109: 83500000, M110: 2690000,
};

/** Position angles (degrees east of north) of the elongated Messier objects (RC3 / NED, rounded). */
const MESSIER_PA = {
    M1: 125, M8: 90, M17: 125, M27: 30, M31: 35, M32: 170, M33: 23, M49: 155, M51: 163, M58: 95, M59: 165, M60: 105,
    M63: 105, M64: 115, M65: 174, M66: 173, M76: 40, M77: 70, M81: 157, M82: 65, M84: 135, M85: 10, M86: 128, M88: 141,
    M90: 23, M91: 110, M94: 105, M96: 15, M98: 158, M100: 30, M102: 128, M104: 90, M105: 70, M106: 150, M108: 79,
    M109: 140, M110: 170,
};

/** Corrections where d3-celestial's row is off or empty: [field, value] (mag, maj′, min′, type). */
const MESSIER_FIX = {
    M24: { type: 'sc' }, M40: { type: 'ast', maj: 0.8, min: 0.8 }, M73: { type: 'ast', maj: 2.8, min: 2.8 },
    M20: { mag: 6.3 }, M27: { mag: 7.5, maj: 8.0, min: 5.7 }, M57: { mag: 8.8, maj: 1.4, min: 1.0 },
    M76: { mag: 10.1, maj: 2.7, min: 1.8 }, M97: { mag: 9.9, maj: 3.4, min: 3.3 }, M43: { maj: 20, min: 15 },
    // The Orion Nebula's catalogue position (the Trapezium region, 05h35m17s −05°23′28″), not the
    // middle of the glow.
    M42: { ra: 83.822, dec: -5.391 },
};

/**
 * The extra showpieces: [id, name, type, raDeg, decDeg, mag, maj′, min′, pa, ly, desig].
 * Hand-entered (J2000) from the NGC/IC catalogue values and standard distances, rounded.
 */
const EXTRAS = [
    ['lmc', 'Large Magellanic Cloud', 'ig', 80.894, -69.756, 0.9, 645, 550, 170, 163000, 'ESO 56-115'],
    ['smc', 'Small Magellanic Cloud', 'ig', 13.187, -72.829, 2.7, 320, 185, 45, 200000, 'NGC 292'],
    ['ngc5139', 'Omega Centauri', 'gc', 201.697, -47.480, 3.9, 36, 36, 0, 17000, 'NGC 5139'],
    ['ngc104', '47 Tucanae', 'gc', 6.024, -72.081, 4.1, 31, 31, 0, 14700, 'NGC 104'],
    ['ngc3372', 'Carina Nebula', 'en', 161.265, -59.867, 1.0, 120, 120, 0, 7500, 'NGC 3372'],
    ['ngc869', 'Double Cluster (h Persei)', 'oc', 34.750, 57.133, 3.7, 30, 30, 0, 7500, 'NGC 869'],
    ['ngc884', 'Double Cluster (χ Persei)', 'oc', 35.583, 57.150, 3.8, 30, 30, 0, 7600, 'NGC 884'],
    ['cr399', 'Coathanger', 'ast', 291.350, 20.183, 3.6, 60, 20, 90, 420, 'Collinder 399'],
    ['ngc4755', 'Jewel Box', 'oc', 193.425, -60.367, 4.2, 10, 10, 0, 6400, 'NGC 4755'],
    ['ngc3532', 'Wishing Well Cluster', 'oc', 166.413, -58.753, 3.0, 55, 55, 0, 1600, 'NGC 3532'],
    ['ic2602', 'Southern Pleiades', 'oc', 160.742, -64.400, 1.9, 50, 50, 0, 480, 'IC 2602'],
    ['ngc2070', 'Tarantula Nebula', 'en', 84.658, -69.100, 8.0, 40, 25, 0, 160000, 'NGC 2070'],
    ['ngc5128', 'Centaurus A', 'eg', 201.365, -43.019, 6.8, 25.7, 20.0, 35, 12400000, 'NGC 5128'],
    ['ngc253', 'Sculptor Galaxy', 'sg', 11.888, -25.288, 7.1, 27.5, 6.8, 52, 11400000, 'NGC 253'],
    ['ngc6752', 'Great Peacock Globular', 'gc', 287.717, -59.985, 5.4, 20, 20, 0, 13000, 'NGC 6752'],
    ['ngc6397', 'NGC 6397', 'gc', 265.175, -53.674, 5.7, 32, 32, 0, 7800, 'NGC 6397'],
    ['mel25', 'Hyades', 'oc', 66.750, 15.867, 0.5, 330, 330, 0, 153, 'Melotte 25'],
    ['mel111', 'Coma Star Cluster', 'oc', 186.000, 26.000, 1.8, 275, 275, 0, 280, 'Melotte 111'],
    ['mel20', 'Alpha Persei Cluster', 'oc', 51.675, 49.117, 1.2, 185, 185, 0, 570, 'Melotte 20'],
    ['ngc7000', 'North America Nebula', 'en', 314.700, 44.333, 4.0, 120, 100, 0, 2200, 'NGC 7000'],
    ['ngc7293', 'Helix Nebula', 'pn', 337.411, -20.837, 7.6, 25, 20, 135, 650, 'NGC 7293'],
    ['veil', 'Veil Nebula', 'snr', 312.750, 30.667, 7.0, 180, 180, 0, 2400, 'NGC 6960/6992'],
    ['ngc2237', 'Rosette Nebula', 'en', 98.000, 5.033, 9.0, 80, 60, 0, 5200, 'NGC 2237'],
    ['ngc2264', 'Christmas Tree Cluster', 'oc', 100.242, 9.895, 3.9, 20, 20, 0, 2500, 'NGC 2264'],
    ['ngc6231', 'NGC 6231', 'oc', 253.542, -41.825, 2.6, 15, 15, 0, 5200, 'NGC 6231'],
    ['ngc2516', 'Southern Beehive', 'oc', 119.517, -60.750, 3.8, 30, 30, 0, 1300, 'NGC 2516'],
    ['ngc457', 'Owl Cluster', 'oc', 19.879, 58.290, 6.4, 13, 13, 0, 7900, 'NGC 457'],
    ['ngc6543', 'Cat’s Eye Nebula', 'pn', 269.639, 66.633, 8.1, 0.4, 0.3, 0, 3300, 'NGC 6543'],
    ['ngc4565', 'Needle Galaxy', 'sg', 189.087, 25.988, 9.6, 16, 2.3, 135, 40000000, 'NGC 4565'],
    ['ngc3242', 'Ghost of Jupiter', 'pn', 156.192, -18.638, 7.7, 0.7, 0.6, 0, 4800, 'NGC 3242'],
];

const FIELDS = ['id', 'name', 'type', 'ra', 'dec', 'mag', 'maj', 'min', 'pa', 'ly', 'desig'];

/** "190x60" → [190, 60]; "13" → [13, 13]; '' → null. */
function parseDim(s) {
    const m = /^\s*([\d.]+)\s*(?:x\s*([\d.]+))?\s*$/.exec(String(s ?? ''));
    if (!m) return null;
    const a = Number(m[1]);
    return [a, m[2] ? Number(m[2]) : a];
}

/** Packs one row (degrees, arcminutes) into the integer form. */
function pack(id, name, type, ra, dec, mag, maj, min, pa, ly, desig) {
    return [id, name, type, Math.round((((ra % 360) + 360) % 360) * 1000), Math.round(dec * 1000), Math.round(mag * 10),
        Math.max(1, Math.round(maj * 10)), Math.max(1, Math.round(min * 10)), Math.round(pa) % 180, Math.round(ly), desig];
}

/**
 * Builds the dso.json object.
 * @param {object} messier d3-celestial messier.json (GeoJSON)
 */
export function buildDso(messier) {
    const rows = [];
    for (const f of messier.features) {
        const id = f.id;
        const p = f.properties;
        const fix = MESSIER_FIX[id] ?? {};
        const type = fix.type ?? D3_TYPE[p.type];
        if (!type) throw new Error(`build-dso: ${id} has an unknown type ${p.type}`);
        const dim = parseDim(p.dim) ?? [1, 1];
        const [lon, lat] = f.geometry.coordinates;
        const ly = MESSIER_LY[id];
        if (!Number.isFinite(ly)) throw new Error(`build-dso: no distance for ${id}`);
        rows.push(pack(id.toLowerCase(), NAMES[id] ?? id, type, fix.ra ?? lon, fix.dec ?? lat, fix.mag ?? p.mag, fix.maj ?? dim[0], fix.min ?? dim[1],
            MESSIER_PA[id] ?? 0, ly, p.desig || ''));
    }
    for (const e of EXTRAS) rows.push(pack(...e));
    return {
        v: 1,
        source: 'Messier: d3-celestial messier.json (BSD-3); others, distances and position angles hand-entered from public catalogue values',
        fields: FIELDS,
        rows,
    };
}

/** One object per line. */
export function serializeDso(doc) {
    return `{"v":${doc.v},"source":${JSON.stringify(doc.source)},"fields":${JSON.stringify(doc.fields)},"rows":[\n`
        + doc.rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]}\n';
}

function main() {
    const messier = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'raw', 'messier.json'), 'utf8'));
    const text = serializeDso(buildDso(messier));
    if (process.argv.includes('--check')) {
        const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (cur !== text) {
            console.error('data/dso.json is out of date — run: node scripts/build-dso.mjs');
            process.exit(1);
        }
        console.log('data/dso.json is up to date');
        return;
    }
    fs.writeFileSync(OUT, text);
    console.log(`data/dso.json: ${text.split('\n').length - 3} objects, ${(text.length / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
