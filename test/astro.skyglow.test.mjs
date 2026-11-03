// Night-sky brightness (js/astro/skyglow.js): Krisciunas & Schaefer 1991 moonlight, the natural sky,
// Walker's-law light pollution from data/cities.json, SQM / Bortle / limiting magnitude, and the
// exposure and night-vision terms they feed (js/astro/photometry.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AE } from '../js/astro/ae.js';
import * as S from '../js/astro/skyglow.js';
import * as P from '../js/astro/photometry.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { createLoop } from '../js/app/loop.js';
import { createStore } from '../js/core/store.js';
import { createClock } from '../js/core/clock.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

const json = JSON.parse(fs.readFileSync(new URL('../data/cities.json', import.meta.url), 'utf8'));
const col = (k) => json.fields.indexOf(k);
const PLACES = json.rows.map((r) => ({ lat: r[col('lat')], lon: r[col('lon')], pop: r[col('pop')] }));

test('units: 22.0 mag/arcsec² is ≈ 54 nL, and nL ↔ SQM round-trips', () => {
    close(S.NATURAL_NL, 54.0, 0.1);
    for (const m of [16, 18.5, 20, 21.7, 22]) close(S.nlToSqm(S.sqmToNl(m)), m, 1e-9);
    assert.ok(S.sqmToNl(18) > S.sqmToNl(22));
});

test('KS91 X(Z) and the natural sky: 1 at the zenith, brighter toward the horizon (van Rhijn)', () => {
    close(S.ksAirmass(0), 1, 1e-12);
    close(S.ksAirmass(90), 5, 1e-9);
    close(S.naturalSky(0), 1, 1e-12);
    const hz = S.naturalSky(90);
    assert.ok(hz > 2.4 && hz < 3, `horizon ${hz}`);
    for (let z = 5; z <= 90; z += 5) assert.ok(S.naturalSky(z) > S.naturalSky(z - 5));
});

test('limitingMag (Schaefer / Unihedron NELM): 6.6 pristine, ~6.1 rural, ~4.1 in a city', () => {
    close(P.limitingMag(22), 6.62, 0.01);
    close(P.limitingMag(21), 6.12, 0.01);
    close(P.limitingMag(18.2), 4.13, 0.01);
    for (let m = 16; m < 22; m += 0.5) assert.ok(P.limitingMag(m + 0.5) > P.limitingMag(m));
    assert.equal(P.limitingMag(NaN), P.limitingMag(22));
});

test('KS91 moonlight: a full Moon at 60° makes the zenith ≈ 17.9 mag/arcsec², quarter Moon far less, none when set', () => {
    const full = S.moonSky(30, 0, 30, 0);
    const sqm = S.NATURAL_SQM - 2.5 * Math.log10(1 + full);
    assert.ok(sqm > 17.4 && sqm < 18.3, `full Moon zenith ${sqm}`);
    close(P.limitingMag(sqm), 3.9, 0.3, 'about magnitude 4 under a full Moon');
    const quarter = S.moonSky(30, 0, 30, 90);
    assert.ok(quarter < full / 5 && quarter > full / 20, `quarter ${quarter}`);
    assert.ok(S.moonSky(10, 20, 30, 0) > full, 'brighter near the Moon (Mie aureole)');
    assert.ok(S.moonSky(120, 0, 30, 0) < full, 'fainter far from it');
    assert.equal(S.moonSky(30, 0, 95, 0), 0, 'Moon below the horizon');
    assert.ok(S.moonSky(30, 0, 30, 0, S.K_V, 1e-4) < full * 1e-3, 'an eclipsed Moon lights almost nothing');
    // The Rayleigh/Mie split the shader colours separately.
    const f = S.moonScatter(30);
    close(f.rayleigh, Math.pow(10, 5.36) * (1.06 + 0.75), 1);
    close(f.mie, Math.pow(10, 6.15 - 0.75), 1);
    assert.deepEqual(S.moonScatter(2), S.moonScatter(10), 'held at 10°');
});

