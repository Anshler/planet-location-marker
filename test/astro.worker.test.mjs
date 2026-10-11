// Astro worker protocol and client (SPEC §C.2): module-worker path, main-thread
// fallback, abort and dispose semantics. Node has no Worker, so fake Worker
// classes stand in for the browser; the real module worker is exercised by
// the headless-Chrome harness in .scratch/G1/worker.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../js/astro/worker.js';
import { createAstroClient } from '../js/astro/client.js';
import { BODY_IDS } from '../js/astro/bodies.js';

const HANOI = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15, tz: 'Asia/Ho_Chi_Minh' };
const DAY_START = Date.parse('2026-10-10T17:00:00Z');
const NEAR = Date.parse('2026-10-11T08:00:00Z');

test('worker.js is importable on the main thread without side effects', () => {
    assert.equal(typeof W.runOp, 'function');
    assert.deepEqual(Object.keys(W.OPS).sort(), ['almanac', 'events', 'path', 'ping', 'riseSet', 'sunSeries', 'tonight', 'twilight']);
    assert.equal(typeof globalThis.onmessage, 'undefined');
});

test('runOp: every op returns the documented shape', () => {
    assert.equal(W.runOp('ping'), 'pong');
    const rs = W.runOp('riseSet', { observer: HANOI, fromMs: DAY_START, toMs: DAY_START + 864e5 });
    assert.deepEqual(Object.keys(rs), [...BODY_IDS]);
    assert.ok(rs.sun.riseMs > DAY_START && rs.sun.status === 'normal');
    const some = W.runOp('riseSet', { bodyIds: ['moon', 'mars'], observer: HANOI, fromMs: DAY_START, toMs: DAY_START + 864e5 });
    assert.deepEqual(Object.keys(some), ['moon', 'mars']);
    const tw = W.runOp('twilight', { observer: HANOI, nearMs: NEAR });
    assert.ok(tw.sunsetMs < tw.sunriseMs);
    const tn = W.runOp('tonight', { observer: HANOI, nearMs: NEAR, hour12: true });
    assert.equal(tn.reports.length, 8);
    const ev = W.runOp('events', { observer: HANOI, fromMs: NEAR, days: 60 });
    assert.ok(Array.isArray(ev) && ev.length > 5);
    const path = W.runOp('path', { bodyId: 'mars', centerMs: Date.parse('2025-01-16T00:00:00Z') });
    assert.equal(path.stations.length, 2);
    assert.ok(path.dirS instanceof Float32Array);
    const ss = W.runOp('sunSeries', { observer: HANOI, fromMs: NEAR, toMs: NEAR + 864e5, n: 96 });
    assert.ok(ss instanceof Float32Array && ss.length === 96);
    const alm = W.runOp('almanac', { observer: HANOI, dayStartMs: DAY_START, nearMs: NEAR, n: 48 });
    assert.deepEqual(Object.keys(alm), ['riseSet', 'twilight', 'tonight', 'sunSeries']);
    assert.equal(alm.sunSeries.values.length, 48);
    assert.equal(alm.sunSeries.fromMs, DAY_START);
    assert.equal(alm.sunSeries.toMs, DAY_START + 864e5);
    assert.throws(() => W.runOp('nope'), RangeError);
    assert.throws(() => W.runOp('constructor'), RangeError);
    assert.throws(() => W.runOp('riseSet', { observer: { latDeg: 'x', lonDeg: 0 }, fromMs: 0, toMs: 1 }), TypeError);
});

