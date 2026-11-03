/**
 * Totality from the ground (pure): Baily's beads and the diamond ring from a lunar limb profile,
 * the corona's epoch parameters (Ludendorff flattening, seeded streamers and prominences), the
 * display adaptation around second and third contact, and the azimuthal shape of totality's 360°
 * horizon glow.
 *
 * Physically placed, illustrative in detail. The Sun–Moon geometry (which limb, when, how wide the
 * gap is) is the snapshot's, the same discs as `obscurationAtObserver`. The lunar limb profile is a
 * fixed, seeded stand-in for the real one (Watts/LOLA, which shifts with libration), so the number
 * and timing of beads are typical rather than predicted, and the corona's streamers, plumes and
 * prominences are invented per date (docs/ASTRONOMY.md §Totality).
 *
 * @module astro/totality
 */
import { DEG2RAD } from './frames.js';

const ARCSEC = DEG2RAD / 3600;
const TAU = 2 * Math.PI;
const DAY_MS = 86400000;
const YEAR_MS = 365.25 * DAY_MS;

/** Most beads reported (the brightest, sorted by flux). */
export const MAX_BEADS = 8;
/** Lunar limb profile resolution: entries per turn of lunar position angle (0.5° each). */
export const LIMB_STEPS = 720;
/** Largest |height| of the limb profile (radians): 2.2″, about 3.7 km at the Moon. */
export const LIMB_AMPLITUDE = 2.2 * ARCSEC;

// Bead search: ±SPAN of position angle around the contact point in STEP increments. A run of open
// limb longer than RUN_MAX samples is split, so a long opening reads as a chain of beads.
const SPAN = 60 * DEG2RAD;
const STEP = 0.25 * DEG2RAD;
const N_SAMPLES = Math.round((2 * SPAN) / STEP) + 1;
const RUN_MAX = 24;
/** No beads while the smooth-limb crescent is wider than this (the crescent itself is drawn). */
const BEAD_MAX_GAP = 8 * ARCSEC;
/** Linear limb darkening of the photosphere (visible light). */
const LD_U = 0.6;

/** Deterministic 32-bit PRNG (mulberry32) → [0, 1). */
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The fixed lunar limb profile: heights above the mean limb (radians) per 0.5° of lunar position
 * angle, counted from the Moon's north pole. Long-wavelength relief (harmonics 2–24) plus 46 hashed
 * mountains and valleys 0.6–2.6° wide, scaled to ±2.2″ (the real limb spans about ±2″, with
 * extremes near 3″). Built once at load. Illustrative: valleys like these are what break the last
 * crescent into Baily's beads.
 */
export const LIMB_PROFILE = (() => {
    const p = new Float64Array(LIMB_STEPS);
    const rnd = prng(0x5eed1aa7);
    for (let k = 2; k <= 24; k++) {
        const a = (rnd() * 2 - 1) / Math.pow(k, 0.9);
        const ph = rnd() * TAU;
        for (let i = 0; i < LIMB_STEPS; i++) p[i] += a * Math.sin((k * i * TAU) / LIMB_STEPS + ph);
    }
    for (let j = 0; j < 46; j++) {
        const c = rnd() * LIMB_STEPS;
        const w = (0.6 + 2.0 * rnd()) * 2;               // samples (0.5° each)
        const h = rnd() < 0.55 ? -(0.8 + 1.6 * rnd()) : 0.5 + 1.2 * rnd();
        for (let i = 0; i < LIMB_STEPS; i++) {
            let d = Math.abs(i - c);
            if (d > LIMB_STEPS / 2) d = LIMB_STEPS - d;
            p[i] += h * Math.exp(-(d * d) / (w * w));
        }
    }
    let mean = 0;
    for (let i = 0; i < LIMB_STEPS; i++) mean += p[i];
    mean /= LIMB_STEPS;
    let peak = 0;
    for (let i = 0; i < LIMB_STEPS; i++) peak = Math.max(peak, Math.abs(p[i] - mean));
    for (let i = 0; i < LIMB_STEPS; i++) p[i] = ((p[i] - mean) / peak) * LIMB_AMPLITUDE;
    return p;
})();

let limbMin = 0;
for (let i = 0; i < LIMB_STEPS; i++) limbMin = Math.min(limbMin, LIMB_PROFILE[i]);
/** Deepest valley of the profile (radians, < 0): past it no bead can open. */
export const LIMB_MIN = limbMin;

