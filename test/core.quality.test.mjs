// Tests for js/core/quality.js — the E.6 table, detectTier cases and the governor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, TIER_ORDER, detectTier, tierConfig, createGovernor, isTier } from '../js/core/quality.js';

test('TIERS holds the exact E.6 values', () => {
    assert.deepEqual(TIERS.low, {
        name: 'low', dprCap: 1.0, composer: false, msaa: 0, bloom: null, earthSegments: [64, 32], dayTex: 'day2k', oceanMask: 'derived',
        clouds: 'none', cloudShadows: false, bump: false, atmosphere: 'analytic', atmoSteps: 0, starMagLimit: 5.0, flare: false,
        labelCap: 12, twinkle: false, beamGlowPx: 8, finalPass: false,
    });
    assert.deepEqual(TIERS.medium, {
        name: 'medium', dprCap: 1.5, composer: true, msaa: 4, bloom: { strength: 0.55, radius: 0.4, threshold: 0.9, scale: 0.5 },
        earthSegments: [96, 48], dayTex: 'day4k', oceanMask: 'specular', clouds: 'clouds1k', cloudShadows: false, bump: false,
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
    assert.deepEqual([tiny.dayTex, tiny.clouds, tiny.oceanMask, tiny.bump, tiny.cloudShadows], ['day2k', 'clouds1k', 'specular', false, false]);
    assert.equal(tierConfig('high', { dprCap: 1.75 }).dprCap, 1.75);
    assert.equal(tierConfig('medium', { dprCap: 1.75 }).dprCap, 1.5, 'never above the tier cap');
    assert.equal(tierConfig('low', { dprCap: 0.5 }).dprCap, 1, 'never below 1');
    assert.equal(tierConfig('bogus').name, 'medium');
    const c = tierConfig('high');
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.bloom));
    assert.notEqual(c.bloom, TIERS.high.bloom);
});

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
    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 2 });
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
    const gov = createGovernor({ tier: 'medium', ceiling: 'medium', dpr: 1 });
    const results = [];
    for (let cycle = 0; cycle < 10; cycle++) {
        results.push(...feed(gov, 40, 3000));
        results.push(...feed(gov, 8, 20000));
    }
    assert.deepEqual(results, ['low'], 'one drop (DPR 1 cannot go lower), never back up');
    assert.equal(gov.tier, 'low');
});

test('governor: DPR step is skipped when it would not change the effective DPR', () => {
    const gov = createGovernor({ tier: 'high', ceiling: 'high', dpr: 1 });
    assert.deepEqual(feed(gov, 30, 2200), ['medium']);
    const unknownDpr = createGovernor({ tier: 'high' });
    assert.deepEqual(feed(unknownDpr, 30, 2200), ['high'], 'unknown device DPR: assume the cap is in effect');
    assert.equal(unknownDpr.dprCap, 1.75);
});

test('governor: the 1.3 × budget threshold, coarse budget and EMA smoothing', () => {
    const desktop = createGovernor({ tier: 'medium', dpr: 1 });
    assert.deepEqual(feed(desktop, 21, 10000), [], '21 ms < 1.3 × 16.7');
    assert.deepEqual(feed(desktop, 23, 3000), ['low'], '23 ms > 21.71');
    const mobile = createGovernor({ tier: 'medium', coarse: true, dpr: 3 });
    assert.deepEqual(feed(mobile, 40, 10000), [], '40 ms is fine on a 33.4 ms budget');
    assert.deepEqual(feed(mobile, 50, 2500), ['medium'], 'over 43.4 ms: DPR step');
    const spiky = createGovernor({ tier: 'medium', dpr: 1 });
    for (let i = 0; i < 2000; i++) assert.equal(spiky.sample(i % 60 === 0 ? 120 : 14), null, 'isolated hitches are absorbed');
});

test('governor ignores gaps and junk samples', () => {
    const gov = createGovernor({ tier: 'medium', dpr: 1 });
    for (let i = 0; i < 100; i++) assert.equal(gov.sample(5000), null, 'tab-switch gaps');
    for (const junk of [0, -5, Number.NaN, 'x', undefined]) assert.equal(gov.sample(junk), null);
    assert.equal(gov.emaMs, null, 'no measurement yet');
});

test('governor: pin disables it; pin(null) returns to auto at the ceiling', () => {
    const gov = createGovernor({ tier: 'medium', ceiling: 'medium', dpr: 1 });
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

test('governor config() is cached until something changes', () => {
    const gov = createGovernor({ tier: 'high', dpr: 2, coarse: false, maxTextureSize: 16384 });
    const a = gov.config();
    assert.equal(gov.config(), a);
    feed(gov, 40, 2200);
    assert.notEqual(gov.config(), a);
    assert.equal(gov.config().dprCap, 1.75);
});
