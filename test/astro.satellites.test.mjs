// Bright satellites (astro/satellites.js, data/tle.json, scripts/fetch-tle.mjs).
//
// Nothing here depends on today's date: every instant is taken from the committed elements'
// own epochs, so CI stays green however old data/tle.json gets (the deploy refreshes the staged
// copy daily).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AE } from '../js/astro/ae.js';
import {
    SAT_INFO, TLE_VALID_DAYS, decodeTle, inTleWindow, observerEf, sunEf, sunlitFraction, satMagnitude, createLook, lookAt,
    createSatProvider, satellitePasses, allPasses, groundTrack, PASS_MIN_ALT_DEG, PASS_SUN_MAX_DEG,
} from '../js/astro/satellites.js';
import { gstime, jdOfMs, tleChecksum } from '../js/astro/sgp4.js';
import { createExtras } from '../js/astro/extras.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { earthFixedToEqj } from '../js/astro/frames.js';
import { pickTle } from '../scripts/fetch-tle.mjs';
import { runOp } from '../js/astro/worker.js';
import { computeMarsSnapshot } from '../js/astro/host-mars.js';
import { MARS_SITES } from '../js/astro/mars-clock.js';

const JSON_DATA = JSON.parse(fs.readFileSync(new URL('../data/tle.json', import.meta.url), 'utf8'));
const SATS = decodeTle(JSON_DATA);
const ISS = SATS.find((s) => s.id === 'sat:iss');
const T0 = ISS.epochMs;
const HANOI = { latDeg: 21.0285, lonDeg: 105.8542, elevM: 15 };
const DEG = Math.PI / 180;

test('data/tle.json: six objects, valid two-line sets, near-Earth, epochs close to the retrieval date', () => {
    assert.equal(JSON_DATA.v, 1);
    assert.deepEqual(SATS.map((s) => s.id), Object.keys(SAT_INFO).map((k) => `sat:${k}`));
    const retrieved = Date.parse(JSON_DATA.retrieved);
    for (const s of SATS) {
        assert.equal(Number(s.l1[68]), tleChecksum(s.l1), `${s.id} line 1 checksum`);
        assert.equal(Number(s.l2[68]), tleChecksum(s.l2), `${s.id} line 2 checksum`);
        assert.equal(s.norad, SAT_INFO[s.key].norad);
        assert.ok(s.periodMin > 85 && s.periodMin < 110, `${s.id}: ${s.periodMin} min`);
        assert.ok(retrieved - s.epochMs >= -3600e3 && retrieved - s.epochMs < 30 * 86400e3, `${s.id} epoch`);
    }
    assert.ok(fs.statSync(new URL('../data/tle.json', import.meta.url)).size < 4096);
    assert.throws(() => decodeTle({ v: 2 }), TypeError);
    // A bad entry costs only itself.
    assert.equal(decodeTle({ v: 1, sats: [{ key: 'iss', norad: 25544, l1: 'x', l2: 'y' }, JSON_DATA.sats[1]] }).length, 1);
});

test('the low-precision Sun agrees with Astronomy Engine to 0.02° (Earth-fixed)', () => {
    const E = new Float64Array(9);
    const s = new Float64Array(3);
    for (const iso of ['2026-11-04T06:00:00Z', '2027-06-21T12:00:00Z', '2027-08-02T10:07:00Z']) {
        const t = Date.parse(iso);
        const au = sunEf(t, gstime(jdOfMs(t)), s);
        const v = AE.GeoVector(AE.Body.Sun, AE.MakeTime(new Date(t)), true);
        earthFixedToEqj(t, E);
        // EF = Eᵀ·EQJ
        const d = Math.hypot(v.x, v.y, v.z);
        const ef = [0, 1, 2].map((i) => (E[i] * v.x + E[3 + i] * v.y + E[6 + i] * v.z) / d);
        const ang = Math.acos(Math.min(1, ef[0] * s[0] + ef[1] * s[1] + ef[2] * s[2])) / DEG;
        assert.ok(ang < 0.02, `${iso}: ${ang}°`);
        assert.ok(Math.abs(au - d) < 2e-4, `${iso}: ${au} vs ${d} AU`);
    }
});

test('the scene path (snapshot frame, provider, registry alt/az) matches the Earth-fixed look to 0.02°', () => {
    const reg = createExtras();
    reg.register(createSatProvider(SATS));
    const snap = createSnapshot();
    const L = createLook();
    const obs = observerEf(HANOI.latDeg, HANOI.lonDeg, HANOI.elevM);
    let checked = 0;
    for (let k = 0; k < 48; k++) {
        const t = T0 + k * 1800e3;
        computeSnapshot(t, HANOI, snap);
        reg.fill(snap);
        for (const s of SATS) {
            const st = reg.state(snap, s.id);
            assert.equal(st.present, true);
            lookAt(s, t, obs, L);
            const dAlt = Math.abs(st.altGeomDeg - L.altDeg);
            const dAz = Math.abs(((st.azGeomDeg - L.azDeg + 540) % 360) - 180) * Math.cos(L.altDeg * DEG);
            assert.ok(dAlt < 0.02 && dAz < 0.02, `${s.id} at +${k / 2} h: Δalt ${dAlt}, Δaz ${dAz}`);
            assert.ok(Math.abs(st.distAU * 149597870.7 - L.rangeKm) < 1e-6);
            checked++;
        }
    }
    assert.equal(checked, 48 * SATS.length);
});

