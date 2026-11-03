// Label feed (js/app/labels-feed.js): body below-horizon flags that agree with the beams, daylight
// gating of star and constellation names, and sky-view label offsets that keep the label outside
// the body's disc and selection reticle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildAnchors, createLabelsFeed, labelBelow, gateStarName, gateConstellationName, bodyLabelOffsets,
} from '../js/app/labels-feed.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { exposureFor } from '../js/astro/photometry.js';
import { BODY_INDEX } from '../js/astro/bodies.js';
import { createHorizon } from '../js/geo/horizon.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PARIS = { latDeg: 48.85, lonDeg: 2.35, elevM: 0, tz: 'Europe/Paris', name: 'Paris', country: 'FR', source: 'url' };
const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, tz: 'Africa/Cairo', name: 'Luxor', country: 'EG', source: 'url' };
const ARCSEC = Math.PI / (180 * 3600);

function snapAt(iso, observer) {
    const s = createSnapshot();
    computeSnapshot(Date.parse(iso), observer, s, { detail: 'frame' });
    return s;
}

function state(over = {}) {
    return {
        observer: PARIS, selection: null, view: { mode: 'orbit', earthLock: false },
        layers: { labels: true, stars: true, starNames: true, constellationNames: true, horizon: true, trails: false },
        ...over,
    };
}

const CATALOG = {
    starNames: [
        { hip: 32349, name: 'Sirius', mag: -1.46, dirS: new Float64Array([0, 0, 1]) },
        { hip: 84012, name: 'Sabik', mag: 2.43, dirS: new Float64Array([0, 1, 0]) },
    ],
    cons: { list: [{ id: 'Ori', name: 'Orion', rank: 1, labelDirS: new Float64Array([1, 0, 0]) }] },
};

/** A camera looking anywhere: only `position` and `projectionMatrix.elements[5]` are read. */
function camera(fovDeg, pos = [0, 0, 3.4]) {
    const e = new Float64Array(16);
    e[5] = 1 / Math.tan((fovDeg * Math.PI) / 360);
    return { position: { x: pos[0], y: pos[1], z: pos[2] }, projectionMatrix: { elements: e } };
}

function feed(st, snap, catalog = CATALOG) {
    const sink = { list: [] };
    const store = { get: () => st, subscribe: () => () => {} };
    const f = createLabelsFeed({ labels: { setAnchors(l) { sink.list = l; } }, store, snap, getCatalog: () => catalog });
    return { f, sink, byId: (id) => sink.list.find((a) => a.id === id) };
}

// Paris, 2026-11-03 16:26 UTC: the Sun's centre is 0.66° under the geometric horizon, but
// refraction holds its upper limb up, so the snapshot (and the beam, and the Sky panel) say "up".
const SUNSET = snapAt('2026-11-03T16:26:00Z', PARIS);

test('the sunset fixture: the Sun is "above" (refracted, upper limb) while geometrically below', () => {
    const sun = SUNSET.bodies[BODY_INDEX.sun];
    assert.equal(sun.above, true);
    assert.ok(sun.altGeomDeg < -0.3 && sun.altGeomDeg > -1, `altGeom ${sun.altGeomDeg}`);
});

/** A landscape profile with a flat silhouette of `deg` everywhere (enabled). */
function flatHills(deg) {
    const h = createHorizon();
    h.alt.fill(deg);
    h.enabled = true;
    return h;
}

test('labelBelow: both views follow the refraction-aware above (sky view draws bodies refracted)', () => {
    const sun = SUNSET.bodies[BODY_INDEX.sun];
    assert.equal(labelBelow(sun, false), false, 'orbit: the beam is solid, so the label is not "below"');
    assert.equal(labelBelow(sun, true), false, 'sky: the refracted disc still touches the horizon');
    assert.equal(labelBelow({ altGeomDeg: -2 }, false), true, 'no above flag: geometric fallback');
    assert.equal(labelBelow({ altGeomDeg: NaN }, true), true, 'NaN-safe');
    assert.equal(labelBelow(null, false), true);
});

