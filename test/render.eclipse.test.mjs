// One eclipse geometry on the render side. The render modules import three, so like
// render.transition.test.mjs this reads their source: every solar radius comes from
// astro/bodies.js sunAngularRadius (the true asin(R☉/d), as the snapshot's obscuration uses), the
// globe's umbra uniform is refreshed per snapshot, and the sky view's Moon and flare follow the
// snapshot's topocentric discs. The numbers themselves are tested in astro.snapshot/shadow tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

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

test('no render module or shader hard-codes a solar angular radius', () => {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.js')) files.push(rel);
        }
    };
    walk('js/render');
    const bad = files.filter((f) => /0\.00465\d*|SUN_ANG_RADIUS_RAD\b/.test(stripComments(read(f))));
    assert.deepEqual(bad, []);
});

test('the globe umbra (Earth, clouds, atmosphere) takes the true solar radius from every snapshot', () => {
    for (const f of ['js/render/earth.js', 'js/render/atmosphere.js']) {
        const src = stripComments(read(f));
        assert.match(src, /import \{[^}]*\bsunAngularRadius\b[^}]*\} from '\.\.\/astro\/bodies\.js'/, f);
        assert.match(body(src, 'apply'), /uEclipse\.value\.z = sunAngularRadius\(snap\??\.bodies\?\.\[0\]\?\.distAU\)/, `${f} apply()`);
    }
    // The cloud shell shares the Earth's uniform object, so it follows too.
    assert.match(stripComments(read('js/render/earth.js')), /uEclipse: u\.uEclipse/);
});

test('sky view: the Moon is drawn along the snapshot dirS at its topocentric distance; Sun, flare and lunar umbra use sunAngularRadius', () => {
    const bodies = stripComments(read('js/render/bodies.js'));
    const apply = body(bodies, 'apply');
    assert.match(apply, /sunR = sunAngularRadius\(snap\.bodies\[SUN\]\.distAU\)/);
    assert.match(apply, /moonUniforms\.uSunR\.value = sunR/);
    assert.match(apply, /moonDistER = snap\.bodies\[MOON\]\.distER/);
    const update = body(bodies, 'update');
    assert.match(update, /c\.x \+ md\[0\] \* moonDistER/, 'mesh at eye + dirS·distER');
    assert.match(update, /moonDrawPos\.copy\(moonPos\)\.lerp\(tmpV, skyBlend\)/, 'blended with the geocentric Moon');
    assert.match(update, /obscuration >= 1 \? 1 - skyBlend : 1/, 'no photosphere drawn in totality');
    assert.match(stripComments(read('js/render/shaders/bodies.glsl.js')), /uniform float uSunR;/);
    const flare = stripComments(read('js/render/flare.js'));
    assert.match(body(flare, 'apply'), /sunR = sunAngularRadius\(s\.distAU\)/);
    assert.match(body(flare, 'update'), /\(1 - obscuration - visM\) \* skyBlend/, 'sky view occludes by obscurationAtObserver');
});

