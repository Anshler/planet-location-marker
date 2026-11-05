// 'Add to calendar' (ROADMAP event-glyphs-and-ics): the RFC 5545 builder — escaping, folding at
// 75 octets, UTC times, durations, the alarm, stable UIDs — and the eclipse bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, foldLine, icsDate, eventSpan, slug, icsFileName, veventLines, buildCalendar, eclipseBundle, placeKeyOf } from '../js/ui/ics.js';
import { upcomingEvents, localSolarEclipseAt } from '../js/astro/events.js';

const LUXOR = { latDeg: 25.6872, lonDeg: 32.6396, elevM: 76 };
const NOW = Date.parse('2026-11-04T12:00:00Z');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
/** Unfolds a calendar (RFC 5545 §3.1) into its content lines. */
const unfold = (text) => text.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);

test('escapeText: backslash, semicolon, comma and newlines', () => {
    assert.equal(escapeText('a\\b; c, d\ne\r\nf'), 'a\\\\b\\; c\\, d\\ne\\nf');
    assert.equal(escapeText('Mars–Jupiter conjunction (0.3° apart)'), 'Mars–Jupiter conjunction (0.3° apart)');
    assert.equal(escapeText(null), '');
});

test('foldLine: at most 75 octets a line, continuations start with a space, never inside a character', () => {
    const ascii = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldLine(ascii);
    const parts = folded.split('\r\n');
    assert.ok(parts.length === 3, `${parts.length} lines`);
    assert.equal(bytes(parts[0]), 75);
    for (const p of parts.slice(1)) { assert.equal(p[0], ' '); assert.ok(bytes(p) <= 75); }
    assert.equal(unfold(folded)[0], ascii);
    // Multi-byte text (2-, 3- and 4-byte characters): every line within 75 octets, and unfolding
    // gives back the same characters (no character was cut in half).
    const mixed = `SUMMARY:${'Moon passes 0.3° from Régulus — 🌕 '.repeat(8)}`;
    const f2 = foldLine(mixed);
    for (const p of f2.split('\r\n')) assert.ok(bytes(p) <= 75, `${bytes(p)} octets: ${p}`);
    assert.equal(unfold(f2)[0], mixed);
    assert.ok(!f2.includes('�'));
    assert.equal(foldLine('SHORT:1'), 'SHORT:1');
});

test('icsDate: UTC basic format, seconds truncated', () => {
    assert.equal(icsDate(Date.parse('2027-08-02T10:07:59.900Z')), '20270802T100759Z');
    assert.equal(icsDate(Date.UTC(1999, 11, 31, 23, 0, 5)), '19991231T230005Z');
});

test('eventSpan: eclipse contacts, transits and passes last; a shower its best hour; the rest are instants', () => {
    const ev = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    assert.deepEqual(eventSpan(ev), { startMs: ev.c1Ms, endMs: ev.c4Ms });
    assert.deepEqual(eventSpan({ kind: 'lunar-eclipse', tMs: 5, u1Ms: 3, u4Ms: 7, p1Ms: 1, p4Ms: 9 }), { startMs: 3, endMs: 7 });
    assert.deepEqual(eventSpan({ kind: 'lunar-eclipse', tMs: 5, u1Ms: null, u4Ms: null, p1Ms: 1, p4Ms: 9 }), { startMs: 1, endMs: 9 }, 'penumbral');
    assert.deepEqual(eventSpan({ kind: 'transit', tMs: 5, startMs: 2, finishMs: 8 }), { startMs: 2, endMs: 8 });
    assert.deepEqual(eventSpan({ kind: 'sat-pass', tMs: 2, pass: { startMs: 2, endMs: 300 } }), { startMs: 2, endMs: 300 });
    assert.deepEqual(eventSpan({ kind: 'meteor-shower', tMs: 0, visibleMs: 7200e3 }), { startMs: 5400e3, endMs: 9000e3 });
    assert.deepEqual(eventSpan({ kind: 'moon-phase', tMs: 42 }), { startMs: 42, endMs: null });
});

