/**
 * Upcoming sky events for the Events panel and the scrubber ticks.
 *
 * Sources (SPEC §C.2): Moon quarters; oppositions and solar conjunctions via
 * SearchRelativeLongitude; greatest elongations of Mercury and Venus; lunar
 * eclipses; global solar eclipses; solar eclipses seen from the observer;
 * equinoxes and solstices. Added for observers: close planet–planet pairings
 * and Moon–planet appulses/occultations that are visible from the observer's
 * site. Each source is isolated, so one failing search never empties the list.
 *
 * Phase 6 (events-breadth-unused-ae, meteor-showers): occultations and close passes of five
 * bright stars by the Moon (fixed J2000 directions, the same topocentric minimisation and
 * observability gate as the planets, pre-minimised on the interpolated Moon table so that only
 * observable close passes cost ephemeris calls), Venus at greatest brilliancy (SearchPeakMagnitude), transits
 * of Mercury and Venus (SearchTransit, with the Sun's altitude here at each contact), the year's
 * closest perigee and farthest apogee plus perigee full Moons (SearchLunarApsis), Saturn's
 * ring-plane crossings (the sign of ring_tilt, a 2038–39 triple crossing merged into one entry)
 * and meteor-shower maxima (astro/meteors.js, with the best hour here, the Moon and the expected
 * rate). The geocentric searches (transits, apsides) are cached across calls in the worker; the
 * whole addition stays within ≈ 20 ms for a 730-day list.
 *
 * Note on SearchRelativeLongitude: per astronomy-engine, a relative longitude
 * of 0° is the opposition of an outer planet (or the inferior conjunction of
 * Mercury/Venus) and 180° is a conjunction with the Sun (superior conjunction).
 *
 * @module astro/events
 */
import { AE } from './ae.js';
import { bodyById, AU_KM } from './bodies.js';
import { aeObserverOf, compass16 } from './almanac.js';
import { showerPeaks, radiantAt, zhrAt, hourlyRate, meteorLimitMag, EVENT_MIN_ZHR } from './meteors.js';
import { moonSky, NATURAL_NL } from './skyglow.js';

const DAY_MS = 86400000;
const RAD2DEG = 180 / Math.PI;
const OUTER = ['mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const INNER = ['mercury', 'venus'];
const PAIR_PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn'];
const PAIR_MAX_DEG = 1.5;          // planet–planet pairings worth a mention
const APPULSE_MAX_DEG = 1.0;       // Moon–planet, topocentric
const MOON_STEP_DAYS = 0.25;       // Moon sampled every 6 h (≤ 0.8°/h → ≤ 2.4° off a minimum)
const MOON_PREFILTER_DEG = APPULSE_MAX_DEG + 2;
const GLARE_DEG = 12;              // pairings closer to the Sun than this are unobservable
const SUPERMOON_KM = 361900;       // full Moon within ~10 % of perigee distance
const MOON_RADIUS_KM = 1737.4;
const QUARTERS = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
const GUARD = 1000;                // hard cap on iterations of any search loop (≥ quarters in 10 years)
const SUN_LIMB_DEG = 0.27;         // AE eclipse altitudes are the refracted centre; the upper limb is this much higher
const LUNAR_STEP_MIN = 5;          // Moon altitude sampled every 5 min across the umbral phases (≤ 1.3° apart)
const STAR_APPULSE_MAX_DEG = 0.5;  // Moon–star passes worth a mention (occultations always)
const CLUSTER_APPULSE_MAX_DEG = 1.0; // the Pleiades: the Moon among (or beside) the cluster
const CLUSTER_OCCULT_DEG = 0.75;   // …and over its bright members
const STAR_PREFILTER_DEG = 2.2;    // 6-h samples sit ≤ 1.8° along track from a ≤ 0.5° minimum
const MEAN_MOON_KM = 384400;
const RING_STEP_DAYS = 10;         // Saturn's ring tilt sampled every 10 days (crossings are ≥ 3 months apart)
const RING_GROUP_DAYS = 400;       // crossings closer than this are one edge-on season
const METEOR_STEP_H = 1;           // a shower's night sampled hourly around its maximum
const METEOR_HALF_H = 14;

/**
 * Bright stars on the Moon's path that it can occult: ICRS J2000 RA/Dec (degrees, Hipparcos
 * positions as given by SIMBAD). The Pleiades are represented by Alcyone (η Tau), their brightest
 * member near the cluster's centre. Proper motion is ignored (≤ 0.2″/yr: ≤ 3.3′ over 1000 years).
 */
export const OCCULTATION_STARS = Object.freeze([
    { id: 'aldebaran', name: 'Aldebaran', raDeg: 68.98016, decDeg: 16.50930, cluster: false },
    { id: 'pleiades', name: 'the Pleiades', raDeg: 56.87115, decDeg: 24.10514, cluster: true },
    { id: 'regulus', name: 'Regulus', raDeg: 152.09296, decDeg: 11.96721, cluster: false },
    { id: 'spica', name: 'Spica', raDeg: 201.29825, decDeg: -11.16132, cluster: false },
    { id: 'antares', name: 'Antares', raDeg: 247.35192, decDeg: -26.43200, cluster: false },
].map((s) => Object.freeze(s)));

/**
 * @typedef {import('../core/types.js').AstroEvent} AstroEvent
 * @typedef {{latDeg:number, lonDeg:number, elevM?:number}} ObserverLike
 */

function msOf(time) {
    return time.date.getTime();
}

function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtLat(lat) {
    return `${Math.abs(lat).toFixed(1)}° ${lat < 0 ? 'S' : 'N'}`;
}

function fmtLon(lon) {
    return `${Math.abs(lon).toFixed(1)}° ${lon < 0 ? 'W' : 'E'}`;
}

function fmtSep(deg) {
    return deg < 1 ? `${Math.max(1, Math.round(deg * 60))}′` : `${deg.toFixed(1)}°`;
}

function fmtThousands(n) {
    const s = String(Math.round(Math.abs(n)));
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (i > 0 && (s.length - i) % 3 === 0) out += ',';
        out += s[i];
    }
    return n < 0 ? `-${out}` : out;
}

function fmtMag(m) {
    const s = Math.abs(m).toFixed(1);
    return m < 0 && s !== '0.0' ? `−${s}` : s;
}

// Cached Intl clock formatters keyed by zone, clock style and seconds. An unknown zone falls back
// to UTC rather than failing the whole list. Seconds are truncated, like a clock.
const clockFormatters = new Map();
function clockFormatter(tz, hour12, seconds) {
    const key = `${tz}|${hour12 ? 12 : 24}|${seconds ? 's' : ''}`;
    let fn = clockFormatters.get(key);
    if (!fn) {
        const opts = hour12
            ? { hour: 'numeric', minute: '2-digit', hour12: true }
            : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        if (seconds) opts.second = '2-digit';
        const locale = hour12 ? 'en-US' : 'en-GB';
        let dtf;
        try {
            dtf = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz || 'UTC' });
        } catch {
            dtf = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
        }
        fn = (ms) => dtf.format(new Date(ms));
        clockFormatters.set(key, fn);
    }
    return fn;
}

// "21 Oct 2038" in a zone (cached per zone; an unknown zone falls back to UTC).
const dateFormatters = new Map();
function dateFormatter(tz) {
    let fn = dateFormatters.get(tz);
    if (!fn) {
        const opts = { day: 'numeric', month: 'short', year: 'numeric' };
        let dtf;
        try {
            dtf = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz || 'UTC' });
        } catch {
            dtf = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
        }
        fn = (ms) => dtf.format(new Date(ms));
        dateFormatters.set(tz, fn);
    }
    return fn;
}

/** "6 m 25 s", "48 s" for a central phase. */
function fmtDurS(s) {
    const r = Math.round(s);
    const m = Math.floor(r / 60), sec = r % 60;
    return m > 0 ? `${m} m ${sec} s` : `${sec} s`;
}

function unit(v) {
    const l = Math.hypot(v.x, v.y, v.z);
    return [v.x / l, v.y / l, v.z / l];
}

function sepDeg(a, b) {
    const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
    return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * RAD2DEG;
}

