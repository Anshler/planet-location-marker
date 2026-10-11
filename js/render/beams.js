/**
 * Signature beams (SPEC §C.6, §E.4): one glowing HDR ribbon per body from the
 * observer pin toward the body, with light-time pulses, an x-ray pass where the
 * beam is hidden by the Earth, dim dashes for bodies below the horizon, and a
 * staggered launch animation.
 *
 * Rendering: one InstancedBufferGeometry (24-segment strip × 9 instances) drawn
 * twice — pass A (renderOrder 30, depth-tested, additive) and pass B
 * (renderOrder 31, GreaterDepth, additive, dashed and faint). See
 * `shaders/beam.glsl.js` for the ribbon math.
 *
 * Extras beyond the RenderModule contract (all optional for the integrator):
 *  - `labelAnchor(id)` → live Float64Array(3) world point for the body's label:
 *    the farthest on-screen, unoccluded point of the visible beam in orbit view,
 *    a point at infinity along the direction in sky view or when the beam is
 *    hidden, and NaN while the beam has not landed (labels hide NaN anchors), so
 *    "labels fade in as each beam lands" falls out of the launch for free.
 *  - `prime()` hides every beam until the next `launch()` (call at intro start).
 *  - `skipLaunch()` completes a running launch at once (intro skipped).
 *
 * No per-frame allocation (R5): every buffer and scratch object is created once.
 *
 * @module render/beams
 */
import * as THREE from 'three';
import { BODIES } from '../astro/bodies.js';
import { BEAM_VERT, BEAM_FRAG } from './shaders/beam.glsl.js';
import { labelExtent, uiOccluders } from './labels.js';

const N = BODIES.length;
const MOON = BODIES.findIndex((b) => b.id === 'moon');
const SUN = BODIES.findIndex((b) => b.id === 'sun');
const SEGMENTS = 24;
/** Far endpoint distance for bodies at infinity, Earth radii (the judge's ruling). */
const FAR_LEN = 2000;
/** The Moon beam stops this far short of the Moon's centre (its radius is 0.2724). */
const MOON_GAP = 0.30;
/** Beam origin is lifted slightly off the unit sphere so it never z-fights the surface. */
const ORIGIN_LIFT = 1.002;
const LAUNCH_MS = 700;
/** Phase speed of the light-time pulses, cycles per second. */
const PULSE_HZ = 0.6;
/** Labels start this far along a beam so they never sit on the pin itself. */
const LABEL_MIN_D = 0.08;
// Beam label footprint around its anchor, CSS px (ADDENDUM A4: the 6 px dot is centred on
// the anchor and the text runs to its right). The DOM labels publish measured boxes
// (labels.js labelExtent); these are the fallbacks before the first measurement. The DOM
// labels nudge or hide any residual overflow.
const LABEL_PAD = 12;          // clearance from the free area's edge
const LABEL_LEFT = 6;
const LABEL_HALF_H = 10;
const LABEL_GAP = 3;           // spacing between two beam labels
const LABEL_SEL_EXTRA = 4;     // a selected label is set bolder than when it was measured
/** Room for floating UI rects (labels.js uiOccluders) in the de-overlap slots. */
const MAX_OCCLUDERS = 32;
/** The observer's label sits on the pin head (labels-feed: radius 1.065). */
const OBSERVER_LABEL_R = 1.065;

const ID_INDEX = Object.fromEntries(BODIES.map((b, i) => [b.id, i]));
/** Estimated px a body label extends right of its anchor: dot, gap and text (selected is bolder). */
const LABEL_RIGHT = Float64Array.from(BODIES, (b) => 16 + 7.2 * b.name.length);

