/**
 * The time-machine sky's 'Precession' layer (astro/precession.js): the pole's 25,800-year circle
 * about the ecliptic pole (illustrative, with the pole stars of other ages), its accurate track
 * over the clock's 1000–3000 with century ticks, a live crosshair on the pole of date, and the
 * March and September equinox points of date on the J2000 sky, all at infinity, refraction-lifted
 * in sky view like the stars. A RenderModule plus `anchors()` (labels-feed: the tick years, the
 * pole stars, 'Pole of date', '♈ March equinox').
 *
 * Static lines are built once; the live markers rewrite a few segments per snapshot (no allocation).
 *
 * @module render/precession
 */
import * as THREE from 'three';
import { createLineLayer } from './sky.js';
import { poleOnCircle, poleTrack, eclipticPole, POLE_STARS } from '../astro/precession.js';

const DEG = Math.PI / 180;
const CIRCLE_SEGS = 360;
const TRACK_FROM = 1000, TRACK_TO = 3000, TRACK_STEP = 20;
/** Tick half-length, radians (on the sphere). */
const TICK = 0.35 * DEG, TICK_BIG = 0.7 * DEG;
const MARK = 0.9 * DEG;
const COLOR = '#e7c98f';
const PALE = '#b9a988';

/** Writes a unit-sphere segment A→B into a line layer at index i. */
function seg(layer, i, a, b, alpha = 1, flag = 0) {
    const ab = layer.ab, st = layer.st, o = i * 6, s = i * 4;
    ab[o] = a[0]; ab[o + 1] = a[1]; ab[o + 2] = a[2]; ab[o + 3] = b[0]; ab[o + 4] = b[1]; ab[o + 5] = b[2];
    st[s] = alpha; st[s + 1] = flag; st[s + 2] = 0; st[s + 3] = 0;
}

/** p + t·u, renormalised, into out. */
function offset(p, u, t, out) {
    const x = p[0] + u[0] * t, y = p[1] + u[1] * t, z = p[2] + u[2] * t;
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return out;
}

/** A unit vector perpendicular to `p` in the plane of `p` and `q` (the track's normal direction). */
function normalTo(p, q, out) {
    // The tangent along the track is q − p; its perpendicular on the sphere is p × tangent.
    const tx = q[0] - p[0], ty = q[1] - p[1], tz = q[2] - p[2];
    const nx = p[1] * tz - p[2] * ty, ny = p[2] * tx - p[0] * tz, nz = p[0] * ty - p[1] * tx;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
}

/**
 * Creates the precession layer.
 * @param {object} rc RenderContext
 * @returns {object} RenderModule & {anchors():object[]}
 */
