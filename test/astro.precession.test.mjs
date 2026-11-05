// The time-machine sky: the pole and equinox of date (astro/precession.js), proper motion
// (data/catalog.js applyProperMotion) and the max tier's deeper stars (mergeDeepStars,
// data/stars8.json), against published values and a rigorous space-motion calculation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { poleOfDate, equinoxOfDate, poleOnCircle, eclipticPole, poleTrack, equinoxConstellation, angleDeg, yearToMs, POLE_STARS,
    OBLIQUITY_J2000_DEG } from '../js/astro/precession.js';
import { decodeSky, applyProperMotion, mergeDeepStars, yearsFromJ2000 } from '../js/data/catalog.js';
import { raDecToScene } from '../js/astro/frames.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const SKY = read('data/sky.json');
const starDir = (cat, hip) => {
    const i = cat.stars.hip.indexOf(hip);
    return [cat.stars.dirS[3 * i], cat.stars.dirS[3 * i + 1], cat.stars.dirS[3 * i + 2]];
};

test('Polaris and the pole of date: 6.21° in 1000, 0.74° in 2000, 0.63° in 2026, 0.46° in 2100, 5.05° in 3000', () => {
    const cat = decodeSky(SKY);
    const pol = starDir(cat, 11767);
    for (const [year, want] of [[1000, 6.21], [2000, 0.74], [2026, 0.63], [2100, 0.46], [3000, 5.05]]) {
        const got = angleDeg(poleOfDate(yearToMs(year)), pol);
        assert.ok(Math.abs(got - want) < 0.015, `${year}: ${got.toFixed(3)}° vs ${want}°`);
    }
});

test('the pole of date is the snapshot\'s Earth axis (earthMatrix·ŷ) and the grid of date\'s x̂ the equinox', () => {
    const s = createSnapshot();
    const t = Date.UTC(1066, 3, 24, 21);
    computeSnapshot(t, { latDeg: 48.85, lonDeg: 2.35, elevM: 0 }, s, { detail: 'frame' });
    const E = s.earthMatrix;
    assert.ok(angleDeg([E[4], E[5], E[6]], poleOfDate(t)) < 1e-6);
    // S·PN·Sᵀ = earthMatrix · RotY(−GAST): its first column is the March equinox of date.
    const g = -s.gastDeg * Math.PI / 180;
    const c = Math.cos(g), sn = Math.sin(g);
    // Column 0 of E·RotY(g) = E·(cos g, 0, −sin g).
    const x = [E[0] * c - E[8] * sn, E[1] * c - E[9] * sn, E[2] * c - E[10] * sn];
    assert.ok(angleDeg(x, equinoxOfDate(t)) < 1e-6);
});

test('the illustrative circle follows Astronomy Engine within 0.03° over 1000–3000; the track samples it', () => {
    for (let y = 1000; y <= 3000; y += 250) {
        const d = angleDeg(poleOfDate(yearToMs(y)), poleOnCircle(y));
        assert.ok(d < 0.03, `${y}: ${d}`);
    }
    assert.ok(Math.abs(angleDeg(eclipticPole(), [0, 1, 0]) - OBLIQUITY_J2000_DEG) < 1e-9);
    const tr = poleTrack(1000, 3000, 100);
    assert.equal(tr.length, 3 * 21);
    assert.ok(angleDeg(tr.subarray(0, 3), poleOfDate(yearToMs(1000))) < 1e-12);
});

test('the pole stars of other ages lie near the circle at their year; Thuban 2830 BCE within 0.3°', () => {
    const cat = decodeSky(SKY);
    for (const s of POLE_STARS) {
        const d = angleDeg(poleOnCircle(s.year), starDir(cat, s.hip));
        assert.ok(d < (s.name === 'Deneb' ? 7.5 : s.name === 'Vega' ? 5 : 2.5), `${s.name} ${d.toFixed(2)}°`);
    }
    assert.ok(angleDeg(poleOnCircle(-2830), starDir(cat, 68756)) < 0.3);
});

test('the March equinox point drifts from Pisces into Aquarius between 2597 and 2600', () => {
    assert.equal(equinoxConstellation(yearToMs(2026)).symbol, 'Psc');
    assert.equal(equinoxConstellation(yearToMs(2596)).symbol, 'Psc');
    assert.equal(equinoxConstellation(yearToMs(2600)).symbol, 'Aqr');
    assert.equal(equinoxConstellation(yearToMs(1000)).symbol, 'Psc');
});

/** Rigorous space motion (Hipparcos Vol. 1 §1.2.8): position + velocity in 3-D, then the direction. */
function spaceMotion(raDeg, decDeg, plxMas, pmraMas, pmdeMas, rvKms, years) {
    const a = raDeg * Math.PI / 180, d = decDeg * Math.PI / 180;
    const p = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    const ea = [-Math.sin(a), Math.cos(a), 0];
    const ed = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
    const AU_KMS_YR = 4.740470446;   // 1 au/yr in km/s
    const rPc = 1000 / plxMas;
    // Velocity in pc/yr: tangential μ·r, radial vr.
    const mas = Math.PI / (180 * 3600e3);
    const vt = (m) => m * mas * rPc;
    const vr = rvKms / AU_KMS_YR / 206264.806;   // km/s → pc/yr
    const pos = p.map((pc, k) => pc * rPc + (vt(pmraMas) * ea[k] + vt(pmdeMas) * ed[k] + vr * p[k]) * years);
    const l = Math.hypot(...pos);
    const eq = pos.map((v) => v / l);
    return [eq[0], eq[2], -eq[1]];   // EQJ → scene
}

