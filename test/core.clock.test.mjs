// Tests for js/core/clock.js — every test drives the clock with an injected now() and explicit
// wall timestamps, so nothing depends on real time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createClock, RATES, STEP, MIN_MS, MAX_MS, MAX_RATE, snapRate, nextRate, sanitizeRate, logEase, scrubSpanMs,
} from '../js/core/clock.js';

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const DAY = 864e5;
const YEAR = 365.25 * DAY;

/** Controllable epoch clock. */
function fakeNow(start = T0) {
    let t = start;
    const f = () => t;
    f.set = (v) => { t = v; };
    f.add = (d) => { t += d; };
    return f;
}

/** Wall-time driver: advances in frames of `frameMs`, ticking the clock each frame. */
function driver(clock, frameMs = 16) {
    let wall = 1000;
    clock.tick(wall);
    return {
        get wall() { return wall; },
        run(ms) {
            const end = wall + ms;
            while (wall < end) {
                wall = Math.min(end, wall + frameMs);
                clock.tick(wall);
            }
            return clock.tMs;
        },
    };
}

function record(clock) {
    const types = [];
    const events = [];
    clock.onChange((e) => { types.push(e.type); events.push(e); });
    return { types, events, clear() { types.length = 0; events.length = 0; } };
}

test('constants match the spec', () => {
    assert.equal(RATES.length, 20);
    assert.deepEqual([...RATES].sort((a, b) => a - b), [...RATES], 'ladder is sorted ascending');
    assert.ok(!RATES.includes(0));
    for (const r of RATES) assert.ok(RATES.includes(-r), `ladder is symmetric (${r})`);
    assert.equal(RATES[0], -31557600);
    assert.equal(RATES.at(-1), 31557600);
    assert.equal(STEP.minute, 6e4);
    assert.equal(STEP.hour, 36e5);
    assert.equal(STEP.day, 864e5);
    assert.equal(STEP.siderealDay, 86164090.5);
    assert.equal(STEP.month, 29.530589 * 864e5);
    assert.equal(STEP.year, 31557600e3);
    assert.equal(new Date(MIN_MS).toISOString(), '1000-01-01T00:00:00.000Z');
    assert.equal(new Date(MAX_MS).toISOString(), '3000-01-01T00:00:00.000Z');
    assert.equal(MAX_RATE, 31557600);
    assert.ok(Object.isFrozen(RATES) && Object.isFrozen(STEP));
});

test('starts Live at now() when no time is given', () => {
    const now = fakeNow();
    const c = createClock({ now });
    assert.equal(c.live, true);
    assert.equal(c.playing, true);
    assert.equal(c.rate, 1);
    assert.equal(c.tMs, T0);
    assert.equal(c.range, null);
    assert.equal(c.isAnimating(), false, 'live 1x does not need continuous redraw');
});

test('Live tracks the injected wall clock, independent of frame timestamps', () => {
    const now = fakeNow();
    const c = createClock({ now });
    c.tick(0);
    now.add(1234);
    assert.equal(c.tick(16), T0 + 1234);
    now.add(60e3);
    assert.equal(c.tick(16), T0 + 1234 + 60e3, 'a repeated frame timestamp still follows now()');
    now.add(5 * 3600e3);
    assert.equal(c.tick(50000), T0 + 1234 + 60e3 + 5 * 3600e3, 'no wall-delta cap applies in Live');
});

test('a clock started with a time or a rate is not Live', () => {
    const now = fakeNow();
    assert.equal(createClock({ now, tMs: T0 }).live, false);
    assert.equal(createClock({ now, rate: 3600 }).live, false);
    assert.equal(createClock({ now, playing: false }).live, false);
    const c = createClock({ now, rate: 0 });
    assert.equal(c.rate, 1, 'invalid initial rate falls back to 1');
    assert.equal(c.live, true);
});