/**
 * Height of the lunar limb above its mean radius at lunar position angle `pa` (radians from the
 * Moon's north pole), linearly interpolated and periodic.
 * @param {number} pa
 * @returns {number} radians
 */
export function limbHeight(pa) {
    let x = (pa / TAU) * LIMB_STEPS;
    x -= Math.floor(x / LIMB_STEPS) * LIMB_STEPS;
    const i = Math.floor(x);
    const f = x - i;
    const a = LIMB_PROFILE[i % LIMB_STEPS];
    const b = LIMB_PROFILE[(i + 1) % LIMB_STEPS];
    return a + (b - a) * f;
}

/**
 * @typedef {{count:number, total:number, gapArcsec:number, flux:Float64Array, paDeg:Float64Array,
 *   dirS:Float64Array}} Beads
 * `gapArcsec`: width of the smooth-limb crescent at the contact point, ρ☉ + σ − ρ☾ (> 0 before
 * second and after third contact, < 0 in totality; {@link NO_GAP} when not computed). `flux`: each bead's
 * share of the full Sun's light (sorted, brightest first), `total` the sum over every open valley.
 * `paDeg`: position angle from celestial north through east. `dirS`: scene unit vectors on the
 * Sun's limb, 3 per bead.
 */

/** `Beads.gapArcsec` outside a solar eclipse: finite (snapshots hold no Infinity), far from any contact. */
export const NO_GAP = 1e9;

/** @returns {Beads} preallocated output for {@link bailysBeads} */
export function createBeads() {
    return {
        count: 0, total: 0, gapArcsec: NO_GAP,
        flux: new Float64Array(MAX_BEADS), paDeg: new Float64Array(MAX_BEADS), dirS: new Float64Array(3 * MAX_BEADS),
    };
}

// Scratch (R5): runs found this call, as [flux, centre offset (rad)].
const RUN_F = new Float64Array(MAX_BEADS);
const RUN_T = new Float64Array(MAX_BEADS);

/** Keeps the MAX_BEADS brightest runs, sorted by flux (insertion). */
function keepRun(out, f, dth) {
    let n = out.count;
    if (n === MAX_BEADS && f <= RUN_F[n - 1]) return;
    let i = n < MAX_BEADS ? n : n - 1;
    while (i > 0 && RUN_F[i - 1] < f) {
        RUN_F[i] = RUN_F[i - 1];
        RUN_T[i] = RUN_T[i - 1];
        i--;
    }
    RUN_F[i] = f;
    RUN_T[i] = dth;
    if (n < MAX_BEADS) out.count = n + 1;
}

/**
 * Baily's beads near second and third contact of a total solar eclipse: where the lunar limb
 * profile ({@link LIMB_PROFILE}) opens the Sun's limb beyond the smooth-limb crescent. Samples the
 * limb ±60° around the contact point every 0.25°; along each position angle θ the photosphere left
 * between the Moon's far limb (mean radius + profile) and the Sun's is
 * w(θ) = ρ☉ − (b + √(b² − σ² + (ρ☾ + h)²)), b = ê(θ)·δ, and a bead is a run where w exceeds the
 * smooth-limb width (so the drawn crescent and the beads never count the same light twice).
 * Flux uses linear limb darkening at the strip. Allocation-free; only total eclipses (ρ☾ > ρ☉) and
 * |gap| within reach of the profile produce beads.
 *
 * @param {Float64Array} sunDir scene unit vector to the Sun (snapshot dirS)
 * @param {Float64Array} moonDir scene unit vector to the Moon (snapshot dirS)
 * @param {number} sunR angular radius (rad)
 * @param {number} moonR angular radius (rad)
 * @param {Float64Array|number[]} moonPole scene vector of the Moon's north pole (limb-profile origin)
 * @param {Beads} out from {@link createBeads}
 * @returns {Beads} out
 */
