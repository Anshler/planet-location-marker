// Tests for the pure helpers of js/app/actions.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    shadowPoint, eventFraming, eclipseFocusExpired, createActions, ECLIPSE_LEAD_MS, eclipsePlayRange, lookSpanning,
    telescopeFov, TELESCOPE_FOV_MIN,
} from '../js/app/actions.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { localSolarEclipseAt, upcomingEvents } from '../js/astro/events.js';
import { createStore } from '../js/core/store.js';
import { distanceKm } from '../js/geo/coords.js';

const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0, tz: 'Africa/Cairo', name: 'Luxor', country: 'Egypt', source: 'url' };

test('shadowPoint lands on the greatest eclipse of 2027-02-06 (annular, South Atlantic off Brazil)', () => {
    // NASA: greatest eclipse 2027-02-06 15:59:43 TD at 31°18′S 48°31′W.
    const snap = createSnapshot();
    const observer = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 0, tz: 'Asia/Ho_Chi_Minh', name: 'Hanoi', country: 'VN', source: 'url' };
    computeSnapshot(Date.parse('2027-02-06T15:59:33Z'), observer, snap, { detail: 'frame' });
    const p = shadowPoint(snap);
    const km = distanceKm(p.latDeg, p.lonDeg, -31.3, -48.52);
    assert.ok(km < 150, `shadow axis at ${p.latDeg.toFixed(2)}, ${p.lonDeg.toFixed(2)} is ${Math.round(km)} km from greatest eclipse`);
});

test('eventFraming: totality lands 20 s before C2 and plays at 5°; partials and lunar eclipses land on visibleMs', () => {
    const luxor = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    const f = eventFraming(luxor);
    assert.equal(f.tMs, luxor.c2Ms - ECLIPSE_LEAD_MS);
    assert.equal(f.play, true);
    assert.equal(f.fovDeg, 5);
    // Aimed mid-way through what follows, so the drifting Sun stays in the 5° field to C3.
    assert.equal(f.aimMs, (f.tMs + luxor.c3Ms) / 2);
    // Totality at sunset (C2 up, C3 down): still C2 − 20 s. At sunrise (only C3 up): C3 − 20 s.
    assert.equal(eventFraming({ ...luxor, sunAltDeg: { ...luxor.sunAltDeg, c3: -1 } }).tMs, luxor.c2Ms - ECLIPSE_LEAD_MS);
    assert.equal(eventFraming({ ...luxor, sunAltDeg: { ...luxor.sunAltDeg, c2: -1 } }).tMs, luxor.c3Ms - ECLIPSE_LEAD_MS);
    // Central phase entirely below the horizon: framed like a partial, paused at visibleMs.
    const below = eventFraming({ ...luxor, visibleMs: luxor.c4Ms - 60e3, sunAltDeg: { ...luxor.sunAltDeg, c2: -2, c3: -2 } });
    assert.deepEqual(below, { tMs: luxor.c4Ms - 60e3, aimMs: luxor.c4Ms - 60e3, play: false, fovDeg: 10 });
    // A partial: paused at its visibleMs, 10°.
    const madrid = upcomingEvents({ latDeg: 40.42, lonDeg: -3.7 }, Date.parse('2027-08-01T00:00:00Z'), 3).find((e) => e.kind === 'local-solar-eclipse');
    assert.deepEqual(eventFraming(madrid), { tMs: madrid.visibleMs, aimMs: madrid.visibleMs, play: false, fovDeg: 10 });
    // A lunar eclipse seen from here: its visibleMs at 5°; one not seen keeps the peak (globe view).
    const lunar = { kind: 'lunar-eclipse', tMs: 1000, visibleMs: 900, view: 'sky' };
    assert.deepEqual(eventFraming(lunar), { tMs: 900, aimMs: 900, play: false, fovDeg: 5 });
    assert.deepEqual(eventFraming({ ...lunar, view: 'orbit', visibleMs: null }), { tMs: 1000, aimMs: 1000, play: false, fovDeg: undefined });
    // Other events: their own instant, the current field.
    assert.deepEqual(eventFraming({ kind: 'opposition', tMs: 5 }), { tMs: 5, aimMs: 5, play: false, fovDeg: undefined });
    assert.equal(eventFraming({ kind: 'opposition' }), null);
});

