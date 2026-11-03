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
 * Telescope (sky view): the same impostor at true scale and orientation (the frame's up is the
 * camera's), on a second instanced mesh at infinity. Each planet cross-fades in from its glyph as
 * its disc passes 1.5-4 device px of radius (astro/disc.js scopeBlend; render/bodies.js fades the
 * glyph out by the same weight), with the phase, oblateness, ring opening and Jupiter's moon
 * shadows of the medallions. Jupiter's four moons are discs of their own (true size, at least
 * ~1 px), shown below a 6 deg field, hidden behind or in front of the disc and in its shadow.
 * Exposure and extinction follow the glyphs; the moons are telescope-bright (the aperture gain).
 *
 *
 * @module render/planets
 */
import * as THREE from 'three';
import { BODIES } from '../astro/bodies.js';
import {
    SHAPES, createDiscFrame, createDiscView, discFrame, discView, toFrame, compressRadius, RING_OUTER, scopeBlend, eqAngRadius,
} from '../astro/disc.js';
import { GALILEAN, MOON_OCCULTED, MOON_ECLIPSED, MOON_SHADOW, MOON_TRANSIT } from '../astro/moons.js';
import { PLANET_KIND, MEDALLION_VERT, MEDALLION_FRAG, SCOPE_VERT, SCOPE_FRAG, planetUniforms, grsLongitudeDeg, } from './shaders/planets.glsl.js';
import { extinctionRGB } from './bodies.js';
import { skyViewExposure } from './sky.js';

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
/** Telescope: Jupiter's moons fade in as the field narrows from 6 deg to 3 deg. */
const SCOPE_MOONS_FOV = [3, 6];
const SCOPE_MOON = 7;
const NS = N + 4;
/**
 * Telescope: relative surface brightness of each disc, Jupiter = 1 (true contrasts of ~5 magnitudes
 * per square arcsecond, from Venus to Neptune, compressed to a display range).
 */
