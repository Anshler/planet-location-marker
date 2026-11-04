/**
 * Extra objects: selectable things beyond the nine BODIES (pure; no three.js, no DOM).
 *
 * The nine bodies keep their contract (BODIES order, Snapshot.bodies, the 1–9 keys, the beam
 * instances). Everything else that can be selected, labelled, picked and shown in the body card
 * registers here as a *provider* for one kind of namespaced id (core/selection.js):
 * `star:<hip>`, `dso:<id>`, `comet:<id>`, `craft:<id>`, `guest:<id>`.
 *
 * Data flow, the same for every kind:
 *
 *   provider.fill(snap, id, st)   per snapshot (frame detail when it is recomputed, full at 4 Hz):
 *                                 the object's topocentric astrometric J2000 direction in the
 *                                 scene frame (like BodyState.dirS), distance, magnitude, and
 *                                 whether it exists at this instant (`present`).
 *   registry.fill(snap)           loop.js calls it right after computeSnapshot; it adds the
 *                                 geometric and refracted alt/az from the snapshot's observer
 *                                 frame, so every consumer reads one ExtraState per id.
 *   snap.extras[slot]             the states, one per registered id, in registry order;
 *                                 registry.state(snap, id) finds one by id.
 *   provider.card(id, st, snap)   the body card's content (4 Hz, UI only).
 *
 * Providers that are not registered yet (data still loading) simply have no slots; a selection of
 * their id stays in the store and resolves once they register (`onChange`).
 *
 * No per-frame allocation: states are created once per id and snapshot, then refilled.
 *
 * @module astro/extras
 */

import { AE } from './ae.js';
import { AU_ER, LIGHT_S_PER_AU } from './bodies.js';
import { refractionDeg } from './photometry.js';
import { sceneToRaDec } from './frames.js';
import { isExtraId, parseSelectionId } from '../core/selection.js';

const RAD2DEG = 180 / Math.PI;

/**
 * @typedef {'star'|'dso'|'comet'|'craft'|'guest'} ExtraKind
 *
 * One extra object's state in one snapshot. Vectors are in the SCENE frame.
 * @typedef {{ id:string, kind:ExtraKind,
 *   dirS:Float64Array,     // topocentric astrometric J2000 unit vector (glyphs, labels, picking)
 *   distAU:number,         // topocentric distance, AU (NaN: at infinity or unknown)
 *   lightTimeS:number,     // one-way light time, s (NaN when distAU is)
 *   mag:number,            // visual magnitude (NaN: none, e.g. a spacecraft)
 *   altGeomDeg:number, azGeomDeg:number,   // from dirS against the observer ENU, unrefracted
 *   altDeg:number, azDeg:number,           // apparent (refracted, 'normal'), as the tables show
 *   above:boolean,         // apparent altitude above the horizon
 *   present:boolean,       // exists at this instant (a guest star before its outburst does not)
 *   approx:boolean,        // outside its data's validity: drawn, but labelled approximate
 *   data:any }} ExtraState  // provider-owned extras (tail vectors, …), preallocated by the provider
 *
 * How an object is drawn and labelled (render/extras.js, app/labels-feed.js):
 * `glyph` 'star' (a point like a star, sized by `mag`), 'marker' (a small hollow diamond: things
 * too faint to see, e.g. spacecraft), 'coma' (drawn by its own module, render/comets.js), 'none'
 * (already drawn by another layer, e.g. a catalogue star: only the reticle). `label` 'always',
 * 'selected' (only while selected) or 'never'. `layer`: a Layers key that must be on for it to be
 * drawn and labelled (e.g. 'stars', 'spacecraft'); absent = always. Label refinements (app/labels-feed.js):
 * `skyOnly` labels it only in sky view (unless selected), `nightMag` gates the label like a star name
 * of that magnitude (gone by day and under a bright sky; deep-sky objects), `priority` replaces the
 * extras' 78 in the declutter.
 * @typedef {{ name:string, color:string, glyph:'star'|'marker'|'coma'|'none', label:'always'|'selected'|'never',
 *   layer?:string, short?:string, skyOnly?:boolean, nightMag?:number, priority?:number }} ExtraMeta
 *
 * The body card's content for an extra (ui/body-card.js). `lines`: sentences under the title
 * (the light-time or radio-time line goes here); `facts`: label/value pairs for the fact grid;
 * `caveat`: a one-line honesty note ('Peak brightness is uncertain by about ±1 mag'); `sources`.
 * `rts`: rise, transit and set for the observer's day (UTC ms, null when it does not happen), when
 * the provider can tell (guest stars, via Astronomy Engine's DefineStar).
 * @typedef {{ kindLabel?:string, subtitle?:string, lines?:string[], facts?:Array<[string, string]>,
 *   caveat?:string, sources?:string[],
 *   rts?:{riseMs:number|null, transitMs:number|null, setMs:number|null, transitAltDeg:number|null}|null }} ExtraCard
 *
 * A provider owns one kind. `ids()` lists every id it knows (stable order; it may change only
 * through `registry.refresh()`); `meta(id)` how it is drawn; `fill` and `card` as above.
 * @typedef {{ kind:ExtraKind, kindLabel:string, ids:()=>ReadonlyArray<string>, meta:(id:string)=>ExtraMeta|null,
 *   fill:(snap:any, id:string, out:ExtraState)=>void, card?:(id:string, st:ExtraState, snap:any)=>ExtraCard|null }} ExtraProvider
 */

