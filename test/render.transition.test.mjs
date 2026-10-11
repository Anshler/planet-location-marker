// Globe ↔ sky transition geometry (round 3). Up in the descent the globe's rim sits several degrees
// below the sky-view horizon, so while the globe (or its atmosphere shell, or clouds) is still
// partly visible the rim must stay out of the camera's view: otherwise a second, polygon-edged
// horizon shows below the sky-view one, with the shell's limb glow between them (clipped to white
// on the low tier). The render side hides the globe once skyBlend reaches GROUND_COVER_AT
// (render/sky.js groundCover); the rig's DESCENT_* curves (camera/rig.js) must keep the rim out of
// view until then. Both files import three, so this test reads their constants from the source and
// replays the rig's pose formulas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rig = fs.readFileSync(path.join(ROOT, 'js/camera/rig.js'), 'utf8');
const sky = fs.readFileSync(path.join(ROOT, 'js/render/sky.js'), 'utf8');

const num = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = (-?[\\d.]+);`));
    assert.ok(m, `${name} not found`);
    return Number(m[1]);
};
const pair = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = \\[(-?[\\d.]+), (-?[\\d.]+)\\];`));
    assert.ok(m, `${name} not found`);
    return [Number(m[1]), Number(m[2])];
};

const C = {
    EYE_R: num(rig, 'EYE_R'), ABOVE_R: num(rig, 'ABOVE_R'), ORBIT_FOV: num(rig, 'ORBIT_FOV'), SKY_FOV: num(rig, 'SKY_FOV'),
    SKY_FOV_MIN: num(rig, 'SKY_FOV_MIN'), SKY_FOV_MAX: num(rig, 'SKY_FOV_MAX'),
    SKY_ALT_MIN: num(rig, 'SKY_ALT_MIN'), SKY_ALT_MAX: num(rig, 'SKY_ALT_MAX'),
    BLEND: pair(rig, 'DESCENT_BLEND'), PITCH: pair(rig, 'DESCENT_PITCH'), COVER_AT: num(sky, 'GROUND_COVER_AT'),
};
const D = Math.PI / 180;
const S = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const cover = (b) => Math.min(1, Math.max(0, b / C.COVER_AT));

/** Highest altitude (deg) anywhere in a roll-free view: the top centre, or a top corner. */
function topAlt(pitchDeg, fovDeg, aspect) {
    const T = Math.tan(fovDeg / 2 * D), H = T * aspect, p = pitchDeg * D;
    const num = Math.sin(p) + Math.cos(p) * T;
    const asin = (x) => Math.asin(Math.max(-1, Math.min(1, x))) / D;
    return Math.max(asin(num / Math.sqrt(1 + T * T)), asin(num / Math.sqrt(1 + T * T + H * H)));
}
const dipDeg = (r) => Math.acos(1 / r) / D;   // the globe's horizon below the local horizontal

const ASPECTS = [0.45, 1, 1.6, 2.4];
const ALTS = [C.SKY_ALT_MIN, 0, 15, 45, C.SKY_ALT_MAX];
const MARGIN_DEG = 2;

test('the rig mirrors its descent curves in the ascent and they start/end at the phase boundaries', () => {
    assert.match(rig, /skyBlend = smoothstep\(DESCENT_BLEND\[0\], DESCENT_BLEND\[1\], k\);/);
    assert.match(rig, /skyBlend = 1 - smoothstep\(1 - DESCENT_BLEND\[1\], 1 - DESCENT_BLEND\[0\], k\);/);
    assert.match(rig, /\(-90 \+ \(t\.look\.alt \+ 90\) \* smoothstep\(DESCENT_PITCH\[0\], DESCENT_PITCH\[1\], k\)\) \* DEG/);
    assert.match(rig, /\(t\.alt0 \+ \(-90 - t\.alt0\) \* smoothstep\(1 - DESCENT_PITCH\[1\], 1 - DESCENT_PITCH\[0\], k\)\) \* DEG/);
    // Continuity with the other phase, where skyBlend is 0.
    assert.equal(C.BLEND[0], 0, 'descent: skyBlend 0 at k = 0');
    assert.ok(C.BLEND[1] <= 1);
});

test('globe → sky: the globe rim stays out of view until the sky-view ground covers it', () => {
    let worst = Infinity;
    for (const aspect of ASPECTS) for (const alt of ALTS) {
        for (let k = 0; k <= 1; k += 0.0005) {
            if (cover(S(C.BLEND[0], C.BLEND[1], k)) >= 0.999) continue;
            const pitch = -90 + (alt + 90) * S(C.PITCH[0], C.PITCH[1], k);
            const fov = C.ORBIT_FOV + (C.SKY_FOV - C.ORBIT_FOV) * k;
            const r = 1 + Math.exp(Math.log(C.ABOVE_R - 1) + (Math.log(C.EYE_R - 1) - Math.log(C.ABOVE_R - 1)) * k);
            worst = Math.min(worst, -dipDeg(r) - topAlt(pitch, fov, aspect));
        }
    }
    assert.ok(worst >= MARGIN_DEG, `rim margin ${worst.toFixed(2)}° < ${MARGIN_DEG}°`);
});

test('sky → globe: the globe returns only once its rim has left the view', () => {
    let worst = Infinity;
    for (const aspect of ASPECTS) for (const alt0 of ALTS) for (const fov0 of [C.SKY_FOV_MIN, C.SKY_FOV, C.SKY_FOV_MAX]) {
        for (let k = 0; k <= 1; k += 0.0005) {
            if (cover(1 - S(1 - C.BLEND[1], 1 - C.BLEND[0], k)) >= 0.999) continue;
            const pitch = alt0 + (-90 - alt0) * S(1 - C.PITCH[1], 1 - C.PITCH[0], k);
            const fov = fov0 + (C.ORBIT_FOV - fov0) * k;
            const r = 1 + Math.exp(Math.log(C.EYE_R - 1) + (Math.log(C.ABOVE_R - 1) - Math.log(C.EYE_R - 1)) * k);
            worst = Math.min(worst, -dipDeg(r) - topAlt(pitch, fov, aspect));
        }
    }
    assert.ok(worst >= MARGIN_DEG, `rim margin ${worst.toFixed(2)}° < ${MARGIN_DEG}°`);
});

test('the globe, its clouds and its atmosphere fade with the ground cover; settled views are unchanged', () => {
    assert.equal(cover(0), 0);
    assert.equal(cover(1), 1);
    const atmo = fs.readFileSync(path.join(ROOT, 'js/render/atmosphere.js'), 'utf8');
    assert.match(atmo, /uIntensity\.value = 1 - cover;/);
    const earth = fs.readFileSync(path.join(ROOT, 'js/render/earth.js'), 'utf8');
    assert.match(earth, /cloudFade\.value = 1 - groundCover\(skyBlend\);/);
    const ground = fs.readFileSync(path.join(ROOT, 'js/render/ground.js'), 'utf8');
    assert.match(ground, /gUniforms\.uCover\.value = groundCover\(blend\);/);
});
