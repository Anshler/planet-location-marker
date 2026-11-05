/**
 * The angle ruler (ROADMAP angle-ruler-and-fists). In sky view, tap two things (a body, a bright
 * star or any point of the sky) and a great-circle arc joins them, labelled with the angle and the
 * hands at arm's length that cover it ('11.9° · about 1 fist'). A third tap starts a new measure.
 * An end on a body follows it as time runs; an end on a star or on empty sky stays put among the
 * stars. The angle is taken between the drawn (refracted) places, which is what a hand held up to
 * the real sky measures; refraction changes it by at most ~0.5°, near the horizon.
 *
 * Fixed buffers (R5): the arc is ARC_SEGS segments and each end a RING_SEGS-segment ring of
 * RING_PX on screen, rewritten in place when an end moves or the zoom changes. The label is one
 * LabelAnchor (kind 'ruler', the labels feed appends `anchors()`), at the arc's midpoint.
 *
 *   createRuler(rc, {onChange}) → RenderModule & { tap(end), clear(), reading(), anchors() }
 *   end: {kind:'body'|'star'|'point', id:string|null, name:string|null, dir:ArrayLike<number>} (scene frame, true direction)
 *
 * @module render/ruler
 */
import * as THREE from 'three';
import { createLineLayer } from './sky.js';
import { BODY_INDEX } from '../astro/bodies.js';
import { liftByRefraction } from '../astro/photometry.js';
import { vectorAngleDeg, rulerText, handSpan, fmtAngle } from '../astro/sky-guide.js';
import { t, N_ } from '../core/i18n.js';

const ARC_SEGS = 64;
const RING_SEGS = 20;
const RING_PX = 9;
const COLOR = [1.0, 0.8, 0.42];
const COLOR_HEX = '#ffcc6b';

function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
    return v;
}

/**
 * Creates the ruler.
 * @param {object} rc RenderContext
 * @param {{onChange?:(reading:{from:string|null, to:string|null, deg:number|null, text:string, ends:number})=>void}} [deps]
 *   onChange: an end was set, or the rounded reading changed
 * @returns {object} RenderModule & {tap(end:object):void, clear():void, reading():object, anchors():object[]}
 */
