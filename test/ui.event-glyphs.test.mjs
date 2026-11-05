// Event glyphs (ROADMAP event-glyphs-and-ics): the geometry helpers (lens, cover offset, phase)
// and what each kind's glyph shows, from the pure spec (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glyphSpec, lensPath, offsetForCover, phasePath, circlePath } from '../js/ui/event-glyphs.js';
import { discVisibleFraction } from '../js/astro/shadow.js';
import { upcomingEvents, localSolarEclipseAt } from '../js/astro/events.js';

const nums = (d) => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
const fills = (spec) => spec.map(([, a]) => a.fill).filter((f) => f && f !== 'none');

test('lensPath: none apart, the smaller disc when inside, else two arcs through the crossing points', () => {
    assert.equal(lensPath(0, 0, 5, 20, 0, 5), '');
    assert.equal(lensPath(0, 0, 10, 1, 1, 2), circlePath(1, 1, 2));
    const d = lensPath(12, 12, 7.6, 16, 9, 7.8);
    assert.match(d, /^M[\d.]+ [\d.]+A7\.8 7\.8 0 [01] 0 [\d.]+ [\d.]+A7\.6 7\.6 0 [01] 0 [\d.]+ [\d.]+z$/);
    const n = nums(d);
    const P = [n[0], n[1]], Q = [n[7], n[8]];
    for (const [x, y] of [P, Q]) {
        assert.ok(Math.abs(Math.hypot(x - 12, y - 12) - 7.6) < 0.02, 'on the first circle');
        assert.ok(Math.abs(Math.hypot(x - 16, y - 9) - 7.8) < 0.02, 'on the second circle');
    }
    assert.deepEqual([n[14], n[15]], P, 'closed back at the start');
});

test('offsetForCover: the separation that covers the asked fraction of the disc', () => {
    for (const [rs, rc] of [[7.6, 7.8], [7.6, 6.6], [7.4, 19.98]]) {
        for (const f of [0.1, 0.3, 0.5, 0.75]) {
            const d = offsetForCover(rs, rc, f);
            assert.ok(Math.abs(1 - discVisibleFraction(rs, rc, d) - f) < 1e-6, `${rs}/${rc} at ${f}: ${d}`);
        }
    }
    assert.equal(offsetForCover(7.6, 7.8, 0), 7.6 + 7.8);
    assert.equal(offsetForCover(7.6, 6.6, 0.99), 0, 'annular: centred is the most it covers');
});

test('phasePath: a quarter is a half disc on the lit side, crescents and gibbous bulge the right way', () => {
    // A quarter's terminator has no width: a straight line back up, whatever its sweep flag.
    assert.match(phasePath(12, 12, 8, 0.5, true), /^M12 4A8 8 0 0 1 12 20A0 8 0 0 [01] 12 4z$/);
    assert.match(phasePath(12, 12, 8, 0.5, false), /^M12 4A8 8 0 0 0 12 20A0 8 0 0 [01] 12 4z$/);
    assert.equal(phasePath(12, 12, 8, 0.25, true), 'M12 4A8 8 0 0 1 12 20A4 8 0 0 0 12 4z', 'crescent: terminator toward the lit limb');
    assert.equal(phasePath(12, 12, 8, 0.75, true), 'M12 4A8 8 0 0 1 12 20A4 8 0 0 1 12 4z', 'gibbous: terminator toward the dark side');
    assert.equal(phasePath(12, 12, 8, 1, true), circlePath(12, 12, 8));
});

test('Moon phases show their phase, lit on the side this hemisphere sees', () => {
    const q = (quarter, south = false) => glyphSpec({ kind: 'moon-phase', quarter, title: '', detail: '' }, { south });
    const lit = (spec) => spec.find(([tag, a]) => tag === 'path' && a.fill === 'var(--body-moon)')?.[1].d;
    assert.equal(lit(q(0)), undefined, 'new: no lit part');
    assert.ok(q(0).some(([, a]) => a.stroke === 'var(--body-moon)'), 'new: the outline');
    assert.ok(q(2).some(([tag, a]) => tag === 'circle' && a.fill === 'var(--body-moon)' && a.opacity === undefined), 'full: a lit disc');
    assert.equal(lit(q(1)), phasePath(12, 12, 8.4, 0.5, true), 'first quarter: right half (north)');
    assert.equal(lit(q(3)), phasePath(12, 12, 8.4, 0.5, false), 'last quarter: left half (north)');
    assert.equal(lit(q(1, true)), phasePath(12, 12, 8.4, 0.5, false), 'first quarter from the south: left half');
    const superFull = glyphSpec({ kind: 'moon-phase', quarter: 2, title: 'Full Moon', detail: 'Moon in Cancer — a supermoon' });
    assert.ok(superFull.length > q(2).length, 'a supermoon gets its halo');
    assert.equal(lit(glyphSpec({ kind: 'moon-phase', title: 'Last Quarter' })), lit(q(3)), 'the quarter from the title');
});

