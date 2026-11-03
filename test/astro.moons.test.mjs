// Galilean moons, libration, Saturn's ring-plane crossings and the disc frame (astro/moons.js,
// astro/disc.js) and the snapshot fields that carry them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AE } from '../js/astro/ae.js';
import { AU_KM, BODY_INDEX } from '../js/astro/bodies.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import {
    GALILEAN, MOON_TRANSIT, MOON_OCCULTED, MOON_ECLIPSED, MOON_SHADOW, bestLimbFeature, librationDirection, saturnEdgeOn,
} from '../js/astro/moons.js';
import {
    SHAPES, createDiscFrame, createDiscView, discFrame, discView, toFrame, compressRadius, ringAt, RING_OUTER,
    scopeBlend, eqAngRadius, SCOPE_FROM_PX, SCOPE_TO_PX,
} from '../js/astro/disc.js';

const FULL = { detail: 'full' };
const D2R = Math.PI / 180;
const JUP = BODY_INDEX.jupiter;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const GREENWICH = { latDeg: 51.48, lonDeg: 0, elevM: 0 };

function snapAt(iso, detail = FULL, obs = GREENWICH) {
    const s = createSnapshot();
    computeSnapshot(Date.parse(iso), obs, s, detail);
    return s;
}

test('Galilean moons: the triple shadow transit of 2015-01-24 (Io, Europa, Callisto; 06:28–06:52 UT, S&T)', () => {
    const shadows = (iso) => Array.from(snapAt(iso).galilean.state, (f) => (f & MOON_SHADOW) !== 0);
    for (const iso of ['2015-01-24T06:31:00Z', '2015-01-24T06:40:00Z', '2015-01-24T06:50:00Z']) {
        assert.deepEqual(shadows(iso), [true, true, false, true], iso);
    }
    // Europa's shadow arrives at 06:28 and Io's leaves at 06:52: one minute's margin either side.
    assert.deepEqual(shadows('2015-01-24T06:26:00Z'), [true, false, false, true]);
    assert.deepEqual(shadows('2015-01-24T06:55:00Z'), [false, true, false, true]);
    // Io and Callisto were in front of the disc (the Hubble image of the event).
    const st = snapAt('2015-01-24T06:40:00Z').galilean.state;
    assert.ok(st[0] & MOON_TRANSIT && st[3] & MOON_TRANSIT && !(st[1] & (MOON_TRANSIT | MOON_OCCULTED)));
});

test('Galilean moons: offsets are AE.JupiterMoons at t − light time, in Jupiter radii (scene frame)', () => {
    const iso = '2026-11-03T22:00:00Z';
    const s = snapAt(iso);
    const jup = s.bodies[JUP];
    const time = AE.MakeTime(new Date(iso));
    const jm = AE.JupiterMoons(time.AddDays(-jup.lightTimeS / 86400));
    const rAU = SHAPES.jupiter.eqRadiusKm / AU_KM;
    GALILEAN.forEach((m, k) => {
        const v = jm[m.id];
        close(s.galilean.offS[k * 3], v.x / rAU, 1e-9, `${m.id} x`);
        close(s.galilean.offS[k * 3 + 1], v.z / rAU, 1e-9, `${m.id} y`);
        close(s.galilean.offS[k * 3 + 2], -v.y / rAU, 1e-9, `${m.id} z`);
    });
    // Light time matters: Io moves ~6° along its orbit in Jupiter's ~45 min.
    const now = AE.JupiterMoons(time).io;
    const a = Math.hypot(now.x - jm.io.x, now.y - jm.io.y, now.z - jm.io.z) / Math.hypot(jm.io.x, jm.io.y, jm.io.z);
    assert.ok(a > 0.08, `chord ${a}`);
});

