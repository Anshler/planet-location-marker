// Shader numerics guards (sky-view black-rectangle flicker, round 2). The headless smoke test runs
// on SwiftShader, which computes pow(x < 0, y) as pow(|x|, y) and never produces the NaN that a real
// GPU (ANGLE/D3D11, Metal) does, so these static checks are the regression net.
//
// One NaN pixel in the HDR scene target is enough: UnrealBloom's mip blur spreads it into a
// screen-sized block that tone mapping shows as black. Hence (a) every domain-sensitive call gets
// an argument inside its domain, and (b) the post chain scrubs NaN/Inf before the bloom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHADER_DIR = path.join(ROOT, 'js/render/shaders');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ground = await import(pathToFileURL(path.join(SHADER_DIR, 'ground.glsl.js')).href);
const common = await import(pathToFileURL(path.join(SHADER_DIR, 'common.glsl.js')).href);

/** The body of `fragmentShader: /* glsl *\/`...`` in a vendored three.js file. */
function vendoredFragment(rel) {
    const m = read(rel).match(/fragmentShader:\s*\/\* glsl \*\/`([\s\S]*?)`/);
    assert.ok(m, `${rel}: fragmentShader not found`);
    return m[1];
}

const stripComments = (g) => g.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** First argument of every `fn(` call in a GLSL string. */
function firstArgs(glsl, fn) {
    const g = stripComments(glsl);
    const out = [];
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(g))) {
        const start = m.index + m[0].length;
        let depth = 1;
        let j = start;
        for (; j < g.length && depth > 0; j++) {
            if (g[j] === '(') depth++;
            else if (g[j] === ')') depth--;
            else if (g[j] === ',' && depth === 1) break;
        }
        out.push(g.slice(start, depth === 0 ? j - 1 : j).trim());
    }
    return out;
}

/** Every GLSL string our shader modules export (SKY_PATCHES: only our replacements). */
async function ourGlsl() {
    const out = [];
    for (const f of fs.readdirSync(SHADER_DIR).filter((n) => n.endsWith('.glsl.js'))) {
        const mod = await import(pathToFileURL(path.join(SHADER_DIR, f)).href);
        for (const [name, v] of Object.entries(mod)) {
            if (typeof v === 'string') out.push({ where: `${f} ${name}`, glsl: v });
            else if (name === 'SKY_PATCHES') v.forEach(([, to], i) => out.push({ where: `${f} SKY_PATCHES[${i}]`, glsl: to }));
        }
    }
    const postfx = read('js/render/postfx.js');
    const finalFrag = postfx.match(/const FINAL_FRAG = \/\* glsl \*\/ `([\s\S]*?)`;/);
    assert.ok(finalFrag, 'postfx.js FINAL_FRAG not found');
    out.push({ where: 'postfx.js FINAL_FRAG', glsl: finalFrag[1] });
    return out;
}

