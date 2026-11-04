// data/sky.json format (SPEC §G) and its reproducibility from data/raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSky, serializeSky, buildStarInfo, serializeStarInfo, readRawInputs } from '../scripts/build-sky.mjs';

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

test('reproducible: build-sky output from data/raw equals the committed files (sky.json and starinfo.json)', () => {
    const raw = readRawInputs((f) => JSON.parse(read(`data/raw/${f}`)));
    const sky = buildSky(raw);
    assert.ok(serializeSky(sky) === TEXT, 'data/sky.json is stale — run node scripts/build-sky.mjs');
    assert.ok(serializeStarInfo(buildStarInfo(sky, raw.starnames, raw.hip2)) === read('data/starinfo.json'), 'data/starinfo.json is stale');
});

test('pm: the fast movers (≥ 100 mas/yr) in star order, with Arcturus, Sirius and α Centauri', () => {
    const pm = SKY.pm;
    assert.ok(pm.i.length > 1000 && pm.i.length < 1400, `${pm.i.length} movers`);
    assert.equal(pm.ra.length, pm.i.length);
    assert.equal(pm.de.length, pm.i.length);
    for (let k = 1; k < pm.i.length; k++) assert.ok(pm.i[k] > pm.i[k - 1]);
    const at = (hip) => pm.i.indexOf(SKY.stars.hip.indexOf(hip));
    for (const k of pm.i.keys()) assert.ok(Math.hypot(pm.ra[k], pm.de[k]) >= 99.5);
    // Hipparcos New Reduction (van Leeuwen 2007): Arcturus −1093.39 / −2000.06, α Cen A −3679.25 / +473.67 mas/yr.
    assert.deepEqual([pm.ra[at(69673)], pm.de[at(69673)]], [-1093, -2000]);
    assert.deepEqual([pm.ra[at(71683)], pm.de[at(71683)]], [-3679, 474]);
    assert.ok(at(32349) >= 0, 'Sirius moves');
    assert.equal(at(27989), -1, 'Betelgeuse (27.5 mas/yr) does not');
});

test('starinfo.json: parallax per star in sky.json order, and designations', () => {
    const info = JSON.parse(read('data/starinfo.json'));
    assert.equal(info.v, 1);
    assert.equal(info.n, SKY.stars.n);
    assert.equal(info.hip0, SKY.stars.hip[0]);
    const i = SKY.stars.hip.indexOf(27989);
    assert.equal(info.plx[i], 655, 'Betelgeuse 6.55 mas');
    assert.equal(info.eplx[i], 83);
    const row = info.names.find((r) => r[0] === i);
    assert.deepEqual(row.slice(1), ['Betelgeuse', 'α', '58', '', 'Ori']);
    assert.ok(info.names.length > 3000);
    assert.ok(info.names.every((r) => !String(r.slice(1)).includes('undefined')));
});

test('compact enough for the transfer budget', () => {
    assert.ok(TEXT.length < 200e3, `${TEXT.length} bytes`);
});
