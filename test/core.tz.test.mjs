// Tests for js/core/tz.js — including ADDENDUM A2 (ICU canonicalisation: the v1 outage on
// UTC-configured systems), DST gaps/overlaps in both hemispheres and half-hour zones.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canonTz, isValidTz, resolveTz, deviceTz, zonedToUtc, utcToZoned, localDayStart, approxTzForLon, offsetLabel,
    offsetLabelAt, listTimeZones, displayTz, daysInMonth, toDatetimeLocal, fromDatetimeLocal,
} from '../js/core/tz.js';

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const Z = (s) => Date.parse(s);
const MINUS = String.fromCharCode(0x2212);

test('A2: canonTz unifies aliases the way the engine does', () => {
    assert.equal(canonTz('UTC'), 'UTC');
    assert.equal(canonTz('Etc/UTC'), 'UTC');
    assert.equal(canonTz('Etc/GMT'), canonTz('UTC'));
    assert.equal(canonTz('utc'), 'UTC', 'case-insensitive');
    for (const [a, b] of [
        ['Asia/Ho_Chi_Minh', 'Asia/Saigon'], ['Asia/Kolkata', 'Asia/Calcutta'], ['Europe/Kyiv', 'Europe/Kiev'],
        ['America/Argentina/Buenos_Aires', 'America/Buenos_Aires'], ['Asia/Kathmandu', 'Asia/Katmandu'],
    ]) {
        assert.ok(canonTz(a), `${a} is valid`);
        assert.equal(canonTz(a), canonTz(b), `${a} ≡ ${b}`);
    }
    assert.equal(canonTz('Foo/Bar'), null);
    assert.equal(canonTz(''), null);
    assert.equal(canonTz('   '), null);
    assert.equal(canonTz(null), null);
    assert.equal(canonTz(undefined), null);
    assert.equal(canonTz(42), null);
    assert.equal(canonTz({}), null);
    assert.equal(canonTz('x'.repeat(200)), null);
    assert.equal(canonTz(' Europe/Paris '), 'Europe/Paris', 'surrounding whitespace is tolerated');
    assert.equal(canonTz('Asia/Ho_Chi_Minh'), canonTz('Asia/Ho_Chi_Minh'), 'memoised result is stable');
});

test('A2: isValidTz / resolveTz accept UTC even though supportedValuesOf omits it', () => {
    assert.equal(isValidTz('UTC'), true);
    assert.equal(isValidTz('Etc/UTC'), true);
    assert.equal(isValidTz('Asia/Saigon'), true);
    assert.equal(isValidTz('Asia/Ho_Chi_Minh'), true);
    assert.equal(isValidTz('Mars/Olympus_Mons'), false);
    assert.equal(resolveTz('Mars/Olympus_Mons'), 'UTC');
    assert.equal(resolveTz(null), 'UTC');
    assert.equal(resolveTz('Europe/Paris'), 'Europe/Paris');
});

test('A2: deviceTz is always a valid zone', () => {
    const d = deviceTz();
    assert.equal(typeof d, 'string');
    assert.ok(isValidTz(d), d);
});

test('A2: listTimeZones starts with UTC, contains deviceTz, has no duplicates', () => {
    const list = listTimeZones();
    assert.equal(list[0], 'UTC');
    assert.ok(list.length > 50);
    assert.equal(new Set(list).size, list.length);
    const dev = deviceTz();
    assert.ok(list.includes(dev) || list.some((z) => canonTz(z) === canonTz(dev)), `contains ${dev}`);
    for (const z of list) assert.ok(isValidTz(z), z);
    const sorted = list.slice(1);
    assert.deepEqual([...sorted].sort(), sorted, 'alphabetical after UTC');
    list.push('mutated');
    assert.ok(!listTimeZones().includes('mutated'), 'returns a fresh array');
});

test('spec: America/New_York DST gap and overlap', () => {
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York')), '2026-03-08T07:30:00Z',
        'gap: 02:30 does not exist → shifted forward by the gap (03:30 EDT)');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 11, d: 1, h: 1, mi: 30, s: 0 }, 'America/New_York')), '2026-11-01T05:30:00Z',
        'overlap: 01:30 happens twice → the earlier instant (EDT)');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 3, d: 8, h: 1, mi: 59, s: 59 }, 'America/New_York')), '2026-03-08T06:59:59Z');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 3, d: 8, h: 3, mi: 0, s: 0 }, 'America/New_York')), '2026-03-08T07:00:00Z');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 11, d: 1, h: 2, mi: 0, s: 0 }, 'America/New_York')), '2026-11-01T07:00:00Z');
});

