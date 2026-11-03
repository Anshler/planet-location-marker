// Illustrative landscape (js/geo/horizon.js): a deterministic per-place horizon profile, low enough
// not to move sunset by minutes, flat over the sea, and one query that every JS horizon test uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    HORIZON_SAMPLES, FAR_RIDGE_MAX_DEG, NEAR_BAND_MAX_DEG, SEA_SECTORS,
    createHorizon, buildHorizon, horizonSeed, horizonKey, horizonAltDeg, azimuthDeg, clearanceDeg, urbanIndex, seaSectors,
} from '../js/geo/horizon.js';
import { refractionDeg } from '../js/astro/photometry.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const PARIS = [48.8566, 2.3522];
const UP = [0, 1, 0], NORTH = [0, 0, -1], EAST = [1, 0, 0];
/** Unit vector at (alt, az) in the frame above (degrees). */
function dir(altDeg, azDeg) {
    const h = (altDeg * Math.PI) / 180, A = (azDeg * Math.PI) / 180;
    return [Math.sin(A) * Math.cos(h), Math.sin(h), -Math.cos(A) * Math.cos(h)];
}

test('an empty profile is flat and disabled: every query is the mathematical horizon', () => {
    const h = createHorizon();
    assert.equal(h.n, HORIZON_SAMPLES);
    for (const a of [h.far, h.near, h.sea, h.alt]) assert.ok(a instanceof Float32Array && a.length === HORIZON_SAMPLES);
    assert.equal(h.enabled, false);
    h.alt.fill(1);
    assert.equal(horizonAltDeg(h, 123), 0, 'disabled');
    assert.equal(horizonAltDeg(null, 123), 0);
    h.enabled = true;
    assert.equal(horizonAltDeg(h, 123), 1);
    assert.equal(horizonAltDeg(h, NaN), 0);
});

test('buildHorizon is deterministic per place (rounded to 0.1°) and differs between places', () => {
    const a = buildHorizon(createHorizon(), ...PARIS, { urban: 0.5 });
    const b = buildHorizon(createHorizon(), 48.8601, 2.3540, { urban: 0.5 });
    assert.deepEqual(a.alt, b.alt, 'same 0.1° cell, same horizon');
    const c = buildHorizon(createHorizon(), 48.9566, 2.3522, { urban: 0.5 });
    assert.notDeepEqual(a.alt, c.alt);
    assert.equal(horizonSeed(10, 180), horizonSeed(10, -180), 'the date line is one place');
    assert.notEqual(horizonSeed(10, 20), horizonSeed(20, 10));
    assert.equal(a.version, 1);
    assert.equal(a.key, horizonKey(...PARIS, { urban: 0.5 }));
    buildHorizon(a, ...PARIS, { urban: 0.5 });
    assert.equal(a.version, 2, 'every build bumps the version (the ground re-uploads its texture)');
});

test('the profile stays low: far ridge ≤ 0.5°, trees and roofs ≤ 1.2°, silhouette = max of both', () => {
    for (const [lat, lon, urban] of [[48.86, 2.35, 1], [39.74, -104.99, 0.3], [-33.87, 151.21, 0], [64.1, -21.9, 0.6]]) {
        const h = buildHorizon(createHorizon(), lat, lon, { urban });
        let farMax = 0, nearMax = 0, nearSum = 0;
        for (let i = 0; i < h.n; i++) {
            assert.ok(h.far[i] >= 0 && h.far[i] <= FAR_RIDGE_MAX_DEG + 1e-6, `far ${h.far[i]}`);
            assert.ok(h.near[i] >= 0 && h.near[i] <= NEAR_BAND_MAX_DEG + 1e-6, `near ${h.near[i]}`);
            assert.equal(h.alt[i], Math.max(h.far[i], h.near[i]));
            farMax = Math.max(farMax, h.far[i]);
            nearMax = Math.max(nearMax, h.near[i]);
            nearSum += h.near[i] > 0.05 ? 1 : 0;
        }
        assert.ok(farMax > 0.1, `a visible ridge at ${lat},${lon}`);
        assert.ok(nearMax > 0.2 && nearSum / h.n > 0.15 && nearSum / h.n < 0.95, `a broken near band (${nearSum / h.n})`);
    }
});

test('towns are wall-to-wall roofs, open country has fields between the woods', () => {
    const cover = (urban) => {
        const h = buildHorizon(createHorizon(), 45.1, 7.3, { urban });
        return h.near.reduce((s, v) => s + (v > 0.05 ? 1 : 0), 0) / h.n;
    };
    assert.ok(cover(1) > cover(0) + 0.15, `urban ${cover(1)} vs rural ${cover(0)}`);
});

