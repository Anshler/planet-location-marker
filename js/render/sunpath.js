/**
 * Sun paths and the analemma (ROADMAP analemma-sun-path), the 'sunPath' layer:
 *
 *  - sky view: today's path of the Sun with hour ticks (gold), this year's June and December
 *    solstice and March equinox paths (thin, pale), and the noon analemma, the figure-8 of where the
 *    Sun stands at local mean noon through the year, with month ticks and longer ones at the
 *    solstices and equinoxes. Line layers at infinity in the observer's local frame (east, up,
 *    south), re-oriented from the snapshot like sky.js's alt-az grid; the points are apparent
 *    (refracted) positions already, so no lift is applied. Segments below the horizon are left out.
 *  - globe: the subsolar figure-8, the point under the Sun at the current UT time of day on every
 *    day of the year (a thin line on the globe, Earth-fixed like the pin, and a dot on today's
 *    point), hidden as sky view comes in.
 *
 * The figures come from the astro worker (astro/sunpath.js `sunFigures`, ≈ 7 ms) through
 * `request(snap)`, only while the layer is on, and are refreshed when the observer moves, the
 * local day changes or the UT time of day moves by 5 minutes. Hidden while a long exposure stacks.
 *
 *   createSunPath(rc, {request, store}) → RenderModule & {stats()}
 *
 * @module render/sunpath
 */
import * as THREE from 'three';
import { createLineLayer } from './sky.js';
import { latLonToLocal } from '../astro/frames.js';

const DEG = Math.PI / 180;
const DAY_MS = 86400000;
const GLOBE_R = 1.004;
const TICK = 0.014;           // hour and month ticks, radians (≈ 0.8°)
const MARK_TICK = 0.03;       // solstice and equinox ticks on the analemma
const MIN_ALT_DEG = -1;
const REQUEST_GAP_MS = 1000;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * @param {any} rc render context
 * @param {{request?:(snap:any)=>Promise<any>, store?:any}} [deps]
 */