/**
 * A fresh ExtraState (not present).
 * @param {string} id
 * @param {ExtraKind} kind
 * @returns {ExtraState}
 */
export function createExtraState(id, kind) {
    return {
        id, kind, dirS: new Float64Array([1, 0, 0]), distAU: NaN, lightTimeS: NaN, mag: NaN,
        altGeomDeg: NaN, azGeomDeg: NaN, altDeg: NaN, azDeg: NaN, above: false, present: false, approx: false, data: null,
    };
}

/**
 * Topocentric direction (scene unit vector into `out`) and distance of an object whose geocentric
 * position is `gx, gy, gz` (AU, scene axes): the observer's place on the globe (snap.observer.posS,
 * Earth radii) is taken off first, so near objects (JWST, a comet close to the Earth) get their
 * parallax. Returns the topocentric distance in AU.
 * @param {number} gx
 * @param {number} gy
 * @param {number} gz
 * @param {any} snap
 * @param {Float64Array} out
 * @returns {number}
 */
export function topocentricScene(gx, gy, gz, snap, out) {
    const p = snap?.observer?.posS;
    let x = gx, y = gy, z = gz;
    if (p) {
        x -= p[0] / AU_ER;
        y -= p[1] / AU_ER;
        z -= p[2] / AU_ER;
    }
    const d = Math.hypot(x, y, z);
    if (d > 0) {
        out[0] = x / d; out[1] = y / d; out[2] = z / d;
    }
    return d;
}

/**
 * Fills `st`'s alt/az from its dirS and the snapshot's observer frame: geometric, then apparent
 * with astronomy-engine's 'normal' refraction (photometry.refractionDeg), and `above`.
 * @param {any} snap
 * @param {ExtraState} st
 */
export function extraAltAz(snap, st) {
    const o = snap?.observer;
    if (!o || !o.upS) return;
    const d = st.dirS;
    const u = d[0] * o.upS[0] + d[1] * o.upS[1] + d[2] * o.upS[2];
    const n = d[0] * o.northS[0] + d[1] * o.northS[1] + d[2] * o.northS[2];
    const e = d[0] * o.eastS[0] + d[1] * o.eastS[1] + d[2] * o.eastS[2];
    const alt = Math.asin(Math.max(-1, Math.min(1, u))) * RAD2DEG;
    let az = Math.atan2(e, n) * RAD2DEG;
    if (az < 0) az += 360;
    st.altGeomDeg = alt;
    st.azGeomDeg = az;
    st.altDeg = alt + refractionDeg(alt);
    st.azDeg = az;
    st.above = st.altDeg > 0;
    st.lightTimeS = Number.isFinite(st.distAU) ? st.distAU * LIGHT_S_PER_AU : NaN;
}

const _rd = { raDeg: 0, decDeg: 0 };

/**
 * An extra object's astrometric J2000 RA/Dec and constellation (Astronomy Engine's Constellation,
 * the IAU boundaries), from its topocentric direction. For the card (4 Hz), not per frame.
 * @param {ExtraState} st
 * @returns {{raH:number, decDeg:number, constellation:{symbol:string, name:string}|null}}
 */
