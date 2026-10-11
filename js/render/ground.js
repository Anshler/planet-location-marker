/**
 * Sky-view atmosphere and ground (G5, SPEC C.7 / E.5).
 *
 * - three's Preetham `Sky` dome (scale 1000, following the camera), driven by the true Sun and the
 *   observer's zenith, patched to drop its grey night floor and duplicate sun disc, to crossfade
 *   with the view blend, to dim during solar eclipses, and to add a twilight/night model (sunward
 *   glow, Earth's shadow, Belt of Venus, airglow, totality's 360° sunset).
 * - Ground hemisphere at infinity with horizon haze, in a single premultiplied draw that hides
 *   everything below the horizon. By day it is lit (mid-grey land fading into the horizon haze),
 *   by night near-black, and a solar eclipse darkens it together with the sky.
 * - Sky-view exposure (SPEC E.5) is applied display-referred inside the shaders (skyViewExposure in
 *   sky.js) rather than through rc.setExposure, so the bloom pass only catches the Sun.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { GROUND_VERT, GROUND_FRAG, SKY_PATCHES } from './shaders/ground.glsl.js';
import { skyViewExposure, groundCover } from './sky.js';

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

/**
 * Creates the ground/atmosphere module.
 * @param {object} rc RenderContext (SPEC C.6)
 * @returns {object} RenderModule
 */
export function createGround(rc) {
    const group = new THREE.Group();
    group.name = 'ground';

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
    group.add(sky);

    // --- Ground + haze ----------------------------------------------------------------------------
    const gUniforms = {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uSunAltDeg: { value: -90 },
        // groundCover(skyBlend): the ground replaces the globe below the horizon ahead of the sky.
        uCover: { value: 0 },
        uDisplay: { value: 1 },
        // The sky's eclipse terms (eclipseGains): the daylit ground darkens with the sky.
        uDayGain: { value: 1 },
        uEclFloor: { value: 0 },
    };
    const groundMaterial = new THREE.ShaderMaterial({
        name: 'ground.hemisphere', uniforms: gUniforms, vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG,
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

    function apply(snap) {
        if (!snap || !snap.observer) return;
        const o = snap.observer;
        su.up.value.set(o.upS[0], o.upS[1], o.upS[2]);
        gUniforms.uUp.value.copy(su.up.value);
        if (snap.sunDirS) {
            su.sunPosition.value.set(snap.sunDirS[0], snap.sunDirS[1], snap.sunDirS[2]);
            gUniforms.uSunDir.value.copy(su.sunPosition.value);
        }
        sunAltDeg = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : -90;
        obscuration = snap.eclipse && Number.isFinite(snap.eclipse.obscurationAtObserver)
            ? clamp(snap.eclipse.obscurationAtObserver, 0, 1) : 0;
        su.uSunAltDeg.value = sunAltDeg;
        gUniforms.uSunAltDeg.value = sunAltDeg;
        su.uObscuration.value = obscuration;
        // Preetham's grey floor only by day; by −3° our twilight model has taken over.
        su.uFloor.value = smooth(-3, 1, sunAltDeg);
        // Spec values (turbidity 2.5, Rayleigh 1.2) by day; a low Sun looks through more haze, which
        // is what turns Preetham's pale horizon into a coloured sunset.
        const low = 1 - smooth(0, 12, sunAltDeg);
        su.turbidity.value = 2.5 + LOW_SUN_TURBIDITY * low;
        su.rayleigh.value = 1.2 + LOW_SUN_RAYLEIGH * low;
        eclipseGains(lastBlend);
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
    }

    function setViewMode(mode, blend) {
        if (Number.isFinite(blend)) {
            const b = clamp(blend, 0, 1);
            su.uFade.value = b;
            gUniforms.uCover.value = groundCover(b);
        }
    }

    function dispose() {
        sky.geometry.dispose();
        m.dispose();
        groundGeometry.dispose();
        groundMaterial.dispose();
    }

    return { object3d: group, apply, update, setViewMode, dispose };
}
