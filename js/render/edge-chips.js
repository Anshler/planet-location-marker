/**
 * Off-screen pointers (ROADMAP ar-sky-pointing, part 1). In sky view each body above the horizon
 * that lies outside the field gets a chip at the edge of the free area ('Saturn ↗ 79°'): the arrow
 * points along the screen toward it, the number is how far it is from the view centre. A tap turns
 * the view there. Useful with a mouse, a finger, or a phone pointed at the sky.
 *
 * Which bodies: those above the horizon (refraction- and limb-aware `above`) that the eye can find
 * now (magnitude against the Sun's altitude: by day the Sun, the Moon and Venus; in twilight the
 * bright planets; at night everything to mag 5.5), plus the selected body whatever its brightness.
 *
 * A DOM layer inside #labels-root (so it hides with the labels during long exposures and vantage
 * points), positioned on every rendered frame with no allocation: chips ride the ray from the view
 * centre (the principal point, panel insets included) to the body's screen direction, are spread
 * apart along their edge, and slide along it to stay clear of the UI chrome (labels.js
 * uiOccluders). Text and transforms are written only when they change.
 *
 * A render module for its per-frame hook; it adds nothing to the scene.
 *
 *   createEdgeChips(rc, {root, onActivate}) → RenderModule & { stats() }
 *
 * @module render/edge-chips
 */
import * as THREE from 'three';
import { BODIES, hostBodies } from '../astro/bodies.js';
import { liftByRefraction } from '../astro/photometry.js';
import { edgeHit } from '../astro/sky-guide.js';
import { uiOccluders } from './labels.js';

