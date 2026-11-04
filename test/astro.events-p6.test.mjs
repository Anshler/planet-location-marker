// Phase 6 event sources (astro/events.js): star occultations, Venus at greatest brilliancy, transits,
// lunar apsides, Saturn's ring-plane crossings and meteor showers, checked against published values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingEvents, OCCULTATION_STARS, fmtMeteorRate } from '../js/astro/events.js';
import { eventFraming } from '../js/app/actions.js';
import { AE } from '../js/astro/ae.js';

const DAY = 864e5, H = 3600e3;
const PARIS = { latDeg: 48.8566, lonDeg: 2.3522, elevM: 35, tz: 'Europe/Paris' };
const HCMC = { latDeg: 10.8231, lonDeg: 106.6297, elevM: 10, tz: 'Asia/Ho_Chi_Minh' };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${new Date(a).toISOString?.() ?? a} vs ${b} (±${tol})`);

const paris2026 = upcomingEvents(PARIS, Date.parse('2026-08-01T00:00:00Z'), 200);

test('Venus reaches greatest brilliancy on 2026-11-27 01:47 UT at mag −4.9 (AE.SearchPeakMagnitude)', () => {
    const ev = paris2026.filter((e) => e.kind === 'brilliancy');
    assert.equal(ev.length, 2, 'evening (Sep) and morning (Nov) peaks');
    const nov = ev.find((e) => e.tMs > Date.parse('2026-11-01'));
    near(nov.tMs, Date.parse('2026-11-27T01:47:00Z'), H, 'time');
    assert.match(nov.title, /^Venus at greatest brilliancy \(mag −4\.9\)$/);
    assert.match(nov.detail, /morning sky/);
    assert.equal(nov.select, 'venus');
});

test('the Mercury transit of 2032-11-13: contacts 06:41–11:07 UT, greatest 08:54 UT (NASA), partly seen from Paris', () => {
    const tr = upcomingEvents(PARIS, Date.parse('2032-11-01T00:00:00Z'), 30).filter((e) => e.kind === 'transit');
    assert.equal(tr.length, 1);
    const t = tr[0];
    assert.equal(t.bodyId, 'mercury');
    near(t.tMs, Date.parse('2032-11-13T08:54:00Z'), 3 * 60e3, 'greatest');
    near(t.startMs, Date.parse('2032-11-13T06:41:00Z'), 4 * 60e3, 'start');
    near(t.finishMs, Date.parse('2032-11-13T11:07:00Z'), 4 * 60e3, 'end');
    // Sunrise in Paris that day is about 07:10 UT: the start is below the horizon.
    assert.equal(t.visibleHere, true);
    assert.match(t.detail, /Partly visible from here: the Sun rises during it/);
    assert.equal(t.view, 'sky');
    const plan = eventFraming(t);
    assert.equal(plan.fovDeg, 2);
    assert.equal(plan.tMs, t.visibleMs);
    // No Venus transit in the app's near future (the next is in 2117).
    assert.equal(upcomingEvents(PARIS, Date.parse('2030-01-01T00:00:00Z'), 3000).filter((e) => e.kind === 'transit' && e.bodyId === 'venus').length, 0);
});

test('Saturn\'s 2038–39 ring-plane crossings are one event listing all three dates', () => {
    const list = upcomingEvents(PARIS, Date.parse('2038-06-01T00:00:00Z'), 500).filter((e) => e.kind === 'ring-plane');
    assert.equal(list.length, 1);
    const ev = list[0];
    assert.equal(ev.crossingsMs.length, 3);
    // Earth's ring-plane crossings: 2038-10-15, 2039-04-01, 2039-07-09.
    ['2038-10-15T12:00:00Z', '2039-04-01T12:00:00Z', '2039-07-09T12:00:00Z'].forEach((iso, i) => near(ev.crossingsMs[i], Date.parse(iso), 2 * DAY, `crossing ${i + 1}`));
    assert.equal(ev.tMs, ev.crossingsMs[0]);
    assert.match(ev.detail, /3 times: 1[45] Oct 2038, (31 Mar|1 Apr) 2039 and (8|9|10) Jul 2039/);
    assert.equal(ev.select, 'saturn');
    // Ring tilt really changes sign across each crossing.
    for (const ms of ev.crossingsMs) {
        const a = AE.Illumination('Saturn', AE.MakeTime(new Date(ms - 2 * DAY))).ring_tilt;
        const b = AE.Illumination('Saturn', AE.MakeTime(new Date(ms + 2 * DAY))).ring_tilt;
        assert.ok(a * b < 0);
    }
});

test('lunar apsides: the year\'s closest perigee is a perigee full Moon (2026-12-24), plus the farthest apogee', () => {
    const ev = upcomingEvents(PARIS, Date.parse('2026-01-01T00:00:00Z'), 364).filter((e) => e.kind === 'lunar-apsis');
    const closest = ev.find((e) => /closest of 2026/.test(e.title));
    assert.ok(closest, 'closest perigee listed');
    near(closest.tMs, Date.parse('2026-12-24T08:30:00Z'), 3 * H, 'perigee');
    assert.ok(closest.supermoon && closest.distKm > 356000 && closest.distKm < 357000, String(closest.distKm));
    // It is within a day of the full Moon.
    let q = AE.SearchMoonQuarter(AE.MakeTime(new Date(closest.tMs - 3 * DAY)));
    while (q.quarter !== 2) q = AE.NextMoonQuarter(q);
    assert.ok(Math.abs(q.time.date.getTime() - closest.tMs) < DAY);
    const far = ev.filter((e) => e.apsis === 'apogee');
    assert.equal(far.length, 1);
    assert.ok(far[0].distKm > 406000 && far[0].distKm < 406800, String(far[0].distKm));
    // Every perigee full Moon really is a perigee within a day of full.
    for (const e of ev.filter((x) => x.supermoon)) assert.match(e.title, /^Perigee full Moon/);
});

test('Moon–star occultations: geometry agrees with a direct check, gated to an observable Moon', () => {
    let found = 0;
    for (const site of [PARIS, HCMC, { latDeg: -33.87, lonDeg: 151.21, tz: 'Australia/Sydney' }]) {
        const list = upcomingEvents(site, Date.parse('2026-01-01T00:00:00Z'), 365).filter((e) => e.kind === 'occultation');
        const obs = new AE.Observer(site.latDeg, site.lonDeg, 0);
        for (const e of list) {
            found++;
            const star = OCCULTATION_STARS.find((s) => s.id === e.star);
            assert.ok(star, e.star);
            const t = AE.MakeTime(new Date(e.tMs));
            const m = AE.Equator('Moon', t, obs, false, false).vec;
            const D = Math.PI / 180;
            const v = [Math.cos(star.decDeg * D) * Math.cos(star.raDeg * D), Math.cos(star.decDeg * D) * Math.sin(star.raDeg * D), Math.sin(star.decDeg * D)];
            const l = Math.hypot(m.x, m.y, m.z);
            const sep = Math.acos((m.x * v[0] + m.y * v[1] + m.z * v[2]) / l) / D;
            assert.ok(Math.abs(sep - e.sepDeg) < 0.01, `${e.id}: ${sep} vs ${e.sepDeg}`);
            assert.ok(e.sepDeg < (star.cluster ? 1.0 : 0.5));
            const moonEq = AE.Equator('Moon', t, obs, true, true);
            assert.ok(AE.Horizon(t, obs, moonEq.ra, moonEq.dec, 'normal').altitude >= 3);
            if (!star.cluster) assert.equal(e.occultation, sep < Math.asin(1737.4 / (l * 149597870.7)) / D);
            assert.equal(e.select, 'moon');
            assert.equal(eventFraming(e).fovDeg, 5);
        }
    }
    assert.ok(found >= 5, `found ${found}`);
});

test('meteor showers: Geminids 2026 at their IMO peak, the best hour after dark, rates and the Moon', () => {
    const gem = paris2026.find((e) => e.kind === 'meteor-shower' && e.showerId === 'GEM');
    assert.ok(gem);
    near(gem.tMs, Date.parse('2026-12-14T13:45:00Z'), H, 'peak');
    assert.equal(gem.bodyId, null);
    assert.equal(gem.view, 'sky');
    assert.match(gem.title, /^Geminids meteor shower peaks \(ZHR 150\)$/);
    // The best hour is in darkness with the radiant high.
    const t = AE.MakeTime(new Date(gem.visibleMs));
    const obs = new AE.Observer(PARIS.latDeg, PARIS.lonDeg, 0);
    const sun = AE.Equator('Sun', t, obs, true, true);
    assert.ok(AE.Horizon(t, obs, sun.ra, sun.dec).altitude < -12);
    assert.ok(gem.radiantAltDeg > 40 && gem.rateDark > 40 && gem.rateDark <= 150);
    assert.match(gem.detail, /meteors an hour from a dark site \(illustrative\)/);
    assert.ok(gem.look && Math.abs(gem.look.altDeg) <= 55);
    const plan = eventFraming(gem);
    assert.equal(plan.tMs, gem.visibleMs);
    assert.equal(plan.play, false);
    // Light pollution lowers the rate "under this sky".
    const city = upcomingEvents(PARIS, Date.parse('2026-12-10T00:00:00Z'), 10, { skyLp: 40 }).find((e) => e.showerId === 'GEM');
    assert.ok(city.rateHere < city.rateDark / 3, `${city.rateHere} vs ${city.rateDark}`);
    assert.match(city.detail, /under this sky/);
    // Southern-sky showers from far north: the Eta Aquariids are low from Paris but fine from Ho Chi Minh City.
    const etaHcmc = upcomingEvents(HCMC, Date.parse('2027-05-01T00:00:00Z'), 10).find((e) => e.showerId === 'ETA');
    assert.ok(etaHcmc.rateDark > 10);
});

test('meteor showers respect history: no Geminids over Hastings in 1066, Leonids yes', () => {
    const list = upcomingEvents({ latDeg: 50.91, lonDeg: 0.49 }, Date.UTC(1066, 9, 1), 92).filter((e) => e.kind === 'meteor-shower');
    const ids = list.map((e) => e.showerId);
    assert.ok(!ids.includes('GEM') && !ids.includes('URS'));
    assert.ok(ids.includes('LEO') && ids.includes('ORI'));
    // 1066's Leonids peak about 13 days earlier in the (proleptic Gregorian) calendar than today's.
    const leo = list.find((e) => e.showerId === 'LEO');
    const d = new Date(leo.tMs);
    assert.equal(d.getUTCMonth(), 10);
    assert.ok(d.getUTCDate() >= 3 && d.getUTCDate() <= 6, d.toISOString());
});

test('meteor showers in a bright summer night: twilight is the reason, not the radiant', () => {
    // Tromsø (69.65° N): the Perseid radiant is circumpolar, but the Sun stays above −6° all night.
    const per = upcomingEvents({ latDeg: 69.65, lonDeg: 18.96 }, Date.UTC(2026, 7, 1), 30).find((e) => e.showerId === 'PER');
    assert.equal(per.visibleHere, false);
    assert.match(per.detail, /does not get dark here/);
    assert.doesNotMatch(per.detail, /below the horizon while/);
    // Helsinki: the Sun reaches only −11.5° at the Southern δ Aquariids' maximum; the hour counts, at a twilight rate.
    const sda = upcomingEvents({ latDeg: 60.17, lonDeg: 24.94 }, Date.UTC(2026, 6, 20), 20).find((e) => e.showerId === 'SDA');
    assert.equal(sda.visibleHere, true);
    assert.ok(sda.radiantAltDeg > 5 && sda.rateDark < 5, `${sda.radiantAltDeg} ${sda.rateDark}`);
    assert.match(sda.detail, /twilight hides the fainter meteors/);
});

test('rate wording', () => {
    assert.equal(fmtMeteorRate(0.2), 'fewer than 1');
    assert.equal(fmtMeteorRate(4.4), '4');
    assert.equal(fmtMeteorRate(83), '85');
});
