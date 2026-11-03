/**
 * The path of a central solar eclipse on the globe (ROADMAP Phase 1, eclipse-path-of-totality):
 * a ribbon between the northern and southern limits with a gold centre line, a translucent band and
 * 30-minute ticks, and a live marker where the umbra is now (a ring just outside it, a chevron for
 * its direction of motion). An annular eclipse (antumbra) is drawn in amber with a dashed centre
 * line; a hybrid switches style along the path.
 *
 * Geometry: astro/eclipse-path.js `ribbonMesh`, built once per eclipse in show() (R5 forbids
 * per-frame allocation, not per-event), in the globe's geometry frame, inside a group whose matrix
 * is snap.earthMatrix (Earth-fixed, like the pin). Radius 1.007, above the cloud shell (1.006),
 * renderOrder 15: after the clouds (10), which write no depth, and before the atmosphere (20). It
 * depth-tests against the Earth only and writes no depth.
 *
 * Reveal (a per-vertex time attribute against the uNow uniform, no reallocation): 'time' draws
 * the part the shadow has passed at full strength and the rest at 40 %; 'chase' hides what it has
 * not reached (the shadow chase paints the ribbon in behind it); 'all' draws the whole path.
 *
 * Shown by main.js (`ribbonPlan`): the eclipse in focus (ui.eclipse) or one in progress. Hidden in
 * sky view, where the band would hang 45 km over the eye. Low tier: no ticks.
 *
 * @module render/eclipse-path
 */
import * as THREE from 'three';
import { ribbonMesh, pathFrameLocal } from '../astro/eclipse-path.js';

const RIBBON_R = 1.007;
const MARKER_R = 1.0075;
const RENDER_ORDER = 15;
const KM_PER_ER = 6378.137;
const AHEAD_ALPHA = 0.4;
const RING = 0.78;            // marker ring radius, as a fraction of the marker quad's half-size
const RING_UMBRA = 1.25;      // the ring sits this far outside the shadow's radius…
const RING_MIN_RAD = 0.012;   // …and never under ≈ 13 px (radians seen from the camera)

const TOTAL = new THREE.Color(1.0, 0.74, 0.3);
const ANNULAR = new THREE.Color(1.0, 0.48, 0.16);

const RIBBON_VERT = /* glsl */ `
attribute vec4 aPath;   // (v: −1 south … +1 north, t: s since start, along-track km, ±(1 + Sun alt°))
varying vec4 vPath;
varying vec3 vL;        // geometry-local position
void main() {
    vPath = aPath;
    vL = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform float uNow;      // s since the start of the path
uniform float uAhead;    // strength of the part the shadow has not reached (0: hidden)
uniform float uAlpha;
uniform float uTicks;
uniform vec3 uTotal;
uniform vec3 uAnnular;
uniform vec4 uShadow;    // the shadow now: geometry-local unit vector, radius in Earth radii (0: none)
varying vec4 vPath;
varying vec3 vL;

void main() {
    float av = abs(vPath.x);
    float t = vPath.y;
    float wv = fwidth(vPath.x) + 1e-5;
    float wt = fwidth(t) + 1e-3;
    bool annular = vPath.w < 0.0;
    float sunAlt = abs(vPath.w) - 1.0;

    float past = 1.0 - smoothstep(uNow - 2.0 * wt, uNow + 2.0 * wt, t);
    float k = mix(uAhead, 1.0, past) * uAlpha;
    // A soft hole around the shadow itself, so the umbra reads as a dark spot inside the marker.
    if (uShadow.w > 0.0) k *= smoothstep(uShadow.w * 0.9, uShadow.w * 2.2, length(normalize(vL) - uShadow.xyz));

    // Centre line ≈ 1.5 px (dashed every 90 km for an annular eclipse), the limits ≈ 1 px.
    float line = 1.0 - smoothstep(0.6 * wv, 1.6 * wv, av);
    if (annular) line *= step(0.45, fract(vPath.z / 90.0));
    float lim = 1.0 - smoothstep(0.4 * wv, 1.4 * wv, abs(av - (1.0 - 1.5 * wv)));
    float dt = abs(fract(t / 1800.0 + 0.5) - 0.5) * 1800.0;
    float tick = (1.0 - smoothstep(0.6 * wt, 1.6 * wt, dt)) * uTicks;
    // The band: translucent, firmer toward the limits, thinner where the Sun is low and the
    // footprint fans out along the horizon.
    float fill = (0.13 + 0.09 * av * av) * mix(0.4, 1.0, smoothstep(0.0, 8.0, sunAlt));

    vec3 base = annular ? uAnnular : uTotal;
    vec3 col = base * 0.75;
    float a = fill;
    col = mix(col, base * 0.95, lim);
    a = max(a, lim * 0.55);
    col = mix(col, base * 0.95, tick);
    a = max(a, tick * 0.4);
    col = mix(col, mix(base, vec3(1.0, 0.88, 0.55), 0.35) * 1.15, line);
    a = max(a, line * 0.9);
    a *= k;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const MARKER_VERT = /* glsl */ `