// Bases that are non-negative by construction, and asin/acos arguments already clamped upstream.
const SAFE_POW_BASE = /^(max|clamp|abs|exp|exp2|texture|textureLod|texture2D)\s*\(/;
const KNOWN_POSITIVE_BASES = new Map([
    ['full / L0', 'beam length ratio: full = max(iLen, L0) and L0 > 0'],
    ['1.0 - a', 'cloud alpha clamped to [0, 0.98] on the line above'],
    ['degrees(asin(s)) + 6.07995', 's is clamped to [0, 1], so the base is >= 6.08'],
    ['F', 'F = exp2(...) > 0'],
    ['uZoom', 'zoom factor uniform, > 0'],
    ['v', 'Milky Way texel; fragments with v < 0.002 are discarded'],
]);
const SAFE_TRIG_ARG = /^(clamp|min|max)\s*\(/;
const KNOWN_CLAMPED_TRIG_ARGS = new Map([
    ['hp', 'twilightSky: hp = clamp(h, 0.0, 1.0)'],
    ['s', 'airmassKY: s = clamp(sinAlt, 0.0, 1.0)'],
]);

test('every SKY_PATCHES search string occurs exactly once in the vendored Sky.js fragment shader', () => {
    const frag = vendoredFragment('vendor/three/addons/objects/Sky.js');
    for (const [from] of ground.SKY_PATCHES) {
        assert.equal(frag.split(from).length - 1, 1, `not found exactly once: ${from}`);
    }
});

test('the bloom high-pass patch still matches the vendored LuminosityHighPassShader', () => {
    const frag = vendoredFragment('vendor/three/addons/shaders/LuminosityHighPassShader.js');
    assert.ok(frag.includes('vec4 texel = texture2D( tDiffuse, vUv );'));
    const postfx = read('js/render/postfx.js');
    assert.match(postfx, /vec4 texel = texture2D\( tDiffuse, vUv \);/);
    assert.match(postfx, /sanitizeBloomInput\(pass\);/);
    assert.match(postfx, /pcFinite\(texture2D\(tDiffuse, vUv\)\.rgb\)/, 'FinalPass scrubs its input');
});

test('pcFinite tests IEEE bits, not isnan() (FXC on ANGLE/D3D11 compiles isnan and x != x away)', () => {
    assert.match(common.FINITE_CHUNK, /floatBitsToUint/);
    assert.match(common.FINITE_CHUNK, /0x7f800000u/);
    assert.ok(!/\bisnan\s*\(|\bisinf\s*\(/.test(stripComments(common.FINITE_CHUNK)));
});

test('no shader relies on isnan()/isinf() (no-ops on ANGLE/D3D11, and a console warning)', async () => {
    const bad = (await ourGlsl()).filter(({ glsl }) => /\bisnan\s*\(|\bisinf\s*\(/.test(stripComments(glsl)));
    assert.deepEqual(bad.map((b) => b.where), []);
});

test('the sky dome output is scrubbed and the azimuth cosine is clamped (twilight + ground haze)', () => {
    const out = ground.SKY_PATCHES.find(([from]) => from.startsWith('gl_FragColor'));
    assert.ok(out && /pcFinite\(/.test(out[1]), 'sky dome gl_FragColor goes through pcFinite');
    for (const [name, glsl] of [['TWILIGHT_CHUNK', ground.TWILIGHT_CHUNK], ['GROUND_FRAG', ground.GROUND_FRAG]]) {
        const lines = stripComments(glsl).split('\n').filter((l) => /\bcAz\s*=/.test(l));
        assert.ok(lines.length > 0, `${name}: cAz assignment present`);
        for (const l of lines) assert.match(l, /clamp\(dot\(/, `${name}: ${l.trim()}`);
    }
    assert.match(ground.TWILIGHT_CHUNK, /float sunward = clamp\(/);
});

test('pow() bases are non-negative and asin/acos arguments stay inside [-1, 1]', async () => {
    const bad = [];
    for (const { where, glsl } of await ourGlsl()) {
        for (const base of firstArgs(glsl, 'pow')) {
            if (!SAFE_POW_BASE.test(base) && !KNOWN_POSITIVE_BASES.has(base)) bad.push(`${where}: pow(${base}, …)`);
        }
        for (const fn of ['asin', 'acos']) {
            for (const arg of firstArgs(glsl, fn)) {
                if (!SAFE_TRIG_ARG.test(arg) && !KNOWN_CLAMPED_TRIG_ARGS.has(arg)) bad.push(`${where}: ${fn}(${arg})`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

// log/log2 need a positive argument, sqrt/inversesqrt a non-negative one.
const SAFE_LOG_ARG = /^(max|clamp|abs|exp|exp2|dot)\s*\(/;
const KNOWN_SAFE_LOG_ARGS = new Map([
    ['1.0 + d', 'beam: d = clamp(vDist, 0.0, vLen.y)'],
    ['1.0 + len', 'beam: len >= L0 > 0 (flat varying from the vertex shader)'],
    ['pk / 12.0', 'atmosphere aureole cap: pk = max(peak, 12.0)'],
    ['h', 'raySphere: returns early when h < 0.0'],
    ['PI * r / (2.0 * ATM_HR)', 'Chapman: r is a radius from the Earth centre, > 0'],
    ['PI * r / (2.0 * ATM_HM)', 'Chapman: r is a radius from the Earth centre, > 0'],
    ['1.0 - x * x', 'Sun limb: x is clamped to [0, 1]'],
    ['depth', 'lunar eclipse: depth is clamped to [0, 1]'],
    ['r2', 'star sprite: r2 = dot(p, p)'],
    ['e', 'star limit: e = clamp(uExposure, 0.0, 1.0)'],
]);

test('log/log2/sqrt/inversesqrt arguments stay inside their domains', async () => {
    const bad = [];
    for (const { where, glsl } of await ourGlsl()) {
        for (const fn of ['log', 'log2', 'sqrt', 'inversesqrt']) {
            for (const arg of firstArgs(glsl, fn)) {
                if (!SAFE_LOG_ARG.test(arg) && !KNOWN_SAFE_LOG_ARGS.has(arg)) bad.push(`${where}: ${fn}(${arg})`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

// A non-flat varying is extrapolated when MSAA shades a partly covered pixel at its centre, so it
// can be far outside the range its vertices span (the beam's vDist reached −16376). A
// domain-sensitive call must never see one unclamped.
test('no domain-sensitive call takes an unclamped interpolated varying', async () => {
    const bad = [];
    for (const { where, glsl } of await ourGlsl()) {
        const g = stripComments(glsl);
        const names = [...g.matchAll(/^\s*(?:(?:smooth|centroid|highp|mediump|lowp)\s+)*varying\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]);
        if (!names.length) continue;
        const re = new RegExp(`\\b(${names.join('|')})\\b`);
        for (const fn of ['log', 'log2', 'sqrt', 'inversesqrt', 'pow', 'asin', 'acos']) {
            for (const arg of firstArgs(g, fn)) {
                if (re.test(arg) && !/^(clamp|max|abs)\s*\(/.test(arg)) bad.push(`${where}: ${fn}(${arg})`);
            }
        }
    }
    assert.deepEqual(bad, []);
});

test('the beam fragment shader clamps vDist once and scrubs its output', async () => {
    const beam = await import(pathToFileURL(path.join(SHADER_DIR, 'beam.glsl.js')).href);
    const body = stripComments(beam.BEAM_FRAG).split('void main()')[1];
    assert.match(body, /float d = clamp\(vDist, 0\.0, vLen\.y\);/);
    assert.equal(body.match(/\bvDist\b/g).length, 1, 'vDist is read only by the clamp');
    assert.match(body, /gl_FragColor = vec4\(pcFinite\(/);
});

test('the clamp the allow-list relies on is still there', () => {
    assert.match(ground.TWILIGHT_CHUNK, /float hp = clamp\(h, 0\.0, 1\.0\);/);
});

// smoothstep(edge0, edge1, x) is undefined for edge0 >= edge1 (GLSL ES 3.00 §8.3, MSL, SPIR-V);
// most drivers evaluate the formula anyway, but nothing guarantees it. A falling ramp is written
// 1.0 - smoothstep(lo, hi, x). Checks literal pairs and "same base ± constant / constant × base".
test('smoothstep edges are increasing (no reversed-edge falling ramps)', () => {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    };
    walk(path.join(ROOT, 'js/render'));
    const parse = (s) => {
        s = s.trim();
        if (/^-?\d*\.?\d+$/.test(s)) return { base: '', k: Number(s), mul: false };
        let m = s.match(/^(.+?)\s*([+-])\s*(\d*\.?\d+)$/);
        if (m) return { base: m[1].trim(), k: (m[2] === '-' ? -1 : 1) * Number(m[3]), mul: false };
        m = s.match(/^(\d*\.?\d+)\s*\*\s*([\w.]+)$/);
        if (m) return { base: m[2], k: Number(m[1]), mul: true };
        if (/^[\w.]+$/.test(s)) return { base: s, k: 0, mul: null };
        return null;
    };
    const bad = [];
    let checked = 0;
    for (const f of files) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/');
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        for (const call of src.matchAll(/\bsmoothstep\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
            const args = call[1].split(',');
            if (args.length !== 3) continue;
            const a = parse(args[0]), b = parse(args[1]);
            if (!a || !b || a.base !== b.base) continue;
            let reversed;
            if (a.base === '') reversed = a.k >= b.k;
            else if (a.mul === true || b.mul === true) {
                if (a.mul === false || b.mul === false) continue;   // offset vs scale: not comparable
                reversed = (a.mul ? a.k : 1) >= (b.mul ? b.k : 1);   // positive base
            } else reversed = a.k >= b.k;
            checked++;
            if (reversed) bad.push(`${rel}: smoothstep(${call[1].trim()})`);
        }
    }
    assert.ok(checked > 50, `parsed ${checked} smoothstep calls`);
    assert.deepEqual(bad, []);
});
