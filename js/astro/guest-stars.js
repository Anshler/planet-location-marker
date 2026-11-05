/**
 * Guest stars: the five naked-eye supernovae of the app's millennium (pure).
 *
 * Each one is a fixed J2000 direction (its remnant's position: the sky is static in EQJ) with a
 * light-curve template anchored on the dates the records give: invisible before the first
 * recorded sighting, rising to a peak, then fading on a template tail that crosses the naked-eye
 * limit near the last recorded sighting. Peak magnitudes are uncertain by about ±1 mag and the
 * templates are illustrative between the recorded dates (docs/ASTRONOMY.md §5a). Dates in the
 * table are as recorded: Julian before 15 Oct 1582, Gregorian after (core/tz.js fromCalendar).
 *
 * The extras provider (astro/extras.js) draws them as stars (glyph 'star', the 'stars' layer);
 * rise, transit and set for the card come from Astronomy Engine's user-defined star (DefineStar
 * on Body.Star8, redefined before each search, so other modules may use the slot too).
 *
 * @module astro/guest-stars
 */

import { AE } from './ae.js';
import { raDecToScene } from './frames.js';
import { fromCalendar } from '../core/tz.js';
import { fmtDate } from '../core/format.js';
import { t, N_, dec } from '../core/i18n.js';

const DAY_MS = 86400e3;
/** Faintest magnitude at which a guest star is still drawn (a little past the naked-eye limit). */
export const GUEST_FADE_MAG = 7;

/** Days → ms of a recorded calendar date (noon UT). */
function dateMs(y, mo, d, cal) {
    const g = fromCalendar(y, mo, d, cal);
    return Date.UTC(g.y, g.mo - 1, g.d, 12);
}

/**
 * The table. `first`/`peak`/`last`: recorded dates [y, mo, d] in the calendar of the time; `ra` in
 * hours and `dec` in degrees (J2000, the remnant); `peakMag`; `tail`: the late decline (mag/day)
 * after the template's first 50 days (type Ia: 2.9 mag in 50 days; SN 1054: 2.0 mag in 23 days).
 */
const TABLE = [
    {
        key: 'sn1006', name: 'SN 1006', long: 'SN 1006, in Lupus', ra: 15 + 2 / 60 + 48.4 / 3600, dec: -(41 + 54 / 60 + 42 / 3600), distLy: 7200,
        first: [1006, 4, 30], peak: [1006, 5, 3], last: [1008, 5, 1], peakMag: -7.5, type: 'Ia', tail: 0.0155,
        record: N_('The brightest stellar event in recorded history: seen from China, Japan, Egypt (Ali ibn Ridwan), Iraq, Yemen and Switzerland, bright enough to read by.'),
        caveat: N_('Peak brightness is uncertain by about ±1 mag (estimates run −7 to −8); the fading between the records is a template.'),
        sources: ['Stephenson & Green, Historical Supernovae and their Remnants (OUP 2002)', 'Winkler, Gupta & Long 2003, ApJ 585, 324'],
    },
    {
        key: 'sn1054', name: N_('SN 1054 (the Crab)'), long: 'SN 1054, the Crab supernova in Taurus', ra: 5 + 34 / 60 + 31.94 / 3600, dec: 22 + 52.2 / 3600, distLy: 6500,
        first: [1054, 7, 4], peak: [1054, 7, 4], last: [1056, 4, 6], peakMag: -6, type: 'II', tail: 0.0159,
        record: N_('Song dynasty astronomers saw a guest star near ζ Tauri on 4 July 1054: visible by day for 23 days and at night for 642 days. A pictograph at Chaco Canyon may record it.'),
        caveat: N_('Peak brightness is uncertain by about ±1 mag; the Chaco Canyon reading is debated, so “may record”. The light curve between the records is a template.'),
        sources: ['Song Huiyao; Stephenson & Green 2002', 'Collins et al. 1999, PASP 111, 871 (the light curve)'],
    },
    {
        key: 'sn1181', name: 'SN 1181', long: 'SN 1181, in Cassiopeia', ra: 0 + 53 / 60 + 11.2 / 3600, dec: 67 + 30 / 60 + 2 / 3600, distLy: 7500,
        first: [1181, 8, 6], peak: [1181, 8, 11], last: [1182, 2, 6], peakMag: 0, type: 'Ia', tail: 0.025,
        record: N_('Recorded in China and Japan for 185 days, near the Chinese asterism Chuanshe. The remnant is probably the nebula Pa 30 (earlier thought to be 3C 58).'),
        caveat: N_('Peak brightness is uncertain (around 0 mag); the remnant identification (Pa 30) is recent. The light curve is a template.'),
        sources: ['Stephenson & Green 2002', 'Ritter et al. 2021, ApJL 918, L33 (Pa 30)'],
    },
    {
        key: 'tycho1572', name: N_("Tycho's star (SN 1572)"), long: "Tycho's supernova, in Cassiopeia", ra: 0 + 25 / 60 + 19.9 / 3600, dec: 64 + 8 / 60 + 18 / 3600, distLy: 8000,
        first: [1572, 11, 6], peak: [1572, 11, 11], last: [1574, 3, 15], peakMag: -4, type: 'Ia', tail: 0.0155,
        record: N_('Tycho Brahe saw it on the evening of 11 November 1572, as bright as Venus. Its unchanging place showed that the heavens beyond the Moon could change.'),
        caveat: N_('Peak brightness about −4 (as bright as Venus) from the records; ±0.5 mag. Light echoes confirm a type Ia.'),
        sources: ['Tycho Brahe, De nova stella (1573)', 'Krause et al. 2008, Nature 456, 617'],
    },
    {
        key: 'kepler1604', name: N_("Kepler's star (SN 1604)"), long: "Kepler's supernova, in Ophiuchus", ra: 17 + 30 / 60 + 42 / 3600, dec: -(21 + 29 / 60), distLy: 17000,
        first: [1604, 10, 9], peak: [1604, 10, 28], last: [1605, 10, 8], peakMag: -2.5, type: 'Ia', tail: 0.0155,
        record: N_('First seen on 9 October 1604 near Mars and Jupiter; Johannes Kepler followed it for a year. The last supernova seen in our galaxy.'),
        caveat: N_('Peak brightness about −2.5 from the records; ±0.5 mag.'),
        sources: ['Kepler, De stella nova (1606)', 'Stephenson & Green 2002'],
    },
];

