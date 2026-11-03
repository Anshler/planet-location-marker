/**
 * Planet medallions (orbit view): each planet's beam ends in a magnified, phase-correct mini-globe
 * at the beam's label anchor (beams.labelAnchor), drawn by the shared impostor shader
 * (shaders/planets.glsl.js) — Venus's crescent, Mars's real central meridian, Jupiter's belts with
 * its four moons beside it and their shadows on it, Saturn's rings at today's opening. Magnified
 * on purpose (a fixed ~26 CSS px, ~40 px when selected); the label's eyepiece ring and its
 * 'magnified' title say so.
 *
 * Orientation: planet north up (astro/disc.js discFrame with the pole as up), as in the body card's
 * eyepiece portrait, so the two always agree; on a north-up sky, east is to the left. Jupiter's
 * moons sit at their true side and order, spaced logarithmically beyond the limb (disc.js
 * compressRadius); a moon behind Jupiter or in its shadow is not drawn.
 *
 * The medallion of a planet follows its label anchor, so it waits for its beam to land in the
 * intro (NaN anchors), hides with the beams layer and fades out with the sky-view transition.
 * Labels (app/labels-feed.js) reserve the medallion's footprint ({@link medallionFootprint}) and
 * tell beams.js, so beam labels slide apart far enough not to cover each other's medallion.
 *
 * Reuse: `PLANET_CHUNK`, `planetUniforms` and `PLANET_KIND` (shaders/planets.glsl.js), plus
 * {@link writeDiscInstance} and {@link writeJupiterMoons} here, are everything a true-scale
 * impostor needs (e.g. a sky-view telescope zoom with the camera's up as the frame's up).
 *
 * @module render/planets
 */
import * as THREE from 'three';
import { BODIES } from '../astro/bodies.js';
import { SHAPES, createDiscFrame, createDiscView, discFrame, discView, toFrame, compressRadius, RING_OUTER } from '../astro/disc.js';
import { GALILEAN, MOON_OCCULTED, MOON_ECLIPSED, MOON_SHADOW } from '../astro/moons.js';
import { PLANET_KIND, MEDALLION_VERT, MEDALLION_FRAG, planetUniforms, grsLongitudeDeg, } from './shaders/planets.glsl.js';

const FIRST_PLANET = 2;
const N = BODIES.length - FIRST_PLANET;
const JUP = BODIES.findIndex((b) => b.id === 'jupiter') - FIRST_PLANET;
/** Footprint radius of a medallion, CSS px (its eyepiece ring), and when selected. */
export const MEDALLION_R = 13;
export const MEDALLION_SEL_R = 20;
/** Globe radius as a share of the footprint radius (Saturn leaves room for its rings, Jupiter for its moons). */
const GLOBE_K = Object.freeze({ mercury: 0.8, venus: 1, mars: 0.9, jupiter: 0.82, saturn: 0.56, uranus: 0.8, neptune: 0.8 });
/** Half-extent of the drawing in equatorial radii (rings; the moons' compressed reach plus a dot). */
const MOON_REACH = compressRadius(27) + 0.12;
const EXTENT = Object.freeze({ saturn: RING_OUTER + 0.04, jupiter: MOON_REACH });
/** Linear-light gain: keeps a lit albedo below the bloom threshold and its hue through ACES. */
const GAIN = 0.95;
/** Fade of a medallion appearing or hiding with its label, ms. */
const FADE_MS = 180;
const BELOW_ALPHA = 0.6;
const JUP_R_KM = SHAPES.jupiter.eqRadiusKm;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * A medallion's label footprint in CSS px: [width, height, eyepiece-ring diameter], or null for a
 * body without one (the Sun and the Moon). The label pool sizes the label's dot to it, so the
 * measured label box (and beams.js de-overlap) covers the medallion.
 * @param {string} id
 * @param {boolean} selected
 * @returns {[number, number, number]|null}
 */
export function medallionFootprint(id, selected) {
    const k = GLOBE_K[id];
    if (!k) return null;
    const F = selected ? MEDALLION_SEL_R : MEDALLION_R;
    const R = F * k;
    const ext = EXTENT[id] ?? 1;
    const halfW = Math.max(F, R * ext);
    const ring = id === 'saturn' ? 2 * R * ext + 2 : 2 * F;
    const halfH = Math.max(F, ring / 2);
    return [Math.round(2 * halfW), Math.round(2 * halfH), Math.round(ring)];
}

