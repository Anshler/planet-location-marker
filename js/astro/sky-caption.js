/**
 * 'The sky you were born under' (pure): a short caption for a full-detail snapshot, naming where
 * the Moon and the naked-eye planets stood ('Jupiter was in Leo; the Moon was 62% lit, in
 * Taurus'), which planets were up at that hour, and Venus as an evening or morning star.
 *
 * @module astro/sky-caption
 */

import { BODY_INDEX } from './bodies.js';
import { t, intl, locale } from '../core/i18n.js';

const PLANETS = ['jupiter', 'saturn', 'mars', 'venus', 'mercury'];
const NAMES = { jupiter: 'Jupiter', saturn: 'Saturn', mars: 'Mars', venus: 'Venus', mercury: 'Mercury' };

/** "a, b and c" (other locales: Intl's list, 'a, b và c'). */
function list(items) {
    if (items.length <= 1) return items.join('');
    if (locale() !== 'en') return intl(Intl.ListFormat, { type: 'conjunction' }).format(items);
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The caption in the interface's language, one whole phrase per clause.
 * @param {import('../core/types.js').Snapshot} snap full detail (constellations, phases, `above`)
 * @returns {string} '' without usable data
 */
export function skyCaption(snap) {
    const b = snap?.bodies;
    if (!b || snap.detail !== 'full') return '';
    const parts = [];
    const moon = b[BODY_INDEX.moon];
    const where = PLANETS.filter((id) => b[BODY_INDEX[id]]?.constellation?.name)
        .map((id, k) => {
            const v = { body: t(NAMES[id]), con: b[BODY_INDEX[id]].constellation.name };
            return k ? t('{body} in {con}', v) : t('{body} was in {con}', v);
        });
    if (where.length) parts.push(`${where[0]}${where.length > 1 ? `, ${list(where.slice(1))}` : ''}.`);
    if (moon && Number.isFinite(moon.phaseFrac)) {
        const v = { pct: Math.round(moon.phaseFrac * 100), con: moon.constellation?.name };
        parts.push(v.con ? (moon.above ? t('The Moon was {pct}% lit, in {con}, and up.', v) : t('The Moon was {pct}% lit, in {con}, below the horizon.', v))
            : moon.above ? t('The Moon was {pct}% lit, and up.', v) : t('The Moon was {pct}% lit, below the horizon.', v));
    }
    const up = PLANETS.filter((id) => b[BODY_INDEX[id]]?.above && b[BODY_INDEX[id]].mag < 2).map((id) => t(NAMES[id]));
    if (up.length) parts.push(t('Up at that hour: {list}.', { list: list(up) }));
    const venus = b[BODY_INDEX.venus];
    if (venus && venus.elongDeg > 15 && venus.elongSide) {
        parts.push(venus.elongSide === 'morning' ? t('Venus was the morning star.') : t('Venus was the evening star.'));
    }
    return parts.join(' ');
}
