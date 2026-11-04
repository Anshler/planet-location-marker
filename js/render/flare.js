/**
 * Custom lens flare (G5, SPEC C.7 / E.5, SHOULD): a starburst at the Sun's screen position and
 * six ghosts along the Sun→centre axis, as NDC quads drawn last (no depth test, additive). Both
 * are procedural (bodies.glsl.js FLARE_FRAG): a fine six-spike starburst with a faint spectral
 * ring, and hexagonal aperture ghosts with chromatic rims. No textures.
 *
 * Occlusion is analytic: the visible fraction of the Sun's disc past the Earth's limb and the
 * Moon (so it fades smoothly as the Sun rises over the limb from orbit, and dims through a solar
 * eclipse), times the horizon in sky view and an off-screen fade; changes ease in over ~150 ms.
 * In sky view the Moon's share is the snapshot's obscurationAtObserver, the geometry the bodies
 * module draws there; from orbit it is the geocentric Moon seen from the camera. Near second and
 * third contact of a total eclipse the starburst moves to the brightest Baily's bead
 * (snap.eclipse.beads) and shines with the beads' light: the diamond ring.
 */
import * as THREE from 'three';
import { liftByRefraction } from '../astro/photometry.js';
import { clearanceDeg } from '../geo/horizon.js';
import { MOON_RADIUS_ER, SUN_ANG_RADIUS_1AU_RAD, sunAngularRadius } from '../astro/bodies.js';
import { FLARE_VERT, FLARE_FRAG } from './shaders/bodies.glsl.js';
import { extinctionRGB, limbTransmittance } from './bodies.js';

// [kind (0 starburst, 1 ghost), size (CSS px), axis distance (<0: at the Sun; 0.5 = screen
// centre, 1 = mirrored through it), ghost hue]. Real ghosts keep converging on the centre as the
// Sun nears the axis, so their positions follow the three.js Lensflare law and never fade there.
const ELEMENTS = [
    [0, 600, -1, 0],
    [1, 46, 0.42, 1],
    [1, 80, 0.58, 2],
    [1, 30, 0.74, 3],
    [1, 120, 0.88, 4],
    [1, 58, 1.04, 1],
    [1, 24, 1.18, 3],
];
/** Exponential fade time constant: occlusion changes reach 95 % in 3τ = 150 ms (SPEC §E.5). */
const FADE_TAU_MS = 50;
const SUN_COLOR = [1.0, 0.95, 0.85];
/** Sky view: flare strength = min(1, green transmission × this gain), the gain easing to 1 below 6°. */
const FLARE_DAY_GAIN = 3;
/** Cap on the flare's red/green ratio in sky view (3 left it paler than the extincted Sun below ~2.5°). */
const LOW_SUN_FLARE_RG = 8;
/** Beads' solar-flux share at which the diamond ring's starburst is at full strength. */
const RING_FLUX = 3e-5;
/** The diamond ring's starburst strength (of the full Sun's): the halo otherwise floods the Moon. */
const RING_FLARE = 0.45;
const DEG = Math.PI / 180;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Visible fraction of a disc of angular radius rs behind an occulter ro at separation d (SPEC E.2). */
export function discVisible(rs, ro, d) {
    if (d >= rs + ro) return 1;
    if (d <= Math.abs(ro - rs)) return ro >= rs ? 0 : 1 - (ro * ro) / (rs * rs);
    const a = rs * rs * Math.acos(clamp((d * d + rs * rs - ro * ro) / (2 * d * rs), -1, 1))
        + ro * ro * Math.acos(clamp((d * d + ro * ro - rs * rs) / (2 * d * ro), -1, 1))
        - 0.5 * Math.sqrt(Math.max(0, (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro)));
    return 1 - a / (Math.PI * rs * rs);
}

/**
 * Creates the lens-flare module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @param {{horizon?:import('../geo/horizon.js').HorizonProfile|null}} [deps]
 *   `horizon`: the shared landscape profile; in sky view the hills hide the Sun as drawn
 * @returns {object} RenderModule
 */
