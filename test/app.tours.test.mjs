// Guided tours (ROADMAP Phase 5, guided-tours): the catalogue and `#tour=` links, the URL writer's
// suspension, the pure step builders (js/app/tours.js) and the runner driven with the real store
// and clock, a stand-in for the actions and fast timers (text mode: no rig).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOURS, TOUR_IDS, isTourId, tourById } from '../js/core/tour-catalog.js';
import { parseHash, serializeHash, bindUrl } from '../js/core/url-state.js';
import { createStore, DEFAULT_STATE } from '../js/core/store.js';
import { createClock } from '../js/core/clock.js';
import { localSolarEclipseAt } from '../js/astro/events.js';
import {
    tonightSteps, yearSteps, eclipseSteps, ambientSteps, highestBright, seasonsOf, localMeanTime, minSec, wait,
    createTourRunner, ECLIPSE_2027_MS, ECLIPSE_2027_SITE,
} from '../js/app/tours.js';

const H = 36e5, DAY = 864e5;
const T0 = Date.parse('2026-11-04T09:00:00Z');
const tick = () => new Promise((r) => setTimeout(r, 0));

test('catalogue: ids, lookup, and #tour= links (read, never written)', () => {
    assert.deepEqual(TOUR_IDS, ['tonight', 'year', 'eclipse-2027', 'ambient']);
    assert.ok(TOURS.every((t) => t.title && t.blurb && Object.isFrozen(t)));
    assert.equal(isTourId('year'), true);
    assert.equal(isTourId('nope'), false);
    assert.equal(isTourId(undefined), false);
    assert.equal(tourById('ambient').approxS, null);
    assert.equal(tourById('x'), null);
    assert.equal(parseHash('#tour=Eclipse-2027').tour, 'eclipse-2027');
    assert.equal(parseHash('#loc=10,106&tour=tonight').tour, 'tonight');
    const bad = parseHash('#tour=moonwalk');
    assert.equal(bad.tour, undefined);
    assert.deepEqual(bad.invalid, ['tour']);
    assert.equal(parseHash('#tour=').invalid, undefined, 'empty: ignored');
    assert.ok(!serializeHash({ state: { ...DEFAULT_STATE, ui: { ...DEFAULT_STATE.ui, tour: { id: 'year' } } } }).includes('tour'));
});

test('bindUrl: nothing is written while suspended; the next write replaces the tour link', async () => {
    let suspended = true;
    const calls = [];
    const win = {
        history: { state: null, replaceState: (_s, _t, url) => calls.push(url) },
        location: { hash: '#tour=tonight', pathname: '/', search: '' },
        addEventListener() {}, removeEventListener() {},
    };
    const store = createStore();
    const clock = createClock({ now: () => T0, tMs: T0, playing: false });
    const unbind = bindUrl({ win, store, clock, minIntervalMs: 0, pollMs: 5, suspended: () => suspended });
    store.set({ selection: 'mars' });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(calls, [], 'suspended');
    suspended = false;
    await new Promise((r) => setTimeout(r, 40));
    unbind();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('sel=mars') && !calls[0].includes('tour='), calls[0]);
});

test('minSec, localMeanTime and seasonsOf', () => {
    assert.equal(minSec(385066), '6 min 25 s');
    assert.equal(minSec(42e3), '42 s');
    // Local mean 06:00 at 90° E is 00:00 UT; at 30° W it is 08:00 UT, a whole day apart day to day.
    assert.equal(localMeanTime(Date.parse('2027-03-20T15:00:00Z'), 6, 90), Date.parse('2027-03-20T00:00:00Z'));
    assert.equal(localMeanTime(Date.parse('2027-03-21T23:00:00Z'), 6, -30) - localMeanTime(Date.parse('2027-03-20T01:00:00Z'), 6, -30), DAY);
    const s = seasonsOf(Date.parse('2027-05-01T00:00:00Z'));
    assert.equal(new Date(s.marMs).toISOString().slice(0, 10), '2027-03-20');
    assert.equal(new Date(s.junMs).toISOString().slice(0, 10), '2027-06-21');
    assert.equal(new Date(s.decMs).toISOString().slice(0, 10), '2027-12-22');
    assert.ok(s.nextMarMs - s.marMs > 364 * DAY && s.nextMarMs - s.marMs < 366 * DAY);
});

