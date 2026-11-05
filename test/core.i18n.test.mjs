import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { t, tn, N_, setLocale, locale, strings, pickLocale, intl, dec, dateText, timeText, LOCALES } from '../js/core/i18n.js';

afterEach(() => setLocale('en'));

const VI = { 'Sky view': 'Bầu trời', 'Hello {name}': 'Xin chào {name}', '{n} worlds above you': '{n} thiên thể trên đầu bạn',
    '{n} apples': { one: '{n} apple (one)', other: '{n} apples (other)' } };

test('English needs no table: the key is the text, placeholders filled', () => {
    assert.equal(locale(), 'en');
    assert.equal(strings(), null);
    assert.equal(t('Sky view'), 'Sky view');
    assert.equal(t('Hello {name}', { name: 'Lan' }), 'Hello Lan');
    assert.equal(t('Hello {name}'), 'Hello {name}', 'no vars: left as written');
    assert.equal(t('{a} and {b}', { a: 1 }), '1 and {b}', 'a missing var stays visible');
    assert.equal(t('{a}{a}', { a: 0 }), '00', 'zero is a value');
    assert.equal(N_('Beams'), 'Beams');
});

test('a table translates, a missing key falls back to English silently', () => {
    const calls = [];
    const orig = { info: console.info, warn: console.warn, error: console.error, log: console.log };
    for (const k of Object.keys(orig)) console[k] = (...a) => calls.push(a);
    try {
        setLocale('vi', VI);
        assert.equal(locale(), 'vi');
        assert.equal(strings(), VI);
        assert.equal(t('Sky view'), 'Bầu trời');
        assert.equal(t('Hello {name}', { name: 'Lan' }), 'Xin chào Lan');
        assert.equal(t('Not translated {x}', { x: 2 }), 'Not translated 2');
    } finally {
        Object.assign(console, orig);
    }
    assert.deepEqual(calls, [], 'no console output');
});

test('unknown locales are English; English drops any table', () => {
    setLocale('xx', VI);
    assert.equal(locale(), 'en');
    assert.equal(t('Sky view'), 'Sky view');
    setLocale('en', VI);
    assert.equal(strings(), null);
    assert.deepEqual(Object.keys(LOCALES), ['en', 'vi']);
});

test('plurals: English one/other, Vietnamese one form, plural objects by Intl.PluralRules', () => {
    assert.equal(tn('{n} world above you', '{n} worlds above you', 1), '1 world above you');
    assert.equal(tn('{n} world above you', '{n} worlds above you', 0), '0 worlds above you');
    assert.equal(tn('{n} world above you', '{n} worlds above you', 3), '3 worlds above you');
    assert.equal(tn('one {x}', '{n} of {x}', 2, { x: 'them' }), '2 of them');
    assert.equal(tn('{n} item', '{n} items', 2, { n: '2,000' }), '2,000 items', 'vars may pre-format n');
    setLocale('vi', VI);
    assert.equal(tn('{n} world above you', '{n} worlds above you', 1), '1 thiên thể trên đầu bạn');
    assert.equal(tn('{n} world above you', '{n} worlds above you', 5), '5 thiên thể trên đầu bạn');
    // vi has only 'other' in Intl.PluralRules.
    assert.equal(tn('{n} apple', '{n} apples', 1), '1 apples (other)');
    assert.equal(tn('{n} pear', '{n} pears', 1), '1 pear', 'untranslated: English forms');
});

test('pickLocale: #lang=, then the saved choice, then the device language', () => {
    assert.equal(pickLocale('vi', 'en', 'en-US'), 'vi');
    assert.equal(pickLocale(undefined, null, 'vi-VN'), 'vi');
    assert.equal(pickLocale(undefined, 'en', 'vi-VN'), 'en', 'a saved English beats the device');
    assert.equal(pickLocale('fr', 'de', 'en-GB'), 'en');
    assert.equal(pickLocale(undefined, undefined, 'de-DE'), 'en');
    assert.equal(pickLocale(), 'en');
    assert.equal(pickLocale('VI'), 'vi');
});

