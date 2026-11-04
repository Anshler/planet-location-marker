/**
 * Catalogue stars as selectable extra objects (kind 'star', ids `star:<hip>`; pure, no three.js,
 * no DOM). Tap a star and its card reads its name and designations, magnitude, colour, distance
 * and when the light you see left it (astro/lighttime.js).
 *
 * The registry slot exists only for the star being looked at (`track(id)`), so a sky of 5,000 (or,
 * on the max tier, 41,000) stars costs one ExtraState per snapshot, not one per star; picking a star
 * is the star field's own job (render/sky.js pickStar), and the field draws it (glyph 'none').
 *
 * Data: the decoded sky catalogue (data/catalog.js; directions follow proper motion, so a selected
 * Arcturus is where it was in 1066) and data/starinfo.json (data/starinfo.js: designations and the
 * Hipparcos New Reduction parallax), fetched the first time a star is selected; until it arrives the
 * card shows what the catalogue knows and asks for it (`needInfo`).
 *
 * @module astro/stars
 */

import { designations, starDisplayName } from '../data/starinfo.js';
import { parallaxDistance, departureLine, lyWords, AU_PER_LY } from './lighttime.js';
import { guestRiseSet } from './guest-stars.js';
import { sceneToRaDec } from './frames.js';
import { AE } from './ae.js';
import { parseSelectionId } from '../core/selection.js';

const DAY_MS = 86400000;
const RAD2DEG = 180 / Math.PI;
/** A deep (max-tier) star's parallax error when only the parallax shipped: Hipparcos' typical at V ≈ 7–8. */
const DEEP_EPLX_MAS = 1.0;

/** Main-sequence absolute magnitude against B−V (rough, for the giant/supergiant words). */
const MS = [[-0.3, -4.0], [0.0, 0.6], [0.3, 2.6], [0.6, 4.4], [0.8, 5.6], [1.0, 6.4], [1.4, 8.5], [1.8, 11.5]];

function msAbs(bv) {
    if (bv <= MS[0][0]) return MS[0][1];
    for (let k = 1; k < MS.length; k++) {
        if (bv <= MS[k][0]) {
            const [x0, y0] = MS[k - 1], [x1, y1] = MS[k];
            return y0 + (y1 - y0) * (bv - x0) / (x1 - x0);
        }
    }
    return MS.at(-1)[1];
}

/**
 * Colour and (with a distance) luminosity class in words, from B−V and the absolute magnitude.
 * Illustrative: real spectral types come from spectra, not from one colour index.
 * @param {number} bv
 * @param {number} absMag NaN without a distance
 * @returns {{colour:string, cls:string, kind:string}} e.g. {colour:'Red', cls:'M', kind:'Red supergiant'}
 */
export function starKind(bv, absMag) {
    const b = Number.isFinite(bv) ? bv : 0.6;
    const [colour, cls] = b < -0.3 ? ['Blue', 'O'] : b < 0 ? ['Blue-white', 'B'] : b < 0.3 ? ['White', 'A']
        : b < 0.58 ? ['Yellow-white', 'F'] : b < 0.81 ? ['Yellow', 'G'] : b < 1.4 ? ['Orange', 'K'] : ['Red', 'M'];
    if (!Number.isFinite(absMag)) return { colour, cls, kind: `${colour} star` };
    const delta = absMag - msAbs(b);
    const lum = absMag < -3.5 && delta < -3 ? 'supergiant' : delta < -2.5 ? 'giant' : 'main-sequence star';
    return { colour, cls, kind: `${colour} ${lum}` };
}

/** Linear RGB (0…1) → '#rrggbb' sRGB. */
function linToHex(r, g, b) {
    const enc = (v) => {
        const x = Math.max(0, Math.min(1, v));
        const s = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
        return Math.round(s * 255).toString(16).padStart(2, '0');
    };
    return `#${enc(r)}${enc(g)}${enc(b)}`;
}