export function createFlare(rc, deps = {}) {
    const { horizon = null } = deps;
    const group = new THREE.Group();
    group.name = 'flare';
    let cfg = rc && rc.tier && typeof rc.tier === 'object' ? rc.tier : null;

    const n = ELEMENTS.length;
    const pos = new Float32Array(n * 4 * 3);
    const elem = new Float32Array(n * 4 * 4);
    const idx = [];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let e = 0; e < n; e++) {
        for (let c = 0; c < 4; c++) {
            const v = e * 4 + c;
            pos[v * 3] = corners[c][0]; pos[v * 3 + 1] = corners[c][1];
            elem.set(ELEMENTS[e], v * 4);
        }
        const b = e * 4;
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aElem', new THREE.BufferAttribute(elem, 4));
    geometry.setIndex(idx);

    const uniforms = {
        uSunNdc: { value: new THREE.Vector2(0, 0) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
        uTint: { value: new THREE.Color(1, 0.95, 0.85) },
        uIntensity: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
        name: 'flare', uniforms, vertexShader: FLARE_VERT, fragmentShader: FLARE_FRAG,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'flare';
    mesh.frustumCulled = false;
    mesh.renderOrder = 50;
    mesh.visible = false;
    group.add(mesh);

    const sunDir = new THREE.Vector3(1, 0, 0);
    const moonPos = new THREE.Vector3(60, 0, 0);
    const up = new THREE.Vector3(0, 1, 0);
    // Observer frame (horizon tests) and the Sun where sky view draws it (lifted by refraction).
    const upA = new Float64Array([0, 1, 0]);
    const northA = new Float64Array([0, 0, -1]);
    const eastA = new Float64Array([1, 0, 0]);
    const sunA = new Float64Array([1, 0, 0]);
    const sunLift = new Float64Array([1, 0, 0]);
    const sunDrawn = new THREE.Vector3(1, 0, 0);
    const tmp = new THREE.Vector3();
    const toMoon = new THREE.Vector3();
    const clip = new THREE.Vector4();
    const rot = new THREE.Matrix4();
    const tmpSize = new THREE.Vector2();
    const tint = [1, 1, 1];
    const limb = [1, 1, 1];
    let sunR = SUN_ANG_RADIUS_1AU_RAD;
    let obscuration = 0;
    let vis = 0;
    let haveSnap = false;
    const beadDir = new THREE.Vector3(1, 0, 0);
    let beadTotal = 0;
    let beadGap = Infinity;
    const invalidateSoon = () => { if (rc && rc.invalidate) rc.invalidate(); };

    function apply(snap) {
        if (!snap || !snap.bodies) return;
        const s = snap.bodies[0];
        sunDir.set(s.dirS[0], s.dirS[1], s.dirS[2]);
        sunR = sunAngularRadius(s.distAU);
        const ob = snap.eclipse && snap.eclipse.obscurationAtObserver;
        obscuration = Number.isFinite(ob) ? clamp(ob, 0, 1) : 0;
        if (snap.moonPosS) moonPos.set(snap.moonPosS[0], snap.moonPosS[1], snap.moonPosS[2]);
        if (snap.observer) {
            const o = snap.observer;
            up.set(o.upS[0], o.upS[1], o.upS[2]);
            for (let k = 0; k < 3; k++) { upA[k] = o.upS[k]; northA[k] = o.northS[k]; eastA[k] = o.eastS[k]; }
        }
        sunA[0] = s.dirS[0]; sunA[1] = s.dirS[1]; sunA[2] = s.dirS[2];
        const b = snap.eclipse && snap.eclipse.beads;
        beadTotal = b && b.count > 0 && Number.isFinite(b.total) ? b.total : 0;
        beadGap = beadTotal > 0 ? b.gapArcsec : Infinity;
        if (beadTotal > 0) beadDir.set(b.dirS[0], b.dirS[1], b.dirS[2]);
        haveSnap = true;
    }

    function update(fi) {
        // Not out in the solar-system zoom: the orrery's Sun is not at infinity.
        const enabled = !!cfg && !!cfg.flare && haveSnap && !(fi && fi.systemBlend >= 0.5);
        const cam = fi && (fi.camera || (rc && rc.camera));
        if (!enabled || !cam) { mesh.visible = false; vis = 0; return; }
        const skyBlend = Number.isFinite(fi.skyBlend) ? clamp(fi.skyBlend, 0, 1) : 0;
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }

        // Sun's NDC position at infinity: rotation-only view, as the sky shaders do, at the
        // refracted direction the sky view draws it (REFRACT_CHUNK).
        liftByRefraction(sunA, upA, skyBlend, sunLift);
        sunDrawn.set(sunLift[0], sunLift[1], sunLift[2]);
        rot.extractRotation(cam.matrixWorldInverse);
        tmp.copy(sunDrawn).applyMatrix4(rot);
        clip.set(tmp.x, tmp.y, tmp.z, 1).applyMatrix4(cam.projectionMatrix);
        let target = 0;
        let nx = 0, ny = 0;
        if (clip.w > 1e-6) {
            nx = clip.x / clip.w; ny = clip.y / clip.w;
            const edge = Math.max(Math.abs(nx), Math.abs(ny));
            target = smooth(1.15, 0.95, edge);
            const c = cam.position;
            const dc = c.length();
            // Earth's limb (from orbit, and the dip of the horizon from the ground).
            if (dc > 1) {
                const earthR = Math.asin(1 / dc);
                tmp.copy(c).multiplyScalar(-1 / dc);
                const sep = Math.acos(clamp(tmp.dot(sunDrawn), -1, 1));
                target *= discVisible(sunR, earthR, sep);
                // From orbit, a Sun on the limb shines through the whole atmosphere: red and dim.
                if (sep < Math.PI / 2) limbTransmittance(dc * Math.sin(sep) - 1, limb);
                else limb[0] = limb[1] = limb[2] = 1;
            } else {
                target = 0;
            }
            // The Moon (eclipses): from the camera in orbit view, the observer's discs in sky view.
            let visM = 0;
            toMoon.copy(moonPos).sub(c);
            const dm = toMoon.length();
            if (dm > MOON_RADIUS_ER) {
                const moonR = Math.asin(MOON_RADIUS_ER / dm);
                const sepM = Math.acos(clamp(toMoon.multiplyScalar(1 / dm).dot(sunDir), -1, 1));
                visM = discVisible(sunR, moonR, sepM);
            }
            const unmooned = target;
            target *= visM + (1 - obscuration - visM) * skyBlend;
            // Diamond ring: the starburst moves onto the brightest bead (sky view), fading in over
            // the last 8″ → 4″ of crescent.
            if (skyBlend > 0 && beadTotal > 0) {
                tmp.copy(beadDir).applyMatrix4(rot);
                clip.set(tmp.x, tmp.y, tmp.z, 1).applyMatrix4(cam.projectionMatrix);
                if (clip.w > 1e-6) {
                    const ring = RING_FLARE * skyBlend * Math.min(1, Math.sqrt(beadTotal / RING_FLUX)) * smooth(8, 4, beadGap);
                    if (ring > target) {
                        nx = clip.x / clip.w; ny = clip.y / clip.w;
                        target = Math.max(target, unmooned * ring);
                    }
                }
            }
            // Sky view: the ground hides the Sun below the horizon as drawn (refracted, behind the
            // illustrative landscape's silhouette when that layer is on); extinction dims it.
            if (skyBlend > 0) {
                const clear = clearanceDeg(horizon, sunA, upA, northA, eastA, skyBlend) * DEG;
                target *= 1 - skyBlend * (1 - smooth(-sunR, sunR, clear));
                const sinAlt = sunDrawn.dot(up);
                extinctionRGB(sinAlt, tint);
                // Dims with the Sun's green transmission, at 3x by day. Near the horizon the gain
                // falls back to 1x and there is no floor: a 0.2 floor kept a cream starburst over
                // the setting Sun's orange disc and lifted it over the bloom threshold.
                const altDeg = Math.asin(clamp(sinAlt, -1, 1)) / DEG;
                const gain = 1 + (FLARE_DAY_GAIN - 1) * smooth(1, 6, altDeg);
                target *= 1 + skyBlend * (Math.min(tint[1] * gain, 1) - 1);
            } else {
                tint[0] = tint[1] = tint[2] = 1;
            }
        }
        const o = 1 - skyBlend;
        target *= 1 + (Math.sqrt(limb[1]) - 1) * o;
        const dt = fi && Number.isFinite(fi.dtMs) ? fi.dtMs : 16;
        const k = 1 - Math.exp(-dt / FADE_TAU_MS);
        vis += (target - vis) * k;
        if (Math.abs(target - vis) < 0.002) vis = target;
        else queueMicrotask(invalidateSoon);

        mesh.visible = vis > 0.003;
        if (!mesh.visible) return;
        uniforms.uSunNdc.value.set(nx, ny);
        uniforms.uViewport.value.set(w, h);
        uniforms.uDpr.value = dpr * (0.5 + 0.5 * vis);
        const g = Math.max(tint[1], 1e-4);
        const tb = skyBlend;
        const lr = Math.max(limb[0], 1e-4);
        uniforms.uTint.value.setRGB(
            SUN_COLOR[0] * (1 + (Math.min(tint[0] / g, LOW_SUN_FLARE_RG) - 1) * tb),
            SUN_COLOR[1] * (1 + (limb[1] / lr - 1) * o),
            SUN_COLOR[2] * (1 + (tint[2] / g - 1) * tb) * (1 + (limb[2] / lr - 1) * o));
        uniforms.uIntensity.value = vis;
    }

    function setQuality(c) { if (c) cfg = c; }

    function dispose() {
        geometry.dispose();
        material.dispose();
    }

    return { object3d: group, apply, update, setQuality, dispose };
}