test('playing off-Live advances by rate × wall delta, with the delta capped', () => {
    const now = fakeNow();
    const c = createClock({ now, tMs: T0, rate: 3600 });
    c.tick(0);
    assert.equal(c.tick(16), T0 + 16 * 3600);
    assert.equal(c.tick(16), T0 + 16 * 3600, 'zero delta, no movement');
    assert.equal(c.tick(10), T0 + 16 * 3600, 'negative delta is ignored');
    assert.equal(c.tick(10 + 10000), T0 + 16 * 3600 + 250 * 3600, 'a 10 s hitch counts as 250 ms');
    now.add(99999);
    assert.equal(c.tick(10 + 10016), T0 + 16 * 3600 + 266 * 3600, 'now() is irrelevant off-Live');

    const custom = createClock({ now, tMs: T0, rate: 10, maxDtMs: 1000 });
    custom.tick(0);
    assert.equal(custom.tick(5000), T0 + 10 * 1000, 'maxDtMs is configurable');
});

test('paused clocks do not move; play() does not count the paused interval', () => {
    const c = createClock({ now: fakeNow(), tMs: T0, rate: 60, playing: false });
    c.tick(0);
    assert.equal(c.tick(1000), T0);
    c.play();
    assert.equal(c.tick(5000), T0, 'the first tick after play() only re-anchors');
    assert.equal(c.tick(5100), T0 + 100 * 60);
});

test('faster/slower walk the signed ladder and cross ±1', () => {
    const c = createClock({ now: fakeNow() });
    const seen = [];
    for (let i = 0; i < 12; i++) { c.faster(); seen.push(c.rate); }
    assert.deepEqual(seen, [10, 60, 600, 3600, 21600, 86400, 604800, 2592000, 31557600, 31557600, 31557600, 31557600]);
    c.setRate(1);
    c.slower();
    assert.equal(c.rate, -1, 'slower from +1 crosses to -1');
    c.slower();
    assert.equal(c.rate, -10);
    c.faster();
    c.faster();
    assert.equal(c.rate, 1, 'faster from -1 crosses to +1');
    c.setRate(-31557600);
    c.slower();
    assert.equal(c.rate, -31557600, 'saturates at the bottom');
    c.setRate(5);
    c.faster();
    assert.equal(c.rate, 10, 'off-ladder rates move to the next ladder value up');
    c.setRate(5);
    c.slower();
    assert.equal(c.rate, 1, '... or down');
});

test('nextRate / snapRate / sanitizeRate helpers', () => {
    assert.equal(nextRate(1, +1), 10);
    assert.equal(nextRate(1, -1), -1);
    assert.equal(nextRate(-1, +1), 1);
    assert.equal(nextRate(31557600, +1), 31557600);
    assert.equal(nextRate(-31557600, -1), -31557600);
    assert.equal(nextRate(1e9, -1), 31557600);
    assert.equal(snapRate(3600), 3600);
    assert.equal(snapRate(5000), 3600);
    assert.equal(snapRate(3), 1);
    assert.equal(snapRate(4), 10, 'nearest in log space');
    assert.equal(snapRate(-7), -10);
    assert.equal(snapRate(1e12), 31557600);
    assert.equal(snapRate(0), null);
    assert.equal(snapRate(Number.NaN), null);
    assert.equal(snapRate('abc'), null);
    assert.equal(sanitizeRate(1e12), MAX_RATE);
    assert.equal(sanitizeRate(-1e12), -MAX_RATE);
    assert.equal(sanitizeRate(0), null);
    assert.equal(sanitizeRate(Infinity), null);
});

test('rate changes leave Live; setRate(1) while Live is a no-op; bad rates are ignored', () => {
    const now = fakeNow();
    const c = createClock({ now });
    const ev = record(c);
    c.setRate(1);
    assert.equal(c.live, true);
    assert.deepEqual(ev.types, []);
    c.setRate(0);
    c.setRate(Number.NaN);
    c.setRate('fast');
    assert.equal(c.live, true);
    assert.equal(c.rate, 1);
    c.setRate(600);
    assert.equal(c.live, false);
    assert.equal(c.rate, 600);
    assert.deepEqual(ev.types, ['rate']);
    assert.equal(ev.events[0].live, false);
    c.setRate(1);
    assert.equal(c.live, false, 'back to 1x is not Live: the clock is ahead of now');
    c.setRate(1e15);
    assert.equal(c.rate, MAX_RATE, 'clamped to 1 yr/s');
});

