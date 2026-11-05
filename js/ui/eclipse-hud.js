/**
 * Eclipse Companion: a HUD for an eclipse seen from here, from 3 h before first contact to 30 min
 * after the last, or after a jump to one (store ui.eclipse): the countdown, the contact track
 * (plain names, the codes beneath), the disc as covered now, and Play / Jump / Stand in the path.
 * On a phone it folds to its countdown above peek or in Sky view, unless the user chose for this
 * eclipse. Written from the 4 Hz readout when something changed; announced once per eclipse.
 * @module ui/eclipse-hud
 */

import { h, on, setText } from './dom.js';
import { icon } from './icons.js';
import { drawPhaseDisc } from './body-card.js';
import { solarDiscGeometry, solarEclipseState, lunarEclipseState } from './sky-now.js';
import { localSolarEclipseAt } from '../astro/events.js';

export const HUD_LEAD_MS = 3 * 3600e3;
export const HUD_TRAIL_MS = 30 * 60e3;
const SOLAR = 'c1Ms C1 c2Ms C2 maxMs Max c3Ms C3 c4Ms C4';
const UMBRAL = 'u1Ms U1 u2Ms U2 maxMs Max u3Ms U3 u4Ms U4';
const PENUMBRAL = 'p1Ms P1 maxMs Max p4Ms P4';
/** A contact's plain name on the track, and its whole phrase for screen readers (R6). */
const CONTACT = {
    C1: ['Begins', 'The eclipse begins (C1)'], C2: ['Totality', 'Totality begins (C2)'], Max: ['Peak', 'The peak of the eclipse'],
    C3: ['Totality ends', 'Totality ends (C3)'], C4: ['Ends', 'The eclipse ends (C4)'],
    U1: ['Partial begins', 'The partial eclipse begins (U1)'], U2: ['Total begins', 'The total eclipse begins (U2)'],
    U3: ['Total ends', 'The total eclipse ends (U3)'], U4: ['Partial ends', 'The partial eclipse ends (U4)'],
    P1: ['Begins', 'The penumbral eclipse begins (P1)'], P4: ['Ends', 'The penumbral eclipse ends (P4)'],
};
const ANNULAR = { C2: ['Annularity', 'Annularity begins (C2)'], C3: ['Annularity ends', 'Annularity ends (C3)'] };
const pad2 = (n) => String(n).padStart(2, '0');
const pct = (x) => Math.max(1, Math.min(99, Math.round((x || 0) * 100)));

/** Contacts of a local solar or lunar eclipse event in order ([{id:'C1', ms}, …]); [] without two. */
export function eclipseContacts(ev) {
    const keys = ev?.kind === 'local-solar-eclipse' ? SOLAR
        : ev?.kind === 'lunar-eclipse' ? (Number.isFinite(ev.u1Ms) ? UMBRAL : PENUMBRAL) : '';
    const w = keys.split(' '), out = [];
    for (let i = 0; i + 1 < w.length; i += 2) {
        const ms = Number.isFinite(ev[w[i]]) ? ev[w[i]] : w[i] === 'maxMs' && Number.isFinite(ev.tMs) ? ev.tMs : null;
        if (ms !== null) out.push({ id: w[i + 1], ms });
    }
    return out.length >= 2 ? out : [];
}

/** True when the countdown is to a total or annular phase (for the Sun, one above the horizon). */
export function isCentral(ev) {
    if (ev?.kind === 'lunar-eclipse') return Number.isFinite(ev.u2Ms) && Number.isFinite(ev.u3Ms);
    return ev?.kind === 'local-solar-eclipse' && ev.eclipseKind !== 'partial' && ev.centralUp !== 'none'
        && Number.isFinite(ev.c2Ms) && Number.isFinite(ev.c3Ms);
}

/** The local solar, or visible lunar, eclipse whose [first − 3 h, last + 30 min] holds tMs. */
export function pickHudEvent(list, tMs) {
    let best = null, bestD = Infinity;
    for (const ev of list || []) {
        if (ev?.kind !== 'local-solar-eclipse' && !(ev?.kind === 'lunar-eclipse' && ev.visibleHere)) continue;
        const c = eclipseContacts(ev);
        const d = Math.abs(ev.tMs - tMs);
        if (c.length && tMs >= c[0].ms - HUD_LEAD_MS && tMs <= c[c.length - 1].ms + HUD_TRAIL_MS && d < bestD) { best = ev; bestD = d; }
    }
    return best;
}

/**
 * Countdown at tMs to the central phase's start and end, then the last contact (or maximum, then
 * the last contact); `passed` counts contacts at or before tMs.
 * @returns {{label:string, leftMs:number|null, passed:number}}
 */