test('registry.advance moves the satellites between snapshots (the ISS: about 7.7 km/s)', () => {
    const reg = createExtras();
    reg.register(createSatProvider(SATS));
    const snap = createSnapshot();
    computeSnapshot(T0, HANOI, snap);
    reg.fill(snap);
    const st = reg.state(snap, 'sat:iss');
    const p0 = Float64Array.from(st.data.posS);
    assert.equal(reg.advance(snap, T0 + 10e3), SATS.length);
    const moved = Math.hypot(st.data.posS[0] - p0[0], st.data.posS[1] - p0[1], st.data.posS[2] - p0[2]) * 6378.137;
    // 10 s of orbit, less the Earth's turn under it (the frame is Earth-fixed).
    assert.ok(moved > 65 && moved < 80, `${moved} km in 10 s`);
    assert.equal(st.data.tMs, T0 + 10e3);
});

test('staleness: shown only within 14 days of the elements, approximate after 3', () => {
    const reg = createExtras();
    reg.register(createSatProvider(SATS));
    const snap = createSnapshot();
    const at = (days) => { computeSnapshot(T0 + days * 86400e3, HANOI, snap); reg.fill(snap); return reg.state(snap, 'sat:iss'); };
    assert.equal(at(1).present, true);
    assert.equal(at(1).approx, false);
    assert.equal(at(5).approx, true);
    assert.equal(at(TLE_VALID_DAYS - 0.1).present, true);
    assert.equal(at(TLE_VALID_DAYS + 0.1).present, false);
    assert.equal(at(-TLE_VALID_DAYS - 0.1).present, false);
    assert.equal(inTleWindow(ISS, T0 + 13 * 86400e3), true);
    // The card says how old the elements are, and the meta routes it to the satellites layer.
    const st = at(2);
    const card = reg.card('sat:iss', snap);
    assert.match(card.facts.find(([k]) => k === 'Orbital elements')[1], /2\.0 days old/);
    assert.match(card.caveat, /14 days/);
    assert.deepEqual({ glyph: reg.meta('sat:iss').glyph, layer: reg.meta('sat:iss').layer }, { glyph: 'sat', layer: 'satellites' });
    assert.ok(st.data.look.heightKm > 380 && st.data.look.heightKm < 450);
});

test('Earth shadow: sunlit, umbra and a penumbra in between (discVisibleFraction)', () => {
    const sun = [1, 0, 0];
    const r = 6800;
    assert.equal(sunlitFraction([r, 0, 0], sun, 1), 1);           // between the Earth and the Sun
    assert.equal(sunlitFraction([-r, 0, 0], sun, 1), 0);          // behind the Earth
    assert.equal(sunlitFraction([0, r, 0], sun, 1), 1);           // abeam: the Sun clears the limb
    // Crossing the shadow cylinder's edge: the fraction falls smoothly from 1 to 0 within a few km.
    const edge = (y) => sunlitFraction([-Math.sqrt(r * r - y * y), y, 0], sun, 1);
    assert.equal(edge(6500), 1);
    assert.equal(edge(6300), 0);
    const mid = edge(6378.137 - 0.0);
    assert.ok(mid > 0.2 && mid < 0.8, String(mid));
    let prev = 1;
    for (let y = 6450; y >= 6300; y -= 5) { const f = edge(y); assert.ok(f <= prev + 1e-12); prev = f; }
});

test('magnitude: the standard magnitude at 1000 km half lit; brighter nearer and fuller', () => {
    assert.ok(Math.abs(satMagnitude(-1.8, 1000, 0, 1) - -1.8) < 0.01);
    // The ISS overhead at 420 km, fully lit: about −4.4.
    const full = satMagnitude(-1.8, 420, 1, 1);
    assert.ok(full > -4.6 && full < -4.2, String(full));
    assert.ok(satMagnitude(-1.8, 420, -0.5, 1) > full);
    assert.ok(Number.isNaN(satMagnitude(-1.8, 420, 1, 0)));
    // Half the Sun's disc: 0.75 mag fainter.
    assert.ok(Math.abs(satMagnitude(-1.8, 1000, 0, 0.5) - -1.8 - 0.753) < 0.01);
});

