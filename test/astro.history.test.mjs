// History's skies: guest stars (astro/guest-stars.js), the Moments and Famous comets
// (core/moments.js) and 'the sky you were born under' (astro/sky-caption.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_STARS, guestById, guestMagnitude, guestRiseSet, createGuestProvider } from '../js/astro/guest-stars.js';
import { MOMENTS, FAMOUS_COMETS } from '../js/core/moments.js';
import { skyCaption } from '../js/astro/sky-caption.js';
import { parseHash } from '../js/core/url-state.js';
import { DEFAULT_STATE } from '../js/core/store.js';
import { MIN_MS, MAX_MS } from '../js/core/clock.js';
import { createExtras } from '../js/astro/extras.js';
import { createCometProvider } from '../js/astro/comets.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { raDecToScene } from '../js/astro/frames.js';
import { fromCalendar } from '../js/core/tz.js';
import { fmtDate } from '../js/core/format.js';

const DAY = 864e5;
const cosSep = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('guest stars: five supernovae at their remnants, dated as recorded', () => {
    assert.deepEqual(GUEST_STARS.map((g) => g.id), ['guest:sn1006', 'guest:sn1054', 'guest:sn1181', 'guest:tycho1572', 'guest:kepler1604']);
    // SN 1054 was recorded "near ζ Tauri" (5h37m38.7s, +21°08′33″): the Crab is 1.1° from it.
    const zeta = raDecToScene((5 + 37 / 60 + 38.7 / 3600) * 15, 21 + 8 / 60 + 33 / 3600);
    const sep = Math.acos(cosSep(guestById('guest:sn1054').dirS, zeta)) * 180 / Math.PI;
    assert.ok(sep > 0.8 && sep < 1.5, `${sep}°`);
    // 4 July 1054 is a Julian date: the first sighting is 10 July proleptic Gregorian.
    const g = guestById('guest:sn1054');
    assert.equal(fmtDate(g.peakMs, 'UTC'), 'Mon 4 Jul 1054');
    const k = guestById('guest:kepler1604');
    assert.equal(new Date(k.peakMs).toISOString().slice(0, 10), '1604-10-28', 'after 1582: Gregorian as recorded');
});

test('guest-star cards: the first-recorded date as recorded, and whole days since it', () => {
    const reg = createExtras();
    reg.register(createGuestProvider());
    const snap = createSnapshot();
    // 1054-07-20T12:00Z is 14 July (Julian) in Kaifeng: day 10 after the record of 4 July.
    computeSnapshot(Date.UTC(1054, 6, 20, 12), { latDeg: 34.7972, lonDeg: 114.3076, elevM: 0 }, snap, { detail: 'full' });
    reg.fill(snap);
    const card = reg.card('guest:sn1054', snap);
    assert.match(card.lines[0], /^Day 10 since it was first recorded \(4 Jul 1054\)/);
    for (const [id, when] of [['guest:sn1006', '30 Apr 1006'], ['guest:tycho1572', '6 Nov 1572'], ['guest:kepler1604', '9 Oct 1604']]) {
        const g = guestById(id);
        computeSnapshot(g.peakMs, { latDeg: 45, lonDeg: 0, elevM: 0 }, snap, { detail: 'full' });
        reg.fill(snap);
        assert.ok(reg.card(id, snap).lines[0].includes(`first recorded (${when})`), `${id}: ${reg.card(id, snap).lines[0]}`);
    }
});

test('light curves: unseen before the record, at the peak on the day, fading past the eye near the last record', () => {
    for (const g of GUEST_STARS) {
        assert.ok(Number.isNaN(guestMagnitude(g, g.firstMs - DAY)), `${g.id} before`);
        assert.ok(Math.abs(guestMagnitude(g, g.peakMs) - g.peakMag) < 1e-9);
        assert.ok(guestMagnitude(g, g.peakMs + 30 * DAY) > g.peakMag + 2);
        const atLast = guestMagnitude(g, g.lastMs);
        assert.ok(atLast > 4 && atLast < 7, `${g.id}: mag ${atLast.toFixed(2)} at the last record`);
    }
    // SN 1054: day-bright (≤ −4) for its 23 recorded days of daylight visibility.
    const c = guestById('guest:sn1054');
    assert.ok(guestMagnitude(c, c.peakMs + 22 * DAY) < -3.9);
    assert.ok(guestMagnitude(c, c.peakMs + 30 * DAY) > -3.9);
});