varying vec2 vP;   // −1..1 across the quad, +x along the shadow's motion
void main() {
    vP = vec2(position.x, -position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MARKER_FRAG = /* glsl */ `
uniform float uAlpha;
uniform vec3 uColor;
varying vec2 vP;
void main() {
    float r = length(vP);
    float ar = fwidth(r) + 1e-5;
    float ring = 1.0 - smoothstep(0.6 * ar, 1.6 * ar, abs(r - ${RING.toFixed(3)}));
    float d = (r - ${RING.toFixed(3)}) / 0.07;
    float glow = exp(-d * d) * 0.3;
    // A chevron just ahead of the ring, pointing along +x.
    vec2 q = vP - vec2(${(RING + 0.17).toFixed(3)}, 0.0);
    float cd = abs(q.x + abs(q.y)) * 0.7071;
    float aw = fwidth(cd) + 1e-5;
    float chev = (1.0 - smoothstep(0.6 * aw, 1.6 * aw, cd)) * (1.0 - smoothstep(0.09, 0.11, abs(q.y)));
    if (r > 1.0 + ar) discard;
    float a = max(max(ring, chev) * 0.95, glow) * uAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor * (0.8 + 1.2 * max(ring, chev)), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * Creates the eclipse path module.
 * @param {object} rc RenderContext
 * @returns {object} RenderModule & {show(path), clear(), setReveal(mode), readonly path}
 */
export function createEclipsePath(rc) {
    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* never throw from a redraw request */ } };

    const group = new THREE.Group();
    group.name = 'eclipsePath';
    group.matrixAutoUpdate = false;
    group.visible = false;

    const empty = new THREE.BufferGeometry();
    const ribbonMat = new THREE.ShaderMaterial({
        name: 'eclipsePath.ribbon',
        uniforms: {
            uNow: { value: 0 },
            uAhead: { value: AHEAD_ALPHA },
            uAlpha: { value: 1 },
            uTicks: { value: 1 },
            uTotal: { value: TOTAL.clone() },
            uAnnular: { value: ANNULAR.clone() },
            uShadow: { value: new THREE.Vector4(0, 0, 0, 0) },
        },
        vertexShader: RIBBON_VERT,
        fragmentShader: RIBBON_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const ribbon = new THREE.Mesh(empty, ribbonMat);
    ribbon.name = 'eclipsePath.ribbon';
    ribbon.renderOrder = RENDER_ORDER;
    group.add(ribbon);

    const markerGeo = new THREE.PlaneGeometry(2, 2);
    markerGeo.rotateX(-Math.PI / 2);
    const markerMat = new THREE.ShaderMaterial({
        name: 'eclipsePath.marker',
        uniforms: { uAlpha: { value: 1 }, uColor: { value: TOTAL.clone() } },
        vertexShader: MARKER_VERT,
        fragmentShader: MARKER_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.name = 'eclipsePath.marker';
    marker.matrixAutoUpdate = false;
    marker.renderOrder = RENDER_ORDER + 1;
    marker.frustumCulled = false;
    group.add(marker);

    // ---- state ----
    const earthM = new THREE.Matrix4();
    const mPos = new Float64Array(3), mFwd = new Float64Array(3);
    const markerW = new THREE.Vector3();
    let path = null;
    let geometry = null;
    let markerOn = false;
    let markerKm = 0;
    let skyBlend = 0;
    let lastT = NaN;

    /** The marker's quad: tangent at the shadow, +x along its motion, sized for the camera. */
    function placeMarker(camera) {
        if (!markerOn) return;
        const px = mPos[0] * MARKER_R, py = mPos[1] * MARKER_R, pz = mPos[2] * MARKER_R;
        let rad = (markerKm / KM_PER_ER) * RING_UMBRA;
        if (camera) {
            markerW.set(px, py, pz).applyMatrix4(earthM);
            rad = Math.max(rad, camera.position.distanceTo(markerW) * RING_MIN_RAD);
        }
        const h = rad / RING;
        // Columns: X = forward·h, Y = up, Z = forward × up · h (a proper rotation, scaled).
        const fx = mFwd[0], fy = mFwd[1], fz = mFwd[2], ux = mPos[0], uy = mPos[1], uz = mPos[2];
        const zx = fy * uz - fz * uy, zy = fz * ux - fx * uz, zz = fx * uy - fy * ux;
        marker.matrix.set(
            fx * h, ux, zx * h, px,
            fy * h, uy, zy * h, py,
            fz * h, uz, zz * h, pz,
            0, 0, 0, 1,
        );
        marker.matrixWorldNeedsUpdate = true;
    }

    function updateVisibility() {
        const k = 1 - smoothstep(0, 0.4, skyBlend);
        group.visible = !!path && k > 0.001;
        ribbonMat.uniforms.uAlpha.value = k;
        markerMat.uniforms.uAlpha.value = k;
        marker.visible = markerOn;
    }

    function apply(snap) {
        if (!snap) return;
        if (snap.earthMatrix) {
            earthM.fromArray(snap.earthMatrix);
            group.matrix.copy(earthM);
            group.matrixWorldNeedsUpdate = true;
        }
        lastT = snap.tMs;
        if (!path) return;
        ribbonMat.uniforms.uNow.value = (snap.tMs - path.startMs) / 1000;
        const r = pathFrameLocal(path, snap.tMs, mPos, mFwd);
        markerOn = Number.isFinite(r);
        const sh = ribbonMat.uniforms.uShadow.value;
        if (markerOn) {
            markerKm = Math.abs(r);
            markerMat.uniforms.uColor.value.copy(r >= 0 ? TOTAL : ANNULAR);
            sh.set(mPos[0], mPos[1], mPos[2], Math.max(markerKm, 30) / KM_PER_ER);
        } else sh.w = 0;
        updateVisibility();
    }

    function update(fi) {
        if (fi && Number.isFinite(fi.skyBlend) && fi.skyBlend !== skyBlend) {
            skyBlend = fi.skyBlend;
            updateVisibility();
        }
        if (group.visible) placeMarker(fi?.camera ?? rc?.camera ?? null);
    }

    /**
     * Shows a path (eclipse-path.js EclipsePath): builds its ribbon once, replacing any other. The
     * reveal mode is kept (a chase may set it before its path arrives); clear() resets it to 'time'.
     * @param {object} p
     */
    function show(p) {
        const mesh = p ? ribbonMesh(p, { radius: RIBBON_R }) : null;
        if (!mesh) {
            clear();
            return;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
        g.setAttribute('aPath', new THREE.BufferAttribute(mesh.attr, 4));
        g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
        g.computeBoundingSphere();
        geometry?.dispose();
        geometry = g;
        ribbon.geometry = g;
        path = p;
        markerOn = false;
        if (Number.isFinite(lastT)) apply({ tMs: lastT, earthMatrix: null });
        updateVisibility();
        invalidate();
    }

    function clear() {
        if (!path && !geometry) return;
        path = null;
        markerOn = false;
        ribbonMat.uniforms.uAhead.value = AHEAD_ALPHA;
        ribbon.geometry = empty;
        geometry?.dispose();
        geometry = null;
        updateVisibility();
        invalidate();
    }

    return {
        object3d: group,
        apply,
        update,
        show,
        clear,
        /** The path shown, or null. */
        get path() { return path; },
        /**
         * What the ribbon shows: 'time' (default: passed at full, ahead at 40 %), 'chase' (only what
         * the shadow has passed), 'all' (the whole path at full).
         * @param {'time'|'chase'|'all'} mode
         */
        setReveal(mode) {
            ribbonMat.uniforms.uAhead.value = mode === 'chase' ? 0 : mode === 'all' ? 1 : AHEAD_ALPHA;
            invalidate();
        },
        setLayers() {},
        setViewMode(mode, sb) {
            skyBlend = Number.isFinite(sb) ? sb : mode === 'sky' ? 1 : 0;
            updateVisibility();
        },
        setSelection() {},
        setQuality(cfg) {
            ribbonMat.uniforms.uTicks.value = cfg && cfg.name === 'low' ? 0 : 1;
        },
        dispose() {
            group.removeFromParent();
            geometry?.dispose();
            empty.dispose();
            markerGeo.dispose();
            ribbonMat.dispose();
            markerMat.dispose();
        },
    };
}