test('reverse() negates the rate and leaves Live', () => {
    const c = createClock({ now: fakeNow() });
    const ev = record(c);
    c.reverse();
    assert.equal(c.rate, -1);
    assert.equal(c.live, false);
    c.setRate(3600);
    c.reverse();
    assert.equal(c.rate, -3600);
    assert.deepEqual(ev.types, ['rate', 'rate', 'rate']);
    const d = driver(c);
    const t = c.tMs;
    d.run(160);
    assert.equal(c.tMs, t - 160 * 3600, 'time runs backwards');
});

test('step() moves by exact amounts for every kind, leaves Live and emits jump', () => {
    const now = fakeNow();
    const c = createClock({ now });
    const ev = record(c);
    let expect = T0;
    for (const kind of Object.keys(STEP)) {
        c.step(kind);
        expect += STEP[kind];
        assert.equal(c.tMs, expect, kind);
    }
    assert.equal(c.live, false);
    assert.equal(c.playing, true, 'stepping does not pause');
    c.step('day', -3);
    expect -= 3 * DAY;
    assert.equal(c.tMs, expect);
    c.step('siderealDay', 2);
    expect += 2 * 86164090.5;
    assert.equal(c.tMs, expect);
    c.step(1234, 2);
    expect += 2468;
    assert.equal(c.tMs, expect, 'numeric step in ms');
    const before = ev.types.length;
    c.step('fortnight');
    c.step('toString');
    c.step('hour', 0);
    c.step('hour', Number.NaN);
    assert.equal(c.tMs, expect, 'unknown kinds and zero/NaN counts do nothing');
    assert.equal(ev.types.length, before);
    assert.ok(ev.types.every((t) => t === 'jump'));
});

test('setTime jumps, leaves Live and keeps the playing state', () => {
    const now = fakeNow();
    const c = createClock({ now });
    const ev = record(c);
    const target = Date.UTC(2027, 7, 2, 10, 7);
    c.setTime(target);
    assert.equal(c.tMs, target);
    assert.equal(c.live, false);
    assert.equal(c.playing, true);
    assert.deepEqual(ev.types, ['jump']);
    c.setTime(Number.NaN);
    c.setTime('soon');
    assert.equal(c.tMs, target);
});

test('setTime outside 1000–3000 clamps, pauses and emits clamp', () => {
    const c = createClock({ now: fakeNow() });
    const ev = record(c);
    c.setTime(MAX_MS + 5 * YEAR);
    assert.equal(c.tMs, MAX_MS);
    assert.equal(c.playing, false);
    assert.deepEqual(ev.types, ['jump', 'pause', 'clamp']);
    ev.clear();
    c.setTime(MIN_MS - 1);
    assert.equal(c.tMs, MIN_MS);
    assert.deepEqual(ev.types, ['jump', 'clamp'], 'already paused: no second pause event');
    ev.clear();
    c.step('year', -1);
    assert.equal(c.tMs, MIN_MS);
    assert.deepEqual(ev.types, ['jump', 'clamp'], 'steps clamp too');
});

test('running into a bound while playing clamps, pauses and emits clamp once', () => {
    const c = createClock({ now: fakeNow(), tMs: MAX_MS - 10 * DAY, rate: 31557600 });
    const ev = record(c);
    const d = driver(c);
    d.run(2000);
    assert.equal(c.tMs, MAX_MS);
    assert.equal(c.playing, false);
    assert.deepEqual(ev.types, ['pause', 'clamp']);
    ev.clear();
    c.play();
    assert.equal(c.playing, false, 'cannot play further out of range');
    assert.deepEqual(ev.types, ['clamp']);
    ev.clear();
    c.reverse();
    c.play();
    assert.equal(c.playing, true, 'playing back into range is fine');
    d.run(100);
    assert.ok(c.tMs < MAX_MS);
    assert.deepEqual(ev.types, ['rate', 'play']);
});