test('slug and file names: the title before any dash clause, without parentheses, ASCII', () => {
    assert.equal(slug('Mars–Jupiter conjunction (0.3° apart)'), 'mars-jupiter-conjunction');
    assert.equal(slug('Total solar eclipse — greatest at 25.5° N, 33.2° E'), 'total-solar-eclipse');
    assert.equal(slug('Moon occults Régulus'), 'moon-occults-regulus');
    assert.equal(slug(''), 'sky-event');
    assert.equal(icsFileName({ title: 'Full Moon', tMs: Date.parse('2027-01-22T12:17:00Z') }), 'full-moon-2027-01-22.ics');
    assert.equal(icsFileName({ title: 'First Quarter', tMs: Date.parse('2027-01-15T20:35:00Z') }, '2027-01-16'), 'first-quarter-2027-01-16.ics', 'the local date');
});

test('a VEVENT: UTC start and end, escaped summary and description with the link, a 30-min alarm', () => {
    const ev = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    const url = 'https://example.test/#loc=25.6872,32.6396&t=2027-08-02T10:04:00Z&p=0&view=sky&sel=sun&intro=0';
    const lines = veventLines(ev, { nowMs: NOW, url, place: 'Luxor, Egypt', placeKey: placeKeyOf(LUXOR) });
    assert.equal(lines[0], 'BEGIN:VEVENT');
    assert.equal(lines.at(-1), 'END:VEVENT');
    const get = (k) => lines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1);
    assert.equal(get('DTSTART'), icsDate(ev.c1Ms));
    assert.equal(get('DTEND'), icsDate(ev.c4Ms));
    assert.equal(get('DTSTAMP'), '20261104T120000Z');
    assert.equal(get('UID'), `${ev.id}.25.69_32.64@planet-location-marker`, 'no comma in a TEXT value');
    assert.equal(veventLines(ev, { nowMs: NOW, placeKey: 'a,b;c' }).find((l) => l.startsWith('UID:')), `UID:${ev.id}.a_b_c@planet-location-marker`);
    assert.match(get('SUMMARY'), /^Total solar eclipse visible here/);
    const desc = get('DESCRIPTION');
    assert.ok(desc.includes('\\n\\nTimes and visibility for Luxor\\, Egypt.'), desc);
    assert.ok(desc.includes(`See this sky: ${escapeText(url)}`), 'the deep link, escaped as TEXT');
    assert.ok(!/[^\\][,;]/.test(desc.replace(/\\[\\,;n]/g, '')), 'no bare comma or semicolon');
    assert.equal(get('URL'), url, 'URL is a URI value, not escaped');
    const a = lines.indexOf('BEGIN:VALARM'), b = lines.indexOf('END:VALARM');
    assert.ok(a > 0 && b > a);
    assert.deepEqual(lines.slice(a + 1, b).sort(), ['ACTION:DISPLAY', `DESCRIPTION:${escapeText(ev.title)}`, 'TRIGGER:-PT30M'].sort());
    // An instant has no DTEND; no alarm when asked for none.
    const inst = veventLines({ id: 'moon-phase:moon:1', kind: 'moon-phase', tMs: Date.parse('2027-01-22T12:17:00Z'), title: 'Full Moon', detail: '' }, { nowMs: NOW, alarmMin: 0 });
    assert.ok(!inst.some((l) => l.startsWith('DTEND')));
    assert.ok(!inst.includes('BEGIN:VALARM'));
});

test('buildCalendar: a folded VCALENDAR with CRLF line ends, one VEVENT per event, UIDs stable across exports', () => {
    const list = upcomingEvents(LUXOR, Date.parse('2027-07-01T00:00:00Z'), 60);
    const opts = { nowMs: NOW, name: 'Sky events', place: 'Luxor, Egypt', placeKey: placeKeyOf(LUXOR), urlFor: (ev) => `https://example.test/#t=${new Date(ev.tMs).toISOString()}` };
    const text = buildCalendar(list, opts);
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/[^\r]\n/.test(text), 'every line ends in CRLF');
    for (const l of text.split('\r\n')) assert.ok(bytes(l) <= 75, `over 75 octets: ${l}`);
    const lines = unfold(text);
    assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, list.length);
    assert.equal(lines.filter((l) => l === 'BEGIN:VALARM').length, list.length);
    assert.ok(lines.includes('X-WR-CALNAME:Sky events'));
    const uids = lines.filter((l) => l.startsWith('UID:'));
    assert.equal(new Set(uids).size, uids.length, 'unique');
    const again = unfold(buildCalendar(list, { ...opts, nowMs: NOW + 864e5 })).filter((l) => l.startsWith('UID:'));
    assert.deepEqual(again, uids, 'the same events give the same UIDs on a later export');
    // A failing link builder still gives a calendar.
    assert.ok(buildCalendar(list.slice(0, 1), { nowMs: NOW, urlFor: () => { throw new Error('x'); } }).includes('BEGIN:VEVENT'));
});