export function bailysBeads(sunDir, moonDir, sunR, moonR, moonPole, out) {
    out.count = 0;
    out.total = 0;
    out.gapArcsec = NO_GAP;
    const sx = sunDir[0], sy = sunDir[1], sz = sunDir[2];
    // Tangent basis at the Sun: n toward the Moon's pole, e = s × n.
    let nx = moonPole[0], ny = moonPole[1], nz = moonPole[2];
    let k = nx * sx + ny * sy + nz * sz;
    nx -= k * sx; ny -= k * sy; nz -= k * sz;
    let len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) {
        // Pole along the line of sight (or missing): any perpendicular will do.
        nx = -sy * sx; ny = 1 - sy * sy; nz = -sy * sz;
        len = Math.hypot(nx, ny, nz);
        if (!(len > 1e-9)) { nx = 1 - sx * sx; ny = -sx * sy; nz = -sx * sz; len = Math.hypot(nx, ny, nz); }
    }
    nx /= len; ny /= len; nz /= len;
    const ex = sy * nz - sz * ny, ey = sz * nx - sx * nz, ez = sx * ny - sy * nx;
    const mx = moonDir[0], my = moonDir[1], mz = moonDir[2];
    const ms = mx * sx + my * sy + mz * sz;
    if (!(ms > 0.5) || !(sunR > 0) || !(moonR > 0)) return out;
    // Moon centre offset from the Sun's (gnomonic, radians).
    const dx = (mx * nx + my * ny + mz * nz) / ms;
    const dy = (mx * ex + my * ey + mz * ez) / ms;
    const sig = Math.hypot(dx, dy);
    const gap = sunR + sig - moonR;
    out.gapArcsec = gap / ARCSEC;
    if (!(moonR > sunR) || !(gap < BEAD_MAX_GAP) || !(gap > LIMB_MIN)) return out;

    const th0 = sig > 1e-12 ? Math.atan2(-dy, -dx) : 0;
    const norm = 1 / (Math.PI * sunR * sunR * (1 - LD_U / 3));
    let runN = 0, runF = 0, runFT = 0;
    for (let i = 0; i < N_SAMPLES; i++) {
        const dth = -SPAN + i * STEP;
        const c = Math.cos(th0 + dth), s = Math.sin(th0 + dth);
        const b = c * dx + s * dy;
        const base = b * b - sig * sig;
        const R = moonR + limbHeight(Math.atan2(sunR * s - dy, sunR * c - dx));
        const wS = sunR - b - Math.sqrt(Math.max(0, base + moonR * moonR));
        const wP = sunR - b - Math.sqrt(Math.max(0, base + R * R));
        const x = wP - Math.max(wS, 0);
        if (x > 0) {
            // Strip of width x on the limb; μ at its middle ≈ √(wP/ρ☉).
            const mu = Math.sqrt(Math.min(1, wP / sunR));
            const f = x * sunR * STEP * (1 - LD_U * (1 - mu)) * norm;
            runF += f;
            runFT += f * dth;
            if (++runN < RUN_MAX) continue;
        }
        if (runN > 0) {
            out.total += runF;
            keepRun(out, runF, runFT / runF);
            runN = 0; runF = 0; runFT = 0;
        }
    }
    if (runN > 0) {
        out.total += runF;
        keepRun(out, runF, runFT / runF);
    }

    // Directions on the Sun's limb, and position angles from celestial north (scene +Y) via east.
    let cex = sz, cey = 0, cez = -sx;        // (0,1,0) × s
    const cl = Math.hypot(cex, cez);
    if (cl > 1e-12) { cex /= cl; cez /= cl; } else { cex = 1; cez = 0; }
    const cnx = sy * cez - sz * cey, cny = sz * cex - sx * cez, cnz = sx * cey - sy * cex;   // s × east
    const t = Math.tan(sunR);
    for (let j = 0; j < out.count; j++) {
        const th = th0 + RUN_T[j];
        const c = Math.cos(th) * t, s = Math.sin(th) * t;
        let vx = sx + c * nx + s * ex, vy = sy + c * ny + s * ey, vz = sz + c * nz + s * ez;
        const vl = Math.hypot(vx, vy, vz);
        vx /= vl; vy /= vl; vz /= vl;
        out.dirS[3 * j] = vx; out.dirS[3 * j + 1] = vy; out.dirS[3 * j + 2] = vz;
        out.flux[j] = RUN_F[j];
        const pa = Math.atan2(vx * cex + vy * cey + vz * cez, vx * cnx + vy * cny + vz * cnz) / DEG2RAD;
        out.paDeg[j] = pa < 0 ? pa + 360 : pa;
    }
    return out;
}

