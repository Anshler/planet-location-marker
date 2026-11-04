// Quality tiers, device detection and the frame-time governor (SPEC §C.3, §E.6).
//
// TIERS holds the exact table values. Device-specific adjustments (MSAA off on coarse-pointer
// medium, 2k day texture when the GPU cannot take 4k comfortably, the governor's DPR steps) are
// applied by tierConfig(), which returns a resolved copy, so TIERS itself never changes.

/** @typedef {import('./types.js').TierCfg} TierCfg */
/** @typedef {'low'|'medium'|'high'|'max'} TierName */

/** @param {any} o */
function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
}

/**
 * Tier table (SPEC §E.6). Frozen; use tierConfig() for a device-adjusted copy.
 * `supersample`: idle progressive supersampling's sample cap (core/sampling.js; 0 = off, the low
 * tier: canvas MSAA and no composer). `streakPx`: the longest fast-time star streak in device px
 * (render/streaks.js; 0 = off).
 */
export const TIERS = deepFreeze({
    low: {
        name: 'low', dprCap: 1.0, composer: false, msaa: 0, bloom: null,
        earthSegments: [64, 32], dayTex: 'day2k', oceanMask: 'roughness2k',
        clouds: 'none', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0,
        starMagLimit: 5.0, flare: false, labelCap: 12, twinkle: false, beamGlowPx: 8, finalPass: false,
        supersample: 0, streakPx: 0,
    },
    medium: {
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4, bloom: { strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 },
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'roughness2k',
        clouds: 'clouds2k', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0,
        starMagLimit: 6.0, flare: true, labelCap: 24, twinkle: false, beamGlowPx: 12, finalPass: true,
        supersample: 8, streakPx: 14,
    },
    high: {
        name: 'high', dprCap: 2.0, composer: true, msaa: 4, bloom: { strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 },
        earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness',
        clouds: 'brc4k', cloudShadows: true, bump: true, atmosphere: 'raymarch', atmoSteps: 8,
        starMagLimit: 6.5, flare: true, labelCap: 40, twinkle: true, beamGlowPx: 14, finalPass: true,
        supersample: 16, streakPx: 24,
    },
    // Manual only (Settings or #q=max): no budget. Auto never picks it, and the governor never
    // leaves it (a chosen tier is pinned, and a pinned tier is not governed). Every knob at its
    // ceiling: the device's full DPR (still bounded by the GPU's render-buffer size), as many MSAA
    // samples as the context allows (postfx clamps to MAX_SAMPLES; FXAA takes over only if that
    // is 0), 8192 px day, night and cloud maps (the 4096 ones show while they load), a 4096 px
    // Moon, 16x anisotropy on the Earth and Moon maps, 32 atmosphere samples, soft cloud shadows
    // and the densest Earth mesh. The star limit is the catalog's own: it stops at magnitude 6.0,
    // so 6.5 already draws every star. tierConfig() falls back per feature, never per tier.
    max: {
        name: 'max', dprCap: Infinity, composer: true, msaa: 16, bloom: { strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 },
        earthSegments: [256, 128], dayTex: 'day8k', oceanMask: 'roughness', clouds: 'clouds8k', cloudShadows: true, bump: true,
        atmosphere: 'raymarch', atmoSteps: 32, starMagLimit: 6.5, flare: true, labelCap: 80, twinkle: true, beamGlowPx: 14,
        finalPass: true, moonTex: 'moon4k', anisotropy: 16, cloudShadowTaps: 5, supersample: 16, streakPx: 32,
    },
});

/** The tiers Auto and the governor move between, lowest to highest. 'max' is manual only. */
export const TIER_ORDER = Object.freeze(['low', 'medium', 'high']);
/** Every tier a user can choose, lowest to highest. */
export const ALL_TIERS = Object.freeze([...TIER_ORDER, 'max']);

/** Software rasterisers: always low. */
const SOFTWARE_GPU = /SwiftShader|llvmpipe|Software/i;
/** Mobile GPUs too weak for the medium tier. */
const WEAK_MOBILE_GPU = /Mali-G[0-5]\d\b|Adreno \(TM\) [1-5]\d\d|PowerVR/;
/** Desktop GPUs that can carry the high tier. */
const DISCRETE_GPU = /NVIDIA|GeForce|RTX|Quadro|Radeon RX|Radeon Pro|Apple M\d (Pro|Max|Ultra)/i;