test('a conjunction shows both bodies in their colours, further apart the wider the pairing', () => {
    const pair = (sepDeg) => glyphSpec({ kind: 'conjunction', bodyIds: ['mars', 'jupiter'], select: 'jupiter', sepDeg });
    assert.deepEqual(fills(pair(0.3)), ['var(--body-mars)', 'var(--body-jupiter)']);
    const gap = (spec) => Math.hypot(spec[1][1].cx - spec[0][1].cx, spec[1][1].cy - spec[0][1].cy);
    assert.ok(gap(pair(1.2)) > gap(pair(0.3)) + 4);
    const moon = glyphSpec({ kind: 'conjunction', bodyIds: ['moon', 'venus'], sepDeg: 0.2, occultation: true });
    assert.deepEqual(fills(moon), ['var(--body-venus)', 'var(--body-moon)'], 'the planet first, so the Moon hides half of it');
    const [, pl] = moon[0], [, mo] = moon[1];
    assert.ok(Math.abs(Math.hypot(pl.cx - mo.cx, pl.cy - mo.cy) - mo.r) < 0.05, 'occulted: on the limb');
    assert.ok(fills(glyphSpec({ kind: 'conjunction', bodyId: 'jupiter', title: 'Jupiter in conjunction with the Sun' })).includes('var(--body-sun)'));
});

test('eclipses show the actual overlap: a hole in the Sun, copper on the Moon', () => {
    const lux = localSolarEclipseAt({ latDeg: 25.6872, lonDeg: 32.6396, elevM: 76 }, Date.parse('2027-08-02T10:05:00Z'));
    const total = glyphSpec(lux);
    assert.ok(total.some(([, a]) => a.fill === 'var(--bg)'), 'totality: the Moon\'s silhouette');
    const partial = glyphSpec({ kind: 'local-solar-eclipse', eclipseKind: 'partial', obscuration: 0.4, title: '' });
    const sun = partial.find(([, a]) => a['fill-rule'] === 'evenodd');
    assert.ok(sun && /z[Mm]/.test(sun[1].d), 'the Sun with the lens cut out (even-odd)');
    assert.ok(/A7\.8 7\.8/.test(sun[1].d), 'the hole follows the Moon\'s limb');
    const annular = glyphSpec({ kind: 'solar-eclipse', eclipseKind: 'annular', title: 'Annular solar eclipse' });
    assert.ok(annular[0][1].d.includes(circlePath(12, 12, 6.6)), 'annular: the Moon centred inside the Sun');
    assert.deepEqual(fills(glyphSpec({ kind: 'lunar-eclipse', eclipseKind: 'total', title: '' })), ['var(--ev-copper)']);
    const pl = glyphSpec({ kind: 'lunar-eclipse', eclipseKind: 'partial', obscuration: 0.4, title: '' });
    assert.deepEqual(fills(pl), ['var(--body-moon)', 'var(--ev-copper)']);
});

test('solstices: the Sun high in this hemisphere\'s summer, low in its winter', () => {
    const apex = (title, south) => glyphSpec({ kind: 'solstice', title }, { south }).find(([tag]) => tag === 'circle')[1].cy;
    assert.ok(apex('June solstice', false) < apex('December solstice', false), 'north: high in June');
    assert.ok(apex('June solstice', true) > apex('December solstice', true), 'south: high in December');
    assert.equal(apex('June solstice', false), apex('December solstice', true));
});

test('every event kind of a real year has a glyph, its discs inside the box, coloured by tokens', () => {
    const list = upcomingEvents({ latDeg: 51.48, lonDeg: 0, elevM: 0 }, Date.parse('2026-01-01T00:00:00Z'), 730);
    const kinds = new Set(list.map((e) => e.kind));
    assert.ok(kinds.size >= 12, [...kinds].join(' '));
    for (const ev of [...list, { kind: 'sat-pass', color: '#ffffff' }, { kind: 'unknown' }]) {
        const spec = glyphSpec(ev);
        assert.ok(spec.length > 0, ev.kind);
        for (const [tag, a] of spec) {
            assert.ok(['circle', 'path'].includes(tag), tag);
            for (const k of ['fill', 'stroke']) {
                const v = a[k];
                if (v == null || v === 'none') continue;
                assert.ok(/^var\(--[a-z-]+\)$/.test(v) || v === 'currentColor' || /^#[\da-f]{6}$/i.test(v), `${ev.kind} ${k}=${v}`);
            }
            if (tag === 'circle' && a.fill !== 'none') {
                assert.ok(a.cx - a.r > -1.5 && a.cx + a.r < 25.5 && a.cy - a.r > -1.5 && a.cy + a.r < 25.5, `${ev.kind}: circle ${JSON.stringify(a)}`);
            }
            for (const v of Object.values(a)) assert.ok(!String(v).includes('NaN'), `${ev.kind}: ${JSON.stringify(a)}`);
        }
    }
});
