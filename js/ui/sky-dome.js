/**
 * Sky dome (ROADMAP sky-dome-chart): an all-sky chart, a collapsible card at the top of Sky now
 * and the hero of text mode. Azimuthal-equidistant about the zenith (r = (90° − alt) / 90° · R) on
 * one DPR-sized 2D canvas: the dome tinted by the Sun's altitude (ui/sky-palette.js, brighter
 * toward the Sun in twilight), altitude rings at 30° and 60°, the horizon ring with 16 ticks and
 * N/E/S/W, the stars to mag 3.5 and faint constellation figures, the ecliptic, the bodies as
 * colour-token dots sized by magnitude, the Moon at its phase with its lit limb toward the Sun,
 * the Sun with a glow, and labels placed greedily so that none overlap. 'Looking up' has east on
 * the left (the sky overhead, north at the top, as star charts have it); 'Map' has it on the right
 * (the ground plan, like the rows' compasses). A tap selects the body or named star under it. In
 * Sky view the camera's field of view (the read-only actions.getView()) is drawn as a wedge.
 *
 * The stars come from `services.catalog()`, late-bound: the UI mounts before the 3D boot has
 * decoded data/sky.json, and text mode fetches it only when this card first opens (the 3D tiers
 * have it anyway, so no embedded star list costs every tier its bytes).
 *
 * Redrawn on change, never per frame: the chart (stars and lines reprojected into preallocated
 * Float32Arrays, only when the time, the observer or the orientation changed) goes into an offscreen
 * canvas from the 4 Hz readout at most once a second, and at once for a new selection, size,
 * orientation or catalogue; the wedge is composited over it when the view moves (polled at 4 Hz,
 * in Sky view only). Its open state and orientation are a preference (`skyDome`).
 *
 *   mountSkyDome(ctx) → {el, update(snap), destroy()}
 *
 * @module ui/sky-dome
 */

import { BODY_INDEX, hostBodies } from '../astro/bodies.js';
import { load as loadPref, save as savePref } from '../core/prefs.js';
import { h, on, setText, setAttr, segmented, uid } from './dom.js';
import { icon } from './icons.js';
import { SKY_LUT, skyLutIndex, C_NIGHT } from './sky-palette.js';

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;
const TAU = 2 * Math.PI;
/** Stars drawn to this magnitude; named stars to HIT_MAG can be tapped. */
export const STAR_MAG = 3.5;
const HIT_MAG = 2.5;
const MARGIN = 15;                  // CSS px outside the rim, for N/E/S/W
const REBUILD_MS = 1000;
const VIEW_POLL_MS = 250;
const OBLIQUITY = 23.4392911 * DEG;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DASH = [3, 3];
const NO_DASH = [];
const CARDINAL = ['N', 'E', 'S', 'W'];
const HINT = {
    up: 'North at the top, east on the left: the sky overhead, as if you held it above you.',
    map: 'North at the top, east on the right, like a map of the ground.',
};
const P = new Float64Array(2);      // projection scratch

/**
 * A direction in the observer's east-north-up frame → the chart's unit disc (azimuthal
 * equidistant about the zenith: r is the zenith distance over 90°, so the horizon is r = 1 and the
 * nadir r = 2). North is up (−y); `flip` +1 puts east on the right (map), −1 on the left (looking up).
 * @param {number} e
 * @param {number} n
 * @param {number} u
 * @param {number} flip
 * @param {{0:number, 1:number}} out
 * @returns {number} r
 */
export function enuToChart(e, n, u, flip, out) {
    const r = Math.acos(u > 1 ? 1 : u < -1 ? -1 : u) / HALF_PI;
    const hz = Math.sqrt(e * e + n * n);
    if (hz > 1e-12) { out[0] = (flip * r * e) / hz; out[1] = (-r * n) / hz; } else { out[0] = 0; out[1] = 0; }
    return r;
}

/** A scene-frame direction (any length) for the observer `o` → the unit disc; returns r. */
function projectScene(x, y, z, o, flip, out) {
    const U = o.upS, N = o.northS, E = o.eastS;
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    return enuToChart(x * E[0] + y * E[1] + z * E[2], x * N[0] + y * N[1] + z * N[2], (x * U[0] + y * U[1] + z * U[2]) / len, flip, out);
}

/**
 * Projects `count` scene-frame unit vectors (xyz triples of `src`) for the observer `o` (its upS,
 * northS and eastS) into `out` (x, y pairs on the unit disc); one below the horizon gets NaN.
 * Allocation-free.
 * @param {ArrayLike<number>} src
 * @param {number} count
 * @param {{upS:ArrayLike<number>, northS:ArrayLike<number>, eastS:ArrayLike<number>}} o
 * @param {number} flip
 * @param {Float32Array} out
 * @returns {number} how many are above the horizon
 */
