// Upcoming events (SPEC §C.2, §H): fixtures with stated tolerances plus list invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingEvents, localSolarEclipseAt } from '../js/astro/events.js';
import { BODY_IDS } from '../js/astro/bodies.js';
import { AE } from '../js/astro/ae.js';

const DAY = 864e5;
const HANOI = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 };
const MADRID = { latDeg: 40.4168, lonDeg: -3.7038, elevM: 650 };
const KINDS = new Set(['moon-phase', 'opposition', 'conjunction', 'max-elongation', 'lunar-eclipse', 'solar-eclipse',
    'occultation', 'brilliancy', 'transit', 'lunar-apsis', 'ring-plane', 'meteor-shower',
    'local-solar-eclipse', 'equinox', 'solstice']);

// The searches are the expensive part, so compute each list once.
const from2026 = Date.parse('2026-10-11T00:00:00Z');
const hanoi2026 = upcomingEvents(HANOI, from2026);
const from2024 = Date.parse('2024-10-01T00:00:00Z');
const hanoi2024 = upcomingEvents(HANOI, from2024);
const fromJune2027 = Date.parse('2027-06-01T00:00:00Z');
const madrid2027 = upcomingEvents(MADRID, fromJune2027, 120);

const within = (ms, iso, days) => Math.abs(ms - Date.parse(iso)) <= days * DAY;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

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
    // Contacts in the observer's zone (none given: UTC), from AE's semi-durations.
    assert.match(total.detail, /^Visible from here.*; totality 17:30–18:53 \(83 min\)$/);
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

// The eclipse of one source seen from `site`, searched over a few days around `iso`.
function eclipseAt(site, iso, kind) {
    const list = upcomingEvents({ elevM: 0, ...site }, Date.parse(iso) - 2 * DAY, 4);
    const ev = list.find((e) => e.kind === kind);
    assert.ok(ev, `${kind} near ${iso}`);
    return ev;
}

test('"Total solar eclipse visible here" only when totality itself clears the horizon (upper-limb test)', () => {
    // Atlantic, near the sunrise end of the 2027-08-02 track: C2/C3 at −1.3° (upper limb −1.0°).
    const atlantic = eclipseAt({ latDeg: 28.10, lonDeg: -46.97 }, '2027-08-02T08:25:00Z', 'local-solar-eclipse');
    assert.equal(atlantic.eclipseKind, 'total');
    assert.equal(atlantic.title, 'Partial solar eclipse visible here (totality is below the horizon)');
    assert.match(atlantic.detail, /^Partial phases 07:35–09:19, maximum at 08:25\. The Sun rises after maximum, still partly eclipsed\. /);
    // Western Mediterranean, 2026-08-12: C2 has the upper limb at +0.10°, C3 at −0.10°.
    const sunset = eclipseAt({ latDeg: 37.8, lonDeg: 6.0 }, '2026-08-12T18:30:00Z', 'local-solar-eclipse');
    assert.equal(sunset.eclipseKind, 'total');
    assert.equal(sunset.title, 'Total solar eclipse visible here at sunset');
    assert.match(sunset.detail, /^Totality 18:32:25–18:33:43 \(1 m 18 s\)\. The Sun sets during totality\. Partial phases 17:40–19:22\. /);
    // Luxor: totality high in the sky.
    const luxor = eclipseAt({ latDeg: 25.7, lonDeg: 32.6 }, '2027-08-02T10:05:00Z', 'local-solar-eclipse');
    assert.equal(luxor.title, 'Total solar eclipse visible here (6 m 25 s)');
    assert.match(luxor.detail, /^Totality 10:01:49–10:08:14 \(6 m 25 s\), Sun 82° up\. Partial phases 08:40–11:26\. /);
    assert.equal(luxor.view, 'sky');
});

