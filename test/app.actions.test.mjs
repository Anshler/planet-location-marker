// Tests for the pure helpers of js/app/actions.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowPoint } from '../js/app/actions.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { distanceKm } from '../js/geo/coords.js';

test('shadowPoint lands on the greatest eclipse of 2027-02-06 (annular, South Atlantic off Brazil)', () => {
    // NASA: greatest eclipse 2027-02-06 15:59:43 TD at 31°18′S 48°31′W.
    const snap = createSnapshot();
    const observer = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 0, tz: 'Asia/Ho_Chi_Minh', name: 'Hanoi', country: 'VN', source: 'url' };
    computeSnapshot(Date.parse('2027-02-06T15:59:33Z'), observer, snap, { detail: 'frame' });
    const p = shadowPoint(snap);
    const km = distanceKm(p.latDeg, p.lonDeg, -31.3, -48.52);
    assert.ok(km < 150, `shadow axis at ${p.latDeg.toFixed(2)}, ${p.lonDeg.toFixed(2)} is ${Math.round(km)} km from greatest eclipse`);
});
