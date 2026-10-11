/**
 * Settings tab: quality (Auto / Low / Medium / High with the running tier),
 * time display zone (Observer / Device / UTC), 24-hour clock, Earth-lock,
 * Replay intro, keyboard shortcuts and Reset all settings (with confirmation).
 *
 * @module ui/settings
 */

import { DEFAULT_STATE } from '../core/store.js';
import { h, on, setText, segmented, switchRow } from './dom.js';
import { icon } from './icons.js';

const TIER_NAME = { low: 'Low', medium: 'Medium', high: 'High' };

/**
 * Mounts the Settings tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountSettings(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const st0 = store.get();

    // Quality.
    const quality = segmented({
        label: 'Quality',
        options: [{ value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
        value: st0.quality?.setting || 'auto',
        onChange: (v) => ui.act('setQuality', v),
    });
    const running = h('p', { class: 'setting__hint' });

    // Time display.
    const tzMode = segmented({
        label: 'Show times in',
        options: [{ value: 'observer', label: 'Observer' }, { value: 'device', label: 'Device' }, { value: 'utc', label: 'UTC' }],
        value: st0.display?.tzMode || 'observer',
        onChange: (v) => {
            if (typeof ctx.actions?.setTzMode === 'function') ui.act('setTzMode', v);
            else store.set({ display: { ...store.get().display, tzMode: v } });
        },
    });
    const tzHint = h('p', { class: 'setting__hint' });
    const clock24 = switchRow({
        label: '24-hour clock', checked: !st0.display?.hour12,
        onChange: (on24) => store.set({ display: { ...store.get().display, hour12: !on24 } }),
    });

    // View.
    const lock = switchRow({
        label: 'Lock view to Earth', keys: ['L'], desc: 'The camera turns with the Earth, so your location stays in view',
        checked: !!st0.view?.earthLock, onChange: (v) => ui.act('setEarthLock', v),
    });

    // Actions.
    const replay = h('button', { class: 'btn btn--soft', type: 'button' }, icon('play', { size: 14 }), 'Replay intro');
    const keys = h('button', { class: 'btn btn--soft', type: 'button' }, icon('keyboard', { size: 16 }), 'Keyboard shortcuts');
    const reset = h('button', { class: 'btn btn--danger-ghost', type: 'button' }, icon('undo', { size: 16 }), 'Reset all settings');
    const confirmYes = h('button', { class: 'btn btn--danger', type: 'button' }, 'Reset');
    const confirmNo = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
    const confirm = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm reset', hidden: true },
        h('p', { class: 'confirm__text' }, 'Reset layers, quality and time display to their defaults? Your location is kept.'),
        h('div', { class: 'confirm__actions' }, confirmNo, confirmYes));
    const motion = h('p', { class: 'note' });

    root.append(
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Settings')),
        h('div', { class: 'group' }, h('h3', { class: 'group-title' }, 'Quality'), quality.el, running),
        h('div', { class: 'group' }, h('h3', { class: 'group-title' }, 'Time display'), tzMode.el, tzHint, clock24.el),
        h('div', { class: 'group' }, h('h3', { class: 'group-title' }, 'View'), lock.el),
        h('div', { class: 'group group--actions' }, h('div', { class: 'btn-row' }, replay, keys), reset, confirm),
        motion);

    offs.push(on(replay, 'click', () => ui.act('replayIntro')));
    offs.push(on(keys, 'click', () => ui.toggleHelp(true)));
    offs.push(on(reset, 'click', () => { confirm.hidden = false; reset.hidden = true; confirmNo.focus(); }));
    offs.push(on(confirmNo, 'click', () => { confirm.hidden = true; reset.hidden = false; reset.focus(); }));
    offs.push(on(confirmYes, 'click', () => {
        const d = DEFAULT_STATE || {};
        if (d.layers) store.set({ layers: { ...d.layers } });
        if (d.display) store.set({ display: { ...d.display } });
        ui.act('setQuality', d.quality?.setting || 'auto');
        ui.act('setTzMode', d.display?.tzMode || 'observer');
        ui.act('setEarthLock', d.view?.earthLock ?? true);
        confirm.hidden = true;
        reset.hidden = false;
        reset.focus();
        ctx.bus.emit('toast', { message: 'Settings reset to defaults', kind: 'info', timeoutMs: 3000 });
    }));

    const sync = () => {
        const st = store.get();
        quality.set(st.quality?.setting || 'auto');
        const active = TIER_NAME[st.quality?.active] || 'Medium';
        setText(running, `Running: ${active}${st.quality?.setting === 'auto' ? ' · chosen automatically for this device' : ''}`);
        tzMode.set(st.display?.tzMode || 'observer');
        const mode = st.display?.tzMode || 'observer';
        const t = ui.snap?.tMs ?? ctx.clock?.tMs ?? Date.now();
        setText(tzHint, mode === 'utc' ? 'Coordinated Universal Time.'
            : mode === 'device' ? `This device’s zone (${ui.offsetText(t)}).`
                : `${ui.placeShort(st.observer)} time (${ui.offsetText(t)}${st.observer?.tzApprox ? ', approximate' : ''}).`);
        clock24.set(!st.display?.hour12);
        lock.set(!!st.view?.earthLock);
        setText(motion, st.status?.reducedMotion || ui.reducedMotion()
            ? 'Reduced motion is on (system setting): transitions are cuts and the intro is skipped.'
            : 'Animations follow your system’s motion preference.');
    };
    offs.push(store.subscribe((s) => s.quality, sync));
    offs.push(store.subscribe((s) => s.display, sync));
    offs.push(store.subscribe((s) => s.view, sync));
    offs.push(store.subscribe((s) => s.observer, sync));
    offs.push(store.subscribe((s) => s.status, sync));
    sync();

    return { destroy() { offs.forEach((off) => off()); root.textContent = ''; } };
}
