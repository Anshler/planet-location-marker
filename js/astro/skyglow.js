/**
 * The night sky's own brightness ('Your real sky', docs/ASTRONOMY.md "Night-sky brightness"):
 *
 *  - the natural sky, brightening toward the horizon as airglow is seen through more air (van
 *    Rhijn), from Krisciunas & Schaefer (1991, PASP 103, 1033; "KS91") eq. 2;
 *  - the moonlit sky, KS91 eqs. 15–21: Rayleigh and Mie scattering of moonlight by phase, the
 *    Moon's altitude and the sky point's distance from the Moon;
 *  - artificial light, estimated from the populations in data/cities.json with Walker's law
 *    (1977: I = 0.01·P·d^−2.5 at 45° toward a city, relative to the natural sky) summed over
 *    cities within LP_RADIUS_KM, with a Garstang-like shape: a 16-bin azimuth dome at the horizon
 *    falling toward a zenith value;
 *  - its summary: the zenith SQM reading (mag/arcsec²), the Bortle class and a naked-eye limiting
 *    magnitude (photometry.limitingMag).
 *
 * Units: KS91 work in nanolamberts (nL). Everything shaded is in natural-sky units R = B / B_nat,
 * where B_nat = NATURAL_NL is a dark site's moonless zenith (22.0 mag/arcsec²), so the SQM reading
 * of a direction is 22.0 − 2.5·log10 R. js/render/shaders/skyglow.glsl.js evaluates the same model
 * per direction from snap.skyglow (uniforms); this module is its reference and feeds the panels.
 *
 * The city estimate is coarse by design: only large cities are listed (small-town glow is
 * missing), and the city-core cap and dome shape are fits, not a radiative-transfer model. The
 * Settings choice 'Sky darkness' overrides it with a Bortle class or a pristine sky.
 *
 * @module astro/skyglow
 */

import { smoothstep, limitingMag } from './photometry.js';

const DEG = Math.PI / 180;
const EARTH_KM = 6371.0088;

/** Moonless zenith of a dark site, V mag/arcsec² (the natural-sky unit). */
export const NATURAL_SQM = 22.0;
/** V-band extinction coefficient, mag per airmass (KS91's Mauna Kea value). */
export const K_V = 0.172;
/** Cities farther than this contribute nothing (Walker's law is fitted out to ~100 km). */
export const LP_RADIUS_KM = 300;
/** Azimuth bins of the light dome (bin k is centred k·360/LP_BINS degrees east of north). */
export const LP_BINS = 16;
/** Altitude e-folding of the dome, from its horizon value toward the zenith value (degrees). */
export const LP_ALT_SCALE_DEG = 34;
const LP_E90 = Math.exp(-90 / LP_ALT_SCALE_DEG);
/** Lower SQM bounds of Bortle classes 1…8 (class 9 below the last). */
export const BORTLE_SQM_MIN = Object.freeze([21.99, 21.89, 21.69, 20.49, 19.5, 18.94, 18.38, 17.8]);
/** A representative zenith SQM per Bortle class 1…9 (the manual setting). */
export const BORTLE_SQM = Object.freeze([21.995, 21.94, 21.79, 21.09, 20.0, 19.22, 18.66, 18.09, 17.4]);

/**
 * mag/arcsec² (V) → nanolamberts: B = 34.08·exp(20.7233 − 0.92104·V) (KS91 eq. 1).
 * @param {number} sqm
 * @returns {number}
 */
export function sqmToNl(sqm) {
    return 34.08 * Math.exp(20.7233 - 0.92104 * sqm);
}

/**
 * Nanolamberts → mag/arcsec² (V); the inverse of {@link sqmToNl}.
 * @param {number} nl
 * @returns {number}
 */
export function nlToSqm(nl) {
    return (20.7233 - Math.log(Math.max(nl, 1e-9) / 34.08)) / 0.92104;
}

/** The natural-sky unit in nanolamberts (≈ 54 nL). */
export const NATURAL_NL = sqmToNl(NATURAL_SQM);

/**
 * KS91's optical path through the airglow layer, X(Z) = (1 − 0.96·sin²Z)^−½: 1 at the zenith,
 * 5 at the horizon.
 * @param {number} zDeg Zenith distance (clamped to 0…90°).
 * @returns {number}
 */
