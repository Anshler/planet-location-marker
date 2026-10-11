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
 * Note on SearchRelativeLongitude: per astronomy-engine, a relative longitude
 * of 0° is the opposition of an outer planet (or the inferior conjunction of
 * Mercury/Venus) and 180° is a conjunction with the Sun (superior conjunction).
 *
 * @module astro/events
 */
import { AE } from './ae.js';
import { bodyById, AU_KM } from './bodies.js';
import { aeObserverOf, compass16 } from './almanac.js';

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
    return {
        kind: 'opposition',
        title: `${b.name} at opposition`,
        detail: `Closest and brightest for the year: mag ${fmtMag(ill.mag)}, ${ill.geo_dist.toFixed(2)} AU away, ` +
            `up all night in ${constellationOf(ill.gc)}`,
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

function lunarEclipses(ctx) {
    let le = AE.SearchLunarEclipse(ctx.from);
    for (let i = 0; i < GUARD && msOf(le.peak) <= ctx.toMs; i++) {
        const alt = horizontal('Moon', le.peak, ctx.obs).altitude;
        const visible = alt > 0;
        let detail = visible
            ? `Visible from here: the Moon is ${Math.round(alt)}° up at mid-eclipse`
            : 'Not visible from here: the Moon is below the horizon at mid-eclipse';
        if (le.kind === 'total') detail += `; totality lasts ${Math.round(2 * le.sd_total)} min`;
        else if (le.kind === 'partial') detail += `; partial phase lasts ${Math.round(2 * le.sd_partial)} min`;
        else detail += '; only a subtle shading of the Moon';
        push(ctx, {
            kind: 'lunar-eclipse', bodyId: 'moon', tMs: msOf(le.peak), title: `${cap(le.kind)} lunar eclipse`, detail,
            select: 'moon', view: visible ? 'sky' : 'orbit',
            eclipseKind: le.kind, obscuration: le.obscuration, visibleHere: visible,
        });
        le = AE.NextLunarEclipse(le.peak);
    }
}

function globalSolarEclipses(ctx) {
    let ge = AE.SearchGlobalSolarEclipse(ctx.from);
    for (let i = 0; i < GUARD && msOf(ge.peak) <= ctx.toMs; i++) {
        const hasCentre = Number.isFinite(ge.latitude) && Number.isFinite(ge.longitude);
        const title = hasCentre
            ? `${cap(ge.kind)} solar eclipse — greatest at ${fmtLat(ge.latitude)}, ${fmtLon(ge.longitude)}`
            : `${cap(ge.kind)} solar eclipse`;
        let detail = 'Only the Moon’s penumbra touches Earth, so it is partial everywhere';
        if (ge.kind === 'total') detail = 'The Moon’s dark umbra sweeps a narrow track of totality across Earth';
        else if (ge.kind === 'annular') detail = 'A “ring of fire” along a narrow track where the Moon is too far to cover the Sun';
        push(ctx, {
            kind: 'solar-eclipse', bodyId: 'sun', tMs: msOf(ge.peak), title, detail, select: 'sun', view: 'orbit',
            eclipseKind: ge.kind, geo: hasCentre ? { latDeg: ge.latitude, lonDeg: ge.longitude } : null,
        });
        ge = AE.NextGlobalSolarEclipse(ge.peak);
    }
}

function localEclipseTitle(ls) {
    const pct = ls.obscuration * 100;
    // A partial eclipse never shows 100 %, however close it comes.
    const shown = ls.kind === 'partial' ? Math.min(99, Math.round(pct)) : Math.round(pct);
    const covered = pct < 1 ? '<1% covered' : `${shown}% covered`;
    if (ls.kind === 'total') return 'Total solar eclipse visible here';
    if (ls.kind === 'annular') return `Annular solar eclipse visible here (${covered})`;
    return `Partial solar eclipse visible here (${covered})`;
}

function localSolarEclipses(ctx) {
    let ls = AE.SearchLocalSolarEclipse(ctx.from, ctx.obs);
    for (let i = 0; i < GUARD && msOf(ls.peak.time) <= ctx.toMs; i++) {
        if (ls.obscuration > 0) {
            const alt = ls.peak.altitude;
            const where = alt > 0
                ? `The Sun is ${Math.round(alt)}° up at maximum.`
                : 'Maximum comes with the Sun below the horizon; only part of it is visible.';
            push(ctx, {
                kind: 'local-solar-eclipse', bodyId: 'sun', tMs: msOf(ls.peak.time), title: localEclipseTitle(ls),
                detail: `${where} Never look at the Sun without certified eclipse glasses.`,
                select: 'sun', view: 'sky', eclipseKind: ls.kind, obscuration: ls.obscuration,
            });
        }
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

function moonAppulses(ctx) {
    const { t0, n, dirs } = dailyDirections(ctx);
    const obs = ctx.obs;
    const m = Math.floor((n - 1) / MOON_STEP_DAYS) + 1;
    const moon = new Float64Array(3 * m);
    for (let k = 0; k < m; k++) moon.set(topoDir('Moon', t0 + k * MOON_STEP_DAYS, obs), 3 * k);
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
];

/**
 * Astronomical events between fromMs and fromMs + days, sorted by time.
 * Every event has a unique `id`, a `title` and a `detail` sentence; `select`
 * and `view` suggest what the UI should focus when the user jumps to it.
 * Some kinds carry extra fields: `quarter` (moon-phase), `eclipseKind`,
 * `obscuration`, `visibleHere`, `geo` {latDeg, lonDeg} (greatest eclipse),
 * `elongDeg`, `bodyIds`, `sepDeg` and `occultation` (pairings).
 * Typical cost: 50–100 ms for a year, so run it in the astro worker.
 * @param {ObserverLike} observer
 * @param {number} fromMs
 * @param {number} [days=365] Clamped to 1..3660.
 * @returns {AstroEvent[]}
 */
export function upcomingEvents(observer, fromMs, days = 365) {
    const obs = aeObserverOf(observer);
    if (!Number.isFinite(fromMs)) throw new TypeError('fromMs must be a finite number of milliseconds');
    const span = Number.isFinite(days) ? Math.min(3660, Math.max(1, days)) : 365;
    const ctx = {
        obs,
        latDeg: obs.latitude,
        fromMs,
        toMs: fromMs + span * DAY_MS,
        from: AE.MakeTime(new Date(fromMs)),
        events: [],
        daily: null,
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
