// Upcoming events (SPEC §C.2, §H): fixtures with stated tolerances plus list invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingEvents } from '../js/astro/events.js';
import { BODY_IDS } from '../js/astro/bodies.js';

const DAY = 864e5;
const HANOI = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 };
const MADRID = { latDeg: 40.4168, lonDeg: -3.7038, elevM: 650 };
const KINDS = new Set(['moon-phase', 'opposition', 'conjunction', 'max-elongation', 'lunar-eclipse', 'solar-eclipse',
    'local-solar-eclipse', 'equinox', 'solstice']);

// The searches are the expensive part, so compute each list once.
const from2026 = Date.parse('2026-10-11T00:00:00Z');
const hanoi2026 = upcomingEvents(HANOI, from2026);
const from2024 = Date.parse('2024-10-01T00:00:00Z');
const hanoi2024 = upcomingEvents(HANOI, from2024);
const fromJune2027 = Date.parse('2027-06-01T00:00:00Z');
const madrid2027 = upcomingEvents(MADRID, fromJune2027, 120);

const within = (ms, iso, days) => Math.abs(ms - Date.parse(iso)) <= days * DAY;

test('from 2026-10-11 the next global solar eclipse is annular on 2027-02-06 (±1 d), greatest at 31.3° S, 48.5° W', () => {
    const ev = hanoi2026.find((e) => e.kind === 'solar-eclipse');
    assert.ok(ev, 'a global solar eclipse is listed');
    assert.ok(within(ev.tMs, '2027-02-06T16:00:00Z', 1), new Date(ev.tMs).toISOString());
    assert.equal(ev.eclipseKind, 'annular');
    assert.equal(ev.title, 'Annular solar eclipse — greatest at 31.3° S, 48.5° W');
    assert.ok(Math.abs(ev.geo.latDeg + 31.3) < 0.5 && Math.abs(ev.geo.lonDeg + 48.5) < 0.5);
    assert.equal(ev.select, 'sun');
    assert.equal(ev.view, 'orbit');
});

test('the total solar eclipse of 2027-08-02 is found, globally and as seen from Madrid', () => {
    const total = madrid2027.find((e) => e.kind === 'solar-eclipse' && e.eclipseKind === 'total');
    assert.ok(total, 'total eclipse listed');
    assert.ok(within(total.tMs, '2027-08-02T10:07:00Z', 1), new Date(total.tMs).toISOString());
    assert.match(total.title, /^Total solar eclipse — greatest at 25\.\d° N, 33\.\d° E$/);
    const local = madrid2027.find((e) => e.kind === 'local-solar-eclipse');
    assert.ok(local, 'visible from Madrid');
    assert.ok(within(local.tMs, '2027-08-02T09:00:00Z', 0.5));
    assert.ok(local.obscuration > 0.5 && local.obscuration < 1);
    assert.match(local.title, /^Partial solar eclipse visible here \(\d{2}% covered\)$/);
    assert.match(local.detail, /eclipse glasses/);
    assert.equal(local.view, 'sky');
});

test('Mars opposition on 2025-01-16 (±1 d) when starting from 2024-10-01', () => {
    const ev = hanoi2024.find((e) => e.kind === 'opposition' && e.bodyId === 'mars');
    assert.ok(ev);
    assert.ok(within(ev.tMs, '2025-01-16T02:30:00Z', 1), new Date(ev.tMs).toISOString());
    assert.equal(ev.title, 'Mars at opposition');
    assert.match(ev.detail, /mag −1\.\d, 0\.6\d AU away, up all night in (Gemini|Cancer)/);
    assert.equal(ev.select, 'mars');
    // Other oppositions of that season: Uranus 2024-11-17, Jupiter 2024-12-07.
    assert.ok(within(hanoi2024.find((e) => e.kind === 'opposition' && e.bodyId === 'jupiter').tMs, '2024-12-07T21:00:00Z', 1));
    assert.ok(within(hanoi2024.find((e) => e.kind === 'opposition' && e.bodyId === 'uranus').tMs, '2024-11-17T02:00:00Z', 1));
});

test('lists are sorted, ids unique, every event titled and well-formed, all inside the requested span', () => {
    for (const [list, fromMs, days] of [[hanoi2026, from2026, 365], [hanoi2024, from2024, 365], [madrid2027, fromJune2027, 120]]) {
        assert.ok(list.length > 10);
        const ids = new Set();
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (i) assert.ok(list[i - 1].tMs <= e.tMs, 'sorted');
            assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
            ids.add(e.id);
            assert.ok(KINDS.has(e.kind), e.kind);
            assert.equal(typeof e.title, 'string');
            assert.ok(e.title.length > 3, 'title');
            assert.equal(typeof e.detail, 'string');
            assert.ok(e.bodyId === null || BODY_IDS.includes(e.bodyId));
            assert.ok(e.select === null || BODY_IDS.includes(e.select));
            assert.ok(e.view === null || e.view === 'orbit' || e.view === 'sky');
            assert.ok(e.tMs >= fromMs && e.tMs <= fromMs + days * DAY);
        }
    }
});