export function ksAirmass(zDeg) {
    const z = Math.min(90, Math.max(0, Number.isFinite(zDeg) ? zDeg : 90)) * DEG;
    const s = Math.sin(z);
    return 1 / Math.sqrt(1 - 0.96 * s * s);
}

/**
 * Natural sky at zenith distance Z in natural units: X·10^(−0.4·k·(X − 1)) (KS91 eq. 2), 1 at
 * the zenith and ≈ 2.7 at the horizon.
 * @param {number} zDeg
 * @param {number} [k=K_V]
 * @returns {number}
 */
export function naturalSky(zDeg, k = K_V) {
    const X = ksAirmass(zDeg);
    return X * Math.pow(10, -0.4 * k * (X - 1));
}

/**
 * The Moon's brightness factor I* = 10^(−0.4·(3.84 + 0.026·|α| + 4·10⁻⁹·α⁴)) (KS91 eq. 20),
 * α the phase angle in degrees (0 = full).
 * @param {number} phaseAngleDeg
 * @returns {number}
 */
export function moonIntensity(phaseAngleDeg) {
    const a = Math.min(180, Math.abs(Number.isFinite(phaseAngleDeg) ? phaseAngleDeg : 180));
    return Math.pow(10, -0.4 * (3.84 + 0.026 * a + 4e-9 * a * a * a * a));
}

/**
 * KS91 scattering function f(ρ) = 10^5.36·(1.06 + cos²ρ) + 10^(6.15 − ρ/40) (eq. 21): Rayleigh
 * plus Mie, ρ the angle from the Moon in degrees (held at ≥ 10°, where the fit stops).
 * @param {number} rhoDeg
 * @param {{rayleigh:number, mie:number}} [out] Reused when given (per-snapshot callers).
 * @returns {{rayleigh:number, mie:number}}
 */
export function moonScatter(rhoDeg, out = { rayleigh: 0, mie: 0 }) {
    const r = Math.max(10, Math.min(180, Number.isFinite(rhoDeg) ? rhoDeg : 180));
    const c = Math.cos(r * DEG);
    out.rayleigh = 229086.765 * (1.06 + c * c);
    out.mie = Math.pow(10, 6.15 - r / 40);
    return out;
}
const SCATTER = { rayleigh: 0, mie: 0 };

/**
 * Moonlit sky in natural units (KS91 eq. 15):
 * B = f(ρ)·I*·10^(−0.4·k·X(Z_moon))·(1 − 10^(−0.4·k·X(Z))) / NATURAL_NL; 0 with the Moon down.
 * @param {number} rhoDeg Angle between the sky point and the Moon.
 * @param {number} zDeg Zenith distance of the sky point.
 * @param {number} zMoonDeg Zenith distance of the Moon.
 * @param {number} phaseAngleDeg
 * @param {number} [k=K_V]
 * @param {number} [lit=1] Unshadowed fraction of the Moon's light (a lunar eclipse dims it).
 * @returns {number}
 */
export function moonSky(rhoDeg, zDeg, zMoonDeg, phaseAngleDeg, k = K_V, lit = 1) {
    if (!(zMoonDeg < 90) || !(zDeg <= 90)) return 0;
    const f = moonScatter(rhoDeg, SCATTER);
    const w = moonIntensity(phaseAngleDeg) * Math.pow(10, -0.4 * k * ksAirmass(zMoonDeg)) * lit / NATURAL_NL;
    return (f.rayleigh + f.mie) * w * (1 - Math.pow(10, -0.4 * k * ksAirmass(zDeg)));
}

/**
 * Walker's law: the artificial brightening at 45° toward a city of `pop` at `dKm`, in natural
 * units, 0.01·P·d^−2.5.
 * @param {number} pop
 * @param {number} dKm
 * @returns {number}
 */
export function walkerGlow(pop, dKm) {
    return 0.01 * Math.max(0, pop) * Math.pow(Math.max(1, dKm), -2.5);
}

/**
 * The brightest sky inside a city of `pop` (natural units), 40·(P/10⁶)^⅓: Walker's law diverges
 * at small distances, and city-centre SQM readings grow only slowly with size (≈ 19.5 in a town
 * of 15 000, 18.0 for a million, 17.2 for ten million).
 * @param {number} pop
 * @returns {number}
 */
