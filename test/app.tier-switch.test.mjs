// Staged tier switches (hitch-free-tier-switch): drawing pauses, the tier is staged and compiled,
// and only then committed; DPR steps apply at once; a newer request replaces a staged one; a hung
// compile or a throwing hook never leaves drawing paused; a context loss outlasts the switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTierSwitch, sameTier } from '../js/app/tier-switch.js';
import { createLoop } from '../js/app/loop.js';
import { createStore } from '../js/core/store.js';
import { createClock } from '../js/core/clock.js';

const tier = (name, dprCap = 1) => ({ name, dprCap, defines: name === 'low' ? [] : [name.toUpperCase()] });
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/**
 * Fake render stack: modules take defines at stage (and would compile them at the next draw),
 * the context holds the committed DPR, and draw() reports what a frame would compile.
 */
function fakeStack(start) {
    const log = [];
    let paused = false;
    const compiled = new Set(start.defines);
    const stack = {
        log,
        modules: { defines: start.defines },
        dprCap: start.dprCap,
        compiles: [],
        get paused() { return paused; },
        /** A frame: null while paused, else the defines it had to compile synchronously. */
        draw() {
            if (paused) return null;
            const fresh = stack.modules.defines.filter((d) => !compiled.has(d));
            for (const d of fresh) compiled.add(d);
            return fresh;
        },
        hooks: {
            current: start,
            pause: () => { paused = true; log.push('pause'); },
            resume: () => { paused = false; log.push('resume'); },
            stage: (cfg) => { stack.modules.defines = cfg.defines; log.push(`stage:${cfg.name}`); },
            compile: (cfg) => {
                log.push(`compile:${cfg.name}`);
                let done;
                const p = new Promise((resolve) => { done = resolve; });
                stack.compiles.push(() => {
                    for (const d of cfg.defines) compiled.add(d);
                    done();
                });
                return p;
            },
            commit: (cfg) => { stack.dprCap = cfg.dprCap; log.push(`commit:${cfg.name}`); },
        },
    };
    return stack;
}

test('sameTier: same name, whatever the DPR cap', () => {
    assert.equal(sameTier(tier('high', 2), tier('high', 1.75)), true);
    assert.equal(sameTier(tier('high'), tier('medium')), false);
    assert.equal(sameTier(null, tier('low')), false);
});

test('a new tier is staged, compiled behind paused drawing, then committed', async () => {
    const high = tier('high', 2), medium = tier('medium', 1.5);
    const s = fakeStack(high);
    const sw = createTierSwitch(s.hooks);
    const done = sw.request(medium);
    assert.deepEqual(s.log, ['pause', 'stage:medium', 'compile:medium'], 'staged in the asking task');
    assert.equal(sw.pending, true);
    assert.equal(sw.staged, medium);
    assert.equal(sw.current, high);
    assert.equal(s.draw(), null, 'no frame draws the staged variants');
    assert.equal(s.dprCap, 2, 'the drawing buffer is untouched until the compile is done');
    s.compiles.shift()();
    await done;
    assert.deepEqual(s.log, ['pause', 'stage:medium', 'compile:medium', 'commit:medium', 'resume']);
    assert.equal(sw.current, medium);
    assert.equal(sw.pending, false);
    assert.equal(s.dprCap, 1.5);
    assert.deepEqual(s.draw(), [], 'the first frame of the new tier compiles nothing');
});

test('a governor DPR step (same variants) applies at once, without a pause', async () => {
    const high = tier('high', 2), stepped = tier('high', 1.75);
    const s = fakeStack(high);
    const sw = createTierSwitch(s.hooks);
    sw.request(stepped);
    assert.deepEqual(s.log, ['stage:high', 'commit:high'], 'synchronous, no compile');
    assert.equal(sw.current, stepped);
    assert.equal(s.dprCap, 1.75);
    await sw.request(stepped);
    assert.equal(s.log.length, 2, 'the same cfg again is a no-op');
});

test('a request while a switch is staged replaces it before anything is drawn', async () => {
    const high = tier('high', 2), medium = tier('medium', 1.5), low = tier('low', 1);
    const s = fakeStack(high);
    const sw = createTierSwitch(s.hooks);
    const first = sw.request(medium);
    const second = sw.request(low);
    assert.equal(first, second, 'one run serves both');
    s.compiles.shift()();
    await flush();
    assert.deepEqual(s.log, ['pause', 'stage:medium', 'compile:medium', 'stage:low', 'compile:low']);
    assert.equal(s.draw(), null, 'still paused between the two');
    s.compiles.shift()();
    await second;
    assert.deepEqual(s.log.slice(5), ['commit:low', 'resume'], 'medium is never committed; one pause, one resume');
    assert.equal(sw.current, low);
    assert.deepEqual(s.draw(), []);
});