export function createRuler(rc, deps = {}) {
    const group = new THREE.Group();
    group.name = 'ruler';
    const refr = { uRefrUp: { value: new THREE.Vector3(0, 1, 0) }, uRefrK: { value: 1 } };
    const lines = createLineLayer({
        name: 'ruler.lines', capacity: ARC_SEGS + 2 * RING_SEGS, color: COLOR, alpha: 0.95, halfWidthPx: 1.0,
        renderOrder: -58, refraction: refr,
    });
    group.add(lines.mesh);
    group.visible = false;

    const ends = [0, 1].map(() => ({ kind: 'none', id: null, name: null, dir: new Float64Array([1, 0, 0]), index: -1 }));
    let count = 0;
    const up = new Float64Array([0, 1, 0]);
    const mid = new Float64Array([NaN, NaN, NaN]);
    const A = new Float64Array(3), B = new Float64Array(3), P = new Float64Array(3), Q = new Float64Array(3);
    const U = new Float64Array(3), V = new Float64Array(3);
    let deg = NaN;
    let text = '';
    let ringRad = NaN;
    let geomDirty = true;
    const tmpSize = new THREE.Vector2();
    const anchor = {
        id: 'ruler', text: '', kind: 'ruler', priority: 98, color: COLOR_HEX, dirS: mid, offsetPx: [0, -2],
        ariaLabel: '', interactive: false,
    };
    const anchorList = [anchor];
    const none = [];

    function nameOf(e) {
        return e.name || (e.kind === 'point' ? N_('a point') : '');
    }

    function reading() {
        return {
            from: count > 0 ? nameOf(ends[0]) : null,
            to: count > 1 ? nameOf(ends[1]) : null,
            deg: count > 1 && Number.isFinite(deg) ? Math.round(deg * 100) / 100 : null,
            text: count > 1 ? text : '',
            fists: count > 1 ? handSpan(deg) : '',
            ends: count,
        };
    }

    function notify() {
        try { deps.onChange?.(reading()); } catch (err) { console.error('[ruler] onChange failed', err); }
    }

    /** The angle between the drawn places; true when the shown reading changed. */
    function measure() {
        if (count < 2) {
            deg = NaN;
            const changed = text !== '';
            text = '';
            return changed;
        }
        // The label's place: the arc's midpoint (true directions, like the arc).
        const a = ends[0].dir, b = ends[1].dir;
        mid[0] = a[0] + b[0]; mid[1] = a[1] + b[1]; mid[2] = a[2] + b[2];
        if (Math.hypot(mid[0], mid[1], mid[2]) > 1e-9) norm(mid);
        liftByRefraction(a, up, 1, P);
        liftByRefraction(b, up, 1, Q);
        deg = vectorAngleDeg(P, Q);
        const next = rulerText(deg);
        if (next === text) return false;
        text = next;
        anchor.text = next;
        anchor.ariaLabel = t('{from} to {to}: {angle}, about {span} at arm’s length', { from: t(nameOf(ends[0])), to: t(nameOf(ends[1])), angle: fmtAngle(deg), span: handSpan(deg) });
        return true;
    }

    let n = 0;
    /** Writes segment n (p → q) and advances. */
    function seg(p, q) {
        const ab = lines.ab, st = lines.st, o = n * 6, s = n * 4;
        ab[o] = p[0]; ab[o + 1] = p[1]; ab[o + 2] = p[2];
        ab[o + 3] = q[0]; ab[o + 4] = q[1]; ab[o + 5] = q[2];
        st[s] = 1; st[s + 1] = 0; st[s + 2] = 0; st[s + 3] = 0;
        n++;
    }

    /** Arc and end rings into the line buffer (true directions; the shader lifts them). */
    function rebuild() {
        geomDirty = false;
        n = 0;
        if (count >= 2) {
            A.set(ends[0].dir);
            B.set(ends[1].dir);
            const ang = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
            const s = Math.sin(ang);
            P.set(A);
            for (let k = 1; k <= ARC_SEGS; k++) {
                const f = k / ARC_SEGS;
                if (s > 1e-9) {
                    const wa = Math.sin((1 - f) * ang) / s, wb = Math.sin(f * ang) / s;
                    for (let c = 0; c < 3; c++) Q[c] = A[c] * wa + B[c] * wb;
                } else {
                    for (let c = 0; c < 3; c++) Q[c] = A[c] + (B[c] - A[c]) * f;
                }
                norm(Q);
                seg(P, Q);
                P.set(Q);
            }
        }
        const r = Number.isFinite(ringRad) ? Math.tan(ringRad) : 0;
        for (let e = 0; e < count && r > 0; e++) {
            const c = ends[e].dir;
            // Tangent basis at the end: U = c × Y (c × X near the poles), V = c × U.
            if (Math.abs(c[1]) < 0.9) { U[0] = -c[2]; U[1] = 0; U[2] = c[0]; } else { U[0] = 0; U[1] = c[2]; U[2] = -c[1]; }
            norm(U);
            V[0] = c[1] * U[2] - c[2] * U[1]; V[1] = c[2] * U[0] - c[0] * U[2]; V[2] = c[0] * U[1] - c[1] * U[0];
            for (let k = 0; k < RING_SEGS; k++) {
                const a0 = (k / RING_SEGS) * 2 * Math.PI, a1 = ((k + 1) / RING_SEGS) * 2 * Math.PI;
                for (let j = 0; j < 3; j++) {
                    P[j] = c[j] + r * (Math.cos(a0) * U[j] + Math.sin(a0) * V[j]);
                    Q[j] = c[j] + r * (Math.cos(a1) * U[j] + Math.sin(a1) * V[j]);
                }
                seg(norm(P), norm(Q));
            }
        }
        lines.setCount(n);
        lines.commit();
    }

    /**
     * Sets the next end: the first of a new measure, or the second of this one.
     * @param {{kind:'body'|'star'|'point', id?:string|null, name?:string|null, dir:ArrayLike<number>}} end
     */
    function tap(end) {
        if (!end || !end.dir || !(Math.hypot(end.dir[0], end.dir[1], end.dir[2]) > 0)) return;
        if (count >= 2) count = 0;
        const e = ends[count];
        e.kind = end.kind === 'body' || end.kind === 'star' ? end.kind : 'point';
        e.id = end.id ?? null;
        e.name = end.name ?? null;
        e.index = e.kind === 'body' && Object.hasOwn(BODY_INDEX, e.id) ? BODY_INDEX[e.id] : -1;
        e.dir[0] = end.dir[0]; e.dir[1] = end.dir[1]; e.dir[2] = end.dir[2];
        norm(e.dir);
        count++;
        measure();
        geomDirty = true;
        group.visible = true;
        notify();
        rc?.invalidate?.();
    }

    function clear() {
        const had = count > 0;
        count = 0;
        measure();
        anchor.text = '';
        geomDirty = true;
        group.visible = false;
        lines.setCount(0);
        if (had) notify();
        rc?.invalidate?.();
    }

    function apply(snap) {
        if (!snap || !snap.observer) return;
        const u = snap.observer.upS;
        up[0] = u[0]; up[1] = u[1]; up[2] = u[2];
        refr.uRefrUp.value.set(u[0], u[1], u[2]);
        if (!count) return;
        // Ends on bodies follow them.
        let moved = false;
        for (let e = 0; e < count; e++) {
            const end = ends[e];
            if (end.index < 0) continue;
            const d = snap.bodies[end.index]?.dirS;
            if (!d) continue;
            if (Math.abs(d[0] - end.dir[0]) + Math.abs(d[1] - end.dir[1]) + Math.abs(d[2] - end.dir[2]) < 1e-9) continue;
            end.dir[0] = d[0]; end.dir[1] = d[1]; end.dir[2] = d[2];
            moved = true;
        }
        if (moved) geomDirty = true;
        if (measure()) notify();
    }

    function update(fi) {
        if (!count || !fi) {
            group.visible = false;
            return;
        }
        group.visible = fi.viewMode === 'sky';
        if (!group.visible) return;
        refr.uRefrK.value = Math.min(1, Math.max(0, fi.skyBlend));
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }
        lines.setViewport(w, h, dpr);
        // Rings keep RING_PX on screen at any zoom.
        const pm = fi.camera && fi.camera.projectionMatrix.elements;
        const cssH = rc.size && rc.size.h > 0 ? rc.size.h : h / dpr;
        const pxPerRad = pm ? 0.5 * cssH * pm[5] : 1000;
        const want = RING_PX / Math.max(1, pxPerRad);
        if (!Number.isFinite(ringRad) || Math.abs(want - ringRad) > 0.02 * ringRad) {
            ringRad = want;
            geomDirty = true;
        }
        if (geomDirty) rebuild();
    }

    return {
        object3d: group,
        tap,
        clear,
        reading,
        /** The ruler's label (kind 'ruler') while two ends are set; empty otherwise. */
        anchors() { return count >= 2 && text ? anchorList : none; },
        apply,
        update,
        setViewMode(mode) { if (mode !== 'sky') group.visible = false; },
        dispose() { lines.dispose(); },
    };
}
