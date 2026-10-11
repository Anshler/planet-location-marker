#!/usr/bin/env node
// Builds the app icons from ONE geometry description, so the SVG and the PNGs match:
//
//   assets/icons/favicon.svg            rounded tile, the mark at full size
//   assets/icons/icon-192.png           full-bleed square (also the apple-touch-icon,
//   assets/icons/icon-512.png             so iOS gets no transparent corners)
//   assets/icons/icon-maskable-512.png  full-bleed, mark shrunk into the 80 % safe zone
//
//   node scripts/build-icons.mjs [--samples=6]
//
// The mark: a small Earth (lit from the upper right, faint graticule, thin atmosphere rim),
// an observer pin on its limb and a glowing beam to a warm planet — the app in one glyph.
// The rasteriser is zero-dependency: it supersamples each pixel (N×N), evaluates the same
// primitives the SVG uses (rounded rect, disc, ring, round-capped line, rotated ellipse
// stroke with circular clip; solid/linear/radial paints) and composites source-over in
// sRGB like browsers do.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');
const GRID = 512;   // design units

// ---------------------------------------------------------------- design ---------------

const BG_INNER = '#0f1f45';
const BG_OUTER = '#03060d';
const EARTH = { cx: 186, cy: 326, r: 140 };
const PLANET = { cx: 410, cy: 102, r: 32 };
const DIR = norm([PLANET.cx - EARTH.cx, PLANET.cy - EARTH.cy]);
const PIN = { cx: EARTH.cx + DIR[0] * EARTH.r, cy: EARTH.cy + DIR[1] * EARTH.r };

function norm([x, y]) {
    const l = Math.hypot(x, y);
    return [x / l, y / l];
}

const linear = (x1, y1, x2, y2, stops) => ({ type: 'linear', x1, y1, x2, y2, stops });
const radial = (cx, cy, r, stops) => ({ type: 'radial', cx, cy, r, stops });

/**
 * Background + mark. `tile` = rounded tile (favicon) or full-bleed square (PNG icons).
 * Shapes are listed back to front.
 */
function design({ tile }) {
    const bg = { kind: 'rect', x: 0, y: 0, w: GRID, h: GRID, rx: tile ? 112 : 0,
        fill: radial(300, 190, 430, [[0, BG_INNER, 1], [0.55, '#081230', 1], [1, BG_OUTER, 1]]) };
    const stars = [[92, 84, 4.5, 0.85], [168, 46, 3, 0.6], [262, 120, 3.5, 0.7], [470, 236, 4, 0.75],
        [430, 404, 3, 0.55], [334, 470, 3.5, 0.6], [56, 180, 3, 0.5], [214, 160, 2.5, 0.45]]
        .map(([cx, cy, r, a]) => ({ kind: 'circle', cx, cy, r, fill: { color: '#ffffff', opacity: a } }));
    const e = EARTH;
    const mark = [
        // soft atmospheric halo behind the globe
        { kind: 'circle', cx: e.cx, cy: e.cy, r: e.r + 34,
            fill: radial(e.cx, e.cy, e.r + 34, [[e.r / (e.r + 34), '#3d8bff', 0.5], [1, '#3d8bff', 0]]) },
        // the globe, lit from the planet's side
        { kind: 'circle', cx: e.cx, cy: e.cy, r: e.r,
            fill: radial(e.cx + 62, e.cy - 70, 236, [[0, '#7fd0ff', 1], [0.3, '#2f86ee', 1], [0.68, '#123d9c', 1], [1, '#06173f', 1]]) },
        // graticule: equator + one meridian, tilted, clipped to the globe
        { kind: 'ellipse', cx: e.cx, cy: e.cy, rx: e.r, ry: e.r * 0.34, rotate: -24, width: 5,
            stroke: { color: '#bfe6ff', opacity: 0.32 }, clip: e },
        { kind: 'ellipse', cx: e.cx, cy: e.cy, rx: e.r * 0.44, ry: e.r, rotate: -24, width: 5,
            stroke: { color: '#bfe6ff', opacity: 0.26 }, clip: e },
        // thin bright rim on the lit limb
        { kind: 'ring', cx: e.cx, cy: e.cy, r: e.r - 3, width: 7,
            stroke: linear(e.cx + DIR[0] * e.r, e.cy + DIR[1] * e.r, e.cx - DIR[0] * e.r * 0.2, e.cy - DIR[1] * e.r * 0.2,
                [[0, '#d9f1ff', 0.95], [1, '#d9f1ff', 0]]) },
        // the beam: stacked translucent strokes approximate a Gaussian glow around a thin hot
        // core; blue at the observer turning warm toward the planet
        ...[[66, 0.07], [46, 0.11], [30, 0.2], [18, 0.38]].map(([width, a]) => ({
            kind: 'line', x1: PIN.cx, y1: PIN.cy, x2: PLANET.cx, y2: PLANET.cy, width,
            stroke: linear(PIN.cx, PIN.cy, PLANET.cx, PLANET.cy, [[0, '#7cc4ff', a], [1, '#ff8a4d', a]]),
        })),
        { kind: 'line', x1: PIN.cx, y1: PIN.cy, x2: PLANET.cx, y2: PLANET.cy, width: 9,
            stroke: linear(PIN.cx, PIN.cy, PLANET.cx, PLANET.cy, [[0, '#ffffff', 1], [1, '#ffe0c2', 1]]) },
        // observer pin
        { kind: 'circle', cx: PIN.cx, cy: PIN.cy, r: 40,
            fill: radial(PIN.cx, PIN.cy, 40, [[0, '#ffffff', 0.75], [1, '#ffffff', 0]]) },
        { kind: 'circle', cx: PIN.cx, cy: PIN.cy, r: 14, fill: '#ffffff' },
        // planet
        { kind: 'circle', cx: PLANET.cx, cy: PLANET.cy, r: 84,
            fill: radial(PLANET.cx, PLANET.cy, 84, [[0, '#ff7a3d', 0.55], [1, '#ff7a3d', 0]]) },
        { kind: 'circle', cx: PLANET.cx, cy: PLANET.cy, r: PLANET.r,
            fill: radial(PLANET.cx - 10, PLANET.cy - 11, 44, [[0, '#ffe2c2', 1], [0.45, '#ff8a4d', 1], [1, '#c9441f', 1]]) },
    ];
    return { bg, stars, mark };
}