test('Bortle classes from SQM, and the manual classes land in their own class', () => {
    assert.equal(S.bortleFromSqm(22), 1);
    assert.equal(S.bortleFromSqm(21.9), 2);
    assert.equal(S.bortleFromSqm(21.0), 4);
    assert.equal(S.bortleFromSqm(19.0), 6);
    assert.equal(S.bortleFromSqm(18.0), 8);
    assert.equal(S.bortleFromSqm(17.0), 9);
    for (let b = 1; b <= 9; b++) {
        const s = S.manualSite(String(b));
        assert.equal(s.bortle, b, `class ${b}`);
        assert.equal(s.auto, false);
        for (const x of s.dome) close(x, 1.6 * s.zenith, 1e-12, 'uniform dome');
    }
    const p = S.manualSite('pristine');
    assert.equal(p.zenith, 0);
    assert.equal(p.bortle, 1);
    assert.equal(p.sqm, S.NATURAL_SQM);
    assert.equal(S.manualSite('x').setting, 'pristine');
});

test('Walker\'s law: a distant city is a dome on its own horizon that matches 0.01·P·d^−2.5 at 45°', () => {
    // A city of 2 million 60 km due east of the observer (on the equator).
    const city = { lat: 0, lon: 60 / 111.195, pop: 2e6 };
    const s = S.lightPollution(0, 0, [city]);
    assert.equal(s.cities, 1);
    const east = S.lpAt(s, 45, 90), west = S.lpAt(s, 45, 270);
    const W = S.walkerGlow(2e6, 60), core = S.cityCoreGlow(2e6);
    close(east, 1 / (1 / W + 1 / core), 0.12 * W, '45° toward the city');
    assert.ok(east > 2.5 * west,`toward ${east} vs away ${west}`);
    assert.ok(S.lpAt(s, 0, 90) > S.lpAt(s, 45, 90) && S.lpAt(s, 45, 90) > S.lpAt(s, 90, 90), 'brightest at the horizon');
    close(S.lpAt(s, 90, 0), s.zenith, 1e-12);
    const k = s.dome.indexOf(Math.max(...s.dome));
    assert.equal(k, 4, 'the brightest bin points east');
    // Nothing past LP_RADIUS_KM; nothing at all is pristine.
    assert.equal(S.lightPollution(0, 0, [{ lat: 0, lon: 3.5, pop: 2e7 }]).zenith, 0);
    const none = S.lightPollution(0, 0, []);
    assert.equal(none.zenith, 0);
    assert.equal(none.bortle, 1);
    assert.equal(S.lightPollution(NaN, 0, PLACES).zenith, 0);
});

test('light pollution from data/cities.json: big cities are Bortle 9, Atacama and Mauna Kea pristine', () => {
    const at = (lat, lon) => S.lightPollution(lat, lon, PLACES);
    for (const [name, lat, lon] of [['Ho Chi Minh City', 10.82, 106.63], ['Paris', 48.86, 2.35], ['New York', 40.71, -74.0]]) {
        const s = at(lat, lon);
        assert.ok(s.bortle >= 8, `${name}: Bortle ${s.bortle} (SQM ${s.sqm.toFixed(2)})`);
        assert.ok(s.sqm > 16 && s.sqm < 18.4, `${name}: SQM ${s.sqm}`);
        assert.ok(P.limitingMag(s.sqm) < 4.2, `${name}: limit ${P.limitingMag(s.sqm)}`);
    }
    for (const [name, lat, lon] of [['Paranal', -24.6, -70.4], ['Mauna Kea', 19.82, -155.47]]) {
        const s = at(lat, lon);
        assert.ok(s.bortle <= 2, `${name}: Bortle ${s.bortle}`);
    }
    // siteFor: 'auto' estimates, anything else is manual; the same object is refilled.
    const out = S.createSite();
    assert.equal(S.siteFor({ latDeg: 10.82, lonDeg: 106.63 }, PLACES, 'auto', out), out);
    assert.equal(out.auto, true);
    assert.ok(out.bortle >= 8);
    S.siteFor({ latDeg: 10.82, lonDeg: 106.63 }, PLACES, 'pristine', out);
    assert.equal(out.zenith, 0);
    assert.equal(out.auto, false);
    S.siteFor(null, null, '3', out);
    assert.equal(out.bortle, 3);
});