test('proper motion: Arcturus in 1000 within 1′ of a rigorous space-motion calculation; figures and names follow', () => {
    const cat = decodeSky(SKY);
    const i = cat.stars.hip.indexOf(69673);
    const j2000 = starDir(cat, 69673);
    const k = SKY.stars.hip.indexOf(69673);
    const ra = SKY.stars.ra[k] / 1000, dec = SKY.stars.dec[k] / 1000;
    const years = yearsFromJ2000(Date.UTC(1000, 0, 1));
    assert.ok(Math.abs(years + 1000) < 0.05, 'Julian years from J2000.0');
    assert.equal(applyProperMotion(cat, years), true);
    assert.equal(applyProperMotion(cat, years), false, 'same epoch: nothing to do');
    const moved = starDir(cat, 69673);
    // Hipparcos New Reduction: plx 88.83 mas, μ −1093.39 / −2000.06 mas/yr; radial velocity −5.19 km/s.
    const want = spaceMotion(ra, dec, 88.83, -1093.39, -2000.06, -5.19, years);
    const errArcmin = angleDeg(moved, want) * 60;
    assert.ok(errArcmin < 1, `${errArcmin.toFixed(2)}′`);
    const shift = angleDeg(moved, j2000);
    assert.ok(shift > 0.6 && shift < 0.65, `Arcturus moved ${shift.toFixed(3)}° in 1000 years`);
    // The constellation line endpoint on Arcturus and its label moved with it.
    const P = cat.cons.segments;
    let linked = 0;
    for (let o = 0; o < P.length; o += 3) if (angleDeg([P[o], P[o + 1], P[o + 2]], moved) < 1e-5) linked++;
    assert.ok(linked >= 1, 'Boötes follows Arcturus');
    const name = cat.starNames.find((s) => s.hip === 69673);
    assert.ok(angleDeg(name.dirS, moved) < 1e-6);
    // Back to J2000.
    applyProperMotion(cat, 0);
    assert.ok(angleDeg(starDir(cat, 69673), j2000) < 1e-5);
    assert.ok(i >= 0);
    // A slow star never moves.
    const bet = starDir(cat, 27989);
    applyProperMotion(cat, -1000);
    assert.deepEqual(starDir(cat, 27989), bet);
});

test('α Centauri, the fastest bright mover, shifts about 1° per millennium', () => {
    const cat = decodeSky(SKY);
    const before = starDir(cat, 71683);
    applyProperMotion(cat, 1000);
    const d = angleDeg(starDir(cat, 71683), before);
    assert.ok(d > 1.0 && d < 1.05, `${d}`);   // 3.71″/yr
});

test('max tier: data/stars8.json — 36,367 stars V 6.01–8.00, none in the base catalogue, merged after it', () => {
    const deep = read('data/stars8.json');
    assert.equal(deep.v, 1);
    assert.equal(deep.n, 36367);
    for (const k of ['hip', 'ra', 'dec', 'mag', 'bv', 'plx']) assert.equal(deep[k].length, deep.n, k);
    for (let i = 1; i < deep.n; i++) assert.ok(deep.mag[i] >= deep.mag[i - 1]);
    assert.ok(deep.mag[0] >= 601 && deep.mag.at(-1) <= 800);
    const base = new Set(SKY.stars.hip);
    assert.ok(deep.hip.every((h) => !base.has(h)), 'no star twice');
    const cat = decodeSky(SKY);
    applyProperMotion(cat, -500);
    const m = mergeDeepStars(cat, deep);
    assert.equal(m.stars.count, 5044 + 36367);
    assert.equal(m.stars.baseCount, 5044);
    for (let i = 1; i < m.stars.count; i++) assert.ok(m.stars.mag[i] >= m.stars.mag[i - 1] - 1e-6, `sorted at ${i}`);
    assert.deepEqual([...m.stars.dirS.subarray(0, 15)], [...cat.stars.dirS.subarray(0, 15)], 'base stars keep their indices');
    assert.ok(Number.isNaN(m.stars.plx[0]) && m.stars.plx[5044 + 10] > 0);
    // Each catalogue keeps its own epoch.
    assert.notEqual(m.stars.pm, cat.stars.pm);
    assert.equal(m.stars.pm.years, -500);
    const k = 5044 + 100;
    const want = raDecToScene(deep.ra[100] / 1000, deep.dec[100] / 1000);
    assert.ok(angleDeg([m.stars.dirS[3 * k], m.stars.dirS[3 * k + 1], m.stars.dirS[3 * k + 2]], want) < 1e-4);
    assert.throws(() => mergeDeepStars(cat, { v: 1, n: 1, hip: [] }), TypeError);
});

test('data/raw/hip2.json and data/stars8.json rebuild from the cached inputs (skipped without them)', async (t) => {
    const { HIP_TDAT, STARS8, parseHipTdat, buildHip2, buildDeep, serializeColumns } = await import('../scripts/build-stars.mjs');
    if (!fs.existsSync(HIP_TDAT) || !fs.existsSync(STARS8)) {
        t.skip('npm run vendor fetches the gitignored inputs');
        return;
    }
    const zlib = await import('node:zlib');
    const hip = parseHipTdat(zlib.gunzipSync(fs.readFileSync(HIP_TDAT)).toString('latin1'));
    assert.equal(hip.size, 117955);
    const ids = new Set(read('data/raw/stars.6.json').features.map((f) => f.id));
    const text = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    assert.ok(serializeColumns(buildHip2(ids, hip), ['hip', 'plx', 'eplx', 'pmra', 'pmde']) === text('data/raw/hip2.json'));
    assert.ok(serializeColumns(buildDeep(JSON.parse(fs.readFileSync(STARS8, 'utf8')), ids, hip), ['hip', 'ra', 'dec', 'mag', 'bv', 'plx'])
        === text('data/stars8.json'));
});
