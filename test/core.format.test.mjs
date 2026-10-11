// Tests for js/core/format.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fmtDate, fmtTime, fmtDateTime, fmtRA, fmtDec, fmtDeg, fmtAlt, fmtAz, compass16, compassWord, fmtDistAU, fmtDistKm,
    fmtLightTime, fmtRate, fmtMag, fmtPct, fmtLatLon, fmtRelative, fmtDuration, fmtAngSize, fmtInt, moonPhaseName, moonAgeDays,
} from '../js/core/format.js';
import { RATES } from '../js/core/clock.js';

const M = String.fromCharCode(0x2212); // minus sign
const DASH = String.fromCharCode(0x2014);
const T = Date.parse('2026-10-11T13:14:05Z'); // a Sunday

test('spec examples', () => {
    assert.equal(fmtRA(6.7525), '6h 45m 09s');
    assert.equal(fmtDec(-(16 + 43 / 60 + 10 / 3600)), `${M}16° 43′ 10″`);
    assert.equal(fmtAlt(34.2), '34.2°');
    assert.equal(fmtAz(118), '118° ESE');
    assert.equal(fmtDistAU(1.524), '1.524 AU · 228.0 million km');
    assert.equal(fmtLightTime(1.28), '1.3 s');
    assert.equal(fmtLightTime(499), '8 min 19 s');
    assert.equal(fmtLightTime(4860), '1 h 21 min');
    assert.equal(fmtRate(1), 'Real time');
    assert.equal(fmtRate(10), '10×');
    assert.equal(fmtRate(60), '1 min/s');
    assert.equal(fmtRate(3600), '1 h/s');
    assert.equal(fmtRate(-86400), `${M}1 d/s`);
    assert.equal(fmtRate(31557600), '1 yr/s');
    assert.equal(fmtMag(-4.3), `${M}4.3`);
    assert.equal(fmtRelative(T + (3 * 3600 + 12 * 60) * 1000, T), 'in 3 h 12 min');
});

test('dates and times in a zone (weekday computed, not localised)', () => {
    assert.equal(fmtDate(T, 'Asia/Ho_Chi_Minh'), 'Sun 11 Oct 2026');
    assert.equal(fmtDate(T, 'Pacific/Chatham'), 'Mon 12 Oct 2026', 'already Monday east of the date line');
    assert.equal(fmtDate(T, 'UTC', { weekday: false }), '11 Oct 2026');
    assert.equal(fmtDate(T, 'UTC', { weekday: false, year: false }), '11 Oct');
    assert.equal(fmtTime(T, 'Asia/Ho_Chi_Minh'), '20:14:05');
    assert.equal(fmtTime(T, 'Asia/Ho_Chi_Minh', true), '8:14:05 PM');
    assert.equal(fmtTime(T, 'Asia/Ho_Chi_Minh', false, { seconds: false }), '20:14');
    assert.equal(fmtTime(Date.parse('2026-10-11T00:05:00Z'), 'UTC', true), '12:05:00 AM');
    assert.equal(fmtTime(Date.parse('2026-10-11T12:05:00Z'), 'UTC', true), '12:05:00 PM');
    assert.equal(fmtDateTime(T, 'Asia/Saigon'), 'Sun 11 Oct 2026 · 20:14:05');
    assert.equal(fmtDateTime(T, 'UTC', true, { seconds: false, weekday: false }), '11 Oct 2026 · 1:14 PM');
    assert.equal(fmtDate(Date.UTC(1000, 0, 1), 'UTC'), 'Wed 1 Jan 1000', 'proleptic Gregorian weekday');
    assert.equal(fmtDate(Date.UTC(2999, 11, 31), 'UTC'), 'Tue 31 Dec 2999');
    assert.equal(fmtDate(Date.UTC(2000, 1, 29), 'UTC'), 'Tue 29 Feb 2000');
    assert.equal(fmtDate(T, 'Not/AZone'), 'Sun 11 Oct 2026', 'bad zone → UTC');
    assert.equal(fmtDate(Number.NaN, 'UTC'), DASH);
    assert.equal(fmtTime(Number.NaN, 'UTC'), DASH);
    assert.equal(fmtDateTime(Number.NaN, 'UTC'), DASH);
});

