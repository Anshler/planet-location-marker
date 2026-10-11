#!/usr/bin/env node
// Vendors every third-party file the site ships, from pinned, immutable URLs, and keeps
// vendor/VENDOR.json as a lock file: [{name, version, url, path, sha256, license, bytes}].
//
//   node scripts/fetch-vendor.mjs                 download missing files, verify against the
//                                                  lock, (re)write VENDOR.json
//   node scripts/fetch-vendor.mjs --check         offline: every file present and matching the
//                                                  lock; unlisted files under vendor/ reported
//   node scripts/fetch-vendor.mjs --verify-remote re-download everything and compare bytes
//   node scripts/fetch-vendor.mjs --force         re-download everything (still verified)
//   node scripts/fetch-vendor.mjs --update        accept new hashes (after a deliberate bump)
//
// Pins: three.js code from npm 0.170.0; planet textures from the three.js repo at tag r170;
// the clouds PNG and lens flares at r186 (re-optimised PNGs, same images); astronomy-engine 2.1.19 (its npm
// package ships no LICENSE, so that comes from the matching git tag); d3-celestial data at
// commit 7e720a3 (master as of 2022-07-05; the repo has no tag for it on jsDelivr).
// GeoNames is not vendored — scripts/build-cities.mjs downloads it to a gitignored cache.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { download } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'vendor', 'VENDOR.json');

const THREE = { name: 'three', version: '0.170.0', license: 'MIT', base: 'https://cdn.jsdelivr.net/npm/three@0.170.0/' };
const AE = { name: 'astronomy-engine', version: '2.1.19', license: 'MIT' };
const TEX170 = { version: 'r170', base: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/' };
const TEX186 = { version: 'r186', base: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r186/examples/textures/' };
const D3C = {
    name: 'd3-celestial', version: '7e720a3de062059d4c5400a379146a601d9010e0', license: 'BSD-3-Clause',
    base: 'https://cdn.jsdelivr.net/gh/ofrohn/d3-celestial@7e720a3de062059d4c5400a379146a601d9010e0/',
};

const threeFile = (src, dst) => ({ name: THREE.name, version: THREE.version, license: THREE.license, url: THREE.base + src, path: dst });
const addon = (dir, file) => threeFile(`examples/jsm/${dir}/${file}`, `vendor/three/addons/${dir}/${file}`);
const texture = (pin, sub, file, license) => ({
    name: `texture:${file}`, version: `three.js ${pin.version}`, license, url: `${pin.base}${sub}/${file}`, path: `assets/textures/${file}`,
});
const SSS = 'CC-BY-4.0 (Solar System Scope, via three.js examples)';
const THREE_EX = 'three.js examples (NASA-derived imagery; no separate licence stated)';
const RO_ME = 'three.js examples (ro.me)';

/** The pinned download list (SPEC §G). Order is the order written to VENDOR.json. */
export const MANIFEST = [
    threeFile('build/three.module.min.js', 'vendor/three/three.module.min.js'),
    threeFile('LICENSE', 'vendor/three/LICENSE'),
    addon('controls', 'OrbitControls.js'),
    ...['EffectComposer', 'RenderPass', 'ShaderPass', 'MaskPass', 'Pass', 'UnrealBloomPass', 'OutputPass']
        .map((f) => addon('postprocessing', `${f}.js`)),
    ...['CopyShader', 'LuminosityHighPassShader', 'OutputShader'].map((f) => addon('shaders', `${f}.js`)),
    addon('objects', 'Sky.js'),
    { ...AE, url: 'https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/esm/astronomy.js', path: 'vendor/astronomy-engine/astronomy.js' },
    { ...AE, url: 'https://cdn.jsdelivr.net/gh/cosinekitty/astronomy@v2.1.19/LICENSE', path: 'vendor/astronomy-engine/LICENSE' },
    texture(TEX170, 'planets', 'earth_day_4096.jpg', SSS),
    texture(TEX170, 'planets', 'earth_night_4096.jpg', SSS),
    texture(TEX170, 'planets', 'earth_bump_roughness_clouds_4096.jpg', SSS),
    texture(TEX170, 'planets', 'earth_atmos_2048.jpg', THREE_EX),
    texture(TEX170, 'planets', 'earth_specular_2048.jpg', THREE_EX),
    texture(TEX186, 'planets', 'earth_clouds_1024.png', THREE_EX),   // re-optimised PNG after r170
    texture(TEX170, 'planets', 'moon_1024.jpg', THREE_EX),
    texture(TEX186, 'lensflare', 'lensflare0.png', RO_ME),
    texture(TEX186, 'lensflare', 'lensflare3.png', RO_ME),
    ...['stars.6.json', 'constellations.lines.json', 'constellations.json', 'starnames.json', 'mw.json'].map((f) => ({
        name: D3C.name, version: D3C.version, license: D3C.license, url: `${D3C.base}data/${f}`, path: `data/raw/${f}`,
    })),
    { name: D3C.name, version: D3C.version, license: D3C.license, url: `${D3C.base}LICENSE`, path: 'data/raw/LICENSE-d3-celestial' },
];

/** @param {Buffer} buf @returns {string} hex sha256 */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Reads the lock file → Map(path → entry); empty when absent. */
export function readLock(file = LOCK) {
    try {
        return new Map(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => [e.path, e]));
    } catch {
        return new Map();
    }
}

/** One entry per line: readable diffs, still valid JSON. */
function serializeLock(entries) {
    return `[\n${entries.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`;
}

function listFiles(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...listFiles(p));
        else out.push(p);
    }
    return out;
}

