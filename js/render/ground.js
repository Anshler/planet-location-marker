/**
 * Sky-view atmosphere and ground (G5, SPEC C.7 / E.5).
 *
 * - three's Preetham `Sky` dome (scale 1000, following the camera), driven by the true Sun and the
 *   observer's zenith, patched to drop its grey night floor and duplicate sun disc, to crossfade
 *   with the view blend, to dim during solar eclipses, to tint a low Sun's Mie glow with its
 *   extinction colour under a lower highlight knee, and to add a twilight/night model (sunward
 *   glow, Earth's shadow, Belt of Venus, airglow, totality's 360° sunset).
 * - Ground hemisphere at infinity with horizon haze, in a single premultiplied draw that hides
 *   everything below the horizon. By day it is lit (mid-grey land fading into the horizon haze),
 *   dim blue-grey through civil and nautical twilight, silvered by a bright Moon, near-black on a
 *   moonless night, and a solar eclipse darkens it together with the sky.
 * - The illustrative landscape (layer 'landscape', on by default): the shared horizon profile
 *   (geo/horizon.js) is built here once per observer change — urban character from the city list,
 *   sea sectors from the ocean mask the globe loads (read back once through a small 2D canvas) —
 *   and uploaded as a HORIZON_SAMPLES×1 float texture. The ground shader draws its silhouette; the
 *   flare, picking and the labels read the same object, so they agree with the drawing. Sea
 *   sectors reflect the sky and carry the Sun's and Moon's glitter path (medium tier up).
 * - Sky-view exposure (SPEC E.5) is applied display-referred inside the shaders (skyViewExposure in
 *   sky.js) rather than through rc.setExposure, so the bloom pass only catches the Sun.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { GROUND_VERT, GROUND_FRAG, SKY_PATCHES } from './shaders/ground.glsl.js';
import { skyViewExposure, groundCover } from './sky.js';
import { extinctionRGB } from './bodies.js';
import { maskKeyFor } from './textures.js';
import { AU_KM, BODIES, sunAngularRadius } from '../astro/bodies.js';
import { umbraHorizonGlow, createHorizonGlow } from '../astro/totality.js';
import { liftByRefraction } from '../astro/photometry.js';
import { HORIZON_SAMPLES, buildHorizon, createHorizon, urbanIndex } from '../geo/horizon.js';
import { createSkyglowUniforms, applySkyglow } from './skyglow.js';

const DEG = Math.PI / 180;
const LOW_SUN_TURBIDITY = 3.5;
const LOW_SUN_RAYLEIGH = 1.0;
// Solar eclipse display model (sky view). The light left is (1 − obscuration)^1.4 (limb darkening
// makes the last crescent dimmer than its area), but the eye adapts, so the displayed daylight
// follows that light^ECL_ADAPT; from ECL_FLOOR_FROM on it crossfades into totality's deep-blue
// sky. The sum then falls steadily to the totality level and never below it (it used to dip to
// near-black just outside totality, darker than totality itself).
const ECL_ADAPT = 0.4;
const ECL_FLOOR_FROM = 0.94;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// Moonlight and glitter (display-referred). The full Moon's magnitude, the land's moonlight at full
// phase overhead (uMoonLight = 1), and the glitter gains of the Sun and the Moon.
const FULL_MOON_MAG = -12.7;
const SUN_GLINT = 0.012;
const MOON_GLINT = 0.007;
// The ocean mask's water test (earth.glsl.js: ocean = 1 − smoothstep(0.25, 0.45, mask.g)) and how
// far around the observer it is read (geo/horizon.js samples out to 30 km).
const MASK_RADIUS_KM = 34;
const MASK_MAX_PX = 512;

/**
 * A water(lat, lon) sampler (0 land … 1 water) over the ocean mask around a place, read back once
 * through a small 2D canvas; null when the mask is not loaded or cannot be read. The mask is the
 * globe's own roughness map (green channel ~0 on water). An ImageBitmap decoded with
 * imageOrientation 'flipY' (texture.flipY false) has the south pole in its first row.
 * @param {object|null} tex the mask texture
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {{canvas:HTMLCanvasElement|null}} scratch reused canvas
 * @returns {((latDeg:number, lonDeg:number) => number)|null}
 */