/** The night of the full Moon after `iso`, at the hour the Moon is highest at `o`. */
function fullMoonNight(iso, o) {
    const t0 = AE.SearchMoonPhase(180, AE.MakeTime(new Date(iso)), 40).date.getTime();
    const snap = createSnapshot();
    let best = t0, bestAlt = -90;
    for (let h = -14; h <= 14; h += 0.5) {
        computeSnapshot(t0 + h * 36e5, o, snap);
        if (snap.bodies[1].altDeg > bestAlt && snap.observer.sunAltDeg < -18) { bestAlt = snap.bodies[1].altDeg; best = t0 + h * 36e5; }
    }
    return best;
}

test('computeSkyglow: a dark site under a full Moon and on a moonless night, a city, and daylight', () => {
    const atacama = { latDeg: -24.6, lonDeg: -70.4, elevM: 0 };
    const snap = createSnapshot();
    const sg = snap.skyglow;
    assert.ok(sg && sg.lpDome.length === S.LP_BINS, 'snapshots carry a skyglow');
    const site = S.lightPollution(atacama.latDeg, atacama.lonDeg, PLACES);
    // Full Moon high: about magnitude 4, the Milky Way washed out, no zodiacal light.
    computeSnapshot(fullMoonNight('2027-01-01T00:00:00Z', atacama), atacama, snap);
    assert.equal(S.computeSkyglow(snap, site, sg), sg);
    assert.ok(sg.moonW > 0);
    assert.ok(sg.limitMag < 4.6 && sg.limitMag > 3, `full Moon limit ${sg.limitMag}`);
    assert.ok(sg.milkyWay < 0.25, `Milky Way contrast ${sg.milkyWay}`);
    assert.equal(sg.milkyWayMax, 1, 'without the Moon this site keeps it');
    assert.ok(sg.darkness < 0.05, `darkness ${sg.darkness}`);
    assert.equal(sg.bortle, site.bortle);
    // Same site, new Moon (the Moon below the horizon at midnight).
    const nm = AE.SearchMoonPhase(0, AE.MakeTime(new Date('2027-01-01T00:00:00Z')), 40).date.getTime();
    computeSnapshot(nm + 4 * 36e5, atacama, snap);
    S.computeSkyglow(snap, site, sg);
    assert.ok(sg.limitMag > 6.5, `moonless limit ${sg.limitMag}`);
    assert.ok(sg.milkyWay > 0.95 && sg.darkness > 0.95);
    // A moonless night in Ho Chi Minh City: Bortle 9, about magnitude 3, no Milky Way at all.
    const hcmc = { latDeg: 10.82, lonDeg: 106.63, elevM: 0 };
    computeSnapshot(nm + 16 * 36e5, hcmc, snap);
    S.computeSkyglow(snap, S.lightPollution(hcmc.latDeg, hcmc.lonDeg, PLACES), sg);
    assert.equal(sg.bortle, 9);
    assert.ok(sg.limitMag < 4, `HCMC limit ${sg.limitMag}`);
    assert.equal(sg.milkyWayMax, 0);
    // By day the dome terms are off; a null site is pristine.
    computeSnapshot(Date.parse('2027-06-21T12:00:00Z'), { latDeg: 0, lonDeg: 0, elevM: 0 }, snap);
    S.computeSkyglow(snap, null, sg);
    assert.equal(sg.domeGain, 0);
    assert.equal(sg.lpZenith, 0);
    assert.equal(sg.setting, 'pristine');
});