/** Files under vendor/ and assets/textures/ that the manifest does not know about. */
function unlistedFiles() {
    const known = new Set(MANIFEST.map((m) => m.path));
    known.add('vendor/VENDOR.json');
    return [...listFiles(path.join(ROOT, 'vendor')), ...listFiles(path.join(ROOT, 'assets', 'textures'))]
        .map((f) => path.relative(ROOT, f).replaceAll('\\', '/'))
        .filter((f) => !known.has(f));
}

const readLocal = (m) => {
    const abs = path.join(ROOT, m.path);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
};

/** --check: offline verification of one entry → problem string or null. */
function checkEntry(m, pinned) {
    const buf = readLocal(m);
    if (!buf) return `missing ${m.path}`;
    if (!pinned) return `not in VENDOR.json: ${m.path}`;
    return sha256(buf) === pinned ? null : `hash mismatch: ${m.path}`;
}

/** --verify-remote: compares the local file with a fresh download → problem string or null. */
async function verifyRemoteEntry(m) {
    const buf = readLocal(m);
    const remote = await download(m.url);
    const same = buf !== null && sha256(remote) === sha256(buf);
    console.log(`${same ? 'same' : 'DIFF'}  ${m.path}`);
    return same ? null : `remote differs: ${m.path} (${m.url})`;
}

/**
 * Default mode: downloads a missing (or, with force, every) file, verifies it against the
 * lock unless `update`, and returns its lock entry — or a problem string.
 */
async function syncEntry(m, pinned, { force, update }) {
    let buf = readLocal(m);
    if (!buf || force) {
        process.stdout.write(`download ${m.url} … `);
        const fetched = await download(m.url);
        if (pinned && sha256(fetched) !== pinned && !update) {
            console.log('HASH MISMATCH');
            return `downloaded ${m.path} does not match VENDOR.json (use --update after a deliberate bump)`;
        }
        const abs = path.join(ROOT, m.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fetched);
        buf = fetched;
        console.log(`${(fetched.length / 1024).toFixed(0)} KB`);
    }
    const hash = sha256(buf);
    if (pinned && hash !== pinned && !update) {
        return `local ${m.path} does not match VENDOR.json (restore it, or --update after a deliberate change)`;
    }
    return { name: m.name, version: m.version, url: m.url, path: m.path, sha256: hash, license: m.license, bytes: buf.length };
}

async function main() {
    const flag = (f) => process.argv.includes(f);
    const mode = (flag('--check') && 'check') || (flag('--verify-remote') && 'remote') || 'sync';
    const opts = { force: flag('--force'), update: flag('--update') };
    const lock = readLock();
    const problems = [];
    const entries = [];

    for (const m of MANIFEST) {
        const pinned = lock.get(m.path)?.sha256;
        let result;
        if (mode === 'check') result = checkEntry(m, pinned);
        else if (mode === 'remote') result = await verifyRemoteEntry(m);
        else result = await syncEntry(m, pinned, opts);
        if (typeof result === 'string') problems.push(result);
        else if (result) entries.push(result);
    }

    const extra = unlistedFiles();
    if (extra.length) console.warn(`unlisted files (not shipped by the manifest):\n  ${extra.join('\n  ')}`);
    if (problems.length) {
        console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
        process.exit(1);
    }
    if (mode === 'check') {
        console.log(`vendor OK: ${MANIFEST.length} files match vendor/VENDOR.json`);
    } else if (mode === 'remote') {
        console.log(`remote OK: all ${MANIFEST.length} files are byte-identical to their pinned URLs`);
    } else {
        fs.writeFileSync(LOCK, serializeLock(entries));
        const total = entries.reduce((a, e) => a + e.bytes, 0);
        console.log(`vendor/VENDOR.json: ${entries.length} files, ${(total / 1048576).toFixed(2)} MB`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (err) {
        console.error(`fetch-vendor: ${err.message}`);
        process.exit(1);
    }
}
