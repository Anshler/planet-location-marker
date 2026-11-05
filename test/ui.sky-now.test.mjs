// Panel wording for lunar eclipses: the geometric phase stays near 100 % through an eclipse, so the
// panels name the eclipse from snap.eclipse.moonLitFraction instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lunarEclipseState, moonPhaseName, moonEclipseText, solarEclipseState, solarDiscGeometry, shownMag, subText, downText } from '../js/ui/sky-now.js';
import { AE } from '../js/astro/ae.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

test('lunarEclipseState: total, partial and none', () => {
    assert.deepEqual(lunarEclipseState({ eclipse: { lunar: true, moonLitFraction: 0 } }),
        { total: true, sunlit: 0, text: 'in total eclipse' });
    assert.deepEqual(lunarEclipseState({ eclipse: { lunar: true, moonLitFraction: 0.42 } }),
        { total: false, sunlit: 0.42, text: 'in eclipse, 42% sunlit' });
    assert.equal(lunarEclipseState({ eclipse: { lunar: true, moonLitFraction: 0.995 } }), null, 'a faint penumbral graze is not news');
    assert.equal(lunarEclipseState({ eclipse: { lunar: false, moonLitFraction: 1 } }), null);
    assert.equal(lunarEclipseState({ eclipse: { lunar: true } }), null, 'older snapshots without the field');
    assert.equal(lunarEclipseState(null), null);
});

test('the Sky-now line for a totally eclipsed full Moon reads naturally', () => {
    const ecl = lunarEclipseState({ eclipse: { lunar: true, moonLitFraction: 0 } });
    assert.equal(moonEclipseText(moonPhaseName(180), ecl), 'Full Moon in total eclipse');
    assert.equal(moonEclipseText(moonPhaseName(180), lunarEclipseState({ eclipse: { lunar: true, moonLitFraction: 0.42 } })), 'Full Moon in eclipse, 42% sunlit');
});

// Solar eclipses: the panels name the eclipse from snap.eclipse.obscurationAtObserver, and the
// topocentric disc sizes decide total / annular / partial.
const AS = Math.PI / 648000;
function solarSnap(obsc, { sepAs = 0, rSunAs = 945, rMoonAs = 980 } = {}) {
    const a = [1, 0, 0];
    const m = [Math.cos(sepAs * AS), Math.sin(sepAs * AS), 0];
    return {
        observer: { upS: [0, 1, 0] },
        eclipse: { solar: obsc > 0, obscurationAtObserver: obsc },
        bodies: [{ id: 'sun', dirS: a, angDiamArcsec: 2 * rSunAs }, { id: 'moon', dirS: m, angDiamArcsec: 2 * rMoonAs }],
    };
}

test('solarEclipseState: total, annular, partial and none', () => {
    assert.equal(solarEclipseState(solarSnap(1, { sepAs: 10 })).kind, 'total');
    assert.equal(solarEclipseState(solarSnap(1, { sepAs: 10 })).text, 'Total solar eclipse');
    const ann = solarEclipseState(solarSnap(0.9, { sepAs: 10, rSunAs: 960, rMoonAs: 900 }));
    assert.equal(ann.kind, 'annular');
    assert.equal(ann.text, 'Annular solar eclipse, 90% of the Sun covered');
    const p = solarEclipseState(solarSnap(0.84, { sepAs: 700 }));
    assert.equal(p.kind, 'partial');
    assert.equal(p.text, 'Partial solar eclipse, 84% of the Sun covered');
    // A thin crescent is still partial, and never rounds up to 100 %.
    const thin = solarEclipseState(solarSnap(0.9996, { sepAs: 40 }));
    assert.equal(thin.kind, 'partial');
    assert.equal(thin.text, 'Partial solar eclipse, 99.9% of the Sun covered');
    assert.equal(solarEclipseState(solarSnap(0)), null, 'Sun down or not covered');
    assert.equal(solarEclipseState({ eclipse: { obscurationAtObserver: 0.5 } }).kind, 'partial', 'no disc data');
    assert.equal(solarEclipseState(null), null);
});

