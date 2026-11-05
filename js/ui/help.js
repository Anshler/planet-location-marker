/**
 * Help overlay (`?`, ⋯): the keyboard shortcuts (SPEC F.3) and the mouse, as a modal dialog bound
 * to `state.ui.help`. On a touch-first device (body.is-coarse) it opens on the gestures instead,
 * with the key table one tap away (a tablet may have a keyboard).
 *
 * @module ui/help
 */

import { h, on, kbd, trapFocus } from './dom.js';
import { icon } from './icons.js';
import { LAYER_GROUPS } from './layers.js';

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl';

/** Shortcut groups: [keys (alternatives separated by '|', chords by '+'), description]. */
export const SHORTCUTS = [
    { title: 'Time', rows: [
        ['Space', 'Play / pause'],
        ['[|]', 'Slower / faster'],
        ['R', 'Reverse direction'],
        [',|.', 'Step back / forward 1 hour'],
        ['Shift+,|Shift+.', 'Step 1 day (or Shift with a step button)'],
        ['Alt+,|Alt+.', 'Step 1 sidereal day (or Alt with a step button)'],
        ['N', 'Now (live)'],
    ] },
    { title: 'Bodies', rows: [
        ['1–9', 'Select Sun, Moon, Mercury … Neptune'],
        ['0', 'Deselect'],
    ] },
    { title: 'View', rows: [
        ['V', 'Globe / Sky view'],
        ['M', 'World map (the globe unrolled) and back'],
        ['Esc', 'Close a menu or dialog, then leave the newest mode shown at the top of the view, then clear the selection'],
        ['L', 'Turn with the Earth, or hold the view still'],
        ['K', 'Sky view: follow the selection, then the stars, then look freely'],
        ['A', 'Sky view: measure the angle between two things (ruler)'],
        ['←|→|↑|↓', 'Rotate the globe / look around'],
        ['+|−', 'Zoom'],
        ['Home', 'Reset the view (also in Tools)'],
        ['H', 'Hide the interface (also in ⋯)'],
        ['Shift+N', 'Night vision: a dim red screen that stays awake'],
        ['F', 'Fullscreen'],
    ] },
    // The layers with a key, named as in Display (LAYER_GROUPS).
    { title: 'Layers', rows: LAYER_GROUPS.flatMap((g) => g.items.filter((it) => it[2]).map(([, label, keys]) => [keys.join('+'), label])) },
    { title: 'App', rows: [
        [`/|${MOD}+K`, 'Search places and the sky'],
        ['S', 'Share link'],
        ['?', 'This help'],
        ['`', 'Debug overlay'],
    ] },
];

/** Touch gestures: [gesture, what it does]. */
export const GESTURES = [
    ['Drag', 'Turn the globe; in Sky view, look around'],
    ['Pinch', 'Zoom in and out'],
    ['Tap a world', 'Meet it: the end of its beam or a row in Up now'],
    ['Tap the Earth', 'Stand there instead (Undo in the message)'],
    ['Double-tap', 'Fly closer; in Sky view, glide there and zoom in'],
    ['Drag the time bar', 'Travel through hours and days; ▶ plays time, Now comes back'],
    ['Drag the panel’s handle', 'Raise or lower the panel (phones)'],
    ['Tap the place name', 'Search for somewhere else'],
];

/** The mouse (fine pointers; the twin of GESTURES). */
export const MOUSE = [
    ['Click a world, its label or a row', 'Select it'],
    ['Click the Earth', 'Stand there (Undo in the message)'],
    ['Double-click', 'Fly closer; in Sky view, glide there and zoom in'],
    ['Drag', 'Turn the globe; in Sky view, look around'],
    ['Scroll', 'Zoom, from a telescope’s field out to the whole solar system'],
];

const actionList = (rows) => h('dl', { class: 'help__list' }, rows.map(([g, d]) => h('div', { class: 'help__row' },
    h('dt', { class: 'help__gesture' }, g), h('dd', null, d))));

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
    const keysBtn = h('button', { class: 'btn btn--soft btn--sm for-coarse', type: 'button', 'aria-expanded': 'false' },
        icon('keyboard', { size: 16 }), 'Keyboard shortcuts');
    const tipsBtn = h('button', { class: 'btn btn--soft btn--sm', type: 'button' }, icon('sparkle', { size: 16 }), 'Show interface tips');
    const dialog = h('div', { class: 'dialog help glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' },
        h('header', { class: 'dialog__head' },
            h('h2', { class: 'dialog__title', id: 'help-title' },
                h('span', { class: 'for-fine for-3d' }, icon('keyboard', { size: 20 }), 'Keyboard shortcuts and mouse'),
                h('span', { class: 'for-coarse for-3d' }, icon('help', { size: 20 }), 'Gestures'),
                h('span', { class: 'for-text' }, icon('keyboard', { size: 20 }), 'Keyboard shortcuts')),
            closeBtn),
        h('section', { class: 'help__group help__touch for-coarse for-3d' }, actionList(GESTURES)),
        h('section', { class: 'help__group help__mouse for-fine for-3d' }, h('h3', { class: 'group-title' }, 'Mouse'), actionList(MOUSE)),
        h('div', { class: 'help__grid' }, SHORTCUTS.map((g) => h('section', { class: 'help__group' },
            h('h3', { class: 'group-title' }, g.title),
            h('dl', { class: 'help__list' }, g.rows.map(([k, d]) => h('div', { class: 'help__row' },
                h('dt', null, keysEl(k)), h('dd', null, d))))))),
        h('p', { class: 'note for-fine' }, 'Shortcuts are ignored while typing in a field, except Esc.',
            h('span', { class: 'for-3d' }, ' On touch screens, drag to rotate and pinch to zoom.')),
        h('div', { class: 'btn-row help__foot' }, keysBtn, tipsBtn));
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
    offs.push(on(tipsBtn, 'click', () => { close(); ui.showTips?.(); }));
    offs.push(on(keysBtn, 'click', () => {
        const open = dialog.classList.toggle('is-keys');
        keysBtn.setAttribute('aria-expanded', String(open));
    }));
    offs.push(on(layer.querySelector('.modal-backdrop'), 'click', close));
    offs.push(on(dialog, 'keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }));
    offs.push(store.subscribe((s) => s.ui?.help, (v) => show(!!v), { immediate: true }));
    offs.push(store.subscribe((s) => s.status?.webgl, (gl) => { tipsBtn.hidden = gl === false; }, { immediate: true }));

    return { destroy() { offs.forEach((off) => off()); release?.(); layer.remove(); } };
}
