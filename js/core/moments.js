// Moments: famous skies as deep links (pure; ROADMAP historic-skies and comets-halley-1066).
//
// Each moment is a place, an instant and a view, written as the URL hash the app already reads
// (core/url-state.js: `t=` is always a Gregorian ISO instant, even for 1054; the app shows the
// Julian date), with a two-line caption and its sources. The Events tab lists them as links
// (ui/events-panel.js); a click sets location.hash and the app flies there. `FAMOUS_COMETS` are the
// best naked-eye views of Halley's five apparitions (astro/comets.js), found by a search over each
// apparition for a dark sky, a high comet and a bright tail. Titles, dates and captions are
// English, marked for the string table (core/i18n.js; shown with t()); sources stay as cited.

import { layersToCode } from './url-state.js';
import { DEFAULT_STATE } from './store.js';
import { N_ } from './i18n.js';

/**
 * @typedef {{ id:string, title:string, when:string, caption:string, sources:string[], hash:string }} Moment
 */

/** Builds a moment's hash: always paused at `t`, without the intro. */
function link({ lat, lon, n, tz, t, view = 'sky', sel = null, cam = null, ly = null }) {
    const parts = [`loc=${lat},${lon}`, `n=${encodeURIComponent(n)}`, `tz=${tz}`, `t=${t}`, 'p=0'];
    // Always named: a hash without `view=` keeps the current view.
    parts.push(`view=${view}`);
    if (sel) parts.push(`sel=${sel}`);
    if (cam) parts.push(`cam=${cam}`);
    if (ly) parts.push(`ly=${ly}`);
    parts.push('intro=0');
    return `#${parts.join('&')}`;
}

/** The default layers plus the spacecraft (url-state LAYER_CODES 'v'). */
const LY_CRAFT = layersToCode({ ...DEFAULT_STATE.layers, spacecraft: true });

