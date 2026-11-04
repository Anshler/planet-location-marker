// Catalogue stars as extra objects (astro/stars.js), their designations and parallaxes
// (data/starinfo.js), and the light-time sentences (astro/lighttime.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeSky } from '../js/data/catalog.js';
import { decodeStarInfo, designations, bayerText, starDisplayName, GENITIVE } from '../js/data/starinfo.js';
import { createStarProvider, starKind } from '../js/astro/stars.js';
import { parallaxDistance, departureLine, lyWords, spanWords, yearWords, historyNear, HISTORY, LY_PER_PC } from '../js/astro/lighttime.js';
import { createExtras } from '../js/astro/extras.js';
import { createSnapshot, computeSnapshot } from '../js/astro/snapshot.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const CAT = decodeSky(read('data/sky.json'));
const INFO = decodeStarInfo(read('data/starinfo.json'), CAT.srcHip);
const T2026 = Date.parse('2026-11-04T12:00:00Z');

test('parallax distances: Hipparcos New Reduction values (Betelgeuse, Sirius, α Centauri)', () => {
    const bet = INFO.get(27989);
    assert.deepEqual([bet.plx, bet.eplx], [6.55, 0.83]);
    const d = parallaxDistance(bet.plx, bet.eplx);
    assert.ok(Math.abs(d.ly - 497.9) < 0.5, `${d.ly}`);
    assert.ok(Math.abs(d.sigmaLy / d.ly - 0.1267) < 0.001);
    const sirius = parallaxDistance(INFO.get(32349).plx, INFO.get(32349).eplx);
    assert.ok(Math.abs(sirius.ly - 8.60) < 0.01, `Sirius ${sirius.ly}`);   // 379.21 mas
    const acen = parallaxDistance(INFO.get(71683).plx, INFO.get(71683).eplx);
    assert.ok(Math.abs(acen.ly - 4.32) < 0.02, `α Cen A ${acen.ly}`);
    // Not significant: only a lower bound.
    const far = parallaxDistance(0.5, 0.6);
    assert.ok(Number.isNaN(far.ly) && far.lowerLy > 1000);
    assert.ok(Math.abs(1000 / 1 * LY_PER_PC - 3261.56) < 0.01, '1 mas = 3,262 ly');
});

test('departure sentences are as precise as the distance', () => {
    const bet = parallaxDistance(6.55, 0.83);
    assert.equal(departureLine(T2026, bet.ly, bet.sigmaLy),
        'The light you see left around the 1500s — when Copernicus put the Sun at the centre.');
    const sir = parallaxDistance(379.21, 1.58);
    assert.equal(departureLine(T2026, sir.ly, sir.sigmaLy), 'The light you see left in 2018, 8.6 years ago.');
    // Rounded catalogue distances (deep-sky objects): a rounded light-time.
    assert.equal(departureLine(T2026, 2800), 'The light you see left about 2,800 years ago — around when the first Olympic Games were held.');
    assert.equal(departureLine(T2026, 163000), 'The light you see left 163,000 years ago — before people painted the first cave art.');
    assert.equal(departureLine(T2026, 2.5e6), 'The light you see left 2.5 million years ago — when our ancestors made the first stone tools.');
    // Seen from 1066, the same star's light left about 500 years earlier still.
    assert.match(departureLine(Date.UTC(1066, 9, 14), bet.ly, bet.sigmaLy), /^The light you see left around the 500s/);
    assert.equal(departureLine(T2026, 0), '');
    assert.equal(yearWords(1528, 100), 'the 1500s');
    assert.equal(yearWords(1983, 10), 'the 1980s');
    assert.equal(yearWords(-600, 100), 'the 7th century BCE');
    assert.equal(yearWords(-43, 1), '44 BCE');
    assert.equal(spanWords(17000), '17,000 years');
    assert.equal(lyWords(497.9, 63.1), 'about 500 light-years (± 13 %)');
    assert.equal(lyWords(433, 6), '430 light-years');
    assert.equal(historyNear(1540, 10)[0], 1543);
    assert.equal(historyNear(1700, 5), null);
    for (let k = 1; k < HISTORY.length; k++) assert.ok(HISTORY[k][0] < HISTORY[k - 1][0], 'newest first');
});

test('designations: Bayer with genitive, Flamsteed, variable, HIP', () => {
    assert.equal(Object.keys(GENITIVE).length, 88);
    assert.deepEqual(designations(INFO.get(27989), 27989), ['α Orionis', '58 Ori', 'HIP 27989']);
    assert.equal(starDisplayName(INFO.get(27989), 27989), 'Betelgeuse');
    assert.equal(bayerText('κ1'), 'κ¹');
    assert.equal(bayerText('ψ12'), 'ψ¹²');
    assert.deepEqual(designations({ flam: '61', con: 'Cyg' }, 104214), ['61 Cygni', 'HIP 104214']);
    assert.deepEqual(designations(null, 5), ['HIP 5']);
    assert.throws(() => decodeStarInfo(read('data/starinfo.json'), CAT.srcHip.slice(1)), TypeError);
});

test('starKind: colour and luminosity class from B−V and absolute magnitude', () => {
    assert.equal(starKind(1.85, -5.5).kind, 'Red supergiant');      // Betelgeuse
    assert.equal(starKind(0.0, 1.45).kind, 'White main-sequence star');   // Sirius
    assert.equal(starKind(1.24, -0.3).kind, 'Orange giant');       // Arcturus
    assert.equal(starKind(-0.03, -6.9).kind, 'Blue-white supergiant');   // Rigel
    assert.equal(starKind(0.64, -3.6).kind, 'Yellow supergiant');  // Polaris (F7 Ib)
    assert.equal(starKind(0.65, NaN).kind, 'Yellow star');
});

