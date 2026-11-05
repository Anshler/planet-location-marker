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
import { t, N_ } from '../core/i18n.js';

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl';

/** Shortcut groups: [keys (alternatives separated by '|', chords by '+'), description]; English, t() where shown. */
export const SHORTCUTS = [
    { title: N_('Time'), rows: [
        ['Space', N_('Play / pause')],
        ['[|]', N_('Slower / faster')],
        ['R', N_('Reverse direction')],
        [',|.', N_('Step back / forward 1 hour')],
        ['Shift+,|Shift+.', N_('Step 1 day (or Shift with a step button)')],
        ['Alt+,|Alt+.', N_('Step 1 sidereal day (or Alt with a step button)')],
        ['N', N_('Now (live)')],
    ] },
    { title: N_('Bodies'), rows: [
        ['1–9', N_('Select Sun, Moon, Mercury … Neptune')],
        ['0', N_('Deselect')],
    ] },
    { title: N_('View'), rows: [
        ['V', N_('Globe / Sky view')],
        ['M', N_('World map (the globe unrolled) and back')],
        ['Esc', N_('Close a menu or dialog, then leave the newest mode shown at the top of the view, then clear the selection')],
        ['L', N_('Turn with the Earth, or hold the view still')],
        ['K', N_('Sky view: follow the selection, then the stars, then look freely')],
        ['A', N_('Sky view: measure the angle between two things (ruler)')],
        ['←|→|↑|↓', N_('Rotate the globe / look around')],
        ['+|−', N_('Zoom')],
        ['Home', N_('Reset the view (also in Tools)')],
        ['H', N_('Hide the interface (also in ⋯)')],
        ['Shift+N', N_('Night vision: a dim red screen that stays awake')],
        ['F', N_('Fullscreen')],
    ] },
    // The layers with a key, named as in Display (LAYER_GROUPS).
    { title: N_('Layers'), rows: LAYER_GROUPS.flatMap((g) => g.items.filter((it) => it[2]).map(([, label, keys]) => [keys.join('+'), label])) },
    { title: N_('App'), rows: [
        [`/|${MOD}+K`, N_('Search places and the sky')],
        ['S', N_('Share link')],
        ['?', N_('This help')],
        ['`', N_('Debug overlay')],
    ] },
];

/** Touch gestures: [gesture, what it does]. */
export const GESTURES = [
    [N_('Drag'), N_('Turn the globe; in Sky view, look around')],
    [N_('Pinch'), N_('Zoom in and out')],
    [N_('Tap a world'), N_('Meet it: the end of its beam or a row in Up now')],
    [N_('Tap the Earth'), N_('Stand there instead (Undo in the message)')],
    [N_('Double-tap'), N_('Fly closer; in Sky view, glide there and zoom in')],
    [N_('Drag the time bar'), N_('Travel through hours and days; ▶ plays time, Now comes back')],
    [N_('Drag the panel’s handle'), N_('Raise or lower the panel (phones)')],
    [N_('Tap the place name'), N_('Search for somewhere else')],
];

/** The mouse (fine pointers; the twin of GESTURES). */
export const MOUSE = [
    [N_('Click a world, its label or a row'), N_('Select it')],
    [N_('Click the Earth'), N_('Stand there (Undo in the message)')],
    [N_('Double-click'), N_('Fly closer; in Sky view, glide there and zoom in')],
    [N_('Drag'), N_('Turn the globe; in Sky view, look around')],
    [N_('Scroll'), N_('Zoom, from a telescope’s field out to the whole solar system')],
];

const actionList = (rows) => h('dl', { class: 'help__list' }, rows.map(([g, d]) => h('div', { class: 'help__row' },
    h('dt', { class: 'help__gesture' }, t(g)), h('dd', null, t(d)))));

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
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Close') }, icon('close', { size: 18 }));
    const keysBtn = h('button', { class: 'btn btn--soft btn--sm for-coarse', type: 'button', 'aria-expanded': 'false' },
        icon('keyboard', { size: 16 }), t('Keyboard shortcuts'));
    const tipsBtn = h('button', { class: 'btn btn--soft btn--sm', type: 'button' }, icon('sparkle', { size: 16 }), t('Show interface tips'));
    const dialog = h('div', { class: 'dialog help glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' },
        h('header', { class: 'dialog__head' },
            h('h2', { class: 'dialog__title', id: 'help-title' },
                h('span', { class: 'for-fine for-3d' }, icon('keyboard', { size: 20 }), t('Keyboard shortcuts and mouse')),
                h('span', { class: 'for-coarse for-3d' }, icon('help', { size: 20 }), t('Gestures')),
                h('span', { class: 'for-text' }, icon('keyboard', { size: 20 }), t('Keyboard shortcuts'))),
            closeBtn),
        h('section', { class: 'help__group help__touch for-coarse for-3d' }, actionList(GESTURES)),
        h('section', { class: 'help__group help__mouse for-fine for-3d' }, h('h3', { class: 'group-title' }, t('Mouse')), actionList(MOUSE)),
        h('div', { class: 'help__grid' }, SHORTCUTS.map((g) => h('section', { class: 'help__group' },
            h('h3', { class: 'group-title' }, t(g.title)),
            h('dl', { class: 'help__list' }, g.rows.map(([k, d]) => h('div', { class: 'help__row' },
                h('dt', null, keysEl(k)), h('dd', null, t(d)))))))),
        h('p', { class: 'note for-fine' }, t('Shortcuts are ignored while typing in a field, except Esc.'),
            h('span', { class: 'for-3d' }, ' ', t('On touch screens, drag to rotate and pinch to zoom.'))),
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