test('skyAt agrees with the zenith summary and grows toward the Moon and the city glow', () => {
    const snap = createSnapshot();
    const o = { latDeg: -24.6, lonDeg: -70.4, elevM: 0 };
    computeSnapshot(fullMoonNight('2027-01-01T00:00:00Z', o), o, snap);
    const sg = S.computeSkyglow(snap, S.manualSite('6'), snap.skyglow);
    const moonAlt = snap.bodies[1].altDeg;
    close(S.skyAt(sg, 90, 0, 90 - moonAlt, moonAlt), sg.zenithR, 1e-9, 'zenith');
    assert.ok(S.skyAt(sg, moonAlt, snap.bodies[1].azDeg, 15, moonAlt) > sg.zenithR);
});

test('exposureFor: the sky term caps the stars at the night sky\'s own limit; vision follows the adapting luminance', () => {
    const sky = { limitMag: 4.0, zenithNl: S.NATURAL_NL * 40 };
    for (const lim of [5, 6, 6.5]) {
        const e = P.exposureFor(-40, 1, undefined, 0, lim, sky);
        close(P.starLimitMag(e.stars, lim), 4.0, 1e-9, `tier ${lim}`);
        assert.equal(e.milkyWay, 1, 'the Milky Way is faded in the shader, per direction');
    }
    // A pristine sky (or none) leaves the dark-sky exposure alone; orbit view stays 1.
    assert.equal(P.exposureFor(-40, 1, undefined, 0, 6.5, { limitMag: 6.62, zenithNl: S.NATURAL_NL }).stars, 1);
    assert.equal(P.exposureFor(-40, 0, undefined, 0, 6.5, sky).stars, 1);
    assert.equal(P.exposureFor(-40, 0, undefined, 0, 6.5, sky).vision, 0);
    // Twilight still wins when it is the brighter sky.
    assert.ok(P.exposureFor(-8, 1, undefined, 0, 6.5, sky).stars < P.starExposureForLimit(4, 6.5));
    // Adapting luminance: about 1 cd/m² at the end of civil twilight, ~2e-4 at night; rods take over below ~5e-3.
    close(Math.log10(P.adaptingLuminance(-6)), 0, 0.05);
    assert.ok(P.adaptingLuminance(-30) < 3e-4 && P.adaptingLuminance(-30) > 1e-4);
    assert.ok(P.adaptingLuminance(-30, S.NATURAL_NL * 40) > 10 * P.adaptingLuminance(-30));
    let prev = Infinity;
    for (let a = 30; a >= -30; a -= 2) {
        const l = P.adaptingLuminance(a);
        assert.ok(l <= prev, `monotonic at ${a}`);
        prev = l;
    }
    assert.ok(P.adaptingLuminance(40, 54, 1) < P.adaptingLuminance(40) * 1e-3, 'totality darkens it');
    assert.equal(P.scotopicWeight(1000), 0);
    assert.equal(P.scotopicWeight(1e-4), 1);
    const mid = P.scotopicWeight(0.1);
    assert.ok(mid > 0.3 && mid < 0.9, `mesopic ${mid}`);
    assert.equal(P.exposureFor(30, 1).vision, 0, 'daylight: cones');
    assert.equal(P.exposureFor(-30, 1).vision, 1, 'a dark night: rods');
});

