// Label anchors for the DOM label pool (SPEC §C.6 labels.js, §C.9 labels-feed.js).
//
// buildAnchors() turns app state + the live snapshot + the star catalog into LabelAnchor objects.
// Anchors hold LIVE vector references (snapshot arrays, the beams module's anchor points, or the
// feed's own scratch vectors), so the label pool re-projects them every rendered frame without the
// list being rebuilt. The list is rebuilt only when something structural changes: selection,
// layers, observer name, view mode, catalog, trails, or an intro reveal.
//
// Placement rules:
//   - Bodies: when the beams module offers `labelAnchor(id)` (G6), each body label uses that live
//     world point: the farthest on-screen, unoccluded point of its beam in orbit view, a point at
//     infinity in sky view, NaN (hidden) until the beam has landed — so labels appear one by one as
//     the launch completes. Without it, a body label rides its beam a fixed fraction of the camera
//     distance out from the pin in orbit view (a body below the horizon is labelled where its x-ray
//     beam leaves the far side of the Earth), and sits at infinity (`dirS`) in sky view, its dot
//     on the upper-right diagonal just outside the glyph, disc or reticle (bodyLabelOffsets).
//   - Bright stars, constellations and (sky view) the four cardinal points sit at infinity.
//   - Orbit view with the horizon layer: N/E/S/W letters ride the rim of the pin's horizon disc
//     (the pin module's live `cardinals`), hidden when the camera is too far out to fit them.
//
// Per-frame flags (sync): a body's `below` (labelBelow); star and constellation names' `hidden` and
// `faint`, which follow the drawn star field, so names leave with their stars at dawn and return at
// dusk or in totality.
//
// Priorities follow SPEC §C.6: selected 100, Sun/Moon 90, planets 80, observer 70, cardinal 60,
// stars 50 − mag, constellations 20.

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { starVisibility } from '../astro/photometry.js';
import { horizonAltDeg } from '../geo/horizon.js';
import { eqAngRadius, RING_OUTER, SCOPE_FROM_PX } from '../astro/disc.js';

/** @typedef {import('../core/types.js').LabelAnchor} LabelAnchor */
/** @typedef {import('../core/types.js').AppState} AppState */
/** @typedef {import('../core/types.js').Snapshot} Snapshot */
/** @typedef {{bodyOrbit:Float64Array[], pinHead:Float64Array, cardinal:Float64Array[], rim:Float64Array[]}} LiveVectors */
/** sync() inputs: star-field exposure (photometry.starExposure), tier magnitude limit, viewport CSS height,
 * and the shared landscape profile (geo/horizon.js; sky-view `below` flags follow its silhouette).
 * @typedef {{starExposure?:number, magLimit?:number, viewportH?:number,
 *   horizon?:import('../geo/horizon.js').HorizonProfile|null}} LabelView */

