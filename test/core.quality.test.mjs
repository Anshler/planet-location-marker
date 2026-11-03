// Tests for js/core/quality.js — the E.6 table, detectTier cases and the governor.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TIERS, TIER_ORDER, detectTier, tierConfig, createGovernor, isTier, autoStartTier, learnedTierRecord,
    LEARNED_TIER_TTL_MS, MAX_CADENCE_MS, CADENCE_PROBE_TICKS,
} from '../js/core/quality.js';

test('TIERS holds the exact E.6 values', () => {
    assert.deepEqual(TIERS.low, {
        name: 'low', dprCap: 1.0, composer: false, msaa: 0, bloom: null, earthSegments: [64, 32], dayTex: 'day2k', oceanMask: 'roughness2k',
        clouds: 'none', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0, starMagLimit: 5.0, flare: false,
        labelCap: 12, twinkle: false, beamGlowPx: 8, finalPass: false,
    });
    assert.deepEqual(TIERS.medium, {
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4, bloom: { strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 },
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'roughness2k', clouds: 'clouds2k', cloudShadows: false, bump: false,
        atmosphere: 'analytic', atmoSteps: 0, starMagLimit: 6.0, flare: true, labelCap: 24, twinkle: false, beamGlowPx: 12, finalPass: true,
    });
    assert.deepEqual(TIERS.high, {
        name: 'high', dprCap: 2.0, composer: true, msaa: 4, bloom: { strength: 0.6, radius: 0.45, threshold: 0.9, scale: 1.0 },
        earthSegments: [128, 64], dayTex: 'day4k', oceanMask: 'roughness', clouds: 'brc4k', cloudShadows: true, bump: true,
        atmosphere: 'raymarch', atmoSteps: 8, starMagLimit: 6.5, flare: true, labelCap: 40, twinkle: true, beamGlowPx: 14, finalPass: true,
    });
    assert.ok(Object.isFrozen(TIERS.high.bloom) && Object.isFrozen(TIERS.high.earthSegments));
    assert.deepEqual([...TIER_ORDER], ['low', 'medium', 'high']);
    assert.equal(isTier('medium'), true);
    assert.equal(isTier('ultra'), false);
});

const D = (o) => ({ webgl2: true, maxTextureSize: 16384, dpr: 1, coarse: false, screenW: 1920, screenH: 1080, saveData: false, ...o });

