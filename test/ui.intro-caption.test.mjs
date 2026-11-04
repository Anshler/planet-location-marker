// Tests for js/ui/intro-caption.js — the intro title card's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldsAbove, introCaption } from '../js/ui/intro-caption.js';

const altAz = (b) => ({ alt: b.alt, az: 0 });

test('worldsAbove counts bodies above the horizon (refracted altitude > 0)', () => {
    assert.equal(worldsAbove([{ alt: 12 }, { alt: -3 }, { alt: 0 }, { alt: 0.2 }, { alt: NaN }], altAz), 2);
    assert.equal(worldsAbove([], altAz), 0);
    assert.equal(worldsAbove(null, altAz), 0);
});

test('introCaption: place, local time and the count, written and spoken', () => {
    assert.deepEqual(introCaption('Ho Chi Minh City', '21:00', 3), {
        title: 'Ho Chi Minh City', line: '21:00 · 3 worlds above you', spoken: 'Ho Chi Minh City, 21:00. 3 worlds above you.',
    });
    assert.equal(introCaption('Hanoi', '9:05 PM', 1).line, '9:05 PM · 1 world above you');
    assert.equal(introCaption('Hanoi', '04:00', 0).spoken, 'Hanoi, 04:00. Every world below your horizon.');
});
