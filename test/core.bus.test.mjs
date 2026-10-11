// Tests for js/core/bus.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBus, BUS_EVENTS } from '../js/core/bus.js';

test('the six spec event types', () => {
    assert.deepEqual([...BUS_EVENTS], ['readout', 'toast', 'announce', 'almanac', 'events', 'intro']);
    assert.ok(Object.isFrozen(BUS_EVENTS));
});

test('on / emit / off', () => {
    const bus = createBus();
    const got = [];
    const off = bus.on('toast', (p) => got.push(p));
    bus.emit('toast', { message: 'Link copied', kind: 'info' });
    bus.emit('announce', 'ignored');
    assert.deepEqual(got, [{ message: 'Link copied', kind: 'info' }]);
    off();
    off();
    bus.emit('toast', { message: 'x' });
    assert.equal(got.length, 1);
    const fn = (p) => got.push(p);
    bus.on('intro', fn);
    bus.off('intro', fn);
    bus.emit('intro', 'start');
    assert.equal(got.length, 1);
    assert.equal(typeof bus.on('intro', 'not a function'), 'function');
});

test('handlers run in registration order; payload identity is preserved', () => {
    const bus = createBus();
    const order = [];
    const snap = { tMs: 1 };
    bus.on('readout', (s) => order.push(['a', s]));
    bus.on('readout', (s) => order.push(['b', s]));
    bus.emit('readout', snap);
    assert.deepEqual(order.map(([n]) => n), ['a', 'b']);
    assert.equal(order[0][1], snap);
});

test('once: callback form and promise form', async () => {
    const bus = createBus();
    const got = [];
    bus.once('intro', (p) => got.push(p));
    const next = bus.once('intro');
    assert.ok(next instanceof Promise);
    bus.emit('intro', 'start');
    bus.emit('intro', 'done');
    assert.deepEqual(got, ['start']);
    assert.equal(await next, 'start');
    const off = bus.once('events', () => got.push('never'));
    off();
    bus.emit('events', []);
    assert.deepEqual(got, ['start']);
});

test('a throwing handler is reported and does not stop the others', () => {
    const errors = [];
    const bus = createBus({ onError: (err, type) => errors.push([err.message, type]) });
    const got = [];
    bus.on('almanac', () => { throw new Error('boom'); });
    bus.on('almanac', (p) => got.push(p));
    bus.emit('almanac', 1);
    assert.deepEqual(got, [1]);
    assert.deepEqual(errors, [['boom', 'almanac']]);
});

test('subscribing or unsubscribing during an emit', () => {
    const bus = createBus();
    const seen = [];
    let offB = null;
    bus.on('toast', () => {
        seen.push('A');
        offB();
        bus.on('toast', () => seen.push('late'));
    });
    offB = bus.on('toast', () => seen.push('B'));
    bus.emit('toast', {});
    assert.deepEqual(seen, ['A'], 'removed handlers are skipped; new ones wait for the next emit');
    bus.emit('toast', {});
    assert.deepEqual(seen, ['A', 'A', 'late']);
});

test('clear() drops everything; unknown types are harmless', () => {
    const bus = createBus();
    const seen = [];
    bus.on('toast', () => seen.push(1));
    bus.on('mystery', () => seen.push(2));
    bus.emit('mystery');
    bus.clear();
    bus.emit('toast', {});
    bus.emit('mystery');
    assert.deepEqual(seen, [2]);
    bus.emit('never-registered', 5);
});