export function projectDirs(src, count, o, flip, out) {
    const U = o.upS;
    let up = 0;
    for (let i = 0; i < count; i++) {
        const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
        if (x * U[0] + y * U[1] + z * U[2] < 0) { out[2 * i] = NaN; out[2 * i + 1] = NaN; continue; }
        projectScene(x, y, z, o, flip, P);
        out[2 * i] = P[0]; out[2 * i + 1] = P[1];
        up++;
    }
    return up;
}

/**
 * Projects `nSeg` chords (two scene-frame unit vectors each, 6 floats, as catalog `cons.segments`)
 * into `out` (x1, y1, x2, y2 on the unit disc). A chord wholly below the horizon gets NaN; one
 * crossing it is cut where its chord meets the horizon plane, so it ends on the ring. Allocation-free.
 * @param {ArrayLike<number>} src
 * @param {number} nSeg
 * @param {any} o observer vectors
 * @param {number} flip
 * @param {Float32Array} out
 */
export function projectSegments(src, nSeg, o, flip, out) {
    const U = o.upS;
    for (let i = 0; i < nSeg; i++) {
        const s = 6 * i, d = 4 * i;
        let ax = src[s], ay = src[s + 1], az = src[s + 2], bx = src[s + 3], by = src[s + 4], bz = src[s + 5];
        const ua = ax * U[0] + ay * U[1] + az * U[2], ub = bx * U[0] + by * U[1] + bz * U[2];
        if (ua < 0 && ub < 0) { out[d] = NaN; continue; }
        if (ua < 0 || ub < 0) {
            const t = ua / (ua - ub);
            const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t, cz = az + (bz - az) * t;
            if (ua < 0) { ax = cx; ay = cy; az = cz; } else { bx = cx; by = cy; bz = cz; }
        }
        projectScene(ax, ay, az, o, flip, P);
        out[d] = P[0]; out[d + 1] = P[1];
        projectScene(bx, by, bz, o, flip, P);
        out[d + 2] = P[0]; out[d + 3] = P[1];
    }
}

/**
 * The J2000 ecliptic as `n` chords in the scene frame (6 floats each; EQJ (cos λ, sin λ cos ε,
 * sin λ sin ε) through S: (x, y, z) → (x, z, −y)).
 * @param {number} [n]
 * @returns {Float32Array}
 */
export function eclipticSegments(n = 72) {
    const out = new Float32Array(6 * n);
    const se = Math.sin(OBLIQUITY), ce = Math.cos(OBLIQUITY);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 2; k++) {
            const l = ((i + k) / n) * TAU, o = 6 * i + 3 * k;
            out[o] = Math.cos(l); out[o + 1] = Math.sin(l) * se; out[o + 2] = -Math.sin(l) * ce;
        }
    }
    return out;
}

/**
 * The chart direction from the Moon toward the Sun along the sky (where its lit limb faces), in
 * canvas radians (0 = +x, +y down), measured by projecting a point a milliradian along the great
 * circle through both, so the projection's stretch and the orientation are included. NaN when the
 * two directions coincide or are opposite.
 * @param {ArrayLike<number>} m the Moon's scene direction
 * @param {ArrayLike<number>} s the Sun's
 * @param {any} o observer vectors
 * @param {number} flip
 * @returns {number}
 */
export function limbAngle(m, s, o, flip) {
    const k = m[0] * s[0] + m[1] * s[1] + m[2] * s[2];
    const vx = s[0] - k * m[0], vy = s[1] - k * m[1], vz = s[2] - k * m[2];
    const vn = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (!(vn > 1e-9)) return NaN;
    const e = 1e-3 / vn;
    projectScene(m[0], m[1], m[2], o, flip, P);
    const x0 = P[0], y0 = P[1];
    projectScene(m[0] + e * vx, m[1] + e * vy, m[2] + e * vz, o, flip, P);
    return Math.atan2(P[1] - y0, P[0] - x0);
}

/**
 * The outline of a sky-view camera's field on the chart: the edges of its image rectangle
 * (vertical field `fovDeg`, `aspect` = width / height, a level camera aimed at `azDeg`, `altDeg`),
 * `steps` points per edge, written as x, y pairs on the unit disc (r > 1 below the horizon).
 * @param {{azDeg:number, altDeg:number, fovDeg:number, aspect?:number}} v
 * @param {number} flip
 * @param {Float32Array} out at least 8·steps floats
 * @param {number} [steps]
 * @returns {number} the number of points
 */
