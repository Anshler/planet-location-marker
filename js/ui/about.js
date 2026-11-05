/**
 * About this app, inside Display (ui/layers.js): what the app is, 'Install app' when the browser
 * offers it (ui/install.js), 'Report a problem' (ui/report.js: Copy diagnostics and a new issue on
 * REPO_URL), the accuracy statement, credits, a privacy note and the licence links. (This file and
 * js/geo/geocode.js are the only places allowed to hold external https URLs — credit links.)
 *
 * @module ui/about
 */

import { APP_NAME, VERSION, REPO_URL } from '../version.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { brandMark } from './topbar.js';
import { mountInstall } from './install.js';
import { mountReport } from './report.js';
import { t, N_ } from '../core/i18n.js';

/** Third-party credits: [name, version/role, licence, url] (roles and licence words English; t() where shown). */
export const CREDITS = [
    ['three.js', N_('r170 · 3D rendering'), 'MIT', 'https://github.com/mrdoob/three.js/blob/dev/LICENSE'],
    ['astronomy-engine', N_('2.1.19 · positions, rise/set, eclipses'), 'MIT', 'https://github.com/cosinekitty/astronomy'],
    ['d3-celestial', N_('star catalogue (Hipparcos), star names, constellations, Milky Way, Messier catalogue'), 'BSD 3-Clause', 'https://github.com/ofrohn/d3-celestial'],
    ['Hipparcos, the New Reduction (van Leeuwen 2007, ESA) via NASA HEASARC', N_('star distances (parallaxes) and proper motions'), N_('Public data'), 'https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/hipnewcat.html'],
    ['GeoNames', N_('offline city list'), 'CC BY 4.0', 'https://www.geonames.org/'],
    ['JPL Horizons (NASA/JPL-Caltech)', N_('Voyager, New Horizons and JWST trajectories; Halley’s Comet orbits per apparition (after Yeomans & Kiang 1981)'), N_('Public data'), 'https://ssd.jpl.nasa.gov/horizons/'],
    ['CelesTrak (T. S. Kelso)', N_('orbital elements of the ISS, Tiangong, Hubble and bright rocket bodies (refreshed with each deploy; SGP4 after Vallado et al. 2006)'), N_('Public data'), 'https://celestrak.org/'],
    ['Stephenson & Green, Historical Supernovae and their Remnants (2002)', N_('the guest stars of 1006, 1054, 1181, 1572 and 1604: dates and brightness from the records'), N_('Facts cited'), 'https://global.oup.com/academic/product/historical-supernovae-and-their-remnants-9780198507666'],
    ['Solar System Scope', N_('Earth day, night and cloud maps (via three.js examples); 8K Earth and 4K Moon maps on Max quality'), 'CC BY 4.0', 'https://www.solarsystemscope.com/textures/'],
    ['NASA Visible Earth', N_('Moon imagery via three.js examples'), N_('Public domain'), 'https://visibleearth.nasa.gov/'],
    ['International Meteor Organization', N_('meteor shower calendar: peaks (solar longitude), radiants, ZHR, velocities'), N_('Facts, cited'), 'https://www.imo.net/resources/calendar/'],
    ['Open-Meteo Geocoding', N_('online place search'), 'CC BY 4.0', 'https://open-meteo.com/'],
    ['Photon by Komoot', N_('online place search'), N_('OpenStreetMap data, ODbL'), 'https://photon.komoot.io/'],
    ['Nominatim', N_('online place search'), N_('OpenStreetMap data, ODbL'), 'https://www.openstreetmap.org/copyright'],
];

/**
 * Mounts About this app.
 * @param {HTMLElement} root its group's body
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountAbout(root, ctx) {
    const offs = [];
    const link = (href, text, cls = 'link') => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' },
        text, icon('external', { size: 13 }));

    // 'Install app' (beforeinstallprompt) or how to add it to an iPhone's Home Screen (ui/install.js).
    const install = mountInstall(ctx);
    // Copy diagnostics and the prefilled issue link (ui/report.js).
    const report = mountReport(ctx);
    offs.push(report.destroy);

    root.append(
        h('div', { class: 'about-hero' },
            brandMark(40),
            h('div', null,
                h('h3', { class: 'about-hero__name' }, APP_NAME),
                h('p', { class: 'about-hero__tag' }, t('Stand anywhere on Earth. See where every world is right now.')))),
        install.el,
        report.el,
        h('div', { class: 'group' },
            h('h3', { class: 'group-title' }, t('Accuracy')),
            h('p', { class: 'prose' }, t('Positions computed in your browser with astronomy-engine (VSOP87/ELP; accurate to about 1 arcminute, 1800–2200).')),
            h('p', { class: 'prose' }, t('Drawn positions are astrometric J2000; tables show apparent, refracted values.')),
            h('p', { class: 'prose' }, [t('The planets at the ends of the beams, and the Details card’s eyepiece view, are magnified, not to scale.'),
                t('Their phase, pole, Saturn’s ring tilt and Jupiter’s moons are computed; belts, the Great Red Spot and Mars’s markings are schematic, and the moons’ spacing beyond Jupiter’s edge is compressed.')].join(' ')),
            h('p', { class: 'note' }, [t('Dates from 1000 to 3000 are supported, with reduced accuracy outside 1800–2200.'),
                t('For a point clicked far from any listed city, the local time zone is estimated from longitude and marked “approx.”.')].join(' '))),
        h('div', { class: 'group' },
            h('h3', { class: 'group-title' }, t('Credits')),
            h('p', { class: 'prose' }, [t('Stars: Hipparcos via d3-celestial.'), t('Earth imagery: Solar System Scope (CC BY 4.0); Moon: NASA (on Max: Solar System Scope).'),
                t('Cities: GeoNames (CC BY 4.0).'), t('Clouds are illustrative, not live weather.'),
                t('In a total solar eclipse the contacts are computed, but the corona’s shape, the prominences and the lunar limb behind Baily’s beads are illustrative.'),
                t('Meteor showers follow the IMO calendar; their hourly rates are expected values, and the meteors drawn in Sky view are illustrative.')].join(' ')),
            h('ul', { class: 'credits' }, CREDITS.map(([name, role, lic, url]) => h('li', { class: 'credit' },
                h('span', { class: 'credit__main' }, link(url, name, 'link credit__name'), h('span', { class: 'credit__role' }, t(role))),
                h('span', { class: 'credit__lic' }, t(lic)))))),
        h('div', { class: 'group' },
            h('h3', { class: 'group-title' }, t('Privacy')),
            h('p', { class: 'prose' }, [t('Everything is computed on this device and nothing is tracked.'),
                t('A place search is sent to the online geocoders only when you type in the search box; “{button}” is used only on this device.', { button: t('Use my location') })].join(' '))),
        h('div', { class: 'btn-row btn-row--wrap' },
            link(REPO_URL, t('Source code'), 'btn btn--soft'),
            h('a', { class: 'btn btn--soft', href: 'THIRD_PARTY_NOTICES.md', target: '_blank', rel: 'noopener' }, t('Third-party notices'))),
        h('p', { class: 'note' }, t('{app} {version}. Made for curious people everywhere.', { app: APP_NAME, version: VERSION })));

    return { destroy() { offs.forEach((off) => off()); install.destroy(); root.textContent = ''; } };
}