test('labelBelow: with the landscape on, sky view tests the apparent upper limb against the silhouette', () => {
    const sun = SUNSET.bodies[BODY_INDEX.sun];
    const upper = sun.altDeg + sun.angDiamArcsec / 7200;
    assert.ok(upper > 0 && upper < 0.3, `upper limb ${upper}°`);
    assert.equal(labelBelow(sun, true, flatHills(upper + 0.05)), true, 'behind the hills');
    assert.equal(labelBelow(sun, true, flatHills(upper - 0.05)), false, 'just above them');
    assert.equal(labelBelow(sun, false, flatHills(5)), false, 'orbit view ignores the landscape');
    const off = flatHills(5);
    off.enabled = false;
    assert.equal(labelBelow(sun, true, off), false, 'layer off: the mathematical horizon');
    // A planet has no semi-diameter allowance.
    const jup = { id: 'jupiter', above: true, altDeg: 0.4, azDeg: 100, angDiamArcsec: 40 };
    assert.equal(labelBelow(jup, true, flatHills(0.39)), false);
    assert.equal(labelBelow(jup, true, flatHills(0.41)), true);
});

test('buildAnchors and the per-frame sync agree with the beams in orbit view and with the drawing in sky view', () => {
    assert.equal(buildAnchors(state(), SUNSET, null, null, { mode: 'orbit' }).find((a) => a.id === 'sun').below, false);
    assert.equal(buildAnchors(state(), SUNSET, null, null, { mode: 'sky' }).find((a) => a.id === 'sun').below, false);
    const { f, byId } = feed(state(), SUNSET);
    f.sync(camera(50), 'orbit', { starExposure: 1, magLimit: 6, viewportH: 900 });
    assert.equal(byId('sun').below, false);
    assert.equal(byId('mercury').below, !SUNSET.bodies[BODY_INDEX.mercury].above);
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: 0.5, magLimit: 6, viewportH: 900 });
    assert.equal(byId('sun').below, false, 'sky view: refracted, on the horizon');
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: 0.5, magLimit: 6, viewportH: 900, horizon: flatHills(1) });
    assert.equal(byId('sun').below, true, 'sky view with the landscape: behind a 1° ridge');
});

test('star names follow their own star: gone by day, back one by one at dusk, with hysteresis', () => {
    const sirius = { mag: -1.46 }, sabik = { mag: 2.43 };
    gateStarName(sirius, 0, 6);
    gateStarName(sabik, 0, 6);
    assert.equal(sirius.hidden, true, 'no stars in daylight, no names');
    assert.equal(sabik.hidden, true);
    gateStarName(sirius, 0.05, 6);
    gateStarName(sabik, 0.05, 6);
    assert.equal(sirius.hidden, false, 'Sirius is out early in twilight');
    assert.equal(sabik.hidden, true, 'a mag-2.4 star is not');
    gateStarName(sabik, 1, 6);
    assert.equal(sabik.hidden, false);
    assert.equal(sabik.faint, false);
    // Hysteresis: between HIDE and SHOW the previous state holds.
    const e = findExposure(2.43, 6, 0.12);
    const shown = { mag: 2.43, hidden: false }, hidden = { mag: 2.43, hidden: true };
    gateStarName(shown, e, 6);
    gateStarName(hidden, e, 6);
    assert.equal(shown.hidden, false, 'a shown name stays until its star is nearly gone');
    assert.equal(hidden.hidden, true, 'a hidden name waits until its star is clearly drawn');
    assert.equal(shown.faint, true, 'and is dimmed meanwhile');
});

/** Star exposure at which a star of magnitude `mag` is drawn at visibility ≈ v (bisection). */
function findExposure(mag, lim, v) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        const l = -1 + (lim + 1) * Math.sqrt(mid);
        const t = Math.min(1, Math.max(0, (mag - (l + 0.35)) / -0.8));
        const vis = t * t * (3 - 2 * t) * Math.min(1, mid / 0.04) ** 2 * (3 - 2 * Math.min(1, mid / 0.04));
        if (vis < v) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

test('constellation names need a darker sky, with hysteresis', () => {
    const c = {};
    gateConstellationName(c, 0);
    assert.equal(c.hidden, true);
    gateConstellationName(c, 0.3);
    assert.equal(c.hidden, true, 'hidden until clearly dark');
    gateConstellationName(c, 0.4);
    assert.equal(c.hidden, false);
    assert.equal(c.faint, true);
    gateConstellationName(c, 0.3);
    assert.equal(c.hidden, false, 'shown until clearly light');
    gateConstellationName(c, 1);
    assert.equal(c.faint, false);
});