test('eclipseFocusExpired: more than a day from the peak, and never during the jump sweep', () => {
    const focus = { peakMs: 1e12 };
    assert.equal(eclipseFocusExpired(focus, 1e12 + 3600e3, false), false);
    assert.equal(eclipseFocusExpired(focus, 1e12 + 864e5 + 1, false), true);
    assert.equal(eclipseFocusExpired(focus, 1e12 - 864e5 - 1, false), true);
    assert.equal(eclipseFocusExpired(focus, 0, true), false, 'sweeping');
    assert.equal(eclipseFocusExpired(null, 0, false), false);
});

test('eclipsePlayRange: C2 − 2 min … C3 + 2 min in the path, C1 … C4 outside it, U1 … U4 for the Moon', () => {
    const luxor = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    assert.deepEqual(eclipsePlayRange(luxor), { fromMs: luxor.c2Ms - 120e3, toMs: luxor.c3Ms + 120e3, durationS: 40, loop: 'once' });
    // Totality below the horizon, or a partial: the whole eclipse.
    assert.deepEqual(eclipsePlayRange({ ...luxor, centralUp: 'none' }), { fromMs: luxor.c1Ms, toMs: luxor.c4Ms, durationS: 40, loop: 'once' });
    assert.equal(eclipsePlayRange({ ...luxor, eclipseKind: 'partial', c2Ms: null, c3Ms: null }).fromMs, luxor.c1Ms);
    assert.deepEqual(eclipsePlayRange({ kind: 'lunar-eclipse', p1Ms: 1, u1Ms: 2, u4Ms: 8, p4Ms: 9 }), { fromMs: 2, toMs: 8, durationS: 40, loop: 'once' });
    assert.equal(eclipsePlayRange({ kind: 'lunar-eclipse', p1Ms: 1, u1Ms: null, u4Ms: null, p4Ms: 9 }).toMs, 9, 'penumbral');
    assert.equal(eclipsePlayRange({ kind: 'local-solar-eclipse' }), null, 'older cached event');
    assert.equal(eclipsePlayRange({ kind: 'opposition', tMs: 5 }), null);
});

test('lookSpanning: centred on the middle of the drift, wide enough for all of it', () => {
    const still = lookSpanning([{ azDeg: 180, altDeg: 60 }, { azDeg: 180, altDeg: 60 }, { azDeg: 180, altDeg: 60 }], 5);
    assert.deepEqual(still, { azDeg: 180, altDeg: 60, fovDeg: 5 });
    // 10° either side of the middle on the horizon: 2.5 × 10 + 1 = 26°.
    const wide = lookSpanning([{ azDeg: 90, altDeg: 0 }, { azDeg: 100, altDeg: 0 }, { azDeg: 110, altDeg: 0 }], 10);
    assert.equal(wide.azDeg, 100);
    assert.ok(Math.abs(wide.fovDeg - 26) < 1e-9, String(wide.fovDeg));
    assert.equal(lookSpanning([{ azDeg: 0, altDeg: -30 }, { azDeg: 0, altDeg: -20 }, { azDeg: 0, altDeg: 80 }]).fovDeg, 100);
    assert.equal(lookSpanning([{ azDeg: 0, altDeg: -30 }, { azDeg: 0, altDeg: -20 }, { azDeg: 0, altDeg: 80 }]).altDeg, -5);
});

/** Actions on a real store with a recording clock, without the 3D view. */
function makeActions(extra = {}) {
    const store = createStore({ observer: LUXOR, view: { mode: 'orbit', earthLock: true }, status: { reducedMotion: true } });
    const calls = [];
    const clock = {
        tMs: Date.parse('2027-07-01T00:00:00Z'), tweening: false,
        pause() { calls.push(['pause']); },
        play() { calls.push(['play']); },
        setRate(r) { calls.push(['rate', r]); },
        setTime(t, o) { calls.push(['time', t, o?.animateMs ?? 0]); this.tMs = t; },
        setRange(r) { calls.push(['range', r]); return true; },
    };
    const toasts = [];
    const actions = createActions({
        store, clock, bus: { emit: (k, v) => { if (k === 'toast') toasts.push(v); } },
        prefs: { load: (_k, d) => d, save() {}, remove() {} }, render: {}, ...extra,
    });
    return { store, clock, calls, actions, toasts };
}