/**
 * @typedef {{ id:string, key:string, name:string, long:string, raH:number, decDeg:number, distLy:number,
 *   firstMs:number, firstRecMs:number, peakMs:number, lastMs:number, peakMag:number, type:'Ia'|'II', tail:number,
 *   record:string, caveat:string, sources:string[], dirS:Float64Array }} GuestStar
 */

/** @type {ReadonlyArray<GuestStar>} */
export const GUEST_STARS = Object.freeze(TABLE.map((g) => Object.freeze({
    id: `guest:${g.key}`, key: g.key, name: g.name, long: g.long, raH: g.ra, decDeg: g.dec, distLy: g.distLy,
    // A record names a local day: the first sighting counts from the start of that day anywhere
    // (UTC+12) for visibility; `firstRecMs` is the recorded day itself (noon UT), for the card.
    firstMs: dateMs(...g.first) - DAY_MS, firstRecMs: dateMs(...g.first), peakMs: dateMs(...g.peak), lastMs: dateMs(...g.last),
    peakMag: g.peakMag, type: /** @type {'Ia'|'II'} */ (g.type), tail: g.tail,
    record: g.record, caveat: g.caveat, sources: Object.freeze([...g.sources]),
    dirS: raDecToScene(g.ra * 15, g.dec),
})));

const BY_ID = new Map(GUEST_STARS.map((g) => [g.id, g]));

/**
 * A guest star's magnitude at an instant: NaN before its first recorded sighting; from the first
 * sighting to the peak a linear rise of 1.2 mag; after the peak the template decline (type Ia:
 * 0.1 mag/day for 20 days, 0.03 mag/day to day 50, then `tail`; SN 1054: 2.0 mag over the 23 days
 * of daylight visibility, then `tail`).
 * @param {GuestStar} g
 * @param {number} tMs
 * @returns {number}
 */
export function guestMagnitude(g, tMs) {
    if (!g || !(tMs >= g.firstMs)) return NaN;
    if (tMs < g.peakMs) {
        // The rise runs from the recorded first day (noon UT) to the peak; a star first seen at its
        // peak (SN 1054) is at its peak the whole recorded day.
        const rise = g.peakMs - (g.firstMs + DAY_MS);
        const f = rise > DAY_MS ? Math.min(1, (g.peakMs - tMs) / rise) : 0;
        return g.peakMag + 1.2 * f;
    }
    const d = (tMs - g.peakMs) / DAY_MS;
    let dm;
    if (g.type === 'II') dm = d <= 23 ? 2.0 * d / 23 : 2.0 + g.tail * (d - 23);
    else if (d <= 20) dm = 0.1 * d;
    else if (d <= 50) dm = 2.0 + 0.03 * (d - 20);
    else dm = 2.9 + g.tail * (d - 50);
    return g.peakMag + dm;
}

/** The guest star of an id, or null. */
export function guestById(id) {
    return BY_ID.get(id) ?? null;
}

/**
 * Rise, transit and set of a guest star for the local day starting at `dayStartMs` (UTC ms), from
 * Astronomy Engine's user-defined star (Body.Star8, redefined here before each search).
 * @param {GuestStar} g
 * @param {{latDeg:number, lonDeg:number, elevM?:number}} observer
 * @param {number} dayStartMs
 * @returns {{riseMs:number|null, transitMs:number|null, setMs:number|null, transitAltDeg:number|null}}
 */