test('the feed gates names per frame from the star exposure, without rebuilding', () => {
    const noon = snapAt('2026-11-03T11:30:00Z', PARIS);
    const { f, sink, byId } = feed(state({ view: { mode: 'sky', earthLock: false } }), noon);
    const ex = exposureFor(noon.observer.sunAltDeg, 1);
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: ex.stars, magLimit: 6, viewportH: 900 });
    const list = sink.list;
    assert.equal(byId('star:32349').hidden, true, 'Sirius by day');
    assert.equal(byId('con:Ori').hidden, true, 'Orion by day');
    assert.equal(byId('sun').hidden, undefined, 'bodies are never gated');
    // Totality: only the brightest stars come out in daytime (limit magnitude 2), so Sirius is named
    // but Sabik (2.4) and the constellation names stay hidden.
    const tot = exposureFor(noon.observer.sunAltDeg, 1, {}, 1, 6);
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: tot.stars, magLimit: 6, viewportH: 900 });
    assert.equal(sink.list, list, 'no rebuild');
    assert.equal(byId('star:32349').hidden, false);
    assert.equal(byId('star:84012').hidden, true);
    assert.equal(byId('con:Ori').hidden, true);
    // Orbit view: the stars are always drawn.
    f.sync(camera(50), 'orbit', { starExposure: 1, magLimit: 6, viewportH: 900 });
    assert.equal(byId('star:32349').hidden, false);
});

test('a rebuild keeps a hidden name hidden (no pop-in inside the hysteresis band)', () => {
    const st = state({ view: { mode: 'sky', earthLock: false } });
    const noon = snapAt('2026-11-03T11:30:00Z', PARIS);
    const { f, byId } = feed(st, noon);
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: 0, magLimit: 6, viewportH: 900 });
    assert.equal(byId('star:84012').hidden, true);
    f.markDirty();
    const e = findExposure(2.43, 6, 0.12);
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: e, magLimit: 6, viewportH: 900 });
    assert.equal(byId('star:84012').hidden, true);
});

/** Radial distance (CSS px) of a label offset from its anchor. */
const radius = (o) => Math.hypot(o[0], o[1]);

test('sky-view offsets: on the upper-right diagonal, at least the old 10 px, outside discs and reticles', () => {
    const offs = Array.from({ length: 9 }, () => new Float64Array(2));
    const pxPerRad = (0.5 * 900) / Math.tan((70 * Math.PI) / 360);
    bodyLabelOffsets(SUNSET, pxPerRad, -1, offs);
    for (const o of offs) {
        assert.ok(o[0] > 0 && o[1] < 0 && Math.abs(o[0] + o[1]) < 1e-9, `diagonal ${o}`);
        assert.ok(radius(o) >= 10 - 1e-9);
    }
    assert.ok(Math.abs(radius(offs[BODY_INDEX.mars]) - 10) < 1e-9, 'a small unselected planet keeps the old offset');
    // Selected planet: outside the 14-px reticle ring, clear of the dot and its 4-px selection ring.
    bodyLabelOffsets(SUNSET, pxPerRad, BODY_INDEX.jupiter, offs);
    assert.ok(Math.abs(radius(offs[BODY_INDEX.jupiter]) - (14 + 10)) < 1e-9);
    // Zoomed onto the Moon (FOV 5°): the label sits outside the lunar disc (and its reticle).
    const tele = (0.5 * 900) / Math.tan((5 * Math.PI) / 360);
    bodyLabelOffsets(SUNSET, tele, BODY_INDEX.moon, offs);
    const moonR = 0.5 * SUNSET.bodies[BODY_INDEX.moon].angDiamArcsec * ARCSEC * tele;
    assert.ok(moonR > 40, `Moon radius ${moonR} px`);
    assert.ok(radius(offs[BODY_INDEX.moon]) >= moonR + 7 + 10 - 1e-9);
    bodyLabelOffsets(SUNSET, tele, -1, offs);
    assert.ok(radius(offs[BODY_INDEX.moon]) >= moonR + 6 - 1e-9);
    assert.ok(radius(offs[BODY_INDEX.sun]) >= 0.5 * SUNSET.bodies[BODY_INDEX.sun].angDiamArcsec * ARCSEC * tele + 6 - 1e-9);
});

test('total solar eclipse (Luxor 2027-08-02): the Sun\'s label clears the larger Moon disc', () => {
    const snap = snapAt('2027-08-02T10:07:00Z', LUXOR);
    const sun = snap.bodies[BODY_INDEX.sun], moon = snap.bodies[BODY_INDEX.moon];
    assert.ok(moon.angDiamArcsec > sun.angDiamArcsec, 'the Moon is the larger disc');
    const tele = (0.5 * 900) / Math.tan((5 * Math.PI) / 360);
    const moonR = 0.5 * moon.angDiamArcsec * ARCSEC * tele;
    const offs = Array.from({ length: 9 }, () => new Float64Array(2));
    bodyLabelOffsets(snap, tele, -1, offs);
    assert.ok(radius(offs[BODY_INDEX.sun]) >= moonR + 6 - 1e-9, 'not inside the Moon');
    bodyLabelOffsets(snap, tele, BODY_INDEX.sun, offs);
    assert.ok(radius(offs[BODY_INDEX.sun]) >= moonR + 7 + 10 - 1e-9, 'outside the reticle that frames the Moon');
});