test('handleMessage replies {id, ok, result} with transferables, or {id, ok: false, error}', () => {
    const replies = [];
    const post = (msg, transfer) => replies.push({ msg, transfer });
    W.handleMessage({ id: 7, op: 'sunSeries', args: { observer: HANOI, fromMs: NEAR, toMs: NEAR + 864e5, n: 8 } }, post);
    W.handleMessage({ id: 8, op: 'path', args: { bodyId: 'venus', centerMs: NEAR, halfSpanDays: 5 } }, post);
    W.handleMessage({ id: 9, op: 'twilight', args: { observer: null, nearMs: NEAR } }, post);
    W.handleMessage({ id: 10, op: 'bogus' }, post);
    W.handleMessage(null, post);
    assert.equal(replies[0].msg.id, 7);
    assert.equal(replies[0].msg.ok, true);
    assert.deepEqual(replies[0].transfer, [replies[0].msg.result.buffer]);
    assert.equal(replies[1].transfer.length, 3, 'tMs, dirS and eclLonDeg buffers');
    assert.deepEqual(replies[2].msg, { id: 9, ok: false, error: { name: 'TypeError', message: 'observer.latDeg and observer.lonDeg must be finite numbers' } });
    assert.equal(replies[3].msg.ok, false);
    assert.equal(replies[3].msg.error.name, 'RangeError');
    assert.equal(replies[4].msg.ok, false);
    assert.deepEqual(W.serializeError('astronomy-engine threw a string'), { name: 'Error', message: 'astronomy-engine threw a string' });
    assert.deepEqual(W.transferablesOf([1, 2]), []);
    assert.deepEqual(W.transferablesOf({ sunSeries: { values: new Float32Array(2) } }).length, 1);
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

test('client without Worker support falls back to the main thread', async () => {
    assert.equal(typeof globalThis.Worker, 'undefined');
    const client = createAstroClient();
    assert.equal(client.mode, 'idle', 'worker creation is lazy');
    assert.equal(await client.call('ping'), 'pong');
    assert.equal(client.mode, 'fallback');
    const [tw, ss] = await Promise.all([
        client.call('twilight', { observer: HANOI, nearMs: NEAR }),
        client.call('sunSeries', { observer: HANOI, fromMs: NEAR, toMs: NEAR + 864e5, n: 12 }),
    ]);
    assert.ok(tw.sunsetMs > 0);
    assert.equal(ss.length, 12);
    await assert.rejects(client.call('nope'), (e) => e instanceof Error && /Unknown astro op/.test(e.message) && e.name === 'RangeError');
    client.dispose();
});

test('client abort: an already-aborted signal rejects at once; a later abort rejects with AbortError and drops the result', async () => {
    const client = createAstroClient({ forceFallback: true });
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(client.call('ping', {}, { signal: pre.signal }), { name: 'AbortError' });
    const ac = new AbortController();
    const p = client.call('events', { observer: HANOI, fromMs: NEAR, days: 30 }, { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(await client.call('ping'), 'pong', 'the client keeps working after an abort');
    client.dispose();
});

test('client dispose rejects pending calls with AbortError and refuses new ones', async () => {
    const client = createAstroClient({ forceFallback: true });
    const p = client.call('events', { observer: HANOI, fromMs: NEAR, days: 30 });
    client.dispose();
    await assert.rejects(p, { name: 'AbortError' });
    await assert.rejects(client.call('ping'), /disposed/);
    assert.equal(client.mode, 'disposed');
    client.dispose(); // idempotent
});

// A stand-in for a module Worker: runs the real handler asynchronously.
function installFakeWorker({ failAfterLoad = false, throwInCtor = false, throwOnPost = false } = {}) {
    const created = [];
    class FakeWorker extends EventTarget {
        constructor(url, opts) {
            super();
            if (throwInCtor) throw new Error('module workers unsupported');
            this.url = String(url);
            this.opts = opts;
            this.terminated = false;
            this.received = [];
            created.push(this);
            if (failAfterLoad) {
                setTimeout(() => this.dispatchEvent(new Event('error', { cancelable: true })), 5);
            } else {
                setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } })), 0);
            }
        }
        postMessage(data) {
            if (throwOnPost) throw new DOMException('could not clone', 'DataCloneError');
            this.received.push(data);
            if (failAfterLoad) return; // never answers
            setTimeout(() => {
                if (this.terminated) return;
                W.handleMessage(data, (msg) => this.dispatchEvent(new MessageEvent('message', { data: msg })));
            }, 0);
        }
        terminate() {
            this.terminated = true;
        }
    }
    globalThis.Worker = FakeWorker;
    return { created, restore: () => { delete globalThis.Worker; } };
}

test('client with a working module worker posts {id, op, args} and resolves from the replies', async () => {
    const fake = installFakeWorker();
    try {
        const client = createAstroClient();
        const [a, b] = await Promise.all([
            client.call('ping'),
            client.call('riseSet', { bodyIds: ['sun'], observer: HANOI, fromMs: DAY_START, toMs: DAY_START + 864e5 }),
        ]);
        assert.equal(a, 'pong');
        assert.ok(b.sun.riseMs > 0);
        assert.equal(client.mode, 'worker');
        assert.equal(fake.created.length, 1, 'one worker for many calls');
        const w = fake.created[0];
        assert.ok(w.url.endsWith('/js/astro/worker.js'), w.url);
        assert.equal(w.opts.type, 'module');
        assert.deepEqual(Object.keys(w.received[0]), ['id', 'op', 'args']);
        await assert.rejects(client.call('nope'), { name: 'RangeError' });
        client.dispose();
        assert.equal(w.terminated, true);
    } finally {
        fake.restore();
    }
});

test('client falls back when the worker fires an error, re-running the calls that were in flight', async () => {
    const fake = installFakeWorker({ failAfterLoad: true });
    try {
        const client = createAstroClient();
        const p1 = client.call('ping');
        const p2 = client.call('twilight', { observer: HANOI, nearMs: NEAR });
        assert.equal(client.mode, 'worker');
        assert.equal(await p1, 'pong');
        assert.ok((await p2).sunsetMs > 0);
        assert.equal(client.mode, 'fallback');
        assert.equal(fake.created[0].terminated, true);
        assert.equal(await client.call('ping'), 'pong');
        assert.equal(fake.created.length, 1, 'no second worker after a failure');
        client.dispose();
    } finally {
        fake.restore();
    }
});

test('client falls back when the Worker constructor throws', async () => {
    const fake = installFakeWorker({ throwInCtor: true });
    try {
        const client = createAstroClient();
        assert.equal(await client.call('ping'), 'pong');
        assert.equal(client.mode, 'fallback');
        client.dispose();
    } finally {
        fake.restore();
    }
});

test('a call whose arguments cannot be posted runs on the main thread instead', async () => {
    const fake = installFakeWorker({ throwOnPost: true });
    try {
        const client = createAstroClient();
        assert.equal(await client.call('ping'), 'pong');
        assert.equal(client.mode, 'worker', 'the worker stays available for other calls');
        client.dispose();
    } finally {
        fake.restore();
    }
});
