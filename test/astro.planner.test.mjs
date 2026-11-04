// The year planner (astro/planner.js) and the Sun's paths (astro/sunpath.js), checked against
// astronomy-engine directly and against published geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { visibilityYear, plannerSummary, plannerVisible, PLANNER_BODIES } from '../js/astro/planner.js';
import { sunFigures } from '../js/astro/sunpath.js';
import { runOp } from '../js/astro/worker.js';
import { AE } from '../js/astro/ae.js';

const DAY = 864e5;
const PARIS = { latDeg: 48.8566, lonDeg: 2.3522, elevM: 35 };
// Paris standard time is UTC+1: local midnight on 1 Nov 2026 is 23:00 UT on 31 Oct.
const FIRST = Date.UTC(2026, 10, 1) - 3600e3;
const year = visibilityYear(PARIS, FIRST);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const dateOf = (i) => FIRST + i * DAY;

test('the grid: 365 nights × 55 samples (15:00–09:00 every 20 min), every planet', () => {
    assert.equal(year.nights, 365);
    assert.equal(year.samples, 55);
    assert.equal(year.startMin, -540);
    assert.deepEqual(Object.keys(year.bodies), [...PLANNER_BODIES]);
    for (const id of PLANNER_BODIES) {
        const b = year.bodies[id];
        assert.equal(b.alt.length, 365 * 55);
        assert.ok(b.mag.every(Number.isFinite), `${id} magnitudes filled`);
    }
    assert.throws(() => visibilityYear(PARIS, NaN), TypeError);
});

test('altitudes agree with AE.Horizon to about a degree (no refraction, the Moon without parallax)', () => {
    const obs = new AE.Observer(PARIS.latDeg, PARIS.lonDeg, PARIS.elevM);
    for (const [i, j] of [[0, 0], [40, 27], [100, 54], [200, 13], [364, 40]]) {
        const t = AE.MakeTime(new Date(dateOf(i) + (year.startMin + j * year.stepMin) * 60e3));
        for (const [name, row, tol] of [['Sun', year.sun, 1.2], ['Jupiter', year.bodies.jupiter.alt, 1.2], ['Moon', year.moon, 2.5]]) {
            const eq = AE.Equator(name, t, obs, true, true);
            const alt = AE.Horizon(t, obs, eq.ra, eq.dec).altitude;
            near(row[i * year.samples + j], alt, tol, `${name} night ${i} sample ${j}`);
        }
    }
    // Solar midnight in Paris (≈ 23:50 UT, sample 29 = 23:40 UT) near the December solstice: the Sun 90° − 48.86° − 23.44° = 64.6° below.
    near(year.sun[51 * year.samples + 29], -64.6, 1.1, 'December midnight Sun');
});

test('Jupiter and Uranus: best around their oppositions (2027-02-10 and 2026-11-25), brightest there', () => {
    const jup = plannerSummary(year, 'jupiter');
    const opp = Math.round((Date.parse('2027-02-10T12:00:00Z') - FIRST) / DAY);
    assert.ok(jup.bestFrom <= opp && opp <= jup.bestTo, `${jup.bestFrom}…${jup.bestTo} vs ${opp}`);
    assert.ok(Math.abs(jup.brightestNight - opp) <= 6, String(jup.brightestNight));
    assert.ok(jup.peakAltDeg > 55 && jup.peakAltDeg < 64, String(jup.peakAltDeg));   // Dec ≈ +16° → 57° at transit
    assert.ok(jup.brightestMag < -2.4 && jup.brightestMag > -2.8);
    const ura = plannerSummary(year, 'uranus');
    assert.ok(Math.abs(ura.brightestNight - 24) <= 6, String(ura.brightestNight));
    // Mercury is only an occasional evening or morning sight.
    const mer = plannerSummary(year, 'mercury');
    assert.ok(mer.visibleNights > 0 && mer.visibleNights < 80, String(mer.visibleNights));
    assert.ok(plannerSummary(year, 'pluto') === null);
});

test('visibility needs darkness, altitude and distance from the Sun', () => {
    const S = year.samples;
    for (let i = 0; i < 365; i += 13) {
        for (let j = 0; j < S; j += 5) {
            if (!plannerVisible(year, 'mars', i, j)) continue;
            assert.ok(year.bodies.mars.alt[i * S + j] >= 10);
            assert.ok(year.sun[i * S + j] <= -6);
            assert.ok(year.bodies.mars.elong[i] >= 12);
        }
    }
});

test('the worker serves the planner and the Sun figures', () => {
    const y = runOp('visibilityYear', { observer: PARIS, firstMidnightMs: FIRST, nights: 10, bodyIds: ['mars'] });
    assert.equal(y.nights, 10);
    assert.deepEqual(Object.keys(y.bodies), ['mars']);
    const f = runOp('sunFigures', { observer: PARIS, tMs: Date.UTC(2026, 10, 4, 12) });
    assert.deepEqual(f.arcs.map((a) => a.key), ['today', 'june', 'december', 'march']);
});