test('a lunar eclipse is visible when any part of its umbral phase is above the horizon, not only mid-eclipse', () => {
    // 2026-03-03 (mid-eclipse 11:34 UTC): New York sees totality begin before moonset.
    const ny = eclipseAt({ latDeg: 40.71, lonDeg: -74.0 }, '2026-03-03T11:34:00Z', 'lunar-eclipse');
    assert.equal(ny.visibleHere, true);
    assert.equal(ny.view, 'sky');
    assert.equal(ny.detail, 'Partly visible from here: the Moon sets during totality, before mid-eclipse; totality 11:03–12:03 (59 min)');
    // Hanoi: moonrise in the partial phase, before totality.
    const hanoi = eclipseAt({ latDeg: 21.03, lonDeg: 105.85 }, '2026-03-03T11:34:00Z', 'lunar-eclipse');
    assert.equal(hanoi.visibleHere, true);
    assert.match(hanoi.detail, /^Visible from here: the Moon rises before totality and is \d° up at mid-eclipse;/);
    // Paris: the Moon set before the umbral phase began.
    const paris = eclipseAt({ latDeg: 48.85, lonDeg: 2.35 }, '2026-03-03T11:34:00Z', 'lunar-eclipse');
    assert.equal(paris.visibleHere, false);
    assert.equal(paris.view, 'orbit');
    assert.match(paris.detail, /^Not visible from here: the Moon is below the horizon throughout the eclipse;/);
    // 2028-12-31: Lagos has the Moon 11° down at mid-eclipse but up before the partial phase ends.
    const lagos = eclipseAt({ latDeg: 6.52, lonDeg: 3.38 }, '2028-12-31T16:52:00Z', 'lunar-eclipse');
    assert.equal(lagos.visibleHere, true);
    assert.equal(lagos.view, 'sky');
    assert.match(lagos.detail, /^Partly visible from here: the Moon rises after totality;/);
});

test('event ids of two-body events name both bodies, so simultaneous pairings cannot collide', () => {
    for (const ev of [...hanoi2026, ...hanoi2024]) {
        if (ev.bodyIds) assert.ok(ev.id.includes(ev.bodyIds.join('+')), ev.id);
    }
});

// ---- eclipse-local-circumstances-and-framing --------------------------------------------------

const LUXOR_TZ = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, tz: 'Africa/Cairo' };
const altOf = (name, site, ms) => {
    const obs = new AE.Observer(site.latDeg, site.lonDeg, 0);
    const time = AE.MakeTime(new Date(ms));
    const eq = AE.Equator(name, time, obs, true, true);
    return AE.Horizon(time, obs, eq.ra, eq.dec, 'normal').altitude;
};

test('Luxor 2027-08-02: contacts, totality and the Sun at each contact, in Cairo time', () => {
    const ev = upcomingEvents(LUXOR_TZ, Date.parse('2027-07-31T00:00:00Z'), 4).find((e) => e.kind === 'local-solar-eclipse');
    assert.ok(ev);
    // AE: C2 10:01:49.6Z, C3 10:08:14.3Z, 384.7 s, maximum 81.8° up.
    near(ev.c2Ms, Date.parse('2027-08-02T10:01:49.6Z'), 1000, 'C2');
    near(ev.c3Ms, Date.parse('2027-08-02T10:08:14.3Z'), 1000, 'C3');
    near(ev.totalDurS, 384.7, 0.5, 'totality');
    assert.ok(ev.c1Ms < ev.c2Ms && ev.c2Ms < ev.maxMs && ev.maxMs < ev.c3Ms && ev.c3Ms < ev.c4Ms);
    assert.equal(ev.maxMs, ev.tMs);
    near(ev.sunAltDeg.max, 81.8, 0.2, 'Sun at maximum');
    for (const k of ['c1', 'c2', 'c3', 'c4']) assert.ok(ev.sunAltDeg[k] > 60, `Sun high at ${k}`);
    assert.equal(ev.centralUp, 'all');
    assert.equal(ev.visibleMs, ev.maxMs);
    assert.equal(ev.title, 'Total solar eclipse visible here (6 m 25 s)');
    assert.match(ev.detail, /^Totality 13:01:49–13:08:14 \(6 m 25 s\), Sun 82° up\. Partial phases 11:40–14:26\. Never look/);
    // opts.tz wins over the observer's zone; hour12 switches the clock style.
    const utc = upcomingEvents(LUXOR_TZ, Date.parse('2027-07-31T00:00:00Z'), 4, { tz: 'UTC', hour12: true })
        .find((e) => e.kind === 'local-solar-eclipse');
    assert.match(utc.detail, /^Totality 10:01:49\sAM–10:08:14\sAM \(6 m 25 s\)/);
});

test('localSolarEclipseAt gives the same event for one site, or null when no eclipse is near', () => {
    const list = upcomingEvents(LUXOR_TZ, Date.parse('2027-07-31T00:00:00Z'), 4).find((e) => e.kind === 'local-solar-eclipse');
    const one = localSolarEclipseAt(LUXOR_TZ, Date.parse('2027-08-02T10:06:00Z'));
    assert.deepEqual(one, list);
    assert.equal(localSolarEclipseAt(LUXOR_TZ, Date.parse('2027-05-01T00:00:00Z')), null);
    assert.throws(() => localSolarEclipseAt(LUXOR_TZ, NaN), TypeError);
});