export function cityCoreGlow(pop) {
    return 40 * Math.cbrt(Math.max(0, pop) / 1e6);
}

/** Urban radius (km) for a population: about 6 km per √(10⁶). */
export function cityRadiusKm(pop) {
    return Math.max(2, 0.006 * Math.sqrt(Math.max(0, pop)));
}

/**
 * Bortle class (1…9) for a zenith SQM reading.
 * @param {number} sqm
 * @returns {number}
 */
export function bortleFromSqm(sqm) {
    for (let i = 0; i < BORTLE_SQM_MIN.length; i++) if (sqm >= BORTLE_SQM_MIN[i]) return i + 1;
    return 9;
}

/**
 * A site's artificial light. `zenith` and `dome` are natural units; `dome[k]` is the horizon value
 * toward azimuth k·360/LP_BINS. `sqm` and `bortle` describe its moonless zenith.
 * @typedef {{setting:string, auto:boolean, zenith:number, dome:Float64Array, sqm:number, bortle:number, cities:number}} SkySite
 */

/** @returns {SkySite} A pristine site. */
export function createSite() {
    return { setting: 'pristine', auto: false, zenith: 0, dome: new Float64Array(LP_BINS), sqm: NATURAL_SQM, bortle: 1, cities: 0 };
}

function finishSite(out) {
    out.sqm = NATURAL_SQM - 2.5 * Math.log10(1 + out.zenith);
    out.bortle = bortleFromSqm(out.sqm);
    return out;
}

/**
 * Light pollution at (lat, lon) from nearby cities ({lat, lon, pop}). For each city at distance d
 * with urban radius r: the glow W = 1/(1/Walker + 1/core) (Walker's law far out, the city-core cap
 * inside), a nearness n = r²/(r² + d²), and
 *   zenith    += W·(n + 0.35·(1 − n))
 *   horizon_k += W·(1.6·n + (1 − n)·(0.3 + 3.1·lobe)),  lobe = ((1 + cos Δaz)/2)^(2 + 10·(1 − n))
 * so a distant city is a narrow dome on its own horizon, matching Walker's value at 45° through
 * the altitude profile of {@link lpAt}, and the sky inside a city is bright all round.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {ArrayLike<{lat:number, lon:number, pop:number}>} places
 * @param {SkySite} [out]
 * @returns {SkySite}
 */
export function lightPollution(latDeg, lonDeg, places, out = createSite()) {
    out.setting = 'auto';
    out.auto = true;
    out.zenith = 0;
    out.dome.fill(0);
    out.cities = 0;
    const la = latDeg * DEG, lo = lonDeg * DEG;
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !places) return finishSite(out);
    const cla = Math.cos(la), sla = Math.sin(la);
    for (let i = 0; i < places.length; i++) {
        const p = places[i];
        const pop = p && p.pop;
        if (!(pop > 0) || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
        const pla = p.lat * DEG, dlo = p.lon * DEG - lo;
        const cpl = Math.cos(pla), spl = Math.sin(pla);
        const sh = Math.sin((pla - la) / 2), sw = Math.sin(dlo / 2);
        const h = sh * sh + cla * cpl * sw * sw;
        const d = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
        if (d > LP_RADIUS_KM) continue;
        const walker = walkerGlow(pop, d), core = cityCoreGlow(pop);
        const w = 1 / (1 / walker + 1 / core);
        const r = cityRadiusKm(pop);
        const n = (r * r) / (r * r + d * d);
        out.zenith += w * (n + 0.35 * (1 - n));
        // Initial bearing toward the city, east of north.
        const az = Math.atan2(Math.sin(dlo) * cpl, cla * spl - sla * cpl * Math.cos(dlo));
        const pw = 2 + 10 * (1 - n);
        for (let k = 0; k < LP_BINS; k++) {
            const lobe = Math.pow((1 + Math.cos((k * 2 * Math.PI) / LP_BINS - az)) / 2, pw);
            out.dome[k] += w * (1.6 * n + (1 - n) * (0.3 + 3.1 * lobe));
        }
        out.cities++;
    }
    return finishSite(out);
}

