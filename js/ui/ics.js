/**
 * 'Add to calendar' (ROADMAP event-glyphs-and-ics): sky events as an RFC 5545 iCalendar file,
 * built offline.
 *
 * The builder is pure and tested (test/ui.ics.test.mjs):
 * - one VEVENT per event: a stable UID (the event's id and the place); DTSTAMP; DTSTART in UTC,
 *   with DTEND where the event lasts (an eclipse's contacts, a transit, a satellite pass, a meteor
 *   shower's best hour), else an instant;
 * - SUMMARY (the title), DESCRIPTION (the detail, the place the times are for, and a deep link
 *   to that sky), URL and a display VALARM 30 minutes before; the words follow the interface's
 *   language (core/i18n.js), the structure, dates and UIDs stay RFC 5545's;
 * - TEXT values escaped (\ ; , and newlines) and every content line folded at 75 octets of
 *   UTF-8, never inside a character, with CRLF line ends.
 *
 * `saveIcs(text, name)` hands the file over: the share sheet on touch devices that can share
 * files (an iOS home-screen app opens no blob download), else an `<a download>` of a Blob.
 *
 * @module ui/ics
 */

import { t } from '../core/i18n.js';

const ECLIPSE_KINDS = new Set(['solar-eclipse', 'local-solar-eclipse', 'lunar-eclipse']);
const HOUR = 3600e3;

/**
 * Escapes an iCalendar TEXT value: backslash, semicolon, comma and newlines (RFC 5545 §3.3.11).
 * @param {unknown} s
 * @returns {string}
 */
export function escapeText(s) {
    return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n?|\n/g, '\\n');
}

const utf8Len = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/**
 * Folds one content line at 75 octets (RFC 5545 §3.1): CRLF and a space before each
 * continuation, which then holds at most 74 octets after that space. Characters are never split.
 * @param {string} line
 * @returns {string}
 */
export function foldLine(line) {
    let out = '', cur = '', n = 0, max = 75;
    for (const ch of line) {
        const b = utf8Len(ch.codePointAt(0));
        if (n + b > max) {
            out += `${cur}\r\n `;
            cur = '';
            n = 0;
            max = 74;
        }
        cur += ch;
        n += b;
    }
    return out + cur;
}

/**
 * UTC date-time in iCalendar form: 20270802T100700Z (seconds truncated).
 * @param {number} ms
 * @returns {string}
 */
export function icsDate(ms) {
    return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * When an event happens, for a calendar: its start and, when it lasts, its end (ms).
 * A local solar eclipse runs C1–C4; a lunar eclipse U1–U4 (P1–P4 when penumbral); a transit and
 * a satellite pass start to finish; a meteor shower its best hour here; anything else is an instant.
 * @param {any} ev
 * @returns {{startMs:number, endMs:number|null}}
 */
export function eventSpan(ev) {
    const at = Number(ev?.tMs);
    const span = (a, b) => (finite(a) && finite(b) && b > a ? { startMs: a, endMs: b } : null);
    let s = null;
    if (ev?.kind === 'local-solar-eclipse') s = span(ev.c1Ms, ev.c4Ms);
    else if (ev?.kind === 'lunar-eclipse') s = span(ev.u1Ms, ev.u4Ms) || span(ev.p1Ms, ev.p4Ms);
    else if (ev?.kind === 'transit') s = span(ev.startMs, ev.finishMs);
    else if (ev?.kind === 'sat-pass') s = span(ev.pass?.startMs, ev.pass?.endMs);
    else if (ev?.kind === 'meteor-shower' && finite(ev.visibleMs)) s = { startMs: ev.visibleMs - HOUR / 2, endMs: ev.visibleMs + HOUR / 2 };
    return s || { startMs: at, endMs: null };
}

/** 'mars-jupiter-conjunction': the title before any ' — ' and without parentheses, ASCII ('đ' → 'd'). */
export function slug(title) {
    const s = String(title || '').split(' — ')[0].replace(/\([^)]*\)/g, '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s.slice(0, 60).replace(/-+$/, '') || 'sky-event';
}

/**
 * A file name for one event: its slug and date, '.ics'.
 * @param {any} ev
 * @param {string} [day] 'YYYY-MM-DD' in the user's zone (default: the UTC date)
 */
export function icsFileName(ev, day) {
    const d = day || (finite(ev?.tMs) ? new Date(ev.tMs).toISOString().slice(0, 10) : '');
    return `${slug(ev?.title)}${d ? `-${d}` : ''}.ics`;
}

/**
 * The VEVENT lines of one event (unfolded).
 * @param {any} ev
 * @param {{nowMs:number, url?:string, place?:string, placeKey?:string, alarmMin?:number}} o
 * @returns {string[]}
 */
export function veventLines(ev, { nowMs, url = '', place = '', placeKey = '', alarmMin = 30 }) {
    const { startMs, endMs } = eventSpan(ev);
    const title = String(ev?.title || t('Sky event'));
    const uidBase = String(ev?.id || `${ev?.kind || 'event'}:${Math.round(startMs / 60000)}`).replace(/[^A-Za-z0-9:+._-]/g, '-');
    const parts = [];
    if (ev?.detail) parts.push(String(ev.detail));
    if (place) parts.push(t('Times and visibility for {place}.', { place }));
    if (url) parts.push(t('See this sky: {url}', { url }));
    const lines = [
        'BEGIN:VEVENT',
        `UID:${uidBase}${placeKey ? `.${placeKey}` : ''}@planet-location-marker`,
        `DTSTAMP:${icsDate(nowMs)}`,
        `DTSTART:${icsDate(startMs)}`,
    ];
    if (endMs !== null) lines.push(`DTEND:${icsDate(endMs)}`);
    lines.push(`SUMMARY:${escapeText(title)}`);
    if (parts.length) lines.push(`DESCRIPTION:${escapeText(parts.join('\n\n'))}`);
    if (place) lines.push(`LOCATION:${escapeText(place)}`);
    if (url) lines.push(`URL:${url}`);
    lines.push('TRANSP:TRANSPARENT');
    if (alarmMin > 0) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(title)}`, `TRIGGER:-PT${Math.round(alarmMin)}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
    return lines;
}