test('setVantage: a globe-view pose (sky view switches to the globe), cleared by Globe or Sky; needs the 3D view', () => {
    // Text mode (no rig): refused with a toast.
    const text = makeActions();
    assert.equal(text.actions.setVantage('l1'), false);
    assert.equal(text.store.get().view.vantage, 'none');
    assert.equal(text.toasts.length, 1);
    // With a rig (the store is what the actions change; main.js hands it to the rig).
    const flights = [];
    const rig = { flyToLatLon: (...a) => { flights.push(a); return Promise.resolve(true); }, setMode: () => Promise.resolve(true) };
    const { store, actions } = makeActions({ render: { rig } });
    assert.equal(actions.setVantage('mars'), false);
    store.set({ view: { ...store.get().view, mode: 'sky' } });
    assert.equal(actions.setVantage('moon'), true);
    assert.deepEqual([store.get().view.mode, store.get().view.vantage], ['orbit', 'moon']);
    assert.equal(actions.setVantage('l1'), true);
    assert.equal(store.get().view.vantage, 'l1');
    // 'Globe' is the way back even though the view is already the globe; 'Sky' leaves it too.
    actions.setViewMode('orbit');
    assert.deepEqual([store.get().view.mode, store.get().view.vantage], ['orbit', 'none']);
    actions.setVantage('moon');
    actions.setViewMode('sky');
    assert.deepEqual([store.get().view.mode, store.get().view.vantage], ['sky', 'none']);
    // A globe-view event jump keeps the vantage (L1 watches the shadow cross the disc).
    actions.setViewMode('orbit');
    actions.setVantage('l1');
    actions.jumpToEvent({ kind: 'solar-eclipse', tMs: Date.parse('2027-08-02T10:07:00Z'), select: 'sun', view: 'orbit', eclipseKind: 'total', geo: { latDeg: 25.5, lonDeg: 33.2 } });
    assert.equal(store.get().view.vantage, 'l1');
    assert.deepEqual(flights, [], 'no flight over the shadow');
    // A sky-view event leaves it.
    actions.jumpToEvent({ kind: 'opposition', tMs: Date.parse('2027-09-01T00:00:00Z'), select: 'saturn', view: 'sky' });
    assert.deepEqual([store.get().view.mode, store.get().view.vantage], ['sky', 'none']);
});

test('jumpToEvent: a total solar eclipse plays from C2 − 20 s and becomes the eclipse in focus', () => {
    const { store, calls, actions } = makeActions();
    const ev = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    actions.jumpToEvent(ev);
    assert.deepEqual(calls, [['pause'], ['time', ev.c2Ms - 20e3, 0], ['rate', 1], ['play']]);
    assert.deepEqual(store.get().ui.eclipse, { peakMs: ev.tMs, kind: 'total', local: true, eventId: ev.id });
    assert.equal(store.get().view.mode, 'sky');
    assert.equal(store.get().selection, 'sun');
    // A non-solar event clears it.
    actions.jumpToEvent({ kind: 'opposition', tMs: Date.parse('2027-09-01T00:00:00Z'), select: 'saturn' });
    assert.equal(store.get().ui.eclipse, null);
});

test('playEclipse runs the timelapse once, selects the Sun and switches to sky view', () => {
    const { store, calls, actions } = makeActions();
    const ev = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    assert.equal(actions.playEclipse(ev), true);
    assert.deepEqual(calls, [['range', eclipsePlayRange(ev)]]);
    assert.equal(store.get().selection, 'sun');
    assert.equal(store.get().view.mode, 'sky');
    assert.equal(store.get().ui.eclipse.peakMs, ev.tMs);
    assert.equal(actions.playEclipse({ kind: 'opposition', tMs: 5 }), false);
    assert.equal(calls.length, 1);
});

