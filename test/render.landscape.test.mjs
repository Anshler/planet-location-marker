// Sky view 2.0 ground (procedural-landscape, twilight-lit-ground, sky-view-refraction): the GLSL
// mirrors of the pure JS (refraction, Bennett's inverse, the profile lookup) and the wiring that
// keeps the drawn sky, picking, the flare and the labels on one geometry. Render modules import
// three, so like render.transition.test.mjs these checks read source text; the shader modules are
// plain strings and are imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HORIZON_SAMPLES } from '../js/geo/horizon.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const shader = (f) => import(pathToFileURL(path.join(ROOT, 'js/render/shaders', f)).href);
const strip = (g) => g.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const sky = await shader('sky.glsl.js');
const bodies = await shader('bodies.glsl.js');
const ground = await shader('ground.glsl.js');

test('REFRACT_CHUNK is photometry.refractionDeg (Saemundsson, clamped at −1°, tapered to the nadir)', () => {
    const g = strip(sky.REFRACT_CHUNK);
    assert.match(g, /float hd = max\(h, -1\.0\);/);
    assert.match(g, /1\.02 \/ \(60\.0 \* tan\(radians\(hd \+ 10\.3 \/ \(hd \+ 5\.11\)\)\)\)/);
    assert.match(g, /h < -1\.0 \? r \* \(h \+ 90\.0\) \/ 89\.0 : r/);
    assert.match(g, /min\(h \+ uRefrK \* refractionDeg\(h\), 90\.0\)/, 'strength = the view blend');
    const js = read('js/astro/photometry.js');
    assert.match(js, /\(1\.02 \/ Math\.tan\(\(hd \+ 10\.3 \/ \(hd \+ 5\.11\)\) \* DEG\)\) \/ 60/);
    assert.match(js, /if \(altDeg < -1\) r \*= \(altDeg \+ 90\) \/ 89;/);
});

test('every at-infinity element is lifted in the vertex shader; the Moon per vertex, about the camera', () => {
    assert.match(strip(sky.INFINITY_VERT_CHUNK), /mat3\(viewMatrix\) \* refractLift\(dirW\)/);
    const line = strip(sky.LINE_VERT);
    assert.match(line, /vec3 a0 = mat3\(viewMatrix\) \* refractLift\(normalize\(M \* iA\)\);/);
    assert.match(line, /vec3 b0 = mat3\(viewMatrix\) \* refractLift\(normalize\(M \* iB\)\);/);
    const moon = strip(bodies.MOON_VERT);
    assert.ok(moon.indexOf('vPw = pw.xyz;') < moon.lastIndexOf('refractLift('), 'lighting and the umbra use the true position');
    assert.match(moon, /pw\.xyz = cameraPosition \+ refractLift\(rel \/ L\) \* L;/);
});

test('DISC_FRAG flattens the Sun with Bennett (photometry.refractionFromApparentDeg), relative to its centre', () => {
    const g = strip(bodies.DISC_FRAG);
    assert.match(g, /1\.0 \/ \(60\.0 \* tan\(radians\(hd \+ 7\.31 \/ \(hd \+ 4\.4\)\)\)\)/);
    assert.match(g, /ha - uRefrV\.w \* bennettDeg\(ha\) - \(uRefrV\.z - uRefrV\.w \* bennettDeg\(uRefrV\.z\)\)/);
    assert.match(g, /float disc = 1\.0 - smoothstep\(uCoreR - uEdge, uCoreR \+ uEdge, rt\);/, 'the disc uses true-altitude radii');
    assert.match(g, /exp\(-r \/ uGlowScale\)/, 'the glow stays round');
    assert.match(read('js/astro/photometry.js'), /1 \/ Math\.tan\(\(h \+ 7\.31 \/ \(h \+ 4\.4\)\) \* DEG\) \/ 60/);
});

