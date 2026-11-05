// Finding things in the real sky (astro/sky-guide.js): hand units, 'find it' sentences, the
// neighbours they lean on, the ruler's numbers and the off-screen pointers' edge geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    handSpan, compassWords16, separationDeg, relativeOffset, findIt, guideRefs, refMagLimit, fmtAngle, rulerText,
    edgeHit, BRIGHT_STARS, FIST_DEG,
} from '../js/astro/sky-guide.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

test('handSpan: fingers below half a fist, then fists in halves', () => {
    assert.equal(handSpan(0.3), 'less than a finger');
    assert.equal(handSpan(1), 'a finger');
    assert.equal(handSpan(2.2), '2 fingers');
    assert.equal(handSpan(3.4), '3 fingers');
    assert.equal(handSpan(5), 'half a fist');
    assert.equal(handSpan(FIST_DEG), '1 fist');
    assert.equal(handSpan(14), '1½ fists');
    assert.equal(handSpan(20.4), '2 fists');
    assert.equal(handSpan(46), '4½ fists');
    assert.equal(handSpan(90), '9 fists');
    assert.equal(handSpan(-1), '');
    assert.equal(handSpan(NaN), '');
});

test('compassWords16 and separations', () => {
    assert.equal(compassWords16(67), 'east-north-east');
    assert.equal(compassWords16(359), 'north');
    assert.equal(compassWords16(-90), 'west');
    assert.ok(Math.abs(separationDeg(10, 0, 350, 0) - 20) < 1e-9, 'across north');
    assert.ok(Math.abs(separationDeg(0, 90, 123, 80) - 10) < 1e-9, 'from the zenith');
    assert.ok(Math.abs(separationDeg(40, 30, 40, 30)) < 1e-9);
});

test('relativeOffset: left and right as you face the reference, across north too', () => {
    // Facing south, a target at a smaller azimuth (toward the east) is on the left.
    const a = relativeOffset({ azDeg: 180, altDeg: 20 }, { azDeg: 160, altDeg: 20 });
    assert.equal(a.words, 'left of');
    assert.ok(a.dx < 0 && Math.abs(a.dy) < 0.06);
    // Facing north, 359° → 9°: right, through the wrap.
    const b = relativeOffset({ azDeg: 359, altDeg: 10 }, { azDeg: 9, altDeg: 10 });
    assert.equal(b.words, 'right of');
    assert.ok(Math.abs(b.sepDeg - 9.85) < 0.05, `${b.sepDeg}`);
    assert.equal(relativeOffset({ azDeg: 90, altDeg: 30 }, { azDeg: 90, altDeg: 45 }).words, 'above');
    assert.equal(relativeOffset({ azDeg: 90, altDeg: 30 }, { azDeg: 100, altDeg: 20 }).words, 'below and to the right of');
});

test('findIt: face, fists up and the nearest neighbour', () => {
    const moon = { name: 'the Moon', azDeg: 150, altDeg: 40 };
    const vega = { name: 'Vega', azDeg: 300, altDeg: 60 };
    const r = findIt({ azDeg: 130, altDeg: 41 }, [vega, moon]);
    assert.equal(r.face, 'south-east');
    assert.equal(r.up, '4 fists');
    assert.equal(r.ref.name, 'the Moon');
    assert.equal(r.ref.words, 'left of');
    assert.equal(r.text, 'Face south-east, 4 fists up from the horizon, 1½ fists left of the Moon.');
    assert.equal(findIt({ azDeg: 10, altDeg: 85 }, []).text, 'Look almost straight up.');
    assert.equal(findIt({ azDeg: 270, altDeg: 1 }, []).text, 'Face west, just above the horizon.');
    assert.equal(findIt({ azDeg: 270, altDeg: -3 }, [moon]), null);
    // Too far from every neighbour: no clause.
    assert.equal(findIt({ azDeg: 0, altDeg: 20 }, [moon]).ref, null);
    // Within 0.6°: right next to it.
    assert.match(findIt({ azDeg: 150.3, altDeg: 40.2 }, [moon]).text, /, right next to the Moon\.$/);
});

