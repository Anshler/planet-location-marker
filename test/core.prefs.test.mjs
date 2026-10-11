// Tests for js/core/prefs.js — with no storage, a working fake, a throwing one and a full one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, save, remove, clearAll, persistent, PREFIX, PREF_KEYS } from '../js/core/prefs.js';

function fakeStorage({ quota = Infinity } = {}) {
    const map = new Map();
    return {
        map,
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem(k, v) {
            const size = [...map.values()].reduce((n, s) => n + s.length, 0) + String(v).length;
            if (size > quota) throw new Error('QuotaExceededError');
            map.set(k, String(v));
        },
        removeItem: (k) => { map.delete(k); },
    };
}

function withStorage(storage, fn) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });
    try {
        clearAll();
        return fn();
    } finally {
        clearAll();
        if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
        else delete globalThis.localStorage;
    }
}

test('keys and prefix', () => {
    assert.equal(PREFIX, 'pc2.');
    assert.deepEqual([...PREF_KEYS], ['observer', 'layers', 'quality', 'display', 'introSeen', 'geocache', 'recentPlaces']);
});

test('persists to localStorage under pc2.', () => {
    const ls = fakeStorage();
    withStorage(ls, () => {
        assert.equal(persistent(), true);
        assert.equal(save('introSeen', true), true);
        assert.equal(ls.map.get('pc2.introSeen'), 'true');
        assert.equal(load('introSeen', false), true);
        save('observer', { latDeg: 10, lonDeg: 20, name: 'X' });
        assert.deepEqual(load('observer', null), { latDeg: 10, lonDeg: 20, name: 'X' });
        assert.notEqual(load('observer', null), load('observer', null), 'fresh copies');
        assert.equal(remove('observer'), true);
        assert.equal(load('observer', 'gone'), 'gone');
        save('introSeen', undefined);
        assert.equal(ls.map.has('pc2.introSeen'), false, 'undefined removes');
    });
});

test('reads values written in an earlier session', () => {
    const ls = fakeStorage();
    withStorage(ls, () => {
        // Written by a previous page load: present in storage, absent from this session's memory.
        ls.map.set('pc2.display', JSON.stringify({ tzMode: 'utc', hour12: true }));
        assert.deepEqual(load('display', { tzMode: 'observer', hour12: false }), { tzMode: 'utc', hour12: true });
    });
});

test('without localStorage everything still works for the session', () => {
    withStorage(undefined, () => {
        assert.equal(persistent(), false);
        assert.equal(save('layers', { beams: false }), false, 'memory only');
        assert.deepEqual(load('layers', null), { beams: false });
        clearAll();
        assert.equal(load('layers', 'none'), 'none');
    });
});

test('a localStorage that throws on access is treated as missing', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
        assert.equal(save('quality', 'high'), false);
        assert.equal(load('quality', 'auto'), 'high');
        assert.equal(persistent(), false);
        clearAll();
    } finally {
        if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
        else delete globalThis.localStorage;
    }
});

test('quota errors fall back to memory, and this session sees its own latest value', () => {
    const ls = fakeStorage({ quota: 40 });
    withStorage(ls, () => {
        assert.equal(save('quality', 'low'), true);
        assert.equal(save('geocache', ['x'.repeat(100)]), false, 'too big for storage');
        assert.deepEqual(load('geocache', []), ['x'.repeat(100)], 'still available this session');
        ls.map.set('pc2.quality', '"high"');
        assert.equal(load('quality', 'auto'), 'low', 'memory (this session) wins over storage');
    });
});

test('corrupt or mistyped stored values never leak through', () => {
    const ls = fakeStorage();
    withStorage(ls, () => {
        ls.map.set('pc2.layers', '{not json');
        assert.deepEqual(load('layers', { beams: true }), { beams: true });
        ls.map.set('pc2.introSeen', '"yes"');
        assert.equal(load('introSeen', false), false, 'type mismatch → fallback');
        ls.map.set('pc2.recentPlaces', '{"a":1}');
        assert.deepEqual(load('recentPlaces', []), [], 'object where an array is expected');
        ls.map.set('pc2.quality', '1e999');
        assert.equal(load('quality', 0), 0, 'non-finite numbers rejected');
        ls.map.set('pc2.display', JSON.stringify({ tzMode: 42, hour12: true, extra: 'kept' }));
        assert.deepEqual(load('display', { tzMode: 'observer', hour12: false }), { tzMode: 'observer', hour12: true, extra: 'kept' },
            'per-key: mistyped keys fall back to defaults, new keys are filled, unknown keys are kept');
        ls.map.set('pc2.observer', JSON.stringify({ latDeg: 1 }));
        assert.deepEqual(load('observer'), { latDeg: 1 }, 'no fallback: anything goes');
        assert.equal(load('missing'), undefined);
    });
});

test('save rejects values JSON cannot encode', () => {
    withStorage(fakeStorage(), () => {
        const cyclic = {};
        cyclic.self = cyclic;
        assert.equal(save('observer', cyclic), false);
        assert.equal(save('observer', () => 1), false);
        assert.equal(load('observer', 'none'), 'none');
    });
});

test('clearAll removes only pc2.* keys', () => {
    const ls = fakeStorage();
    ls.map.set('other-app', 'keep');
    withStorage(ls, () => {
        save('layers', {});
        save('display', {});
        clearAll();
        assert.deepEqual([...ls.map.keys()], ['other-app']);
    });
});
