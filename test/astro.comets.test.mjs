// Halley's Comet (astro/comets.js): Kepler solvers, the B1950 → J2000 rotation, positions against
// JPL Horizons, the magnitude law, tails and the extras provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    HALLEY, solveKeplerElliptic, solveKeplerHyperbolic, solveBarker, orbitPlaneState, elementsB1950ToJ2000,
    cometGeocentric, cometMagnitude, tailLengths, createCometProvider, GAUSS_K, TAIL_SAMPLES,
} from '../js/astro/comets.js';
import { createExtras } from '../js/astro/extras.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { AE } from '../js/astro/ae.js';

const DEG = Math.PI / 180;

test('Kepler solvers: elliptic, hyperbolic and parabolic', () => {
    for (const e of [0, 0.1, 0.5, 0.9, 0.967, 0.999]) {
        for (const M of [-3, -0.5, 1e-4, 0.3, 1, 2.5, 3.14, 7, 100]) {
            const E = solveKeplerElliptic(M, e);
            assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-10, `e=${e} M=${M}`);
        }
    }
    for (const e of [1.01, 1.5, 3]) {
        for (const M of [-20, -1, 0.01, 1, 10, 50]) {
            const H = solveKeplerHyperbolic(M, e);
            assert.ok(Math.abs(e * Math.sinh(H) - H - M) < 1e-9, `e=${e} M=${M}`);
        }
    }
    // Barker: tan³(ν/2)/3 + tan(ν/2) = k·dt/√(2q³).
    for (const dt of [-200, -5, 0, 3, 40, 500]) {
        const q = 0.6, nu = solveBarker(dt, q), s = Math.tan(nu / 2);
        assert.ok(Math.abs(s ** 3 / 3 + s - GAUSS_K * dt / Math.sqrt(2 * q ** 3)) < 1e-12);
    }
});

test('orbit-plane states conserve energy and angular momentum on every conic', () => {
    const mu = GAUSS_K ** 2;
    for (const [q, e] of [[0.587, 0.9673], [1, 0], [0.5, 1], [0.3, 1.4]]) {
        const a = e === 1 ? Infinity : q / (1 - e);
        const ref = e === 1 ? 0 : -mu / (2 * a);
        const hRef = Math.sqrt(mu * q * (1 + e));
        for (const dt of [-300, -10, 0, 25, 400]) {
            const s = orbitPlaneState(q, e, dt);
            const v2 = s.vx ** 2 + s.vy ** 2;
            const energy = v2 / 2 - mu / Math.hypot(s.x, s.y);
            assert.ok(Math.abs(energy - ref) < 1e-12, `energy q=${q} e=${e} dt=${dt}`);
            assert.ok(Math.abs(s.x * s.vy - s.y * s.vx - hRef) < 1e-12, `h q=${q} e=${e}`);
            assert.ok(Math.abs(Math.hypot(s.x, s.y) - s.r) < 1e-12);
        }
        assert.ok(Math.abs(orbitPlaneState(q, e, 0).r - q) < 1e-12, 'perihelion at T');
    }
});

test('B1950 elements rotate to J2000: Halley 1986 (Marsden) matches Horizons’ J2000 set', () => {
    // MPC/Marsden 1986 elements referred to B1950.0: ω 111.8466°, Ω 58.1440°, i 162.2393°.
    const j = elementsB1950ToJ2000({ iDeg: 162.2393, nodeDeg: 58.144, periDeg: 111.8466 });
    const h = HALLEY.find((a) => a.year === 1986);
    assert.ok(Math.abs(j.iDeg - h.iDeg) < 0.005, `i ${j.iDeg}`);
    assert.ok(Math.abs(j.nodeDeg - h.nodeDeg) < 0.005, `node ${j.nodeDeg}`);
    assert.ok(Math.abs(j.periDeg - h.periDeg) < 0.005, `peri ${j.periDeg}`);
    // Without the rotation the node would be 0.7° out: the size of the error the verifier warned of.
    assert.ok(Math.abs(58.144 - h.nodeDeg) > 0.6);
});

// JPL Horizons, geocentric astrometric RA/Dec (ICRF), r and Δ, at TT Julian dates (fetched 2026-11-04,
// from the same DASTCOM records: 90000018, 90000023, 90000029, 90000030).
const HORIZONS = [
    [1066, 2110500.5, 350.30949, 4.44671, 0.5956231, 1.0433902],
    [1066, 2110528.333, 99.73683, 24.10616, 0.9349284, 0.1158019],
    [1066, 2110550.5, 155.72709, 1.94117, 1.2804323, 0.9169109],
    [1456, 2253010.5, 44.43303, 26.78922, 0.6339673, 1.0802206],
    [1456, 2253040.5, 159.71822, 16.89205, 0.7046396, 0.6326646],
    [1910, 2418760.5, 3.91189, 8.57019, 0.7440708, 1.7261834],
    [1910, 2418809.5, 41.38451, 18.59883, 0.8337701, 0.1836264],
    [1986, 2446504.5, 300.21847, -22.45699, 0.9171223, 0.9372590],
    [1986, 2446531.5, 224.70202, -47.21441, 1.3319826, 0.4172346],
    [2061, 2474033.5, 127.46217, 40.59119, 0.5929946, 0.4830657],
    [2061, 2474060.5, 190.07333, -3.37345, 0.8143773, 1.2634577],
];

