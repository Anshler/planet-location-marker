/**
 * Atmosphere shell (SPEC §C.5, §E.1, §E.3): SphereGeometry(1.025, 96, 48),
 * BackSide, additive, depthWrite off, renderOrder 20. Single scattering with a
 * closed-form sun path: 4 view taps on low/medium ("analytic"), atmoSteps view
 * samples on high ("raymarch"). Hidden in sky view.
 */
import * as THREE from 'three';
import { ATMOSPHERE_SHADER, ATMO_EXPOSURE } from './shaders/atmosphere.glsl.js';
import { groundCover } from './sky.js';

const SHELL_RADIUS = 1.025;
const MOON_RADIUS_ER = 1737.4 / 6378.137;
const SUN_ANG_RADIUS_RAD = 0.0046542;

/** Airglow line strength (linear HDR, before exposure). */
const AIRGLOW = 0.12;

const SEGMENTS_BY_TIER = { low: 64, medium: 96, high: 128 };

function modelOf(tier) {
    const t = tier && typeof tier === 'object' ? tier : { name: tier };
    const raymarch = t.atmosphere ? t.atmosphere === 'raymarch' : t.name === 'high';
    const steps = Math.max(4, Math.min(32, (t.atmoSteps | 0) || 8));
    // The Earth mesh is a polygon inside the unit sphere; rays that miss the polygon
    // but graze the true sphere must count as limb rays, not ground hits.
    const segW = Array.isArray(t.earthSegments) ? t.earthSegments[0] : (SEGMENTS_BY_TIER[t.name] ?? 96);
    return { raymarch, steps, planetR: Math.cos(Math.PI / Math.max(8, segW)) };
}

function definesFor(m) {
    return m.raymarch ? { RAYMARCH: '', STEPS: m.steps } : {};
}

/**
 * Creates the atmosphere render module.
 * @param {{tier?:object|string, invalidate?:()=>void}} rc RenderContext
 * @returns {{object3d:THREE.Mesh, apply:(snap:object)=>void, update:(fi:object)=>void,
 *   setLayers:(layers:object)=>void, setViewMode:(mode:string, skyBlend:number)=>void,
 *   setQuality:(cfg:object)=>void, dispose:()=>void}}
 */
export function createAtmosphere(rc) {
    let model = modelOf(rc?.tier);
    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* never throw from a redraw request */ } };

    const uniforms = {
        uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
        uIntensity: { value: 1 },
        uExposure: { value: ATMO_EXPOSURE },
        uPlanetR: { value: model.planetR },
        uAirglow: { value: AIRGLOW },
        uEclipse: { value: new THREE.Vector4(0, MOON_RADIUS_ER, SUN_ANG_RADIUS_RAD, 0) },
        uMoonPosW: { value: new THREE.Vector3(0, 0, 60) },
    };

    const material = new THREE.ShaderMaterial({
        name: 'atmosphere',
        uniforms,
        vertexShader: ATMOSPHERE_SHADER.vertex,
        fragmentShader: ATMOSPHERE_SHADER.fragment,
        defines: definesFor(model),
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
    });

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SHELL_RADIUS, 96, 48), material);
    mesh.name = 'atmosphere';
    mesh.renderOrder = 20;

    let layerOn = true;
    let skyBlend = 0;

    // Gone once the sky-view ground covers the globe (groundCover): seen from inside the shell near
    // the surface, its limb is a bright band just above the globe's rim.
    function refresh() {
        const cover = groundCover(skyBlend);
        uniforms.uIntensity.value = 1 - cover;
        mesh.visible = layerOn && cover < 0.999;
    }
    refresh();

    return {
        object3d: mesh,

        apply(snap) {
            const s = snap?.sunDirS;
            if (s) uniforms.uSunDirW.value.set(s[0], s[1], s[2]);
            const mp = snap?.moonPosS;
            if (mp) uniforms.uMoonPosW.value.set(mp[0], mp[1], mp[2]);
            uniforms.uEclipse.value.x = snap?.eclipse?.solar ? 1 : 0;
        },

        update(fi) {
            const sb = Math.min(1, Math.max(0, fi?.skyBlend ?? 0));
            if (sb !== skyBlend) {
                skyBlend = sb;
                refresh();
            }
        },

        setLayers(layers) {
            if (layers && 'atmosphere' in layers) {
                layerOn = !!layers.atmosphere;
                refresh();
                invalidate();
            }
        },

        setViewMode(mode, sb) {
            skyBlend = Math.min(1, Math.max(0, Number.isFinite(sb) ? sb : (mode === 'sky' ? 1 : 0)));
            refresh();
        },

        setQuality(cfg) {
            const next = modelOf(cfg);
            uniforms.uPlanetR.value = next.planetR;
            if (next.raymarch !== model.raymarch || (next.raymarch && next.steps !== model.steps)) {
                material.defines = definesFor(next);
                material.needsUpdate = true;
            }
            model = next;
            invalidate();
        },

        dispose() {
            mesh.geometry.dispose();
            material.dispose();
            mesh.removeFromParent();
        },
    };
}