test('southern hemisphere DST: Australia/Sydney gap (October) and overlap (April)', () => {
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 4, h: 2, mi: 30 }, 'Australia/Sydney')), '2026-10-03T16:30:00Z',
        '02:30 in the spring-forward gap → 03:30 AEDT');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 4, d: 5, h: 2, mi: 30 }, 'Australia/Sydney')), '2026-04-04T15:30:00Z',
        '02:30 twice → the earlier (AEDT, +11)');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 1, d: 15, h: 12 }, 'Australia/Sydney')), '2026-01-15T01:00:00Z', 'summer +11');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 7, d: 15, h: 12 }, 'Australia/Sydney')), '2026-07-15T02:00:00Z', 'winter +10');
});

test('half-hour and 45-minute zones, including a 30-minute DST shift', () => {
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 11, h: 20 }, 'Asia/Kolkata')), '2026-10-11T14:30:00Z');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 11, h: 20 }, 'Asia/Calcutta')), '2026-10-11T14:30:00Z');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 11, h: 20 }, 'Asia/Kathmandu')), '2026-10-11T14:15:00Z');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 7, d: 1, h: 12 }, 'America/St_Johns')), '2026-07-01T14:30:00Z', 'NDT −2:30');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 1, d: 1, h: 12 }, 'America/St_Johns')), '2026-01-01T15:30:00Z', 'NST −3:30');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 12, h: 2, mi: 59, s: 5 }, 'Pacific/Chatham')), '2026-10-11T13:14:05Z', '+13:45');
    // Lord Howe Island moves its clocks by only 30 minutes.
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 10, d: 4, h: 2, mi: 15 }, 'Australia/Lord_Howe')), '2026-10-03T15:45:00Z',
        '02:15 in the 30-minute gap → 02:45 (+11)');
    assert.equal(iso(zonedToUtc({ y: 2026, mo: 4, d: 5, h: 1, mi: 45 }, 'Australia/Lord_Howe')), '2026-04-04T14:45:00Z',
        '01:45 twice → the earlier (+11)');
});

test('utcToZoned fields, offsets and abbreviations', () => {
    const t = Z('2026-10-11T13:14:05Z');
    const hcm = utcToZoned(t, 'Asia/Ho_Chi_Minh');
    assert.deepEqual({ y: hcm.y, mo: hcm.mo, d: hcm.d, h: hcm.h, mi: hcm.mi, s: hcm.s, offsetMin: hcm.offsetMin },
        { y: 2026, mo: 10, d: 11, h: 20, mi: 14, s: 5, offsetMin: 420 });
    assert.ok(hcm.abbr.length > 0);
    assert.equal(utcToZoned(t, 'Asia/Saigon').h, 20);
    assert.equal(utcToZoned(t, 'UTC').offsetMin, 0);
    assert.equal(utcToZoned(t, 'Asia/Kolkata').offsetMin, 330);
    assert.equal(utcToZoned(t, 'Asia/Kathmandu').offsetMin, 345);
    assert.equal(utcToZoned(t, 'Pacific/Chatham').offsetMin, 825);
    assert.equal(utcToZoned(t, 'Australia/Lord_Howe').offsetMin, 660);
    assert.equal(utcToZoned(Z('2026-07-01T00:00:00Z'), 'Australia/Lord_Howe').offsetMin, 630);
    assert.equal(utcToZoned(t, 'America/St_Johns').offsetMin, -150);
    assert.equal(utcToZoned(t, 'Etc/GMT-7').offsetMin, 420);
    assert.equal(utcToZoned(t, 'Etc/GMT+5').offsetMin, -300);
    // Seconds are truncated, never rounded up into the next minute.
    assert.equal(utcToZoned(Z('2026-10-11T13:14:05.999Z'), 'UTC').s, 5);
    // Pre-1970 instants floor correctly.
    const pre = utcToZoned(Date.UTC(1969, 11, 31, 23, 59, 58, 500), 'UTC');
    assert.equal(pre.s, 58);
    const out = {};
    assert.equal(utcToZoned(t, 'UTC', out), out, 'reuses the provided object');
});

