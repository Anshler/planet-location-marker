/**
 * 'The sky you were born under' (pure): a short caption for a full-detail snapshot, naming where
 * the Moon and the naked-eye planets stood ('Jupiter was in Leo; the Moon was 62% lit, in
 * Taurus'), which planets were up at that hour, and Venus as an evening or morning star.
 *
 * @module astro/sky-caption
 */

import { BODY_INDEX } from './bodies.js';

const PLANETS = ['jupiter', 'saturn', 'mars', 'venus', 'mercury'];
const NAMES = { jupiter: 'Jupiter', saturn: 'Saturn', mars: 'Mars', venus: 'Venus', mercury: 'Mercury' };

/** "a, b and c" */
function list(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * @param {import('../core/types.js').Snapshot} snap full detail (constellations, phases, `above`)
 * @returns {string} '' without usable data
 */
export function skyCaption(snap) {
    const b = snap?.bodies;
    if (!b || snap.detail !== 'full') return '';
    const parts = [];
    const moon = b[BODY_INDEX.moon];
    const where = PLANETS.map((id) => {
        const st = b[BODY_INDEX[id]];
        const con = st?.constellation?.name;
        return con ? `${NAMES[id]} in ${con}` : null;
    }).filter(Boolean);
    if (where.length) parts.push(`${where[0].replace(' in ', ' was in ')}${where.length > 1 ? `, ${list(where.slice(1))}` : ''}.`);
    if (moon && Number.isFinite(moon.phaseFrac)) {
        const pct = Math.round(moon.phaseFrac * 100);
        const con = moon.constellation?.name;
        parts.push(`The Moon was ${pct}% lit${con ? `, in ${con}` : ''}${moon.above ? ', and up' : ', below the horizon'}.`);
    }
    const up = PLANETS.filter((id) => b[BODY_INDEX[id]]?.above && b[BODY_INDEX[id]].mag < 2).map((id) => NAMES[id]);
    if (up.length) parts.push(`Up at that hour: ${list(up)}.`);
    const venus = b[BODY_INDEX.venus];
    if (venus && venus.elongDeg > 15 && venus.elongSide) parts.push(`Venus was the ${venus.elongSide} star.`);
    return parts.join(' ');
}