export const PRIORITY = Object.freeze({ selected: 100, sunMoon: 90, planet: 80, observer: 70, cardinal: 60, starBase: 50, constellation: 20 });
/** Star names shown in sky view (SPEC: mag ≤ 2.5) and, more sparingly, around the globe. */
export const STAR_NAME_MAG_SKY = 2.5;
export const STAR_NAME_MAG_ORBIT = 1.0;
/** Fallback orbit-view body label distance along its beam, as a fraction of the camera distance. */
const ORBIT_LABEL_K = 0.24;
const ORBIT_LABEL_MIN = 0.35;
const ORBIT_LABEL_MAX = 40;
/** Pin head height above the surface (spike 0.05 + head 0.012, SPEC §C.6 pin.js). */
const PIN_HEAD_R = 1.065;
/** Cardinal letters sit just above the horizon line so the ground never swallows them. */
const CARDINAL_LIFT_RAD = 1.2 * Math.PI / 180;
/** Orbit-view rim letters only while the horizon disc is big enough on screen to carry them. */
const RIM_LABEL_MAX_DIST = 6;
const CARDINALS = Object.freeze([
    { id: 'card:N', text: 'N', az: 0, aria: 'North', color: '#ff7a6b' },
    { id: 'card:E', text: 'E', az: 90, aria: 'East', color: '#e8edf6' },
    { id: 'card:S', text: 'S', az: 180, aria: 'South', color: '#e8edf6' },
    { id: 'card:W', text: 'W', az: 270, aria: 'West', color: '#e8edf6' },
]);
const STAR_COLOR = '#cdd6e4';
const CONSTELLATION_COLOR = '#8fa6cc';
const OBSERVER_COLOR = '#7cc4ff';
/** Small screen offset so a star's or planet's own glyph is not covered by the label dot. */
const GLYPH_OFFSET = Object.freeze([7, -7]);
// Sky-view body label radius (CSS px): the dot (3 px, +4 px ring when selected) clears the glyph,
// disc or reticle by 3 px, and never comes closer than GLYPH_OFFSET (≈ 10 px).
const LABEL_CLEAR_PX = 6;
const LABEL_CLEAR_SEL_PX = 10;
const LABEL_MIN_R = 10;
// Mirrors render/bodies.js (CSS px): reticle radius, or disc + gap for the Sun and Moon; 3-px Sun core.
const RETICLE_PX = 14;
const RETICLE_GAP_PX = 7;
const SUN_MIN_CORE_PX = 3;
const ARCSEC_RAD = Math.PI / (180 * 3600);
const SUN = BODY_INDEX.sun;
const MOON = BODY_INDEX.moon;
// Daylight: a star name shows while its star is drawn at least this visible (starVisibility,
// with hysteresis between SHOW and HIDE) and is dimmed below FAINT; constellation names go by the
// star-field exposure and need a darker sky.
const STAR_NAME_SHOW = 0.2;
const STAR_NAME_HIDE = 0.06;
const STAR_NAME_FAINT = 0.6;
const CON_NAME_SHOW = 0.35;
const CON_NAME_HIDE = 0.25;
const CON_NAME_FAINT = 0.55;
const DEFAULT_MAG_LIMIT = 6.0;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const glyphSizePx = (mag) => clamp(3.0 + (1.5 - mag) * 1.4, 3, 12);
/** NaN-safe "is below the horizon". */
const isBelow = (altDeg) => !(Number.isFinite(altDeg) && altDeg >= 0);

/**
 * A body label's below-the-horizon flag: the Sky panel's refraction- and limb-aware `above`, in
 * both views (sky view draws bodies refracted, so a setting Sun sits on the horizon exactly while
 * `above` holds). In sky view with the illustrative landscape on, the horizon is the silhouette:
 * the body's apparent altitude (plus the Sun's or Moon's semi-diameter) against the profile at its
 * azimuth, the same test the ground shader, picking and the flare use.
 * @param {{id?:string, above?:boolean, altDeg?:number, azDeg?:number, altGeomDeg?:number, angDiamArcsec?:number}|null|undefined} st BodyState
 * @param {boolean} sky
 * @param {import('../geo/horizon.js').HorizonProfile|null} [horizon] the shared landscape profile
 * @returns {boolean}
 */
export function labelBelow(st, sky, horizon = null) {
    if (!st) return true;
    if (typeof st.above !== 'boolean') return isBelow(st.altGeomDeg);
    if (!sky || !horizon || !horizon.enabled || !Number.isFinite(st.altDeg)) return !st.above;
    const hAlt = horizonAltDeg(horizon, st.azDeg);
    if (!(hAlt > 0)) return !st.above;
    const semi = (st.id === 'sun' || st.id === 'moon') && Number.isFinite(st.angDiamArcsec) ? st.angDiamArcsec / 7200 : 0;
    return !(st.altDeg + semi > hAlt);
}

