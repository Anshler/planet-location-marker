// The long exposure's controller (render/long-exposure.js) in Node: what restarts the stack. A
// frame that only moves sim time keeps it; a new framing (the rig's view, the size, or the view
// offset that follows the UI panels) starts a fresh one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/three-hooks.mjs', import.meta.url);
await import('three');
const { createLongExposure } = await import('../js/render/long-exposure.js');

function harness() {
    const pass = { resets: 0, frames: 0, fresh: true, frozen: false, add: true, brightOnly: false, reset() { this.resets++; } };
    const rc = {
        dpr: 1, size: { w: 1440, h: 900 }, tier: { name: 'high' }, accum: pass,
        setAccumulation: () => true,
    };
    const view = { azDeg: 180, altDeg: 40, fovDeg: 60 };
    const rig = { tracking: 'none', tweening: false, dragging: false, getView: () => view };
    const state = { layers: {}, observer: {}, ui: { expose: 'trails' } };
    const store = { get: () => state };
    const camera = { view: null };
    const fi = { viewMode: 'sky', skyBlend: 1, camera, snap: { tMs: 0, observer: { sunAltDeg: -20 } } };
    const mod = createLongExposure(rc, { rig, store, clock: null });
    const frame = () => {
        fi.snap.tMs += 1000;
        mod.update(fi);
    };
    return { mod, pass, rc, camera, view, frame };
}

test('sim time alone keeps the stack; a new look restarts it', () => {
    const h = harness();
    h.frame();
    const r0 = h.pass.resets;
    for (let i = 0; i < 5; i++) h.frame();
    assert.equal(h.pass.resets, r0, 'no reset while only time runs');
    h.view.azDeg = 181;
    h.frame();
    assert.equal(h.pass.resets, r0 + 1, 'the look moved');
});

test('the view offset (UI insets) is part of the framing', () => {
    const h = harness();
    h.camera.view = { enabled: true, offsetX: 198, offsetY: -40 };
    h.frame();
    const r0 = h.pass.resets;
    h.frame();
    assert.equal(h.pass.resets, r0, 'the same offset keeps the stack');
    // The side panel collapses: the view centre moves, the projected sky shifts.
    h.camera.view = { enabled: true, offsetX: 37, offsetY: -40 };
    h.frame();
    assert.equal(h.pass.resets, r0 + 1, 'a new offset restarts the stack');
    h.camera.view.enabled = false;
    h.frame();
    assert.equal(h.pass.resets, r0 + 2, 'the offset cleared restarts it too');
    h.frame();
    assert.equal(h.pass.resets, r0 + 2);
});
