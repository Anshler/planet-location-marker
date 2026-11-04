// Julian calendar display before 15 October 1582 (core/tz.js, core/format.js; ROADMAP historic-skies).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    jdnFromGregorian, jdnFromJulian, gregorianFromJdn, julianFromJdn, toCalendar, fromCalendar,
    daysInMonthCal, parseCalendarInput, isJulianEra, zonedToUtc,
} from '../js/core/tz.js';
import { fmtDate } from '../js/core/format.js';
import { AE } from '../js/astro/ae.js';

test('Julian Day Numbers match the published epochs', () => {
    assert.equal(jdnFromGregorian(2000, 1, 1), 2451545);            // J2000.0's day
    assert.equal(jdnFromJulian(1582, 10, 4), 2299160);              // last Julian day
    assert.equal(jdnFromGregorian(1582, 10, 15), 2299161);          // first Gregorian day
    assert.equal(jdnFromJulian(-4712, 1, 1), 0);                    // the JD epoch
    for (const jdn of [2086308, 2299160, 2299161, 2451545, 2816788]) {
        const g = gregorianFromJdn(jdn), j = julianFromJdn(jdn);
        assert.equal(jdnFromGregorian(g.y, g.mo, g.d), jdn);
        assert.equal(jdnFromJulian(j.y, j.mo, j.d), jdn);
    }
});

test('dates before 15 Oct 1582 show in the Julian calendar, weekdays shared', () => {
    // The SN 1054 first sighting: 4 July 1054 (Julian) is 10 July proleptic Gregorian.
    assert.equal(fmtDate(Date.UTC(1054, 6, 10, 12), 'UTC'), 'Mon 4 Jul 1054');
    assert.equal(fmtDate(Date.UTC(1054, 6, 10, 12), 'UTC', { calendar: true }), 'Mon 4 Jul 1054 (Julian)');
    // The reform: Thursday 4 October was followed by Friday 15 October 1582.
    assert.equal(fmtDate(Date.UTC(1582, 9, 14, 12), 'UTC'), 'Thu 4 Oct 1582');
    assert.equal(fmtDate(Date.UTC(1582, 9, 15, 12), 'UTC'), 'Fri 15 Oct 1582');
    assert.equal(fmtDate(Date.UTC(2026, 10, 4, 12), 'UTC', { calendar: true }), 'Wed 4 Nov 2026');
    // Hastings: Halley's comet was seen from 24 April 1066 (Julian) = 30 April Gregorian.
    assert.deepEqual(fromCalendar(1066, 4, 24), { y: 1066, mo: 4, d: 30 });
    assert.equal(toCalendar({ y: 1066, mo: 4, d: 30 }).cal, 'julian');
    assert.equal(toCalendar({ y: 1700, mo: 1, d: 1 }).cal, 'gregorian');
    assert.ok(isJulianEra(1582, 10, 14) && !isJulianEra(1582, 10, 15));
});

test("Columbus's lunar eclipse falls on 29 February 1504 (Julian) in Jamaica", () => {
    // Astronomy Engine works in proleptic Gregorian: the eclipse peaks 1504-03-11 00:40 UT.
    const e = AE.SearchLunarEclipse(new Date(Date.UTC(1504, 2, 5)));
    assert.equal(e.kind, 'total');
    const ms = e.peak.date.getTime();
    assert.equal(new Date(ms).toISOString().slice(0, 13), '1504-03-11T00');
    assert.equal(fmtDate(ms, 'America/Jamaica'), 'Thu 29 Feb 1504');
    assert.equal(fmtDate(ms, 'UTC'), 'Fri 1 Mar 1504');
    // 29 Feb 1504 exists in both calendars (1504 is a leap year either way).
    assert.deepEqual(fromCalendar(1504, 2, 29), { y: 1504, mo: 3, d: 10 });
});

test('Julian-only leap days and the ten missing days', () => {
    assert.equal(daysInMonthCal(1500, 2, 'julian'), 29);
    assert.equal(daysInMonthCal(1500, 2, 'gregorian'), 28);
    assert.equal(daysInMonthCal(1600, 2, 'gregorian'), 29);
    assert.deepEqual(parseCalendarInput('1500-02-29 12:00'), { y: 1500, mo: 2, d: 29, h: 12, mi: 0, s: 0, cal: 'julian' });
    assert.equal(parseCalendarInput('1700-02-29'), null);
    assert.equal(parseCalendarInput('1582-10-10T12:00'), null);
    assert.equal(parseCalendarInput('1582-10-04T23:59:59')?.cal, 'julian');
    assert.equal(parseCalendarInput('1582-10-15')?.cal, 'gregorian');
    assert.deepEqual(parseCalendarInput('24 Apr 1066 20:00'), { y: 1066, mo: 4, d: 24, h: 20, mi: 0, s: 0, cal: 'julian' });
    assert.deepEqual(parseCalendarInput('4 July 1054, 05:30'), { y: 1054, mo: 7, d: 4, h: 5, mi: 30, s: 0, cal: 'julian' });
    assert.deepEqual(parseCalendarInput('2027-08-02T10:07:00'), { y: 2027, mo: 8, d: 2, h: 10, mi: 7, s: 0, cal: 'gregorian' });
    for (const bad of ['', 'yesterday', '1066-13-01', '31 Apr 2026', '1066-04-24 25:00', '12 Foo 1066']) {
        assert.equal(parseCalendarInput(bad), null, bad);
    }
});

test('overflowing days step across the reform in the calendar they started in', () => {
    // 4 Oct 1582 (Julian) + 1 day → 15 Oct 1582 (Gregorian).
    assert.deepEqual(fromCalendar(1582, 10, 5, 'julian'), { y: 1582, mo: 10, d: 15 });
    assert.deepEqual(fromCalendar(1054, 12, 32, 'julian'), fromCalendar(1055, 1, 1, 'julian'));
    assert.deepEqual(fromCalendar(1054, 13, 1, 'julian'), fromCalendar(1055, 1, 1, 'julian'));
    // A typed Julian wall time in a zone → the instant (UTC ms): Hastings, 24 Apr 1066 20:00 UTC.
    const p = parseCalendarInput('1066-04-24 20:00');
    const g = fromCalendar(p.y, p.mo, p.d, p.cal);
    assert.equal(zonedToUtc({ ...g, h: p.h, mi: p.mi }, 'UTC'), Date.UTC(1066, 3, 30, 20));
});