/** Body anchors (one per BODIES entry that is not hidden). */
function bodyAnchors(out, state, snap, sky, live, opts) {
    const sel = state.selection ?? null;
    for (let i = 0; i < BODIES.length; i++) {
        const b = BODIES[i];
        if (opts.hideBody?.(b.id)) continue;
        const st = snap.bodies[i];
        const selected = sel === b.id;
        const base = b.kind === 'planet' ? PRIORITY.planet : PRIORITY.sunMoon;
        /** @type {LabelAnchor & Record<string, any>} */
        const a = {
            id: b.id,
            text: b.name,
            kind: 'body',
            priority: selected ? PRIORITY.selected : base,
            color: b.color,
            ariaLabel: `${b.name} — show details`,
            interactive: true,
            bodyId: b.id,
            selected,
            below: labelBelow(st, sky),
        };
        // Orbit view: the planet's medallion (render/planets.js) sits on the label's dot.
        let med = null;
        try {
            med = !sky && opts.medallion ? opts.medallion(b.id, selected) : null;
        } catch {
            med = null;
        }
        if (med) {
            a.med = med;
            a.title = `${b.name}, magnified (not to scale)`;
            a.ariaLabel = `${b.name}, shown magnified — show details`;
        }
        let point = null;
        try {
            point = opts.bodyPoint ? opts.bodyPoint(b.id) : null;
        } catch {
            point = null;
        }
        const offset = (sky && opts.bodyOffset?.[i]) || GLYPH_OFFSET;
        if (point && point.length >= 3) {
            a.posS = point;
            if (sky) a.offsetPx = offset;
        } else if (sky || !live) {
            a.dirS = st.dirS;
            a.offsetPx = offset;
        } else {
            a.posS = live.bodyOrbit[i];
        }
        out.push(a);
    }
}

function observerAnchor(out, state, live) {
    const name = state.observer?.name || 'Your location';
    out.push({
        id: 'observer',
        text: name,
        kind: 'observer',
        priority: PRIORITY.observer,
        color: OBSERVER_COLOR,
        posS: live.pinHead,
        ariaLabel: `Your location: ${name}. Change location`,
        interactive: true,
    });
}

/** Sky view: directions at infinity. Orbit view (`rim`): world points on the horizon disc rim. */
function cardinalAnchors(out, live, rim) {
    CARDINALS.forEach((c, k) => {
        /** @type {LabelAnchor} */
        const a = {
            id: c.id,
            text: c.text,
            kind: 'cardinal',
            priority: PRIORITY.cardinal,
            color: c.color,
            ariaLabel: c.aria,
            interactive: false,
        };
        if (rim) a.posS = live.rim[k];
        else a.dirS = live.cardinal[k];
        out.push(a);
    });
}

function starAnchors(out, catalog, sky) {
    const limit = sky ? STAR_NAME_MAG_SKY : STAR_NAME_MAG_ORBIT;
    for (const s of catalog.starNames ?? []) {
        if (!s?.name || !s.dirS || !(s.mag <= limit)) continue;
        out.push({
            id: `star:${s.hip}`,
            text: s.name,
            kind: 'star',
            priority: PRIORITY.starBase - s.mag,
            color: STAR_COLOR,
            dirS: s.dirS,
            offsetPx: GLYPH_OFFSET,
            ariaLabel: s.name,
            interactive: false,
            mag: s.mag,
            hidden: false,
            faint: false,
        });
    }
}

function constellationAnchors(out, catalog) {
    for (const c of catalog.cons?.list ?? []) {
        if (!c?.labelDirS || !c.name) continue;
        out.push({
            id: `con:${c.id}`,
            text: c.name,
            kind: 'constellation',
            // A whisker of rank ordering so prominent figures win ties in the declutter.
            priority: PRIORITY.constellation - 0.25 * ((c.rank ?? 2) - 1),
            color: CONSTELLATION_COLOR,
            dirS: c.labelDirS,
            ariaLabel: c.name,
            interactive: false,
            hidden: false,
            faint: false,
        });
    }
}

/**
 * Daylight gating of a star name (sets `a.hidden`, `a.faint`) by how visible its star is drawn.
 * @param {{mag:number, hidden?:boolean, faint?:boolean}} a star anchor
 * @param {number} e star-field exposure (photometry.starExposure)
 * @param {number} magLimit the tier's limiting magnitude
 */
