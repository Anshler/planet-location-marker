/**
 * The Earth: surface sphere plus cloud shell, oriented by snap.earthMatrix
 * (SPEC §C.5, §E.1, §E.2, tiers §E.6).
 *
 * Texture slots (day map, night lights, ocean mask, clouds) are bound per tier.
 * A slot keeps whatever real texture it already shows until the tier's
 * preferred one is ready, then swaps texture and interpretation together
 * (uniforms, no recompile). Before any mask has arrived the ocean is derived
 * from the day map. The 2k and 4k maps of a slot are the same imagery, so a
 * tier switch changes sharpness, never colour or weather.
 *
 * Previews (textures.js PREVIEW): until a day or night map is in, its slot shows the 512 px
 * preview, so the first frame is already a lit Earth. When the map arrives over a preview, the
 * preview stays bound (uDayPrev, uNightPrev) and uSharpen tweens from 0 to 1 over SHARPEN_MS, a
 * focus pull rather than a pop (a uniform only; instant with reduced motion).
 *
 * The flat map (ROADMAP globe-to-map-morph): update() reads fi.mapK and fi.map (the rig's map frame,
 * geo/mapview.js) into the uMap* uniforms of the surface and the cloud deck, which unroll in their
 * vertex shader (shaders/earth.glsl.js SURFACE_VERTEX) and draw the twilight contours. While the
 * map is shown the meshes are never frustum-culled: the plane reaches far beyond the unit sphere.
 */
import * as THREE from 'three';
import { EARTH_SHADER } from './shaders/earth.glsl.js';
import { CLOUDS_SHADER } from './shaders/clouds.glsl.js';
import { ATMO_SUN_I, ATMO_EXPOSURE } from './shaders/atmosphere.glsl.js';
import { dayKeyFor, nightKeyFor, maskKeyFor, cloudsKeyFor, interimKeyFor, previewKeyFor } from './textures.js';
import { groundCover } from './sky.js';
import { createAuroraUniforms, createAuroraDriver, auroraShellFor } from './aurora.js';
import { BODIES, MOON_RADIUS_ER, SUN_ANG_RADIUS_1AU_RAD, sunAngularRadius } from '../astro/bodies.js';

const CLOUD_RADIUS = 1.006;
/** The cloud deck's height over the flat map (plane units), toward the camera. */
const CLOUD_MAP_LIFT = 0.003;

/** Look tuning (linear HDR). Diffuse peaks stay under the 0.9 bloom threshold. */
const LOOK = {
    sunE: 1.0,
    lightsGain: 1.8,
    bumpScale: 3.0,
    glintGain: 1.0,
};

/** Clouds drift eastward with simulated time: one lap per 40 days (illustrative, deterministic). */
const CLOUD_DRIFT_PERIOD_MS = 40 * 86400e3;
const CLOUD_DRIFT_EPOCH_MS = Date.UTC(2000, 0, 1, 12);
/** The preview → full-map sharpen-in. */
const SHARPEN_MS = 600;

