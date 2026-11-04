/**
 * The sky view's ruler (A; render/ruler.js draws the arc) and 'Point the phone at the sky' (phones
 * with orientation sensors, https only), started from Tools (ui/view-switch.js) and shown as mode
 * chips (ui/modes.js) with Done, or Align and Stop. State: `ui.ruler`, `ui.aim`.
 *
 * @module ui/sky-tools
 */

/** True where 'Point at the sky' can work: orientation events, a secure page, a touch screen. */
export function canPointAtSky(win, coarse) {
    try {
        return !!coarse && !!win && 'DeviceOrientationEvent' in win && win.isSecureContext !== false;
    } catch {
        return false;
    }
}

/**
 * Keeps the ruler's and the pointing's chips in step with the store.
 * @param {any} ctx UiCtx (with ui.modes)
 * @returns {{destroy():void}}
 */
export function mountSkyTools(ctx) {
    const { store, ui } = ctx;
    function sync() {
        const st = store.get();
        const sky = st.view?.mode === 'sky';
        const r = sky ? st.ui?.ruler : null;
        const a = sky ? st.ui?.aim : null;
        if (r) {
            ui.modes.set('ruler', {
                icon: 'ruler', title: 'Angle ruler', live: true,
                detail: r.ends >= 2 && r.text ? `${cap(r.from)} → ${r.to}: ${r.text} at arm’s length`
                    : r.ends === 1 ? `From ${r.from}: now tap a second point` : 'Tap a body, a star or any point of the sky',
                exit: { label: 'Done', done: 'Ruler off', run: () => ui.act('setRuler', false) },
            });
        } else ui.modes.clear('ruler');
        if (a) {
            const starting = a.source === 'starting';
            ui.modes.set('aim', {
                icon: 'phone', title: 'Pointing with your phone', live: true,
                detail: starting ? 'Waiting for the compass…'
                    : a.aligned ? `Aligned on ${a.aligned}, still approximate`
                        : a.source === 'relative' ? 'No compass here: centre a bright body and choose Align'
                            : 'Approximate: centre a bright body, then choose Align',
                actions: [{ label: 'Align', disabled: starting, run: () => ui.act('alignAim') }],
                exit: { label: 'Stop', done: 'Stopped following the phone', run: () => ui.act('pointAtSky', false) },
            });
        } else ui.modes.clear('aim');
    }
    const offs = [
        store.subscribe((s) => s.view?.mode, sync),
        store.subscribe((s) => s.ui.ruler, sync),
        store.subscribe((s) => s.ui.aim, sync),
    ];
    sync();
    return { destroy() { offs.forEach((off) => off()); ui.modes.clear('ruler'); ui.modes.clear('aim'); } };
}

function cap(s) {
    const t = String(s ?? '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