test('weekdays agree with Date for many random days', () => {
    const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 400; i++) {
        const t = Date.UTC(1000, 0, 1) + Math.floor(((i * 7919) % 400) / 400 * 730000) * 864e5 + i * 1e6;
        assert.equal(fmtDate(t, 'UTC').slice(0, 3), W[new Date(t).getUTCDay()]);
    }
});

test('right ascension and declination', () => {
    assert.equal(fmtRA(0), '0h 00m 00s');
    assert.equal(fmtRA(23.99999), '0h 00m 00s', 'rounding wraps to 0h');
    assert.equal(fmtRA(-1), '23h 00m 00s');
    assert.equal(fmtRA(25.5), '1h 30m 00s');
    assert.equal(fmtRA(101.2872 / 15), '6h 45m 09s', 'Sirius');
    assert.equal(fmtDec(7.4071), '+7° 24′ 26″');
    assert.equal(fmtDec(0), '+0° 00′ 00″');
    assert.equal(fmtDec(-0.0000001), '+0° 00′ 00″', 'no negative zero');
    assert.equal(fmtDec(-89.99999), `${M}90° 00′ 00″`);
    assert.equal(fmtDec(-16.7161), `${M}16° 42′ 58″`);
    assert.equal(fmtRA('x'), DASH);
    assert.equal(fmtDec(Number.NaN), DASH);
});

test('altitude, degrees and azimuth', () => {
    assert.equal(fmtAlt(-5.27), `${M}5.3°`);
    assert.equal(fmtAlt(-0.04), '0.0°', 'no negative zero');
    assert.equal(fmtDeg(46.94, 1), '46.9°');
    assert.equal(fmtDeg(-12.345, 2), `${M}12.35°`);
    assert.equal(fmtAz(0), '0° N');
    assert.equal(fmtAz(359.7), '0° N');
    assert.equal(fmtAz(90), '90° E');
    assert.equal(fmtAz(-90), '270° W');
    assert.equal(fmtAz(725), '5° N');
    assert.equal(fmtAz(Infinity), DASH);
});

test('compass points', () => {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    names.forEach((n, i) => {
        assert.equal(compass16(i * 22.5), n);
        assert.equal(compass16(i * 22.5 + 11), n, 'within the sector');
        assert.equal(compass16(i * 22.5 - 11), n);
    });
    assert.equal(compass16(-22.5), 'NNW');
    assert.equal(compassWord(135), 'south-east');
    assert.equal(compassWord(0), 'north');
    assert.equal(compassWord(200), 'south');
    assert.equal(compassWord(337.6), 'north');
    assert.equal(compass16(Number.NaN), DASH);
});

test('distances', () => {
    assert.equal(fmtDistKm(384400), '384,400 km');
    assert.equal(fmtDistKm(999), '999 km');
    assert.equal(fmtDistKm(999999.6), '1.0 million km', 'no "1,000,000 km"');
    assert.equal(fmtDistKm(227987155), '228.0 million km');
    assert.equal(fmtDistKm(999990000), '1.00 billion km', 'no "1000.0 million km"');
    assert.equal(fmtDistKm(1.43e9), '1.43 billion km');
    assert.equal(fmtDistKm(-5), DASH);
    assert.equal(fmtDistAU(0.0025695), '0.00257 AU · 384,392 km');
    assert.equal(fmtDistAU(9.54), '9.540 AU · 1.43 billion km', 'three decimals below 10 AU');
    assert.equal(fmtDistAU(30.07), '30.07 AU · 4.50 billion km');
    assert.equal(fmtDistAU(0.98329), '0.983 AU · 147.1 million km');
    assert.equal(fmtDistAU(Number.NaN), DASH);
    assert.equal(fmtInt(-1234567.4), `${M}1,234,567`);
    assert.equal(fmtInt(0), '0');
});

test('durations, light time and relative time', () => {
    assert.equal(fmtLightTime(0), '0.0 s');
    assert.equal(fmtLightTime(9.94), '9.9 s');
    assert.equal(fmtLightTime(9.96), '10 s');
    assert.equal(fmtLightTime(59.6), '1 min');
    assert.equal(fmtLightTime(480), '8 min');
    assert.equal(fmtLightTime(3599.6), '1 h');
    assert.equal(fmtLightTime(14940), '4 h 9 min', 'Neptune-scale');
    assert.equal(fmtLightTime(-1), DASH);
    assert.equal(fmtDuration(40e3), '40 s');
    assert.equal(fmtDuration(45 * 6e4), '45 min');
    assert.equal(fmtDuration(3 * 36e5), '3 h');
    assert.equal(fmtDuration((2 * 24 + 4) * 36e5), '2 d 4 h');
    assert.equal(fmtDuration(5 * 864e5), '5 d');
    assert.equal(fmtDuration(150 * 864e5), '5 mo');
    assert.equal(fmtDuration(2.5 * 365.25 * 864e5), '2.5 yr');
    assert.equal(fmtRelative(T - 25 * 6e4, T), '25 min ago');
    assert.equal(fmtRelative(T + 10e3, T), 'now');
    assert.equal(fmtRelative(T + 3 * 864e5 + 2 * 36e5, T), 'in 3 d 2 h');
    assert.equal(fmtRelative(Number.NaN, T), DASH);
});

