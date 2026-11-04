// Tests for js/ui/coach.js — which world the first tip points at, and where the spotlight and tip go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { featuredWorld, spotRect, placeTip, COACH_STEPS } from '../js/ui/coach.js';

const altAz = (b) => ({ alt: b.alt, az: 0 });
const VIEW = { w: 390, h: 844 };

test('three steps, each with a title and a mouse and a touch sentence', () => {
    assert.deepEqual(COACH_STEPS.map((s) => s[0]), ['world', 'time', 'view']);
    for (const [, title, fine, touch] of COACH_STEPS) {
        assert.ok(title && fine && touch);
        assert.doesNotMatch(touch, /\b(press|click|key)/i, 'touch copy names no keys or clicks');
    }
});

test('featuredWorld: the highest body up, the Sun after the others, the Moon as a last resort', () => {
    const bodies = [{ id: 'sun', alt: 60 }, { id: 'moon', alt: -10 }, { id: 'mars', alt: 20 }, { id: 'jupiter', alt: 45 }, { id: 'venus', alt: -1 }];
    assert.deepEqual(featuredWorld(bodies, altAz), ['jupiter', 'mars', 'sun', 'moon']);
    assert.deepEqual(featuredWorld([{ id: 'moon', alt: 3 }, { id: 'saturn', alt: 10 }], altAz), ['saturn', 'moon']);
    assert.deepEqual(featuredWorld(null, altAz), ['moon']);
});

test('spotRect pads the target and stays on screen', () => {
    assert.deepEqual(spotRect({ left: 100, top: 200, width: 80, height: 30 }, VIEW, 6), { left: 94, top: 194, width: 92, height: 42 });
    const edge = spotRect({ left: 340, top: 820, width: 60, height: 40 }, VIEW, 6);
    assert.equal(edge.left + edge.width, VIEW.w - 2);
    assert.equal(edge.top + edge.height, VIEW.h - 2);
});

test('placeTip: below when it fits, else above; centred, inside the viewport', () => {
    const tip = { w: 320, h: 150 };
    const high = placeTip({ left: 300, top: 60, width: 60, height: 60 }, tip, VIEW);
    assert.equal(high.side, 'below');
    assert.equal(high.y, 60 + 60 + 12);
    assert.equal(high.x, VIEW.w - 12 - tip.w, 'clamped to the right margin');
    const low = placeTip({ left: 20, top: 760, width: 350, height: 60 }, tip, VIEW);
    assert.equal(low.side, 'above');
    assert.equal(low.y, 760 - 12 - tip.h);
    assert.equal(low.x, Math.round(20 + 175 - 160));
    const big = placeTip({ left: 0, top: 0, width: 390, height: 844 }, tip, VIEW);
    assert.ok(big.y >= 12 && big.y + tip.h <= VIEW.h - 12, 'a target filling the screen still leaves the tip on it');
});
