/**
 * Event glyphs (ROADMAP event-glyphs-and-ics): a small inline SVG per sky event that shows the
 * event itself, built like `icons.js` (24-unit viewBox, no canvas, no cache needed) and coloured
 * by the CSS colour tokens (`--body-*`, `--ev-copper`, `--ev-meteor`), so a theme change or the
 * Mars palette restyles them.
 *
 * - Moon phases show their phase (new, first quarter, full, last quarter), lit on the side this
 *   hemisphere sees (`south`); a supermoon is a larger full disc with a halo.
 * - A conjunction of two bodies is two dots in both bodies' colours, spaced by `sepDeg`; a Moon
 *   appulse puts the planet beside the Moon (half behind its limb for an occultation); a planet
 *   with the Sun sits in front of it (inferior conjunction) or behind its limb.
 * - Eclipses show the actual overlap: a local solar eclipse's obscuration and a lunar eclipse's
 *   umbral fraction become the discs' offset (`offsetForCover`, by bisection on
 *   astro/shadow.js `discVisibleFraction`); the covered part is a lens (`lensPath`), the Sun's a
 *   hole through it (even-odd), the Moon's in copper.
 * - Oppositions are a Sun–Earth–planet line; greatest elongations the planet above the Sun on the
 *   horizon, further the wider the angle;
 *   transits a dark dot on the Sun at its distance from the centre; star occultations a star at
 *   the Moon's limb (the Pleiades a cluster); perigee and apogee the Moon large or small;
 *   ring-plane crossings Saturn's rings edge-on; meteor showers streaks from a radiant;
 *   equinoxes and solstices the Sun's day arc over the horizon (high in this hemisphere's summer).
 *
 * `glyphSpec(ev, opts)` is pure (no DOM): a list of [tag, attrs] that tests read. `eventGlyph`
 * turns it into an SVGElement; colour values in `var(...)` go to `style`, since presentation
 * attributes do not take custom properties.
 *
 * @module ui/event-glyphs
 */

import { svgNS } from './dom.js';
import { discVisibleFraction } from '../astro/shadow.js';

const SUN = 'var(--body-sun)';
const MOON = 'var(--body-moon)';
const EARTH = 'var(--accent)';
const COPPER = 'var(--ev-copper)';
const BG = 'var(--bg)';
const MUTED = 'var(--muted)';
const body = (id) => `var(--body-${id})`;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** A full circle as path data (so it can join a compound even-odd path). */
export function circlePath(cx, cy, r) {
    return `M${r2(cx - r)} ${r2(cy)}a${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0a${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0z`;
}

/**
 * The intersection of two discs as path data: two arcs between the circles' crossing points;
 * the smaller disc when one holds the other; '' when they do not overlap.
 */
export function lensPath(x1, y1, ra, x2, y2, rb) {
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
    if (!(d < ra + rb)) return '';
    if (d <= Math.abs(ra - rb)) return ra <= rb ? circlePath(x1, y1, ra) : circlePath(x2, y2, rb);
    const a = (d * d + ra * ra - rb * rb) / (2 * d);
    const hh = Math.sqrt(Math.max(0, ra * ra - a * a));
    const mx = x1 + (a * dx) / d, my = y1 + (a * dy) / d;
    const px = mx + (hh * dy) / d, py = my - (hh * dx) / d;
    const qx = mx - (hh * dy) / d, qy = my + (hh * dx) / d;
    // From P to Q along circle B's arc inside A, then back along A's arc inside B.
    const bigB = a > d ? 1 : 0;          // B's centre lies on P–Q's far side from A: its inner arc is the long one
    const bigA = a < 0 ? 1 : 0;
    return `M${r2(px)} ${r2(py)}A${r2(rb)} ${r2(rb)} 0 ${bigB} 0 ${r2(qx)} ${r2(qy)}A${r2(ra)} ${r2(ra)} 0 ${bigA} 0 ${r2(px)} ${r2(py)}z`;
}

/**
 * Centre separation at which a disc of radius `rc` covers the fraction `frac` of a disc of radius
 * `rs` (area), by bisection; `rs + rc` for none, the centred offset for all it can cover.
 */