test('rates: every ladder value and off-ladder timelapse rates', () => {
    const expected = new Map([
        [1, 'Real time'], [10, '10×'], [60, '1 min/s'], [600, '10 min/s'], [3600, '1 h/s'], [21600, '6 h/s'],
        [86400, '1 d/s'], [604800, '7 d/s'], [2592000, '30 d/s'], [31557600, '1 yr/s'],
    ]);
    for (const r of RATES) {
        const pos = expected.get(Math.abs(r));
        if (r > 0) assert.equal(fmtRate(r), pos);
        else assert.equal(fmtRate(r), r === -1 ? `${M}1×` : `${M}${pos}`);
    }
    assert.equal(fmtRate(864000), '10 d/s');
    assert.equal(fmtRate(-302400), `${M}3.5 d/s`);
    assert.equal(fmtRate(2.5), '2.5×');
    assert.equal(fmtRate(0), 'Paused');
    assert.equal(fmtRate(Number.NaN), DASH);
});

test('magnitude, percentages and angular sizes', () => {
    assert.equal(fmtMag(0.6), '0.6');
    assert.equal(fmtMag(-0.04), '0.0');
    assert.equal(fmtMag(5.86), '5.9');
    assert.equal(fmtPct(0.62), '62%');
    assert.equal(fmtPct(0), '0%');
    assert.equal(fmtPct(1), '100%');
    assert.equal(fmtPct(0.003), '<1%');
    assert.equal(fmtPct(0.997), '>99%');
    assert.equal(fmtPct('x'), DASH);
    assert.equal(fmtAngSize(45.21), '45.2″');
    assert.equal(fmtAngSize(1890), '31′ 30″');
    assert.equal(fmtAngSize(59.97), '1′ 00″');
});

test('latitude/longitude in decimal and DMS', () => {
    assert.equal(fmtLatLon(21.0285, 105.8542), '21.03° N 105.85° E');
    assert.equal(fmtLatLon(48.86, 2.35, 'dec', { digits: 4, sep: ', ' }), '48.8600° N, 2.3500° E');
    assert.equal(fmtLatLon(-33.8679, -70.6), '33.87° S 70.60° W');
    assert.equal(fmtLatLon(-0.001, -0.001), '0.00° N 0.00° E', 'no "0.00° S"');
    assert.equal(fmtLatLon(48.856666, 2.352222, 'dms'), '48°51′24″ N 2°21′08″ E');
    assert.equal(fmtLatLon(10, 190), '10.00° N 170.00° W', 'longitude wraps');
    assert.equal(fmtLatLon(91, 0), DASH);
    assert.equal(fmtLatLon(Number.NaN, 0), DASH);
});

test('Moon phase names and age', () => {
    assert.equal(moonPhaseName(0), 'New Moon');
    assert.equal(moonPhaseName(358), 'New Moon');
    assert.equal(moonPhaseName(4.07), 'New Moon', '2026-10-11 (SPEC §0)');
    assert.equal(moonPhaseName(30), 'Waxing crescent');
    assert.equal(moonPhaseName(91), 'First quarter');
    assert.equal(moonPhaseName(135), 'Waxing gibbous');
    assert.equal(moonPhaseName(180), 'Full Moon');
    assert.equal(moonPhaseName(225), 'Waning gibbous');
    assert.equal(moonPhaseName(268), 'Last quarter');
    assert.equal(moonPhaseName(300), 'Waning crescent');
    assert.equal(moonPhaseName(-90), 'Last quarter');
    assert.ok(Math.abs(moonAgeDays(180) - 14.7652945) < 1e-6);
    assert.ok(Number.isNaN(moonAgeDays('x')));
});
