/**
 * Finding things in the real sky (ROADMAP angle-ruler-and-fists, ar-sky-pointing), pure.
 *
 * - Hand units at arm's length: a fist covers about 10°, a finger about 1° (`handSpan`: '1½ fists').
 *   They vary from person to person, so every sentence says 'about'.
 * - `findIt(target, refs)`: 'Face east-north-east, 1½ fists up from the horizon, 2 fists left of the
 *   Moon.' from the target's apparent altitude and azimuth and its nearest bright neighbour, the
 *   offset measured in the neighbour's own upright frame (left and right as you face it).
 * - `guideRefs(snap, targetId)`: the neighbours a sentence may lean on: the Moon and the bright
 *   planets, and by night the brightest stars (`BRIGHT_STARS`, J2000; Polaris too).
 * - `separationDeg`, `fmtAngle`, `rulerText`: the angle ruler's numbers.
 * - `edgeHit`: where a ray from the view centre leaves a rectangle (the off-screen pointers).
 *
 * Horizon terms throughout: azimuth from north through east, altitude above the horizon (degrees).
 * Vectors are Float64Array(3) (R7); horizon vectors are (east, north, up).
 *
 * @module astro/sky-guide
 */

import { hostBodies } from './bodies.js';

const DEG = Math.PI / 180;

/** A fist at arm's length covers about this many degrees. */
export const FIST_DEG = 10;
/** A finger's width at arm's length covers about this many degrees. */
export const FINGER_DEG = 1;
/** Closer than this, a neighbour is 'right next to' the target. */
export const NEXT_TO_DEG = 0.6;
/** Neighbours farther than this from the target are no help. */
export const MAX_REF_SEP_DEG = 40;
/** Neighbours this low are lost in the haze or behind the trees. */
export const REF_MIN_ALT_DEG = 3;
/** A neighbour this many magnitudes fainter than the target is used only when nothing brighter is near. */
export const REF_FAINTER_MAG = 1.5;

const COMPASS16_WORDS = Object.freeze([
    'north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east',
    'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west',
]);
/** Offset directions by 45° sector, counter-clockwise from 'right' (screen-like: +x right, +y up). */
const DIR8 = Object.freeze([
    'right of', 'above and to the right of', 'above', 'above and to the left of',
    'left of', 'below and to the left of', 'below', 'below and to the right of',
]);

/**
 * The brightest stars (mag ≤ 1.6) and Polaris: name, J2000 right ascension (hours), declination
 * (degrees), visual magnitude, Hipparcos number. Positions to ~0.01°, proper motion ignored (≤ 0.05°
 * since 2000; up to 0.6° by 1000 or 3000, so a card excludes its own star by `hip`, not by place).
 */
export const BRIGHT_STARS = Object.freeze([
    ['Sirius', 6.7525, -16.716, -1.46, 32349], ['Canopus', 6.3992, -52.696, -0.74, 30438], ['Arcturus', 14.2610, 19.182, -0.05, 69673],
    ['Rigil Kentaurus', 14.6601, -60.834, -0.27, 71683], ['Vega', 18.6156, 38.784, 0.03, 91262], ['Capella', 5.2782, 45.998, 0.08, 24608],
    ['Rigel', 5.2423, -8.202, 0.13, 24436], ['Procyon', 7.6550, 5.225, 0.34, 37279], ['Achernar', 1.6286, -57.237, 0.46, 7588],
    ['Betelgeuse', 5.9195, 7.407, 0.50, 27989], ['Hadar', 14.0637, -60.373, 0.61, 68702], ['Altair', 19.8464, 8.868, 0.77, 97649],
    ['Acrux', 12.4433, -63.099, 0.76, 60718], ['Aldebaran', 4.5987, 16.509, 0.86, 21421], ['Antares', 16.4901, -26.432, 0.96, 80763],
    ['Spica', 13.4199, -11.161, 0.97, 65474], ['Pollux', 7.7553, 28.026, 1.14, 37826], ['Fomalhaut', 22.9608, -29.622, 1.16, 113368],
    ['Deneb', 20.6905, 45.280, 1.25, 102098], ['Mimosa', 12.7954, -59.689, 1.25, 62434], ['Regulus', 10.1395, 11.967, 1.35, 49669],
    ['Adhara', 6.9771, -28.972, 1.50, 33579], ['Castor', 7.5767, 31.888, 1.58, 36850], ['Polaris', 2.5303, 89.264, 1.98, 11767],
].map(([name, raH, decDeg, mag, hip]) => Object.freeze({ name, raH, decDeg, mag, hip })));

