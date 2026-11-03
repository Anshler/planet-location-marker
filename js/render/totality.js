/**
 * Baily's beads and the diamond ring (sky view, total solar eclipses).
 *
 * The snapshot finds the open lunar-limb valleys near second and third contact
 * (`snap.eclipse.beads`, js/astro/totality.js: the Sun–Moon dirS pair against a fixed limb profile,
 * so the timing follows the real contacts). This module draws up to MAX_BEADS preallocated HDR point
 * sprites there. A bead is a point source: its display flux is the larger of its share of the
 * adapted photosphere (the same scale as the thin crescent in DISC_FRAG, so the two agree at narrow
 * fields) and a zoom-independent point-source floor, so the diamond ring still reads at FOV 70°.
 * Bloom and the lens flare (flare.js moves its starburst to the brightest bead) do the rest; the low
 * tier, with neither, gets six analytic rays on the brightest bead.
 */
import * as THREE from 'three';
import { MAX_BEADS, photosphereAdapt } from '../astro/totality.js';
import { sunAngularRadius } from '../astro/bodies.js';
import { BEAD_VERT, BEAD_FRAG } from './shaders/totality.glsl.js';
import { extinctionRGB, SUN_INTENSITY } from './bodies.js';
import { skyViewExposure } from './sky.js';

/** Solar-flux share of a bright diamond ring (the scale of the size, ray and floor terms). */
const RING_FLUX = 3e-5;
/** Point-source floor: display flux (HDR·CSS px²) of a RING_FLUX bead at any zoom. */
const POINT_FLUX = 300;
/** Core sigma (CSS px) of a faint bead; a bright one grows by up to 60 %. */
const SIGMA_PX = 1.1;
/** The photosphere's disc-averaged radiance relative to its centre (linear limb darkening, u = 0.6). */
const LD_MEAN = 0.8;
const BEAD_CORE = [1.0, 0.96, 0.88];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Creates the beads module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @returns {object} RenderModule
 */
export function createTotality(rc) {
    const group = new THREE.Group();
    group.name = 'totality';
    let cfg = rc && rc.tier && typeof rc.tier === 'object' ? rc.tier : null;

    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setIndex(quad.getIndex());
    const iDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEADS * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEADS * 4), 4);
    iDir.setUsage(THREE.DynamicDrawUsage);
    iParams.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iDir', iDir);
    geo.setAttribute('iParams', iParams);
    geo.instanceCount = MAX_BEADS;
    const uniforms = {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uRayGain: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
        name: 'totality.beads', uniforms, vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG,
        // Not depth-tested: a bead sits on the Moon's limb, a fraction of a pixel inside the smooth
        // mesh (the valley is what lets it through). The ground (drawn later) still hides it.
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'totality.beads';
    mesh.frustumCulled = false;
    mesh.renderOrder = -57;
    mesh.visible = false;
    group.add(mesh);

    const tmpSize = new THREE.Vector2();
    const tint = [1, 1, 1];
    const flux = new Float64Array(MAX_BEADS);
    let count = 0;
    let gap = Infinity;
    let sunR = sunAngularRadius(1);
    let sinAlt = 1;
    let sunAltDeg = -90;
    let obscuration = 0;

    function applyTier() {
        // Bloom and the flare make the diamond ring on medium/high; rays stand in for them on low.
        uniforms.uRayGain.value = cfg && cfg.bloom ? 0.6 : 1;
    }
    applyTier();

    function apply(snap) {
        const ecl = snap && snap.eclipse;
        const b = ecl && ecl.beads;
        if (!b || !(b.count > 0) || !snap.bodies) { count = 0; return; }
        count = Math.min(MAX_BEADS, b.count);
        gap = b.gapArcsec;
        const d = iDir.array;
        for (let i = 0; i < count; i++) {
            flux[i] = b.flux[i];
            d[i * 3] = b.dirS[i * 3]; d[i * 3 + 1] = b.dirS[i * 3 + 1]; d[i * 3 + 2] = b.dirS[i * 3 + 2];
        }
        iDir.needsUpdate = true;
        const s = snap.bodies[0];
        sunR = sunAngularRadius(s.distAU);
        const up = snap.observer && snap.observer.upS;
        sinAlt = up ? s.dirS[0] * up[0] + s.dirS[1] * up[1] + s.dirS[2] * up[2] : 1;
        sunAltDeg = snap.observer && Number.isFinite(snap.observer.sunAltDeg) ? snap.observer.sunAltDeg : -90;
        obscuration = Number.isFinite(ecl.obscurationAtObserver) ? clamp(ecl.obscurationAtObserver, 0, 1) : 0;
    }

    function update(fi) {
        const skyBlend = fi && Number.isFinite(fi.skyBlend) ? clamp(fi.skyBlend, 0, 1) : 0;
        const cam = fi && (fi.camera || (rc && rc.camera));
        if (count === 0 || skyBlend <= 0.001 || !cam) { mesh.visible = false; return; }
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }
        const pxPerRad = 0.5 * h * cam.projectionMatrix.elements[5];
        // Beads fade in over the last 8″ → 6″ of crescent instead of popping in.
        const k = skyBlend * smooth(-sunR, sunR, sinAlt) * skyViewExposure(sunAltDeg, skyBlend, obscuration)
            * (Number.isFinite(gap) ? smooth(8, 6, gap) : 0);
        extinctionRGB(sinAlt, tint);
        uniforms.uTint.value.setRGB(BEAD_CORE[0] * tint[0], BEAD_CORE[1] * tint[1], BEAD_CORE[2] * tint[2]);
        uniforms.uViewport.value.set(w, h);
        uniforms.uDpr.value = dpr;
        const sunPx = sunR * pxPerRad;
        const disc = Math.PI * sunPx * sunPx * SUN_INTENSITY * LD_MEAN * photosphereAdapt(obscuration);
        const p = iParams.array;
        for (let i = 0; i < MAX_BEADS; i++) {
            if (i >= count || !(k > 0)) { p[i * 4 + 3] = 0; continue; }
            const f = flux[i];
            const rel = Math.min(1, Math.sqrt(Math.max(f, 0) / RING_FLUX));
            const D = Math.max(f * disc, POINT_FLUX * dpr * dpr * Math.sqrt(Math.max(f, 0) / RING_FLUX)) * k;
            const s = SIGMA_PX * dpr * (1 + 0.6 * rel);
            p[i * 4] = s;
            p[i * 4 + 1] = Math.min(D / (2 * Math.PI * s * s), 400);
            p[i * 4 + 2] = i === 0 ? dpr * (18 + 70 * rel) : 0;
            p[i * 4 + 3] = 1;
        }
        iParams.needsUpdate = true;
        mesh.visible = k > 0;
    }

    function setQuality(c) {
        if (!c) return;
        cfg = c;
        applyTier();
    }

    function dispose() {
        quad.dispose();
        geo.dispose();
        material.dispose();
    }

    return { object3d: group, apply, update, setQuality, dispose };
}
