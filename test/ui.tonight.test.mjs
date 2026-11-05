// Tonight planner (ROADMAP tonight-planner): the chart's window, series sampling and ribbon opacity
// from the almanac's tonight() series, and Sky now's countdown for rows below the horizon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightWindow, seriesAlt, ribbonAlpha } from '../js/ui/tonight.js';
import { downText } from '../js/ui/sky-now.js';
import { tonight } from '../js/astro/almanac.js';
import { fmtDuration } from '../js/core/format.js';

const HOUR = 3600e3;
const PARIS = { latDeg: 48.8566, lonDeg: 2.3522, elevM: 35, tz: 'Europe/Paris' };
const TROMSO = { latDeg: 69.6492, lonDeg: 18.9553, elevM: 0, tz: 'Europe/Oslo' };

test('nightWindow: an hour either side of sunset and sunrise, inside the noon-to-noon grid', () => {
    const res = tonight(PARIS, Date.parse('2026-11-04T20:30:00Z'));
    const w = nightWindow(res);
    assert.equal(w.kind, 'night');
    assert.equal(w.fromMs, res.nightStartMs - HOUR);
    assert.equal(w.toMs, res.nightEndMs + HOUR);
    assert.ok(w.fromMs >= res.series.t0Ms);
    assert.equal(nightWindow(null), null);
    assert.equal(nightWindow({ series: null }), null);
});

test('nightWindow: the whole 24 h under the midnight sun and in polar night', () => {
    const summer = tonight(TROMSO, Date.parse('2026-06-21T20:00:00Z'));
    const ws = nightWindow(summer);
    assert.equal(ws.kind, 'midnight-sun');
    assert.equal(ws.toMs - ws.fromMs, 24 * HOUR);
    const winter = nightWindow(tonight(TROMSO, Date.parse('2026-12-21T12:00:00Z')));
    assert.equal(winter.kind, 'polar-night');
    assert.equal(winter.toMs - winter.fromMs, 24 * HOUR);
});

test('seriesAlt: samples exactly, interpolates between them, NaN outside; row −1 is the Sun', () => {
    const s = { t0Ms: 1000, stepMs: 10, n: 3, alt: Float32Array.of(0, 10, 20, -5, -15, -25), sunAlt: Float32Array.of(1, 2, 3) };
    assert.equal(seriesAlt(s, 0, 1010), 10);
    assert.equal(seriesAlt(s, 1, 1015), -20);
    assert.equal(seriesAlt(s, -1, 1020), 3);
    assert.equal(seriesAlt(s, -1, 1005), 1.5);
    assert.ok(Number.isNaN(seriesAlt(s, 0, 999)));
    assert.ok(Number.isNaN(seriesAlt(s, 0, 1021)));
    const res = tonight(PARIS, Date.parse('2026-11-04T20:30:00Z'));
    const sat = res.reports.findIndex((r) => r.id === 'saturn');
    assert.ok(Math.abs(seriesAlt(res.series, sat, res.reports[sat].bestMs) - res.reports[sat].bestAltDeg) < 1e-3);
});

test('ribbonAlpha: clear below the horizon, brighter the higher, faint by day', () => {
    assert.equal(ribbonAlpha(-1, -30), 0);
    assert.equal(ribbonAlpha(NaN, -30), 0);
    assert.ok(Math.abs(ribbonAlpha(0.01, -30) - 0.25) < 1e-3);
    assert.equal(ribbonAlpha(60, -30), 1);
    assert.equal(ribbonAlpha(80, -30), 1);
    assert.ok(ribbonAlpha(30, -30) > ribbonAlpha(10, -30));
    assert.ok(Math.abs(ribbonAlpha(60, 10) - 1 / 3) < 1e-9, 'a third by day');
});

test('downText: a countdown to the rise instead of repeating "below horizon"', () => {
    const ui = { fmt: (name, ...a) => (name === 'fmtDuration' ? fmtDuration(...a) : '—') };
    const t = Date.parse('2026-11-04T20:30:00Z');
    assert.equal(downText(ui, { nextRiseMs: t + 3 * HOUR + 36 * 60e3, status: 'normal' }, t), 'rises in 3 h 36 min');
    assert.equal(downText(ui, { nextRiseMs: t + 10e3, status: 'normal' }, t), 'rising now');
    assert.equal(downText(ui, { nextRiseMs: null, status: 'never' }, t), 'stays down');
    assert.equal(downText(ui, { nextRiseMs: null, status: null }, t), 'below horizon');
    assert.equal(downText({ fmt: () => '—' }, { nextRiseMs: t + HOUR, status: 'normal' }, t), 'below horizon', 'no formatter');
});
