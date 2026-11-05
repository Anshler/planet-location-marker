/**
 * 'The light you see left in …': light-travel time to the stars and deep-sky objects, rounded to
 * what the distance supports, with a moment of history from when that light set out (pure; no
 * three.js, no DOM).
 *
 * Distances come from parallax (stars: Hipparcos New Reduction) or from the catalogue (deep-sky
 * objects, already rounded); the departure year is the simulated year minus the light-time, and is
 * only ever as precise as the distance: a star known to ±13 % is 'around the 1500s', not '1476'.
 *
 * Sentences are in the interface's language (core/i18n.js), one whole phrase per case; the
 * history moments are N_-marked clauses translated where they are placed ('— when {event}').
 *
 * @module astro/lighttime
 */

import { t, N_, dec, locale } from '../core/i18n.js';
import { fmtInt } from '../core/format.js';

/** Astronomical units in one light-year (IAU: c · Julian year / au). */
export const AU_PER_LY = 63241.077;
/** Light-years per parsec. */
export const LY_PER_PC = 3.2615638;

/**
 * Distance (light-years) and its 1σ from a parallax (mas) and its error; NaN when the parallax is
 * not significant (≤ 0, or under 3σ: then only a lower bound is known).
 * @param {number} plxMas
 * @param {number} eplxMas
 * @returns {{ly:number, sigmaLy:number, lowerLy:number}} lowerLy: the 3σ lower bound when ly is NaN
 */
export function parallaxDistance(plxMas, eplxMas) {
    const e = Number.isFinite(eplxMas) && eplxMas > 0 ? eplxMas : 0;
    if (!(plxMas > 0) || (e > 0 && plxMas < 3 * e)) {
        const hi = (plxMas > 0 ? plxMas : 0) + 3 * e;
        return { ly: Number.NaN, sigmaLy: Number.NaN, lowerLy: hi > 0 ? 1000 / hi * LY_PER_PC : Number.NaN };
    }
    const ly = 1000 / plxMas * LY_PER_PC;
    return { ly, sigmaLy: ly * (e / plxMas), lowerLy: Number.NaN };
}

/**
 * Moments of history to date departing light by (astronomical year numbering: 1 BCE = 0). Kept to
 * well-known, well-dated events; deep time at the end.
 * @type {ReadonlyArray<[number, string]>}
 */
export const HISTORY = Object.freeze([
    [2015, N_('New Horizons flew past Pluto')],
    [2012, N_('Curiosity landed on Mars')],
    [2000, N_('the first crew moved into the International Space Station')],
    [1990, N_('the Hubble Space Telescope was launched')],
    [1977, N_('the two Voyagers were launched')],
    [1969, N_('Apollo 11 landed on the Moon')],
    [1957, N_('Sputnik 1 was launched')],
    [1930, N_('Pluto was discovered')],
    [1905, N_('Einstein published special relativity')],
    [1859, N_('Darwin published On the Origin of Species')],
    [1846, N_('Neptune was found')],
    [1838, N_('Bessel measured the first distance to a star')],
    [1781, N_('Herschel discovered Uranus')],
    [1769, N_('Cook watched the transit of Venus from Tahiti')],
    [1687, N_('Newton published the Principia')],
    [1610, N_('Galileo turned a telescope on Jupiter')],
    [1572, N_('Tycho saw his new star')],
    [1543, N_('Copernicus put the Sun at the centre')],
    [1492, N_('Columbus crossed the Atlantic')],
    [1455, N_('Gutenberg printed his Bible')],
    [1347, N_('the Black Death reached Europe')],
    [1271, N_('Marco Polo set out for China')],
    [1206, N_('Genghis Khan united the Mongols')],
    [1066, N_('Halley’s Comet hung over the Battle of Hastings')],
    [1054, N_('Chinese astronomers recorded the supernova that made the Crab Nebula')],
    [1000, N_('Leif Erikson reached North America')],
    [800, N_('Charlemagne was crowned emperor')],
    [476, N_('the Western Roman Empire fell')],
    [79, N_('Vesuvius buried Pompeii')],
    [-43, N_('Julius Caesar was murdered')],
    [-220, N_('Qin Shi Huang unified China')],
    [-775, N_('the first Olympic Games were held')],
    [-1322, N_('Tutankhamun was buried')],
    [-2559, N_('the Great Pyramid was built')],
    [-2999, N_('the first stones of Stonehenge were raised')],
    [-3199, N_('writing was invented in Sumer')],
    [-9499, N_('Göbekli Tepe was built')],
    [-11699, N_('the last Ice Age ended')],
    [-40000, N_('people painted the first cave art')],
    [-300000, N_('the first Homo sapiens lived')],
    [-2.5e6, N_('our ancestors made the first stone tools')],
    [-6e6, N_('our ancestors and the chimpanzees’ parted ways')],
    [-66e6, N_('an asteroid ended the age of the dinosaurs')],
]);

