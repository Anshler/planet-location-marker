/**
 * Deep-sky objects: the 110 Messier objects and 30 more showpieces (data/dso.json, built by
 * scripts/build-dso.mjs) as selectable extra objects (kind 'dso', ids `dso:m31`, `dso:lmc`;
 * pure, no three.js, no DOM). render/dso.js draws them as faint, true-size procedural sprites.
 *
 * Visibility (shared with the renderer): an extended object is harder to see than a star of the
 * same total magnitude, so it is judged by an effective magnitude, its total magnitude plus
 * 0.8·log10(major axis in arcminutes) (M31 3.4 → 5.2, M13 5.8 → 6.8, the LMC 0.9 → 3.2), against
 * the same limiting magnitude as the stars (twilight, the Moon, light pollution, the telescope's
 * aperture gain). Illustrative: real detection thresholds depend on surface-brightness contrast.
 *
 * @module astro/dso
 */

import { raDecToScene } from './frames.js';
import { departureLine, lyWords, AU_PER_LY } from './lighttime.js';
import { guestRiseSet } from './guest-stars.js';

const DAY_MS = 86400000;

/** Type code → label and the sprite's tint (sRGB; the renderer keeps it near grey). */
export const DSO_TYPES = Object.freeze({
    sg: { label: 'Spiral galaxy', color: '#ded6c6' },
    eg: { label: 'Elliptical galaxy', color: '#e2d8c4' },
    ig: { label: 'Irregular galaxy', color: '#d8dce6' },
    gc: { label: 'Globular cluster', color: '#e6dcc2' },
    oc: { label: 'Open cluster', color: '#d4e0f4' },
    en: { label: 'Emission nebula', color: '#cfe4d8' },
    rn: { label: 'Reflection nebula', color: '#c6d6f2' },
    pn: { label: 'Planetary nebula', color: '#b6e6dc' },
    snr: { label: 'Supernova remnant', color: '#d6e2cc' },
    sc: { label: 'Milky Way star cloud', color: '#e2e2ea' },
    ast: { label: 'Asterism', color: '#dfe6f2' },
});

/** Numeric type codes for the GPU (render/dso.js). */
export const DSO_TYPE_CODE = Object.freeze({ sg: 0, eg: 1, ig: 2, gc: 3, oc: 4, en: 5, rn: 6, pn: 7, snr: 8, sc: 9, ast: 10 });

/** Effective magnitude of an extended object (see the module note). */
export function dsoEffMag(mag, majArcmin) {
    return mag + 0.8 * Math.log10(Math.max(1, majArcmin));
}

/**
 * How visible an object of effective magnitude `eff` is under a limiting magnitude `limit`
 * (0…1): the star shader's own ramp, from lim + 0.35 (gone) to lim − 0.45 (fully there).
 * @param {number} eff
 * @param {number} limit
 * @returns {number}
 */
export function dsoVisibility(eff, limit) {
    const t = Math.min(1, Math.max(0, (eff - (limit + 0.35)) / ((limit - 0.45) - (limit + 0.35))));
    return t * t * (3 - 2 * t);
}

/** Labels always on (sky view, gated by the sky like star names) for objects at least this easy to see. */
export const DSO_LABEL_EFF_MAG = 5.5;

/**
 * @typedef {{id:string, key:string, name:string, desig:string, messier:string, type:string, raDeg:number, decDeg:number,
 *   mag:number, majArcmin:number, minArcmin:number, paDeg:number, ly:number, effMag:number, dirS:Float64Array}} Dso
 */

/**
 * Decodes data/dso.json. Throws a TypeError for anything that is not a v1 document.
 * @param {object} json
 * @returns {Dso[]}
 */
export function decodeDso(json) {
    const ok = json?.v === 1 && Array.isArray(json.fields) && Array.isArray(json.rows);
    if (!ok) throw new TypeError('decodeDso: not a v1 dso.json document');
    const f = Object.fromEntries(json.fields.map((k, i) => [k, i]));
    const out = [];
    for (const r of json.rows) {
        if (!Array.isArray(r)) continue;
        const key = String(r[f.id] ?? '');
        const type = String(r[f.type] ?? '');
        if (!/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(key) || !DSO_TYPES[type]) continue;
        const raDeg = r[f.ra] / 1000, decDeg = r[f.dec] / 1000;
        const maj = r[f.maj] / 10, min = r[f.min] / 10;
        const mag = r[f.mag] / 10;
        const messier = /^m\d+$/.test(key) ? key.toUpperCase() : '';
        out.push({
            id: `dso:${key}`, key, name: String(r[f.name] ?? key), desig: String(r[f.desig] ?? ''), messier, type,
            raDeg, decDeg, mag, majArcmin: maj, minArcmin: min, paDeg: r[f.pa] ?? 0, ly: r[f.ly],
            effMag: dsoEffMag(mag, maj),
            dirS: Float64Array.from(raDecToScene(raDeg, decDeg, new Float64Array(3))),
        });
    }
    return out;
}