test('the feed writes live sky-view offsets into its body anchors (no rebuild, no new arrays)', () => {
    const { f, sink, byId } = feed(state({ view: { mode: 'sky', earthLock: false }, selection: 'moon' }), SUNSET);
    f.sync(camera(70, [0.66, 0.75, 0.05]), 'sky', { starExposure: 1, magLimit: 6, viewportH: 900 });
    const list = sink.list;
    const off = byId('moon').offsetPx;
    const r70 = radius(off);
    assert.ok(Math.abs(r70 - 24) < 1e-9, `selected at FOV 70°: just outside the 14-px reticle (${r70})`);
    f.sync(camera(5, [0.66, 0.75, 0.05]), 'sky', { starExposure: 1, magLimit: 6, viewportH: 900 });
    assert.equal(sink.list, list, 'no rebuild');
    assert.equal(byId('moon').offsetPx, off, 'same array');
    assert.ok(radius(off) > 2.5 * r70, `zoomed in: ${radius(off)} vs ${r70}`);
    // Orbit view: body labels sit on their beams with no offset (the beams module de-overlaps them).
    f.sync(camera(50), 'orbit', { starExposure: 1, magLimit: 6, viewportH: 900 });
    assert.equal(byId('moon').offsetPx, undefined);
});

test('mirrored constants match render/bodies.js and the star shader', () => {
    const bodies = read('js/render/bodies.js');
    const feedSrc = read('js/app/labels-feed.js');
    for (const name of ['RETICLE_PX', 'RETICLE_GAP_PX']) {
        const re = new RegExp(`const ${name} = (\\d+(?:\\.\\d+)?);`);
        assert.equal(feedSrc.match(re)?.[1], bodies.match(re)?.[1], name);
    }
    const glyph = /clamp\(3\.0 \+ \(1\.5 - mag\) \* 1\.4, 3, 12\)/;
    assert.match(bodies, glyph, 'bodies.js glyphSizePx');
    assert.match(feedSrc, glyph, 'labels-feed glyphSizePx');
    const shader = read('js/render/shaders/sky.glsl.js');
    assert.match(shader, /float lim = mix\(-1\.0, uMagLimit, sqrt\(e\)\);/);
    assert.match(shader, /smoothFall\(lim \+ 0\.35, lim - 0\.45, aMag\) \* smoothstep\(0\.0, 0\.04, e\)/);
    assert.match(read('js/render/sky.js'), /const starExp = exposure\.stars;/, 'sky.js draws with exposure.stars');
    assert.match(read('js/app/loop.js'), /labelView\.starExposure = exposure\.stars;/, 'labels gate on the same exposure');
});

test('medallions: orbit-view planet labels carry the medallion footprint and a magnified title; sky view does not', () => {
    const calls = [];
    const medallion = (id, sel) => {
        calls.push([id, sel]);
        return id === 'sun' || id === 'moon' ? null : [sel ? 40 : 26, sel ? 40 : 26, sel ? 40 : 26];
    };
    const orbit = buildAnchors(state({ selection: 'saturn' }), SUNSET, null, null, { mode: 'orbit', medallion });
    const sat = orbit.find((a) => a.id === 'saturn');
    assert.deepEqual(sat.med, [40, 40, 40]);
    assert.match(sat.title, /magnified/);
    assert.match(sat.ariaLabel, /magnified/);
    assert.deepEqual(orbit.find((a) => a.id === 'mars').med, [26, 26, 26]);
    assert.equal(orbit.find((a) => a.id === 'moon').med, undefined, 'no medallion for the Moon');
    assert.ok(calls.some(([id, sel]) => id === 'saturn' && sel === true));
    const sky = buildAnchors(state({ selection: 'saturn' }), SUNSET, null, null, { mode: 'sky', medallion });
    assert.ok(sky.every((a) => a.med === undefined));
    // A throwing provider never breaks the anchor list.
    const safe = buildAnchors(state(), SUNSET, null, null, { mode: 'orbit', medallion: () => { throw new Error('x'); } });
    assert.equal(safe.find((a) => a.id === 'mars').med, undefined);
});