export function hudCountdown(ev, contacts, tMs) {
    const word = ev.eclipseKind === 'annular' ? 'Ring of fire' : 'Totality';
    const last = contacts[contacts.length - 1];
    const steps = isCentral(ev) && contacts.length === 5
        ? [[contacts[1], `${word} in`], [contacts[3], `${word} ends in`], [last, 'Eclipse ends in']]
        : [[contacts.find((c) => c.id === 'Max'), 'Peak in'], [last, 'Eclipse ends in']];
    const passed = contacts.filter((c) => c.ms <= tMs).length;
    for (const [c, label] of steps) if (c && tMs < c.ms) return { label, leftMs: c.ms - tMs, passed };
    return { label: 'Eclipse over', leftMs: null, passed };
}

/** Playhead position 0…1: contacts evenly spaced, time linear between them. */
export function trackPos(contacts, tMs) {
    const n = contacts.length;
    if (n < 2 || tMs <= contacts[0].ms) return 0;
    for (let i = 1; i < n; i += 1) {
        const a = contacts[i - 1].ms, b = contacts[i].ms;
        if (tMs < b) return (i - 1 + (tMs - a) / (b - a)) / (n - 1);
    }
    return 1;
}

/** "00:27:14" (hours keep counting past 24). */
export function fmtCountdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

function spoken(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60;
    const u = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return hh ? `${u(hh, 'hour')} ${u(mm, 'minute')}` : mm ? u(mm, 'minute') : u(s, 'second');
}

/**
 * Mounts the HUD in its shell region.
 * @param {HTMLElement} root
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void}}
 */
