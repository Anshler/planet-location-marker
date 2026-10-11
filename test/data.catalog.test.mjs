// js/data/catalog.js against the real data/sky.json (SPEC §H, G3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeSky, emptyCatalog, starCountForMag, starIndexByHip, DEFAULT_MAG_LIMIT } from '../js/data/catalog.js';
import { sceneToRaDec } from '../js/astro/frames.js';

const SKY = JSON.parse(fs.readFileSync(new URL('../data/sky.json', import.meta.url), 'utf8'));
const cat = decodeSky(SKY);

/** Independent inverse of SPEC §D.2 (α = atan2(−z, x), δ = asin(y)), to localise failures. */
function invD2(x, y, z) {
    let ra = Math.atan2(-z, x) * 180 / Math.PI;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI };
}

const starDir = (hip) => {
    const i = starIndexByHip(cat.stars, hip);
    assert.ok(i >= 0, `HIP ${hip} present`);
    return [cat.stars.dirS[3 * i], cat.stars.dirS[3 * i + 1], cat.stars.dirS[3 * i + 2]];
};

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('star count and arrays', () => {
    const s = cat.stars;
    assert.ok(s.count >= 5044, `count ${s.count}`);
    assert.equal(s.dirS.length, 3 * s.count);
    assert.equal(s.color.length, 3 * s.count);
    assert.equal(s.mag.length, s.count);
    assert.equal(s.hip.length, s.count);
    assert.ok(s.dirS instanceof Float32Array && s.color instanceof Float32Array && s.mag instanceof Float32Array);
    assert.ok(s.hip instanceof Int32Array);
    assert.equal(cat.magLimit, DEFAULT_MAG_LIMIT);
});

test('Sirius and Betelgeuse positions (SPEC D.5)', () => {
    for (const [hip, ra, dec] of [[32349, 101.287, -16.716], [27989, 88.793, 7.407]]) {
        const v = starDir(hip);
        const g1 = sceneToRaDec(v);
        assert.ok(angDiff(g1.raDeg, ra) <= 0.001, `HIP ${hip} RA ${g1.raDeg}`);
        assert.ok(Math.abs(g1.decDeg - dec) <= 0.001, `HIP ${hip} Dec ${g1.decDeg}`);
        const ind = invD2(...v);
        assert.ok(angDiff(ind.raDeg, ra) <= 0.001 && Math.abs(ind.decDeg - dec) <= 0.001, `HIP ${hip} independent inverse`);
    }
});

test('Sirius is the brightest star and comes first', () => {
    assert.equal(cat.stars.hip[0], 32349);
    assert.ok(Math.abs(cat.stars.mag[0] - -1.44) < 1e-6);
});

test('magnitudes in [-1.5, 6.6] and sorted brightest first', () => {
    const m = cat.stars.mag;
    for (let i = 0; i < m.length; i++) {
        assert.ok(m[i] >= -1.5 && m[i] <= 6.6, `mag[${i}] = ${m[i]}`);
        if (i) assert.ok(m[i] >= m[i - 1], `sorted at ${i}`);
    }
});

test('directions are unit vectors; colours are linear RGB with max component 1', () => {
    const { dirS, color, count } = cat.stars;
    for (let i = 0; i < count; i++) {
        const len = Math.hypot(dirS[3 * i], dirS[3 * i + 1], dirS[3 * i + 2]);
        assert.ok(Math.abs(len - 1) < 1e-6, `|dir ${i}| = ${len}`);
        const r = color[3 * i], g = color[3 * i + 1], b = color[3 * i + 2];
        assert.ok(r >= 0 && g >= 0 && b >= 0 && Math.abs(Math.max(r, g, b) - 1) < 1e-5, `colour ${i}: ${r},${g},${b}`);
    }
});

test('B−V colours: Betelgeuse is red-dominant, Rigel is blue-dominant', () => {
    const col = (hip) => {
        const i = starIndexByHip(cat.stars, hip);
        return [cat.stars.color[3 * i], cat.stars.color[3 * i + 1], cat.stars.color[3 * i + 2]];
    };
    const [br, , bb] = col(27989);
    const [rr, , rb] = col(24436);
    assert.ok(br > bb, 'Betelgeuse r > b');
    assert.ok(rb > rr, 'Rigel b > r');
});

test('88 or 89 constellations with unique ids; Serpens split into two halves', () => {
    const list = cat.cons.list;
    assert.ok(list.length === 88 || list.length === 89, `got ${list.length}`);
    assert.equal(new Set(list.map((c) => c.id)).size, list.length, 'ids unique');
    const ser = list.filter((c) => c.iau === 'Ser');
    assert.ok(ser.length >= 1);
    if (list.length === 89) assert.deepEqual(ser.map((c) => c.id).sort(), ['Ser1', 'Ser2']);
    const ori = list.find((c) => c.id === 'Ori');
    assert.equal(ori.name, 'Orion');
    assert.equal(ori.rank, 1);
    const lab = invD2(...ori.labelDirS);
    assert.ok(angDiff(lab.raDeg, 84) < 6 && Math.abs(lab.decDeg - 5) < 12, `Orion label at ${lab.raDeg}, ${lab.decDeg}`);
    for (const c of list) {
        assert.ok(c.rank >= 1 && c.rank <= 3, `${c.id} rank`);
        assert.ok(Math.abs(Math.hypot(...c.labelDirS) - 1) < 1e-9, `${c.id} label is a unit vector`);
        assert.ok(c.segCount > 0, `${c.id} has a figure`);
    }
});

