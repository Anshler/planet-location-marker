/**
 * Help overlay (`?`): the keyboard shortcut table from SPEC F.3, as a modal
 * dialog bound to `state.ui.help`.
 *
 * @module ui/help
 */

import { h, on, kbd, trapFocus } from './dom.js';
import { icon } from './icons.js';

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl';

/** Shortcut groups: [keys (alternatives separated by '|', chords by '+'), description]. */
export const SHORTCUTS = [
    { title: 'Time', rows: [
        ['Space', 'Play / pause'],
        ['[|]', 'Slower / faster'],
        ['R', 'Reverse direction'],
        [',|.', 'Step back / forward 1 hour'],
        ['Shift+,|Shift+.', 'Step 1 day'],
        ['Alt+,|Alt+.', 'Step 1 sidereal day'],
        ['N', 'Now (live)'],
    ] },
    { title: 'Bodies', rows: [
        ['1–9', 'Select Sun, Moon, Mercury … Neptune'],
        ['0|Esc', 'Deselect / close dialog'],
    ] },
    { title: 'View', rows: [
        ['V', 'Globe / Sky view'],
        ['L', 'Lock view to Earth'],
        ['←|→|↑|↓', 'Rotate the globe / look around'],
        ['+|−', 'Zoom'],
        ['Home', 'Reset camera'],
        ['H', 'Hide the interface'],
        ['F', 'Fullscreen'],
    ] },
    { title: 'Layers', rows: [
        ['B', 'Beams'],
        ['C', 'Constellation lines'],
        ['Shift+C', 'Constellation names'],
        ['M', 'Milky Way'],
        ['E', 'Ecliptic'],
        ['G', 'Equatorial grid'],
        ['O', 'Visibility footprint'],
        ['T', 'Path of selected body'],
    ] },
    { title: 'App', rows: [
        [`/|${MOD}+K`, 'Search places'],
        ['S', 'Share link'],
        ['?', 'This help'],
        ['`', 'Debug overlay'],
    ] },
];

function keysEl(spec) {
    const wrap = h('span', { class: 'help__keys' });
    spec.split('|').forEach((alt, i) => {
        if (i) wrap.appendChild(h('span', { class: 'help__or' }, ' '));
        wrap.appendChild(kbd(...alt.split(/\+(?=.)/)));
    });
    return wrap;
}

/**
 * Mounts the help dialog.
 * @param {HTMLElement} root overlay container
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountHelp(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, icon('close', { size: 18 }));
    const dialog = h('div', { class: 'dialog help glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' },
        h('header', { class: 'dialog__head' },
            h('h2', { class: 'dialog__title', id: 'help-title' }, icon('keyboard', { size: 20 }), 'Keyboard shortcuts'),
            closeBtn),
        h('div', { class: 'help__grid' }, SHORTCUTS.map((g) => h('section', { class: 'help__group' },
            h('h3', { class: 'group-title' }, g.title),
            h('dl', { class: 'help__list' }, g.rows.map(([k, d]) => h('div', { class: 'help__row' },
                h('dt', null, keysEl(k)), h('dd', null, d))))))),
        h('p', { class: 'note' }, 'Shortcuts are ignored while typing in a field, except Esc. On touch screens, drag to rotate and pinch to zoom.'));
    const layer = h('div', { class: 'modal-layer help-layer', hidden: true }, h('div', { class: 'modal-backdrop' }), dialog);
    root.appendChild(layer);

    let release = null;
    function show(open) {
        if (open === !layer.hidden) return;
        layer.hidden = !open;
        layer.classList.toggle('is-open', open);
        if (open) release = trapFocus(dialog, { initial: closeBtn });
        else { release?.(); release = null; }
    }
    const close = () => ui.toggleHelp(false);
    offs.push(on(closeBtn, 'click', close));
    offs.push(on(layer.querySelector('.modal-backdrop'), 'click', close));
    offs.push(on(dialog, 'keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }));
    offs.push(store.subscribe((s) => s.ui?.help, (v) => show(!!v), { immediate: true }));

    return { destroy() { offs.forEach((off) => off()); release?.(); layer.remove(); } };
}
