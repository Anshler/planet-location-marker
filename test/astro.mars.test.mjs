// Standing on Mars (ROADMAP stand-on-mars, phase 1): the Mars clock against Mars24's worked
// example, Perseverance's sol count and its sol-397 Phobos transit, the local frame against the
// clock, the host table, the moons' provider and the URL keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    marsTime, marsTimeTT, createMarsTime, missionSol, marsClockText, marsSunAltDeg, marsSiteNear, MARS_SITES, hhmm,
} from '../js/astro/mars-clock.js';
import { computeMarsSnapshot, marsMoonPosition, MARS_MOONS, EARTH_SLOT, createMarsMoonsProvider } from '../js/astro/host-mars.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { BODIES, BODY_IDS, hostBodies, EARTH_TARGET } from '../js/astro/bodies.js';
import { createExtras } from '../js/astro/extras.js';
import { parseHash, serializeHash } from '../js/core/url-state.js';
import { DEFAULT_STATE } from '../js/core/store.js';
import { AE } from '../js/astro/ae.js';

const DEG = Math.PI / 180;
const JEZERO = MARS_SITES.find((s) => s.id === 'jezero');
const sep = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG;

test('Mars clock: Mars24 worked example A (2000-01-06 00:00:00 UTC)', () => {
    // NASA GISS Mars24 "Algorithm and Worked Examples", example A: Ls 277.18758°, EOT −5.18774°,
    // MST 23.99425 h, LTST(0°) 23.64841 h, δs −25.22847°, r 1.39358 AU, subsolar 174.72609° W.
    // Mars24 adds TT − UTC = 64.184 s; astronomy-engine's ΔT for 2000 is ~0.35 s less.
    const m = marsTime(Date.UTC(2000, 0, 6), 0);
    assert.ok(Math.abs(m.lsDeg - 277.18758) < 5e-4, `Ls ${m.lsDeg}`);
    assert.ok(Math.abs(m.eotDeg - -5.18774) < 1e-3, `EOT ${m.eotDeg}`);
    assert.ok(Math.abs(m.mtcH - 23.99425) < 5e-4, `MTC ${m.mtcH}`);
    assert.ok(Math.abs(m.ltstH - 23.64841) < 5e-4, `LTST ${m.ltstH}`);
    assert.ok(Math.abs(m.solarDecDeg - -25.22847) < 2e-3, `δs ${m.solarDecDeg}`);
    assert.ok(Math.abs(m.sunDistAU - 1.39358) < 1e-4, `r ${m.sunDistAU}`);
    assert.ok(Math.abs(m.subsolarLonDeg - -174.72609) < 3e-3, `subsolar ${m.subsolarLonDeg}`);
    assert.ok(Math.abs(m.msd - 44795.99976) < 2e-5, `MSD ${m.msd}`);
    // LMST is MTC plus the east longitude in hours.
    assert.ok(Math.abs(marsTime(Date.UTC(2000, 0, 6), 90).lmstH - ((m.mtcH + 6) % 24)) < 1e-9);
});

test('Mars clock: Perseverance\'s sol 397 is 2 April 2022 (the Phobos transit), and the stamp text', () => {
    // NASA/JPL: Mastcam-Z filmed Phobos crossing the Sun on 2 April 2022, sol 397, at 08:20:37 LMST.
    const t = solLmst(397, 8 + 20 / 60 + 37 / 3600);
    assert.equal(new Date(t).toISOString().slice(0, 10), '2022-04-02');
    const m = marsTime(t, JEZERO.lonDeg);
    assert.equal(missionSol(JEZERO, m.msd), 397);
    assert.equal(marsClockText(m, JEZERO).text, 'Sol 397 · 08:20 LMST');
    // Before landing there is no mission sol: the stamp gives the local Mars Sol Date.
    const early = marsTime(Date.UTC(2020, 0, 1), JEZERO.lonDeg);
    assert.equal(missionSol(JEZERO, early.msd), null);
    assert.match(marsClockText(early, JEZERO).text, /^MSD \d{2},\d{3} · \d\d:\d\d LMST$/);
    assert.equal(hhmm(23.9999), '23:59');
    assert.equal(marsSiteNear(18.44, 77.45)?.id, 'jezero');
    assert.equal(marsSiteNear(0, 0), null);
});

test('Phobos crosses the Sun at Jezero within minutes of the sol-397 transit (mean elements)', () => {
    const t0 = solLmst(397, 8 + 20 / 60 + 37 / 3600);
    const snap = createSnapshot();
    let best = Infinity, bestDt = 0;
    for (let dt = -8 * 60e3; dt <= 8 * 60e3; dt += 10e3) {
        computeMarsSnapshot(t0 + dt, JEZERO, snap);
        const s = sep(snap.bodies[0].dirS, snap.mars.moons[0].dirS);
        if (s < best) { best = s; bestDt = dt; }
    }
    const sunR = snap.bodies[0].angDiamArcsec / 7200;
    assert.ok(best < sunR, `closest ${best.toFixed(3)}° (Sun's radius ${sunR.toFixed(3)}°): a transit`);
    assert.ok(Math.abs(bestDt) <= 5 * 60e3, `${(bestDt / 60e3).toFixed(1)} min from the observed time`);
});