test('historic local mean time offsets keep their seconds', () => {
    const z = utcToZoned(Z('1900-01-01T00:00:00Z'), 'Asia/Ho_Chi_Minh');
    assert.equal(z.offsetMin, 426.5, 'LMT +7:06:30');
    assert.equal(z.h, 7);
    assert.equal(z.mi, 6);
    assert.equal(z.s, 30);
    assert.equal(zonedToUtc(z, 'Asia/Ho_Chi_Minh'), Z('1900-01-01T00:00:00Z'));
    const ny = utcToZoned(Date.UTC(1000, 0, 1), 'America/New_York');
    assert.equal(ny.y, 999, 'the year-1000 bound reads as 999 in New York LMT');
    assert.equal(zonedToUtc(ny, 'America/New_York'), Date.UTC(1000, 0, 1));
});

test('Samoa skipped 30 Dec 2011 entirely: a wall time that day moves forward 24 h', () => {
    assert.equal(iso(zonedToUtc({ y: 2011, mo: 12, d: 30, h: 12 }, 'Pacific/Apia')), '2011-12-30T22:00:00Z');
    const z = utcToZoned(Z('2011-12-30T22:00:00Z'), 'Pacific/Apia');
    assert.deepEqual([z.mo, z.d, z.h], [12, 31, 12]);
});

const ZONES = ['UTC', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Asia/Kathmandu',
    'Pacific/Chatham', 'America/St_Johns', 'Europe/London', 'Asia/Ho_Chi_Minh', 'Pacific/Apia', 'America/Santiago',
    'Asia/Beirut', 'America/Havana', 'Europe/Kyiv'];

/** Deterministic PRNG so failures are reproducible. */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

test('round trip instant → wall → instant (overlaps map to the earlier instant)', () => {
    const rand = rng(12345);
    const lo = Date.UTC(1000, 0, 1), hi = Date.UTC(3000, 0, 1);
    let overlaps = 0;
    for (const zone of ZONES) {
        for (let i = 0; i < 160; i++) {
            const t = Math.floor((lo + rand() * (hi - lo)) / 1000) * 1000;
            const z = utcToZoned(t, zone);
            const back = zonedToUtc(z, zone);
            if (back !== t) {
                overlaps++;
                assert.ok(back < t, `${zone} ${iso(t)}: only the later occurrence of an overlap may map elsewhere`);
                const z2 = utcToZoned(back, zone);
                assert.deepEqual([z2.y, z2.mo, z2.d, z2.h, z2.mi, z2.s], [z.y, z.mo, z.d, z.h, z.mi, z.s]);
            }
        }
    }
    assert.ok(overlaps < 20, `overlaps are rare (${overlaps})`);
});

test('round trip around every 2026 transition, minute by minute', () => {
    for (const zone of ['America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Beirut']) {
        // Find the transitions of 2026 by scanning offsets hourly.
        let prev = utcToZoned(Date.UTC(2026, 0, 1), zone).offsetMin;
        let transitions = 0;
        for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 36e5) {
            const off = utcToZoned(t, zone).offsetMin;
            if (off === prev) continue;
            prev = off;
            transitions++;
            for (let m = -150; m <= 150; m++) {
                const u = t + m * 6e4;
                const z = utcToZoned(u, zone);
                const back = zonedToUtc(z, zone);
                assert.ok(back === u || back < u, `${zone} ${iso(u)}`);
                const z2 = utcToZoned(back, zone);
                assert.deepEqual([z2.d, z2.h, z2.mi], [z.d, z.h, z.mi], `${zone} ${iso(u)} wall time preserved`);
            }
        }
        assert.equal(transitions, 2, `${zone} has two DST transitions in 2026`);
    }
});

