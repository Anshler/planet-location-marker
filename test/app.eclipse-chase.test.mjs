// The globe's eclipse ribbon policy and the shadow chase (js/app/eclipse-chase.js): ribbonPlan,
// the clock legs, the follow target, and the controller driven with the real clock and store and a
// stand-in rig and ribbon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ribbonPlan, chaseLegs, chaseTarget, createEclipseChase, CHASE_DURATION_S, CHASE_HOLD_MS, CHASE_POSE } from '../js/app/eclipse-chase.js';
import { eclipsePath, pathFrameLocal } from '../js/astro/eclipse-path.js';
import { createClock } from '../js/core/clock.js';
import { createStore } from '../js/core/store.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const H = 36e5;
const PATH = eclipsePath(Date.parse('2027-08-02T10:07:00Z'));

test('ribbonPlan: the eclipse in focus, else one in progress; loaded, pending and missed requests hold', () => {
    const none = { path: null, pendingMs: NaN, missMs: NaN };
    const t = Date.parse('2027-08-02T10:00:00Z');
    assert.deepEqual(ribbonPlan(none, null, t, false), { action: 'keep', atMs: NaN }, 'nothing to show, nothing shown');
    assert.deepEqual(ribbonPlan(none, null, t, true), { action: 'load', atMs: t }, 'in progress: load near now');
    assert.deepEqual(ribbonPlan(none, { peakMs: PATH.peakMs }, t + 20 * H, false), { action: 'load', atMs: PATH.peakMs }, 'focus wins');
    const shown = { path: { peakMs: PATH.peakMs }, pendingMs: NaN, missMs: NaN };
    assert.equal(ribbonPlan(shown, null, t, true).action, 'keep', 'already shown');
    assert.equal(ribbonPlan(shown, { peakMs: PATH.peakMs + 2 * H }, t, false).action, 'keep', 'a local maximum of the same eclipse');
    assert.equal(ribbonPlan(shown, null, t + 5 * H, false).action, 'clear', 'over: clear');
    assert.equal(ribbonPlan(shown, { peakMs: PATH.peakMs + 180 * 24 * H }, t, false).action, 'load', 'another eclipse');
    assert.equal(ribbonPlan({ ...none, pendingMs: t - H }, null, t, true).action, 'keep', 'request in flight');
    assert.equal(ribbonPlan({ ...none, pendingMs: t }, null, t, false).action, 'clear', 'in flight but no longer wanted');
    assert.equal(ribbonPlan({ ...none, missMs: t - 2 * H }, null, t, true).action, 'keep', 'a partial eclipse: no path, no retry');
    assert.equal(ribbonPlan({ ...none, missMs: t - 20 * H }, null, t, true).action, 'load', 'a miss far away does not block');
});

test('chaseLegs: start → greatest eased out, greatest → end eased in, 40 s at one mean rate', () => {
    const legs = chaseLegs(PATH);
    assert.equal(legs.length, 2);
    assert.deepEqual(legs.map((l) => [l.fromMs, l.toMs, l.loop, l.ease]),
        [[PATH.startMs, PATH.peakMs, 'once', 'out'], [PATH.peakMs, PATH.endMs, 'once', 'in']]);
    near(legs[0].durationS + legs[1].durationS, CHASE_DURATION_S, 1e-9, 'total wall time');
    near((legs[0].toMs - legs[0].fromMs) / legs[0].durationS, (legs[1].toMs - legs[1].fromMs) / legs[1].durationS, 1e-6, 'same mean rate');
    // About 3 h of shadow in 40 s: ≈ 270× real time.
    const rate = (PATH.endMs - PATH.startMs) / 1000 / CHASE_DURATION_S;
    assert.ok(rate > 200 && rate < 350, `rate ${rate.toFixed(0)}×`);
    assert.equal(chaseLegs({ startMs: 0, endMs: 1e6, peakMs: 0 }).length, 1, 'greatest at an end: one leg');
    assert.equal(chaseLegs({ startMs: 0, endMs: 1e6, peakMs: 0 })[0].ease, 'out');
    assert.deepEqual(chaseLegs(null), []);
});

test('chaseTarget: the centre line at the snapshot instant, false outside the path', () => {
    const f = chaseTarget(PATH);
    const pos = new Float64Array(3), fwd = new Float64Array(3), ref = new Float64Array(3);
    assert.equal(f({ tMs: PATH.peakMs }, pos, fwd), true);
    pathFrameLocal(PATH, PATH.peakMs, ref);
    near(pos[0] * ref[0] + pos[1] * ref[1] + pos[2] * ref[2], 1, 1e-12, 'same point');
    assert.equal(f({ tMs: PATH.endMs + 1 }, pos, fwd), false);
    assert.equal(f(null, pos, fwd), false);
});

