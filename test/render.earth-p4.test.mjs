// Phase 4 globe work on the render side: the aurora (face-on term + limb shell), moonlight and
// moonglint, close-zoom city lights and sculpted clouds. The render modules import three, so like
// render.eclipse.test.mjs this reads their source and the exported GLSL. The geomagnetic numbers
// are tested in astro.geomag.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const shader = async (f) => import(pathToFileURL(path.join(ROOT, 'js/render/shaders', f)).href);

/** Body of the `name(…) { … }` method or function (brace-matched). */
function body(src, name) {
    const i = src.search(new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`));
    assert.ok(i >= 0, `${name} not found`);
    let j = src.indexOf('{', i), depth = 0;
    for (let k = j; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}' && --depth === 0) return src.slice(j, k + 1);
    }
    throw new Error(`${name}: unbalanced braces`);
}

test('aurora: the shell module is registered in main.js and draws between the clouds and the atmosphere', () => {
    const main = stripComments(read('js/main.js'));
    assert.match(main, /aurora: import\('\.\/render\/aurora\.js'\)/, 'importRenderStack');
    // (In the Earth-only group that standing on Mars hides: app/mars-host.js.)
    assert.match(main, /create\('aurora', m\.aurora && \(\(\) => m\.aurora\.createAurora\(rc, \{ reducedMotion: rm \}\)\)(, earthScene)?\)/);
    assert.match(main, /m\.earth\.createEarth\(rc, \{ textures, reducedMotion: rm \}\)/, 'the face-on term honours reduced motion too');
    const src = stripComments(read('js/render/aurora.js'));
    assert.match(src, /mesh\.renderOrder = 15;/);
    assert.match(src, /side: THREE\.FrontSide/, 'FrontSide: the camera never enters r = 1.05 in orbit view');
    assert.match(src, /depthTest: true/);
    assert.match(src, /depthWrite: false/);
    assert.match(src, /STEPS = \{ high: \d+, max: \d+ \}/, 'the shell exists on high and max only');
    for (const m of ['apply', 'update', 'setLayers', 'setViewMode', 'setQuality', 'dispose']) assert.ok(src.includes(`${m}(`), m);
    assert.doesNotMatch(body(src, 'update'), /new (Float32Array|THREE\.)/, 'no per-frame allocation');
});

test('aurora: animation follows simulated time only, freezes with reduced motion, and fine detail fades at fast rates', () => {
    const src = stripComments(read('js/render/aurora.js'));
    assert.match(src, /u\.uAur\.value\.y = reducedMotion \? STILL_PHASE : a\.phase;/);
    assert.match(src, /Math\.abs\(fi\?\.simRate \?\? 0\)/, 'detail from the clock rate the loop reports');
    assert.doesNotMatch(src, /performance\.now|Date\.now|fi\.timeS/, 'never wall-clock time');
    const loop = stripComments(read('js/app/loop.js'));
    assert.match(loop, /fi\.simRate = clock\.playing && Number\.isFinite\(clock\.rate\) \? clock\.rate : 0;/);
    // (Not while standing on Mars: the loop's host, app/mars-host.js.)
    assert.match(loop, /if \(s\.aurora && !host\) computeAurora\(s, auroraActivity, s\.aurora\);/);
});

test('aurora: one column model, face-on in the surface and cloud shaders, handed over to the shell by n·V', async () => {
    const { AURORA_CHUNK, AURORA_SHADER } = await shader('aurora.glsl.js');
    const chunk = stripComments(AURORA_CHUNK);
    assert.match(chunk, /uniform float uAurOval\[48\];/);
    assert.match(chunk, /slant \*= smoothstep\(0\.15, 0\.45, nov\);/);
    const frag = stripComments(AURORA_SHADER.fragment);
    assert.match(frag, /w = 1\.0 - smoothstep\(0\.15, 0\.45, dot\(normalize\(ro \+ rd \* raySphere\(ro, rd, AUR_R\)\.x\), -rd\)\)/,
        'the shell takes exactly the complement, at the same 110 km point');
    // raySphere returns (1e9, -1e9) on a miss: a hit needs t1 > t0 too, or every ray passing above
    // the planet would lose the far half of its chord (curtains behind the limb).
    assert.match(frag, /vec2 tp = raySphere\(ro, rd, 1\.0\);\s*bool hit = tp\.x > 0\.0 && tp\.y > tp\.x;/);
    assert.doesNotMatch(frag, /raySphere\([^;]*\)\.x > 0\.0/, 'no bare .x > 0.0 hit test');
    // The fine-detail fade (uAur.z, fast time-lapse) steadies the rays' heights, not only their brightness.
    assert.match(frag, /vec3 pr = aurProfile\(hh, mix\(0\.5, ray, uAur\.z\)\);/);
    const main = frag.split('void main()')[1];
    assert.ok(main.indexOf('#include <tonemapping_fragment>') < main.indexOf('#include <colorspace_fragment>'));
    // fwidth before any non-uniform early return.
    const face = chunk.split('vec3 auroraFace(')[1];
    assert.ok(face.indexOf('fwidth(') < face.indexOf('if (dark <= 0.0)'));
    for (const f of ['earth.glsl.js', 'clouds.glsl.js']) {
        const mod = await shader(f);
        const src = stripComments((mod.EARTH_SHADER ?? mod.CLOUDS_SHADER).fragment);
        assert.match(src, /col \+= auroraFace\(Ng, V, L\);/, f);
        assert.ok(src.indexOf('auroraFace(Ng, V, L)') < src.indexOf('#include <tonemapping_fragment>'), f);
    }
    const earth = stripComments(read('js/render/earth.js'));
    assert.match(earth, /if \(auroraShellFor\(cfg\)\) d\.AURORA_SHELL = '';/);
});

test('moonlight: a phase-scaled term toward the Moon replaces the constant night fill; the glint skips low', async () => {
    const { EARTH_SHADER } = await shader('earth.glsl.js');
    const frag = stripComments(EARTH_SHADER.fragment);
    assert.doesNotMatch(frag, /vec3\(0\.55, 0\.75, 1\.3\) \* 0\.008;/, 'the old constant is gone');
    assert.match(frag, /\(NIGHT_FLOOR \+ MOON_E \* uMoonK \* NoM\)/);
    assert.match(frag, /#ifdef MOON_GLINT[\s\S]*uMoonK \* 0\.6 \* ocean \* nightW \* \(1\.0 - cloud\)[\s\S]*#endif/);
    const { CLOUDS_SHADER } = await shader('clouds.glsl.js');
    assert.match(stripComments(CLOUDS_SHADER.fragment), /uMoonK \* wrapM/);
    const earth = stripComments(read('js/render/earth.js'));
    assert.match(earth, /if \(cfg\.name !== 'low'\) d\.MOON_GLINT = '';/);
    // Illuminated fraction x the lunar-eclipse sunlit share; the direction is the existing uMoonPosW.
    assert.match(body(earth, 'apply'), /u\.uMoonK\.value = \(Number\.isFinite\(lit\) \? lit : 0\) \* \(Number\.isFinite\(sunlit\) \? sunlit : 1\);/);
});

test('close-zoom lights: B-spline when magnified, lod-gated grain, jittered switch-on; the cloud deck keeps its blur', async () => {
    const { EARTH_SHADER } = await shader('earth.glsl.js');
    const frag = stripComments(EARTH_SHADER.fragment);
    const fn = frag.split('vec3 nightLights(')[1].split('\nvoid main()')[0];
    assert.match(fn, /pcTextureBSpline\(uNight, uv\)/);
    assert.match(fn, /1\.0 - smoothstep\(-3\.0, -1\.5, nLod\)/, 'grain only below lod -1.5');
    assert.match(frag, /col \+= nightLights\(uv\) \* nightW/);
    const { CLOUDS_SHADER } = await shader('clouds.glsl.js');
    assert.match(stripComments(CLOUDS_SHADER.fragment), /textureLod\(uNight, uv, blurLod\)/, 'clouds.glsl night lookup unchanged');
});

test('sculpted clouds: cloudAt untouched (ground shadows stay registered); self-shadow on high and max', async () => {
    const { CLOUD_LOOKUP, EARTH_SHADER } = await shader('earth.glsl.js');
    const lookup = stripComments(CLOUD_LOOKUP);
    assert.match(lookup, /return cloudDensity\(texture\(tex, st\)\.b\) \* polar;/);
    assert.match(stripComments(EARTH_SHADER.fragment), /float c0 = cloudAt\(uClouds, uv \+ duv\);/);
    const { CLOUDS_SHADER } = await shader('clouds.glsl.js');
    const frag = stripComments(CLOUDS_SHADER.fragment);
    assert.match(frag, /float cloud = cloudAt\(uClouds, uv\);/);
    assert.match(frag, /#ifdef CLOUD_SELF_SHADOW/);
    // Erosion: gradient noise off the texel grid (a lattice in step with the texels drew a block
    // mosaic), a whole number of cells per turn, its noise on the edges only.
    assert.match(frag, /float w1 = floor\(csz\.x \* 2\.37 \+ 0\.5\), w2 = floor\(csz\.x \* 8\.93 \+ 0\.5\);/);
    assert.match(frag, /return mix\(mix\(a, b, u\.x\), mix\(c, d, u\.x\), u\.y\);/);
    assert.match(frag, /float thin = 0\.15 \* \(1\.0 - cloud\) \+ 0\.6 \* g \* cloud \* \(1\.0 - cloud\);/);
    assert.doesNotMatch(frag, /csz \* 2\.0;/);
    assert.match(frag, /float beer = \(1\.0 - exp\(-tau\)\) \* \(1\.0 - 0\.5 \* exp\(-2\.0 \* tau\)\);/);
    const earth = stripComments(read('js/render/earth.js'));
    assert.match(earth, /if \(cfg\.name === 'high' \|\| cfg\.name === 'max'\) d\.CLOUD_SELF_SHADOW = '';/);
    assert.match(earth, /cloudMaterial\.defines = c1;/, 'tier switches recompile the cloud shell');
});
