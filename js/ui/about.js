/**
 * About tab: what the app is, the accuracy statement, credits, licence links
 * and a privacy note. (This file and js/geo/geocode.js are the only places
 * allowed to hold external https URLs — credit links.)
 *
 * @module ui/about
 */

import { APP_NAME, VERSION, REPO_URL } from '../version.js';
import { h, on } from './dom.js';
import { icon } from './icons.js';
import { brandMark } from './topbar.js';

/** Third-party credits: [name, version/role, licence, url]. */
export const CREDITS = [
    ['three.js', 'r170 · 3D rendering', 'MIT', 'https://github.com/mrdoob/three.js/blob/dev/LICENSE'],
    ['astronomy-engine', '2.1.19 · positions, rise/set, eclipses', 'MIT', 'https://github.com/cosinekitty/astronomy'],
    ['d3-celestial', 'star catalogue (Hipparcos), constellations, Milky Way', 'BSD 3-Clause', 'https://github.com/ofrohn/d3-celestial'],
    ['GeoNames', 'offline city list', 'CC BY 4.0', 'https://www.geonames.org/'],
    ['NASA Visible Earth', 'Earth and Moon imagery via three.js examples', 'Public domain', 'https://visibleearth.nasa.gov/'],
    ['Open-Meteo Geocoding', 'online place search', 'CC BY 4.0', 'https://open-meteo.com/'],
    ['Photon by Komoot', 'online place search', 'OpenStreetMap data, ODbL', 'https://photon.komoot.io/'],
    ['Nominatim', 'online place search', 'OpenStreetMap data, ODbL', 'https://www.openstreetmap.org/copyright'],
];

/**
 * Mounts the About tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountAbout(root, ctx) {
    const { ui } = ctx;
    const offs = [];
    const link = (href, text, cls = 'link') => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' },
        text, icon('external', { size: 13 }));

    const keysBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('keyboard', { size: 16 }), 'Keyboard shortcuts');
    offs.push(on(keysBtn, 'click', () => ui.toggleHelp(true)));

    root.append(
        h('div', { class: 'about-hero' },
            brandMark(40),
            h('div', null,
                h('h2', { class: 'about-hero__name' }, APP_NAME, h('span', { class: 'pill pill--version' }, `v${VERSION}`)),
                h('p', { class: 'about-hero__tag' }, 'Stand anywhere on Earth. See where every world is right now.'))),
        h('div', { class: 'group' },
            h('h3', { class: 'group-title' }, 'Accuracy'),
            h('p', { class: 'prose' }, 'Positions computed in your browser with astronomy-engine (VSOP87/ELP; accurate to about 1 arcminute, 1800–2200).'),
            h('p', { class: 'prose' }, 'Drawn positions are astrometric J2000; tables show apparent, refracted values.'),
            h('p', { class: 'prose prose--muted' }, 'Dates from 1000 to 3000 are supported, with reduced accuracy outside 1800–2200. '
                + 'For a point clicked far from any listed city, the local time zone is estimated from longitude and marked “approx.”.')),
        h('div', { class: 'group' },
            h('h3', { class: 'group-title' }, 'Credits'),
            h('p', { class: 'prose' }, 'Stars: Hipparcos via d3-celestial. Imagery: NASA Visible Earth via three.js. Cities: GeoNames (CC BY 4.0). '
                + 'Clouds are illustrative, not live weather.'),
            h('ul', { class: 'credits' }, CREDITS.map(([name, role, lic, url]) => h('li', { class: 'credit' },
                h('span', { class: 'credit__main' }, link(url, name, 'link credit__name'), h('span', { class: 'credit__role' }, role)),
                h('span', { class: 'credit__lic' }, lic))))),
        h('div', { class: 'group' },
            h('h3', { class: 'group-title' }, 'Privacy'),
            h('p', { class: 'prose' }, 'Everything is computed on this device and nothing is tracked. A place search is sent to the online geocoders only '
                + 'when you type in the search box; “Use my location” is used only on this device.')),
        h('div', { class: 'btn-row btn-row--wrap' },
            link(REPO_URL, 'Source code', 'btn btn--soft'),
            h('a', { class: 'btn btn--soft', href: 'THIRD_PARTY_NOTICES.md', target: '_blank', rel: 'noopener' }, 'Third-party notices'),
            keysBtn),
        h('p', { class: 'note' }, `${APP_NAME} ${VERSION}. Made for curious people everywhere.`));

    return { destroy() { offs.forEach((off) => off()); root.textContent = ''; } };
}
