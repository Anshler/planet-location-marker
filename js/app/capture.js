// Frame capture (ROADMAP sky-postcard; lighten-stacking-exposure 'Save image'): the scene rendered
// once at a requested size into a 2D canvas, with the label feed's labels drawn on top.
//
//   createCapture({getRc, getLoop, getFeed, doc}) → { frame(opts) → HTMLCanvasElement|null,
//                                                     session(opts) → {canvas, frame(now, dt), end()}|null }
//   projectLabels(anchors, view, opts, measure) → placed labels   (pure, unit-tested)
//
// The render context does the one-task resize-render-read-restore (render/context.js capture), the
// loop draws (loop.redraw: module updates, label-feed sync, rc.render), and this module paints. The
// labels are NOT read from the DOM: their boxes belong to the screen's aspect. The label feed's own
// anchors (world directions and points, already synced to the capture camera by loop.redraw) are
// reprojected with the capture camera, culled as the label pool culls them (behind the camera,
// behind the Earth, star and constellation names under the horizon or the landscape), decluttered
// greedily in priority order and painted with the label CSS's type styles.
//
// A session (the time-lapse video, app/recorder.js) keeps the capture's size for many frames
// (rc.beginCapture … endCapture): each frame is one loop.step() on the caller's time base with the
// capture projection bracketing its draw, composited with its labels into one reused 2D canvas.
//
// js/app may touch the DOM (canvas, fonts); it never imports three: the camera is read through its
// plain `elements` arrays.

import { liftByRefraction } from '../astro/photometry.js';
import { azimuthDeg, horizonAltDeg } from '../geo/horizon.js';

const DEG = Math.PI / 180;
/** Mirrors render/labels.js: the horizon tolerance, the far-point distance, kind ranks, padding. */
const HORIZON_SIN = -0.005;
const FAR_POINT = 200;
const KIND_RANK = { body: 0, observer: 1, cardinal: 2, trail: 3, star: 4, constellation: 5 };
const PAD = 3;
const EDGE = 4;
const LINE_H = 20;
export const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Type styles of the label kinds (css/app.css §3, in CSS px): weight, size, tracking (em), dot
 * diameter (0 = none), dot-to-text gap, the dot's offset left of the anchor, upper case.
 */
export const LABEL_STYLES = Object.freeze({
    body: { weight: 600, size: 12.5, track: 0.01, dot: 6, gap: 6, upper: false },
    observer: { weight: 700, size: 12, track: 0.01, dot: 6, gap: 6, upper: false },
    star: { weight: 500, size: 11, track: 0.01, dot: 4, gap: 5, upper: false },
    constellation: { weight: 650, size: 10, track: 0.16, dot: 0, gap: 0, upper: true },
    cardinal: { weight: 800, size: 13, track: 0.06, dot: 0, gap: 0, upper: false, centre: true },
    trail: { weight: 550, size: 10.5, track: 0.01, dot: 5, gap: 6, upper: false },
});

const _lift = new Float64Array(3);

function rayHitsSphere(cx, cy, cz, dx, dy, dz) {
    const c = cx * cx + cy * cy + cz * cz - 1;
    if (c <= 0) return true;
    const b = cx * dx + cy * dy + cz * dz;
    if (b >= 0) return false;
    return b * b - c > 0;
}

function segmentHitsSphere(cx, cy, cz, px, py, pz) {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const L = Math.hypot(dx, dy, dz);
    if (!(L > 0)) return false;
    const c = cx * cx + cy * cy + cz * cz - 1;
    if (c <= 0) return false;
    const b = (cx * dx + cy * dy + cz * dz) / L;
    const disc = b * b - c;
    if (disc <= 0) return false;
    const t0 = -b - Math.sqrt(disc);
    return t0 > 0 && t0 < L - Math.max(1e-4, L * 1e-4);
}

/**
 * Screen point of one anchor (CSS px), or null when the label pool would not show it.
 * @param {any} a LabelAnchor
 * @param {{mv:ArrayLike<number>, pm:ArrayLike<number>, pos:ArrayLike<number>, w:number, h:number}} V
 *   camera: world→view (matrixWorldInverse.elements), projection elements, position; viewport CSS px
 * @param {{refrK?:number, upS?:ArrayLike<number>|null, horizon?:boolean, landscape?:any, northS?:any, eastS?:any}} o
 * @returns {{x:number, y:number}|null}
 */