export function mountEclipseHud(root, ctx) {
    const { store, bus, ui, clock } = ctx;
    const el = (tag, cls, ...kids) => h(tag, cls && { class: cls }, ...kids);
    const btn = (cls, ...kids) => h('button', { class: `btn btn--sm ${cls}`, type: 'button' }, ...kids);
    root.hidden = true;
    root.setAttribute('aria-labelledby', 'ecl-title');
    const eyebrow = el('p', 'ecl__eye');
    const title = h('h2', { class: 'ecl__title', id: 'ecl-title' });
    const label = el('span');
    const count = el('span', 'ecl__count');
    const status = el('p', 'ecl__status');
    const disc = h('canvas', { 'aria-hidden': 'true' });   // the status line says what it shows
    const toggle = h('button', {
        class: 'icon-btn ecl__tog', type: 'button', 'aria-controls': 'ecl-body', 'aria-expanded': 'true', 'aria-label': 'Eclipse details',
    }, icon('chevron-up', { size: 18 }));
    const rail = h('div', { class: 'ecl-trk__rail', 'aria-hidden': 'true' }, el('i', 'ecl-trk__head'));
    const list = h('ol', { class: 'ecl-trk__nodes', 'aria-label': 'Contacts (approximate times)' });
    const track = el('div', 'ecl-trk', rail, list);
    const playBtn = btn('btn--primary', icon('play', { size: 14 }), 'Play the eclipse');
    const jumpBtn = btn('btn--soft');
    const standBtn = btn('btn--ghost', icon('pin', { size: 14 }), el('span'));
    const note = el('p', 'ecl__note');
    root.append(el('div', 'ecl__head', disc, el('div', 'ecl__main', eyebrow, title, el('p', 'ecl__cd', label, ' ', count), status), toggle),
        h('div', { class: 'ecl__body', id: 'ecl-body' }, track, el('div', 'btn-row', playBtn, jumpBtn, standBtn), note));

    let cur = null, focusKey = '', focusEv = null, nodes = [], key = '', pos = '', passed = -1, discKey = '', sayTimer = 0;
    /** The user's own open or closed, until this eclipse ends. */
    let chosen = '';
    function fold() {
        const st = store.get(), sky = st.view?.mode === 'sky';
        // A phone above peek or in Sky view, and any layout while a playback runs in Sky view (the
        // Sun is the show then): the countdown alone.
        const auto = (ui.layout === 'mobile' && (st.ui?.sheet !== 'peek' || sky)) || (sky && !!clock?.range);
        const shut = chosen ? chosen === 'closed' : auto;
        root.classList.toggle('is-collapsed', shut);
        toggle.setAttribute('aria-expanded', String(!shut));
    }

    const offs = [
        on(toggle, 'click', () => { chosen = root.classList.contains('is-collapsed') ? 'open' : 'closed'; fold(); }),
        on(playBtn, 'click', () => cur?.ev && ui.act('playEclipse', cur.ev)),
        on(jumpBtn, 'click', () => cur?.ev && ui.act('jumpToEvent', cur.ev)),
        on(standBtn, 'click', () => {
            if (!cur?.standMs) return;
            standBtn.disabled = true;
            Promise.resolve(ui.act('standInPath', cur.standMs)).catch(() => null).then(() => { standBtn.disabled = false; });
        }),
    ];

    /** The eclipse in focus (contacts recomputed here on observer changes), else one in its window. */
    function resolve(t) {
        const st = store.get();
        const focus = st.ui?.eclipse || null;
        const okey = ui.observerKey(st.observer);
        if (focus && `${focus.peakMs}|${okey}` !== focusKey) {
            focusKey = `${focus.peakMs}|${okey}`;
            try { focusEv = localSolarEclipseAt(ui.astroObserver(st.observer), focus.peakMs); } catch { focusEv = null; }
        }
        const events = ui.events.key === okey ? ui.events.list : null;
        const ev = (focus && focusEv) || pickHudEvent(events, t);
        if (!ev && !focus) return null;
        const peakMs = ev ? ev.tMs : focus.peakMs;
        // The global eclipse: is there a path of totality or annularity to stand in?
        let g = focus && !focus.local && Math.abs(focus.peakMs - peakMs) < 864e5 ? focus : null;
        const e = g ? null : events?.find((x) => x.kind === 'solar-eclipse' && Math.abs(x.tMs - peakMs) < 864e5);
        if (e) g = { peakMs: e.tMs, kind: e.eclipseKind };
        const solar = !ev || ev.kind === 'local-solar-eclipse';
        return {
            id: `${ev ? ev.id : 'away'}|${peakMs}|${okey}`, ev, solar, peakMs, contacts: ev ? eclipseContacts(ev) : [],
            standMs: solar && g?.kind && g.kind !== 'partial' && !isCentral(ev) ? g.peakMs : 0,
            kind: (ev ? (solar && !isCentral(ev) ? 'partial' : ev.eclipseKind) : g?.kind || focus.kind) || 'partial',
        };
    }

    function build(c) {
        const ev = c.ev, s = ev && c.solar && c.kind !== 'partial' ? Math.round(ev.totalDurS || 0) : 0;
        setText(title, `${c.kind[0].toUpperCase()}${c.kind.slice(1)} ${c.solar ? 'solar' : 'lunar'} eclipse${s ? ` · ${Math.floor(s / 60)} m ${pad2(s % 60)} s` : ''}`);
        track.hidden = playBtn.hidden = jumpBtn.hidden = disc.hidden = !ev;
        standBtn.hidden = !c.standMs;
        setText(standBtn.lastChild, `Stand in the path of ${c.kind === 'annular' ? 'annularity' : 'totality'}`);
        // The jump goes to C2 − 20 s, or C3 − 20 s when totality begins before sunrise (actions.jumpToEvent).
        const ends = ev?.centralUp === 'sunrise';
        setText(jumpBtn, !isCentral(ev) || !c.solar ? 'Jump to the peak' : c.kind === 'annular'
            ? (ends ? 'Jump to just before annularity ends' : 'Jump to just before annularity')
            : ends ? 'Jump to just before totality ends' : 'Jump to just before totality');
        setText(note, `${c.solar ? 'Never look at the Sun without certified eclipse glasses.' : 'Safe to watch with the naked eye.'} Times are approximate.`);
        root.classList.toggle('is-lunar', !c.solar);
        const n = c.contacts.length;
        rail.classList.toggle('is-central', n === 5 && isCentral(ev));
        nodes = c.contacts.map((k, i) => {
            const [name, long] = (c.kind === 'annular' && ANNULAR[k.id]) || CONTACT[k.id] || [k.id, k.id];
            const time = ui.fmtClock(k.ms, { seconds: /[23]$/.test(k.id) });
            return h('li', { style: { left: `${(100 * i) / (n - 1)}%` } }, h('span', { class: 'sr-only' }, `${long} at ${time}`),
                h('b', { 'aria-hidden': 'true' }, name), h('span', { 'aria-hidden': 'true' }, time),
                k.id === 'Max' ? null : h('small', { 'aria-hidden': 'true' }, k.id));
        });
        list.replaceChildren(...nodes);
        passed = -1;
        discKey = '';
    }

    function statusText(c, cd, snap, t) {
        const ev = c.ev, k = c.contacts;
        if (!ev) return `Not visible from ${ui.placeShort(store.get().observer)}`;
        // A partial: the obscuration it reaches, until the peak.
        const atMax = c.kind === 'partial' && t < ev.tMs ? ` · ${pct(ev.obscuration)}% at the peak` : '';
        if (t < k[0].ms) return `Begins ${ui.fmtWhen(k[0].ms, t)}${atMax}`;
        if (cd.leftMs === null) return `Ended ${ui.fmtWhen(k[k.length - 1].ms, t)}`;
        if (!c.solar) {
            const l = lunarEclipseState(snap);
            return !(ui.altAz(ui.bodyOf(snap, 'moon')).alt > 0) ? 'The Moon is below the horizon' : l ? `Moon ${l.text}` : 'Penumbral phase';
        }
        const alt = snap.observer?.sunAltDeg, s = solarEclipseState(snap);
        if (alt < -0.8) return 'The Sun is below the horizon';
        if (!s) return 'Partial phase';
        if (s.kind === 'total') return `Totality · Sun ${Math.round(alt)}° up`;
        return `${s.kind === 'annular' ? 'Ring of fire · ' : ''}${s.pct}% of the Sun covered${atMax}`;
    }

    function drawDisc(c, snap) {
        const g = c.solar && solarDiscGeometry(snap);
        const cover = g ? { d: g.sep / g.rS, r: g.rM / g.rS, pa: g.pa } : null;
        const shadow = c.solar ? 0 : 1 - (lunarEclipseState(snap)?.sunlit ?? 1);
        const k = cover ? `${cover.d.toFixed(2)},${cover.r.toFixed(3)},${cover.pa.toFixed(2)}` : `${c.solar}${shadow.toFixed(2)}`;
        if (k === discKey) return;
        discKey = k;
        drawPhaseDisc(disc, { frac: 1, litRight: true, color: c.solar ? '#ffd36b' : '#d8dde6', sun: c.solar, moon: !c.solar, shadow, cover });
    }

    function update(snap = ui.snap) {
        if (!snap) return;
        const t = snap.tMs, c = resolve(t);
        if (!c) {
            if (cur) { cur = null; chosen = ''; root.hidden = true; }
            return;
        }
        const opened = c.id !== cur?.id;
        if (opened) { chosen = ''; fold(); }
        const k = `${c.id}|${ui.displayTz()}|${!!store.get().display?.hour12}|${c.standMs}`;
        cur = c;
        if (k !== key) { key = k; build(c); }
        root.hidden = false;
        setText(eyebrow, `Eclipse companion · ${ui.placeShort(store.get().observer)}`);
        const cd = c.ev ? hudCountdown(c.ev, c.contacts, t) : null;
        setText(label, cd ? cd.label : `${ui.fmtDay(c.peakMs, { year: false })}, greatest eclipse ${ui.fmtClock(c.peakMs)}`);
        setText(count, cd?.leftMs != null ? fmtCountdown(cd.leftMs) : '');
        setText(status, statusText(c, cd, snap, t));
        if (cd) {
            const p = trackPos(c.contacts, t).toFixed(4);
            if (p !== pos) { pos = p; track.style.setProperty('--p', p); }
            if (cd.passed !== passed) {
                passed = cd.passed;
                nodes.forEach((n, i) => n.classList.toggle('is-past', i < passed));
            }
            drawDisc(c, snap);
        }
        if (opened) {
            // Once per eclipse, later than a jump's own narration (time, selection), which would otherwise win.
            const text = `Eclipse companion: ${title.textContent}. ${cd?.leftMs != null ? `${cd.label} ${spoken(cd.leftMs)}` : (cd?.label ?? status.textContent)}.`;
            clearTimeout(sayTimer);
            sayTimer = setTimeout(() => bus.emit('announce', text), 1200);
        }
    }

    const refresh = () => update();
    offs.push(store.subscribe((s) => s.ui?.eclipse, refresh), store.subscribe((s) => s.observer, refresh),
        ui.on('events', refresh), ui.on('display', refresh),
        store.subscribe((s) => s.ui?.sheet, fold), store.subscribe((s) => s.view?.mode, fold), ui.on('layout', fold),
        clock?.onChange?.((ev) => { if (ev?.type === 'range') fold(); }) ?? (() => {}));

    // The status stack under the top bar (ui/modes.js: the mode chips) goes beside the panel on a
    // wide window, else below it (css: --ecl-w and --ecl-h, its right edge and height plus a gap,
    // 0 while it is hidden), never under it.
    const host = ui?.root ?? root.ownerDocument?.documentElement ?? null;
    let lastH = -1, lastW = -1;
    const publish = () => {
        const r = root.hidden ? null : root.getBoundingClientRect?.();
        const hgt = Math.ceil(r?.height || 0), w = hgt > 0 ? Math.ceil(r.right) + 8 : 0;
        if ((hgt === lastH && w === lastW) || !host?.style) return;
        lastH = hgt; lastW = w;
        host.style.setProperty('--ecl-h', hgt > 0 ? `${hgt + 8}px` : '0px');
        host.style.setProperty('--ecl-w', `${w}px`);
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    ro?.observe(root);

    return {
        update,
        destroy() {
            offs.forEach((off) => off());
            clearTimeout(sayTimer);
            ro?.disconnect();
            host?.style?.removeProperty?.('--ecl-h');
            host?.style?.removeProperty?.('--ecl-w');
            root.textContent = '';
        },
    };
}