export function gateStarName(a, e, magLimit) {
    const v = starVisibility(a.mag, e, magLimit);
    a.hidden = a.hidden === true ? v < STAR_NAME_SHOW : v < STAR_NAME_HIDE;
    a.faint = v < STAR_NAME_FAINT;
}

/**
 * Daylight gating of a constellation name (sets `a.hidden`, `a.faint`) by star-field exposure.
 * @param {{hidden?:boolean, faint?:boolean}} a constellation anchor
 * @param {number} e star-field exposure (photometry.starExposure)
 */
export function gateConstellationName(a, e) {
    a.hidden = a.hidden === true ? !(e >= CON_NAME_SHOW) : !(e >= CON_NAME_HIDE);
    a.faint = !(e >= CON_NAME_FAINT);
}

/**
 * Sky-view label offsets per body (CSS px, upper-right diagonal, where the reticle ring has its
 * gaps): the dot clears the glyph or disc, and the reticle of the selected body. In a solar
 * eclipse the Sun's label clears the larger disc, as the reticle does. No allocation.
 * @param {Snapshot} snap
 * @param {number} pxPerRad CSS px per radian at the view centre (0.5 · viewport height · P[5])
 * @param {number} selIndex selected BODIES index, or −1
 * @param {Float64Array[]} offsets one Float64Array(2) per body (written)
 */
export function bodyLabelOffsets(snap, pxPerRad, selIndex, offsets) {
    const k = Number.isFinite(pxPerRad) && pxPerRad > 0 ? pxPerRad : 0;
    const sun = snap.bodies[SUN], moon = snap.bodies[MOON];
    const sunR = 0.5 * (sun.angDiamArcsec || 0) * ARCSEC_RAD * k;
    const moonR = 0.5 * (moon.angDiamArcsec || 0) * ARCSEC_RAD * k;
    const a = sun.dirS, b = moon.dirS;
    const sep = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) * k;
    // The Moon over the Sun: the larger disc frames both (render/bodies.js does the same).
    const sunDisc = sep < sunR + moonR ? Math.max(sunR, moonR) : sunR;
    for (let i = 0; i < BODIES.length; i++) {
        let disc, ring = RETICLE_PX;
        if (i === SUN) {
            ring = Math.max(RETICLE_PX, sunDisc + RETICLE_GAP_PX);
            disc = Math.max(sunDisc, SUN_MIN_CORE_PX);
        } else if (i === MOON) {
            ring = Math.max(RETICLE_PX, moonR + RETICLE_GAP_PX);
            disc = moonR;
        } else {
            const m = snap.bodies[i].mag;
            // At telescope zoom the true disc (Saturn: its rings) outgrows the glyph.
            const b = snap.bodies[i];
            const trueR = eqAngRadius(b.id, b.distAU) * (b.id === 'saturn' ? RING_OUTER : 1) * k;
            disc = Math.max(0.5 * glyphSizePx(Number.isFinite(m) ? m : 6), trueR);
            if (trueR > SCOPE_FROM_PX) ring = Math.max(RETICLE_PX, trueR + RETICLE_GAP_PX);
        }
        const r = i === selIndex
            ? Math.max(LABEL_MIN_R, disc + LABEL_CLEAR_SEL_PX, ring + LABEL_CLEAR_SEL_PX)
            : Math.max(LABEL_MIN_R, disc + LABEL_CLEAR_PX);
        const o = offsets[i];
        o[0] = r * Math.SQRT1_2;
        o[1] = -r * Math.SQRT1_2;
    }
}

function trailAnchors(out, trails) {
    if (!trails || typeof trails.anchors !== 'function') return;
    let extra = [];
    try {
        extra = trails.anchors() ?? [];
    } catch {
        extra = [];
    }
    for (const a of extra) if (a?.id) out.push(a);
}