test('solarEclipseState never reads "Partial … 100.0%" and says Total exactly in AE\'s totality (Luxor 2027-08-02)', () => {
    const obs = { latDeg: 25.7, lonDeg: 32.6, elevM: 0 };
    const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date('2027-07-01')), new AE.Observer(obs.latDeg, obs.lonDeg, 0));
    const c2 = ls.total_begin.time.date.getTime(), c3 = ls.total_end.time.date.getTime();
    const snap = createSnapshot();
    let first = NaN, last = NaN;
    for (const [from, to] of [[c2 - 90e3, c2 + 30e3], [c3 - 30e3, c3 + 90e3]]) {
        for (let t = from; t <= to; t += 250) {
            for (const detail of ['frame', 'full']) {
                computeSnapshot(t, obs, snap, { detail });
                const st = solarEclipseState(snap);
                assert.ok(st, `eclipse state at ${new Date(t).toISOString()}`);
                const at = `${new Date(t).toISOString()} (${detail}): ${st.text}`;
                assert.ok(!/^Partial.*100\.0%/.test(st.text), at);
                assert.equal(st.kind === 'total', snap.eclipse.obscurationAtObserver === 1, at);
                if (st.kind === 'total') {
                    if (!(first <= t)) first = t;
                    last = t;
                }
            }
        }
    }
    // Sampled every 250 ms: totality starts and ends within 1 s of AE's second and third contacts.
    assert.ok(Math.abs(first - c2) < 1000, `first Total ${(first - c2) / 1000} s from C2`);
    assert.ok(Math.abs(last - c3) < 1000, `last Total ${(last - c3) / 1000} s from C3`);
});

test('solarDiscGeometry: separation in arcsec and the Moon position angle', () => {
    const g = solarDiscGeometry(solarSnap(0.5, { sepAs: 600 }));
    assert.ok(Math.abs(g.sep - 600) < 1e-3);
    assert.equal(g.rS, 945);
    assert.ok(Math.abs(g.pa) < 1e-9, 'Moon toward the zenith: position angle 0 (up)');
});

test('shownMag hides the magnitude of an invisible new Moon only', () => {
    assert.equal(shownMag({ id: 'moon', mag: -4.0, phaseFrac: 0.001 }), null);
    assert.equal(shownMag({ id: 'moon', mag: -4.7, phaseFrac: 0.02 }), -4.7);
    assert.equal(shownMag({ id: 'venus', mag: -4.5, phaseFrac: 0.001 }), -4.5);
    assert.equal(shownMag({ id: 'sun', mag: NaN }), null);
});

// The Charts card's preference (§10.2): `chart` joins `skyDome`, and the older `tonightOpen` migrates once.
test('chartsPref: a chart and an open state the user chose; Tonight wins only where it was the open card', async () => {
    const { chartsPref } = await import('../js/ui/sky-now.js');
    assert.deepEqual(chartsPref(null, null), { mode: 'up', chart: 'dome' }, 'first visit: no open state, the layout decides');
    assert.deepEqual(chartsPref(null, true), { mode: 'up', open: true, chart: 'tonight' });
    assert.deepEqual(chartsPref({ open: false, mode: 'map' }, true), { open: true, mode: 'map', chart: 'tonight' }, 'a closed dome under an open Tonight');
    assert.deepEqual(chartsPref({ open: true, mode: 'up' }, true), { open: true, mode: 'up', chart: 'dome' }, 'an open dome stays the dome');
    assert.deepEqual(chartsPref({ open: false }, false), { open: false, mode: 'up', chart: 'dome' });
    assert.deepEqual(chartsPref({ open: true, chart: 'tonight', mode: 'map' }, false), { open: true, chart: 'tonight', mode: 'map' }, 'once migrated, tonightOpen is ignored');
    assert.deepEqual(chartsPref({ open: 'yes', chart: 'pie' }, null), { mode: 'up', chart: 'dome' }, 'junk is dropped');
});

test('a body that never rises: "stays down" on the right, only its magnitude below (no second "stays below")', () => {
    const ui = { fmt: () => '—' };
    const never = { status: 'never', nextRiseMs: null };
    assert.equal(downText(ui, never, 0), 'stays down');
    assert.equal(subText(never, 'Stays below the horizon', false, 'mag 0.6'), 'mag 0.6');
    assert.equal(subText({ status: 'normal', nextRiseMs: 5e6 }, 'Rises 21:03', false, 'mag 0.6'), 'Rises 21:03 · mag 0.6');
    assert.equal(subText({ status: 'circumpolar', nextRiseMs: null }, 'Up all day', true, ''), 'Up all day');
});
