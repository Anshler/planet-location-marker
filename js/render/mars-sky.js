/**
 * The Mars sky view (ROADMAP stand-on-mars, phase 1), loaded only when the observer stands on Mars
 * (app/mars-host.js adds it to the scene and the frame loop):
 *
 * - The dome (shaders/mars.glsl.js): a butterscotch dust sky by day, a blue aureole around a low
 *   Sun, a long blue-and-brown twilight. ground.js hides the Earth's Preetham dome and draws its own
 *   ground in Mars colours (`#define MARS`); the stars, planets and labels are the Earth view's own.
 * - Phobos and Deimos (snap.mars.moons): true-size dark Lambert discs at a finite distance, so a
 *   transit takes a bite out of the Sun, never smaller than MIN_PX. They are labelled and picked as
 *   the extra objects `sat:phobos` and `sat:deimos` (astro/host-mars.js createMarsMoonsProvider).
 * - The light from home: a ribbon from the ground ahead of the observer up to the Earth (BODIES
 *   slot 4 on Mars), with pulses running down it; labels-feed writes 'the light from home left N
 *   min ago' on the Earth's label. Hidden with the 'beams' layer or while the Earth is down.
 *
 * No per-frame allocation (R5).
 *
 * @module render/mars-sky
 */
import * as THREE from 'three';
import { MARS_SKY_VERT, MARS_SKY_FRAG, MOONLET_VERT, MOONLET_FRAG, HOMEBEAM_VERT, HOMEBEAM_FRAG } from './shaders/mars.glsl.js';
import { skyViewExposure } from './sky.js';
import { EARTH_SLOT } from '../astro/host-mars.js';

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** The moons are drawn this far from the eye (scene units; the near plane is 0.01). */
const MOON_DIST = 50;
/** Smallest drawn moon diameter, CSS px. */
const MIN_PX = 2.4;
/** Albedo-weighted brightness of a fully lit moon disc at night (display-referred). */
const MOON_GAIN = 0.55;
const BEAM_SEGMENTS = 48;
const BEAM_LEN = 400;
/** The beam starts at the observer's feet: this far ahead and this far below the eye (scene units), off
 * the bottom of the screen for any upward look, so it rises from the viewer to the Earth. */
const BEAM_AHEAD = 0.04;
const BEAM_DROP = 0.026;
const EARTH_BLUE = new THREE.Color('#6fb6ff');

/**
 * @param {object} rc RenderContext
 * @param {{reducedMotion?:boolean}} [deps]
 * @returns {object} RenderModule
 */
