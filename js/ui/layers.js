/**
 * Layers tab: one switch per layer (SPEC F.2 list), grouped, each showing its
 * keyboard shortcut. Switches call `actions.toggleLayer(key, on)`.
 *
 * @module ui/layers
 */

import { h, switchRow } from './dom.js';

/** Layer switches in display order: [key, label, keys?, description?]. */
export const LAYER_GROUPS = [
    {
        title: 'Beams',
        items: [
            ['beams', 'Beams', ['B'], 'A line of sight from you to every body'],
            ['ghostBeams', 'Through-Earth beams', null, 'Dashed where a beam passes through the planet'],
            ['sunMoonBeams', 'Sun & Moon beams', null, null],
        ],
    },
    {
        title: 'Sky',
        items: [
            ['stars', 'Stars', null, null],
            ['constellations', 'Constellation lines', ['C'], null],
            ['constellationNames', 'Constellation names', ['Shift', 'C'], null],
            ['starNames', 'Star names', null, null],
            ['milkyWay', 'Milky Way', ['M'], null],
            ['ecliptic', 'Ecliptic', ['E'], 'The Sun’s yearly path; planets stay close to it'],
            ['eqGrid', 'Equatorial grid', ['G'], 'Right ascension and declination'],
            ['altAzGrid', 'Horizon grid (Sky view)', null, 'Altitude and azimuth when standing on the ground'],
        ],
    },
    {
        title: 'Earth',
        items: [
            ['clouds', 'Clouds', null, 'Illustrative, not live weather'],
            ['atmosphere', 'Atmosphere', null, null],
            ['horizon', 'Horizon disc', null, 'Your local horizon with compass ticks'],
            ['footprint', 'Visibility footprint', ['O'], 'Where on Earth the selected body is up'],
            ['subpoints', 'Sub-points', null, 'The spot on Earth directly below each body'],
        ],
    },
    {
        title: 'Overlays',
        items: [
            ['trails', 'Path of selected body', ['T'], 'Six months either side, with retrograde loops'],
            ['labels', 'Labels', null, null],
        ],
    },
];

/**
 * Mounts the Layers tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountLayers(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    /** @type {Record<string, ReturnType<typeof switchRow>>} */
    const rows = {};

    root.append(h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Layers')));
    for (const g of LAYER_GROUPS) {
        const box = h('div', { class: 'group', role: 'group', 'aria-label': g.title }, h('h3', { class: 'group-title' }, g.title));
        for (const [key, label, keys, desc] of g.items) {
            const row = switchRow({
                label, desc: desc || undefined, keys: keys || undefined, checked: !!store.get().layers?.[key],
                onChange: (on) => {
                    if (typeof ctx.actions?.toggleLayer === 'function') ui.act('toggleLayer', key, on);
                    else store.set({ layers: { ...store.get().layers, [key]: on } });
                },
            });
            rows[key] = row;
            box.appendChild(row.el);
        }
        root.appendChild(box);
    }
    root.appendChild(h('p', { class: 'note' }, 'Layer choices are remembered on this device and included in shared links.'));

    const sync = () => {
        const ly = store.get().layers || {};
        for (const key in rows) rows[key].set(!!ly[key]);
        const low = store.get().quality?.active === 'low';
        rows.clouds?.setNote(low ? 'Not drawn at Low quality' : '');
    };
    offs.push(store.subscribe((s) => s.layers, sync));
    offs.push(store.subscribe((s) => s.quality, sync));
    sync();

    return { destroy() { offs.forEach((off) => off()); root.textContent = ''; } };
}