export function fovOutline(v, flip, out, steps = 8) {
    const sa = Math.sin(v.azDeg * DEG), ca = Math.cos(v.azDeg * DEG), sl = Math.sin(v.altDeg * DEG), cl = Math.cos(v.altDeg * DEG);
    const tv = Math.tan(Math.min(170, Math.max(0.05, v.fovDeg)) * DEG / 2), th = tv * (v.aspect > 0 ? v.aspect : 1);
    let k = 0;
    for (let edge = 0; edge < 4; edge++) {
        for (let i = 0; i < steps; i++) {
            const t = -1 + (2 * i) / steps;
            const sx = edge === 0 ? t : edge === 1 ? 1 : edge === 2 ? -t : -1;
            const sy = edge === 0 ? 1 : edge === 1 ? -t : edge === 2 ? -1 : t;
            // forward (cl·sa, cl·ca, sl), right (ca, −sa, 0), up (−sl·sa, −sl·ca, cl) in ENU
            const e = cl * sa + sx * th * ca - sy * tv * sl * sa;
            const n = cl * ca - sx * th * sa - sy * tv * sl * ca;
            const u = sl + sy * tv * cl;
            const len = Math.sqrt(e * e + n * n + u * u);
            enuToChart(e / len, n / len, u / len, flip, P);
            out[k++] = P[0]; out[k++] = P[1];
        }
    }
    return k / 2;
}

/** A body's dot radius (CSS px) by magnitude: Venus ≈ 4.8, Saturn ≈ 3.2, Uranus 2.2. */
export const bodyRadius = (mag) => (Number.isFinite(mag) ? Math.min(5, Math.max(2.2, 3.4 - 0.32 * mag)) : 2.6);
/** A star's dot radius (CSS px) by magnitude: Sirius ≈ 2.5, mag 2 ≈ 1.1, mag 3.5 ≈ 0.55. */
export const starRadius = (mag) => Math.min(2.6, Math.max(0.55, 1.9 - 0.42 * mag));

/**
 * @typedef {{id:string, name:string, x:number, y:number, r:number, w:number, h:number, star:boolean,
 *   lx:number, ly:number, ok:boolean}} DomeItem
 *   a dot (x, y, radius r) and its label box (w × h; w = 0 wants none), placed at (lx, ly) when ok
 */

const overlaps = (ax, ay, aw, ah, bx, by, bw, bh) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

/**
 * Greedy label placement: each item, in priority order, takes the first of four spots around its
 * dot (right, left, above, below) that stays inside the W × H box and overlaps neither a label
 * placed before it nor any other item's dot; an item with no free spot goes unlabelled (`ok` false).
 * @param {DomeItem[]} items
 * @param {number} n items in use
 * @param {number} W
 * @param {number} H
 * @returns {number} labels placed
 */
export function placeLabels(items, n, W, H) {
    let placed = 0;
    for (let i = 0; i < n; i++) {
        const a = items[i];
        a.ok = false;
        if (!(a.w > 0)) continue;
        for (let c = 0; c < 4 && !a.ok; c++) {
            const lx = c === 0 ? a.x + a.r + 3 : c === 1 ? a.x - a.r - 3 - a.w : a.x - a.w / 2;
            const ly = c < 2 ? a.y - a.h / 2 : c === 2 ? a.y - a.r - 1 - a.h : a.y + a.r + 1;
            if (lx < 1 || ly < 1 || lx + a.w > W - 1 || ly + a.h > H - 1) continue;
            let hit = false;
            for (let j = 0; j < n && !hit; j++) {
                if (j === i) continue;
                const b = items[j];
                hit = overlaps(lx, ly, a.w, a.h, b.x - b.r - 1, b.y - b.r - 1, 2 * b.r + 2, 2 * b.r + 2)
                    || (j < i && b.ok && overlaps(lx, ly, a.w, a.h, b.lx, b.ly, b.w, b.h));
            }
            if (!hit) { a.lx = lx; a.ly = ly; a.ok = true; placed++; }
        }
    }
    return placed;
}

/**
 * The item under a tap: the nearest body whose dot is within `slop` px, else the nearest star
 * (items without an id are obstacles only).
 * @param {DomeItem[]} items
 * @param {number} n
 * @param {number} x
 * @param {number} y
 * @param {number} slop
 * @returns {number} index or −1
 */