export function offsetForCover(rs, rc, frac) {
    const f = clamp01(frac);
    let lo = Math.abs(rs - rc), hi = rs + rc;
    if (f <= 0) return hi;
    if (f >= 1 - discVisibleFraction(rs, rc, lo) - 1e-9) return rc >= rs ? Math.max(0, lo - 0.01) : 0;
    for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        if (1 - discVisibleFraction(rs, rc, m) > f) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
}

/**
 * The lit part of a disc as path data: the limb on the lit side, then the terminator (an
 * ellipse of half-width |1 − 2k|·r) back. `k` is the lit fraction, `right` the lit side.
 */
export function phasePath(cx, cy, r, k, right) {
    const f = clamp01(k);
    if (f >= 0.999) return circlePath(cx, cy, r);
    const rx = Math.abs(1 - 2 * f) * r;
    const limb = right ? 1 : 0;
    const term = (f < 0.5) === right ? 0 : 1;
    return `M${r2(cx)} ${r2(cy - r)}A${r2(r)} ${r2(r)} 0 0 ${limb} ${r2(cx)} ${r2(cy + r)}A${r2(rx)} ${r2(r)} 0 0 ${term} ${r2(cx)} ${r2(cy - r)}z`;
}

/** A four-point sparkle (a star) centred at (x, y). */
function sparkle(x, y, s) {
    const k = s * 0.28;
    return `M${r2(x)} ${r2(y - s)}L${r2(x + k)} ${r2(y - k)}L${r2(x + s)} ${r2(y)}L${r2(x + k)} ${r2(y + k)}L${r2(x)} ${r2(y + s)}` +
        `L${r2(x - k)} ${r2(y + k)}L${r2(x - s)} ${r2(y)}L${r2(x - k)} ${r2(y - k)}z`;
}

const circle = (cx, cy, r, attrs) => ['circle', { cx: r2(cx), cy: r2(cy), r: r2(r), ...attrs }];
const path = (d, attrs) => ['path', { d, ...attrs }];
const fill = (c, extra) => ({ fill: c, ...extra });
const line = (c, w = 1.4, extra) => ({ fill: 'none', stroke: c, 'stroke-width': w, 'stroke-linecap': 'round', ...extra });

/** Which quarter a phase event is (its `quarter`, else from the title). */
function quarterOf(ev) {
    if (Number.isInteger(ev.quarter)) return ev.quarter;
    const t = String(ev.title || '');
    return /^New/.test(t) ? 0 : /^First/.test(t) ? 1 : /^Full/.test(t) ? 2 : /^Last/.test(t) ? 3 : 2;
}

function moonPhase(ev, south) {
    const q = quarterOf(ev);
    const big = q === 2 && /supermoon/i.test(String(ev.detail || ''));
    const r = big ? 9.2 : 8.4;
    const out = [circle(12, 12, r, fill(MOON, { opacity: 0.16 }))];
    if (q === 0) out.push(circle(12, 12, r, line(MOON, 1.1, { opacity: 0.6 })));
    else if (q === 2) out.push(circle(12, 12, r, fill(MOON)));
    else out.push(path(phasePath(12, 12, r, 0.5, (q === 1) !== south), fill(MOON)));
    if (big) out.push(circle(12, 12, 11.1, line(MOON, 0.9, { opacity: 0.45 })));
    return out;
}

function opposition(ev) {
    const id = ev.bodyId || ev.select;
    return [
        path('M6.8 12h3.6M14.3 12h2.6', line(MUTED, 1.1, { 'stroke-dasharray': '1.2 1.5' })),
        circle(4, 12, 2.8, fill(SUN)),
        circle(12.4, 12, 1.9, fill(EARTH)),
        circle(19.8, 12, 2.6, fill(body(id))),
    ];
}