/** Scales/translates shapes about the centre (for the maskable safe zone). */
function transformShapes(shapes, s) {
    const c = GRID / 2;
    const p = (v) => c + (v - c) * s;
    const paint = (pt) => {
        if (!pt || typeof pt === 'string' || !pt.type) return pt;
        return pt.type === 'linear'
            ? { ...pt, x1: p(pt.x1), y1: p(pt.y1), x2: p(pt.x2), y2: p(pt.y2) }
            : { ...pt, cx: p(pt.cx), cy: p(pt.cy), r: pt.r * s };
    };
    return shapes.map((sh) => {
        const o = { ...sh, fill: paint(sh.fill), stroke: paint(sh.stroke) };
        for (const k of ['cx', 'x1', 'x2']) if (k in sh) o[k] = p(sh[k]);
        for (const k of ['cy', 'y1', 'y2']) if (k in sh) o[k] = p(sh[k]);
        for (const k of ['r', 'rx', 'ry', 'width']) if (k in sh && sh.kind !== 'rect') o[k] = sh[k] * s;
        if (sh.clip) o.clip = { cx: p(sh.clip.cx), cy: p(sh.clip.cy), r: sh.clip.r * s };
        return o;
    });
}

/** Shape list for one output. */
export function iconShapes({ tile = false, markScale = 1, starScale = markScale } = {}) {
    const d = design({ tile });
    return [d.bg, ...transformShapes(d.stars, starScale), ...transformShapes(d.mark, markScale)];
}

// ---------------------------------------------------------------- SVG ------------------

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/**
 * Serialises shapes as a standalone SVG (viewBox 0 0 512 512).
 * @param {object[]} shapes
 * @param {{title?:string}} [opts]
 * @returns {string}
 */