/** "3.2° × 1.0°" or "8′ × 6′" or "40″". */
export function sizeWords(majArcmin, minArcmin) {
    const one = (a) => (a >= 60 ? `${(a / 60).toFixed(a >= 600 ? 0 : 1)}°` : a >= 1 ? `${Math.round(a)}′` : `${Math.round(a * 60)}″`);
    return Math.abs(majArcmin - minArcmin) < 0.05 * majArcmin ? one(majArcmin) : `${one(majArcmin)} × ${one(minArcmin)}`;
}

/**
 * The extras provider for deep-sky objects.
 * @param {Dso[]} list decodeDso's result
 * @returns {import('./extras.js').ExtraProvider & {list:Dso[], byId:Map<string, Dso>}}
 */
export function createDsoProvider(list) {
    const byId = new Map(list.map((d) => [d.id, d]));
    const ids = list.map((d) => d.id);
    let rtsKey = '';
    let rts = null;
    return {
        kind: 'dso',
        kindLabel: 'Deep-sky object',
        list,
        byId,
        ids: () => ids,
        meta(id) {
            const d = byId.get(id);
            if (!d) return null;
            return {
                name: d.name, short: d.messier || d.name, color: DSO_TYPES[d.type].color, glyph: 'none',
                label: d.effMag <= DSO_LABEL_EFF_MAG ? 'always' : 'selected', layer: 'deepSky',
                // labels-feed: only in sky view, gated like a star name by how visible it is drawn.
                skyOnly: true, nightMag: d.effMag, priority: 46,
            };
        },
        fill(snap, id, out) {
            const d = byId.get(id);
            if (!d) { out.present = false; return; }
            out.dirS[0] = d.dirS[0]; out.dirS[1] = d.dirS[1]; out.dirS[2] = d.dirS[2];
            out.distAU = d.ly * AU_PER_LY;
            out.mag = d.mag;
            out.present = true;
            out.approx = false;
            // The telescope frames the whole object (actions.telescopeFov reads data.fovDeg).
            if (!out.data) out.data = { fovDeg: Math.min(60, Math.max(0.5, 2.2 * d.majArcmin / 60)), type: d.type };
        },
        card(id, st, snap) {
            const d = byId.get(id);
            if (!d) return null;
            const t = snap?.tMs ?? NaN;
            const o = snap?.observer;
            if (o && Number.isFinite(t)) {
                const day0 = Math.floor((t + o.lonDeg / 15 * 3600e3) / DAY_MS) * DAY_MS - o.lonDeg / 15 * 3600e3;
                const key = `${id}|${day0}|${o.latDeg.toFixed(2)}|${o.lonDeg.toFixed(2)}`;
                if (key !== rtsKey) {
                    rtsKey = key;
                    try { rts = guestRiseSet({ raH: d.raDeg / 15, decDeg: d.decDeg, distLy: Math.max(1, d.ly) }, o, day0); } catch { rts = null; }
                }
            }
            const label = d.key === 'm40' ? 'Double star' : DSO_TYPES[d.type].label;
            const des = [d.messier, d.desig].filter(Boolean).join(' · ');
            const eye = d.effMag <= 4.6 ? 'Easy to see with the naked eye from a dark site'
                : d.effMag <= 6.3 ? 'A naked-eye smudge under a dark sky; binoculars show it well'
                    : d.effMag <= 8 ? 'Binoculars or a small telescope' : 'A telescope object';
            return {
                kindLabel: label,
                subtitle: des && des !== d.name ? des : '',
                lines: [departureLine(t, d.ly), `${eye}.`],
                facts: [
                    ['Distance', lyWords(d.ly)],
                    ['Apparent size', sizeWords(d.majArcmin, d.minArcmin)],
                    ...(des ? [['Designation', des]] : []),
                ],
                caveat: 'Drawn as a faint illustrative smudge at its true size and orientation; distances are rounded catalogue values.',
                sources: ['d3-celestial Messier catalogue (BSD-3)', 'NGC/IC, SEDS and NED values'],
                rts,
            };
        },
    };
}
