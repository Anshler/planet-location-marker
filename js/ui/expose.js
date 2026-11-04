/**
 * Long exposures (ROADMAP lighten-stacking-exposure): presets in the Sky view's Tools menu
 * (ui/view-switch.js); while one runs, a mode chip (ui/modes.js) shows the stack's progress
 * (`actions.exposeStatus()`, on the 4 Hz readout) with Save image (the postcard's photo mode) and
 * Stop. Esc asks twice once frames are stacked. State: `ui.expose`.
 *
 * @module ui/expose
 */

export const EXPOSE_PRESETS = Object.freeze([
    Object.freeze({ id: 'trails', title: 'Star trails', desc: 'Tonight from dusk at 10 min/s, facing the celestial pole.' }),
    Object.freeze({ id: 'analemma', title: 'Analemma', desc: "The Sun at noon every day for a year: its figure-8." }),
    Object.freeze({ id: 'free', title: 'Free exposure', desc: 'Stack whatever you do with the time and the view.' }),
]);
const TITLES = Object.fromEntries(EXPOSE_PRESETS.map((p) => [p.id, p.title]));

/**
 * The exposure chip's status line.
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
 * Keeps the exposure's chip in step with the store and the readout.
 * @param {any} ctx UiCtx (with ui.modes)
 * @param {{savePhoto:(caption:string)=>void}} hooks
 * @returns {{destroy():void}}
 */
export function mountExpose(ctx, { savePhoto }) {
    const { store, ui, bus } = ctx;
    const status = () => ctx.actions?.exposeStatus?.() ?? null;

    /** "Star trails · Paranal, Chile · 10 Nov 2026 01:00 → 05:10 (4 h 10 min)". */
    function caption() {
        const st = status();
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
    const text = () => exposeStatusText(status(), (ms) => ui.fmt('fmtDuration', ms), ui.snap?.observer?.sunAltDeg);

    function sync() {
        const kind = store.get().ui.expose;
        if (!kind) { ui.modes.clear('expose'); return; }
        ui.modes.set('expose', {
            icon: 'aperture', title: `Long exposure: ${TITLES[kind] ?? kind}`, detail: text(), live: true,
            actions: [{ label: 'Save image', run: () => savePhoto(caption()) }],
            exit: { label: 'Stop', done: 'Long exposure stopped', run: () => ui.act('expose', null) },
            // With frames stacked, a stray Esc must not throw the picture away.
            guard: () => (status()?.frames > 0 ? 'Press Esc again to stop the exposure, or choose Save image' : null),
        });
    }
    const offs = [
        store.subscribe((s) => s.ui.expose, sync),
        bus.on('readout', () => { if (store.get().ui.expose) ui.modes.update('expose', { detail: text() }); }),
    ];
    sync();
    return { destroy() { offs.forEach((off) => off()); ui.modes.clear('expose'); } };
}
