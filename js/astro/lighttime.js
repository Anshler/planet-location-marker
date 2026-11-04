/**
 * 'The light you see left in …': light-travel time to the stars and deep-sky objects, rounded to
 * what the distance supports, with a moment of history from when that light set out (pure; no
 * three.js, no DOM).
 *
 * Distances come from parallax (stars: Hipparcos New Reduction) or from the catalogue (deep-sky
 * objects, already rounded); the departure year is the simulated year minus the light-time, and is
 * only ever as precise as the distance: a star known to ±13 % is 'around the 1500s', not '1476'.
 *
 * @module astro/lighttime
 */

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
    [2015, 'New Horizons flew past Pluto'],
    [2012, 'Curiosity landed on Mars'],
    [2000, 'the first crew moved into the International Space Station'],
    [1990, 'the Hubble Space Telescope was launched'],
    [1977, 'the two Voyagers were launched'],
    [1969, 'Apollo 11 landed on the Moon'],
    [1957, 'Sputnik 1 was launched'],
    [1930, 'Pluto was discovered'],
    [1905, 'Einstein published special relativity'],
    [1859, 'Darwin published On the Origin of Species'],
    [1846, 'Neptune was found'],
    [1838, 'Bessel measured the first distance to a star'],
    [1781, 'Herschel discovered Uranus'],
    [1769, 'Cook watched the transit of Venus from Tahiti'],
    [1687, 'Newton published the Principia'],
    [1610, 'Galileo turned a telescope on Jupiter'],
    [1572, 'Tycho saw his new star'],
    [1543, 'Copernicus put the Sun at the centre'],
    [1492, 'Columbus crossed the Atlantic'],
    [1455, 'Gutenberg printed his Bible'],
    [1347, 'the Black Death reached Europe'],
    [1271, 'Marco Polo set out for China'],
    [1206, 'Genghis Khan united the Mongols'],
    [1066, 'Halley’s Comet hung over the Battle of Hastings'],
    [1054, 'Chinese astronomers recorded the supernova that made the Crab Nebula'],
    [1000, 'Leif Erikson reached North America'],
    [800, 'Charlemagne was crowned emperor'],
    [476, 'the Western Roman Empire fell'],
    [79, 'Vesuvius buried Pompeii'],
    [-43, 'Julius Caesar was murdered'],
    [-220, 'Qin Shi Huang unified China'],
    [-775, 'the first Olympic Games were held'],
    [-1322, 'Tutankhamun was buried'],
    [-2559, 'the Great Pyramid was built'],
    [-2999, 'the first stones of Stonehenge were raised'],
    [-3199, 'writing was invented in Sumer'],
    [-9499, 'Göbekli Tepe was built'],
    [-11699, 'the last Ice Age ended'],
    [-40000, 'people painted the first cave art'],
    [-300000, 'the first Homo sapiens lived'],
    [-2.5e6, 'our ancestors made the first stone tools'],
    [-6e6, 'our ancestors and the chimpanzees’ parted ways'],
    [-66e6, 'an asteroid ended the age of the dinosaurs'],
]);

/**
 * 'the 1500s' (the decade or century that contains the year), '1476', '600 BCE', 'the 6th century
 * BCE'. Astronomical year in (1 BCE = 0), words out.
 */
export function yearWords(y, step) {
    if (step <= 1) {
        const r = Math.round(y);
        return r > 0 ? String(r) : `${1 - r} BCE`;
    }
    const r = Math.floor(y / step) * step;
    if (y >= 1) return r > 0 ? `the ${r}s` : 'the 1st century';
    const bce = 1 - Math.floor(y);
    if (step >= 100) return `the ${ordinal(Math.ceil(bce / 100))} century BCE`;
    return `the ${Math.floor(bce / 10) * 10}s BCE`;
}

function ordinal(n) {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
    return `${n}${s}`;
}

/** '2.5 million years', '17,000 years', '640 years', '8.6 years'. */
export function spanWords(years) {
    const a = Math.abs(years);
    if (a >= 1e9) return `${trim(a / 1e9)} billion years`;
    if (a >= 1e6) return `${trim(a / 1e6)} million years`;
    if (a >= 1e4) return `${Math.round(a / 1000).toLocaleString('en-US')},000 years`;
    if (a >= 100) return `${(Math.round(a / 10) * 10).toLocaleString('en-US')} years`;
    if (a >= 10) return `${Math.round(a)} years`;
    return `${a.toFixed(1)} years`;
}

const trim = (x) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));

/**
 * The 'light left …' sentence for an object `ly` light-years away (±sigmaLy), seen at `tMs`.
 * @param {number} tMs simulated UTC ms
 * @param {number} ly light-years
 * @param {number} [sigmaLy] 1σ, light-years (0 or NaN: as precise as the catalogue's rounding)
 * @param {{subject?:string}} [opts] `subject`: 'it' (default 'The light you see')
 * @returns {string}
 */
export function departureLine(tMs, ly, sigmaLy = Number.NaN, opts = {}) {
    if (!(ly > 0) || !Number.isFinite(tMs)) return '';
    const year = new Date(tMs).getUTCFullYear() + (new Date(tMs).getUTCMonth() + 0.5) / 12;
    const leftYear = year - ly;
    const known = Number.isFinite(sigmaLy) && sigmaLy > 0;
    const sig = known ? sigmaLy : ly * 0.05;
    const subject = opts.subject ?? 'The light you see';
    if (!known && ly >= 100 && ly < 5000) {
        // A rounded catalogue distance (deep-sky objects): a rounded light-time, ±10 % for history.
        const ev = historyNear(leftYear, ly * 0.1);
        return `${subject} left about ${spanWords(ly)} ago${ev ? ` — around when ${ev[1]}` : ''}.`;
    }
    if (ly >= 5000) {
        // Deep time: an event within 10 % of the light-time, else the first one after the light left.
        const ev = historyNear(leftYear, ly * 0.1);
        const after = ev ? null : historyAfter(leftYear);
        const tail = ev ? ` — when ${ev[1]}` : after ? ` — before ${after[1]}` : '';
        return `${subject} left ${spanWords(ly)} ago${tail}.`;
    }
    let when;
    let within;
    if (sig < 1.5 && ly < 100) {
        when = `in ${yearWords(leftYear, 1)}, ${spanWords(ly)} ago`;
        within = 1;
    } else if (sig < 80) {
        const step = sig < 8 ? 10 : 100;
        when = `around ${yearWords(leftYear, step)}`;
        within = Math.max(sig, step / 2);
    } else {
        when = `about ${spanWords(Math.round(ly / 100) * 100)} ago, give or take ${spanWords(Math.max(100, Math.round(sig / 100) * 100))}`;
        within = sig;
    }
    const ev = historyNear(leftYear, within);
    return `${subject} left ${when}${ev ? ` — when ${ev[1]}` : ''}.`;
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
    if (ly >= 1e6) core = `${trim(ly / 1e6)} million light-years`;
    else if (ly >= 1e4) core = `${Math.round(ly / 1000).toLocaleString('en-US')},000 light-years`;
    else if (ly >= 1000) core = `${(Math.round(ly / 100) * 100).toLocaleString('en-US')} light-years`;
    else if (ly >= 100) core = `${Math.round(ly / 10) * 10} light-years`;
    else core = `${ly.toFixed(1)} light-years`;
    if (rel >= 0.02) return `about ${core} (± ${Math.round(rel * 100)} %)`;
    return core;
}
