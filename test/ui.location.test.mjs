// The location picker's place preview (ROADMAP picker-place-preview): a place's Sun altitude,
// twilight phase, next sunrise or sunset and 'Moon up' from the snapshot's sub-points, checked
// against Astronomy Engine at the place itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeSky, skyWords, PHASE_LABEL } from '../js/ui/location.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';
import { AE } from '../js/astro/ae.js';
import { fmtRelative } from '../js/core/format.js';

const PLACES = [
    { name: 'London', latDeg: 51.5074, lonDeg: -0.1278 },
    { name: 'Santiago', latDeg: -33.4489, lonDeg: -70.6693 },
    { name: 'Sanaa', latDeg: 15.3694, lonDeg: 44.191 },
    { name: 'Tromsø', latDeg: 69.6492, lonDeg: 18.9553 },
    { name: 'Longyearbyen', latDeg: 78.2232, lonDeg: 15.6267 },
    { name: 'Quito', latDeg: -0.1807, lonDeg: -78.4678 },
];
const TIMES = ['2026-11-04T06:30:00Z', '2027-03-20T18:00:00Z', '2027-06-21T02:10:00Z', '2027-12-10T13:45:00Z'].map(Date.parse);
const GREENWICH = { latDeg: 51.4779, lonDeg: -0.0015, elevM: 0 };

const snapAt = (() => {
    const snap = createSnapshot();
    return (t) => { computeSnapshot(t, GREENWICH, snap, { detail: 'frame' }); return snap; };
})();
/** AE's geometric (unrefracted) topocentric altitude of a body at a place. */
function aeAlt(name, p, t, refraction = '') {
    const obs = new AE.Observer(p.latDeg, p.lonDeg, 0);
    const time = AE.MakeTime(new Date(t));
    const eq = AE.Equator(name, time, obs, true, true);
    return AE.Horizon(time, obs, eq.ra, eq.dec, refraction).altitude;
}

test('placeSky: the Sun\'s altitude from its sub-point is AE\'s at the place to 0.05°, and the phase follows it', () => {
    for (const t of TIMES) {
        const snap = snapAt(t);
        for (const p of PLACES) {
            const sky = placeSky(p.latDeg, p.lonDeg, snap.bodies[0], snap.bodies[1], t);
            const alt = aeAlt('Sun', p, t);
            assert.ok(Math.abs(sky.sunAlt - alt) < 0.05, `${p.name} ${new Date(t).toISOString()}: ${sky.sunAlt} vs ${alt}`);
            const want = alt > -0.833 ? 'day' : alt > -6 ? 'civil' : alt > -12 ? 'nautical' : alt > -18 ? 'astro' : 'night';
            if (Math.abs(alt - Math.round(alt)) > 0.1) assert.equal(sky.phase, want, `${p.name}: ${alt}`);
        }
    }
});

test('placeSky: the next sunrise or sunset is AE\'s to a minute when it is near (the 90 minutes the line names it)', () => {
    let near = 0, far = 0;
    for (const t0 of TIMES) {
        for (const p of PLACES) {
            const obs = new AE.Observer(p.latDeg, p.lonDeg, 0);
            for (const dir of [+1, -1]) {
                const ev = AE.SearchRiseSet('Sun', obs, dir, AE.MakeTime(new Date(t0)), 1);
                if (!ev) continue;
                const at = ev.date.getTime();
                // 40 minutes before it, and from t0 itself (hours ahead: the held declination drifts).
                for (const [t, tol] of [[at - 40 * 60e3, 60e3], [t0, 8 * 60e3]]) {
                    const snap = snapAt(t);
                    const sky = placeSky(p.latDeg, p.lonDeg, snap.bodies[0], snap.bodies[1], t);
                    const got = dir > 0 ? sky.riseMs : sky.setMs;
                    if (t === t0 && got === null) continue; // the other crossing comes first
                    assert.ok(got !== null, `${p.name} ${new Date(t).toISOString()}: ${dir > 0 ? 'rise' : 'set'} expected`);
                    assert.ok(Math.abs(got - at) < tol, `${p.name}: ${new Date(got).toISOString()} vs ${ev.date.toISOString()}`);
                    assert.equal(dir > 0 ? sky.setMs : sky.riseMs, null, 'only the next crossing is given');
                    if (t === t0) far++; else near++;
                }
            }
        }
    }
    assert.ok(near >= 30 && far >= 15, `${near} near, ${far} far`);
    // Longyearbyen in late November: polar night, no sunrise to count down to.
    const t = Date.parse('2026-11-30T11:00:00Z');
    const snap = snapAt(t);
    const lyb = placeSky(78.2232, 15.6267, snap.bodies[0], snap.bodies[1], t);
    assert.deepEqual([lyb.riseMs, lyb.setMs], [null, null]);
    assert.notEqual(lyb.phase, 'day');
});

test('placeSky: "Moon up" matches AE\'s refracted Moon (upper limb) away from the horizon', () => {
    let up = 0, down = 0;
    for (const t of TIMES) {
        const snap = snapAt(t);
        for (const p of PLACES) {
            const sky = placeSky(p.latDeg, p.lonDeg, snap.bodies[0], snap.bodies[1], t);
            const alt = aeAlt('Moon', p, t, 'normal') + 0.26;
            if (Math.abs(alt) < 0.5) continue;
            assert.equal(sky.moonUp, alt > 0, `${p.name} ${new Date(t).toISOString()}: Moon at ${alt.toFixed(2)}°`);
            if (sky.moonUp) up++; else down++;
        }
    }
    assert.ok(up > 3 && down > 3, `${up} up, ${down} down`);
});

test('placeSky: null without a Sun sub-point (standing on Mars) or a place', () => {
    assert.equal(placeSky(10, 10, { subLatDeg: NaN, subLonDeg: NaN }, null, 0), null);
    assert.equal(placeSky(NaN, 10, { subLatDeg: 0, subLonDeg: 0 }, null, 0), null);
    assert.equal(placeSky(10, 10, null, null, 0), null);
    const s = placeSky(0, 0, { subLatDeg: 0, subLonDeg: 0 }, null, 0);
    assert.equal(s.moonUp, false, 'no Moon, no "Moon up"');
    assert.ok(Math.abs(s.sunAlt - 90) < 1e-9);
});

test('skyWords: sunrise or sunset within 90 minutes, else the phase, then "Moon up"', () => {
    const t = 0, rel = (ms) => fmtRelative(ms, t);
    assert.equal(skyWords({ phase: 'civil', riseMs: 12 * 60e3, setMs: null, moonUp: false }, t, rel), 'sunrise in 12 min');
    assert.equal(skyWords({ phase: 'day', riseMs: null, setMs: 65 * 60e3, moonUp: true }, t, rel), 'sunset in 1 h 5 min, Moon up');
    assert.equal(skyWords({ phase: 'night', riseMs: 5 * 3600e3, setMs: null, moonUp: true }, t, rel), 'night, Moon up');
    assert.equal(skyWords({ phase: 'nautical', riseMs: null, setMs: null, moonUp: false }, t, rel), 'nautical twilight');
    assert.deepEqual(Object.keys(PHASE_LABEL), ['day', 'civil', 'nautical', 'astro', 'night']);
});