const SCOPE_SB = Object.freeze({ mercury: 1.6, venus: 2.2, mars: 1.15, jupiter: 1, saturn: 0.8, uranus: 0.6, neptune: 0.5 });

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
const _dir = new Float64Array(3);
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

    // --- Telescope: true-scale impostors and Jupiter's moons in sky view --------------------------
    const sgeo = new THREE.InstancedBufferGeometry();
    sgeo.setAttribute('position', quad.getAttribute('position'));
    sgeo.setIndex(quad.getIndex());
    const sattr = (n) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(NS * n), n);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
    };
    const sDir = sattr(3), sPole = sattr(3), sPrime = sattr(3), sLight = sattr(3), sShape = sattr(4), sTint = sattr(4);
    sgeo.setAttribute('iDir', sDir);
    sgeo.setAttribute('iPole', sPole);
    sgeo.setAttribute('iPrime', sPrime);
    sgeo.setAttribute('iLight', sLight);
    sgeo.setAttribute('iShape', sShape);
    sgeo.setAttribute('iTint', sTint);
    sgeo.instanceCount = NS;
    for (let i = 0; i < NS; i++) {
        const id = ids[i];
        sShape.array[i * 4] = i < N ? PLANET_KIND[id] : SCOPE_MOON;
        sShape.array[i * 4 + 1] = i < N ? SHAPES[id].flattening : 0;
        sShape.array[i * 4 + 2] = id === 'saturn' ? RING_OUTER + 0.04 : 1.06;
    }
    const sUniforms = {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uRefrUp: { value: new THREE.Vector3(0, 1, 0) },
        uRefrK: { value: 0 },
        ...planetUniforms(THREE),
    };
    const sMaterial = new THREE.ShaderMaterial({
        name: 'planets.scope', uniforms: sUniforms, vertexShader: SCOPE_VERT, fragmentShader: SCOPE_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const scope = new THREE.Mesh(sgeo, sMaterial);
    scope.name = 'planets.scope';
    scope.frustumCulled = false;
    scope.renderOrder = -59;   // over the glyphs it replaces, under the ground (-50)
    scope.visible = false;
    group.add(scope);
    const camUp = new THREE.Vector3();
    const upArr = new Float64Array(3);
    const jupFrameS = createDiscFrame();
    const tint = [1, 1, 1];
    let hasSnap = false;
    let beamsOn = true;
    let skyBlend = 0;
    let selected = '';
    let disposed = false;
    let lastSnap = null;

    function setDetail(cfg) {
        const name = cfg && cfg.name;
        uniforms.uPlDetail.value = name === 'low' ? 0 : name === 'max' ? 2 : 1;
        if (sUniforms) sUniforms.uPlDetail.value = uniforms.uPlDetail.value;
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
        uniforms.uPlGrsLon.value = sUniforms.uPlGrsLon.value = grsLongitudeDeg(snap.tMs);
        lastSnap = snap;
        hasSnap = true;
    }

    /**
     * Sky view: each planet's true-scale disc, weighted by scopeBlend of its radius in device px,
     * and Jupiter's moons in a narrow field. Frames take the camera's up, so the drawing is the sky
     * as it appears on screen (a rolled, star-locked view included).
     */
    function updateScope(fi, dpr) {
        const cam = fi && fi.camera;
        const snap = lastSnap;
        if (!snap || !cam || !(skyBlend > 0.01)) { scope.visible = false; return; }
        const pxPerRad = 0.5 * size.y * cam.projectionMatrix.elements[5];
        camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
        upArr[0] = camUp.x; upArr[1] = camUp.y; upArr[2] = camUp.z;
        const up = snap.observer.upS;
        const k = Math.min(1, skyBlend);
        sUniforms.uRefrUp.value.set(up[0], up[1], up[2]);
        sUniforms.uRefrK.value = k;
        sUniforms.uViewport.value.copy(size);
        sUniforms.uPlDotPx.value = 3.2 * dpr;
        const display = skyViewExposure(snap.observer.sunAltDeg, skyBlend, snap.eclipse ? snap.eclipse.obscurationAtObserver : 0);
        const ex = fi.exposure || null;
        const expP = (ex && Number.isFinite(ex.planets) ? ex.planets : 1) * display * GAIN;
        const d = sDir.array, sh = sShape.array, t = sTint.array;
        let any = false, jupOn = false;
        for (let i = 0; i < NS; i++) t[i * 4 + 3] = 0;
        for (let i = 0; i < N; i++) {
            const st = snap.bodies[FIRST_PLANET + i];
            const rpx = eqAngRadius(ids[i], st.distAU) * pxPerRad;
            const w = scopeBlend(rpx) * k;
            if (!(w > 0.002)) continue;
            any = true;
            const ds = st.dirS;
            d[i * 3] = ds[0]; d[i * 3 + 1] = ds[1]; d[i * 3 + 2] = ds[2];
            writeDiscInstance(st, upArr, frame, view, sPole.array, sPrime.array, sLight.array, i);
            if (i === JUP) {
                jupFrameS.ex.set(frame.ex); jupFrameS.ey.set(frame.ey); jupFrameS.ez.set(frame.ez);
                jupOn = true;
            }
            sh[i * 4 + 3] = rpx;
            tintFor(ds, up, expP * SCOPE_SB[ids[i]]);
            t[i * 4] = tint[0]; t[i * 4 + 1] = tint[1]; t[i * 4 + 2] = tint[2]; t[i * 4 + 3] = w;
        }
        const mk = k * (1 - smooth(SCOPE_MOONS_FOV[0], SCOPE_MOONS_FOV[1], cam.fov));
        const g = snap.galilean;
        if (jupOn) {
            writeJupiterMoons(snap, jupFrameS, sUniforms, false);
            // The moons are instances of their own here: the disc keeps their shadows, and draws
            // only a moon crossing it (whose instance is skipped below), once the moons show.
            for (let m = 0; m < 4; m++) {
                if (!(mk > 0.5 && g && (g.state[m] & MOON_TRANSIT))) sUniforms.uPlMoon.value[m].z = 0;
            }
        }
        if (mk > 0.002 && g) {
            const jst = snap.bodies[FIRST_PLANET + JUP];
            const rJ = eqAngRadius('jupiter', jst.distAU);
            const jd = jst.dirS;
            for (let m = 0; m < 4; m++) {
                if (g.state[m] & (MOON_OCCULTED | MOON_ECLIPSED | MOON_TRANSIT)) continue;
                const j = N + m, o = m * 3;
                // Jovicentric offsets (Jupiter radii) across the line of sight: rJ radians per radius.
                let x = jd[0] + g.offS[o] * rJ, y = jd[1] + g.offS[o + 1] * rJ, z = jd[2] + g.offS[o + 2] * rJ;
                const l = Math.hypot(x, y, z);
                x /= l; y /= l; z /= l;
                d[j * 3] = x; d[j * 3 + 1] = y; d[j * 3 + 2] = z;
                const rpx = Math.max(MOON_R[m] * rJ * pxPerRad, 1e-3);
                sh[j * 4 + 2] = Math.max(1, 1.6 * dpr / rpx) + 1.5 / rpx;
                sh[j * 4 + 3] = rpx;
                // Telescope-bright (the aperture's gain): a little dimmer with magnitude, Ganymede first.
                _dir[0] = x; _dir[1] = y; _dir[2] = z;
                tintFor(_dir, up, expP * (1.2 - 0.15 * (GALILEAN[m].mag - 4.6)));
                t[j * 4] = tint[0]; t[j * 4 + 1] = tint[1]; t[j * 4 + 2] = tint[2]; t[j * 4 + 3] = mk;
                any = true;
            }
        }
        sDir.needsUpdate = sShape.needsUpdate = sTint.needsUpdate = true;
        sPole.needsUpdate = sPrime.needsUpdate = sLight.needsUpdate = true;
        scope.visible = any;
    }

    /** tint = gain x the atmosphere's transmission toward dir (the glyphs' extinction, by the view blend). */
    function tintFor(dir, up, gain) {
        extinctionRGB(dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2], tint);
        const k = Math.min(1, skyBlend);
        for (let c = 0; c < 3; c++) tint[c] = gain * (1 + (tint[c] - 1) * k);
    }

    function update(fi) {
        if (fi && Number.isFinite(fi.skyBlend)) skyBlend = fi.skyBlend;
        const r = rc && rc.renderer;
        let dpr = 1;
        if (r) {
            r.getDrawingBufferSize(size);
            dpr = r.getPixelRatio();
        }
        updateScope(fi, dpr);
        const fade = 1 - smooth(0.2, 0.5, skyBlend);
        const on = hasSnap && beamsOn && fade > 0.002 && !!beams;
        mesh.visible = on;
        if (!on) return;
        uniforms.uViewport.value.copy(size);
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
        /** The telescope mesh (sky view; tests and the debug overlay). */
        get scope() { return scope; },
        /** True while medallions are drawn in orbit view (layers allow them and the module runs). */
        get enabled() { return !disposed && beamsOn; },
        footprint: medallionFootprint,
        dispose() {
            disposed = true;
            syncFootprints();
            group.removeFromParent();
            geo.dispose();
            sgeo.dispose();
            quad.dispose();
            material.dispose();
            sMaterial.dispose();
        },
    };
}