test('the GLSL model mirrors the JS one (constants), and the panels state the sky class', async () => {
    const { SKYGLOW_CHUNK } = await import('../js/render/shaders/skyglow.glsl.js');
    const num = (re) => Number(SKYGLOW_CHUNK.match(re)[1]);
    close(num(/exp\(-asin\(clamp\(cz, 0\.0, 1\.0\)\) \/ ([\d.]+)\)/), (S.LP_ALT_SCALE_DEG * Math.PI) / 180, 1e-6, 'altitude scale');
    close(num(/\) - ([\d.]+)\) \/ [\d.]+;/), Math.exp(-90 / S.LP_ALT_SCALE_DEG), 1e-6, 'e^(−90/s)');
    close(num(/vec2\(([\d.]+) \* \(1\.06 \+ cr \* cr\)/), Math.pow(10, 5.36), 0.01, 'KS91 Rayleigh');
    assert.match(SKYGLOW_CHUNK, /exp\(2\.302585 \* \(6\.15 - rho \/ 40\.0\)\)/, 'KS91 Mie');
    assert.match(SKYGLOW_CHUNK, /uniform float uSgLp\[16\];/);
    assert.equal(S.LP_BINS, 16);
    assert.match(SKYGLOW_CHUNK, /22\.0 - 1\.0857362 \* log/, 'natural sky = 22.0 mag/arcsec²');
    assert.equal(S.NATURAL_SQM, 22.0);
    assert.match(SKYGLOW_CHUNK, /7\.93 - 2\.1714724 \* log\(exp\(2\.302585 \* \(4\.316 - sqm \/ 5\.0\)\) \+ 1\.0\)/, 'limitingMag');
    const { MW_FRAG } = await import('../js/render/shaders/sky.glsl.js');
    assert.match(MW_FRAG, /1\.0 - smoothstep\(0\.1, 3\.4, ex\)/, 'milkyWayContrast');
    assert.match(MW_FRAG, /1\.0 - smoothstep\(0\.1, 1\.5, ex\)/, 'darkSkyGate');
    close(S.milkyWayContrast(0), 1, 1e-12);
    assert.equal(S.milkyWayContrast(3.5), 0);
    assert.equal(S.darkSkyGate(1.6), 0);
    // The Sky panel line (text mode included).
    const { skyDarknessText } = await import('../js/ui/sky-now.js');
    assert.equal(skyDarknessText({ skyglow: { bortle: 8, limitMag: 4.06 }, observer: { sunAltDeg: -30 } }), 'Bortle 8 · limiting mag 4.1');
    assert.equal(skyDarknessText({ skyglow: { bortle: 8, limitMag: 4.06 }, observer: { sunAltDeg: 20 } }), 'Bortle 8 sky');
    assert.equal(skyDarknessText({}), '');
});

test('the frame loop fills snap.skyglow from its site and recomputes it on setSkySite', () => {
    const queue = [];
    const win = { requestAnimationFrame(fn) { queue.push(fn); return queue.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} };
    const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    const observer = { latDeg: 10.82, lonDeg: 106.63, elevM: 0, name: 'HCMC', country: 'VN', tz: 'Asia/Ho_Chi_Minh', tzApprox: false, source: 'url' };
    const store = createStore({ observer, status: { phase: 'ready', reducedMotion: false, introPlaying: false } });
    const clock = createClock({ tMs: Date.parse('2027-01-08T15:00:00Z'), playing: false });
    const readouts = [];
    const loop = createLoop({ clock, store, bus: { emit(ev, s) { if (ev === 'readout') readouts.push(s.skyglow.bortle); } }, win, doc });
    let now = 1000;
    const step = (n) => { for (let i = 0; i < n; i++) { const fns = queue.splice(0); for (const fn of fns) fn(now); now += 300; } };
    loop.start();
    step(3);
    assert.equal(loop.snapFull.skyglow.bortle, 1, 'no site yet: pristine');
    const site = S.lightPollution(observer.latDeg, observer.lonDeg, PLACES);
    loop.setSkySite(site);
    step(2);
    assert.equal(loop.snapFull.skyglow.bortle, 9);
    assert.equal(loop.snapFull.skyglow.auto, true);
    S.manualSite('3', site);
    loop.setSkySite(site);
    step(2);
    assert.equal(loop.snapFull.skyglow.bortle, 3);
    assert.ok(readouts.includes(9) && readouts.at(-1) === 3, `readouts ${readouts}`);
    loop.dispose();
});