/**
 * A uniform site for a chosen darkness: 'pristine' (no artificial light) or a Bortle class '1'…'9'
 * at its representative SQM, the horizon 1.6× the zenith all round.
 * @param {string|number} setting
 * @param {SkySite} [out]
 * @returns {SkySite}
 */
export function manualSite(setting, out = createSite()) {
    const b = Math.round(Number(setting));
    out.setting = b >= 1 && b <= 9 ? String(b) : 'pristine';
    out.auto = false;
    out.cities = 0;
    out.zenith = b >= 1 && b <= 9 ? Math.max(0, Math.pow(10, 0.4 * (NATURAL_SQM - BORTLE_SQM[b - 1])) - 1) : 0;
    out.dome.fill(1.6 * out.zenith);
    return finishSite(out);
}

/**
 * The site for the Settings choice: 'auto' estimates it from `places`, anything else is
 * {@link manualSite}.
 * @param {{latDeg:number, lonDeg:number}|null} observer
 * @param {ArrayLike<{lat:number, lon:number, pop:number}>|null} places
 * @param {string} setting 'auto' | 'pristine' | '1'…'9'
 * @param {SkySite} [out]
 * @returns {SkySite}
 */
export function siteFor(observer, places, setting, out = createSite()) {
    if (setting === 'auto' || setting === undefined || setting === null) {
        return lightPollution(observer ? observer.latDeg : NaN, observer ? observer.lonDeg : NaN, places, out);
    }
    return manualSite(setting, out);
}

/**
 * Artificial light toward (alt, az), natural units: the zenith value rising to the azimuth bins'
 * horizon value with the weight (e^(−alt/s) − e^(−90°/s)) / (1 − e^(−90°/s)), s = LP_ALT_SCALE_DEG
 * (so exactly the zenith value at 90°), bins interpolated linearly.
 * @param {{zenith:number, dome:ArrayLike<number>}} site SkySite or a Skyglow
 * @param {number} altDeg
 * @param {number} azDeg
 * @returns {number}
 */
export function lpAt(site, altDeg, azDeg) {
    const zen = site.zenith ?? site.lpZenith ?? 0;
    const dome = site.dome ?? site.lpDome;
    const x = ((((azDeg % 360) + 360) % 360) / 360) * LP_BINS;
    const i = Math.min(LP_BINS - 1, Math.floor(x));
    const hz = dome[i] + (dome[(i + 1) % LP_BINS] - dome[i]) * (x - i);
    const w = (Math.exp(-Math.min(90, Math.max(0, altDeg)) / LP_ALT_SCALE_DEG) - LP_E90) / (1 - LP_E90);
    return zen + (hz - zen) * w;
}

/**
 * The night sky for one snapshot (snap.skyglow). The shader inputs are `moonDirS`, `moonW`
 * (I*·10^(−0.4·k·X(Z_moon))·lit / NATURAL_NL, faded across the horizon), `k`, `lpZenith` and
 * `lpDome`; the rest summarises the zenith: `zenithR` (natural units), `zenithNl`, `sqm`,
 * `limitMag`, `excessMag` (2.5·log10 zenithR), `milkyWay` (its contrast factor there),
 * `milkyWayMax` (the same without the Moon), `darkness` (dark-sky gate: 1 at Bortle 1–3 without
 * the Moon, 0 by about Bortle 5) and `domeGain` (the sky-view dome's night factor, 0 by day).
 * @typedef {{setting:string, auto:boolean, bortle:number, siteSqm:number, cities:number,
 *   moonDirS:Float64Array, moonW:number, k:number, lpZenith:number, lpDome:Float64Array,
 *   zenithR:number, zenithNl:number, sqm:number, limitMag:number, excessMag:number,
 *   milkyWay:number, milkyWayMax:number, darkness:number, domeGain:number}} Skyglow
 */

/** @returns {Skyglow} */
export function createSkyglow() {
    return {
        setting: 'pristine', auto: false, bortle: 1, siteSqm: NATURAL_SQM, cities: 0,
        moonDirS: new Float64Array([0, 1, 0]), moonW: 0, k: K_V,
        lpZenith: 0, lpDome: new Float64Array(LP_BINS),
        zenithR: 1, zenithNl: NATURAL_NL, sqm: NATURAL_SQM, limitMag: limitingMag(NATURAL_SQM), excessMag: 0,
        milkyWay: 1, milkyWayMax: 1, darkness: 1, domeGain: 1,
    };
}

