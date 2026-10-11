/**
 * Apparent path ("trail") of the selected body among the stars (G5, SPEC C.7, SHOULD).
 *
 * Draws the geocentric path from astro/paths.apparentPath (typically ±180 days, daily samples) at
 * infinity: the part before the current time is dimmer and dashed, both ends fade out, a short
 * tick crosses the path at the start of every month, and ring markers sit on the stationary points
 * where retrograde motion begins and ends. `anchors()` gives the label pool those stations and the
 * month ticks (kind 'trail').
 */
import * as THREE from 'three';
import { createLineLayer } from './sky.js';
import { bodyById } from '../astro/bodies.js';

const DEG = Math.PI / 180;
const TICK_HALF_RAD = 0.55 * DEG;
const RING_RAD = 0.75 * DEG;
const RING_SEGS = 16;
const MAX_POINTS = 4096;

let dateFmt = null;
let monthFmt = null;
function fmtDate(ms) {
    try {
        dateFmt ??= new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        return dateFmt.format(ms);
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}
function fmtMonth(ms, withYear) {
    try {
        monthFmt ??= new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
        const m = monthFmt.format(ms);
        return withYear ? `${m} ${new Date(ms).getUTCFullYear()}` : m;
    } catch {
        return new Date(ms).toISOString().slice(0, 7);
    }
}

function normalize3(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
    return v;
}

/**
 * Creates the trails module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @returns {object} RenderModule & {show(path, stations, colorHex), clear(), anchors():object[]}
 */
export function createTrails(rc) {
    const group = new THREE.Group();
    group.name = 'trails';
    const path = createLineLayer({
        name: 'trails.path', capacity: 400, color: [1, 1, 1], alpha: 0.85, halfWidthPx: 0.9,
        renderOrder: -60, defines: { TRAIL: '' },
    });
    const marks = createLineLayer({
        name: 'trails.marks', capacity: 512, color: [1, 1, 1], alpha: 0.75, halfWidthPx: 0.75, renderOrder: -60,
    });
    group.add(path.mesh, marks.mesh);

    let enabled = true;
    let has = false;
    let tMs = new Float64Array(0);
    let count = 0;
    let list = [];
    const tmpSize = new THREE.Vector2();

    /** Unit direction at time t (linear in the samples, renormalised), into out. */
    function dirAt(dirS, t, out) {
        let lo = 0, hi = count - 1;
        if (t <= tMs[0]) lo = hi = 0;
        else if (t >= tMs[count - 1]) lo = hi = count - 1;
        else {
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tMs[mid] <= t) lo = mid; else hi = mid; }
        }
        const f = hi === lo ? 0 : (t - tMs[lo]) / (tMs[hi] - tMs[lo]);
        for (let k = 0; k < 3; k++) out[k] = dirS[lo * 3 + k] + (dirS[hi * 3 + k] - dirS[lo * 3 + k]) * f;
        return normalize3(out);
    }

    /** Fractional sample index of time t (−1 before the path, count−1+ after it). */
    function indexAt(t) {
        if (!count) return -1;
        if (t < tMs[0]) return -1;
        if (t >= tMs[count - 1]) return count - 1 + (t - tMs[count - 1]) / 864e5;
        let lo = 0, hi = count - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tMs[mid] <= t) lo = mid; else hi = mid; }
        return lo + (t - tMs[lo]) / (tMs[hi] - tMs[lo]);
    }

    /**
     * Shows a path. Allocation happens here (on demand), never per frame.
     * @param {{tMs:Float64Array, dirS:Float32Array|Float64Array, bodyId?:string}} p apparentPath() result
     * @param {Array<{tMs:number, kind:string, dirS:number[]}>} stations stationaryPoints() result
     * @param {string|number} [colorHex] body colour (default: the colour of p.bodyId)
     */
    function show(p, stations, colorHex) {
        clear();
        if (!p || !p.tMs || !p.dirS || p.tMs.length < 2) return;
        // Decimate very long paths so the buffers stay bounded.
        const n0 = p.tMs.length;
        const step = Math.max(1, Math.ceil(n0 / MAX_POINTS));
        count = Math.floor((n0 - 1) / step) + 1;
        tMs = new Float64Array(count);
        const dirS = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            const j = i * step;
            tMs[i] = p.tMs[j];
            const x = p.dirS[j * 3], y = p.dirS[j * 3 + 1], z = p.dirS[j * 3 + 2];
            const l = Math.hypot(x, y, z) || 1;
            dirS[i * 3] = x / l; dirS[i * 3 + 1] = y / l; dirS[i * 3 + 2] = z / l;
        }
        // The path names its body: use that colour when the caller passes none (loop.callModule
        // forwards only two arguments).
        colorHex ??= bodyById(p.bodyId)?.color ?? '#ffffff';
        let color;
        try { color = new THREE.Color(colorHex); } catch { color = new THREE.Color(1, 1, 1); }
        path.uniforms.uColor.value.copy(color);
        marks.uniforms.uColor.value.copy(color);

        // Path segments; style z/w carry the sample index so the shader can split past/future.
        path.ensure(count - 1);
        for (let i = 0; i < count - 1; i++) {
            const o = i * 6, s = i * 4, a = i * 3, b = (i + 1) * 3;
            path.ab[o] = dirS[a]; path.ab[o + 1] = dirS[a + 1]; path.ab[o + 2] = dirS[a + 2];
            path.ab[o + 3] = dirS[b]; path.ab[o + 4] = dirS[b + 1]; path.ab[o + 5] = dirS[b + 2];
            path.st[s] = 1; path.st[s + 1] = 0; path.st[s + 2] = i; path.st[s + 3] = i + 1;
        }
        path.setCount(count - 1);
        path.uniforms.uSpan.value = count - 1;
        path.commit();

        // Month ticks (1st of each month, UTC) and station rings.
        const segs = [];
        const anchorsOut = [];
        const d = [0, 0, 0], d2 = [0, 0, 0], perp = [0, 0, 0];
        const t0 = tMs[0], t1 = tMs[count - 1];
        const start = new Date(t0);
        let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1;
        for (let guard = 0; guard < 240; guard++, m++) {
            if (m > 11) { m = 0; y++; }
            const tm = Date.UTC(y, m, 1);
            if (tm > t1) break;
            if (tm <= t0) continue;
            dirAt(dirS, tm, d);
            dirAt(dirS, tm + 864e5, d2);
            // Tick perpendicular to the local direction of motion, in the sky's tangent plane.
            const tx = d2[0] - d[0], ty = d2[1] - d[1], tz = d2[2] - d[2];
            perp[0] = d[1] * tz - d[2] * ty; perp[1] = d[2] * tx - d[0] * tz; perp[2] = d[0] * ty - d[1] * tx;
            if (Math.hypot(perp[0], perp[1], perp[2]) < 1e-12) continue;
            normalize3(perp);
            segs.push(
                d[0] - perp[0] * TICK_HALF_RAD, d[1] - perp[1] * TICK_HALF_RAD, d[2] - perp[2] * TICK_HALF_RAD,
                d[0] + perp[0] * TICK_HALF_RAD, d[1] + perp[1] * TICK_HALF_RAD, d[2] + perp[2] * TICK_HALF_RAD,
            );
            anchorsOut.push({
                id: `trail:month:${y}-${m + 1}`,
                text: fmtMonth(tm, m === 0),
                kind: 'trail',
                priority: 24,
                color: typeof colorHex === 'string' ? colorHex : `#${color.getHexString()}`,
                dirS: Float64Array.from(d),
                offsetPx: [6, 10],
                ariaLabel: `${fmtMonth(tm, true)} on the path`,
                interactive: false,
            });
        }
        let si = 0;
        for (const st of Array.isArray(stations) ? stations : []) {
            if (!st || !st.dirS) continue;
            const c = normalize3([st.dirS[0], st.dirS[1], st.dirS[2]]);
            // Ring of angular radius RING_RAD around the station, in the tangent plane at c.
            const ref = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const u = normalize3([c[1] * ref[2] - c[2] * ref[1], c[2] * ref[0] - c[0] * ref[2], c[0] * ref[1] - c[1] * ref[0]]);
            const v = [c[1] * u[2] - c[2] * u[1], c[2] * u[0] - c[0] * u[2], c[0] * u[1] - c[1] * u[0]];
            for (let k = 0; k < RING_SEGS; k++) {
                const a0 = (k / RING_SEGS) * 2 * Math.PI, a1 = ((k + 1) / RING_SEGS) * 2 * Math.PI;
                const r = Math.tan(RING_RAD);
                segs.push(
                    c[0] + r * (Math.cos(a0) * u[0] + Math.sin(a0) * v[0]), c[1] + r * (Math.cos(a0) * u[1] + Math.sin(a0) * v[1]), c[2] + r * (Math.cos(a0) * u[2] + Math.sin(a0) * v[2]),
                    c[0] + r * (Math.cos(a1) * u[0] + Math.sin(a1) * v[0]), c[1] + r * (Math.cos(a1) * u[1] + Math.sin(a1) * v[1]), c[2] + r * (Math.cos(a1) * u[2] + Math.sin(a1) * v[2]),
                );
            }
            const begins = st.kind === 'retrograde-start';
            const when = Number.isFinite(st.tMs) ? fmtDate(st.tMs) : '';
            anchorsOut.push({
                id: `trail:station:${si++}`,
                text: `${begins ? 'Retrograde begins' : 'Retrograde ends'}${when ? ` · ${when}` : ''}`,
                kind: 'trail',
                priority: 55,
                color: typeof colorHex === 'string' ? colorHex : `#${color.getHexString()}`,
                dirS: Float64Array.from(c),
                offsetPx: [10, -10],
                ariaLabel: `${begins ? 'Retrograde motion begins' : 'Retrograde motion ends'}${when ? ` on ${when}` : ''}`,
                interactive: false,
                tMs: st.tMs,
                station: st.kind,
            });
        }
        const nMarks = segs.length / 6;
        marks.ensure(nMarks);
        for (let i = 0; i < nMarks; i++) {
            for (let k = 0; k < 6; k++) marks.ab[i * 6 + k] = segs[i * 6 + k];
            marks.st[i * 4] = 1; marks.st[i * 4 + 1] = 0; marks.st[i * 4 + 2] = 0; marks.st[i * 4 + 3] = 0;
        }
        marks.setCount(nMarks);
        marks.commit();
        list = anchorsOut;
        has = true;
        if (rc && rc.invalidate) rc.invalidate();
    }

    function clear() {
        has = false;
        count = 0;
        list = [];
        path.setCount(0);
        marks.setCount(0);
        if (rc && rc.invalidate) rc.invalidate();
    }

    /** @returns {object[]} LabelAnchor list (kind 'trail'): stations and month ticks. */
    function anchors() { return has && enabled ? list : []; }

    function apply(snap) {
        if (!snap || !has) return;
        path.uniforms.uNow.value = indexAt(snap.tMs);
    }

    function update(fi) {
        const visible = enabled && has;
        path.mesh.visible = marks.mesh.visible = visible;
        if (!visible || !fi) return;
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }
        path.setViewport(w, h, dpr);
        marks.setViewport(w, h, dpr);
        // Slightly dimmer against a bright sky.
        const e = fi.exposure && Number.isFinite(fi.exposure.stars) ? fi.exposure.stars : 1;
        path.uniforms.uAlpha.value = 0.85 * (0.6 + 0.4 * e);
        marks.uniforms.uAlpha.value = 0.75 * (0.6 + 0.4 * e);
    }

    function setLayers(layers) {
        if (layers && typeof layers.trails === 'boolean') enabled = layers.trails;
    }

    function dispose() {
        path.dispose();
        marks.dispose();
    }

    return { object3d: group, show, clear, anchors, apply, update, setLayers, dispose };
}