test('Phobos rises in the west and Deimos in the east; Phobos keeps its sidereal period and distance', () => {
    const snap = createSnapshot();
    const t0 = Date.UTC(2026, 10, 4);
    const prev = [NaN, NaN];
    const rises = [[], []];
    for (let t = t0; t < t0 + 3 * 864e5; t += 60e3) {
        computeMarsSnapshot(t, JEZERO, snap);
        for (let k = 0; k < 2; k++) {
            const m = snap.mars.moons[k];
            if (prev[k] < 0 && m.altDeg >= 0) rises[k].push(m.azDeg);
            prev[k] = m.altDeg;
        }
    }
    assert.ok(rises[0].length >= 5, `Phobos rose ${rises[0].length} times in 3 sols`);
    for (const az of rises[0]) assert.ok(az > 180 && az < 360, `Phobos rises at az ${az}`);
    for (const az of rises[1]) assert.ok(az > 0 && az < 180, `Deimos rises at az ${az}`);
    const P = 0.31891023, a = new Float64Array(3), b = new Float64Array(3);
    const tt = AE.MakeTime(new Date(t0)).tt;
    marsMoonPosition(MARS_MOONS[0], tt, a);
    marsMoonPosition(MARS_MOONS[0], tt + P, b);
    const r = Math.hypot(...a);
    assert.ok(Math.abs(r - 9375) < 200, `Phobos at ${r.toFixed(0)} km`);
    assert.ok(sep(a.map((x) => x / r), b.map((x) => x / Math.hypot(...b))) < 1.5, 'back where it was after one sidereal period');
});

test('the Martian sky: the local frame agrees with the Mars24 clock, the Sun is two thirds the size, the Earth is slot 4', () => {
    const snap = createSnapshot();
    // At local true solar noon (Mars24) the Sun crosses the meridian of the IAU frame.
    const t0 = Date.UTC(2026, 10, 4, 6);
    let tNoon = NaN;
    for (let t = t0, prev = NaN; t < t0 + 1.1 * 864e5; t += 30e3) {
        const h = marsTime(t, JEZERO.lonDeg).ltstH;
        if (prev < 12 && h >= 12) { tNoon = t; break; }
        prev = h;
    }
    computeMarsSnapshot(tNoon, JEZERO, snap);
    const sun = snap.bodies[0];
    assert.ok(Math.abs(sun.azDeg - 180) < 1, `Sun azimuth at LTST noon ${sun.azDeg}`);
    assert.ok(Math.abs(sun.altDeg - marsSunAltDeg(snap.mars.time, JEZERO.latDeg)) < 0.5, 'clock altitude within 0.5°');
    const o = snap.observer;
    for (const [u, v] of [[o.upS, o.northS], [o.upS, o.eastS], [o.northS, o.eastS]]) assert.ok(Math.abs(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) < 1e-12);
    assert.deepEqual([...o.posS], [...o.upS], 'the eye stands where the zenith points');
    assert.equal(snap.host, 'mars');
    // The Sun from Mars: 1/r of its size from 1 AU (1.38–1.67 AU: 0.60–0.72 of 1919″).
    const k = sun.angDiamArcsec / 1919.3;
    assert.ok(k > 0.59 && k < 0.73, `Sun ${sun.angDiamArcsec.toFixed(0)}″`);
    // Slot 4 is the Earth: opposite the Earth's view of Mars (to light time and aberration), 3–22 light-minutes away.
    const earthSnap = computeSnapshot(tNoon, { latDeg: 0, lonDeg: 0 }, createSnapshot());
    const e = snap.bodies[EARTH_SLOT].geoDirS, m = earthSnap.bodies[EARTH_SLOT].geoDirS;
    assert.ok(sep(e, [-m[0], -m[1], -m[2]]) < 0.05, 'the Earth–Mars line, seen from both ends');
    assert.ok(snap.mars.earthLightS > 180 && snap.mars.earthLightS < 1345, `${snap.mars.earthLightS} s`);
    assert.ok(snap.bodies[EARTH_SLOT].mag > -3.5 && snap.bodies[EARTH_SLOT].mag < 2, `Earth mag ${snap.bodies[EARTH_SLOT].mag}`);
    // The Moon stays within 0.3° of the Earth from Mars.
    assert.ok(sep(snap.bodies[1].dirS, snap.bodies[EARTH_SLOT].dirS) < 0.3);
    // Back on the Earth the snapshot says so.
    computeSnapshot(tNoon, { latDeg: 0, lonDeg: 0 }, snap);
    assert.equal(snap.host, 'earth');
});

