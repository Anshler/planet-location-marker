// Tests for js/app/capture.js (postcard and Save-image labels: reprojection, culling, declutter),
// js/app/expose.js (long-exposure presets) and loop.redraw (the capture's one-off draw).
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAnchor, projectLabels, labelText } from '../js/app/capture.js';
import {
    photoLayers, trailsLook, meanNoonMs, analemmaPlan, nextDarkMs, EXPOSE_HIDDEN_LAYERS, ANALEMMA_DAYS, DARK_SUN_DEG,
} from '../js/app/expose.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODY_INDEX } from '../js/astro/bodies.js';
import { DEFAULT_STATE, createStore } from '../js/core/store.js';
import { createClock } from '../js/core/clock.js';
import { createLoop } from '../js/app/loop.js';

const DAY = 864e5;

/** A camera at `pos` looking down −Z (no rotation), 90° field, square viewport (column-major). */
function view(pos, w = 400, h = 400) {
    const n = 0.1, f = 1000;
    const mv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -pos[0], -pos[1], -pos[2], 1];
    const pm = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0];
    return { mv, pm, pos, w, h };
}
const unit = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
const OUT = view([0, 0, -10]);          // looking away from the Earth
const AT_EARTH = view([0, 0, 10]);      // looking at it

test('projectAnchor: directions at infinity, behind the camera, hidden, gated', () => {
    const centre = projectAnchor({ kind: 'body', dirS: [0, 0, -1] }, OUT, {});
    assert.deepEqual(centre, { x: 200, y: 200 });
    const t = Math.tan(Math.PI / 8);
    const right = projectAnchor({ kind: 'star', dirS: unit(t, 0, -1) }, OUT, {});
    assert.ok(Math.abs(right.x - (t * 0.5 + 0.5) * 400) < 1e-9 && Math.abs(right.y - 200) < 1e-9);
    const up = projectAnchor({ kind: 'star', dirS: unit(0, t, -1), offsetPx: [7, -7] }, OUT, {});
    assert.ok(up.y < 200 - 7, 'screen y grows downward; the offset is in CSS px');
    assert.equal(projectAnchor({ kind: 'body', dirS: [0, 0, 1] }, OUT, {}), null, 'behind the camera');
    assert.equal(projectAnchor({ kind: 'body', dirS: [0, 0, -1], hidden: true }, OUT, {}), null);
    assert.equal(projectAnchor({ kind: 'body', dirS: [0, 0, -1], gate: () => false }, OUT, {}), null);
    assert.equal(projectAnchor({ kind: 'body', dirS: [NaN, 0, -1] }, OUT, {}), null);
    assert.equal(projectAnchor({ kind: 'body' }, OUT, {}), null, 'no position at all');
});

test('projectAnchor: the Earth hides directions and points behind it; the ground hides star names', () => {
    assert.equal(projectAnchor({ kind: 'body', dirS: [0, 0, -1] }, AT_EARTH, {}), null, 'a direction through the globe');
    assert.equal(projectAnchor({ kind: 'body', posS: [0, 0, -5] }, AT_EARTH, {}), null, 'a point behind the globe');
    assert.ok(projectAnchor({ kind: 'body', posS: [0, 2, 0] }, AT_EARTH, {}), 'a point beside it');
    assert.ok(projectAnchor({ kind: 'observer', posS: [0, 0, 1] }, AT_EARTH, {}), 'a surface point facing the camera');
    const below = unit(0, -0.3, -1);
    const o = { horizon: true, upS: [0, 1, 0] };
    assert.equal(projectAnchor({ kind: 'star', dirS: below }, OUT, o), null, 'star name under the horizon');
    assert.equal(projectAnchor({ kind: 'constellation', dirS: below }, OUT, o), null);
    assert.ok(projectAnchor({ kind: 'body', dirS: below }, OUT, o), 'bodies keep theirs (drawn as below)');
    assert.ok(projectAnchor({ kind: 'star', dirS: below }, OUT, {}), 'globe view: no horizon test');
});