function conjunction(ev) {
    const ids = Array.isArray(ev.bodyIds) ? ev.bodyIds : null;
    const sep = Number(ev.sepDeg);
    if (ids && ids[0] === 'moon') {
        // A Moon appulse: the planet beside the Moon, half behind its limb when occulted.
        const rm = 6.6;
        const d = ev.occultation ? rm : rm + 2 + clamp01(sep / 1) * 4.6;
        const px = 9.2 + d * 0.94, py = 12 - d * 0.34;
        return [circle(px, py, 2.1, fill(body(ids[1]))), circle(9.2, 12, rm, fill(MOON))];
    }
    if (ids && ids.length === 2) {
        // Two planets: centres 5 units apart at 0°, 15 at the 1.5° limit.
        const d = 5.2 + clamp01((Number.isFinite(sep) ? sep : 1.5) / 1.5) * 10;
        const ux = 0.906, uy = -0.423;
        const ra = ev.select === ids[0] ? 2.9 : 2.3, rb = ev.select === ids[1] ? 2.9 : 2.3;
        return [
            circle(12 - (ux * d) / 2, 12 - (uy * d) / 2, ra, fill(body(ids[0]))),
            circle(12 + (ux * d) / 2, 12 + (uy * d) / 2, rb, fill(body(ids[1]))),
        ];
    }
    // A planet and the Sun: in front of it (inferior conjunction) or behind its limb.
    const id = ev.bodyId || ev.select;
    if (/inferior/i.test(String(ev.title || ''))) {
        return [circle(12, 12, 7, fill(SUN)), circle(14.6, 10.4, 2.2, fill(body(id), { stroke: BG, 'stroke-width': 1 }))];
    }
    return [circle(18.6, 9.6, 2.3, fill(body(id))), circle(11, 12.4, 7, fill(SUN))];
}

function elongation(ev) {
    // The planet above the Sun on the horizon (east: an evening sky, the Sun setting on the right),
    // further from it the wider the elongation: 5 units plus 10.5 at 50°.
    const id = ev.bodyId || ev.select;
    const e = Math.max(14, Math.min(50, Number(ev.elongDeg) || 30));
    const east = /east/i.test(String(ev.title || ''));
    const sx = east ? 16.6 : 7.4, ux = east ? -0.6 : 0.6, uy = -0.8;
    const d = 5 + (e / 50) * 10.5;
    const px = sx + ux * d, py = 18 + uy * d;
    return [
        path('M1.6 18h20.8', line(MUTED, 1.2)),
        path(`M${r2(sx - 3.4)} 18A3.4 3.4 0 0 1 ${r2(sx + 3.4)} 18z`, fill(SUN)),
        path(`M${r2(sx + ux * 4.8)} ${r2(18 + uy * 4.8)}L${r2(px - ux * 3.2)} ${r2(py - uy * 3.2)}`, line(MUTED, 1, { 'stroke-dasharray': '1.2 1.6' })),
        circle(px, py, 2.3, fill(body(id))),
    ];
}

// The covering disc comes in from the upper right.
const UX = 0.8, UY = -0.6;

function solarEclipse(ev) {
    const rs = 7.6;
    const kind = ev.eclipseKind || (/annular/i.test(ev.title) ? 'annular' : /total|hybrid/i.test(ev.title) ? 'total' : 'partial');
    const local = ev.kind === 'local-solar-eclipse';
    const central = kind !== 'partial' && (!local || (ev.centralUp && ev.centralUp !== 'none'));
    if (central && kind !== 'annular') {
        // Totality: the Moon's silhouette, the inner corona around it.
        return [
            circle(12, 12, 10.4, line(SUN, 1.3, { opacity: 0.35 })),
            circle(12, 12, 8.9, line(SUN, 1.1, { opacity: 0.7 })),
            circle(12, 12, 7.9, fill(BG, { stroke: SUN, 'stroke-width': 0.8 })),
        ];
    }
    const rm = kind === 'annular' ? 6.6 : 7.8;
    let d;
    if (central) d = 0;
    else {
        const obsc = local && Number.isFinite(ev.obscuration) ? Math.min(0.86, Math.max(0.12, ev.obscuration)) : 0.5;
        d = offsetForCover(rs, rm, obsc);
    }
    const mx = 12 + UX * d, my = 12 + UY * d;
    const hole = lensPath(12, 12, rs, mx, my, rm);
    return [
        path(circlePath(12, 12, rs) + hole, fill(SUN, { 'fill-rule': 'evenodd' })),
        circle(mx, my, rm, line(SUN, 0.7, { opacity: 0.35 })),
    ];
}

