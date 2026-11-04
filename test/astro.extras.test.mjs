// The extra-object selection model (core/selection.js, astro/extras.js) and its consumers'
// pure parts (labels-feed anchors, actions.extraOf/selectionLook).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isExtraId, isSelectionId, parseSelectionId, normalizeSelectionId, EXTRA_KINDS } from '../js/core/selection.js';
import { createExtras, createExtraState, topocentricScene, extraAltAz, extraSky } from '../js/astro/extras.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { raDecToScene } from '../js/astro/frames.js';
import { AE } from '../js/astro/ae.js';
import { buildAnchors } from '../js/app/labels-feed.js';
import { extraOf, selectionLook } from '../js/app/actions.js';
import { DEFAULT_STATE } from '../js/core/store.js';
import { AU_ER } from '../js/astro/bodies.js';

const PARIS = { latDeg: 48.8566, lonDeg: 2.3522, elevM: 35 };

test('selection ids: the nine bodies and namespaced extras', () => {
    assert.deepEqual([...EXTRA_KINDS], ['star', 'dso', 'comet', 'craft', 'guest', 'sat']);
    for (const id of ['mars', 'sun', 'comet:halley', 'craft:voyager1', 'guest:sn1054', 'star:32349', 'dso:m31', 'dso:ngc7000']) {
        assert.ok(isSelectionId(id), id);
    }
    for (const id of ['', 'pluto', 'comet', 'comet:', 'Comet:halley', 'planet:x', 'comet:-x', 'comet:a b', 'craft:v1:x', null, 3]) {
        assert.ok(!isSelectionId(id), String(id));
    }
    assert.ok(isExtraId('comet:halley') && !isExtraId('mars'));
    assert.deepEqual(parseSelectionId('mars'), { kind: 'body', key: 'mars' });
    assert.deepEqual(parseSelectionId('craft:jwst'), { kind: 'craft', key: 'jwst' });
    assert.equal(parseSelectionId('nope'), null);
    assert.equal(normalizeSelectionId(' Comet:Halley '), 'comet:halley');
    assert.equal(normalizeSelectionId('none'), null);
    assert.equal(normalizeSelectionId('bogus:x'), undefined);
});

/** A provider with one fixed star and one that exists only after a date. */
function testProvider() {
    const dir = raDecToScene(83.633, 22.0145);   // the Crab
    return {
        kind: 'guest', kindLabel: 'Test',
        ids: () => ['guest:a', 'guest:b'],
        meta: (id) => ({ name: id === 'guest:a' ? 'A' : 'B', color: '#ffffff', glyph: 'star', label: id === 'guest:a' ? 'always' : 'selected', layer: 'stars' }),
        fill(snap, id, out) {
            out.present = id === 'guest:a' || snap.tMs > Date.UTC(2000, 0, 1);
            out.mag = 1;
            out.distAU = NaN;
            out.dirS.set(dir);
        },
        card: (id, st) => ({ kindLabel: 'Test', lines: [`${id} at ${st.altDeg.toFixed(1)}`] }),
    };
}

test('registry: register, fill per snapshot, state by id, card, onChange, unregister', () => {
    const reg = createExtras();
    let changes = 0;
    reg.onChange(() => { changes++; });
    const off = reg.register(testProvider());
    assert.equal(changes, 1);
    assert.deepEqual(reg.ids(), ['guest:a', 'guest:b']);
    assert.ok(reg.has('guest:a') && !reg.has('guest:zz'));
    assert.equal(reg.meta('guest:a').kindLabel, 'Test');
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(1999, 0, 1, 22), PARIS, snap, { detail: 'full' });
    reg.fill(snap);
    const a = reg.state(snap, 'guest:a');
    const b = reg.state(snap, 'guest:b');
    assert.ok(a.present && !b.present);
    assert.equal(snap.extras.length, 2);
    // Refilling reuses the same state objects (no allocation per frame).
    computeSnapshot(Date.UTC(2001, 0, 1, 22), PARIS, snap, { detail: 'full' });
    reg.fill(snap);
    assert.equal(reg.state(snap, 'guest:a'), a);
    assert.ok(reg.state(snap, 'guest:b').present);
    assert.match(reg.card('guest:a', snap).lines[0], /^guest:a at /);
    off();
    assert.equal(changes, 2);
    assert.deepEqual(reg.ids(), []);
    assert.equal(reg.state(snap, 'guest:a'), null);
});