export function createSunPath(rc, deps = {}) {
    const { request = null, store = null } = deps;
    const group = new THREE.Group();
    group.name = 'sunPath';

    const today = createLineLayer({ name: 'sunpath.today', capacity: 200, color: [1.0, 0.8, 0.36], alpha: 0.75, halfWidthPx: 0.9, renderOrder: -62 });
    const seasons = createLineLayer({ name: 'sunpath.seasons', capacity: 450, color: [0.95, 0.78, 0.5], alpha: 0.32, halfWidthPx: 0.6, renderOrder: -62 });
    const analemma = createLineLayer({ name: 'sunpath.analemma', capacity: 400, color: [1.0, 0.9, 0.62], alpha: 0.6, halfWidthPx: 0.8, renderOrder: -62 });
    const skyLayers = [today, seasons, analemma];
    for (const l of skyLayers) { l.mesh.visible = false; group.add(l.mesh); }

    // The globe's figure-8: one closed line and today's dot, in an Earth-fixed group.
    const globe = new THREE.Group();
    globe.name = 'sunpath.globe';
    globe.matrixAutoUpdate = false;
    const linePos = new Float32Array(366 * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffc35a, transparent: true, opacity: 0.85, depthWrite: false });
    const line = new THREE.Line(lineGeo, lineMat);
    line.frustumCulled = false;
    line.renderOrder = 15;
    const dotPos = new Float32Array(3);
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3));
    const dotMat = new THREE.PointsMaterial({ color: 0xfff0c0, size: 6, sizeAttenuation: false, transparent: true, depthWrite: false });
    const dot = new THREE.Points(dotGeo, dotMat);
    dot.frustumCulled = false;
    dot.renderOrder = 16;
    globe.add(line, dot);
    globe.visible = false;
    group.add(globe);

    const east = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 1, 0), south = new THREE.Vector3(0, 0, 1);
    const p = new Float64Array(3);
    let layerOn = false;
    let skyBlend = 0;
    let fig = null;
    let figKey = '';
    let pendingKey = '';
    let lastSnap = null;
    let segCounts = { today: 0, seasons: 0, analemma: 0, globe: 0 };

    function invalidate() { try { rc?.invalidate?.(); } catch { /* ignore */ } }

    /** The key a figure set answers: place, local day (by the hour of its start) and the UT time of day to 5 min. */
    function keyFor(snap) {
        const o = snap.observer;
        const utMin = Math.round(((((snap.tMs % DAY_MS) + DAY_MS) % DAY_MS) / 300000)) * 5;
        const meanDay = Math.floor((snap.tMs + (o.lonDeg / 360) * DAY_MS) / DAY_MS);
        return `${o.latDeg.toFixed(3)},${o.lonDeg.toFixed(3)}|${meanDay}|${utMin}`;
    }

    // Fast time changes the key every frame: ask at most every REQUEST_GAP_MS, and once more when
    // the clock settles (a timer, since a paused clock brings no further snapshots).
    let lastReqAt = -Infinity;
    let retry = 0;
    function maybeRequest(snap) {
        if (!layerOn || !request || !snap?.observer) return;
        const key = keyFor(snap);
        if (key === figKey || key === pendingKey) return;
        if (pendingKey) return;
        const now = performance.now();
        if (now - lastReqAt < REQUEST_GAP_MS) {
            if (!retry) retry = setTimeout(() => { retry = 0; if (lastSnap) maybeRequest(lastSnap); }, REQUEST_GAP_MS - (now - lastReqAt) + 10);
            return;
        }
        lastReqAt = now;
        pendingKey = key;
        let pr;
        try { pr = request(snap); } catch { pendingKey = ''; return; }
        Promise.resolve(pr).then((res) => {
            if (pendingKey !== key) return;
            pendingKey = '';
            if (!res || !res.arcs) return;
            fig = res;
            figKey = key;
            build();
            invalidate();
        }, () => { if (pendingKey === key) pendingKey = ''; });
    }

    function put(layer, i, ax, ay, az, bx, by, bz, alpha = 1) {
        const ab = layer.ab, st = layer.st, o = i * 6, s = i * 4;
        ab[o] = ax; ab[o + 1] = ay; ab[o + 2] = az; ab[o + 3] = bx; ab[o + 4] = by; ab[o + 5] = bz;
        st[s] = alpha; st[s + 1] = 0; st[s + 2] = 0; st[s + 3] = 0;
    }

    // A tick at point k of `pts` toward the zenith (local +y), of length `len` radians.
    function tick(layer, i, pts, k, len, alpha) {
        const x = pts[3 * k], y = pts[3 * k + 1], z = pts[3 * k + 2];
        let tx = -x * y, ty = 1 - y * y, tz = -z * y;
        const l = Math.hypot(tx, ty, tz) || 1;
        tx /= l; ty /= l; tz /= l;
        put(layer, i, x, y, z, x + tx * len, y + ty * len, z + tz * len, alpha);
    }

    function polyline(layer, i0, pts, alt, n, closed = false) {
        let i = i0;
        const last = closed ? n : n - 1;
        for (let k = 0; k < last; k++) {
            const k2 = (k + 1) % n;
            if (alt[k] < MIN_ALT_DEG || alt[k2] < MIN_ALT_DEG) continue;
            put(layer, i++, pts[3 * k], pts[3 * k + 1], pts[3 * k + 2], pts[3 * k2], pts[3 * k2 + 1], pts[3 * k2 + 2]);
        }
        return i;
    }

    function build() {
        if (!fig) return;
        const arcs = fig.arcs;
        const t = arcs.find((a) => a.key === 'today');
        let n = 0;
        if (t) {
            const N = t.alt.length;
            n = polyline(today, 0, t.points, t.alt, N);
            for (const k of fig.hourTicks) if (k < N && t.alt[k] >= 0) tick(today, n++, t.points, k, TICK, 0.9);
        }
        today.setCount(n); today.commit();
        segCounts.today = n;
        let m = 0;
        for (const a of arcs) if (a.key !== 'today') m = polyline(seasons, m, a.points, a.alt, a.alt.length);
        seasons.setCount(m); seasons.commit();
        segCounts.seasons = m;
        const an = fig.analemma;
        let q = polyline(analemma, 0, an.points, an.alt, an.days, true);
        for (const k of an.monthStarts) if (an.alt[k] >= MIN_ALT_DEG) tick(analemma, q++, an.points, k, TICK, 0.8);
        for (const k of an.markers) if (an.alt[k] >= MIN_ALT_DEG) tick(analemma, q++, an.points, k, MARK_TICK, 1);
        analemma.setCount(q); analemma.commit();
        segCounts.analemma = q;

        // The globe's figure-8, closed.
        const ss = fig.subsolar;
        const days = Math.min(365, ss.days);
        for (let d = 0; d <= days; d++) {
            const k = d % days;
            latLonToLocal(ss.latLon[2 * k], ss.latLon[2 * k + 1], p);
            linePos[3 * d] = p[0] * GLOBE_R; linePos[3 * d + 1] = p[1] * GLOBE_R; linePos[3 * d + 2] = p[2] * GLOBE_R;
        }
        lineGeo.attributes.position.needsUpdate = true;
        lineGeo.setDrawRange(0, days + 1);
        const ti = Math.min(days - 1, Math.max(0, ss.todayIndex));
        latLonToLocal(ss.latLon[2 * ti], ss.latLon[2 * ti + 1], p);
        dotPos[0] = p[0] * GLOBE_R; dotPos[1] = p[1] * GLOBE_R; dotPos[2] = p[2] * GLOBE_R;
        dotGeo.attributes.position.needsUpdate = true;
        segCounts.globe = days + 1;
    }

    function apply(snap) {
        if (!snap || !snap.observer) return;
        lastSnap = snap;
        const o = snap.observer;
        east.set(o.eastS[0], o.eastS[1], o.eastS[2]);
        up.set(o.upS[0], o.upS[1], o.upS[2]);
        south.set(-o.northS[0], -o.northS[1], -o.northS[2]);
        for (const l of skyLayers) {
            l.mesh.matrix.makeBasis(east, up, south);
            l.mesh.matrixWorldNeedsUpdate = true;
        }
        if (snap.earthMatrix) {
            globe.matrix.fromArray(snap.earthMatrix);
            globe.matrixWorldNeedsUpdate = true;
        }
        maybeRequest(snap);
    }

    function update(fi) {
        if (!fi) return;
        skyBlend = Number.isFinite(fi.skyBlend) ? fi.skyBlend : 0;
        const r = rc && rc.renderer;
        if (r) {
            r.getDrawingBufferSize(size);
            const dpr = r.getPixelRatio();
            for (const l of skyLayers) l.setViewport(size.x, size.y, dpr);
        }
        const exposing = !!store?.get?.()?.ui?.expose;
        const k = clamp01(skyBlend);
        const skyOn = layerOn && !!fig && k > 0.001 && !exposing;
        today.mesh.visible = skyOn && segCounts.today > 0;
        seasons.mesh.visible = skyOn && segCounts.seasons > 0;
        analemma.mesh.visible = skyOn && segCounts.analemma > 0;
        today.uniforms.uAlpha.value = 0.75 * k;
        seasons.uniforms.uAlpha.value = 0.32 * k;
        analemma.uniforms.uAlpha.value = 0.6 * k;
        const g = 1 - clamp01(skyBlend / 0.4);
        globe.visible = layerOn && !!fig && g > 0.001 && segCounts.globe > 0;
        lineMat.opacity = 0.85 * g;
        dotMat.opacity = g;
    }
    const size = new THREE.Vector2();

    return {
        object3d: group,
        apply,
        update,
        setLayers(l) {
            if (!l || typeof l.sunPath !== 'boolean' || l.sunPath === layerOn) return;
            layerOn = l.sunPath;
            if (layerOn && lastSnap) maybeRequest(lastSnap);
            invalidate();
        },
        setViewMode(mode, blend) { if (Number.isFinite(blend)) skyBlend = blend; },
        /** Diagnostics: segments built per figure and the figures' key. */
        stats() { return { ...segCounts, key: figKey, on: layerOn, rise: fig ? fig.arcs.map((a) => [a.key, Math.round(a.riseAzDeg), Math.round(a.setAzDeg)]) : null }; },
        dispose() {
            clearTimeout(retry);
            for (const l of skyLayers) l.dispose();
            lineGeo.dispose(); lineMat.dispose(); dotGeo.dispose(); dotMat.dispose();
        },
    };
}
