// Parts that come and go with simulated time stay in the scene graph (render/satellites.js and the
// modules with the same pattern): three uploads a geometry the first time it projects its object,
// so a part kept `visible = false` until a satellite first rose, the first dusk, a comet's
// apparition, a shower's radiant or totality's beads came round in a time-lapse uploaded a new
// geometry mid-run (the smoke's 'memory stable' flake: geometries 18 → 19). Hidden parts must hide
// through their own material (out of the render list, not out of projection) or an instance count
// of zero.
// In Node with the real three.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { decodeSky } from '../js/data/catalog.js';
import { createExtras } from '../js/astro/extras.js';
import { decodeDso, createDsoProvider } from '../js/astro/dso.js';

register('./helpers/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const { createSky } = await import('../js/render/sky.js');
const { createSatellites } = await import('../js/render/satellites.js');
const { createExtrasLayer } = await import('../js/render/extras.js');
const { createComets } = await import('../js/render/comets.js');
const { createMeteors } = await import('../js/render/meteors.js');
const { createFlare } = await import('../js/render/flare.js');
const { createDsoLayer } = await import('../js/render/dso.js');
const { createTotality } = await import('../js/render/totality.js');

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const rc = { invalidate() {}, tier: { name: 'high', starMagLimit: 6.5, flare: true }, size: { w: 1440, h: 900 }, dpr: 1 };
const snap = createSnapshot();
computeSnapshot(Date.parse('2026-11-04T12:00:00Z'), { latDeg: 51.5, lonDeg: -0.1, elevM: 0 }, snap, { detail: 'frame' });

/** Every object with a geometry under `root`: [name, object]. */
function drawables(root) {
    const out = [];
    root.traverse((o) => { if (o.geometry) out.push([o.name || o.type, o]); });
    return out;
}
const drawn = (o) => o.material.visible !== false && !(o.geometry.isInstancedBufferGeometry && o.geometry.instanceCount === 0)
    && o.geometry.drawRange.count !== 0;

test('time-driven parts stay in the scene graph while hidden: every geometry is projected from the first frame', () => {
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.01, 1000);
    cam.position.set(0, 0, 4);
    const extras = createExtras();
    const sky = createSky(rc, { catalog: decodeSky(read('data/sky.json')) });
    const mods = {
        sky,
        satellites: createSatellites(rc, { extras, sky }),
        extras: createExtrasLayer(rc, { extras, sky }),
        comets: createComets(rc, { extras }),
        meteors: createMeteors(rc, {}),
        flare: createFlare(rc, {}),
        dso: createDsoLayer(rc, { provider: createDsoProvider(decodeDso(read('data/dso.json'))) }),
        totality: createTotality(rc),
    };
    // Broad daylight in sky view, nothing up: the star field, the Milky Way, the deep-sky sprites,
    // the meteors, the beads and every satellite, guest star and comet part have nothing to draw.
    const fi = { snap, camera: cam, skyBlend: 1, systemBlend: 0, exposure: { stars: 0, milkyWay: 0, planets: 1 }, tMs: snap.tMs, timeS: 1, dtMs: 16 };
    for (const m of Object.values(mods)) {
        m.setLayers?.({ satellites: true, beams: true, stars: true, milkyWay: true, meteors: true, deepSky: true });
        m.apply?.(snap);
        m.update?.(fi);
    }
    for (const [mod, m] of Object.entries(mods)) {
        for (const [name, o] of drawables(m.object3d)) {
            if (['sky.eqgrid', 'sky.ecliptic', 'sky.constellations', 'sky.altaz'].includes(name)) continue;   // layers: a user's choice
            assert.equal(o.visible, true, `${mod}: ${name} stays in the scene graph`);
        }
    }
    const hidden = (mod, name) => {
        const o = drawables(mods[mod].object3d).find(([n]) => n === name)?.[1];
        assert.ok(o, `${mod}: ${name} exists`);
        assert.equal(drawn(o), false, `${mod}: ${name} draws nothing`);
    };
    hidden('sky', 'sky.stars');
    hidden('sky', 'sky.milkyway');
    for (const n of ['satellites.dots', 'satellites.sky', 'satellites.ring', 'satellites.beams', 'satellites.track']) hidden('satellites', n);
    for (const n of ['extras.guests', 'extras.marks']) hidden('extras', n);
    for (const n of ['comets.tails', 'comets.coma']) hidden('comets', n);
    for (const n of ['meteors.streaks', 'meteors.radiants']) hidden('meteors', n);
    hidden('flare', 'flare');
    hidden('dso', 'dso.sprites');
    hidden('totality', 'totality.beads');
});

test('the guest stars and the satellites in sky view draw with a copy of the star material on the same uniforms', () => {
    const extras = createExtras();
    const sky = createSky(rc, { catalog: decodeSky(read('data/sky.json')) });
    const sat = drawables(createSatellites(rc, { extras, sky }).object3d).find(([n]) => n === 'satellites.sky')[1];
    const guests = drawables(createExtrasLayer(rc, { extras, sky }).object3d).find(([n]) => n === 'extras.guests')[1];
    for (const o of [sat, guests]) {
        assert.notEqual(o.material, sky.starMaterial, 'its own material, so hiding it leaves the star field alone');
        assert.equal(o.material.uniforms, sky.starMaterial.uniforms, 'the same uniform objects: twinkle, exposure, streaks');
        assert.equal(o.material.vertexShader, sky.starMaterial.vertexShader);
        assert.equal(o.material.fragmentShader, sky.starMaterial.fragmentShader);
        assert.equal(o.material.name, sky.starMaterial.name, 'the same program cache key');
    }
});