/** Scene-frame unit vectors of BRIGHT_STARS (EQJ → scene: (x, y, z) → (x, z, −y)), built once. */
const STAR_DIRS = BRIGHT_STARS.map((s) => {
    const a = s.raH * 15 * DEG, d = s.decDeg * DEG;
    const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
    return new Float64Array([x, z, -y]);
});

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const wrap360 = (d) => ((d % 360) + 360) % 360;

/**
 * An angle as hands at arm's length: 'less than a finger', 'a finger', '3 fingers', 'half a fist',
 * '1 fist', '1½ fists', '4 fists'. Empty for a negative or non-finite angle.
 * @param {number} deg
 * @returns {string}
 */
export function handSpan(deg) {
    if (!Number.isFinite(deg) || deg < 0) return '';
    if (deg < NEXT_TO_DEG) return 'less than a finger';
    if (deg < 1.5 * FINGER_DEG) return 'a finger';
    if (deg < 3.5 * FINGER_DEG) return `${Math.round(deg / FINGER_DEG)} fingers`;
    if (deg < 0.75 * FIST_DEG) return 'half a fist';
    const halves = Math.round(deg / (FIST_DEG / 2));
    const whole = Math.floor(halves / 2), half = halves % 2 === 1;
    return `${whole}${half ? '½' : ''} fist${whole === 1 && !half ? '' : 's'}`;
}

/**
 * 16-point compass words for an azimuth: 67 → 'east-north-east'.
 * @param {number} azDeg
 * @returns {string}
 */
export function compassWords16(azDeg) {
    if (!Number.isFinite(azDeg)) return '';
    return COMPASS16_WORDS[Math.round(wrap360(azDeg) / 22.5) % 16];
}

/**
 * Horizon unit vector (east, north, up) for an azimuth and altitude, into out.
 * @param {number} azDeg
 * @param {number} altDeg
 * @param {Float64Array} out
 * @returns {Float64Array} out
 */
export function horizonVector(azDeg, altDeg, out) {
    const ca = Math.cos(altDeg * DEG);
    out[0] = ca * Math.sin(azDeg * DEG);
    out[1] = ca * Math.cos(azDeg * DEG);
    out[2] = Math.sin(altDeg * DEG);
    return out;
}

const _a = new Float64Array(3);
const _b = new Float64Array(3);

/**
 * Angle between two horizon directions (degrees, 0…180), stable at small and large angles.
 * @returns {number}
 */
export function separationDeg(az1, alt1, az2, alt2) {
    horizonVector(az1, alt1, _a);
    horizonVector(az2, alt2, _b);
    return vectorAngleDeg(_a, _b);
}

/**
 * Angle between two unit vectors (degrees), atan2 of the cross and dot products.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function vectorAngleDeg(a, b) {
    const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
    return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / DEG;
}

/**
 * Where `target` sits as seen from `ref` by an upright observer facing `ref`: dx to the right and
 * dy up (the components of the target's direction along the ref's local right and up), the
 * separation, and the words for the offset ('left of', 'above and to the right of', …).
 * @param {{azDeg:number, altDeg:number}} ref
 * @param {{azDeg:number, altDeg:number}} target
 * @returns {{dx:number, dy:number, sepDeg:number, words:string}}
 */
export function relativeOffset(ref, target) {
    const az = ref.azDeg * DEG, alt = ref.altDeg * DEG;
    horizonVector(target.azDeg, target.altDeg, _b);
    // Right of an upright observer facing az: the horizontal direction az + 90°. Up: toward the zenith.
    const dx = _b[0] * Math.cos(az) - _b[1] * Math.sin(az);
    const dy = -_b[0] * Math.sin(alt) * Math.sin(az) - _b[1] * Math.sin(alt) * Math.cos(az) + _b[2] * Math.cos(alt);
    const sepDeg = separationDeg(ref.azDeg, ref.altDeg, target.azDeg, target.altDeg);
    const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    return { dx, dy, sepDeg, words: DIR8[sector] };
}