/**
 * Writes one impostor instance's frame vectors (frame coordinates, see astro/disc.js) into three
 * attribute arrays at index i: pole, prime meridian, light. `upS` picks the frame's up (a pole for
 * planet-north-up, a camera's up for the true view).
 * @param {object} st BodyState
 * @param {ArrayLike<number>} upS
 * @param {import('../astro/disc.js').DiscFrame} frame scratch, filled
 * @param {import('../astro/disc.js').DiscView} view scratch, filled
 * @param {Float32Array} pole @param {Float32Array} prime @param {Float32Array} light
 * @param {number} i
 */
export function writeDiscInstance(st, upS, frame, view, pole, prime, light, i) {
    discFrame(st.dirS, upS, frame);
    discView(st, frame, view);
    const o = i * 3;
    for (let k = 0; k < 3; k++) {
        pole[o + k] = view.pole[k];
        prime[o + k] = view.prime[k];
        light[o + k] = view.light[k];
    }
}

const MOON_TMP = new Float64Array(3);
const MOON_R = GALILEAN.map((m) => m.radiusKm / JUP_R_KM);

/**
 * Fills the impostor's uPlMoon/uPlShadow uniforms from a snapshot, in Jupiter's frame `frame`
 * (from {@link writeDiscInstance} for Jupiter). `compress`: log spacing beyond the limb
 * (medallions) or true positions (false: a true-scale view).
 * @param {object} snap Snapshot
 * @param {import('../astro/disc.js').DiscFrame} frame
 * @param {{uPlMoon:{value:THREE.Vector4[]}, uPlShadow:{value:THREE.Vector4[]}}} uniforms
 * @param {boolean} compress
 */
export function writeJupiterMoons(snap, frame, uniforms, compress) {
    const g = snap.galilean;
    for (let k = 0; k < 4; k++) {
        const m = uniforms.uPlMoon.value[k], s = uniforms.uPlShadow.value[k];
        const f = g.state[k];
        toFrame(frame, g.offS, MOON_TMP, 0, k * 3);
        let x = MOON_TMP[0], y = MOON_TMP[1];
        const r = Math.hypot(x, y);
        if (compress && r > 1) { const c = compressRadius(r) / r; x *= c; y *= c; }
        m.set(x, y, f & (MOON_OCCULTED | MOON_ECLIPSED) ? 0 : 1, MOON_R[k]);
        if (f & MOON_SHADOW) {
            toFrame(frame, g.shadowS, MOON_TMP, 0, k * 3);
            s.set(MOON_TMP[0], MOON_TMP[1], 1, MOON_R[k]);
        } else s.set(0, 0, 0, 0);
    }
}

/**
 * Creates the medallions module.
 * @param {object} rc RenderContext
 * @param {{beams?:{labelAnchor:(id:string)=>Float64Array|null, setFootprint?:Function}|null,
 *   isLabelShown?:(id:string)=>boolean|null}} [deps] `isLabelShown` (labels.isShown): a medallion hides with its label
 * @returns {object} RenderModule & {enabled:boolean, footprint:(id:string, selected:boolean)=>number[]|null}
 */
