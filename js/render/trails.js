/**
 * Apparent path ("trail") of the selected body among the stars (G5, SPEC C.7, SHOULD).
 *
 * Draws the geocentric path from astro/paths.apparentPath (typically ±180 days, daily samples) at
 * infinity: the part before the current time is dimmer and dashed, both ends fade out, a short
 * tick crosses the path at the start of every month, and ring markers sit on the stationary points
 * where retrograde motion begins and ends. `anchors()` gives the label pool those stations and the
 * month ticks (kind 'trail').
 *
 * Retrograde time-lapse: for a planet the path also carries `ghosts` (astro/paths.js, every 10
 * days), drawn as the composite astrophotographers make: one planet image per sample, sized from
 * its angular diameter (log-scaled) and its magnitude, so Mars swells from a dot to a blazing disc
 * at opposition; past images are dimmer and paler. Samples closer on screen than 1.5 images are
 * skipped (the pile-up at the stations), and so is the one where the planet itself is now.
 */
import * as THREE from 'three';
import { createLineLayer, skyViewExposure } from './sky.js';
import { bodyById } from '../astro/bodies.js';
import { GLYPH_VERT, GLYPH_FRAG } from './shaders/bodies.glsl.js';
import { glyphSizePx, glyphIntensity } from './bodies.js';
import { dateText } from '../core/i18n.js';

const DEG = Math.PI / 180;
const TICK_HALF_RAD = 0.55 * DEG;
const RING_RAD = 0.75 * DEG;
const RING_SEGS = 16;
const MAX_POINTS = 4096;
const MAX_GHOSTS = 64;

