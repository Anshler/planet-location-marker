// Star designations and parallaxes (pure: no three.js, no DOM).
//
// Decodes data/starinfo.json (scripts/build-sky.mjs): per star, in sky.json's own order, the
// Hipparcos New Reduction parallax and its error, and the proper name, Bayer letter, Flamsteed
// number and variable-star name from d3-celestial's starnames.json. Formats designations the way
// atlases print them ('α Orionis', '58 Ori', 'HIP 27989').

/** IAU constellation genitives, for Bayer and Flamsteed designations ('α Orionis'). */
export const GENITIVE = Object.freeze({
    And: 'Andromedae', Ant: 'Antliae', Aps: 'Apodis', Aqr: 'Aquarii', Aql: 'Aquilae', Ara: 'Arae', Ari: 'Arietis', Aur: 'Aurigae',
    Boo: 'Boötis', Cae: 'Caeli', Cam: 'Camelopardalis', Cnc: 'Cancri', CVn: 'Canum Venaticorum', CMa: 'Canis Majoris',
    CMi: 'Canis Minoris', Cap: 'Capricorni', Car: 'Carinae', Cas: 'Cassiopeiae', Cen: 'Centauri', Cep: 'Cephei', Cet: 'Ceti',
    Cha: 'Chamaeleontis', Cir: 'Circini', Col: 'Columbae', Com: 'Comae Berenices', CrA: 'Coronae Australis', CrB: 'Coronae Borealis',
    Crv: 'Corvi', Crt: 'Crateris', Cru: 'Crucis', Cyg: 'Cygni', Del: 'Delphini', Dor: 'Doradus', Dra: 'Draconis', Equ: 'Equulei',
    Eri: 'Eridani', For: 'Fornacis', Gem: 'Geminorum', Gru: 'Gruis', Her: 'Herculis', Hor: 'Horologii', Hya: 'Hydrae', Hyi: 'Hydri',
    Ind: 'Indi', Lac: 'Lacertae', Leo: 'Leonis', LMi: 'Leonis Minoris', Lep: 'Leporis', Lib: 'Librae', Lup: 'Lupi', Lyn: 'Lyncis',
    Lyr: 'Lyrae', Men: 'Mensae', Mic: 'Microscopii', Mon: 'Monocerotis', Mus: 'Muscae', Nor: 'Normae', Oct: 'Octantis',
    Oph: 'Ophiuchi', Ori: 'Orionis', Pav: 'Pavonis', Peg: 'Pegasi', Per: 'Persei', Phe: 'Phoenicis', Pic: 'Pictoris', Psc: 'Piscium',
    PsA: 'Piscis Austrini', Pup: 'Puppis', Pyx: 'Pyxidis', Ret: 'Reticuli', Sge: 'Sagittae', Sgr: 'Sagittarii', Sco: 'Scorpii',
    Scl: 'Sculptoris', Sct: 'Scuti', Ser: 'Serpentis', Sex: 'Sextantis', Tau: 'Tauri', Tel: 'Telescopii', Tri: 'Trianguli',
    TrA: 'Trianguli Australis', Tuc: 'Tucanae', UMa: 'Ursae Majoris', UMi: 'Ursae Minoris', Vel: 'Velorum', Vir: 'Virginis',
    Vol: 'Volantis', Vul: 'Vulpeculae',
});

const SUPER = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

/**
 * One star's entry.
 * @typedef {{hip:number, name:string, bayer:string, flam:string, variable:string, con:string,
 *   plx:number, eplx:number}} StarInfo  plx, eplx in mas (NaN when Hipparcos has none)
 */

/**
 * Decodes data/starinfo.json against sky.json's star order (`srcHip`, SkyCatalog.srcHip).
 * Throws a TypeError for a document that is not v1 or does not match that order.
 * @param {object} json parsed data/starinfo.json
 * @param {ArrayLike<number>} srcHip HIP per sky.json star index
 * @returns {{get(hip:number):StarInfo|null, size:number}}
 */
export function decodeStarInfo(json, srcHip) {
    const d = json;
    const ok = d?.v === 1 && Number.isInteger(d.n) && Array.isArray(d.plx) && Array.isArray(d.eplx) && Array.isArray(d.names)
        && d.plx.length === d.n && d.eplx.length === d.n && srcHip && srcHip.length === d.n && srcHip[0] === d.hip0;
    if (!ok) throw new TypeError('decodeStarInfo: not a v1 starinfo.json matching this sky.json');
    const named = new Map();
    for (const row of d.names) {
        if (Array.isArray(row) && Number.isInteger(row[0])) named.set(row[0], row);
    }
    const byHip = new Map();
    for (let i = 0; i < d.n; i++) byHip.set(srcHip[i], i);
    const cache = new Map();
    return {
        size: d.n,
        get(hip) {
            if (cache.has(hip)) return cache.get(hip);
            const i = byHip.get(hip);
            if (i === undefined) return null;
            const r = named.get(i) ?? [];
            const p = d.plx[i], e = d.eplx[i];
            const info = {
                hip, name: String(r[1] ?? ''), bayer: String(r[2] ?? ''), flam: String(r[3] ?? ''), variable: String(r[4] ?? ''),
                con: String(r[5] ?? ''), plx: p > 0 ? p / 100 : Number.NaN, eplx: e > 0 ? e / 100 : Number.NaN,
            };
            cache.set(hip, info);
            return info;
        },
    };
}

/** 'κ1' → 'κ¹' (a Bayer letter's index as a superscript). */
export function bayerText(b) {
    return String(b || '').replace(/(\D)(\d+)$/, (_, l, n) => l + [...n].map((c) => SUPER[c] ?? c).join(''));
}

/**
 * Designations, most familiar first: 'α Orionis', '58 Orionis', 'HIP 27989' (the genitive form is
 * used when the constellation is known; Flamsteed numbers then get the short form '58 Ori').
 * @param {Partial<StarInfo>|null|undefined} info
 * @param {number} hip
 * @param {string} [conFallback] IAU code to use when the entry has none (the star's constellation)
 * @returns {string[]}
 */
export function designations(info, hip, conFallback = '') {
    const con = info?.con || conFallback || '';
    const gen = GENITIVE[con] ?? '';
    const out = [];
    if (info?.bayer && gen) out.push(`${bayerText(info.bayer)} ${gen}`);
    if (info?.flam && con) out.push(out.length ? `${info.flam} ${con}` : `${info.flam} ${gen || con}`);
    if (info?.variable && con && !/^\d+$/.test(info.variable)) out.push(`${info.variable} ${gen || con}`);
    if (Number.isInteger(hip) && hip > 0) out.push(`HIP ${hip}`);
    return out;
}

/**
 * A star's display name: its proper name, else its first designation.
 * @param {Partial<StarInfo>|null|undefined} info
 * @param {number} hip
 * @param {string} [conFallback]
 * @returns {string}
 */
export function starDisplayName(info, hip, conFallback = '') {
    return info?.name || designations(info, hip, conFallback)[0] || `HIP ${hip}`;
}