/** A tonight() result: sunset 17:28 local, planets in a shuffled order, the Moon. */
function report({ planets = true, moon = 'good', sunset = true } = {}) {
    const r = (id, verdict, bestMs, alt = 40) => ({
        id, name: id[0].toUpperCase() + id.slice(1), verdict, bestMs, bestAltDeg: alt, bestAzDeg: 120, phaseFrac: 0.4,
        sentence: `${id}: ${verdict}`,
    });
    const reports = planets
        ? [r('mercury', 'not-visible', null), r('venus', 'twilight', T0 + 2 * H, 8), r('mars', 'excellent', T0 + 10 * H),
            r('jupiter', 'good', T0 + 9 * H), r('saturn', 'low', T0 + 5 * H, 12), r('uranus', 'excellent', T0 + 6 * H),
            r('neptune', 'excellent', T0 + 6 * H)]
        : [r('venus', 'daytime', T0 - 3 * H)];
    reports.push(r('moon', moon, moon === 'not-visible' ? null : T0 + 4 * H));
    return {
        nightStartMs: sunset ? T0 + H : null,
        twilight: sunset ? { sunsetMs: T0 + H, civilDuskMs: T0 + 1.4 * H, nauticalDuskMs: T0 + 1.8 * H, astroDuskMs: T0 + 2.2 * H } : {},
        reports,
    };
}
const tonightCtx = { place: 'Testville', fmt: () => '17:28', sunAt: () => ({ azDeg: 250, altDeg: -1 }), latDeg: 10 };

test('tonightSteps: sunset, twilight, naked-eye planets by time with telescope stops, then the Moon', () => {
    const steps = tonightSteps(report(), tonightCtx);
    assert.match(steps[0].caption, /^Tonight from Testville\. The Sun sets at 17:28 in the west/);
    assert.equal(steps[0].view, 'sky');
    assert.equal(steps[0].look.azDeg, 250);
    assert.equal(steps[1].time.range.toMs, T0 + 2.2 * H, 'twilight runs to astronomical dusk');
    const planetIds = steps.filter((s) => s.select && s.select !== 'moon' && !s.telescope).map((s) => s.select);
    assert.deepEqual(planetIds, ['venus', 'saturn', 'jupiter', 'mars'], 'time order; no Mercury (not visible), Uranus or Neptune');
    const jup = steps.findIndex((s) => s.select === 'jupiter');
    assert.equal(steps[jup].then.track, 'body');
    assert.equal(steps[jup].look.fovDeg, 40);
    assert.equal(steps[jup + 1].telescope, 'jupiter', 'a well-placed Jupiter gets the telescope');
    assert.ok(!steps.some((s) => s.telescope === 'saturn'), 'a low Saturn does not');
    const moon = steps.findIndex((s) => s.select === 'moon');
    assert.ok(moon > jup);
    assert.equal(steps[moon + 1].telescope, 'moon');
    assert.match(steps[moon + 1].caption, /40% lit/);
    assert.match(steps.at(-1).caption, /Clear skies/);
    for (const s of steps) assert.ok(typeof s.caption === 'string' && s.caption && s.holdMs > 0);
});

test('tonightSteps: no planets, no Moon, no sunset', () => {
    const steps = tonightSteps(report({ planets: false, moon: 'not-visible', sunset: false }), tonightCtx);
    assert.match(steps[0].caption, /does not set/);
    assert.ok(steps.some((s) => /No bright planets/.test(s.caption)));
    assert.ok(steps.some((s) => s.caption === 'moon: not-visible'), 'the Moon\'s sentence still told');
    assert.ok(!steps.some((s) => s.telescope));
    assert.ok(tonightSteps(null, tonightCtx).length >= 2, 'a missing report still makes a tour');
});