export function projectAnchor(a, V, o) {
    if (!a || a.hidden === true) return null;
    if (typeof a.gate === 'function') {
        try { if (a.gate() === false) return null; } catch { return null; }
    }
    const M = V.mv, P = V.pm;
    const cx = V.pos[0], cy = V.pos[1], cz = V.pos[2];
    const refrK = o.refrK > 0 ? o.refrK : 0;
    const upS = o.upS ?? null;
    let X, Y, W;
    if (a.posS) {
        let px = a.posS[0], py = a.posS[1], pz = a.posS[2];
        if (!(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz))) return null;
        if (refrK > 0 && upS && a.kind === 'body') {
            const rx = px - cx, ry = py - cy, rz = pz - cz;
            const L = Math.hypot(rx, ry, rz);
            if (L > FAR_POINT) {
                _lift[0] = rx / L; _lift[1] = ry / L; _lift[2] = rz / L;
                liftByRefraction(_lift, upS, refrK, _lift);
                px = cx + _lift[0] * L; py = cy + _lift[1] * L; pz = cz + _lift[2] * L;
            }
        }
        const vx = M[0] * px + M[4] * py + M[8] * pz + M[12];
        const vy = M[1] * px + M[5] * py + M[9] * pz + M[13];
        const vz = M[2] * px + M[6] * py + M[10] * pz + M[14];
        X = P[0] * vx + P[4] * vy + P[8] * vz + P[12];
        Y = P[1] * vx + P[5] * vy + P[9] * vz + P[13];
        W = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
        if (!(W > 1e-6)) return null;
        if (segmentHitsSphere(cx, cy, cz, px, py, pz)) return null;
    } else if (a.dirS) {
        let d = a.dirS;
        if (!(Number.isFinite(d[0]) && Number.isFinite(d[1]) && Number.isFinite(d[2]))) return null;
        if (refrK > 0 && upS && a.kind !== 'cardinal') d = liftByRefraction(d, upS, refrK, _lift);
        const dx = d[0], dy = d[1], dz = d[2];
        const vx = M[0] * dx + M[4] * dy + M[8] * dz;
        const vy = M[1] * dx + M[5] * dy + M[9] * dz;
        const vz = M[2] * dx + M[6] * dy + M[10] * dz;
        X = P[0] * vx + P[4] * vy + P[8] * vz;
        Y = P[1] * vx + P[5] * vy + P[9] * vz;
        W = P[3] * vx + P[7] * vy + P[11] * vz;
        if (!(W > 1e-6)) return null;
        if (rayHitsSphere(cx, cy, cz, dx, dy, dz)) return null;
        if (o.horizon && upS && (a.kind === 'star' || a.kind === 'constellation')) {
            let lim = HORIZON_SIN;
            if (o.landscape && o.landscape.enabled && o.northS && o.eastS) {
                lim += Math.sin(horizonAltDeg(o.landscape, azimuthDeg(d, o.northS, o.eastS)) * DEG);
            }
            if (dx * upS[0] + dy * upS[1] + dz * upS[2] < lim) return null;
        }
    } else {
        return null;
    }
    const off = a.offsetPx;
    const x = (X / W * 0.5 + 0.5) * V.w + (off ? off[0] || 0 : 0);
    const y = (0.5 - Y / W * 0.5) * V.h + (off ? off[1] || 0 : 0);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * The text a label shows (constellation names in capitals).
 * @param {any} a
 */
export function labelText(a) {
    const s = String(a?.text ?? '');
    return LABEL_STYLES[a?.kind]?.upper ? s.toUpperCase() : s;
}

/**
 * Places the labels for a capture: projection (projectAnchor), then a greedy declutter in priority
 * order (selected first, ties by kind as the label pool ranks them) up to `cap`, dropping any label
 * whose box leaves the frame or enters the bottom `insetBottom` CSS px (a caption band).
 * `measure(a)` returns the text width in CSS px.
 * @param {any[]} anchors LabelAnchor list (labels-feed `anchors`)
 * @param {{mv:ArrayLike<number>, pm:ArrayLike<number>, pos:ArrayLike<number>, w:number, h:number}} V
 * @param {{cap?:number, refrK?:number, upS?:any, horizon?:boolean, landscape?:any, northS?:any, eastS?:any, insetBottom?:number}} o
 * @param {(a:any)=>number} measure
 * @returns {{a:any, x:number, y:number, box:number[]}[]}
 */