export function nearestHit(items, n, x, y, slop) {
    let best = -1, score = Infinity;
    for (let i = 0; i < n; i++) {
        const a = items[i];
        if (!a.id) continue;
        const d = Math.hypot(a.x - x, a.y - y);
        if (d > a.r + slop) continue;
        const s = d + (a.star ? 1000 : 0);
        if (s < score) { score = s; best = i; }
    }
    return best;
}

const rgbStr = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lutRgb = (alt) => { const i = skyLutIndex(alt); return [SKY_LUT[i], SKY_LUT[i + 1], SKY_LUT[i + 2]]; };
const ECLIPTIC = eclipticSegments(72);

/**
 * Mounts the Sky dome card. The caller places `el` and forwards its 4 Hz `update(snap)`.
 * @param {any} ctx UiCtx
 * @returns {{el: HTMLElement, update(snap:any): void, destroy(): void}}
 */
export function mountSkyDome(ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const pref = loadPref('skyDome', { open: true, mode: 'up' });
    let open = pref.open !== false;
    let mode = pref.mode === 'map' ? 'map' : 'up';
    const save = () => savePref('skyDome', { open, mode });

    const bodyId = uid('dome');
    const meta = h('span', { class: 'dome__meta' });
    const head = h('button', { class: 'dome__head', type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId },
        h('span', { class: 'dome__title' }, 'Sky dome'), meta,
        h('span', { class: 'dome__chev', 'aria-hidden': 'true' }, icon('chevron-down', { size: 16 })));
    const cv = h('canvas', { class: 'dome__cv', role: 'img', 'aria-label': 'All-sky chart' });
    const wrap = h('div', { class: 'dome__wrap' }, cv);
    const hint = h('p', { class: 'dome__hint' });
    const seg = segmented({
        label: 'Chart orientation', className: 'dome__seg', value: mode,
        options: [{ value: 'up', label: 'Looking up' }, { value: 'map', label: 'Map' }],
        onChange: (v) => { mode = v === 'map' ? 'map' : 'up'; save(); setHint(); rebuildNow(); },
    });
    const body = h('div', { class: 'dome__body', id: bodyId, hidden: !open }, wrap, h('div', { class: 'dome__foot' }, seg.el, hint));
    const el = h('section', { class: 'dome', 'aria-label': 'Sky dome' }, head, body);
    el.classList.toggle('is-open', open);
    const setHint = () => setText(hint, `${HINT[mode]} Tap a dot to select it.`);
    setHint();

    const c = cv.getContext('2d');
    const base = document.createElement('canvas');
    const bc = base.getContext('2d');
    let W = 0, dpr = 1;

    // Catalogue (late-bound), reprojection buffers and the items (dots, labels, tap targets).
    let cat = null, asked = false;
    let nStars = 0, starXY = new Float32Array(0), starStyle = [];
    let nSeg = 0, segXY = new Float32Array(0);
    let names = [], nameDir = new Float32Array(0), nameXY = new Float32Array(0);
    const eclXY = new Float32Array(4 * 72);
    const proj = { t: NaN, u0: NaN, u1: NaN, u2: NaN, flip: 0, cat: null };
    /** @type {DomeItem[]} */
    const items = [];
    let nItems = 0;
    const widths = new Map();
    const fovXY = new Float32Array(64);
    let view = null;
    const viewAt = { az: NaN, alt: NaN, fov: NaN, aspect: NaN };
    let lastBuild = -1e9, timer = 0, force = true, pollId = 0, label = '';

    function askCatalog() {
        if (asked || typeof ctx.services?.catalog !== 'function') return;
        asked = true;
        Promise.resolve(ctx.services.catalog()).then((k) => {
            if (!k?.stars?.count) { asked = false; return; }
            useCatalog(k);
            rebuildNow();
        }, () => { asked = false; });
    }

    function useCatalog(k) {
        const st = k.stars;
        let n = 0;
        while (n < st.count && st.mag[n] <= STAR_MAG) n++;
        cat = k;
        nStars = n;
        starXY = new Float32Array(2 * n);
        starStyle = [];
        for (let i = 0; i < n; i++) {
            // The B−V colour (linear, peak 1) toward white, gamma-encoded.
            const ch = (j) => Math.round(255 * (0.55 + 0.45 * Math.pow(Math.max(0, st.color[3 * i + j]), 1 / 2.2)));
            starStyle.push(rgbStr([ch(0), ch(1), ch(2)], Math.min(1, 0.55 + 0.18 * (STAR_MAG - st.mag[i]))));
        }
        nSeg = Math.floor((k.cons?.segments?.length ?? 0) / 6);
        segXY = new Float32Array(4 * nSeg);
        names = (k.starNames ?? []).filter((s) => s.mag <= HIT_MAG && Number.isInteger(s.hip)).map((s) => ({ s, id: `star:${s.hip}` }));
        nameDir = new Float32Array(3 * names.length);
        nameXY = new Float32Array(2 * names.length);
        proj.cat = null;
    }

    function item(k) {
        if (!items[k]) items[k] = { id: '', name: '', x: 0, y: 0, r: 0, w: 0, h: 0, star: false, lx: 0, ly: 0, ok: false };
        return items[k];
    }

    function measure(text, font) {
        const key = font + text;
        let w = widths.get(key);
        if (w === undefined) { bc.font = font; w = bc.measureText(text).width; widths.set(key, w); }
        return w;
    }

    /** Reprojects stars, lines and names when the time, the observer or the orientation changed. */
    function reproject(snap, flip) {
        const o = snap.observer, U = o.upS;
        if (proj.t === snap.tMs && proj.u0 === U[0] && proj.u1 === U[1] && proj.u2 === U[2] && proj.flip === flip && proj.cat === cat) return;
        proj.t = snap.tMs; proj.u0 = U[0]; proj.u1 = U[1]; proj.u2 = U[2]; proj.flip = flip; proj.cat = cat;
        projectSegments(ECLIPTIC, 72, o, flip, eclXY);
        if (!cat) return;
        projectDirs(cat.stars.dirS, nStars, o, flip, starXY);
        projectSegments(cat.cons.segments, nSeg, o, flip, segXY);
        // Names follow proper motion (catalog.js moves their dirS in place), so they are copied each time.
        for (let i = 0; i < names.length; i++) {
            const d = names[i].s.dirS;
            nameDir[3 * i] = d[0]; nameDir[3 * i + 1] = d[1]; nameDir[3 * i + 2] = d[2];
        }
        projectDirs(nameDir, names.length, o, flip, nameXY);
    }

    function strokeSegs(g, xy, n, cx, cy, R) {
        g.beginPath();
        for (let i = 0; i < n; i++) {
            const d = 4 * i;
            if (xy[d] !== xy[d]) continue;
            g.moveTo(cx + xy[d] * R, cy + xy[d + 1] * R);
            g.lineTo(cx + xy[d + 2] * R, cy + xy[d + 3] * R);
        }
        g.stroke();
    }

    /** The chart into the offscreen canvas, and its items. */
    function build(snap) {
        clearTimeout(timer);
        timer = 0;
        force = false;
        lastBuild = performance.now();
        if (!W || !snap?.observer?.upS) return;
        const flip = mode === 'map' ? 1 : -1;
        reproject(snap, flip);
        const g = bc, cx = W / 2, cy = W / 2, R = W / 2 - MARGIN, k = Math.min(1.5, Math.max(1, R / 110));
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, W);
        const sunAlt = snap.observer.sunAltDeg;
        const sky = lutRgb(sunAlt);
        let grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
        grad.addColorStop(0, rgbStr(mixRgb(sky, C_NIGHT, 0.45)));
        grad.addColorStop(1, rgbStr(sky));
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
        const bodies = snap.bodies, table = hostBodies(snap.host);
        const sunB = bodies[0], sun = ui.altAz(sunB);
        // Twilight brightens the sky on the Sun's side.
        if (sunAlt > -18 && sunAlt < 12 && Number.isFinite(sun.az)) {
            const r = Math.min(1, (90 - Math.max(0, sun.alt)) / 90) * R;
            const sx = cx + flip * r * Math.sin(sun.az * DEG), sy = cy - r * Math.cos(sun.az * DEG);
            const a = 0.55 * (sunAlt > 0 ? 1 - sunAlt / 12 : 1 + sunAlt / 18);
            grad = g.createRadialGradient(sx, sy, 0, sx, sy, R * 1.1);
            const glow = lutRgb(sunAlt + 6);
            grad.addColorStop(0, rgbStr(glow, a));
            grad.addColorStop(1, rgbStr(glow, 0));
            g.fillStyle = grad;
            g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
        }
        g.save();
        g.beginPath(); g.arc(cx, cy, R + 0.5, 0, TAU); g.clip();
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,0.08)';
        g.setLineDash(DASH);
        g.beginPath(); g.arc(cx, cy, R / 3, 0, TAU); g.moveTo(cx + (2 * R) / 3, cy); g.arc(cx, cy, (2 * R) / 3, 0, TAU); g.stroke();
        g.strokeStyle = 'rgba(255,214,120,0.32)';
        strokeSegs(g, eclXY, 72, cx, cy, R);
        g.setLineDash(NO_DASH);
        const day = sunAlt > -0.833 ? 0.4 : sunAlt > -6 ? 0.7 : 1;
        if (cat) {
            g.strokeStyle = `rgba(190,205,235,${0.16 * day + 0.04})`;
            strokeSegs(g, segXY, nSeg, cx, cy, R);
            g.globalAlpha = day;
            for (let i = 0; i < nStars; i++) {
                const x = starXY[2 * i];
                if (x !== x) continue;
                g.fillStyle = starStyle[i];
                g.beginPath(); g.arc(cx + x * R, cy + starXY[2 * i + 1] * R, starRadius(cat.stars.mag[i]) * k, 0, TAU); g.fill();
            }
            g.globalAlpha = 1;
        }
        g.restore();
        // Horizon, ticks and the cardinal points.
        g.strokeStyle = 'rgba(255,255,255,0.34)';
        g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
        g.beginPath();
        for (let i = 0; i < 16; i++) {
            const a = i * 22.5 * DEG, len = i % 4 === 0 ? 6 : i % 2 === 0 ? 4 : 2.5;
            const sx = flip * Math.sin(a), sy = -Math.cos(a);
            g.moveTo(cx + sx * R, cy + sy * R); g.lineTo(cx + sx * (R + len), cy + sy * (R + len));
        }
        g.stroke();
        g.font = `700 10.5px ${FONT}`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let i = 0; i < 4; i++) {
            const a = i * HALF_PI, rr = R + 10.5;
            g.fillStyle = i === 0 ? '#ff8f7e' : 'rgba(154,166,184,0.95)';
            g.fillText(CARDINAL[i], cx + flip * Math.sin(a) * rr, cy - Math.cos(a) * rr + 0.5);
        }

        // Items: the bodies above the horizon (smallest dot first, so the bright ones draw on top), then named stars.
        nItems = 0;
        const sel = store.get().selection;
        const up = [];
        for (let i = bodies.length - 1; i >= 0; i--) {
            const b = bodies[i], { alt, az } = ui.altAz(b);
            const isUp = typeof b.above === 'boolean' ? b.above : alt > 0;
            if (!isUp || !Number.isFinite(az)) continue;
            const r = Math.min(1, (90 - Math.max(0, alt)) / 90) * R;
            const it = item(nItems++);
            it.id = b.id; it.name = ui.bodyName(b.id); it.star = false;
            it.x = cx + flip * r * Math.sin(az * DEG); it.y = cy - r * Math.cos(az * DEG);
            it.r = (b.id === 'sun' ? 5.5 : b.id === 'moon' ? 6 : bodyRadius(b.mag)) * k;
            up.push({ name: it.name, alt, az });
        }
        const nBodies = nItems;
        for (let i = 1; i < nBodies; i++) {
            const a = items[i];
            let j = i - 1;
            for (; j >= 0 && items[j].r > a.r; j--) items[j + 1] = items[j];
            items[j + 1] = a;
        }
        // The cardinal letters outside the rim keep labels off them (obstacles only, never tapped).
        for (let i = 0; i < 4; i++) {
            const it = item(nItems++), rr = R + 10.5;
            it.id = ''; it.name = ''; it.star = true; it.w = 0; it.r = 6;
            it.x = cx + flip * Math.sin(i * HALF_PI) * rr; it.y = cy - Math.cos(i * HALF_PI) * rr;
        }
        const labelMag = R >= 150 ? 1.6 : 1.0;
        for (let i = 0; i < names.length; i++) {
            const x = nameXY[2 * i];
            if (x !== x) continue;
            const s = names[i].s, it = item(nItems++);
            it.id = names[i].id; it.name = s.name; it.star = true;
            it.x = cx + x * R; it.y = cy + nameXY[2 * i + 1] * R; it.r = Math.max(1.5, starRadius(s.mag) * k);
            it.w = s.mag <= labelMag || it.id === sel ? measure(s.name, `10px ${FONT}`) : 0;
            it.h = 11;
        }
        // Labels in priority order: the selection, the Sun, the Moon and planets (brightest first), then stars.
        for (let i = 0; i < nBodies; i++) { const it = items[i]; it.w = measure(it.name, `600 11px ${FONT}`); it.h = 13; }
        const order = items.slice(0, nItems).sort((a, b) => (b.id === sel) - (a.id === sel) || a.star - b.star || b.r - a.r);
        placeLabels(order, nItems, W, W);

        for (let i = 0; i < nBodies; i++) {
            const it = items[i], b = bodies[BODY_INDEX[it.id]];
            const col = table[BODY_INDEX[it.id]].color;
            if (it.id === 'sun') {
                grad = g.createRadialGradient(it.x, it.y, 0, it.x, it.y, it.r * 3.4);
                grad.addColorStop(0, 'rgba(255,211,107,0.6)');
                grad.addColorStop(1, 'rgba(255,211,107,0)');
                g.fillStyle = grad;
                g.beginPath(); g.arc(it.x, it.y, it.r * 3.4, 0, TAU); g.fill();
                g.fillStyle = '#ffe9a8';
                g.beginPath(); g.arc(it.x, it.y, it.r, 0, TAU); g.fill();
            } else if (it.id === 'moon' && snap.host !== 'mars') {
                const lit = snap.eclipse?.lunar ? snap.eclipse.moonLitFraction : 1;
                drawMoon(g, it.x, it.y, it.r, b.phaseFrac, limbAngle(b.dirS, sunB.dirS, snap.observer, flip), Number.isFinite(lit) ? 1 - lit : 0);
            } else {
                g.fillStyle = col;
                g.strokeStyle = 'rgba(0,0,0,0.55)';
                g.beginPath(); g.arc(it.x, it.y, it.r, 0, TAU); g.fill(); g.stroke();
            }
        }
        for (let i = 0; i < nItems; i++) {
            const it = items[i];
            if (it.id !== sel) continue;
            g.strokeStyle = '#7cc4ff';
            g.lineWidth = 1.5;
            g.beginPath(); g.arc(it.x, it.y, it.r + 3.5, 0, TAU); g.stroke();
            g.lineWidth = 1;
        }
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.lineJoin = 'round';
        g.strokeStyle = 'rgba(4,6,12,0.7)';
        g.lineWidth = 3;
        for (let i = 0; i < nItems; i++) {
            const it = items[i];
            if (!it.ok) continue;
            g.font = it.star ? `10px ${FONT}` : `600 11px ${FONT}`;
            g.strokeText(it.name, it.lx, it.ly + 0.5);
            g.fillStyle = it.star ? 'rgba(186,198,216,0.92)' : table[BODY_INDEX[it.id]].color;
            g.fillText(it.name, it.lx, it.ly + 0.5);
        }
        g.lineWidth = 1;
        describe(up);
        composite();
    }

    function describe(up) {
        up.sort((a, b) => b.alt - a.alt);
        const ids = up.map((u) => u.name);
        setText(meta, ids.length ? `${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ` +${ids.length - 4}` : ''} up` : 'Sun, Moon and planets below the horizon');
        const text = `All-sky chart, ${mode === 'map' ? 'as a map, east on the right' : 'looking up, east on the left'}, north at the top. `
            + (up.length ? `Above the horizon: ${up.map((u) => `${u.name} ${Math.round(u.alt)}° ${ui.compass(u.az)}`).join(', ')}.` : 'Nothing above the horizon but stars.')
            + (view ? ` The camera looks ${ui.compassWords(view.azDeg)}, ${Math.round(view.altDeg)}° up.` : '');
        if (text !== label) { label = text; setAttr(cv, 'aria-label', text); }
    }

    /** The chart, plus the camera's wedge in Sky view. */
    function composite() {
        if (!W) return;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, cv.width, cv.height);
        c.drawImage(base, 0, 0);
        if (!view) return;
        const cx = W / 2, cy = W / 2, R = W / 2 - MARGIN, flip = mode === 'map' ? 1 : -1;
        const n = fovOutline(view, flip, fovXY, 8);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.save();
        c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.clip();
        c.beginPath();
        for (let i = 0; i < n; i++) c.lineTo(cx + fovXY[2 * i] * R, cy + fovXY[2 * i + 1] * R);
        c.closePath();
        c.fillStyle = 'rgba(124,196,255,0.16)';
        c.fill();
        c.strokeStyle = 'rgba(124,196,255,0.85)';
        c.lineWidth = 1.25;
        c.stroke();
        c.restore();
    }

    function update(snap) {
        if (!open || !snap?.bodies?.length) return;
        const now = performance.now();
        if (force || now - lastBuild >= REBUILD_MS) { build(snap); return; }
        if (!timer) timer = setTimeout(() => { timer = 0; if (open && ui.snap) build(ui.snap); }, REBUILD_MS - (now - lastBuild));
    }
    function rebuildNow() { force = true; if (ui.snap) update(ui.snap); }

    // The camera's field in Sky view: polled while it is shown, composited only when it moved.
    function pollView() {
        if (document.hidden) return;
        const v = ui.act('getView');
        const ok = v?.mode === 'sky' && Number.isFinite(v.azDeg);
        if (ok && Math.abs(v.azDeg - viewAt.az) < 0.4 && Math.abs(v.altDeg - viewAt.alt) < 0.4
            && Math.abs(v.fovDeg / viewAt.fov - 1) < 0.01 && Math.abs(v.aspect - viewAt.aspect) < 0.01) return;
        if (!ok && !view) return;
        view = ok ? v : null;
        viewAt.az = ok ? v.azDeg : NaN; viewAt.alt = ok ? v.altDeg : NaN; viewAt.fov = ok ? v.fovDeg : NaN; viewAt.aspect = ok ? v.aspect : NaN;
        composite();
    }
    function syncPoll() {
        const st = store.get();
        const want = open && W > 0 && st.view?.mode === 'sky' && st.status?.webgl !== false;
        if (want && !pollId) { pollId = setInterval(pollView, VIEW_POLL_MS); pollView(); }
        if (!want && pollId) { clearInterval(pollId); pollId = 0; }
        if (!want && view) { view = null; viewAt.az = NaN; composite(); }
    }

    function resize() {
        const w = Math.round(wrap.clientWidth);
        const d = Math.min(2, globalThis.devicePixelRatio || 1);
        if (w === W && d === dpr) return;
        W = w; dpr = d;
        if (W) {
            cv.width = base.width = Math.round(W * dpr);
            cv.height = base.height = Math.round(W * dpr);
            rebuildNow();
        }
        syncPoll();
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    offs.push(on(head, 'click', () => {
        open = !open;
        body.hidden = !open;
        el.classList.toggle('is-open', open);
        setAttr(head, 'aria-expanded', String(open));
        save();
        if (open) { askCatalog(); resize(); rebuildNow(); }
        syncPoll();
    }));
    const tapAt = (e, slop) => {
        const r = cv.getBoundingClientRect();
        return nearestHit(items, nItems, e.clientX - r.left, e.clientY - r.top, slop);
    };
    offs.push(on(cv, 'click', (e) => {
        const coarse = ctx.env?.coarse || store.get().status?.coarse;
        const i = tapAt(e, coarse ? 14 : 8);
        if (i >= 0) ui.act('select', items[i].id, { fly: true });
    }));
    offs.push(on(cv, 'pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const i = tapAt(e, 6);
        cv.style.cursor = i >= 0 ? 'pointer' : '';
        cv.title = i >= 0 ? items[i].name : '';
    }));
    offs.push(store.subscribe((st) => st.selection, rebuildNow));
    offs.push(store.subscribe((st) => st.observer, rebuildNow));
    offs.push(store.subscribe((st) => st.view?.mode, syncPoll));
    offs.push(store.subscribe((st) => st.status?.webgl, syncPoll));
    if (open) askCatalog();

    return {
        el,
        update,
        destroy() {
            offs.forEach((off) => off());
            ro?.disconnect();
            clearTimeout(timer);
            clearInterval(pollId);
            el.remove();
        },
    };
}

/**
 * The Moon on the chart: its dark disc, and the lit part bounded by the limb and the terminator
 * (an ellipse of half-width |1 − 2k|·r), turned so the lit limb faces `ang` (toward the Sun);
 * copper as a lunar eclipse takes its direct sunlight (`shadow` 0…1).
 */
function drawMoon(g, x, y, r, frac, ang, shadow) {
    g.fillStyle = '#262c3a';
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); g.stroke();
    const k = Math.min(1, Math.max(0, Number.isFinite(frac) ? frac : 1));
    if (k < 0.004) return;
    g.save();
    g.translate(x, y);
    if (ang === ang) g.rotate(ang);
    g.beginPath();
    for (let i = 0; i <= 16; i++) { const yy = -r + (r * i) / 8; g.lineTo(Math.sqrt(Math.max(0, r * r - yy * yy)), yy); }
    for (let i = 16; i >= 0; i--) { const yy = -r + (r * i) / 8; g.lineTo((1 - 2 * k) * Math.sqrt(Math.max(0, r * r - yy * yy)), yy); }
    g.closePath();
    g.fillStyle = rgbStr(mixRgb([238, 241, 246], [168, 74, 40], Math.min(1, Math.max(0, shadow || 0))));
    g.fill();
    g.restore();
}