test('asking for the committed tier while another is staged stages it back', async () => {
    const high = tier('high', 2), medium = tier('medium', 1.5);
    const s = fakeStack(high);
    const sw = createTierSwitch(s.hooks);
    sw.request(medium);
    const back = sw.request(high);
    s.compiles.shift()();
    await flush();
    assert.deepEqual(s.log.slice(3), ['stage:high', 'compile:high'], 'the modules hold medium: restage high');
    s.compiles.shift()();
    await back;
    assert.deepEqual(s.log.slice(5), ['commit:high', 'resume']);
    assert.equal(sw.current, high);
    assert.deepEqual(s.modules.defines, ['HIGH']);
});

test('a DPR step during a staged switch waits for it and is staged too', async () => {
    const high = tier('high', 2), medium = tier('medium', 1.5), medium2 = tier('medium', 1.25);
    const s = fakeStack(high);
    const sw = createTierSwitch(s.hooks);
    sw.request(medium);
    const p = sw.request(medium2);
    assert.equal(s.log.includes('commit:medium'), false);
    s.compiles.shift()();
    await flush();
    s.compiles.shift()();
    await p;
    assert.deepEqual(s.log, ['pause', 'stage:medium', 'compile:medium', 'stage:medium', 'compile:medium', 'commit:medium', 'resume']);
    assert.equal(s.dprCap, 1.25);
});

test('a compile that never settles is given up after timeoutMs; drawing resumes', async () => {
    const high = tier('high', 2), low = tier('low', 1);
    const s = fakeStack(high);
    const timers = [];
    const sw = createTierSwitch({
        ...s.hooks,
        timeoutMs: 5000,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: () => {},
    });
    const p = sw.request(low);
    await flush();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 5000);
    timers[0].fn();
    await p;
    assert.deepEqual(s.log.slice(-2), ['commit:low', 'resume']);
    assert.equal(sw.current, low);
    assert.deepEqual(s.draw(), [], 'whatever is left compiles at the first frame, as before');
});

test('a throwing hook is reported and the switch still commits and resumes', async () => {
    const high = tier('high', 2), medium = tier('medium', 1.5);
    const s = fakeStack(high);
    const errors = [];
    const sw = createTierSwitch({
        ...s.hooks,
        stage: () => { throw new Error('module broke'); },
        compile: () => Promise.reject(new Error('compile broke')),
        onError: (phase, err) => errors.push(`${phase}:${err.message}`),
    });
    await sw.request(medium);
    assert.deepEqual(errors, ['stage:module broke', 'compile:compile broke']);
    assert.deepEqual(s.log, ['pause', 'commit:medium', 'resume']);
    assert.equal(sw.current, medium);
    assert.equal(s.paused, false);
});

test('a request after a finished switch starts a new one', async () => {
    const high = tier('high', 2), medium = tier('medium', 1.5), low = tier('low', 1);
    const s = fakeStack(high);
    const sw = createTierSwitch(s.hooks);
    const a = sw.request(medium);
    s.compiles.shift()();
    await a;
    const b = sw.request(low);
    assert.notEqual(a, b);
    s.compiles.shift()();
    await b;
    assert.deepEqual(s.log.filter((l) => l.startsWith('commit')), ['commit:medium', 'commit:low']);
    assert.deepEqual(s.log.filter((l) => l === 'pause' || l === 'resume'), ['pause', 'resume', 'pause', 'resume']);
});

test('loop: a tier switch ending during a context loss leaves drawing paused until the restore', () => {
    const store = createStore({ status: { phase: 'ready', reducedMotion: false, introPlaying: false } });
    const clock = createClock({ tMs: Date.UTC(2026, 10, 4, 22), playing: false });
    const win = { requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} };
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    const rc = { renderer: null, camera: {}, size: { w: 640, h: 360 }, render() {} };
    const rig = { mode: 'orbit', skyBlend: 0, tweening: false, camera: { fov: 45 }, update() { return false; } };
    const loop = createLoop({ clock, store, bus: { emit() {} }, win, doc, rc, rig, modules: [], getTierCfg: () => ({}) });
    assert.equal(loop.rendering, true);
    loop.setRenderPaused(true, 'tier');
    loop.setRenderPaused(true);                // webglcontextlost (default reason)
    loop.setRenderPaused(false, 'tier');       // the switch gives up its compile and commits
    assert.equal(loop.rendering, false, 'still lost');
    assert.equal(loop.redraw(), false);
    loop.setRenderPaused(false);               // webglcontextrestored
    assert.equal(loop.rendering, true);
    loop.setRenderPaused(true);
    loop.setRenderPaused(true, 'tier');
    loop.setRenderPaused(false);               // restored while a switch compiles
    assert.equal(loop.rendering, false, 'the switch still holds drawing');
    loop.setRenderPaused(false, 'tier');
    assert.equal(loop.rendering, true);
    loop.dispose();
});