/** Milky Way contrast for a sky `excessMag` brighter than the natural sky (shared with MW_FRAG). */
export function milkyWayContrast(excessMag) {
    return 1 - smoothstep(0.1, 3.4, excessMag);
}

/** Helio-ecliptic longitudes |λ − λ☉| (degrees) of the rows of {@link ZL_S10}. */
export const ZL_LON_DEG = Object.freeze([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180]);
/** Ecliptic latitudes |β| (degrees) of the columns of {@link ZL_S10}. */
export const ZL_LAT_DEG = Object.freeze([0, 5, 10, 15, 20, 25, 30, 45, 60, 75, 90]);
/**
 * Zodiacal light at 500 nm in S10 units (1 S10 = 27.78 mag/arcsec², so the natural sky's 22.0 is
 * ≈ 205 S10): Leinert et al. (1998, A&AS 127, 1) Table 17, row-major by ZL_LON_DEG × ZL_LAT_DEG.
 * The table is blank within about 12° of the Sun; those eight cells (row 0: β 0–10, row 5: β 0–10,
 * row 10: β 0–5) are extrapolated along β from the rows beyond, and are never seen at night (the
 * Sun is then well below the horizon). MW_FRAG embeds the same values.
 */
export const ZL_S10 = Object.freeze([
    20000, 11600, 6000, 3140, 1610, 985, 640, 275, 150, 100, 77,
    18500, 10900, 5600, 2940, 1540, 945, 625, 271, 150, 100, 77,
    15800, 9300, 4740, 2470, 1370, 865, 590, 264, 148, 100, 77,
    11500, 6780, 3440, 1860, 1110, 755, 525, 251, 146, 100, 77,
    6400, 4480, 2410, 1410, 910, 635, 454, 237, 141, 99, 77,
    3840, 2830, 1730, 1100, 749, 545, 410, 223, 136, 97, 77,
    2480, 1870, 1220, 845, 615, 467, 365, 207, 131, 95, 77,
    1650, 1270, 910, 680, 510, 397, 320, 193, 125, 93, 77,
    1180, 940, 700, 530, 416, 338, 282, 179, 120, 92, 77,
    910, 730, 555, 442, 356, 292, 250, 166, 116, 90, 77,
    505, 442, 352, 292, 243, 209, 183, 134, 104, 86, 77,
    338, 317, 269, 227, 196, 172, 151, 116, 93, 82, 77,
    259, 251, 225, 193, 166, 147, 132, 104, 86, 79, 77,
    212, 210, 197, 170, 150, 133, 119, 96, 82, 77, 77,
    188, 186, 177, 154, 138, 125, 113, 90, 77, 74, 77,
    179, 178, 166, 147, 134, 122, 110, 90, 77, 73, 77,
    179, 178, 165, 148, 137, 127, 116, 96, 79, 72, 77,
    196, 192, 179, 165, 151, 141, 131, 104, 82, 72, 77,
    230, 212, 195, 178, 163, 148, 134, 105, 83, 72, 77,
]);

/**
 * Zodiacal light (S10) at helio-ecliptic longitude `dlDeg` from the Sun and ecliptic latitude
 * `betaDeg`: {@link ZL_S10} interpolated bilinearly in log brightness (power-law falloffs stay
 * smooth). The grid is 5° steps to 45° (|λ − λ☉|) and 30° (|β|), 15° beyond. Mirrored by MW_FRAG
 * zodiacal().
 * @param {number} dlDeg
 * @param {number} betaDeg
 * @returns {number}
 */
export function zodiacalS10(dlDeg, betaDeg) {
    const dl = Math.min(Math.abs(dlDeg), 180), b = Math.min(Math.abs(betaDeg), 90);
    const x = dl < 45 ? dl / 5 : 9 + (dl - 45) / 15;
    const y = b < 30 ? b / 5 : 6 + (b - 30) / 15;
    const i = Math.min(Math.floor(x), 17), j = Math.min(Math.floor(y), 9);
    const fx = x - i, fy = y - j, k = i * 11 + j;
    const L = (n) => Math.log(ZL_S10[n]);
    const lo = L(k) + (L(k + 1) - L(k)) * fy, hi = L(k + 11) + (L(k + 12) - L(k + 11)) * fy;
    return Math.exp(lo + (hi - lo) * fx);
}

