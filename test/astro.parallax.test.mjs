// Two places, one sky (js/astro/parallax.js, ROADMAP two-observers): the Moon's parallax between two
// observers and the distance the two sightlines imply, as Lalande and Lacaille measured it in 1751.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSight } from '../js/astro/parallax.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODY_INDEX, AU_KM } from '../js/astro/bodies.js';

const BERLIN = { latDeg: 52.52, lonDeg: 13.40, elevM: 0 };
const CAPE = { latDeg: -33.92, lonDeg: 18.42, elevM: 0 };

function pair(iso, a = BERLIN, b = CAPE) {
    const sa = createSnapshot(), sb = createSnapshot();
    computeSnapshot(Date.parse(iso), a, sa, { detail: 'full' });
    computeSnapshot(Date.parse(iso), b, sb, { detail: 'full' });
    return [sa, sb];
}

test('Berlin and the Cape: the Moon is ~1.35° apart and the sightlines put it within 1% of its distance', () => {
    const [a, b] = pair('2026-11-21T20:00:00Z');
    const r = compareSight(a, b, BODY_INDEX.moon);
    assert.ok(r.sepDeg > 1.2 && r.sepDeg < 1.5, `parallax ${r.sepDeg}°`);
    // The chord through the Earth (the pins sit on the unit sphere), nearly square to the line of sight.
    assert.ok(r.baselineKm > 8600 && r.baselineKm < 8900, `baseline ${r.baselineKm}`);
    assert.ok(r.perpKm <= r.baselineKm && r.perpKm > 0.95 * r.baselineKm, `perp ${r.perpKm}`);
    const trueKm = 0.5 * (a.bodies[BODY_INDEX.moon].distAU + b.bodies[BODY_INDEX.moon].distAU) * AU_KM;
    assert.ok(Math.abs(r.distKm / trueKm - 1) < 0.01, `${r.distKm} vs ${trueKm}`);
});

test('far bodies barely move: the Sun by arcseconds, a planet by less; the same place gives nothing', () => {
    const [a, b] = pair('2026-11-04T12:00:00Z');
    const sun = compareSight(a, b, BODY_INDEX.sun);
    assert.ok(sun.sepDeg * 3600 < 13, `Sun ${sun.sepDeg * 3600}″`);   // 8.8″ per Earth radius of baseline
    const sat = compareSight(a, b, BODY_INDEX.saturn);
    assert.ok(sat.sepDeg * 3600 < 1.5, `Saturn ${sat.sepDeg * 3600}″`);
    const [c, d] = pair('2026-11-04T12:00:00Z', BERLIN, BERLIN);
    const same = compareSight(c, d, BODY_INDEX.moon);
    assert.equal(same.sepDeg, 0);
    assert.ok(Number.isNaN(same.distKm), 'no distance without an angle');
});

test('reuses its out object and refuses incomplete snapshots', () => {
    const [a, b] = pair('2026-11-21T20:00:00Z');
    const out = { sepDeg: 0, baselineKm: 0, perpKm: 0, distKm: NaN };
    assert.equal(compareSight(a, b, BODY_INDEX.moon, out), out);
    assert.equal(compareSight(a, null, BODY_INDEX.moon), null);
    assert.equal(compareSight(a, b, 42), null);
});