/** UTC calendar fields of `ms` for core/i18n.js dateText (the interface's locale). */
function utcFields(ms) {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay() };
}
function fmtDate(ms) {
    try {
        return dateText(utcFields(ms), { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}
function fmtMonth(ms, withYear) {
    try {
        return dateText(utcFields(ms), { month: 'short', year: withYear && 'numeric' });
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
    // Sky view draws the path at apparent (refracted) positions, like the bodies on it.
    const refr = { uRefrUp: { value: new THREE.Vector3(0, 1, 0) }, uRefrK: { value: 0 } };
    const path = createLineLayer({
        name: 'trails.path', capacity: 400, color: [1, 1, 1], alpha: 0.85, halfWidthPx: 0.9,
        renderOrder: -60, defines: { TRAIL: '' }, refraction: refr,
    });
    const marks = createLineLayer({
        name: 'trails.marks', capacity: 512, color: [1, 1, 1], alpha: 0.75, halfWidthPx: 0.75, renderOrder: -60,
        refraction: refr,
    });
    group.add(path.mesh, marks.mesh);

    // Time-lapse images: instanced glyphs (bodies.glsl.js), buffers fixed at MAX_GHOSTS.
    const quad = new THREE.PlaneGeometry(2, 2);
    const gGeo = new THREE.InstancedBufferGeometry();
    gGeo.setAttribute('position', quad.getAttribute('position'));
    gGeo.setIndex(quad.getIndex());
    const gAttr = (name, n) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_GHOSTS * n), n);
        a.setUsage(THREE.DynamicDrawUsage);
        gGeo.setAttribute(name, a);
        return a;
    };
    const gDir = gAttr('iDir', 3), gColor = gAttr('iColor', 3), gParams = gAttr('iParams', 4);
    gGeo.instanceCount = 0;
    const gUniforms = { uViewport: { value: new THREE.Vector2(1, 1) }, uDpr: { value: 1 }, uExposure: { value: 1 }, ...refr };
    const gMat = new THREE.ShaderMaterial({
        name: 'trails.ghosts', uniforms: gUniforms, vertexShader: GLYPH_VERT, fragmentShader: GLYPH_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const ghosts = new THREE.Mesh(gGeo, gMat);
    ghosts.name = 'trails.ghosts';
    ghosts.frustumCulled = false;
    ghosts.renderOrder = -61;   // under the live glyph (-60)
    group.add(ghosts);
    const gT = new Float64Array(MAX_GHOSTS);
    const gSize = new Float32Array(MAX_GHOSTS);
    const gInt = new Float32Array(MAX_GHOSTS);
    const gBase = new THREE.Color();
    let nGhosts = 0;
    let nowMs = NaN;
    let sunAltDeg = -90;
    let obscuration = 0;

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

        // Time-lapse images: size from the log of the angular diameter and from the magnitude.
        const g = p.ghosts;
        nGhosts = g && g.index ? Math.min(MAX_GHOSTS, g.index.length) : 0;
        let dMin = Infinity, brightest = -1;
        for (let k = 0; k < nGhosts; k++) {
            dMin = Math.min(dMin, g.diamArcsec[k]);
            if (brightest < 0 || g.mag[k] < g.mag[brightest]) brightest = k;
        }
        for (let k = 0; k < nGhosts; k++) {
            const j = Math.min(g.index[k], n0 - 1);
            const l = Math.hypot(p.dirS[j * 3], p.dirS[j * 3 + 1], p.dirS[j * 3 + 2]) || 1;
            for (let c = 0; c < 3; c++) gDir.array[k * 3 + c] = p.dirS[j * 3 + c] / l;
            gT[k] = p.tMs[j];
            const grow = 0.7 + 0.45 * Math.log2(Math.max(1, g.diamArcsec[k] / dMin));
            gSize[k] = Math.min(14, Math.max(3, glyphSizePx(g.mag[k]) * grow));
            gInt[k] = Math.min(1.5, glyphIntensity(g.mag[k]));
        }
        gBase.copy(color);
        gDir.needsUpdate = true;
        gGeo.instanceCount = nGhosts;
        if (brightest >= 0 && nGhosts > 2) {
            const j = Math.min(g.index[brightest], n0 - 1);
            anchorsOut.push({
                id: 'trail:brightest', text: `Brightest · ${fmtDate(p.tMs[j])}`, kind: 'trail', priority: 50,
                color: typeof colorHex === 'string' ? colorHex : `#${color.getHexString()}`,
                dirS: Float64Array.from(gDir.array.subarray(brightest * 3, brightest * 3 + 3)),
                offsetPx: [12, 14], ariaLabel: `Brightest on ${fmtDate(p.tMs[j])}`, interactive: false,
            });
        }
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
        nGhosts = 0;
        gGeo.instanceCount = 0;
        if (rc && rc.invalidate) rc.invalidate();
    }

    /**
     * Ghost params for this frame: past images dimmer and paler, the one at the planet's own place
     * now hidden, and any image closer than 1.5 image sizes to the last one kept skipped.
     */
    function writeGhosts(pxPerRad) {
        const d = gDir.array, pr = gParams.array, col = gColor.array;
        let last = -1;
        for (let k = 0; k < nGhosts; k++) {
            const past = gT[k] < nowMs;
            let on = Math.abs(gT[k] - nowMs) > 5 * 864e5;
            if (on && last >= 0) {
                const dot = d[k * 3] * d[last * 3] + d[k * 3 + 1] * d[last * 3 + 1] + d[k * 3 + 2] * d[last * 3 + 2];
                const sepPx = Math.acos(Math.min(1, dot)) * pxPerRad;
                if (sepPx < 0.75 * (gSize[k] + gSize[last]) * gUniforms.uDpr.value) on = false;
            }
            if (on) last = k;
            pr[k * 4] = gSize[k];
            pr[k * 4 + 1] = gInt[k] * (past ? 0.45 : 0.8);
            pr[k * 4 + 2] = 0;
            pr[k * 4 + 3] = on ? 1 : 0;
            const pale = past ? 0.45 : 0.15;
            col[k * 3] = gBase.r + (1 - gBase.r) * pale;
            col[k * 3 + 1] = gBase.g + (1 - gBase.g) * pale;
            col[k * 3 + 2] = gBase.b + (1 - gBase.b) * pale;
        }
        gParams.needsUpdate = gColor.needsUpdate = true;
    }

    /** @returns {object[]} LabelAnchor list (kind 'trail'): stations and month ticks. */
    function anchors() { return has && enabled ? list : []; }

    function apply(snap) {
        if (!snap) return;
        const up = snap.observer && snap.observer.upS;
        if (up) refr.uRefrUp.value.set(up[0], up[1], up[2]);
        sunAltDeg = snap.observer && Number.isFinite(snap.observer.sunAltDeg) ? snap.observer.sunAltDeg : -90;
        obscuration = snap.eclipse && Number.isFinite(snap.eclipse.obscurationAtObserver)
            ? snap.eclipse.obscurationAtObserver : 0;
        nowMs = snap.tMs;
        if (!has) return;
        path.uniforms.uNow.value = indexAt(snap.tMs);
    }

    function update(fi) {
        const visible = enabled && has;
        path.mesh.visible = marks.mesh.visible = visible;
        ghosts.visible = visible && nGhosts > 0;
        if (!visible || !fi) return;
        refr.uRefrK.value = Number.isFinite(fi.skyBlend) ? Math.min(1, Math.max(0, fi.skyBlend)) : 0;
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }
        path.setViewport(w, h, dpr);
        marks.setViewport(w, h, dpr);
        if (ghosts.visible) {
            gUniforms.uViewport.value.set(w, h);
            gUniforms.uDpr.value = dpr;
            // The live glyph's exposure, daytime display factor included (render/bodies.js), so the
            // ghosts stay fainter than the planet they trace by day too.
            const planetsExp = fi.exposure && Number.isFinite(fi.exposure.planets) ? fi.exposure.planets : 1;
            gUniforms.uExposure.value = planetsExp * skyViewExposure(sunAltDeg, refr.uRefrK.value, obscuration);
            const cam = fi.camera;
            writeGhosts(cam ? 0.5 * h * cam.projectionMatrix.elements[5] : 1000);
        }
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
        gGeo.dispose();
        quad.dispose();
        gMat.dispose();
    }

    return { object3d: group, show, clear, anchors, apply, update, setLayers, dispose };
}