export function createPlanets(rc, deps = {}) {
    const beams = deps.beams ?? null;
    const isLabelShown = typeof deps.isLabelShown === 'function' ? deps.isLabelShown : null;
    const shownK = new Float64Array(N);
    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* a redraw request must never throw */ } };
    const group = new THREE.Group();
    group.name = 'planets';

    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setIndex(quad.getIndex());
    const attr = (n) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(N * n), n);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
    };
    const iCenter = attr(3), iPole = attr(3), iPrime = attr(3), iLight = attr(3), iShape = attr(4), iAlpha = attr(1);
    geo.setAttribute('iCenter', iCenter);
    geo.setAttribute('iPole', iPole);
    geo.setAttribute('iPrime', iPrime);
    geo.setAttribute('iLight', iLight);
    geo.setAttribute('iShape', iShape);
    geo.setAttribute('iAlpha', iAlpha);
    geo.instanceCount = N;
    const ids = BODIES.slice(FIRST_PLANET).map((b) => b.id);
    for (let i = 0; i < N; i++) {
        const id = ids[i];
        iShape.array[i * 4] = PLANET_KIND[id];
        iShape.array[i * 4 + 1] = SHAPES[id].flattening;
        iShape.array[i * 4 + 2] = (EXTENT[id] ?? 1.06);
        iShape.array[i * 4 + 3] = MEDALLION_R;
    }

    const uniforms = {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uGain: { value: GAIN },
        ...planetUniforms(THREE),
    };
    const material = new THREE.ShaderMaterial({
        name: 'planets.medallions', uniforms, vertexShader: MEDALLION_VERT, fragmentShader: MEDALLION_FRAG,
        transparent: true, depthWrite: false, depthTest: true,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'planets.medallions';
    mesh.frustumCulled = false;
    mesh.renderOrder = 33;   // over the beams (30, 31) that end in it
    group.add(mesh);

    const frame = createDiscFrame();
    const view = createDiscView();
    const jupFrame = createDiscFrame();
    const size = new THREE.Vector2();
    let hasSnap = false;
    let beamsOn = true;
    let skyBlend = 0;
    let selected = '';
    let disposed = false;
    let lastSnap = null;

    function setDetail(cfg) {
        const name = cfg && cfg.name;
        uniforms.uPlDetail.value = name === 'low' ? 0 : name === 'max' ? 2 : 1;
    }
    setDetail(rc && rc.tier);

    function apply(snap) {
        if (!snap || !snap.bodies || !snap.galilean) return;
        for (let i = 0; i < N; i++) {
            const st = snap.bodies[FIRST_PLANET + i];
            writeDiscInstance(st, st.poleS, frame, view, iPole.array, iPrime.array, iLight.array, i);
            if (i === JUP) {
                jupFrame.ex.set(frame.ex); jupFrame.ey.set(frame.ey); jupFrame.ez.set(frame.ez);
            }
        }
        iPole.needsUpdate = iPrime.needsUpdate = iLight.needsUpdate = true;
        writeJupiterMoons(snap, jupFrame, uniforms, true);
        uniforms.uPlGrsLon.value = grsLongitudeDeg(snap.tMs);
        lastSnap = snap;
        hasSnap = true;
    }

    function update(fi) {
        if (fi && Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
        const fade = 1 - smooth(0.2, 0.5, skyBlend);
        const on = hasSnap && beamsOn && fade > 0.002 && !!beams;
        mesh.visible = on;
        if (!on) return;
        const r = rc && rc.renderer;
        let dpr = 1;
        if (r) {
            r.getDrawingBufferSize(size);
            uniforms.uViewport.value.copy(size);
            dpr = r.getPixelRatio();
        }
        uniforms.uPlDotPx.value = 1.3 * dpr;
        const c = iCenter.array, s = iShape.array, a = iAlpha.array;
        const step = (fi && Number.isFinite(fi.dtMs) ? fi.dtMs : 16) / FADE_MS;
        let animating = false;
        for (let i = 0; i < N; i++) {
            const id = ids[i];
            const p = beams.labelAnchor(id);
            const ok = p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
            // A medallion and its label are one unit: it fades with the label (decluttered, under
            // the UI); with no label at all (labels layer off) it follows the anchor alone.
            let want = ok ? 1 : 0;
            if (ok && isLabelShown) {
                let sh = null;
                try { sh = isLabelShown(id); } catch { sh = null; }
                if (sh === false) want = 0;
            }
            const k = shownK[i];
            shownK[i] = want > k ? Math.min(want, k + step) : Math.max(want, k - step);
            if (shownK[i] !== want) animating = true;
            if (!ok || shownK[i] <= 0) { a[i] = 0; continue; }
            c[i * 3] = p[0]; c[i * 3 + 1] = p[1]; c[i * 3 + 2] = p[2];
            const F = id === selected ? MEDALLION_SEL_R : MEDALLION_R;
            s[i * 4 + 3] = F * GLOBE_K[id] * dpr;
            const st = lastSnap && lastSnap.bodies[FIRST_PLANET + i];
            const below = st && typeof st.above === 'boolean' ? !st.above : false;
            a[i] = fade * shownK[i] * (below ? BELOW_ALPHA : 1);
        }
        iCenter.needsUpdate = iShape.needsUpdate = iAlpha.needsUpdate = true;
        if (animating) invalidate();
    }

    function syncFootprints() {
        if (!beams || typeof beams.setFootprint !== 'function') return;
        for (const id of ids) {
            const fp = beamsOn && !disposed ? medallionFootprint(id, id === selected) : null;
            beams.setFootprint(id, fp ? fp[0] / 2 : 0, fp ? fp[1] / 2 : 0);
        }
    }
    syncFootprints();

    return {
        object3d: group,
        apply,
        update,
        setLayers(l) {
            if (!l) return;
            beamsOn = l.beams !== false;
            syncFootprints();
        },
        setViewMode(mode, sb) {
            skyBlend = Number.isFinite(sb) ? sb : mode === 'sky' ? 1 : 0;
        },
        setSelection(id) {
            selected = id || '';
            syncFootprints();
        },
        setQuality(cfg) {
            setDetail(cfg);
        },
        /** True while medallions are drawn in orbit view (layers allow them and the module runs). */
        get enabled() { return !disposed && beamsOn; },
        footprint: medallionFootprint,
        dispose() {
            disposed = true;
            syncFootprints();
            group.removeFromParent();
            geo.dispose();
            quad.dispose();
            material.dispose();
        },
    };
}
