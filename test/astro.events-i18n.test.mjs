// Event titles and details follow the interface's language (the astro worker gets the table):
// whole Vietnamese phrases, the locale's digits, and structured fields the UI reads instead of words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { upcomingEvents, localSolarEclipseAt } from '../js/astro/events.js';
import { setLocale } from '../js/core/i18n.js';

const VI = JSON.parse(fs.readFileSync(new URL('../data/i18n/vi.json', import.meta.url), 'utf8'));
const HANOI = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15, tz: 'Asia/Ho_Chi_Minh' };
const FROM = Date.parse('2026-01-01T00:00:00Z');

test.afterEach(() => setLocale('en'));

test('Vietnamese: titles and details are whole Vietnamese phrases with a decimal comma', () => {
    const en = upcomingEvents(HANOI, FROM, 365);
    setLocale('vi', VI);
    const vi = upcomingEvents(HANOI, FROM, 365);
    assert.equal(vi.length, en.length, 'the same events');
    for (let i = 0; i < vi.length; i++) {
        assert.equal(vi[i].id, en[i].id, 'ids and times do not depend on the language');
        assert.notEqual(vi[i].title, en[i].title, `translated: ${en[i].title}`);
        assert.notEqual(vi[i].detail, en[i].detail, `translated: ${en[i].detail}`);
        assert.doesNotMatch(vi[i].title + vi[i].detail, /\{\w+\}/, 'every placeholder filled');
    }
    const full = vi.find((e) => e.kind === 'moon-phase' && e.quarter === 2);
    assert.equal(full.title, 'Trăng tròn');
    assert.match(full.detail, /^Mặt Trăng trong chòm \w+, cách Trái Đất \d{3}\.\d00 km/, 'dot grouping');
    const elong = vi.find((e) => e.kind === 'max-elongation');
    assert.match(elong.title, /^Sao (Thủy|Kim) đạt ly giác cực đại phía (đông|tây) \(\d+,\d°\)$/);
    assert.ok(elong.side === 'east' || elong.side === 'west');
    const inferior = vi.filter((e) => e.conj === 'inferior').map((e) => e.title);
    assert.ok(inferior.includes('Sao Kim giao hội dưới') && inferior.includes('Sao Thủy giao hội dưới'), inferior.join());
    assert.ok(vi.filter((e) => e.season).map((e) => e.season).join() === 'mar,jun,sep,dec');
});

test('Vietnamese: a local solar eclipse in the locale, with its times as numbers', () => {
    setLocale('vi', VI);
    const luxor = { latDeg: 25.6872, lonDeg: 32.6396, elevM: 80 };
    const ev = localSolarEclipseAt(luxor, Date.parse('2027-08-02T10:07:00Z'), { tz: 'Africa/Cairo' });
    assert.match(ev.title, /^Nhật thực toàn phần thấy được ở đây \(6 phút \d+ giây\)$/);
    assert.match(ev.detail, /^Pha toàn phần \d\d:\d\d:\d\d–\d\d:\d\d:\d\d \(6 phút \d+ giây\), Mặt Trời cao \d+°\. Các pha một phần \d\d:\d\d–\d\d:\d\d\./);
    assert.match(ev.detail, /Tuyệt đối không nhìn Mặt Trời/);
});

test('English is unchanged by the locale machinery', () => {
    const ev = localSolarEclipseAt({ latDeg: 25.6872, lonDeg: 32.6396, elevM: 80 }, Date.parse('2027-08-02T10:07:00Z'), { tz: 'Africa/Cairo' });
    assert.match(ev.title, /^Total solar eclipse visible here \(6 m \d+ s\)$/);
    assert.match(ev.detail, /^Totality \d\d:\d\d:\d\d–\d\d:\d\d:\d\d \(6 m \d+ s\), Sun \d+° up\. Partial phases/);
});
