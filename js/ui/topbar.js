/**
 * Top bar: the small wordmark, the location chip ("Hanoi, Vietnam · 21.03° N 105.85° E",
 * pin icon) and the search button. Both the chip and the button open the
 * location palette.
 *
 * @module ui/topbar
 */

import { APP_NAME } from '../version.js';
import { h, s, on, setText, uid } from './dom.js';
import { icon } from './icons.js';
import { marsSiteNear } from '../astro/mars-clock.js';

/**
 * The brand mark: a small Earth with a beam toward a planet.
 * @returns {SVGElement}
 */
export function brandMark(size = 22) {
    // A page-unique gradient id: the mark is drawn twice (top bar, About), and a hidden copy's id would not paint.
    const id = uid('pc-brand');
    return s('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'brand__mark' },
        s('defs', null,
            s('radialGradient', { id, cx: '36%', cy: '34%', r: '72%' },
                s('stop', { offset: '0', 'stop-color': '#a8dcff' }),
                s('stop', { offset: '0.55', 'stop-color': '#3a7fc4' }),
                s('stop', { offset: '1', 'stop-color': '#0f2a4d' }))),
        s('circle', { cx: 9.6, cy: 14.4, r: 7.2, fill: `url(#${id})` }),
        s('path', { d: 'M3 15.2c2.6 1.4 6.8 1.7 10.4.2', stroke: 'rgba(255,255,255,.35)', 'stroke-width': 0.9, fill: 'none', 'stroke-linecap': 'round' }),
        s('path', { d: 'M9.6 14.4L19.6 4.4', stroke: '#ffd36b', 'stroke-width': 1.7, 'stroke-linecap': 'round' }),
        s('circle', { cx: 19.9, cy: 4.1, r: 2, fill: '#ff6a3d' }),
        s('circle', { cx: 9.6, cy: 14.4, r: 1.5, fill: '#ffffff' }));
}

/**
 * Mounts the top bar.
 * @param {HTMLElement} root `<header class="topbar">`
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountTopbar(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];

    const brand = h('div', { class: 'brand' }, brandMark(), h('span', { class: 'brand__name' }, APP_NAME));
    const chipName = h('span', { class: 'loc-chip__name' });
    const chipCoords = h('span', { class: 'loc-chip__coords' });
    const chip = h('button', {
        class: 'loc-chip glass', type: 'button', 'aria-haspopup': 'dialog',
    }, h('span', { class: 'loc-chip__icon' }, icon('pin', { size: 18 })), chipName,
    h('span', { class: 'loc-chip__sep', 'aria-hidden': 'true' }, '·'), chipCoords);
    const search = h('button', {
        class: 'icon-btn icon-btn--glass glass', type: 'button', 'aria-label': 'Search places', 'aria-haspopup': 'dialog',
        'data-tip': 'Search places', 'data-kbd': '/', 'data-tip-side': 'bottom',
    }, icon('search', { size: 19 }));

    // Standing on Mars: the chip names the Martian site, and a button goes home.
    const home = h('button', {
        class: 'btn btn--soft glass topbar__home', type: 'button', hidden: true, 'data-tip': 'Back to the Earth', 'data-tip-side': 'bottom',
    }, icon('globe', { size: 16 }), h('span', null, 'Back to Earth'));
    root.append(brand, h('div', { class: 'topbar__loc' }, chip, search, home));
    offs.push(on(home, 'click', () => ui.act('leaveMars')));

    offs.push(on(chip, 'click', () => ui.openPalette()));
    offs.push(on(search, 'click', () => ui.openPalette()));

    const render = () => {
        const host = store.get().host;
        const mars = host?.id === 'mars';
        home.hidden = !mars;
        if (mars) {
            const site = marsSiteNear(host.latDeg, host.lonDeg, 0.5);
            const label = `${host.name || site?.name || 'Mars'}, Mars`;
            const coords = ui.latLonText(host.latDeg, host.lonDeg, 2);
            setText(chipName, label);
            setText(chipCoords, coords);
            chip.setAttribute('aria-label', `Standing on Mars: ${label}, ${coords}. Choose a place`);
            chip.title = `${label} · ${coords} (planetocentric, east longitude)`;
            return;
        }
        const o = store.get().observer;
        if (!o) return;
        let label = ui.placeLabel(o);
        label = label.charAt(0).toUpperCase() + label.slice(1);
        const coords = ui.latLonText(o.latDeg, o.lonDeg, 2);
        setText(chipName, label);
        setText(chipCoords, coords);
        chip.setAttribute('aria-label', `Location: ${label}, ${coords}. Change location`);
        chip.title = `${label} · ${coords}`;
    };
    offs.push(store.subscribe((st) => st.observer, render, { immediate: true }));
    offs.push(store.subscribe((st) => st.host, render));
    // Offline cities load after mount; a nameless observer can then say "near …".
    const retry = setInterval(() => {
        const c = ctx.services?.cities;
        if (c && c.ready !== false) { render(); clearInterval(retry); }
    }, 1000);

    return {
        destroy() {
            offs.forEach((off) => off());
            clearInterval(retry);
            root.textContent = '';
        },
    };
}