function constellationOf(vecEqj) {
    const eq = AE.EquatorFromVector(vecEqj);
    return AE.Constellation(eq.ra, eq.dec).name;
}

function horizontal(aeName, time, obs) {
    const eq = AE.Equator(aeName, time, obs, true, true);
    return AE.Horizon(time, obs, eq.ra, eq.dec, 'normal');
}

// Adds an event if it falls inside the requested span. `ev` holds kind,
// bodyId, tMs, title, detail and optionally select/view and extra fields.
function push(ctx, ev) {
    if (!(ev.tMs >= ctx.fromMs && ev.tMs <= ctx.toMs)) return;
    ctx.events.push({
        id: `${ev.kind}:${ev.bodyIds ? ev.bodyIds.join('+') : (ev.bodyId ?? 'sky')}:${Math.round(ev.tMs / 60000)}`,
        select: null,
        view: null,
        ...ev,
    });
}

// Golden-section minimisation of f on [a, b] (UT days); returns [t, f(t)].
function minimize(f, a, b, iterations = 26) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    let fc = f(c), fd = f(d);
    for (let i = 0; i < iterations; i++) {
        if (fc < fd) {
            b = d; d = c; fd = fc;
            c = b - g * (b - a); fc = f(c);
        } else {
            a = c; c = d; fc = fd;
            d = a + g * (b - a); fd = f(d);
        }
    }
    return fc < fd ? [c, fc] : [d, fd];
}

/**
 * Golden-section minimisation that gives up (null) once the bracket is under an hour wide and its
 * best value is still more than 0.4° above `limit`: the Moon moves ≤ 0.8°/h against the stars, so
 * the true minimum cannot then be below the limit. Most monthly passes are rejected in 8 evaluations.
 */
function minimizeBelow(f, a, b, limit, iterations) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    let fc = f(c), fd = f(d);
    for (let i = 0; i < iterations; i++) {
        if (b - a < 1 / 24 && Math.min(fc, fd) > limit + 0.4) return null;
        if (fc < fd) {
            b = d; d = c; fd = fc;
            c = b - g * (b - a); fc = f(c);
        } else {
            a = c; c = d; fc = fd;
            d = a + g * (b - a); fd = f(d);
        }
    }
    return fc < fd ? [c, fc] : [d, fd];
}