function waterSampler(tex, latDeg, lonDeg, scratch) {
    const img = tex && tex.image;
    const W = img && img.width, H = img && img.height;
    if (!(W > 1 && H > 1) || typeof document === 'undefined') return null;
    const flipped = tex.flipY === false;
    const rowOf = (lat) => (flipped ? (lat + 90) / 180 : (90 - lat) / 180) * H;
    const colOf = (lon) => ((lon + 180) / 360) * W;
    const rDeg = MASK_RADIUS_KM / 111.195;
    const rx = (rDeg / Math.max(Math.cos(latDeg * DEG), 0.05)) * (W / 360);
    const ry = rDeg * (H / 180);
    const x0 = Math.floor(colOf(lonDeg) - rx) - 2;
    const sw = Math.min(W, Math.ceil(2 * rx) + 5);
    const yc = rowOf(latDeg);
    const y0 = clamp(Math.floor(yc - ry) - 2, 0, H - 1);
    const sh = clamp(Math.ceil(yc + ry) + 3, y0 + 1, H) - y0;
    if (sw > MASK_MAX_PX || sh > MASK_MAX_PX) return null;
    let data;
    try {
        if (!scratch.canvas) scratch.canvas = document.createElement('canvas');
        const c = scratch.canvas;
        c.width = sw; c.height = sh;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, sw, sh);
        // The window may cross the date line: draw it in up to two pieces.
        let sx = ((x0 % W) + W) % W, dx = 0;
        while (dx < sw) {
            const n = Math.min(sw - dx, W - sx);
            ctx.drawImage(img, sx, y0, n, sh, dx, 0, n, sh);
            dx += n;
            sx = 0;
        }
        data = ctx.getImageData(0, 0, sw, sh).data;
    } catch {
        return null;
    }
    const g = (x, y) => data[(y * sw + x) * 4 + 1] / 255;
    return (la, lo) => {
        let x = colOf(lo) - 0.5 - x0;
        x -= Math.floor(x / W) * W;
        const y = rowOf(la) - 0.5 - y0;
        if (!(x >= 0 && x <= sw - 1 && y >= 0 && y <= sh - 1)) return 0;
        const ix = Math.min(Math.floor(x), sw - 2 < 0 ? 0 : sw - 2), iy = Math.min(Math.floor(y), sh - 2 < 0 ? 0 : sh - 2);
        const fx = clamp(x - ix, 0, 1), fy = clamp(y - iy, 0, 1);
        const ix1 = Math.min(ix + 1, sw - 1), iy1 = Math.min(iy + 1, sh - 1);
        const v = (g(ix, iy) * (1 - fx) + g(ix1, iy) * fx) * (1 - fy) + (g(ix, iy1) * (1 - fx) + g(ix1, iy1) * fx) * fy;
        return 1 - smooth(0.25, 0.45, v);
    };
}

/**
 * Creates the ground/atmosphere module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @param {{textures?:object|null, horizon?:import('../geo/horizon.js').HorizonProfile|null,
 *   cities?:{ready?:boolean, list?:ArrayLike<object>}|null}} [deps] `horizon`: the shared landscape
 *   profile this module builds (created here when absent); `cities`: the city index (urban character)
 * @returns {object} RenderModule
 */