test('a satellite pass keeps its UID when the pass search runs again (start times a few ms apart)', async () => {
    const { passEvent } = await import('../js/ui/sat-passes.js');
    const ui = { fmtClock: () => '21:03', compass: () => 'S' };
    const pass = (startMs) => ({ id: 'sat:tiangong', name: 'Tiangong', startMs, peakMs: startMs + 180e3, endMs: startMs + 360e3, peakAltDeg: 60,
        startAltDeg: 10, startAzDeg: 200, peakAzDeg: 180, endAzDeg: 90, mag: -2, starts: 'horizon', ends: 'shadow' });
    const uid = (p) => veventLines(passEvent(p, ui), { nowMs: NOW, placeKey: placeKeyOf({ latDeg: 21.02, lonDeg: 105.84 }) }).find((l) => l.startsWith('UID:'));
    const a = uid(pass(1793963390988)), b = uid(pass(1793963391026));
    assert.equal(a, b);
    assert.equal(a, 'UID:pass:sat:tiangong:29899390.21.02_105.84@planet-location-marker');
    assert.notEqual(uid(pass(1793963390988 + 95 * 60e3)), a, 'the next pass is another event');
});

test('eclipseBundle: lunar and local solar eclipses, and global ones only when not seen here', () => {
    const H = 3600e3;
    const list = [
        { kind: 'solar-eclipse', tMs: 100 * H, id: 'g1' },
        { kind: 'local-solar-eclipse', tMs: 100 * H + 30 * 60e3, id: 'l1' },
        { kind: 'solar-eclipse', tMs: 900 * H, id: 'g2' },
        { kind: 'lunar-eclipse', tMs: 500 * H, id: 'm1' },
        { kind: 'moon-phase', tMs: 200 * H, id: 'p' },
        { kind: 'lunar-eclipse', tMs: 99999 * H, id: 'late' },
    ];
    assert.deepEqual(eclipseBundle(list, 0, 10000 * H).map((e) => e.id), ['l1', 'm1', 'g2']);
    // Real data: from Luxor the 2027-08-02 total eclipse is listed once, as the local one.
    const real = eclipseBundle(upcomingEvents(LUXOR, Date.parse('2027-06-01T00:00:00Z'), 120), Date.parse('2027-06-01T00:00:00Z'), Date.parse('2027-10-01T00:00:00Z'));
    const aug = real.filter((e) => Math.abs(e.tMs - Date.parse('2027-08-02T10:07:00Z')) < 864e5);
    assert.deepEqual(aug.map((e) => e.kind), ['local-solar-eclipse']);
});

test('the calendar speaks the interface language; its structure, dates and UIDs do not change', async () => {
    const { setLocale } = await import('../js/core/i18n.js');
    const vi = JSON.parse((await import('node:fs')).readFileSync(new URL('../data/i18n/vi.json', import.meta.url), 'utf8'));
    const ev = { id: 'conj:mars:jupiter:2026-11-10', kind: 'conjunction', tMs: Date.parse('2026-11-10T03:00:00Z') };
    const en = veventLines(ev, { nowMs: NOW, url: 'https://x.test/#t=1', place: 'Hà Nội', placeKey: '21.03,105.85' });
    setLocale('vi', vi);
    try {
        const lines = veventLines(ev, { nowMs: NOW, url: 'https://x.test/#t=1', place: 'Hà Nội', placeKey: '21.03,105.85' });
        assert.equal(lines.find((l) => l.startsWith('SUMMARY:')), 'SUMMARY:Sự kiện bầu trời');
        assert.match(lines.find((l) => l.startsWith('DESCRIPTION:')), /^DESCRIPTION:Giờ giấc và khả năng quan sát tính cho Hà Nội\.\\n\\nXem bầu trời này: https/);
        const machine = (ls) => ls.filter((l) => /^(BEGIN|END|UID|DTSTAMP|DTSTART|DTEND|URL|TRANSP|ACTION|TRIGGER):/.test(l));
        assert.deepEqual(machine(lines), machine(en));
        assert.equal(slug('Nguyệt thực toàn phần — Đông Á'), 'nguyet-thuc-toan-phan');
        assert.equal(slug('Điểm cận nhật'), 'diem-can-nhat');
    } finally { setLocale('en'); }
});