test('guideRefs: bright neighbours only, the Sun never, stars by night', () => {
    const snap = createSnapshot();
    // London before dawn, 1 Dec 2026: the Moon near Jupiter and Mars in the south-east.
    computeSnapshot(Date.parse('2026-12-01T04:00:00Z'), { latDeg: 51.5074, lonDeg: -0.1278, elevM: 0 }, snap, { detail: 'full' });
    const refs = guideRefs(snap, 'jupiter');
    const ids = refs.map((r) => r.id);
    assert.ok(ids.includes('moon') && ids.includes('mars'), ids.join());
    assert.ok(!ids.includes('jupiter') && !ids.includes('sun'));
    assert.ok(!ids.includes('uranus'), 'too faint');
    assert.ok(ids.some((id) => id.startsWith('star:')), 'stars by night');
    assert.ok(refs.every((r) => r.altDeg >= 3));
    const moon = refs.find((r) => r.id === 'moon');
    assert.equal(moon.name, 'the Moon');
    // Regulus: J2000 vector against the observer frame agrees with the planets' frame (Mars sits ~1° from it).
    const reg = refs.find((r) => r.name === 'Regulus');
    assert.ok(reg && Math.abs(reg.altDeg - 46) < 8, JSON.stringify(reg));
    const jup = snap.bodies.find((b) => b.id === 'jupiter');
    const guide = findIt({ azDeg: jup.azDeg, altDeg: jup.altDeg, mag: jup.mag }, refs);
    // Regulus and Mars are nearer, but far fainter than Jupiter: the Moon is the signpost.
    assert.equal(guide.text, 'Face south-south-east, 5 fists up from the horizon, 1 fist above and to the right of the Moon.');
    // Uranus (mag 5.6) takes the nearest bright neighbour, whatever it is.
    const ura = snap.bodies.find((b) => b.id === 'uranus');
    assert.match(findIt({ azDeg: ura.azDeg, altDeg: ura.altDeg, mag: ura.mag }, guideRefs(snap, 'uranus')).text, /^Face west, 3 fists up from the horizon, .+ of Aldebaran\.$/);
    // Nothing comparable near: a fainter neighbour after all.
    const moon2 = snap.bodies[1];
    assert.ok(findIt({ azDeg: moon2.azDeg, altDeg: moon2.altDeg, mag: -10 }, guideRefs(snap, 'moon')).ref);
    assert.equal(refMagLimit(10), -3.5);
    assert.equal(BRIGHT_STARS.length, 24);
});

test('fmtAngle and rulerText', () => {
    assert.equal(fmtAngle(0.7), '42′');
    assert.equal(fmtAngle(4.24), '4.2°');
    assert.equal(fmtAngle(36.6), '37°');
    assert.equal(rulerText(11.9), '11.9° · about 1 fist');
    assert.equal(rulerText(NaN), '');
});

test('edgeHit: where a ray from the centre leaves the free area', () => {
    const o = { x: 0, y: 0, edge: '' };
    edgeHit(50, 50, 1, 0, 0, 0, 100, 100, o);
    assert.deepEqual(o, { x: 100, y: 50, edge: 'right' });
    edgeHit(50, 50, -1, -1, 0, 0, 100, 200, o);
    assert.deepEqual(o, { x: 0, y: 0, edge: 'left' });
    edgeHit(50, 50, 0.2, 1, 0, 0, 100, 100, o);
    assert.equal(o.edge, 'bottom');
    assert.ok(Math.abs(o.x - 60) < 1e-9 && o.y === 100);
    // A start outside the rect is clamped in first; a zero direction points right.
    edgeHit(-20, 50, 0, 0, 0, 0, 100, 100, o);
    assert.deepEqual(o, { x: 100, y: 50, edge: 'right' });
});