test('standInPath moves the observer onto the centre line and frames the eclipse from there', async () => {
    const far = { ...LUXOR, latDeg: 30.06, lonDeg: 31.25, name: 'Cairo' };   // outside the band (partial)
    const astroCalls = [];
    const { store, calls, actions, toasts } = makeActions({
        astro: {
            async eclipsePath(peakMs, opts) {
                astroCalls.push([peakMs, opts?.n]);
                const { eclipsePath } = await import('../js/astro/eclipse-path.js');
                return eclipsePath(peakMs);
            },
        },
    });
    store.set({ observer: far });
    const peak = Date.parse('2027-08-02T10:06:39Z');
    const next = await actions.standInPath(peak);
    assert.ok(next, 'moved');
    assert.equal(astroCalls.length, 1);
    // The centre-line point nearest Cairo: ~160 km south-east, in the Nile valley's band.
    const km = distanceKm(far.latDeg, far.lonDeg, next.latDeg, next.lonDeg);
    assert.ok(km > 100 && km < 400, `${km.toFixed(0)} km from Cairo`);
    assert.equal(next.source, 'manual');
    assert.ok(toasts.some((t) => t.actionLabel === 'Undo'), 'undoable like any observer move');
    // Framed as a total eclipse seen from there: C2 − 20 s, playing.
    const ev = localSolarEclipseAt(next, peak);
    assert.equal(ev.eclipseKind, 'total');
    assert.deepEqual(calls.slice(-4), [['pause'], ['time', ev.c2Ms - 20e3, 0], ['rate', 1], ['play']]);
    assert.equal(store.get().ui.eclipse.local, true);
    // The path request is shared: asking again does not recompute.
    await actions.eclipsePath(peak);
    assert.equal(astroCalls.length, 1);
    // No central line: a toast, nothing moves.
    const before = store.get().observer;
    assert.equal(await actions.standInPath(Date.parse('2025-09-21T19:42:00Z')), null);
    assert.equal(store.get().observer, before);
});

