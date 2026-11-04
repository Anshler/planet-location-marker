// Sky dome (ROADMAP sky-dome-chart): the all-sky chart's projection, horizon clipping, the
// ecliptic, the Moon's bright-limb direction, the camera's field outline, label placement and
// hit-testing (js/ui/sky-dome.js; the drawing itself is checked by the smoke screenshots).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    enuToChart, projectDirs, projectSegments, eclipticSegments, limbAngle, fovOutline, placeLabels, nearestHit,
    bodyRadius, starRadius, STAR_MAG,
} from '../js/ui/sky-dome.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { decodeSky } from '../js/data/catalog.js';
import { raDecToScene } from '../js/astro/frames.js';

const DEG = Math.PI / 180;
const PARIS = { latDeg: 48.8566, lonDeg: 2.3522, elevM: 35 };
/** The observer frame equal to the scene axes: east x, north y, up z. */
const FLAT = { upS: [0, 0, 1], northS: [0, 1, 0], eastS: [1, 0, 0] };
const enu = (altDeg, azDeg) => [Math.cos(altDeg * DEG) * Math.sin(azDeg * DEG), Math.cos(altDeg * DEG) * Math.cos(azDeg * DEG), Math.sin(altDeg * DEG)];
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('enuToChart: zenith at the centre, north up, east left looking up and right on the map', () => {
    const out = [0, 0];
    assert.equal(enuToChart(0, 0, 1, -1, out), 0);
    assert.deepEqual(out, [0, 0]);
    close(enuToChart(0, 1, 0, -1, out), 1, 1e-12, 'north horizon r');
    close(out[0], 0, 1e-12); close(out[1], -1, 1e-12);
    enuToChart(1, 0, 0, -1, out);
    close(out[0], -1, 1e-12, 'east, looking up');
    enuToChart(1, 0, 0, 1, out);
    close(out[0], 1, 1e-12, 'east, map');
    const [e, n, u] = enu(45, 180);
    close(enuToChart(e, n, u, 1, out), 0.5, 1e-12, 'alt 45 r');
    close(out[1], 0.5, 1e-12, 'south is down');
    close(enuToChart(0, 0, -1, 1, out), 2, 1e-12, 'the nadir');
});

test('projectDirs matches the snapshot’s own altitudes and azimuths (equidistant radius)', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.parse('2026-11-04T21:00:00Z'), PARIS, snap);
    const src = new Float64Array(3 * snap.bodies.length);
    snap.bodies.forEach((b, i) => src.set(b.dirS, 3 * i));
    const out = new Float32Array(2 * snap.bodies.length);
    const up = projectDirs(src, snap.bodies.length, snap.observer, 1, out);
    let n = 0;
    snap.bodies.forEach((b, i) => {
        if (b.altGeomDeg < 0) { assert.ok(Number.isNaN(out[2 * i]), `${b.id} below`); return; }
        n++;
        const r = Math.hypot(out[2 * i], out[2 * i + 1]);
        close(r, (90 - b.altGeomDeg) / 90, 1e-5, `${b.id} r`);
        const az = (Math.atan2(out[2 * i], -out[2 * i + 1]) / DEG + 360) % 360;
        close(Math.abs(((az - b.azGeomDeg + 540) % 360) - 180), 0, 1e-3, `${b.id} az`);
    });
    assert.equal(up, n);
});

test('the catalogue: Polaris stands at Paris’s latitude in the north, and the list to mag 3.5 is short', () => {
    const cat = decodeSky(JSON.parse(fs.readFileSync(new URL('../data/sky.json', import.meta.url))));
    let nStars = 0;
    while (nStars < cat.stars.count && cat.stars.mag[nStars] <= STAR_MAG) nStars++;
    assert.ok(nStars > 200 && nStars < 400, `${nStars} stars to mag ${STAR_MAG}`);
    const snap = createSnapshot();
    computeSnapshot(Date.parse('2026-11-04T21:00:00Z'), PARIS, snap);
    const polaris = cat.starNames.find((s) => s.name === 'Polaris');
    const out = new Float32Array(2);
    projectDirs(polaris.dirS, 1, snap.observer, -1, out);
    close(Math.hypot(out[0], out[1]), (90 - PARIS.latDeg) / 90, 1 / 90, 'Polaris within 1° of the latitude');
    assert.ok(out[1] < 0 && Math.abs(out[0]) < 0.02, 'due north, at the top');
    const segXY = new Float32Array(4 * (cat.cons.segments.length / 6));
    projectSegments(cat.cons.segments, cat.cons.segments.length / 6, snap.observer, -1, segXY);
    for (let i = 0; i < segXY.length; i += 4) {
        if (Number.isNaN(segXY[i])) continue;
        assert.ok(Math.hypot(segXY[i], segXY[i + 1]) <= 1 + 1e-5 && Math.hypot(segXY[i + 2], segXY[i + 3]) <= 1 + 1e-5, 'figures stay inside the horizon');
    }
});

test('projectSegments: a chord across the horizon ends on the ring; one below it is dropped', () => {
    const a = enu(20, 90), b = enu(-10, 100), c = enu(-5, 0), d = enu(-30, 10);
    const src = new Float64Array([...a, ...b, ...c, ...d]);
    const out = new Float32Array(8);
    projectSegments(src, 2, FLAT, 1, out);
    close(Math.hypot(out[0], out[1]), 70 / 90, 1e-6, 'the visible end');
    close(Math.hypot(out[2], out[3]), 1, 1e-6, 'cut at the horizon');
    assert.ok(out[2] > 0.95, 'toward the east, on the right on the map');
    assert.ok(Number.isNaN(out[4]));
});

