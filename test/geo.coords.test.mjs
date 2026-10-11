// Tests for js/geo/coords.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLatLon, wrapLon, distanceKm } from '../js/geo/coords.js';

const PARIS_DMS = { lat: 48 + 51 / 60 + 24 / 3600, lon: 2 + 21 / 60 + 8 / 3600 };

function near(actual, expected, label) {
    assert.ok(actual, `${label}: parsed`);
    assert.ok(Math.abs(actual.lat - expected.lat) < 1e-9 && Math.abs(actual.lon - expected.lon) < 1e-9,
        `${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

test('every format listed in the spec', () => {
    near(parseLatLon('48.8566, 2.3522'), { lat: 48.8566, lon: 2.3522 }, 'comma');
    near(parseLatLon('48.8566 2.3522'), { lat: 48.8566, lon: 2.3522 }, 'space');
    near(parseLatLon('-33.9 151.2'), { lat: -33.9, lon: 151.2 }, 'negative');
    near(parseLatLon('48°51′24″N 2°21′8″E'), PARIS_DMS, 'DMS with symbols');
    near(parseLatLon('48 51 24 N, 2 21 8 E'), PARIS_DMS, 'DMS with spaces');
    near(parseLatLon('21.03N 105.85E'), { lat: 21.03, lon: 105.85 }, 'hemisphere suffix');
});

test('the other ways people paste coordinates', () => {
    const cases = [
        ['48.8566,2.3522', { lat: 48.8566, lon: 2.3522 }],
        ['  48.8566 ,  2.3522  ', { lat: 48.8566, lon: 2.3522 }],
        ['(48.8566, 2.3522)', { lat: 48.8566, lon: 2.3522 }],
        ['[-33.9; 151.2]', { lat: -33.9, lon: 151.2 }],
        ['48,8566 2,3522', { lat: 48.8566, lon: 2.3522 }],
        ['48,8566; 2,3522', { lat: 48.8566, lon: 2.3522 }],
        ['−33.9 151.2', { lat: -33.9, lon: 151.2 }],
        ['+48.8566 +2.3522', { lat: 48.8566, lon: 2.3522 }],
        ['.5 .25', { lat: 0.5, lon: 0.25 }],
        ['48°51\'24"N 2°21\'8"E', PARIS_DMS],
        ['48º51’24”N 2º21’8”E', PARIS_DMS],
        ["48°51'24''N 2°21'8''E", PARIS_DMS],
        ['48:51:24N 2:21:08E', PARIS_DMS],
        ['48 51 24 2 21 8', PARIS_DMS],
        ['48°51′24″ 2°21′8″', PARIS_DMS],
        ['N 48°51.4′ E 2°21.1′', { lat: 48 + 51.4 / 60, lon: 2 + 21.1 / 60 }],
        ['N48.85 E2.35', { lat: 48.85, lon: 2.35 }],
        ['48 51 N 2 21 E', { lat: 48 + 51 / 60, lon: 2 + 21 / 60 }],
        ['2.35E 48.85N', { lat: 48.85, lon: 2.35 }],
        ['33°52′S 151°12′E', { lat: -(33 + 52 / 60), lon: 151.2 }],
        ['33.87S, 151.21E', { lat: -33.87, lon: 151.21 }],
        ['22.9 s 43.2 w', { lat: -22.9, lon: -43.2 }],
        ['-0 30 0 0', { lat: -0.5, lon: 0 }],
        ['0 0', { lat: 0, lon: 0 }],
        ['90 180', { lat: 90, lon: 180 }],
        ['-90, -180', { lat: -90, lon: -180 }],
    ];
    for (const [s, want] of cases) near(parseLatLon(s), want, JSON.stringify(s));
    assert.ok(Object.is(parseLatLon('0 -0').lon, 0), 'no negative zero');
});

test('rejections', () => {
    const bad = [
        'Paris', 'Hanoi, Vietnam', '', '   ', '48.8566', '91 0', '-90.1 0', '0 181', '0 -180.5',
        '48 61 0 N 2 0 0 E', '48 51 60 N 2 21 8 E', '-33.9S 151.2E', '-48N 2E', '-48 N, 2 E', 'N -48 E 2', '-0 30 N 2 E', '48N 2N', '48E 2W', '48N', 'N 48 2',
        '1, 2, 3', '1 2 3', '1 2 3 4 5', '48.5 30 N 2 E', '1e3 2', 'NaN NaN', 'Infinity 0', '48.8566, 2.3522, 100',
        '12.5 N 45.5 S', 'Lat 48 Lon 2', '48 51 24 N 2 21 8', '48 -51 N 2 E', '51′24″N 2°E', '48 ,51 N 2 E', 'x'.repeat(200),
    ];
    for (const s of bad) assert.equal(parseLatLon(s), null, JSON.stringify(s));
    for (const v of [null, undefined, 42, {}, ['48', '2']]) assert.equal(parseLatLon(v), null, String(v));
});

test('wrapLon and distanceKm', () => {
    assert.equal(wrapLon(190), -170);
    assert.equal(wrapLon(-190), 170);
    assert.equal(wrapLon(180), 180);
    assert.equal(wrapLon(-180), -180);
    assert.equal(wrapLon(540), 180);
    assert.equal(wrapLon(105.8542), 105.8542, 'in-range values are untouched');
    assert.ok(Number.isNaN(wrapLon('x')));
    const parisLondon = distanceKm(48.8534, 2.3488, 51.5085, -0.1257);
    assert.ok(Math.abs(parisLondon - 343.5) < 2, `Paris–London ${parisLondon}`);
    assert.ok(Math.abs(distanceKm(0, 179.5, 0, -179.5) - 111.2) < 0.5, 'across the antimeridian');
    assert.ok(Math.abs(distanceKm(90, 0, -90, 0) - Math.PI * 6371.0088) < 1e-6);
    assert.equal(distanceKm(10, 20, 10, 20), 0);
});
