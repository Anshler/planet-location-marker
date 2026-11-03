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