const DEG = 180 / Math.PI;
/** Chips keep this far inside the free area (CSS px). */
const PAD = 10;
/** A body this far inside the free area's edge counts as in view (its glyph and label show). */
const IN_VIEW_PX = 4;
const CHIP_H = 26;
const GAP = 6;
/** Sliding along the edge to clear UI chrome: steps of SLIDE_PX, at most SLIDE_STEPS each way. */
const SLIDE_PX = 14;
const SLIDE_STEPS = 14;
/** Arrows point along the projection up to TURN_FROM_DEG from the centre, along the turn beyond TURN_FULL_DEG. */
const TURN_FROM_DEG = 40;
const TURN_FULL_DEG = 70;

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
function smoothstep(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

/**
 * Brightness a body needs for a chip: the naked-eye limit at night, the bright planets in
 * twilight, the Moon and Venus (and the Sun) by day.
 * @param {number} sunAltDeg
 * @returns {number}
 */
export function chipMagLimit(sunAltDeg) {
    if (!Number.isFinite(sunAltDeg) || sunAltDeg < -12) return 5.5;
    if (sunAltDeg < -4) return 1.5;
    return -3.5;
}

/**
 * Creates the off-screen pointer layer.
 * @param {object} rc RenderContext (size: {w, h, insets})
 * @param {{root?:HTMLElement|null, onActivate?:(id:string)=>void}} [deps] root: the labels root
 * @returns {object} RenderModule & {stats():{shown:number}}
 */
export function createEdgeChips(rc, deps = {}) {
    const group = new THREE.Group();
    group.name = 'edge-chips';
    const doc = deps.root?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const layer = doc ? doc.createElement('div') : null;
    let enabled = true;
    let selection = null;
    let shown = 0;
    const LIFT = new Float64Array(3);
    const HIT = { x: 0, y: 0, edge: '' };

    // One slot per body: the element, its last written state, and this frame's placement.
    const slots = BODIES.map((b, i) => {
        const s = {
            i, id: b.id, name: b.name, el: null, arrow: null, deg: null,
            on: false, x: NaN, y: NaN, rot: NaN, text: '', vis: false,
            // this frame
            want: false, px: 0, py: 0, edge: '', along: 0, hw: 0, angle: 0, rotNow: 0,
        };
        if (layer) {
            const el = doc.createElement('button');
            el.type = 'button';
            el.className = 'echip';
            el.tabIndex = -1;
            el.dataset.id = b.id;
            el.style.setProperty('--c', `var(--body-${b.id}, ${b.color})`);
            const arrow = doc.createElement('span');
            arrow.className = 'echip__arrow';
            arrow.setAttribute('aria-hidden', 'true');
            const name = doc.createElement('span');
            name.className = 'echip__name';
            name.textContent = b.name;
            const deg = doc.createElement('span');
            deg.className = 'echip__deg';
            el.append(arrow, name, deg);
            el.hidden = true;
            layer.appendChild(el);
            s.el = el;
            s.arrow = arrow;
            s.deg = deg;
        }
        return s;
    });
    const order = slots.slice();

    if (layer) {
        layer.className = 'echips';
        deps.root?.appendChild(layer);
        layer.addEventListener('click', (e) => {
            const b = /** @type {HTMLElement} */ (e.target).closest?.('.echip');
            if (!b || !b.dataset.id) return;
            e.stopPropagation();
            try { deps.onActivate?.(b.dataset.id); } catch (err) { console.error('[edge-chips] activate failed', err); }
        });
    }

    function hideAll() {
        for (const s of slots) setVisible(s, false);
        shown = 0;
    }

    function setVisible(s, on) {
        if (s.vis === on || !s.el) { s.vis = on; return; }
        s.vis = on;
        s.el.hidden = !on;
    }

    /** Offset (into uiOccluders().rects) of the first UI chrome rect the chip centred at (x, y) overlaps, or −1. */
    function occluder(x, y, hw, hh) {
        const oc = uiOccluders();
        const r = oc.rects;
        for (let k = 0, n = oc.count * 4; k < n; k += 4) {
            if (x - hw < r[k + 2] && x + hw > r[k] && y - hh < r[k + 3] && y + hh > r[k + 1]) return k;
        }
        return -1;
    }

    function occluded(x, y, hw, hh) {
        return occluder(x, y, hw, hh) >= 0;
    }

    function update(fi) {
        if (!layer) return;
        const snap = fi && fi.snap;
        const cam = fi && fi.camera;
        if (!enabled || !snap || !cam || fi.viewMode !== 'sky' || !(fi.skyBlend >= 0.999)) {
            hideAll();
            return;
        }
        const size = rc.size || {};
        const w = size.w || 0, h = size.h || 0;
        if (!(w > 0 && h > 0)) { hideAll(); return; }
        const ins = size.insets || null;
        const fx0 = (ins ? ins.left || 0 : 0) + PAD, fx1 = w - (ins ? ins.right || 0 : 0) - PAD;
        const fy0 = (ins ? ins.top || 0 : 0) + PAD, fy1 = h - (ins ? ins.bottom || 0 : 0) - PAD;
        const M = cam.matrixWorldInverse.elements, PM = cam.projectionMatrix.elements;
        // The view centre on screen: the projection of the camera axis (the panel offset moves it).
        const pcx = (-PM[8] / -PM[11] * 0.5 + 0.5) * w;
        const pcy = (0.5 - -PM[9] / -PM[11] * 0.5) * h;
        const up = snap.observer.upS, no = snap.observer.northS, ea = snap.observer.eastS;
        const k = Math.min(1, Math.max(0, fi.skyBlend));
        const lim = chipMagLimit(snap.observer.sunAltDeg);
        // The look in horizon terms (the camera's forward is its view matrix's third row, negated),
        // and the zenith's direction on screen: far bodies are pointed to by the turn that reaches
        // them (left or right, then up or down), not by the great circle, which runs over the zenith.
        const f0 = -M[2], f1 = -M[6], f2 = -M[10];
        const azC = Math.atan2(f0 * ea[0] + f1 * ea[1] + f2 * ea[2], f0 * no[0] + f1 * no[1] + f2 * no[2]) * DEG;
        const altC = Math.asin(Math.max(-1, Math.min(1, f0 * up[0] + f1 * up[1] + f2 * up[2]))) * DEG;
        let zx = M[0] * up[0] + M[4] * up[1] + M[8] * up[2], zy = M[1] * up[0] + M[5] * up[1] + M[9] * up[2];
        const zl = Math.hypot(zx, zy);
        const turnOk = zl > 0.05;
        if (turnOk) { zx /= zl; zy /= zl; }
        let n = 0;
        // Always findable whatever its brightness: the Moon from the Earth; from Mars the Earth (slot 4)
        // is what people look for, and the Earth's Moon is a faint point.
        const always = snap.host === 'mars' ? 'mars' : 'moon';
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            const b = snap.bodies[i];
            s.want = false;
            if (!b || !b.above) continue;
            const mag = Number.isFinite(b.mag) ? b.mag : 0;
            if (s.id !== selection && mag > lim && s.id !== 'sun' && s.id !== always) continue;
            const d = liftByRefraction(b.dirS, up, k, LIFT);
            const vx = M[0] * d[0] + M[4] * d[1] + M[8] * d[2];
            const vy = M[1] * d[0] + M[5] * d[1] + M[9] * d[2];
            const vz = M[2] * d[0] + M[6] * d[1] + M[10] * d[2];
            const X = PM[0] * vx + PM[4] * vy + PM[8] * vz;
            const Y = PM[1] * vx + PM[5] * vy + PM[9] * vz;
            const W = PM[3] * vx + PM[7] * vy + PM[11] * vz;
            if (W > 1e-6) {
                const sx = (X / W * 0.5 + 0.5) * w, sy = (0.5 - Y / W * 0.5) * h;
                if (sx > fx0 - PAD + IN_VIEW_PX && sx < fx1 + PAD - IN_VIEW_PX && sy > fy0 - PAD + IN_VIEW_PX && sy < fy1 + PAD - IN_VIEW_PX) continue;
            }
            // Screen direction toward it (y down): the projection nearby, the turn far away.
            const sep = Math.acos(Math.max(-1, Math.min(1, -vz))) * DEG;
            let ux = vx * PM[0], uy = -vy * PM[5];
            let l = Math.hypot(ux, uy);
            if (l > 1e-9) { ux /= l; uy /= l; } else { ux = 1; uy = 0; }
            const wt = turnOk ? smoothstep(TURN_FROM_DEG, TURN_FULL_DEG, sep) : 0;
            if (wt > 0) {
                const altB = Number.isFinite(b.altDeg) ? b.altDeg : b.altGeomDeg, azB = Number.isFinite(b.azDeg) ? b.azDeg : b.azGeomDeg;
                const hz = wrap180(azB - azC) * Math.cos((altB + altC) * 0.5 / DEG), vt = altB - altC;
                // Camera space: up is the zenith's direction, right is where the azimuth grows.
                const cx = zy * hz + zx * vt, cy = -zx * hz + zy * vt;
                let tx = cx * PM[0], ty = -cy * PM[5];
                l = Math.hypot(tx, ty);
                if (l > 1e-9) {
                    tx /= l; ty /= l;
                    ux = ux * (1 - wt) + tx * wt;
                    uy = uy * (1 - wt) + ty * wt;
                }
            }
            if (!(Math.hypot(ux, uy) > 1e-9)) { ux = 1; uy = 0; }
            s.angle = Math.round(sep);
            s.rotNow = Math.atan2(uy, ux) * DEG;
            const text = `${s.angle}°`;
            if (text !== s.text) {
                s.text = text;
                s.deg.textContent = text;
                s.el.setAttribute('aria-label', `${s.name}, ${text} from the centre of the view. Turn there.`);
                s.el.title = `${s.name}: ${text} away — tap to turn there`;
            }
            s.hw = (34 + 6.8 * (s.name.length + text.length)) / 2;
            edgeHit(pcx, pcy, ux, uy, fx0 + s.hw, fy0 + CHIP_H / 2, fx1 - s.hw, fy1 - CHIP_H / 2, HIT);
            s.px = HIT.x;
            s.py = HIT.y;
            s.edge = HIT.edge;
            s.along = HIT.edge === 'top' || HIT.edge === 'bottom' ? HIT.x : HIT.y;
            s.want = true;
            n++;
        }
        if (n > 1) spread(fx0, fy0, fx1, fy1);
        shown = 0;
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (!s.want) { setVisible(s, false); continue; }
            // Clear of the UI chrome: just inside it (below the top bar, left of the floating
            // column, above the view switch), else slid along the edge, nearest free spot first.
            let x = s.px, y = s.py, ok = false;
            for (let tries = 0; tries < 4; tries++) {
                const r = occluder(x, y, s.hw, CHIP_H / 2);
                if (r < 0) { ok = true; break; }
                const R = uiOccluders().rects;
                if (s.edge === 'top') y = R[r + 3] + CHIP_H / 2 + GAP;
                else if (s.edge === 'bottom') y = R[r + 1] - CHIP_H / 2 - GAP;
                else if (s.edge === 'left') x = R[r + 2] + s.hw + GAP;
                else x = R[r] - s.hw - GAP;
                if (x - s.hw < fx0 || x + s.hw > fx1 || y - CHIP_H / 2 < fy0 || y + CHIP_H / 2 > fy1) break;
            }
            if (!ok) { x = s.px; y = s.py; }
            const horiz = s.edge === 'top' || s.edge === 'bottom';
            for (let step = 1; !ok && step <= SLIDE_STEPS; step++) {
                for (let sign = -1; sign <= 1 && !ok; sign += 2) {
                    const tx = horiz ? s.px + sign * step * SLIDE_PX : s.px;
                    const ty = horiz ? s.py : s.py + sign * step * SLIDE_PX;
                    if (tx - s.hw < fx0 || tx + s.hw > fx1 || ty - CHIP_H / 2 < fy0 || ty + CHIP_H / 2 > fy1) continue;
                    if (!occluded(tx, ty, s.hw, CHIP_H / 2)) { x = tx; y = ty; ok = true; }
                }
            }
            if (!ok) { setVisible(s, false); continue; }
            const rx = Math.round(x), ry = Math.round(y);
            if (rx !== s.x || ry !== s.y) {
                s.x = rx;
                s.y = ry;
                s.el.style.transform = `translate(${rx}px, ${ry}px) translate(-50%, -50%)`;
            }
            const rot = Math.round(s.rotNow);
            if (rot !== s.rot) {
                s.rot = rot;
                s.arrow.style.transform = `rotate(${rot}deg)`;
            }
            const sel = s.id === selection;
            if (sel !== s.on) {
                s.on = sel;
                s.el.classList.toggle('is-selected', sel);
            }
            setVisible(s, true);
            shown++;
        }
    }

    /** Spreads chips sharing an edge so they do not overlap (two sweeps, then clamped). */
    function spread(fx0, fy0, fx1, fy1) {
        // Insertion sort by edge, then position along it (no allocation).
        for (let a = 1; a < order.length; a++) {
            const s = order[a];
            let b = a - 1;
            while (b >= 0 && cmp(order[b], s) > 0) { order[b + 1] = order[b]; b--; }
            order[b + 1] = s;
        }
        let start = 0;
        while (start < order.length) {
            const s0 = order[start];
            if (!s0.want) { start++; continue; }
            let end = start + 1;
            while (end < order.length && order[end].want && order[end].edge === s0.edge) end++;
            if (end - start > 1) spreadRun(start, end, s0.edge === 'top' || s0.edge === 'bottom', fx0, fy0, fx1, fy1);
            start = end;
        }
    }

    function cmp(p, q) {
        if (p.want !== q.want) return p.want ? -1 : 1;
        if (p.edge !== q.edge) return p.edge < q.edge ? -1 : 1;
        return p.along - q.along;
    }

    function spreadRun(a, b, horiz, fx0, fy0, fx1, fy1) {
        const half = (s) => (horiz ? s.hw : CHIP_H / 2);
        const lo = horiz ? fx0 : fy0, hi = horiz ? fx1 : fy1;
        for (let j = a + 1; j < b; j++) {
            const p = order[j - 1], s = order[j];
            const min = p.along + half(p) + GAP + half(s);
            if (s.along < min) s.along = min;
        }
        const last = order[b - 1];
        if (last.along + half(last) > hi) last.along = hi - half(last);
        for (let j = b - 2; j >= a; j--) {
            const s = order[j], q = order[j + 1];
            const max = q.along - half(q) - GAP - half(s);
            if (s.along > max) s.along = max;
        }
        for (let j = a; j < b; j++) {
            const s = order[j];
            s.along = Math.max(lo + half(s), Math.min(hi - half(s), s.along));
            if (horiz) s.px = s.along;
            else s.py = s.along;
        }
    }

    return {
        object3d: group,
        apply() {},
        update,
        setLayers(layers) {
            const on = !layers || layers.labels !== false;
            if (on === enabled) return;
            enabled = on;
            if (!on) hideAll();
        },
        setSelection(id) { selection = id ?? null; },
        setViewMode(mode) { if (mode !== 'sky') hideAll(); },
        /** The world the observer stands on: on Mars slot 4 is the Earth (astro/bodies.js hostBodies). */
        setHost(id) {
            const table = hostBodies(id);
            for (const s of slots) {
                const name = table[s.i].name;
                if (s.name === name) continue;
                s.name = name;
                s.text = '';
                const el = s.el && s.el.querySelector('.echip__name');
                if (el) el.textContent = name;
            }
        },
        /** Chips on screen after the last frame (tests, stats). */
        stats() { return { shown }; },
        dispose() { layer?.remove(); },
    };
}