/**
 * A whole VCALENDAR for `events`, folded, CRLF-terminated.
 * @param {any[]} events
 * @param {{nowMs:number, name?:string, urlFor?:(ev:any)=>string, place?:string, placeKey?:string, alarmMin?:number}} o
 * @returns {string}
 */
export function buildCalendar(events, { nowMs, name = '', urlFor, place = '', placeKey = '', alarmMin = 30 }) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planet Location Marker//Sky events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`);
    for (const ev of events) {
        if (!finite(ev?.tMs)) continue;
        let url = '';
        try { url = urlFor?.(ev) || ''; } catch { url = ''; }
        lines.push(...veventLines(ev, { nowMs, url, place, placeKey, alarmMin }));
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * The eclipses in [fromMs, toMs] for the 'All eclipses in the next year' bundle: lunar eclipses,
 * the solar eclipses seen from here, and the global solar eclipses that are not seen here (a
 * global entry within 12 h of a local one is the same eclipse).
 * @param {any[]} list events, sorted or not
 * @param {number} fromMs
 * @param {number} toMs
 */
export function eclipseBundle(list, fromMs, toMs) {
    const all = (Array.isArray(list) ? list : []).filter((e) => e && ECLIPSE_KINDS.has(e.kind) && e.tMs >= fromMs && e.tMs <= toMs);
    const local = all.filter((e) => e.kind === 'local-solar-eclipse');
    return all.filter((e) => e.kind !== 'solar-eclipse' || !local.some((l) => Math.abs(l.tMs - e.tMs) < 12 * HOUR))
        .sort((a, b) => a.tMs - b.tMs);
}

/** A coarse place key for UIDs: '48.86,2.35'. */
export const placeKeyOf = (o) => (o && Number.isFinite(o.latDeg) && Number.isFinite(o.lonDeg) ? `${o.latDeg.toFixed(2)},${o.lonDeg.toFixed(2)}` : '');

/**
 * Hands an .ics file to the user: the share sheet on a touch device that can share files, else
 * a download. Resolves 'shared' (also when the sheet was dismissed), 'saved' or 'failed'.
 * @param {string} text
 * @param {string} name
 * @param {{title?: string}} [o]
 * @returns {Promise<'shared'|'saved'|'failed'>}
 */
export async function saveIcs(text, name, { title = '' } = {}) {
    const nav = globalThis.navigator;
    let file = null;
    try { file = new File([text], name, { type: 'text/calendar' }); } catch { file = null; }
    const coarse = !!globalThis.matchMedia?.('(pointer: coarse)').matches;
    if (file && coarse && typeof nav?.share === 'function') {
        let can = false;
        try { can = !!nav.canShare?.({ files: [file] }); } catch { can = false; }
        if (can) {
            try {
                await nav.share({ files: [file], title: title || name });
                return 'shared';
            } catch (err) {
                if (err?.name === 'AbortError') return 'shared';
            }
        }
    }
    try {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.hidden = true;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60e3);
        return 'saved';
    } catch {
        return 'failed';
    }
}