test('projectLabels: priority declutter, cap, frame edges and the caption band', () => {
    const measure = () => 40;
    const a = (id, priority, d, extra = {}) => ({ id, text: id, kind: 'body', priority, dirS: d, ...extra });
    const c = [0, 0, -1];
    const near = unit(0.02, 0, -1);           // a few px to the right: overlaps the centre label
    const far = unit(-0.3, 0.2, -1);
    const anchors = [a('low', 50, c), a('high', 80, near), a('away', 20, far), a('sel', 10, unit(0.3, -0.2, -1), { selected: true })];
    const placed = projectLabels(anchors, OUT, {}, measure).map((p) => p.a.id);
    assert.deepEqual(placed, ['sel', 'high', 'away'], 'selected first, then priority; the overlapped one drops');
    assert.deepEqual(projectLabels(anchors, OUT, { cap: 2 }, measure).map((p) => p.a.id), ['sel', 'high']);
    // A label whose box would cross the right edge is dropped (no nudging in a capture).
    const edge = projectLabels([a('edge', 90, unit(0.95, 0, -1))], OUT, {}, measure);
    assert.equal(edge.length, 0);
    // The bottom 150 px are the postcard's band: the label at y ≈ 280 goes.
    const lowY = unit(0, -0.4, -1);
    assert.equal(projectLabels([a('low', 90, lowY)], OUT, {}, measure).length, 1);
    assert.equal(projectLabels([a('low', 90, lowY)], OUT, { insetBottom: 150 }, measure).length, 0);
    // Cardinal letters are centred on their point.
    const card = projectLabels([{ id: 'card:N', text: 'N', kind: 'cardinal', priority: 60, dirS: c }], OUT, {}, () => 10)[0];
    assert.ok(Math.abs((card.box[0] + card.box[2]) / 2 - 200) < 1e-9);
    assert.equal(labelText({ kind: 'constellation', text: 'Orion' }), 'ORION');
    assert.equal(labelText({ kind: 'star', text: 'Rigel' }), 'Rigel');
});

test('photoLayers hides the line art for the stack, without touching the input', () => {
    const l = { ...DEFAULT_STATE.layers, constellations: true, ecliptic: true, eqGrid: true, trails: true };
    const p = photoLayers(l);
    for (const k of EXPOSE_HIDDEN_LAYERS) if (k in l) assert.equal(p[k], false, k);
    assert.equal(p.stars, true);
    assert.equal(p.milkyWay, true);
    assert.equal(p.landscape, true);
    assert.equal(l.constellations, true, 'input untouched');
});

test('trailsLook faces the visible pole with the landscape in frame', () => {
    assert.deepEqual(trailsLook(48.85), { azDeg: 0, altDeg: 48.85 - 80 * 0.22, fovDeg: 80 });
    assert.equal(trailsLook(-24.6).azDeg, 180);
    assert.equal(trailsLook(-24.6).altDeg, 10, 'never below 10°');
    assert.equal(trailsLook(89, 20).altDeg, 75, 'never above 75°');
    assert.equal(trailsLook(NaN).azDeg, 0);
});

test('meanNoonMs: the observer’s mean solar noon on its solar day', () => {
    const t = Date.UTC(2026, 10, 4, 10, 0);
    assert.equal(meanNoonMs(t, 0), Date.UTC(2026, 10, 4, 12, 0));
    assert.equal(meanNoonMs(t, 90), Date.UTC(2026, 10, 4, 6, 0));
    assert.equal(meanNoonMs(t, -165), Date.UTC(2026, 10, 3, 23, 0), '10:00 UTC is still the 3rd at 165° W');
    assert.equal(meanNoonMs(t, 2.35), Date.UTC(2026, 10, 4, 11, 51), 'whole minutes');
});

