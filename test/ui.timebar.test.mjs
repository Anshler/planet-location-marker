// Scrubber gradient cache: while time-lapse slides the window, the cached row is shifted by whole
// columns and only the exposed columns are recomputed. The result must match a fresh row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideGradientRow, halfWindowFor } from '../js/ui/timebar.js';

const DAY = 86400e3;

/** A smooth, non-periodic test signal standing in for the Sun's altitude / day length. */
const signal = (t) => Math.round(127.5 + 127 * Math.sin(t / (3.7 * DAY)) * Math.cos(t / (41 * DAY)));

function fill(data, from, to, start, colMs) {
    for (let x = from; x < to; x += 1) {
        const v = signal(start + (x + 0.5) * colMs);
        data[x * 4] = v; data[x * 4 + 1] = 255 - v; data[x * 4 + 2] = x & 255; data[x * 4 + 3] = 255;
    }
}

test('slideGradientRow: under half a column keeps the row', () => {
    const W = 8, colMs = 1000;
    const data = new Uint8ClampedArray(W * 4).fill(7);
    const cache = { start: 5000 };
    const out = { from: -1, to: -1 };
    assert.equal(slideGradientRow(cache, data, W, colMs, 5000 + 499, out), out);
    assert.deepEqual(out, { from: 0, to: 0 });
    assert.equal(cache.start, 5000);
    slideGradientRow(cache, data, W, colMs, 5000 - 499, out);
    assert.deepEqual(out, { from: 0, to: 0 });
    assert.ok(data.every((v) => v === 7), 'row untouched');
});

test('slideGradientRow: forward and backward slides shift whole columns', () => {
    const W = 6, colMs = 10;
    const data = new Uint8ClampedArray(W * 4);
    for (let x = 0; x < W; x += 1) data[x * 4] = x + 1;
    const cache = { start: 0 };
    const out = { from: 0, to: 0 };
    slideGradientRow(cache, data, W, colMs, 21, out); // two columns later
    assert.deepEqual(out, { from: 4, to: 6 });
    assert.equal(cache.start, 20);
    assert.deepEqual([0, 1, 2, 3].map((x) => data[x * 4]), [3, 4, 5, 6]);
    slideGradientRow(cache, data, W, colMs, -10, out); // three columns earlier
    assert.deepEqual(out, { from: 0, to: 3 });
    assert.equal(cache.start, -10);
    assert.deepEqual([3, 4, 5].map((x) => data[x * 4]), [3, 4, 5]);
});

test('slideGradientRow: a jump of a full row or more recomputes everything', () => {
    const W = 5, colMs = 10;
    const data = new Uint8ClampedArray(W * 4);
    const out = { from: 0, to: 0 };
    const cache = { start: 0 };
    slideGradientRow(cache, data, W, colMs, 50, out);
    assert.deepEqual(out, { from: 0, to: 5 });
    assert.equal(cache.start, 50);
    slideGradientRow(cache, data, W, colMs, -1e6, out);
    assert.deepEqual(out, { from: 0, to: 5 });
    assert.equal(cache.start, -1e6);
});

test('slideGradientRow: a time-lapse of slides matches a freshly computed row', () => {
    const W = 600;
    const span = 2 * halfWindowFor(86400); // ±30 d at 1 d/s
    const colMs = span / W;
    const data = new Uint8ClampedArray(W * 4);
    const fresh = new Uint8ClampedArray(W * 4);
    let start = Date.UTC(2026, 10, 3) - span / 2;
    const cache = { start };
    fill(data, 0, W, start, colMs);
    const out = { from: 0, to: 0 };
    let computed = 0;
    // Uneven frame steps forward and backward (reverse time), all well under a row.
    const steps = [0.3, 1.7, 2.2, 0.1, 5.5, 12.9, -4.4, -0.2, 33.3, 1, 1, 1, -60.6, 0.49, 0.51, 200.25];
    for (let i = 0; i < 400; i += 1) {
        start += steps[i % steps.length] * colMs;
        slideGradientRow(cache, data, W, colMs, start, out);
        fill(data, out.from, out.to, cache.start, colMs);
        computed += out.to - out.from;
        assert.ok(Math.abs(cache.start - start) <= colMs / 2 + 1e-6, 'row within half a column of the window');
    }
    fill(fresh, 0, W, cache.start, colMs);
    let maxDiff = 0;
    for (let x = 0; x < W; x += 1) maxDiff = Math.max(maxDiff, Math.abs(data[x * 4] - fresh[x * 4]), Math.abs(data[x * 4 + 1] - fresh[x * 4 + 1]));
    assert.ok(maxDiff <= 1, `cached row differs from a fresh one by ${maxDiff}`);
    assert.ok(computed < 400 * W * 0.1, `computed ${computed} columns over 400 frames`);
});