test('rise, transit and set from Astronomy Engine’s user-defined star', () => {
    const g = guestById('guest:tycho1572');
    const day0 = Date.UTC(1572, 10, 21);
    const r = guestRiseSet(g, { latDeg: 56.0866, lonDeg: 13.241 }, day0);
    // Circumpolar from Herrevad (dec +64° > 90° − 56°): no rise or set. It culminates north of the
    // zenith at 90° − (δ − φ): 82° with the J2000 δ, 84.3° with 1572's δ of date (precession, 2.4°).
    assert.equal(r.riseMs, null);
    assert.equal(r.setMs, null);
    assert.ok(Math.abs(r.transitAltDeg - 84.3) < 0.2, `${r.transitAltDeg}`);
    const k = guestRiseSet(guestById('guest:kepler1604'), { latDeg: 50.0875, lonDeg: 14.4214 }, Date.UTC(1604, 9, 17));
    assert.ok(k.riseMs && k.setMs && k.transitMs);
});

test('every Moment is a valid link that shows what its caption promises', () => {
    const reg = createExtras();
    reg.register(createGuestProvider());
    reg.register(createCometProvider());
    const snap = createSnapshot();
    const ids = new Set();
    for (const m of [...MOMENTS, ...FAMOUS_COMETS]) {
        assert.ok(!ids.has(m.id), m.id);
        ids.add(m.id);
        const p = parseHash(m.hash);
        assert.deepEqual(p.invalid ?? [], [], `${m.id}: ${p.invalid}`);
        assert.ok(p.tMs >= MIN_MS && p.tMs <= MAX_MS && p.playing === false && p.intro === false, m.id);
        assert.ok(p.observer && p.observer.tz, m.id);
        // The view is always named (a hash without it keeps the current one) and matches the camera.
        assert.ok(p.view && (!p.cam || p.cam.mode === p.view), `${m.id}: view ${p.view}, cam ${p.cam?.mode}`);
        // A Moment's layers add to the defaults, never turn one off (prefs would keep it off).
        if (p.layers) {
            for (const [k, on] of Object.entries(DEFAULT_STATE.layers)) if (on) assert.ok(p.layers[k], `${m.id}: layer ${k} kept`);
        }
        if (MOMENTS.includes(m)) assert.ok(m.caption.length > 40 && m.sources.length > 0, m.id);
        // The selected extra object is in the sky, above the horizon.
        if (p.selection && p.selection.includes(':') && !p.selection.startsWith('craft:')) {
            computeSnapshot(p.tMs, p.observer, snap, { detail: 'full' });
            reg.fill(snap);
            const st = reg.state(snap, p.selection);
            assert.ok(st && st.present, `${m.id}: ${p.selection} present`);
            assert.ok(st.altDeg > 5, `${m.id}: ${p.selection} at ${st.altDeg.toFixed(1)}°`);
            assert.ok(st.mag < 5, `${m.id}: mag ${st.mag}`);
        }
    }
    // Columbus: the Moon in total eclipse, up in the east, on 29 Feb 1504 (Julian) in Jamaica.
    const jam = parseHash(MOMENTS.find((m) => m.id === 'jamaica-1504').hash);
    computeSnapshot(jam.tMs, jam.observer, snap, { detail: 'full' });
    assert.ok(snap.eclipse.lunar && snap.bodies[1].altDeg > 10);
    assert.equal(fmtDate(jam.tMs, 'America/Jamaica'), 'Thu 29 Feb 1504');
    assert.deepEqual(fromCalendar(1504, 2, 29), { y: 1504, mo: 3, d: 10 });
});

test('the sky you were born under: a caption from a full snapshot', () => {
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(1990, 6, 1, 21), { latDeg: 51.5, lonDeg: -0.1, elevM: 0 }, snap, { detail: 'full' });
    const text = skyCaption(snap);
    assert.match(text, /^Jupiter was in [A-Z][a-z]+(?: [A-Z][a-z]+)?, Saturn in /);
    assert.match(text, /The Moon was \d+% lit, in [A-Z]/);
    const frame = createSnapshot();
    computeSnapshot(Date.UTC(1990, 6, 1, 21), { latDeg: 51.5, lonDeg: -0.1, elevM: 0 }, frame, { detail: 'frame' });
    assert.equal(skyCaption(frame), '', 'needs the full detail');
});
