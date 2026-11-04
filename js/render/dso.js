/**
 * Deep-sky objects (astro/dso.js) as faint, true-size procedural sprites at infinity: one
 * instanced quad per object, sized to its catalogue axes and turned to its position angle, with a
 * per-type profile — an exponential disc and bulge (spiral and elliptical galaxies), a patchy glow
 * (irregular galaxies, star clouds), a King profile that resolves into stars as the telescope zooms
 * in (globular clusters), a faint haze (open clusters: their bright members are the catalogue's own
 * stars), noise-shaped nebulae, rings (planetary nebulae, the Veil). Asterisms are not drawn.
 *
 * Kept to grey smudges as the eye sees them: at the default field most objects are a few pixels
 * across, near the limit of visibility; the structure (spiral arms, resolved stars, nebula noise
 * octaves) fades in only as an object grows past ~20 px on screen. Visibility uses the stars' own
 * limit (twilight, skyglow per direction, the aperture gain, the tier), an extended object's
 * effective magnitude (astro/dso.js dsoEffMag) standing for its total magnitude. Illustrative.
 *
 * A RenderModule (main.js adds it) plus `pick(tapDir, radPerPx)`: the visible object under a tap,
 * large objects (the LMC, M31) pickable anywhere inside their outline. Buffers are built once from
 * the provider's list; nothing is allocated per frame.
 *
 * @module render/dso
 */
import * as THREE from 'three';
import { INFINITY_VERT_CHUNK, EXTINCTION_CHUNK, SMOOTH_FALL_CHUNK } from './shaders/sky.glsl.js';
import { SKYGLOW_CHUNK } from './shaders/skyglow.glsl.js';
import { createSkyglowUniforms, applySkyglow } from './skyglow.js';
import { skyViewExposure } from './sky.js';
import { DSO_TYPE_CODE, DSO_TYPES, dsoVisibility } from '../astro/dso.js';

const ARCMIN = Math.PI / (180 * 60);
const DEG = Math.PI / 180;
/** The display gain of the brightest smudge (additive, display-referred; below the Milky Way's). */
const GAIN = 0.16;
/** Smallest drawn semi-major axis, CSS px: smaller objects keep this size and dim by the area. */
const MIN_PX = 1.6;
/** Pick radius floor, CSS px. */
const PICK_PX = 16;