/**
 * Builds the label anchor list.
 *
 * @param {AppState} state
 * @param {Snapshot} snap  live snapshot (its typed arrays are referenced, not copied)
 * @param {object|null} catalog  decoded sky catalog ({starNames, cons}) or null
 * @param {{anchors?:()=>LabelAnchor[]}|null} trails  trails module (its anchors are appended)
 * @param {{mode?:'orbit'|'sky', live?:LiveVectors, bodyPoint?:(id:string)=>Float64Array|null,
 *          bodyOffset?:Float64Array[], hideBody?:(id:string)=>boolean, hideObserver?:boolean,
 *          rimCardinals?:boolean, medallion?:((id:string, selected:boolean)=>number[]|null)|null}} [opts]
 *   `medallion` (render/planets.js footprint): orbit-view body labels get `med` (their dot becomes
 *   the medallion's eyepiece ring) and a 'magnified' title.
 *   `mode` defaults to state.view.mode. `bodyPoint` (the beams module's `labelAnchor`) supplies a
 *   live world point per body; `bodyOffset`, live sky-view offsets per BODIES index (else [7, −7]).
 *   `live` supplies the fallback
 *   orbit-view world points and the observer/cardinal vectors (see createLabelsFeed); without it
 *   those anchors are omitted and bodies sit at their at-infinity direction. `rimCardinals` adds
 *   the orbit-view N/E/S/W letters on the horizon disc (only when the horizon layer is on).
 * @returns {LabelAnchor[]}
 */
export function buildAnchors(state, snap, catalog, trails, opts = {}) {
    /** @type {LabelAnchor[]} */
    const out = [];
    const layers = state?.layers ?? {};
    if (!state || !snap || layers.labels === false) return out;
    const mode = opts.mode ?? state.view?.mode ?? 'orbit';
    const sky = mode === 'sky';
    const live = opts.live ?? null;

    bodyAnchors(out, state, snap, sky, live, opts);
    if (live && !sky && !opts.hideObserver) observerAnchor(out, state, live);
    if (live && sky) cardinalAnchors(out, live, false);
    if (live && !sky && opts.rimCardinals && layers.horizon !== false && !opts.hideObserver) cardinalAnchors(out, live, true);
    if (catalog && layers.stars !== false && layers.starNames) starAnchors(out, catalog, sky);
    if (catalog && layers.constellationNames) constellationAnchors(out, catalog);
    if (layers.trails) trailAnchors(out, trails);
    return out;
}

/** Fallback orbit-view body points: along each beam, or past the far side when below the horizon. */
function syncOrbitPoints(live, snap, camera) {
    const o = snap.observer;
    const p = o.posS, up = o.upS;
    const cp = camera.position;
    const camDist = Math.hypot(cp.x, cp.y, cp.z);
    const base = clamp(ORBIT_LABEL_K * camDist, ORBIT_LABEL_MIN, ORBIT_LABEL_MAX);
    const farSide = clamp(0.12 * camDist, 0.2, 8);
    for (let i = 0; i < BODIES.length; i++) {
        const st = snap.bodies[i];
        const d = st.dirS;
        const du = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
        // A ray from a point on the unit sphere re-exits after a chord of −2·(d·up).
        let L = du >= 0 ? base : -2 * du + farSide;
        if (i === BODY_INDEX.moon && st.distER - 1.2 > 0.5) L = Math.min(L, st.distER - 1.2);
        const out = live.bodyOrbit[i];
        out[0] = p[0] + d[0] * L;
        out[1] = p[1] + d[1] * L;
        out[2] = p[2] + d[2] * L;
    }
}

function syncPinHead(live, snap) {
    const p = snap.observer.posS;
    live.pinHead[0] = p[0] * PIN_HEAD_R;
    live.pinHead[1] = p[1] * PIN_HEAD_R;
    live.pinHead[2] = p[2] * PIN_HEAD_R;
}