/** The controller on the real clock and store, with a stand-in rig and ribbon. */
function harness({ reduced = false, path = PATH } = {}) {
    let wall = 0;
    const clock = createClock({ now: () => Date.parse('2026-11-04T00:00:00Z'), tMs: Date.parse('2027-08-02T10:01:00Z'), playing: false });
    const store = createStore();
    store.set({ view: { ...store.get().view, mode: 'sky' } }, 'test');
    const timers = [];
    const log = [];
    const rig = {
        following: false,
        followArgs: null,
        follow(fn, opts) {
            this.following = true;
            this.followArgs = { fn, opts };
            log.push('follow');
            return new Promise((resolve) => { this.end = (v) => { this.following = false; resolve(v); }; });
        },
        stopFollow() { log.push('stopFollow'); this.end?.(true); },
        flyToLatLon(lat, lon, o) { log.push(['fly', lat, lon, o?.distance, o?.animate]); return Promise.resolve(true); },
    };
    const ribbon = { mode: 'time', setReveal(m) { this.mode = m; } };
    const toasts = [];
    const chase = createEclipseChase({
        store, clock, getRig: () => rig, getRibbon: () => ribbon,
        eclipsePath: async () => path, reducedMotion: () => reduced,
        toast: (m) => toasts.push(m),
        setTimeout: (fn, ms) => { timers.push({ fn, at: wall + ms }); return timers.length; },
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    });
    /** Runs the clock for `ms` of wall time in 16 ms frames, firing due timers. */
    const run = (ms) => {
        for (let e = 0; e < ms; e += 16) {
            wall += 16;
            clock.tick(wall);
            for (const tm of timers) if (tm.fn && tm.at <= wall) { const fn = tm.fn; tm.fn = null; fn(); }
        }
    };
    const arrive = async () => { rig.followArgs.opts.onArrive(); await Promise.resolve(); await Promise.resolve(); };
    return { clock, store, rig, ribbon, chase, run, arrive, log, toasts };
}

test('chase: focus on the globe, wait for the camera, two eased legs with a hold, then the overview', async () => {
    const h = harness();
    assert.equal(await h.chase.start(PATH.peakMs), true);
    const st = h.store.get();
    assert.equal(st.view.mode, 'orbit', 'on the globe');
    assert.equal(st.ui.eclipse.peakMs, PATH.peakMs, 'the eclipse in focus');
    assert.equal(st.ui.eclipse.kind, 'total');
    assert.equal(h.clock.tMs, PATH.startMs, 'parked at the sunrise end');
    assert.equal(h.clock.playing, false, 'until the camera arrives');
    assert.equal(h.ribbon.mode, 'chase');
    assert.equal(h.chase.active, true);
    assert.deepEqual(h.rig.followArgs.opts.altitude, CHASE_POSE.other.altitude);
    h.run(500);
    assert.equal(h.clock.tMs, PATH.startMs, 'still parked');
    await h.arrive();
    assert.equal(h.clock.playing, true);
    assert.equal(h.clock.range.ease, 'out');
    h.run(1000 * (h.clock.range.durationS + 0.1));
    assert.equal(h.clock.tMs, PATH.peakMs, 'paused at greatest eclipse');
    assert.equal(h.clock.playing, false);
    h.run(CHASE_HOLD_MS - 200);
    assert.equal(h.clock.tMs, PATH.peakMs, 'holding');
    h.run(400);
    assert.equal(h.clock.playing, true, 'second leg');
    assert.equal(h.clock.range.ease, 'in');
    h.run(1000 * (h.clock.range.durationS + 0.1));
    assert.equal(h.clock.tMs, PATH.endMs, 'ends at the sunset end');
    assert.equal(h.chase.active, false);
    assert.equal(h.ribbon.mode, 'time', 'the whole path is in the past now');
    assert.ok(h.log.includes('stopFollow'));
    const fly = h.log.find((x) => Array.isArray(x) && x[0] === 'fly');
    assert.deepEqual(fly.slice(1, 4), [PATH.greatest.latDeg, PATH.greatest.lonDeg, 2.4], 'pulls back over greatest eclipse');
});

test('chase: the user taking the clock ends it where it is; camera input alone does not', async () => {
    const h = harness();
    await h.chase.start(PATH.peakMs);
    await h.arrive();
    h.run(3000);
    // Camera input: the rig's follow is cancelled (resolves false); the time-lapse carries on.
    h.rig.end(false);
    await Promise.resolve();
    h.run(1000);
    assert.equal(h.chase.active, true);
    assert.equal(h.clock.playing, true);
    // A rate change is the user's: the chase ends, the clock is theirs.
    const t = h.clock.tMs;
    h.clock.setRate(60);
    assert.equal(h.chase.active, false);
    assert.equal(h.ribbon.mode, 'time');
    h.run(1000);
    assert.ok(h.clock.tMs > t, 'their clock runs on');
    assert.ok(!h.log.some((x) => Array.isArray(x) && x[0] === 'fly'), 'no overview after a takeover');
});

test('chase: a jump during the approach ends it before any leg starts', async () => {
    const h = harness();
    await h.chase.start(PATH.peakMs);
    h.clock.setTime(Date.parse('2027-08-02T12:00:00Z'));
    assert.equal(h.chase.active, false);
    assert.equal(h.log.at(-1), 'stopFollow');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.clock.range, null, 'the late arrival starts nothing');
});

test('chase: reduced motion sets a static frame at greatest eclipse with the whole path drawn', async () => {
    const h = harness({ reduced: true });
    assert.equal(await h.chase.start({ tMs: PATH.peakMs, eclipseKind: 'total', id: 'e1' }), true);
    assert.equal(h.chase.active, false);
    assert.equal(h.clock.tMs, PATH.peakMs);
    assert.equal(h.clock.playing, false);
    assert.equal(h.ribbon.mode, 'all');
    assert.equal(h.store.get().ui.eclipse.eventId, 'e1');
    assert.deepEqual(h.log, [['fly', PATH.greatest.latDeg, PATH.greatest.lonDeg, 2.4, false]]);
});

test('chase: no path (a partial eclipse) toasts and does nothing', async () => {
    const h = harness({ path: null });
    assert.equal(await h.chase.start(Date.parse('2027-08-02T10:00:00Z')), false);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.store.get().ui.eclipse, null);
    assert.equal(h.chase.active, false);
});