test('materials sharing a program all declare the lift; the alt-az grid passes none (apparent already)', () => {
    const skyJs = read('js/render/sky.js');
    assert.match(skyJs, /uRefrUp: refr\.uRefrUp,\s*uRefrK: refr\.uRefrK,/, 'createLineLayer always declares both');
    const layer = (name) => skyJs.slice(skyJs.indexOf(`name: '${name}'`), skyJs.indexOf('});', skyJs.indexOf(`name: '${name}'`)));
    for (const n of ['sky.constellations', 'sky.eqgrid', 'sky.ecliptic']) assert.match(layer(n), /refraction: refr/, n);
    assert.doesNotMatch(layer('sky.altaz'), /refraction/);
    assert.equal((skyJs.match(/\.\.\.refr,/g) || []).length, 2, 'stars and the Milky Way');
    const bodiesJs = read('js/render/bodies.js');
    assert.equal((bodiesJs.match(/\.\.\.refr,/g) || []).length, 6, 'Sun, aureole, glyphs, reticle, Moon and its depth pass');
    assert.match(bodiesJs, /name: 'bodies\.moon\.depth', vertexShader: MOON_VERT, uniforms: \{ \.\.\.refr, uNearZ: moonNearZ \}/);
    assert.match(read('js/render/trails.js'), /refraction: refr/);
    assert.match(read('js/render/totality.js'), /uRefrK: \{ value: 0 \}/);
});

test("time-lapse ghosts take the live planet glyph's exposure, the daytime display factor included", () => {
    const trails = read('js/render/trails.js');
    assert.match(trails, /gUniforms\.uExposure\.value = planetsExp \* skyViewExposure\(sunAltDeg, refr\.uRefrK\.value, obscuration\);/);
    assert.match(read('js/render/bodies.js'), /glyphUniforms\.uExposure\.value = planetsExp \* display;/);
    assert.match(read('js/render/bodies.js'), /const display = skyViewExposure\(sunAltDeg, skyBlend, obscuration\);/);
});

test('the profile texture is read exactly like horizonAltDeg (two texels, linear in azimuth)', () => {
    const g = strip(ground.LANDSCAPE_CHUNK);
    assert.match(g, /float x = azDeg \/ 360\.0 \* fn;/);
    assert.match(g, /x -= floor\(x \/ fn\) \* fn;/);
    assert.match(g, /mix\(texelFetch\(uHorizon, ivec2\(a, 0\), 0\), texelFetch\(uHorizon, ivec2\(b, 0\), 0\), x - i0\)/);
    assert.ok(HORIZON_SAMPLES <= 2048, 'WebGL2 guarantees 2048-texel textures');
    const groundJs = read('js/render/ground.js');
    assert.match(groundJs, /new THREE\.DataTexture\(hData, HORIZON_SAMPLES, 1, THREE\.RGBAFormat, THREE\.FloatType\)/);
    assert.match(groundJs, /hData\[i \* 4 \+ 3\] = horizon\.alt\[i\];/, 'alpha = the silhouette every JS test reads');
    assert.match(groundJs, /THREE\.NearestFilter/);
});

