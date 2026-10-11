/**
 * Pooled DOM labels (SPEC §C.6, ADDENDUM A4).
 *
 *   createLabels(rootEl, {cap}) → { setAnchors(list), update(camera, viewport, opts), onActivate(cb) → off,
 *                                   relayout(), dispose(), visibleCount }
 *
 * Each label is `<button type="button" class="lbl lbl--{kind}" data-id aria-label style="--c:…">`
 * (or a `<span aria-hidden="true">` when not interactive) holding
 * `<span class="lbl__dot"></span><span class="lbl__text">…</span>`. This module
 * writes only `transform: translate3d(X, Y, 0)` (the anchor's screen point,
 * rounded to 0.5 px, written only when it moved more than 0.5 px) and the state
 * classes `is-selected`, `is-below`, `is-hidden`, `is-new` (first 600 ms after
 * becoming visible). Everything else is G7's CSS.
 *
 * Per rendered frame: project every anchor (a `dirS` anchor sits at infinity,
 * `camera.position + dirS`; a `posS` anchor is a world point), cull it when
 * behind the camera or hidden by the unit sphere (for a direction, the camera
 * ray along it hits the sphere; for a point, the segment from the camera hits
 * the sphere first). A label is never cut by the viewport edge or drawn under
 * UI chrome: a label box that overflows the free area (the viewport minus
 * `viewport.insets`, CSS px per edge, e.g. rc.size.insets) by at most NUDGE_MAX
 * px is nudged inside, otherwise it is hidden; a label that touches a floating
 * UI element (OCCLUDER_SELECTOR: top bar items, view bar items, time bar,
 * panel, sheet) is hidden. Those rects are re-measured at most every 500 ms
 * while rendering, on resize, and once after rendering goes idle, never per
 * frame; `uiOccluders()` shares them with beams.js so beam labels steer clear.
 * Every 100 ms a greedy rectangle declutter
 * places labels in priority order up to `cap`. Label sizes are measured once
 * per text change (batched reads, never per frame). When rendering goes idle a
 * single timer finishes any pending declutter or `is-new` removal.
 *
 * Optional anchor fields beyond the spec: `selected` (boolean; otherwise
 * priority ≥ 100 means selected), `below` (boolean), `gate` (() => boolean,
 * evaluated per frame; false hides the label). `update` also accepts
 * `opts.upS` (live observer zenith): body anchors with a `dirS` then get
 * `is-below` from the live direction, so it never goes stale between
 * setAnchors calls. A non-finite anchor position simply hides the label
 * (e.g. beams.labelAnchor before the beam has landed).
 *
 * @module render/labels
 */

const DECLUTTER_MS = 100;
const NEW_MS = 600;
const PAD = 3;            // px of breathing room between labels
const EDGE = 4;           // label boxes keep this far inside the free area
const NUDGE_MAX = 12;     // px a label may be shifted to stay inside it; beyond that it hides
/** Floating UI chrome that hides labels beneath it (G7's DOM, read-only). */
const OCCLUDER_SELECTOR = '.ui .topbar > *, .ui .viewbar > *, .ui .timebar, .ui .panel, .ui .sheet';
const OCCLUDER_MS = 500;
const OCCLUDER_MAX = 32;

/**
 * UI chrome rects in CSS px relative to the labels root (= the canvas): x0, y0, x1, y1 per
 * rect, `count` rects. Shared with beams.js; refreshed by the label pool (see module docs).
 */
const OCCLUDERS = { rects: new Float64Array(OCCLUDER_MAX * 4), count: 0 };

/**
 * The floating UI elements' rects as last measured by the label pool.
 * @returns {{rects: Float64Array, count: number}} live; do not modify
 */
export function uiOccluders() {
    return OCCLUDERS;
}

/**
 * Measured label boxes relative to their anchor point, CSS px [x0, y0, x1, y1], by label id.
 * Shared with beams.js so beam label anchors keep the measured text on screen and clear of the
 * observer's label. Written only when a label's text is (re)measured.
 * @type {Map<string, Float64Array>}
 */
