// The Earth's day and night slots (instant-earth-progressive-textures): the 512 px preview first,
// then a 600 ms sharpen into the map with a uniform-only tween, skipped when nobody saw the preview
// or with reduced motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/three-hooks.mjs', import.meta.url);
const { createEarth } = await import('../js/render/earth.js');

/** A store stand-in the test drives: ready(key) makes a key ready and calls its listeners. */
function fakeStore() {
    const tex = new Map(), listeners = new Map();
    const t = (key) => {
        if (!tex.has(key)) tex.set(key, { name: key, isTexture: true });
        return tex.get(key);
    };
    const ready = new Set();
    const PREV = { day2k: 'dayPreview', day4k: 'dayPreview', night2k: 'nightPreview', night4k: 'nightPreview' };
    return {
        get: (key) => (ready.has(key) ? t(key) : ready.has(PREV[key]) ? t(PREV[key]) : t(`placeholder:${key}`)),
        isReady: (key) => ready.has(key),
        state: (key) => (ready.has(key) ? 'ready' : ready.has(PREV[key]) ? 'preview' : 'loading'),
        onReady(key, cb) {
            if (ready.has(key)) { cb(t(key)); return () => {}; }
            const set = listeners.get(key) ?? new Set();
            set.add(cb);
            listeners.set(key, set);
            return () => set.delete(cb);
        },
        ready(key) {
            ready.add(key);
            for (const cb of listeners.get(key) ?? []) cb(t(key));
            listeners.delete(key);
        },
    };
}

function earthWith(store, { reducedMotion = false } = {}) {
    let invalidations = 0;
    const rc = { tier: 'low', invalidate: () => { invalidations++; } };
    const earth = createEarth(rc, { textures: store, reducedMotion });
    const u = earth.mesh.material.uniforms;
    return { earth, u, invalidations: () => invalidations };
}

test('earth: preview first, then a 600 ms sharpen into the map, uniform only', () => {
    const store = fakeStore();
    const { earth, u, invalidations } = earthWith(store);
    assert.equal(u.uDay.value.name, 'placeholder:day2k');
    store.ready('dayPreview');
    store.ready('nightPreview');
    assert.equal(u.uDay.value.name, 'dayPreview', 'the preview replaces the flat placeholder');
    assert.equal(u.uNight.value.name, 'nightPreview');
    const sharpen = u.uSharpen.value;
    assert.deepEqual([sharpen.x, sharpen.y], [1, 1], 'no mix while the preview is the map');
    earth.update({ timeS: 10 });   // a frame shows the preview
    store.ready('day2k');
    assert.equal(u.uDay.value.name, 'day2k');
    assert.equal(u.uDayPrev.value.name, 'dayPreview', 'the preview stays bound for the mix');
    assert.equal(sharpen.x, 0);
    const before = invalidations();
    earth.update({ timeS: 10.1 });   // the tween starts on this frame
    assert.equal(sharpen.x, 0);
    earth.update({ timeS: 10.4 });
    assert.ok(sharpen.x > 0.5 && sharpen.x < 1, `halfway: ${sharpen.x}`);
    assert.ok(invalidations() > before, 'keeps frames coming while it runs');
    earth.update({ timeS: 10.8 });
    assert.equal(sharpen.x, 1);
    assert.equal(u.uSharpen.value, sharpen, 'the same Vector2 throughout');
    const settled = invalidations();
    earth.update({ timeS: 11 });
    assert.equal(invalidations(), settled, 'then idle again');
    assert.equal(sharpen.y, 1, 'the night map has not arrived: no mix');
    earth.dispose();
});

test('earth: no sharpen when the map beats the first frame, or with reduced motion', () => {
    for (const [label, opts, frameFirst] of [['before any frame', {}, false], ['reduced motion', { reducedMotion: true }, true]]) {
        const store = fakeStore();
        const { earth, u } = earthWith(store, opts);
        store.ready('dayPreview');
        if (frameFirst) earth.update({ timeS: 1 });
        store.ready('day2k');
        assert.equal(u.uDay.value.name, 'day2k', label);
        assert.equal(u.uSharpen.value.x, 1, `${label}: straight to the map`);
        earth.dispose();
    }
});

test('earth: a tier switch while the preview shows keeps it until the new map, and failures keep it', () => {
    const store = fakeStore();
    const { earth, u } = earthWith(store);
    store.ready('dayPreview');
    earth.update({ timeS: 1 });
    earth.setQuality('high');   // day4k now
    assert.equal(u.uDay.value.name, 'dayPreview');
    store.ready('day2k');       // the old tier's map: no longer wanted
    assert.equal(u.uDay.value.name, 'dayPreview');
    store.ready('day4k');
    assert.equal(u.uDay.value.name, 'day4k');
    assert.equal(u.uSharpen.value.x, 0, 'sharpens from the preview it showed');
    earth.dispose();
});