test('provider: one slot for the star being looked at; meta, fill and the card', () => {
    const extras = createExtras();
    let asked = 0;
    let info = null;
    const p = createStarProvider({ getCatalog: () => CAT, getInfo: () => info, needInfo: () => { asked++; } });
    extras.register(p);
    assert.deepEqual(extras.ids('star'), []);
    assert.equal(p.track('star:27989'), true);
    assert.equal(p.track('star:27989'), false, 'no change');
    assert.equal(asked, 1, 'asks for starinfo.json on the first selection');
    extras.refresh();
    assert.deepEqual(extras.ids('star'), ['star:27989']);
    assert.equal(extras.meta('star:27989').name, 'Betelgeuse', 'a bright star is named before starinfo arrives');
    assert.equal(extras.meta('star:27989').glyph, 'none');
    const s = createSnapshot();
    computeSnapshot(Date.parse('2027-01-20T05:00:00Z'), { latDeg: 37, lonDeg: -118.2, elevM: 0 }, s, { detail: 'full' });
    extras.fill(s);
    const st = extras.state(s, 'star:27989');
    assert.equal(st.present, true);
    const i = CAT.stars.hip.indexOf(27989);
    assert.deepEqual([...st.dirS].map((v) => Math.fround(v)), [...CAT.stars.dirS.subarray(3 * i, 3 * i + 3)]);
    assert.ok(Number.isNaN(st.distAU), 'no distance before starinfo');
    info = INFO;
    extras.refresh();
    extras.fill(s);
    const st2 = extras.state(s, 'star:27989');
    assert.ok(Math.abs(st2.lightTimeS / (365.25 * 86400) - 497.9) < 0.5, 'light-time from the parallax');
    const card = extras.card('star:27989', s);
    assert.equal(card.kindLabel, 'Red supergiant');
    assert.equal(card.subtitle, 'α Orionis');
    assert.match(card.lines[0], /left around the 1500s/);
    assert.deepEqual(card.facts.find(([k]) => k === 'Designation'), ['Designation', 'α Orionis · 58 Ori · HIP 27989']);
    assert.match(card.caveat, /6\.55 ± 0\.83 mas/);
    assert.ok(card.rts.transitMs !== null);
    // Polaris: its distance from the pole of date.
    p.track('star:11767');
    extras.refresh();
    extras.fill(s);
    const pol = extras.card('star:11767', s);
    const fact = pol.facts.find(([k]) => k === 'From the north celestial pole');
    assert.ok(fact && Math.abs(Number.parseFloat(fact[1]) - 0.63) < 0.02, fact?.[1]);
    // Anything else drops the slot.
    assert.equal(p.track('moon'), true);
    extras.refresh();
    assert.deepEqual(extras.ids('star'), []);
});

test('a selected fast star is at the snapshot epoch before the sky module moves the catalogue', () => {
    const cat = decodeSky(read('data/sky.json'));
    const extras = createExtras();
    const p = createStarProvider({ getCatalog: () => cat, getInfo: () => null });
    extras.register(p);
    p.track('star:69673');   // Arcturus, 2.3″/yr
    extras.refresh();
    const i = cat.stars.hip.indexOf(69673);
    const j2000 = [...cat.stars.dirS.subarray(3 * i, 3 * i + 3)];
    const s = createSnapshot();
    computeSnapshot(Date.UTC(1000, 5, 1, 22), { latDeg: 50.91, lonDeg: 0.49, elevM: 0 }, s, { detail: 'frame' });
    extras.fill(s);
    const st = extras.state(s, 'star:69673');
    const sep = Math.acos(Math.min(1, st.dirS[0] * j2000[0] + st.dirS[1] * j2000[1] + st.dirS[2] * j2000[2])) * 180 / Math.PI;
    assert.ok(sep > 0.55 && sep < 0.75, `moved ${sep}°`);
    assert.equal(cat.stars.pm.years, Math.round((Date.UTC(1000, 5, 1, 22) - Date.UTC(2000, 0, 1, 12)) / (365.25 * 864e5)));
    assert.deepEqual([...st.dirS].map((v) => Math.fround(v)), [...cat.stars.dirS.subarray(3 * i, 3 * i + 3)]);
});

test('a star too far for a parallax: the light left before a moment that is safely later', () => {
    const extras = createExtras();
    const info = new Map([[26549, { plx: 0.5, eplx: 0.6, con: 'Ori' }]]);
    const p = createStarProvider({ getCatalog: () => CAT, getInfo: () => info });
    extras.register(p);
    p.track('star:26549');
    extras.refresh();
    const s = createSnapshot();
    computeSnapshot(T2026, { latDeg: 37, lonDeg: -118.2, elevM: 0 }, s, { detail: 'full' });
    extras.fill(s);
    const card = extras.card('star:26549', s);
    const line = card.lines.find((l) => l.startsWith('Too far'));
    assert.ok(line, card.lines.join(' | '));
    assert.doesNotMatch(line, /telescope was invented|pyramids rose/);
    const lower = parallaxDistance(0.5, 0.6).lowerLy;
    const [, words] = HISTORY.filter((h) => h[0] > 2026 - lower && h[0] <= 2026).at(-1);
    assert.match(line, new RegExp(`left before ${words}`));
});
