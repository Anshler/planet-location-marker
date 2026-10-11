/**
 * Body registry and physical constants shared by every group.
 *
 * The order of BODIES is a contract: Snapshot.bodies, beam instances, glyph
 * vertices and the 1–9 keyboard shortcuts all index into it.
 *
 * @module astro/bodies
 */

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
/** Nominal angular radius of the Sun's disc at 1 AU, in radians (≈ 960″). */
export const SUN_ANG_RADIUS_RAD = 0.0046542;

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
    { id: 'sun', ae: 'Sun', name: 'Sun', kind: 'star', color: '#ffd36b', radiusKm: 695700, key: '1' },
    { id: 'moon', ae: 'Moon', name: 'Moon', kind: 'moon', color: '#d8dde6', radiusKm: 1737.4, key: '2' },
    { id: 'mercury', ae: 'Mercury', name: 'Mercury', kind: 'planet', color: '#b9b2aa', radiusKm: 2439.7, key: '3' },
    { id: 'venus', ae: 'Venus', name: 'Venus', kind: 'planet', color: '#fff4d6', radiusKm: 6051.8, key: '4' },
    { id: 'mars', ae: 'Mars', name: 'Mars', kind: 'planet', color: '#ff6a3d', radiusKm: 3389.5, key: '5' },
    { id: 'jupiter', ae: 'Jupiter', name: 'Jupiter', kind: 'planet', color: '#e9c08f', radiusKm: 69911, key: '6' },
    { id: 'saturn', ae: 'Saturn', name: 'Saturn', kind: 'planet', color: '#e8c872', radiusKm: 58232, key: '7' },
    { id: 'uranus', ae: 'Uranus', name: 'Uranus', kind: 'planet', color: '#9fe3e6', radiusKm: 25362, key: '8' },
    { id: 'neptune', ae: 'Neptune', name: 'Neptune', kind: 'planet', color: '#7f97ff', radiusKm: 24622, key: '9' },
]);

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