/** @type {ReadonlyArray<Moment>} */
export const MOMENTS = Object.freeze([
    {
        id: 'cairo-1006', title: N_('The brightest star ever seen'), when: N_('Cairo, night of 30 April 1006'),
        caption: N_('A guest star low in Lupus, perhaps a quarter as bright as the Moon: the physician Ali ibn Ridwan saw it light the ground.'),
        sources: ['Ali ibn Ridwan, commentary on Ptolemy’s Tetrabiblos', 'Goldstein 1965, AJ 70, 105'],
        hash: link({ lat: 30.0444, lon: 31.2357, n: 'Cairo', tz: 'Africa/Cairo', t: '1006-05-06T21:00:00Z', sel: 'guest:sn1006', cam: 's:180,18,70' }),
    },
    {
        id: 'kaifeng-1054', title: N_('A guest star in Taurus'), when: N_('Kaifeng, dawn of 4 July 1054'),
        caption: N_('Song astronomers record a new star near ζ Tauri, bright enough to see by day for 23 days: the Crab supernova. A pictograph at Chaco Canyon may record the dawn of 5 July, when the crescent Moon stood beside it.'),
        sources: ['Song Huiyao (Song dynasty records)', 'Stephenson & Green, Historical Supernovae (2002)'],
        hash: link({ lat: 34.7972, lon: 114.3076, n: 'Kaifeng', tz: 'Asia/Shanghai', t: '1054-07-09T20:50:00Z', sel: 'guest:sn1054', cam: 's:86,24,64' }),
    },
    {
        id: 'hastings-1066', title: N_('Halley over Hastings'), when: N_('Hastings, evening of 24 April 1066'),
        caption: N_('The Anglo-Saxon Chronicle saw “a sign such as men never saw before” in the west after sunset. Months later came the Norman conquest; the Bayeux Tapestry shows the star.'),
        sources: ['Anglo-Saxon Chronicle (1066)', 'JPL Horizons, Halley 1066 solution (after Yeomans & Kiang 1981)'],
        hash: link({ lat: 50.911, lon: 0.487, n: 'Hastings', tz: 'Europe/London', t: '1066-04-30T20:45:00Z', sel: 'comet:halley', cam: 's:283,17,72' }),
    },
    {
        id: 'jamaica-1504', title: N_('Columbus’s eclipse'), when: N_('St Ann’s Bay, Jamaica, 29 February 1504'),
        caption: N_('Stranded and refused food, Columbus read in Regiomontanus’s almanac that the Moon would be eclipsed, and warned the Taíno it would rise “inflamed with wrath”. It rose red.'),
        sources: ['Ferdinand Columbus, Historie (1571)', 'Espenak & Meeus, Five Millennium Canon of Lunar Eclipses (NASA 2009)'],
        hash: link({ lat: 18.4358, lon: -77.201, n: 'St Ann’s Bay', tz: 'America/Jamaica', t: '1504-03-11T00:40:00Z', sel: 'moon', cam: 's:92,16,56' }),
    },
    {
        id: 'herrevad-1572', title: N_('Tycho’s new star'), when: N_('Herrevad Abbey, 11 November 1572'),
        caption: N_('Walking home, Tycho Brahe saw a star in Cassiopeia brighter than Venus where none had been. It did not move against the stars: the heavens could change.'),
        sources: ['Tycho Brahe, De nova stella (1573)'],
        hash: link({ lat: 56.0866, lon: 13.241, n: 'Herrevad Abbey', tz: 'Europe/Stockholm', t: '1572-11-21T17:00:00Z', sel: 'guest:tycho1572', cam: 's:55,60,80' }),
    },
    {
        id: 'prague-1604', title: N_('Kepler’s star'), when: N_('Prague, 17 October 1604'),
        caption: N_('A new star by Mars and Jupiter in Ophiuchus. Kepler followed it for a year; no supernova in our galaxy has been seen by eye since.'),
        sources: ['Johannes Kepler, De stella nova (1606)'],
        hash: link({ lat: 50.0875, lon: 14.4214, n: 'Prague', tz: 'Europe/Prague', t: '1604-10-17T17:15:00Z', sel: 'guest:kepler1604', cam: 's:225,12,60' }),
    },
    {
        id: 'padua-1610', title: N_('Jupiter’s moons'), when: N_('Padua, 7 January 1610'),
        caption: N_('Galileo’s new telescope showed three “little stars” in a line beside Jupiter; within a week there were four, and they moved with it. They were moons.'),
        sources: ['Galileo Galilei, Sidereus Nuncius (1610)'],
        hash: link({ lat: 45.4064, lon: 11.8768, n: 'Padua', tz: 'Europe/Rome', t: '1610-01-07T19:00:00Z', sel: 'jupiter', cam: 's:128,58,2' }),
    },
    {
        id: 'bath-1781', title: N_('A new planet'), when: N_('Bath, 13 March 1781'),
        caption: N_('From his garden in New King Street, William Herschel found a “curious either nebulous star or perhaps a comet” near ζ Tauri: Uranus, the first planet found since antiquity.'),
        sources: ['Herschel 1781, Phil. Trans. 71, 492'],
        hash: link({ lat: 51.3816, lon: -2.3667, n: 'Bath', tz: 'Europe/London', t: '1781-03-13T22:30:00Z', sel: 'uranus', cam: 's:265,35,8' }),
    },
    {
        id: 'berlin-1846', title: N_('Neptune, where it was predicted'), when: N_('Berlin, 23 September 1846'),
        caption: N_('Galle and d’Arrest compared the sky in Aquarius with a fresh star chart and found Neptune within 1° of where Le Verrier had calculated it must be.'),
        sources: ['Galle 1846, MNRAS 7, 153'],
        hash: link({ lat: 52.5163, lon: 13.4064, n: 'Berlin', tz: 'Europe/Berlin', t: '1846-09-23T23:00:00Z', sel: 'neptune', cam: 's:213,18,6' }),
    },
    {
        id: 'principe-1919', title: N_('Starlight bends'), when: N_('Príncipe, 29 May 1919'),
        caption: N_('In totality the Sun stood among the Hyades. Eddington’s plates showed the stars nudged outward by the Sun’s gravity, as Einstein had predicted.'),
        sources: ['Dyson, Eddington & Davidson 1920, Phil. Trans. A 220, 291'],
        hash: link({ lat: 1.6167, lon: 7.4, n: 'Príncipe', tz: 'Africa/Sao_Tome', t: '1919-05-29T14:15:00Z', sel: 'sun', cam: 's:310,44,40' }),
    },
    {
        id: 'dallas-2024', title: N_('The Great North American Eclipse'), when: N_('Dallas, 8 April 2024'),
        caption: N_('Nearly four minutes of totality over Texas, with Venus and Jupiter either side of the Sun, at the peak of a solar cycle: prominences at the rim.'),
        sources: ['NASA eclipse predictions (Espenak)'],
        hash: link({ lat: 32.7767, lon: -96.797, n: 'Dallas', tz: 'America/Chicago', t: '2024-04-08T18:42:00Z', sel: 'sun', cam: 's:170,64,50' }),
    },
    {
        id: 'luxor-2027', title: N_('The eclipse of the century'), when: N_('Luxor, 2 August 2027'),
        caption: N_('Six minutes and 23 seconds of totality over the Valley of the Kings, the Sun almost overhead: the longest on land until 2114.'),
        sources: ['NASA eclipse predictions (Espenak)'],
        hash: link({ lat: 25.6872, lon: 32.6396, n: 'Luxor', tz: 'Africa/Cairo', t: '2027-08-02T10:04:30Z', sel: 'sun', cam: 's:0,82,60' }),
    },
    {
        id: 'voyager-lightday', title: N_('One light-day away'), when: N_('Goldstone, 18 November 2026'),
        caption: N_('Voyager 1 becomes the first spacecraft a whole light-day from Earth: a message sent from the dish today arrives tomorrow.'),
        sources: ['JPL Horizons (NASA/JPL-Caltech)'],
        hash: link({ lat: 35.4267, lon: -116.89, n: 'Goldstone Deep Space Complex', tz: 'America/Los_Angeles', t: '2026-11-18T20:00:00Z', view: 'orbit', sel: 'craft:voyager1', cam: 'o:20,-130,7', ly: LY_CRAFT }),
    },
].map((m) => Object.freeze({ ...m, sources: Object.freeze([...m.sources]) })));