const VERT = /* glsl */ `
uniform float uMagLimit;
uniform float uBoost;
uniform float uExposure;
uniform float uSkyBlend;
uniform float uSgLimZen;
uniform float uDisplay;
uniform float uPxPerRad;
uniform vec3 uUp;
attribute vec3 iDir;
attribute vec4 iAxes;    // semi-major, semi-minor (rad), position angle (rad), type
attribute vec4 iMeta;    // effective magnitude, seed, -, -
varying vec2 vUv;
varying float vType;
varying float vAlpha;
varying float vSeed;
varying float vDetail;
varying float vPx;
${INFINITY_VERT_CHUNK}
${EXTINCTION_CHUNK}
${SMOOTH_FALL_CHUNK}
${SKYGLOW_CHUNK}
void main() {
    vec3 d = normalize(iDir);
    float e = clamp(uExposure, 0.0, 1.0);
    float lim = mix(-1.0, uMagLimit, sqrt(e));
    if (uSkyBlend > 0.0) lim = min(lim + (sgLimitMag(sgSky(d)) - uSgLimZen) * uSkyBlend, uMagLimit);
    lim += uBoost;
    float eff = iMeta.x;
    float vis = smoothFall(lim + 0.35, lim - 0.45, eff) * smoothstep(0.0, 0.04, e);
    // Well above the limit an object reads brighter; at the limit it is barely there.
    float bright = vis * mix(0.3, 1.0, clamp((lim - eff) / 4.0, 0.0, 1.0));
    float a = iAxes.x, b = iAxes.y;
    float aPx = a * uPxPerRad;
    float grow = aPx < ${MIN_PX.toFixed(2)} ? ${MIN_PX.toFixed(2)} / max(aPx, 1e-4) : 1.0;
    bright /= grow * grow;
    if (uSkyBlend > 0.0) {
        float sinAlt = dot(d, uUp);
        bright *= mix(1.0, extinctionRGB(sinAlt).g, uSkyBlend) * smoothstep(-0.02, 0.02, sinAlt + (1.0 - uSkyBlend));
    }
    // Tangent basis: north toward the J2000 pole, east = increasing right ascension.
    vec3 n = vec3(0.0, 1.0, 0.0) - d * d.y;
    float ln = length(n);
    n = ln > 1e-5 ? n / ln : vec3(1.0, 0.0, 0.0);
    vec3 east = cross(n, d);
    float pa = iAxes.z;
    vec3 major = n * cos(pa) + east * sin(pa);
    vec3 minor = -n * sin(pa) + east * cos(pa);
    vec2 q = position.xy * 1.15;
    vec3 dir = normalize(d + major * (q.x * a * grow) + minor * (q.y * b * grow));
    vUv = q;
    vType = iAxes.w;
    vSeed = iMeta.y;
    vPx = aPx;
    vDetail = smoothstep(20.0, 260.0, aPx);
    vAlpha = ${GAIN.toFixed(3)} * bright * uDisplay;
    gl_Position = vAlpha > 0.0015 && iAxes.w < 9.5 ? infinityClip(dir) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uOctaves;
uniform vec3 uTints[11];
varying vec2 vUv;
varying float vType;
varying float vAlpha;
varying float vSeed;
varying float vDetail;
varying float vPx;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
    float s = 0.0, w = 0.5;
    for (int k = 0; k < 4; k++) {
        if (float(k) >= uOctaves) break;
        s += w * vnoise(p);
        p = p * 2.03 + vec2(17.1, 9.3);
        w *= 0.5;
    }
    return s / (1.0 - pow(0.5, uOctaves));
}
float smoothFallR(float r) { return 1.0 - smoothstep(0.55, 1.1, r); }
// Resolved stars: one sparkle per cell at most, cells ~3 px across.
float sparkles(vec2 uv, float density) {
    float cells = max(4.0, vPx / 3.0);
    vec2 c = uv * cells;
    vec2 i = floor(c);
    float h = hash(i + vSeed * 31.0);
    vec2 o = vec2(hash(i + 7.3), hash(i + 2.1)) - 0.5;
    float r = length(fract(c) - 0.5 - 0.6 * o);
    return step(1.0 - density, h) * exp(-r * r * 40.0);
}
void main() {
    vec2 uv = vUv;
    float r = length(uv);
    if (r > 1.15) discard;
    int t = int(vType + 0.5);
    float I = 0.0;
    vec2 sp = uv * 2.2 + vSeed * 13.0;
    if (t == 0) {          // spiral (and lenticular) galaxy: disc + bulge, arms at zoom
        float th = atan(uv.y, uv.x);
        float arms = 1.0 + vDetail * 0.45 * sin(2.0 * th - 5.5 * log(r + 0.06) + vSeed * 6.283) * smoothstep(0.08, 0.3, r);
        I = 0.55 * exp(-3.4 * r) * arms + 0.9 * exp(-r * r / 0.012);
        I *= mix(1.0, 0.75 + 0.5 * fbm(sp * 1.5), vDetail * 0.6);
    } else if (t == 1) {   // elliptical galaxy
        I = exp(-4.2 * r) + 0.6 * exp(-r * r / 0.01);
    } else if (t == 2) {   // irregular galaxy: patchy
        I = exp(-2.2 * r) * (0.45 + 0.75 * fbm(sp));
    } else if (t == 3) {   // globular cluster: King profile, resolved stars at zoom
        float c = 0.12;
        I = max(0.0, inversesqrt(1.0 + (r / c) * (r / c)) - 0.12);
        I += vDetail * 3.0 * sparkles(uv, 0.22) * exp(-1.6 * r);
    } else if (t == 4) {   // open cluster: a faint haze of its unresolved members (its stars are the
                           // catalogue's), gone once the field is resolved
        I = 0.16 * exp(-2.0 * r * r) * (1.0 - 0.85 * vDetail);
    } else if (t == 5 || t == 6) {   // emission / reflection nebula
        float n = fbm(sp);
        I = (0.35 + 0.9 * n * n) * smoothFallR(r) + 0.45 * exp(-r * r / 0.03);
    } else if (t == 7) {   // planetary nebula: a ring
        I = exp(-pow((r - 0.62) / 0.22, 2.0)) + 0.3 * exp(-r * r / 0.08);
    } else if (t == 8) {   // supernova remnant: filaments
        float n = fbm(sp * 1.4);
        I = (0.6 * exp(-pow((r - 0.8) / 0.12, 2.0)) + 0.35 * exp(-r * r * 2.5)) * (0.35 + 0.9 * n);
    } else {               // star cloud
        I = exp(-2.4 * r * r) * (0.6 + 0.5 * fbm(sp));
    }
    I *= 1.0 - smoothstep(0.85, 1.15, r);
    vec3 tint = uTints[t];
    vec3 col = mix(vec3(0.86, 0.88, 0.87), tint, 0.2 + 0.4 * vDetail);
    float a = vAlpha * I;
    if (a < 0.0008) discard;
    gl_FragColor = vec4(col * a, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/** sRGB hex → linear THREE.Vector3. */
function tintOf(hex) {
    const c = new THREE.Color(hex);   // three converts sRGB hex to linear working space
    return new THREE.Vector3(c.r, c.g, c.b);
}

/**
 * Creates the deep-sky layer.
 * @param {object} rc RenderContext
 * @param {{provider?:{list:any[]}|null, reducedMotion?:boolean}} [deps]
 *   provider: astro/dso.js createDsoProvider's result (or null until data/dso.json arrives; see setProvider)
 * @returns {object} RenderModule & {setProvider(p), pick(tap, radPerPx):string|null}
 */
export function createDsoLayer(rc, deps = {}) {
    const group = new THREE.Group();
    group.name = 'dso';
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    geom.setIndex([0, 1, 2, 2, 1, 3]);
    geom.instanceCount = 0;
    const sg = createSkyglowUniforms();
    const upS = new THREE.Vector3(0, 1, 0);
    const tints = Object.keys(DSO_TYPE_CODE).sort((a, b) => DSO_TYPE_CODE[a] - DSO_TYPE_CODE[b]).map((k) => tintOf(DSO_TYPES[k].color));
    const uniforms = {
        ...sg,
        uMagLimit: { value: 6.0 }, uBoost: { value: 0 }, uExposure: { value: 1 }, uSkyBlend: { value: 0 },
        uSgLimZen: { value: 6.6 }, uDisplay: { value: 1 }, uPxPerRad: { value: 1000 }, uUp: { value: upS },
        uOctaves: { value: 3 }, uTints: { value: tints },
        uRefrUp: { value: upS }, uRefrK: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
        name: 'dso.sprites', uniforms, vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = 'dso.sprites';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -85;   // over the Milky Way, under the stars
    group.add(mesh);

    /** @type {any[]} */
    let list = [];
    let effMag = new Float32Array(0);
    let semiMaj = new Float32Array(0);
    let layers = { deepSky: true };
    let selection = null;
    let skyBlend = 0;
    let magLimit = 6.0;
    let sunAltDeg = -90;
    let obscuration = 0;
    let exposure = 1;
    let lastSnap = null;

    function setProvider(p) {
        list = Array.isArray(p?.list) ? p.list : [];
        const n = list.length;
        const dir = new Float32Array(3 * n), axes = new Float32Array(4 * n), meta = new Float32Array(4 * n);
        effMag = new Float32Array(n);
        semiMaj = new Float32Array(n);
        list.forEach((d, i) => {
            dir.set(d.dirS, 3 * i);
            const code = DSO_TYPE_CODE[d.type] ?? 10;
            axes[4 * i] = 0.5 * d.majArcmin * ARCMIN;
            axes[4 * i + 1] = 0.5 * Math.max(0.05, d.minArcmin) * ARCMIN;
            axes[4 * i + 2] = (d.paDeg || 0) * DEG;
            // Asterisms (and anything unknown) are selectable but not drawn.
            axes[4 * i + 3] = d.type === 'ast' ? 10 : code;
            meta[4 * i] = d.effMag;
            meta[4 * i + 1] = ((i * 0.6180339887) % 1);
            effMag[i] = d.effMag;
            semiMaj[i] = 0.5 * d.majArcmin * ARCMIN;
        });
        geom.setAttribute('iDir', new THREE.InstancedBufferAttribute(dir, 3));
        geom.setAttribute('iAxes', new THREE.InstancedBufferAttribute(axes, 4));
        geom.setAttribute('iMeta', new THREE.InstancedBufferAttribute(meta, 4));
        geom.instanceCount = n;
        rc?.invalidate?.();
    }
    if (deps.provider) setProvider(deps.provider);

    /** The limiting magnitude the stars use now, at the zenith (for picking). */
    function limitNow() {
        const e = Math.max(0, Math.min(1, exposure));
        return -1 + (magLimit + 1) * Math.sqrt(e) + uniforms.uBoost.value;
    }

    return {
        object3d: group,
        setProvider,
        apply(snap) {
            if (!snap || !snap.observer) return;
            lastSnap = snap;
            const o = snap.observer;
            sunAltDeg = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : -90;
            obscuration = snap.eclipse && Number.isFinite(snap.eclipse.obscurationAtObserver) ? snap.eclipse.obscurationAtObserver : 0;
            upS.set(o.upS[0], o.upS[1], o.upS[2]);
            applySkyglow(sg, snap);
            if (snap.skyglow) uniforms.uSgLimZen.value = snap.skyglow.limitMag;
        },
        update(fi) {
            if (!fi) return;
            skyBlend = Number.isFinite(fi.skyBlend) ? fi.skyBlend : 0;
            exposure = fi.exposure && Number.isFinite(fi.exposure.stars) ? fi.exposure.stars : 1;
            const cam = fi.camera || rc?.camera;
            const fov = cam && cam.fov ? cam.fov : 45;
            const h = rc?.size?.h || (rc?.renderer ? rc.renderer.domElement.clientHeight : 800) || 800;
            uniforms.uPxPerRad.value = h / (fov * DEG);
            // The telescope's aperture gain, as the stars get it (render/sky.js scopeGainMag).
            const boost = fov > 0 ? Math.min(3.5, Math.max(0, 2 * Math.log10(25 / fov))) * Math.max(0, Math.min(1, skyBlend)) : 0;
            uniforms.uBoost.value = boost;
            uniforms.uExposure.value = exposure;
            uniforms.uSkyBlend.value = skyBlend;
            uniforms.uRefrK.value = Math.max(0, Math.min(1, skyBlend));
            uniforms.uDisplay.value = skyViewExposure(sunAltDeg, skyBlend, obscuration);
            uniforms.uMagLimit.value = magLimit;
            mesh.visible = layers.deepSky === true && layers.stars !== false && geom.instanceCount > 0 && exposure > 0.01;
        },
        setLayers(l) { if (l) layers = { deepSky: l.deepSky === true, stars: l.stars !== false }; },
        setSelection(id) { selection = id || null; },
        setViewMode(_m, blend) { if (Number.isFinite(blend)) skyBlend = blend; },
        setQuality(c) {
            if (!c) return;
            if (Number.isFinite(c.starMagLimit)) magLimit = c.starMagLimit;
            uniforms.uOctaves.value = c.name === 'low' ? 1 : c.name === 'medium' ? 3 : 4;
        },
        /**
         * The visible deep-sky object under a tap (or the selected one, visible or not): inside its
         * outline, or within PICK_PX of its centre; the closest relative to its size wins.
         * @param {ArrayLike<number>} tap true direction under the tap (picking.js skyTapDir)
         * @param {number} radPerPx
         * @returns {string|null}
         */
        pick(tap, radPerPx) {
            if (!tap || !(radPerPx > 0) || !mesh.visible) return null;
            const lim = limitNow();
            let best = null, bestScore = Infinity;
            for (let i = 0; i < list.length; i++) {
                const d = list[i];
                if (d.id !== selection && dsoVisibility(effMag[i], lim) < 0.15) continue;
                const dir = d.dirS;
                // Compared at its true place (tap has the drawn lift taken off).
                const dot = dir[0] * tap[0] + dir[1] * tap[1] + dir[2] * tap[2];
                const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
                const reach = Math.max(PICK_PX * radPerPx, 0.8 * semiMaj[i]);
                if (ang > reach) continue;
                const score = ang / reach;
                if (score < bestScore) { bestScore = score; best = d.id; }
            }
            return best;
        },
        dispose() { geom.dispose(); material.dispose(); },
    };
}
