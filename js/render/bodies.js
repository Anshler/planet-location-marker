/**
 * Sun, Moon and planets (G5, SPEC C.7 / E.5).
 *
 * - Sun: an HDR, limb-darkened billboard at infinity (true angular size, at least 3 px) with a
 *   glow; bloom does the rest.
 * - Planets: seven instanced glyph quads at infinity, sized and brightened by live magnitude, with
 *   diffraction spikes for the brightest on the high tier. In a narrow sky view each glyph fades
 *   out as the planet's true disc grows past a few pixels (astro/disc.js scopeBlend), handing over
 *   to render/planets.js's true-scale impostor; the reticle then rings the disc (and the rings).
 * - Moon: a true-scale textured sphere 60 Earth radii away, oriented by the IAU model (libration),
 *   lit with Lommel–Seeliger photometry, earthshine and lunar-eclipse reddening. Orbit view puts it
 *   at its geocentric position; sky view along the snapshot's topocentric astrometric `dirS` at its
 *   topocentric distance from the eye, the same discs as `obscurationAtObserver` (snapshot.js).
 * - Selection reticle around the selected body, with a short "acquire" animation.
 * In sky view everything is dimmed and reddened by atmospheric extinction toward the horizon, and
 * drawn where refraction puts it (REFRACT_CHUNK, strength = the view blend): the at-infinity quads
 * are lifted in their vertex shaders, the Moon per vertex (so a low Moon flattens), and the Sun's
 * disc is mapped back to true altitude per fragment (DISC_FRAG). Picking uses the same lift and the
 * illustrative landscape's silhouette (geo/horizon.js).
 */
import * as THREE from 'three';
import { BODIES, MOON_RADIUS_ER, SUN_ANG_RADIUS_1AU_RAD, sunAngularRadius } from '../astro/bodies.js';
import {
    DISC_VERT, DISC_FRAG, GLYPH_VERT, GLYPH_FRAG, RETICLE_VERT, RETICLE_FRAG, MOON_VERT, MOON_FRAG,
} from './shaders/bodies.glsl.js';
import { skyViewExposure } from './sky.js';
import { moonKeyFor } from './textures.js';
import { discVisibleFraction } from '../astro/shadow.js';
import { liftByRefraction, refractionDeg } from '../astro/photometry.js';
import { clearanceDeg } from '../geo/horizon.js';
import { scopeBlend, eqAngRadius, RING_OUTER } from '../astro/disc.js';
import {
    coronaParams, createCoronaParams, coronaVisibility, coronaStretch, chromosphereFlash, photosphereAdapt,
} from '../astro/totality.js';

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const SUN = 0;
const MOON = 1;
const FIRST_PLANET = 2;
const N_PLANETS = BODIES.length - FIRST_PLANET;
/** HDR radiance of the Sun's core (before extinction and exposure); render/totality.js scales beads by it. */
export const SUN_INTENSITY = 30;
const SUN_CORE = [1.0, 0.95, 0.85];
const SUN_GLOW = [1.0, 0.86, 0.66];
/** Glow of sunlight forward-scattered through the limb while the Sun sits just behind the Earth. */
const SUN_CORONA = [1.0, 0.66, 0.34];
const SUN_GLOW_SCALE = 0.8 * DEG;
const SUN_CORONA_SCALE = 0.5 * DEG;
/** How fast the limb glow dies as the Sun sinks behind the limb (angle). */
const SUN_CORONA_DEPTH = 1.0 * DEG;
const SUN_CORONA_GAIN = 1.3;
// Sky view in a total solar eclipse: the structured corona of DISC_FRAG's SUN_ECLIPSE branch, faded
// in by coronaVisibility (astro/totality.js) as the photosphere goes. It is stretched so its
// ρ = 3 isophote reaches at least CORONA_MIN_PX (CSS px) from the centre: at FOV 70° the true
// corona is ~9 px, a stylised inflation like the planet glyphs' (docs/ASTRONOMY.md §Totality).
const CORONA_MIN_PX = 30;
/** The thin crescent replaces the disc's anti-aliased rim below this width (device px). */
const THIN_FROM_PX = 1.6;
const THIN_TO_PX = 0.7;
/** Relative radiance of the photosphere at the extreme limb (linear limb darkening, u = 0.6). */
const LIMB_LD = 0.45;
const SUN_QUAD_RAD = 6 * DEG;
const MOON_AUREOLE_RAD = 9 * DEG;
const SUN_E = 1.6;
/**
 * Albedo scale per Moon map, so the full Moon keeps its tuned brightness whichever map draws it.
 * moon4k (Solar System Scope's albedo map, max tier) has darker maria than the 1024 relief map:
 * its near-side disc averages 0.220 in linear light against 0.268 (projected-area weighted).
 */
const MOON_MAP_GAIN = { moon: 1, moon4k: 1.21 };
// Lunar eclipse umbra adaptation: uUmbraGain = 1 / (1 + moonLitFraction / UMBRA_ADAPT).
const UMBRA_ADAPT = 0.015;
// Selection reticle radius, CSS px: RETICLE_PX, or a disc's radius + RETICLE_GAP_PX for the Sun and
// Moon (app/labels-feed.js mirrors both to keep the selected label outside the ring).
const RETICLE_PX = 14;
/** Sun and aureole: premultiplied "add the glow, cover the sky by alpha"; alpha 0 is plain additive. */
const DISC_BLENDING = {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};
const RETICLE_GAP_PX = 7;
/** Lunar orbit: the Moon's pinned NDC depth + 1 (window depth 1e-5, ~170 steps of a 24-bit buffer). */
const MOON_FRONT_Z = 2e-5;
/** Lunar orbit: the surface's brightness relative to the Moon's tuned disc. */
const MOON_FRONT_GAIN = 0.42;
const ACQUIRE_S = 0.45;
const EXT_K = [0.10, 0.17, 0.30];

/**
 * Kasten–Young airmass and per-channel atmospheric transmission for sin(altitude); mirrors
 * EXTINCTION_CHUNK in shaders/sky.glsl.js.
 * @param {number} sinAlt
 * @param {number[]|Float32Array} out length-3 output
 * @returns {number[]|Float32Array} out
 */