/**
 * True for 'low' | 'medium' | 'high' | 'max'.
 * @param {unknown} t
 * @returns {t is TierName}
 */
export function isTier(t) {
    return t === 'low' || t === 'medium' || t === 'high' || t === 'max';
}

/**
 * True for the tiers Auto may run at: 'low' | 'medium' | 'high' (never 'max').
 * @param {unknown} t
 * @returns {t is 'low'|'medium'|'high'}
 */
export function isAutoTier(t) {
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
 *  - maxTextureSize known and < 8192: the 2k day (and so night) map on medium (SPEC §I risk 4);
 *  - maxTextureSize known and < 8192: max keeps the 4096 day, night and cloud maps (per feature,
 *    the rest of max stays);
 *  - maxTextureSize known and < 4096: no 4k-only features (bump, cloud shadows, brc4k clouds,
 *    roughness mask, the 4096 Moon);
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
    if (texKnown && maxTextureSize < 8192) {
        if (cfg.dayTex === 'day8k') cfg.dayTex = 'day4k';
        if (cfg.clouds === 'clouds8k') cfg.clouds = 'brc4k';
    }
    if (texKnown && maxTextureSize < 4096) {
        cfg.dayTex = 'day2k';
        if (cfg.clouds === 'brc4k') cfg.clouds = 'clouds2k';
        if (cfg.oceanMask === 'roughness') cfg.oceanMask = 'roughness2k';
        if (cfg.moonTex) cfg.moonTex = 'moon';
        cfg.bump = false;
        cfg.cloudShadows = false;
    }
    if (Number.isFinite(dprCap) && dprCap > 0) cfg.dprCap = Math.min(cfg.dprCap, Math.max(1, dprCap));
    return deepFreeze(cfg);
}

/** How long a tier the governor learned stays the starting tier on that GPU: 30 days (ms). */
export const LEARNED_TIER_TTL_MS = 30 * 864e5;

/**
 * The tier Auto starts at: the governor's last tier drop (prefs 'qualityLearned') when it was
 * saved for this renderer string under 30 days ago and is below the ceiling, else the ceiling.
 * It expires, so one bad session cannot cap a device for good.
 * @param {TierName} ceiling
 * @param {unknown} learned the saved learnedTierRecord, or null
 * @param {string} rendererString
 * @param {number} nowMs epoch ms
 * @returns {TierName}
 */
export function autoStartTier(ceiling, learned, rendererString, nowMs) {
    const ceil = isAutoTier(ceiling) ? ceiling : 'medium';
    if (!learned || typeof learned !== 'object') return ceil;
    const { tier, renderer, atMs } = /** @type {any} */ (learned);
    if (!isAutoTier(tier) || renderer !== String(rendererString ?? '')) return ceil;
    const age = nowMs - atMs;
    if (!(age >= 0 && age < LEARNED_TIER_TTL_MS)) return ceil;
    return rank(tier) < rank(ceil) ? tier : ceil;
}

/**
 * What main.js saves when the governor drops a tier (read back by autoStartTier).
 * @param {TierName} tier
 * @param {string} rendererString
 * @param {number} nowMs epoch ms
 */
export function learnedTierRecord(tier, rendererString, nowMs) {
    return { tier, renderer: String(rendererString ?? ''), atMs: nowMs };
}

/** The display cadence: the median of the last 31 idle intervals, once 6 are in. */
const CADENCE_WINDOW = 31;
const CADENCE_MIN_SAMPLES = 6;
/** Ticks a cadence probe holds back: about 130 ms at 60 Hz, 270 ms at 30 Hz. */
export const CADENCE_PROBE_TICKS = 8;
/**
 * Slowest believable display (20 Hz). A slower idle tick is a stalled main thread (the loop caps
 * dt at 100 ms, so boot stalls arrive as 60–100 ms ticks) and is not a cadence sample at all.
 */
export const MAX_CADENCE_MS = 50;
/**
 * Rendered time (ms) after which the newest idle tick no longer vouches for the display (a cap
 * can start mid-session while every tick renders), and the minimum spacing between probes.
 */
export const CADENCE_STALE_MS = 5000;

