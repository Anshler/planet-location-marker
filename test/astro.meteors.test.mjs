// Meteor showers (astro/meteors.js): IMO-calendar peaks with precession, validity years, activity,
// rates and the deterministic meteor generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SHOWERS, SHOWER_INDEX, precessionDeg, showerValid, showerPeakMs, showerPeaks, zhrAt, radiantAt, hourlyRate,
    meteorLimitMag, eclipticLonJ2000, solarLonFromScene, hash01, poissonCount, meteorShape, sampleMagnitude, meteorAlpha,
    BRIGHTEST_MAG,
} from '../js/astro/meteors.js';
import { AE } from '../js/astro/ae.js';

const H = 3600e3;
const shower = (id) => SHOWERS[SHOWER_INDEX[id]];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('the table: thirteen annual showers, well-formed, J2000 solar longitudes', () => {
    assert.equal(SHOWERS.length, 13);
    for (const s of SHOWERS) {
        assert.ok(Object.isFrozen(s));
        assert.ok(s.peak >= 0 && s.peak < 360 && s.zhr > 0 && s.r > 1.5 && s.r < 3.5 && s.v >= 11 && s.v <= 72, s.id);
        assert.ok(s.ra >= 0 && s.ra < 360 && Math.abs(s.dec) <= 90, s.id);
        assert.ok(zhrAt(s, s.peak) === s.zhr, `${s.id} peaks at its ZHR`);
    }
    assert.deepEqual(['PER', 'GEM', 'QUA'].map((id) => shower(id).zhr), [100, 150, 80]);
});

test('IMO peak times: λ☉ J2000 + general precession, through AE.SearchSunLongitude', () => {
    // IMO Meteor Shower Calendars: Geminids 2023-12-14 19h and 2024-12-14 01h UT; Perseids 2024-08-12 13–16h UT;
    // Quadrantids 2025-01-03 15h UT.
    near(showerPeakMs(shower('GEM'), 2023), Date.parse('2023-12-14T19:00:00Z'), 1.5 * H, 'Geminids 2023');
    near(showerPeakMs(shower('GEM'), 2024), Date.parse('2024-12-14T01:00:00Z'), 1.5 * H, 'Geminids 2024');
    near(showerPeakMs(shower('PER'), 2024), Date.parse('2024-08-12T14:30:00Z'), 2 * H, 'Perseids 2024');
    near(showerPeakMs(shower('QUA'), 2025), Date.parse('2025-01-03T15:00:00Z'), 1.5 * H, 'Quadrantids 2025');
});

test('precession moves the peaks through the calendar: −13° in 1066, the Perseids in late July', () => {
    near(precessionDeg(Date.UTC(2000, 0, 1, 12)), 0, 1e-9, 'J2000');
    near(precessionDeg(Date.UTC(1066, 7, 1)), -13.05, 0.05, '1066');
    near(precessionDeg(Date.UTC(2999, 7, 1)), 13.98, 0.1, '2999');
    const per1066 = new Date(showerPeakMs(shower('PER'), 1066));
    // Proleptic Gregorian: the Sun reaches λ 127° (of date) on 30 July 1066 (24 July in the Julian calendar).
    assert.equal(per1066.getUTCMonth(), 6);
    assert.ok(per1066.getUTCDate() >= 28 && per1066.getUTCDate() <= 31, per1066.toISOString());
    // The Sun's longitude of date at that instant is the J2000 value plus precession.
    const lon = AE.SunPosition(AE.MakeTime(per1066)).elon;
    near(lon, 140.0 + precessionDeg(per1066.getTime()), 0.01, 'λ of date');
});

test('validity years: no Geminids before 1862 nor Quadrantids before 1835, and none after 2400', () => {
    assert.equal(showerValid(shower('GEM'), 1066), false);
    assert.equal(showerValid(shower('GEM'), 1862), true);
    assert.equal(showerValid(shower('QUA'), 1800), false);
    assert.equal(showerValid(shower('QUA'), 2026), true);
    assert.equal(showerValid(shower('QUA'), 2500), false);
    assert.equal(showerValid(shower('PER'), 1000), true);
    const ids = (from, days) => showerPeaks(from, from + days * 864e5).map((p) => p.shower.id);
    assert.ok(!ids(Date.UTC(1066, 0, 1), 365).includes('GEM'));
    assert.ok(ids(Date.UTC(1066, 0, 1), 365).includes('PER'));
    assert.ok(ids(Date.UTC(2026, 0, 1), 365).includes('GEM'));
    const minor = showerPeaks(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), { minZhr: 10 }).map((p) => p.shower.id);
    assert.ok(!minor.includes('CAP') && !minor.includes('STA') && minor.includes('URS'));
});

