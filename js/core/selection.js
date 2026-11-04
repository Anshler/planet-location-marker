// What `store.selection` may hold (pure, no DOM).
//
// A selection is one of the nine BodyIds (astro/bodies.js: their order and the 1–9 keys stay a
// contract) or an *extra object*: a namespaced id `<kind>:<key>` for things beyond the nine.
//
//   star:<hip>        a catalogue star (Hipparcos number)        e.g. star:32349 (Sirius)
//   dso:<id>          a deep-sky object                          e.g. dso:m31
//   comet:<id>        a comet (astro/comets.js)                  e.g. comet:halley
//   craft:<id>        a spacecraft (astro/craft.js)              e.g. craft:voyager1
//   guest:<id>        a historical guest star (astro/guest-stars.js)  e.g. guest:sn1054
//
// Keys are lower-case ASCII letters, digits and `._+-`, 1–32 characters, starting with a letter
// or digit, so an id survives the URL hash (`sel=comet:halley`) unescaped. Whether an id names a
// real object is the extras registry's business (astro/extras.js): a well-formed id is accepted
// here, so a link keeps its selection while the data that defines it is still loading.

/** The extra-object kinds, in the order the registry lists them. */
export const EXTRA_KINDS = Object.freeze(['star', 'dso', 'comet', 'craft', 'guest']);

const BODY_SET = new Set(['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
const EXTRA_RE = /^(star|dso|comet|craft|guest):([a-z0-9][a-z0-9._+-]{0,31})$/;

/**
 * True for a well-formed extra-object id (`comet:halley`, `star:32349`).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isExtraId(id) {
    return typeof id === 'string' && EXTRA_RE.test(id);
}

/**
 * True for anything `store.selection` may hold besides null: a BodyId or a well-formed extra id.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSelectionId(id) {
    return typeof id === 'string' && (BODY_SET.has(id) || EXTRA_RE.test(id));
}

/**
 * Splits a selection id: `{kind:'body', key:'mars'}`, `{kind:'comet', key:'halley'}`, or null.
 * @param {unknown} id
 * @returns {{kind:'body'|'star'|'dso'|'comet'|'craft'|'guest', key:string}|null}
 */
export function parseSelectionId(id) {
    if (typeof id !== 'string') return null;
    if (BODY_SET.has(id)) return { kind: 'body', key: id };
    const m = EXTRA_RE.exec(id);
    return m ? { kind: /** @type {any} */ (m[1]), key: m[2] } : null;
}

/**
 * Normalises a typed or linked selection: trims, lower-cases, and returns the id when it is
 * valid, null for '' or 'none', and undefined when it is not usable.
 * @param {unknown} v
 * @returns {string|null|undefined}
 */
export function normalizeSelectionId(v) {
    if (v === null) return null;
    if (typeof v !== 'string') return undefined;
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'none') return null;
    return isSelectionId(s) ? s : undefined;
}