/**
 * 'Find it' guidance: which way to face, how many hands up, and where it is from the nearest
 * bright neighbour. Null below the horizon (apparent altitude under −0.5°).
 * @param {{name?:string, azDeg:number, altDeg:number, mag?:number}} target apparent horizon position;
 *   with `mag`, neighbours more than REF_FAINTER_MAG fainter are a last resort
 * @param {Array<{name:string, azDeg:number, altDeg:number, mag?:number}>} [refs] candidate neighbours
 *   (guideRefs); `name` as it reads in a sentence ('the Moon', 'Jupiter', 'Vega')
 * @returns {{face:string, up:string, overhead:boolean, ref:{name:string, span:string, words:string, sepDeg:number}|null,
 *   text:string}|null}
 */
export function findIt(target, refs = []) {
    if (!target || !Number.isFinite(target.altDeg) || !Number.isFinite(target.azDeg) || target.altDeg < -0.5) return null;
    const alt = target.altDeg;
    const face = compassWords16(target.azDeg);
    const overhead = alt >= 80;
    const up = handSpan(Math.max(0, alt));
    let head;
    if (overhead) head = 'Look almost straight up';
    else if (alt < 2.5) head = `Face ${face}, just above the horizon`;
    else head = `Face ${face}, ${up} up from the horizon`;
    // A neighbour much fainter than the target is a poor signpost (Jupiter is no easier to find from
    // Regulus): those count only when nothing comparable is near.
    const list = Array.isArray(refs) ? refs : [];
    const tMag = Number.isFinite(target.mag) ? target.mag : Infinity;
    let ref = nearestRef(list, target, tMag + REF_FAINTER_MAG);
    if (!ref && Number.isFinite(tMag)) ref = nearestRef(list, target, Infinity);
    let tail = '';
    let refOut = null;
    if (ref) {
        const off = relativeOffset(ref, target);
        if (off.sepDeg < NEXT_TO_DEG) {
            refOut = { name: ref.name, span: '', words: 'right next to', sepDeg: off.sepDeg };
            tail = `, right next to ${ref.name}`;
        } else {
            const span = handSpan(off.sepDeg);
            refOut = { name: ref.name, span, words: off.words, sepDeg: off.sepDeg };
            tail = `, ${span} ${off.words} ${ref.name}`;
        }
    }
    return { face, up, overhead, ref: refOut, text: `${head}${tail}.` };
}

/** The neighbour nearest the target within MAX_REF_SEP_DEG and no fainter than magLimit, or null. */
function nearestRef(list, target, magLimit) {
    let ref = null;
    let best = MAX_REF_SEP_DEG;
    for (const r of list) {
        if (!r || !Number.isFinite(r.altDeg) || !Number.isFinite(r.azDeg)) continue;
        if (Number.isFinite(r.mag) && r.mag > magLimit) continue;
        const sep = separationDeg(r.azDeg, r.altDeg, target.azDeg, target.altDeg);
        if (!(sep < best) || sep < 1e-6) continue;
        best = sep;
        ref = r;
    }
    return ref;
}

/**
 * Brightness a neighbour needs to be of use: by night the bright planets and stars, in twilight only
 * the brightest, by day the Moon and Venus.
 * @param {number} sunAltDeg
 * @returns {number} magnitude limit
 */
export function refMagLimit(sunAltDeg) {
    if (!Number.isFinite(sunAltDeg)) return 1.6;
    if (sunAltDeg < -8) return 2.0;
    if (sunAltDeg < -2) return 0;
    return -3.5;
}

/**
 * The neighbours findIt may use, from a snapshot: the Moon and planets bright enough to see now
 * (apparent positions; the Sun never), and below −8° of Sun the BRIGHT_STARS, all at least
 * REF_MIN_ALT_DEG up. Names read in a sentence ('the Moon').
 * @param {{bodies:Array<{altDeg?:number, azDeg?:number, altGeomDeg:number, azGeomDeg:number, mag?:number}>,
 *   observer:{upS:ArrayLike<number>, northS:ArrayLike<number>, eastS:ArrayLike<number>, sunAltDeg?:number}}} snap
 * @param {string|null} [targetId] left out of the list
 * @returns {Array<{id:string, name:string, azDeg:number, altDeg:number, mag:number}>}
 */
