// Eclipse Companion (js/ui/eclipse-hud.js): which eclipse it shows, its contacts, countdown and
// playhead, for the 2 Aug 2027 total eclipse from Luxor (in the path) and Paris (51 % partial).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    eclipseContacts, isCentral, pickHudEvent, hudCountdown, trackPos, fmtCountdown, HUD_LEAD_MS, HUD_TRAIL_MS,
} from '../js/ui/eclipse-hud.js';
import { localSolarEclipseAt } from '../js/astro/events.js';

const PEAK = Date.parse('2027-08-02T10:05:00Z');
const luxor = localSolarEclipseAt({ latDeg: 25.7, lonDeg: 32.6 }, PEAK);
const paris = localSolarEclipseAt({ latDeg: 48.857, lonDeg: 2.352 }, PEAK);
const lunar = {
    kind: 'lunar-eclipse', tMs: 5e6, visibleHere: true, eclipseKind: 'total',
    p1Ms: 1e6, u1Ms: 2e6, u2Ms: 4e6, maxMs: 5e6, u3Ms: 6e6, u4Ms: 8e6, p4Ms: 9e6,
};

test('eclipseContacts: C1–C2–Max–C3–C4 in the path, C1–Max–C4 outside it, U1–U4 for the Moon', () => {
    assert.deepEqual(eclipseContacts(luxor).map((c) => c.id), ['C1', 'C2', 'Max', 'C3', 'C4']);
    const ms = eclipseContacts(luxor).map((c) => c.ms);
    assert.deepEqual(ms, [luxor.c1Ms, luxor.c2Ms, luxor.tMs, luxor.c3Ms, luxor.c4Ms]);
    assert.ok(ms.every((v, i) => i === 0 || v > ms[i - 1]), 'in order');
    assert.equal(paris.eclipseKind, 'partial');
    assert.deepEqual(eclipseContacts(paris).map((c) => c.id), ['C1', 'Max', 'C4']);
    assert.deepEqual(eclipseContacts(lunar).map((c) => c.id), ['U1', 'U2', 'Max', 'U3', 'U4']);
    const penumbral = { kind: 'lunar-eclipse', tMs: 5, p1Ms: 1, maxMs: 5, p4Ms: 9, u1Ms: null };
    assert.deepEqual(eclipseContacts(penumbral).map((c) => c.id), ['P1', 'Max', 'P4']);
    // Older cached events without contacts, and other kinds, have none.
    assert.deepEqual(eclipseContacts({ kind: 'local-solar-eclipse', tMs: 5 }), []);
    assert.deepEqual(eclipseContacts({ kind: 'opposition', tMs: 5 }), []);
    assert.equal(isCentral(luxor), true);
    assert.equal(isCentral(paris), false);
    assert.equal(isCentral({ ...luxor, centralUp: 'none' }), false, 'totality below the horizon');
    assert.equal(isCentral(lunar), true);
});

test('pickHudEvent: from 3 h before C1 to 30 min after C4, local eclipses and lunar ones seen from here', () => {
    const list = [{ kind: 'solar-eclipse', tMs: PEAK }, luxor, { kind: 'opposition', tMs: PEAK }];
    assert.equal(pickHudEvent(list, luxor.c1Ms - HUD_LEAD_MS + 1000), luxor);
    assert.equal(pickHudEvent(list, luxor.c4Ms + HUD_TRAIL_MS - 1000), luxor);
    assert.equal(pickHudEvent(list, luxor.c1Ms - HUD_LEAD_MS - 1000), null);
    assert.equal(pickHudEvent(list, luxor.c4Ms + HUD_TRAIL_MS + 1000), null);
    assert.equal(pickHudEvent([lunar], 5e6), lunar);
    assert.equal(pickHudEvent([{ ...lunar, visibleHere: false }], 5e6), null);
    assert.equal(pickHudEvent(null, 5e6), null);
});

test('hudCountdown: totality, its end, the end of the eclipse; maximum for a partial', () => {
    const c = eclipseContacts(luxor);
    const at940 = Date.parse('2027-08-02T09:40:00Z');
    assert.deepEqual(hudCountdown(luxor, c, at940), { label: 'Totality in', leftMs: luxor.c2Ms - at940, passed: 1 });
    assert.equal(hudCountdown(luxor, c, luxor.c1Ms - 60e3).label, 'Totality in', 'before C1 too');
    const at1003 = Date.parse('2027-08-02T10:03:00Z');
    assert.deepEqual(hudCountdown(luxor, c, at1003), { label: 'Totality ends in', leftMs: luxor.c3Ms - at1003, passed: 2 });
    assert.equal(hudCountdown(luxor, c, luxor.c3Ms).label, 'Eclipse ends in');
    assert.deepEqual(hudCountdown(luxor, c, luxor.c4Ms), { label: 'Eclipse over', leftMs: null, passed: 5 });
    assert.equal(hudCountdown({ ...luxor, eclipseKind: 'annular' }, c, at940).label, 'Ring of fire in');
    const p = eclipseContacts(paris);
    const early = paris.c1Ms + 60e3;
    assert.deepEqual(hudCountdown(paris, p, early), { label: 'Maximum in', leftMs: paris.tMs - early, passed: 1 });
    assert.equal(hudCountdown(paris, p, paris.tMs + 1).label, 'Eclipse ends in');
    assert.equal(hudCountdown(lunar, eclipseContacts(lunar), 4.5e6).label, 'Totality ends in');
});

test('trackPos: evenly spaced contacts, linear time between them', () => {
    const c = eclipseContacts(lunar);
    assert.equal(trackPos(c, 0), 0);
    assert.equal(trackPos(c, 2e6), 0);
    assert.equal(trackPos(c, 3e6), 0.125);
    assert.equal(trackPos(c, 5e6), 0.5);
    assert.equal(trackPos(c, 7e6), 0.875);
    assert.equal(trackPos(c, 9e6), 1);
});

test('fmtCountdown: hh:mm:ss, rounded up, hours past 24', () => {
    assert.equal(fmtCountdown(27 * 60e3 + 14e3), '00:27:14');
    assert.equal(fmtCountdown(13_400), '00:00:14');
    assert.equal(fmtCountdown(-5), '00:00:00');
    assert.equal(fmtCountdown(25 * 3600e3), '25:00:00');
});

test('layout: the status stack (mode chips) sits under the companion (--ecl-h), on both layouts', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../css/app.css', import.meta.url), 'utf8');
    const src = await readFile(new URL('../js/ui/eclipse-hud.js', import.meta.url), 'utf8');
    assert.match(src, /setProperty\('--ecl-h'/, 'the companion publishes its height');
    for (const sel of ['.status-stack', '.ui[data-layout="mobile"] .status-stack']) {
        const at = css.indexOf(`\n${sel} {`);
        assert.ok(at >= 0, `${sel} rule`);
        const rule = css.slice(at, css.indexOf('}', at));
        assert.match(rule, /top:[^;]*var\(--ecl-h, 0px\)/, `${sel}: its top clears the companion`);
    }
});