/**
 * Display adaptation of the photosphere left near totality (sky view): the eye, adapted to the
 * darkening sky, sees the last crescent and the beads as dazzling. The light left is
 * L = (1 − obscuration)^1.4 (as js/render/ground.js ECL_ADAPT and eclipseStarLimitMag); the drawn
 * crescent then totals ∝ L^0.4 instead of L, i.e. a gain (L / 0.02)^−0.6, 1 until L = 2 % and
 * capped at 40 (from just before second contact to just after third).
 * @param {number} obscuration 0…1
 * @returns {number} ≥ 1
 */
export function photosphereAdapt(obscuration) {
    const o = Number.isFinite(obscuration) ? Math.min(1, Math.max(0, obscuration)) : 0;
    const L = Math.pow(1 - o, 1.4);
    if (!(L > 0)) return 40;
    return Math.min(40, Math.max(1, Math.pow(L / 0.02, -0.6)));
}

/**
 * How much of the corona shows (0…1) as the photosphere goes: 1 / (1 + √(L / 2e-5)) with
 * L = (1 − obscuration)^1.4, so it is still faint with 1 % of the Sun left, about a third 8 s before
 * second contact, and full in totality. 0 below 95 % obscuration.
 * @param {number} obscuration 0…1
 * @returns {number}
 */
export function coronaVisibility(obscuration) {
    const o = Number.isFinite(obscuration) ? Math.min(1, Math.max(0, obscuration)) : 0;
    if (o < 0.95) return 0;
    const L = Math.pow(1 - o, 1.4);
    const v = 1 / (1 + Math.sqrt(L / 2e-5));
    // Fade the last 0.95 → 0.96 so the term starts at exactly 0.
    return v * Math.min(1, (o - 0.95) / 0.01);
}

/**
 * Stylised minimum size of the corona (like the planet glyphs' inflation): the outer corona is
 * stretched about the limb, ρ' = 1 + (ρ − 1)/k, until the ρ' = 3 isophote reaches `minPx` from the
 * Sun's centre. At FOV 70° the true 3 R☉ is about 9 px; the inner corona stays on the limb.
 * @param {number} sunRadiusPx the Sun's true radius on screen (device px)
 * @param {number} minPx minimum radius of the ρ' = 3 isophote (device px)
 * @returns {number} k ≥ 1
 */
export function coronaStretch(sunRadiusPx, minPx) {
    if (!(sunRadiusPx > 0) || !(minPx > 0)) return 1;
    return Math.max(1, (minPx / sunRadiusPx - 1) / 2);
}

/**
 * Chromosphere flash (0…1): the pink rim shows on the contact limb from about 3″ before second
 * contact (and after third) and fades over the next ~10–20 s as the Moon's limb moves on.
 * @param {number} gapArcsec smooth-limb crescent width (Beads.gapArcsec)
 * @returns {number}
 */
export function chromosphereFlash(gapArcsec) {
    if (!Number.isFinite(gapArcsec) || gapArcsec >= 3) return 0;
    const t = Math.min(1, (3 - gapArcsec) / 2.5);
    return t * t * (3 - 2 * t) * Math.exp(-Math.max(-gapArcsec, 0) / 8);
}

/** Start of solar cycle 25's maximum phase (smoothed sunspot number, about October 2024). */
const CYCLE_MAX_MS = Date.UTC(2024, 9, 15);
const CYCLE_YEARS = 11;

/**
 * Ludendorff flattening ε of the corona for the epoch: about 0.04 at solar maximum (round) to 0.30
 * at minimum (wings along the equator), on an idealised 11-year cycle phased to cycle 25's maximum.
 * 2027-08-02 sits in the declining phase: ε ≈ 0.16. Illustrative outside cycles 24–26.
 * @param {number} tMs UTC milliseconds
 * @returns {number}
 */
export function coronaFlattening(tMs) {
    if (!Number.isFinite(tMs)) return 0.15;
    let ph = (tMs - CYCLE_MAX_MS) / (CYCLE_YEARS * YEAR_MS);
    ph -= Math.floor(ph);
    return 0.04 + 0.26 * (1 - Math.cos(TAU * ph)) / 2;
}

/**
 * @typedef {{day:number, seed:number, flattening:number, streamerPA:Float64Array, streamerWidth:Float64Array,
 *   streamerGain:Float64Array, promPA:Float64Array, promHeight:Float64Array, promWidth:Float64Array}} CoronaParams
 * Position angles (rad) are counted from the Sun's north rotation pole; heights in solar radii.
 */