test('a bad time zone never throws and means UTC', () => {
    const t = Z('2026-10-11T13:14:05Z');
    for (const bad of ['Foo/Bar', '', null, undefined, 42, {}, 'UTC+7', 'GMT+7:00:00:00']) {
        const z = utcToZoned(t, bad);
        assert.deepEqual([z.y, z.mo, z.d, z.h, z.mi, z.s, z.offsetMin], [2026, 10, 11, 13, 14, 5, 0], String(bad));
        assert.equal(zonedToUtc({ y: 2026, mo: 10, d: 11, h: 13, mi: 14, s: 5 }, bad), t);
        assert.equal(localDayStart(t, bad), Z('2026-10-11T00:00:00Z'));
    }
});

test('unusable fields give NaN, never an exception', () => {
    assert.ok(Number.isNaN(zonedToUtc({}, 'UTC')));
    assert.ok(Number.isNaN(zonedToUtc(null, 'UTC')));
    assert.ok(Number.isNaN(zonedToUtc({ y: 'abc' }, 'UTC')));
    assert.ok(Number.isNaN(zonedToUtc({ y: 2026, mo: Number.NaN }, 'UTC')));
    assert.ok(Number.isNaN(zonedToUtc({ y: 1e9 }, 'UTC')));
    const z = utcToZoned(Number.NaN, 'Asia/Tokyo');
    assert.ok(Number.isNaN(z.y));
    assert.equal(z.offsetMin, 0);
    assert.ok(Number.isNaN(utcToZoned(1e20, 'UTC').y));
    assert.ok(Number.isNaN(localDayStart(Number.NaN, 'UTC')));
});

test('zonedToUtc defaults and overflow', () => {
    assert.equal(zonedToUtc({ y: 2026 }, 'UTC'), Date.UTC(2026, 0, 1));
    assert.equal(zonedToUtc({ y: 2026, mo: 2, d: 29 }, 'UTC'), Date.UTC(2026, 2, 1), 'Feb 29 2026 rolls to Mar 1');
    assert.equal(zonedToUtc({ y: 2026, mo: 10, d: 11, h: 24 }, 'UTC'), Date.UTC(2026, 9, 12));
    assert.equal(zonedToUtc({ y: 50, mo: 1, d: 1 }, 'UTC'), new Date('0050-01-01T00:00:00Z').getTime(), 'years 0..99 are not 19xx');
    assert.equal(zonedToUtc({ y: '2026', mo: '10', d: '11' }, 'UTC'), Date.UTC(2026, 9, 11), 'numeric strings are fine');
});

test('localDayStart, including days whose midnight does not exist', () => {
    assert.equal(iso(localDayStart(Z('2026-10-11T13:14:05Z'), 'Asia/Ho_Chi_Minh')), '2026-10-10T17:00:00Z');
    assert.equal(iso(localDayStart(Z('2026-10-11T13:14:05Z'), 'UTC')), '2026-10-11T00:00:00Z');
    assert.equal(iso(localDayStart(Z('2026-03-29T12:00:00Z'), 'Asia/Beirut')), '2026-03-28T22:00:00Z', 'starts 01:00 (+3)');
    assert.equal(iso(localDayStart(Z('2026-09-06T15:00:00Z'), 'America/Santiago')), '2026-09-06T04:00:00Z', 'starts 01:00 (−3)');
    assert.equal(iso(localDayStart(Z('2026-03-08T15:00:00Z'), 'America/Havana')), '2026-03-08T05:00:00Z', 'starts 01:00 (−4)');
    assert.equal(iso(localDayStart(Z('2026-04-05T12:00:00Z'), 'Australia/Sydney')), '2026-04-04T13:00:00Z', 'DST-end day starts at +11');
});

test('approxTzForLon uses the inverted Etc sign and always yields a valid zone', () => {
    assert.equal(approxTzForLon(105), 'Etc/GMT-7');
    assert.equal(approxTzForLon(105.85), 'Etc/GMT-7');
    assert.equal(approxTzForLon(-75), 'Etc/GMT+5');
    assert.equal(approxTzForLon(0), 'Etc/GMT');
    assert.equal(approxTzForLon(7.4), 'Etc/GMT');
    assert.equal(approxTzForLon(-7.4), 'Etc/GMT');
    assert.equal(approxTzForLon(7.6), 'Etc/GMT-1');
    assert.equal(approxTzForLon(180), 'Etc/GMT-12');
    assert.equal(approxTzForLon(-180), 'Etc/GMT+12');
    assert.equal(approxTzForLon(465), 'Etc/GMT-7', 'wraps longitudes');
    assert.equal(approxTzForLon(Number.NaN), 'Etc/GMT');
    for (let lon = -180; lon <= 180; lon += 2.5) {
        const zone = approxTzForLon(lon);
        assert.ok(isValidTz(zone), zone);
        const off = utcToZoned(Date.UTC(2026, 0, 1), zone).offsetMin / 60;
        assert.ok(Math.abs(off - lon / 15) <= 0.5 + 1e-9, `${lon}° → ${zone} (${off} h)`);
    }
});