function lunarEclipse(ev) {
    const rm = 7.4;
    const kind = ev.eclipseKind || (/total/i.test(ev.title) ? 'total' : /partial/i.test(ev.title) ? 'partial' : 'penumbral');
    if (kind === 'total') {
        return [circle(12, 12, rm, fill(COPPER)), circle(12, 12, rm, line(MOON, 0.8, { opacity: 0.35 }))];
    }
    const out = [circle(12, 12, rm, fill(MOON))];
    if (kind === 'partial') {
        const ru = rm * 2.7;
        const d = offsetForCover(rm, ru, Number.isFinite(ev.obscuration) ? Math.min(0.9, Math.max(0.1, ev.obscuration)) : 0.5);
        out.push(path(lensPath(12, 12, rm, 12 - UX * d, 12 - UY * d, ru), fill(COPPER)));
    } else {
        const rp = rm * 4.6;
        const d = offsetForCover(rm, rp, 0.6);
        out.push(path(lensPath(12, 12, rm, 12 - UX * d, 12 - UY * d, rp), fill(BG, { opacity: 0.4 })));
    }
    return out;
}

function transit(ev) {
    const rs = 8.6;
    const id = ev.bodyId || ev.select;
    const rp = id === 'venus' ? 1.9 : 1.2;
    const y = 12 + Math.min(6.6, (Math.max(0, Number(ev.sepArcmin) || 8) / 16) * rs);
    return [
        path(circlePath(12, 12, rs) + circlePath(10.4, y, rp), fill(SUN, { 'fill-rule': 'evenodd' })),
        path(`M${r2(12 - Math.sqrt(Math.max(0, rs * rs - (y - 12) ** 2)) + 1)} ${r2(y)}H${r2(8.4)}`, line(BG, 0.9, { opacity: 0.55, 'stroke-dasharray': '1 1.4' })),
    ];
}

function occultation(ev) {
    const rm = 7.2, mx = 9.8;
    const out = [];
    if (ev.star === 'pleiades') {
        const dx = ev.occultation ? 5.6 : 8.4;
        const pts = [[0, 0], [1.9, -1.2], [3.1, 0.5], [1.2, 1.9], [-0.4, -2.2], [2.9, -2.6]];
        for (const [x, y] of pts) out.push(circle(mx + dx + x, 12.2 + y, 0.85, fill('var(--text)')));
    } else {
        const d = ev.occultation ? rm + 0.2 : rm + 2.6 + clamp01((Number(ev.sepDeg) || 0.3) / 0.5) * 2.4;
        out.push(path(sparkle(mx + d, 11, 2.8), fill('var(--text)')));
    }
    out.push(circle(mx, 12, rm, fill(MOON)));
    return out;
}

function apsis(ev) {
    if (ev.apsis === 'apogee' || /farthest/i.test(String(ev.title || ''))) {
        return [circle(12, 12, 9.2, line(MOON, 0.9, { opacity: 0.45, 'stroke-dasharray': '1.4 1.8' })), circle(12, 12, 5.4, fill(MOON))];
    }
    const out = [circle(12, 12, 9.4, fill(MOON))];
    if (ev.supermoon) out.push(circle(12, 12, 11.2, line(MOON, 0.9, { opacity: 0.45 })));
    else out.push(circle(12, 12, 5.4, line(BG, 0.9, { opacity: 0.45, 'stroke-dasharray': '1.4 1.8' })));
    return out;
}

function ringPlane() {
    const c = body('saturn');
    return [circle(12, 12, 5.4, fill(c)), path('M2.2 12.4h19.6', line(BG, 2.6, { opacity: 0.8 })), path('M2.2 12.4h19.6', line(c, 1.2))];
}

function meteors() {
    const c = 'var(--ev-meteor)';
    // Three streaks from the radiant (upper left), each with a bright head.
    const streaks = [[25, 15.2], [52, 16.4], [79, 13.6]];
    const out = [circle(5, 5, 1.5, line(c, 1, { opacity: 0.7 }))];
    for (const [deg, len] of streaks) {
        const a = deg * Math.PI / 180, c0 = Math.cos(a), s0 = Math.sin(a);
        const x0 = 5 + 4 * c0, y0 = 5 + 4 * s0, x1 = 5 + len * c0, y1 = 5 + len * s0;
        out.push(path(`M${r2(x0)} ${r2(y0)}L${r2(x1)} ${r2(y1)}`, line(c, 1.3, { opacity: 0.55 })));
        out.push(circle(x1, y1, 1.25, fill(c)));
    }
    return out;
}

