// Scrubber gradient cache: while time-lapse slides the window, the cached row is shifted by whole
// columns and only the exposed columns are recomputed. The result must match a fresh row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideGradientRow, halfWindowFor, moonLitApprox, eclipseSpan, STEP_UNITS, zoneTemplates } from '../js/ui/timebar.js';
import { STEP } from '../js/core/clock.js';
import { SKY_LUT, LUT_N, LUT_MIN, LUT_STEP, skyLutIndex, C_GOLD, C_NIGHT } from '../js/ui/sky-palette.js';
import { AE } from '../js/astro/ae.js';

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

test('slideGradientRow: several rows (gradient and bands) slide together', () => {
    const W = 50, rows = 3, colMs = 10;
    const data = new Uint8ClampedArray(rows * W * 4);
    const put = (from, to, start) => {
        for (let r = 0; r < rows; r += 1) {
            for (let x = from; x < to; x += 1) data[(r * W + x) * 4] = (Math.round((start + (x + 0.5) * colMs) / colMs) * 7 + r * 50) & 255;
        }
    };
    const cache = { start: 0 };
    put(0, W, 0);
    const out = { from: 0, to: 0 };
    for (const step of [3, 11, -7, -20, 49, -2]) {
        slideGradientRow(cache, data, W, colMs, cache.start + step * colMs, out);
        put(out.from, out.to, cache.start);
        const want = new Uint8ClampedArray(rows * W * 4);
        for (let r = 0; r < rows; r += 1) {
            for (let x = 0; x < W; x += 1) want[(r * W + x) * 4] = (Math.round((cache.start + (x + 0.5) * colMs) / colMs) * 7 + r * 50) & 255;
        }
        for (let i = 0; i < want.length; i += 4) assert.equal(data[i], want[i], `pixel ${i / 4} after a step of ${step}`);
    }
});

// WCAG relative luminance and contrast ratio.
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test('sky palette: the bar\'s light text keeps 4.5:1 on every colour, golden hour included', () => {
    const text = lum(0xe8, 0xed, 0xf6);
    let worst = Infinity;
    for (let i = 0; i < LUT_N; i += 1) {
        worst = Math.min(worst, contrast(text, lum(SKY_LUT[i * 3], SKY_LUT[i * 3 + 1], SKY_LUT[i * 3 + 2])));
    }
    assert.ok(worst >= 4.5, `worst contrast ${worst.toFixed(2)}:1`);
});

test('sky palette: amber at sunset, rose-violet in civil twilight, indigo nautical, near-black night', () => {
    const rgb = (alt) => { const i = skyLutIndex(alt); return [SKY_LUT[i], SKY_LUT[i + 1], SKY_LUT[i + 2]]; };
    const [gr, gg, gb] = rgb(0);
    assert.ok(gr > gg && gg > gb, 'amber around the horizon');
    assert.deepEqual(rgb(0.5).map(Math.round), C_GOLD, 'pure amber just above the horizon');
    const [cr, cg, cb] = rgb(-3.5);
    assert.ok(cr > cg && cb > cg, 'rose to violet');
    const [nr, ng, nb] = rgb(-9);
    assert.ok(nb > 2 * nr && nb > 2 * ng, 'indigo');
    assert.deepEqual(rgb(-25), C_NIGHT);
    const [dr, , db] = rgb(30);
    assert.ok(db > dr, 'day is blue');
    assert.equal(skyLutIndex(NaN), 0, 'NaN reads as night');
    assert.equal(skyLutIndex(1e9), (LUT_N - 1) * 3);
    assert.equal(skyLutIndex(LUT_MIN + 10 * LUT_STEP), 30);
});

test('moonLitApprox follows Astronomy Engine within 1.5 %', () => {
    let worst = 0;
    for (let d = 0; d < 60; d += 0.7) {
        const t = Date.UTC(2026, 10, 1) + d * 86400e3;
        const ae = AE.Illumination('Moon', AE.MakeTime(new Date(t))).phase_fraction;
        worst = Math.max(worst, Math.abs(moonLitApprox(t) - ae));
    }
    assert.ok(worst < 0.015, `worst ${worst.toFixed(4)}`);
});

test('eclipseSpan: local solar contacts, the umbral or penumbral lunar phase, nothing else', () => {
    const out = { from: 0, to: 0 };
    assert.equal(eclipseSpan({ kind: 'local-solar-eclipse', c1Ms: 10, c4Ms: 90 }, out), true);
    assert.deepEqual(out, { from: 10, to: 90 });
    assert.equal(eclipseSpan({ kind: 'lunar-eclipse', p1Ms: 0, u1Ms: 20, u4Ms: 80, p4Ms: 100 }, out), true);
    assert.deepEqual(out, { from: 20, to: 80 });
    assert.equal(eclipseSpan({ kind: 'lunar-eclipse', p1Ms: 0, u1Ms: null, u4Ms: null, p4Ms: 100 }, out), true);
    assert.deepEqual(out, { from: 0, to: 100 });
    assert.equal(eclipseSpan({ kind: 'solar-eclipse', tMs: 5 }, out), false, 'a global eclipse has no local span');
    assert.equal(eclipseSpan({ kind: 'local-solar-eclipse', c1Ms: null, c4Ms: 90 }, out), false);
    assert.equal(eclipseSpan(null, out), false);
});

test('STEP_UNITS: every clock step, six of them, with a unit for the buttons and a whole phrase', () => {
    assert.deepEqual(STEP_UNITS.map((u) => u.kind), ['minute', 'hour', 'day', 'siderealDay', 'month', 'year']);
    for (const u of STEP_UNITS) {
        assert.ok(Object.hasOwn(STEP, u.kind), u.kind);
        assert.match(u.unit, /^1 \S/, `${u.kind} unit`);
        assert.match(u.long, /^1 [a-z ]+$/, `${u.kind} phrase`);
    }
    assert.equal(STEP_UNITS.find((u) => u.kind === 'siderealDay').label, 'Sidereal day (23 h 56 min)', 'plain words, then the length');
});

test('zoneTemplates: Observer names the place, Device says so, UTC is just UTC; short forms keep the offset', () => {
    const fill = (t, p) => t.replace(/\{(\w+)\}/g, (_, k) => p[k]);
    const parts = { place: 'Greenwich', offset: 'UTC+0' };
    assert.deepEqual(zoneTemplates('observer').map((t) => fill(t, parts)), ['Greenwich, UTC+0', 'UTC+0']);
    assert.deepEqual(zoneTemplates('device').map((t) => fill(t, parts)), ['This device, UTC+0', 'UTC+0']);
    assert.deepEqual(zoneTemplates('utc'), ['UTC', 'UTC'], 'UTC mode no longer looks like Observer at Greenwich');
    assert.deepEqual(zoneTemplates('observer', true).map((t) => fill(t, parts)), ['Greenwich, UTC+0 (approx.)', 'UTC+0 (approx.)']);
    // Whole phrases: the placeholders are named, and the short form never needs the place.
    for (const m of ['observer', 'device', 'utc']) for (const t of zoneTemplates(m)) assert.doesNotMatch(t, /\{(?!place\}|offset\})/);
    for (const m of ['observer', 'device', 'utc']) assert.doesNotMatch(zoneTemplates(m)[1], /\{place\}/);
});