/**
 * Downgrade-only frame-time governor (SPEC §E.6).
 *
 * Feed sample(dt) the dt of consecutive rendered frames. It keeps an EMA (α = 0.05) and when the
 * EMA stays above 1.3 × budget for 2 s of rendered time it steps down: first the DPR cap by 0.25
 * (once per tier, never below 1.0, only if that actually lowers the effective DPR), then one tier.
 * Each step starts a 5 s cooldown with a fresh EMA. It never steps up, so it cannot oscillate.
 * pin(tier) (Settings or ?q=) disables it; pin(null) returns to auto at the start tier. 'max' is
 * reachable only through pin(): Auto's ceiling and start are always low, medium or high, so the
 * governor never runs at max and never steps a deliberate max choice down.
 *
 * The budget is 16.7 ms (33.4 ms on coarse pointers), or the display's own frame interval when
 * longer: Energy Saver and Low Power Mode cap rAF at 30 Hz, and a 48 Hz panel never ticks faster
 * than 20.8 ms. Feed idle(dt) the dt of consecutive rAF ticks that drew nothing. Only those show
 * the display: a frame that takes two intervals looks like a display twice as slow. Idle ticks
 * over MAX_CADENCE_MS are a stalled main thread and are dropped, so a janky boot cannot inflate
 * the budget and hide a slow GPU.
 *
 * A step can come due with no current measurement: the intro renders from its first frame, and
 * a time-lapse or a long drag renders every tick, so a cap that starts mid-session (a laptop
 * unplugged into Energy Saver) brings no idle ticks. When a step is due and the cadence is
 * unknown, or its newest idle tick is over CADENCE_STALE_MS of rendering old, the governor
 * measures afresh: probe() returns true for up to CADENCE_PROBE_TICKS ticks (the loop draws
 * nothing) and the sample ring restarts (the previous median stands until 6 new intervals are in).
 * The step then follows on the next sample still over the measured budget, unless that budget
 * is over 10 % larger: time over a smaller budget is no evidence against a larger one, so the
 * 2 s start again. Probes are at least CADENCE_STALE_MS of rendering apart, so one that
 * measures nothing (every tick stalled) cannot hold a step back.
 *
 * sample(dt) returns the tier name whenever the configuration changed (a tier drop OR a DPR step)
 * and null otherwise; apply `config()` (a resolved TierCfg including the reduced dprCap).
 * dt values over 1 s are treated as gaps (not consecutive) and ignored; dt is capped at 250 ms.
 *
 * @param {{tier?:TierName, ceiling?:TierName, coarse?:boolean, dpr?:number, maxTextureSize?:number,
 *          budgetMs?:number}} [opts] `tier`: the Auto start (≤ ceiling); `budgetMs`: the base budget.
 * @returns {import('./types.js').Governor}
 */
