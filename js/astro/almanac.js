/**
 * Almanac: rise/transit/set, twilight, the Sun-altitude series for the time
 * scrubber, and plain-language "tonight" verdicts. Runs in the astro worker
 * (or on the main thread as a fallback); nothing here is per-frame.
 *
 * Rise and set follow astronomy-engine's definition: the upper limb of the Sun
 * and Moon (centre for planets) crosses a horizon lowered by 34′ of standard
 * refraction, scaled by air density at the observer's elevation.
 *
 * @module astro/almanac
 */
import { AE } from './ae.js';
import { BODIES, bodyById, AU_KM } from './bodies.js';
import { SUNRISE_ALT_DEG } from './photometry.js';

const DAY_MS = 86400000;
const SAMPLE_MIN = 10;                       // tonight() sampling step
const SAMPLES = (24 * 60) / SAMPLE_MIN + 1;  // noon-to-noon, inclusive
const NODES = 25;                            // hourly RA/Dec nodes over the same 24 h
const SAMPLES_PER_NODE = 60 / SAMPLE_MIN;
const REFRACTION_NEAR_HORIZON_DEG = 34 / 60;
const SUN_RADIUS_AU = BODIES[0].radiusKm / AU_KM;
const MEAN_SEMI_DIAMETER_DEG = { sun: 0.2666, moon: 0.2590 };
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/**
 * @typedef {{latDeg:number, lonDeg:number, elevM?:number, tz?:string|null}} ObserverLike
 * @typedef {{riseMs:number|null, transitMs:number|null, setMs:number|null, transitAltDeg:number|null,
 *            status:'normal'|'circumpolar'|'never', riseAzDeg:number|null, setAzDeg:number|null}} RTS
 * @typedef {{sunsetMs:number|null, civilDuskMs:number|null, nauticalDuskMs:number|null, astroDuskMs:number|null,
 *            astroDawnMs:number|null, nauticalDawnMs:number|null, civilDawnMs:number|null, sunriseMs:number|null}} Twilight
 */

// Numbers pass through, numeric strings convert; null, booleans and blanks do
// not silently become 0 (Number(null) === 0 would put the observer at 0°N 0°E).
function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return Number.NaN;
}

/**
 * Builds a validated AE.Observer from an app observer. Latitude is clamped to
 * ±90°, elevation to astronomy-engine's atmosphere model range.
 * @param {ObserverLike} observer
 * @returns {object} AE.Observer
 * @throws {TypeError} When latitude or longitude is not a finite number.
 */
export function aeObserverOf(observer) {
    const lat = toNumber(observer?.latDeg);
    const lon = toNumber(observer?.lonDeg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new TypeError('observer.latDeg and observer.lonDeg must be finite numbers');
    }
    const elev = toNumber(observer.elevM);
    return new AE.Observer(
        Math.min(90, Math.max(-90, lat)),
        lon,
        Number.isFinite(elev) ? Math.min(100000, Math.max(-500, elev)) : 0,
    );
}

/**
 * 16-point compass label for an azimuth in degrees ('N', 'NNE', …).
 * @param {number} azDeg
 * @returns {string}
 */
export function compass16(azDeg) {
    const i = Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16;
    return COMPASS[i];
}

function requireBody(id) {
    const b = bodyById(id);
    if (!b) throw new RangeError(`Unknown body id: ${String(id)}`);
    return b;
}

