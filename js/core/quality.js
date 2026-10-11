// Quality tiers, device detection and the frame-time governor (SPEC §C.3, §E.6).
//
// TIERS holds the exact table values. Device-specific adjustments (MSAA off on coarse-pointer
// medium, 2k day texture when the GPU cannot take 4k comfortably, the governor's DPR steps) are
// applied by tierConfig(), which returns a resolved copy, so TIERS itself never changes.

/** @typedef {import('./types.js').TierCfg} TierCfg */
/** @typedef {'low'|'medium'|'high'} TierName */

/** @param {any} o */
function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
}

/** Tier table (SPEC §E.6). Frozen; use tierConfig() for a device-adjusted copy. */
export const TIERS = deepFreeze({
    low: {
        name: 'low', dprCap: 1.0, composer: false, msaa: 0, bloom: null,
        earthSegments: [64, 32], dayTex: 'day2k', oceanMask: 'derived',
        clouds: 'none', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0,
        starMagLimit: 5.0, flare: false, labelCap: 12, twinkle: false, beamGlowPx: 8, finalPass: false,
    },
    medium: {
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4, bloom: { strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 },
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'specular',
        clouds: 'clouds1k', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0,
        starMagLimit: 6.0, flare: true, labelCap: 24, twinkle: false, beamGlowPx: 12, finalPass: true,
    },
    high: {
        name: 'high', dprCap: 2.0, composer: true, msaa: 4, bloom: { strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 },
        earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness',
        clouds: 'brc4k', cloudShadows: true, bump: true, atmosphere: 'raymarch', atmoSteps: 8,
        starMagLimit: 6.5, flare: true, labelCap: 40, twinkle: true, beamGlowPx: 14, finalPass: true,
    },
});

/** Tier names from lowest to highest. */
export const TIER_ORDER = Object.freeze(['low', 'medium', 'high']);

/** Software rasterisers: always low. */
const SOFTWARE_GPU = /SwiftShader|llvmpipe|Software/i;
/** Mobile GPUs too weak for the medium tier. */
const WEAK_MOBILE_GPU = /Mali-G[0-5]\d\b|Adreno \(TM\) [1-5]\d\d|PowerVR/;
/** Desktop GPUs that can carry the high tier. */
const DISCRETE_GPU = /NVIDIA|GeForce|RTX|Quadro|Radeon RX|Radeon Pro|Apple M\d (Pro|Max|Ultra)/i;

/**
 * True for 'low' | 'medium' | 'high'.
 * @param {unknown} t
 * @returns {t is TierName}
 */
export function isTier(t) {
    return t === 'low' || t === 'medium' || t === 'high';
}

/** @param {TierName} t */
function rank(t) {
    return TIER_ORDER.indexOf(t);
}

/**
 * Picks the starting tier and the auto ceiling for a device (SPEC §E.6). The initial tier equals
 * the ceiling. Beyond the table: Save-Data and a max texture size under 4096 mean low on any
 * device, and a desktop discrete GPU with under 4 GB of device memory is held at medium.
 * `textMode` is true when there is no WebGL2 (three r170 needs it): the caller shows the text UI.
 * @param {import('./types.js').TierProbe} probe
 * @returns {import('./types.js').TierDecision}
 */
export function detectTier(probe) {
    const p = probe && typeof probe === 'object' ? probe : {};
    const decide = (tier, reason, textMode = false) => ({ tier, ceiling: tier, textMode, reason });
    if (!p.webgl2) return decide('low', 'no-webgl2', true);
    const gpu = typeof p.rendererString === 'string' ? p.rendererString : '';
    if (SOFTWARE_GPU.test(gpu)) return decide('low', 'software-renderer');
    const lowMem = Number.isFinite(p.deviceMemory) && p.deviceMemory < 4;
    const smallTex = Number.isFinite(p.maxTextureSize) && p.maxTextureSize < 4096;
    if (p.coarse) {
        if (lowMem) return decide('low', 'coarse-low-memory');
        if (smallTex) return decide('low', 'small-max-texture');
        if (p.saveData) return decide('low', 'save-data');
        if (WEAK_MOBILE_GPU.test(gpu)) return decide('low', 'weak-mobile-gpu');
        return decide('medium', 'coarse-pointer');
    }
    if (smallTex) return decide('low', 'small-max-texture');
    if (p.saveData) return decide('low', 'save-data');
    if (DISCRETE_GPU.test(gpu)) return lowMem ? decide('medium', 'discrete-gpu-low-memory') : decide('high', 'discrete-gpu');
    return decide('medium', 'integrated-gpu');
}

/**
 * A resolved, frozen copy of TIERS[name] for this device:
 *  - coarse pointer: MSAA 0 on medium (SPEC §E.6);
 *  - maxTextureSize known and < 8192: the 2k day map on medium (SPEC §I risk 4);
 *  - maxTextureSize known and < 4096: no 4k-only features (bump, cloud shadows, brc4k clouds, roughness mask);
 *  - dprCap: the governor's reduced DPR cap, never above the tier's own cap.
 * @param {TierName} name
 * @param {{coarse?:boolean, maxTextureSize?:number, dprCap?:number}} [env]
 * @returns {TierCfg}
 */