// Indices of discrete local minima below `limit`; each brackets a true
// minimum between its neighbours because separation curves are convex there.
function localMinima(series, limit) {
    const out = [];
    for (let i = 1; i < series.length - 1; i++) {
        if (series[i] <= series[i - 1] && series[i] < series[i + 1] && series[i] < limit) out.push(i);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function moonPhases(ctx) {
    let mq = AE.SearchMoonQuarter(ctx.from);
    for (let i = 0; i < GUARD && msOf(mq.time) <= ctx.toMs; i++) {
        const g = AE.GeoMoon(mq.time);
        const km = Math.hypot(g.x, g.y, g.z) * AU_KM;
        let detail = `Moon in ${constellationOf(g)}, ${fmtThousands(Math.round(km / 100) * 100)} km from Earth`;
        if (mq.quarter === 2 && km < SUPERMOON_KM) detail += ' — a supermoon';
        push(ctx, {
            kind: 'moon-phase', bodyId: 'moon', tMs: msOf(mq.time), title: QUARTERS[mq.quarter], detail,
            select: 'moon', quarter: mq.quarter,
        });
        mq = AE.NextMoonQuarter(mq);
    }
}

function relativeLongitudeEvents(ctx, id, target, describe) {
    const b = bodyById(id);
    let t = AE.SearchRelativeLongitude(b.ae, target, ctx.from);
    for (let i = 0; i < GUARD && msOf(t) <= ctx.toMs; i++) {
        push(ctx, { bodyId: id, tMs: msOf(t), select: id, ...describe(b, t) });
        t = AE.SearchRelativeLongitude(b.ae, target, t.AddDays(1));
    }
}

function describeOpposition(b, t) {
    const ill = AE.Illumination(b.ae, t);
    // Mars swings from 1.38 to 1.67 AU from the Sun, so its oppositions range from grand to poor.
    let mars = '';
    if (b.id === 'mars') {
        if (ill.helio_dist < 1.42) mars = '; a perihelic opposition, Mars near its closest to the Sun: as close and bright as it gets';
        else if (ill.helio_dist > 1.6) mars = '; an aphelic opposition: Mars stays small and comparatively faint';
    }
    return {
        kind: 'opposition',
        title: `${b.name} at opposition`,
        detail: `Closest and brightest for the year: mag ${fmtMag(ill.mag)}, ${ill.geo_dist.toFixed(2)} AU away, ` +
            `up all night in ${constellationOf(ill.gc)}${mars}`,
    };
}

function oppositionsAndConjunctions(ctx) {
    for (const id of OUTER) {
        relativeLongitudeEvents(ctx, id, 0, describeOpposition);
        relativeLongitudeEvents(ctx, id, 180, (b) => ({
            kind: 'conjunction',
            title: `${b.name} in conjunction with the Sun`,
            detail: 'Lost in the Sun’s glare; it reappears in the morning sky weeks later',
        }));
    }
    for (const id of INNER) {
        relativeLongitudeEvents(ctx, id, 0, (b) => ({
            kind: 'conjunction',
            title: `${b.name} at inferior conjunction`,
            detail: 'Passes between Earth and the Sun, moving from the evening to the morning sky',
        }));
        relativeLongitudeEvents(ctx, id, 180, (b) => ({
            kind: 'conjunction',
            title: `${b.name} at superior conjunction`,
            detail: 'Passes behind the Sun, moving from the morning to the evening sky',
        }));
    }
}

function greatestElongations(ctx) {
    for (const id of INNER) {
        const b = bodyById(id);
        let e = AE.SearchMaxElongation(b.ae, ctx.from);
        for (let i = 0; i < GUARD && msOf(e.time) <= ctx.toMs; i++) {
            const evening = e.visibility === 'evening';
            push(ctx, {
                kind: 'max-elongation', bodyId: id, tMs: msOf(e.time),
                title: `${b.name} at greatest elongation ${evening ? 'east' : 'west'} (${e.elongation.toFixed(1)}°)`,
                detail: evening ? 'Best evening view: look west after sunset' : 'Best morning view: look east before sunrise',
                select: id, elongDeg: e.elongation,
            });
            e = AE.SearchMaxElongation(b.ae, e.time.AddDays(1));
        }
    }
}

// The Moon's refracted altitude `min` minutes from mid-eclipse.
function moonAltAt(le, min, obs) {
    return horizontal('Moon', le.peak.AddDays(min / 1440), obs).altitude;
}

// Minute offset of the horizon crossing between offsets a (Moon up = upA) and b, bisected to ~1 s.
function horizonCrossing(le, obs, a, b, upA) {
    for (let k = 0; k < 9; k++) {
        const m = (a + b) / 2;
        if ((moonAltAt(le, m, obs) > 0) === upA) a = m; else b = m;
    }
    return (a + b) / 2;
}

// Where in a lunar eclipse an instant falls, for "the Moon rises …" sentences.
function lunarPhaseAt(le, min) {
    if (le.kind !== 'total') return 'during the partial phase';
    if (min < -le.sd_total) return 'before totality';
    return min > le.sd_total ? 'after totality' : 'during totality';
}

/**
 * The instant to look at an eclipse whose body is up only for part of it: the peak when the body
 * is up then, else a moment just inside the visible window nearest the peak (15 minutes past the
 * horizon crossing, or the middle of a shorter window). Offsets in minutes from the peak.
 */
function visibleOffsetMin(rise, set, half) {
    const NUDGE = 15;              // minutes: ~3° clear of the horizon
    // Not up at the peak: it rises after the peak (window [rise, set or U4]) or set before it.
    const afterRise = rise !== null && rise > 0 ? [rise, set !== null && set > rise ? set : half] : null;
    const beforeSet = set !== null && set < 0 ? [rise !== null && rise < set ? rise : -half, set] : null;
    const pick = afterRise && (!beforeSet || afterRise[0] <= -beforeSet[1]) ? afterRise : beforeSet;
    if (!pick) return 0;
    const nudge = Math.min(NUDGE, (pick[1] - pick[0]) / 2);
    return pick === afterRise ? pick[0] + nudge : pick[1] - nudge;
}

/**
 * Whether a lunar eclipse can be seen from the observer, and the sentence that says so.
 * A partial or total eclipse counts as visible when the Moon is above the horizon at any time
 * in the umbral phases (U1–U4), not only at mid-eclipse, so eclipses at moonrise and moonset
 * are found. A penumbral eclipse is only a faint shading near its middle, so it is judged
 * at mid-eclipse. `visibleMs` is when to look: mid-eclipse when the Moon is up then, else just
 * after moonrise or before moonset (null when it is not visible).
 * @returns {{visible:boolean, text:string, visibleMs:number|null}}
 */
function lunarVisibility(le, obs) {
    const alt = moonAltAt(le, 0, obs);
    const up = alt > 0;
    const upText = alt < 0.5 ? 'on the horizon' : `${Math.round(alt)}° up`;
    const atPeak = `the Moon is ${upText} at mid-eclipse`;
    const peakMs = msOf(le.peak);
    if (le.kind === 'penumbral') {
        return up
            ? { visible: true, text: `Visible from here: ${atPeak}`, visibleMs: peakMs }
            : { visible: false, text: 'Not visible from here: the Moon is below the horizon at mid-eclipse', visibleMs: null };
    }
    // The umbral phases last at most ~3.8 h, too short for the Moon to both rise and set
    // (outside the polar regions), so one crossing on each side of the peak is enough.
    const half = le.sd_partial;
    const steps = Math.max(2, Math.ceil(half / LUNAR_STEP_MIN));
    let prevM = -half, prevUp = moonAltAt(le, prevM, obs) > 0;
    let rise = null, set = null, anyUp = up || prevUp;
    for (let k = 1; k <= 2 * steps; k++) {
        const m = k === steps ? 0 : -half + (k * half) / steps;
        const isUp = k === steps ? up : moonAltAt(le, m, obs) > 0;
        if (isUp !== prevUp) {
            const at = horizonCrossing(le, obs, prevM, m, prevUp);
            if (isUp) rise ??= at; else set ??= at;
        }
        anyUp ||= isUp;
        prevM = m; prevUp = isUp;
    }
    if (!anyUp) return { visible: false, text: 'Not visible from here: the Moon is below the horizon throughout the eclipse', visibleMs: null };
    let text;
    if (up) {
        if (rise !== null && rise < 0) text = `Visible from here: the Moon rises ${lunarPhaseAt(le, rise)} and is ${upText} at mid-eclipse`;
        else if (set !== null && set > 0) text = `Visible from here: ${atPeak} and sets ${lunarPhaseAt(le, set)}`;
        else text = `Visible from here: ${atPeak}`;
    } else {
        // "During" phases straddle mid-eclipse, so say which half is seen.
        const phase = lunarPhaseAt(le, rise ?? set ?? 0);
        const which = phase.startsWith('during') ? (rise !== null ? ', after mid-eclipse' : ', before mid-eclipse') : '';
        text = `Partly visible from here: the Moon ${rise !== null ? 'rises' : 'sets'} ${phase}${which}`;
    }
    const visibleMs = up ? peakMs : Math.round(peakMs + visibleOffsetMin(rise, set, half) * 60000);
    return { visible: true, text, visibleMs };
}

/** Contact times (ms) of a lunar eclipse from its semi-durations; null for phases it lacks. */
function lunarContacts(le) {
    const peak = msOf(le.peak);
    const at = (min, sign) => (min > 0 ? Math.round(peak + sign * min * 60000) : null);
    return {
        p1Ms: at(le.sd_penum, -1), u1Ms: at(le.sd_partial, -1), u2Ms: at(le.sd_total, -1), maxMs: peak,
        u3Ms: at(le.sd_total, 1), u4Ms: at(le.sd_partial, 1), p4Ms: at(le.sd_penum, 1),
    };
}

function lunarEclipses(ctx) {
    let le = AE.SearchLunarEclipse(ctx.from);
    for (let i = 0; i < GUARD && msOf(le.peak) <= ctx.toMs; i++) {
        const { visible, text, visibleMs } = lunarVisibility(le, ctx.obs);
        const c = lunarContacts(le);
        const hm = ctx.clock;
        let detail = text;
        if (le.kind === 'total') detail += `; totality ${hm(c.u2Ms)}–${hm(c.u3Ms)} (${Math.round(2 * le.sd_total)} min)`;
        else if (le.kind === 'partial') detail += `; partial phase ${hm(c.u1Ms)}–${hm(c.u4Ms)} (${Math.round(2 * le.sd_partial)} min)`;
        else detail += '; only a subtle shading of the Moon';
        push(ctx, {
            kind: 'lunar-eclipse', bodyId: 'moon', tMs: msOf(le.peak), title: `${cap(le.kind)} lunar eclipse`, detail,
            select: 'moon', view: visible ? 'sky' : 'orbit',
            eclipseKind: le.kind, obscuration: le.obscuration, visibleHere: visible, visibleMs, ...c,
        });
        le = AE.NextLunarEclipse(le.peak);
    }
}

// Central duration (s) of a local solar eclipse, or null for a partial one.
function centralDurS(ls) {
    if (ls.kind === 'partial' || !ls.total_begin || !ls.total_end) return null;
    return (msOf(ls.total_end.time) - msOf(ls.total_begin.time)) / 1000;
}

function globalSolarEclipses(ctx) {
    let ge = AE.SearchGlobalSolarEclipse(ctx.from);
    for (let i = 0; i < GUARD && msOf(ge.peak) <= ctx.toMs; i++) {
        const hasCentre = Number.isFinite(ge.latitude) && Number.isFinite(ge.longitude);
        const title = hasCentre
            ? `${cap(ge.kind)} solar eclipse — greatest at ${fmtLat(ge.latitude)}, ${fmtLon(ge.longitude)}`
            : `${cap(ge.kind)} solar eclipse`;
        // The central duration where it is longest, from AE's local circumstances there.
        let durS = null;
        if (hasCentre && ge.kind !== 'partial') {
            try {
                const ls = AE.SearchLocalSolarEclipse(ge.peak.AddDays(-1), new AE.Observer(ge.latitude, ge.longitude, 0));
                if (Math.abs(msOf(ls.peak.time) - msOf(ge.peak)) < DAY_MS) durS = centralDurS(ls);
            } catch {
                durS = null;
            }
        }
        const upTo = durS ? `, up to ${fmtDurS(durS)}` : '';
        let detail = 'Only the Moon’s penumbra touches Earth, so it is partial everywhere';
        if (ge.kind === 'total') detail = `The Moon’s dark umbra sweeps a narrow track of totality across Earth${upTo}`;
        else if (ge.kind === 'annular') detail = `A “ring of fire” along a narrow track where the Moon is too far to cover the Sun${upTo}`;
        push(ctx, {
            kind: 'solar-eclipse', bodyId: 'sun', tMs: msOf(ge.peak), title, detail, select: 'sun', view: 'orbit',
            eclipseKind: ge.kind, geo: hasCentre ? { latDeg: ge.latitude, lonDeg: ge.longitude, durS } : null,
        });
        ge = AE.NextGlobalSolarEclipse(ge.peak);
    }
}

// True when the Sun's upper limb is above the horizon at an AE EclipseEvent.
function sunUp(ev) {
    return ev.altitude + SUN_LIMB_DEG > 0;
}

// The Sun's upper limb crossing the horizon between a (Sun down) and b (Sun up), in ms, to ~1 s.
function sunHorizonCrossing(downMs, upMs, obs) {
    let a = downMs, b = upMs;
    for (let k = 0; k < 14 && Math.abs(b - a) > 1000; k++) {
        const m = (a + b) / 2;
        if (horizontal('Sun', AE.MakeTime(new Date(m)), obs).altitude + SUN_LIMB_DEG > 0) b = m; else a = m;
    }
    return b;
}

/**
 * When to look at a local solar eclipse: maximum when the Sun is up then, else just after
 * sunrise (it rises after maximum) or before sunset (it sets before), 10 minutes inside the
 * visible part or its middle when shorter.
 */
function solarVisibleMs(ls, obs) {
    const peak = msOf(ls.peak.time);
    if (sunUp(ls.peak)) return peak;
    const NUDGE = 600e3;
    if (sunUp(ls.partial_end)) {
        const end = msOf(ls.partial_end.time);
        const rise = sunHorizonCrossing(peak, end, obs);
        return Math.round(rise + Math.min(NUDGE, (end - rise) / 2));
    }
    const start = msOf(ls.partial_begin.time);
    const set = sunHorizonCrossing(peak, start, obs);
    return Math.round(set - Math.min(NUDGE, (set - start) / 2));
}

// How much of the total or annular phase (C2–C3) is above the horizon:
// 'all', 'sunrise' or 'sunset' (only its end or its start), 'none', or null for a partial eclipse.
function centralPhaseUp(ls) {
    if (ls.kind === 'partial' || !ls.total_begin || !ls.total_end) return null;
    const c2 = sunUp(ls.total_begin), c3 = sunUp(ls.total_end);
    if (c2 && c3) return 'all';
    if (c2) return 'sunset';
    return c3 ? 'sunrise' : 'none';
}

/**
 * Title of a local solar eclipse. 'Total' or 'Annular … visible here' is promised only when
 * the central phase itself is above the horizon: 'at sunrise' / 'at sunset' when only part of
 * it is, and a partial eclipse when all of it happens with the Sun below the horizon. The peak
 * obscuration is quoted only when maximum itself is above the horizon.
 */
function localEclipseTitle(ls) {
    const pct = ls.obscuration * 100;
    // A partial eclipse never shows 100 %, however close it comes.
    const shown = ls.kind === 'partial' ? Math.min(99, Math.round(pct)) : Math.round(pct);
    const covered = !sunUp(ls.peak) ? null : pct < 1 ? '<1% covered' : `${shown}% covered`;
    const central = centralPhaseUp(ls);
    if (central === null) {
        if (covered) return `Partial solar eclipse visible here (${covered})`;
        return `Partial solar eclipse visible here at ${sunUp(ls.partial_end) ? 'sunrise' : 'sunset'}`;
    }
    if (central === 'none') {
        return `Partial solar eclipse visible here (${ls.kind === 'total' ? 'totality' : 'the ring phase'} is below the horizon)`;
    }
    if (central !== 'all') return `${ls.kind === 'total' ? 'Total' : 'Annular'} solar eclipse visible here at ${central}`;
    const dur = fmtDurS(centralDurS(ls));
    if (ls.kind === 'total') return `Total solar eclipse visible here (${dur})`;
    return `Annular solar eclipse visible here (${dur}, ${covered})`;
}

// The sentence on where the Sun stands, for an eclipse that may start before sunrise or end after sunset.
function localEclipseWhere(ls) {
    const central = centralPhaseUp(ls);
    if (central === 'sunrise' || central === 'sunset') {
        return `The Sun ${central === 'sunrise' ? 'rises' : 'sets'} during ${ls.kind === 'total' ? 'totality' : 'the ring phase'}.`;
    }
    const rises = !sunUp(ls.partial_begin), sets = !sunUp(ls.partial_end);
    if (sunUp(ls.peak)) {
        const alt = ls.peak.altitude < 0.5 ? 'on the horizon' : `${Math.round(ls.peak.altitude)}° up`;
        if (rises) return `The Sun rises already eclipsed and is ${alt} at maximum.`;
        if (sets) return `The Sun is ${alt} at maximum and sets before the eclipse ends.`;
        return `The Sun is ${alt} at maximum.`;
    }
    if (rises && !sets) return 'The Sun rises after maximum, still partly eclipsed.';
    if (sets && !rises) return 'The Sun sets before maximum, already partly eclipsed.';
    return 'Maximum comes with the Sun below the horizon; only part of it is visible.';
}

/**
 * The detail sentences: the central phase's contacts and length (to the second), the partial
 * phases (to the minute), where the Sun stands, and the safety line. With the whole central
 * phase up: "Totality 13:01:49–13:08:14 (6 m 25 s), Sun 82° up. Partial phases 11:40–14:26."
 */
function localEclipseDetail(ls, clock, clockS) {
    const central = centralPhaseUp(ls);
    const parts = [];
    const phase = ls.kind === 'total' ? 'Totality' : 'Ring of fire';
    const range = central ? `${clockS(msOf(ls.total_begin.time))}–${clockS(msOf(ls.total_end.time))} (${fmtDurS(centralDurS(ls))})` : '';
    const partial = `${clock(msOf(ls.partial_begin.time))}–${clock(msOf(ls.partial_end.time))}`;
    if (central === 'all') {
        const alt = ls.peak.altitude < 0.5 ? 'on the horizon' : `${Math.round(ls.peak.altitude)}° up`;
        parts.push(`${phase} ${range}, Sun ${alt}.`, `Partial phases ${partial}.`);
    } else if (central === 'sunrise' || central === 'sunset') {
        parts.push(`${phase} ${range}.`, localEclipseWhere(ls), `Partial phases ${partial}.`);
    } else {
        parts.push(`Partial phases ${partial}, maximum at ${clock(msOf(ls.peak.time))}.`, localEclipseWhere(ls));
    }
    parts.push('Never look at the Sun without certified eclipse glasses.');
    return parts.join(' ');
}

// A local solar eclipse event (null when the Moon only grazes the Sun's disc here).
function localSolarEvent(ls, obs, clock, clockS) {
    if (!(ls.obscuration > 0)) return null;
    const ms = (ev) => (ev ? msOf(ev.time) : null);
    const alt = (ev) => (ev ? ev.altitude : null);
    return {
        kind: 'local-solar-eclipse', bodyId: 'sun', tMs: msOf(ls.peak.time), title: localEclipseTitle(ls),
        detail: localEclipseDetail(ls, clock, clockS),
        select: 'sun', view: 'sky', eclipseKind: ls.kind, obscuration: ls.obscuration,
        c1Ms: ms(ls.partial_begin), c2Ms: ms(ls.total_begin), maxMs: ms(ls.peak), c3Ms: ms(ls.total_end), c4Ms: ms(ls.partial_end),
        totalDurS: centralDurS(ls),
        sunAltDeg: { c1: alt(ls.partial_begin), c2: alt(ls.total_begin), max: alt(ls.peak), c3: alt(ls.total_end), c4: alt(ls.partial_end) },
        centralUp: centralPhaseUp(ls),
        visibleMs: solarVisibleMs(ls, obs),
    };
}

function localSolarEclipses(ctx) {
    let ls = AE.SearchLocalSolarEclipse(ctx.from, ctx.obs);
    for (let i = 0; i < GUARD && msOf(ls.peak.time) <= ctx.toMs; i++) {
        const ev = localSolarEvent(ls, ctx.obs, ctx.clock, ctx.clockS);
        if (ev) push(ctx, ev);
        ls = AE.NextLocalSolarEclipse(ls.peak.time, ctx.obs);
    }
}

function seasons(ctx) {
    const north = ctx.latDeg >= 0;
    const hemi = north ? 'northern' : 'southern';
    const equal = 'day and night are nearly equal everywhere';
    const longest = 'Longest day of the year here; the noon Sun stands highest';
    const shortest = 'Shortest day of the year here; the noon Sun stands lowest';
    const y0 = new Date(ctx.fromMs).getUTCFullYear();
    const y1 = new Date(ctx.toMs).getUTCFullYear();
    for (let y = y0; y <= y1; y++) {
        const s = AE.Seasons(y);
        const entries = [
            ['equinox', s.mar_equinox, 'March equinox', `${north ? 'Spring' : 'Autumn'} begins in the ${hemi} hemisphere; ${equal}`],
            ['solstice', s.jun_solstice, 'June solstice', north ? longest : shortest],
            ['equinox', s.sep_equinox, 'September equinox', `${north ? 'Autumn' : 'Spring'} begins in the ${hemi} hemisphere; ${equal}`],
            ['solstice', s.dec_solstice, 'December solstice', north ? shortest : longest],
        ];
        for (const [kind, t, title, detail] of entries) {
            push(ctx, { kind, bodyId: 'sun', tMs: msOf(t), title, detail, view: 'orbit' });
        }
    }
}

// Daily geocentric unit vectors of the Sun and the bright planets, shared by
// the pairing and appulse searches.
function dailyDirections(ctx) {
    if (ctx.daily) return ctx.daily;
    const t0 = ctx.from.ut - 1;
    const n = Math.ceil((ctx.toMs - ctx.fromMs) / DAY_MS) + 3;
    const dirs = {};
    for (const id of ['sun', ...PAIR_PLANETS]) {
        const b = bodyById(id);
        const arr = new Float64Array(3 * n);
        for (let i = 0; i < n; i++) arr.set(unit(AE.GeoVector(b.ae, new AE.AstroTime(t0 + i), true)), 3 * i);
        dirs[id] = arr;
    }
    ctx.daily = { t0, n, dirs };
    return ctx.daily;
}

function dirAt(arr, i) {
    return [arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]];
}

// Linear interpolation of a daily direction table at fractional day x.
function dirInterp(arr, n, x) {
    const i = Math.min(n - 2, Math.max(0, Math.floor(x))), f = x - i, j = 3 * i;
    return [arr[j] + (arr[j + 3] - arr[j]) * f, arr[j + 1] + (arr[j + 4] - arr[j + 1]) * f, arr[j + 2] + (arr[j + 5] - arr[j + 2]) * f];
}

function geoSep(a, b, ut) {
    const time = new AE.AstroTime(ut);
    return sepDeg(unit(AE.GeoVector(a.ae, time, true)), unit(AE.GeoVector(b.ae, time, true)));
}

function pairingEvent(ctx, a, b, ut, minSep) {
    const time = new AE.AstroTime(ut);
    const va = AE.GeoVector(a.ae, time, true);
    const elong = sepDeg(unit(va), unit(AE.GeoVector('Sun', time, true)));
    if (elong < GLARE_DEG) return;
    const brighter = AE.Illumination(a.ae, time).mag <= AE.Illumination(b.ae, time).mag ? a : b;
    push(ctx, {
        kind: 'conjunction', bodyId: a.id, tMs: msOf(time),
        title: `${a.name}–${b.name} conjunction (${fmtSep(minSep)} apart)`,
        detail: `A close pairing in the ${AE.Elongation(a.ae, time).visibility} sky, ${Math.round(elong)}° from the Sun, in ${constellationOf(va)}`,
        select: brighter.id, view: 'sky', bodyIds: [a.id, b.id], sepDeg: minSep,
    });
}

function planetPairings(ctx) {
    const { t0, n, dirs } = dailyDirections(ctx);
    for (let p = 0; p < PAIR_PLANETS.length; p++) {
        for (let q = p + 1; q < PAIR_PLANETS.length; q++) {
            const a = bodyById(PAIR_PLANETS[p]), b = bodyById(PAIR_PLANETS[q]);
            const sep = new Float64Array(n);
            for (let i = 0; i < n; i++) sep[i] = sepDeg(dirAt(dirs[a.id], i), dirAt(dirs[b.id], i));
            for (const i of localMinima(sep, PAIR_MAX_DEG + 1)) {
                const [ut, minSep] = minimize((x) => geoSep(a, b, x), t0 + i - 1, t0 + i + 1);
                if (minSep < PAIR_MAX_DEG) pairingEvent(ctx, a, b, ut, minSep);
            }
        }
    }
}

function topoDir(aeName, ut, obs) {
    return unit(AE.Equator(aeName, new AE.AstroTime(ut), obs, false, false).vec);
}

function appulseEvent(ctx, b, ut, minSep) {
    const obs = ctx.obs;
    const time = new AE.AstroTime(ut);
    const moonHor = horizontal('Moon', time, obs);
    if (moonHor.altitude < 3 || horizontal('Sun', time, obs).altitude > -3) return; // must be observable here
    const moonEq = AE.Equator('Moon', time, obs, false, false);
    const occults = minSep < Math.asin(MOON_RADIUS_KM / (moonEq.dist * AU_KM)) * RAD2DEG;
    push(ctx, {
        kind: 'conjunction', bodyId: 'moon', tMs: msOf(time),
        title: occults ? `Moon occults ${b.name}` : `Moon passes ${fmtSep(minSep)} from ${b.name}`,
        detail: `Visible from here, ${Math.round(moonHor.altitude)}° up in the ${compass16(moonHor.azimuth)}, in ${constellationOf(moonEq.vec)}`,
        select: b.id, view: 'sky', bodyIds: ['moon', b.id], sepDeg: minSep, occultation: occults,
    });
}

// The Moon's topocentric J2000 direction every MOON_STEP_DAYS over the span (shared by the
// planet appulses and the star occultations).
function moonTable(ctx) {
    if (ctx.moonTopo) return ctx.moonTopo;
    const t0 = ctx.from.ut - 1;
    const n = Math.ceil((ctx.toMs - ctx.fromMs) / DAY_MS) + 3;
    const m = Math.floor((n - 1) / MOON_STEP_DAYS) + 1;
    const moon = new Float64Array(3 * m);
    for (let k = 0; k < m; k++) moon.set(topoDir('Moon', t0 + k * MOON_STEP_DAYS, ctx.obs), 3 * k);
    ctx.moonTopo = { t0, m, moon };
    return ctx.moonTopo;
}

function moonAppulses(ctx) {
    const { t0, n, dirs } = dailyDirections(ctx);
    const obs = ctx.obs;
    const { m, moon } = moonTable(ctx);
    const sep = new Float64Array(m);
    for (const id of PAIR_PLANETS) {
        const b = bodyById(id);
        // Planets move < 2°/day, so the daily geocentric table interpolates to
        // arcseconds, and their parallax (< 30″) is negligible here.
        for (let k = 0; k < m; k++) sep[k] = sepDeg(dirAt(moon, k), dirInterp(dirs[id], n, k * MOON_STEP_DAYS));
        for (const k of localMinima(sep, MOON_PREFILTER_DEG)) {
            const f = (ut) => sepDeg(topoDir('Moon', ut, obs), topoDir(b.ae, ut, obs));
            const [ut, minSep] = minimize(f, t0 + (k - 1) * MOON_STEP_DAYS, t0 + (k + 1) * MOON_STEP_DAYS);
            if (minSep < APPULSE_MAX_DEG) appulseEvent(ctx, b, ut, minSep);
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 6 sources
// ---------------------------------------------------------------------------

function starVector(s) {
    const a = s.raDeg * Math.PI / 180, d = s.decDeg * Math.PI / 180;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

function starEvent(ctx, star, ut, minSep) {
    const obs = ctx.obs;
    const time = new AE.AstroTime(ut);
    const moonHor = horizontal('Moon', time, obs);
    if (moonHor.altitude < 3 || horizontal('Sun', time, obs).altitude > -3) return; // observable here
    const moonEq = AE.Equator('Moon', time, obs, false, false);
    const moonR = Math.asin(MOON_RADIUS_KM / (moonEq.dist * AU_KM)) * RAD2DEG;
    const occults = star.cluster ? minSep < CLUSTER_OCCULT_DEG : minSep < moonR;
    let title;
    if (star.cluster) title = occults ? 'The Moon passes over the Pleiades' : `Moon passes ${fmtSep(minSep)} from the Pleiades`;
    else title = occults ? `Moon occults ${star.name}` : `Moon passes ${fmtSep(minSep)} from ${star.name}`;
    const what = star.cluster
        ? (occults ? '; it covers the cluster’s bright stars one by one' : '')
        : (occults ? `; ${star.name} vanishes behind the Moon’s limb and reappears up to an hour later` : '');
    push(ctx, {
        id: `occultation:${star.id}:${Math.round(msOf(time) / 60000)}`,
        kind: 'occultation', bodyId: 'moon', tMs: msOf(time), title,
        detail: `Visible from here, ${Math.round(moonHor.altitude)}° up in the ${compass16(moonHor.azimuth)}, in ${constellationOf(moonEq.vec)}${what}`,
        select: 'moon', view: 'sky', star: star.id, sepDeg: minSep, occultation: occults,
    });
}

/**
 * The Moon table's direction at fractional sample index x (Catmull–Rom through the four nearest
 * samples, renormalised). Six-hourly samples of the topocentric Moon interpolate to ≈ 0.02°: the
 * diurnal parallax (≤ 1°, a 24.8-h period) is the fastest term.
 */
function moonInterp(table, x, out) {
    const { m, moon } = table;
    const i = Math.min(m - 3, Math.max(1, Math.floor(x))), f = x - i;
    const f2 = f * f, f3 = f2 * f;
    const w0 = -0.5 * f3 + f2 - 0.5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + 0.5 * f, w3 = 0.5 * f3 - 0.5 * f2;
    for (let c = 0; c < 3; c++) {
        out[c] = w0 * moon[3 * (i - 1) + c] + w1 * moon[3 * i + c] + w2 * moon[3 * (i + 1) + c] + w3 * moon[3 * (i + 2) + c];
    }
    const l = Math.hypot(out[0], out[1], out[2]);
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
}

/**
 * Close passes and occultations of the five OCCULTATION_STARS by the Moon, topocentric, kept only
 * when the Moon is up in a dark enough sky here. Each monthly pass is first minimised on the
 * interpolated 6-hourly Moon table (shared with the planet appulses; no ephemeris calls), and only
 * passes that come within 0.15° of the limit are refined against AE (about an hour either side).
 */
function starOccultations(ctx) {
    const table = moonTable(ctx);
    const { t0, m, moon } = table;
    const obs = ctx.obs;
    const sep = new Float64Array(m);
    const p = [0, 0, 0];
    for (const star of OCCULTATION_STARS) {
        const v = starVector(star);
        const limit = star.cluster ? CLUSTER_APPULSE_MAX_DEG : STAR_APPULSE_MAX_DEG;
        for (let k = 0; k < m; k++) sep[k] = sepDeg(dirAt(moon, k), v);
        for (const k of localMinima(sep, STAR_PREFILTER_DEG + limit)) {
            if (k < 2 || k > m - 3) continue;
            const [x, est] = minimize((xi) => sepDeg(moonInterp(table, xi, p), v), k - 1, k + 1, 22);
            if (est > limit + 0.15) continue;
            const ut0 = t0 + x * MOON_STEP_DAYS;
            // The refined minimum is within minutes of ut0: a Moon well down or a Sun well up there
            // already fails the observability gate (starEvent), so it is not refined.
            const t0Time = new AE.AstroTime(ut0);
            if (horizontal('Moon', t0Time, obs).altitude < 0 || horizontal('Sun', t0Time, obs).altitude > 0) continue;
            const [ut, minSep] = minimize((ut1) => sepDeg(topoDir('Moon', ut1, obs), v), ut0 - 1 / 24, ut0 + 1 / 24, 12);
            if (minSep < limit) starEvent(ctx, star, ut, minSep);
        }
    }
}

/** Venus at greatest brilliancy (AE.SearchPeakMagnitude), twice in each 584-day cycle. */
function venusBrilliancy(ctx) {
    let pm = AE.SearchPeakMagnitude('Venus', ctx.from);
    for (let i = 0; i < GUARD && msOf(pm.time) <= ctx.toMs; i++) {
        const el = AE.Elongation('Venus', pm.time);
        push(ctx, {
            kind: 'brilliancy', bodyId: 'venus', tMs: msOf(pm.time),
            title: `Venus at greatest brilliancy (mag ${fmtMag(pm.mag)})`,
            detail: `At its brightest in the ${el.visibility} sky: a ${Math.round(pm.phase_fraction * 100)}%-lit crescent ` +
                `${Math.round(el.elongation)}° from the Sun, in ${constellationOf(pm.gc)}; bright enough to cast shadows at a dark site`,
            select: 'venus', mag: pm.mag,
        });
        pm = AE.SearchPeakMagnitude('Venus', pm.time.AddDays(30));
    }
}

/**
 * Transits of Mercury and Venus are global and rare (Mercury 13–14 a century, Venus next in
 * 2117), so the searches are kept across calls: per planet, the transits found and the span
 * [fromMs, toMs] they are known to be complete for.
 */
const transitCache = new Map();

function transitsBetween(name, fromMs, toMs) {
    const c = transitCache.get(name);
    if (c && fromMs >= c.fromMs && toMs <= c.toMs) return c.list.filter((x) => x.peakMs >= fromMs && x.peakMs <= toMs);
    const list = [];
    let tr = AE.SearchTransit(name, AE.MakeTime(new Date(fromMs)));
    let complete = toMs;
    for (let i = 0; i < 40; i++) {
        const t = { startMs: msOf(tr.start), peakMs: msOf(tr.peak), finishMs: msOf(tr.finish), sepArcmin: tr.separation };
        list.push(t);
        if (t.peakMs > toMs) { complete = t.peakMs; break; }
        tr = AE.NextTransit(name, tr.finish);
    }
    transitCache.set(name, { fromMs, toMs: complete, list });
    return list.filter((x) => x.peakMs >= fromMs && x.peakMs <= toMs);
}

function transits(ctx) {
    for (const id of INNER) {
        const b = bodyById(id);
        for (const tr of transitsBetween(b.ae, ctx.fromMs - DAY_MS, ctx.toMs)) {
            const up = [tr.startMs, tr.peakMs, tr.finishMs].map((ms) => horizontal('Sun', AE.MakeTime(new Date(ms)), ctx.obs).altitude + SUN_LIMB_DEG > 0);
            const all = up.every(Boolean), any = up.some(Boolean);
            let vis = 'Not visible from here: the Sun is down throughout';
            if (all) vis = 'Visible from here from start to finish';
            else if (any) vis = up[0] ? 'Partly visible from here: the Sun sets before it ends' : 'Partly visible from here: the Sun rises during it';
            let visibleMs = null;
            if (up[1]) visibleMs = tr.peakMs;
            else if (up[0]) visibleMs = Math.min(tr.startMs + 600e3, tr.peakMs);
            else if (up[2]) visibleMs = Math.max(tr.finishMs - 600e3, tr.peakMs);
            push(ctx, {
                kind: 'transit', bodyId: id, tMs: tr.peakMs,
                title: `Transit of ${b.name} across the Sun`,
                detail: `${b.name} crosses the Sun’s face ${ctx.clock(tr.startMs)}–${ctx.clock(tr.finishMs)}, passing ${Math.round(tr.sepArcmin)}′ from its centre at ${ctx.clock(tr.peakMs)}. ` +
                    `${vis}. Never look at the Sun without a proper solar filter.`,
                select: id, view: any ? 'sky' : 'orbit', visibleHere: any, visibleMs,
                startMs: tr.startMs, finishMs: tr.finishMs, sepArcmin: tr.sepArcmin,
            });
        }
    }
}

/** Lunar perigees and apogees of a calendar year (UT), cached across calls. */
const apsisCache = new Map();
function apsidesOfYear(year) {
    let list = apsisCache.get(year);
    if (list) return list;
    list = [];
    const end = Date.UTC(year + 1, 0, 1);
    let a = AE.SearchLunarApsis(AE.MakeTime(new Date(Date.UTC(year, 0, 1))));
    for (let i = 0; i < 40 && msOf(a.time) < end; i++) {
        list.push({ perigee: a.kind === 0, ms: msOf(a.time), km: a.dist_km });
        a = AE.NextLunarApsis(a);
    }
    if (apsisCache.size >= 64) apsisCache.delete(apsisCache.keys().next().value);
    apsisCache.set(year, list);
    return list;
}

/**
 * The Moon's closest perigee and farthest apogee of each calendar year, and every perigee within
 * a day of full Moon (a "perigee full Moon", the supermoon in its strict sense).
 */
function lunarApsides(ctx) {
    const y0 = new Date(ctx.fromMs).getUTCFullYear(), y1 = new Date(ctx.toMs).getUTCFullYear();
    for (let y = y0; y <= y1; y++) {
        const list = apsidesOfYear(y);
        let near = null, far = null;
        for (const a of list) {
            if (a.perigee && (!near || a.km < near.km)) near = a;
            if (!a.perigee && (!far || a.km > far.km)) far = a;
        }
        for (const a of list) {
            if (!a.perigee) continue;
            const phase = AE.MoonPhase(AE.MakeTime(new Date(a.ms)));
            const fromFullH = (((((phase - 180) + 180) % 360) + 360) % 360 - 180) / 12.19 * 24;
            const full = Math.abs(fromFullH) <= 24;
            if (!full && a !== near) continue;
            const km = fmtThousands(Math.round(a.km / 10) * 10);
            const larger = Math.round((MEAN_MOON_KM / a.km - 1) * 100), brighter = Math.round(((MEAN_MOON_KM / a.km) ** 2 - 1) * 100);
            const h = Math.round(Math.abs(fromFullH));
            const title = full ? `Perigee full Moon — a supermoon${a === near ? ` (closest of ${y})` : ''}` : `Moon at its closest for ${y}`;
            const detail = full
                ? `The Moon is ${km} km away, ${h < 1 ? 'within the hour of' : `${h} h ${fromFullH < 0 ? 'before' : 'after'}`} full: about ${larger}% larger and ${brighter}% brighter than an average full Moon`
                : `Perigee at ${km} km, the Moon’s closest approach this year (${Math.round((1 - Math.cos(phase * Math.PI / 180)) * 50)}% lit)`;
            push(ctx, {
                kind: 'lunar-apsis', bodyId: 'moon', tMs: a.ms, title, detail, select: 'moon',
                apsis: 'perigee', distKm: a.km, supermoon: full,
            });
        }
        if (far) {
            push(ctx, {
                kind: 'lunar-apsis', bodyId: 'moon', tMs: far.ms, title: `Moon at its farthest for ${y}`,
                detail: `Apogee at ${fmtThousands(Math.round(far.km / 10) * 10)} km; a full Moon now looks about 12% smaller than one at perigee`,
                select: 'moon', apsis: 'apogee', distKm: far.km, supermoon: false,
            });
        }
    }
}

/**
 * Earth crossing the plane of Saturn's rings (ring_tilt changing sign, sampled every 10 days and
 * bisected to minutes). Crossings within RING_GROUP_DAYS form one edge-on season, listed once at
 * its first crossing inside the span with every date in the detail.
 */
function ringPlaneCrossings(ctx) {
    const tilt = (ut) => AE.Illumination('Saturn', new AE.AstroTime(ut)).ring_tilt;
    const a = ctx.from.ut - RING_GROUP_DAYS, b = ctx.from.ut + (ctx.toMs - ctx.fromMs) / DAY_MS + RING_GROUP_DAYS;
    const crossings = [];
    let pu = a, pv = tilt(a);
    for (let u = a + RING_STEP_DAYS; u <= b + RING_STEP_DAYS; u += RING_STEP_DAYS) {
        const v = tilt(u);
        if ((v > 0) !== (pv > 0)) {
            let lo = pu, hi = u, lv = pv;
            for (let k = 0; k < 20; k++) {
                const mid = (lo + hi) / 2, mv = tilt(mid);
                if ((mv > 0) === (lv > 0)) { lo = mid; lv = mv; } else hi = mid;
            }
            crossings.push(msOf(new AE.AstroTime((lo + hi) / 2)));
        }
        pu = u; pv = v;
    }
    const day = dateFormatter(ctx.tz);
    const groups = [];
    for (const ms of crossings) {
        const g = groups.at(-1);
        if (g && ms - g.at(-1) < RING_GROUP_DAYS * DAY_MS) g.push(ms); else groups.push([ms]);
    }
    for (const g of groups) {
        const at = g.find((ms) => ms >= ctx.fromMs && ms <= ctx.toMs);
        if (at === undefined) continue;
        const n = g.length;
        const dates = g.map(day);
        const list = n === 1 ? dates[0] : `${dates.slice(0, -1).join(', ')} and ${dates.at(-1)}`;
        push(ctx, {
            kind: 'ring-plane', bodyId: 'saturn', tMs: at,
            title: 'Saturn’s rings edge-on',
            detail: `Earth passes through the plane of Saturn’s rings ${n === 1 ? 'on' : n === 2 ? 'twice:' : `${n} times:`} ${list}. ` +
                'For weeks around each crossing the rings shrink to a thin line or vanish in small telescopes',
            select: 'saturn', crossingsMs: g,
        });
    }
}

/** A rounded hourly count: "fewer than 1", "4", "35" (to 5 above 10). */
export function fmtMeteorRate(r) {
    if (!(r >= 0.5)) return 'fewer than 1';
    return r < 10 ? String(Math.round(r)) : String(Math.round(r / 5) * 5);
}
const meteorsAnHour = (r) => (r < 0.5 ? 'fewer than 1 meteor an hour' : r < 1.5 ? 'about 1 meteor an hour' : `about ${fmtMeteorRate(r)} meteors an hour`);
/** The Sun's highest altitude for a shower hour to count: as render/meteors.js draws them (−6°); the
 * limiting magnitude's twilight term lowers the rate between −6° and −18°. */
const SHOWER_SUN_MAX_DEG = -6;

/**
 * A meteor shower's maximum as seen from here: the hour around it (± METEOR_HALF_H) with the most
 * meteors expected, from the radiant's altitude, the shower's activity profile, twilight, the Moon
 * and (when the caller passes `skyLp`) the site's light pollution. Altitudes are geometric, from
 * the Sun's and the radiant's RA/Dec of date at maximum with the sidereal clock running.
 */
function showerEvent(ctx, s, peakMs) {
    const obs = ctx.obs;
    const tp = AE.MakeTime(new Date(peakMs));
    const sun = AE.Equator('Sun', tp, obs, true, true);
    const rj = radiantAt(s, s.peak);
    const ra0 = rj.raDeg * Math.PI / 180, de0 = rj.decDeg * Math.PI / 180;
    const vj = new AE.Vector(Math.cos(de0) * Math.cos(ra0), Math.cos(de0) * Math.sin(ra0), Math.sin(de0), tp);
    const rad = AE.EquatorFromVector(AE.RotateVector(AE.Rotation_EQJ_EQD(tp), vj));
    const gast = AE.SiderealTime(tp);
    const ill = AE.Illumination('Moon', tp);
    const lat = obs.latitude * Math.PI / 180, slat = Math.sin(lat), clat = Math.cos(lat);
    const altAz = (raH, decDeg, lstH) => {
        const H = (lstH - raH) * 15 * Math.PI / 180, d = decDeg * Math.PI / 180;
        const alt = Math.asin(Math.max(-1, Math.min(1, slat * Math.sin(d) + clat * Math.cos(d) * Math.cos(H)))) * RAD2DEG;
        const az = ((Math.atan2(-Math.cos(d) * Math.sin(H), Math.sin(d) * clat - Math.cos(d) * Math.cos(H) * slat) * RAD2DEG) + 360) % 360;
        return [alt, az];
    };
    const lp = Number.isFinite(ctx.skyLp) ? Math.max(0, ctx.skyLp) : 0;
    let best = null, everDark = false;
    for (let h = -METEOR_HALF_H; h <= METEOR_HALF_H; h += METEOR_STEP_H) {
        const lst = gast + h * 1.00273790935 + obs.longitude / 15;
        const [sunAlt] = altAz(sun.ra, sun.dec, lst);
        if (sunAlt > SHOWER_SUN_MAX_DEG) continue;
        everDark = true;
        const [radAlt, radAz] = altAz(rad.ra, rad.dec, lst);
        if (radAlt < 5) continue;
        const t = tp.AddDays(h / 24);
        const moon = horizontal('Moon', t, obs);
        const zm = 90 - moon.altitude;
        const moonZen = moon.altitude > 0 ? moonSky(zm, 0, zm, ill.phase_angle) : 0;
        const zhr = zhrAt(s, s.peak + (h / 24) * 0.98565);
        const dark = hourlyRate(zhr, radAlt, meteorLimitMag(sunAlt, (1 + moonZen) * NATURAL_NL), s.r);
        const here = hourlyRate(zhr, radAlt, meteorLimitMag(sunAlt, (1 + moonZen + lp) * NATURAL_NL), s.r);
        if (!best || here > best.here || (here === best.here && dark > best.dark)) {
            best = { ms: msOf(t), radAlt, radAz, moonAlt: moon.altitude, sunAlt, dark, here };
        }
    }
    const pct = Math.round(ill.phase_fraction * 100);
    const base = {
        id: `meteor-shower:${s.id}:${Math.round(peakMs / 60000)}`, kind: 'meteor-shower', bodyId: null, tMs: peakMs,
        title: `${s.name} meteor shower peaks (ZHR ${s.zhr})`, select: null,
        showerId: s.id, zhr: s.zhr, moonPct: pct,
    };
    const radCon = AE.Constellation(rj.raDeg / 15, rj.decDeg).name;
    if (!best) {
        // Polar and subpolar summer: the radiant may be high, but the sky never gets dark.
        const why = everDark ? 'From here it stays below the horizon while the sky is dark'
            : `The sky does not get dark here around the maximum (the Sun never sinks ${-SHOWER_SUN_MAX_DEG}° below the horizon)`;
        return {
            ...base, view: null, visibleHere: false, visibleMs: null,
            detail: `Radiant in ${radCon}. ${why}, so few if any meteors are seen. Parent: ${s.parent}`,
        };
    }
    const moonTxt = best.moonAlt > 0 ? `${pct}% lit, ${Math.round(best.moonAlt)}° up` : `${pct}% lit, below the horizon`;
    const here = lp > 0.05 && fmtMeteorRate(best.here) !== fmtMeteorRate(best.dark) ? `, ${fmtMeteorRate(best.here)} under this sky` : '';
    const rate = meteorsAnHour(best.dark);
    return {
        ...base, view: 'sky', visibleHere: true, visibleMs: best.ms,
        radiantAltDeg: best.radAlt, rateDark: best.dark, rateHere: best.here,
        look: { azDeg: best.radAz, altDeg: Math.min(best.radAlt, 55) },
        detail: `Best around ${ctx.clock(best.ms)}, radiant ${Math.round(best.radAlt)}° up in the ${compass16(best.radAz)} (in ${radCon}). ` +
            `Moon ${moonTxt}. ${cap(rate)} from a dark site${here} (illustrative)` +
            `${best.sunAlt > -12 ? `. The Sun is only ${Math.round(-best.sunAlt)}° below the horizon then: twilight hides the fainter meteors` : ''}. Parent: ${s.parent}`,
    };
}

function meteorShowers(ctx) {
    for (const { shower, peakMs } of showerPeaks(ctx.fromMs, ctx.toMs, { minZhr: EVENT_MIN_ZHR })) {
        push(ctx, showerEvent(ctx, shower, peakMs));
    }
}

const SOURCES = [
    moonPhases,
    oppositionsAndConjunctions,
    greatestElongations,
    lunarEclipses,
    globalSolarEclipses,
    localSolarEclipses,
    seasons,
    planetPairings,
    moonAppulses,
    starOccultations,
    venusBrilliancy,
    transits,
    lunarApsides,
    ringPlaneCrossings,
    meteorShowers,
];

/**
 * Astronomical events between fromMs and fromMs + days, sorted by time.
 * Every event has a unique `id`, a `title` and a `detail` sentence; `select`
 * and `view` suggest what the UI should focus when the user jumps to it.
 * Some kinds carry extra fields: `quarter` (moon-phase), `eclipseKind`,
 * `obscuration`, `visibleHere`, `geo` {latDeg, lonDeg, durS} (greatest eclipse
 * and the central duration there), `elongDeg`, `bodyIds`, `sepDeg` and
 * `occultation` (pairings). A local solar eclipse's `eclipseKind` is the
 * geometric kind at the site; its title says whether the total or annular
 * phase itself is above the horizon. Eclipse contacts (UT ms, null when the
 * phase does not occur):
 *  - local-solar-eclipse: `c1Ms c2Ms maxMs c3Ms c4Ms`, `totalDurS` (C2–C3 in s,
 *    null for a partial), `sunAltDeg` {c1, c2, max, c3, c4} (AE's refracted
 *    altitude of the Sun's centre), `centralUp` ('all' | 'sunrise' | 'sunset' |
 *    'none' | null: how much of C2–C3 has the upper limb up);
 *  - lunar-eclipse: `p1Ms u1Ms u2Ms maxMs u3Ms u4Ms p4Ms`.
 * Both carry `visibleMs`: when to look from here (maximum when the body is up
 * then, else just inside the part above the horizon; null when not visible).
 * Phase 6 kinds:
 *  - occultation: the Moon and a bright star (`star`: an OCCULTATION_STARS id,
 *    `sepDeg`, `occultation`), select 'moon', view 'sky';
 *  - brilliancy: Venus at greatest brilliancy (`mag`);
 *  - transit: Mercury or Venus across the Sun (`startMs`, `finishMs`,
 *    `sepArcmin`, `visibleHere`, `visibleMs`);
 *  - lunar-apsis: the year's closest perigee or farthest apogee, or a perigee
 *    full Moon (`apsis`, `distKm`, `supermoon`);
 *  - ring-plane: Earth crossing Saturn's ring plane (`crossingsMs`: the whole
 *    edge-on season);
 *  - meteor-shower: a shower's maximum (`showerId`, `zhr`, `moonPct`,
 *    `visibleHere`, `visibleMs`: the best hour here, `radiantAltDeg`, `rateDark`
 *    and `rateHere` per hour, `look` {azDeg, altDeg}: where to face); bodyId null.
 * Times in titles and details use `opts.tz`, else `observer.tz`, else UTC.
 * `opts.skyLp` is the site's artificial zenith light in natural-sky units
 * (skyglow `lpZenith`), for the meteor rates "under this sky".
 * Typical cost: 50–100 ms for a year, so run it in the astro worker.
 * @param {ObserverLike & {tz?:string|null}} observer
 * @param {number} fromMs
 * @param {number} [days=365] Clamped to 1..3660.
 * @param {{tz?:string, hour12?:boolean, skyLp?:number}} [opts]
 * @returns {AstroEvent[]}
 */
export function upcomingEvents(observer, fromMs, days = 365, opts = {}) {
    const obs = aeObserverOf(observer);
    if (!Number.isFinite(fromMs)) throw new TypeError('fromMs must be a finite number of milliseconds');
    const span = Number.isFinite(days) ? Math.min(3660, Math.max(1, days)) : 365;
    const tz = opts?.tz || observer?.tz || 'UTC';
    const ctx = {
        obs,
        latDeg: obs.latitude,
        fromMs,
        toMs: fromMs + span * DAY_MS,
        from: AE.MakeTime(new Date(fromMs)),
        events: [],
        daily: null,
        moonTopo: null,
        tz,
        skyLp: Number.isFinite(opts?.skyLp) ? opts.skyLp : 0,
        clock: clockFormatter(tz, !!opts?.hour12, false),
        clockS: clockFormatter(tz, !!opts?.hour12, true),
    };
    for (const source of SOURCES) {
        try {
            source(ctx);
        } catch {
            // A rare astronomy-engine search failure only drops that one source.
        }
    }
    ctx.events.sort((a, b) => a.tMs - b.tMs);
    const seen = new Set();
    return ctx.events.filter((ev) => {
        if (seen.has(ev.id)) return false;
        seen.add(ev.id);
        return true;
    });
}

/**
 * The local-solar-eclipse event (as in upcomingEvents) of the solar eclipse whose maximum here
 * falls within a day of `nearMs`, or null when it is not seen from this observer. One
 * AE.SearchLocalSolarEclipse (≈ 1.4 ms), so it is fine on the main thread, e.g. after moving the
 * observer into the path of totality.
 * @param {ObserverLike & {tz?:string|null}} observer
 * @param {number} nearMs
 * @param {{tz?:string, hour12?:boolean}} [opts]
 * @returns {AstroEvent|null}
 */
export function localSolarEclipseAt(observer, nearMs, opts = {}) {
    const obs = aeObserverOf(observer);
    if (!Number.isFinite(nearMs)) throw new TypeError('nearMs must be a finite number of milliseconds');
    const tz = opts?.tz || observer?.tz || 'UTC';
    const ls = AE.SearchLocalSolarEclipse(AE.MakeTime(new Date(nearMs - DAY_MS)), obs);
    if (Math.abs(msOf(ls.peak.time) - nearMs) > DAY_MS) return null;
    const ev = localSolarEvent(ls, obs, clockFormatter(tz, !!opts?.hour12, false), clockFormatter(tz, !!opts?.hour12, true));
    return ev && { id: `${ev.kind}:sun:${Math.round(ev.tMs / 60000)}`, ...ev };
}