/** Tier knobs this module reads, used when rc.tier is a name or a partial config. */
const TIER_DEFAULTS = {
    low: { name: 'low', earthSegments: [64, 32], dayTex: 'day2k', oceanMask: 'roughness2k', clouds: 'none', cloudShadows: false, bump: false },
    medium: { name: 'medium', earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'roughness2k', clouds: 'clouds2k', cloudShadows: false, bump: false },
    high: { name: 'high', earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', cloudShadows: true, bump: true },
    max: {
        name: 'max', earthSegments: [256, 128], dayTex: 'day8k', oceanMask: 'roughness', clouds: 'clouds8k', cloudShadows: true, bump: true,
        cloudShadowTaps: 5,
    },
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
 * @param {{textures?:ReturnType<import('./textures.js').createTextureStore>, reducedMotion?:boolean}} [deps]
 * @returns {{object3d:THREE.Group, mesh:THREE.Mesh, clouds:THREE.Mesh,
 *   apply:(snap:object)=>void, update:(fi:object)=>void, setLayers:(layers:object)=>void,
 *   setViewMode:(mode:string, skyBlend:number)=>void, setSelection:(id:string|null)=>void,
 *   setQuality:(cfg:object)=>void, setFootprint:(dirS:ArrayLike<number>|null, colorHex?:number|string, opts?:{distER?:number})=>void,
 *   setSubpoints:(on:boolean)=>void, dispose:()=>void}}
 */
export function createEarth(rc, { textures, reducedMotion = false } = {}) {
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
        uNight: { value: store.get(nightKeyFor(cfg)) },
        uDayPrev: { value: store.get('dayPreview') },
        uNightPrev: { value: store.get('nightPreview') },
        // (day, night): 0 shows the preview, 1 the slot's own map.
        uSharpen: { value: new THREE.Vector2(1, 1) },
        uMask: { value: store.get('brc4k') },
        uClouds: { value: store.get('clouds2k') },
        uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
        uSunDirL: { value: new THREE.Vector3(1, 0, 0) },
        uPoleW: { value: new THREE.Vector3(0, 1, 0) },
        uSunE: { value: LOOK.sunE },
        uLightsGain: { value: LOOK.lightsGain },
        uBumpScale: { value: LOOK.bumpScale },
        uGlintGain: { value: LOOK.glintGain },
        uHazeE: { value: ATMO_SUN_I * ATMO_EXPOSURE },
        uMaskMode: { value: 0 },
        uBumpOn: { value: 0 },
        uCloudMode: { value: 0 },
        uCloudShift: { value: 0 },
        uAtmo: { value: 1 },
        // (on, Moon radius ER, the Sun's true angular radius — set per snapshot, see apply(), _)
        uEclipse: { value: new THREE.Vector4(0, MOON_RADIUS_ER, SUN_ANG_RADIUS_1AU_RAD, 0) },
        uMoonPosW: { value: new THREE.Vector3(0, 0, 60) },
        // Moonlight: the Moon's illuminated fraction x its sunlit share (0 in a total lunar eclipse).
        uMoonK: { value: 0 },
        uFoot: { value: new THREE.Vector4(0, 1, 0, 0) },
        uFootColor: { value: new THREE.Color(0xffffff) },
        uFootK: { value: 0 },
        uSub: { value: sub },
        uSubCol: { value: subCol },
        uSubOn: { value: 0 },
        uFade: { value: 1 },
        // The flat map (shaders/earth.glsl.js SURFACE_VERTEX, MAP_FRAG): morph, plane frame, pole clip.
        uMapK: { value: 0 },
        uMapO: { value: new THREE.Vector3(0, 0, 1.02) },
        uMapR: { value: new THREE.Vector3(1, 0, 0) },
        uMapU: { value: new THREE.Vector3(0, 1, 0) },
        uMapN: { value: new THREE.Vector3(0, 0, 1) },
        uMapLift: { value: 0 },
        uMapClip: { value: 1 / 48 },
    };
    // The face-on aurora (shaders/aurora.glsl.js), shared with the cloud shell.
    const aur = createAuroraUniforms();
    Object.assign(u, aur);
    const aurora = createAuroraDriver(aur, { reducedMotion });

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
            uSunDirL: u.uSunDirL, uPoleW: u.uPoleW, uMoonK: u.uMoonK, ...aur,
            uMapK: u.uMapK, uMapO: u.uMapO, uMapR: u.uMapR, uMapU: u.uMapU, uMapN: u.uMapN, uMapClip: u.uMapClip,
            uMapLift: { value: CLOUD_MAP_LIFT },
        },
        vertexShader: CLOUDS_SHADER.vertex,
        fragmentShader: CLOUDS_SHADER.fragment,
        defines: cloudDefinesFor(cfg),
        transparent: true,
        depthWrite: false,
    });

    let [segW, segH] = segmentsOf(cfg);
    u.uMapClip.value = 1 / segH;
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
    const active = { day: null, night: null, mask: null, clouds: null };
    const pending = { day: null, night: null, mask: null, clouds: null };
    /** Slots that always hold a texture, so they show the key's placeholder until it loads. */
    const IMAGE_SLOT = { day: u.uDay, night: u.uNight };
    /** The image slots' previews: bound sampler, uSharpen component, whether the slot shows it now. */
    const PREV = {
        day: { u: u.uDayPrev, c: 'x', on: false, seen: false, off: null, t0: NaN },
        night: { u: u.uNightPrev, c: 'y', on: false, seen: false, off: null, t0: NaN },
    };

    /**
     * One frame of a slot's sharpen-in (t0: NaN idle, -1 starts on this frame, else its start in s).
     * @param {{on:boolean, seen:boolean, c:'x'|'y', t0:number}} p
     * @param {number} now frame time, s
     */
    function sharpen(p, now) {
        if (p.on) p.seen = true;   // this frame draws the preview
        if (Number.isNaN(p.t0)) return;
        if (p.t0 < 0) p.t0 = now;
        const k = Math.min(1, Math.max(0, ((now - p.t0) * 1000) / SHARPEN_MS));
        u.uSharpen.value[p.c] = k * k * (3 - 2 * k);
        if (k >= 1) p.t0 = NaN;
        else invalidate();
    }

    /** Shows a slot's preview while it has no real map (from now, or once the preview is in). */
    function showPreview(slot, key) {
        const p = PREV[slot];
        const pk = previewKeyFor(interimKeyFor(key) ?? key);
        if (!p || !pk) return;
        const bind = (tex) => {
            p.off = null;
            if (active[slot]) return;
            IMAGE_SLOT[slot].value = tex;
            if (!p.on) p.seen = false;
            p.on = true;
            invalidate();
        };
        if (store.isReady(pk)) bind(store.get(pk));
        else p.off = store.onReady(pk, bind);
    }

    function bindSlot(slot, key) {
        const tex = store.get(key);
        if (IMAGE_SLOT[slot]) {
            const p = PREV[slot];
            if (p.off) { p.off(); p.off = null; }
            if (p.on && p.seen && !reducedMotion) {
                // Over a preview already on screen: keep it bound and sharpen into the map (update()).
                p.u.value = IMAGE_SLOT[slot].value;
                u.uSharpen.value[p.c] = 0;
                p.t0 = -1;
            }
            p.on = false;
            IMAGE_SLOT[slot].value = tex;
        } else if (slot === 'mask') {
            u.uMask.value = tex;
            u.uMaskMode.value = 1;
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

    /** Unsubscribers of a slot's stand-in (max tier: the 4096 map shown while the 8192 one loads). */
    const pendingInterim = { day: null, night: null, mask: null, clouds: null };

    function want(slot, key) {
        if (PREV[slot]?.off) { PREV[slot].off(); PREV[slot].off = null; }
        if (pending[slot]) { pending[slot](); pending[slot] = null; }
        if (pendingInterim[slot]) { pendingInterim[slot](); pendingInterim[slot] = null; }
        if (!key) { clearSlot(slot); invalidate(); return; }
        if (active[slot] === key && isReady(key)) return;
        if (isReady(key)) { bindSlot(slot, key); return; }
        // Not loaded yet: show its stand-in once that is ready, keep any real texture already
        // shown meanwhile, otherwise fall back.
        const stand = interimKeyFor(key);
        if (stand && isReady(stand)) {
            if (active[slot] !== stand) bindSlot(slot, stand);
        } else {
            if (!active[slot]) {
                if (IMAGE_SLOT[slot]) {
                    IMAGE_SLOT[slot].value = store.get(stand ?? key);
                    showPreview(slot, key);
                } else clearSlot(slot);
            }
            if (stand) {
                pendingInterim[slot] = store.onReady(stand, () => {
                    pendingInterim[slot] = null;
                    if (active[slot] !== key) bindSlot(slot, stand);
                });
            }
        }
        pending[slot] = store.onReady(key, () => {
            pending[slot] = null;
            if (pendingInterim[slot]) { pendingInterim[slot](); pendingInterim[slot] = null; }
            bindSlot(slot, key);
        });
    }

    function bindTier() {
        want('day', dayKeyFor(cfg));
        want('night', nightKeyFor(cfg));
        want('mask', maskKeyFor(cfg));
        want('clouds', cloudsKeyFor(cfg));
    }

    function refreshClouds() {
        const key = active.clouds;
        // clouds8k is grey like clouds2k (mode 1); brc4k keeps its clouds in blue (mode 2).
        const mode = key === 'clouds2k' || key === 'clouds8k' ? 1 : key === 'brc4k' ? 2 : 0;
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
            const lit = snap.bodies?.[1]?.phaseFrac;
            const sunlit = snap.eclipse?.moonLitFraction;
            u.uMoonK.value = (Number.isFinite(lit) ? lit : 0) * (Number.isFinite(sunlit) ? sunlit : 1);
            aurora.apply(snap);
            u.uEclipse.value.x = snap.eclipse?.solar ? 1 : 0;
            // The true solar radius (±1.7 % over the year): a constant drew the umbra ~19 % too
            // narrow in August 2027 and the antumbra too wide in February.
            u.uEclipse.value.z = sunAngularRadius(snap.bodies?.[0]?.distAU);
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

        /** Per rendered frame: follows the sky-view crossfade and the flat map's morph. */
        update(fi) {
            aurora.update(fi);
            const now = Number.isFinite(fi?.timeS) ? fi.timeS : 0;
            sharpen(PREV.day, now);
            sharpen(PREV.night, now);
            const sb = Math.min(1, Math.max(0, fi?.skyBlend ?? 0));
            if (sb !== skyBlend) {
                skyBlend = sb;
                refreshVisibility();
            }
            const mk = Math.min(1, Math.max(0, Number.isFinite(fi?.mapK) ? fi.mapK : 0));
            const f = fi?.map;
            if (mk > 0 && f) {
                u.uMapO.value.fromArray(f.center);
                u.uMapR.value.fromArray(f.right).multiplyScalar(f.scale);
                u.uMapU.value.fromArray(f.up).multiplyScalar(f.scale);
                u.uMapN.value.fromArray(f.normal);
            }
            const k = f ? mk : 0;
            if (k !== u.uMapK.value) {
                u.uMapK.value = k;
                mesh.frustumCulled = clouds.frustumCulled = k === 0;
            }
        },

        setLayers(layers) {
            if (!layers) return;
            if ('clouds' in layers) cloudLayer = !!layers.clouds;
            if ('atmosphere' in layers) {
                u.uAtmo.value = layers.atmosphere ? 1 : 0;
                aurora.setOn(!!layers.atmosphere);   // the aurora is shown with the atmosphere layer
            }
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
                u.uMapClip.value = 1 / segH;
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
            const c0 = cloudDefinesFor(prev), c1 = cloudDefinesFor(cfg);
            if (Object.keys(c0).join() !== Object.keys(c1).join()) {
                cloudMaterial.defines = c1;
                cloudMaterial.needsUpdate = true;
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
            for (const p of Object.values(PREV)) { if (p.off) p.off(); p.off = null; }
            for (const k of Object.keys(pending)) { if (pending[k]) pending[k](); pending[k] = null; }
            for (const k of Object.keys(pendingInterim)) { if (pendingInterim[k]) pendingInterim[k](); pendingInterim[k] = null; }
            mesh.geometry.dispose();
            clouds.geometry.dispose();
            material.dispose();
            cloudMaterial.dispose();
            group.removeFromParent();
        },
    };
}

/** Cloud-shell features per tier: the self-shadow march on high and max (relief is on every cloud tier). */
function cloudDefinesFor(cfg) {
    const d = {};
    if (cfg.name === 'high' || cfg.name === 'max') d.CLOUD_SELF_SHADOW = '';
    if (auroraShellFor(cfg)) d.AURORA_SHELL = '';
    return d;
}

function definesFor(cfg) {
    const d = {};
    if (cfg.name !== 'low') d.MOON_GLINT = '';
    if (auroraShellFor(cfg)) d.AURORA_SHELL = '';
    if (cfg.bump) d.BUMP = '';
    if (cfg.cloudShadows && cfg.clouds && cfg.clouds !== 'none') {
        d.CLOUD_SHADOWS = '';
        // Max: a soft shadow edge from a ring of taps (the cloud deck has thickness; one tap draws it razor-thin).
        if (cfg.cloudShadowTaps > 1) d.CLOUD_SHADOW_SOFT = '';
    }
    return d;
}