export function extinctionRGB(sinAlt, out) {
    const s = Math.min(1, Math.max(0, sinAlt));
    const X = 1 / (s + 0.50572 * Math.pow(Math.asin(s) / DEG + 6.07995, -1.6364));
    out[0] = Math.exp(-0.921034 * EXT_K[0] * X);
    out[1] = Math.exp(-0.921034 * EXT_K[1] * X);
    out[2] = Math.exp(-0.921034 * EXT_K[2] * X);
    return out;
}

// Atmosphere constants of shaders/atmosphere.glsl.js (Earth radii; scale heights inflated 5x).
const ATM_HR = 0.00625;
const ATM_HM = 0.0025;
const ATM_BETA_R = [7.4, 17.2, 42.2];
const ATM_BETA_M_EXT = 10 * 1.1;
/** Column density of a full grazing chord at tangent height 0: 2·H·sqrt(pi/(2H)). */
const ATM_COL_R = 2 * ATM_HR * Math.sqrt(Math.PI / (2 * ATM_HR));
const ATM_COL_M = 2 * ATM_HM * Math.sqrt(Math.PI / (2 * ATM_HM));

/**
 * Transmittance of the atmosphere along a ray from space that grazes the Earth at tangent height
 * h (Earth radii; ≤ 0 clamps to the surface), per channel: what reaches an orbiting camera from a
 * Sun on the limb. Same model as the atmosphere shell, so the sunrise colour matches the rim.
 * @param {number} h
 * @param {number[]|Float32Array} out length-3 output
 * @returns {number[]|Float32Array} out
 */
