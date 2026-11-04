// The angle ruler (render/ruler.js) and the off-screen pointers (render/edge-chips.js) in Node:
// the ruler's reading, its ends following bodies, its fixed buffers; the chips' brightness gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODY_INDEX } from '../js/astro/bodies.js';
import { liftByRefraction } from '../js/astro/photometry.js';
import { vectorAngleDeg } from '../js/astro/sky-guide.js';

register('./helpers/three-hooks.mjs', import.meta.url);
await import('three');
const { createRuler } = await import('../js/render/ruler.js');
const { createEdgeChips, chipMagLimit } = await import('../js/render/edge-chips.js');

const LONDON = { latDeg: 51.5074, lonDeg: -0.1278, elevM: 0 };
const snapAt = (iso) => {
    const s = createSnapshot();
    computeSnapshot(Date.parse(iso), LONDON, s, { detail: 'frame' });
    return s;
};

test('ruler: two taps measure the drawn angle, a label sits on the arc, a third tap starts again', () => {
    const changes = [];
    const ruler = createRuler({ invalidate() {} }, { onChange: (r) => changes.push(r) });
    const s = snapAt('2026-12-01T04:00:00Z');
    ruler.apply(s);
    const jup = s.bodies[BODY_INDEX.jupiter], moon = s.bodies[BODY_INDEX.moon];
    ruler.tap({ kind: 'body', id: 'jupiter', name: 'Jupiter', dir: jup.dirS });
    assert.equal(ruler.reading().ends, 1);
    assert.deepEqual(ruler.anchors(), [], 'no label with one end');
    ruler.tap({ kind: 'body', id: 'moon', name: 'the Moon', dir: moon.dirS });
    const r = ruler.reading();
    const up = s.observer.upS, a = new Float64Array(3), b = new Float64Array(3);
    const want = vectorAngleDeg(liftByRefraction(jup.dirS, up, 1, a), liftByRefraction(moon.dirS, up, 1, b));
    assert.ok(Math.abs(r.deg - want) < 0.01, `${r.deg} vs ${want}`);
    assert.equal(r.text, '11.9° · about 1 fist');
    assert.deepEqual([r.from, r.to], ['Jupiter', 'the Moon']);
    const [label] = ruler.anchors();
    assert.equal(label.kind, 'ruler');
    assert.equal(label.text, r.text);
    // The label sits halfway along the arc.
    const half = vectorAngleDeg(label.dirS, jup.dirS);
    assert.ok(Math.abs(half - vectorAngleDeg(jup.dirS, moon.dirS) / 2) < 1e-6);
    assert.equal(changes.length, 2);
    // Two hours on: the ends follow the bodies (the Moon moves ~1° against Jupiter).
    const s2 = snapAt('2026-12-01T06:00:00Z');
    ruler.apply(s2);
    assert.ok(Math.abs(ruler.reading().deg - r.deg) > 0.3, 'followed the Moon');
    assert.equal(changes.length, 3, 'reading changed');
    // A third tap starts a new measure; clear() empties it.
    ruler.tap({ kind: 'point', dir: [1, 0, 0] });
    assert.equal(ruler.reading().ends, 1);
    assert.equal(ruler.reading().from, 'a point');
    ruler.clear();
    assert.equal(ruler.reading().ends, 0);
    ruler.dispose();
});

test('edge chips: brightness gate, and no DOM needed to build', () => {
    assert.equal(chipMagLimit(-30), 5.5);
    assert.equal(chipMagLimit(-8), 1.5);
    assert.equal(chipMagLimit(20), -3.5);
    const chips = createEdgeChips({ size: { w: 800, h: 600 } }, { root: null });
    assert.ok(chips.object3d);
    chips.update({ snap: null });
    assert.deepEqual(chips.stats(), { shown: 0 });
    chips.dispose();
});