/**
 * 'the 1500s' (the decade or century that contains the year), '1476', '600 BCE', 'the 6th century
 * BCE'. Astronomical year in (1 BCE = 0), words out.
 */
export function yearWords(y, step) {
    if (step <= 1) {
        const r = Math.round(y);
        return r > 0 ? String(r) : t('{n} BCE', { n: 1 - r });
    }
    const r = Math.floor(y / step) * step;
    if (y >= 1) return r > 0 ? t('the {n}s', { n: r }) : t('the 1st century');
    const bce = 1 - Math.floor(y);
    if (step >= 100) return t('the {ord} century BCE', { ord: ordinal(Math.ceil(bce / 100)) });
    return t('the {n}s BCE', { n: Math.floor(bce / 10) * 10 });
}

/** '7th' in English; the bare number elsewhere ('thế kỷ 7'). */
function ordinal(n) {
    if (locale() !== 'en') return String(n);
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
    return `${n}${s}`;
}

/** '2.5 million years', '17,000 years', '640 years', '8.6 years'. */
export function spanWords(years) {
    const a = Math.abs(years);
    if (a >= 1e9) return t('{n} billion years', { n: trim(a / 1e9) });
    if (a >= 1e6) return t('{n} million years', { n: trim(a / 1e6) });
    if (a >= 1e4) return t('{n} years', { n: fmtInt(Math.round(a / 1000) * 1000) });
    if (a >= 100) return t('{n} years', { n: fmtInt(Math.round(a / 10) * 10) });
    if (a >= 10) return t('{n} years', { n: Math.round(a) });
    return t('{n} years', { n: dec(a, 1) });
}

const trim = (x) => (x >= 10 ? String(Math.round(x)) : dec(x, 1).replace(/[.,]0$/, ''));

/**
 * The 'light left …' sentence for an object `ly` light-years away (±sigmaLy), seen at `tMs`.
 * @param {number} tMs simulated UTC ms
 * @param {number} ly light-years
 * @param {number} [sigmaLy] 1σ, light-years (0 or NaN: as precise as the catalogue's rounding)
 * @returns {string}
 */
