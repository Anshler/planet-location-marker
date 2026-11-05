// The page's side of the service worker (js/app/sw-client.js) against a fake navigator.serviceWorker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swMode, createSwClient } from '../js/app/sw-client.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake worker that answers {type:'version'} on its port and records everything else. */
function fakeWorker(version, staged = true) {
    return {
        version, posted: [],
        postMessage(msg, ports) {
            this.posted.push(msg);
            if (msg.type === 'version') queueMicrotask(() => ports[0].reply({ type: 'version', version, staged }));
        },
    };
}

class FakeChannel {
    constructor() {
        this.port1 = { onmessage: null };
        this.port2 = { reply: (data) => this.port1.onmessage?.({ data }) };
    }
}

function fakeEnv({ hash = '', protocol = 'https:', hostname = 'example.github.io', controller = null, waiting = null, hidden = false } = {}) {
    const listeners = {};
    const active = controller ?? fakeWorker('v1');
    const reg = { active, waiting, installing: null, unregistered: false, unregister() { this.unregistered = true; return Promise.resolve(true); } };
    const sw = {
        controller,
        registered: [],
        addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
        register(url) {
            this.registered.push(url);
            return Promise.resolve(reg);
        },
        getRegistration: () => Promise.resolve(reg),
        ready: Promise.resolve(reg),
        fire(type, data) { for (const fn of listeners[type] ?? []) fn({ data }); },
    };
    const toasts = [];
    const timers = [];
    const deleted = [];
    const win = {
        location: { hash, protocol, hostname },
        document: { hidden },
        MessageChannel: FakeChannel,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        caches: { keys: () => Promise.resolve(['pc2-1', 'other-app', 'pc2-2']), delete: (k) => { deleted.push(k); return Promise.resolve(true); } },
    };
    let reloads = 0;
    const client = createSwClient({
        nav: { serviceWorker: sw }, win, bus: { emit: (t, p) => { if (t === 'toast') toasts.push(p); } },
        urls: () => ['https://example.github.io/planet-location-marker/assets/textures/earth_day_4096.jpg'],
        reload: () => { reloads++; },
    });
    return { client, sw, reg, active, toasts, timers, deleted, win, reloads: () => reloads };
}

test('swMode: the deploy and #sw=1 register, #sw=0 unregisters, localhost alone does nothing', () => {
    assert.equal(swMode({ protocol: 'https:', hostname: 'anshler.github.io', hash: '' }), 'on');
    assert.equal(swMode({ protocol: 'http:', hostname: 'localhost', hash: '' }), null);
    assert.equal(swMode({ protocol: 'https:', hostname: 'localhost', hash: '' }), null);
    assert.equal(swMode({ protocol: 'http:', hostname: '127.0.0.1', hash: '#sw=1' }), 'on');
    assert.equal(swMode({ protocol: 'http:', hostname: '127.0.0.1', hash: '#t=2027-08-02T10:00:00Z&intro=0&sw=1' }), 'on');
    assert.equal(swMode({ protocol: 'https:', hostname: 'anshler.github.io', hash: '#q=high&sw=0' }), 'off');
    assert.equal(swMode({ protocol: 'http:', hostname: '127.0.0.1', hash: '#sw=10' }), null);
    assert.equal(swMode({ protocol: 'http:', hostname: '127.0.0.1', hash: '#xsw=1' }), null);
    assert.equal(swMode(undefined), null);
});

test('first visit: registers, reads the version, warms the worker up, then knows it is precached', async () => {
    const env = fakeEnv();
    const state = await env.client.start();
    assert.deepEqual(env.sw.registered, ['sw.js']);
    assert.equal(state.registered, true);
    assert.equal(state.version, 'v1');
    assert.equal(state.staged, true);
    const warm = env.active.posted.find((m) => m.type === 'precache');
    assert.ok(warm, 'the URLs this visit loaded go to the active worker');
    assert.match(warm.urls[0], /earth_day_4096/);
    assert.equal(state.precached, false);
    env.sw.fire('message', { type: 'precached', version: 'v1' });
    assert.equal(state.precached, true);
    // The install's clients.claim(): now controlled, and no reload or toast for it.
    env.sw.controller = env.active;
    env.sw.fire('controllerchange');
    assert.equal(state.controlled, true);
    assert.equal(state.precached, true);
    assert.equal(env.reloads(), 0);
    assert.equal(env.toasts.length, 0);
});

