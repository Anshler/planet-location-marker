/**
 * Settings tab: quality (Auto / Low / Medium / High / Max with the running tier),
 * time display zone (Observer / Device / UTC), 24-hour clock, sky darkness
 * (Auto from location / Pristine / Bortle 1–9), aurora activity (Quiet / Typical / Storm: the
 * modelled ovals, not live data), Earth-lock, night vision (the screen dim red and kept awake;
 * main.js bindNightVision), Replay intro, Show interface tips (ui/coach.js), keyboard shortcuts (gestures on touch) and
 * Reset all settings (with confirmation).
 *
 * @module ui/settings
 */

import { DEFAULT_STATE } from '../core/store.js';
import { ovalSummary } from '../astro/geomag.js';
import { h, on, setText, segmented, switchRow } from './dom.js';
import { icon } from './icons.js';
import { helpButton } from './help.js';

const TIER_NAME = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
/** Bortle's names for classes 1…9. */
const BORTLE_NAMES = ['Excellent dark site', 'Typical dark site', 'Rural sky', 'Rural/suburban transition', 'Suburban sky',
    'Bright suburban sky', 'Suburban/urban transition', 'City sky', 'Inner-city sky'];
/** Max is never chosen automatically, so its cost is spelled out next to the choice. */
const MAX_CAPTION = 'Everything at full detail: 8K Earth maps, full screen resolution, every effect at its finest. '
    + 'Large download (about 15 MB more); for fast GPUs.';

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
        options: [{ value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }],
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

    // Sky darkness (light pollution in sky view; js/astro/skyglow.js).
    const skyId = 'settings-sky-dark';
    const skyDark = h('select', { class: 'select', id: skyId },
        h('option', { value: 'auto' }, 'Auto (from location)'),
        h('option', { value: 'pristine' }, 'Pristine (no light pollution)'),
        ...BORTLE_NAMES.map((name, i) => h('option', { value: String(i + 1) }, `Bortle ${i + 1} · ${name}`)));
    skyDark.value = st0.display?.skyDark || 'auto';
    const skyHint = h('p', { class: 'setting__hint' });
    offs.push(on(skyDark, 'change', () => ui.act('setSkyDark', skyDark.value)));

    // Aurora activity (the Kp the modelled ovals are drawn for; js/astro/geomag.js). No live data.
    const auroraId = 'settings-aurora';
    const aurora = h('select', { class: 'select', id: auroraId },
        h('option', { value: 'quiet' }, 'Quiet (Kp 1)'),
        h('option', { value: 'typical' }, 'Typical (Kp 3)'),
        h('option', { value: 'storm' }, 'Storm (Kp 7)'));
    aurora.value = st0.display?.aurora || 'typical';
    const auroraHint = h('p', { class: 'setting__hint' });
    offs.push(on(aurora, 'change', () => ui.act('setAuroraActivity', aurora.value)));

    // View.
    const lock = switchRow({
        label: 'Lock view to Earth', keys: ['L'], desc: 'The camera turns with the Earth, so your location stays in view',
        checked: !!st0.view?.earthLock, onChange: (v) => ui.act('setEarthLock', v),
    });

    // Night vision: a device preference (display.red, saved, never in links).
    const red = switchRow({
        label: 'Night vision', keys: ['Shift', 'N'],
        desc: 'A dim red screen that keeps your eyes dark-adapted outdoors. The screen stays awake while it is on',
        checked: !!st0.display?.red, onChange: (v) => ui.act('setNightVision', v),
        note: globalThis.navigator && !('wakeLock' in navigator) ? 'This browser cannot keep the screen awake' : '',
    });

    // Actions.
    const replay = h('button', { class: 'btn btn--soft', type: 'button' }, icon('play', { size: 14 }), 'Replay intro');
    // The coach marks again (ui/coach.js; the 3D view only).
    const tips = h('button', { class: 'btn btn--soft', type: 'button' }, icon('sparkle', { size: 16 }), 'Show interface tips');
    const keys = helpButton(ui);
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
        h('div', { class: 'group' }, h('h3', { class: 'group-title' }, h('label', { for: skyId }, 'Sky darkness')), skyDark, skyHint),
        h('div', { class: 'group' }, h('h3', { class: 'group-title' }, h('label', { for: auroraId }, 'Aurora activity')), aurora, auroraHint),
        h('div', { class: 'group' }, h('h3', { class: 'group-title' }, 'View'), lock.el, red.el),
        h('div', { class: 'group group--actions' }, h('div', { class: 'btn-row' }, replay, tips, keys.el), reset, confirm),
        motion);

    offs.push(on(replay, 'click', () => ui.act('replayIntro')));
    offs.push(on(tips, 'click', () => ui.showTips()));
    offs.push(keys.off);
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
        setText(running, st.quality?.setting === 'max' ? MAX_CAPTION
            : `Running: ${active}${st.quality?.setting === 'auto' ? ' · chosen automatically for this device' : ''}`);
        tzMode.set(st.display?.tzMode || 'observer');
        const mode = st.display?.tzMode || 'observer';
        const t = ui.snap?.tMs ?? ctx.clock?.tMs ?? Date.now();
        setText(tzHint, mode === 'utc' ? 'Coordinated Universal Time.'
            : mode === 'device' ? `This device’s zone (${ui.offsetText(t)}).`
                : `${ui.placeShort(st.observer)} time (${ui.offsetText(t)}${st.observer?.tzApprox ? ', approximate' : ''}).`);
        clock24.set(!st.display?.hour12);
        const sd = st.display?.skyDark || 'auto';
        if (skyDark.value !== sd) skyDark.value = sd;
        const sg = ui.snap?.skyglow;
        setText(skyHint, sd === 'auto'
            ? `${sg?.auto ? `Estimated Bortle ${sg.bortle} from the cities around ${ui.placeShort(st.observer)}` : 'Estimated from the cities around you'}: moonlight and city glow brighten the sky view and hide faint stars.`
            : sd === 'pristine' ? 'No light pollution: the sky of a remote dark site, with moonlight only.'
                : `Bortle ${sd}: the sky of ${BORTLE_NAMES[Number(sd) - 1].toLowerCase()}, wherever you are.`);
        const au = st.display?.aurora || 'typical';
        if (aurora.value !== au) aurora.value = au;
        setText(auroraHint, ovalSummary(au));
        lock.set(!!st.view?.earthLock);
        red.set(!!st.display?.red);
        tips.hidden = st.status?.webgl === false;
        setText(motion, st.status?.reducedMotion || ui.reducedMotion()
            ? 'Reduced motion is on (system setting): transitions are cuts and the intro is skipped.'
            : 'Animations follow your system’s motion preference.');
    };
    offs.push(store.subscribe((s) => s.quality, sync));
    offs.push(store.subscribe((s) => s.display, sync));
    offs.push(store.subscribe((s) => s.view, sync));
    offs.push(store.subscribe((s) => s.observer, sync));
    offs.push(store.subscribe((s) => s.status, sync));
    // The estimated class arrives with the readouts (snap.skyglow).
    let lastSky = '';
    offs.push(ui.on('snap', (snap) => {
        const key = `${snap?.skyglow?.auto}|${snap?.skyglow?.bortle}`;
        if (key !== lastSky) { lastSky = key; sync(); }
    }));
    sync();

    return { destroy() { offs.forEach((off) => off()); root.textContent = ''; } };
}
