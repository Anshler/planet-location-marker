/**
 * Body registry and physical constants shared by every group.
 *
 * The order of BODIES is a contract: Snapshot.bodies, beam instances, glyph
 * vertices and the 1–9 keyboard shortcuts all index into it. Names are English, marked for the
 * string table (core/i18n.js): show them with t(name).
 *
 * @module astro/bodies
 */

import { N_ } from '../core/i18n.js';

/** Kilometres per astronomical unit (IAU 2012). */
export const AU_KM = 149597870.7;
/** Earth equatorial radius in km (WGS84). One scene unit equals this length. */
export const EARTH_RADIUS_KM = 6378.137;
/** Earth radii per astronomical unit (≈ 23454.8). */
export const AU_ER = AU_KM / EARTH_RADIUS_KM;
/** Light travel time across one astronomical unit, in seconds. */
export const LIGHT_S_PER_AU = 499.004784;
/** Mean lunar radius in Earth radii (1737.4 km / 6378.137 km ≈ 0.27240). */
export const MOON_RADIUS_ER = 1737.4 / 6378.137;
/** Solar radius in km (IAU 2015 nominal; astronomy-engine's SUN_RADIUS_KM for its eclipse contacts). */
export const SUN_RADIUS_KM = 695700;
/**
 * Angular radius of the Sun's disc seen from exactly 1 AU, in radians: asin(R☉ / 1 AU) ≈ 959.2″.
 * The true radius varies ±1.7 % over the year; use {@link sunAngularRadius} for it.
 */
export const SUN_ANG_RADIUS_1AU_RAD = Math.asin(SUN_RADIUS_KM / AU_KM);

/**
 * True angular radius of the Sun's disc at a distance, in radians: asin(R☉ / d). The one rule
 * shared by the snapshot's obscuration, the globe's umbra and the drawn disc, so all three agree
 * with astronomy-engine's contact times. Non-positive or non-finite input gives the 1 AU value.
 * @param {number} distAU Distance to the Sun in AU (a snapshot's `bodies[0].distAU`).
 * @returns {number} Radians (≈ 0.004585 at aphelion, 0.004742 at perihelion).
 */
export function sunAngularRadius(distAU) {
    return distAU > 0 && distAU < Infinity ? Math.asin(Math.min(1, SUN_RADIUS_KM / (distAU * AU_KM))) : SUN_ANG_RADIUS_1AU_RAD;
}

/**
 * @typedef {'sun'|'moon'|'mercury'|'venus'|'mars'|'jupiter'|'saturn'|'uranus'|'neptune'} BodyId
 * @typedef {{id:BodyId, ae:string, name:string, kind:'star'|'moon'|'planet', color:string, radiusKm:number, key:string}} BodyInfo
 */

/**
 * The nine tracked bodies, in contract order. `ae` is the astronomy-engine body
 * name; `color` is the sRGB hex used by beams, glyphs, labels and CSS
 * (`--body-<id>`); `key` is the keyboard shortcut that selects the body.
 * The array is frozen so an accidental in-place sort cannot silently break the
 * order contract for every consumer; the entries themselves stay extensible.
 * @type {ReadonlyArray<BodyInfo>}
 */
export const BODIES = Object.freeze([
    { id: 'sun', ae: 'Sun', name: N_('Sun'), kind: 'star', color: '#ffd36b', radiusKm: SUN_RADIUS_KM, key: '1' },
    { id: 'moon', ae: 'Moon', name: N_('Moon'), kind: 'moon', color: '#d8dde6', radiusKm: 1737.4, key: '2' },
    { id: 'mercury', ae: 'Mercury', name: N_('Mercury'), kind: 'planet', color: '#b9b2aa', radiusKm: 2439.7, key: '3' },
    { id: 'venus', ae: 'Venus', name: N_('Venus'), kind: 'planet', color: '#fff4d6', radiusKm: 6051.8, key: '4' },
    { id: 'mars', ae: 'Mars', name: N_('Mars'), kind: 'planet', color: '#ff6a3d', radiusKm: 3389.5, key: '5' },
    { id: 'jupiter', ae: 'Jupiter', name: N_('Jupiter'), kind: 'planet', color: '#e9c08f', radiusKm: 69911, key: '6' },
    { id: 'saturn', ae: 'Saturn', name: N_('Saturn'), kind: 'planet', color: '#e8c872', radiusKm: 58232, key: '7' },
    { id: 'uranus', ae: 'Uranus', name: N_('Uranus'), kind: 'planet', color: '#9fe3e6', radiusKm: 25362, key: '8' },
    { id: 'neptune', ae: 'Neptune', name: N_('Neptune'), kind: 'planet', color: '#7f97ff', radiusKm: 24622, key: '9' },
]);

/**
 * The Earth as a target, for an observer standing on Mars (astro/host-mars.js). It takes Mars's
 * slot (index 4, key 5, id 'mars'), so every consumer that indexes BODIES — beams, glyphs, the 1–9
 * keys, URL ids — stays valid; only what is shown (name, colour, astronomy-engine body) changes.
 * `target` names the body it really is.
 * @type {Readonly<BodyInfo & {target:string}>}
 */
export const EARTH_TARGET = Object.freeze({
    id: 'mars', target: 'earth', ae: 'Earth', name: N_('Earth'), kind: 'planet', color: '#6fb6ff', radiusKm: 6371.0, key: '5',
});

/**
 * The nine slots as seen from each host world: the Earth's sky (BODIES), and Mars's, where slot 4
 * is the Earth (the verifier's host table; ROADMAP stand-on-mars).
 * @type {Readonly<{earth:ReadonlyArray<BodyInfo>, mars:ReadonlyArray<BodyInfo>}>}
 */
export const HOST_BODIES = Object.freeze({
    earth: BODIES,
    mars: Object.freeze(BODIES.map((b) => (b.id === 'mars' ? EARTH_TARGET : b))),
});

/**
 * The slot table for a host world ('earth' when unknown).
 * @param {string|null|undefined} host a snapshot's `host` or the store's `host.id`
 * @returns {ReadonlyArray<BodyInfo>}
 */
export function hostBodies(host) {
    return host === 'mars' ? HOST_BODIES.mars : BODIES;
}

/**
 * Index of each body in BODIES, e.g. `BODY_INDEX.mars === 4`.
 * @type {Readonly<Record<BodyId, number>>}
 */
export const BODY_INDEX = Object.freeze(Object.fromEntries(BODIES.map((b, i) => [b.id, i])));

/**
 * Body ids in contract order.
 * @type {ReadonlyArray<BodyId>}
 */
export const BODY_IDS = Object.freeze(BODIES.map((b) => b.id));

/**
 * True when `id` names one of the nine tracked bodies.
 * @param {unknown} id
 * @returns {id is BodyId}
 */
export function isBodyId(id) {
    // hasOwnProperty guards against prototype keys such as 'constructor'.
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BODY_INDEX, id);
}

/**
 * Looks up a body by id.
 * @param {string} id
 * @returns {BodyInfo|null} The registry entry, or null for an unknown id.
 */
export function bodyById(id) {
    return isBodyId(id) ? BODIES[BODY_INDEX[id]] : null;
}