function season(ev, south) {
    const t = String(ev.title || '');
    const june = /^June/.test(t), dec = /^December/.test(t);
    // The Sun's day arc in this hemisphere: high and long in summer, low and short in winter.
    let apex = 8.6, x0 = 4.2;
    if (june || dec) {
        const summer = june !== south;
        apex = summer ? 4.4 : 12.4;
        x0 = summer ? 2.4 : 6.4;
    }
    const cy = 2 * apex - 17.4;   // a quadratic's apex is half-way to its control point
    return [
        path('M1.6 17.4h20.8', line(MUTED, 1.2)),
        path(`M${r2(x0)} 17.4Q12 ${r2(cy)} ${r2(24 - x0)} 17.4`, line(SUN, 1.1, { opacity: 0.6, 'stroke-dasharray': ev.kind === 'equinox' ? '1.4 1.6' : null })),
        circle(12, apex, 2.6, fill(SUN)),
    ];
}

function brilliancy(ev) {
    const detail = String(ev.detail || '');
    const m = /(\d+)%-lit/.exec(detail);
    const k = m ? Number(m[1]) / 100 : 0.27;
    const right = !/morning/.test(detail);
    const c = body('venus');
    const cx = right ? 10.4 : 13.6;
    const rx = right ? 19.2 : 4.8, dx = right ? 2.4 : -2.4;
    return [
        circle(cx, 12, 7.4, fill(c, { opacity: 0.14 })),
        path(phasePath(cx, 12, 7.4, k, right), fill(c)),
        path(`M${r2(rx)} 6.2l${r2(dx)} -1.6M${r2(rx + dx * 0.4)} 12h${r2(dx)}M${r2(rx)} 17.8l${r2(dx)} 1.6`, line(c, 1.1, { opacity: 0.7 })),
    ];
}

function satPass(ev) {
    const c = /^#[\da-f]{6}$/i.test(ev.color || '') ? ev.color : 'var(--accent)';
    return [path('M3 19.4Q12 2.6 21 19.4', line(c, 1.1, { opacity: 0.5, 'stroke-dasharray': '1.4 1.8' })), circle(15.2, 8.6, 2.2, fill(c))];
}

/**
 * The glyph of an event as a list of [tag, attrs] (pure; colours are CSS `var(...)` values).
 * @param {any} ev AstroEvent (or a satellite pass event, kind 'sat-pass')
 * @param {{south?: boolean}} [opts] `south`: the observer is in the southern hemisphere
 * @returns {Array<[string, Record<string, string|number|null>]>}
 */
export function glyphSpec(ev, { south = false } = {}) {
    switch (ev?.kind) {
        case 'moon-phase': return moonPhase(ev, south);
        case 'opposition': return opposition(ev);
        case 'conjunction': return conjunction(ev);
        case 'max-elongation': return elongation(ev);
        case 'solar-eclipse': case 'local-solar-eclipse': return solarEclipse(ev);
        case 'lunar-eclipse': return lunarEclipse(ev);
        case 'transit': return transit(ev);
        case 'occultation': return occultation(ev);
        case 'lunar-apsis': return apsis(ev);
        case 'ring-plane': return ringPlane();
        case 'meteor-shower': return meteors();
        case 'equinox': case 'solstice': return season(ev, south);
        case 'brilliancy': return brilliancy(ev);
        case 'sat-pass': return satPass(ev);
        default: return [circle(12, 12, 4, fill('currentColor'))];
    }
}

/**
 * The event's glyph as an inline, decorative SVG.
 * @param {any} ev
 * @param {{size?: number, south?: boolean}} [opts]
 * @returns {SVGSVGElement}
 */
export function eventGlyph(ev, { size = 26, south = false } = {}) {
    const ns = svgNS();
    const svg = /** @type {SVGSVGElement} */ (document.createElementNS(ns, 'svg'));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('class', `evg evg--${ev?.kind || 'dot'}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tag, attrs] of glyphSpec(ev, { south })) {
        const el = document.createElementNS(ns, tag);
        let style = '';
        for (const k in attrs) {
            const v = attrs[k];
            if (v == null) continue;
            if ((k === 'fill' || k === 'stroke') && String(v).startsWith('var(')) style += `${k}:${v};`;
            else el.setAttribute(k, String(v));
        }
        if (style) el.setAttribute('style', style);
        svg.appendChild(el);
    }
    return svg;
}