export function createMarsSky(rc, deps = {}) {
    let reducedMotion = !!deps.reducedMotion;
    const group = new THREE.Group();
    group.name = 'marsSky';

    // --- dome --------------------------------------------------------------------------------------
    const domeUniforms = {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uSunAltDeg: { value: -90 },
        uDisplay: { value: 1 },
        uFade: { value: 0 },
        uDust: { value: 1 },
        uRefrUp: { value: new THREE.Vector3(0, 1, 0) },
        uRefrK: { value: 0 },
    };
    const domeGeometry = new THREE.SphereGeometry(1, 64, 32);
    const domeMaterial = new THREE.ShaderMaterial({
        name: 'marsSky.dome', uniforms: domeUniforms, vertexShader: MARS_SKY_VERT, fragmentShader: MARS_SKY_FRAG,
        side: THREE.BackSide, depthWrite: false, depthTest: true,
    });
    const dome = new THREE.Mesh(domeGeometry, domeMaterial);
    dome.name = 'marsSky.dome';
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    dome.matrixAutoUpdate = false;
    group.add(dome);

    // --- Phobos and Deimos ----------------------------------------------------------------------------
    const quad = new THREE.PlaneGeometry(2, 2);
    const moons = [0, 1].map((k) => {
        const u = {
            uCenter: { value: new THREE.Vector3(1, 0, 0) },
            uRadius: { value: 0.01 },
            uLightV: { value: new THREE.Vector3(0, 0, 1) },
            uColor: { value: new THREE.Color(0, 0, 0) },
            uEdge: { value: 0.2 },
        };
        const mat = new THREE.ShaderMaterial({
            name: `marsSky.moon${k}`, uniforms: u, vertexShader: MOONLET_VERT, fragmentShader: MOONLET_FRAG,
            depthWrite: true, depthTest: true, blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(quad, mat);
        mesh.name = `marsSky.moon${k}`;
        mesh.frustumCulled = false;
        mesh.renderOrder = -90;
        mesh.visible = false;
        group.add(mesh);
        return { mesh, u, mat, dir: new Float64Array([1, 0, 0]), angR: 0, phase: 1, lit: 1, mag: 10, up: false, eclipsed: false };
    });
    const sunDir = new Float64Array([1, 0, 0]);

    // --- the light from home ---------------------------------------------------------------------------
    const beamGeometry = new THREE.BufferGeometry();
    {
        const n = BEAM_SEGMENTS + 1;
        const t = new Float32Array(n * 2 * 2);
        const pos = new Float32Array(n * 2 * 3);
        const idx = [];
        for (let i = 0; i < n; i++) {
            const s = i / BEAM_SEGMENTS;
            t[i * 4] = s; t[i * 4 + 1] = -1;
            t[i * 4 + 2] = s; t[i * 4 + 3] = 1;
            if (i < BEAM_SEGMENTS) {
                const a = i * 2;
                idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
        }
        beamGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        beamGeometry.setAttribute('aT', new THREE.BufferAttribute(t, 2));
        beamGeometry.setIndex(idx);
    }
    const beamUniforms = {
        uOrigin: { value: new THREE.Vector3() },
        uDir: { value: new THREE.Vector3(0, 1, 0) },
        uLen: { value: BEAM_LEN },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uWidthPx: { value: 3 },
        uColor: { value: EARTH_BLUE.clone() },
        uPhase: { value: 0 },
        uAlpha: { value: 0 },
    };
    const beamMaterial = new THREE.ShaderMaterial({
        name: 'marsSky.homeBeam', uniforms: beamUniforms, vertexShader: HOMEBEAM_VERT, fragmentShader: HOMEBEAM_FRAG,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.name = 'marsSky.homeBeam';
    beam.frustumCulled = false;
    beam.renderOrder = 30;
    beam.visible = false;
    group.add(beam);

    const up = new Float64Array([0, 1, 0]);
    const earthDir = new Float64Array([1, 0, 0]);
    let earthUp = false;
    let sunAltDeg = -90;
    let skyBlend = 0;
    let beamsOn = true;
    let haveSnap = false;
    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const size = new THREE.Vector2();

    function apply(snap) {
        if (!snap || !snap.observer || snap.host !== 'mars' || !snap.mars) {
            haveSnap = false;   // back on the Earth: nothing to draw
            return;
        }
        haveSnap = true;
        const o = snap.observer;
        up[0] = o.upS[0]; up[1] = o.upS[1]; up[2] = o.upS[2];
        domeUniforms.uUp.value.set(up[0], up[1], up[2]);
        const s = snap.bodies[0].dirS;
        sunDir[0] = s[0]; sunDir[1] = s[1]; sunDir[2] = s[2];
        domeUniforms.uSunDir.value.set(s[0], s[1], s[2]);
        sunAltDeg = Number.isFinite(o.sunAltDeg) ? o.sunAltDeg : -90;
        domeUniforms.uSunAltDeg.value = sunAltDeg;
        const ms = snap.mars.moons;
        for (let k = 0; k < moons.length; k++) {
            const m = moons[k], st = ms[k];
            if (!st) continue;
            m.dir[0] = st.dirS[0]; m.dir[1] = st.dirS[1]; m.dir[2] = st.dirS[2];
            m.angR = (st.angDiamArcsec / 7200) * DEG;
            m.up = st.altDeg > -1;
            m.eclipsed = !!st.eclipsed;
        }
        const e = snap.bodies[EARTH_SLOT].dirS;
        earthDir[0] = e[0]; earthDir[1] = e[1]; earthDir[2] = e[2];
        earthUp = e[0] * up[0] + e[1] * up[1] + e[2] * up[2] > -0.01;
    }

    function update(fi) {
        if (!fi) return;
        skyBlend = Number.isFinite(fi.skyBlend) ? clamp(fi.skyBlend, 0, 1) : 0;
        const cam = fi.camera || (rc && rc.camera);
        const on = haveSnap && skyBlend > 0.0005;
        group.visible = on;
        if (!on || !cam) return;
        const display = skyViewExposure(sunAltDeg, skyBlend, 0);
        domeUniforms.uDisplay.value = display;
        domeUniforms.uFade.value = skyBlend;
        const r = rc && rc.renderer;
        let h = 1, w = 1, dpr = 1;
        if (r) { r.getDrawingBufferSize(size); w = size.x; h = size.y; dpr = r.getPixelRatio(); }
        const pxPerRad = 0.5 * h * cam.projectionMatrix.elements[5];
        const c = cam.position;

        // Moons: true size (MIN_PX at least), lit along the Sun, faded into the dust near the horizon.
        // In daylight their light adds to the bright sky they sit behind, so they show faintly.
        const night = 1 - smooth(-6, 4, sunAltDeg);
        for (let k = 0; k < moons.length; k++) {
            const m = moons[k];
            m.mesh.visible = m.up;
            if (!m.up) continue;
            const angR = Math.max(m.angR, (0.5 * MIN_PX * dpr) / pxPerRad);
            m.u.uCenter.value.set(c.x + m.dir[0] * MOON_DIST, c.y + m.dir[1] * MOON_DIST, c.z + m.dir[2] * MOON_DIST);
            m.u.uRadius.value = MOON_DIST * Math.tan(angR);
            m.u.uEdge.value = clamp(1.5 / Math.max(angR * pxPerRad, 1e-3), 0.02, 1);
            tmp.set(sunDir[0], sunDir[1], sunDir[2]).transformDirection(cam.matrixWorldInverse);
            m.u.uLightV.value.copy(tmp);
            const sinA = m.dir[0] * up[0] + m.dir[1] * up[1] + m.dir[2] * up[2];
            const haze = smooth(-0.01, 0.12, sinA);
            const g = m.eclipsed ? 0 : MOON_GAIN * (0.35 + 0.65 * night) * haze * skyBlend * (k === 0 ? 1 : 0.9);
            m.u.uColor.value.setRGB(0.95 * g, 0.80 * g, 0.66 * g);
        }

        // The light from home: from the observer's feet (ahead along the Earth's azimuth, below the
        // eye) up to the Earth. A steep upward look puts the feet behind the camera: no beam then.
        let show = beamsOn && earthUp && skyBlend > 0.5;
        if (show) {
            tmp.set(earthDir[0], earthDir[1], earthDir[2]);
            const k = tmp.x * up[0] + tmp.y * up[1] + tmp.z * up[2];
            tmp2.set(earthDir[0] - k * up[0], earthDir[1] - k * up[1], earthDir[2] - k * up[2]);
            if (tmp2.lengthSq() < 1e-10) tmp2.set(1, 0, 0);
            tmp2.normalize();
            const ox = tmp2.x * BEAM_AHEAD - up[0] * BEAM_DROP;
            const oy = tmp2.y * BEAM_AHEAD - up[1] * BEAM_DROP;
            const oz = tmp2.z * BEAM_AHEAD - up[2] * BEAM_DROP;
            const fe = cam.matrixWorld.elements;
            show = -(ox * fe[8] + oy * fe[9] + oz * fe[10]) > cam.near * 1.2;
            beamUniforms.uOrigin.value.set(c.x + ox, c.y + oy, c.z + oz);
        }
        beam.visible = show;
        if (show) {
            beamUniforms.uDir.value.copy(tmp);
            beamUniforms.uViewport.value.set(w, h);
            beamUniforms.uWidthPx.value = 2.2 * dpr;
            const tS = Number.isFinite(fi.timeS) ? fi.timeS : 0;
            beamUniforms.uPhase.value = reducedMotion ? 0 : (tS * 0.5) % 1;
            // Brighter against the night: the day's dust light swamps a faint ribbon.
            const g = (0.35 + 0.65 * night) * smooth(0.5, 1, skyBlend) * display;
            beamUniforms.uAlpha.value = 0.9 * g;
        }
    }

    function setViewMode(mode, blend) {
        if (Number.isFinite(blend)) skyBlend = clamp(blend, 0, 1);
    }

    function setLayers(l) {
        if (l) beamsOn = l.beams !== false;
    }

    function setReducedMotion(on) { reducedMotion = !!on; }

    /** True while something here animates (the beam's pulses). */
    function animating() { return beam.visible && !reducedMotion; }

    function dispose() {
        domeGeometry.dispose();
        domeMaterial.dispose();
        quad.dispose();
        for (const m of moons) m.mat.dispose();
        beamGeometry.dispose();
        beamMaterial.dispose();
    }

    return { object3d: group, apply, update, setViewMode, setLayers, setReducedMotion, animating, dispose };
}
