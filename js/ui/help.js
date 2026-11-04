/**
 * Help overlay (`?`): the keyboard shortcut table from SPEC F.3, as a modal
 * dialog bound to `state.ui.help`. On a touch-first device (body.is-coarse) it opens on the
 * gestures instead, with the key table one tap away (a tablet may have a keyboard).
 * `helpButton(ui)` is the 'Keyboard shortcuts' / 'Gestures and help' button of Settings and About.
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
        ['M', 'World map (the globe unrolled) and back'],
        ['Esc', 'Leave a vantage point (View from L1, Earthrise) or the world map'],
        ['L', 'Lock view to Earth'],
        ['K', 'Sky view: track the body, then the stars'],
        ['A', 'Sky view: measure the angle between two things (ruler)'],
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
        ['Shift+M', 'Milky Way'],
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

/** Touch gestures: [gesture, what it does]. */
export const GESTURES = [
    ['Drag', 'Turn the globe; in Sky view, look around'],
    ['Pinch', 'Zoom in and out'],
    ['Tap a world', 'Meet it: the end of its beam, a row in Sky now or a chip under the time bar'],
    ['Tap the Earth', 'Stand there instead (Undo in the message)'],
    ['Double-tap', 'Fly closer; in Sky view, glide there and zoom in'],
    ['Drag the time bar', 'Travel through hours and days; ▶ plays time, Now comes back'],
    ['Drag the panel’s handle', 'Raise or lower the panel (phones)'],
    ['Tap the place name', 'Search for somewhere else'],
];

/**
 * The button that opens this dialog: 'Keyboard shortcuts' with a mouse, 'Gestures and help' on touch.
 * @param {any} ui the UI hub
 * @returns {{el: HTMLElement, off: () => void}}
 */
export function helpButton(ui) {
    const el = h('button', { class: 'btn btn--soft', type: 'button' },
        h('span', { class: 'for-fine' }, icon('keyboard', { size: 16 }), 'Keyboard shortcuts'),
        h('span', { class: 'for-coarse' }, icon('help', { size: 16 }), 'Gestures and help'));
    return { el, off: on(el, 'click', () => ui.toggleHelp(true)) };
}

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
                h('span', { class: 'for-fine' }, icon('keyboard', { size: 20 }), 'Keyboard shortcuts'),
                h('span', { class: 'for-coarse' }, icon('help', { size: 20 }), 'Gestures')),
            closeBtn),
        h('section', { class: 'help__group help__touch for-coarse' },
            h('dl', { class: 'help__list' }, GESTURES.map(([g, d]) => h('div', { class: 'help__row' },
                h('dt', { class: 'help__gesture' }, g), h('dd', null, d))))),
        h('div', { class: 'help__grid' }, SHORTCUTS.map((g) => h('section', { class: 'help__group' },
            h('h3', { class: 'group-title' }, g.title),
            h('dl', { class: 'help__list' }, g.rows.map(([k, d]) => h('div', { class: 'help__row' },
                h('dt', null, keysEl(k)), h('dd', null, d))))))),
        h('p', { class: 'note for-fine' }, 'Shortcuts are ignored while typing in a field, except Esc. On touch screens, drag to rotate and pinch to zoom.'),
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