test('Halley’s positions match JPL Horizons to under 1′ at all five apparitions', () => {
    const out = { geo: new Float64Array(3), helio: new Float64Array(3), vel: new Float64Array(3) };
    for (const [year, jd, ra, dec, r0, d0] of HORIZONS) {
        const approx = (jd - 2440587.5) * 86400e3;
        const t = AE.MakeTime(new Date(approx));
        const ms = approx - (t.tt - t.ut) * 86400e3;
        const e = AE.HelioVector('Earth', AE.MakeTime(new Date(ms)));
        const el = HALLEY.find((a) => a.year === year);
        const { r, delta } = cometGeocentric(el, ms, [e.x, e.y, e.z], out);
        const g = out.geo;
        const raC = Math.atan2(g[1], g[0]), decC = Math.asin(g[2] / delta);
        const sep = Math.acos(Math.min(1, Math.sin(dec * DEG) * Math.sin(decC) + Math.cos(dec * DEG) * Math.cos(decC) * Math.cos(ra * DEG - raC))) / DEG * 60;
        assert.ok(sep < 1, `${year} JD ${jd}: ${sep.toFixed(2)}′`);
        assert.ok(Math.abs(r - r0) < 2e-4 && Math.abs(delta - d0) < 2e-4, `${year}: r ${r} Δ ${delta}`);
    }
});

test('magnitude law (JPL T-mag) and tails', () => {
    const el = HALLEY.find((a) => a.year === 1986);
    // Horizons: T-mag 5.059 at r 0.917, Δ 0.937 (1986-03-15).
    assert.ok(Math.abs(cometMagnitude(el, 0.9171223, 0.937259) - 5.059) < 0.01);
    const far = tailLengths(3), near = tailLengths(0.6);
    assert.equal(far.ion, 0);
    assert.ok(near.ion > near.dust && near.ion <= 0.15 && near.activity === 1);
});

test('the provider: Halley over Hastings in 1066, tail away from the Sun, absent between apparitions', () => {
    const reg = createExtras();
    reg.register(createCometProvider());
    const snap = createSnapshot();
    computeSnapshot(Date.UTC(1066, 3, 30, 20, 45), { latDeg: 50.911, lonDeg: 0.487, elevM: 0 }, snap, { detail: 'full' });
    reg.fill(snap);
    const st = reg.state(snap, 'comet:halley');
    assert.ok(st.present && st.approx);
    assert.ok(st.mag > 0 && st.mag < 1.2, `mag ${st.mag}`);
    assert.ok(st.altDeg > 15 && st.altDeg < 30 && st.azDeg > 270 && st.azDeg < 300, `${st.altDeg} ${st.azDeg}`);
    assert.ok(Math.abs(st.distAU - 0.117) < 0.003);
    // The ion tail's far end is farther from the Sun's direction than the head.
    const sun = snap.bodies[0].dirS;
    const D = st.data;
    const n = (TAIL_SAMPLES - 1) * 3;
    const cosHead = sun[0] * D.ion[0] + sun[1] * D.ion[1] + sun[2] * D.ion[2];
    const cosTip = sun[0] * D.ion[n] + sun[1] * D.ion[n + 1] + sun[2] * D.ion[n + 2];
    assert.ok(cosTip < cosHead, 'the tail points away from the Sun');
    const card = reg.card('comet:halley', snap);
    assert.match(card.kindLabel, /1066/);
    assert.match(card.subtitle, /20 Mar 1066/, 'perihelion date in the Julian calendar');
    // 1500: no element set within ±1.5 years.
    computeSnapshot(Date.UTC(1500, 0, 1), { latDeg: 50.911, lonDeg: 0.487, elevM: 0 }, snap, { detail: 'full' });
    reg.fill(snap);
    assert.equal(reg.state(snap, 'comet:halley').present, false);
    // 1986, two months before perihelion and well placed: precise (not approximate).
    computeSnapshot(Date.UTC(1986, 2, 15), { latDeg: -23.7, lonDeg: 133.88, elevM: 0 }, snap, { detail: 'full' });
    reg.fill(snap);
    assert.equal(reg.state(snap, 'comet:halley').approx, false);
});