function requireMs(ms, name) {
    if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a finite number of milliseconds`);
    return ms;
}

function msOf(time) {
    return time ? time.date.getTime() : null;
}

// astronomy-engine signals rare numerical failures by throwing strings; for a
// UI almanac a missing event is the right outcome, not a failed request.
function attempt(fn) {
    try {
        return fn();
    } catch {
        return null;
    }
}

function horizontal(aeName, time, obs, refraction) {
    const eq = AE.Equator(aeName, time, obs, true, true);
    return AE.Horizon(time, obs, eq.ra, eq.dec, refraction);
}

/**
 * Next rise, upper transit and set of a body inside [fromMs, toMs].
 * Uses SearchRiseSet(±1) and SearchHourAngle(0). When neither a rise nor a
 * set occurs, `status` comes from the altitude at transit and anti-transit:
 * 'circumpolar' if it stays up, 'never' if it stays down.
 * `transitAltDeg` is the refracted altitude at the next upper transit after
 * fromMs (even if that transit falls after toMs, in which case transitMs is
 * null). Extra: azimuths of the rise and set points.
 * @param {string} bodyId
 * @param {ObserverLike} observer
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {RTS}
 */
export function riseTransitSet(bodyId, observer, fromMs, toMs) {
    const b = requireBody(bodyId);
    const obs = aeObserverOf(observer);
    requireMs(fromMs, 'fromMs');
    requireMs(toMs, 'toMs');
    if (toMs <= fromMs) throw new RangeError('toMs must be after fromMs');
    const days = (toMs - fromMs) / DAY_MS;
    const start = AE.MakeTime(new Date(fromMs));

    const rise = attempt(() => AE.SearchRiseSet(b.ae, obs, +1, start, days));
    const set = attempt(() => AE.SearchRiseSet(b.ae, obs, -1, start, days));
    const tr = attempt(() => AE.SearchHourAngle(b.ae, obs, 0, start, +1));

    const trMs = tr ? msOf(tr.time) : null;
    return {
        riseMs: msOf(rise),
        transitMs: trMs !== null && trMs <= toMs ? trMs : null,
        setMs: msOf(set),
        transitAltDeg: tr ? tr.hor.altitude : null,
        status: rise || set ? 'normal' : statusWithoutCrossing(b, obs, start, tr),
        riseAzDeg: rise ? horizontal(b.ae, rise, obs, 'normal').azimuth : null,
        setAzDeg: set ? horizontal(b.ae, set, obs, 'normal').azimuth : null,
    };
}

// No rise or set in the interval: decide from the extremes of the daily arc.
function statusWithoutCrossing(b, obs, start, transit) {
    const anti = attempt(() => AE.SearchHourAngle(b.ae, obs, 12, start, +1));
    const semi = MEAN_SEMI_DIAMETER_DEG[b.id] || 0;
    if (anti && anti.hor.altitude + semi > 0) return 'circumpolar';
    if (transit && transit.hor.altitude + semi < 0) return 'never';
    return 'normal';
}

// Same criterion as AE.SearchRiseSet: upper limb above the refraction-lowered horizon.
function sunIsUp(obs, time) {
    const eq = AE.Equator('Sun', time, obs, true, true);
    const hor = AE.Horizon(time, obs, eq.ra, eq.dec);
    const semi = Math.asin(SUN_RADIUS_AU / eq.dist) * (180 / Math.PI);
    return hor.altitude + semi > -REFRACTION_NEAR_HORIZON_DEG * AE.Atmosphere(obs.height).density;
}

// The solar anti-transit ("solar midnight") at the heart of the night that is
// current at nearMs, or upcoming when the Sun is up.
function nightCenter(obs, nearMs) {
    const near = AE.MakeTime(new Date(nearMs));
    const next = AE.SearchHourAngle('Sun', obs, 12, near, +1).time;
    if (sunIsUp(obs, near)) return next;
    const prev = AE.SearchHourAngle('Sun', obs, 12, near, -1).time;
    return near.ut - prev.ut < next.ut - near.ut ? prev : next;
}

function twilightAround(obs, mid) {
    // Dusk events lie between the preceding solar noon and solar midnight,
    // dawn events between midnight and the following noon; a little slack
    // absorbs the minutes by which the solar day differs from 24 h.
    const eve = mid.AddDays(-0.5);
    const span = 0.5 + 1 / 96;
    const dusk = (alt) => msOf(attempt(() => AE.SearchAltitude('Sun', obs, -1, eve, span, alt)));
    const dawn = (alt) => msOf(attempt(() => AE.SearchAltitude('Sun', obs, +1, mid, span, alt)));
    return {
        sunsetMs: msOf(attempt(() => AE.SearchRiseSet('Sun', obs, -1, eve, span))),
        civilDuskMs: dusk(-6),
        nauticalDuskMs: dusk(-12),
        astroDuskMs: dusk(-18),
        astroDawnMs: dawn(-18),
        nauticalDawnMs: dawn(-12),
        civilDawnMs: dawn(-6),
        sunriseMs: msOf(attempt(() => AE.SearchRiseSet('Sun', obs, +1, mid, span))),
    };
}

/**
 * Sunset, dusks, dawns and sunrise of "tonight": the night in progress at
 * nearMs, or the coming night when the Sun is up. Events that do not happen
 * (midnight sun, polar night, white nights) are null. When all exist they are
 * strictly ordered: sunset < civil < nautical < astro dusk < astro dawn <
 * nautical < civil dawn < sunrise. Twilight altitudes (−6/−12/−18°) are
 * unrefracted Sun-centre altitudes, by convention.
 * @param {ObserverLike} observer
 * @param {number} nearMs
 * @returns {Twilight}
 */
export function twilight(observer, nearMs) {
    const obs = aeObserverOf(observer);
    requireMs(nearMs, 'nearMs');
    return twilightAround(obs, nightCenter(obs, nearMs));
}

/**
 * Sun-centre altitude (degrees, unrefracted) at `n` evenly spaced instants
 * from fromMs to toMs inclusive — the day/night gradient of the time scrubber.
 * Classify samples with photometry.twilightClass().
 * @param {ObserverLike} observer
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} n Sample count, 1..100000.
 * @returns {Float32Array}
 */
export function sunAltitudeSeries(observer, fromMs, toMs, n) {
    const obs = aeObserverOf(observer);
    requireMs(fromMs, 'fromMs');
    requireMs(toMs, 'toMs');
    const count = Math.floor(Number(n));
    if (!(count >= 1 && count <= 100000)) throw new RangeError('n must be between 1 and 100000');
    const out = new Float32Array(count);
    const step = count > 1 ? (toMs - fromMs) / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
        const time = AE.MakeTime(new Date(fromMs + i * step));
        out[i] = horizontal('Sun', time, obs, undefined).altitude;
    }
    return out;
}

// Cached Intl formatters keyed by zone and clock style. An unknown zone falls
// back to UTC rather than failing the whole report.
const timeFormatters = new Map();
function timeFormatter(tz, hour12) {
    const key = `${tz}|${hour12 ? 12 : 24}`;
    let fn = timeFormatters.get(key);
    if (!fn) {
        const opts = hour12
            ? { hour: 'numeric', minute: '2-digit', hour12: true }
            : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        let dtf;
        try {
            dtf = new Intl.DateTimeFormat(hour12 ? 'en-US' : 'en-GB', { ...opts, timeZone: tz || 'UTC' });
        } catch {
            dtf = new Intl.DateTimeFormat(hour12 ? 'en-US' : 'en-GB', { ...opts, timeZone: 'UTC' });
        }
        fn = (ms) => (ms === null ? '—' : dtf.format(new Date(ms)));
        timeFormatters.set(key, fn);
    }
    return fn;
}

function fmtMag(m) {
    const s = Math.abs(m).toFixed(1);
    return m < 0 && s !== '0.0' ? `−${s}` : s;
}

// Apparent topocentric RA/Dec of date at hourly nodes, RA unwrapped so that
// linear interpolation never crosses the 0h/24h seam. Interpolating to the
// 10-minute samples is accurate to < 0.01° even for the Moon, whose diurnal
// parallax is the fastest-varying term, at a sixth of the cost.
function hourlyTrack(aeName, obs, t0, ra, dec) {
    for (let j = 0; j < NODES; j++) {
        const eq = AE.Equator(aeName, new AE.AstroTime(t0 + j / 24), obs, true, true);
        let r = eq.ra;
        if (j > 0) {
            while (r - ra[j - 1] > 12) r -= 24;
            while (r - ra[j - 1] < -12) r += 24;
        }
        ra[j] = r;
        dec[j] = eq.dec;
    }
}

function sampleTrack(times, obs, ra, dec, refraction, outAlt, outAz) {
    for (let k = 0; k < SAMPLES; k++) {
        const j = Math.min(NODES - 2, Math.floor(k / SAMPLES_PER_NODE));
        const f = k / SAMPLES_PER_NODE - j;
        const hor = AE.Horizon(times[k], obs, ra[j] + (ra[j + 1] - ra[j]) * f, dec[j] + (dec[j + 1] - dec[j]) * f, refraction);
        outAlt[k] = hor.altitude;
        if (outAz) outAz[k] = hor.azimuth;
    }
}

// Contiguous run of flagged samples around index k.
function runAround(flags, k) {
    let a = k, b = k;
    while (a > 0 && flags[a - 1]) a--;
    while (b < flags.length - 1 && flags[b + 1]) b++;
    return [a, b];
}

// Closest elongation at which each body can still be seen at all: the Danjon
// limit (~7°) for the lunar crescent, a similar figure for brilliant Venus,
// 12° for everything else (SPEC). Daylight sightings need a wider gap.
const GLARE_LIMIT_DEG = { moon: 7, venus: 7 };
const DEFAULT_GLARE_LIMIT_DEG = 12;
const DAYTIME_MIN_ELONG_DEG = 20;
const DAYTIME_CAPABLE = new Set(['moon', 'venus']);

/**
 * @typedef {{id:string, name:string,
 *   verdict:'excellent'|'good'|'low'|'twilight'|'daytime'|'not-visible',
 *   bestMs:number|null, bestAltDeg:number|null, bestAzDeg:number|null, compass:string|null,
 *   windowStartMs:number|null, windowEndMs:number|null, mag:number, phaseFrac:number,
 *   constellation:{symbol:string, name:string}, elongDeg:number,
 *   equipment:'naked-eye'|'binoculars'|'telescope', sentence:string}} TonightReport
 */

// 10-minute grid from solar noon to solar noon, plus the Sun's altitude on it.
function sampleGrid(obs, mid) {
    const t0 = mid.ut - 0.5;
    const times = new Array(SAMPLES);
    for (let k = 0; k < SAMPLES; k++) times[k] = new AE.AstroTime(t0 + (k * SAMPLE_MIN) / 1440);
    const ra = new Float64Array(NODES);
    const dec = new Float64Array(NODES);
    hourlyTrack('Sun', obs, t0, ra, dec);
    const sunAlt = new Float64Array(SAMPLES);
    sampleTrack(times, obs, ra, dec, undefined, sunAlt, null);
    let sunMin = Infinity, sunMax = -Infinity;
    for (const a of sunAlt) {
        sunMin = Math.min(sunMin, a);
        sunMax = Math.max(sunMax, a);
    }
    return { t0, times, sunAlt, sunMin, sunMax };
}

function nightBounds(tw, grid) {
    const firstMs = msOf(grid.times[0]);
    const lastMs = msOf(grid.times[SAMPLES - 1]);
    if (grid.sunMax < SUNRISE_ALT_DEG) return { nightStartMs: firstMs, nightEndMs: lastMs }; // polar night
    if (grid.sunMin >= SUNRISE_ALT_DEG) return { nightStartMs: null, nightEndMs: null };     // midnight sun
    return { nightStartMs: tw.sunsetMs ?? firstMs, nightEndMs: tw.sunriseMs ?? lastMs };
}

// Index of the highest flagged sample, or −1.
function highest(flags, alt) {
    let best = -1;
    for (let k = 0; k < flags.length; k++) {
        if (flags[k] && (best < 0 || alt[k] > alt[best])) best = k;
    }
    return best;
}

// Flags every sample as visible (up while dark enough), twilit (up, but the
// sky is not yet dark enough) or daylit, and finds the highest of each kind.
function classifySamples(grid, w, darkLimit) {
    const { sunAlt } = grid;
    let excellent = false;
    for (let k = 0; k < SAMPLES; k++) {
        const up = w.alt[k] > 5;
        const dark = sunAlt[k] < darkLimit;
        const day = sunAlt[k] >= SUNRISE_ALT_DEG;
        w.visible[k] = up && dark ? 1 : 0;
        w.twilit[k] = up && !dark && !day ? 1 : 0;
        w.daylit[k] = up && day ? 1 : 0;
        if (w.visible[k] && sunAlt[k] < -18 && w.alt[k] > 30) excellent = true;
    }
    return { vis: highest(w.visible, w.alt), tw: highest(w.twilit, w.alt), day: highest(w.daylit, w.alt), excellent };
}

function decideVerdict(id, elongDeg, c, w) {
    if (elongDeg < (GLARE_LIMIT_DEG[id] ?? DEFAULT_GLARE_LIMIT_DEG)) {
        return { verdict: 'not-visible', best: -1, flags: null, reason: `too close to the Sun (${Math.round(elongDeg)}°)` };
    }
    if (c.vis >= 0) {
        let verdict = 'low';
        if (c.excellent) verdict = 'excellent';
        else if (w.alt[c.vis] >= 15) verdict = 'good';
        return { verdict, best: c.vis, flags: w.visible, reason: null };
    }
    if (c.tw >= 0) return { verdict: 'twilight', best: c.tw, flags: w.twilit, reason: null };
    const daytimeOk = DAYTIME_CAPABLE.has(id);
    if (c.day >= 0 && daytimeOk && elongDeg >= DAYTIME_MIN_ELONG_DEG) {
        return { verdict: 'daytime', best: c.day, flags: w.daylit, reason: null };
    }
    let reason = 'below the horizon after dark';
    if (c.day >= 0) {
        reason = daytimeOk ? `lost in the Sun’s glare (${Math.round(elongDeg)}° away)` : 'up only in daylight';
    }
    return { verdict: 'not-visible', best: -1, flags: null, reason };
}

function equipmentFor(id, mag) {
    if (id === 'neptune') return 'telescope';
    if (id === 'uranus' || mag > 5.5) return 'binoculars';
    return 'naked-eye';
}

function reportFor(b, obs, mid, grid, w, fmt) {
    hourlyTrack(b.ae, obs, grid.t0, w.ra, w.dec);
    sampleTrack(grid.times, obs, w.ra, w.dec, 'normal', w.alt, w.az);
    const illMid = AE.Illumination(b.ae, mid);
    const elongDeg = AE.AngleFromSun(b.ae, mid);
    const c = classifySamples(grid, w, illMid.mag > 4 ? -12 : -6);
    const { verdict, best, flags, reason } = decideVerdict(b.id, elongDeg, c, w);
    const seen = best >= 0;
    const atTime = seen ? grid.times[best] : mid;
    const ill = seen ? AE.Illumination(b.ae, atTime) : illMid;
    const eqj = AE.Equator(b.ae, atTime, obs, false, false);
    const con = AE.Constellation(eqj.ra, eqj.dec);
    const [w0, w1] = seen ? runAround(flags, best) : [-1, -1];
    const report = {
        id: b.id,
        name: b.name,
        verdict,
        bestMs: seen ? msOf(grid.times[best]) : null,
        bestAltDeg: seen ? w.alt[best] : null,
        bestAzDeg: seen ? w.az[best] : null,
        compass: seen ? compass16(w.az[best]) : null,
        windowStartMs: seen ? msOf(grid.times[w0]) : null,
        windowEndMs: seen ? msOf(grid.times[w1]) : null,
        mag: ill.mag,
        phaseFrac: ill.phase_fraction,
        constellation: { symbol: con.symbol, name: con.name },
        elongDeg,
        equipment: equipmentFor(b.id, ill.mag),
        sentence: '',
    };
    report.sentence = sentenceFor(report, reason, fmt);
    return report;
}

/**
 * Observing verdicts for the Moon and the seven planets for "tonight" (see
 * {@link twilight} for which night). Samples every 10 min from solar noon to
 * solar noon. "Dark" means the Sun below −6° (−12° when mag > 4); "up" means
 * a refracted altitude above 5°.
 *  - excellent: up above 30° during astronomical darkness
 *  - good / low: visible in the dark, peaking at ≥ 15° / below 15°
 *  - twilight: only up during twilight
 *  - daytime: only up in daylight (Moon and Venus, at least 20° from the Sun)
 *  - not-visible: within 12° of the Sun (7° for the Moon and Venus, which
 *    are bright enough to be glimpsed closer), or never up
 * The Sun is not reported (reports follow BODIES order without it). best*
 * fields describe the highest point inside the viewing interval (null when
 * not visible); times in `sentence` use `opts.tz`, else `observer.tz`, else UTC.
 * @param {ObserverLike} observer
 * @param {number} nearMs
 * @param {{tz?:string, hour12?:boolean}} [opts]
 * @returns {{nightStartMs:number|null, nightEndMs:number|null, reports:TonightReport[], twilight:Twilight}}
 */
export function tonight(observer, nearMs, opts = {}) {
    const obs = aeObserverOf(observer);
    requireMs(nearMs, 'nearMs');
    const fmt = timeFormatter(opts?.tz || observer?.tz || 'UTC', !!opts?.hour12);
    const mid = nightCenter(obs, nearMs);
    const tw = twilightAround(obs, mid);
    const grid = sampleGrid(obs, mid);
    const w = {
        ra: new Float64Array(NODES),
        dec: new Float64Array(NODES),
        alt: new Float64Array(SAMPLES),
        az: new Float64Array(SAMPLES),
        visible: new Uint8Array(SAMPLES),
        twilit: new Uint8Array(SAMPLES),
        daylit: new Uint8Array(SAMPLES),
    };
    const reports = [];
    for (const b of BODIES) {
        if (b.id !== 'sun') reports.push(reportFor(b, obs, mid, grid, w, fmt));
    }
    return { ...nightBounds(tw, grid), reports, twilight: tw };
}

function litText(frac) {
    const pct = frac * 100;
    if (pct > 0 && pct < 1) return '<1% lit';
    return `${Math.round(pct)}% lit`;
}

function sentenceFor(r, reason, fmt) {
    if (r.verdict === 'not-visible') return `${r.name}: not visible tonight — ${reason}`;
    const light = r.id === 'moon' ? litText(r.phaseFrac) : `mag ${fmtMag(r.mag)}`;
    const gear = r.equipment === 'naked-eye' ? '' : ` (${r.equipment})`;
    const where = `${Math.round(r.bestAltDeg)}° ${r.compass}`;
    const con = r.constellation.name;
    switch (r.verdict) {
        case 'twilight':
            return `${r.name}: in twilight only, ${where} at ${fmt(r.bestMs)}, ${light} in ${con}${gear}`;
        case 'daytime':
            return `${r.name}: daytime only, ${where} at ${fmt(r.bestMs)}, ${light} in ${con}`;
        default:
            return `${r.name}: ${r.verdict}, highest ${fmt(r.bestMs)} at ${where}, ${light} in ${con}${gear}`;
    }
}