export function toSvg(shapes, { title = 'Planet Location Marker' } = {}) {
    const defs = [];
    let gid = 0;
    const paintRef = (pt) => {
        if (typeof pt === 'string') return { attr: pt, op: 1 };
        if (!pt.type) return { attr: pt.color, op: pt.opacity ?? 1 };
        const id = `g${gid++}`;
        const stops = pt.stops.map(([o, c, a]) => `<stop offset="${fmt(o)}" stop-color="${c}"${a === 1 ? '' : ` stop-opacity="${fmt(a)}"`}/>`).join('');
        defs.push(pt.type === 'linear'
            ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(pt.x1)}" y1="${fmt(pt.y1)}" x2="${fmt(pt.x2)}" y2="${fmt(pt.y2)}">${stops}</linearGradient>`
            : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(pt.cx)}" cy="${fmt(pt.cy)}" r="${fmt(pt.r)}">${stops}</radialGradient>`);
        return { attr: `url(#${id})`, op: 1 };
    };
    const clipIds = new Map();
    const clipRef = (c) => {
        const key = `${c.cx},${c.cy},${c.r}`;
        if (!clipIds.has(key)) {
            const id = `c${clipIds.size}`;
            clipIds.set(key, id);
            defs.push(`<clipPath id="${id}"><circle cx="${fmt(c.cx)}" cy="${fmt(c.cy)}" r="${fmt(c.r)}"/></clipPath>`);
        }
        return clipIds.get(key);
    };
    const body = shapes.map((s) => {
        const f = s.fill ? paintRef(s.fill) : null;
        const st = s.stroke ? paintRef(s.stroke) : null;
        const fill = f ? ` fill="${f.attr}"${f.op === 1 ? '' : ` fill-opacity="${fmt(f.op)}"`}` : ' fill="none"';
        const stroke = st ? ` stroke="${st.attr}" stroke-width="${fmt(s.width)}"${st.op === 1 ? '' : ` stroke-opacity="${fmt(st.op)}"`}` : '';
        switch (s.kind) {
            case 'rect':
                return `<rect width="${fmt(s.w)}" height="${fmt(s.h)}"${s.rx ? ` rx="${fmt(s.rx)}"` : ''}${fill}/>`;
            case 'circle':
                return `<circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.r)}"${fill}/>`;
            case 'ring':
                return `<circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.r)}" fill="none"${stroke}/>`;
            case 'line':
                return `<line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"${stroke} stroke-linecap="round"/>`;
            case 'ellipse':
                return `<ellipse cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" rx="${fmt(s.rx)}" ry="${fmt(s.ry)}"`
                    + `${s.rotate ? ` transform="rotate(${fmt(s.rotate)} ${fmt(s.cx)} ${fmt(s.cy)})"` : ''} fill="none"${stroke}`
                    + `${s.clip ? ` clip-path="url(#${clipRef(s.clip)})"` : ''}/>`;
            default:
                throw new Error(`unknown shape ${s.kind}`);
        }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" role="img" aria-label="${title}">`
        + `<title>${title}</title><defs>${defs.join('')}</defs>${body.join('')}</svg>\n`;
}

// ---------------------------------------------------------------- raster ---------------

function hexRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Compiles a paint into fn(x, y, out4) → premultiplied-free RGBA (0..255, alpha 0..1). */
function compilePaint(pt) {
    if (typeof pt === 'string' || !pt.type) {
        const [r, g, b] = hexRgb(typeof pt === 'string' ? pt : pt.color);
        const a = typeof pt === 'string' ? 1 : pt.opacity ?? 1;
        return (x, y, o) => { o[0] = r; o[1] = g; o[2] = b; o[3] = a; };
    }
    const stops = pt.stops.map(([off, c, a]) => [off, ...hexRgb(c), a]);
    const at = (t, o) => {
        if (t <= stops[0][0]) { [, o[0], o[1], o[2], o[3]] = stops[0]; return; }
        const last = stops.at(-1);
        if (t >= last[0]) { [, o[0], o[1], o[2], o[3]] = last; return; }
        let i = 1;
        while (stops[i][0] < t) i++;
        const s0 = stops[i - 1], s1 = stops[i];
        const u = (t - s0[0]) / (s1[0] - s0[0] || 1);
        // Interpolate premultiplied (what browsers do), then un-premultiply.
        const a = s0[4] + (s1[4] - s0[4]) * u;
        for (let k = 0; k < 3; k++) {
            const pm = s0[k + 1] * s0[4] + (s1[k + 1] * s1[4] - s0[k + 1] * s0[4]) * u;
            o[k] = a > 0 ? pm / a : s0[k + 1] + (s1[k + 1] - s0[k + 1]) * u;
        }
        o[3] = a;
    };
    if (pt.type === 'linear') {
        const dx = pt.x2 - pt.x1, dy = pt.y2 - pt.y1, l2 = dx * dx + dy * dy || 1;
        return (x, y, o) => at(((x - pt.x1) * dx + (y - pt.y1) * dy) / l2, o);
    }
    return (x, y, o) => at(Math.hypot(x - pt.cx, y - pt.cy) / pt.r, o);
}

/** Distance from (px,py) to an axis-aligned ellipse (a,b) centred at the origin (Newton on θ). */
function ellipseDistance(px, py, a, b) {
    const x = Math.abs(px), y = Math.abs(py);
    let t = Math.atan2(a * y, b * x);
    for (let i = 0; i < 6; i++) {
        const ct = Math.cos(t), st = Math.sin(t);
        const ex = a * ct, ey = b * st;
        const fx = ex - x, fy = ey - y;
        const g = -a * st * fx + b * ct * fy;          // d/dθ ½|e−p|²
        const h = a * a * st * st + b * b * ct * ct - a * ct * fx - b * st * fy;
        if (Math.abs(h) < 1e-12) break;
        t = Math.min(Math.PI / 2, Math.max(0, t - g / h));
    }
    return Math.hypot(a * Math.cos(t) - x, b * Math.sin(t) - y);
}

/** Compiles a shape into {inside(x,y) → boolean, paint(x,y,o)} in design units. */
function compileShape(s) {
    const paint = compilePaint(s.fill ?? s.stroke);
    const hw = (s.width ?? 0) / 2;
    let inside;
    switch (s.kind) {
        case 'rect': {
            const r = s.rx ?? 0;
            inside = (x, y) => {
                if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false;
                if (!r) return true;
                const qx = Math.max(s.x + r - x, 0, x - (s.x + s.w - r));
                const qy = Math.max(s.y + r - y, 0, y - (s.y + s.h - r));
                return qx * qx + qy * qy <= r * r;
            };
            break;
        }
        case 'circle':
            inside = (x, y) => (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
            break;
        case 'ring':
            inside = (x, y) => Math.abs(Math.hypot(x - s.cx, y - s.cy) - s.r) <= hw;
            break;
        case 'line': {
            const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy;
            inside = (x, y) => {
                const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / l2));
                return (x - s.x1 - t * dx) ** 2 + (y - s.y1 - t * dy) ** 2 <= hw * hw;
            };
            break;
        }
        case 'ellipse': {
            const th = -(s.rotate ?? 0) * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
            const clip = s.clip;
            inside = (x, y) => {
                if (clip && (x - clip.cx) ** 2 + (y - clip.cy) ** 2 > clip.r * clip.r) return false;
                const dx = x - s.cx, dy = y - s.cy;
                return ellipseDistance(dx * c - dy * sn, dx * sn + dy * c, s.rx, s.ry) <= hw;
            };
            break;
        }
        default:
            throw new Error(`unknown shape ${s.kind}`);
    }
    return { inside, paint };
}

