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
//     beam leaves the far side of the Earth), and sits at infinity (`dirS`) in sky view.
//   - Bright stars, constellations and (sky view) the four cardinal points sit at infinity.
//   - Orbit view with the horizon layer: N/E/S/W letters ride the rim of the pin's horizon disc
//     (the pin module's live `cardinals`), hidden when the camera is too far out to fit them.
//
// Priorities follow SPEC §C.6: selected 100, Sun/Moon 90, planets 80, observer 70, cardinal 60,
// stars 50 − mag, constellations 20.

import { BODIES, BODY_INDEX } from '../astro/bodies.js';

/** @typedef {import('../core/types.js').LabelAnchor} LabelAnchor */
/** @typedef {import('../core/types.js').AppState} AppState */
/** @typedef {import('../core/types.js').Snapshot} Snapshot */
/** @typedef {{bodyOrbit:Float64Array[], pinHead:Float64Array, cardinal:Float64Array[], rim:Float64Array[]}} LiveVectors */

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

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
/** NaN-safe "is below the horizon". */
const isBelow = (altDeg) => !(Number.isFinite(altDeg) && altDeg >= 0);

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
            below: isBelow(st?.altGeomDeg),
        };
        let point = null;
        try {
            point = opts.bodyPoint ? opts.bodyPoint(b.id) : null;
        } catch {
            point = null;
        }
        if (point && point.length >= 3) {
            a.posS = point;
            if (sky) a.offsetPx = GLYPH_OFFSET;
        } else if (sky || !live) {
            a.dirS = st.dirS;
            a.offsetPx = GLYPH_OFFSET;
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
        });
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
 *          hideBody?:(id:string)=>boolean, hideObserver?:boolean, rimCardinals?:boolean}} [opts]
 *   `mode` defaults to state.view.mode. `bodyPoint` (the beams module's `labelAnchor`) supplies a
 *   live world point per body. `live` supplies the fallback orbit-view world points and the
 *   observer/cardinal vectors (see createLabelsFeed); without it those anchors are omitted and
 *   bodies sit at their at-infinity direction. `rimCardinals` adds the orbit-view N/E/S/W letters
 *   on the horizon disc (only when the horizon layer is on).
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
    getPin = () => null }) {
    /** @type {LiveVectors} */
    const live = {
        bodyOrbit: BODIES.map(() => new Float64Array(3)),
        pinHead: new Float64Array(3),
        cardinal: CARDINALS.map(() => new Float64Array(3)),
        rim: CARDINALS.map(() => new Float64Array([NaN, NaN, NaN])),
    };
    /** @type {LabelAnchor[]} */
    let anchors = [];
    /** Body anchors by BODIES index (null when not shown), for the per-frame `below` flag. */
    const bodyAnchor = new Array(BODIES.length).fill(null);
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
        anchors = buildAnchors(store.get(), snap, getCatalog(), getTrails(), {
            mode,
            live,
            bodyPoint,
            hideBody: (id) => introHiding && !usesBeamPoints && !revealed.has(id),
            hideObserver: observerHidden,
            rimCardinals: !!getPin()?.cardinals,
        });
        bodyAnchor.fill(null);
        for (const a of anchors) {
            if (a.kind === 'body' && Object.hasOwn(BODY_INDEX, a.id)) bodyAnchor[BODY_INDEX[a.id]] = a;
        }
        labels.setAnchors(anchors);
        builtMode = mode;
        dirty = false;
    }

    /**
     * Per-frame refresh. Call before `labels.update()` on every rendered frame.
     * @param {{position:{x:number,y:number,z:number}}} camera
     * @param {'orbit'|'sky'} mode effective view mode (sky once the transition is past halfway)
     */
    function sync(camera, mode) {
        if (dirty || mode !== builtMode) rebuild(mode);
        if (mode === 'orbit') {
            if (!usesBeamPoints) syncOrbitPoints(live, snap, camera);
            syncPinHead(live, snap);
            syncRim(live, getPin(), camera);
        } else {
            syncCardinals(live, snap);
        }
        for (let i = 0; i < BODIES.length; i++) {
            const a = bodyAnchor[i];
            if (a) a.below = isBelow(snap.bodies[i].altGeomDeg);
        }
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
