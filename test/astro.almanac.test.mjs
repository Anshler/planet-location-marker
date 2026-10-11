// Almanac (SPEC §C.2, §H): rise/transit/set, twilight, Sun-altitude series and tonight verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import { BODIES, BODY_IDS } from '../js/astro/bodies.js';
import { riseTransitSet, twilight, sunAltitudeSeries, tonight, compass16, aeObserverOf } from '../js/astro/almanac.js';
import { twilightClass } from '../js/astro/photometry.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const GREENWICH = { latDeg: 51.4769, lonDeg: -0.0005, elevM: 0, tz: 'Europe/London' };
const HANOI = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15, tz: 'Asia/Ho_Chi_Minh' };
const TROMSO = { latDeg: 69.6492, lonDeg: 18.9553, elevM: 0, tz: 'Europe/Oslo' };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

function direct(body, o, dir, fromMs, days) {
    const t = AE.SearchRiseSet(body, new AE.Observer(o.latDeg, o.lonDeg, o.elevM), dir, AE.MakeTime(new Date(fromMs)), days);
    return t ? t.date.getTime() : null;
}

for (const [label, o, isoDay, offsetH] of [
    ['Greenwich', GREENWICH, '2026-06-21', 1],
    ['Greenwich', GREENWICH, '2026-12-21', 0],
    ['Hanoi', HANOI, '2026-10-11', 7],
    ['Hanoi', HANOI, '2027-03-20', 7],
]) {
    test(`${label} ${isoDay}: sunrise and sunset match direct SearchRiseSet within 1 s`, () => {
        const fromMs = Date.parse(`${isoDay}T00:00:00Z`) - offsetH * HOUR; // local midnight
        const r = riseTransitSet('sun', o, fromMs, fromMs + DAY);
        assert.equal(r.status, 'normal');
        close(r.riseMs, direct('Sun', o, +1, fromMs, 1), 1000, 'sunrise');
        close(r.setMs, direct('Sun', o, -1, fromMs, 1), 1000, 'sunset');
        assert.ok(r.riseMs < r.transitMs && r.transitMs < r.setMs, 'rise < transit < set on a normal day');
        assert.ok(r.transitAltDeg > 0 && r.transitAltDeg <= 90);
        assert.ok(r.riseAzDeg > 0 && r.riseAzDeg < 180, 'rises in the east');
        assert.ok(r.setAzDeg > 180 && r.setAzDeg < 360, 'sets in the west');
    });
}

test('transit is the hour-angle-0 crossing, with its refracted altitude', () => {
    const fromMs = Date.parse('2026-10-10T17:00:00Z');
    const r = riseTransitSet('saturn', HANOI, fromMs, fromMs + DAY);
    const obs = new AE.Observer(HANOI.latDeg, HANOI.lonDeg, HANOI.elevM);
    const ha = AE.SearchHourAngle('Saturn', obs, 0, AE.MakeTime(new Date(fromMs)), +1);
    close(r.transitMs, ha.time.date.getTime(), 1);
    close(r.transitAltDeg, ha.hor.altitude, 1e-9);
    // Saturn near opposition culminates high over Hanoi (dec ≈ −1°, lat 21° → ≈ 68–71°).
    assert.ok(r.transitAltDeg > 60);
});

test('Tromsø 2026-06-21: the Sun is circumpolar; on 2026-12-21 it never rises', () => {
    const june = Date.parse('2026-06-20T22:00:00Z');
    const s = riseTransitSet('sun', TROMSO, june, june + DAY);
    assert.equal(s.status, 'circumpolar');
    assert.equal(s.riseMs, null);
    assert.equal(s.setMs, null);
    assert.ok(s.transitMs !== null && s.transitAltDeg > 40);
    const dec = Date.parse('2026-12-20T23:00:00Z');
    const w = riseTransitSet('sun', TROMSO, dec, dec + DAY);
    assert.equal(w.status, 'never');
    assert.ok(w.transitAltDeg < 0);
});

test('every body gets a well-formed result over a local day', () => {
    const fromMs = Date.parse('2026-10-10T17:00:00Z');
    for (const id of BODY_IDS) {
        const r = riseTransitSet(id, HANOI, fromMs, fromMs + DAY);
        for (const k of ['riseMs', 'transitMs', 'setMs']) {
            assert.ok(r[k] === null || (r[k] >= fromMs && r[k] <= fromMs + DAY), `${id} ${k} inside the interval`);
        }
        assert.ok(['normal', 'circumpolar', 'never'].includes(r.status));
        assert.equal(typeof r.transitAltDeg, 'number');
    }
});

test('riseTransitSet validates its inputs', () => {
    assert.throws(() => riseTransitSet('pluto', HANOI, 0, DAY), RangeError);
    assert.throws(() => riseTransitSet('sun', HANOI, DAY, 0), RangeError);
    assert.throws(() => riseTransitSet('sun', HANOI, NaN, DAY), TypeError);
    assert.throws(() => riseTransitSet('sun', { latDeg: 'x', lonDeg: 0 }, 0, DAY), TypeError);
    const clamped = aeObserverOf({ latDeg: 95, lonDeg: 10, elevM: -2000 });
    assert.equal(clamped.latitude, 90);
    assert.equal(clamped.height, -500);
});