test('the ground draws the silhouette with fwidth AA, keeps the flat horizon with the layer off, and stays cheap on low', () => {
    const g = strip(ground.GROUND_FRAG);
    assert.match(g, /if \(uLandscape > 0\.5\) \{/);
    assert.match(g, /float w = clamp\(0\.75 \* fwidth\(hDeg\), 0\.003, 0\.3\);/);
    assert.match(g, /a = 1\.0 - smoothstep\(-w, w, hDeg - P\.a\);/);
    // Trees and roofs reach down to their own foot (0.06° below the horizon), so a telescope field
    // shows no seam across them at 0°; the far ridge's foot is the horizon.
    assert.match(g, /float above = smoothstep\(-w, w, hDeg \+ min\(P\.g, 0\.06\)\);/);
    // Layer off: the mathematical horizon, with the same pixel-wide edge (a fixed width in sin(alt)
    // filled the telescope's 0.2° field with a see-through gradient).
    assert.match(g, /\} else \{\s*float hDeg = degrees\(asin\(clamp\(h, -1\.0, 1\.0\)\)\);\s*float w = clamp\(0\.75 \* fwidth\(hDeg\), 0\.003, 0\.3\);\s*a = 1\.0 - smoothstep\(-w, w, hDeg\);/);
    assert.doesNotMatch(g, /smoothFall\(0\.0025, -0\.0025, h\)/);
    assert.match(g, /#ifdef LANDSCAPE_DETAIL[\s\S]*seaColor\(/);
    const groundJs = read('js/render/ground.js');
    assert.match(groundJs, /c && c\.name !== 'low' \? \{ LANDSCAPE_DETAIL: '', LANDSCAPE_GLINT: '' \} : \{\}/);
    assert.match(groundJs, /horizon\.enabled = l\.landscape !== false;/);
});

test('twilight-lit ground: tied to the dome\'s twilight factor and kept under the brightened haze band', () => {
    const g = strip(ground.GROUND_FRAG);
    assert.match(g, /float tw = smoothFall\(4\.0, -1\.0, uSunAltDeg\) \* exp\(-max\(-uSunAltDeg, 0\.0\) \/ 5\.5\)/);
    // Display-referred levels: the twilight term at −3°, −6° and −12° (its luminance).
    const smoothFall = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const smoothstep = (e0, e1, x) => smoothFall(e0, e1, x);
    const tw = (a) => smoothFall(4, -1, a) * Math.exp(-Math.max(-a, 0) / 5.5) * smoothstep(-17, -10, a) * (1 - smoothstep(2, 12, a));
    // The Earth palette (GROUND_FRAG's #else branch; #define MARS swaps in the Martian one).
    assert.match(g, /\+ G_TWI \* tw \+/);
    const m = g.match(/#else[\s\S]*?const vec3 G_TWI = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\);/);
    assert.ok(m, 'twilight ground colour');
    const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
    const at = (a) => lum * tw(a);
    assert.ok(at(-3) > 0.02 && at(-3) < 0.035, `−3°: ${at(-3)}`);
    assert.ok(at(-6) > 0.01 && at(-6) < 0.025, `−6°: ${at(-6)}`);
    assert.ok(at(-12) < 0.006 && at(-17) === 0, `−12°: ${at(-12)}`);
    // The haze band gets more twilight light than the land (×0.25 at the horizon line, on top of the sky).
    assert.match(g, /hazeCol \+= \(H_TWI \* tw/);
    const h = g.match(/#else[\s\S]*?const vec3 H_TWI = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\);/);
    assert.ok(h);
    const hl = 0.2126 * Number(h[1]) + 0.7152 * Number(h[2]) + 0.0722 * Number(h[3]);
    assert.ok(hl > 1.5 * lum, `haze ${hl} vs land ${lum}`);
});

test('one horizon for everything: the flare, picking and labels test the shared profile with the lift', () => {
    assert.match(read('js/render/flare.js'), /clearanceDeg\(horizon, sunA, upA, northA, eastA, skyBlend\)/);
    assert.match(read('js/render/bodies.js'), /clearanceDeg\(horizon, d, upS, northS, eastS, skyBlend\) < -0\.3/);
    const labels = read('js/render/labels.js');
    assert.match(labels, /liftByRefraction\(d, upS, refrK, LIFT\)/);
    assert.match(labels, /horizonAltDeg\(landscape, azimuthDeg\(d, northS, eastS\)\)/);
    assert.match(read('js/app/labels-feed.js'), /labelBelow\(snap\.bodies\[i\], sky, view && view\.horizon\)/);
    const main = read('js/main.js');
    for (const m of ['createBodies(rc, { textures, horizon })', 'createGround(rc, { textures, horizon, cities })', 'createFlare(rc, { horizon })']) {
        assert.ok(main.includes(m), m);
    }
    assert.match(main, /getTierCfg: \(\) => currentCfg, horizon,/);
});
