// Humanity's emissaries (astro/craft.js, data/craft.json, scripts/build-craft.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeCraft, craftStateAt, hermite, radioTimeS, dsnInView, fmtRadioTime, createCraftProvider } from '../js/astro/craft.js';
import { adaptiveKnots, parseVectors } from '../scripts/build-craft.mjs';
import { createExtras } from '../js/astro/extras.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { AE } from '../js/astro/ae.js';

const JSON_DATA = JSON.parse(fs.readFileSync(new URL('../data/craft.json', import.meta.url), 'utf8'));
const CRAFT = decodeCraft(JSON_DATA);
const byId = (id) => CRAFT.find((c) => c.id === id);
const DEG = Math.PI / 180;

test('data/craft.json: four craft, ordered knots, compact', () => {
    assert.deepEqual(CRAFT.map((c) => c.id), ['craft:voyager1', 'craft:voyager2', 'craft:newhorizons', 'craft:jwst']);
    for (const c of CRAFT) {
        for (let i = 1; i < c.t.length; i++) assert.ok(c.t[i] > c.t[i - 1]);
    }
    assert.ok(fs.statSync(new URL('../data/craft.json', import.meta.url)).size < 48 * 1024);
    assert.match(JSON_DATA.source, /JPL Horizons/);
});

test('Hermite interpolation is exact for cubics; the knot picker keeps every sample within tolerance', () => {
    const f = (t) => 2 + 3 * t - t * t + 0.5 * t ** 3, df = (t) => 3 - 2 * t + 1.5 * t * t;
    for (const t of [1, 1.3, 2.2, 3]) assert.ok(Math.abs(hermite(1, f(1), df(1), 3, f(3), df(3), t) - f(t)) < 1e-12);
    // A circular orbit sampled daily: the knots reproduce it to 1e-6 AU.
    const n = 0.0172;
    const rows = Array.from({ length: 366 }, (_, i) => [i, Math.cos(n * i), Math.sin(n * i), 0, -n * Math.sin(n * i), n * Math.cos(n * i), 0]);
    const knots = adaptiveKnots(rows, () => 1e-6);
    assert.ok(knots.length > 2 && knots.length < 80, `${knots.length} knots`);
    for (let k = 1; k < knots.length; k++) {
        const A = rows[knots[k - 1]], B = rows[knots[k]];
        for (let i = knots[k - 1]; i <= knots[k]; i++) {
            const x = hermite(A[0], A[1], A[4], B[0], B[1], B[4], rows[i][0]);
            assert.ok(Math.abs(x - rows[i][1]) < 1.2e-6);
        }
    }
    assert.deepEqual(parseVectors('$$SOE\n2461345.5, A.D. x, 1, 2, 3, 4, 5, 6,\n$$EOE'), [[2461345.5, 1, 2, 3, 4, 5, 6]]);
});

// JPL Horizons, geocentric astrometric RA/Dec (deg) and Δ (AU) at UT instants (fetched 2026-11-04).
const HORIZONS = [
    ['craft:voyager1', '2026-11-04T00:00:00Z', 258.76189, 12.08862, 172.900104676],
    ['craft:voyager2', '1989-08-25T04:00:00Z', 280.74114, -22.15579, 29.580928665],
    ['craft:newhorizons', '2015-07-14T12:00:00Z', 284.81879, -20.75775, 31.899900989],
    ['craft:jwst', '2026-01-01T00:00:00Z', 86.86938, 11.78406, 0.011341678],
    ['craft:voyager1', '1980-11-12T23:00:00Z', 186.71220, -0.56066, 10.193616140],
];

test('interpolated positions match JPL Horizons (flybys included)', () => {
    for (const [id, iso, ra, dec, delta] of HORIZONS) {
        const c = byId(id);
        const t = AE.MakeTime(new Date(iso));
        const jd = t.tt + 2451545;
        const e = AE.HelioVector('Earth', t);
        const p = new Float64Array(3);
        let tau = 0;
        for (let k = 0; k < 3; k++) {
            assert.equal(craftStateAt(c, jd - tau, p), 'data');
            tau = Math.hypot(p[0] - e.x, p[1] - e.y, p[2] - e.z) * 499.004784 / 86400;
        }
        const g = [p[0] - e.x, p[1] - e.y, p[2] - e.z];
        const d = Math.hypot(...g);
        const raC = Math.atan2(g[1], g[0]), decC = Math.asin(g[2] / d);
        const sep = Math.acos(Math.min(1, Math.sin(dec * DEG) * Math.sin(decC) + Math.cos(dec * DEG) * Math.cos(decC) * Math.cos(ra * DEG - raC))) / DEG;
        const tol = id === 'craft:jwst' ? 0.05 : 0.01;
        assert.ok(sep < tol, `${id} ${iso}: ${sep.toFixed(4)}°`);
        assert.ok(Math.abs(d - delta) / delta < 1e-4, `${id}: Δ ${d} vs ${delta}`);
    }
});

test('Voyager 1 becomes one light-day away in November 2026 ("a message sent now arrives tomorrow")', () => {
    const v1 = byId('craft:voyager1');
    const at = (iso) => {
        const t = AE.MakeTime(new Date(iso));
        const e = AE.HelioVector('Earth', t);
        return radioTimeS(v1, t.tt + 2451545, [e.x, e.y, e.z]);
    };
    assert.ok(at('2026-11-10T00:00:00Z') < 86400);
    assert.ok(at('2026-11-20T00:00:00Z') > 86400);
    assert.equal(fmtRadioTime(at('2026-11-04T00:00:00Z')), '23 h 58 min');
    assert.equal(fmtRadioTime(4.9), '4.9 s');
    assert.equal(fmtRadioTime(192), '3 min 12 s');
});

test('beyond the data: the Voyagers coast (projected); JWST is not shown after 2031; nothing before launch', () => {
    const p = new Float64Array(3);
    assert.equal(craftStateAt(byId('craft:voyager1'), 2488070.5 + 3650, p), 'projected');   // 2111
    assert.ok(Math.hypot(...p) > 300);
    assert.equal(craftStateAt(byId('craft:jwst'), 2463210.5, p), null);                     // 2031-11-29
    assert.equal(craftStateAt(byId('craft:voyager2'), 2443000.5, p), null);                 // 1976
    const reg = createExtras();
    reg.register(createCraftProvider(CRAFT));
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(1975, 0, 1), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap, { detail: 'full' });
    reg.fill(snap);
    assert.equal(reg.state(snap, 'craft:voyager1').present, false);
    computeSnapshot(Date.UTC(2200, 0, 1), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap, { detail: 'full' });
    reg.fill(snap);
    const v1 = reg.state(snap, 'craft:voyager1');
    assert.ok(v1.present && v1.approx);
    assert.equal(reg.state(snap, 'craft:jwst').present, false);
});

test('Deep Space Network: Voyager 2 is so far south that only Canberra sees it', () => {
    const reg = createExtras();
    reg.register(createCraftProvider(CRAFT));
    const snap = createSnapshot();
    const seen = new Set();
    for (let h = 0; h < 24; h++) {
        computeSnapshot(Date.UTC(2026, 10, 15, h), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap, { detail: 'full' });
        reg.fill(snap);
        const st = reg.state(snap, 'craft:voyager2');
        for (const n of dsnInView(snap, st.data.geoS)) seen.add(n);
    }
    assert.deepEqual([...seen], ['Canberra']);
    const card = reg.card('craft:voyager2', snap);
    assert.match(card.lines[0], /^A message sent now arrives in \d+ h \d\d min/);
});
