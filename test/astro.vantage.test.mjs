// Vantage-point geometry (js/astro/vantage.js): the L1 pose, the Earthrise orbit plan and pose,
// fields of view, the near-plane rule and the Moon-in-front test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { MOON_RADIUS_ER, EARTH_RADIUS_KM } from '../js/astro/bodies.js';
import {
    VANTAGE_KINDS, isVantage, createPose, vantageFov, moonInFront, vantageNear, l1Pose, L1_DIST_ER, L1_OFFSET_DEG,
    planLunarOrbit, lunarOrbitPose, earthAboveLimbDeg, lunarPeriodS, LUNAR_ALT_KM, EARTHRISE_DEG, LIMB_DIP_RAD, LIMB_NDC_Y,
} from '../js/astro/vantage.js';

const D = Math.PI / 180;
const LUXOR = { latDeg: 25.7, lonDeg: 32.6, elevM: 0 };
const snapAt = (iso) => {
    const s = createSnapshot();
    computeSnapshot(Date.parse(iso), LUXOR, s, { detail: 'frame' });
    return s;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('vantage kinds', () => {
    assert.deepEqual([...VANTAGE_KINDS], ['none', 'l1', 'moon']);
    assert.ok(isVantage('l1') && isVantage('moon'));
    assert.ok(!isVantage('none') && !isVantage('sky') && !isVantage(null));
});

test('L1: 1.5 million km out, 4° off the Sun toward ecliptic north, north up, the disc filling 70 % of the height', () => {
    const s = snapAt('2027-08-02T10:07:00Z');
    const p = l1Pose(s, 16 / 9, createPose());
    near(len(p.pos), L1_DIST_ER, 1e-9, 'distance');
    near(L1_DIST_ER * EARTH_RADIUS_KM, 1.5e6, 1, 'km');
    const dir = p.pos.map((x) => x / L1_DIST_ER);
    near(Math.acos(dot(dir, s.sunDirS)) / D, L1_OFFSET_DEG, 1e-6, 'off the Sun–Earth line');
    // Toward ecliptic north (scene (0, cos ε, sin ε)).
    const eps = 23.4392911 * D;
    assert.ok(dot(dir, [0, Math.cos(eps), Math.sin(eps)]) > 0.06, 'north of the Sun–Earth line');
    // Looking at the Earth's centre, up square to it and on the J2000 pole's side.
    near(dot(p.fwd, dir), -1, 1e-12, 'looks at the centre');
    near(dot(p.up, p.fwd), 0, 1e-12, 'up ⟂ forward');
    near(len(p.up), 1, 1e-12, 'unit up');
    assert.ok(p.up[1] > 0.9, 'north up');
    near(p.fovDeg, 0.7, 1e-12, 'landscape field');
    const disc = 2 * Math.asin(1 / L1_DIST_ER) / D;
    near(disc / p.fovDeg, 0.7, 0.01, 'disc share of the height');
});

test('L1: the eclipse-day Moon stands clear of its own shadow, outside the frame', () => {
    // 2027-08-02, greatest eclipse 10:07 UT: Sun, Moon and Earth in line; from the L1 camera the
    // Moon must not sit on the umbra (it would, exactly on the Sun–Earth line).
    const s = snapAt('2027-08-02T10:07:00Z');
    const p = l1Pose(s, 16 / 9, createPose());
    const m = s.moonPosS;
    const toMoon = [m[0] - p.pos[0], m[1] - p.pos[1], m[2] - p.pos[2]];
    const sep = Math.acos(dot(toMoon, p.fwd) / len(toMoon)) / D;
    // The frame's half-diagonal at 16:9 and 0.7° is ~0.4°.
    assert.ok(sep > 1, `the Moon is ${sep.toFixed(2)}° from the view centre`);
});

test('fields of view span the narrower side; portrait phones open up, Earthrise to at most 32°', () => {
    near(vantageFov('l1', 16 / 9), 0.7, 1e-12, 'l1 landscape');
    near(vantageFov('moon', 16 / 9), 18, 1e-12, 'moon landscape');
    const a = 390 / 844;
    near(Math.tan(vantageFov('l1', a) * D / 2) * a, Math.tan(0.35 * D), 1e-12, 'l1 portrait: 0.7° across the width');
    assert.equal(vantageFov('moon', a), 32);
    assert.equal(vantageFov('moon', 0), 18);
});

test('near plane: 0.8 of the way to the nearest surface, ignoring a Moon drawn in front', () => {
    // L1, the Moon 175 R off: the Moon is nearer than the Earth's shells.
    near(vantageNear(235, 175, false), 0.8 * (175 - MOON_RADIUS_ER * 1.02), 1e-9, 'Moon nearer');
    near(vantageNear(235, 290, false), 0.8 * (235 - 1.06), 1e-9, 'Earth nearer');
    // Lunar orbit: the Moon is drawn in front; the Earth (~60 R) sets the near plane.
    assert.ok(moonInFront(60, 0.3));
    assert.ok(!moonInFront(60, 9) && !moonInFront(10, 6));
    near(vantageNear(60, 0.3, true), 0.8 * (60 - 1.06), 1e-9, 'lunar orbit');
    assert.equal(vantageNear(1.05, Infinity, false), 0.003);
    // 24-bit depth at the Earth from L1: far finer than the 0.006 R cloud gap.
    const n = vantageNear(235, 290, false), z = 234;
    assert.ok(z * z / (n * 2 ** 24) < 1e-4);
});

test('lunar orbit: 150 km up, a 122.6-minute period', () => {
    near(lunarPeriodS() / 60, 122.6, 0.1, 'period');
    near(lunarPeriodS(100) / 60, 117.8, 0.2, 'Kaguya at 100 km');
    near(Math.cos(LIMB_DIP_RAD), MOON_RADIUS_ER / (MOON_RADIUS_ER + LUNAR_ALT_KM / EARTH_RADIUS_KM), 1e-12, 'limb dip');
});

for (const iso of ['2027-08-02T10:07:00Z', '2026-11-04T12:00:00Z', '2026-11-20T00:00:00Z', '2027-03-14T06:00:00Z']) {
    test(`Earthrise ${iso}: the Earth stands ${EARTHRISE_DEG}° over the sunlit-side limb, rising, framed above the limb`, () => {
        const s = snapAt(iso);
        const plan = planLunarOrbit(s);
        near(earthAboveLimbDeg(plan, s.tMs, s.moonPosS), EARTHRISE_DEG, 1e-4, 'height above the limb at entry');
        const s2 = createSnapshot();
        computeSnapshot(s.tMs + 60e3, LUXOR, s2, { detail: 'frame' });
        const rise = earthAboveLimbDeg(plan, s2.tMs, s2.moonPosS) - EARTHRISE_DEG;
        near(rise, 360 / lunarPeriodS() * 60, 0.15, 'rises at the orbital rate');
        const p = lunarOrbitPose(plan, s, 16 / 9, createPose());
        const m = s.moonPosS;
        const rel = [p.pos[0] - m[0], p.pos[1] - m[1], p.pos[2] - m[2]];
        near(len(rel) - MOON_RADIUS_ER, LUNAR_ALT_KM / EARTH_RADIUS_KM, 1e-9, 'orbit height');
        // Orthonormal camera basis; up is the local vertical tilted by the pitch.
        near(len(p.fwd), 1, 1e-12, 'unit forward');
        near(dot(p.fwd, p.up), 0, 1e-12, 'up ⟂ forward');
        // The Earth: centred left–right, in the lower half above the limb.
        const e = [-p.pos[0], -p.pos[1], -p.pos[2]];
        const el = len(e);
        const right = [p.fwd[1] * p.up[2] - p.fwd[2] * p.up[1], p.fwd[2] * p.up[0] - p.fwd[0] * p.up[2], p.fwd[0] * p.up[1] - p.fwd[1] * p.up[0]];
        const t = Math.tan(p.fovDeg * D / 2);
        const ex = dot(e, right) / dot(e, p.fwd) / t, ey = dot(e, p.up) / dot(e, p.fwd) / t;
        assert.ok(Math.abs(ex) < 0.02, `Earth x ${ex}`);
        assert.ok(ey > -LIMB_NDC_Y && ey < 0, `Earth y ${ey} between the limb and the centre`);
        assert.ok(el > 55 && el < 65, 'Earth distance');
        // The orbiter rose over the limb on the Sun's side: its zenith leans sunward.
        const zen = rel.map((x) => x / len(rel));
        assert.ok(dot(zen, s.sunDirS) > -0.05, `foreground sunlit side (${dot(zen, s.sunDirS).toFixed(3)})`);
    });
}

test('Earthrise: half an orbit later the Earth is behind the Moon, one orbit later it is back', () => {
    const s = snapAt('2026-11-04T12:00:00Z');
    const plan = planLunarOrbit(s);
    const P = lunarPeriodS() * 1000;
    assert.ok(earthAboveLimbDeg(plan, s.tMs - P / 4, s.moonPosS) < 0, 'not yet risen a quarter orbit before');
    near(earthAboveLimbDeg(plan, s.tMs + P, s.moonPosS), EARTHRISE_DEG, 1e-6, 'same Moon, one orbit later');
});
