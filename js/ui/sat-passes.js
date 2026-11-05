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
import { t } from '../core/i18n.js';
import { fmtMag } from '../core/format.js';

const MAX_CARD_PASSES = 6;

const magText = (m) => (Number.isFinite(m) ? t('mag {m}', { m: fmtMag(m) }) : '');

/**
 * "ISS pass: up to 67° high, mag −3.4".
 * @param {any} p SatPass
 */
export function passTitle(p) {
    const v = { name: p.name, deg: Math.round(p.peakAltDeg), mag: magText(p.mag) };
    return v.mag ? t('{name} pass: up to {deg}° high, {mag}', v) : t('{name} pass: up to {deg}° high', v);
}

/**
 * "Appears 21:03 low in the SW · highest 21:06 in the S · fades into the Earth's shadow 21:08 in the E".
 * @param {any} p SatPass
 * @param {any} ui the UI hub (fmtClock, compass)
 */
export function passDetail(p, ui) {
    const at = (ms, az) => t('{time} in the {dir}', { time: ui.fmtClock(ms), dir: ui.compass(az) });
    const a = { at: at(p.startMs, p.startAzDeg), deg: Math.round(p.startAltDeg) }, b = { at: at(p.endMs, p.endAzDeg) };
    const start = p.starts === 'shadow' ? t('Leaves the Earth’s shadow {at} ({deg}°)', a) : p.starts === 'twilight' ? t('Shows {at} ({deg}°)', a) : t('Appears {at} ({deg}°)', a);
    const end = p.ends === 'shadow' ? t('fades into the Earth’s shadow {at}', b) : p.ends === 'twilight' ? t('lost in the dawn {at}', b) : t('sets {at}', b);
    return `${start} · ${t('highest {at}', { at: at(p.peakMs, p.peakAzDeg) })} · ${end}`;
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
    const list = h('ol', { class: 'ev-list sat-passes__list', 'aria-label': t('Next visible passes') });
    const empty = h('p', { class: 'empty', hidden: true });
    const el = h('section', { class: 'sat-passes', hidden: true, 'aria-label': t('Next visible passes') },
        h('h3', { class: 'group-title' }, t('Next visible passes')), head, list, empty);
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
        const now = simNow();
        const all = ui.passes?.list;
        const mine = Array.isArray(all) ? all.filter((p) => p.id === id && p.endMs >= now).slice(0, MAX_CARD_PASSES) : null;
        const k = `${id}|${ui.passes?.fromMs}|${mine?.length ?? -1}|${mine?.[0]?.startMs ?? ''}|${ui.displayTz()}|${!!ui.onMars?.()}`
            + (mine && !mine.length ? `|${Math.floor(now / 86400e3)}` : '');
        if (k === key) return;
        key = k;
        rows = [];
        if (!mine) {
            list.replaceChildren();
            empty.hidden = false;
            setText(empty, t('Computing passes…'));
            return;
        }
        empty.hidden = mine.length > 0;
        if (!mine.length) setText(empty, noPassesText(id, now));
        list.replaceChildren(...mine.map((p, i) => {
            const meta = h('span', { class: 'ev__meta' });
            rows.push({ p, meta });
            return h('li', { class: 'ev' },
                h('span', { class: 'ev__icon', style: { '--c': p.color }, 'aria-hidden': 'true' }, icon('satellite', { size: 18 })),
                h('div', { class: 'ev__main' },
                    h('span', { class: 'ev__title' }, magText(p.mag) ? t('Up to {deg}° · {mag}', { deg: Math.round(p.peakAltDeg), mag: magText(p.mag) }) : t('Up to {deg}°', { deg: Math.round(p.peakAltDeg) })),
                    meta,
                    h('span', { class: 'ev__detail' }, passDetail(p, ui))),
                h('button', { class: 'btn btn--soft btn--sm ev__jump', type: 'button', 'data-pass': String(i),
                    'aria-label': t('Watch the pass at {when}', { when: ui.fmtSpoken(p.startMs) }) }, icon('sky', { size: 14 }), t('Watch this pass')));
        }));
        tick(now);
    }

    /** Why the list is empty: no predictions past the elements' window, a clipped span, or the sky. */
    function noPassesText(id, now) {
        const prov = ctx.extras?.provider?.('sat') ?? null;
        const sat = prov?.sat?.(id) ?? null;
        const days = prov?.validDays ?? 14;
        const until = sat && Number.isFinite(sat.epochMs) ? sat.epochMs + days * 86400e3 : NaN;
        const to = Number.isFinite(ui.passes?.toMs) ? ui.passes.toMs : now + 10 * 86400e3;
        if (now >= until) return t('No predictions: the orbital elements are {n} days old (the limit is {days}).', { n: Math.floor((now - sat.epochMs) / 86400e3), days });
        const mars = !!ui.onMars?.(), date = ui.fmtDay(until, { year: false });
        if (until < to) {
            return mars ? t('No visible passes from your place on the Earth before predictions stop on {date}.', { date })
                : t('No visible passes from here before predictions stop on {date}.', { date });
        }
        return mars ? t('No visible passes from your place on the Earth in the next 10 days: it is either below the horizon, in the Earth’s shadow, or up only in daylight.')
            : t('No visible passes from here in the next 10 days: it is either below the horizon, in the Earth’s shadow, or up only in daylight.');
    }

    function tick(now) {
        for (const { p, meta } of rows) {
            const when = `${ui.fmtDay(p.startMs, { year: false })} · ${ui.fmtClock(p.startMs)}`;
            const rel = now >= p.startMs && now <= p.endMs ? t('visible now, until {time}', { time: ui.fmtClock(p.endMs) }) : ui.fmt('fmtRelative', p.startMs, now);
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
        const hrs = Math.abs(age) < 1, v = { n: hrs ? Math.round(Math.abs(age) * 24) : ui.fmt('fmtNum', Math.abs(age), 1) };
        const old = !Number.isFinite(age) ? t('Orbital elements') : age < 0
            ? (hrs ? t('Orbital elements {n} h ahead of their date', v) : t('Orbital elements {n} days ahead of their date', v))
            : hrs ? t('Orbital elements {n} h old', v) : t('Orbital elements {n} days old', v);
        // Standing on Mars the passes are still the Earth place's: Watch takes you back there.
        const o = ctx.store?.get?.().observer;
        const mars = ui.onMars?.() ? `${t('Passes over {place}; Watch this pass returns you to the Earth.', { place: o?.name || t('your place on the Earth') })} ` : '';
        setText(head, mars + t('{elements}; predictions stop {date} ({days} days after them). Times in the time-bar zone.', { elements: old, date: ui.fmtDay(until, { year: false }), days }));
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
