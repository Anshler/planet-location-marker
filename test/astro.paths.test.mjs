// Apparent paths and stationary points (SPEC §C.2, §H).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import { apparentPath, stationaryPoints } from '../js/astro/paths.js';
import * as F from '../js/astro/frames.js';

const DAY = 864e5;
const within = (ms, iso, days) => Math.abs(ms - Date.parse(iso)) <= days * DAY;

const mars = apparentPath('mars', Date.parse('2025-01-16T00:00:00Z'));
const marsStations = stationaryPoints(mars);

test('Mars retrograde starts about 2024-12-07 (±3 d) and ends about 2025-02-24 (±3 d)', () => {
    assert.equal(marsStations.length, 2);
    const [start, end] = marsStations;
    assert.equal(start.kind, 'retrograde-start');
    assert.equal(end.kind, 'retrograde-end');
    assert.ok(within(start.tMs, '2024-12-07T00:00:00Z', 3), new Date(start.tMs).toISOString());
    assert.ok(within(end.tMs, '2025-02-24T00:00:00Z', 3), new Date(end.tMs).toISOString());
    // During retrograde the ecliptic longitude decreases.
    assert.ok(end.eclLonDeg < start.eclLonDeg);
});

test('apparentPath: sample layout, unit scene directions, geocentric GeoVector(…, true) and Ecliptic() longitudes', () => {
    assert.equal(mars.bodyId, 'mars');
    assert.equal(mars.tMs.length, 361);
    assert.ok(mars.tMs instanceof Float64Array && mars.dirS instanceof Float32Array && mars.eclLonDeg instanceof Float64Array);
    assert.equal(mars.dirS.length, 3 * 361);
    assert.equal(mars.tMs[180], Date.parse('2025-01-16T00:00:00Z'));
    assert.equal(mars.tMs[1] - mars.tMs[0], DAY);
    for (let i = 0; i < mars.tMs.length; i += 37) {
        const d = [mars.dirS[3 * i], mars.dirS[3 * i + 1], mars.dirS[3 * i + 2]];
        assert.ok(Math.abs(F.length3(d) - 1) < 1e-6);
        const g = AE.GeoVector('Mars', AE.MakeTime(new Date(mars.tMs[i])), true);
        assert.ok(F.angleBetween3(d, F.normalize3(F.eqjToScene(g))) < 1e-6);
        assert.ok(Math.abs(mars.eclLonDeg[i] - AE.Ecliptic(g).elon) < 1e-9);
    }
    const hourly = apparentPath('venus', Date.parse('2026-10-24T00:00:00Z'), 2, 6);
    assert.equal(hourly.tMs.length, 17);
    assert.equal(hourly.tMs[1] - hourly.tMs[0], 6 * 3600e3);
});

test('stationary points carry exact directions; interpolation-only paths agree within a couple of hours', () => {
    for (const s of marsStations) {
        const g = AE.GeoVector('Mars', AE.MakeTime(new Date(s.tMs)), true);
        assert.ok(F.angleBetween3(s.dirS, F.normalize3(F.eqjToScene(g))) < 1e-9);
        assert.ok(Array.isArray(s.dirS) && s.dirS.length === 3);
    }
    const anonymous = stationaryPoints({ tMs: mars.tMs, dirS: mars.dirS, eclLonDeg: mars.eclLonDeg });
    assert.equal(anonymous.length, 2);
    for (let i = 0; i < 2; i++) {
        assert.equal(anonymous[i].kind, marsStations[i].kind);
        assert.ok(Math.abs(anonymous[i].tMs - marsStations[i].tMs) < 2 * 3600e3);
        assert.ok(Math.abs(F.length3(anonymous[i].dirS) - 1) < 1e-6);
    }
});

test('known 2026 retrogrades: Venus Oct 3 – Nov 14, Mercury Oct 24 – Nov 13 (±2 d)', () => {
    const venus = stationaryPoints(apparentPath('venus', Date.parse('2026-10-24T00:00:00Z'), 60));
    assert.deepEqual(venus.map((s) => s.kind), ['retrograde-start', 'retrograde-end']);
    assert.ok(within(venus[0].tMs, '2026-10-03T00:00:00Z', 2) && within(venus[1].tMs, '2026-11-14T00:00:00Z', 2));
    const mercury = stationaryPoints(apparentPath('mercury', Date.parse('2026-11-04T00:00:00Z'), 20));
    assert.deepEqual(mercury.map((s) => s.kind), ['retrograde-start', 'retrograde-end']);
    assert.ok(within(mercury[0].tMs, '2026-10-24T00:00:00Z', 2) && within(mercury[1].tMs, '2026-11-13T00:00:00Z', 2));
});

test('the Sun and Moon never turn retrograde; longitudes wrapping through 0° do not create false stations', () => {
    assert.deepEqual(stationaryPoints(apparentPath('sun', Date.parse('2026-03-20T00:00:00Z'))), []);
    assert.deepEqual(stationaryPoints(apparentPath('moon', Date.parse('2026-10-11T00:00:00Z'), 60, 6)), []);
});

test('input validation', () => {
    assert.throws(() => apparentPath('pluto', 0), RangeError);
    assert.throws(() => apparentPath('mars', NaN), TypeError);
    assert.throws(() => apparentPath('mars', 0, 0), RangeError);
    assert.throws(() => apparentPath('mars', 0, 10, -1), RangeError);
    assert.deepEqual(stationaryPoints(null), []);
    assert.deepEqual(stationaryPoints({ eclLonDeg: new Float64Array(2) }), []);
});