test('intl() caches one formatter per locale and options', () => {
    const a = intl(Intl.NumberFormat, { maximumFractionDigits: 1 });
    assert.equal(intl(Intl.NumberFormat, { maximumFractionDigits: 1 }), a);
    assert.equal(a.resolvedOptions().locale, 'en-US');
    setLocale('vi', VI);
    const b = intl(Intl.NumberFormat, { maximumFractionDigits: 1 });
    assert.notEqual(b, a);
    assert.equal(b.resolvedOptions().locale, 'vi-VN');
    assert.equal(typeof intl(Intl.RelativeTimeFormat, { numeric: 'auto' }).format(-1, 'day'), 'string');
});

test('dec: English toFixed, Vietnamese decimal comma and dot grouping', () => {
    assert.equal(dec(1234.56, 1), '1234.6');
    assert.equal(dec(0.5), '1', 'toFixed rounding');
    setLocale('vi', VI);
    assert.equal(dec(1234.56, 1), '1.234,6');
    assert.equal(dec(2.5, 2), '2,50');
});

const F = { y: 2026, mo: 10, d: 11, wd: 0, h: 20, mi: 14, s: 5.7 };

test('dateText / timeText in English keep the designed format', () => {
    assert.equal(dateText(F, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), 'Sun 11 Oct 2026');
    assert.equal(dateText(F, { day: 'numeric', month: 'short' }), '11 Oct');
    assert.equal(dateText(F, { weekday: 'short', day: 'numeric' }), 'Sun 11');
    assert.equal(dateText(F, { month: 'long', year: 'numeric' }), 'October 2026');
    assert.equal(dateText(F, { weekday: 'short', day: 'numeric', month: 'short', year: false }), 'Sun 11 Oct', 'false options are skipped');
    assert.equal(dateText({ y: 2026, mo: 9, d: 12, wd: 6 }, { month: 'short' }), 'Sep', 'not CLDR en-GB "Sept"');
    assert.equal(timeText(F), '20:14');
    assert.equal(timeText(F, { seconds: true }), '20:14:05');
    assert.equal(timeText(F, { hour12: true }), '8:14 PM');
    assert.equal(timeText({ h: 0, mi: 5, s: 0 }, { hour12: true, seconds: true }), '12:05:00 AM');
    assert.equal(timeText({ h: 12, mi: 5 }, { hour12: true }), '12:05 PM');
});

test('dateText / timeText in Vietnamese come from Intl, the weekday from the fields', () => {
    setLocale('vi', VI);
    assert.equal(dateText(F, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), 'CN, 11 thg 10, 2026');
    assert.equal(dateText(F, { day: 'numeric', month: 'short' }), '11 thg 10');
    assert.equal(dateText(F, { month: 'long', year: 'numeric' }), 'tháng 10 năm 2026');
    assert.equal(dateText({ ...F, wd: 2 }, { weekday: 'narrow' }), 'T3');
    // A Julian date (27 Dec 999 = Gregorian 2 Jan 1000, a Wednesday): Intl prints the fields as given.
    assert.equal(dateText({ y: 999, mo: 12, d: 27, wd: 3 }, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), 'Thứ 4, 27 thg 12, 999');
    assert.equal(timeText(F), '20:14');
    assert.equal(timeText(F, { hour12: true }), '8:14 CH');
    assert.equal(timeText({ h: 9, mi: 5, s: 1 }, { hour12: true, seconds: true }), '9:05:01 SA');
});

test('data/i18n tables cover exactly the supported locales', () => {
    const files = fs.readdirSync(new URL('../data/i18n/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    assert.deepEqual(files.sort(), Object.keys(LOCALES).filter((c) => c !== 'en').sort());
});