/** Dark-sky gate (zodiacal light, green airglow) for `excessMag` (shared with MW_FRAG). */
export function darkSkyGate(excessMag) {
    return 1 - smoothstep(0.1, 1.5, excessMag);
}

/**
 * Fills `out` (snap.skyglow) from a snapshot and a site. Allocation-free.
 * @param {import('../core/types.js').Snapshot} snap
 * @param {SkySite|null} site null = pristine
 * @param {Skyglow} out
 * @returns {Skyglow}
 */
export function computeSkyglow(snap, site, out) {
    const moon = snap && snap.bodies ? snap.bodies[1] : null;
    out.k = K_V;
    if (site) {
        out.setting = site.setting;
        out.auto = site.auto;
        out.bortle = site.bortle;
        out.siteSqm = site.sqm;
        out.cities = site.cities;
        out.lpZenith = site.zenith;
        for (let k = 0; k < LP_BINS; k++) out.lpDome[k] = site.dome[k];
    } else {
        out.setting = 'pristine';
        out.auto = false;
        out.bortle = 1;
        out.siteSqm = NATURAL_SQM;
        out.cities = 0;
        out.lpZenith = 0;
        out.lpDome.fill(0);
    }
    let moonZen = 0;
    if (moon && moon.dirS && Number.isFinite(moon.altDeg)) {
        out.moonDirS[0] = moon.dirS[0];
        out.moonDirS[1] = moon.dirS[1];
        out.moonDirS[2] = moon.dirS[2];
        const e = snap.eclipse;
        const litF = e && Number.isFinite(e.moonLitFraction) ? Math.min(1, Math.max(0, e.moonLitFraction)) : 1;
        // A totally eclipsed Moon still shines a few 1e-4 of full (the copper light).
        const lit = litF + (1 - litF) * 2e-4;
        const zm = 90 - moon.altDeg;
        out.moonW = moonIntensity(moon.phaseAngleDeg) * Math.pow(10, -0.4 * K_V * ksAirmass(zm)) * lit / NATURAL_NL
            * smoothstep(-1, 1, moon.altDeg);
        if (out.moonW > 0) {
            const f = moonScatter(zm, SCATTER);
            moonZen = (f.rayleigh + f.mie) * out.moonW * (1 - Math.pow(10, -0.4 * K_V));
        }
    } else {
        out.moonW = 0;
    }
    out.zenithR = 1 + moonZen + out.lpZenith;
    out.zenithNl = out.zenithR * NATURAL_NL;
    out.excessMag = 2.5 * Math.log10(out.zenithR);
    out.sqm = NATURAL_SQM - out.excessMag;
    out.limitMag = limitingMag(out.sqm);
    out.milkyWay = milkyWayContrast(out.excessMag);
    out.milkyWayMax = milkyWayContrast(2.5 * Math.log10(1 + out.lpZenith));
    out.darkness = darkSkyGate(out.excessMag);
    const sunAlt = snap && snap.observer && Number.isFinite(snap.observer.sunAltDeg) ? snap.observer.sunAltDeg : -90;
    out.domeGain = 1 - smoothstep(-12, -4, sunAlt);
    return out;
}

/**
 * The sky's total brightness toward a direction, natural units (natural + moonlit + artificial):
 * the reference for the shaders' sgSky.
 * @param {Skyglow} sg
 * @param {number} altDeg
 * @param {number} azDeg
 * @param {number} rhoDeg Angle from the Moon.
 * @param {number} moonAltDeg
 * @returns {number}
 */
export function skyAt(sg, altDeg, azDeg, rhoDeg, moonAltDeg) {
    const z = 90 - Math.max(0, altDeg);
    let moonPart = 0;
    if (sg.moonW > 0 && moonAltDeg > -1) {
        const f = moonScatter(rhoDeg, SCATTER);
        moonPart = (f.rayleigh + f.mie) * sg.moonW * (1 - Math.pow(10, -0.4 * sg.k * ksAirmass(z)));
    }
    return naturalSky(z, sg.k) + moonPart + lpAt(sg, altDeg, azDeg);
}