test('passes: start ≤ peak ≤ end, visible all along, and consistent with a direct look', () => {
    const obs = observerEf(HANOI.latDeg, HANOI.lonDeg, HANOI.elevM);
    const L = createLook();
    const passes = satellitePasses(ISS, HANOI, T0, T0 + 10 * 86400e3);
    assert.ok(passes.length >= 3, `${passes.length} ISS passes over Hanoi in 10 days`);
    for (const p of passes) {
        assert.ok(p.riseMs <= p.startMs && p.startMs < p.peakMs + 1 && p.peakMs <= p.endMs + 1 && p.endMs <= p.setMs, JSON.stringify(p));
        assert.ok(p.endMs - p.startMs >= 60e3 && p.endMs - p.startMs < 12 * 60e3);
        assert.ok(p.peakAltDeg >= PASS_MIN_ALT_DEG && p.peakAltDeg >= p.startAltDeg - 1e-6 && p.peakAltDeg >= p.endAltDeg - 1e-6);
        assert.ok(p.mag < 1 && p.mag > -5, String(p.mag));
        for (let t = p.startMs + 2000; t < p.endMs - 2000; t += 15e3) {
            lookAt(ISS, t, obs, L);
            assert.ok(L.altDeg >= PASS_MIN_ALT_DEG - 0.05 && L.lit > 0.45 && L.sunAltDeg <= PASS_SUN_MAX_DEG + 0.05, `${p.id} ${new Date(t).toISOString()}`);
        }
        lookAt(ISS, p.peakMs, obs, L);
        assert.ok(Math.abs(L.altDeg - p.peakAltDeg) < 1e-6 && Math.abs(L.azDeg - p.peakAzDeg) < 1e-6);
        assert.ok(['rises', 'shadow', 'twilight'].includes(p.starts) && ['sets', 'shadow', 'twilight'].includes(p.ends));
    }
    // Nothing is predicted past the elements' window.
    assert.deepEqual(satellitePasses(ISS, HANOI, T0 + 15 * 86400e3, T0 + 25 * 86400e3), []);
});

test('allPasses (the worker op satPasses): every satellite, by start time', () => {
    const list = runOp('satPasses', { tle: JSON_DATA, observer: HANOI, fromMs: T0, days: 3 });
    assert.ok(Array.isArray(list) && list.length > 0);
    for (let i = 1; i < list.length; i++) assert.ok(list[i].startMs >= list[i - 1].startMs);
    assert.ok(list.every((p) => p.startMs >= T0 - 1 && p.startMs <= T0 + 3 * 86400e3 && typeof p.name === 'string' && p.color));
    assert.deepEqual(allPasses(JSON_DATA, HANOI, T0, 3).length, list.length);
});

test('ground track: one orbit either side on the sphere, the minutes symmetric about now', () => {
    const n = 61;
    const pos = new Float32Array(n * 3), min = new Float32Array(n);
    assert.equal(groundTrack(ISS, T0, ISS.periodMin * 60e3, n, 1.008, pos, min), n);
    for (let k = 0; k < n; k++) {
        assert.ok(Math.abs(Math.hypot(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]) - 1.008) < 1e-5);
        assert.ok(Math.abs(min[k] + min[n - 1 - k]) < 1e-3);
        // The track stays inside the inclination's band (51.6°).
        assert.ok(Math.abs(Math.asin(pos[k * 3 + 1] / 1.008)) / DEG < 52);
    }
    assert.ok(Math.abs(min[n - 1] - ISS.periodMin) < 1e-3);
});

test('fetch-tle: picks and validates one set from a CelesTrak response', () => {
    const iss = JSON_DATA.sats[0];
    const text = `ISS (ZARYA)             \r\n${iss.l1}\r\n${iss.l2}\r\n`;
    const now = ISS.epochMs + 86400e3;
    assert.deepEqual(pickTle(text, 25544, now), { name: 'ISS (ZARYA)', l1: iss.l1, l2: iss.l2 });
    assert.throws(() => pickTle(text, 20580, now), /no element set/);
    assert.throws(() => pickTle(text, 25544, ISS.epochMs + 40 * 86400e3), /days old/);
    assert.throws(() => pickTle(text.replace(iss.l1, iss.l1.slice(0, 68) + ((Number(iss.l1[68]) + 1) % 10)), 25544, now), /checksum/);
});

test('standing on Mars, Earth satellites stay out of the sky between snapshots too (advance)', () => {
    const reg = createExtras();
    const prov = createSatProvider(SATS, { json: JSON_DATA });
    reg.register(prov);
    const snap = createSnapshot();
    const t = Date.UTC(2026, 10, 4, 0, 11);
    computeMarsSnapshot(t, MARS_SITES.find((s) => s.id === 'jezero'), snap);
    reg.fill(snap);
    for (let dt = 250; dt <= 5000; dt += 250) reg.advance(snap, t + dt);
    for (const id of reg.ids('sat')) assert.equal(reg.state(snap, id).present, false, id);
    // The provider alone (called directly, as an older registry would) refuses a Mars snapshot.
    const out = { dirS: new Float64Array(3), present: true };
    prov.advance(snap, 'sat:iss', out, t + 1000);
    assert.equal(out.present, false);
});
