/**
 * The Earth: surface sphere plus cloud shell, oriented by snap.earthMatrix
 * (SPEC §C.5, §E.1, §E.2, tiers §E.6).
 *
 * Texture slots (day map, ocean mask, clouds) are bound per tier. A slot keeps
 * whatever real texture it already shows until the tier's preferred one is
 * ready, then swaps texture and interpretation together (uniforms, no
 * recompile). Before any mask has arrived the ocean is derived from the day map.
 */
import * as THREE from 'three';
import { EARTH_SHADER } from './shaders/earth.glsl.js';
import { CLOUDS_SHADER } from './shaders/clouds.glsl.js';
import { ATMO_SUN_I, ATMO_EXPOSURE } from './shaders/atmosphere.glsl.js';
import { dayKeyFor, maskKeyFor, cloudsKeyFor } from './textures.js';
import { groundCover } from './sky.js';
import { BODIES } from '../astro/bodies.js';

const CLOUD_RADIUS = 1.006;
const MOON_RADIUS_ER = 1737.4 / 6378.137;
const SUN_ANG_RADIUS_RAD = 0.0046542;

/** Look tuning (linear HDR). Diffuse peaks stay under the 0.9 bloom threshold. */
const LOOK = {
    sunE: 1.0,
    lightsGain: 1.8,
    bumpScale: 3.0,
    glintGain: 1.0,
};

/** (b - r) window for the derived ocean mask, fitted per day map against the specular map. */
const DERIVED_WINDOW = { day4k: [0.02, 0.10], day2k: [0.016, 0.036] };
/** Albedo gain per day map: earth_atmos_2048 is ~1.3x darker (linear) than earth_day_4096. */
const DAY_GAIN = { day4k: 1.0, day2k: 1.3 };

/** Clouds drift eastward with simulated time: one lap per 40 days (illustrative, deterministic). */
const CLOUD_DRIFT_PERIOD_MS = 40 * 86400e3;
const CLOUD_DRIFT_EPOCH_MS = Date.UTC(2000, 0, 1, 12);

