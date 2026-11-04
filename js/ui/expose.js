/**
 * Long-exposure controls (ROADMAP lighten-stacking-exposure): the sky view's Expose button opens a
 * popover of presets (Star trails · Analemma · Free); while an exposure runs, a status pill shows
 * what is being stacked, with Save image (the postcard dialog's photo mode) and Stop.
 *
 * State lives in the store (`ui.expose`); the stack's progress comes from
 * `actions.exposeStatus()`, read on the 4 Hz readout.
 *
 * @module ui/expose
 */

import { h, on, setText, openPopover } from './dom.js';
import { icon } from './icons.js';

export const EXPOSE_PRESETS = Object.freeze([
    Object.freeze({ id: 'trails', title: 'Star trails', desc: 'Tonight from dusk at 10 min/s, facing the celestial pole.' }),
    Object.freeze({ id: 'analemma', title: 'Analemma', desc: "The Sun at noon every day for a year: its figure-8." }),
    Object.freeze({ id: 'free', title: 'Free exposure', desc: 'Stack whatever you do with the time and the view.' }),
]);
const TITLES = Object.fromEntries(EXPOSE_PRESETS.map((p) => [p.id, p.title]));

/**
 * The pill's status line.
 * @param {{frames:number, fromMs:number, toMs:number, gated:boolean, active:boolean, kind:string|null}|null} st
 * @param {(ms:number)=>string} fmtDuration
 * @param {number} [sunAltDeg]
 * @returns {string}
 */
export function exposeStatusText(st, fmtDuration, sunAltDeg = NaN) {
    if (!st || !st.active) return 'Starting…';
    const span = Number.isFinite(st.fromMs) && Number.isFinite(st.toMs) ? st.toMs - st.fromMs : 0;
    const frames = `${st.frames} frame${st.frames === 1 ? '' : 's'}`;
    if (st.kind === 'analemma') {
        const days = Math.round(span / 864e5) + (st.frames > 0 ? 1 : 0);
        return `${days} day${days === 1 ? '' : 's'} · ${frames}`;
    }
    const a = Math.round(sunAltDeg);
    const sun = Number.isFinite(a) ? ` (Sun ${a < 0 ? '−' : ''}${Math.abs(a)}°)` : '';
    if (st.gated) return st.frames > 0 ? `Paused for daylight${sun} · ${fmtDuration(span)} so far` : `Waiting for darkness${sun}`;
    return st.frames > 0 ? `${fmtDuration(span)} · ${frames}` : 'Collecting…';
}

/**
 * Wires the Expose button and mounts the status pill.
 * @param {HTMLElement} btn the view bar's Expose button
 * @param {HTMLElement} host where the popover and the pill live
 * @param {any} ctx UiCtx
 * @param {{savePhoto:(caption:string)=>void}} hooks
 * @returns {{destroy():void}}
 */