/** @returns {CoronaParams} */
export function createCoronaParams() {
    return {
        day: NaN, seed: 0, flattening: 0.15,
        streamerPA: new Float64Array(4), streamerWidth: new Float64Array(4), streamerGain: new Float64Array(4),
        promPA: new Float64Array(4), promHeight: new Float64Array(4), promWidth: new Float64Array(4),
    };
}

/**
 * The corona's invented structure for the UTC date of `tMs`, seeded by that date so each eclipse
 * looks different but stays the same through it (recomputed only when the day changes).
 * - Four helmet streamers, two on each equatorial limb, at latitudes up to 15° (minimum) … 55°
 *   (maximum); 7–15° wide at the base; one of them often weak, so 3–4 read.
 * - Four prominences in the active belts (latitudes up to 50°): three 0.04–0.08 R☉ tall, which
 *   show on the contact limb near second and third contact, and one 0.14–0.20 R☉ (a large one),
 *   tall enough to clear the Moon's limb through most of a long totality (the Moon overhangs the
 *   Sun by up to 0.08 R☉).
 * @param {number} tMs UTC milliseconds
 * @param {CoronaParams} out from {@link createCoronaParams}
 * @returns {CoronaParams} out
 */
export function coronaParams(tMs, out) {
    const day = Number.isFinite(tMs) ? Math.floor(tMs / DAY_MS) : 0;
    if (day === out.day) return out;
    out.day = day;
    const rnd = prng(Math.imul(day ^ 0x9e3779b9, 0x85ebca6b) ^ 0xc2b2ae35);
    out.seed = rnd();
    out.flattening = coronaFlattening(day * DAY_MS);
    const spread = 15 + 40 * (1 - Math.min(1, out.flattening / 0.3));
    for (let i = 0; i < 4; i++) {
        const limb = i < 2 ? Math.PI / 2 : -Math.PI / 2;
        const lat = (rnd() * 2 - 1) * spread * DEG2RAD;
        out.streamerPA[i] = limb + (limb > 0 ? -lat : lat);
        out.streamerWidth[i] = (7 + 8 * rnd()) * DEG2RAD;
        out.streamerGain[i] = rnd() < 0.3 ? 0.25 + 0.2 * rnd() : 0.8 + 0.7 * rnd();
    }
    const tall = Math.floor(rnd() * 4);
    for (let i = 0; i < 4; i++) {
        const limb = rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
        out.promPA[i] = limb + (rnd() * 2 - 1) * 50 * DEG2RAD;
        out.promHeight[i] = i === tall ? 0.14 + 0.06 * rnd() : 0.04 + 0.04 * rnd();
        out.promWidth[i] = (2 + 4 * rnd()) * DEG2RAD;
    }
    return out;
}

/** Horizon distance (km) over which totality's horizon glow falls by e toward the umbra's far edge. */
export const GLOW_EDGE_KM = 100;
const GLOW_AZ = 16;

/**
 * @typedef {{inUmbra:boolean, nearKm:number, level:number, h1:Float64Array, d2:Float64Array, a2:number}} HorizonGlow
 * Shape f(az) = 1 + h1·d̂ + a2·(2(d2·d̂)² − 1) for a horizontal unit direction d̂ (scene); `level`
 * scales the whole ring (a narrow umbra glows brighter); `nearKm` is the distance to the nearest edge.
 */

/** @returns {HorizonGlow} */
export function createHorizonGlow() {
    return { inUmbra: false, nearKm: 0, level: 1, h1: new Float64Array(3), d2: new Float64Array([0, 1, 0]), a2: 0 };
}

const GLOW_W = new Float64Array(GLOW_AZ);

