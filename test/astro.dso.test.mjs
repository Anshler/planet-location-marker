// Deep-sky objects: data/dso.json (scripts/build-dso.mjs) and astro/dso.js (decoder, provider,
// visibility), checked against published catalogue positions and distances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDso, serializeDso } from '../scripts/build-dso.mjs';
import { decodeDso, createDsoProvider, dsoEffMag, dsoVisibility, sizeWords, DSO_TYPES, DSO_LABEL_EFF_MAG } from '../js/astro/dso.js';
import { createExtras } from '../js/astro/extras.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { sceneToRaDec } from '../js/astro/frames.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TEXT = read('data/dso.json');
const DOC = JSON.parse(TEXT);
const LIST = decodeDso(DOC);
const byId = new Map(LIST.map((d) => [d.id, d]));
const hms = (h, m, s) => 15 * (h + m / 60 + s / 3600);
const dms = (sign, d, m, s) => sign * (d + m / 60 + s / 3600);

test('reproducible: build-dso output from data/raw/messier.json equals the committed file', () => {
    assert.ok(serializeDso(buildDso(JSON.parse(read('data/raw/messier.json')))) === TEXT, 'data/dso.json is stale — run node scripts/build-dso.mjs');
});

test('140 objects: all 110 Messier objects and 30 showpieces, unique lower-case ids, known types', () => {
    assert.equal(LIST.length, 140);
    assert.equal(new Set(LIST.map((d) => d.id)).size, 140);
    for (let n = 1; n <= 110; n++) assert.ok(byId.has(`dso:m${n}`), `M${n}`);
    for (const id of ['lmc', 'smc', 'ngc5139', 'ngc104', 'ngc3372', 'ngc869', 'ngc884', 'cr399', 'ngc4755']) assert.ok(byId.has(`dso:${id}`), id);
    for (const d of LIST) {
        assert.ok(DSO_TYPES[d.type], `${d.id} type`);
        assert.ok(d.majArcmin >= d.minArcmin && d.minArcmin > 0, `${d.id} axes`);
        assert.ok(d.ly > 100 && d.ly < 1e8, `${d.id} distance`);
        assert.ok(Math.abs(Math.hypot(...d.dirS) - 1) < 1e-12);
    }
    assert.ok(TEXT.length < 16e3, `${TEXT.length} bytes (check-size budget 16 KB)`);
});

test('positions match published J2000 coordinates within 0.05°', () => {
    // SEDS / NED J2000 positions.
    const cases = [
        ['dso:m31', hms(0, 42, 44.3), dms(1, 41, 16, 9)],
        ['dso:m42', hms(5, 35, 17.3), dms(-1, 5, 23, 28)],
        ['dso:m13', hms(16, 41, 41.2), dms(1, 36, 27, 35)],
        ['dso:m57', hms(18, 53, 35.1), dms(1, 33, 1, 45)],
        ['dso:m1', hms(5, 34, 31.9), dms(1, 22, 0, 52)],
        ['dso:m45', hms(3, 47, 0), dms(1, 24, 7, 0)],
        ['dso:ngc5139', hms(13, 26, 47.3), dms(-1, 47, 28, 46)],
        ['dso:ngc104', hms(0, 24, 5.7), dms(-1, 72, 4, 53)],
        ['dso:lmc', hms(5, 23, 34.5), dms(-1, 69, 45, 22)],
    ];
    const off = [];
    for (const [id, ra, dec] of cases) {
        const d = byId.get(id);
        const rd = sceneToRaDec(d.dirS);
        const sep = Math.hypot((((rd.raDeg - ra + 540) % 360) - 180) * Math.cos(dec * Math.PI / 180), rd.decDeg - dec);
        if (!(sep < 0.05)) off.push(`${id}: ${sep.toFixed(3)}°`);
    }
    assert.deepEqual(off, []);
});