test('an out-of-range start time is clamped and paused', () => {
    const early = createClock({ now: fakeNow(), tMs: Date.UTC(500, 0, 1) });
    assert.equal(early.tMs, MIN_MS);
    assert.equal(early.playing, false);
    const late = createClock({ now: fakeNow(Date.UTC(3100, 0, 1)) });
    assert.equal(late.tMs, MAX_MS);
    assert.equal(late.live, false);
    assert.equal(late.playing, false);
});

test('goLive() restores rate 1, playing and sync with now()', () => {
    const now = fakeNow();
    const c = createClock({ now, tMs: T0 - 50 * YEAR, rate: -86400, playing: false });
    const ev = record(c);
    c.goLive();
    assert.equal(c.live, true);
    assert.equal(c.rate, 1);
    assert.equal(c.playing, true);
    assert.equal(c.tMs, T0);
    assert.deepEqual(ev.types, ['rate', 'jump', 'play', 'live']);
    ev.clear();
    c.goLive();
    assert.deepEqual(ev.types, [], 'already Live: nothing to report');
    now.add(5000);
    assert.equal(c.tick(123), T0 + 5000);
});

test('goLive() with a device clock outside 1000–3000 clamps instead', () => {
    const now = fakeNow(Date.UTC(3500, 0, 1));
    const c = createClock({ now, tMs: T0 });
    const ev = record(c);
    c.goLive();
    assert.equal(c.tMs, MAX_MS);
    assert.equal(c.live, false);
    assert.equal(c.playing, false);
    assert.ok(ev.types.includes('clamp'));
});

test('Live with now() drifting out of range clamps on tick', () => {
    const now = fakeNow(MAX_MS - 1000);
    const c = createClock({ now });
    assert.equal(c.live, true);
    const ev = record(c);
    now.add(5000);
    c.tick(0);
    assert.equal(c.tMs, MAX_MS);
    assert.equal(c.live, false);
    assert.deepEqual(ev.types, ['pause', 'clamp']);
});

test('setTime with animateMs sweeps in log-time to the exact target', () => {
    const now = fakeNow();
    const c = createClock({ now, playing: false, tMs: T0 });
    const target = T0 + 100 * YEAR;
    c.setTime(target, { animateMs: 1000 });
    assert.equal(c.tweening, true);
    assert.equal(c.isAnimating(), true, 'animating while tweening, even when paused');
    const samples = [];
    c.tick(0);
    for (let w = 10; w <= 1000; w += 10) samples.push([w, c.tick(w)]);
    for (let i = 1; i < samples.length; i++) assert.ok(samples[i][1] >= samples[i - 1][1], 'monotonic');
    for (const [, t] of samples) assert.ok(t >= T0 && t <= target, 'never overshoots');
    const at = (w) => samples.find(([x]) => x === w)[1];
    assert.ok(Math.abs(at(500) - (T0 + (target - T0) / 2)) < 1, 'midpoint at half time');
    assert.ok(at(250) - T0 < DAY, `a quarter of the way in, a 100-year jump has moved less than a day (${(at(250) - T0) / 36e5} h)`);
    assert.ok(target - at(750) < DAY, 'three quarters in, it is within a day of the target');
    assert.ok(at(100) - T0 < 60e3 * 5, 'starts gently');
    assert.equal(at(1000), target, 'lands exactly');
    assert.equal(c.tweening, false);
    assert.equal(c.isAnimating(), false);
    assert.equal(c.playing, false, 'a tween does not start playback');
});

test('logEase: endpoints, symmetry, small jumps are nearly linear, direction', () => {
    assert.equal(logEase(0, 1e12, 0), 0);
    assert.equal(logEase(0, 1e12, 1), 1e12);
    assert.ok(Math.abs(logEase(0, 1e12, 0.5) - 5e11) < 1e-3);
    assert.equal(logEase(5, 5, 0.3), 5);
    const a = logEase(0, 1e12, 0.3), b = logEase(0, 1e12, 0.7);
    assert.ok(Math.abs(a + b - 1e12) < 1e-3, 'symmetric about the midpoint');
    const small = logEase(0, 10e3, 0.25);
    const smooth = 0.25 * 0.25 * (3 - 0.5) * 10e3;
    assert.ok(Math.abs(small - smooth) / 10e3 < 0.02, 'sub-minute jumps are just smoothstep');
    assert.ok(logEase(1e12, 0, 0.25) > 5e11, 'backwards jumps ease the same way');
});

