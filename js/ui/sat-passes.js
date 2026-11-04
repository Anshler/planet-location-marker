/**
 * Satellite passes in words (astro/satellites.js SatPass, from the UI hub's `ui.passes`): the
 * Events tab's entries and the satellite card's 'Next visible passes' list, each with a countdown
 * to the simulated time and 'Watch this pass' (actions.watchPass: sky view, 30 s before it
 * appears, tracked at 1×).
 *
 * @module ui/sat-passes
 */

import { h, on, setText } from './dom.js';
import { icon } from './icons.js';

const MAX_CARD_PASSES = 6;

const fmtMag = (m) => (Number.isFinite(m) ? `mag ${m < 0 ? '−' : ''}${Math.abs(m).toFixed(1)}` : '');

/**
 * "ISS: up to 67° high, mag −3.4".
 * @param {any} p SatPass
 */
export function passTitle(p) {
    const mag = fmtMag(p.mag);
    return `${p.name} pass: up to ${Math.round(p.peakAltDeg)}° high${mag ? `, ${mag}` : ''}`;
}

/**
 * "Appears 21:03 low in the SW · highest 21:06 in the S · fades into the Earth's shadow 21:08 in the E".
 * @param {any} p SatPass
 * @param {any} ui the UI hub (fmtClock, compass)
 */
export function passDetail(p, ui) {
    const at = (ms, az) => `${ui.fmtClock(ms)} in the ${ui.compass(az)}`;
    const start = p.starts === 'shadow' ? 'Leaves the Earth’s shadow' : p.starts === 'twilight' ? 'Shows' : 'Appears';
    const end = p.ends === 'shadow' ? 'fades into the Earth’s shadow' : p.ends === 'twilight' ? 'lost in the dawn' : 'sets';
    return `${start} ${at(p.startMs, p.startAzDeg)} (${Math.round(p.startAltDeg)}°) · highest ${at(p.peakMs, p.peakAzDeg)}`
        + ` · ${end} ${at(p.endMs, p.endAzDeg)}`;
}

/**
 * A SatPass as an Events-tab entry (kind 'sat-pass'; the Jump button watches it).
 * @param {any} p
 * @param {any} ui
 */
export function passEvent(p, ui) {
    return { id: `pass:${p.id}:${Math.round(p.startMs)}`, kind: 'sat-pass', tMs: p.startMs, title: passTitle(p),
        detail: passDetail(p, ui), select: p.id, pass: p, color: p.color };
}

/** Passes worth a place among the year's events ('All'): the bright ones. Every pass is under 'Satellites'. */
export const isBrightPass = (p) => Number.isFinite(p?.mag) && p.mag <= -1;

/**
 * The satellite card's pass list.
 * @param {any} ctx UiCtx
 * @returns {{el:HTMLElement, update(id:string, snap:any):void, destroy():void}}
 */
