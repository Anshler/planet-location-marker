// Tests for js/ui/install.js — which install help a device gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isIos, installOffer } from '../js/ui/install.js';

test('isIos: iPhone, iPod and iPad, including iPadOS presenting itself as a Mac', () => {
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15', platform: 'iPhone', maxTouchPoints: 5 }), true);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', platform: 'iPod' }), true);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }), true);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile', platform: 'Linux armv81', maxTouchPoints: 5 }), false);
    assert.equal(isIos(), false);
});

test('installOffer: nothing once installed; the browser dialog first; else the iOS steps', () => {
    assert.equal(installOffer({ standalone: true, prompt: true, ios: true }), null);
    assert.equal(installOffer({ standalone: false, prompt: true, ios: false }), 'prompt');
    assert.equal(installOffer({ standalone: false, prompt: true, ios: true }), 'prompt');
    assert.equal(installOffer({ standalone: false, prompt: false, ios: true }), 'ios');
    assert.equal(installOffer({ standalone: false, prompt: false, ios: false }), null);
});