test('eclipticSegments: the J2000 ecliptic, through the solstice at RA 6 h, Dec +23.44°', () => {
    const e = eclipticSegments(72);
    assert.equal(e.length, 6 * 72);
    for (let i = 0; i < 72; i++) close(Math.hypot(e[6 * i], e[6 * i + 1], e[6 * i + 2]), 1, 1e-6, 'unit');
    const sol = raDecToScene(90, 23.4392911, new Float64Array(3));
    const k = 6 * 18;     // λ = 90°
    for (let j = 0; j < 3; j++) close(e[k + j], sol[j], 1e-6, `axis ${j}`);
    assert.deepEqual([...e.subarray(3, 6)], [...e.subarray(6, 9)], 'chords join');
});

test('limbAngle: the lit limb faces the Sun, mirrored between the two orientations', () => {
    const moon = enu(30, 180), sunW = enu(-2, 270);
    const map = limbAngle(moon, sunW, FLAT, 1), upw = limbAngle(moon, sunW, FLAT, -1);
    assert.ok(Math.cos(map) < -0.5, `map: toward the west on the left (${map})`);
    assert.ok(Math.cos(upw) > 0.5, `looking up: toward the west on the right (${upw})`);
    // A nearby Sun: the angle points at its place on the chart.
    const m = enu(40, 120), s = enu(48, 135), pm = [0, 0], ps = [0, 0];
    enuToChart(m[0], m[1], m[2], -1, pm);
    enuToChart(s[0], s[1], s[2], -1, ps);
    const chord = Math.atan2(ps[1] - pm[1], ps[0] - pm[0]);
    close(Math.abs(((limbAngle(m, s, FLAT, -1) - chord) / DEG + 540) % 360 - 180), 0, 4, 'within 4° of the chord');
    assert.ok(Number.isNaN(limbAngle(m, m, FLAT, 1)));
});

test('fovOutline: the field’s outline surrounds the view centre, east of the zenith looking east', () => {
    const out = new Float32Array(64);
    const n = fovOutline({ azDeg: 90, altDeg: 30, fovDeg: 40, aspect: 1.5 }, 1, out, 8);
    assert.equal(n, 32);
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += out[2 * i] / n; my += out[2 * i + 1] / n; }
    close(mx, 60 / 90, 0.05, 'centred on alt 30° due east');
    close(my, 0, 0.02);
    const top = Math.hypot(out[8], out[9]), bottom = Math.hypot(out[40], out[41]);
    assert.ok(top < bottom, 'the top edge is nearer the zenith');
    fovOutline({ azDeg: 90, altDeg: 20, fovDeg: 60, aspect: 1.5 }, 1, out, 8);
    assert.ok(Math.hypot(out[40], out[41]) > 1, 'a low, wide field dips below the horizon');
    fovOutline({ azDeg: 90, altDeg: 30, fovDeg: 40, aspect: 1.5 }, -1, out, 8);
    assert.ok(out[0] < 0, 'looking up: east is on the left');
});

const it = (x, y, r, w, extra = {}) => ({ id: '', name: '', x, y, r, w, h: 12, star: false, lx: 0, ly: 0, ok: false, ...extra });

test('placeLabels: labels go right, then left, above or below, and never overlap a dot or each other', () => {
    const items = [it(100, 100, 4, 40), it(104, 110, 2, 30), it(196, 50, 3, 30), it(5, 20, 3, 80)];
    const placed = placeLabels(items, items.length, 200, 200);
    assert.equal(items[0].lx, 107, 'the first takes the right');
    assert.ok(items[1].ok && items[1].ly > 110, 'the second goes below, clear of the first label');
    assert.ok(items[2].ok && items[2].lx + 30 <= 199, 'at the right edge it goes elsewhere');
    assert.equal(items[3].lx, 11, 'at the left edge it takes the right');
    for (const a of items) {
        if (!a.ok) continue;
        for (const b of items) {
            if (a === b) continue;
            assert.ok(!(a.lx < b.x + b.r && b.x - b.r < a.lx + a.w && a.ly < b.y + b.r && b.y - b.r < a.ly + a.h), 'clear of dots');
            if (b.ok) assert.ok(!(a.lx < b.lx + b.w && b.lx < a.lx + a.w && a.ly < b.ly + b.h && b.ly < a.ly + a.h), 'clear of labels');
        }
    }
    assert.equal(placed, items.filter((a) => a.ok).length);
    const crowd = [it(50, 50, 4, 300)];
    assert.equal(placeLabels(crowd, 1, 100, 100), 0, 'too wide to fit anywhere');
    assert.equal(crowd[0].ok, false);
});

test('nearestHit: the nearest body within reach wins over a star', () => {
    const items = [it(100, 100, 3, 0, { id: 'mars' }), it(97, 100, 1.5, 0, { id: 'star:1', star: true }), it(140, 100, 4, 0, { id: 'venus' })];
    assert.equal(items[nearestHit(items, 3, 98, 100, 8)].id, 'mars');
    assert.equal(items[nearestHit(items, 1 + 1, 92, 100, 8)].id, 'mars', 'a body within reach beats a closer star');
    assert.equal(nearestHit(items, 3, 120, 140, 8), -1);
    assert.equal(items[nearestHit(items.slice(1), 1, 96, 101, 8) + 1].id, 'star:1');
});

test('dot sizes grow with brightness and stay within their bounds', () => {
    assert.ok(bodyRadius(-4.4) > bodyRadius(0.5) && bodyRadius(0.5) > bodyRadius(5.7));
    assert.equal(bodyRadius(7.8), 2.2);
    assert.equal(bodyRadius(-10), 5);
    assert.ok(starRadius(-1.44) > starRadius(2) && starRadius(2) > starRadius(3.5));
    assert.equal(starRadius(6), 0.55);
});
