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
import { t, tn, N_ } from '../core/i18n.js';

export const HUD_LEAD_MS = 3 * 3600e3;
export const HUD_TRAIL_MS = 30 * 60e3;
const SOLAR = 'c1Ms C1 c2Ms C2 maxMs Max c3Ms C3 c4Ms C4';
const UMBRAL = 'u1Ms U1 u2Ms U2 maxMs Max u3Ms U3 u4Ms U4';
const PENUMBRAL = 'p1Ms P1 maxMs Max p4Ms P4';
/** A contact's plain name on the track, and its whole phrase for screen readers (R6). */
const CONTACT = {
    C1: [N_('Begins'), N_('The eclipse begins (C1)')], C2: [N_('Totality'), N_('Totality begins (C2)')], Max: [N_('Peak'), N_('The peak of the eclipse')],
    C3: [N_('Totality ends'), N_('Totality ends (C3)')], C4: [N_('Ends'), N_('The eclipse ends (C4)')],
    U1: [N_('Partial begins'), N_('The partial eclipse begins (U1)')], U2: [N_('Total begins'), N_('The total eclipse begins (U2)')],
    U3: [N_('Total ends'), N_('The total eclipse ends (U3)')], U4: [N_('Partial ends'), N_('The partial eclipse ends (U4)')],
    P1: [N_('Begins'), N_('The penumbral eclipse begins (P1)')], P4: [N_('Ends'), N_('The penumbral eclipse ends (P4)')],
};
const ANNULAR = { C2: [N_('Annularity'), N_('Annularity begins (C2)')], C3: [N_('Annularity ends'), N_('Annularity ends (C3)')] };
/** The HUD's title by body and kind. */
const TITLE = {
    'solar total': N_('Total solar eclipse'), 'solar annular': N_('Annular solar eclipse'), 'solar partial': N_('Partial solar eclipse'),
    'solar hybrid': N_('Hybrid solar eclipse'), 'lunar total': N_('Total lunar eclipse'), 'lunar partial': N_('Partial lunar eclipse'),
    'lunar penumbral': N_('Penumbral lunar eclipse'),
};
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
    const ring = ev.eclipseKind === 'annular';
    const last = contacts[contacts.length - 1];
    const steps = isCentral(ev) && contacts.length === 5
        ? [[contacts[1], ring ? t('Ring of fire in') : t('Totality in')], [contacts[3], ring ? t('Ring of fire ends in') : t('Totality ends in')], [last, t('Eclipse ends in')]]
        : [[contacts.find((c) => c.id === 'Max'), t('Peak in')], [last, t('Eclipse ends in')]];
    const passed = contacts.filter((c) => c.ms <= tMs).length;
    for (const [c, label] of steps) if (c && tMs < c.ms) return { label, leftMs: c.ms - tMs, passed };
    return { label: t('Eclipse over'), leftMs: null, passed };
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
    const hrs = tn('{n} hour', '{n} hours', hh), mins = tn('{n} minute', '{n} minutes', mm);
    return hh ? `${hrs} ${mins}` : mm ? mins : tn('{n} second', '{n} seconds', s);
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
        class: 'icon-btn ecl__tog', type: 'button', 'aria-controls': 'ecl-body', 'aria-expanded': 'true', 'aria-label': t('Eclipse details'),
    }, icon('chevron-up', { size: 18 }));
    const rail = h('div', { class: 'ecl-trk__rail', 'aria-hidden': 'true' }, el('i', 'ecl-trk__head'));
    const list = h('ol', { class: 'ecl-trk__nodes', 'aria-label': t('Contacts (approximate times)') });
    const track = el('div', 'ecl-trk', rail, list);
    const playBtn = btn('btn--primary', icon('play', { size: 14 }), t('Play the eclipse'));
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
        // A playback in Sky view folds it on any layout.
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
    function resolve(now) {
        const st = store.get();
        const focus = st.ui?.eclipse || null;
        const okey = ui.observerKey(st.observer);
        if (focus && `${focus.peakMs}|${okey}` !== focusKey) {
            focusKey = `${focus.peakMs}|${okey}`;
            try { focusEv = localSolarEclipseAt(ui.astroObserver(st.observer), focus.peakMs); } catch { focusEv = null; }
        }
        const events = ui.events.key === okey ? ui.events.list : null;
        const ev = (focus && focusEv) || pickHudEvent(events, now);
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
        const name = TITLE[`${c.solar ? 'solar' : 'lunar'} ${c.kind}`];
        const head = name ? t(name) : `${c.kind[0].toUpperCase()}${c.kind.slice(1)} ${c.solar ? 'solar' : 'lunar'} eclipse`;
        setText(title, s ? t('{title} · {m} m {s} s', { title: head, m: Math.floor(s / 60), s: pad2(s % 60) }) : head);
        track.hidden = playBtn.hidden = jumpBtn.hidden = disc.hidden = !ev;
        standBtn.hidden = !c.standMs;
        setText(standBtn.lastChild, c.kind === 'annular' ? t('Stand in the path of annularity') : t('Stand in the path of totality'));
        // The jump goes to C2 − 20 s, or C3 − 20 s when totality begins before sunrise (actions.jumpToEvent).
        const ends = ev?.centralUp === 'sunrise';
        setText(jumpBtn, !isCentral(ev) || !c.solar ? t('Jump to the peak') : c.kind === 'annular'
            ? (ends ? t('Jump to just before annularity ends') : t('Jump to just before annularity'))
            : ends ? t('Jump to just before totality ends') : t('Jump to just before totality'));
        setText(note, c.solar ? t('Never look at the Sun without certified eclipse glasses. Times are approximate.') : t('Safe to watch with the naked eye. Times are approximate.'));
        root.classList.toggle('is-lunar', !c.solar);
        const n = c.contacts.length;
        rail.classList.toggle('is-central', n === 5 && isCentral(ev));
        nodes = c.contacts.map((k, i) => {
            const [name, long] = (c.kind === 'annular' && ANNULAR[k.id]) || CONTACT[k.id] || [k.id, k.id];
            const time = ui.fmtClock(k.ms, { seconds: /[23]$/.test(k.id) });
            return h('li', { style: { left: `${(100 * i) / (n - 1)}%` } }, h('span', { class: 'sr-only' }, t('{contact} at {time}', { contact: t(long), time })),
                h('b', { 'aria-hidden': 'true' }, t(name)), h('span', { 'aria-hidden': 'true' }, time),
                k.id === 'Max' ? null : h('small', { 'aria-hidden': 'true' }, k.id));
        });
        list.replaceChildren(...nodes);
        passed = -1;
        discKey = '';
    }

    function statusText(c, cd, snap, now) {
        const ev = c.ev, k = c.contacts;
        if (!ev) return t('Not visible from {place}', { place: ui.placeShort(store.get().observer) });
        // A partial: the obscuration it reaches, until the peak.
        const atMax = c.kind === 'partial' && now < ev.tMs ? ` · ${t('{pct}% at the peak', { pct: pct(ev.obscuration) })}` : '';
        if (now < k[0].ms) return t('Begins {when}', { when: ui.fmtWhen(k[0].ms, now) }) + atMax;
        if (cd.leftMs === null) return t('Ended {when}', { when: ui.fmtWhen(k[k.length - 1].ms, now) });
        if (!c.solar) {
            const l = lunarEclipseState(snap);
            return !(ui.altAz(ui.bodyOf(snap, 'moon')).alt > 0) ? t('The Moon is below the horizon') : l ? t('Moon {state}', { state: l.text }) : t('Penumbral phase');
        }
        const alt = snap.observer?.sunAltDeg, s = solarEclipseState(snap);
        if (alt < -0.8) return t('The Sun is below the horizon');
        if (!s) return t('Partial phase');
        if (s.kind === 'total') return t('Totality · Sun {deg}° up', { deg: Math.round(alt) });
        return (s.kind === 'annular' ? t('Ring of fire · {pct}% of the Sun covered', { pct: s.pct }) : t('{pct}% of the Sun covered', { pct: s.pct })) + atMax;
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
        const now = snap.tMs, c = resolve(now);
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
        setText(eyebrow, t('Eclipse companion · {place}', { place: ui.placeShort(store.get().observer) }));
        const cd = c.ev ? hudCountdown(c.ev, c.contacts, now) : null;
        setText(label, cd ? cd.label : t('{date}, greatest eclipse {time}', { date: ui.fmtDay(c.peakMs, { year: false }), time: ui.fmtClock(c.peakMs) }));
        setText(count, cd?.leftMs != null ? fmtCountdown(cd.leftMs) : '');
        setText(status, statusText(c, cd, snap, now));
        if (cd) {
            const p = trackPos(c.contacts, now).toFixed(4);
            if (p !== pos) { pos = p; track.style.setProperty('--p', p); }
            if (cd.passed !== passed) {
                passed = cd.passed;
                nodes.forEach((n, i) => n.classList.toggle('is-past', i < passed));
            }
            drawDisc(c, snap);
        }
        if (opened) {
            // Once per eclipse, later than a jump's own narration (time, selection), which would otherwise win.
            const text = t('Eclipse companion: {title}. {detail}.', { title: title.textContent, detail: cd?.leftMs != null ? `${cd.label} ${spoken(cd.leftMs)}` : (cd?.label ?? status.textContent) });
            clearTimeout(sayTimer);
            sayTimer = setTimeout(() => bus.emit('announce', text), 1200);
        }
    }

    const refresh = () => update();
    offs.push(store.subscribe((s) => s.ui?.eclipse, refresh), store.subscribe((s) => s.observer, refresh),
        ui.on('events', refresh), ui.on('display', refresh),
        store.subscribe((s) => s.ui?.sheet, fold), store.subscribe((s) => s.view?.mode, fold), ui.on('layout', fold),
        clock?.onChange?.((ev) => { if (ev?.type === 'range') fold(); }) ?? (() => {}));

    // The mode chips (ui/modes.js) go beside or below it (css --ecl-w, --ecl-h: its right edge and
    // height plus a gap, 0 while hidden), never under it.
    const host = ui?.root ?? root.ownerDocument?.documentElement ?? null;
    let last = '';
    const publish = () => {
        const r = root.hidden ? null : root.getBoundingClientRect?.();
        const hgt = Math.ceil(r?.height || 0), w = hgt ? Math.ceil(r.right) + 8 : 0;
        if (`${hgt},${w}` === last || !host?.style) return;
        last = `${hgt},${w}`;
        host.style.setProperty('--ecl-h', `${hgt && hgt + 8}px`);
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