test('steps during a tween accumulate onto its destination', () => {
    const c = createClock({ now: fakeNow(), tMs: T0, playing: false });
    c.setTime(T0 + 10 * DAY, { animateMs: 500 });
    c.tick(0);
    c.tick(100);
    c.step('day', 1, { animateMs: 500 });
    assert.equal(c.tweening, true);
    for (let w = 200; w <= 1200; w += 100) c.tick(w);
    assert.equal(c.tweening, false);
    assert.equal(c.tMs, T0 + 11 * DAY);
});

test('goLive with animateMs chases a moving now() and ends Live', () => {
    const now = fakeNow();
    const c = createClock({ now, tMs: T0 - 2 * YEAR, playing: false });
    c.goLive({ animateMs: 800 });
    assert.equal(c.live, true, 'the Live indicator switches at once');
    assert.equal(c.isAnimating(), true);
    c.tick(0);
    for (let w = 16; w <= 800; w += 16) {
        now.add(16);
        c.tick(w);
    }
    now.add(16);
    c.tick(816);
    assert.equal(c.tweening, false);
    assert.equal(c.tMs, now());
    now.add(1000);
    assert.equal(c.tick(832), now(), 'tracking now() afterwards');
    assert.equal(c.isAnimating(), false);
});

test('pausing during a goLive tween keeps the destination but leaves Live', () => {
    const now = fakeNow();
    const c = createClock({ now, tMs: T0 - YEAR });
    c.goLive({ animateMs: 400 });
    c.tick(0);
    c.tick(100);
    c.pause();
    assert.equal(c.live, false);
    const dest = now();
    now.add(60e3);
    c.tick(300);
    c.tick(500);
    assert.equal(c.tweening, false);
    assert.equal(c.tMs, dest, 'the tween ends where now() was when paused');
    assert.equal(c.playing, false);
});

test('range loop: progress, wrap, effective rate, seek', () => {
    const now = fakeNow();
    const c = createClock({ now, rate: 3600 });
    const ev = record(c);
    const from = Date.UTC(2026, 0, 1), to = Date.UTC(2026, 0, 11);
    assert.equal(c.setRange({ fromMs: from, toMs: to, durationS: 1, loop: 'loop' }), true);
    assert.deepEqual(ev.types, ['range', 'rate', 'jump']);
    assert.deepEqual(c.range, { fromMs: from, toMs: to, durationS: 1, loop: 'loop' });
    assert.equal(c.tMs, from);
    assert.equal(c.progress(), 0);
    assert.equal(c.rate, 10 * 86400, 'effective rate: 10 days per second');
    assert.equal(c.baseRate, 3600);
    assert.equal(c.isAnimating(), true);
    const d = driver(c, 10);
    d.run(500);
    assert.ok(Math.abs(c.progress() - 0.5) < 1e-9);
    assert.ok(Math.abs(c.tMs - (from + 5 * DAY)) < 1);
    d.run(600);
    assert.ok(Math.abs(c.progress() - 0.1) < 1e-9, 'wrapped past the end');
    assert.ok(c.tMs >= from && c.tMs <= to);
    ev.clear();
    assert.equal(c.seek(0.25), true);
    assert.equal(c.tMs, from + 2.5 * DAY);
    assert.deepEqual(ev.types, ['jump']);
    assert.equal(c.seek(7), true);
    assert.equal(c.progress(), 1, 'seek clamps to [0, 1]');
    assert.equal(c.seek('x'), false);
});