test('yearSteps: four contiguous dawn sweeps (equinox to equinox), then the noon sky', () => {
    const seasons = seasonsOf(Date.parse('2027-01-10T00:00:00Z'));
    const paris = yearSteps({ observer: { latDeg: 48.86, lonDeg: 2.35 }, place: 'Paris', seasons });
    const sweeps = paris.filter((s) => s.sweep).map((s) => s.sweep);
    assert.equal(sweeps.length, 5);
    for (let i = 0; i < 3; i++) {
        const end = sweeps[i].fromMs + (sweeps[i].count - 1) * DAY;
        assert.equal(sweeps[i + 1].fromMs, end, `sweep ${i + 1} starts where ${i} ended`);
    }
    // Local mean 06:00 at 2.35° E.
    assert.equal(((sweeps[0].fromMs % DAY) + DAY) % DAY, Math.round((6 - 2.35 / 15) * H));
    assert.ok(sweeps[4].count >= 365 && sweeps[4].count <= 367, 'the noon sweep covers the year');
    assert.equal(paris[0].layers.beams, false);
    assert.equal(paris[0].fly.latDeg, 10);
    const sky = paris.find((s) => s.view === 'sky');
    assert.equal(sky.select, 'sun');
    assert.equal(sky.look.azDeg, 180);
    assert.match(sky.caption, /65° high in June, sinks to 18° in December/);
    const sydney = yearSteps({ observer: { latDeg: -33.87, lonDeg: 151.2 }, place: 'Sydney', seasons });
    assert.equal(sydney.find((s) => s.view === 'sky').look.azDeg, 0, 'south of the equator: face north');
    assert.match(sydney.find((s) => s.view === 'sky').caption, /in December, sinks to 33° in June/);
    assert.match(yearSteps({ observer: { latDeg: 10, lonDeg: 0 }, place: 'X', seasons }).find((s) => s.view === 'sky').caption, /overhead twice/);
    assert.match(yearSteps({ observer: { latDeg: 78, lonDeg: 15 }, place: 'Y', seasons }).find((s) => s.view === 'sky').caption, /below the horizon in December/);
});

test('eclipseSteps: Luxor, C2 − 20 s, totality, the second diamond ring, then the chase', () => {
    const site = ECLIPSE_2027_SITE;
    const ev = localSolarEclipseAt(site, ECLIPSE_2027_MS, { tz: site.tz });
    const steps = eclipseSteps(ev, { site, sunAt: () => ({ azDeg: 190, altDeg: 82 }) });
    assert.equal(steps.length, 7);
    assert.equal(steps[0].observer, site);
    assert.equal(steps[0].eclipse.local, true);
    assert.match(steps[0].caption, /6 min 2\d s/);
    assert.equal(steps[1].event, ev);
    assert.equal(steps[1].untilMs, ev.c2Ms + 1500);
    assert.equal(steps[3].look.fovDeg, 100);
    assert.equal(steps[4].time.tMs, ev.c3Ms - 15e3);
    assert.equal(steps[4].look.fovDeg, 5);
    assert.equal(steps[5].chase, ev.tMs);
    assert.deepEqual(eclipseSteps(null, { site, sunAt: () => ({}) }).map((s) => !!s.chase), [true, false], 'no local event: the chase alone');
});

test('ambientSteps and highestBright: the live globe, then the highest bright body', () => {
    const body = (id, altDeg, mag) => ({ id, altDeg, azDeg: 100, mag });
    const snap = { bodies: [body('sun', 50, -26), body('moon', 20, -10), body('mars', 60, 1.0), body('uranus', 70, 5.7), body('saturn', 5, 0.5)] };
    assert.deepEqual(highestBright(snap), { id: 'mars', azDeg: 100, altDeg: 60 });
    assert.equal(highestBright({ bodies: [body('venus', 3, -4)] }), null);
    assert.equal(highestBright(null), null);
    const steps = ambientSteps({ observer: { latDeg: 50, lonDeg: 10 }, place: 'Here', snap, cycle: 1 });
    assert.equal(steps[0].time.live, true);
    assert.equal(steps[0].cinema, true);
    assert.equal(steps[0].fly.lonDeg, -30, 'odd cycles drift west');
    assert.equal(steps[0].fly.durationMs, 30000);
    assert.equal(steps[1].select, 'mars');
    assert.equal(steps[1].then.track, 'stars');
    assert.ok(steps.every((s) => s.captionMs > 0));
    assert.equal(ambientSteps({ observer: { latDeg: -5, lonDeg: 0 }, place: 'H', snap: null, cycle: 0 })[1].look.azDeg, 0);
});

