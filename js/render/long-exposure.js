/**
 * Long exposure (ROADMAP lighten-stacking-exposure): the controller of the stacking pass. While
 * `ui.expose` is set and the sky view is fully in, every rendered frame is max-stacked
 * (render/accum.js through rc.setAccumulation), so stars draw arcs around the celestial pole and
 * the landscape stays crisp; Expose off or the globe releases the pass and its two targets.
 *
 *   createLongExposure(rc, {rig, store, clock}) → RenderModule & { stats() }
 *
 * A render module for its per-frame hook only (object3d is an empty group): update() runs before
 * rc.render() on every rendered frame, so the reset and the gate apply to the frame about to be
 * stacked. A paused clock renders nothing new and so adds nothing.
 *
 * Reset (a fresh stack) when what the frame frames changes: the rig's LOCAL view (getView az/alt/fov;
 * under sidereal tracking, which re-aims every frame, the tracking mode and the field instead), a
 * tween or a drag, a clock jump or time sweep (setTime, setRange, seek), the layers, the observer, the pixel ratio
 * or size, the tier, or the preset. Never on the camera's world matrix: in sky view it turns with
 * the Earth on every frame that time runs, which is exactly what the exposure records.
 *
 * Gate: star trails stop collecting while the Sun is above GATE_SUN_DEG (a daylight frame would
 * flood the stack); the frame is still shown over the stack. The analemma collects every frame (its
 * subject is the Sun), bright-only: the first frame is the landscape and the sky, later ones add just
 * the Sun's core (render/accum.js), as a solar-filter multiple exposure does; a plain max would keep
 * the brightest summer sky and every daytime Moon and planet.
 *
 * @module render/long-exposure
 */
import * as THREE from 'three';

/** Above this solar altitude (degrees) star trails keep the stack without adding to it. */
export const GATE_SUN_DEG = -8;

/**
 * @param {any} rc render context
 * @param {{rig:any, store:any, clock:any}} deps
 */
export function createLongExposure(rc, { rig, store, clock }) {
    const group = new THREE.Group();
    group.name = 'longExposure';

    let active = false;
    let jumped = false;
    const offClock = clock?.onChange?.((ev) => {
        if (ev && (ev.type === 'jump' || ev.type === 'range')) jumped = true;
    }) ?? null;

    // The framing the stack was started with (see module docs).
    const key = { kind: '', track: '', az: NaN, alt: NaN, fov: NaN, layers: null, observer: null, dpr: 0, w: 0, h: 0, tier: '' };
    const stat = { kind: null, frames: 0, fromMs: NaN, toMs: NaN, gated: false, active: false };

    /** Updates the key; true when anything in it changed. No allocation beyond rig.getView(). */
    function framingChanged(kind) {
        const st = store.get();
        const v = rig?.getView?.() ?? null;
        const track = rig?.tracking ?? 'none';
        const tracked = track !== 'none';
        const az = v && !tracked ? v.azDeg : 0, alt = v && !tracked ? v.altDeg : 0, fov = v ? v.fovDeg : 0;
        const tier = rc.tier?.name ?? '';
        let changed = !!(rig?.tweening || rig?.dragging || clock?.tweening) || jumped;
        jumped = false;
        if (key.kind !== kind || key.track !== track || !Object.is(key.az, az) || !Object.is(key.alt, alt)
            || !Object.is(key.fov, fov) || key.layers !== st.layers || key.observer !== st.observer
            || key.dpr !== rc.dpr || key.w !== rc.size.w || key.h !== rc.size.h || key.tier !== tier) {
            changed = true;
            key.kind = kind;
            key.track = track;
            key.az = az;
            key.alt = alt;
            key.fov = fov;
            key.layers = st.layers;
            key.observer = st.observer;
            key.dpr = rc.dpr;
            key.w = rc.size.w;
            key.h = rc.size.h;
            key.tier = tier;
        }
        return changed;
    }

    function release() {
        active = false;
        stat.active = false;
        stat.frames = 0;
        stat.fromMs = stat.toMs = NaN;
        stat.gated = false;
        key.kind = '';
        rc.setAccumulation(false);
    }

    function update(fi) {
        const kind = store.get().ui?.expose ?? null;
        const on = !!kind && !!fi && fi.viewMode === 'sky' && fi.skyBlend >= 1;
        if (!on) {
            if (active) release();
            stat.kind = kind;
            return;
        }
        if (!active) {
            active = rc.setAccumulation(true);
            stat.active = active;
            if (!active) return;
            key.kind = '';
        }
        const pass = rc.accum;
        if (!pass) {
            active = stat.active = false;
            return;
        }
        // A capture at another size renders through here with the stack frozen: leave it be.
        if (pass.frozen) return;
        stat.kind = kind;
        if (framingChanged(kind)) {
            pass.reset();
            stat.fromMs = stat.toMs = NaN;
        }
        const sunAlt = fi.snap?.observer?.sunAltDeg;
        pass.add = kind === 'analemma' || !(sunAlt > GATE_SUN_DEG);
        pass.brightOnly = kind === 'analemma';
        stat.gated = !pass.add;
        if (pass.add) {
            const t = fi.snap?.tMs;
            if (pass.fresh || !Number.isFinite(stat.fromMs)) stat.fromMs = t;
            stat.toMs = t;
        }
    }

    return {
        object3d: group,
        update,
        /**
         * The exposure so far: preset, frames stacked, the simulated span they cover (ms), and
         * whether the gate (daylight) holds new frames back.
         * @returns {{kind:string|null, active:boolean, frames:number, fromMs:number, toMs:number, gated:boolean}}
         */
        stats() {
            stat.frames = active ? rc.accum?.frames ?? 0 : 0;
            return { ...stat };
        },
        dispose() {
            offClock?.();
            if (active) release();
        },
    };
}