test('alt/az of an extra object agree with Astronomy Engine (a fixed J2000 star)', () => {
    const reg = createExtras();
    reg.register(testProvider());
    const snap = createSnapshot();
    const t = Date.UTC(2026, 10, 4, 23, 30);
    computeSnapshot(t, PARIS, snap, { detail: 'full' });
    reg.fill(snap);
    const st = reg.state(snap, 'guest:a');
    AE.DefineStar(AE.Body.Star7, 83.633 / 15, 22.0145, 6500);
    const time = AE.MakeTime(new Date(t));
    const obs = new AE.Observer(PARIS.latDeg, PARIS.lonDeg, PARIS.elevM);
    const eq = AE.Equator(AE.Body.Star7, time, obs, true, true);
    const hor = AE.Horizon(time, obs, eq.ra, eq.dec, 'normal');
    // The drawn direction is astrometric J2000 against the of-date horizon frame, like the bodies'
    // (≈ aberration, 20″, apart from AE's apparent place).
    assert.ok(Math.abs(st.altDeg - hor.altitude) < 0.02, `${st.altDeg} vs ${hor.altitude}`);
    assert.ok(Math.abs(st.azDeg - hor.azimuth) < 0.03, `${st.azDeg} vs ${hor.azimuth}`);
    assert.equal(st.above, hor.altitude > 0);
    const sky = extraSky(st);
    assert.equal(sky.constellation.name, 'Taurus');
    assert.ok(Math.abs(sky.raH - 83.633 / 15) < 1e-3 && Math.abs(sky.decDeg - 22.0145) < 1e-3);
});

test('topocentric direction takes off the observer’s place (parallax of a near object)', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(2026, 0, 1), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap, { detail: 'frame' });
    const up = snap.observer.upS;
    // An object 0.01 AU straight up: the distance shrinks by one Earth radius.
    const out = new Float64Array(3);
    const d = topocentricScene(up[0] * 0.01, up[1] * 0.01, up[2] * 0.01, snap, out);
    assert.ok(Math.abs(d - (0.01 - 1 / AU_ER)) < 1e-12);
    const st = createExtraState('craft:x', 'craft');
    st.dirS.set(out);
    st.distAU = d;
    extraAltAz(snap, st);
    assert.ok(st.altGeomDeg > 89.999);
    assert.ok(Math.abs(st.lightTimeS - d * 499.004784) < 1e-9);
});

test('labels: extra objects get anchors (always / only when selected), gated by presence and layer', () => {
    const reg = createExtras();
    reg.register(testProvider());
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(1999, 0, 1, 22), PARIS, snap, { detail: 'full' });
    reg.fill(snap);
    const state = { ...DEFAULT_STATE, view: { ...DEFAULT_STATE.view, mode: 'sky' } };
    let list = buildAnchors(state, snap, null, null, { extras: reg });
    const a = list.find((x) => x.id === 'guest:a');
    assert.ok(a && a.extra && a.interactive && a.kind === 'body');
    assert.equal(a.dirS, reg.state(snap, 'guest:a').dirS, 'live vector, not a copy');
    assert.equal(a.gate(), true);
    assert.ok(!list.some((x) => x.id === 'guest:b'), "'selected' label hidden while not selected");
    list = buildAnchors({ ...state, selection: 'guest:b' }, snap, null, null, { extras: reg });
    const b = list.find((x) => x.id === 'guest:b');
    assert.ok(b && b.selected && b.priority === 100);
    assert.equal(b.gate(), false, 'not present before 2000: hidden');
    list = buildAnchors({ ...state, layers: { ...state.layers, stars: false } }, snap, null, null, { extras: reg });
    assert.ok(!list.some((x) => x.id === 'guest:a'), 'its layer is off');
    // A snapshot the registry has not filled yet: pending, so the feed rebuilds next frame.
    const fresh = createSnapshot();
    computeSnapshot(Date.UTC(1999, 0, 1, 22), PARIS, fresh, { detail: 'full' });
    const opts = { extras: reg };
    buildAnchors(state, fresh, null, null, opts);
    assert.equal(opts.extrasPending, true);
});

test('actions: extraOf and the sky look at a selected extra', () => {
    const reg = createExtras();
    reg.register(testProvider());
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(2026, 10, 4, 23, 30), PARIS, snap, { detail: 'full' });
    reg.fill(snap);
    assert.equal(extraOf(snap, 'guest:a'), reg.state(snap, 'guest:a'));
    assert.equal(extraOf(snap, 'guest:none'), null);
    const look = selectionLook('guest:a', snap);
    assert.ok(look && Math.abs(look.altDeg - reg.state(snap, 'guest:a').altDeg) < 1e-9);
});