export function createPrecession(rc) {
    const group = new THREE.Group();
    group.name = 'precession';
    const upS = new THREE.Vector3(0, 1, 0);
    const refr = { uRefrUp: { value: upS }, uRefrK: { value: 0 } };
    const col = new THREE.Color(COLOR);
    const pale = new THREE.Color(PALE);
    const lines = createLineLayer({
        name: 'precession.lines', capacity: 600, color: [pale.r, pale.g, pale.b], alpha: 0.28, halfWidthPx: 0.6,
        renderOrder: -79, defines: { HIGHLIGHT: '' }, refraction: refr,
    });
    lines.uniforms.uHighlightColor.value.copy(col);
    lines.uniforms.uHighlightAlpha.value = 0.7;
    group.add(lines.mesh);

    const a = new Float64Array(3), b = new Float64Array(3), n = new Float64Array(3);
    let i = 0;
    // The illustrative circle (one full turn) and its millennium ticks.
    const period = 25772;
    for (let k = 0; k < CIRCLE_SEGS; k++) {
        poleOnCircle(2000 + (k / CIRCLE_SEGS) * period, a);
        poleOnCircle(2000 + ((k + 1) / CIRCLE_SEGS) * period, b);
        seg(lines, i++, a, b, 0.8, 0);
    }
    for (let y = -12000; y <= 14000; y += 1000) {
        if (y >= TRACK_FROM && y <= TRACK_TO) continue;
        poleOnCircle(y, a); poleOnCircle(y + 1, b);
        normalTo(a, b, n);
        seg(lines, i++, offset(a, n, -TICK, b), offset(a, n, TICK, new Float64Array(3)), 0.9, 0);
    }
    // The accurate track 1000–3000 (Astronomy Engine), with century ticks.
    const track = poleTrack(TRACK_FROM, TRACK_TO, TRACK_STEP);
    const nTrack = track.length / 3;
    for (let k = 0; k + 1 < nTrack; k++) {
        seg(lines, i++, track.subarray(3 * k, 3 * k + 3), track.subarray(3 * k + 3, 3 * k + 6), 1.3, 1);
    }
    const tickDir = [];
    for (let y = TRACK_FROM; y <= TRACK_TO; y += 100) {
        const k = (y - TRACK_FROM) / TRACK_STEP;
        const p = track.subarray(3 * k, 3 * k + 3);
        const q = k + 1 < nTrack ? track.subarray(3 * k + 3, 3 * k + 6) : track.subarray(3 * k - 3, 3 * k);
        normalTo(p, q, n);
        const big = y % 500 === 0;
        seg(lines, i++, offset(p, n, -(big ? TICK_BIG : TICK), a), offset(p, n, big ? TICK_BIG : TICK, b), big ? 1.3 : 1.0, 1);
        if (big) tickDir.push({ year: y, dir: Float64Array.from(offset(p, n, TICK_BIG * 1.4, a)) });
    }
    const staticCount = i;
    // Live markers: the pole of date (a cross) and the two equinox points (small crosses).
    const LIVE = 12;
    lines.setCount(staticCount + LIVE);
    lines.commit();

    // Labels (labels-feed): built once; the live ones point at vectors updated in apply().
    const poleLive = new Float64Array([0, 1, 0]);
    const marchLive = new Float64Array([1, 0, 0]);
    const septLive = new Float64Array([-1, 0, 0]);
    const anchorList = [];
    const mk = (id, text, dirS, color = COLOR, priority = 30) => ({
        id, text, kind: 'trail', priority, color, dirS, offsetPx: [6, -6], ariaLabel: text, interactive: false,
    });
    for (const t of tickDir) anchorList.push(mk(`prec:${t.year}`, String(t.year), t.dir, COLOR, 28));
    for (const s of POLE_STARS) {
        if (s.year >= TRACK_FROM && s.year <= TRACK_TO) continue;
        anchorList.push(mk(`prec:${s.name}`, `${s.label} (illustrative)`, Float64Array.from(poleOnCircle(s.year)), PALE, 26));
    }
    anchorList.push(mk('prec:ecl', 'Ecliptic pole', Float64Array.from(eclipticPole()), PALE, 24));
    anchorList.push(mk('prec:pole', 'Pole of date', poleLive, '#ffe2a8', 34));
    anchorList.push(mk('prec:march', '♈ March equinox', marchLive, '#ffe2a8', 33));
    anchorList.push(mk('prec:sept', '♎ September equinox', septLive, '#ffe2a8', 32));

    const m4 = new THREE.Matrix4(), unspin = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const bufSize = new THREE.Vector2();
    const e1 = new Float64Array(3), e2 = new Float64Array(3);
    function cross(p, k, size) {
        // Two short arcs through p, along two directions perpendicular to it.
        const ref = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        e1[0] = p[1] * ref[2] - p[2] * ref[1]; e1[1] = p[2] * ref[0] - p[0] * ref[2]; e1[2] = p[0] * ref[1] - p[1] * ref[0];
        let l = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1[0] /= l; e1[1] /= l; e1[2] /= l;
        e2[0] = p[1] * e1[2] - p[2] * e1[1]; e2[1] = p[2] * e1[0] - p[0] * e1[2]; e2[2] = p[0] * e1[1] - p[1] * e1[0];
        l = Math.hypot(e2[0], e2[1], e2[2]) || 1; e2[0] /= l; e2[1] /= l; e2[2] /= l;
        seg(lines, k, offset(p, e1, -size, a), offset(p, e1, size, b), 1.4, 1);
        seg(lines, k + 1, offset(p, e2, -size, a), offset(p, e2, size, b), 1.4, 1);
    }
    let layerOn = false;
    let lastKey = NaN;

    return {
        object3d: group,
        anchors() { return layerOn ? anchorList : []; },
        apply(snap) {
            if (!snap || !snap.observer) return;
            const o = snap.observer;
            upS.set(o.upS[0], o.upS[1], o.upS[2]);
            if (!snap.earthMatrix || !Number.isFinite(snap.gastDeg)) return;
            // S·PN·Sᵀ = earthMatrix · RotY(−GAST) (render/sky.js, the grid of date): its ŷ is the pole
            // of date and its x̂ the March equinox, both in J2000 scene coordinates.
            const key = Math.round(snap.tMs / 86400000);
            if (key === lastKey) return;
            lastKey = key;
            unspin.makeRotationY(-snap.gastDeg * DEG);
            m4.fromArray(snap.earthMatrix).multiply(unspin);
            v.set(0, 1, 0).applyMatrix4(m4).normalize();
            poleLive[0] = v.x; poleLive[1] = v.y; poleLive[2] = v.z;
            v.set(1, 0, 0).applyMatrix4(m4).normalize();
            marchLive[0] = v.x; marchLive[1] = v.y; marchLive[2] = v.z;
            septLive[0] = -v.x; septLive[1] = -v.y; septLive[2] = -v.z;
            cross(poleLive, staticCount, MARK);
            cross(marchLive, staticCount + 2, MARK * 0.8);
            cross(septLive, staticCount + 4, MARK * 0.8);
            for (let k = staticCount + 6; k < staticCount + LIVE; k++) seg(lines, k, poleLive, poleLive, 0, 0);
            lines.commit();
            rc?.invalidate?.();
        },
        update(fi) {
            if (!fi) return;
            const k = Number.isFinite(fi.skyBlend) ? Math.max(0, Math.min(1, fi.skyBlend)) : 0;
            refr.uRefrK.value = k;
            const r = rc?.renderer;
            if (r) {
                r.getDrawingBufferSize(bufSize);
                lines.setViewport(bufSize.x, bufSize.y, r.getPixelRatio());
            }
            lines.mesh.visible = layerOn;
        },
        setLayers(l) { layerOn = !!l && l.precession === true; lines.mesh.visible = layerOn; },
        setSelection() {},
        setViewMode() {},
        setQuality() {},
        dispose() { lines.dispose(); },
    };
}