/** Copies the pin's live rim points, or hides them (NaN) when the camera is too far out. */
function syncRim(live, pin, camera) {
    const c = pin?.cardinals;
    const cp = camera.position;
    const far = Math.hypot(cp.x, cp.y, cp.z) > RIM_LABEL_MAX_DIST;
    for (let k = 0; k < CARDINALS.length; k++) {
        const src = c ? c[CARDINALS[k].text] : null;
        const out = live.rim[k];
        if (!src || far) {
            out[0] = out[1] = out[2] = NaN;
        } else {
            out[0] = src[0];
            out[1] = src[1];
            out[2] = src[2];
        }
    }
}

function syncCardinals(live, snap) {
    const o = snap.observer;
    const n = o.northS, e = o.eastS, up = o.upS;
    const cl = Math.cos(CARDINAL_LIFT_RAD), sl = Math.sin(CARDINAL_LIFT_RAD);
    for (let k = 0; k < CARDINALS.length; k++) {
        const az = CARDINALS[k].az * Math.PI / 180;
        const ca = Math.cos(az), sa = Math.sin(az);
        const out = live.cardinal[k];
        out[0] = cl * (ca * n[0] + sa * e[0]) + sl * up[0];
        out[1] = cl * (ca * n[1] + sa * e[1]) + sl * up[1];
        out[2] = cl * (ca * n[2] + sa * e[2]) + sl * up[2];
    }
}

/**
 * Keeps the label pool fed: rebuilds anchors when the inputs change and refreshes the live
 * world-space anchor points once per rendered frame (no allocation on that path).
 *
 * @param {{labels:{setAnchors:(list:LabelAnchor[])=>void}, store:any, snap:Snapshot,
 *          getCatalog?:()=>object|null, getTrails?:()=>object|null, getBeams?:()=>object|null,
 *          getPin?:()=>object|null}} deps
 */
