// Body registry and constants (SPEC §C.2, ADDENDUM A5).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../js/astro/bodies.js';
import { AE } from '../js/astro/ae.js';

test('BODIES order, ids, astronomy-engine names and keys are the contract', () => {
    assert.deepEqual(B.BODIES.map((b) => b.id), ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
    assert.deepEqual(B.BODIES.map((b) => b.key), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    for (const b of B.BODIES) {
        assert.equal(AE.Body[b.ae], b.ae, `${b.ae} is an astronomy-engine body`);
        assert.ok(['star', 'moon', 'planet'].includes(b.kind));
        assert.match(b.color, /^#[0-9a-f]{6}$/);
        assert.ok(b.radiusKm > 0);
    }
    assert.ok(Object.isFrozen(B.BODIES), 'an accidental in-place sort must not reorder the contract');
    assert.deepEqual(B.BODY_IDS, B.BODIES.map((b) => b.id));
});

test('colours are identical to the CSS custom properties in ADDENDUM A5', () => {
    const css = { sun: '#ffd36b', moon: '#d8dde6', mercury: '#b9b2aa', venus: '#fff4d6', mars: '#ff6a3d', jupiter: '#e9c08f',
        saturn: '#e8c872', uranus: '#9fe3e6', neptune: '#7f97ff' };
    for (const b of B.BODIES) assert.equal(b.color, css[b.id]);
});

test('BODY_INDEX, bodyById and isBodyId', () => {
    B.BODIES.forEach((b, i) => {
        assert.equal(B.BODY_INDEX[b.id], i);
        assert.equal(B.bodyById(b.id), b);
        assert.equal(B.isBodyId(b.id), true);
    });
    for (const bad of ['pluto', '', 'constructor', '__proto__', 'toString', null, undefined, 3]) {
        assert.equal(B.bodyById(bad), null, String(bad));
        assert.equal(B.isBodyId(bad), false);
    }
});

test('physical constants', () => {
    assert.equal(B.AU_KM, 149597870.7);
    assert.equal(B.EARTH_RADIUS_KM, 6378.137);
    assert.ok(Math.abs(B.AU_ER - 23454.79) < 0.01);
    assert.ok(Math.abs(B.MOON_RADIUS_ER - 0.27240) < 1e-5);
    assert.equal(B.LIGHT_S_PER_AU, 499.004784);
    assert.equal(B.SUN_ANG_RADIUS_RAD, 0.0046542);
    // Light time per AU agrees with astronomy-engine's speed of light.
    assert.ok(Math.abs(B.LIGHT_S_PER_AU - 86400 / AE.C_AUDAY) < 1e-6);
});