const EXTENTS = new Map();

/**
 * Last measured box of a label relative to its anchor, or null before the first measurement.
 * @param {string} id
 * @returns {Float64Array|null} [x0, y0, x1, y1] in CSS px (live; do not modify)
 */
export function labelExtent(id) {
    return EXTENTS.get(id) || null;
}

// sin(−0.3°): a name whose anchor is just under the horizon line is already behind the ground.
const HORIZON_SIN = -0.005;
const KIND_RANK = { body: 0, observer: 1, cardinal: 2, trail: 3, star: 4, constellation: 5 };

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * @typedef {{ id:string, text:string, kind:'body'|'observer'|'star'|'constellation'|'cardinal'|'trail',
 *   priority:number, color?:string, dirS?:ArrayLike<number>, posS?:ArrayLike<number>, offsetPx?:[number,number],
 *   ariaLabel?:string, interactive:boolean, selected?:boolean, below?:boolean, gate?:()=>boolean }} LabelAnchor
 */

/**
 * Creates the label pool inside `rootEl` (#labels-root).
 * @param {HTMLElement} rootEl
 * @param {{cap?:number, now?:()=>number}} [opts]
 * @returns {{setAnchors(list:LabelAnchor[]):void, update(camera:object, viewport:{w:number,h:number}, opts?:{cap?:number, upS?:ArrayLike<number>}):number,
 *   onActivate(cb:(id:string)=>void):()=>void, relayout():void, dispose():void, readonly visibleCount:number}}
 */