test('range pingpong bounces between the endpoints and flips the effective rate', () => {
    const c = createClock({ now: fakeNow() });
    const ev = record(c);
    const from = T0, to = T0 + 30 * DAY;
    c.setRange({ fromMs: from, toMs: to, durationS: 2, loop: 'pingpong' });
    ev.clear();
    const d = driver(c, 20);
    let maxP = 0;
    for (let i = 0; i < 150; i++) {
        d.run(20);
        maxP = Math.max(maxP, c.progress());
        assert.ok(c.tMs >= from && c.tMs <= to, 'stays inside the range');
    }
    assert.ok(maxP > 0.99, 'reached the end');
    assert.ok(c.progress() < 0.6, `came back (${c.progress()})`);
    assert.ok(c.rate < 0, 'now playing backwards');
    assert.ok(ev.types.includes('rate'));
    assert.equal(c.playing, true);
});

test('range once pauses at the end; play() replays from the start', () => {
    const c = createClock({ now: fakeNow() });
    const ev = record(c);
    const from = T0, to = T0 + DAY;
    c.setRange({ fromMs: from, toMs: to, durationS: 0.5, loop: 'once' });
    const d = driver(c, 16);
    d.run(1000);
    assert.equal(c.tMs, to);
    assert.equal(c.progress(), 1);
    assert.equal(c.playing, false);
    assert.equal(ev.types.at(-1), 'pause');
    ev.clear();
    c.play();
    assert.equal(c.tMs, from);
    assert.equal(c.progress(), 0);
    assert.deepEqual(ev.types, ['jump', 'play']);
    c.reverse();
    c.seek(0);
    c.pause();
    c.play();
    assert.equal(c.progress(), 1, 'reversed once-range replays from its end');
});

test('range: reverse flips direction, rate controls end the range, setRange(null) restores the ladder rate', () => {
    const c = createClock({ now: fakeNow(), rate: 600 });
    c.setRange({ fromMs: T0, toMs: T0 + 10 * DAY, durationS: 10 });
    assert.equal(c.range.loop, 'loop', 'default loop mode');
    c.reverse();
    assert.equal(c.rate, -86400);
    assert.notEqual(c.range, null, 'reverse keeps the timelapse');
    const ev = record(c);
    c.faster();
    assert.equal(c.range, null, 'faster takes over from the timelapse');
    assert.equal(c.rate, -21600, 'one ladder step up from the effective −1 d/s');
    assert.deepEqual(ev.types, ['range', 'rate']);

    c.setRange({ fromMs: T0, toMs: T0 + 10 * DAY, durationS: 10 });
    assert.equal(c.baseRate, -21600);
    ev.clear();
    c.setRange(null);
    assert.equal(c.range, null);
    assert.equal(c.rate, -21600, 'the ladder rate in force before the range returns');
    assert.deepEqual(ev.types, ['range', 'rate']);
    assert.equal(c.progress(), null);
    assert.equal(c.seek(0.5), false, 'seek needs a range');
});

test('setTime / step / goLive end a running range', () => {
    for (const act of [(c) => c.setTime(T0), (c) => c.step('hour'), (c) => c.goLive(), (c) => c.setRate(10)]) {
        const c = createClock({ now: fakeNow() });
        c.setRange({ fromMs: T0, toMs: T0 + DAY, durationS: 5 });
        const ev = record(c);
        act(c);
        assert.equal(c.range, null);
        assert.equal(ev.types[0], 'range');
    }
});

test('invalid ranges are rejected without side effects; endpoints are clamped', () => {
    const c = createClock({ now: fakeNow() });
    const ev = record(c);
    assert.equal(c.setRange({ fromMs: T0, toMs: T0 + 500, durationS: 5 }), false, 'shorter than a second');
    assert.equal(c.setRange({ fromMs: Number.NaN, toMs: T0 }), false);
    assert.equal(c.setRange({ fromMs: T0, toMs: T0 + DAY, durationS: -1 }), false);
    assert.equal(c.setRange({ fromMs: T0, toMs: T0 + DAY, durationS: 'x' }), false);
    assert.equal(c.setRange('loop'), false);
    assert.deepEqual(ev.types, []);
    assert.equal(c.live, true);
    assert.equal(c.setRange({ fromMs: Date.UTC(900, 0, 1), toMs: Date.UTC(1200, 0, 1), durationS: 1e9, loop: 'weird' }), true);
    assert.equal(c.range.fromMs, MIN_MS);
    assert.equal(c.range.durationS, 86400, 'duration capped');
    assert.equal(c.range.loop, 'loop');
    assert.equal(c.setRange({ fromMs: T0 + DAY, toMs: T0, durationS: 1 }), true, 'backwards ranges play backwards');
    assert.ok(c.rate < 0);
});

