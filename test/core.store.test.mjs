// Tests for js/core/store.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, DEFAULT_STATE } from '../js/core/store.js';

test('DEFAULT_STATE matches the spec and is deeply frozen', () => {
    assert.deepEqual(DEFAULT_STATE.observer, {
        latDeg: 51.4769, lonDeg: -0.0005, elevM: 0, name: 'Royal Observatory Greenwich', country: 'United Kingdom',
        tz: 'Europe/London', tzApprox: false, source: 'default',
    });
    assert.equal(DEFAULT_STATE.selection, null);
    assert.deepEqual(DEFAULT_STATE.view, { mode: 'orbit', earthLock: true });
    assert.deepEqual(DEFAULT_STATE.layers, {
        beams: true, ghostBeams: true, sunMoonBeams: true, stars: true, constellations: true, constellationNames: true, starNames: true,
        milkyWay: true, clouds: true, atmosphere: true, ecliptic: false, eqGrid: false, altAzGrid: true, horizon: true, footprint: false,
        subpoints: false, trails: false, labels: true,
    });
    assert.deepEqual(DEFAULT_STATE.display, { tzMode: 'observer', hour12: false });
    assert.deepEqual(DEFAULT_STATE.quality, { setting: 'auto', active: 'medium', ceiling: 'medium' });
    assert.deepEqual(DEFAULT_STATE.ui, { panel: 'sky', sheet: 'peek', cinema: false, help: false, palette: false });
    assert.deepEqual(DEFAULT_STATE.status, {
        phase: 'boot', progress: 0, webgl: true, onlineSearch: 'unknown', reducedMotion: false, coarse: false, introPlaying: false,
    });
    assert.ok(Object.isFrozen(DEFAULT_STATE));
    assert.ok(Object.isFrozen(DEFAULT_STATE.layers));
    assert.throws(() => { DEFAULT_STATE.layers.beams = false; }, TypeError);
});

test('createStore merges a partial initial state over the defaults', () => {
    const s = createStore({ observer: { latDeg: 10, lonDeg: 20, name: 'X' }, layers: { beams: false }, selection: 'mars' });
    const st = s.get();
    assert.equal(st.observer.latDeg, 10);
    assert.equal(st.observer.tz, 'Europe/London', 'unspecified observer fields keep their defaults');
    assert.equal(st.layers.beams, false);
    assert.equal(st.layers.stars, true);
    assert.equal(st.selection, 'mars');
    assert.equal(st.view, DEFAULT_STATE.view, 'untouched slices are shared, not copied');
    assert.deepEqual(createStore().get(), DEFAULT_STATE);
    assert.deepEqual(createStore(null).get(), DEFAULT_STATE);
    const u = createStore({ observer: undefined, layers: undefined });
    assert.deepEqual(u.get().observer, DEFAULT_STATE.observer, 'undefined slices mean "not provided"');
});

test('set merges per slice, immutably, preserving identity of untouched slices', () => {
    const s = createStore();
    const before = s.get();
    assert.equal(s.set({ layers: { beams: false } }), true);
    const after = s.get();
    assert.notEqual(after, before);
    assert.notEqual(after.layers, before.layers);
    assert.equal(after.layers.beams, false);
    assert.equal(after.layers.stars, true);
    assert.equal(before.layers.beams, true, 'the previous state is not mutated');
    assert.equal(after.observer, before.observer);
    assert.ok(Object.isFrozen(after) && Object.isFrozen(after.layers));
    assert.equal(s.set({ layers: { beams: false } }), false, 'no-op patch');
    assert.equal(s.get(), after, 'no-op keeps state identity');
    assert.equal(s.set({ observer: { tz: undefined } }), false, 'undefined fields are ignored');
    s.set({ selection: 'moon' });
    assert.equal(s.get().selection, 'moon');
    s.set({ selection: null });
    assert.equal(s.get().selection, null, 'null clears');
    assert.equal(s.set(null), false);
    assert.equal(s.set('layers'), false);
    s.set({ extra: { a: 1 } });
    assert.deepEqual(s.get().extra, { a: 1 }, 'forward-compatible: unknown slices are kept');
    s.set((st) => ({ ui: { panel: st.ui.panel === 'sky' ? 'layers' : 'sky' } }));
    assert.equal(s.get().ui.panel, 'layers', 'functional patch');
});