export function createLabelsFeed({ labels, store, snap, getCatalog = () => null, getTrails = () => null, getBeams = () => null,
    getPin = () => null, getPlanets = () => null }) {
    /** @type {LiveVectors} */
    const live = {
        bodyOrbit: BODIES.map(() => new Float64Array(3)),
        pinHead: new Float64Array(3),
        cardinal: CARDINALS.map(() => new Float64Array(3)),
        rim: CARDINALS.map(() => new Float64Array([NaN, NaN, NaN])),
    };
    /** Live sky-view label offsets per BODIES index (bodyLabelOffsets), shared by every rebuild. */
    const bodyOffset = BODIES.map(() => new Float64Array(GLYPH_OFFSET));
    /** @type {LabelAnchor[]} */
    let anchors = [];
    /** Body anchors by BODIES index (null when not shown), for the per-frame `below` flag. */
    const bodyAnchor = new Array(BODIES.length).fill(null);
    let selIndex = -1;
    /** @type {Array<LabelAnchor & Record<string, any>>} star and constellation anchors (daylight gating) */
    let nameAnchors = [];
    /** Ids of names hidden by daylight, so a rebuild keeps their hysteresis state. */
    const hiddenNames = new Set();
    let dirty = true;
    /** @type {'orbit'|'sky'|null} */
    let builtMode = null;
    let usesBeamPoints = false;

    // Intro choreography. With the beams' own anchors, labels already wait for their beam to land;
    // the per-body gating below is the fallback when that API is missing.
    let introHiding = false;
    let observerHidden = false;
    const revealed = new Set();

    const offs = [
        store.subscribe((s) => s.selection, () => { dirty = true; }),
        store.subscribe((s) => s.layers, () => { dirty = true; }),
        store.subscribe((s) => s.observer.name, () => { dirty = true; }),
    ];

    function beamPointFn() {
        const beams = getBeams();
        return beams && typeof beams.labelAnchor === 'function' ? (id) => beams.labelAnchor(id) : null;
    }

    function rebuild(mode) {
        const bodyPoint = beamPointFn();
        usesBeamPoints = !!bodyPoint;
        const planets = getPlanets();
        anchors = buildAnchors(store.get(), snap, getCatalog(), getTrails(), {
            mode,
            live,
            bodyPoint,
            medallion: bodyPoint && planets && planets.enabled && typeof planets.footprint === 'function'
                ? (id, sel) => planets.footprint(id, sel) : null,
            bodyOffset,
            hideBody: (id) => introHiding && !usesBeamPoints && !revealed.has(id),
            hideObserver: observerHidden,
            rimCardinals: !!getPin()?.cardinals,
        });
        bodyAnchor.fill(null);
        selIndex = -1;
        nameAnchors = [];
        for (const a of anchors) {
            if (a.kind === 'body' && Object.hasOwn(BODY_INDEX, a.id)) {
                bodyAnchor[BODY_INDEX[a.id]] = a;
                if (a.selected) selIndex = BODY_INDEX[a.id];
            } else if (a.kind === 'star' || a.kind === 'constellation') {
                a.hidden = hiddenNames.has(a.id);
                nameAnchors.push(a);
            }
        }
        labels.setAnchors(anchors);
        builtMode = mode;
        dirty = false;
    }

    /** Daylight gating of star and constellation names. No allocation. */
    function syncNames(view) {
        const e = view && Number.isFinite(view.starExposure) ? view.starExposure : 1;
        const lim = view && Number.isFinite(view.magLimit) ? view.magLimit : DEFAULT_MAG_LIMIT;
        for (let k = 0; k < nameAnchors.length; k++) {
            const a = nameAnchors[k];
            const was = a.hidden === true;
            if (a.kind === 'star') gateStarName(a, e, lim);
            else gateConstellationName(a, e);
            if (a.hidden !== was) {
                if (a.hidden) hiddenNames.add(a.id);
                else hiddenNames.delete(a.id);
            }
        }
    }

    /**
     * Per-frame refresh. Call before `labels.update()` on every rendered frame.
     * @param {{position:{x:number,y:number,z:number}, projectionMatrix?:{elements:ArrayLike<number>}}} camera
     * @param {'orbit'|'sky'} mode effective view mode (sky once the transition is past halfway)
     * @param {LabelView} [view]
     */
    function sync(camera, mode, view) {
        if (dirty || mode !== builtMode) rebuild(mode);
        const sky = mode !== 'orbit';
        if (!sky) {
            if (!usesBeamPoints) syncOrbitPoints(live, snap, camera);
            syncPinHead(live, snap);
            syncRim(live, getPin(), camera);
        } else {
            syncCardinals(live, snap);
            const pm = camera?.projectionMatrix?.elements;
            const h = view && view.viewportH > 0 ? view.viewportH : 0;
            bodyLabelOffsets(snap, pm && h ? 0.5 * h * pm[5] : 0, selIndex, bodyOffset);
        }
        for (let i = 0; i < BODIES.length; i++) {
            const a = bodyAnchor[i];
            if (a) a.below = labelBelow(snap.bodies[i], sky, view && view.horizon);
        }
        syncNames(view);
    }

    return {
        sync,
        /** Forces a rebuild on the next rendered frame (catalog arrived, trails changed, …). */
        markDirty() { dirty = true; },
        /** Hides the observer label (and, without beam anchors, body labels) until revealed. */
        beginIntro() {
            introHiding = true;
            observerHidden = true;
            revealed.clear();
            dirty = true;
        },
        /** @param {string} id */
        revealBody(id) {
            if (!introHiding || revealed.has(id)) return;
            revealed.add(id);
            if (!usesBeamPoints) dirty = true;
        },
        revealObserver() {
            if (!observerHidden) return;
            observerHidden = false;
            dirty = true;
        },
        /** Ends the intro choreography: everything visible again. */
        endIntro() {
            if (!introHiding && !observerHidden) return;
            introHiding = false;
            observerHidden = false;
            revealed.clear();
            dirty = true;
        },
        /** @param {string} id @returns {LabelAnchor|null} */
        anchorById(id) {
            return anchors.find((a) => a.id === id) ?? null;
        },
        get anchors() { return anchors; },
        dispose() {
            for (const off of offs) off();
        },
    };
}
