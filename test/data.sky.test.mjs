// data/sky.json format (SPEC §G) and its reproducibility from data/raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSky, serializeSky } from '../scripts/build-sky.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TEXT = read('data/sky.json');
const SKY = JSON.parse(TEXT);

test('header', () => {
    assert.equal(SKY.v, 1);
    assert.equal(SKY.epoch, 'J2000');
    assert.match(SKY.source, /d3-celestial/);
});

test('stars: parallel integer arrays, Hipparcos ids unique, sorted brightest first', () => {
    const s = SKY.stars;
    assert.equal(s.n, 5044);
    for (const k of ['hip', 'ra', 'dec', 'mag', 'bv']) {
        assert.equal(s[k].length, s.n, k);
        assert.ok(s[k].every(Number.isInteger), `${k} integers`);
    }
    assert.equal(new Set(s.hip).size, s.n, 'unique HIP');
    assert.ok(s.hip.every((h) => h > 0));
    assert.ok(s.ra.every((r) => r >= 0 && r < 360000), 'ra in [0, 360000)');
    assert.ok(s.dec.every((d) => d >= -90000 && d <= 90000), 'dec in range');
    assert.ok(s.bv.every((b) => b >= -500 && b <= 3500), 'B−V plausible');
    for (let i = 1; i < s.n; i++) assert.ok(s.mag[i] >= s.mag[i - 1], `sorted at ${i}`);
    assert.equal(s.hip[0], 32349, 'Sirius first');
    assert.deepEqual([s.ra[0], s.dec[0], s.mag[0]], [101287, -16716, -144]);
});

test('names: bright named stars pointing at the right index', () => {
    assert.ok(SKY.names.length >= 100);
    let prev = -1;
    for (const [hip, name, con, idx] of SKY.names) {
        assert.equal(SKY.stars.hip[idx], hip, `${name} index`);
        assert.ok(SKY.stars.mag[idx] <= 300, `${name} mag ≤ 3`);
        assert.ok(typeof name === 'string' && name.trim() === name && name.length > 0);
        assert.match(con, /^[A-Z][A-Za-z]{2}$/, `${name} constellation`);
        assert.ok(idx > prev, 'names in star order');
        prev = idx;
    }
    const names = new Map(SKY.names.map(([, n, c]) => [n, c]));
    for (const [n, c] of [['Sirius', 'CMa'], ['Vega', 'Lyr'], ['Betelgeuse', 'Ori'], ['Polaris', 'UMi'], ['Antares', 'Sco']]) {
        assert.equal(names.get(n), c, n);
    }
});

test('constellations: 89 figures (Serpens in two halves), labels and polylines', () => {
    const cons = SKY.cons;
    assert.equal(cons.length, 89);
    assert.equal(new Set(cons.map((c) => c.id)).size, 89, 'ids unique');
    assert.deepEqual(cons.filter((c) => c.id.startsWith('Ser')).map((c) => [c.id, c.name]),
        [['Ser1', 'Serpens Caput'], ['Ser2', 'Serpens Cauda']]);
    let segs = 0;
    for (const c of cons) {
        assert.match(c.id, /^[A-Z][A-Za-z]{2}\d?$/, c.id);
        assert.ok([1, 2, 3].includes(c.rank), `${c.id} rank`);
        assert.ok(c.label[0] >= 0 && c.label[0] < 36000 && Math.abs(c.label[1]) <= 9000, `${c.id} label`);
        assert.ok(c.lines.length > 0, `${c.id} has lines`);
        for (const l of c.lines) {
            assert.ok(l.length >= 4 && l.length % 2 === 0, `${c.id} polyline`);
            for (let i = 0; i < l.length; i += 2) assert.ok(l[i] >= 0 && l[i] < 36000 && Math.abs(l[i + 1]) <= 9000);
            segs += l.length / 2 - 1;
        }
    }
    assert.equal(segs, 743);
});

test('reproducible: build-sky output from data/raw equals the committed file', () => {
    const raw = (f) => JSON.parse(read(`data/raw/${f}`));
    const rebuilt = serializeSky(buildSky({
        stars: raw('stars.6.json'),
        starnames: raw('starnames.json'),
        lines: raw('constellations.lines.json'),
        cons: raw('constellations.json'),
    }));
    assert.ok(rebuilt === TEXT, 'data/sky.json is stale — run node scripts/build-sky.mjs');
});

test('compact enough for the transfer budget', () => {
    assert.ok(TEXT.length < 200e3, `${TEXT.length} bytes`);
});