test('subscribe fires on Object.is change of the selected value only', () => {
    const s = createStore();
    const calls = [];
    const off = s.subscribe((st) => st.layers, (v, prev, state, source) => calls.push({ v, prev, state, source }));
    s.set({ selection: 'mars' });
    assert.equal(calls.length, 0, 'other slices do not notify');
    s.set({ layers: { beams: false } }, 'shortcut');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].v.beams, false);
    assert.equal(calls[0].prev.beams, true);
    assert.equal(calls[0].state, s.get());
    assert.equal(calls[0].source, 'shortcut');
    s.set({ layers: { beams: false } });
    assert.equal(calls.length, 1, 'no change, no call');
    off();
    s.set({ layers: { beams: true } });
    assert.equal(calls.length, 1, 'unsubscribed');
    off();
});

test('subscribe accepts dotted paths and null; immediate delivers the current value', () => {
    const s = createStore();
    const modes = [];
    s.subscribe('view.mode', (v, prev) => modes.push([v, prev]), { immediate: true });
    s.set({ view: { earthLock: false } });
    s.set({ view: { mode: 'sky' } });
    assert.deepEqual(modes, [['orbit', undefined], ['sky', 'orbit']]);
    const all = [];
    s.subscribe(null, (st) => all.push(st));
    s.set({ selection: 'sun' });
    assert.equal(all.length, 1);
    assert.equal(all[0], s.get());
    const missing = [];
    s.subscribe('no.such.path', (v) => missing.push(v), { immediate: true });
    assert.deepEqual(missing, [undefined]);
    assert.equal(typeof s.subscribe('x', null), 'function');
});

test('re-entrant set inside a subscriber is applied and everyone sees the final state', () => {
    const s = createStore();
    const log = [];
    s.subscribe('selection', (v) => {
        log.push(`A:${v}`);
        if (v === 'mars') s.set({ ui: { panel: 'details' } }, 'auto');
    });
    s.subscribe('ui.panel', (v, prev, st, source) => log.push(`B:${v}:${source}`));
    s.subscribe('selection', (v, prev, st) => log.push(`C:${v}:${st.ui.panel}`));
    s.set({ selection: 'mars' }, 'click');
    assert.equal(s.get().ui.panel, 'details');
    assert.deepEqual(log, ['A:mars', 'B:details:auto', 'C:mars:details']);
});

test('a ping-pong of subscribers is cut off instead of hanging', () => {
    const errors = [];
    const s = createStore(undefined, { onError: (e) => errors.push(e) });
    s.subscribe('ui.help', (v) => s.set({ ui: { help: !v } }));
    s.set({ ui: { help: true } });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0].message), /gave up/);
});

test('throwing selectors and subscribers are isolated', () => {
    const errors = [];
    const s = createStore(undefined, { onError: (e) => errors.push(e) });
    const seen = [];
    s.subscribe(() => { throw new Error('bad selector'); }, () => seen.push('never'));
    s.subscribe('selection', () => { throw new Error('bad subscriber'); });
    s.subscribe('selection', (v) => seen.push(v));
    s.set({ selection: 'venus' });
    assert.deepEqual(seen, ['venus']);
    assert.ok(errors.some((e) => e.message === 'bad selector'));
    assert.ok(errors.some((e) => e.message === 'bad subscriber'));
});

test('unsubscribing during a notification pass is safe', () => {
    const s = createStore();
    const seen = [];
    let offB = null;
    s.subscribe('selection', () => { seen.push('A'); offB(); });
    offB = s.subscribe('selection', () => seen.push('B'));
    s.subscribe('selection', () => seen.push('C'));
    s.set({ selection: 'moon' });
    assert.deepEqual(seen, ['A', 'C'], 'B was removed before its turn');
    s.set({ selection: 'sun' });
    assert.deepEqual(seen, ['A', 'C', 'A', 'C']);
});