test('analemmaPlan: a year of daily steps at mean noon, framed on the figure-8', () => {
    const paris = { latDeg: 48.85, lonDeg: 2.35, elevM: 35 };
    const scratch = createSnapshot();
    const plan = analemmaPlan(Date.UTC(2026, 10, 4, 10), paris, scratch);
    assert.equal(plan.range.strideMs, DAY);
    assert.equal(plan.range.loop, 'once');
    assert.equal((plan.range.toMs - plan.range.fromMs) / DAY, ANALEMMA_DAYS - 1);
    assert.ok(Math.abs(plan.look.azDeg - 180) < 3, `faces south (${plan.look.azDeg})`);
    // Every noon Sun is inside the vertical field, and the horizon (−4°) is too.
    const half = plan.look.fovDeg / 2;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < ANALEMMA_DAYS; k += 7) {
        computeSnapshot(plan.range.fromMs + k * DAY, paris, scratch, { detail: 'frame' });
        const alt = scratch.bodies[BODY_INDEX.sun].altDeg;
        lo = Math.min(lo, alt);
        hi = Math.max(hi, alt);
    }
    assert.ok(lo > 15 && lo < 20 && hi > 63 && hi < 67, `winter ${lo}°, summer ${hi}°`);
    assert.ok(plan.look.altDeg - half <= -4 && plan.look.altDeg + half >= hi + 5, JSON.stringify(plan.look));
});

test('nextDarkMs: now when dark, tonight when not, null in polar summer', () => {
    const paris = { latDeg: 48.85, lonDeg: 2.35, elevM: 35 };
    const s = createSnapshot();
    const night = Date.UTC(2026, 10, 4, 22);
    assert.equal(nextDarkMs(night, paris, s), night);
    const noon = Date.UTC(2026, 10, 4, 12);
    const dark = nextDarkMs(noon, paris, s);
    assert.ok(dark > noon && dark - noon < 8 * 36e5, new Date(dark).toISOString());
    computeSnapshot(dark, paris, s, { detail: 'frame' });
    assert.ok(s.observer.sunAltDeg < DARK_SUN_DEG);
    computeSnapshot(dark - 10 * 6e4, paris, s, { detail: 'frame' });
    assert.ok(s.observer.sunAltDeg >= DARK_SUN_DEG, 'the first such moment (10-min steps)');
    assert.equal(nextDarkMs(Date.UTC(2026, 5, 21, 12), { latDeg: 78.2, lonDeg: 15.6, elevM: 0 }, s), null);
});

test('loop.redraw draws one frame now: module updates, label-feed sync, render', () => {
    const calls = [];
    const store = createStore({ status: { phase: 'ready', reducedMotion: false, introPlaying: false } });
    const clock = createClock({ tMs: Date.UTC(2026, 10, 4, 22), playing: false });
    const win = { requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} };
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    const headless = createLoop({ clock, store, bus: { emit() {} }, win, doc });
    assert.equal(headless.redraw(), false, 'nothing to draw without a render stack');
    const rc = { renderer: null, camera: { id: 'rc' }, size: { w: 640, h: 360 }, render() { calls.push('render'); } };
    const rig = { mode: 'sky', skyBlend: 1, tweening: false, camera: { id: 'rig', fov: 60 }, update() { return false; } };
    const mod = { object3d: {}, update(fi) { calls.push(`update:${fi.camera.id}:${fi.dtMs}`); } };
    const labels = { update() { calls.push('labels'); } };
    const labelsFeed = { sync(cam, mode, v) { calls.push(`sync:${cam.id}:${mode}:${v.viewportH}`); } };
    const loop = createLoop({ clock, store, bus: { emit() {} }, win, doc, rc, rig, modules: [mod], labels, labelsFeed, getTierCfg: () => ({}) });
    assert.equal(loop.redraw(), true);
    assert.deepEqual(calls, ['update:rig:0', 'sync:rig:orbit:360', 'render'], 'no DOM label update');
    assert.ok(loop.labelOptions && 'cap' in loop.labelOptions);
    loop.setRenderPaused(true);
    assert.equal(loop.redraw(), false, 'not while the context is lost');
    loop.dispose();
    headless.dispose();
});