export function projectLabels(anchors, V, o, measure) {
    const cand = [];
    const yMax = V.h - EDGE - (o.insetBottom > 0 ? o.insetBottom : 0);
    for (const a of anchors || []) {
        const p = projectAnchor(a, V, o);
        if (!p) continue;
        const st = LABEL_STYLES[a.kind] ?? LABEL_STYLES.body;
        const tw = Math.max(0, Number(measure(a)) || 0);
        let x0, x1;
        if (st.centre) {
            x0 = p.x - tw / 2;
            x1 = p.x + tw / 2;
        } else {
            x0 = p.x - st.dot / 2;
            x1 = p.x + st.dot / 2 + st.gap + tw;
        }
        const box = [x0 - PAD, p.y - LINE_H / 2, x1 + PAD, p.y + LINE_H / 2];
        if (box[0] < EDGE || box[2] > V.w - EDGE || box[1] < EDGE || box[3] > yMax) continue;
        const sel = a.selected === true || a.priority >= 100;
        cand.push({ a, x: p.x, y: p.y, box, sel });
    }
    cand.sort((p, q) => (q.sel - p.sel) || (q.a.priority - p.a.priority)
        || ((KIND_RANK[p.a.kind] ?? 9) - (KIND_RANK[q.a.kind] ?? 9)));
    const cap = Number.isFinite(o.cap) ? o.cap : 24;
    const out = [];
    for (const c of cand) {
        if (out.length >= cap) break;
        const b = c.box;
        let hit = false;
        for (const q of out) {
            if (b[0] < q.box[2] && b[2] > q.box[0] && b[1] < q.box[3] && b[3] > q.box[1]) { hit = true; break; }
        }
        if (!hit) out.push(c);
    }
    return out;
}

/** "#rrggbb" mixed with white: color-mix(in srgb, c p, #fff). */
function mixWhite(hex, p) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#eef3fb';
    const n = parseInt(m[1], 16);
    const ch = (v) => Math.round(v * p + 255 * (1 - p));
    return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

function fontFor(st, sel) {
    return `${sel ? 750 : st.weight} ${st.size}px ${FONT_STACK}`;
}

/**
 * Paints placed labels (CSS px coordinates; the context is already scaled to device px).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{a:any, x:number, y:number}[]} placed
 * @param {{daySky?:boolean}} [opts]
 */