test('offsetLabel formats with a true minus sign', () => {
    assert.equal(offsetLabel(-210), `UTC${MINUS}3:30`);
    assert.equal(offsetLabel(420), 'UTC+7');
    assert.equal(offsetLabel(330), 'UTC+5:30');
    assert.equal(offsetLabel(345), 'UTC+5:45');
    assert.equal(offsetLabel(825), 'UTC+13:45');
    assert.equal(offsetLabel(-600), `UTC${MINUS}10`);
    assert.equal(offsetLabel(0), 'UTC+0');
    assert.equal(offsetLabel(-0.2), 'UTC+0');
    assert.equal(offsetLabel(426.5), 'UTC+7:07', 'LMT rounds to the minute');
    assert.equal(offsetLabel(Number.NaN), 'UTC');
    assert.equal(offsetLabelAt(Z('2026-10-11T00:00:00Z'), 'Asia/Kolkata'), 'UTC+5:30');
    assert.equal(offsetLabelAt(Z('2026-10-11T00:00:00Z'), 'nonsense'), 'UTC+0');
});

test('displayTz follows the display mode', () => {
    const obs = { tz: 'Asia/Ho_Chi_Minh', lonDeg: 106.6 };
    assert.equal(displayTz({ tzMode: 'observer' }, obs), 'Asia/Ho_Chi_Minh');
    assert.equal(displayTz({ tzMode: 'utc' }, obs), 'UTC');
    assert.equal(displayTz({ tzMode: 'device' }, obs), deviceTz());
    assert.equal(displayTz({ tzMode: 'observer' }, { tz: null, lonDeg: -75 }), 'Etc/GMT+5');
    assert.equal(displayTz({ tzMode: 'observer' }, { tz: 'Nope/Nope', lonDeg: 105 }), 'Etc/GMT-7');
    assert.equal(displayTz(null, null), 'UTC');
});

test('datetime-local helpers round-trip and are DST-safe', () => {
    const t = Z('2026-10-11T13:14:05Z');
    assert.equal(toDatetimeLocal(t, 'Asia/Ho_Chi_Minh'), '2026-10-11T20:14:05');
    assert.equal(toDatetimeLocal(t, 'Asia/Ho_Chi_Minh', { seconds: false }), '2026-10-11T20:14');
    assert.equal(fromDatetimeLocal('2026-10-11T20:14:05', 'Asia/Ho_Chi_Minh'), t);
    assert.equal(fromDatetimeLocal('2026-10-11 20:14', 'Asia/Saigon'), Z('2026-10-11T13:14:00Z'));
    assert.equal(fromDatetimeLocal('2026-03-08T02:30', 'America/New_York'), Z('2026-03-08T07:30:00Z'));
    assert.equal(fromDatetimeLocal('2026-02-29T10:00', 'UTC'), null, 'not a leap year');
    assert.equal(fromDatetimeLocal('2028-02-29T10:00', 'UTC'), Date.UTC(2028, 1, 29, 10));
    assert.equal(fromDatetimeLocal('2026-04-31T10:00', 'UTC'), null);
    assert.equal(fromDatetimeLocal('2026-10-11T25:00', 'UTC'), null);
    assert.equal(fromDatetimeLocal('yesterday', 'UTC'), null);
    assert.equal(fromDatetimeLocal(null, 'UTC'), null);
    assert.equal(toDatetimeLocal(Number.NaN, 'UTC'), '');
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(1900, 2), 28);
    assert.equal(daysInMonth(2000, 2), 29);
    assert.equal(daysInMonth(2026, 11), 30);
});