/**
 * Azimuthal shape of totality's 360° horizon glow. The ring is sunlight scattered by air outside
 * the umbra, so it is brightest toward the umbra's nearest edge. Walking a distance t along
 * azimuth az moves the Moon's apparent centre by −t·g⊥/D (parallax; g the horizontal unit vector,
 * D the Moon's distance), and the edge is where |δ − t·g⊥/D| = ρ☾ − ρ☉; the glow per azimuth is
 * exp(−t/GLOW_EDGE_KM), fitted with its mean and first two harmonics (16 azimuths). With the Sun
 * high the shadow is round and the ring brightest toward the near edge; with it low the shadow is
 * stretched along the Sun's azimuth and the ring darker there. Allocation-free.
 * @param {Float64Array} sunDir scene unit vector to the Sun
 * @param {Float64Array} moonDir scene unit vector to the Moon
 * @param {number} sunR angular radius (rad)
 * @param {number} moonR angular radius (rad)
 * @param {number} moonDistKm topocentric distance to the Moon (km)
 * @param {Float64Array} northS observer's north (scene unit vector)
 * @param {Float64Array} eastS observer's east (scene unit vector)
 * @param {HorizonGlow} out from {@link createHorizonGlow}
 * @returns {HorizonGlow} out
 */
export function umbraHorizonGlow(sunDir, moonDir, sunR, moonR, moonDistKm, northS, eastS, out) {
    out.inUmbra = false;
    out.a2 = 0;
    out.level = 1;
    out.nearKm = 0;
    out.h1[0] = out.h1[1] = out.h1[2] = 0;
    const R = moonR - sunR;
    const sx = sunDir[0], sy = sunDir[1], sz = sunDir[2];
    const mx = moonDir[0], my = moonDir[1], mz = moonDir[2];
    const ms = mx * sx + my * sy + mz * sz;
    if (!(R > 0) || !(moonDistKm > 0) || !(ms > 0.5)) return out;
    // δ: the Moon's centre offset from the Sun's, in the Sun's tangent plane (gnomonic, 3-D).
    const dx = mx / ms - sx, dy = my / ms - sy, dz = mz / ms - sz;
    const dd = dx * dx + dy * dy + dz * dz;
    if (!(dd < R * R)) return out;
    let sum = 0, near = Infinity;
    for (let k = 0; k < GLOW_AZ; k++) {
        const az = (k * TAU) / GLOW_AZ;
        const ca = Math.cos(az), sa = Math.sin(az);
        let gx = ca * northS[0] + sa * eastS[0], gy = ca * northS[1] + sa * eastS[1], gz = ca * northS[2] + sa * eastS[2];
        // Parallax shift per km: the part of g across the line of sight, in the Sun's tangent plane.
        const gm = gx * mx + gy * my + gz * mz;
        gx -= gm * mx; gy -= gm * my; gz -= gm * mz;
        const gs = gx * sx + gy * sy + gz * sz;
        const ux = (gx - gs * sx) / moonDistKm, uy = (gy - gs * sy) / moonDistKm, uz = (gz - gs * sz) / moonDistKm;
        const a = ux * ux + uy * uy + uz * uz;
        const b = dx * ux + dy * uy + dz * uz;
        // a·t² − 2b·t + (|δ|² − R²) = 0, positive root (c < 0 inside the umbra).
        const t = a > 0 ? (b + Math.sqrt(Math.max(0, b * b - a * (dd - R * R)))) / a : Infinity;
        near = Math.min(near, t);
        const w = Number.isFinite(t) ? Math.exp(-t / GLOW_EDGE_KM) : 0;
        GLOW_W[k] = w;
        sum += w;
    }
    const mean = sum / GLOW_AZ;
    if (!(mean > 0)) return out;
    let a1 = 0, b1 = 0, a2 = 0, b2 = 0;
    for (let k = 0; k < GLOW_AZ; k++) {
        const az = (k * TAU) / GLOW_AZ;
        const w = GLOW_W[k] / mean;
        a1 += w * Math.cos(az); b1 += w * Math.sin(az);
        a2 += w * Math.cos(2 * az); b2 += w * Math.sin(2 * az);
    }
    const kk = 2 / GLOW_AZ;
    a1 *= kk; b1 *= kk; a2 *= kk; b2 *= kk;
    for (let i = 0; i < 3; i++) out.h1[i] = a1 * northS[i] + b1 * eastS[i];
    out.a2 = Math.hypot(a2, b2);
    const phi = Math.atan2(b2, a2) / 2;
    for (let i = 0; i < 3; i++) out.d2[i] = Math.cos(phi) * northS[i] + Math.sin(phi) * eastS[i];
    // A typical umbra (≈130 km to the edge) gives 1; narrower ones glow more, wider ones less.
    out.level = Math.min(1.6, Math.max(0.5, mean / Math.exp(-130 / GLOW_EDGE_KM)));
    out.nearKm = near;
    out.inUmbra = true;
    return out;
}