test('wait resolves after the delay or at once on abort', async () => {
    const ac = new AbortController();
    const p = wait(10000, ac.signal);
    ac.abort();
    await p;
    await wait(0);
    await wait(5);
});

/** The runner in text mode (no rig) on the real store and clock, with instant timers. */
function harness({ frozen = false, reduced = false } = {}) {
    const store = createStore({
        observer: { ...DEFAULT_STATE.observer, latDeg: 10.82, lonDeg: 106.63, name: 'Ho Chi Minh City', tz: 'Asia/Ho_Chi_Minh', source: 'city' },
        selection: 'venus', view: { mode: 'orbit', earthLock: false, track: 'none' },
        status: { ...DEFAULT_STATE.status, reducedMotion: reduced },
    });
    const clock = createClock({ now: () => T0 + 3 * H, tMs: T0, playing: false });
    const said = [];
    const bus = { emit: (type, text) => { if (type === 'announce') said.push(text); } };
    const listeners = {};
    const win = {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        removeEventListener: (type) => { delete listeners[type]; },
    };
    const calls = [];
    const actions = {
        setObserver: (o) => { calls.push(['setObserver', o.source]); store.set({ observer: { ...store.get().observer, ...o } }); return o; },
        jumpToEvent: (ev) => calls.push(['jumpToEvent', ev.kind]),
        chaseEclipse: () => { calls.push(['chase']); return Promise.resolve(false); },
        stopChase: () => calls.push(['stopChase']),
        chasing: false,
    };
    const pending = [];
    const timers = frozen
        ? { setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout() {} }
        : { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (id) => clearTimeout(id) };
    let t = 0;
    const runner = createTourRunner({
        store, bus, clock, actions, win, timers, getRig: () => null, getSnap: () => null,
        now: () => (t += 400), raf: (cb) => setTimeout(() => cb(t), 0),
        astro: { call: async (op) => (op === 'tonight' ? report() : null) },
    });
    return { store, clock, said, listeners, calls, runner };
}

/** Runs the clock's restore sweep (a tween) to its end. */
function settleClock(clock) {
    for (let i = 0; i < 40; i++) clock.tick(i * 250);
}

/** The observer without the keys a restore cleared (null). */
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

async function until(fn, ms = 4000) {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await tick();
    }
}

test('runner: plays a tour as captions and time jumps, then restores everything it touched', async () => {
    const { store, clock, said, runner } = harness();
    const before = store.get();
    const layerLog = [];
    store.subscribe((s) => s.layers.beams, (v) => layerLog.push(v));
    assert.equal(await runner.start('year'), true);
    assert.equal(store.get().ui.tour.id, 'year');
    assert.equal(store.get().ui.tour.steps, 7);
    assert.equal(store.get().ui.sheet, 'peek');
    await until(() => !runner.active);
    assert.deepEqual(layerLog, [false, true], 'the tour\'s layers came and went');
    const after = store.get();
    assert.equal(after.ui.tour, null);
    assert.equal(after.observer, before.observer);
    assert.equal(after.selection, 'venus');
    assert.deepEqual(after.view, before.view);
    assert.deepEqual(after.layers, before.layers);
    assert.equal(after.ui.sheet, before.ui.sheet);
    assert.equal(clock.tweening, true, 'the clock sweeps back');
    settleClock(clock);
    assert.equal(clock.tMs, T0);
    assert.equal(clock.playing, false);
    assert.ok(said.some((s) => /March equinox/.test(s)), 'captions are announced');
    assert.match(said.at(-1), /A year in a minute: the end/);
});

