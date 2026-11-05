// The context-loss backoff (context-loss-backoff-and-diagnostics): a sliding window of losses steps
// the session down a tier, then gives up on the 3D view; Retry comes back at low.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOSS_WINDOW_MS, lossRecord, recordLoss, retryRecord, tierBelow, capTier } from '../js/core/context-loss.js';

test('loss window: restore, then one tier lower within a minute, then text mode', () => {
    const t0 = 1_800_000_000_000;
    const a = recordLoss(null, t0, 'high');
    assert.equal(a.action, 'restore');
    assert.deepEqual(a.record, { n: 1, t: [t0], cap: null, text: false });
    const b = recordLoss(a.record, t0 + 30e3, 'high');
    assert.equal(b.action, 'step-down');
    assert.equal(b.record.cap, 'medium');
    const c = recordLoss(b.record, t0 + 50e3, 'medium');
    assert.equal(c.action, 'text');
    assert.equal(c.record.text, true);
    assert.equal(c.record.n, 3);
});

test('loss window: losses further apart than the window restore each time', () => {
    const t0 = 1e12;
    let r = null;
    for (let i = 0; i < 5; i++) {
        const out = recordLoss(r, t0 + i * (LOSS_WINDOW_MS + 1), 'medium');
        assert.equal(out.action, 'restore', `loss ${i + 1}`);
        r = out.record;
    }
    assert.equal(r.n, 5, 'the session count keeps every loss');
    assert.deepEqual(r.t, [t0 + 4 * (LOSS_WINDOW_MS + 1)], 'the window holds the recent ones only');
});

test('loss window: the step-down sticks for the session and only ever lowers the cap', () => {
    const t0 = 1e12;
    let r = recordLoss(recordLoss(null, t0, 'max').record, t0 + 1000, 'max').record;
    assert.equal(r.cap, 'high', 'max steps to high');
    // Much later, two more losses at a tier the user picked above the cap: the cap only goes down.
    r = recordLoss(r, t0 + 10 * LOSS_WINDOW_MS, 'max').record;
    const out = recordLoss(r, t0 + 10 * LOSS_WINDOW_MS + 5e3, 'max');
    assert.equal(out.action, 'step-down');
    assert.equal(out.record.cap, 'high');
    // At low there is nothing lower: a second loss restores.
    const low = recordLoss(recordLoss(null, t0, 'low').record, t0 + 1e3, 'low');
    assert.equal(low.action, 'restore');
    assert.equal(low.record.cap, null);
});

test('loss window: stored junk is made safe; Retry clears the window and holds low', () => {
    assert.deepEqual(lossRecord('nope'), { n: 0, t: [], cap: null, text: false });
    assert.deepEqual(lossRecord({ n: -2, t: [1, 'x', 2, 3, 4], cap: 'ultra', text: 'yes' }), { n: 3, t: [2, 3, 4], cap: null, text: false });
    // A clock that went backwards does not count a future loss.
    assert.equal(recordLoss({ n: 1, t: [5e12] }, 1e12, 'high').action, 'restore');
    assert.deepEqual(retryRecord({ n: 3, t: [1, 2, 3], cap: 'medium', text: true }), { n: 3, t: [], cap: 'low', text: false });
});

test('tierBelow and capTier', () => {
    assert.equal(tierBelow('max'), 'high');
    assert.equal(tierBelow('medium'), 'low');
    assert.equal(tierBelow('low'), null);
    assert.equal(capTier('high', 'medium'), 'medium');
    assert.equal(capTier('low', 'medium'), 'low', 'a cap never raises');
    assert.equal(capTier('max', null), 'max');
});