test('distances, sizes and names: catalogue facts', () => {
    const m31 = byId.get('dso:m31');
    assert.equal(m31.name, 'Andromeda Galaxy');
    assert.equal(m31.ly, 2500000);
    assert.deepEqual([m31.majArcmin, m31.minArcmin, m31.paDeg, m31.type], [190, 60, 35, 'sg']);
    assert.equal(byId.get('dso:m45').ly, 444);
    assert.equal(byId.get('dso:m42').name, 'Orion Nebula');
    assert.equal(byId.get('dso:m57').type, 'pn');
    assert.equal(byId.get('dso:m40').type, 'ast');
    assert.equal(byId.get('dso:lmc').type, 'ig');
    assert.equal(sizeWords(190, 60), '3.2° × 1.0°');
    assert.equal(sizeWords(28, 28), '28′');
    assert.equal(sizeWords(0.4, 0.3), '24″ × 18″');
});

test('visibility: an extended object counts fainter; the star ramp against the limit', () => {
    assert.ok(Math.abs(dsoEffMag(3.4, 190) - 5.22) < 0.01, 'M31');
    assert.ok(Math.abs(dsoEffMag(0.9, 645) - 3.15) < 0.01, 'LMC');
    assert.equal(dsoEffMag(8, 0.5), 8, 'a point-like object keeps its magnitude');
    assert.equal(dsoVisibility(5.2, 6.5), 1, 'M31 under a dark sky');
    assert.equal(dsoVisibility(5.2, 4.0), 0, 'M31 under a city sky');
    let prev = 1;
    for (let m = 4; m <= 8; m += 0.1) {
        const v = dsoVisibility(m, 6);
        assert.ok(v <= prev + 1e-12);
        prev = v;
    }
});

test('provider: registered ids, meta (deep-sky layer, labels for the naked-eye ones), fill and the card', () => {
    const p = createDsoProvider(LIST);
    const extras = createExtras();
    extras.register(p);
    assert.equal(extras.ids('dso').length, 140);
    const m = extras.meta('dso:m31');
    assert.equal(m.glyph, 'none');
    assert.equal(m.layer, 'deepSky');
    assert.equal(m.label, 'always', `M31 eff ${dsoEffMag(3.4, 190).toFixed(2)} ≤ ${DSO_LABEL_EFF_MAG}`);
    assert.equal(extras.meta('dso:m57').label, 'selected');
    assert.equal(m.skyOnly, true);
    const s = createSnapshot();
    computeSnapshot(Date.parse('2026-10-15T05:30:00Z'), { latDeg: 37, lonDeg: -118.2, elevM: 0 }, s, { detail: 'full' });
    extras.fill(s);
    const st = extras.state(s, 'dso:m31');
    assert.equal(st.present, true);
    assert.ok(st.altDeg > 60 && st.altDeg < 80, `M31 high in the evening: ${st.altDeg}`);
    assert.ok(Math.abs(st.lightTimeS / (365.25 * 86400) - 2.5e6) / 2.5e6 < 1e-3, 'light time = distance');
    assert.ok(st.data.fovDeg > 6 && st.data.fovDeg < 8, 'the telescope frames the whole galaxy');
    const card = extras.card('dso:m31', s);
    assert.equal(card.kindLabel, 'Spiral galaxy');
    assert.match(card.lines[0], /^The light you see left 2\.5 million years ago — when our ancestors made the first stone tools\.$/);
    assert.deepEqual(card.facts.find(([k]) => k === 'Distance'), ['Distance', '2.5 million light-years']);
    assert.ok(card.rts && card.rts.transitMs !== null, 'rise/transit/set from AE DefineStar');
    // Allocation-free refill.
    const data = st.data;
    extras.fill(s);
    assert.equal(extras.state(s, 'dso:m31').data, data);
});

test('decodeDso rejects anything but a v1 document', () => {
    assert.throws(() => decodeDso({ v: 2, fields: [], rows: [] }), TypeError);
    assert.throws(() => decodeDso(null), TypeError);
    assert.deepEqual(decodeDso({ v: 1, fields: DOC.fields, rows: [['BAD', 'x', 'sg', 0, 0, 0, 1, 1, 0, 1, '']] }), []);
});