/**
 * Rasterises shapes to straight-alpha RGBA.
 * @param {object[]} shapes design-unit shapes (512 grid)
 * @param {number} size output pixels
 * @param {number} [samples=6] supersamples per axis
 * @returns {Uint8Array} size×size×4
 */
export function rasterize(shapes, size, samples = 6) {
    const compiled = shapes.map(compileShape);
    const out = new Uint8Array(size * size * 4);
    const scale = GRID / size;
    const col = new Float64Array(4);
    const n = samples * samples;
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let R = 0, G = 0, B = 0, A = 0;   // premultiplied accumulators over samples
            for (let sy = 0; sy < samples; sy++) {
                for (let sx = 0; sx < samples; sx++) {
                    const x = (px + (sx + 0.5) / samples) * scale;
                    const y = (py + (sy + 0.5) / samples) * scale;
                    let r = 0, g = 0, b = 0, a = 0;   // premultiplied, source-over in sRGB
                    for (const sh of compiled) {
                        if (!sh.inside(x, y)) continue;
                        sh.paint(x, y, col);
                        const sa = col[3];
                        r = col[0] * sa + r * (1 - sa);
                        g = col[1] * sa + g * (1 - sa);
                        b = col[2] * sa + b * (1 - sa);
                        a = sa + a * (1 - sa);
                    }
                    R += r; G += g; B += b; A += a;
                }
            }
            const o = (py * size + px) * 4;
            const alpha = A / n;
            out[o + 3] = Math.round(alpha * 255);
            if (alpha > 0) {
                out[o] = Math.round(Math.min(255, R / n / alpha));
                out[o + 1] = Math.round(Math.min(255, G / n / alpha));
                out[o + 2] = Math.round(Math.min(255, B / n / alpha));
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------- outputs --------------

/** Every icon this script writes. */
export const OUTPUTS = [
    { file: 'favicon.svg', svg: true, opts: { tile: true } },
    { file: 'icon-192.png', size: 192, opts: { markScale: 0.9, starScale: 1 } },
    { file: 'icon-512.png', size: 512, opts: { markScale: 0.9, starScale: 1 } },
    { file: 'icon-maskable-512.png', size: 512, opts: { markScale: 0.68, starScale: 1 } },
];

function main() {
    const arg = process.argv.find((a) => a.startsWith('--samples='));
    const samples = arg ? Math.max(1, Number(arg.split('=')[1]) || 6) : 6;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const o of OUTPUTS) {
        const shapes = iconShapes(o.opts);
        const file = path.join(OUT_DIR, o.file);
        if (o.svg) {
            fs.writeFileSync(file, toSvg(shapes));
        } else {
            fs.writeFileSync(file, encodePng(o.size, o.size, rasterize(shapes, o.size, samples), { channels: 4 }));
        }
        console.log(`${path.relative(ROOT, file).replaceAll('\\', '/')}: ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
