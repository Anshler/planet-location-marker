// Near-Earth SGP4 (astro/sgp4.js) against Vallado's published verification vectors.
//
// test/fixtures/sgp4-vallado.json holds the near-Earth cases of SGP4-VER.TLE and the matching
// rows of tcppver.out (Vallado, Crawford, Hujsak & Kelso, "Revisiting Spacetrack Report #3",
// AIAA 2006-6753, rev. 3; WGS-72), as python-sgp4 (MIT) distributes them: Vanguard 1 (00005, the
// TEME example), Delta 1 debris (06251, moderate drag), 22312, CBERS 2 (28057, e < 1e-4), Cosmos
// 2405 (28350, perigee < 156 km), the decaying Minotaur stage (28872) and SL-14 debris (29141),
// SL-12 debris (29238, perigee < 220 km: the simplified drag equations) and the original STR#3
// case (88888).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTle, sgp4init, sgp4, gstime, temeToEf, tleChecksum, jdOfMs, DEEP_SPACE_MIN } from '../js/astro/sgp4.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/sgp4-vallado.json', import.meta.url), 'utf8'));

test('Vallado near-Earth vectors: position within 1 m, velocity within 1 mm/s', () => {
    assert.equal(FIX.cases.length, 9);
    let rows = 0;
    const r = new Float64Array(3), v = new Float64Array(3);
    for (const c of FIX.cases) {
        const rec = sgp4init(parseTle(c.line1, c.line2, { checksum: false }));
        assert.equal(rec.error, null, `${c.satnum}: ${rec.error}`);
        assert.ok(rec.periodMin < DEEP_SPACE_MIN);
        for (const [t, x, y, z, vx, vy, vz] of c.rows) {
            const err = sgp4(rec, t, r, v);
            assert.equal(err, null, `${c.satnum} at ${t} min: ${err}`);
            const dr = Math.hypot(r[0] - x, r[1] - y, r[2] - z);
            const dv = Math.hypot(v[0] - vx, v[1] - vy, v[2] - vz);
            assert.ok(dr < 1e-3, `${c.satnum} at ${t} min: position off by ${(dr * 1000).toFixed(3)} m`);
            assert.ok(dv < 1e-6, `${c.satnum} at ${t} min: velocity off by ${(dv * 1e6).toFixed(3)} mm/s`);
            rows++;
        }
    }
    assert.ok(rows >= 150, `${rows} rows`);
});

test('the decaying Minotaur stage (28872) fails past the last published row, as in tcppver.out', () => {
    const c = FIX.cases.find((k) => k.satnum === 28872);
    const rec = sgp4init(parseTle(c.line1, c.line2, { checksum: false }));
    const last = c.rows.at(-1)[0];
    const r = new Float64Array(3);
    assert.equal(sgp4(rec, last, r), null);
    assert.notEqual(sgp4(rec, last + 5, r), null);
});

test('deep-space orbits are rejected (Molniya 2-14, 08195: a 12 h period)', () => {
    const rec = sgp4init(parseTle(
        '1 08195U 75081A   06176.33215444  .00000099  00000-0  11873-3 0   813',
        '2 08195  64.1586 279.0717 6877146 264.7651  20.2257  2.00491383225656', { checksum: false }));
    assert.equal(rec.error, 'deep-space');
    assert.equal(sgp4(rec, 0, new Float64Array(3)), 'deep-space');
});

test('TLE parsing: fields, epoch and checksums (ISS, CelesTrak)', () => {
    const l1 = '1 25544U 98067A   26307.91797357  .00005463  00000+0  10662-3 0  9991';
    const l2 = '2 25544  51.6329 328.6334 0007180 345.0321  15.0454 15.49169062593415';
    assert.equal(tleChecksum(l1), 1);
    assert.equal(tleChecksum(l2), 5);
    const el = parseTle(l1, l2);
    assert.equal(el.satnum, 25544);
    assert.equal(el.intlDes, '98067A');
    assert.equal(el.ecc, 0.000718);
    assert.equal(el.inclDeg, 51.6329);
    assert.ok(Math.abs(el.bstar - 1.0662e-4) < 1e-12);
    assert.equal(el.revPerDay, 15.49169062);
    // Day 307.91797357 of 2026 = 3 November 2026, 22:01:52.917 UTC.
    assert.ok(Math.abs(el.epochMs - Date.parse('2026-11-03T22:01:52.917Z')) < 2);
    assert.throws(() => parseTle(l1.slice(0, 68) + '0', l2), /checksum/);
    assert.throws(() => parseTle(l1, l2.replace('25544', '25545')), TypeError);
    assert.throws(() => parseTle('garbage', l2), TypeError);
    // The ISS: about 92.9 minutes, ≈ 420 km up.
    const rec = sgp4init(el);
    assert.ok(Math.abs(rec.periodMin - 92.9) < 0.2, String(rec.periodMin));
    const r = new Float64Array(3);
    assert.equal(sgp4(rec, 0, r), null);
    const h = Math.hypot(r[0], r[1], r[2]) - 6378.137;
    assert.ok(h > 400 && h < 440, `altitude ${h} km`);
});

test('gstime: GMST at J2000.0 and Vallado example 3-5 (1992-08-20 12:14 UT1 → 152.578788°)', () => {
    assert.ok(Math.abs(gstime(2451545.0) * 180 / Math.PI - 280.46061837) < 1e-6);
    const jd = jdOfMs(Date.UTC(1992, 7, 20, 12, 14, 0));
    assert.ok(Math.abs(gstime(jd) * 180 / Math.PI - 152.578788) < 1e-5);
    // TEME → Earth-fixed is a rotation about z by −GMST.
    const ef = temeToEf([1, 0, 0.5], Math.PI / 2, new Float64Array(3));
    assert.ok(Math.abs(ef[0]) < 1e-15 && Math.abs(ef[1] + 1) < 1e-15 && ef[2] === 0.5);
});