export function tierConfig(name, { coarse = false, maxTextureSize, dprCap } = {}) {
    const base = TIERS[isTier(name) ? name : 'medium'];
    const cfg = {
        ...base,
        earthSegments: [base.earthSegments[0], base.earthSegments[1]],
        bloom: base.bloom ? { ...base.bloom } : null,
    };
    if (coarse && cfg.name === 'medium') cfg.msaa = 0;
    const texKnown = Number.isFinite(maxTextureSize) && maxTextureSize > 0;
    if (texKnown && maxTextureSize < 8192 && cfg.name === 'medium') cfg.dayTex = 'day2k';
    if (texKnown && maxTextureSize < 4096) {
        cfg.dayTex = 'day2k';
        if (cfg.clouds === 'brc4k') cfg.clouds = 'clouds1k';
        if (cfg.oceanMask === 'roughness') cfg.oceanMask = 'specular';
        cfg.bump = false;
        cfg.cloudShadows = false;
    }
    if (Number.isFinite(dprCap) && dprCap > 0) cfg.dprCap = Math.min(cfg.dprCap, Math.max(1, dprCap));
    return deepFreeze(cfg);
}

/**
 * Downgrade-only frame-time governor (SPEC §E.6).
 *
 * Feed it the dt of consecutive rendered frames. It keeps an EMA (α = 0.05) and when the EMA stays
 * above 1.3 × budget (16.7 ms, or 33.4 ms on coarse pointers) for 2 s of rendered time it steps
 * down: first the DPR cap by 0.25 (once per tier, never below 1.0, only if that actually lowers
 * the effective DPR), then one tier. Each step starts a 5 s cooldown with a fresh EMA. It never
 * steps up, so it cannot oscillate. pin(tier) (Settings or ?q=) disables it; pin(null) returns to
 * auto at the ceiling.
 *
 * sample(dt) returns the tier name whenever the configuration changed (a tier drop OR a DPR step)
 * and null otherwise; apply `config()` (a resolved TierCfg including the reduced dprCap).
 * dt values over 1 s are treated as gaps (not consecutive) and ignored; dt is capped at 250 ms.
 *
 * @param {{tier?:TierName, ceiling?:TierName, coarse?:boolean, dpr?:number, maxTextureSize?:number,
 *          budgetMs?:number}} [opts]
 * @returns {import('./types.js').Governor}
 */
export function createGovernor({ tier = 'medium', ceiling, coarse = false, dpr, maxTextureSize, budgetMs } = {}) {
    const ceil = isTier(ceiling) ? ceiling : isTier(tier) ? tier : 'medium';
    let cur = isTier(tier) ? tier : ceil;
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : coarse ? 33.4 : 16.7;
    const deviceDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : null;

    /** @type {TierName|null} */
    let pinned = null;
    let dprCap = TIERS[cur].dprCap;
    let dprStepped = false;
    /** @type {number|null} */
    let ema = null;
    let overMs = 0;
    let cooldownMs = 0;
    /** @type {TierCfg|null} */
    let cfgMemo = null;

    function resetMeasure() {
        ema = null;
        overMs = 0;
    }

    function setTier(t) {
        cur = t;
        dprCap = TIERS[t].dprCap;
        dprStepped = false;
        cfgMemo = null;
        resetMeasure();
        cooldownMs = 0;
    }

    /** Takes one downgrade step; returns true when something changed. */
    function stepDown() {
        const effective = deviceDpr === null ? dprCap : Math.min(deviceDpr, dprCap);
        if (!dprStepped && effective > 1.0 + 1e-6) {
            dprCap = Math.max(1.0, effective - 0.25);
            dprStepped = true;
            cfgMemo = null;
            return true;
        }
        const i = rank(cur);
        if (i <= 0) return false;
        const next = TIER_ORDER[i - 1];
        const keepCap = Math.min(TIERS[next].dprCap, dprCap);
        cur = next;
        dprCap = keepCap;
        dprStepped = false;
        cfgMemo = null;
        return true;
    }

    function sample(dtMs) {
        if (pinned !== null) return null;
        const dt = Number(dtMs);
        if (!(dt > 0) || dt > 1000) return null;
        const d = Math.min(dt, 250);
        if (cooldownMs > 0) {
            cooldownMs -= d;
            return null;
        }
        ema = ema === null ? d : ema + 0.05 * (d - ema);
        if (ema > 1.3 * budget) overMs += d;
        else overMs = 0;
        if (overMs < 2000) return null;
        resetMeasure();
        if (!stepDown()) return null;
        cooldownMs = 5000;
        return cur;
    }

    function pin(t) {
        if (isTier(t)) {
            pinned = t;
            setTier(t);
        } else {
            pinned = null;
            setTier(ceil);
        }
        return cur;
    }

    function config() {
        if (!cfgMemo) cfgMemo = tierConfig(cur, { coarse, maxTextureSize, dprCap });
        return cfgMemo;
    }

    return {
        sample,
        pin,
        config,
        reset() {
            resetMeasure();
            cooldownMs = 0;
        },
        get tier() { return cur; },
        get ceiling() { return ceil; },
        get pinned() { return pinned; },
        get dprCap() { return dprCap; },
        get emaMs() { return ema; },
    };
}