test('Moon phases: ~4 per lunation in quarter order, with spec titles', () => {
    const phases = hanoi2026.filter((e) => e.kind === 'moon-phase');
    assert.ok(phases.length >= 48 && phases.length <= 51, `${phases.length} quarters in a year`);
    const names = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
    for (let i = 1; i < phases.length; i++) {
        assert.equal(phases[i].quarter, (phases[i - 1].quarter + 1) % 4);
        const gap = (phases[i].tMs - phases[i - 1].tMs) / DAY;
        assert.ok(gap > 6.2 && gap < 8.5, `quarter gap ${gap} d`);
    }
    for (const p of phases) {
        assert.equal(p.title, names[p.quarter]);
        assert.match(p.detail, /^Moon in [A-Z][a-z]+( [A-Z][a-z]+)?, [\d,]+ km from Earth/);
    }
    // 2026-11-24 is the closest full Moon of the year: a supermoon.
    const nov = phases.find((p) => p.title === 'Full Moon' && within(p.tMs, '2026-11-24T15:00:00Z', 1));
    assert.ok(nov && /supermoon/.test(nov.detail));
});

test('equinoxes and solstices have the spec titles, hemisphere-aware details and the right dates', () => {
    const seasons = hanoi2026.filter((e) => e.kind === 'equinox' || e.kind === 'solstice');
    assert.deepEqual(seasons.map((e) => e.title), ['December solstice', 'March equinox', 'June solstice', 'September equinox']);
    assert.ok(within(seasons[1].tMs, '2027-03-20T20:25:00Z', 0.1));
    assert.match(seasons[0].detail, /^Shortest day/);
    const south = upcomingEvents({ latDeg: -33.9, lonDeg: 151.2, elevM: 0 }, Date.parse('2026-12-01T00:00:00Z'), 30);
    assert.match(south.find((e) => e.kind === 'solstice').detail, /^Longest day/);
});

test('greatest elongations, solar conjunctions and lunar eclipses use the spec title formats', () => {
    for (const e of hanoi2026.filter((x) => x.kind === 'max-elongation')) {
        assert.match(e.title, /^(Mercury|Venus) at greatest elongation (east|west) \(\d+\.\d°\)$/);
        assert.ok(e.elongDeg > 17 && e.elongDeg < 48);
    }
    const venus = hanoi2026.find((e) => e.kind === 'max-elongation' && e.bodyId === 'venus');
    assert.ok(within(venus.tMs, '2027-01-03T18:00:00Z', 1));
    assert.ok(hanoi2026.some((e) => e.title === 'Venus at inferior conjunction' && within(e.tMs, '2026-10-24T03:00:00Z', 1)));
    assert.ok(hanoi2026.some((e) => e.title === 'Jupiter in conjunction with the Sun'));
    const lunar = hanoi2026.filter((e) => e.kind === 'lunar-eclipse');
    assert.ok(lunar.length >= 2);
    for (const e of lunar) {
        assert.match(e.title, /^(Penumbral|Partial|Total) lunar eclipse$/);
        assert.equal(typeof e.visibleHere, 'boolean');
        assert.equal(e.view, e.visibleHere ? 'sky' : 'orbit');
    }
    const total = upcomingEvents(HANOI, Date.parse('2025-09-01T00:00:00Z'), 30).find((e) => e.kind === 'lunar-eclipse');
    assert.equal(total.title, 'Total lunar eclipse');
    assert.ok(within(total.tMs, '2025-09-07T18:12:00Z', 0.1));
    assert.match(total.detail, /^Visible from here.*totality lasts \d+ min$/);
});

test('planet pairings and Moon appulses are tagged as conjunctions with both bodies', () => {
    const pairs = hanoi2026.filter((e) => e.kind === 'conjunction' && Array.isArray(e.bodyIds));
    assert.ok(pairs.length >= 1);
    for (const e of pairs) {
        assert.equal(e.bodyIds.length, 2);
        assert.ok(e.sepDeg < 1.5);
        assert.equal(e.view, 'sky');
        assert.match(e.title, /conjunction \(\d+(\.\d)?[′°] apart\)$|^Moon (passes|occults)/);
    }
    const mj = pairs.find((e) => e.title.startsWith('Mars–Jupiter'));
    assert.ok(mj && within(mj.tMs, '2026-11-16T02:00:00Z', 1), 'Mars–Jupiter pairing of November 2026');
});

test('upcomingEvents validates input and clamps the span', () => {
    assert.throws(() => upcomingEvents({ latDeg: NaN, lonDeg: 0 }, from2026), TypeError);
    assert.throws(() => upcomingEvents(HANOI, NaN), TypeError);
    const short = upcomingEvents(HANOI, from2026, 0);
    for (const e of short) assert.ok(e.tMs <= from2026 + DAY);
});

test('a deep partial solar eclipse never reads "100% covered" (Madrid, 2026-08-12)', () => {
    const ev = upcomingEvents(MADRID, Date.parse('2026-08-01T00:00:00Z'), 30).find((e) => e.kind === 'local-solar-eclipse');
    assert.ok(ev, 'local eclipse found');
    assert.equal(ev.eclipseKind, 'partial');
    assert.ok(ev.obscuration > 0.995);
    assert.equal(ev.title, 'Partial solar eclipse visible here (99% covered)');
});

test('event ids of two-body events name both bodies, so simultaneous pairings cannot collide', () => {
    for (const ev of [...hanoi2026, ...hanoi2024]) {
        if (ev.bodyIds) assert.ok(ev.id.includes(ev.bodyIds.join('+')), ev.id);
    }
});