export function extraSky(st) {
    sceneToRaDec(st.dirS, _rd);
    let con = null;
    try {
        const c = AE.Constellation(_rd.raDeg / 15, _rd.decDeg);
        con = { symbol: c.symbol, name: c.name };
    } catch { con = null; }
    return { raH: _rd.raDeg / 15, decDeg: _rd.decDeg, constellation: con };
}

/**
 * Creates the extras registry.
 * @returns {{
 *   register(provider:ExtraProvider):()=>void, refresh():void,
 *   has(id:string):boolean, meta(id:string):(ExtraMeta & {id:string, kind:string, kindLabel:string})|null,
 *   ids(kind?:string):string[], fill(snap:any):void, state(snap:any, id:string):ExtraState|null,
 *   card(id:string, snap:any):ExtraCard|null, onChange(fn:()=>void):()=>void, readonly version:number,
 *   readonly lastError:unknown }}
 */
export function createExtras() {
    /** @type {Map<string, ExtraProvider>} */
    const providers = new Map();
    /** @type {{id:string, kind:string, provider:ExtraProvider, meta:ExtraMeta}[]} */
    let slots = [];
    /** @type {Map<string, number>} */
    let slotOf = new Map();
    let version = 0;
    let lastError = null;
    const listeners = new Set();

    function rebuild() {
        const next = [];
        for (const kind of ['guest', 'comet', 'craft', 'dso', 'star']) {
            const p = providers.get(kind);
            if (!p) continue;
            let ids = [];
            try { ids = p.ids() || []; } catch (err) { lastError = err; ids = []; }
            for (const id of ids) {
                const parsed = parseSelectionId(id);
                if (!parsed || parsed.kind !== kind) continue;
                let meta = null;
                try { meta = p.meta(id); } catch (err) { lastError = err; meta = null; }
                if (!meta) continue;
                next.push({ id, kind, provider: p, meta });
            }
        }
        slots = next;
        slotOf = new Map(next.map((s, i) => [s.id, i]));
        version += 1;
        for (const fn of listeners) {
            try { fn(); } catch (err) { lastError = err; }
        }
    }

    /** Makes snap.extras match the current slots (new states only for new ids). */
    function ensure(snap) {
        if (snap.extrasVersion === version && Array.isArray(snap.extras)) return;
        const old = new Map();
        if (Array.isArray(snap.extras)) for (const st of snap.extras) old.set(st.id, st);
        snap.extras = slots.map((s) => old.get(s.id) ?? createExtraState(s.id, /** @type {any} */ (s.kind)));
        snap.extrasVersion = version;
    }

    return {
        register(provider) {
            if (!provider || typeof provider.kind !== 'string') throw new TypeError('extras.register: a provider needs a kind');
            providers.set(provider.kind, provider);
            rebuild();
            return () => {
                if (providers.get(provider.kind) === provider) {
                    providers.delete(provider.kind);
                    rebuild();
                }
            };
        },
        /** Re-reads every provider's ids (a provider's list changed). */
        refresh() { rebuild(); },
        has(id) { return slotOf.has(id); },
        meta(id) {
            const i = slotOf.get(id);
            if (i === undefined) return null;
            const s = slots[i];
            return { ...s.meta, id: s.id, kind: s.kind, kindLabel: s.provider.kindLabel };
        },
        ids(kind) { return slots.filter((s) => !kind || s.kind === kind).map((s) => s.id); },
        fill(snap) {
            if (!snap) return;
            ensure(snap);
            const list = snap.extras;
            for (let i = 0; i < slots.length; i++) {
                const s = slots[i];
                const st = list[i];
                try {
                    s.provider.fill(snap, s.id, st);
                } catch (err) {
                    lastError = err;
                    st.present = false;
                }
                if (st.present) extraAltAz(snap, st);
            }
        },
        state(snap, id) {
            if (!snap || !isExtraId(id)) return null;
            const i = slotOf.get(id);
            if (i === undefined || snap.extrasVersion !== version || !snap.extras) return null;
            return snap.extras[i] ?? null;
        },
        card(id, snap) {
            const i = slotOf.get(id);
            if (i === undefined) return null;
            const s = slots[i];
            const st = this.state(snap, id);
            if (!st || typeof s.provider.card !== 'function') return null;
            try { return s.provider.card(id, st, snap); } catch (err) { lastError = err; return null; }
        },
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        get version() { return version; },
        get lastError() { return lastError; },
    };
}