export function mountExpose(btn, host, ctx, { savePhoto }) {
    const { store, ui, bus } = ctx;
    const offs = [];

    // ---------------------------------------------------------------- popover
    const items = EXPOSE_PRESETS.map((p) => h('button', { class: 'xp-opt', type: 'button', 'data-kind': p.id, 'aria-pressed': 'false' },
        h('span', { class: 'xp-opt__title' }, p.title), h('span', { class: 'xp-opt__desc' }, p.desc)));
    const lowNote = h('p', { class: 'pop__hint xp-low', hidden: true }, 'Low quality stacks without the glow (bloom).');
    const stopBtn = h('button', { class: 'btn btn--ghost', type: 'button', hidden: true }, 'Stop exposure');
    const pop = h('div', { class: 'popover pop-expose', role: 'dialog', 'aria-label': 'Long exposure', hidden: true },
        h('div', { class: 'pop__title' }, icon('aperture', { size: 16 }), 'Long exposure'),
        h('p', { class: 'pop__hint' }, 'Every frame is stacked, brightest wins: a camera on a tripod with the shutter open.'),
        h('div', { class: 'xp-opts' }, items), lowNote,
        h('div', { class: 'pop__actions' }, stopBtn));
    host.appendChild(pop);
    let popCtl = null;
    const closePop = () => { popCtl?.close(); popCtl = null; };
    function openPop() {
        if (popCtl) { closePop(); return; }
        syncPop();
        popCtl = openPopover(btn, pop, { placement: ui.layout === 'mobile' ? 'bottom' : 'top', onClose: () => { popCtl = null; } });
    }
    function syncPop() {
        const cur = store.get().ui.expose;
        for (const it of items) {
            const on_ = it.dataset.kind === cur;
            it.classList.toggle('is-on', on_);
            it.setAttribute('aria-pressed', String(on_));
        }
        stopBtn.hidden = !cur;
        lowNote.hidden = store.get().quality?.active !== 'low';
    }
    offs.push(on(btn, 'click', openPop));
    for (const it of items) {
        offs.push(on(it, 'click', () => {
            ui.act('expose', it.dataset.kind);
            closePop();
        }));
    }
    offs.push(on(stopBtn, 'click', () => { ui.act('expose', null); closePop(); }));

    // ---------------------------------------------------------------- status pill
    const title = h('span', { class: 'xp__title' });
    const status = h('span', { class: 'xp__status' });
    const saveBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, icon('download', { size: 14 }), 'Save image');
    const endBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Stop');
    const pill = h('section', { class: 'xp glass', role: 'status', 'aria-label': 'Long exposure', hidden: true },
        h('span', { class: 'xp__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'xp__text' }, title, status), saveBtn, endBtn);
    host.appendChild(pill);
    offs.push(on(endBtn, 'click', () => ui.act('expose', null)));

    /** "Star trails · Paranal, Chile · 10 Nov 2026 01:00 → 05:10 (4 h 10 min)". */
    function caption() {
        const st = ctx.actions?.exposeStatus?.() ?? null;
        const kind = store.get().ui.expose;
        const parts = [TITLES[kind] ?? 'Long exposure', ui.placeLabel(store.get().observer)];
        if (st && Number.isFinite(st.fromMs) && Number.isFinite(st.toMs)) {
            if (kind === 'analemma') {
                parts.push(`${ui.fmtDay(st.fromMs, { weekday: false })} → ${ui.fmtDay(st.toMs, { weekday: false })}, at ${ui.fmtClock(st.fromMs)}`);
            } else {
                parts.push(`${ui.fmtDay(st.fromMs, { weekday: false })} ${ui.fmtClock(st.fromMs)} → ${ui.fmtWhen(st.toMs, st.fromMs)} (${ui.fmt('fmtDuration', st.toMs - st.fromMs)})`);
            }
        }
        return parts.join(' · ');
    }
    offs.push(on(saveBtn, 'click', () => savePhoto(caption())));

    let lastText = '';
    function syncPill() {
        const kind = store.get().ui.expose;
        pill.hidden = !kind;
        btn.classList.toggle('is-on', !!kind);
        btn.setAttribute('aria-pressed', String(!!kind));
        if (!kind) { lastText = ''; return; }
        const st = ctx.actions?.exposeStatus?.() ?? null;
        setText(title, TITLES[kind] ?? 'Long exposure');
        const text = exposeStatusText(st, (ms) => ui.fmt('fmtDuration', ms), ui.snap?.observer?.sunAltDeg);
        if (text !== lastText) { lastText = text; setText(status, text); }
        pill.classList.toggle('is-gated', !!st?.gated);
    }
    offs.push(store.subscribe((s) => s.ui.expose, () => { syncPill(); if (popCtl) syncPop(); }, { immediate: true }));
    offs.push(bus.on('readout', syncPill));

    return {
        destroy() {
            closePop();
            offs.forEach((off) => off());
            pop.remove();
            pill.remove();
        },
    };
}
