/**
 * Guided tours (ROADMAP Phase 5, guided-tours): the catalogue the Events tab lists and the URL
 * accepts (`#tour=<id>`). The steps themselves are built by js/app/tours.js, which main.js loads
 * on demand when a tour starts.
 *
 * Pure: no DOM, no three.js.
 * @module core/tour-catalog
 */

/** @typedef {{id:string, title:string, blurb:string, approxS:number|null}} TourInfo */

/** @type {ReadonlyArray<Readonly<TourInfo>>} `approxS` is the running time (null: runs until stopped). */
export const TOURS = Object.freeze([
    { id: 'tonight', title: 'Tonight from here', blurb: 'Sunset, each planet at its best, then the Moon', approxS: 90 },
    { id: 'year', title: 'A year in a minute', blurb: 'The seasons sweep the globe; the noon Sun climbs and sinks', approxS: 60 },
    { id: 'eclipse-2027', title: 'Eclipse 2027', blurb: 'Totality from Luxor, then ride the Moon’s shadow', approxS: 130 },
    { id: 'ambient', title: 'Ambient', blurb: 'A slow live drift for idle screens', approxS: null },
].map((t) => Object.freeze(t)));

/** Tour ids in catalogue order. */
export const TOUR_IDS = Object.freeze(TOURS.map((t) => t.id));

/** @param {unknown} id @returns {id is string} */
export function isTourId(id) {
    return typeof id === 'string' && TOUR_IDS.includes(id);
}

/** @param {unknown} id @returns {Readonly<TourInfo>|null} */
export function tourById(id) {
    return TOURS.find((t) => t.id === id) ?? null;
}