test('activity profile: the peak, an asymmetric Geminid fall-off, nothing outside the window', () => {
    const g = shower('GEM');
    assert.equal(zhrAt(g, 262.2), 150);
    assert.ok(zhrAt(g, 261.2) > zhrAt(g, 263.2), 'slower rise than fall');
    near(zhrAt(g, 261.2), 150 * 10 ** -0.39, 1e-9, 'B+');
    assert.equal(zhrAt(g, 240), 0);
    // A window across 0°: the Quadrantids, 276.6 … 291.1.
    assert.ok(zhrAt(shower('QUA'), 283.15) === 80 && zhrAt(shower('QUA'), 300) === 0);
    // Drift: the Perseid radiant moves east 1.4° a day.
    near(radiantAt(shower('PER'), 135).raDeg, 48 - 7, 1e-9, 'drift');
});

test('rates: HR = ZHR·sin h·r^(lm − 6.5) — Geminids at 60° under a 6.0 sky are about 80 an hour', () => {
    near(hourlyRate(150, 60, 6.0, 2.6), 80.6, 0.5, 'verifier example');
    near(hourlyRate(150, 90, 6.5, 2.6), 150, 1e-9, 'standard observer');
    near(hourlyRate(150, 90, 7.2, 2.6), 150, 1e-9, 'capped at 6.5');
    assert.equal(hourlyRate(150, -5, 6.5, 2.6), 0);
    // Limiting magnitude: pristine night → 6.5 (capped), city (≈ 18.2 mag/arcsec²) ≈ 4.1, twilight lower.
    near(meteorLimitMag(-40, 54), 6.5, 1e-9, 'pristine');
    const city = 34.08 * Math.exp(20.7233 - 0.92104 * 18.2);
    near(meteorLimitMag(-40, city), 4.1, 0.15, 'city');
    assert.ok(meteorLimitMag(-10, 54) < meteorLimitMag(-16, 54) && meteorLimitMag(-16, 54) < 6.5);
});

test('solar longitude from the scene frame matches the Sun\'s J2000 ecliptic longitude', () => {
    const t = AE.MakeTime(new Date(Date.UTC(2000, 11, 14, 12)));
    const v = AE.GeoVector('Sun', t, true);
    const l = Math.hypot(v.x, v.y, v.z);
    const eqj = [v.x / l, v.y / l, v.z / l];
    const scene = [eqj[0], eqj[2], -eqj[1]];
    near(solarLonFromScene(scene), eclipticLonJ2000(eqj), 1e-9, 'scene = EQJ');
    near(eclipticLonJ2000(eqj), AE.SunPosition(t).elon, 0.02, 'vs AE in 2000');
});

test('the generator is deterministic and well-distributed', () => {
    assert.equal(hash01(123456789012, 3, 4, 5), hash01(123456789012, 3, 4, 5));
    assert.notEqual(hash01(123456789012, 3, 4, 5), hash01(123456789013, 3, 4, 5));
    let sum = 0, n = 20000, sumU = 0;
    for (let i = 0; i < n; i++) {
        const u = hash01(i, 1, 2, 3);
        assert.ok(u >= 0 && u < 1);
        sumU += u;
        sum += poissonCount(2.5, hash01(i, 7, 7, 7));
    }
    near(sumU / n, 0.5, 0.01, 'uniform mean');
    near(sum / n, 2.5, 0.06, 'Poisson mean');
    assert.equal(poissonCount(0, 0.9), 0);
    const out = { offset: 0, psiDeg: 0, paDeg: 0, lenDeg: 0, durS: 0, u: 0 };
    for (let k = 0; k < 500; k++) {
        meteorShape(1e9 + k, 11, k % 5, 35, out);
        assert.ok(out.psiDeg >= 3 - 1e-9 && out.psiDeg <= 100 + 1e-9);
        assert.ok(out.durS >= 0.3 && out.durS <= 0.8);
        assert.ok(out.lenDeg > 0 && out.lenDeg <= 32);
        assert.ok(out.offset >= 0 && out.offset < 1);
    }
    // Slow Geminids last longer than fast Leonids, on average.
    const avg = (v) => { let s = 0; for (let k = 0; k < 300; k++) s += meteorShape(k, 0, 0, v, out).durS; return s / 300; };
    assert.ok(avg(35) > avg(71) + 0.1);
});

test('magnitudes follow the population index; alpha grows with brightness', () => {
    for (let i = 0; i < 200; i++) {
        const m = sampleMagnitude(i / 200, 2.6, 6.5);
        assert.ok(m >= BRIGHTEST_MAG - 1e-9 && m <= 6.5 + 1e-9);
    }
    // A steeper population (larger r) is fainter on average.
    const mean = (r) => { let s = 0; for (let i = 0; i < 400; i++) s += sampleMagnitude((i + 0.5) / 400, r, 6.5); return s / 400; };
    assert.ok(mean(3.0) > mean(2.1));
    assert.ok(meteorAlpha(-3) > meteorAlpha(1) && meteorAlpha(1) > meteorAlpha(5));
    assert.ok(meteorAlpha(-10) <= 2);
});