test('isAnimating matrix', () => {
    const now = fakeNow();
    const c = createClock({ now });
    assert.equal(c.isAnimating(), false, 'live 1x');
    c.setRate(10);
    assert.equal(c.isAnimating(), true, 'playing fast');
    c.setRate(-3600);
    assert.equal(c.isAnimating(), true, 'playing backwards');
    c.setRate(1);
    assert.equal(c.isAnimating(), false, 'off-Live 1x: 2 Hz redraw is enough');
    c.setRate(600);
    c.pause();
    assert.equal(c.isAnimating(), false, 'paused');
    c.setTime(T0 + DAY, { animateMs: 100 });
    assert.equal(c.isAnimating(), true, 'tweening');
});

test('toggle(), play()/pause() idempotence and events', () => {
    const c = createClock({ now: fakeNow() });
    const ev = record(c);
    c.play();
    assert.deepEqual(ev.types, []);
    c.toggle();
    assert.equal(c.playing, false);
    assert.equal(c.live, false, 'pausing leaves Live');
    c.pause();
    c.toggle();
    assert.equal(c.playing, true);
    assert.equal(c.live, false, 'resuming does not re-enter Live');
    assert.deepEqual(ev.types, ['pause', 'play']);
});

test('onChange: unsubscribe, error isolation, event payload', () => {
    const errors = [];
    const c = createClock({ now: fakeNow(), onError: (e) => errors.push(e) });
    const got = [];
    const off = c.onChange((e) => got.push(e));
    c.onChange(() => { throw new Error('boom'); });
    const late = [];
    c.onChange((e) => late.push(e.type));
    c.setRate(60);
    assert.equal(errors.length, 1);
    assert.deepEqual(late, ['rate'], 'a throwing listener does not starve later ones');
    assert.deepEqual(got[0], { type: 'rate', tMs: c.tMs, rate: 60, playing: true, live: false });
    assert.ok(Object.isFrozen(got[0]));
    off();
    off();
    c.setRate(600);
    assert.equal(got.length, 1);
    assert.equal(typeof c.onChange(null), 'function');
});

test('a misbehaving now() falls back to Date.now() instead of throwing', () => {
    const c = createClock({ now: () => { throw new Error('nope'); } });
    assert.ok(Math.abs(c.tMs - Date.now()) < 5000);
    const d = createClock({ now: () => Number.NaN });
    assert.ok(Number.isFinite(d.tick(0)));
    const e = createClock({ now: 'not a function' });
    assert.ok(Number.isFinite(e.tMs));
});

test('tick() with no argument uses now() as the wall base', () => {
    const now = fakeNow();
    const c = createClock({ now, tMs: T0, rate: 10 });
    c.tick();
    now.add(100);
    assert.equal(c.tick(), T0 + 1000);
});

test('scrubSpanMs windows follow the spec', () => {
    const H = 36e5;
    assert.equal(scrubSpanMs(1), 12 * H);
    assert.equal(scrubSpanMs(-600), 12 * H);
    assert.equal(scrubSpanMs(3600), 3 * DAY);
    assert.equal(scrubSpanMs(21600), 3 * DAY);
    assert.equal(scrubSpanMs(86400), 30 * DAY);
    assert.equal(scrubSpanMs(-604800), 30 * DAY);
    assert.equal(scrubSpanMs(2592000), 365.25 * DAY);
    assert.equal(scrubSpanMs(Number.NaN), 12 * H);
});