/** Launch progress easing: gentle start, so the log-length growth reads as a "whoosh". */
function easeInOutSine(t) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function prefersReducedMotion() {
    try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Builds the shared ribbon strip: rows i = 0..24 with (aS = i/24, aSide = ±1).
 * @returns {THREE.InstancedBufferGeometry}
 */
function buildStrip() {
    const g = new THREE.InstancedBufferGeometry();
    const rows = SEGMENTS + 1;
    const pos = new Float32Array(rows * 2 * 3);
    for (let i = 0; i < rows; i++) {
        const s = i / SEGMENTS;
        pos[i * 6 + 0] = s; pos[i * 6 + 1] = -1; pos[i * 6 + 2] = 0;
        pos[i * 6 + 3] = s; pos[i * 6 + 4] = 1; pos[i * 6 + 5] = 0;
    }
    const idx = new Uint16Array(SEGMENTS * 6);
    for (let i = 0; i < SEGMENTS; i++) {
        const a = i * 2;
        idx[i * 6 + 0] = a; idx[i * 6 + 1] = a + 1; idx[i * 6 + 2] = a + 2;
        idx[i * 6 + 3] = a + 1; idx[i * 6 + 4] = a + 3; idx[i * 6 + 5] = a + 2;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.instanceCount = N;
    return g;
}

/**
 * Creates the beams module.
 * @param {object} rc RenderContext (SPEC §C.6).
 * @param {{now?:()=>number, reducedMotion?:boolean}} [deps] `now` overrides the animation clock (tests).
 * @returns {object} RenderModule & {launch, getTip, labelAnchor, isLanded, prime, skipLaunch, setReducedMotion}
 */
export function createBeams(rc, deps = {}) {
    const now = typeof deps.now === 'function' ? deps.now : nowMs;
    let reducedMotion = deps.reducedMotion ?? prefersReducedMotion();

    const geometry = buildStrip();
    const aOrigin = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    const aDir = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    const aColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    const aLen = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const aState = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    for (const a of [aOrigin, aDir, aLen, aState]) a.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iOrigin', aOrigin);
    geometry.setAttribute('iDir', aDir);
    geometry.setAttribute('iColor', aColor);
    geometry.setAttribute('iLen', aLen);
    geometry.setAttribute('iState', aState);

    // Linear-sRGB body colours (THREE.Color converts from the sRGB hex).
    const tmpColor = new THREE.Color();
    for (let i = 0; i < N; i++) {
        tmpColor.set(BODIES[i].color);
        aColor.array[i * 3] = tmpColor.r;
        aColor.array[i * 3 + 1] = tmpColor.g;
        aColor.array[i * 3 + 2] = tmpColor.b;
    }

    // Double-precision mirrors for CPU queries (getTip, label anchors).
    const origin = new Float64Array(3);
    const dirs = new Float64Array(N * 3);
    const fullLen = new Float64Array(N).fill(FAR_LEN);
    const below = new Uint8Array(N);
    const progress = new Float64Array(N).fill(1);
    const launchStart = new Float64Array(N);
    const anchors = BODIES.map(() => new Float64Array([NaN, NaN, NaN]));
    let hasSnap = false;
    for (let i = 0; i < N; i++) dirs[i * 3] = 1;

    const uniforms = {
        uNear: { value: 0.05 },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uGlowPx: { value: 12 },
        uDpr: { value: 1 },
        uPulses: { value: 0 },
        uPhase: { value: 0 },
        uFade: { value: 1 },
        uSelActive: { value: 0 },
    };
    const common = {
        uniforms,
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
    };
    const matA = new THREE.ShaderMaterial({ ...common, name: 'beams.A' });
    const matB = new THREE.ShaderMaterial({ ...common, name: 'beams.B.xray', defines: { XRAY: '' } });
    matB.depthFunc = THREE.GreaterDepth;

    const meshA = new THREE.Mesh(geometry, matA);
    const meshB = new THREE.Mesh(geometry, matB);
    meshA.name = 'beams.A';
    meshB.name = 'beams.B';
    meshA.renderOrder = 30;
    meshB.renderOrder = 31;
    for (const m of [meshA, meshB]) {
        m.frustumCulled = false;
        m.matrixAutoUpdate = false;
    }
    const group = new THREE.Group();
    group.name = 'beams';
    group.add(meshA, meshB);

    const layers = { beams: true, ghostBeams: true, sunMoonBeams: true };
    let selected = -1;
    let skyBlend = 0;
    let glowPx = 12;
    let pulsesTarget = 0;
    let launching = false;
    /** @type {null|((done:boolean)=>void)} */
    let launchResolve = null;
    let lastNow = now();

    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* a redraw request must never throw */ } };

    function readTier(cfg) {
        const c = cfg && typeof cfg === 'object' ? cfg : rc?.tier;
        if (c && typeof c === 'object' && Number.isFinite(c.beamGlowPx)) glowPx = c.beamGlowPx;
    }
    readTier(rc?.tier);

    function writeStates() {
        const s = aState.array;
        for (let i = 0; i < N; i++) {
            const isSunMoon = i === SUN || i === MOON;
            const visible = layers.beams && (!isSunMoon || layers.sunMoonBeams);
            s[i * 4] = i === selected ? 1 : 0;
            s[i * 4 + 1] = below[i];
            s[i * 4 + 2] = visible ? 1 : 0;
            s[i * 4 + 3] = progress[i];
        }
        aState.needsUpdate = true;
        uniforms.uSelActive.value = selected >= 0 ? 1 : 0;
    }

    function updateVisibility() {
        group.visible = layers.beams && skyBlend < 0.5;
        meshB.visible = layers.ghostBeams;
    }

    /**
     * Copies the snapshot's observer origin and body directions into the
     * instance buffers.
     * @param {object} snap Snapshot (SPEC §C.1).
     */
    function apply(snap) {
        if (!snap || !snap.observer || !snap.bodies) return;
        const p = snap.observer.posS;
        origin[0] = p[0] * ORIGIN_LIFT;
        origin[1] = p[1] * ORIGIN_LIFT;
        origin[2] = p[2] * ORIGIN_LIFT;
        const o = aOrigin.array, d = aDir.array, l = aLen.array;
        for (let i = 0; i < N; i++) {
            const st = snap.bodies[i];
            if (!st) continue;
            o[i * 3] = origin[0]; o[i * 3 + 1] = origin[1]; o[i * 3 + 2] = origin[2];
            const v = st.dirS;
            dirs[i * 3] = v[0]; dirs[i * 3 + 1] = v[1]; dirs[i * 3 + 2] = v[2];
            d[i * 3] = v[0]; d[i * 3 + 1] = v[1]; d[i * 3 + 2] = v[2];
            fullLen[i] = i === MOON && st.distER > 2 ? st.distER - MOON_GAP : FAR_LEN;
            l[i] = fullLen[i];
            // `above` is refraction- and limb-aware (filled at every detail level);
            // fall back to the geometric altitude for a partial snapshot.
            below[i] = (typeof st.above === 'boolean' ? !st.above : st.altGeomDeg < 0) ? 1 : 0;
        }
        aOrigin.needsUpdate = true;
        aDir.needsUpdate = true;
        aLen.needsUpdate = true;
        hasSnap = true;
        writeStates();
    }

    function settleLaunch(done) {
        launching = false;
        const r = launchResolve;
        launchResolve = null;
        if (r) r(done);
    }

    function stepLaunch(t) {
        if (!launching) return;
        let all = true;
        for (let i = 0; i < N; i++) {
            const k = Math.min(1, Math.max(0, (t - launchStart[i]) / LAUNCH_MS));
            progress[i] = k >= 1 ? 1 : easeInOutSine(k);
            if (k < 1) all = false;
        }
        writeStates();
        if (all) settleLaunch(true);
    }

    const _size = new THREE.Vector2();
    const _iv = { lo: 0, hi: 0 };

    /**
     * Per-frame update: uniforms, pulse phase, launch tween and label anchors.
     * @param {object} fi FrameInfo (SPEC §C.1).
     */
    function update(fi) {
        const t = now();
        const dtMs = fi && Number.isFinite(fi.dtMs) ? fi.dtMs : Math.min(100, Math.max(0, t - lastNow));
        lastNow = t;
        if (fi && Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
        uniforms.uFade.value = 1 - smoothstep(0.2, 0.5, skyBlend);
        updateVisibility();

        const cam = (fi && fi.camera) || rc?.camera;
        if (cam) uniforms.uNear.value = cam.near;
        const r = rc?.renderer;
        if (r) {
            r.getDrawingBufferSize(_size);
            uniforms.uViewport.value.copy(_size);
            const dpr = r.getPixelRatio();
            uniforms.uDpr.value = dpr;
            uniforms.uGlowPx.value = glowPx * dpr;
        }

        // Pulses ease in and out over ~250 ms; the phase lives on the CPU so it never loses precision.
        pulsesTarget = fi && fi.pulsesActive && !reducedMotion ? 1 : 0;
        const pv = uniforms.uPulses.value;
        if (pv !== pulsesTarget) {
            const step = dtMs / 250;
            uniforms.uPulses.value = pulsesTarget > pv ? Math.min(pulsesTarget, pv + step) : Math.max(pulsesTarget, pv - step);
            invalidate();
        }
        if (uniforms.uPulses.value > 0) {
            uniforms.uPhase.value = (uniforms.uPhase.value + (dtMs / 1000) * PULSE_HZ) % 1;
        }

        if (launching) {
            stepLaunch(t);
            invalidate();
        }
        if (cam) computeAnchors(cam);
    }

    // ---- label anchors ---------------------------------------------------------------------

    const _mv = new Float64Array(16);
    const _pm = new Float64Array(16);
    // Per body: the chosen distance, the lower bound of the on-screen interval, and the
    // clip-space coefficients c(d) = c0 + d*c1 as (x0, y0, w0, x1, y1, w1).
    const _d = new Float64Array(N);
    const _lo = new Float64Array(N);
    const _cc = new Float64Array(N * 6);
    const _cand = new Uint8Array(N);
    const _order = new Int8Array(N);
    const _boxes = new Float64Array((N + 1 + MAX_OCCLUDERS) * 4);   // + observer label, UI rects

    /**
     * Writes, per body, the world point its label should sit on. In orbit view it is
     * the farthest point of the beam inside the free part of the viewport (inset by the
     * UI-covered edges in `rc.size.insets` and by the label's own extent, so the text
     * never runs off-screen or under a panel), in front of the camera and not hidden by
     * the Earth. A beam that leaves the screen is therefore labelled where it exits, as
     * an edge indicator. Labels that would overlap slide back along their beams
     * (selected first, then the Sun and Moon, then the planets). Elsewhere the anchor
     * is a point far along the direction from the camera (at infinity).
     */
    function computeAnchors(cam) {
        const mv = cam.matrixWorldInverse.elements;
        const pm = cam.projectionMatrix.elements;
        for (let k = 0; k < 16; k++) { _mv[k] = mv[k]; _pm[k] = pm[k]; }
        const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
        const size = rc?.size;
        const w = size && size.w > 0 ? size.w : 1;
        const h = size && size.h > 0 ? size.h : 1;
        const ins = size?.insets;
        const insL = ins ? ins.left || 0 : 0, insR = ins ? ins.right || 0 : 0;
        const insT = ins ? ins.top || 0 : 0, insB = ins ? ins.bottom || 0 : 0;
        // Free area for the anchor point (CSS px), before the per-body text extent.
        const ax0 = insL + LABEL_PAD + LABEL_LEFT;
        const ay0 = insT + LABEL_PAD + LABEL_HALF_H;
        const ay1 = h - insB - LABEL_PAD - LABEL_HALF_H;
        const yTop = 1 - (2 * ay0) / h, yBot = 1 - (2 * ay1) / h;
        const xa = (2 * ax0) / w - 1;
        const near = cam.near * 1.05;
        const beamsShown = group.visible;
        const st = aState.array;

        for (let i = 0; i < N; i++) {
            const out = anchors[i];
            _cand[i] = 0;
            const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
            if (!hasSnap || progress[i] < 0.98) { out[0] = out[1] = out[2] = NaN; continue; }
            const instanceShown = beamsShown && st[i * 4 + 2] > 0.5;
            const xb = (2 * (w - insR - LABEL_PAD - rightExtent(i))) / w - 1;
            if (!instanceShown || !(xb > xa) || !(yTop > yBot)) {
                // At infinity: far along the direction from the camera.
                out[0] = cx + dx * 1e3; out[1] = cy + dy * 1e3; out[2] = cz + dz * 1e3;
                continue;
            }
            const len = fullLen[i];
            const ox = origin[0], oy = origin[1], oz = origin[2];
            // View-space origin and direction.
            const vox = _mv[0] * ox + _mv[4] * oy + _mv[8] * oz + _mv[12];
            const voy = _mv[1] * ox + _mv[5] * oy + _mv[9] * oz + _mv[13];
            const voz = _mv[2] * ox + _mv[6] * oy + _mv[10] * oz + _mv[14];
            const vdx = _mv[0] * dx + _mv[4] * dy + _mv[8] * dz;
            const vdy = _mv[1] * dx + _mv[5] * dy + _mv[9] * dz;
            const vdz = _mv[2] * dx + _mv[6] * dy + _mv[10] * dz;
            // Clip coordinates are affine in the distance d: c(d) = c0 + d*c1.
            const x0 = _pm[0] * vox + _pm[4] * voy + _pm[8] * voz + _pm[12];
            const y0 = _pm[1] * vox + _pm[5] * voy + _pm[9] * voz + _pm[13];
            const w0 = _pm[3] * vox + _pm[7] * voy + _pm[11] * voz + _pm[15];
            const x1 = _pm[0] * vdx + _pm[4] * vdy + _pm[8] * vdz;
            const y1 = _pm[1] * vdx + _pm[5] * vdy + _pm[9] * vdz;
            const w1 = _pm[3] * vdx + _pm[7] * vdy + _pm[11] * vdz;
            _iv.lo = LABEL_MIN_D;
            _iv.hi = len;
            // Each constraint a + b*d >= 0 (free-area sides in NDC, in front of the near plane) narrows [lo, hi].
            narrow(_iv, x0 - xa * w0, x1 - xa * w1);
            narrow(_iv, xb * w0 - x0, xb * w1 - x1);
            narrow(_iv, y0 - yBot * w0, y1 - yBot * w1);
            narrow(_iv, yTop * w0 - y0, yTop * w1 - y1);
            narrow(_iv, -voz - near, -vdz);
            const lo = _iv.lo, hi = _iv.hi;
            if (!(hi >= lo)) {
                out[0] = cx + dx * 1e3; out[1] = cy + dy * 1e3; out[2] = cz + dz * 1e3;
                continue;
            }
            // Walk back from the far end (log-spaced) to the first point not hidden by the Earth.
            let d = hi;
            const ratio = Math.pow(lo / hi, 1 / 15);
            let found = false;
            for (let s = 0; s < 16; s++) {
                if (!occludedBySphere(cx, cy, cz, ox + dx * d, oy + dy * d, oz + dz * d)) { found = true; break; }
                d *= ratio;
            }
            if (!found) d = hi;
            _d[i] = d;
            _lo[i] = lo;
            const o = i * 6;
            _cc[o] = x0; _cc[o + 1] = y0; _cc[o + 2] = w0; _cc[o + 3] = x1; _cc[o + 4] = y1; _cc[o + 5] = w1;
            _cand[i] = found ? 1 : 0;
            out[0] = ox + dx * d; out[1] = oy + dy * d; out[2] = oz + dz * d;
        }
        separateLabels(cx, cy, cz, w, h);
    }

    /** Px a body's label extends right of its anchor: measured when available, else estimated. */
    function rightExtent(i) {
        const e = labelExtent(BODIES[i].id);
        const r = e ? e[2] : LABEL_RIGHT[i];
        return i === selected ? r + LABEL_SEL_EXTRA : r;
    }

    /**
     * Reserves the observer's label box (slot 0) when it has been measured and the pin
     * is in front of the camera; returns the number of slots used (0 or 1).
     */
    function reserveObserver(w, h) {
        const e = labelExtent('observer');
        if (!e) return 0;
        const k = OBSERVER_LABEL_R / ORIGIN_LIFT;
        const px = origin[0] * k, py = origin[1] * k, pz = origin[2] * k;
        const vx = _mv[0] * px + _mv[4] * py + _mv[8] * pz + _mv[12];
        const vy = _mv[1] * px + _mv[5] * py + _mv[9] * pz + _mv[13];
        const vz = _mv[2] * px + _mv[6] * py + _mv[10] * pz + _mv[14];
        const X = _pm[0] * vx + _pm[4] * vy + _pm[8] * vz + _pm[12];
        const Y = _pm[1] * vx + _pm[5] * vy + _pm[9] * vz + _pm[13];
        const W = _pm[3] * vx + _pm[7] * vy + _pm[11] * vz + _pm[15];
        if (!(W > 1e-9)) return 0;
        const sx = (X / W * 0.5 + 0.5) * w, sy = (0.5 - Y / W * 0.5) * h;
        _boxes[0] = sx + e[0] - LABEL_GAP;
        _boxes[1] = sy + e[1] - LABEL_GAP;
        _boxes[2] = sx + e[2] + LABEL_GAP;
        _boxes[3] = sy + e[3] + LABEL_GAP;
        return 1;
    }

    /** Label box of body i at distance d along its beam into slot k of _boxes; false when behind the camera. */
    function boxAt(i, d, w, h, k) {
        const o = i * 6;
        const X = _cc[o] + d * _cc[o + 3], Y = _cc[o + 1] + d * _cc[o + 4], W = _cc[o + 2] + d * _cc[o + 5];
        if (!(W > 1e-9)) return false;
        const sx = (X / W * 0.5 + 0.5) * w, sy = (0.5 - Y / W * 0.5) * h;
        const b = k * 4;
        const e = labelExtent(BODIES[i].id);
        _boxes[b] = sx + (e ? e[0] : -LABEL_LEFT) - LABEL_GAP;
        _boxes[b + 1] = sy + (e ? e[1] : -LABEL_HALF_H) - LABEL_GAP;
        _boxes[b + 2] = sx + rightExtent(i) + LABEL_GAP;
        _boxes[b + 3] = sy + (e ? e[3] : LABEL_HALF_H) + LABEL_GAP;
        return true;
    }

    /** True when box slot k overlaps any of the slots from..k-1. */
    function overlapsPlaced(k, from) {
        const b = k * 4;
        for (let j = from; j < k; j++) {
            const c = j * 4;
            if (_boxes[b] < _boxes[c + 2] && _boxes[b + 2] > _boxes[c]
                && _boxes[b + 1] < _boxes[c + 3] && _boxes[b + 3] > _boxes[c + 1]) return true;
        }
        return false;
    }

    /**
     * Greedy de-overlap of the beam labels in label-priority order, around the observer's
     * own label and the floating UI (labels.js uiOccluders, which the DOM labels hide
     * under): a label that would cover an earlier one slides back toward the observer
     * along its own beam (staying inside the free area and unoccluded). A body label
     * outranks the observer's (SPEC priorities), so when the only spot clear of other
     * body labels covers the observer's label it takes it; with no spot at all it keeps
     * its place and the DOM declutter decides.
     */
    function separateLabels(cx, cy, cz, w, h) {
        let n = 0;
        if (selected >= 0 && _cand[selected]) _order[n++] = selected;
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < N; i++) {
                if (!_cand[i] || i === selected) continue;
                const sunMoon = i === SUN || i === MOON;
                if ((pass === 0) === sunMoon) _order[n++] = i;
            }
        }
        if (n === 0) return;
        const obs = reserveObserver(w, h);
        let placed = obs;
        const occ = uiOccluders();
        for (let k = 0, m = Math.min(occ.count, MAX_OCCLUDERS); k < m; k++) {
            const b = placed * 4, o = k * 4;
            _boxes[b] = occ.rects[o]; _boxes[b + 1] = occ.rects[o + 1];
            _boxes[b + 2] = occ.rects[o + 2]; _boxes[b + 3] = occ.rects[o + 3];
            placed++;
        }
        for (let k = 0; k < n; k++) {
            const i = _order[k];
            const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
            let d = _d[i];
            let fallback = -1;
            let ok = false;
            for (let s = 0; s < 25; s++) {
                if (s > 0) {
                    d *= 0.86;
                    if (d < _lo[i]) break;
                    if (occludedBySphere(cx, cy, cz, origin[0] + dx * d, origin[1] + dy * d, origin[2] + dz * d)) continue;
                }
                if (!boxAt(i, d, w, h, placed)) break;
                if (!overlapsPlaced(placed, 0)) { ok = true; break; }
                if (fallback < 0 && obs && !overlapsPlaced(placed, obs)) fallback = d;
            }
            if (!ok) {
                // Clear of the body labels only, or else the original spot; either way it is
                // reserved so later labels avoid it too.
                d = fallback >= 0 ? fallback : _d[i];
                if (!boxAt(i, d, w, h, placed)) continue;
            }
            placed++;
            const out = anchors[i];
            out[0] = origin[0] + dx * d; out[1] = origin[1] + dy * d; out[2] = origin[2] + dz * d;
        }
    }

    // ---- public API --------------------------------------------------------------------------

    /**
     * Grows every beam from the pin, staggered in BODIES order.
     * @param {{staggerMs?:number, durationMs?:number}} [opts]
     * @returns {Promise<boolean>} true when the launch completed, false if superseded or skipped.
     */
    function launch({ staggerMs = 120 } = {}) {
        if (launchResolve) settleLaunch(false);
        if (reducedMotion) {
            progress.fill(1);
            writeStates();
            invalidate();
            return Promise.resolve(true);
        }
        const t0 = now();
        const stagger = Number.isFinite(staggerMs) ? Math.max(0, staggerMs) : 120;
        for (let i = 0; i < N; i++) {
            launchStart[i] = t0 + i * stagger;
            progress[i] = 0;
        }
        launching = true;
        writeStates();
        invalidate();
        return new Promise((resolve) => { launchResolve = resolve; });
    }

    /** Hides every beam until the next launch() (e.g. at the start of the intro). */
    function prime() {
        if (launchResolve) settleLaunch(false);
        progress.fill(0);
        writeStates();
        invalidate();
    }

    /** Completes any running launch immediately. */
    function skipLaunch() {
        progress.fill(1);
        writeStates();
        if (launchResolve) settleLaunch(false);
        launching = false;
        invalidate();
    }

    /**
     * Current tip of a beam (world point), following the launch animation.
     * @param {string} id BodyId
     * @param {Float64Array|number[]|{x:number,y:number,z:number,set?:Function}} out3
     * @returns {typeof out3|null}
     */
    function getTip(id, out3) {
        const i = ID_INDEX[id];
        if (i === undefined || !out3) return null;
        const full = Math.max(fullLen[i], 0.02);
        const p = progress[i];
        const len = p >= 1 ? full : 0.02 * Math.pow(full / 0.02, p);
        const x = origin[0] + dirs[i * 3] * len;
        const y = origin[1] + dirs[i * 3 + 1] * len;
        const z = origin[2] + dirs[i * 3 + 2] * len;
        if (typeof out3.set === 'function' && 'x' in out3) out3.set(x, y, z);
        else { out3[0] = x; out3[1] = y; out3[2] = z; }
        return out3;
    }

    /**
     * Live world-space label point for a body (see module docs); NaN until the beam lands.
     * @param {string} id BodyId
     * @returns {Float64Array|null}
     */
    function labelAnchor(id) {
        const i = ID_INDEX[id];
        return i === undefined ? null : anchors[i];
    }

    /** @param {string} id @returns {boolean} true once the body's beam has fully launched. */
    function isLanded(id) {
        const i = ID_INDEX[id];
        return i !== undefined && progress[i] >= 1;
    }

    writeStates();
    updateVisibility();

    return {
        object3d: group,
        apply,
        update,
        setLayers(l) {
            if (!l) return;
            layers.beams = l.beams !== false;
            layers.ghostBeams = l.ghostBeams !== false;
            layers.sunMoonBeams = l.sunMoonBeams !== false;
            writeStates();
            updateVisibility();
            invalidate();
        },
        setViewMode(mode, sb) {
            skyBlend = Number.isFinite(sb) ? sb : mode === 'sky' ? 1 : 0;
            uniforms.uFade.value = 1 - smoothstep(0.2, 0.5, skyBlend);
            updateVisibility();
            invalidate();
        },
        setSelection(id) {
            const i = id == null ? -1 : ID_INDEX[id] ?? -1;
            if (i === selected) return;
            selected = i;
            writeStates();
            invalidate();
        },
        setQuality(cfg) {
            readTier(cfg);
            invalidate();
        },
        setReducedMotion(on) {
            reducedMotion = !!on;
            if (reducedMotion && launching) skipLaunch();
        },
        launch,
        prime,
        skipLaunch,
        getTip,
        labelAnchor,
        isLanded,
        get launching() { return launching; },
        dispose() {
            if (launchResolve) settleLaunch(false);
            group.removeFromParent();
            geometry.dispose();
            matA.dispose();
            matB.dispose();
        },
    };
}

/** Intersects the interval iv with {d : a + b·d ≥ 0}. */
function narrow(iv, a, b) {
    if (Math.abs(b) < 1e-12) {
        if (a < 0) iv.hi = -Infinity;
        return;
    }
    const r = -a / b;
    if (b > 0) {
        if (r > iv.lo) iv.lo = r;
    } else if (r < iv.hi) {
        iv.hi = r;
    }
}

function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * True when the segment from the camera C to the point P passes through the
 * unit sphere before reaching P.
 */
function occludedBySphere(cx, cy, cz, px, py, pz) {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const L = Math.hypot(dx, dy, dz);
    if (!(L > 0)) return false;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    const b = cx * ux + cy * uy + cz * uz;
    const c = cx * cx + cy * cy + cz * cz - 1;
    if (c <= 0) return false; // camera inside the sphere (never in practice)
    const disc = b * b - c;
    if (disc <= 0) return false;
    const t0 = -b - Math.sqrt(disc);
    return t0 > 0 && t0 < L * (1 - 1e-4);
}