test('a partial solar eclipse whose maximum is below the horizon does not quote the peak obscuration', () => {
    // Mid-Atlantic, 2027-08-02: maximum at −2.3°, the Sun rises before the eclipse ends.
    const site = { latDeg: 10, lonDeg: -40 };
    const ev = eclipseAt(site, '2027-08-02T08:20:00Z', 'local-solar-eclipse');
    assert.equal(ev.eclipseKind, 'partial');
    assert.ok(ev.sunAltDeg.max < 0 && ev.c2Ms === null && ev.totalDurS === null);
    assert.equal(ev.title, 'Partial solar eclipse visible here at sunrise');
    // The jump target is just after sunrise, inside the eclipse, with the Sun up.
    assert.ok(ev.visibleMs > ev.maxMs && ev.visibleMs < ev.c4Ms);
    assert.ok(altOf('Sun', site, ev.visibleMs) > 0, 'Sun up at visibleMs');
    // A partial seen with the Sun up at maximum keeps its percentage.
    const madrid = madrid2027.find((e) => e.kind === 'local-solar-eclipse');
    assert.match(madrid.title, /\(\d{2}% covered\)$/);
});

test('lunar eclipses carry their contacts, and visibleMs falls when the Moon is up', () => {
    const nySite = { latDeg: 40.71, lonDeg: -74.0 };
    const ny = eclipseAt(nySite, '2026-03-03T11:34:00Z', 'lunar-eclipse');
    assert.ok(ny.p1Ms < ny.u1Ms && ny.u1Ms < ny.u2Ms && ny.u2Ms < ny.maxMs && ny.maxMs < ny.u3Ms && ny.u3Ms < ny.u4Ms && ny.u4Ms < ny.p4Ms);
    near((ny.u3Ms - ny.u2Ms) / 60000, 59.4, 0.5, 'totality (min)');
    near(ny.maxMs - ny.u2Ms, ny.u3Ms - ny.maxMs, 2, 'symmetric');
    // New York: the Moon sets during totality, before mid-eclipse → look before moonset, not at the peak.
    assert.ok(ny.visibleMs < ny.maxMs && ny.visibleMs > ny.u1Ms);
    assert.ok(altOf('Moon', nySite, ny.visibleMs) > 0, 'Moon up at visibleMs (New York)');
    assert.ok(altOf('Moon', nySite, ny.maxMs) < 0, 'Moon down at mid-eclipse (New York)');
    // Lagos 2028-12-31: the Moon rises after totality → look after moonrise.
    const lagosSite = { latDeg: 6.52, lonDeg: 3.38 };
    const lagos = eclipseAt(lagosSite, '2028-12-31T16:52:00Z', 'lunar-eclipse');
    assert.ok(lagos.visibleMs > lagos.u3Ms && lagos.visibleMs < lagos.u4Ms);
    assert.ok(altOf('Moon', lagosSite, lagos.visibleMs) > 0, 'Moon up at visibleMs (Lagos)');
    // Up at mid-eclipse (Hanoi): the peak itself; not visible (Paris): null.
    const hanoi = eclipseAt({ latDeg: 21.03, lonDeg: 105.85 }, '2026-03-03T11:34:00Z', 'lunar-eclipse');
    assert.equal(hanoi.visibleMs, hanoi.maxMs);
    const paris = eclipseAt({ latDeg: 48.85, lonDeg: 2.35 }, '2026-03-03T11:34:00Z', 'lunar-eclipse');
    assert.equal(paris.visibleMs, null);
    // A partial lunar eclipse has no totality contacts.
    const partial = upcomingEvents(HANOI, Date.parse('2026-08-20T00:00:00Z'), 15).find((e) => e.kind === 'lunar-eclipse');
    assert.equal(partial.eclipseKind, 'partial');
    assert.equal(partial.u2Ms, null);
    assert.equal(partial.u3Ms, null);
    assert.ok(partial.u1Ms < partial.maxMs && partial.u4Ms > partial.maxMs);
});

test('a global central eclipse quotes the central duration at greatest eclipse', () => {
    const total = madrid2027.find((e) => e.kind === 'solar-eclipse' && e.eclipseKind === 'total');
    near(total.geo.durS, 386.9, 1, 'AE at the greatest point');
    assert.match(total.detail, /, up to 6 m 2\d s$/);
});