/**
 * The extras provider for catalogue stars.
 * @param {{getCatalog:()=>any, getInfo?:()=>({get(hip:number):any}|null), needInfo?:()=>void}} deps
 *   `getCatalog`: the current SkyCatalog (main.js R.catalog; the max tier's merged one included);
 *   `getInfo`: the decoded data/starinfo.json, or null until it has arrived; `needInfo`: asks for it.
 * @returns {import('./extras.js').ExtraProvider & {track(id:string|null):boolean, readonly active:string|null}}
 */
export function createStarProvider({ getCatalog, getInfo = () => null, needInfo = () => {} }) {
    let active = null;
    let lookupFor = null;
    /** @type {Map<number, number>} */
    let indexOfHip = new Map();
    let rtsKey = '';
    let rts = null;
    const rd = { raDeg: 0, decDeg: 0 };

    const hipOf = (id) => {
        const p = parseSelectionId(id);
        const h = p && p.kind === 'star' ? Number(p.key) : NaN;
        return Number.isInteger(h) && h > 0 ? h : -1;
    };
    /** Catalogue index of a HIP number (−1), the lookup rebuilt when the catalogue changes. */
    function indexOf(hip) {
        const cat = getCatalog?.();
        const st = cat?.stars;
        if (!st || !st.count) return -1;
        if (lookupFor !== st) {
            lookupFor = st;
            indexOfHip = new Map();
            for (let i = 0; i < st.count; i++) indexOfHip.set(st.hip[i], i);
        }
        return indexOfHip.get(hip) ?? -1;
    }
    function infoOf(hip) {
        const inf = getInfo?.();
        return inf ? inf.get(hip) : null;
    }
    /** Parallax distance: data/starinfo.json for a base star, the catalogue's own `plx` for a deep one. */
    function distanceOf(hip, i) {
        const info = infoOf(hip);
        if (info) return { ...parallaxDistance(info.plx, info.eplx), plx: info.plx, eplx: info.eplx, assumed: false };
        const st = getCatalog?.()?.stars;
        const p = st?.plx && i >= 0 ? st.plx[i] : NaN;
        if (p > 0) return { ...parallaxDistance(p, DEEP_EPLX_MAS), plx: p, eplx: DEEP_EPLX_MAS, assumed: true };
        return null;
    }
    /** The star's constellation code (Astronomy Engine), for designations without one. */
    function conOf(i) {
        const st = getCatalog?.()?.stars;
        if (!st || i < 0) return '';
        const d = [st.dirS[3 * i], st.dirS[3 * i + 1], st.dirS[3 * i + 2]];
        sceneToRaDec(d, rd);
        try { return AE.Constellation(rd.raDeg / 15, rd.decDeg).symbol || ''; } catch { return ''; }
    }

    return {
        kind: 'star',
        kindLabel: 'Star',
        get active() { return active; },
        /**
         * Makes `id` the star with a registry slot (or none for anything else). Returns true when the
         * slot list changed (the caller then calls extras.refresh()).
         * @param {string|null} id
         */
        track(id) {
            const next = id && hipOf(id) > 0 ? id : null;
            if (next === active) return false;
            active = next;
            if (next) needInfo();
            return true;
        },
        ids() {
            return active && indexOf(hipOf(active)) >= 0 ? [active] : [];
        },
        meta(id) {
            const hip = hipOf(id);
            const i = indexOf(hip);
            if (i < 0) return null;
            const st = getCatalog().stars;
            const info = infoOf(hip);
            const bright = getCatalog().starNames?.find?.((s) => s.hip === hip)?.name ?? '';
            const name = info ? starDisplayName(info, hip, conOf(i)) : bright || `HIP ${hip}`;
            return {
                name, short: name, glyph: 'none', label: 'selected', layer: 'stars',
                color: linToHex(st.color[3 * i], st.color[3 * i + 1], st.color[3 * i + 2]),
            };
        },
        fill(snap, id, out) {
            const hip = hipOf(id);
            const i = indexOf(hip);
            if (i < 0) { out.present = false; return; }
            const st = getCatalog().stars;
            out.dirS[0] = st.dirS[3 * i]; out.dirS[1] = st.dirS[3 * i + 1]; out.dirS[2] = st.dirS[3 * i + 2];
            out.mag = st.mag[i];
            const dist = distanceOf(hip, i);
            out.distAU = dist && dist.ly > 0 ? dist.ly * AU_PER_LY : NaN;
            out.present = true;
            out.approx = false;
            if (!out.data) out.data = { fovDeg: 3, index: -1 };
            out.data.index = i;
        },
        card(id, stt, snap) {
            const hip = hipOf(id);
            const i = indexOf(hip);
            if (i < 0) return null;
            const st = getCatalog().stars;
            const info = infoOf(hip);
            if (!info) needInfo();
            const con = info?.con || conOf(i);
            const des = designations(info, hip, con);
            const dist = distanceOf(hip, i);
            const bv = st.bv ? st.bv[i] : NaN;
            // M = m − 5·log10(d / 10 pc); 10 pc = 32.6 light-years.
            const absMag = dist && dist.ly > 0 ? st.mag[i] - 5 * Math.log10(dist.ly / 32.615638) : NaN;
            const k = starKind(bv, absMag);
            const t = snap?.tMs ?? NaN;
            const lines = [];
            const facts = [];
            if (des.length) facts.push(['Designation', des.join(' · ')]);
            let caveat = '';
            if (dist && dist.ly > 0) {
                lines.push(departureLine(t, dist.ly, dist.sigmaLy));
                facts.push(['Distance', lyWords(dist.ly, dist.sigmaLy)]);
                const rel = dist.sigmaLy / dist.ly;
                if (dist.assumed) caveat = 'Distance from the Hipparcos parallax with a typical error assumed; the year its light left is as uncertain.';
                else if (rel >= 0.1) caveat = `Hipparcos parallax ${dist.plx.toFixed(2)} ± ${dist.eplx.toFixed(2)} mas: the distance, and so the year the light left, is uncertain by about ${Math.round(rel * 100)} %.`;
            } else if (dist && dist.lowerLy > 0) {
                lines.push(`Too far for Hipparcos to measure: more than about ${lyWords(dist.lowerLy)} away, so the light you see left before ${Math.round(dist.lowerLy / 100) * 100 > 2000 ? 'the pyramids rose' : 'the telescope was invented'}.`);
            } else if (!info) {
                lines.push('Looking up its distance…');
            }
            facts.push(['Colour', `${k.colour} (B−V ${Number.isFinite(bv) ? bv.toFixed(2) : '—'}, about ${k.cls}-type)`]);
            if (Number.isFinite(absMag)) facts.push(['Luminosity', `absolute magnitude ${absMag < 0 ? '−' : '+'}${Math.abs(absMag).toFixed(1)} (the Sun: +4.8)`]);
            // How far from the celestial pole of date (earthMatrix·ŷ): Polaris was 6° off in 1000.
            const E = snap?.earthMatrix;
            if (E && E.length >= 16) {
                const dot = stt.dirS[0] * E[4] + stt.dirS[1] * E[5] + stt.dirS[2] * E[6];
                const away = Math.acos(Math.max(-1, Math.min(1, Math.abs(dot)))) * RAD2DEG;
                if (away < 20) facts.push([`From the ${dot >= 0 ? 'north' : 'south'} celestial pole`, `${away.toFixed(2)}° (of date)`]);
            }
            const o = snap?.observer;
            if (o && Number.isFinite(t)) {
                const day0 = Math.floor((t + o.lonDeg / 15 * 3600e3) / DAY_MS) * DAY_MS - o.lonDeg / 15 * 3600e3;
                const key = `${id}|${day0}|${o.latDeg.toFixed(2)}|${o.lonDeg.toFixed(2)}`;
                if (key !== rtsKey) {
                    rtsKey = key;
                    sceneToRaDec(stt.dirS, rd);
                    try { rts = guestRiseSet({ raH: rd.raDeg / 15, decDeg: rd.decDeg, distLy: Math.max(1, dist?.ly || 1000) }, o, day0); } catch { rts = null; }
                }
            }
            return {
                kindLabel: k.kind,
                subtitle: info?.name && des[0] ? des[0] : '',
                lines,
                facts,
                caveat,
                rts,
                sources: ['Hipparcos New Reduction (van Leeuwen 2007)', 'd3-celestial star names and positions (Hipparcos)'],
            };
        },
    };
}