test('twilight returns events in the correct order (Greenwich, Hanoi; during the day and during the night)', () => {
    const order = ['sunsetMs', 'civilDuskMs', 'nauticalDuskMs', 'astroDuskMs', 'astroDawnMs', 'nauticalDawnMs', 'civilDawnMs', 'sunriseMs'];
    for (const [o, nearIso] of [
        [GREENWICH, '2026-10-11T12:00:00Z'],
        [GREENWICH, '2026-10-12T02:00:00Z'],
        [HANOI, '2026-10-11T05:00:00Z'],
        [HANOI, '2026-10-11T20:00:00Z'],
    ]) {
        const tw = twilight(o, Date.parse(nearIso));
        const times = order.map((k) => tw[k]);
        for (const [i, v] of times.entries()) assert.equal(typeof v, 'number', `${order[i]} present at ${nearIso}`);
        for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] < times[i], `${order[i - 1]} < ${order[i]} at ${nearIso}`);
        assert.ok(times[7] - times[0] < DAY, 'one night');
        // The Sun really is at the advertised altitudes.
        const obs = new AE.Observer(o.latDeg, o.lonDeg, o.elevM);
        for (const [k, alt] of [['civilDuskMs', -6], ['nauticalDuskMs', -12], ['astroDawnMs', -18]]) {
            const t = AE.MakeTime(new Date(tw[k]));
            const eq = AE.Equator('Sun', t, obs, true, true);
            close(AE.Horizon(t, obs, eq.ra, eq.dec).altitude, alt, 0.01, k);
        }
    }
});

test('twilight picks the night in progress, or the coming night while the Sun is up', () => {
    const day = twilight(HANOI, Date.parse('2026-10-11T05:00:00Z'));      // 12:00 local
    const night = twilight(HANOI, Date.parse('2026-10-11T19:00:00Z'));    // 02:00 local, same night
    assert.equal(day.sunsetMs, night.sunsetMs);
    assert.ok(day.sunsetMs > Date.parse('2026-10-11T05:00:00Z'));
    assert.ok(night.sunsetMs < Date.parse('2026-10-11T19:00:00Z') && night.sunriseMs > Date.parse('2026-10-11T19:00:00Z'));
    const morning = twilight(HANOI, Date.parse('2026-10-11T00:30:00Z')); // 07:30 local, after sunrise → tonight
    assert.equal(morning.sunsetMs, day.sunsetMs);
});

test('twilight in polar summer and polar night: missing events are null, present ones stay ordered', () => {
    const summer = twilight(TROMSO, Date.parse('2026-06-21T12:00:00Z'));
    assert.ok(Object.values(summer).every((v) => v === null));
    const winter = twilight(TROMSO, Date.parse('2026-12-21T12:00:00Z'));
    assert.equal(winter.sunsetMs, null);
    assert.equal(winter.sunriseMs, null);
    assert.ok(winter.civilDuskMs < winter.nauticalDuskMs && winter.nauticalDuskMs < winter.astroDuskMs);
    assert.ok(winter.astroDuskMs < winter.astroDawnMs && winter.astroDawnMs < winter.civilDawnMs);
});

test('sunAltitudeSeries: n samples, inclusive endpoints, matching AE and classifiable', () => {
    const from = Date.parse('2026-06-21T00:00:00Z');
    const s = sunAltitudeSeries(GREENWICH, from, from + DAY, 97);
    assert.ok(s instanceof Float32Array);
    assert.equal(s.length, 97);
    const obs = new AE.Observer(GREENWICH.latDeg, GREENWICH.lonDeg, 0);
    for (const i of [0, 48, 96]) {
        const t = AE.MakeTime(new Date(from + (i * DAY) / 96));
        const eq = AE.Equator('Sun', t, obs, true, true);
        close(s[i], AE.Horizon(t, obs, eq.ra, eq.dec).altitude, 1e-4, `sample ${i}`);
    }
    const max = Math.max(...s);
    close(max, 90 - 51.4769 + 23.44, 0.2, 'solstice noon altitude');
    assert.equal(twilightClass(s[48]), 'day');
    assert.equal(twilightClass(s[0]), 'astronomical'); // lat + dec − 90 ≈ −15° at midnight in June
    assert.equal(sunAltitudeSeries(GREENWICH, from, from + DAY, 1).length, 1);
    assert.throws(() => sunAltitudeSeries(GREENWICH, from, from + DAY, 0), RangeError);
});

