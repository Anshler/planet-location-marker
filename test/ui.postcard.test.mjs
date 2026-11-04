// Postcard and long-exposure wording (js/ui/postcard.js, js/ui/expose.js): word wrap, the
// 'Up now' line, the capture scale per card, the exposure pill's status line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLines, upNowText, captureScale, POSTCARD_PRESETS } from '../js/ui/postcard.js';
import { exposeStatusText, EXPOSE_PRESETS } from '../js/ui/expose.js';
import { EXPOSE_KINDS } from '../js/app/expose.js';
import { fmtDuration } from '../js/core/format.js';

const mono = (s) => s.length * 10;   // 10 px per character

test('wrapLines: greedy, at most maxLines, the last one ellipsised', () => {
    assert.deepEqual(wrapLines('Up now: Saturn 51° NW, Neptune 47° WNW', 200, mono, 2), ['Up now: Saturn 51°', 'NW, Neptune 47° WNW']);
    const one = wrapLines('Saturn is 76° above the south-east horizon, in Cetus.', 200, mono, 1);
    assert.equal(one.length, 1);
    assert.ok(one[0].endsWith('…') && mono(one[0]) <= 200, one[0]);
    assert.deepEqual(wrapLines('Paris', 200, mono, 2), ['Paris']);
    assert.deepEqual(wrapLines('', 200, mono, 2), []);
    const long = wrapLines('Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch', 200, mono, 2);
    assert.equal(long.length, 1, 'one unbreakable word');
    assert.ok(long[0].endsWith('…') && mono(long[0]) <= 200);
    for (const l of wrapLines('a b c d e f g h i j k l m n o p q r s t u v w x y z', 50, mono, 3)) assert.ok(mono(l) <= 50, l);
});

test('upNowText lists the bodies above the horizon', () => {
    assert.equal(upNowText([{ name: 'Saturn', alt: 51.4, dir: 'NW' }, { name: 'Neptune', alt: 47.2, dir: 'WNW' }]),
        'Up now: Saturn 51° NW, Neptune 47° WNW');
    assert.equal(upNowText([]), 'Nothing is above the horizon.');
});

test('captureScale: a card reads like a ~450-px phone view', () => {
    const [portrait, wide, story] = POSTCARD_PRESETS;
    assert.deepEqual([portrait.w, portrait.h, wide.w, wide.h, story.w, story.h], [1080, 1350, 1200, 630, 1080, 1920]);
    assert.equal(captureScale(1080, 1350), 2.4);
    assert.equal(captureScale(1200, 630), 1.4);
    assert.equal(captureScale(300, 200), 1, 'never below 1');
    assert.equal(captureScale(4000, 4000), 3, 'never above 3');
});

test('exposeStatusText: span and frames, daylight gate, the analemma in days', () => {
    const fmt = (ms) => fmtDuration(ms);
    const base = { active: true, kind: 'trails', frames: 380, fromMs: 0, toMs: 2 * 36e5 + 14 * 6e4, gated: false };
    assert.equal(exposeStatusText(base, fmt), '2 h 14 min · 380 frames');
    assert.equal(exposeStatusText({ ...base, frames: 0, fromMs: NaN, toMs: NaN, gated: true }, fmt, -3.4), 'Waiting for darkness (Sun −3°)');
    assert.equal(exposeStatusText({ ...base, gated: true }, fmt), 'Paused for daylight · 2 h 14 min so far');
    assert.equal(exposeStatusText({ ...base, kind: 'analemma', frames: 900, fromMs: 0, toMs: 41 * 864e5 }, fmt), '42 days · 900 frames');
    assert.equal(exposeStatusText(null, fmt), 'Starting…');
    assert.deepEqual(EXPOSE_PRESETS.map((p) => p.id), [...EXPOSE_KINDS], 'the UI offers every preset the actions accept');
});
