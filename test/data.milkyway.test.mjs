// data/milkyway.png: format, orientation and shape of the galactic band (SPEC §G), and the smooth
// isophote interpolation that replaced the flat contour terraces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodePng, encodePng } from '../scripts/lib/png.mjs';
import { renderMilkyWay, unwrapRing, levelValue, distanceField, W, H, LEVELS, L_MAX } from '../scripts/build-milkyway.mjs';

const BYTES = fs.readFileSync(new URL('../data/milkyway.png', import.meta.url));
const IMG = decodePng(BYTES);
const D = Math.PI / 180;

/** Pixel at RA/Dec using the documented mapping: x ↔ RA = 360·(x+0.5)/W, y ↔ Dec = 90 − 180·(y+0.5)/H. */
const at = (ra, dec) => {
    const x = Math.min(W - 1, Math.floor((((ra % 360) + 360) % 360) / 360 * W));
    const y = Math.min(H - 1, Math.max(0, Math.floor((90 - dec) / 180 * H)));
    return IMG.data[y * W + x];
};
const raDecOf = (i) => [360 * ((i % W) + 0.5) / W, 90 - 180 * (Math.floor(i / W) + 0.5) / H];
const sep = (ra1, dec1, ra2, dec2) => Math.acos(Math.min(1, Math.sin(dec1 * D) * Math.sin(dec2 * D)
    + Math.cos(dec1 * D) * Math.cos(dec2 * D) * Math.cos((ra1 - ra2) * D))) / D;

// ICRS → galactic rotation (rows); equatorial = Tᵀ · galactic.
const T = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445],
    [-0.8676661490, -0.1980763734, 0.4559837762]];
function galToEq(l, b) {
    const g = [Math.cos(b * D) * Math.cos(l * D), Math.cos(b * D) * Math.sin(l * D), Math.sin(b * D)];
    const e = [0, 1, 2].map((i) => T[0][i] * g[0] + T[1][i] * g[1] + T[2][i] * g[2]);
    return [((Math.atan2(e[1], e[0]) / D) + 360) % 360, Math.asin(e[2]) / D];
}
const litFraction = (b) => {
    let n = 0, lit = 0;
    for (let l = 0; l < 360; l += 0.5) {
        for (const bb of b === 0 ? [0] : [b, -b]) {
            n++;
            if (at(...galToEq(l, bb)) > 0) lit++;
        }
    }
    return lit / n;
};

test('2048×1024 8-bit greyscale, within the size target', () => {
    assert.equal(IMG.width, 2048);
    assert.equal(IMG.height, 1024);
    assert.equal(IMG.channels, 1);
    assert.equal(BYTES[25], 0, 'PNG colour type 0 (grey)');
    assert.ok(BYTES.length <= 200e3, `${BYTES.length} bytes (textures.js weights the loader with 200 KB)`);
});

test('galactic centre region is the brightest part of the sky', () => {
    const [ra, dec] = galToEq(0, 0);
    assert.ok(Math.abs(ra - 266.405) < 0.01 && Math.abs(dec + 28.936) < 0.01, 'galactic frame sanity');
    let max = 0;
    for (let dra = -3.5; dra <= 3.5; dra += 0.05) {
        for (let dd = -3; dd <= 3; dd += 0.05) {
            if ((dra * Math.cos(dec * D)) ** 2 + dd ** 2 <= 9) max = Math.max(max, at(ra + dra, dec + dd));
        }
    }
    let gmax = 0, gi = 0;
    for (let i = 0; i < IMG.data.length; i++) if (IMG.data[i] > gmax) { gmax = IMG.data[i]; gi = i; }
    assert.ok(gmax >= 0.9 * 255, `brightest pixel ${gmax}: the code range is used`);
    assert.ok(sep(...raDecOf(gi), ra, dec) <= 8, `brightest pixel ${sep(...raDecOf(gi), ra, dec).toFixed(1)}° from the centre`);
    assert.ok(max >= 0.95 * gmax, `max within 3° of the centre = ${max} (sky max ${gmax})`);
    assert.ok(at(ra, dec) >= 100, `value at the centre = ${at(ra, dec)}`);
});

test('band follows the galactic equator and the galactic poles are dark', () => {
    assert.ok(litFraction(0) >= 0.9, `b=0 lit ${litFraction(0)}`);
    assert.ok(litFraction(30) <= 0.005, `|b|=30° lit ${litFraction(30)}`);
    assert.ok(litFraction(60) === 0);
    assert.equal(at(192.859, 27.128), 0, 'north galactic pole');
    assert.equal(at(12.859, -27.128), 0, 'south galactic pole');
});

test('orientation: north up, RA increasing to the right', () => {
    assert.ok(at(270, -28) > 200 && at(90, -28) === 0, 'Sagittarius bright, its RA mirror dark');
    assert.ok(at(305, 40) > 0 && at(305, -40) === 0, 'Cygnus lit, its Dec mirror dark');
});