export function guideRefs(snap, targetId = null) {
    const out = [];
    if (!snap || !snap.bodies || !snap.observer) return out;
    const o = snap.observer;
    const sunAlt = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : snap.bodies[0]?.altGeomDeg;
    const lim = refMagLimit(sunAlt);
    // Standing on Mars slot 4 is the Earth, and the Earth's Moon is a faint point, not a day landmark.
    const mars = snap.host === 'mars';
    const names = hostBodies(mars ? 'mars' : 'earth');
    for (let i = 0; i < names.length && i < snap.bodies.length; i++) {
        const id = names[i].id;
        if (id === 'sun' || id === targetId) continue;
        const b = snap.bodies[i];
        const full = Number.isFinite(b.altDeg) && Number.isFinite(b.azDeg) && !(b.altDeg === 0 && b.azDeg === 0 && b.altGeomDeg !== 0);
        const alt = full ? b.altDeg : b.altGeomDeg, az = full ? b.azDeg : b.azGeomDeg;
        const mag = id === 'moon' && !mars ? -10 : Number.isFinite(b.mag) ? b.mag : 99;
        if (!(alt >= REF_MIN_ALT_DEG) || mag > lim) continue;
        const name = id === 'moon' ? 'the Moon' : mars && id === 'mars' ? 'the Earth' : names[i].name;
        out.push({ id, name, azDeg: az, altDeg: alt, mag });
    }
    if (o.upS && o.northS && o.eastS && sunAlt < -8) {
        const up = o.upS, n = o.northS, e = o.eastS;
        for (let k = 0; k < BRIGHT_STARS.length; k++) {
            const d = STAR_DIRS[k], s = BRIGHT_STARS[k];
            if (s.mag > lim) continue;
            const du = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
            const alt = Math.asin(clamp(du, -1, 1)) / DEG;
            if (alt < REF_MIN_ALT_DEG) continue;
            const az = wrap360(Math.atan2(d[0] * e[0] + d[1] * e[1] + d[2] * e[2], d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / DEG);
            out.push({ id: `star:${s.name}`, name: s.name, azDeg: az, altDeg: alt, mag: s.mag, hip: s.hip });
        }
    }
    return out;
}

/**
 * A measured angle for display: arcminutes under 1° ('42′'), one decimal under 20° ('4.2°'),
 * whole degrees above ('37°').
 * @param {number} deg
 * @returns {string}
 */
export function fmtAngle(deg) {
    if (!Number.isFinite(deg)) return '—';
    if (deg < 1) return `${Math.round(deg * 60)}′`;
    if (deg < 20) return `${(Math.round(deg * 10) / 10).toFixed(1)}°`;
    return `${Math.round(deg)}°`;
}

/**
 * The angle ruler's reading: '4.2° · about half a fist'.
 * @param {number} deg
 * @returns {string}
 */
export function rulerText(deg) {
    if (!Number.isFinite(deg)) return '';
    return `${fmtAngle(deg)} · about ${handSpan(deg)}`;
}

/**
 * Where a ray from (px, py) in direction (dx, dy) leaves the rectangle [x0, x1] × [y0, y1] (screen
 * pixels, y down). A start point outside is clamped in first; a zero direction points right.
 * @param {number} px
 * @param {number} py
 * @param {number} dx
 * @param {number} dy
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {{x:number, y:number, edge:string}} out edge: 'top' | 'bottom' | 'left' | 'right'
 * @returns {{x:number, y:number, edge:string}} out
 */
export function edgeHit(px, py, dx, dy, x0, y0, x1, y1, out) {
    if (x1 < x0) x0 = x1 = (x0 + x1) / 2;
    if (y1 < y0) y0 = y1 = (y0 + y1) / 2;
    px = clamp(px, x0, x1);
    py = clamp(py, y0, y1);
    const l = Math.hypot(dx, dy);
    if (!(l > 1e-12)) { dx = 1; dy = 0; } else { dx /= l; dy /= l; }
    let t = Infinity, edge = 'right';
    if (dx > 1e-12) { const u = (x1 - px) / dx; if (u < t) { t = u; edge = 'right'; } }
    if (dx < -1e-12) { const u = (x0 - px) / dx; if (u < t) { t = u; edge = 'left'; } }
    if (dy > 1e-12) { const u = (y1 - py) / dy; if (u < t) { t = u; edge = 'bottom'; } }
    if (dy < -1e-12) { const u = (y0 - py) / dy; if (u < t) { t = u; edge = 'top'; } }
    if (!Number.isFinite(t)) t = 0;
    out.x = clamp(px + dx * t, x0, x1);
    out.y = clamp(py + dy * t, y0, y1);
    out.edge = edge;
    return out;
}