test('Sun paths at Paris: solstice noon altitudes, rise and set azimuths, the equinox due east', () => {
    const f = sunFigures(PARIS, Date.UTC(2026, 10, 4, 12));
    const arc = (k) => f.arcs.find((a) => a.key === k);
    // Noon altitude 90° − φ ± ε (plus ~0.03° of refraction), to the 10-minute sampling.
    near(arc('june').noonAltDeg, 90 - 48.8566 + 23.44, 0.25, 'June noon');
    near(arc('december').noonAltDeg, 90 - 48.8566 - 23.44, 0.25, 'December noon');
    near(arc('march').noonAltDeg, 90 - 48.8566, 0.4, 'equinox noon');
    // Paris solstice azimuths at the upper limb's rise and set (AE.SearchRiseSet): 51.6°/308.4°
    // in June, 126.0°/234.0° in December. The −0.833° standard is a geometric altitude.
    near(arc('june').riseAzDeg, 51.6, 0.2, 'June sunrise');
    near(arc('june').setAzDeg, 308.4, 0.2, 'June sunset');
    near(arc('december').riseAzDeg, 126.0, 0.2, 'December sunrise');
    near(arc('december').setAzDeg, 234.0, 0.2, 'December sunset');
    near(arc('march').riseAzDeg, 89, 1.5, 'equinox sunrise');
    // Local frame: x east, y up, z south — the noon Sun stands due south.
    const t = arc('today');
    let best = 0;
    for (let k = 0; k < t.alt.length; k++) if (t.alt[k] > t.alt[best]) best = k;
    assert.ok(t.points[3 * best + 2] > 0.5 && Math.abs(t.points[3 * best]) < 0.1, 'south at noon');
    near(Math.hypot(t.points[0], t.points[1], t.points[2]), 1, 1e-6, 'unit vectors');
});

test('Sun paths: rise and set azimuths match AE.SearchRiseSet at high latitude', () => {
    // At 65° N in June the Sun skims the horizon, so a wrong rise altitude moves the azimuth by degrees.
    for (const [observer, key] of [[{ latDeg: 65, lonDeg: 25, elevM: 0 }, 'june'], [{ latDeg: 66, lonDeg: 25, elevM: 0 }, 'december'], [PARIS, 'june']]) {
        const f = sunFigures(observer, Date.UTC(2026, 10, 4, 12));
        const arc = f.arcs.find((a) => a.key === key);
        const obs = new AE.Observer(observer.latDeg, observer.lonDeg, observer.elevM);
        const azAt = (dir) => {
            const ev = AE.SearchRiseSet('Sun', obs, dir, AE.MakeTime(new Date(arc.startMs)), 1);
            const eq = AE.Equator('Sun', ev, obs, true, true);
            return AE.Horizon(ev, obs, eq.ra, eq.dec, 'normal').azimuth;
        };
        near(arc.riseAzDeg, azAt(+1), 0.2, `${observer.latDeg}° ${key} sunrise`);
        near(arc.setAzDeg, azAt(-1), 0.2, `${observer.latDeg}° ${key} sunset`);
    }
    const f65 = sunFigures({ latDeg: 65, lonDeg: 25, elevM: 0 }, Date.UTC(2026, 10, 4, 12));
    near(f65.arcs.find((a) => a.key === 'june').riseAzDeg, 13.5, 0.3, '65° N June sunrise');
});

test('the noon analemma and the subsolar figure-8', () => {
    const f = sunFigures(PARIS, Date.UTC(2026, 10, 4, 12));
    const a = f.analemma;
    assert.equal(a.days, 365);
    near(Math.max(...a.alt), 64.6, 0.3, 'top of the 8');
    near(Math.min(...a.alt), 17.7, 0.3, 'bottom of the 8');
    // The equation of time swings the noon Sun ±4° in hour angle: at this latitude a few degrees of azimuth.
    assert.ok(Math.max(...a.az) - 180 > 2 && 180 - Math.min(...a.az) > 2 && Math.max(...a.az) < 190 && Math.min(...a.az) > 170);
    assert.equal(a.markers.length, 4);
    assert.ok(a.markers[1] >= 170 && a.markers[1] <= 173, 'June solstice day of year');
    const s = f.subsolar;
    assert.equal(s.utMin, 720);
    let latMin = 90, latMax = -90, lonMin = 180, lonMax = -180;
    for (let d = 0; d < s.days; d++) {
        latMin = Math.min(latMin, s.latLon[2 * d]); latMax = Math.max(latMax, s.latLon[2 * d]);
        lonMin = Math.min(lonMin, s.latLon[2 * d + 1]); lonMax = Math.max(lonMax, s.latLon[2 * d + 1]);
    }
    near(latMax, 23.44, 0.05, 'Tropic of Cancer');
    near(latMin, -23.44, 0.05, 'Tropic of Capricorn');
    // At 12:00 UT the subsolar point swings −4.1° … +3.6° about Greenwich (the equation of time, −14 … +16 min).
    near(lonMin, -4.1, 0.2, 'west extreme');
    near(lonMax, 3.6, 0.2, 'east extreme');
    assert.equal(s.todayIndex, 307);
});