test('tonight: Hanoi 2026-10-11 — Saturn near opposition is excellent; the 1-day-old Moon is lost in the glare', () => {
    const t = tonight(HANOI, Date.parse('2026-10-11T08:00:00Z'));
    assert.equal(t.reports.length, 8);
    assert.deepEqual(t.reports.map((r) => r.id), BODIES.slice(1).map((b) => b.id), 'BODIES order without the Sun');
    assert.ok(t.nightStartMs < t.nightEndMs);
    assert.equal(t.nightStartMs, t.twilight.sunsetMs);
    assert.equal(t.nightEndMs, t.twilight.sunriseMs);
    const saturn = t.reports.find((r) => r.id === 'saturn');
    assert.equal(saturn.verdict, 'excellent');
    assert.equal(saturn.equipment, 'naked-eye');
    assert.ok(saturn.bestAltDeg > 60 && saturn.bestMs > t.nightStartMs && saturn.bestMs < t.nightEndMs);
    assert.ok(saturn.windowStartMs <= saturn.bestMs && saturn.bestMs <= saturn.windowEndMs);
    assert.match(saturn.sentence, /^Saturn: excellent, highest \d\d:\d\d at \d+° [NESW]{1,3}, mag −?\d\.\d in [A-Z][a-z]+/);
    assert.equal(saturn.constellation.symbol.length, 3);
    const moon = t.reports.find((r) => r.id === 'moon');
    assert.equal(moon.verdict, 'not-visible');
    assert.equal(moon.bestMs, null);
    assert.match(moon.sentence, /not visible tonight/);
    const neptune = t.reports.find((r) => r.id === 'neptune');
    assert.equal(neptune.equipment, 'telescope');
    assert.match(neptune.sentence, /\(telescope\)$/);
    assert.equal(t.reports.find((r) => r.id === 'uranus').equipment, 'binoculars');
});

test('tonight: verdict rules hold for every report across observers and seasons', () => {
    const verdicts = new Set(['excellent', 'good', 'low', 'twilight', 'daytime', 'not-visible']);
    for (const [o, iso] of [[HANOI, '2027-02-10T12:00:00Z'], [GREENWICH, '2026-12-01T18:00:00Z'], [{ latDeg: -33.86, lonDeg: 151.21, elevM: 0, tz: 'Australia/Sydney' }, '2026-07-15T03:00:00Z']]) {
        const t = tonight(o, Date.parse(iso), { hour12: true });
        for (const r of t.reports) {
            assert.ok(verdicts.has(r.verdict), r.verdict);
            assert.equal(typeof r.sentence, 'string');
            assert.ok(r.sentence.startsWith(`${r.name}:`));
            if (r.verdict === 'not-visible') {
                assert.equal(r.bestMs, null);
                assert.equal(r.windowStartMs, null);
            } else {
                assert.ok(r.bestAltDeg > 5, `${r.id} best altitude ${r.bestAltDeg}`);
                assert.ok(r.windowStartMs <= r.bestMs && r.bestMs <= r.windowEndMs);
                assert.equal(r.compass, compass16(r.bestAzDeg));
            }
            if (r.verdict === 'excellent') assert.ok(r.bestAltDeg > 30);
            if (r.id !== 'moon' && r.id !== 'venus' && r.elongDeg < 12) assert.equal(r.verdict, 'not-visible');
            if (r.verdict === 'daytime') assert.ok(r.id === 'moon' || r.id === 'venus');
            if (r.verdict !== 'not-visible' && r.id !== 'moon') assert.match(r.sentence, /(AM|PM)/, '12-hour clock honoured');
        }
    }
});

test('tonight under the midnight sun has no night and nothing better than daytime sightings', () => {
    const t = tonight(TROMSO, Date.parse('2026-06-21T12:00:00Z'));
    assert.equal(t.nightStartMs, null);
    assert.equal(t.nightEndMs, null);
    for (const r of t.reports) assert.ok(r.verdict === 'daytime' || r.verdict === 'not-visible', `${r.id}: ${r.verdict}`);
});

test('tonight in polar night treats the whole day as night', () => {
    const t = tonight(TROMSO, Date.parse('2026-12-21T12:00:00Z'));
    assert.ok(t.nightEndMs - t.nightStartMs >= DAY - 60e3);
    assert.ok(t.reports.some((r) => r.verdict === 'excellent'), 'something is excellent in a 24-h night');
});

test('tonight formats times in the observer zone, and an unknown zone falls back to UTC instead of failing', () => {
    const near = Date.parse('2026-10-11T08:00:00Z');
    const local = tonight(HANOI, near).reports.find((r) => r.id === 'saturn');
    const utc = tonight({ ...HANOI, tz: 'Not/AZone' }, near).reports.find((r) => r.id === 'saturn');
    const hhmm = (s) => s.match(/highest (\d\d):(\d\d)/).slice(1).map(Number);
    const [lh, lm] = hhmm(local.sentence);
    const [uh, um] = hhmm(utc.sentence);
    assert.equal(((lh * 60 + lm) - (uh * 60 + um) + 1440) % 1440, 7 * 60, 'UTC+7');
});

test('compass16', () => {
    assert.deepEqual([0, 22.5, 45, 90, 135, 180, 225, 270, 315, 349, 359.9, -10].map(compass16),
        ['N', 'NNE', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'N', 'N']);
    assert.equal(compass16(118), 'ESE');
});