export function guestRiseSet(g, observer, dayStartMs) {
    AE.DefineStar(AE.Body.Star8, g.raH, g.decDeg, g.distLy);
    const obs = new AE.Observer(observer.latDeg, observer.lonDeg, observer.elevM || 0);
    const t0 = AE.MakeTime(new Date(dayStartMs));
    const ms = (r) => (r ? r.date.getTime() : null);
    const rise = AE.SearchRiseSet(AE.Body.Star8, obs, +1, t0, 1);
    const set = AE.SearchRiseSet(AE.Body.Star8, obs, -1, t0, 1);
    let transitMs = null, transitAltDeg = null;
    try {
        const tr = AE.SearchHourAngle(AE.Body.Star8, obs, 0, t0, +1);
        if (tr && tr.time.date.getTime() - dayStartMs < DAY_MS) {
            transitMs = tr.time.date.getTime();
            transitAltDeg = tr.hor.altitude;
        }
    } catch { /* never transits in the window */ }
    return { riseMs: ms(rise), transitMs, setMs: ms(set), transitAltDeg };
}

/** "6.5 thousand light-years" */
function lyText(ly) {
    return ly >= 1000 ? t('{n} thousand light-years', { n: dec(ly / 1000, ly < 10000 ? 1 : 0) }) : t('{n} light-years', { n: ly });
}

/**
 * The extras provider for guest stars (kind 'guest').
 * @param {{fmtDate?:(ms:number)=>string}} [opts] date formatting for the card (the UI's zone)
 * @returns {import('./extras.js').ExtraProvider}
 */
export function createGuestProvider(opts = {}) {
    const ids = GUEST_STARS.map((g) => g.id);
    const fmt = opts.fmtDate ?? ((ms) => fmtDate(ms, 'UTC', { weekday: false }));
    // Rise · transit · set, once per guest star, place and (UT) day.
    let rtsKey = '';
    let rts = null;
    return {
        kind: 'guest',
        kindLabel: N_('Guest star (supernova)'),
        ids: () => ids,
        meta(id) {
            const g = BY_ID.get(id);
            return g ? { name: g.name, short: g.name.split(' (')[0], color: '#fff3d6', glyph: 'star', label: 'always', layer: 'stars' } : null;
        },
        fill(snap, id, out) {
            const g = BY_ID.get(id);
            const m = g ? guestMagnitude(g, snap.tMs) : NaN;
            out.present = Number.isFinite(m) && m <= GUEST_FADE_MAG;
            out.mag = m;
            out.distAU = NaN;
            out.approx = false;
            const d = g ? g.dirS : null;
            if (d) { out.dirS[0] = d[0]; out.dirS[1] = d[1]; out.dirS[2] = d[2]; }
        },
        card(id, st, snap) {
            const g = BY_ID.get(id);
            if (!g) return null;
            const tMs = snap?.tMs ?? NaN;
            const o = snap?.observer;
            // Whole days from the recorded day to the observer's local (mean) day.
            const lonMs = o && Number.isFinite(o.lonDeg) ? o.lonDeg / 15 * 3600e3 : 0;
            const days = Math.floor((tMs + lonMs) / DAY_MS) - Math.floor(g.firstRecMs / DAY_MS);
            const bright = st.mag <= -4 ? t('bright enough to see in daylight') : st.mag <= 1 ? t('one of the brightest points in the sky')
                : st.mag <= 6 ? t('visible to the naked eye') : t('fading below the naked-eye limit');
            const when = days === 0 ? t('First recorded today') : days < 0 ? t('First recorded on {date}', { date: fmt(g.firstRecMs) })
                : t('Day {n} since it was first recorded ({date})', { n: days, date: fmt(g.firstRecMs) });
            if (o && Number.isFinite(tMs)) {
                // The local day, near enough: from local mean midnight.
                const day0 = Math.floor((tMs + o.lonDeg / 15 * 3600e3) / DAY_MS) * DAY_MS - o.lonDeg / 15 * 3600e3;
                const key = `${id}|${day0}|${o.latDeg.toFixed(2)}|${o.lonDeg.toFixed(2)}`;
                if (key !== rtsKey) {
                    rtsKey = key;
                    try { rts = guestRiseSet(g, o, day0); } catch { rts = null; }
                }
            }
            return {
                rts,
                kindLabel: t('Guest star · a supernova'),
                lines: [
                    `${when}: ${bright}.`,
                    t(g.record),
                    t('The star exploded about {dist} away: its light took that long to arrive.', { dist: lyText(g.distLy) }),
                ],
                facts: [
                    [t('Peak'), t('about {mag} mag on {date}', { mag: `${g.peakMag > 0 ? '+' : g.peakMag < 0 ? '−' : ''}${dec(Math.abs(g.peakMag), g.peakMag % 1 ? 1 : 0)}`, date: fmt(g.peakMs) })],
                    [t('Last recorded'), fmt(g.lastMs)],
                    [t('Distance'), lyText(g.distLy)],
                ],
                caveat: t(g.caveat),
                sources: [...g.sources],
            };
        },
    };
}