export function limbTransmittance(h, out) {
    const hh = Math.max(h, 0);
    const cR = ATM_COL_R * Math.exp(-hh / ATM_HR);
    const cM = ATM_COL_M * Math.exp(-hh / ATM_HM) * ATM_BETA_M_EXT;
    for (let k = 0; k < 3; k++) out[k] = Math.exp(-(ATM_BETA_R[k] * cR + cM));
    return out;
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Glyph size (CSS px, disc diameter) from magnitude (SPEC E.5). */
export function glyphSizePx(mag) { return clamp(3.0 + (1.5 - mag) * 1.4, 3, 12); }
/** Glyph intensity from magnitude (SPEC E.5). */
export function glyphIntensity(mag) { return clamp(Math.pow(10, -0.4 * (mag - 1)), 0.6, 3.0); }

// Typical magnitudes, used only if a snapshot ever carries a non-finite one.
const FALLBACK_MAG = [-26.7, -10, 0, -4, 1, -2.2, 0.6, 5.7, 7.8];

/**
 * Creates the bodies module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @param {{textures?:object|null, reducedMotion?:boolean, horizon?:import('../geo/horizon.js').HorizonProfile|null}} [deps]
 *   `horizon`: the shared landscape profile (picking leaves out bodies behind it)
 * @returns {object} RenderModule & {pickCandidates():Array<{id:string, dirS:Float64Array}>, setReducedMotion(on:boolean)}
 */
export function createBodies(rc, deps = {}) {
    const { textures = null, horizon = null } = deps;
    const group = new THREE.Group();
    group.name = 'bodies';
    let cfg = rc && rc.tier && typeof rc.tier === 'object' ? rc.tier : null;
    let reducedMotion = !!deps.reducedMotion;
    const quad = new THREE.PlaneGeometry(2, 2);
    const tmpSize = new THREE.Vector2();
    const tmpV = new THREE.Vector3();
    const tint = [1, 1, 1];
    const limbT = [1, 1, 1];

    // --- live state (copied in apply) --------------------------------------------------------------
    const dirs = BODIES.map(() => new Float64Array([1, 0, 0]));
    const sinAlt = new Float64Array(BODIES.length);
    const mags = Float64Array.from(FALLBACK_MAG);
    // Telescope zoom: true equatorial angular radius (rad) and the glyph → disc hand-over weight.
    const eqR = new Float64Array(BODIES.length);
    const scopeW = new Float64Array(BODIES.length);
    let sunR = SUN_ANG_RADIUS_1AU_RAD;  // true angular radius of the Sun (sunAngularRadius)
    let moonDistER = 60;                // topocentric Moon distance (sky view)
    let moonPhaseFrac = 0.5;
    let moonLit = 1;    // direct-sunlight fraction of the Moon's disc (0 in a total lunar eclipse)
    const moonPos = new THREE.Vector3(60, 0, 0);        // geocentric (orbit view, lighting)
    const moonDrawPos = new THREE.Vector3(60, 0, 0);    // where the mesh is drawn this frame
    const moonDirCam = new Float64Array([1, 0, 0]);
    const linColors = BODIES.map(b => new THREE.Color(b.color));
    const upS = new Float64Array([0, 1, 0]);
    const northS = new Float64Array([0, 0, -1]);
    const eastS = new Float64Array([1, 0, 0]);
    // Refraction lift (REFRACT_CHUNK) shared by every material here: the zenith and the view blend.
    const refr = { uRefrUp: { value: new THREE.Vector3(0, 1, 0) }, uRefrK: { value: 0 } };
    let skyBlend = 0;
    let sunAltDeg = -90;
    let obscuration = 0;
    let haveSnap = false;

    // --- Sun ------------------------------------------------------------------------------------------
    const sunUniforms = {
        uDir: { value: new THREE.Vector3(1, 0, 0) },
        uTanR: { value: Math.tan(SUN_QUAD_RAD) },
        uCoreR: { value: SUN_ANG_RADIUS_1AU_RAD },
        uEdge: { value: 1e-3 },
        uCoreColor: { value: new THREE.Color() },
        uGlowColor: { value: new THREE.Color() },
        uGlowScale: { value: SUN_GLOW_SCALE },
        uGlowGain: { value: 1.5 },
        // Sky view: the core hides the sky behind it (DISC_FRAG); 0 keeps the orbit view additive.
        uOcclude: { value: 0 },
        // Totality (DISC_FRAG, SUN_ECLIPSE): 0 gains skip every branch.
        uSunR: { value: SUN_ANG_RADIUS_1AU_RAD },
        uTotality: { value: 0 },
        uThin: { value: 0 },
        uChromo: { value: 0 },
        uMoon: { value: new THREE.Vector3(0, 0, SUN_ANG_RADIUS_1AU_RAD) },
        uLimbColor: { value: new THREE.Color(0, 0, 0) },
        uCoronaColor: { value: new THREE.Color(1, 1, 1) },
        uCorStretch: { value: 1 },
        uPoleUv: { value: new THREE.Vector2(0, 1) },
        uCorFlat: { value: 0.15 },
        uCorSeed: { value: 0 },
        uStrPA: { value: new THREE.Vector4(1.4, 1.8, -1.4, -1.8) },
        uStrW: { value: new THREE.Vector4(0.2, 0.2, 0.2, 0.2) },
        uStrG: { value: new THREE.Vector4(1, 1, 1, 1) },
        uPromPA: { value: new THREE.Vector4(1, 2, -1, -2) },
        uPromH: { value: new THREE.Vector4(0.04, 0.04, 0.04, 0.1) },
        uPromW: { value: new THREE.Vector4(0.06, 0.06, 0.06, 0.06) },
        // Refraction: the disc flattens near the horizon (DISC_FRAG).
        uRefrV: { value: new THREE.Vector4(0, 1, 0, 0) },
        ...refr,
    };
    const sunMaterial = new THREE.ShaderMaterial({
        name: 'bodies.sun', uniforms: sunUniforms, vertexShader: DISC_VERT, fragmentShader: DISC_FRAG,
        defines: { SUN_ECLIPSE: '' },
        transparent: true, depthWrite: false, depthTest: true, ...DISC_BLENDING,
    });
    const coronaP = createCoronaParams();
    const sunPole = new Float64Array([0, 1, 0]);
    let gapArcsec = Infinity;
    const ndcS = new THREE.Vector2();
    const ndcO = new THREE.Vector2();
    const tmpV4 = new THREE.Vector4();
    const sun = new THREE.Mesh(quad, sunMaterial);
    sun.name = 'bodies.sun';
    sun.frustumCulled = false;
    sun.renderOrder = -60;
    group.add(sun);

    // --- Moon aureole (sky view: moonlight scattered by the atmosphere) -----------------------------
    const aureoleUniforms = {
        uDir: { value: new THREE.Vector3(1, 0, 0) },
        uTanR: { value: Math.tan(MOON_AUREOLE_RAD) },
        uCoreR: { value: 1e-6 },
        uEdge: { value: 1e-6 },
        uCoreColor: { value: new THREE.Color(0, 0, 0) },
        uGlowColor: { value: new THREE.Color() },
        uGlowScale: { value: 2.2 * DEG },
        uGlowGain: { value: 0 },
        uOcclude: { value: 0 },
        uRefrV: { value: new THREE.Vector4(0, 1, 0, 0) },
        ...refr,
    };
    const aureoleMaterial = new THREE.ShaderMaterial({
        name: 'bodies.aureole', uniforms: aureoleUniforms, vertexShader: DISC_VERT, fragmentShader: DISC_FRAG,
        transparent: true, depthWrite: false, depthTest: true, ...DISC_BLENDING,
    });
    const aureole = new THREE.Mesh(quad, aureoleMaterial);
    aureole.name = 'bodies.aureole';
    aureole.frustumCulled = false;
    aureole.renderOrder = -61;
    aureole.visible = false;
    group.add(aureole);

    // --- Planet glyphs ------------------------------------------------------------------------------------
    const glyphGeo = new THREE.InstancedBufferGeometry();
    glyphGeo.setAttribute('position', quad.getAttribute('position'));
    glyphGeo.setIndex(quad.getIndex());
    const iDir = new THREE.InstancedBufferAttribute(new Float32Array(N_PLANETS * 3), 3);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(N_PLANETS * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(N_PLANETS * 4), 4);
    iDir.setUsage(THREE.DynamicDrawUsage);
    iColor.setUsage(THREE.DynamicDrawUsage);
    iParams.setUsage(THREE.DynamicDrawUsage);
    glyphGeo.setAttribute('iDir', iDir);
    glyphGeo.setAttribute('iColor', iColor);
    glyphGeo.setAttribute('iParams', iParams);
    glyphGeo.instanceCount = N_PLANETS;
    const glyphUniforms = {
        uViewport: { value: new THREE.Vector2(1, 1) },
        uDpr: { value: 1 },
        uExposure: { value: 1 },
        ...refr,
    };
    const glyphMaterial = new THREE.ShaderMaterial({
        name: 'bodies.glyphs', uniforms: glyphUniforms, vertexShader: GLYPH_VERT, fragmentShader: GLYPH_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    const glyphs = new THREE.Mesh(glyphGeo, glyphMaterial);
    glyphs.name = 'bodies.glyphs';
    glyphs.frustumCulled = false;
    glyphs.renderOrder = -60;
    group.add(glyphs);

    // --- Selection reticle ----------------------------------------------------------------------------
    const reticleUniforms = {
        uDir: { value: new THREE.Vector3(1, 0, 0) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: RETICLE_PX },
        uDpr: { value: 1 },
        uAlpha: { value: 0 },
        uRot: { value: 0 },
        uColor: { value: new THREE.Color(1, 1, 1) },
        ...refr,
    };
    const reticleMaterial = new THREE.ShaderMaterial({
        name: 'bodies.reticle', uniforms: reticleUniforms, vertexShader: RETICLE_VERT, fragmentShader: RETICLE_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
    });
    const reticle = new THREE.Mesh(quad, reticleMaterial);
    reticle.name = 'bodies.reticle';
    reticle.frustumCulled = false;
    reticle.renderOrder = -59;
    reticle.visible = false;
    group.add(reticle);
    let selection = null;
    let selIndex = -1;
    let acquireStart = NaN;
    const invalidateSoon = () => { if (rc && rc.invalidate) rc.invalidate(); };

    // --- Moon -------------------------------------------------------------------------------------------
    const moonGeometry = new THREE.SphereGeometry(MOON_RADIUS_ER, 64, 32);
    // Lunar orbit (FrameInfo.moonFront): depth pinned in front (MOON_VERT uNearZ), the depth pass
    // painting the disc black so the Earth behind the limb is covered (the colour pass adds the
    // Moon's light on top), and a finer sphere: from 150 km up the 64-segment limb shows as
    // facets 6 px deep at 18°; 384 segments leave a quarter pixel. Built on first use.
    const moonNearZ = { value: 0 };
    let moonHiGeometry = null;
    let moonFront = false;
    const moonUniforms = {
        uMap: { value: textures ? textures.get('moon') : null },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uMoonPos: { value: moonPos },
        uSunE: { value: SUN_E },
        uAlbedo: { value: 1.0 },
        // Spec's 0.012 is invisible on a display; 0.04 shows the crescent's ashen light.
        uEarthshine: { value: 0.04 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        // Umbra exposure during a lunar eclipse: 1 in totality, dimmer while a sunlit cap remains.
        uUmbraGain: { value: 1 },
        // The Sun's angular radius seen from the Moon (sunAngularRadius; within 0.3 % of Earth's).
        uSunR: { value: SUN_ANG_RADIUS_1AU_RAD },
        uNearZ: moonNearZ,
        ...refr,
    };
    if (!moonUniforms.uMap.value) {
        const grey = new THREE.DataTexture(new Uint8Array([136, 136, 136, 255]), 1, 1, THREE.RGBAFormat);
        grey.colorSpace = THREE.SRGBColorSpace;
        grey.needsUpdate = true;
        moonUniforms.uMap.value = grey;
    }
    // Depth-only pass first (opaque list): the Moon occludes stars, planets and the Sun behind it
    // (solar eclipses) even though its colour is added on top of the sky.
    // (No tonemapping/colorspace includes, unlike every other fragment: colour writes are off.)
    const moonDepthMaterial = new THREE.ShaderMaterial({
        name: 'bodies.moon.depth', vertexShader: MOON_VERT, uniforms: { ...refr, uNearZ: moonNearZ },
        fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
        colorWrite: false, depthWrite: true, depthTest: true,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const moonDepth = new THREE.Mesh(moonGeometry, moonDepthMaterial);
    moonDepth.name = 'bodies.moon.depth';
    moonDepth.matrixAutoUpdate = false;
    moonDepth.frustumCulled = false;
    moonDepth.renderOrder = 0;
    group.add(moonDepth);
    const moonMaterial = new THREE.ShaderMaterial({
        name: 'bodies.moon', uniforms: moonUniforms, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG,
        transparent: true, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth,
        blending: THREE.AdditiveBlending,
    });
    const moon = new THREE.Mesh(moonGeometry, moonMaterial);
    moon.name = 'bodies.moon';
    moon.matrixAutoUpdate = false;
    moon.frustumCulled = false;
    moon.renderOrder = -58;
    group.add(moon);
    // The tier's Moon map (max: moon4k). The 1024 map shows until it is ready, and stays bound on
    // the other tiers.
    let moonKey = 'moon';
    let offMoon = null;
    let offMoonTier = null;
    function showMoon(tex, key) {
        moonUniforms.uMap.value = tex;
        moonUniforms.uAlbedo.value = MOON_MAP_GAIN[key] ?? 1;
        invalidateSoon();
    }
    if (textures) {
        try {
            offMoon = textures.onReady('moon', (tex) => {
                if (moonKey !== 'moon' && textures.isReady?.(moonKey)) return;
                showMoon(tex, 'moon');
            });
        } catch { /* keep the placeholder */ }
    }
    function bindMoon(key) {
        if (!textures || key === moonKey) return;
        moonKey = key;
        if (offMoonTier) { offMoonTier(); offMoonTier = null; }
        if (key === 'moon') {
            if (textures.isReady?.('moon')) showMoon(textures.get('moon'), 'moon');
            return;
        }
        try {
            offMoonTier = textures.onReady(key, (tex) => {
                offMoonTier = null;
                if (moonKey === key) showMoon(tex, key);
            });
        } catch { /* keep the 1024 map */ }
    }
    bindMoon(moonKeyFor(cfg));

    // --- picking -------------------------------------------------------------------------------------
    // Pick targets at their drawn (lifted) directions, refreshed by pickCandidates().
    const pickDirs = BODIES.map(() => new Float64Array([1, 0, 0]));
    const candidates = BODIES.map((b, i) => ({ id: b.id, dirS: pickDirs[i] }));
    const pickList = [];

    /** Moves the Moon mesh and its depth pass to world point `p` (orientation kept). */
    function placeMoon(p) {
        if (p !== moonDrawPos) moonDrawPos.copy(p);
        const e = moon.matrix.elements;
        e[12] = moonDrawPos.x; e[13] = moonDrawPos.y; e[14] = moonDrawPos.z;
        moonDepth.matrix.copy(moon.matrix);
        moon.matrixWorldNeedsUpdate = true;
        moonDepth.matrixWorldNeedsUpdate = true;
    }

    function writeGlyphParams() {
        const spikesOn = !!cfg && (cfg.name === 'high' || cfg.name === 'max');
        const p = iParams.array;
        for (let k = 0; k < N_PLANETS; k++) {
            const m = mags[FIRST_PLANET + k];
            const w = scopeW[FIRST_PLANET + k];
            p[k * 4] = glyphSizePx(m);
            p[k * 4 + 1] = glyphIntensity(m) * (1 - w);
            p[k * 4 + 2] = spikesOn && m < -1.5 ? 1 : 0;
            p[k * 4 + 3] = haveSnap && w < 0.998 ? 1 : 0;
        }
        iParams.needsUpdate = true;
    }

    /**
     * DISC_FRAG's uRefrV for the Sun: the local vertical on screen in the quad's axes, the centre's
     * apparent altitude and the strength. Off (w = 0) from orbit and for a high Sun, where the
     * flattening is far below a pixel.
     */
    function writeFlattening(cam) {
        const v = sunUniforms.uRefrV.value;
        const altG = Math.asin(clamp(sinAlt[SUN], -1, 1)) / DEG;
        if (!cam || !(skyBlend > 0) || altG > 30 || altG < -5) { v.w = 0; return; }
        const sd = dirs[SUN];
        const k = sinAlt[SUN];
        const e = cam.projectionMatrix.elements;
        if (!toNdc(cam, sd[0], sd[1], sd[2], ndcS)
            || !toNdc(cam, sd[0] + 0.02 * (upS[0] - k * sd[0]), sd[1] + 0.02 * (upS[1] - k * sd[1]),
                sd[2] + 0.02 * (upS[2] - k * sd[2]), ndcO)) { v.w = 0; return; }
        const px = (ndcO.x - ndcS.x) / e[0], py = (ndcO.y - ndcS.y) / e[5];
        const l = Math.hypot(px, py);
        if (!(l > 1e-9)) { v.w = 0; return; }
        v.set(px / l, py / l, altG + skyBlend * refractionDeg(altG), skyBlend);
    }

    /** NDC of the direction (x, y, z) at infinity (rotation-only view, as the sky shaders); false behind. */
    function toNdc(cam, x, y, z, out) {
        tmpV4.set(x, y, z, 0).applyMatrix4(cam.matrixWorldInverse);
        tmpV4.w = 1;
        tmpV4.applyMatrix4(cam.projectionMatrix);
        if (!(tmpV4.w > 1e-9)) return false;
        out.set(tmpV4.x / tmpV4.w, tmpV4.y / tmpV4.w);
        return true;
    }

    // --- RenderModule API ------------------------------------------------------------------------------
    function apply(snap) {
        if (!snap || !snap.bodies) return;
        haveSnap = true;
        const up = snap.observer && snap.observer.upS;
        if (up) {
            const o = snap.observer;
            for (let k = 0; k < 3; k++) { upS[k] = up[k]; northS[k] = o.northS[k]; eastS[k] = o.eastS[k]; }
            refr.uRefrUp.value.set(up[0], up[1], up[2]);
        }
        for (let i = 0; i < BODIES.length && i < snap.bodies.length; i++) {
            const b = snap.bodies[i];
            const d = b.dirS;
            dirs[i][0] = d[0]; dirs[i][1] = d[1]; dirs[i][2] = d[2];
            sinAlt[i] = up ? d[0] * up[0] + d[1] * up[1] + d[2] * up[2] : 1;
            mags[i] = Number.isFinite(b.mag) ? b.mag : FALLBACK_MAG[i];
            eqR[i] = i >= FIRST_PLANET ? eqAngRadius(b.id, b.distAU) : 0;
        }
        sunR = sunAngularRadius(snap.bodies[SUN].distAU);
        moonUniforms.uSunR.value = sunR;
        sunUniforms.uSunR.value = sunR;
        moonDistER = snap.bodies[MOON].distER > MOON_RADIUS_ER ? snap.bodies[MOON].distER : 60;
        moonPhaseFrac = Number.isFinite(snap.bodies[MOON].phaseFrac) ? snap.bodies[MOON].phaseFrac : 0.5;
        moonLit = snap.eclipse && Number.isFinite(snap.eclipse.moonLitFraction) ? clamp(snap.eclipse.moonLitFraction, 0, 1) : 1;
        // The copper umbra is exposed for totality; with 6 % of the disc's sunlight left it shows
        // at ~1/5 of that, so the sunlit cap stays the brightest part through the partial phases.
        moonUniforms.uUmbraGain.value = 1 / (1 + moonLit / UMBRA_ADAPT);
        sunAltDeg = snap.observer && Number.isFinite(snap.observer.sunAltDeg) ? snap.observer.sunAltDeg : -90;
        obscuration = snap.eclipse && Number.isFinite(snap.eclipse.obscurationAtObserver)
            ? clamp(snap.eclipse.obscurationAtObserver, 0, 1) : 0;
        const sd = dirs[SUN];
        sunUniforms.uDir.value.set(sd[0], sd[1], sd[2]);
        // Totality: the contact geometry, the Sun's pole, and the corona invented for this date.
        const beads = snap.eclipse && snap.eclipse.beads;
        gapArcsec = beads && typeof beads.gapArcsec === 'number' && !Number.isNaN(beads.gapArcsec) ? beads.gapArcsec : Infinity;
        if (snap.eclipse && snap.eclipse.solar && snap.sunPoleS) {
            sunPole[0] = snap.sunPoleS[0]; sunPole[1] = snap.sunPoleS[1]; sunPole[2] = snap.sunPoleS[2];
            coronaParams(snap.tMs, coronaP);
            const su = sunUniforms;
            su.uCorFlat.value = coronaP.flattening;
            su.uCorSeed.value = coronaP.seed;
            const s = coronaP.streamerPA, w = coronaP.streamerWidth, g = coronaP.streamerGain;
            su.uStrPA.value.set(s[0], s[1], s[2], s[3]);
            su.uStrW.value.set(w[0], w[1], w[2], w[3]);
            su.uStrG.value.set(g[0], g[1], g[2], g[3]);
            const pa = coronaP.promPA, ph = coronaP.promHeight, pw = coronaP.promWidth;
            su.uPromPA.value.set(pa[0], pa[1], pa[2], pa[3]);
            su.uPromH.value.set(ph[0], ph[1], ph[2], ph[3]);
            su.uPromW.value.set(pw[0], pw[1], pw[2], pw[3]);
        }
        const dir = iDir.array;
        for (let k = 0; k < N_PLANETS; k++) {
            const d = dirs[FIRST_PLANET + k];
            dir[k * 3] = d[0]; dir[k * 3 + 1] = d[1]; dir[k * 3 + 2] = d[2];
        }
        iDir.needsUpdate = true;
        writeGlyphParams();

        // Orientation from the snapshot; update() sets the translation (moonDrawPos) every frame.
        if (snap.moonMatrix) moon.matrix.fromArray(snap.moonMatrix);
        if (snap.moonPosS) moonPos.set(snap.moonPosS[0], snap.moonPosS[1], snap.moonPosS[2]);
        placeMoon(moonPos);
        if (snap.sunDirS) moonUniforms.uSunDir.value.set(snap.sunDirS[0], snap.sunDirS[1], snap.sunDirS[2]);
    }

    function update(fi) {
        if (!fi) return;
        skyBlend = Number.isFinite(fi.skyBlend) ? clamp(fi.skyBlend, 0, 1) : 0;
        refr.uRefrK.value = skyBlend;
        const cam = fi.camera || (rc && rc.camera);
        const r = rc && rc.renderer;
        let w = 1, h = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(tmpSize); w = tmpSize.x; h = tmpSize.y; dpr = r.getPixelRatio(); }
        const pxPerRad = cam ? 0.5 * h * cam.projectionMatrix.elements[5] : 1000;
        const planetsExp = fi.exposure && Number.isFinite(fi.exposure.planets) ? fi.exposure.planets : 1;
        const display = skyViewExposure(sunAltDeg, skyBlend, obscuration);
        // Telescope zoom: glyphs give way to true discs (render/planets.js draws them by the same weight).
        let scopeChanged = false;
        for (let i = FIRST_PLANET; i < BODIES.length; i++) {
            const w = skyBlend > 0.01 ? scopeBlend(eqR[i] * pxPerRad) * Math.min(1, skyBlend) : 0;
            if (Math.abs(w - scopeW[i]) > 1e-3 || (w === 0) !== (scopeW[i] === 0)) { scopeW[i] = w; scopeChanged = true; }
        }
        if (scopeChanged && haveSnap) writeGlyphParams();

        // Moon placement. Orbit view: the geocentric position. Sky view: where the observer sees
        // it, along the snapshot's dirS (WGS84 topocentric, aberration-matched to the Sun and the
        // stars) at its topocentric distance from the eye, so the drawn discs are exactly the ones
        // obscurationAtObserver uses. The two differ by ≤ 0.01 ER and blend through the transitions.
        if (cam && skyBlend > 0) {
            const md = dirs[MOON], c = cam.position;
            tmpV.set(c.x + md[0] * moonDistER, c.y + md[1] * moonDistER, c.z + md[2] * moonDistER);
            placeMoon(moonDrawPos.copy(moonPos).lerp(tmpV, skyBlend));
        } else {
            placeMoon(moonPos);
        }

        // Sun: true angular radius, but never smaller than 3 px; dimmed/reddened near the horizon.
        sunUniforms.uCoreR.value = Math.max(sunR, (3 * dpr) / pxPerRad);
        sunUniforms.uEdge.value = 1 / pxPerRad;
        sunUniforms.uOcclude.value = skyBlend;
        writeFlattening(cam);
        extinctionRGB(sinAlt[SUN], tint);
        const tr = (1 + (tint[0] - 1) * skyBlend) * display;
        const tg = (1 + (tint[1] - 1) * skyBlend) * display;
        const tb = (1 + (tint[2] - 1) * skyBlend) * display;
        // Orbit view: glare belongs to the visible part of the disc (the glow quad is only depth-
        // clipped by the Earth, which left a large beige disc hanging off the limb when the Sun was
        // behind it), and sunlight grazing the limb crosses the whole atmosphere, so an orbital
        // sunrise is a red sliver with a tight, warm glow. Just behind the limb a little of that
        // warm glow remains (light scattered through the limb), fading as the Sun sinks.
        let occl = 1, corona = 0;
        limbT[0] = limbT[1] = limbT[2] = 1;
        if (cam && skyBlend < 1) {
            const c = cam.position;
            const dc = c.length();
            const sd = sunUniforms.uDir.value;
            let visE = 0;
            if (dc > 1) {
                const earthR = Math.asin(1 / dc);
                const sep = Math.acos(clamp(-(c.x * sd.x + c.y * sd.y + c.z * sd.z) / dc, -1, 1));
                visE = discVisibleFraction(sunR, earthR, sep);
                corona = (1 - visE) * Math.exp(-Math.max(earthR - sep, 0) / SUN_CORONA_DEPTH);
                if (sep < Math.PI / 2) limbTransmittance(dc * Math.sin(sep) - 1, limbT);
            }
            let visM = 1;
            tmpV.copy(moonDrawPos).sub(c);
            const dm = tmpV.length();
            if (dm > MOON_RADIUS_ER) {
                const sepM = Math.acos(clamp(tmpV.dot(sd) / dm, -1, 1));
                visM = discVisibleFraction(sunR, Math.asin(MOON_RADIUS_ER / dm), sepM);
            }
            const o = 1 - skyBlend;
            occl = 1 + (visE * visM - 1) * o;
            corona *= visM * o;
            for (let k = 0; k < 3; k++) limbT[k] = 1 + (limbT[k] - 1) * o;
        }
        // Sky view: the glare belongs to the part of the disc the Moon leaves (adapted like the
        // daylight, ground.js ECL_ADAPT); it used to stay at full strength through totality, a
        // bright haze filling a narrow view. The corona takes over as the last of it goes.
        let coronaSky = 0;
        let adapt = 1;
        if (skyBlend > 0 && obscuration > 0) {
            const skyVis = Math.pow(Math.max(1 - obscuration, 0), 1.4 * 0.4);
            occl *= 1 + (skyVis - 1) * skyBlend;
            coronaSky = coronaVisibility(obscuration) * skyBlend;
            // The eye, adapted to the darkening sky, sees the last of the photosphere dazzle.
            adapt = 1 + (photosphereAdapt(obscuration) - 1) * skyBlend;
        }
        // Thin crescent: below ~1 px the disc's anti-aliased rim misdraws the sliver (it lit ±45°
        // of limb at FOV 5°); DISC_FRAG draws it as a flux-conserving ring instead (uThin).
        const gapPx = gapArcsec * ARCSEC * pxPerRad;
        const thin = obscuration < 1 && gapPx < THIN_FROM_PX ? skyBlend * smooth(THIN_FROM_PX, THIN_TO_PX, gapPx) : 0;
        // Totality (obscuration is exactly 1 only between second and third contact): no photosphere
        // is left. Without this the disc's anti-aliased rim, and its 3 px minimum size in a wide
        // view, kept a ring of HDR sunlight around the Moon for the whole of totality.
        const photo = (obscuration >= 1 ? 1 - skyBlend : 1) * adapt;
        const core = SUN_INTENSITY * photo * (1 - thin);
        sunUniforms.uCoreColor.value.setRGB(
            SUN_CORE[0] * core * tr * limbT[0],
            SUN_CORE[1] * core * tg * limbT[1],
            SUN_CORE[2] * core * tb * limbT[2]);
        const lc = SUN_INTENSITY * photo * LIMB_LD;
        sunUniforms.uLimbColor.value.setRGB(SUN_CORE[0] * lc * tr, SUN_CORE[1] * lc * tg, SUN_CORE[2] * lc * tb);
        sunUniforms.uThin.value = thin;
        sunUniforms.uTotality.value = coronaSky;
        sunUniforms.uCoronaColor.value.setRGB(tr, tg, tb);
        sunUniforms.uChromo.value = chromosphereFlash(gapArcsec) * skyBlend;
        sunUniforms.uCorStretch.value = coronaStretch(sunR * pxPerRad, CORONA_MIN_PX * dpr);
        // Warmth: how much of the green the limb took out, or the hidden-Sun limb glow's share.
        const glare = 1.5 * occl * (0.35 + 0.65 * Math.sqrt(limbT[1]));
        const cg = SUN_CORONA_GAIN * corona;
        const gain = glare + cg;
        const cw = Math.max(1 - limbT[1], gain > 1e-6 ? cg / gain : 0);
        sunUniforms.uGlowGain.value = gain;
        sunUniforms.uGlowScale.value = SUN_GLOW_SCALE + (SUN_CORONA_SCALE - SUN_GLOW_SCALE) * cw;
        sunUniforms.uGlowColor.value.setRGB(
            (SUN_GLOW[0] + (SUN_CORONA[0] - SUN_GLOW[0]) * cw) * tr,
            (SUN_GLOW[1] + (SUN_CORONA[1] - SUN_GLOW[1]) * cw) * tg,
            (SUN_GLOW[2] + (SUN_CORONA[2] - SUN_GLOW[2]) * cw) * tb);
        sun.visible = haveSnap;

        // Planets: colour × extinction in sky view.
        const col = iColor.array;
        for (let k = 0; k < N_PLANETS; k++) {
            const i = FIRST_PLANET + k;
            const c = linColors[i];
            if (skyBlend > 0) {
                extinctionRGB(sinAlt[i], tint);
                const g = Math.max(tint[1], 1e-4);
                col[k * 3] = c.r * (1 + (tint[0] - 1) * skyBlend);
                col[k * 3 + 1] = c.g * (1 + (g - 1) * skyBlend);
                col[k * 3 + 2] = c.b * (1 + (tint[2] - 1) * skyBlend);
            } else {
                col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
            }
        }
        iColor.needsUpdate = true;
        glyphUniforms.uViewport.value.set(w, h);
        glyphUniforms.uDpr.value = dpr;
        glyphUniforms.uExposure.value = planetsExp * display;
        glyphs.visible = haveSnap;

        // Moon: extinction tint, and its direction/size as seen from the camera (parallax matters
        // at 60 Earth radii: from orbit it can sit degrees away from the observer's direction).
        extinctionRGB(sinAlt[MOON], tint);
        // From lunar orbit the surface fills the frame beside the Earth (albedo 0.12 against 0.3):
        // the small disc's display gain would wash it out to white.
        const mg = fi.moonFront ? MOON_FRONT_GAIN * display : display;
        moonUniforms.uTint.value.set(
            (1 + (tint[0] - 1) * skyBlend) * mg,
            (1 + (tint[1] - 1) * skyBlend) * mg,
            (1 + (tint[2] - 1) * skyBlend) * mg);
        let moonAngR = 0.0045;
        if (cam) {
            tmpV.copy(moonDrawPos).sub(cam.position);
            const dist = tmpV.length();
            if (dist > 1e-6) {
                tmpV.multiplyScalar(1 / dist);
                moonDirCam[0] = tmpV.x; moonDirCam[1] = tmpV.y; moonDirCam[2] = tmpV.z;
                moonAngR = Math.asin(Math.min(1, MOON_RADIUS_ER / dist));
            }
        }
        moon.visible = moonDepth.visible = haveSnap;
        const front = !!fi.moonFront;
        if (front !== moonFront) {
            moonFront = front;
            moonNearZ.value = front ? MOON_FRONT_Z : 0;
            moonDepthMaterial.colorWrite = front;
            if (front && !moonHiGeometry) moonHiGeometry = new THREE.SphereGeometry(MOON_RADIUS_ER, 384, 192);
            moon.geometry = moonDepth.geometry = front ? moonHiGeometry : moonGeometry;
        }

        // Totality on screen, in the Sun quad's axes (DISC_VERT: screen-aligned, radians at the
        // view centre): the Moon's offset as actually projected, and solar north.
        if (cam && (thin > 0 || coronaSky > 0 || sunUniforms.uChromo.value > 0)) {
            const sd = dirs[SUN];
            const e = cam.projectionMatrix.elements;
            if (toNdc(cam, sd[0], sd[1], sd[2], ndcS) && toNdc(cam, moonDirCam[0], moonDirCam[1], moonDirCam[2], ndcO)) {
                sunUniforms.uMoon.value.set((ndcO.x - ndcS.x) / e[0], (ndcO.y - ndcS.y) / e[5], moonAngR);
            }
            const k = sunPole[0] * sd[0] + sunPole[1] * sd[1] + sunPole[2] * sd[2];
            if (toNdc(cam, sd[0] + 0.02 * (sunPole[0] - k * sd[0]), sd[1] + 0.02 * (sunPole[1] - k * sd[1]),
                sd[2] + 0.02 * (sunPole[2] - k * sd[2]), ndcO)) {
                const px = (ndcO.x - ndcS.x) / e[0], py = (ndcO.y - ndcS.y) / e[5];
                const l = Math.hypot(px, py);
                if (l > 1e-9) sunUniforms.uPoleUv.value.set(px / l, py / l);
            }
        }

        // Aureole: a faint halo of scattered moonlight, only under a dark-ish sky in sky view. It
        // scales with the sunlight actually on the disc, so it goes out in a total lunar eclipse.
        const night = 1 - smooth(-8, 2, sunAltDeg);
        const aure = skyBlend * night * Math.pow(clamp(moonPhaseFrac * moonLit, 0, 1), 1.5) * smooth(-0.02, 0.05, sinAlt[MOON]);
        aureoleUniforms.uDir.value.set(moonDirCam[0], moonDirCam[1], moonDirCam[2]);
        aureoleUniforms.uGlowGain.value = 0.012 * aure;
        aureoleUniforms.uGlowColor.value.set(0.80 * moonUniforms.uTint.value.x, 0.86 * moonUniforms.uTint.value.y, 1.0 * moonUniforms.uTint.value.z);
        aureole.visible = aure > 0.002;

        // Reticle.
        if (selIndex >= 0 && haveSnap) {
            const d = selIndex === MOON ? moonDirCam : dirs[selIndex];
            reticleUniforms.uDir.value.set(d[0], d[1], d[2]);
            let radiusPx = RETICLE_PX * dpr;
            if (selIndex === MOON) radiusPx = Math.max(radiusPx, moonAngR * pxPerRad + RETICLE_GAP_PX * dpr);
            else if (selIndex >= FIRST_PLANET && scopeW[selIndex] > 0) {
                // A true disc (Saturn: its rings) is ringed outside its limb.
                const ext = BODIES[selIndex].id === 'saturn' ? RING_OUTER : 1;
                radiusPx = Math.max(radiusPx, eqR[selIndex] * ext * pxPerRad + RETICLE_GAP_PX * dpr);
            } else if (selIndex === SUN) {
                // In a solar eclipse the Moon's disc is often the larger one: frame whichever disc is
                // bigger, or the ring hugs the Moon's limb (labels-feed mirrors this for the label).
                const sd = dirs[SUN];
                const sep = Math.acos(clamp(sd[0] * moonDirCam[0] + sd[1] * moonDirCam[1] + sd[2] * moonDirCam[2], -1, 1));
                const discR = sep < sunR + moonAngR ? Math.max(sunR, moonAngR) : sunR;
                radiusPx = Math.max(radiusPx, discR * pxPerRad + RETICLE_GAP_PX * dpr);
            }
            const tS = Number.isFinite(fi.timeS) ? fi.timeS : 0;
            if (acquireStart !== acquireStart) acquireStart = tS;
            const p = reducedMotion ? 1 : clamp((tS - acquireStart) / ACQUIRE_S, 0, 1);
            const e = 1 - Math.pow(1 - p, 3);
            reticleUniforms.uRadius.value = radiusPx * (1 + 1.1 * (1 - e));
            reticleUniforms.uAlpha.value = 0.9 * e;
            reticleUniforms.uRot.value = (1 - e) * Math.PI * 0.5;
            reticleUniforms.uViewport.value.set(w, h);
            reticleUniforms.uDpr.value = dpr;
            reticle.visible = true;
            if (p < 1) queueMicrotask(invalidateSoon);
        } else {
            reticle.visible = false;
        }
    }

    function setSelection(id) {
        const idx = id ? BODIES.findIndex(b => b.id === id) : -1;
        if (idx === selIndex) return;
        selection = idx >= 0 ? id : null;
        selIndex = idx;
        acquireStart = NaN;
        if (idx >= 0) {
            const c = linColors[idx];
            // Brighten toward white so dark body colours still read against the sky.
            reticleUniforms.uColor.value.setRGB(0.35 + 0.65 * c.r, 0.35 + 0.65 * c.g, 0.35 + 0.65 * c.b);
        }
    }

    function setQuality(c) {
        if (!c) return;
        cfg = c;
        bindMoon(moonKeyFor(cfg));
        if (haveSnap) writeGlyphParams();
    }

    function setViewMode(mode, blend) {
        if (Number.isFinite(blend)) skyBlend = clamp(blend, 0, 1);
    }

    function setReducedMotion(on) { reducedMotion = !!on; }

    /**
     * Bodies as pick targets: Sun and planets at their (infinite) directions, the Moon along the
     * camera→Moon ray, each lifted by refraction as drawn. In sky view, bodies under the ground or
     * behind the landscape's silhouette (the shared horizon profile) are left out.
     * @returns {Array<{id:string, dirS:Float64Array}>}
     */
    function pickCandidates() {
        pickList.length = 0;
        for (let i = 0; i < candidates.length; i++) {
            const d = i === MOON ? moonDirCam : dirs[i];
            if (skyBlend > 0.5 && clearanceDeg(horizon, d, upS, northS, eastS, skyBlend) < -0.3) continue;
            liftByRefraction(d, upS, skyBlend, pickDirs[i]);
            pickList.push(candidates[i]);
        }
        return pickList;
    }

    function dispose() {
        if (offMoon) { try { offMoon(); } catch { /* ignore */ } }
        if (offMoonTier) { try { offMoonTier(); } catch { /* ignore */ } }
        quad.dispose();
        glyphGeo.dispose();
        moonGeometry.dispose();
        moonHiGeometry?.dispose();
        sunMaterial.dispose(); aureoleMaterial.dispose(); glyphMaterial.dispose(); reticleMaterial.dispose();
        moonMaterial.dispose(); moonDepthMaterial.dispose();
    }

    return {
        object3d: group,
        apply, update, setSelection, setQuality, setViewMode, setReducedMotion, pickCandidates, dispose,
        get selection() { return selection; },
    };
}