/** Tier knobs this module reads, used when rc.tier is a name or a partial config. */
const TIER_DEFAULTS = {
    low: { name: 'low', earthSegments: [64, 32], dayTex: 'day2k', oceanMask: 'derived', clouds: 'none', cloudShadows: false, bump: false },
    medium: { name: 'medium', earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'specular', clouds: 'clouds1k', cloudShadows: false, bump: false },
    high: { name: 'high', earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', cloudShadows: true, bump: true },
};

function resolveCfg(tier) {
    const name = typeof tier === 'string' ? tier : tier?.name;
    const base = TIER_DEFAULTS[name] ?? TIER_DEFAULTS.medium;
    return tier && typeof tier === 'object' ? { ...base, ...tier } : base;
}

function segmentsOf(cfg) {
    const s = Array.isArray(cfg.earthSegments) ? cfg.earthSegments : TIER_DEFAULTS.medium.earthSegments;
    return [Math.max(8, s[0] | 0), Math.max(4, s[1] | 0)];
}

/** Store stand-in when no texture store is provided: placeholders that never load. */
function nullStore() {
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    black.needsUpdate = true;
    const day = new THREE.DataTexture(new Uint8Array([0x1b, 0x3a, 0x5c, 255]), 1, 1);
    day.colorSpace = THREE.SRGBColorSpace;
    day.needsUpdate = true;
    return {
        get: (key) => (key === 'day4k' || key === 'day2k' ? day : black),
        onReady: () => () => {},
        isReady: () => false,
    };
}

/**
 * Creates the Earth render module.
 * @param {{tier?:object|string, invalidate?:()=>void}} rc RenderContext
 * @param {{textures?:ReturnType<import('./textures.js').createTextureStore>}} [deps]
 * @returns {{object3d:THREE.Group, mesh:THREE.Mesh, clouds:THREE.Mesh,
 *   apply:(snap:object)=>void, update:(fi:object)=>void, setLayers:(layers:object)=>void,
 *   setViewMode:(mode:string, skyBlend:number)=>void, setSelection:(id:string|null)=>void,
 *   setQuality:(cfg:object)=>void, setFootprint:(dirS:ArrayLike<number>|null, colorHex?:number|string, opts?:{distER?:number})=>void,
 *   setSubpoints:(on:boolean)=>void, dispose:()=>void}}
 */
export function createEarth(rc, { textures } = {}) {
    const store = textures ?? nullStore();
    const isReady = (key) => (store.isReady ? store.isReady(key) : false);
    const invalidate = () => { try { rc?.invalidate?.(); } catch { /* never let a redraw request throw */ } };

    let cfg = resolveCfg(rc?.tier);

    const sub = [];
    const subCol = [];
    for (let i = 0; i < 9; i++) {
        sub.push(new THREE.Vector3(0, 1, 0));
        subCol.push(new THREE.Color(BODIES[i]?.color ?? '#ffffff'));
    }

    /** Uniform objects; the cloud material shares the ones it needs by reference. */
    const u = {
        uDay: { value: store.get(dayKeyFor(cfg)) },
        uNight: { value: store.get('night') },
        uMask: { value: store.get('brc4k') },
        uClouds: { value: store.get('clouds1k') },
        uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
        uSunDirL: { value: new THREE.Vector3(1, 0, 0) },
        uPoleW: { value: new THREE.Vector3(0, 1, 0) },
        uSunE: { value: LOOK.sunE },
        uLightsGain: { value: LOOK.lightsGain },
        uBumpScale: { value: LOOK.bumpScale },
        uGlintGain: { value: LOOK.glintGain },
        uHazeE: { value: ATMO_SUN_I * ATMO_EXPOSURE },
        uMaskMode: { value: 0 },
        uDerivedWin: { value: new THREE.Vector2(...DERIVED_WINDOW.day4k) },
        uDayGain: { value: DAY_GAIN.day4k },
        uBumpOn: { value: 0 },
        uCloudMode: { value: 0 },
        uCloudShift: { value: 0 },
        uAtmo: { value: 1 },
        uEclipse: { value: new THREE.Vector4(0, MOON_RADIUS_ER, SUN_ANG_RADIUS_RAD, 0) },
        uMoonPosW: { value: new THREE.Vector3(0, 0, 60) },
        uFoot: { value: new THREE.Vector4(0, 1, 0, 0) },
        uFootColor: { value: new THREE.Color(0xffffff) },
        uFootK: { value: 0 },
        uSub: { value: sub },
        uSubCol: { value: subCol },
        uSubOn: { value: 0 },
        uFade: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
        name: 'earth-surface',
        uniforms: u,
        vertexShader: EARTH_SHADER.vertex,
        fragmentShader: EARTH_SHADER.fragment,
        defines: definesFor(cfg),
    });

    // The clouds draw over the sky-view ground, so they fade with its cover (groundCover), not
    // with the sky blend: gone before the camera descends through their shell.
    const cloudFade = { value: 1 };
    const cloudMaterial = new THREE.ShaderMaterial({
        name: 'earth-clouds',
        uniforms: {
            uClouds: u.uClouds, uNight: u.uNight, uSunDirW: u.uSunDirW, uSunE: u.uSunE,
            uLightsGain: u.uLightsGain, uHazeE: u.uHazeE, uCloudMode: u.uCloudMode, uCloudShift: u.uCloudShift,
            uAtmo: u.uAtmo, uFade: cloudFade, uEclipse: u.uEclipse, uMoonPosW: u.uMoonPosW,
        },
        vertexShader: CLOUDS_SHADER.vertex,
        fragmentShader: CLOUDS_SHADER.fragment,
        transparent: true,
        depthWrite: false,
    });

    let [segW, segH] = segmentsOf(cfg);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segW, segH), material);
    mesh.name = 'earth-surface';
    mesh.renderOrder = 0;

    const clouds = new THREE.Mesh(new THREE.SphereGeometry(CLOUD_RADIUS, segW, segH), cloudMaterial);
    clouds.name = 'earth-clouds';
    clouds.renderOrder = 10;
    clouds.visible = false;

    const group = new THREE.Group();
    group.name = 'earth';
    group.matrixAutoUpdate = false;
    group.add(mesh, clouds);

    // ---- view / layer state -------------------------------------------------
    let skyBlend = 0;
    let cloudLayer = true;
    let footLayer = true;
    let selectionIndex = -1;
    /** Explicit footprint target from setFootprint (live reference, re-read on apply). */
    let footDir = null;
    let footExplicitDistER = 0;
    let lastSnap = null;

    // ---- texture slots ------------------------------------------------------
    /** Active real texture key per slot (null while only a placeholder or nothing is bound). */
    const active = { day: null, mask: null, clouds: null };
    const pending = { day: null, mask: null, clouds: null };

    function bindSlot(slot, key) {
        const tex = store.get(key);
        if (slot === 'day') {
            u.uDay.value = tex;
            const w = DERIVED_WINDOW[key] ?? DERIVED_WINDOW.day4k;
            u.uDerivedWin.value.set(w[0], w[1]);
            u.uDayGain.value = DAY_GAIN[key] ?? 1;
        } else if (slot === 'mask') {
            u.uMask.value = tex;
            u.uMaskMode.value = key === 'specular' ? 1 : 2;
            u.uBumpOn.value = key === 'brc4k' ? 1 : 0;
        } else {
            u.uClouds.value = tex;
        }
        active[slot] = key;
        refreshClouds();
        invalidate();
    }

    function clearSlot(slot) {
        active[slot] = null;
        if (slot === 'mask') {
            u.uMaskMode.value = 0;
            u.uBumpOn.value = 0;
        }
        refreshClouds();
    }

    function want(slot, key) {
        if (pending[slot]) { pending[slot](); pending[slot] = null; }
        if (!key) { clearSlot(slot); invalidate(); return; }
        if (active[slot] === key && isReady(key)) return;
        if (isReady(key)) { bindSlot(slot, key); return; }
        // Not loaded yet: keep any real texture already shown; otherwise fall back.
        if (!active[slot]) {
            if (slot === 'day') u.uDay.value = store.get(key);
            else clearSlot(slot);
        }
        pending[slot] = store.onReady(key, () => {
            pending[slot] = null;
            bindSlot(slot, key);
        });
    }

    function bindTier() {
        want('day', dayKeyFor(cfg));
        want('mask', maskKeyFor(cfg));
        want('clouds', cloudsKeyFor(cfg));
    }

    // Night lights are the same for every tier.
    let nightOff = store.onReady('night', (tex) => { u.uNight.value = tex; nightOff = null; invalidate(); });

    function refreshClouds() {
        const key = active.clouds;
        const mode = key === 'clouds1k' ? 1 : key === 'brc4k' ? 2 : 0;
        u.uCloudMode.value = cloudLayer ? mode : 0;
        clouds.visible = cloudLayer && mode !== 0 && groundCover(skyBlend) < 0.999;
    }

    function refreshVisibility() {
        u.uFade.value = 1 - skyBlend;
        cloudFade.value = 1 - groundCover(skyBlend);
        group.visible = skyBlend < 0.999;
        refreshClouds();
    }

    function refreshFootprint() {
        let dir = footDir;
        let distER = footExplicitDistER;
        if (!dir && lastSnap && selectionIndex >= 0) {
            const b = lastSnap.bodies?.[selectionIndex];
            dir = b?.geoDirS ?? null;
            distER = selectionIndex === 1 ? (b?.distER ?? 0) : 0;
        }
        const on = footLayer && !!dir;
        if (dir) u.uFoot.value.set(dir[0], dir[1], dir[2], on ? 1 : 0);
        else u.uFoot.value.w = 0;
        // The Moon is close: its horizon footprint edge sits at dot = 1/distance.
        u.uFootK.value = distER > 1 ? 1 / distER : 0;
    }

    bindTier();
    refreshVisibility();

    // ---- RenderModule -------------------------------------------------------
    return {
        object3d: group,
        mesh,
        clouds,

        /** Orients the Earth and updates every snapshot-driven uniform. */
        apply(snap) {
            if (!snap) return;
            lastSnap = snap;
            const m = snap.earthMatrix;
            if (m && m.length >= 16) {
                group.matrix.fromArray(m);
                group.matrixWorldNeedsUpdate = true;
                u.uPoleW.value.set(m[4], m[5], m[6]);
            }
            const s = snap.sunDirS;
            if (s) {
                u.uSunDirW.value.set(s[0], s[1], s[2]);
                if (m && m.length >= 16) {
                    // Earth-local Sun = earthMatrix^T * sunDirS (rotation only).
                    u.uSunDirL.value.set(
                        m[0] * s[0] + m[1] * s[1] + m[2] * s[2],
                        m[4] * s[0] + m[5] * s[1] + m[6] * s[2],
                        m[8] * s[0] + m[9] * s[1] + m[10] * s[2],
                    );
                } else {
                    u.uSunDirL.value.set(s[0], s[1], s[2]);
                }
            }
            const mp = snap.moonPosS;
            if (mp) u.uMoonPosW.value.set(mp[0], mp[1], mp[2]);
            u.uEclipse.value.x = snap.eclipse?.solar ? 1 : 0;
            const bodies = snap.bodies;
            if (bodies) {
                for (let i = 0; i < 9; i++) {
                    const g = bodies[i]?.geoDirS;
                    if (g) sub[i].set(g[0], g[1], g[2]);
                }
            }
            if (Number.isFinite(snap.tMs)) {
                const laps = (snap.tMs - CLOUD_DRIFT_EPOCH_MS) / CLOUD_DRIFT_PERIOD_MS;
                u.uCloudShift.value = laps - Math.floor(laps);
            }
            refreshFootprint();
        },

        /** Per rendered frame: follows the sky-view crossfade. */
        update(fi) {
            const sb = Math.min(1, Math.max(0, fi?.skyBlend ?? 0));
            if (sb !== skyBlend) {
                skyBlend = sb;
                refreshVisibility();
            }
        },

        setLayers(layers) {
            if (!layers) return;
            if ('clouds' in layers) cloudLayer = !!layers.clouds;
            if ('atmosphere' in layers) u.uAtmo.value = layers.atmosphere ? 1 : 0;
            if ('footprint' in layers) footLayer = !!layers.footprint;
            if ('subpoints' in layers) u.uSubOn.value = layers.subpoints ? 1 : 0;
            refreshClouds();
            refreshFootprint();
            invalidate();
        },

        setViewMode(mode, sb) {
            skyBlend = Math.min(1, Math.max(0, Number.isFinite(sb) ? sb : (mode === 'sky' ? 1 : 0)));
            refreshVisibility();
        },

        /** The footprint follows the selected body unless setFootprint gave an explicit target. */
        setSelection(id) {
            selectionIndex = id ? BODIES.findIndex((b) => b.id === id) : -1;
            if (selectionIndex >= 0 && !footDir) u.uFootColor.value.set(BODIES[selectionIndex].color);
            refreshFootprint();
            invalidate();
        },

        setQuality(next) {
            const prev = cfg;
            cfg = resolveCfg(next);
            const [w, h] = segmentsOf(cfg);
            if (w !== segW || h !== segH) {
                segW = w;
                segH = h;
                const g0 = mesh.geometry, g1 = clouds.geometry;
                mesh.geometry = new THREE.SphereGeometry(1, segW, segH);
                clouds.geometry = new THREE.SphereGeometry(CLOUD_RADIUS, segW, segH);
                g0.dispose();
                g1.dispose();
            }
            const d0 = definesFor(prev), d1 = definesFor(cfg);
            if (Object.keys(d0).join() !== Object.keys(d1).join()) {
                material.defines = d1;
                material.needsUpdate = true;
            }
            bindTier();
            invalidate();
        },

        /**
         * Shows the visibility footprint of a direction (scene frame, geocentric).
         * `dirS` is kept by reference and re-read on every apply(), so a live
         * snapshot vector can be passed. null returns to following the selection.
         */
        setFootprint(dirS, colorHex, opts = {}) {
            footDir = dirS && dirS.length >= 3 ? dirS : null;
            footExplicitDistER = Number.isFinite(opts?.distER) ? opts.distER : 0;
            if (colorHex !== undefined && colorHex !== null) u.uFootColor.value.set(colorHex);
            else if (!footDir && selectionIndex >= 0) u.uFootColor.value.set(BODIES[selectionIndex].color);
            refreshFootprint();
            invalidate();
        },

        setSubpoints(on) {
            u.uSubOn.value = on ? 1 : 0;
            invalidate();
        },

        dispose() {
            for (const k of Object.keys(pending)) { if (pending[k]) pending[k](); pending[k] = null; }
            if (nightOff) nightOff();
            mesh.geometry.dispose();
            clouds.geometry.dispose();
            material.dispose();
            cloudMaterial.dispose();
            group.removeFromParent();
        },
    };
}

function definesFor(cfg) {
    const d = {};
    if (cfg.bump) d.BUMP = '';
    if (cfg.cloudShadows && cfg.clouds && cfg.clouds !== 'none') d.CLOUD_SHADOWS = '';
    return d;
}