test('segment indices within range and contiguous per constellation', () => {
    const { segments, segCon, list } = cat.cons;
    const segs = segCon.length;
    assert.ok(segs > 600, `segments ${segs}`);
    assert.equal(segments.length, 6 * segs);
    assert.ok(segCon instanceof Uint16Array && segments instanceof Float32Array);
    for (let i = 0; i < segs; i++) {
        assert.ok(segCon[i] < list.length, `segCon[${i}]`);
        const a = Math.hypot(segments[6 * i], segments[6 * i + 1], segments[6 * i + 2]);
        const b = Math.hypot(segments[6 * i + 3], segments[6 * i + 4], segments[6 * i + 5]);
        assert.ok(Math.abs(a - 1) < 1e-6 && Math.abs(b - 1) < 1e-6, `segment ${i} endpoints are unit vectors`);
        const dot = segments[6 * i] * segments[6 * i + 3] + segments[6 * i + 1] * segments[6 * i + 4] + segments[6 * i + 2] * segments[6 * i + 5];
        assert.ok(dot > Math.cos(60 * Math.PI / 180), `segment ${i} spans < 60°`);
    }
    let expectStart = 0;
    list.forEach((c, k) => {
        assert.equal(c.segStart, expectStart, `${c.id} segStart`);
        for (let s = c.segStart; s < c.segStart + c.segCount; s++) assert.equal(segCon[s], k);
        expectStart += c.segCount;
    });
    assert.equal(expectStart, segs);
});

test('star names: bright named stars with matching directions', () => {
    const names = cat.starNames;
    assert.ok(names.length >= 100, `names ${names.length}`);
    const sirius = names.find((n) => n.name === 'Sirius');
    assert.ok(sirius, 'Sirius named');
    assert.equal(sirius.hip, 32349);
    assert.equal(sirius.con, 'CMa');
    assert.deepEqual(sirius.dirS, starDir(32349));
    assert.ok(names.find((n) => n.name === 'Betelgeuse' && n.con === 'Ori'));
    assert.ok(names.find((n) => n.name === 'Polaris' && n.con === 'UMi'));
    for (const n of names) assert.ok(n.mag <= 3.0 + 1e-6 && n.name.length > 0, `${n.name} mag ${n.mag}`);
});

test('magLimit filters stars, names and keeps order; starCountForMag matches', () => {
    const c5 = decodeSky(SKY, { magLimit: 5 });
    const expected = SKY.stars.mag.filter((m) => m / 100 <= 5).length;
    assert.equal(c5.stars.count, expected);
    assert.ok(c5.stars.mag.every((m) => m <= 5));
    assert.equal(starCountForMag(cat.stars, 5), expected);
    assert.equal(starCountForMag(cat.stars, -5), 0);
    assert.equal(starCountForMag(cat.stars, 99), cat.stars.count);
    const c2 = decodeSky(SKY, { magLimit: 1.0 });
    assert.ok(c2.starNames.every((n) => n.mag <= 1.0));
    assert.ok(c2.starNames.length > 5 && c2.starNames.length < cat.starNames.length);
    assert.equal(c2.cons.list.length, cat.cons.list.length, 'constellations do not depend on magLimit');
});

test('accepts JSON text; rejects invalid documents; empty catalog shape', () => {
    assert.equal(decodeSky(JSON.stringify(SKY)).stars.count, cat.stars.count);
    assert.throws(() => decodeSky(null), TypeError);
    assert.throws(() => decodeSky({ v: 2, stars: SKY.stars }), TypeError);
    assert.throws(() => decodeSky({ v: 1, stars: { n: 3, hip: [1], ra: [], dec: [], mag: [], bv: [] } }), TypeError);
    const e = emptyCatalog();
    assert.equal(e.stars.count, 0);
    assert.equal(e.stars.dirS.length, 0);
    assert.equal(e.cons.segments.length, 0);
    assert.deepEqual(e.starNames, []);
    assert.deepEqual(e.cons.list, []);
});

test('unsorted input is re-sorted and stale name indices fall back to HIP lookup', () => {
    const doc = {
        v: 1,
        stars: { n: 3, hip: [10, 20, 30], ra: [0, 90000, 180000], dec: [0, 0, 45000], mag: [300, 100, 200], bv: [0, 600, 1500] },
        names: [[20, 'Two', 'Ori', 0], [30, 'Three', 'Cyg', 2]],
        cons: [{ id: 'Tst', name: 'Test', rank: 2, lines: [[0, 0, 9000, 0, 9000, 4500]] }],
    };
    const c = decodeSky(doc);
    assert.deepEqual(Array.from(c.stars.hip), [20, 30, 10]);
    assert.deepEqual(c.starNames.map((n) => n.name), ['Two', 'Three']);
    assert.ok(Math.abs(c.starNames[0].dirS[2] - -1) < 1e-6, 'RA 90° → scene −Z');
    assert.equal(c.cons.list[0].segCount, 2);
    assert.equal(c.cons.list[0].iau, 'Tst');
    assert.ok(Math.abs(Math.hypot(...c.cons.list[0].labelDirS) - 1) < 1e-9, 'centroid label fallback');
});