test('seamless across RA 0h/24h', () => {
    let seam = 0, adjacent = 0;
    for (let y = 0; y < H; y++) {
        seam += Math.abs(IMG.data[y * W] - IMG.data[y * W + W - 1]);
        adjacent += Math.abs(IMG.data[y * W + 1] - IMG.data[y * W + 2]);
    }
    assert.ok(seam / H <= Math.max(0.5, 2 * adjacent / H), `seam ${seam / H} vs adjacent ${adjacent / H}`);
});

test('no terraces: brightness ramps between the contour levels instead of sitting on plateaus', () => {
    // Filling ol1..ol5 with flat steps put ~40 % of the lit sky on one code value (the ol1 plateau).
    const hist = new Uint32Array(256);
    let n = 0;
    for (const v of IMG.data) if (v >= 20) { hist[v]++; n++; }
    const top = Math.max(...hist);
    assert.ok(top / n < 0.04, `most common code holds ${(100 * top / n).toFixed(1)} % of the band`);
    // A soft outer edge: walking out of the band at Sagittarius, the glow fades over several degrees.
    let steps = 0;
    for (let b = -12; b >= -30; b -= 0.25) {
        const v = at(...galToEq(0, b));
        if (v > 0 && v < 40) steps++;
    }
    assert.ok(steps >= 8, `${steps / 4}° of faint fringe south of the bulge`);
});

test('isophote interpolation is continuous across each contour and fades to zero outside', () => {
    for (let k = 1; k <= LEVELS; k++) {
        // Just outside contour k (count k−1, b → 0) meets just inside it (count k, a → 0).
        assert.ok(Math.abs(levelValue(k - 1, 1, 1e-9) - k) < 1e-6, `outside contour ${k}`);
        assert.ok(Math.abs(levelValue(k, 1e-9, 1) - k) < 1e-6, `inside contour ${k}`);
    }
    assert.equal(levelValue(0, 0, 10), 0, 'far outside ol1');
    assert.ok(levelValue(0, 0, 1) > levelValue(0, 0, 2), 'fades with distance');
    assert.ok(levelValue(2, 1, 1) === 2.5, 'halfway between two isophotes');
    assert.ok(levelValue(LEVELS, 50, Infinity) < L_MAX, 'core stays below L_MAX');
    assert.equal(levelValue(3, 0.5, Infinity), 3, 'no higher contour: holds the level');
});

test('distanceField measures degrees on the sky, scaled by cos δ and wrapping in RA', () => {
    const px = 180 / H;
    const eq = (H / 2) * W;                 // first pixel of the row just south of the equator
    const d = distanceField((i) => i === eq + 5);
    assert.equal(d[eq + 5], 0);
    assert.ok(Math.abs(d[eq + 15] - 10 * px * Math.cos(0.5 * px * D)) < 1e-3, 'ten columns east');
    assert.ok(Math.abs(d[eq + W - 5] - 10 * px * Math.cos(0.5 * px * D)) < 1e-3, 'ten columns west, across RA 0h');
    assert.ok(Math.abs(d[eq + 5 - 4 * W] - 4 * px) < 1e-3, 'four rows north');
    const y60 = Math.round((90 - 60) / px);   // a row near Dec +60°: columns are half as far apart
    const r = y60 * W;
    const d60 = distanceField((i) => i === r);
    const cos = Math.cos((90 - (y60 + 0.5) * px) * D);
    assert.ok(Math.abs(d60[r + 20] - 20 * px * cos) < 1e-3, `cos δ scaling ${d60[r + 20]}`);
});

test('ring unwrapping: a pole-encircling ring is closed through the south pole', () => {
    const ring = [[170, 10], [-170, 12], [-90, 10], [0, 8], [90, 9], [170, 10]];
    const { ra, dec, winding } = unwrapRing(ring);
    assert.equal(winding, 1);
    assert.equal(ra.at(-1), ra[0], 'closes back on the start meridian');
    assert.deepEqual([...dec.slice(-2)], [-90, -90]);
    const local = unwrapRing([[179, 0], [-179, 0], [-179, 2], [179, 2], [179, 0]]);
    assert.equal(local.winding, 0);
    assert.ok(Math.max(...local.ra) - Math.min(...local.ra) < 3, 'seam-crossing ring stays compact');
});

test('reproducible: build-milkyway output from data/raw/mw.json equals the committed file', () => {
    const mw = JSON.parse(fs.readFileSync(new URL('../data/raw/mw.json', import.meta.url), 'utf8'));
    const png = encodePng(W, H, renderMilkyWay(mw));
    assert.ok(png.equals(BYTES), 'data/milkyway.png is stale — run node scripts/build-milkyway.mjs');
});