export function departureLine(tMs, ly, sigmaLy = Number.NaN) {
    if (!(ly > 0) || !Number.isFinite(tMs)) return '';
    const year = new Date(tMs).getUTCFullYear() + (new Date(tMs).getUTCMonth() + 0.5) / 12;
    const leftYear = year - ly;
    const known = Number.isFinite(sigmaLy) && sigmaLy > 0;
    const sig = known ? sigmaLy : ly * 0.05;
    if (!known && ly >= 100 && ly < 5000) {
        // A rounded catalogue distance (deep-sky objects): a rounded light-time, ±10 % for history.
        const ev = historyNear(leftYear, ly * 0.1);
        const v = { span: spanWords(ly), event: ev ? t(ev[1]) : '' };
        return ev ? t('The light you see left about {span} ago — around when {event}.', v) : t('The light you see left about {span} ago.', v);
    }
    if (ly >= 5000) {
        // Deep time: an event within 10 % of the light-time, else the first one after the light left.
        const ev = historyNear(leftYear, ly * 0.1);
        const after = ev ? null : historyAfter(leftYear);
        const v = { span: spanWords(ly), event: ev ? t(ev[1]) : after ? t(after[1]) : '' };
        return ev ? t('The light you see left {span} ago — when {event}.', v)
            : after ? t('The light you see left {span} ago — before {event}.', v) : t('The light you see left {span} ago.', v);
    }
    // When it left, as precisely as the distance allows: the year, the decade or century, or a span.
    let within;
    let how;
    const v = { span: spanWords(ly) };
    if (sig < 1.5 && ly < 100) {
        const r = Math.round(leftYear);
        how = r > 0 ? 'ce' : 'bce';
        v.year = r > 0 ? r : 1 - r;
        within = 1;
    } else if (sig < 80) {
        const step = sig < 8 ? 10 : 100;
        how = 'era';
        v.era = yearWords(leftYear, step);
        within = Math.max(sig, step / 2);
    } else {
        how = 'span';
        v.span = spanWords(Math.round(ly / 100) * 100);
        v.err = spanWords(Math.max(100, Math.round(sig / 100) * 100));
        within = sig;
    }
    const ev = historyNear(leftYear, within);
    if (ev) {
        v.event = t(ev[1]);
        if (how === 'ce') return t('The light you see left in {year}, {span} ago — when {event}.', v);
        if (how === 'bce') return t('The light you see left in {year} BCE, {span} ago — when {event}.', v);
        if (how === 'era') return t('The light you see left around {era} — when {event}.', v);
        return t('The light you see left about {span} ago, give or take {err} — when {event}.', v);
    }
    if (how === 'ce') return t('The light you see left in {year}, {span} ago.', v);
    if (how === 'bce') return t('The light you see left in {year} BCE, {span} ago.', v);
    if (how === 'era') return t('The light you see left around {era}.', v);
    return t('The light you see left about {span} ago, give or take {err}.', v);
}

/**
 * The earliest HISTORY moment after `year`, or null.
 * @param {number} year
 * @returns {[number, string]|null}
 */
export function historyAfter(year) {
    let best = null;
    for (const h of HISTORY) if (h[0] > year && (!best || h[0] < best[0])) best = h;
    return best;
}

/**
 * The HISTORY moment nearest `year` within ±within years (never one after the real present), or null.
 * @param {number} year astronomical year
 * @param {number} within
 * @returns {[number, string]|null}
 */
export function historyNear(year, within) {
    let best = null, bestD = within;
    for (const h of HISTORY) {
        const d = Math.abs(h[0] - year);
        if (d <= bestD) { best = h; bestD = d; }
    }
    return best;
}

/**
 * A distance in light-years for the card: 'about 500 light-years (± 13 %)', '2.5 million light-years'.
 * @param {number} ly
 * @param {number} [sigmaLy]
 * @returns {string}
 */
export function lyWords(ly, sigmaLy = Number.NaN) {
    if (!(ly > 0)) return '—';
    const rel = Number.isFinite(sigmaLy) && sigmaLy > 0 ? sigmaLy / ly : 0;
    let core;
    if (ly >= 1e6) core = t('{n} million light-years', { n: trim(ly / 1e6) });
    else if (ly >= 1e4) core = t('{n} light-years', { n: fmtInt(Math.round(ly / 1000) * 1000) });
    else if (ly >= 1000) core = t('{n} light-years', { n: fmtInt(Math.round(ly / 100) * 100) });
    else if (ly >= 100) core = t('{n} light-years', { n: Math.round(ly / 10) * 10 });
    else core = t('{n} light-years', { n: dec(ly, 1) });
    if (rel >= 0.02) return t('about {dist} (± {pct} %)', { dist: core, pct: Math.round(rel * 100) });
    return core;
}