export function createPassBox(ctx) {
    const { ui, clock } = ctx;
    const head = h('p', { class: 'sat-passes__head' });
    const list = h('ol', { class: 'ev-list sat-passes__list', 'aria-label': 'Next visible passes' });
    const empty = h('p', { class: 'empty', hidden: true });
    const el = h('section', { class: 'sat-passes', hidden: true, 'aria-label': 'Next visible passes' },
        h('h3', { class: 'group-title' }, 'Next visible passes'), head, list, empty);
    /** @type {{p:any, meta:HTMLElement}[]} */
    let rows = [];
    let key = '';
    let shownId = '';
    const offs = [on(list, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-pass]');
        const r = b ? rows[Number(b.dataset.pass)] : null;
        if (r) ui.act('watchPass', r.p);
    })];

    const simNow = () => (Number.isFinite(clock?.tMs) ? clock.tMs : ui.snap?.tMs ?? Date.now());

    function render(id) {
        const t = simNow();
        const all = ui.passes?.list;
        const mine = Array.isArray(all) ? all.filter((p) => p.id === id && p.endMs >= t).slice(0, MAX_CARD_PASSES) : null;
        const k = `${id}|${ui.passes?.fromMs}|${mine?.length ?? -1}|${mine?.[0]?.startMs ?? ''}|${ui.displayTz()}|${!!ui.onMars?.()}`
            + (mine && !mine.length ? `|${Math.floor(t / 86400e3)}` : '');
        if (k === key) return;
        key = k;
        rows = [];
        if (!mine) {
            list.replaceChildren();
            empty.hidden = false;
            setText(empty, 'Computing passes…');
            return;
        }
        empty.hidden = mine.length > 0;
        if (!mine.length) setText(empty, noPassesText(id, t));
        list.replaceChildren(...mine.map((p, i) => {
            const meta = h('span', { class: 'ev__meta' });
            rows.push({ p, meta });
            return h('li', { class: 'ev' },
                h('span', { class: 'ev__icon', style: { '--c': p.color }, 'aria-hidden': 'true' }, icon('satellite', { size: 18 })),
                h('div', { class: 'ev__main' },
                    h('span', { class: 'ev__title' }, `Up to ${Math.round(p.peakAltDeg)}°${fmtMag(p.mag) ? ` · ${fmtMag(p.mag)}` : ''}`),
                    meta,
                    h('span', { class: 'ev__detail' }, passDetail(p, ui))),
                h('button', { class: 'btn btn--soft btn--sm ev__jump', type: 'button', 'data-pass': String(i),
                    'aria-label': `Watch the pass at ${ui.fmtSpoken(p.startMs)}` }, icon('sky', { size: 14 }), 'Watch this pass'));
        }));
        tick(t);
    }

    /** Why the list is empty: no predictions past the elements' window, a clipped span, or the sky. */
    function noPassesText(id, t) {
        const prov = ctx.extras?.provider?.('sat') ?? null;
        const sat = prov?.sat?.(id) ?? null;
        const days = prov?.validDays ?? 14;
        const until = sat && Number.isFinite(sat.epochMs) ? sat.epochMs + days * 86400e3 : NaN;
        const to = Number.isFinite(ui.passes?.toMs) ? ui.passes.toMs : t + 10 * 86400e3;
        if (t >= until) return `No predictions: the orbital elements are ${Math.floor((t - sat.epochMs) / 86400e3)} days old (the limit is ${days}).`;
        const where = ui.onMars?.() ? 'from your place on the Earth' : 'from here';
        if (until < to) return `No visible passes ${where} before predictions stop on ${ui.fmtDay(until, { year: false })}.`;
        return `No visible passes ${where} in the next 10 days: it is either below the horizon, in the Earth’s shadow, or up only in daylight.`;
    }

    function tick(t) {
        for (const { p, meta } of rows) {
            const when = `${ui.fmtDay(p.startMs, { year: false })} · ${ui.fmtClock(p.startMs)}`;
            const rel = t >= p.startMs && t <= p.endMs ? `visible now, until ${ui.fmtClock(p.endMs)}` : ui.fmt('fmtRelative', p.startMs, t);
            setText(meta, `${when}${rel === '—' ? '' : ' · ' + rel}`);
        }
    }

    function header(id, snap) {
        const st = ui.bodyOf(snap, id);
        const age = st?.data?.ageDays;
        const prov = ctx.extras?.provider?.('sat') ?? null;
        const sat = prov?.sat?.(id) ?? null;
        if (!sat) { setText(head, ''); return; }
        const days = prov.validDays ?? 14;
        const until = sat.epochMs + days * 86400e3;
        const old = Number.isFinite(age) ? `Orbital elements ${Math.abs(age) < 1 ? `${Math.round(Math.abs(age) * 24)} h` : `${Math.abs(age).toFixed(1)} days`} ${age < 0 ? 'ahead of their date' : 'old'}` : 'Orbital elements';
        // Standing on Mars the passes are still the Earth place's: Watch takes you back there.
        const o = ctx.store?.get?.().observer;
        const mars = ui.onMars?.() ? `Passes over ${o?.name || 'your place on the Earth'}; Watch this pass returns you to the Earth. ` : '';
        setText(head, `${mars}${old}; predictions stop ${ui.fmtDay(until, { year: false })} (${days} days after them). Times in the time-bar zone.`);
    }

    offs.push(ui.on('passes', () => { key = ''; if (shownId) render(shownId); }));
    offs.push(ui.on('display', () => { key = ''; }));

    return {
        el,
        update(id, snap) {
            const isSat = typeof id === 'string' && id.startsWith('sat:');
            el.hidden = !isSat;
            if (!isSat) { shownId = ''; return; }
            if (id !== shownId) { shownId = id; key = ''; }
            header(id, snap);
            render(id);
            tick(simNow());
        },
        destroy() { offs.forEach((off) => off()); },
    };
}