export function createGround(rc, deps = {}) {
    const { textures = null, cities = null } = deps;
    const horizon = deps.horizon || createHorizon();
    const group = new THREE.Group();
    group.name = 'ground';
    let cfg = rc && rc.tier && typeof rc.tier === 'object' ? rc.tier : null;

    // --- Preetham dome --------------------------------------------------------------------------
    const sky = new Sky();
    sky.name = 'ground.sky';
    sky.scale.setScalar(1000);
    sky.frustumCulled = false;
    sky.renderOrder = -100;
    sky.visible = false;
    const m = sky.material;
    let frag = m.fragmentShader;
    const missed = [];
    for (const [from, to] of SKY_PATCHES) {
        if (frag.includes(from)) frag = frag.replace(from, to);
        else missed.push(from);
    }
    // A miss means the vendored Sky.js changed: the dome still draws, but some guard is gone.
    if (missed.length) console.warn('ground: Sky.js patches not applied:', missed);
    const patched = frag.includes('twilightSky');
    m.fragmentShader = frag;
    m.name = 'ground.sky';
    m.depthWrite = false;
    const su = m.uniforms;
    // Sky.js defaults sunPosition to (0, 0, 0), and normalize(0) is NaN in its vertex shader for
    // any frame drawn before the first apply().
    su.sunPosition.value.set(1, 0, 0);
    su.turbidity.value = 2.5;
    su.rayleigh.value = 1.2;
    su.mieCoefficient.value = 0.005;
    su.mieDirectionalG.value = 0.8;
    su.uFloor = { value: 1 };
    su.uDayGain = { value: 1 };
    su.uFade = { value: 0 };
    su.uSunAltDeg = { value: -90 };
    su.uObscuration = { value: 0 };
    su.uEclFloor = { value: 0 };
    su.uDisplay = { value: 1 };
    su.uSunTint = { value: new THREE.Vector3(1, 1, 1) };
    su.uLowSun = { value: 0 };
    // Totality's 360° glow (umbraHorizonGlow): first harmonic + level, second harmonic axis + amplitude.
    su.uEclH1 = { value: new THREE.Vector4(0, 0, 0, 1) };
    su.uEclH2 = { value: new THREE.Vector4(0, 1, 0, 0) };
    // The night sky's own light (moonlit sky, city light dome), shared by the dome and the ground.
    const sg = createSkyglowUniforms();
    Object.assign(su, sg);
    group.add(sky);

    // --- Landscape profile (geo/horizon.js) as a float texture: far, near, sea, silhouette ---------
    const hData = new Float32Array(HORIZON_SAMPLES * 4);
    const hTex = new THREE.DataTexture(hData, HORIZON_SAMPLES, 1, THREE.RGBAFormat, THREE.FloatType);
    hTex.name = 'ground.horizon';
    hTex.minFilter = THREE.NearestFilter;
    hTex.magFilter = THREE.NearestFilter;
    hTex.generateMipmaps = false;
    hTex.needsUpdate = true;
    const maskScratch = { canvas: null };
    const built = { la: NaN, lo: NaN, mask: '', cities: false };
    let uploaded = -1;

    // --- Ground + haze ----------------------------------------------------------------------------
    const gUniforms = {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uNorth: { value: new THREE.Vector3(0, 0, -1) },
        uEast: { value: new THREE.Vector3(1, 0, 0) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uLandscape: { value: 0 },
        uHorizon: { value: hTex },
        uMoonLight: { value: 0 },
        uSunGlint: { value: new THREE.Vector3(0, 0, 0) },
        uMoonGlint: { value: new THREE.Vector3(0, 0, 0) },
        uSunAltDeg: { value: -90 },
        // groundCover(skyBlend): the ground replaces the globe below the horizon ahead of the sky.
        uCover: { value: 0 },
        uDisplay: { value: 1 },
        // The sky's eclipse terms (eclipseGains): the daylit ground darkens with the sky.
        uDayGain: { value: 1 },
        uEclFloor: { value: 0 },
        // Totality: the land and haze catch the horizon ring's light (shared with the dome).
        uObscuration: su.uObscuration,
        uEclH1: su.uEclH1,
        uEclH2: su.uEclH2,
        ...sg,
    };
    const groundMaterial = new THREE.ShaderMaterial({
        name: 'ground.hemisphere', uniforms: gUniforms, vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG,
        defines: landscapeDefines(cfg),
        side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const groundGeometry = new THREE.SphereGeometry(1, 96, 48);
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.name = 'ground.hemisphere';
    ground.frustumCulled = false;
    ground.renderOrder = -50;
    ground.matrixAutoUpdate = false;
    ground.visible = false;
    group.add(ground);

    let sunAltDeg = -90;
    let obscuration = 0;
    let lastBlend = 0;
    const ext = [1, 1, 1];
    const glow = createHorizonGlow();
    const lift = new Float64Array(3);

    /** Low tier: one flat silhouette and a plain sea; medium up: ridge + near band, Fresnel sea, glitter. */
    function landscapeDefines(c) {
        return c && c.name !== 'low' ? { LANDSCAPE_DETAIL: '', LANDSCAPE_GLINT: '' } : {};
    }

    const maskReadyNow = () => {
        const k = maskKeyFor(cfg);
        return !!(textures && k && textures.isReady?.(k));
    };
    const citiesReadyNow = () => !!(cities && cities.size > 0);
    let lastLat = NaN, lastLon = NaN, maskWas = false, citiesWere = false;

    /** Rebuilds the shared profile when the place, the mask or the city list changed. */
    function refreshProfile(latDeg, lonDeg) {
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return;
        lastLat = latDeg;
        lastLon = lonDeg;
        const maskKey = maskKeyFor(cfg);
        const maskReady = maskWas = maskReadyNow();
        const citiesReady = citiesWere = citiesReadyNow();
        // Same place (to 0.01°), mask and city list: keep the profile (no string built per apply).
        const la = Math.round(latDeg * 100), lo = Math.round(lonDeg * 100);
        const src = maskReady ? maskKey : '';
        if (la === built.la && lo === built.lo && src === built.mask && citiesReady === built.cities) return;
        built.la = la; built.lo = lo; built.mask = src; built.cities = citiesReady;
        let water = null;
        try { water = maskReady ? waterSampler(textures.get(maskKey), latDeg, lonDeg, maskScratch) : null; } catch { water = null; }
        const urban = citiesReady ? urbanIndex(cities.list, latDeg, lonDeg) : 0;
        buildHorizon(horizon, latDeg, lonDeg, { water, urban });
    }

    function uploadProfile() {
        if (uploaded === horizon.version) return;
        uploaded = horizon.version;
        for (let i = 0; i < HORIZON_SAMPLES; i++) {
            hData[i * 4] = horizon.far[i];
            hData[i * 4 + 1] = horizon.near[i];
            hData[i * 4 + 2] = horizon.sea[i];
            hData[i * 4 + 3] = horizon.alt[i];
        }
        hTex.needsUpdate = true;
    }

    /**
     * Moonlight on the land (uMoonLight, 0…1) and the Moon's glitter: brightness from its magnitude
     * against the full Moon's (square-rooted, display-referred), its altitude and the sunlight left
     * on it in a lunar eclipse, only once the daylight has gone.
     */
    function moonTerms(snap, up) {
        const mo = snap.bodies && snap.bodies[1];
        if (!mo || !mo.dirS) { gUniforms.uMoonLight.value = 0; gUniforms.uMoonGlint.value.set(0, 0, 0); return; }
        liftByRefraction(mo.dirS, up, 1, lift);
        gUniforms.uMoonDir.value.set(lift[0], lift[1], lift[2]);
        const sinA = lift[0] * up[0] + lift[1] * up[1] + lift[2] * up[2];
        const m = Number.isFinite(mo.mag) ? mo.mag : FULL_MOON_MAG + 2.5 * (1 - (mo.phaseFrac ?? 0.5));
        const flux = Math.sqrt(Math.min(1.5, Math.pow(10, -0.4 * (m - FULL_MOON_MAG))));
        const lit = snap.eclipse && Number.isFinite(snap.eclipse.moonLitFraction) ? clamp(snap.eclipse.moonLitFraction, 0.05, 1) : 1;
        const dark = 1 - smooth(-6, 2, sunAltDeg);
        const up01 = smooth(-0.01, 0.07, sinA);
        gUniforms.uMoonLight.value = flux * Math.sqrt(Math.max(sinA, 0)) * up01 * lit * dark;
        extinctionRGB(sinA, ext);
        const g = MOON_GLINT * flux * lit * up01 * (1 - smooth(-8, 0, sunAltDeg) * 0.85);
        gUniforms.uMoonGlint.value.set(0.82 * ext[0] * g, 0.88 * ext[1] * g, 1.0 * ext[2] * g);
    }

    function apply(snap) {
        if (!snap || !snap.observer) return;
        const o = snap.observer;
        su.up.value.set(o.upS[0], o.upS[1], o.upS[2]);
        gUniforms.uUp.value.copy(su.up.value);
        gUniforms.uNorth.value.set(o.northS[0], o.northS[1], o.northS[2]);
        gUniforms.uEast.value.set(o.eastS[0], o.eastS[1], o.eastS[2]);
        if (snap.sunDirS) {
            su.sunPosition.value.set(snap.sunDirS[0], snap.sunDirS[1], snap.sunDirS[2]);
            gUniforms.uSunDir.value.copy(su.sunPosition.value);
        }
        // The ground's Sun (warm haze, glitter) is the one the sky view draws: topocentric, refracted.
        const sb = snap.bodies && snap.bodies[0];
        if (sb && sb.dirS) {
            liftByRefraction(sb.dirS, o.upS, 1, lift);
            gUniforms.uSunDir.value.set(lift[0], lift[1], lift[2]);
        }
        refreshProfile(o.latDeg, o.lonDeg);
        uploadProfile();
        gUniforms.uLandscape.value = horizon.enabled ? 1 : 0;
        sunAltDeg = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : -90;
        obscuration = snap.eclipse && Number.isFinite(snap.eclipse.obscurationAtObserver)
            ? clamp(snap.eclipse.obscurationAtObserver, 0, 1) : 0;
        su.uSunAltDeg.value = sunAltDeg;
        gUniforms.uSunAltDeg.value = sunAltDeg;
        applySkyglow(sg, snap);
        su.uObscuration.value = obscuration;
        moonTerms(snap, o.upS);
        // The Sun's glitter: its extinction colour, strongest low over the sea, gone by ~25°.
        extinctionRGB(Math.sin(sunAltDeg * DEG), ext);
        const gs = SUN_GLINT * (1 - smooth(10, 25, sunAltDeg)) * smooth(-1.2, 0.3, sunAltDeg);
        gUniforms.uSunGlint.value.set(ext[0] * gs, ext[1] * gs, ext[2] * gs);
        // Preetham's grey floor only by day; by −3° our twilight model has taken over.
        su.uFloor.value = smooth(-3, 1, sunAltDeg);
        // Spec values (turbidity 2.5, Rayleigh 1.2) by day; a low Sun looks through more haze, which
        // is what turns Preetham's pale horizon into a coloured sunset.
        const low = 1 - smooth(0, 12, sunAltDeg);
        su.turbidity.value = 2.5 + LOW_SUN_TURBIDITY * low;
        su.rayleigh.value = 1.2 + LOW_SUN_RAYLEIGH * low;
        // The Sun's own extinction colour, normalised to its red channel, tints the Mie lobe; it
        // blends to white by 12° so the daytime haze keeps its colour.
        extinctionRGB(Math.sin(sunAltDeg * DEG), ext);
        su.uSunTint.value.set(1, 1 + (ext[1] / ext[0] - 1) * low, 1 + (ext[2] / ext[0] - 1) * low);
        // Lower sky knee for a low Sun (skyKnee); it lets go again as Preetham's term fades out
        // below the horizon, so twilight keeps its look.
        su.uLowSun.value = low * smooth(-3, 0, sunAltDeg);
        eclipseGains(lastBlend);
        // Totality's horizon ring: brightest toward the umbra's nearest edge.
        if (obscuration > 0.98 && snap.bodies) {
            const s = snap.bodies[0], mo = snap.bodies[1];
            const moonKm = mo.distAU * AU_KM;
            umbraHorizonGlow(s.dirS, mo.dirS, sunAngularRadius(s.distAU), Math.asin(Math.min(1, BODIES[1].radiusKm / moonKm)),
                moonKm, o.northS, o.eastS, glow);
        } else {
            glow.inUmbra = false;
        }
        if (glow.inUmbra) {
            su.uEclH1.value.set(glow.h1[0], glow.h1[1], glow.h1[2], glow.level);
            su.uEclH2.value.set(glow.d2[0], glow.d2[1], glow.d2[2], glow.a2);
        } else {
            su.uEclH1.value.set(0, 0, 0, 1);
            su.uEclH2.value.w = 0;
        }
    }

    /**
     * uDayGain and uEclFloor for the current obscuration (see ECL_ADAPT). Both are applied before
     * the shader's uDisplay exposure, which itself rises toward 1 near totality, so they are
     * divided by it: what reaches the screen is the adapted daylight at the uneclipsed exposure,
     * crossfading into the totality floor at full exposure.
     */
    function eclipseGains(blend) {
        if (!(obscuration > 0)) {
            su.uDayGain.value = gUniforms.uDayGain.value = 1;
            su.uEclFloor.value = gUniforms.uEclFloor.value = 0;
            return;
        }
        const e = skyViewExposure(sunAltDeg, blend, obscuration);
        const e0 = skyViewExposure(sunAltDeg, blend, 0);
        const s = smooth(ECL_FLOOR_FROM, 1, obscuration);
        su.uDayGain.value = gUniforms.uDayGain.value = (1 - s) * Math.pow(1 - obscuration, 1.4 * ECL_ADAPT) * (e0 / e);
        su.uEclFloor.value = gUniforms.uEclFloor.value = s / e;
    }

    function update(fi) {
        if (!fi) return;
        const blend = Number.isFinite(fi.skyBlend) ? clamp(fi.skyBlend, 0, 1) : 0;
        const cam = fi.camera || (rc && rc.camera);
        const on = blend > 0.0005;
        sky.visible = on && patched;
        ground.visible = on;
        if (on && cam) sky.position.copy(cam.position);
        su.uFade.value = blend;
        gUniforms.uCover.value = groundCover(blend);
        const e = skyViewExposure(sunAltDeg, blend, obscuration);
        su.uDisplay.value = e;
        gUniforms.uDisplay.value = e;
        lastBlend = blend;
        eclipseGains(blend);
        // The ocean mask or the city list arrived since the profile was built (a paused clock
        // applies no new snapshot): rebuild it for the same place.
        if (on && (maskReadyNow() !== maskWas || citiesReadyNow() !== citiesWere)) {
            refreshProfile(lastLat, lastLon);
            uploadProfile();
        }
    }

    function setViewMode(mode, blend) {
        if (Number.isFinite(blend)) {
            const b = clamp(blend, 0, 1);
            su.uFade.value = b;
            gUniforms.uCover.value = groundCover(b);
        }
    }

    function setLayers(l) {
        if (!l) return;
        horizon.enabled = l.landscape !== false;
        gUniforms.uLandscape.value = horizon.enabled ? 1 : 0;
    }

    function setQuality(c) {
        if (!c) return;
        const was = cfg && cfg.name;
        cfg = c;
        if ((was === 'low') !== (c.name === 'low')) {
            groundMaterial.defines = landscapeDefines(c);
            groundMaterial.needsUpdate = true;
        }
    }

    function dispose() {
        sky.geometry.dispose();
        m.dispose();
        groundGeometry.dispose();
        groundMaterial.dispose();
        hTex.dispose();
    }

    return { object3d: group, apply, update, setViewMode, setLayers, setQuality, dispose, horizon };
}