export function createGovernor({ tier = 'medium', ceiling, coarse = false, dpr, maxTextureSize, budgetMs } = {}) {
    const ceil = isAutoTier(ceiling) ? ceiling : isAutoTier(tier) ? tier : 'medium';
    const start = isAutoTier(tier) && rank(tier) < rank(ceil) ? tier : ceil;
    let cur = start;
    const baseBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : coarse ? 33.4 : 16.7;
    const deviceDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : null;

    // Idle intervals and a scratch copy to sort (no per-frame allocation).
    const ring = new Float64Array(CADENCE_WINDOW);
    const sorted = new Float64Array(CADENCE_WINDOW);
    let ringCount = 0;
    let ringNext = 0;
    let ringDirty = false;
    /** @type {number|null} */
    let cadence = null;
    /** @type {number|null} The previous median, while a restarted ring fills. */
    let fallback = null;
    let probeLeft = 0;
    // Rendered time since the newest accepted idle tick and since the last probe began.
    let sinceIdleMs = 0;
    let sinceProbeMs = Infinity;

    /** @type {TierName|null} */
    let pinned = null;
    let dprCap = TIERS[cur].dprCap;
    let dprStepped = false;
    /** @type {number|null} */
    let ema = null;
    let overMs = 0;
    /** The budget at the start of the current over-budget run. */
    let overBudget = baseBudget;
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

    /** True while lowering the DPR cap would lower the DPR actually in effect (once per tier). */
    function dprCanStep() {
        const effective = deviceDpr === null ? dprCap : Math.min(deviceDpr, dprCap);
        return !dprStepped && effective > 1.0 + 1e-6;
    }

    /** Takes one downgrade step; returns true when something changed. */
    function stepDown() {
        if (dprCanStep()) {
            const effective = deviceDpr === null ? dprCap : Math.min(deviceDpr, dprCap);
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

    /**
     * The median idle interval, or (fewer than 6 in the ring) the previous ring's median or
     * null; re-sorted only after idle().
     */
    function cadenceMs() {
        if (!ringDirty) return cadence;
        ringDirty = false;
        if (ringCount < CADENCE_MIN_SAMPLES) return (cadence = fallback);
        sorted.set(ring);
        if (ringCount < CADENCE_WINDOW) sorted.fill(Infinity, ringCount); // unfilled slots sort last
        sorted.sort();
        cadence = sorted[(ringCount - 1) >> 1];
        return cadence;
    }

    /** Empties the ring for a fresh measurement; the current median stands in meanwhile. */
    function restartCadence() {
        fallback = cadenceMs();
        ringCount = 0;
        ringNext = 0;
        ringDirty = true;
    }

    function budget() {
        const c = cadenceMs();
        return c === null ? baseBudget : Math.max(baseBudget, c);
    }

    function idle(dtMs) {
        const dt = Number(dtMs);
        // Slower than any believable display: the main thread stalled. It never votes.
        if (!(dt > 0) || dt > MAX_CADENCE_MS) return;
        ring[ringNext] = dt;
        ringNext = (ringNext + 1) % CADENCE_WINDOW;
        if (ringCount < CADENCE_WINDOW) ringCount++;
        ringDirty = true;
        sinceIdleMs = 0;
    }

    function sample(dtMs) {
        const dt = Number(dtMs);
        if (!(dt > 0) || dt > 1000) return null;
        const d = Math.min(dt, 250);
        sinceIdleMs += d;
        sinceProbeMs += d;
        if (pinned !== null) return null;
        if (cooldownMs > 0) {
            cooldownMs -= d;
            return null;
        }
        ema = ema === null ? d : ema + 0.05 * (d - ema);
        const b = budget();
        if (ema > 1.3 * b) {
            // A run starts here, or a probe raised the budget (by over 10 %, not jitter): time
            // over the old budget is no evidence against the new one, so the 2 s start again.
            if (overMs === 0 || b > 1.1 * overBudget) {
                overMs = 0;
                overBudget = b;
            }
            overMs += d;
        } else {
            overMs = 0;
        }
        if (overMs < 2000) return null;
        // On the floor (low, DPR step taken) nothing can step: no probe either.
        const canStep = rank(cur) > 0 || dprCanStep();
        if (canStep && sinceProbeMs >= CADENCE_STALE_MS
            && (cadenceMs() === null || sinceIdleMs >= CADENCE_STALE_MS)) {
            // Measure the display as it is now before blaming the GPU; the next sample decides.
            sinceProbeMs = 0;
            restartCadence();
            probeLeft = CADENCE_PROBE_TICKS;
            return null;
        }
        resetMeasure();
        if (!stepDown()) return null;
        cooldownMs = 5000;
        return cur;
    }

    /** Asked once per rAF tick: true while the loop should draw nothing (a probe is measuring). */
    function probe() {
        if (probeLeft <= 0) return false;
        if (ringCount >= CADENCE_MIN_SAMPLES) {
            probeLeft = 0;
            return false;
        }
        probeLeft--;
        return true;
    }

    function pin(t) {
        if (isTier(t)) {
            pinned = t;
            setTier(t);
        } else {
            pinned = null;
            setTier(start);
        }
        return cur;
    }

    function config() {
        if (!cfgMemo) cfgMemo = tierConfig(cur, { coarse, maxTextureSize, dprCap });
        return cfgMemo;
    }

    return {
        sample,
        idle,
        probe,
        pin,
        config,
        reset() {
            resetMeasure();
            cooldownMs = 0;
        },
        get tier() { return cur; },
        get ceiling() { return ceil; },
        get start() { return start; },
        get pinned() { return pinned; },
        get dprCap() { return dprCap; },
        get emaMs() { return ema; },
        get cadenceMs() { return cadenceMs(); },
        get budgetMs() { return budget(); },
    };
}
