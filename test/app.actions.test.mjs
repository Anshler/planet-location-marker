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