test('the host table keeps the BODIES contract: slot 4 shows the Earth, every id stays', () => {
    const mars = hostBodies('mars');
    assert.equal(mars.length, BODIES.length);
    assert.deepEqual(mars.map((b) => b.id), [...BODY_IDS]);
    assert.equal(mars[EARTH_SLOT], EARTH_TARGET);
    assert.equal(mars[EARTH_SLOT].name, 'Earth');
    assert.equal(mars[EARTH_SLOT].key, '5');
    assert.equal(hostBodies('earth'), BODIES);
    assert.equal(hostBodies(undefined), BODIES);
    assert.ok(Object.isFrozen(mars));
});

test('the moons of Mars are extra objects present only in a Mars snapshot; comets stay on the Earth', () => {
    const reg = createExtras();
    reg.register(createMarsMoonsProvider());
    reg.register({ kind: 'comet', kindLabel: 'Comet', host: 'earth', ids: () => ['comet:x'], meta: () => ({ name: 'X', color: '#fff', glyph: 'coma', label: 'always' }),
        fill: (s, id, st) => { st.present = true; st.dirS[0] = 1; } });
    const snap = createSnapshot();
    computeMarsSnapshot(Date.UTC(2026, 10, 4, 19, 40), JEZERO, snap);
    reg.fill(snap);
    assert.equal(reg.state(snap, 'moon:phobos').present, true);
    assert.equal(reg.state(snap, 'comet:x').present, false, 'an Earth-hosted provider is not drawn from Mars');
    assert.equal(reg.meta('moon:deimos').name, 'Deimos');
    assert.ok(reg.card('moon:phobos', snap).facts.length >= 4);
    computeSnapshot(Date.UTC(2026, 10, 4, 19, 40), { latDeg: 0, lonDeg: 0 }, snap);
    reg.fill(snap);
    assert.equal(reg.state(snap, 'moon:phobos').present, false);
    assert.equal(reg.state(snap, 'comet:x').present, true);
});

test('URL: host=mars with an optional hloc round-trips; Jezero is the default', () => {
    assert.deepEqual(parseHash('#host=mars').host, { id: 'mars', latDeg: 18.4447, lonDeg: 77.4508 });
    assert.deepEqual(parseHash('#host=mars&hloc=-4.5895,137.4417').host, { id: 'mars', latDeg: -4.5895, lonDeg: 137.4417 });
    assert.deepEqual(parseHash('#host=mars&hloc=95,0').invalid, ['hloc']);
    assert.deepEqual(parseHash('#host=venus').invalid, ['host']);
    assert.equal(parseHash('#host=earth').host, undefined);
    const st = { ...DEFAULT_STATE, view: { ...DEFAULT_STATE.view, mode: 'sky' } };
    assert.doesNotMatch(serializeHash({ state: st }), /host=/);
    assert.match(serializeHash({ state: { ...st, host: { ...DEFAULT_STATE.host, id: 'mars' } } }), /host=mars(?!&hloc)/);
    const h = serializeHash({ state: { ...st, host: { id: 'mars', latDeg: -4.5895, lonDeg: 137.4417 } } });
    assert.match(h, /host=mars&hloc=-4\.5895,137\.4417/);
    assert.deepEqual(parseHash(h).host, { id: 'mars', latDeg: -4.5895, lonDeg: 137.4417 });
});

test('no per-call allocation of typed arrays in the Mars snapshot (R5)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../js/astro/host-mars.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function computeMarsSnapshot'), src.indexOf('function eclipticLon'));
    assert.doesNotMatch(body, /new Float(32|64)Array/);
    const mt = createMarsTime();
    assert.equal(marsTimeTT(0, 0, mt), mt, 'the clock fills its out parameter');
});

/** UTC ms of a Perseverance mission sol at a local mean solar time (hours), by bisection. */
function solLmst(sol, lmstH) {
    const f = (t) => { const m = marsTime(t, JEZERO.lonDeg); return missionSol(JEZERO, m.msd) + m.lmstH / 24; };
    let lo = Date.UTC(2021, 1, 18, 21) + (sol - 1) * 88775244, hi = lo + 3 * 88775244;
    const target = sol + lmstH / 24;
    for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < target) lo = mid; else hi = mid;
    }
    return lo;
}

test('Find-it neighbours from Mars: slot 4 is the Earth, and the Earth’s Moon is no daytime landmark', async () => {
    const { guideRefs } = await import('../js/astro/sky-guide.js');
    const snap = createSnapshot();
    for (const h of [10.5, 19.5]) {
        computeMarsSnapshot(Date.UTC(2026, 10, 4, h, 30), JEZERO, snap, { detail: 'full' });
        const refs = guideRefs(snap, null);
        assert.ok(!refs.some((r) => r.name === 'Mars'), refs.map((r) => r.name).join());
        const earth = refs.find((r) => r.id === 'mars');
        if (h > 12) assert.equal(earth?.name, 'the Earth', 'by night the Earth is a signpost, by its name');
        // By day (the Sun 66° up) the Earth's Moon, mag +3, is not one (from the Earth it always is).
        assert.ok(!refs.some((r) => r.id === 'moon'), `${h} h: ${refs.map((r) => r.name).join()}`);
    }
});