test('sea sectors: flat (no hills, no trees) where the far ground is water, land elsewhere', () => {
    // Water east of the observer's meridian (a north–south coast through the observer).
    const lon0 = 151.21;
    const water = (la, lo) => (lo > lon0 + 0.02 ? 1 : 0);
    const h = buildHorizon(createHorizon(), -33.87, lon0, { water, urban: 0.5 });
    h.enabled = true;
    const at = (az) => h.sea[Math.round((az / 360) * h.n) % h.n];
    assert.ok(at(90) > 0.99 && at(60) > 0.99 && at(120) > 0.99, 'east is sea');
    assert.ok(at(270) < 0.01 && at(240) < 0.01, 'west is land');
    assert.equal(horizonAltDeg(h, 90), 0, 'a flat sea horizon');
    close(h.seaFrac, 0.5, 0.08);
    // Without water information the whole horizon is land.
    assert.equal(buildHorizon(createHorizon(), -33.87, lon0, {}).seaFrac, 0);
    // A failing sampler is treated as land, not an exception.
    assert.equal(buildHorizon(createHorizon(), 0, 0, { water: () => { throw new Error('x'); } }).seaFrac, 0);
    const sec = seaSectors(-33.87, lon0, water);
    assert.equal(sec.length, SEA_SECTORS);
});

test('urbanIndex: a city centre is 1, a village or empty land 0, across the date line too', () => {
    const list = [
        { lat: 48.8566, lon: 2.3522, pop: 2_100_000 },
        { lat: 45.0, lon: 7.0, pop: 9_000 },
        { lat: -17.75, lon: 179.95, pop: 1_000_000 },
    ];
    close(urbanIndex(list, 48.86, 2.35), 1, 1e-9);
    assert.equal(urbanIndex(list, 45.01, 7.0), 0, 'a village');
    assert.equal(urbanIndex(list, 0, 0), 0);
    assert.equal(urbanIndex([], 48.86, 2.35), 0);
    assert.equal(urbanIndex(null, 48.86, 2.35), 0);
    assert.ok(urbanIndex(list, -17.75, -179.98) > 0.5, 'the city across the date line counts');
    assert.ok(urbanIndex(list, 49.1, 2.35) < urbanIndex(list, 48.9, 2.35), 'falls off with distance');
});

test('horizonAltDeg is linear between samples and wraps at north', () => {
    const h = createHorizon();
    h.enabled = true;
    const n = h.n, step = 360 / n;
    h.alt[0] = 1; h.alt[1] = 2; h.alt[n - 1] = 3;
    close(horizonAltDeg(h, 0), 1, 1e-12);
    close(horizonAltDeg(h, step), 2, 1e-12);
    close(horizonAltDeg(h, step / 4), 1.25, 1e-9);
    close(horizonAltDeg(h, 360 - step / 2), 2, 1e-9, 'between the last sample and the first');
    close(horizonAltDeg(h, -step / 2), 2, 1e-9, 'negative azimuth');
    close(horizonAltDeg(h, 360 + step / 4), 1.25, 1e-9);
});

test('azimuthDeg and clearanceDeg: north 0°, east 90°; clearance = refracted altitude − silhouette', () => {
    close(azimuthDeg(dir(10, 0), NORTH, EAST), 0, 1e-9);
    close(azimuthDeg(dir(10, 90), NORTH, EAST), 90, 1e-9);
    close(azimuthDeg(dir(10, 250), NORTH, EAST), 250, 1e-9);
    assert.equal(azimuthDeg([0, 1, 0], NORTH, EAST), 0, 'zenith');
    const h = createHorizon();
    h.alt.fill(0.4);
    h.enabled = true;
    const d = dir(0.2, 247);
    close(clearanceDeg(h, d, UP, NORTH, EAST, 1), 0.2 + refractionDeg(0.2) - 0.4, 1e-6, 'float32 profile');
    close(clearanceDeg(h, d, UP, NORTH, EAST, 0), 0.2 - 0.4, 1e-6, 'k = 0: geometric');
    close(clearanceDeg(null, d, UP, NORTH, EAST, 1), 0.2 + refractionDeg(0.2), 1e-9, 'no landscape: the mathematical horizon');
    h.enabled = false;
    close(clearanceDeg(h, d, UP, NORTH, EAST, 1), 0.2 + refractionDeg(0.2), 1e-9, 'layer off');
});