export function createLabels(rootEl, { cap = 24, now = nowMs } = {}) {
    const doc = rootEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    /** @type {Map<string, object>} */
    const items = new Map();
    /** Items in priority order (rebuilt on setAnchors only). */
    let order = [];
    const pool = { button: [], span: [] };
    const activateCbs = new Set();
    let defaultCap = Number.isFinite(cap) ? cap : 24;
    let lastDeclutter = -Infinity;
    let declutterDue = true;
    let measureDirty = false;
    let visibleCount = 0;
    let disposed = false;
    let timer = 0;
    /** Last update arguments, so the idle timer can finish pending work. */
    let lastCam = null;
    const lastVp = { w: 0, h: 0, insets: null };
    let lastOpts = null;
    let horizonOn = false;   // sky view: hide star/constellation names below the horizon
    // Placed rectangles for the greedy declutter (x0, y0, x1, y1 per label).
    let rects = new Float64Array(4 * 64);
    const M = new Float64Array(16);
    const PM = new Float64Array(16);
    // Free area (CSS px) for the current update: viewport minus UI insets and EDGE.
    let fx0 = 0, fy0 = 0, fx1 = 1, fy1 = 1;
    // UI chrome measurement bookkeeping (OCCLUDERS).
    let occAt = -Infinity;
    let occDirty = true;
    let lastFrameT = -Infinity;

    // ---- DOM helpers ---------------------------------------------------------------------------

    function makeEl(tag) {
        const el = doc.createElement(tag);
        if (tag === 'button') el.type = 'button';
        else el.setAttribute('aria-hidden', 'true');
        const dot = doc.createElement('span');
        dot.className = 'lbl__dot';
        const text = doc.createElement('span');
        text.className = 'lbl__text';
        el.append(dot, text);
        return { el, dot, textEl: text };
    }

    function acquire(tag) {
        const p = pool[tag];
        const node = p.length ? p.pop() : makeEl(tag);
        rootEl.appendChild(node.el);
        return node;
    }

    function release(it) {
        EXTENTS.delete(it.id);
        it.node.el.remove();
        it.node.el.removeAttribute('data-id');
        pool[it.tag].push(it.node);
    }

    function applyAnchorToEl(it, a) {
        const el = it.node.el;
        el.className = `lbl lbl--${it.kind} is-hidden`;
        el.setAttribute('data-id', it.id);
        it.shown = false;
        it.isNew = false;
        it.sel = false;
        it.below = false;
        // A pooled element keeps its last transform; park it at the origin so the first
        // measurement (relative to wx, wy) is right.
        el.style.transform = 'translate3d(0px, 0px, 0)';
        it.wx = 0;
        it.wy = 0;
        syncAttrs(it, a, true);
    }

    function syncAttrs(it, a, force) {
        const el = it.node.el;
        const text = String(a.text ?? '');
        if (force || text !== it.text) {
            it.text = text;
            it.node.textEl.textContent = text;
            it.measured = false;
            measureDirty = true;
        }
        if (it.tag === 'button') {
            const aria = String(a.ariaLabel ?? text);
            if (force || aria !== it.aria) {
                it.aria = aria;
                el.setAttribute('aria-label', aria);
            }
        }
        const color = a.color ? String(a.color) : '';
        if (force || color !== it.color) {
            it.color = color;
            if (color) el.style.setProperty('--c', color);
            else el.style.removeProperty('--c');
        }
    }

    // ---- anchors ---------------------------------------------------------------------------------

    /**
     * Replaces the anchor set. Elements are reused by id; text, aria-label and
     * colour are only written when they change.
     * @param {LabelAnchor[]} list
     */
    function setAnchors(list) {
        if (disposed || !doc) return;
        const seen = new Set();
        const next = [];
        if (Array.isArray(list)) {
            for (let k = 0; k < list.length; k++) {
                const a = list[k];
                if (!a || a.id == null || seen.has(String(a.id))) continue;
                if (!a.dirS && !a.posS) continue;
                const id = String(a.id);
                seen.add(id);
                const kind = KIND_RANK[a.kind] !== undefined ? a.kind : 'star';
                const tag = a.interactive ? 'button' : 'span';
                let it = items.get(id);
                if (it && (it.tag !== tag || it.kind !== kind)) {
                    release(it);
                    items.delete(id);
                    it = null;
                }
                if (!it) {
                    it = {
                        id, kind, tag, node: acquire(tag), anchor: a, seq: k,
                        text: null, aria: null, color: null,
                        rx0: -4, ry0: -9, rx1: 40, ry1: 9, measured: false,
                        sx: 0, sy: 0, ok: false, placed: false,
                        shown: false, isNew: false, newUntil: 0, sel: false, below: false, wx: NaN, wy: NaN,
                    };
                    items.set(id, it);
                    applyAnchorToEl(it, a);
                } else {
                    it.anchor = a;
                    it.seq = k;
                    syncAttrs(it, a, false);
                }
                next.push(it);
            }
        }
        for (const [id, it] of items) {
            if (!seen.has(id)) {
                release(it);
                items.delete(id);
            }
        }
        next.sort((p, q) => (q.anchor.priority || 0) - (p.anchor.priority || 0)
            || KIND_RANK[p.kind] - KIND_RANK[q.kind] || p.seq - q.seq);
        order = next;
        if (rects.length < order.length * 4) rects = new Float64Array(order.length * 4 + 64);
        declutterDue = true;
        schedule();
    }

    // ---- measurement -------------------------------------------------------------------------------

    /** Reads label boxes relative to their anchor point (batched; only for changed text). */
    function measure() {
        measureDirty = false;
        let rootRect = null;
        for (let i = 0; i < order.length; i++) {
            const it = order[i];
            if (it.measured) continue;
            if (!rootRect) rootRect = rootEl.getBoundingClientRect();
            const ax = rootRect.left + (Number.isFinite(it.wx) ? it.wx : 0);
            const ay = rootRect.top + (Number.isFinite(it.wy) ? it.wy : 0);
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            const n = it.node;
            for (const el of [n.el, n.dot, n.textEl]) {
                const r = el.getBoundingClientRect();
                if (!(r.width > 0 || r.height > 0)) continue;
                if (r.left < x0) x0 = r.left;
                if (r.top < y0) y0 = r.top;
                if (r.right > x1) x1 = r.right;
                if (r.bottom > y1) y1 = r.bottom;
            }
            if (x1 > x0 && y1 > y0 && x1 - x0 < 2000) {
                it.rx0 = x0 - ax;
                it.ry0 = y0 - ay;
                it.rx1 = x1 - ax;
                it.ry1 = y1 - ay;
                it.measured = true;
                let ext = EXTENTS.get(it.id);
                if (!ext) EXTENTS.set(it.id, ext = new Float64Array(4));
                ext[0] = it.rx0; ext[1] = it.ry0; ext[2] = it.rx1; ext[3] = it.ry1;
            } else {
                // Not laid out yet (stylesheet still loading): estimate and retry later.
                const len = it.text ? it.text.length : 4;
                it.rx0 = -4;
                it.ry0 = -9;
                it.rx1 = 12 + 7 * len;
                it.ry1 = 9;
                measureDirty = true;
            }
        }
    }

    /**
     * Re-reads the floating UI elements' rects into OCCLUDERS (layout read; at most every
     * OCCLUDER_MS while rendering, never per frame). Hidden chrome (cinema mode) is skipped.
     */
    function refreshOccluders(t) {
        occAt = t;
        occDirty = false;
        OCCLUDERS.count = 0;
        let list = null;
        try { list = doc.querySelectorAll(OCCLUDER_SELECTOR); } catch { list = null; }
        if (!list || !list.length) return;
        const view = doc.defaultView;
        const rr = rootEl.getBoundingClientRect();
        const oc = OCCLUDERS.rects;
        let n = 0;
        for (let k = 0; k < list.length && n < OCCLUDER_MAX; k++) {
            const el = list[k];
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            const cs = view?.getComputedStyle?.(el);
            if (cs && (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0)) continue;
            const o = n * 4;
            oc[o] = r.left - rr.left;
            oc[o + 1] = r.top - rr.top;
            oc[o + 2] = r.right - rr.left;
            oc[o + 3] = r.bottom - rr.top;
            n++;
        }
        OCCLUDERS.count = n;
    }

    /** Forces every label to be re-measured (fonts loaded, stylesheet changed, resize). */
    function relayout() {
        for (const it of items.values()) it.measured = false;
        occDirty = true;
        measureDirty = true;
        declutterDue = true;
        schedule();
    }

    // ---- projection ---------------------------------------------------------------------------------

    /**
     * Projects one item and sets it.ok/sx/sy. No allocation.
     * @returns {boolean}
     */
    function project(it, cx, cy, cz, w, h, upS) {
        const a = it.anchor;
        it.ok = false;
        if (typeof a.gate === 'function') {
            let pass = true;
            try { pass = a.gate() !== false; } catch { pass = false; }
            if (!pass) return false;
        }
        let X, Y, W;
        if (a.posS) {
            const px = a.posS[0], py = a.posS[1], pz = a.posS[2];
            if (!(Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz))) return false;
            const vx = M[0] * px + M[4] * py + M[8] * pz + M[12];
            const vy = M[1] * px + M[5] * py + M[9] * pz + M[13];
            const vz = M[2] * px + M[6] * py + M[10] * pz + M[14];
            X = PM[0] * vx + PM[4] * vy + PM[8] * vz + PM[12];
            Y = PM[1] * vx + PM[5] * vy + PM[9] * vz + PM[13];
            W = PM[3] * vx + PM[7] * vy + PM[11] * vz + PM[15];
            if (!(W > 1e-6)) return false;
            if (segmentHitsSphere(cx, cy, cz, px, py, pz)) return false;
        } else {
            const d = a.dirS;
            const dx = d[0], dy = d[1], dz = d[2];
            if (!(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz))) return false;
            const vx = M[0] * dx + M[4] * dy + M[8] * dz;
            const vy = M[1] * dx + M[5] * dy + M[9] * dz;
            const vz = M[2] * dx + M[6] * dy + M[10] * dz;
            X = PM[0] * vx + PM[4] * vy + PM[8] * vz;
            Y = PM[1] * vx + PM[5] * vy + PM[9] * vz;
            W = PM[3] * vx + PM[7] * vy + PM[11] * vz;
            if (!(W > 1e-6)) return false;
            if (rayHitsSphere(cx, cy, cz, dx, dy, dz)) return false;
            // Sky view: the ground hides everything below the horizon, so do the names of stars
            // and constellations there (bodies keep theirs, marked is-below).
            if (horizonOn && upS && (it.kind === 'star' || it.kind === 'constellation')
                && dx * upS[0] + dy * upS[1] + dz * upS[2] < HORIZON_SIN) return false;
        }
        const off = a.offsetPx;
        const sx = (X / W * 0.5 + 0.5) * w + (off ? off[0] || 0 : 0);
        const sy = (0.5 - Y / W * 0.5) * h + (off ? off[1] || 0 : 0);
        if (!(Number.isFinite(sx) && Number.isFinite(sy))) return false;
        // Keep the whole box inside the free area: nudge a little, or hide.
        let nx = 0, ny = 0;
        if (sx + it.rx0 < fx0) nx = fx0 - (sx + it.rx0);
        else if (sx + it.rx1 > fx1) nx = fx1 - (sx + it.rx1);
        if (sy + it.ry0 < fy0) ny = fy0 - (sy + it.ry0);
        else if (sy + it.ry1 > fy1) ny = fy1 - (sy + it.ry1);
        if (nx > NUDGE_MAX || nx < -NUDGE_MAX || ny > NUDGE_MAX || ny < -NUDGE_MAX) return false;
        const qx = sx + nx, qy = sy + ny;
        // Larger than the free area itself (tiny viewport, tall sheet): hide.
        if (qx + it.rx0 < fx0 - 0.5 || qx + it.rx1 > fx1 + 0.5 || qy + it.ry0 < fy0 - 0.5 || qy + it.ry1 > fy1 + 0.5) return false;
        // Under floating UI chrome: hidden.
        const oc = OCCLUDERS.rects;
        for (let k = 0, n = OCCLUDERS.count * 4; k < n; k += 4) {
            if (qx + it.rx0 < oc[k + 2] && qx + it.rx1 > oc[k] && qy + it.ry0 < oc[k + 3] && qy + it.ry1 > oc[k + 1]) return false;
        }
        it.sx = qx;
        it.sy = qy;
        // Live below-horizon state for bodies (opts.upS), else the anchor's static flag.
        if (upS && a.dirS && it.kind === 'body') {
            it.belowNow = a.dirS[0] * upS[0] + a.dirS[1] * upS[1] + a.dirS[2] * upS[2] < 0;
        } else {
            it.belowNow = a.below === true;
        }
        it.ok = true;
        return true;
    }

    // ---- declutter ---------------------------------------------------------------------------------------

    function declutter(w, h, capNow) {
        let n = 0;
        for (let i = 0; i < order.length; i++) {
            const it = order[i];
            it.placed = false;
            if (!it.ok || n >= capNow) continue;
            const x0 = it.sx + it.rx0 - PAD, y0 = it.sy + it.ry0 - PAD;
            const x1 = it.sx + it.rx1 + PAD, y1 = it.sy + it.ry1 + PAD;
            let free = true;
            for (let k = 0; k < n; k++) {
                const o = k * 4;
                if (x0 < rects[o + 2] && x1 > rects[o] && y0 < rects[o + 3] && y1 > rects[o + 1]) { free = false; break; }
            }
            if (!free) continue;
            const o = n * 4;
            rects[o] = x0; rects[o + 1] = y0; rects[o + 2] = x1; rects[o + 3] = y1;
            n++;
            it.placed = true;
        }
    }

    // ---- per-frame update -----------------------------------------------------------------------------

    /**
     * Projects, culls, declutters (every 100 ms) and writes transforms/classes.
     * Call after rendering, with the camera used for the frame.
     * @param {object} camera THREE.PerspectiveCamera (matrices current)
     * @param {{w:number, h:number, insets?:{left?:number, right?:number, top?:number, bottom?:number}}} viewport
     *   CSS px of #labels-root / the canvas; `insets` is the UI-covered band on each edge
     * @param {{cap?:number, upS?:ArrayLike<number>, horizon?:boolean}} [opts] `horizon`: sky view, hide
     *   star and constellation names below the horizon
     * @returns {number} labels visible after this update
     */
    function update(camera, viewport, opts) {
        return run(camera, viewport, opts, false);
    }

    /** One pass; `idle` is true for the trailing timer pass after frames stopped. */
    function run(camera, viewport, opts, idle) {
        if (disposed || !camera || !doc) return 0;
        lastCam = camera;
        const w = Number(viewport?.w ?? viewport?.width) || rootEl.clientWidth || 1;
        const h = Number(viewport?.h ?? viewport?.height) || rootEl.clientHeight || 1;
        lastVp.w = w;
        lastVp.h = h;
        const ins = viewport?.insets;
        lastVp.insets = ins || null;
        fx0 = (ins ? Math.max(0, ins.left || 0) : 0) + EDGE;
        fy0 = (ins ? Math.max(0, ins.top || 0) : 0) + EDGE;
        fx1 = w - (ins ? Math.max(0, ins.right || 0) : 0) - EDGE;
        fy1 = h - (ins ? Math.max(0, ins.bottom || 0) : 0) - EDGE;
        lastOpts = opts || null;
        const capNow = Number.isFinite(opts?.cap) ? opts.cap : defaultCap;
        const upS = opts?.upS || null;
        horizonOn = opts?.horizon === true;
        const t = now();
        if (!idle) lastFrameT = t;
        // UI chrome rects: on demand, every OCCLUDER_MS, and once more after a burst of frames.
        if (occDirty || t - occAt >= OCCLUDER_MS || (idle && occAt < lastFrameT)) refreshOccluders(t);

        const mw = camera.matrixWorldInverse.elements;
        const pm = camera.projectionMatrix.elements;
        for (let k = 0; k < 16; k++) { M[k] = mw[k]; PM[k] = pm[k]; }
        const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

        let becameOk = false;
        for (let i = 0; i < order.length; i++) {
            const it = order[i];
            const was = it.ok;
            project(it, cx, cy, cz, w, h, upS);
            if (it.ok && !was) becameOk = true;
        }
        if (measureDirty) measure();
        if (becameOk) declutterDue = true;
        // A frame between declutters reuses the last placement; the idle timer then runs a
        // trailing declutter, so the layout a moving camera comes to rest on is never stale.
        let stale = false;
        if (declutterDue || t - lastDeclutter >= DECLUTTER_MS) {
            declutter(w, h, capNow);
            lastDeclutter = t;
            declutterDue = false;
        } else {
            stale = true;
        }

        // DOM writes.
        let count = 0;
        let pendingNew = false;
        for (let i = 0; i < order.length; i++) {
            const it = order[i];
            const el = it.node.el;
            const vis = it.ok && it.placed;
            if (vis) {
                count++;
                const rx = Math.round(it.sx * 2) / 2;
                const ry = Math.round(it.sy * 2) / 2;
                if (!(Math.abs(rx - it.wx) <= 0.5 && Math.abs(ry - it.wy) <= 0.5)) {
                    el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
                    it.wx = rx;
                    it.wy = ry;
                }
                if (!it.shown) {
                    el.classList.remove('is-hidden');
                    el.classList.add('is-new');
                    it.shown = true;
                    it.isNew = true;
                    it.newUntil = t + NEW_MS;
                }
                const sel = it.anchor.selected === true || (it.anchor.selected !== false && (it.anchor.priority || 0) >= 100);
                if (sel !== it.sel) {
                    el.classList.toggle('is-selected', sel);
                    it.sel = sel;
                }
                if (it.belowNow !== it.below) {
                    el.classList.toggle('is-below', !!it.belowNow);
                    it.below = !!it.belowNow;
                }
            } else if (it.shown) {
                el.classList.add('is-hidden');
                it.shown = false;
            }
            if (it.isNew) {
                if (t >= it.newUntil || !it.shown) {
                    el.classList.remove('is-new');
                    it.isNew = false;
                } else {
                    pendingNew = true;
                }
            }
        }
        visibleCount = count;
        if (pendingNew || measureDirty || stale || (!idle && occAt < t)) schedule();
        return count;
    }

    /** One idle timer finishes a pending declutter / is-new removal when frames stop. */
    function schedule() {
        if (timer || disposed || typeof setTimeout !== 'function') return;
        timer = setTimeout(() => {
            timer = 0;
            if (lastCam) run(lastCam, lastVp, lastOpts || undefined, now() - lastFrameT >= DECLUTTER_MS);
        }, DECLUTTER_MS + 20);
    }

    // ---- activation (event delegation) ------------------------------------------------------------------

    const onClick = (e) => {
        const t = e.target;
        const el = t && typeof t.closest === 'function' ? t.closest('.lbl[data-id]') : null;
        if (!el || el.tagName !== 'BUTTON' || !rootEl.contains(el)) return;
        const id = el.getAttribute('data-id');
        for (const cb of activateCbs) {
            try { cb(id); } catch (err) { setTimeout(() => { throw err; }); }
        }
    };
    rootEl?.addEventListener('click', onClick);

    const onResize = () => relayout();
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
    try {
        doc?.fonts?.ready?.then(() => { if (!disposed) relayout(); });
    } catch { /* FontFaceSet unsupported */ }

    return {
        setAnchors,
        update,
        /**
         * Registers a callback for label activation (click / Enter / Space on an interactive label).
         * @param {(id:string)=>void} cb
         * @returns {()=>void} off
         */
        onActivate(cb) {
            activateCbs.add(cb);
            return () => activateCbs.delete(cb);
        },
        relayout,
        /** Sets the default cap used when update() gets no opts.cap. */
        setCap(n) {
            if (Number.isFinite(n)) defaultCap = n;
            declutterDue = true;
        },
        get visibleCount() { return visibleCount; },
        dispose() {
            disposed = true;
            if (timer) clearTimeout(timer);
            rootEl?.removeEventListener('click', onClick);
            if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
            for (const it of items.values()) {
                EXTENTS.delete(it.id);
                it.node.el.remove();
            }
            items.clear();
            order = [];
            pool.button.length = 0;
            pool.span.length = 0;
            activateCbs.clear();
        },
    };
}

/** Ray from the camera along a unit direction hits the unit sphere (in front of the camera). */
function rayHitsSphere(cx, cy, cz, dx, dy, dz) {
    const c = cx * cx + cy * cy + cz * cz - 1;
    if (c <= 0) return true; // camera inside the Earth: everything is hidden
    const b = cx * dx + cy * dy + cz * dz;
    if (b >= 0) return false; // pointing away from the sphere
    return b * b - c > 0;
}

/** Segment from the camera to P passes through the unit sphere before reaching P. */
function segmentHitsSphere(cx, cy, cz, px, py, pz) {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const L = Math.hypot(dx, dy, dz);
    if (!(L > 0)) return false;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    const c = cx * cx + cy * cy + cz * cz - 1;
    if (c <= 0) return false;
    const b = cx * ux + cy * uy + cz * uz;
    const disc = b * b - c;
    if (disc <= 0) return false;
    const t0 = -b - Math.sqrt(disc);
    // Surface points (the observer) hit at t0 ≈ L: a relative tolerance keeps them visible.
    return t0 > 0 && t0 < L - Math.max(1e-4, L * 1e-4);
}
