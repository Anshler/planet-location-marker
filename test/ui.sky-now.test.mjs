// Panel wording for lunar eclipses: the geometric phase stays near 100 % through an eclipse, so the
// panels name the eclipse from snap.eclipse.moonLitFraction instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lunarEclipseState, moonPhaseName, solarEclipseState, solarDiscGeometry, shownMag } from '../js/ui/sky-now.js';

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
    assert.equal(`${moonPhaseName(180)} ${ecl.text}`, 'Full Moon in total eclipse');
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