test('totality stars come from the pure exposureFor, not a render-side term', () => {
    const sky = stripComments(read('js/render/sky.js'));
    assert.doesNotMatch(sky, /eclipseStars/);
    assert.match(body(sky, 'update'), /const starExp = exposure\.stars;/);
    const loop = stripComments(read('js/app/loop.js'));
    assert.match(loop, /exposureFor\(sunAlt, skyBlend, exposure, obscuration, tierMagLimit, sky \?\? null\)/);
    assert.match(loop, /updateExposure\(snap\.observer\.sunAltDeg, skyBlend, snap\.eclipse\.obscurationAtObserver,/);
});

test('totality: the Sun material alone carries the SUN_ECLIPSE branch, gated by uniforms and scrubbed', async () => {
    const bodies = stripComments(read('js/render/bodies.js'));
    const sunMat = bodies.match(/name: 'bodies\.sun'[\s\S]*?\}\);/)[0];
    assert.match(sunMat, /defines: \{ SUN_ECLIPSE: '' \}/);
    const aureoleMat = bodies.match(/name: 'bodies\.aureole'[\s\S]*?\}\);/)[0];
    assert.doesNotMatch(aureoleMat, /SUN_ECLIPSE/);
    const { DISC_FRAG } = await import(new URL('../js/render/shaders/bodies.glsl.js', import.meta.url).href);
    const g = stripComments(DISC_FRAG);
    assert.match(g, /#ifdef SUN_ECLIPSE[\s\S]*if \(uThin > 0\.0\)[\s\S]*if \(uTotality > 0\.0 \|\| uChromo > 0\.0\)[\s\S]*return pcFinite\(c\);/);
    assert.match(g, /0\.0532 \* exp\(-2\.5 \* L\) \+ 1\.425 \* exp\(-7\.0 \* L\) \+ 2\.565 \* exp\(-17\.0 \* L\)/, 'Baumbach');
    const main = g.split('void main()')[1];
    assert.ok(main.indexOf('#include <tonemapping_fragment>') > main.indexOf('eclipseLight('));
    // JS side: the corona fades in with the photosphere's light; the pole and the Moon are projected.
    const update = body(bodies, 'update');
    assert.match(update, /coronaSky = coronaVisibility\(obscuration\) \* skyBlend/);
    assert.match(update, /sunUniforms\.uTotality\.value = coronaSky/);
    assert.match(update, /sunUniforms\.uMoon\.value\.set\(/);
    assert.match(update, /sunUniforms\.uPoleUv\.value\.set\(/);
});

test('totality: beads module registered, not depth-tested, flare follows the brightest bead, ring shared', () => {
    const main = stripComments(read('js/main.js'));
    assert.match(main, /totality: import\('\.\/render\/totality\.js'\)/);
    assert.match(main, /create\('totality', m\.totality && \(\(\) => m\.totality\.createTotality\(rc\)\)\)/);
    const tot = stripComments(read('js/render/totality.js'));
    assert.match(tot, /depthTest: false/);
    assert.match(tot, /new Float32Array\(MAX_BEADS \* 3\)/, 'preallocated');
    assert.doesNotMatch(body(tot, 'update'), /new (Float32Array|THREE\.)/, 'no per-frame allocation');
    const flare = stripComments(read('js/render/flare.js'));
    assert.match(body(flare, 'apply'), /snap\.eclipse && snap\.eclipse\.beads/);
    assert.match(body(flare, 'update'), /tmp\.copy\(beadDir\)/);
    const ground = stripComments(read('js/render/ground.js'));
    assert.match(ground, /uEclH1: su\.uEclH1/);
    assert.match(body(ground, 'apply'), /umbraHorizonGlow\(/);
});

// ---- Phase 1: the globe's path ribbon, the eclipse-aware pin and beams --------------------------------

test('the path ribbon: registered in main.js, above the clouds, drawn after them, Earth-fixed, one geometry per eclipse', () => {
    const main = stripComments(read('js/main.js'));
    assert.match(main, /eclipsePath: import\('\.\/render\/eclipse-path\.js'\)/, 'importRenderStack');
    assert.match(main, /create\('eclipsePath', m\.eclipsePath && \(\(\) => m\.eclipsePath\.createEclipsePath\(rc\)\), furniture\)/, 'create list (in the furniture a vantage hides)');
    const src = stripComments(read('js/render/eclipse-path.js'));
    const earth = stripComments(read('js/render/earth.js'));
    const cloudR = Number(earth.match(/const CLOUD_RADIUS = ([\d.]+);/)[1]);
    const ribbonR = Number(src.match(/const RIBBON_R = ([\d.]+);/)[1]);
    assert.ok(ribbonR >= 1.007 && ribbonR > cloudR, `ribbon radius ${ribbonR} above the cloud shell ${cloudR}`);
    const order = Number(src.match(/const RENDER_ORDER = (\d+);/)[1]);
    assert.ok(order > 10 && order + 1 < 20, 'after the clouds (10), before the atmosphere (20)');
    assert.match(src, /depthTest: true,\s*depthWrite: false/);
    assert.match(body(src, 'apply'), /group\.matrix\.copy\(earthM\)/, 'Earth-fixed group');
    // Geometry is built in show() only; apply/update move uniforms and one matrix.
    for (const fn of ['apply', 'update', 'placeMarker']) {
        assert.doesNotMatch(body(src, fn), /new THREE\.|new Float(32|64)Array|ribbonMesh\(/, `${fn}: no allocation`);
    }
    assert.match(body(src, 'show'), /ribbonMesh\(p, \{ radius: RIBBON_R \}\)/);
});

test('eclipse-aware pin and beams: both key on umbraNear from the snapshot', () => {
    const pin = stripComments(read('js/render/pin.js'));
    assert.match(body(pin, 'apply'), /clearT = umbraNear\(snap\);/);
    assert.match(pin, /uniform float uClear;/);
    const beams = stripComments(read('js/render/beams.js'));
    assert.match(body(beams, 'apply'), /uRootClear\.value = umbraNear\(snap, ROOT_CLEAR_RAD\[0\], ROOT_CLEAR_RAD\[1\]\)/);
    assert.match(stripComments(read('js/render/shaders/beam.glsl.js')), /uniform float uRootClear;/);
});