test('Galilean moons: east/west side agrees with AE geocentric right ascensions', () => {
    for (const iso of ['2026-11-03T22:00:00Z', '2027-03-15T00:00:00Z', '2031-07-01T12:00:00Z']) {
        const s = createSnapshot();
        const tMs = Date.parse(iso);
        computeSnapshot(tMs, { latDeg: 0, lonDeg: 0, elevM: 0 }, s, FULL);
        const jup = s.bodies[JUP];
        const time = AE.MakeTime(new Date(tMs));
        const tl = time.AddDays(-jup.lightTimeS / 86400);
        const jv = AE.GeoVector('Jupiter', time, false);
        const jm = AE.JupiterMoons(tl);
        const raJ = Math.atan2(jv.y, jv.x);
        // East on the sky at Jupiter: increasing RA, scene (x, z, −y) of EQJ (−sin α, cos α, 0).
        const east = [-Math.sin(raJ), 0, -Math.cos(raJ)];
        GALILEAN.forEach((m, k) => {
            const mv = jm[m.id];
            const raM = Math.atan2(jv.y + mv.y, jv.x + mv.x);
            const dRa = ((raM - raJ + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
            const o = s.galilean.offS;
            const e = o[k * 3] * east[0] + o[k * 3 + 1] * east[1] + o[k * 3 + 2] * east[2];
            if (Math.abs(e) > 0.5) assert.equal(Math.sign(e), Math.sign(dRa), `${iso} ${m.id}`);
        });
    }
});

test('Galilean moons: flags are exclusive where they must be, and shadows land on the surface', () => {
    const s = createSnapshot();
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    let seen = 0;
    for (let h = 0; h < 24 * 20; h += 3) {
        computeSnapshot(t0 + h * 3600e3, GREENWICH, s);
        const g = s.galilean;
        for (let k = 0; k < 4; k++) {
            const f = g.state[k];
            assert.ok(!((f & MOON_TRANSIT) && (f & MOON_OCCULTED)));
            assert.ok(!((f & MOON_ECLIPSED) && (f & MOON_SHADOW)));
            if (f & MOON_SHADOW) {
                seen |= 1;
                const x = g.shadowS[k * 3], y = g.shadowS[k * 3 + 1], z = g.shadowS[k * 3 + 2];
                // On the spheroid: |x⊥|² + (x·p / (1 − f))² = 1.
                const p = s.bodies[JUP].poleS;
                const xp = x * p[0] + y * p[1] + z * p[2];
                const r2 = x * x + y * y + z * z - xp * xp + (xp / (1 - SHAPES.jupiter.flattening)) ** 2;
                close(r2, 1, 1e-9, 'shadow on the surface');
            }
            if (f & MOON_ECLIPSED) seen |= 2;
            if (f & MOON_OCCULTED) seen |= 4;
        }
    }
    assert.equal(seen, 7, 'twenty days show shadows, eclipses and occultations');
});

test('libration: the full snapshot carries AE.Libration; the limb feature follows the tilt', () => {
    const iso = '2026-11-03T00:00:00Z';
    const s = snapAt(iso);
    const l = AE.Libration(AE.MakeTime(new Date(iso)));
    close(s.libration.elonDeg, l.elon, 1e-12);
    close(s.libration.elatDeg, l.elat, 1e-12);
    assert.ok(['Mare Crisium', 'Mare Marginis', 'Mare Smythii'].includes(bestLimbFeature(7, 0).name));
    assert.ok(['Grimaldi', 'Mare Orientale'].includes(bestLimbFeature(-7, -1).name));
    assert.equal(bestLimbFeature(-2, -6.5).name, 'Bailly');
    assert.equal(librationDirection(5, 5), 'north-east');
    assert.equal(librationDirection(-6, 0), 'west');
    assert.equal(librationDirection(0.1, 0.2), '');
});

test('Saturn: edge-on from Oct 2038 to Jul 2039 (three crossings), memoised', () => {
    const e = saturnEdgeOn(Date.parse('2026-11-03T00:00:00Z'));
    assert.equal(e.count, 3);
    assert.equal(new Date(e.firstMs).toISOString().slice(0, 7), '2038-10');
    assert.equal(new Date(e.lastMs).toISOString().slice(0, 7), '2039-07');
    assert.equal(saturnEdgeOn(Date.parse('2026-11-04T00:00:00Z')), e, 'same 30-day bucket');
    // The 2025 crossing (Earth through the ring plane on 2025-03-23).
    const p = saturnEdgeOn(Date.parse('2024-06-01T00:00:00Z'));
    assert.equal(new Date(p.firstMs).toISOString().slice(0, 7), '2025-03');
    // Just after it, in the same 30-day bucket, the next one is the 2038–39 run, not the past one.
    for (const d of ['2025-03-24', '2025-04-01', '2025-04-05']) {
        const n = saturnEdgeOn(Date.parse(`${d}T12:00:00Z`));
        assert.equal(new Date(n.firstMs).toISOString().slice(0, 7), '2038-10', d);
        assert.equal(n.count, 3, d);
    }
    assert.equal(saturnEdgeOn(NaN), null);
});

test('disc frame: orthonormal, right-handed, ez toward the observer; fallbacks for a degenerate up', () => {
    const f = createDiscFrame();
    const d = [0.3, -0.5, 0.81];
    const n = Math.hypot(...d);
    const dir = d.map((x) => x / n);
    for (const up of [[0, 1, 0], [1, 2, 3], dir, [0, 0, 0]]) {
        discFrame(dir, up, f);
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        close(dot(f.ex, f.ex), 1, 1e-12); close(dot(f.ey, f.ey), 1, 1e-12); close(dot(f.ez, f.ez), 1, 1e-12);
        close(dot(f.ex, f.ey), 0, 1e-12); close(dot(f.ey, f.ez), 0, 1e-12);
        close(dot(f.ez, dir), -1, 1e-12);
        // ex = ey × ez.
        close(f.ex[0], f.ey[1] * f.ez[2] - f.ey[2] * f.ez[1], 1e-12);
    }
    const out = new Float64Array(3);
    discFrame(dir, [0, 1, 0], f);
    toFrame(f, f.ex, out);
    assert.deepEqual(Array.from(out, (x) => Math.round(x * 1e9) / 1e9), [1, 0, 0]);
});

test('disc view: phase angle from lightS matches AE, Saturn\'s opening is the ring tilt, poles are IAU', () => {
    const s = snapAt('2026-11-03T20:00:00Z', FULL, { latDeg: 10.82, lonDeg: 106.63, elevM: 0 });
    const f = createDiscFrame(), v = createDiscView();
    for (const b of s.bodies) {
        if (b.id === 'sun' || b.id === 'moon') continue;
        discFrame(b.dirS, b.poleS, f);
        discView(b, f, v);
        close(v.phaseAngleDeg, b.phaseAngleDeg, 0.1, `${b.id} phase angle`);
        close(Math.hypot(...b.poleS), 1, 1e-12);
        close(b.poleS[0] * b.primeS[0] + b.poleS[1] * b.primeS[1] + b.poleS[2] * b.primeS[2], 0, 1e-12, `${b.id} prime ⟂ pole`);
        // Pole-up frame: the pole has no x component.
        close(v.pole[0], 0, 1e-12);
    }
    const sat = s.bodies[BODY_INDEX.saturn];
    discFrame(sat.dirS, sat.poleS, f);
    discView(sat, f, v);
    // AE's ring_tilt is the Earth's ring-plane latitude with the sign flipped (positive: south face).
    close(v.subLatDeg, -sat.ringTiltDeg, 0.1, 'ring opening');
    close(sat.ringTiltDeg, 6.5, 0.1, '2026-11-03');
    assert.equal(s.bodies[JUP].ringTiltDeg, 0, 'no rings: 0');
    // Jupiter's pole: RA 268.06°, Dec 64.50° (IAU 2015), scene (x, z, −y) of EQJ.
    const p = s.bodies[JUP].poleS;
    close(Math.asin(p[1]) / D2R, 64.50, 0.01);
    close((Math.atan2(-p[2], p[0]) / D2R + 360) % 360, 268.06, 0.02);
    // Venus is a thin evening/morning crescent ten days after inferior conjunction: bright limb ~90° off up.
    const ven = s.bodies[BODY_INDEX.venus];
    discFrame(ven.dirS, ven.poleS, f);
    discView(ven, f, v);
    assert.ok(v.phaseAngleDeg > 150 && ven.phaseFrac < 0.06);
});

test('disc helpers: log spacing is continuous and monotonic; ring zones', () => {
    assert.equal(compressRadius(0.5), 0.5);
    close(compressRadius(1 + 1e-9), 1, 1e-8);
    let prev = 0;
    for (let r = 0.1; r < 30; r += 0.1) {
        const c = compressRadius(r);
        assert.ok(c > prev);
        prev = c;
    }
    assert.ok(compressRadius(26.3) < 3.1, 'Callisto stays within ~3 radii');
    assert.deepEqual(ringAt(1.3), [0.128, 0.32]);
    close(ringAt(1.7)[0], 2.2, 0.1, "B ring");
    assert.equal(ringAt(1.98)[0], 0.083, "Cassini division");
    assert.ok(ringAt(2.215)[0] < ringAt(2.1)[0], "Encke gap");
    assert.deepEqual(ringAt(1.1), [0, 0]);
    assert.deepEqual(ringAt(RING_OUTER + 0.01), [0, 0]);
});

test('snapshot: new fields keep their typed arrays, and frame detail fills poles and moons too', () => {
    const s = createSnapshot();
    const refs = [s.bodies[JUP].poleS, s.bodies[JUP].primeS, s.bodies[JUP].lightS, s.galilean.offS, s.galilean.state];
    computeSnapshot(Date.parse('2026-11-03T20:00:00Z'), GREENWICH, s);
    computeSnapshot(Date.parse('2027-01-03T20:00:00Z'), GREENWICH, s, FULL);
    assert.deepEqual([s.bodies[JUP].poleS, s.bodies[JUP].primeS, s.bodies[JUP].lightS, s.galilean.offS, s.galilean.state], refs);
    const f = createSnapshot();
    computeSnapshot(Date.parse('2026-11-03T20:00:00Z'), GREENWICH, f);
    const g = createSnapshot();
    computeSnapshot(Date.parse('2026-11-03T20:00:00Z'), GREENWICH, g, FULL);
    assert.deepEqual(Array.from(f.galilean.offS), Array.from(g.galilean.offS));
    assert.deepEqual(Array.from(f.bodies[BODY_INDEX.mars].primeS), Array.from(g.bodies[BODY_INDEX.mars].primeS));
    // The Moon's pole and prime meridian are columns of its IAU orientation (moonMatrix = S·M·Sᵀ:
    // geometry +Y is the body's pole, +X its prime meridian).
    const m = g.bodies[BODY_INDEX.moon], mm = g.moonMatrix;
    close(m.poleS[0], mm[4], 1e-12); close(m.poleS[1], mm[5], 1e-12); close(m.poleS[2], mm[6], 1e-12);
    close(m.primeS[0], mm[0], 1e-12); close(m.primeS[1], mm[1], 1e-12); close(m.primeS[2], mm[2], 1e-12);
});

test('telescope hand-over: scopeBlend runs 0 → 1 over the glyph core; eqAngRadius is the true radius', () => {
    assert.equal(scopeBlend(0), 0);
    assert.equal(scopeBlend(SCOPE_FROM_PX), 0);
    assert.equal(scopeBlend(SCOPE_TO_PX), 1);
    assert.equal(scopeBlend(100), 1);
    assert.equal(scopeBlend(NaN), 0);
    let prev = 0;
    for (let r = SCOPE_FROM_PX; r <= SCOPE_TO_PX; r += 0.1) {
        const w = scopeBlend(r);
        assert.ok(w >= prev - 1e-15, 'monotonic');
        prev = w;
    }
    // Jupiter at 4.2 AU: 71,492 km → 23.5″ of equatorial radius.
    const r = eqAngRadius('jupiter', 4.2) * 180 / Math.PI * 3600;
    assert.ok(Math.abs(r - 71492 / (4.2 * AU_KM) * 206264.806) < 1e-6);
    assert.equal(eqAngRadius('pluto', 30), 0);
    assert.equal(eqAngRadius('mars', 0), 0);
});