test('update: one sticky toast; Reload sends skip-waiting and reloads once the new version controls', async () => {
    const old = fakeWorker('v1');
    const env = fakeEnv({ controller: old });
    const state = await env.client.start();
    assert.equal(state.controlled, true);
    const next = fakeWorker('v2');
    env.reg.waiting = next;
    env.sw.fire('message', { type: 'update-ready', version: 'v2' });
    env.sw.fire('message', { type: 'update-ready', version: 'v2' });
    assert.equal(env.toasts.length, 1, 'offered once');
    const t = env.toasts[0];
    assert.equal(t.message, 'A new version is ready');
    assert.equal(t.actionLabel, 'Reload');
    assert.equal(t.timeoutMs, 0, 'stays until used or dismissed');
    assert.equal(state.waiting, 'v2');
    t.onAction();
    assert.deepEqual(next.posted, [{ type: 'skip-waiting' }]);
    assert.equal(env.reloads(), 0, 'not before the new version controls the page');
    env.sw.controller = next;
    env.sw.fire('controllerchange');
    assert.equal(env.reloads(), 1);
    // The fallback timer (no controllerchange) never reloads twice.
    for (const { fn } of env.timers) fn();
    assert.equal(env.reloads(), 1);
});

test('update: Reload still reloads when the controllerchange never comes', async () => {
    const env = fakeEnv({ controller: fakeWorker('v1') });
    await env.client.start();
    env.reg.waiting = fakeWorker('v2');
    env.sw.fire('message', { type: 'update-ready', version: 'v2' });
    env.toasts[0].onAction();
    const fallback = env.timers.find((t) => t.ms === 4000);
    assert.ok(fallback, 'a 4 s fallback');
    fallback.fn();
    assert.equal(env.reloads(), 1);
});

test('a version waiting from an earlier visit is offered at start', async () => {
    const env = fakeEnv({ controller: fakeWorker('v1'), waiting: fakeWorker('v2') });
    const state = await env.client.start();
    await tick();
    assert.equal(env.toasts.length, 1);
    assert.equal(state.waiting, 'v2', 'asked the waiting worker for its version');
    env.sw.fire('message', { type: 'update-ready', version: 'v2' });
    assert.equal(env.toasts.length, 1, 'not offered again');
});

test('a version activated in another tab: a hidden tab reloads, a visible one is offered the reload', async () => {
    const hidden = fakeEnv({ controller: fakeWorker('v1'), hidden: true });
    await hidden.client.start();
    hidden.sw.controller = fakeWorker('v2');
    hidden.sw.fire('controllerchange');
    assert.equal(hidden.reloads(), 1);
    assert.equal(hidden.toasts.length, 0);

    const shown = fakeEnv({ controller: fakeWorker('v1') });
    const state = await shown.client.start();
    shown.sw.fire('message', { type: 'precached', version: 'v1' });
    shown.sw.controller = fakeWorker('v2');
    shown.sw.fire('controllerchange');
    assert.equal(shown.reloads(), 0);
    assert.equal(shown.toasts.length, 1);
    assert.equal(state.precached, false, 'the new version has not been warmed up by this page');
    shown.toasts[0].onAction();   // nothing waiting any more: a plain reload
    assert.equal(shown.reloads(), 1);
});

test('#sw=0 unregisters and drops only this app\'s caches; insecure pages and localhost leave it alone', async () => {
    const off = fakeEnv({ hash: '#sw=0' });
    await off.client.start();
    assert.equal(off.reg.unregistered, true);
    assert.deepEqual(off.deleted, ['pc2-1', 'pc2-2']);
    assert.deepEqual(off.sw.registered, []);

    const local = fakeEnv({ protocol: 'http:', hostname: 'localhost' });
    const state = await local.client.start();
    assert.deepEqual(local.sw.registered, [], 'dev without #sw=1: no registration');
    assert.equal(state.registered, false);

    const insecure = createSwClient({ nav: { serviceWorker: local.sw }, win: local.win, secure: false });
    await insecure.start();
    assert.deepEqual(local.sw.registered, []);
    assert.equal((await createSwClient({ nav: {}, win: local.win }).start()).registered, false, 'no serviceWorker API');
});