test('runner: Tonight from the worker report; Live is restored', async () => {
    const { store, clock, said, runner } = harness();
    clock.goLive();
    assert.equal(await runner.start('tonight'), true);
    await until(() => !runner.active);
    assert.equal(clock.live, true);
    assert.ok(said.includes('jupiter: good'));
    assert.equal(store.get().selection, 'venus');
});

test('runner: the eclipse tour places the observer as a tour (never persisted) and jumps to the event', async () => {
    const { store, calls, runner } = harness();
    const before = store.get().observer;
    await runner.start('eclipse-2027');
    await until(() => calls.some((c) => c[0] === 'jumpToEvent'));
    assert.deepEqual(calls[0], ['setObserver', 'tour']);
    assert.equal(store.get().observer.name, 'Luxor');
    runner.stop();
    assert.deepEqual(present(store.get().observer), before, 'the tour\'s cc and elevM are cleared');
    assert.equal(store.get().ui.eclipse, null);
});

test('runner: input pauses, Resume replays, Next skips, Esc ends; Ambient ends on input', async () => {
    const { store, listeners, runner, said } = harness({ frozen: true });
    await runner.start('tonight');
    await tick();
    assert.equal(store.get().ui.tour.step, 1);
    // Input on the tour bar itself is not an interruption.
    listeners.pointerdown({ target: { closest: () => ({}) } });
    assert.equal(store.get().ui.tour.paused, false);
    listeners.keydown({ key: 'Tab', target: null });
    assert.equal(store.get().ui.tour.paused, false);
    listeners.pointerdown({ target: null });
    assert.equal(store.get().ui.tour.paused, true);
    assert.match(said.at(-1), /paused/);
    runner.resume();
    await tick();
    await tick();
    assert.deepEqual([store.get().ui.tour.step, store.get().ui.tour.paused], [1, false], 'resume replays the step');
    runner.next();
    await tick();
    await tick();
    assert.equal(store.get().ui.tour.step, 2);
    listeners.wheel({ target: null });
    runner.next();
    await tick();
    await tick();
    assert.deepEqual([store.get().ui.tour.step, store.get().ui.tour.paused], [3, false], 'next from a pause skips ahead');
    const esc = { key: 'Escape', defaultPrevented: false, stopped: false };
    esc.preventDefault = () => { esc.defaultPrevented = true; };
    esc.stopImmediatePropagation = () => { esc.stopped = true; };
    listeners.keydown(esc);
    assert.equal(runner.active, false);
    assert.equal(store.get().ui.tour, null);
    // The global Esc (ui/shortcuts.js) must not then leave the restored map, cinema or selection.
    assert.ok(esc.defaultPrevented && esc.stopped, 'Esc is consumed by the tour');
    assert.equal(store.get().selection, 'venus', 'the selection the tour found stays');
    assert.equal(listeners.keydown, undefined, 'input listeners removed');

    await runner.start('ambient');
    assert.equal(store.get().ui.tour.ambient, true);
    await tick();
    assert.equal(store.get().ui.cinema, true);
    listeners.keydown({ key: 'a', target: null });
    assert.equal(runner.active, false);
    assert.equal(store.get().ui.cinema, false);
});

test('runner: a second tour keeps the state the first one found; unknown ids do nothing', async () => {
    const { store, clock, runner } = harness({ frozen: true, reduced: true });
    assert.equal(await runner.start('nope'), false);
    assert.equal(store.get().ui.tour, null);
    await runner.start('year');
    await tick();
    assert.notEqual(clock.tMs, T0);
    await runner.start('tonight');
    assert.equal(store.get().ui.tour.id, 'tonight');
    runner.stop();
    assert.equal(clock.tMs, T0);
    assert.equal(store.get().layers.beams, true);
});

test('runner: reduced motion lands each sweep on its last day', async () => {
    const { clock, runner } = harness({ reduced: true });
    const seen = [];
    clock.onChange((e) => { if (e.type === 'jump') seen.push(clock.tMs); });
    await runner.start('year');
    await until(() => !runner.active);
    assert.ok(seen.length < 20, `${seen.length} jumps, no strobing`);
});
