// Planet medallions and the shared impostor shader (render/planets.js, shaders/planets.glsl.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { SATURN_RINGS, ringAt, grsLongitudeDeg, createDiscFrame, createDiscView } from '../js/astro/disc.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODY_INDEX } from '../js/astro/bodies.js';
import { MOON_OCCULTED } from '../js/astro/moons.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { PLANET_CHUNK, MEDALLION_FRAG, MEDALLION_VERT, planetUniforms, PLANET_KIND } = await import('../js/render/shaders/planets.glsl.js');
const { medallionFootprint, writeDiscInstance, writeJupiterMoons, createPlanets, MEDALLION_R, MEDALLION_SEL_R } = await import('../js/render/planets.js');

test('R6: the medallion fragment ends with the tonemapping and colorspace includes', () => {
    const body = MEDALLION_FRAG.trim();
    assert.match(body, /#include <tonemapping_fragment>\s*#include <colorspace_fragment>\s*}\s*$/);
    assert.ok(MEDALLION_FRAG.includes(PLANET_CHUNK));
    assert.match(MEDALLION_VERT, /attribute vec3 iCenter;/);
});

test('the shader\'s ring profile is generated from SATURN_RINGS (ringAt mirrors plRing)', () => {
    for (const [r0, r1, tau, alb] of SATURN_RINGS) {
        assert.ok(PLANET_CHUNK.includes(r0.toFixed(3)) && PLANET_CHUNK.includes(r1.toFixed(3)), `edges ${r0}–${r1}`);
        assert.ok(PLANET_CHUNK.includes(alb.toFixed(3)), `albedo ${alb}`);
        assert.ok(PLANET_CHUNK.includes(tau.toFixed(3)), `tau ${tau}`);
    }
    assert.equal(ringAt(1.0)[0], 0);
    assert.ok(ringAt(1.9)[0] > 2);
    assert.deepEqual(Object.values(PLANET_KIND), [0, 1, 2, 3, 4, 5, 6]);
    const u = planetUniforms(THREE);
    assert.equal(u.uPlMoon.value.length, 4);
    assert.equal(u.uPlShadow.value.length, 4);
});

test('Great Red Spot longitude: System II fixed, so it drifts ~0.27°/day in System III', () => {
    const a = grsLongitudeDeg(Date.UTC(2026, 10, 3));
    const b = grsLongitudeDeg(Date.UTC(2026, 10, 13));
    assert.ok(a >= -180 && a <= 180 && b >= -180 && b <= 180);
    const d = ((a - b + 540) % 360) - 180;
    assert.ok(Math.abs(d - 2.66) < 0.01, `${d}`);
});

test('medallion footprints: planets only; Saturn widens for its rings, Jupiter for its moons; selection grows them', () => {
    assert.equal(medallionFootprint('sun', false), null);
    assert.equal(medallionFootprint('moon', true), null);
    const mars = medallionFootprint('mars', false);
    assert.deepEqual(mars, [2 * MEDALLION_R, 2 * MEDALLION_R, 2 * MEDALLION_R]);
    const jup = medallionFootprint('jupiter', false);
    assert.ok(jup[0] > 2.5 * jup[1], `Jupiter ${jup}`);
    const sat = medallionFootprint('saturn', false);
    assert.ok(sat[0] > 2 * MEDALLION_R && sat[2] >= sat[0] - 4, `Saturn ${sat}`);
    assert.ok(medallionFootprint('venus', true)[0] === 2 * MEDALLION_SEL_R);
});

test('impostor instance data: frame vectors in the planet-north-up frame; hidden moons are not drawn', () => {
    const s = createSnapshot();
    computeSnapshot(Date.parse('2026-11-03T22:00:00Z'), { latDeg: 10.82, lonDeg: 106.63, elevM: 0 }, s);
    const pole = new Float32Array(21), prime = new Float32Array(21), light = new Float32Array(21);
    const f = createDiscFrame(), v = createDiscView();
    const jup = s.bodies[BODY_INDEX.jupiter];
    writeDiscInstance(jup, jup.poleS, f, v, pole, prime, light, 3);
    assert.ok(Math.abs(pole[9]) < 1e-6, 'pole has no x in a pole-up frame');
    assert.ok(Math.abs(Math.hypot(light[9], light[10], light[11]) - 1) < 1e-6);
    const u = planetUniforms(THREE);
    writeJupiterMoons(s, f, u, true);
    for (let k = 0; k < 4; k++) {
        const m = u.uPlMoon.value[k];
        assert.equal(m.z, s.galilean.state[k] & MOON_OCCULTED ? 0 : m.z);
        assert.ok(Math.hypot(m.x, m.y) < 3.1, 'log-spaced within the quad');
    }
    // Io is behind Jupiter at 2026-11-03T22:00Z (the verifier's AE check).
    assert.ok(s.galilean.state[0] & MOON_OCCULTED);
    assert.equal(u.uPlMoon.value[0].z, 0);
});

test('the module: RenderModule shape, footprints sent to the beams, no medallion before an anchor lands', () => {
    const fp = new Map();
    const anchors = new Map();
    const beams = {
        labelAnchor: (id) => anchors.get(id) ?? new Float64Array([NaN, NaN, NaN]),
        setFootprint: (id, w, h) => fp.set(id, [w, h]),
    };
    const rc = { tier: { name: 'high' }, renderer: null, invalidate() {} };
    const m = createPlanets(rc, { beams, isLabelShown: () => true });
    for (const k of ['object3d', 'apply', 'update', 'setLayers', 'setViewMode', 'setSelection', 'setQuality', 'dispose']) assert.ok(k in m, k);
    assert.deepEqual(fp.get('mars'), [MEDALLION_R, MEDALLION_R]);
    m.setSelection('mars');
    assert.deepEqual(fp.get('mars'), [MEDALLION_SEL_R, MEDALLION_SEL_R]);
    m.setLayers({ beams: false });
    assert.deepEqual(fp.get('mars'), [0, 0]);
    assert.equal(m.enabled, false);
    m.setLayers({ beams: true });
    const s = createSnapshot();
    computeSnapshot(Date.parse('2026-11-03T22:00:00Z'), { latDeg: 0, lonDeg: 0, elevM: 0 }, s);
    m.apply(s);
    m.update({ dtMs: 16, skyBlend: 0 });
    const mesh = m.object3d.children[0];
    assert.equal(mesh.visible, true);
    const alpha = mesh.geometry.getAttribute('iAlpha').array;
    assert.ok(Array.from(alpha).every((a) => a === 0), 'NaN anchors: nothing drawn');
    anchors.set('saturn', new Float64Array([1, 2, 3]));
    for (let i = 0; i < 20; i++) m.update({ dtMs: 16, skyBlend: 0 });
    assert.ok(alpha[4] > 0.5, 'Saturn fades in once its anchor lands');
    m.update({ dtMs: 16, skyBlend: 1 });
    assert.equal(mesh.visible, false, 'sky view: hidden');
    m.dispose();
    assert.deepEqual(fp.get('saturn'), [0, 0]);
});