test('detectTier: the E.6 table', () => {
    const cases = [
        [{ webgl2: false }, 'low', true, 'no-webgl2'],
        [D({ rendererString: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' }), 'low', false, 'software-renderer'],
        [D({ rendererString: 'llvmpipe (LLVM 15.0.7, 256 bits)' }), 'low', false, 'software-renderer'],
        [D({ rendererString: 'Microsoft Basic Render Driver (Software)' }), 'low', false, 'software-renderer'],
        [D({ coarse: true, rendererString: 'Apple GPU' }), 'medium', false, 'coarse-pointer'],
        [D({ coarse: true, rendererString: 'Adreno (TM) 640' }), 'medium', false, 'coarse-pointer'],
        [D({ coarse: true, rendererString: 'Adreno (TM) 540' }), 'low', false, 'weak-mobile-gpu'],
        [D({ coarse: true, rendererString: 'Mali-G52 MC2' }), 'low', false, 'weak-mobile-gpu'],
        [D({ coarse: true, rendererString: 'Mali-G78 MP14' }), 'medium', false, 'coarse-pointer'],
        [D({ coarse: true, rendererString: 'PowerVR Rogue GE8320' }), 'low', false, 'weak-mobile-gpu'],
        [D({ coarse: true, rendererString: 'Apple GPU', deviceMemory: 2 }), 'low', false, 'coarse-low-memory'],
        [D({ coarse: true, rendererString: 'Apple GPU', maxTextureSize: 2048 }), 'low', false, 'small-max-texture'],
        [D({ coarse: true, rendererString: 'Apple GPU', saveData: true }), 'low', false, 'save-data'],
        [D({ coarse: true, rendererString: 'NVIDIA GeForce RTX 4090' }), 'medium', false, 'coarse-pointer'],
        [D({ rendererString: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' }), 'high', false, 'discrete-gpu'],
        [D({ rendererString: 'ANGLE (NVIDIA, Quadro P2000)' }), 'high', false, 'discrete-gpu'],
        [D({ rendererString: 'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11)' }), 'high', false, 'discrete-gpu'],
        [D({ rendererString: 'AMD Radeon Pro 5500M OpenGL Engine' }), 'high', false, 'discrete-gpu'],
        [D({ rendererString: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)' }), 'high', false, 'discrete-gpu'],
        [D({ rendererString: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' }), 'medium', false, 'integrated-gpu'],
        [D({ rendererString: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)' }), 'medium', false, 'integrated-gpu'],
        [D({ rendererString: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11)' }), 'medium', false, 'integrated-gpu'],
        [D({ rendererString: '' }), 'medium', false, 'integrated-gpu'],
        [D({ rendererString: 'NVIDIA GeForce GTX 1060', deviceMemory: 2 }), 'medium', false, 'discrete-gpu-low-memory'],
        [D({ rendererString: 'NVIDIA GeForce GTX 1060', saveData: true }), 'low', false, 'save-data'],
        [D({ rendererString: 'NVIDIA GeForce GTX 1060', maxTextureSize: 2048 }), 'low', false, 'small-max-texture'],
    ];
    for (const [probe, tier, textMode, reason] of cases) {
        const r = detectTier(probe);
        assert.deepEqual(r, { tier, ceiling: tier, textMode, reason }, `${probe.rendererString ?? 'no webgl2'} coarse=${probe.coarse}`);
    }
    assert.equal(detectTier(null).textMode, true);
    assert.equal(detectTier(undefined).tier, 'low');
    assert.equal(detectTier({ webgl2: true, rendererString: 42 }).tier, 'medium');
});

test('tierConfig: device adjustments on a copy', () => {
    const mc = tierConfig('medium', { coarse: true });
    assert.equal(mc.msaa, 0, 'coarse medium: no MSAA');
    assert.equal(TIERS.medium.msaa, 4, 'TIERS untouched');
    assert.equal(tierConfig('high', { coarse: true }).msaa, 4);
    assert.equal(tierConfig('medium', { maxTextureSize: 4096 }).dayTex, 'day2k');
    assert.equal(tierConfig('medium', { maxTextureSize: 16384 }).dayTex, 'day4k');
    assert.equal(tierConfig('medium').dayTex, 'day4k', 'unknown size keeps 4k');
    const tiny = tierConfig('high', { maxTextureSize: 2048 });
    assert.deepEqual([tiny.dayTex, tiny.clouds, tiny.oceanMask, tiny.bump, tiny.cloudShadows], ['day2k', 'clouds2k', 'roughness2k', false, false]);
    assert.equal(tierConfig('high', { dprCap: 1.75 }).dprCap, 1.75);
    assert.equal(tierConfig('medium', { dprCap: 1.75 }).dprCap, 1.5, 'never above the tier cap');
    assert.equal(tierConfig('low', { dprCap: 0.5 }).dprCap, 1, 'never below 1');
    assert.equal(tierConfig('bogus').name, 'medium');
    const c = tierConfig('high');
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.bloom));
    assert.notEqual(c.bloom, TIERS.high.bloom);
});

/** A governor that has already seen a 60 Hz display idle: the cadence is known, so no probe. */
function gov60(opts) {
    const gov = createGovernor(opts);
    for (let i = 0; i < 31; i++) gov.idle(1000 / 60);
    return gov;
}

/** Feeds `ms` of frames of duration `dt`; returns every non-null result. */
function feed(gov, dt, ms) {
    const out = [];
    for (let t = 0; t < ms; t += dt) {
        const r = gov.sample(dt);
        if (r !== null) out.push(r);
    }
    return out;
}

test('governor steps down after 2 s over budget: DPR first, then the tier', () => {
    const gov = gov60({ tier: 'high', ceiling: 'high', dpr: 2 });
    assert.deepEqual(feed(gov, 16, 10000), [], 'on budget: nothing happens');
    assert.deepEqual(feed(gov, 30, 1500), [], 'not yet 2 s');
    const r1 = feed(gov, 30, 1500);
    assert.deepEqual(r1, ['high'], 'first step lowers the DPR');
    assert.equal(gov.dprCap, 1.75);
    assert.equal(gov.config().dprCap, 1.75);
    assert.equal(gov.tier, 'high');
    assert.deepEqual(feed(gov, 30, 4900), [], '5 s cooldown');
    const r2 = feed(gov, 30, 2600);
    assert.deepEqual(r2, ['medium'], 'second step drops the tier');
    assert.equal(gov.tier, 'medium');
    assert.equal(gov.dprCap, 1.5);
    assert.equal(gov.config().name, 'medium');
    feed(gov, 30, 7700);
    assert.equal(gov.dprCap, 1.25);
    feed(gov, 30, 7700);
    assert.equal(gov.tier, 'low');
    assert.equal(gov.dprCap, 1);
    assert.deepEqual(feed(gov, 60, 60000), [], 'the floor is the floor');
    assert.equal(gov.tier, 'low');
});

test('governor never steps up and does not oscillate', () => {
    const gov = gov60({ tier: 'medium', ceiling: 'medium', dpr: 1 });
    const results = [];
    for (let cycle = 0; cycle < 10; cycle++) {
        results.push(...feed(gov, 40, 3000));
        results.push(...feed(gov, 8, 20000));
    }
    assert.deepEqual(results, ['low'], 'one drop (DPR 1 cannot go lower), never back up');
    assert.equal(gov.tier, 'low');
});

test('governor: DPR step is skipped when it would not change the effective DPR', () => {
    const gov = gov60({ tier: 'high', ceiling: 'high', dpr: 1 });
    assert.deepEqual(feed(gov, 30, 2200), ['medium']);
    const unknownDpr = gov60({ tier: 'high' });
    assert.deepEqual(feed(unknownDpr, 30, 2200), ['high'], 'unknown device DPR: assume the cap is in effect');
    assert.equal(unknownDpr.dprCap, 1.75);
});

test('governor: the 1.3 × budget threshold, coarse budget and EMA smoothing', () => {
    const desktop = gov60({ tier: 'medium', dpr: 1 });
    assert.deepEqual(feed(desktop, 21, 10000), [], '21 ms < 1.3 × 16.7');
    assert.deepEqual(feed(desktop, 23, 3000), ['low'], '23 ms > 21.71');
    const mobile = gov60({ tier: 'medium', coarse: true, dpr: 3 });
    assert.deepEqual(feed(mobile, 40, 10000), [], '40 ms is fine on a 33.4 ms budget');
    assert.deepEqual(feed(mobile, 50, 2500), ['medium'], 'over 43.4 ms: DPR step');
    const spiky = gov60({ tier: 'medium', dpr: 1 });
    for (let i = 0; i < 2000; i++) assert.equal(spiky.sample(i % 60 === 0 ? 120 : 14), null, 'isolated hitches are absorbed');
});

test('governor ignores gaps and junk samples', () => {
    const gov = createGovernor({ tier: 'medium', dpr: 1 });
    for (let i = 0; i < 100; i++) assert.equal(gov.sample(5000), null, 'tab-switch gaps');
    for (const junk of [0, -5, Number.NaN, 'x', undefined]) assert.equal(gov.sample(junk), null);
    assert.equal(gov.emaMs, null, 'no measurement yet');
});

test('governor: pin disables it; pin(null) returns to auto at the ceiling', () => {
    const gov = gov60({ tier: 'medium', ceiling: 'medium', dpr: 1 });
    assert.equal(gov.pin('high'), 'high', 'the user may pin above the ceiling');
    assert.equal(gov.pinned, 'high');
    assert.deepEqual(feed(gov, 50, 10000), [], 'pinned: no automatic changes');
    assert.equal(gov.tier, 'high');
    assert.equal(gov.pin(null), 'medium');
    assert.equal(gov.pinned, null);
    assert.equal(gov.ceiling, 'medium');
    assert.deepEqual(feed(gov, 50, 2200), ['low'], 'auto again');
    assert.equal(gov.pin('nonsense'), 'medium', 'invalid pin means auto');
    gov.reset();
    assert.equal(gov.emaMs, null);
});

/** Feeds `n` idle (display cadence) intervals produced by `f(i)`. */
function idle(gov, n, f) {
    for (let i = 0; i < n; i++) gov.idle(typeof f === 'function' ? f(i) : f);
}

test('governor: a 30 Hz-capped display (Energy Saver, Low Power Mode) never downgrades a capable GPU', () => {
    // Without the cadence (and with no loop to probe it) the rAF interval alone reads as slowness,
    // as in the review's trace: high → DPR step → medium → DPR step → low.
    const blind = createGovernor({ tier: 'high', ceiling: 'high', dpr: 2 });
    assert.deepEqual(feed(blind, 33.3, 30000), ['high', 'medium', 'medium', 'low']);

    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 2 });
    idle(gov, 40, 33.3);
    assert.equal(gov.cadenceMs, 33.3);
    assert.equal(gov.budgetMs, 33.3);
    assert.deepEqual(feed(gov, 33.3, 60000), [], 'frames at the display cadence are on budget');
    assert.equal(gov.tier, 'high');
    assert.equal(gov.dprCap, 2);
});

test('governor: a 48 Hz panel with jitter keeps its tier', () => {
    // 48 Hz = 20.8 ms; jittered rendered intervals average 21.9 ms, above 1.3 × 16.7 = 21.7.
    const jitter = (i) => [19.3, 22.3, 20.8, 21.2, 20.4][i % 5];
    const blind = createGovernor({ tier: 'medium', ceiling: 'medium', dpr: 1 });
    let out = [];
    for (let i = 0; i < 3000; i++) { const r = blind.sample(21.9 + (i % 2 ? 1.5 : -1.5)); if (r) out.push(r); }
    assert.deepEqual(out, ['low'], 'the old budget drops it');

    const gov = createGovernor({ tier: 'medium', ceiling: 'medium', dpr: 1 });
    idle(gov, 31, jitter);
    assert.equal(gov.cadenceMs, 20.8, 'median of the jittered idle intervals');
    out = [];
    for (let i = 0; i < 3000; i++) { const r = gov.sample(21.9 + (i % 2 ? 1.5 : -1.5)); if (r) out.push(r); }
    assert.deepEqual(out, []);
    assert.equal(gov.tier, 'medium');
});

test('governor: real overload under a 30 Hz cap still steps down', () => {
    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    idle(gov, 31, 33.3);
    assert.deepEqual(feed(gov, 66.7, 2100), ['medium'], 'every frame takes two display intervals');
});

test('governor: the cadence is a robust, sliding, bounded median', () => {
    const gov = createGovernor({ tier: 'medium', dpr: 1 });
    idle(gov, 5, 33.3);
    assert.equal(gov.cadenceMs, null, 'fewer than 6 intervals: not trusted yet');
    assert.equal(gov.budgetMs, 16.7);
    idle(gov, 1, 33.3);
    assert.equal(gov.cadenceMs, 33.3);

    const hitchy = createGovernor({ tier: 'medium', dpr: 1 });
    idle(hitchy, 31, (i) => (i % 3 === 0 ? 100 : 16.7));
    assert.equal(hitchy.cadenceMs, 16.7, 'a third of the idle ticks delayed by long tasks: still 60 Hz');

    const fast = createGovernor({ tier: 'high', dpr: 1 });
    idle(fast, 31, 6.9);
    assert.equal(fast.cadenceMs, 6.9);
    assert.equal(fast.budgetMs, 16.7, '144 Hz: the budget never drops below 16.7 ms');
    assert.equal(createGovernor({ coarse: true }).budgetMs, 33.4);

    const stalled = createGovernor({ tier: 'medium', dpr: 1 });
    idle(stalled, 31, 95);
    assert.equal(stalled.cadenceMs, null, 'a stalled main thread is not a display cap: no vote at all');
    assert.equal(stalled.budgetMs, 16.7);
    assert.deepEqual(feed(stalled, 70, 2100), ['low']);
    idle(stalled, 31, MAX_CADENCE_MS);
    assert.equal(stalled.cadenceMs, MAX_CADENCE_MS, 'a 20 Hz display still counts');

    const sliding = createGovernor({ tier: 'medium', dpr: 1 });
    idle(sliding, 31, 33.3);
    idle(sliding, 31, 16.7);
    assert.equal(sliding.cadenceMs, 16.7, 'Energy Saver turned off: the window forgets the old cap');
    for (const junk of [0, -1, Number.NaN, 5000, 'x']) sliding.idle(junk);
    assert.equal(sliding.cadenceMs, 16.7, 'junk and tab-switch gaps are ignored');
});

/**
 * A loop at a display of `cadence` ms whose frames take `frameMs` (≥ cadence), rendering
 * continuously for `ms` (the intro): asks probe() every tick, feeds idle() on consecutive idle
 * ticks and sample() on consecutive rendered ones. Returns the steps and the ticks held back.
 */
function continuous(gov, cadence, frameMs, ms) {
    const steps = [];
    let held = 0;
    let rendered = false;
    let idleBefore = false;
    for (let t = 0; t < ms;) {
        if (gov.probe()) {
            held++;
            if (idleBefore) gov.idle(cadence);
            idleBefore = true;
            rendered = false;
            t += cadence;
            continue;
        }
        if (rendered) {
            const r = gov.sample(frameMs);
            if (r !== null) steps.push(r);
        }
        rendered = true;
        idleBefore = false;
        t += frameMs;
    }
    return { steps, held };
}

test('governor: with no cadence known yet, a due step first holds a few frames back to measure it', () => {
    // The first-visit intro renders from the first frame: no idle ticks before the decision.
    const capped = createGovernor({ tier: 'high', ceiling: 'high', dpr: 2 });
    const a = continuous(capped, 33.3, 33.3, 30000);
    assert.deepEqual(a.steps, [], '30 Hz cap, capable GPU: measured, then kept');
    assert.ok(a.held >= 7 && a.held <= CADENCE_PROBE_TICKS, `held ${a.held} ticks once`);
    assert.equal(capped.cadenceMs, 33.3);

    const slow = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    const s = continuous(slow, 16.7, 40, 2300);
    assert.deepEqual(s.steps, ['medium'], '60 Hz display, slow GPU: the measured budget is the base one, so it steps right after');
    assert.ok(s.held >= 7 && s.held <= CADENCE_PROBE_TICKS, `held ${s.held} ticks`);
    assert.equal(slow.cadenceMs, 16.7);

    // A capped display AND a slow GPU: the measured budget is larger, so 2 s over it are needed.
    const both = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    assert.deepEqual(continuous(both, 33.3, 66.7, 3900).steps, [], 'probed at 2 s, then 2 s over 33.3 ms');
    assert.equal(both.budgetMs, 33.3);
    assert.deepEqual(continuous(both, 33.3, 66.7, 800).steps, ['medium']);

    const noProbe = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    assert.deepEqual(feed(noProbe, 40, 2000), [], 'the probe is offered at 2 s');
    assert.equal(noProbe.probe(), true);
    assert.deepEqual(feed(noProbe, 40, 100), ['medium'], 'a loop that never probes: the base budget decides');

    const known = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    idle(known, 31, 16.7);
    assert.deepEqual(feed(known, 40, 2200), ['medium']);
    assert.equal(known.probe(), false, 'cadence known and fresh: no probe');

    const near60 = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    assert.deepEqual(continuous(near60, 17.5, 40, 2300).steps, ['medium'], 'a budget raised by under 10 % keeps the 2 s');
});

test('governor: a janky boot cannot hide a slow GPU (stalled idle ticks never vote)', () => {
    // The review's boot under back-to-back 70 ms tasks: the loop caps dt at 100 ms.
    const boot = [72.6, 100, 100, 78.9, 12.1, 66.8, 6.0, 66.6, 84.8];
    const slow = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    idle(slow, boot.length, (i) => boot[i]);
    assert.equal(slow.cadenceMs, null, 'two believable intervals: no cadence yet');
    assert.equal(slow.budgetMs, 16.7);
    const s = continuous(slow, 16.7, 46, 2500);
    assert.deepEqual(s.steps, ['medium'], 'probed, then stepped');
    assert.ok(s.held >= 7, `held ${s.held}`);

    const capped = createGovernor({ tier: 'high', ceiling: 'high', dpr: 2 });
    idle(capped, boot.length, (i) => boot[i]);
    assert.deepEqual(continuous(capped, 36.4, 36.4, 30000).steps, [], 'a 30 Hz cap after the same boot: kept');
    assert.equal(capped.cadenceMs, 36.4);
});

test('governor: a cadence gone stale is measured again before a step', () => {
    // Learned at 60 Hz, then a time-lapse renders every tick: no idle ticks for 30 s.
    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 2 });
    idle(gov, 31, 16.7);
    assert.deepEqual(feed(gov, 16.7, 30000), []);
    // Unplugged into Energy Saver mid-time-lapse: rAF drops to 30 Hz.
    const a = continuous(gov, 33.3, 33.3, 30000);
    assert.deepEqual(a.steps, [], 'measured again, then kept');
    assert.ok(a.held >= 7 && a.held <= CADENCE_PROBE_TICKS, `held ${a.held} ticks once`);
    assert.equal(gov.cadenceMs, 33.3);
    assert.equal(gov.tier, 'high');
    assert.equal(gov.dprCap, 2);

    // Paused a moment (idle ticks, still capped): a real overload right after steps without a probe.
    idle(gov, 10, 33.3);
    assert.deepEqual(continuous(gov, 33.3, 66.7, 2500), { steps: ['high'], held: 0 });
    assert.equal(gov.dprCap, 1.75);
    // 30 s of rendering later the cadence is stale again: measured again before the next step.
    feed(gov, 33.3, 30000);
    const c = continuous(gov, 33.3, 66.7, 3500);
    assert.deepEqual(c.steps, ['medium']);
    assert.ok(c.held >= 7, `held ${c.held}`);
});

test('governor: probes never hold a step back, and never run on the floor', () => {
    // Every held tick stalls (> 50 ms): the probe measures nothing, the step follows at once.
    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    const steps = [];
    let held = 0;
    let rendered = false;
    for (let t = 0; t < 3500;) {
        if (gov.probe()) {
            held++;
            gov.idle(100);
            rendered = false;
            t += 100;
            continue;
        }
        if (rendered) {
            const r = gov.sample(40);
            if (r !== null) steps.push(r);
        }
        rendered = true;
        t += 40;
    }
    assert.equal(held, CADENCE_PROBE_TICKS);
    assert.deepEqual(steps, ['medium']);
    assert.equal(gov.cadenceMs, null);

    const floor = createGovernor({ tier: 'low', ceiling: 'low', dpr: 1 });
    assert.deepEqual(continuous(floor, 16.7, 40, 20000), { steps: [], held: 0 }, 'nothing can step: nothing to measure for');
});

test('governor: a single 400 ms hitch is absorbed', () => {
    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    idle(gov, 31, 16.7);
    const out = [...feed(gov, 16.7, 5000)];
    if (gov.sample(400) !== null) out.push('hitch');
    out.push(...feed(gov, 16.7, 10000));
    assert.deepEqual(out, []);
});

test('autoStartTier: a learned tier drop for this GPU, below the ceiling, under 30 days old', () => {
    const gpu = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const now = Date.UTC(2026, 10, 3);
    const rec = learnedTierRecord('medium', gpu, now - 864e5);
    assert.deepEqual(rec, { tier: 'medium', renderer: gpu, atMs: now - 864e5 });
    assert.equal(autoStartTier('high', rec, gpu, now), 'medium');
    assert.equal(autoStartTier('high', JSON.parse(JSON.stringify(rec)), gpu, now), 'medium', 'survives prefs JSON');
    assert.equal(autoStartTier('high', rec, 'ANGLE (Intel, Intel(R) UHD Graphics 630)', now), 'high', 'another GPU');
    assert.equal(autoStartTier('high', rec, gpu, now - 864e5 + LEARNED_TIER_TTL_MS), 'high', 'expired');
    assert.equal(autoStartTier('high', rec, gpu, now - 2 * 864e5), 'high', 'from the future: ignored');
    assert.equal(autoStartTier('medium', learnedTierRecord('low', gpu, now), gpu, now), 'low');
    assert.equal(autoStartTier('low', rec, gpu, now), 'low', 'never above the ceiling');
    for (const junk of [null, undefined, 'medium', 42, {}, { tier: 'ultra', renderer: gpu, atMs: now }, { tier: 'low', renderer: gpu }]) {
        assert.equal(autoStartTier('high', junk, gpu, now), 'high', JSON.stringify(junk));
    }
    assert.equal(autoStartTier('high', learnedTierRecord('low', undefined, now), '', now), 'low', 'unknown renderer string');
});

test('governor: starts at the learned tier, pin(null) returns there, never above the ceiling', () => {
    const gov = createGovernor({ tier: 'medium', ceiling: 'high', dpr: 1 });
    assert.equal(gov.tier, 'medium');
    assert.equal(gov.start, 'medium');
    assert.equal(gov.ceiling, 'high');
    assert.equal(gov.pin('high'), 'high');
    assert.equal(gov.pin(null), 'medium', 'auto again: the learned start, not the ceiling');
    assert.equal(createGovernor({ tier: 'high', ceiling: 'medium' }).tier, 'medium', 'clamped to the ceiling');
    assert.equal(createGovernor({ tier: 'bogus', ceiling: 'low' }).tier, 'low');
});

test('governor config() is cached until something changes', () => {
    const gov = gov60({ tier: 'high', dpr: 2, coarse: false, maxTextureSize: 16384 });
    const a = gov.config();
    assert.equal(gov.config(), a);
    feed(gov, 40, 2200);
    assert.notEqual(gov.config(), a);
    assert.equal(gov.config().dprCap, 1.75);
});