/** Halley's five apparitions in the app's millennium: the best naked-eye view of each. */
export const FAMOUS_COMETS = Object.freeze([
    { id: 'halley-1066', title: N_('1066 · Hastings'), detail: N_('Mag 0.6 in the west after sunset, its tail over 20° long'),
        hash: link({ lat: 50.911, lon: 0.487, n: 'Hastings', tz: 'Europe/London', t: '1066-04-30T20:45:00Z', sel: 'comet:halley', cam: 's:283,17,72' }) },
    { id: 'halley-1456', title: N_('1456 · Florence'), detail: N_('Toscanelli’s comet: mag 2.3 before dawn in the north-east'),
        hash: link({ lat: 43.7696, lon: 11.2558, n: 'Florence', tz: 'Europe/Rome', t: '1456-06-21T02:00:00Z', sel: 'comet:halley', cam: 's:50,14,72' }) },
    { id: 'halley-1910', title: N_('1910 · Cape Town'), detail: N_('Two days after the Earth passed through its tail'),
        hash: link({ lat: -33.9249, lon: 18.4241, n: 'Cape Town', tz: 'Africa/Johannesburg', t: '1910-05-21T17:00:00Z', sel: 'comet:halley', cam: 's:300,16,80' }) },
    { id: 'halley-1986', title: N_('1986 · Alice Springs'), detail: N_('A faint smudge high in the south before dawn'),
        hash: link({ lat: -23.698, lon: 133.8807, n: 'Alice Springs', tz: 'Australia/Darwin', t: '1986-04-03T20:00:00Z', sel: 'comet:halley', cam: 's:180,62,70' }) },
    { id: 'halley-2061', title: N_('2061 · Paris'), detail: N_('Its next return: mag 2.3 before dawn in the north-east'),
        hash: link({ lat: 48.8566, lon: 2.3522, n: 'Paris', tz: 'Europe/Paris', t: '2061-07-25T02:30:00Z', sel: 'comet:halley', cam: 's:40,14,72' }) },
].map((m) => Object.freeze(m)));