export function paintLabels(ctx, placed, { daySky = false } = {}) {
    ctx.textBaseline = 'middle';
    for (const { a, x, y } of placed) {
        const st = LABEL_STYLES[a.kind] ?? LABEL_STYLES.body;
        const sel = a.selected === true || a.priority >= 100;
        const below = a.below === true;
        const dark = daySky && !below;
        ctx.save();
        ctx.globalAlpha = below ? 0.55 : a.faint === true ? 0.5 : 1;
        const c = a.color || '#ffffff';
        if (st.dot) {
            const r = st.dot / 2;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = a.kind === 'observer' ? '#ffffff' : c;
            ctx.shadowColor = a.kind === 'observer' ? 'rgba(124, 196, 255, .9)' : c;
            ctx.shadowBlur = a.kind === 'star' ? 0 : 8;
            if (a.kind === 'star') ctx.globalAlpha *= 0.75;
            ctx.fill();
            if (sel) {
                ctx.shadowBlur = 16;
                ctx.lineWidth = 2;
                ctx.strokeStyle = c;
                ctx.beginPath();
                ctx.arc(x, y, r + 3, 0, Math.PI * 2);
                ctx.stroke();
            }
            if (a.kind === 'star') ctx.globalAlpha /= 0.75;
        }
        ctx.font = (below ? 'italic ' : '') + fontFor(st, sel);
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${st.track}em`;
        let fill;
        if (dark) fill = a.kind === 'cardinal' ? '#6e3d0c' : sel ? '#070d18' : '#182538';
        else if (sel) fill = '#ffffff';
        else if (a.kind === 'body') fill = mixWhite(c, 0.38);
        else if (a.kind === 'trail') fill = mixWhite(c, 0.55);
        else if (a.kind === 'star') fill = 'rgba(222, 230, 242, .8)';
        else if (a.kind === 'constellation') fill = 'rgba(150, 178, 225, .66)';
        else if (a.kind === 'cardinal') fill = '#ffdca8';
        else fill = '#eef3fb';
        ctx.fillStyle = fill;
        ctx.shadowColor = dark ? 'rgba(255, 255, 255, .6)' : 'rgba(0, 0, 0, .9)';
        ctx.shadowBlur = dark ? 6 : 4;
        ctx.textAlign = st.centre ? 'center' : 'left';
        const tx = st.centre ? x : x + st.dot / 2 + st.gap;
        ctx.fillText(labelText(a), tx, y);
        ctx.restore();
    }
}

/**
 * @param {{getRc:()=>any, getLoop:()=>any, getFeed:()=>any, doc?:Document}} deps
 *   getters, because the render stack arrives after the actions exist
 */
export function createCapture({ getRc, getLoop, getFeed, doc = typeof document !== 'undefined' ? document : null }) {
    /**
     * Paints the label feed's labels for `camera` over a capture (device px canvas, CSS px layout).
     * @param {CanvasRenderingContext2D} ctx
     * @param {any} cam the capture camera (its projection as drawn)
     * @param {number} scale capture pixel ratio
     * @param {number} insetBottom CSS px kept for a caption
     */
    function drawLabels(ctx, cam, scale, insetBottom) {
        const feed = getFeed?.();
        const loop = getLoop?.();
        if (!feed?.anchors?.length || !cam) return;
        const o = loop?.labelOptions ?? {};
        const canvas = ctx.canvas;
        cam.updateMatrixWorld?.();
        const V = {
            mv: cam.matrixWorldInverse.elements, pm: cam.projectionMatrix.elements,
            pos: [cam.position.x, cam.position.y, cam.position.z],
            w: canvas.width / scale, h: canvas.height / scale,
        };
        const measure = (a) => {
            const st = LABEL_STYLES[a.kind] ?? LABEL_STYLES.body;
            ctx.font = fontFor(st, a.selected === true || a.priority >= 100);
            if ('letterSpacing' in ctx) ctx.letterSpacing = `${st.track}em`;
            return ctx.measureText(labelText(a)).width;
        };
        const placed = projectLabels(feed.anchors, V, {
            cap: o.cap, refrK: o.refrK, upS: o.upS, horizon: o.horizon, landscape: o.landscape, northS: o.northS, eastS: o.eastS,
            insetBottom,
        }, measure);
        ctx.save();
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        paintLabels(ctx, placed, { daySky: (o.skyLum ?? 0) >= 0.6 });
        ctx.restore();
    }

    /**
     * Renders the scene once into a new canvas.
     * @param {{width?:number, height?:number, scale?:number, labels?:boolean, insetBottom?:number}} [opts]
     *   width × height in device px (default: the screen's drawing buffer, which is then the screen
     *   frame itself, a long-exposure stack included); scale = the capture's pixel ratio (labels,
     *   lines and stars are sized for a screen of that density); insetBottom = CSS px at the bottom
     *   kept for a caption (the view centres above it and no label goes there)
     * @returns {HTMLCanvasElement|null} null without a 3D view or when the context is lost
     */
    function frame({ width, height, scale, labels = true, insetBottom = 0 } = {}) {
        const rc = getRc?.();
        const loop = getLoop?.();
        if (!rc || !loop || !doc || typeof rc.capture !== 'function') return null;
        const el = rc.renderer?.domElement;
        const W = Number.isFinite(width) && width > 0 ? width : el?.width ?? 0;
        const H = Number.isFinite(height) && height > 0 ? height : el?.height ?? 0;
        if (!(W > 0 && H > 0)) return null;
        const canvas = doc.createElement('canvas');
        let ok = false;
        try {
            rc.capture(W, H, scale ?? 1, () => { loop.redraw(); }, (src, info) => {
                canvas.width = src.width;
                canvas.height = src.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.drawImage(src, 0, 0);
                ok = true;
                if (labels) drawLabels(ctx, info.camera, info.scale, insetBottom);
            }, { insetBottom });
        } catch (err) {
            console.error('[capture] frame failed', err);
            return null;
        }
        return ok ? canvas : null;
    }

    /**
     * Starts a video session at width × height device px (rc.beginCapture). Null without a 3D view,
     * when the context is lost or a session already runs.
     * @param {{width:number, height:number, scale?:number, labels?:boolean, insetBottom?:number, stack?:boolean}} opts
     *   stack: a long exposure keeps stacking at this size
     * @returns {{canvas:HTMLCanvasElement, frame(now:number, dtMs:number):HTMLCanvasElement|null, end():void}|null}
     */
    function session({ width, height, scale = 1, labels = true, insetBottom = 0, stack = false }) {
        const rc = getRc?.();
        const loop = getLoop?.();
        if (!rc || !loop || !doc || typeof rc.beginCapture !== 'function' || typeof loop.step !== 'function') return null;
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
        if (!rc.beginCapture(width, height, s, { insetBottom, stack })) return null;
        const canvas = doc.createElement('canvas');
        let ctx = null;
        let ended = false;
        return {
            canvas,
            /** Draws the frame at `now` (the session's time base) and composites it; null on failure. */
            frame(now, dtMs) {
                if (ended || rc.lost) return null;
                let ok = false;
                try {
                    loop.step(now, dtMs, {
                        before: () => rc.captureCamera(),
                        after: (camera) => {
                            const src = rc.renderer.domElement;
                            if (canvas.width !== src.width || canvas.height !== src.height) {
                                canvas.width = src.width;
                                canvas.height = src.height;
                                ctx = null;
                            }
                            ctx ??= canvas.getContext('2d');
                            if (!ctx) return;
                            ctx.drawImage(src, 0, 0);
                            ok = true;
                            if (labels) drawLabels(ctx, camera, s, insetBottom);
                        },
                    });
                } finally {
                    rc.releaseCamera();
                }
                return ok ? canvas : null;
            },
            /** Gives the screen its size back (the loop redraws on its next frame). */
            end() {
                if (ended) return;
                ended = true;
                rc.endCapture();
            },
        };
    }

    return { frame, session };
}
