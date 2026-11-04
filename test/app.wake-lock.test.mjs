// The shared screen wake lock (js/app/wake-lock.js): reasons, visibility, refusals, idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock, WAKE_IDLE_MS } from '../js/app/wake-lock.js';

const tick = () => new Promise((r) => setImmediate(r));

/** A navigator whose screen lock the page can lose, a document and an input target. */
function fakeEnv({ refuse = false } = {}) {
    const doc = { visibilityState: 'visible', listeners: new Map() };
    doc.addEventListener = (n, fn) => doc.listeners.set(n, fn);
    doc.removeEventListener = (n) => doc.listeners.delete(n);
    const win = { listeners: new Map() };
    win.addEventListener = (n, fn) => win.listeners.set(n, fn);
    win.removeEventListener = (n) => win.listeners.delete(n);
    const sentinels = [];
    let requests = 0;
    const nav = {
        wakeLock: {
            request(type) {
                requests++;
                assert.equal(type, 'screen');
                if (refuse) return Promise.reject(new Error('NotAllowedError'));
                const s = {
                    released: false, onRelease: null,
                    addEventListener(n, fn) { if (n === 'release') this.onRelease = fn; },
                    release() { this.released = true; this.onRelease?.(); return Promise.resolve(); },
                };
                sentinels.push(s);
                return Promise.resolve(s);
            },
        },
    };
    let t = 0;
    return {
        nav, doc, win, sentinels, now: () => t, advance: (ms) => { t += ms; },
        get requests() { return requests; },
        /** The page hides: the browser releases the lock itself. */
        hide() { doc.visibilityState = 'hidden'; for (const s of sentinels) if (!s.released) s.release(); doc.listeners.get('visibilitychange')?.(); },
        show() { doc.visibilityState = 'visible'; doc.listeners.get('visibilitychange')?.(); },
    };
}

test('createWakeLock: held while any reason is, released when the last one goes', async () => {
    const env = fakeEnv();
    const wake = createWakeLock(env);
    assert.equal(wake.locked, false);
    wake.hold('red', true);
    await tick();
    assert.equal(wake.locked, true);
    assert.equal(env.requests, 1);
    wake.hold('sky', true);
    wake.hold('red', true);   // idempotent
    await tick();
    assert.equal(env.requests, 1, 'one lock for every reason');
    assert.deepEqual(wake.reasons, ['red', 'sky']);
    wake.hold('red', false);
    assert.equal(wake.locked, true, 'sky still holds it');
    wake.hold('sky', false);
    assert.equal(wake.locked, false);
    assert.equal(env.sentinels[0].released, true);
    assert.equal(env.doc.listeners.size + env.win.listeners.size, 0, 'listeners off with no reason');
    wake.dispose();
});

test('createWakeLock: asked again when the page shows', async () => {
    const env = fakeEnv();
    const wake = createWakeLock(env);
    wake.hold('red', true);
    await tick();
    env.hide();
    assert.equal(wake.locked, false, 'the browser let it go');
    assert.equal(env.requests, 1, 'not asked while hidden');
    env.show();
    await tick();
    assert.equal(wake.locked, true);
    assert.equal(env.requests, 2);
    wake.dispose();
    assert.equal(env.sentinels[1].released, true);
});

test('createWakeLock: a reason dropped while the request is pending lets the lock go at once', async () => {
    const env = fakeEnv();
    const wake = createWakeLock(env);
    wake.hold('aim', true);
    wake.hold('aim', false);
    await tick();
    assert.equal(wake.locked, false);
    assert.equal(env.sentinels[0].released, true);
});

test('createWakeLock: a refusal is quiet and not retried until something changes', async () => {
    const env = fakeEnv({ refuse: true });
    const wake = createWakeLock(env);
    wake.hold('red', true);
    await tick();
    assert.equal(wake.locked, false);
    env.win.listeners.get('pointerdown')?.();
    await tick();
    assert.equal(env.requests, 1, 'input does not retry a refusal');
    wake.hold('sky', true);
    await tick();
    assert.equal(env.requests, 2, 'a new reason does');
    env.hide();
    env.show();
    await tick();
    assert.equal(env.requests, 3, 'and so does the page showing again');
    wake.dispose();
});

test('createWakeLock: no API, or one that throws, is no lock and no error', async () => {
    const a = createWakeLock({ nav: {}, doc: null, win: null });
    a.hold('red', true);
    assert.equal(a.locked, false);
    a.dispose();
    const b = createWakeLock({ nav: { wakeLock: { request() { throw new Error('policy'); } } }, doc: null, win: null });
    b.hold('red', true);
    await tick();
    assert.equal(b.locked, false);
    b.dispose();
});

test('createWakeLock: idle for WAKE_IDLE_MS lets go until the next tap', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const env = fakeEnv();
    const wake = createWakeLock(env);
    wake.hold('sky', true);
    await tick();
    assert.equal(wake.locked, true);
    env.advance(WAKE_IDLE_MS + 1);
    t.mock.timers.tick(60000);
    assert.equal(wake.locked, false, 'idle');
    env.win.listeners.get('keydown')?.();
    await tick();
    assert.equal(wake.locked, true, 'back on the next key');
    assert.equal(env.requests, 2);
    wake.dispose();
});