test('telescopeFov: Jupiter with all four moons, the Moon whole, small planets at the 0.2° floor; portrait fits the width', () => {
    const s = createSnapshot();
    computeSnapshot(Date.parse('2026-11-04T03:00:00Z'), { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, s);
    const jup = s.bodies[5];
    const fov = telescopeFov('jupiter', s, 16 / 9);
    // Every moon's offset across the line of sight fits in half the (vertical) field.
    const rDeg = jup.angDiamArcsec / 7200;
    for (let k = 0; k < 4; k++) {
        const o = s.galilean.offS.subarray(k * 3, k * 3 + 3), d = jup.dirS;
        const along = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
        const across = Math.sqrt(o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - along * along) * rDeg;
        assert.ok(across < fov / 2, `moon ${k}: ${across.toFixed(3)}° inside ${fov.toFixed(3)}°`);
    }
    assert.ok(fov > 0.2 && fov < 1, `Jupiter ${fov}`);
    assert.ok(telescopeFov('jupiter', s, 0.5) > fov * 1.9, 'portrait: the width decides');
    const moon = telescopeFov('moon', s);
    assert.ok(moon > s.bodies[1].angDiamArcsec / 3600 && moon < 1, `the Moon ${moon}`);
    assert.equal(telescopeFov('mars', s), TELESCOPE_FOV_MIN);
    assert.equal(telescopeFov('pluto', s), null);
});

test('setRuler: sky view only (switches there), toggles, needs the 3D view', () => {
    const text = makeActions();
    assert.equal(text.actions.setRuler(true), false);
    assert.equal(text.store.get().ui.ruler, undefined);
    assert.equal(text.toasts.length, 1);
    const { store, actions } = makeActions({ render: { rig: { setMode: () => Promise.resolve(true) } } });
    assert.equal(actions.setRuler(), true);
    assert.equal(store.get().view.mode, 'sky');
    assert.deepEqual(store.get().ui.ruler, { ends: 0, from: null, to: null, deg: null, text: '', fists: '' });
    assert.equal(actions.setRuler(true), true, 'already on');
    assert.equal(actions.setRuler(), false);
    assert.equal(store.get().ui.ruler, null);
});

test('pointAtSky: iOS permission asked inside the call, then the aim runner; denied → a toast', async () => {
    const order = [];
    let answer = 'granted';
    const DeviceOrientationEvent = { requestPermission: () => { order.push('permission'); return Promise.resolve(answer); } };
    const aim = { start: () => { order.push('start'); return Promise.resolve(true); }, stop: (r) => order.push(`stop:${r}`), align: () => 'the Moon' };
    const { store, actions, toasts } = makeActions({ render: { rig: {} }, aim, win: { DeviceOrientationEvent } });
    // Globe view: refused.
    assert.equal(await actions.pointAtSky(true), false);
    assert.equal(toasts.length, 1);
    store.set({ view: { ...store.get().view, mode: 'sky' } });
    const p = actions.pointAtSky();
    assert.deepEqual(order, ['permission'], 'synchronously, still inside the tap');
    assert.equal(await p, true);
    assert.deepEqual(order, ['permission', 'start']);
    answer = 'denied';
    assert.equal(await actions.pointAtSky(true), false);
    assert.match(toasts.at(-1).message, /Motion access was declined/);
    // On (ui.aim set by main.js): the toggle stops it.
    store.set({ ui: { ...store.get().ui, aim: { source: 'compass', offsetDeg: 0, aligned: null } } });
    assert.equal(await actions.pointAtSky(), false);
    assert.equal(order.at(-1), 'stop:user');
    assert.equal(actions.alignAim(), 'the Moon');
});

test('expose: stopping a preset gives back the clock it found; a clock taken over meanwhile stays', async () => {
    const { createClock } = await import('../js/core/clock.js');
    const NY = { latDeg: 40.7, lonDeg: -74, elevM: 0, name: 'New York', tz: 'America/New_York', source: 'url' };
    const T = Date.parse('2026-11-04T03:00:00Z');
    const make = (opts) => {
        const store = createStore({ observer: NY, view: { mode: 'sky', earthLock: true, track: 'none' }, status: { reducedMotion: true } });
        const clock = createClock({ tMs: T, now: () => T + 3600e3, ...opts });
        const actions = createActions({
            store, clock, bus: { emit() {} }, prefs: { load: (_k, d) => d, save() {}, remove() {} },
            render: { rig: { setMode: () => Promise.resolve(true), setTracking() {} } },
        });
        return { store, clock, actions };
    };
    // Paused at rate 1: Star trails run 10 min/s; stopping pauses again at 1× (the night stays).
    const a = make({ playing: false, rate: 1 });
    assert.equal(a.actions.expose('trails'), true);
    assert.equal(a.clock.rate, 600);
    assert.equal(a.clock.playing, true);
    a.actions.expose(null);
    assert.deepEqual([a.clock.rate, a.clock.playing], [1, false], 'paused at 1× again');
    // Live: stopping goes Live again.
    const b = make({ tMs: undefined });
    assert.equal(b.clock.live, true);
    b.actions.expose('trails');
    assert.equal(b.clock.live, false);
    b.actions.expose(null);
    assert.equal(b.clock.live, true, 'Live again');
    // Taken over (the user paused): left as the user set it.
    const c = make({ playing: true, rate: 60 });
    c.actions.expose('trails');
    c.clock.pause();
    c.actions.expose(null);
    assert.deepEqual([c.clock.rate, c.clock.playing], [600, false], 'the user’s pause stays');
    // The analemma: back to the day it started, paused as found.
    const d = make({ playing: false, rate: 1 });
    d.actions.expose('analemma');
    d.clock.seek?.(0.5);
    d.actions.expose(null);
    assert.equal(d.clock.range, null);
    assert.equal(d.clock.tMs, T, 'the start time');
    assert.equal(d.clock.playing, false);
});

test('copyDiagnostics: the report as JSON on the clipboard, and the text either way', async () => {
    const copied = [];
    const report = { app: { version: '2.0.0' }, hash: { q: 'high' } };
    const nav = { clipboard: { writeText: async (t) => { copied.push(t); } } };
    const { actions } = makeActions({ diagnostics: () => report, nav, doc: null });
    assert.deepEqual(actions.diagnostics(), report);
    const r = await actions.copyDiagnostics();
    assert.deepEqual(r, { ok: true, text: JSON.stringify(report, null, 2) });
    assert.deepEqual(copied, [r.text]);
    // Clipboard blocked and no document for the textarea fallback: not copied, the text is still handed back.
    const blocked = makeActions({ diagnostics: () => report, nav: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc: null });
    assert.deepEqual(await blocked.actions.copyDiagnostics(), { ok: false, text: r.text });
    // A host without a report (or one that throws) copies an empty object.
    const none = makeActions({ diagnostics: () => { throw new Error('x'); }, nav, doc: null });
    assert.equal(none.actions.diagnostics(), null);
    assert.equal((await none.actions.copyDiagnostics()).text, '{}');
});

test('shareUrl({event}): a link to the event\'s sky, paused where a jump lands, its selection and view, no camera or intro', async () => {
    const { parseHash } = await import('../js/core/url-state.js');
    const { store, actions } = makeActions({ win: { location: { origin: 'https://example.test', pathname: '/planet-location-marker/', search: '' } } });
    store.set({ selection: 'mars', host: { id: 'mars', latDeg: 0, lonDeg: 0 } });
    const ev = localSolarEclipseAt(LUXOR, Date.parse('2027-08-02T10:05:00Z'));
    const url = actions.shareUrl({ event: ev });
    assert.ok(url.startsWith('https://example.test/planet-location-marker/#'), url);
    const h = parseHash(url.slice(url.indexOf('#')));
    assert.equal(h.tMs, Math.round((ev.c2Ms - 20e3) / 1000) * 1000, 'the jump\'s landing: 20 s before second contact');
    assert.equal(h.playing, false);
    assert.equal(h.selection, 'sun');
    assert.equal(h.view, 'sky');
    assert.equal(h.intro, false);
    assert.ok(!url.includes('cam='), 'no camera: the app turns to the selection');
    assert.ok(!url.includes('host='), 'the events are the Earth\'s');
    assert.ok(url.includes('loc=25.7,32.6'));
    // An event without a body clears the selection; the store itself is untouched.
    const season = { id: 'equinox:sun:1', kind: 'equinox', bodyId: 'sun', tMs: Date.parse('2027-03-20T14:25:00Z'), title: 'March equinox', detail: '', select: null, view: 'orbit' };
    const h2 = parseHash(actions.shareUrl({ event: season }).split('#')[1]);
    assert.equal(h2.selection ?? null, null);
    assert.equal(h2.tMs, season.tMs);
    assert.equal(store.get().selection, 'mars');
});

test('setNightVision: toggles display.red, announces, and stays out of shared links', async () => {
    const { serializeHash } = await import('../js/core/url-state.js');
    const said = [];
    const store = createStore({ observer: LUXOR });
    const actions = createActions({
        store, clock: { tMs: Date.parse('2027-07-01T00:00:00Z'), playing: true, rate: 1 },
        bus: { emit: (k, v) => { if (k === 'announce') said.push(v); } },
        prefs: { load: (_k, d) => d, save() {}, remove() {} }, render: {},
        win: { location: { origin: 'https://example.test', pathname: '/', search: '' } },
    });
    assert.equal(store.get().display.red, false);
    assert.equal(actions.setNightVision(), true, 'omitted: toggle');
    assert.equal(store.get().display.red, true);
    assert.equal(actions.setNightVision(true), true);
    assert.equal(said.length, 1, 'no announcement without a change');
    assert.ok(!/red/.test(actions.shareUrl()), 'a device preference, not part of the sky');
    assert.ok(!/red/.test(serializeHash({ state: store.get(), clock: { tMs: 0, playing: true, rate: 1 } })));
    assert.equal(actions.setNightVision(false), false);
    assert.equal(store.get().display.red, false);
    assert.deepEqual(said, ['Night vision on: the screen is dim red and stays awake', 'Night vision off']);
});

test('telescope: ui.scope keeps the way back; leaveTelescope restores the field and the following; the chip ends with its premise', () => {
    const s = createSnapshot();
    computeSnapshot(Date.parse('2026-11-04T03:00:00Z'), { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, s);
    const id = ['jupiter', 'saturn', 'mars', 'venus', 'moon'].find((b) => s.bodies.find((x) => x.id === b).altGeomDeg > 5);
    assert.ok(id, 'a body up to look at');
    let cam = { mode: 'sky', azDeg: 120, altDeg: 30, fovDeg: 50 };
    const looks = [], zooms = [], on = {};
    const rig = {
        camera: { aspect: 16 / 9 }, getView: () => cam, telescope: (f) => zooms.push(f), setTracking() {},
        setMode: (_m, o) => { looks.push(o?.look); return Promise.resolve(true); },
    };
    const store = createStore({ observer: LUXOR, view: { mode: 'sky', earthLock: true, track: 'none' }, status: { reducedMotion: true } });
    const actions = createActions({
        store, clock: { tMs: s.tMs }, bus: { emit() {}, on: (k, fn) => { on[k] = fn; } },
        prefs: { load: (_k, d) => d, save() {}, remove() {} }, render: { rig }, getSnap: () => s,
    });
    const scope = () => store.get().ui.scope;
    assert.equal(actions.telescope(id), true);
    assert.deepEqual({ ...scope(), fovDeg: undefined }, { id, fovDeg: undefined, prevFovDeg: 50, prevTrack: 'none' });
    assert.deepEqual([store.get().selection, store.get().view.track, zooms.length], [id, 'body', 1]);
    // The zoom-in starts wide: the 4 Hz check waits until the field has arrived.
    on.readout();
    assert.ok(scope(), 'still zooming in');
    cam = { ...cam, fovDeg: scope().fovDeg };
    on.readout();
    // Leaving: the field it found (a free look glides back) and the selection stays.
    assert.equal(actions.leaveTelescope(), true);
    assert.equal(scope(), null);
    assert.deepEqual([store.get().selection, store.get().view.track, looks.at(-1).fovDeg], [id, 'none', 50]);
    assert.equal(actions.leaveTelescope(), false, 'nothing to leave');
    // The chip ends with another selection, the globe, Follow set free, or a zoom well past the field.
    actions.telescope(id);
    actions.select('sun');
    assert.equal(scope(), null, 'another selection');
    actions.telescope(id);
    actions.setViewMode('orbit');
    assert.equal(scope(), null, 'the globe');
    store.set({ view: { ...store.get().view, mode: 'sky' } });
    actions.telescope(id);
    actions.setTracking('none');
    assert.equal(scope(), null, 'Follow set free');
    actions.telescope(id);
    cam = { ...cam, fovDeg: scope().fovDeg };
    on.readout();
    cam = { ...cam, fovDeg: 12 };
    on.readout();
    assert.equal(scope(), null, 'zoomed out');
    // Following the stars before: it comes back, zooming out as it engages; a second telescope keeps the first way back.
    actions.setTracking('stars');
    cam = { ...cam, fovDeg: 30 };
    actions.telescope(id);
    cam = { ...cam, fovDeg: 1 };
    actions.telescope(id);
    assert.deepEqual([scope().prevFovDeg, scope().prevTrack], [30, 'stars']);
    actions.leaveTelescope();
    assert.deepEqual([store.get().view.track, zooms.at(-1)], ['stars', 30]);
    // A shared link's narrow field on the selection (sky view) gets the chip, back to a 60° free look.
    actions.scopeFromLink({ mode: 'sky', azDeg: 0, altDeg: 20, fovDeg: 12 });
    assert.equal(scope(), null, 'too wide for a telescope');
    actions.scopeFromLink({ mode: 'sky', azDeg: 0, altDeg: 20, fovDeg: 0.5 });
    assert.deepEqual(scope(), { id, fovDeg: 0.5, prevFovDeg: 60, prevTrack: 'none' });
});
