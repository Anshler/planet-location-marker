/**
 * Eclipse 2027 on the globe: which eclipse the path ribbon shows (`ribbonPlan`, main.js), and the
 * shadow chase (`createEclipseChase`, actions.chaseEclipse): the camera drops into low orbit
 * behind the Moon's umbra and follows it across the Earth while the clock runs the path in about
 * 40 s, slowing into greatest eclipse, holding there, and the ribbon is drawn in behind it.
 *
 * Choreography (ROADMAP Phase 1, eclipse-shadow-chase):
 *   1. the eclipse becomes the one in focus (ui.eclipse), on the globe; the clock pauses at the
 *      sunrise end of the path and the ribbon hides what the shadow has not reached yet;
 *   2. rig.follow() glides into the chase pose (≈ 1.6 s); on arrival the clock runs start → greatest
 *      eclipse as an eased-out range, holds 1.5 s, then greatest → sunset end eased in;
 *   3. at the end the whole ribbon is shown and the camera pulls back over greatest eclipse.
 * Pointer, wheel or key input hands the camera back (the clock carries on); a clock change by the
 * user (time, rate, Now, another jump) ends the chase where it is. Reduced motion: no chase, a
 * static frame over greatest eclipse at its instant with the whole path drawn.
 *
 * No three.js here: the camera is reached through the rig's API, the ribbon through its module.
 * @module app/eclipse-chase
 */
import { pathFrameLocal } from '../astro/eclipse-path.js';

const HALF_DAY_MS = 432e5;
/** Wall-clock length of the chase across the whole path (s). */
export const CHASE_DURATION_S = 40;
/** The pause at greatest eclipse (ms). */
export const CHASE_HOLD_MS = 1500;
/** The chase pose per tier (rig.follow options): higher on low, whose 2k day map is soft up close. */
export const CHASE_POSE = Object.freeze({
    low: Object.freeze({ altitude: 0.5, backDeg: 18, tiltDeg: 10 }),
    other: Object.freeze({ altitude: 0.35, backDeg: 14, tiltDeg: 10 }),
});
/** Distance of the closing overview (and of the reduced-motion frame) over greatest eclipse. */
export const CHASE_OVERVIEW_DIST = 2.4;

/**
 * What the globe's ribbon should do (main.js runs this on every readout and ui.eclipse change).
 * It shows the eclipse in focus (`ui.eclipse`), or without one an eclipse in progress
 * (`snap.eclipse.solar`, the geocentric Sun–Moon separation under 1.6°). A loaded path, a request
 * in flight or a known miss (a partial eclipse: no path) within half a day answers the request.
 * @param {{path:{peakMs:number}|null, pendingMs:number, missMs:number}} state
 * @param {{peakMs:number}|null|undefined} focus store ui.eclipse
 * @param {number} tMs simulated time
 * @param {boolean} solar snap.eclipse.solar
 * @returns {{action:'keep'|'clear'|'load', atMs:number}} 'load': request the path near atMs (after
 *   clearing what is shown); 'clear': hide the ribbon and forget the request.
 */
export function ribbonPlan(state, focus, tMs, solar) {
    const at = focus && Number.isFinite(focus.peakMs) ? focus.peakMs : solar && Number.isFinite(tMs) ? tMs : NaN;
    if (!Number.isFinite(at)) {
        return { action: state.path || Number.isFinite(state.pendingMs) ? 'clear' : 'keep', atMs: NaN };
    }
    const near = (x) => Number.isFinite(x) && Math.abs(at - x) < HALF_DAY_MS;
    if ((state.path && near(state.path.peakMs)) || near(state.pendingMs) || (!state.path && near(state.missMs))) {
        return { action: 'keep', atMs: at };
    }
    return { action: 'load', atMs: at };
}

/**
 * The chase's clock legs: the sunrise end to greatest eclipse eased out (the shadow slows into the
 * peak), then greatest eclipse to the sunset end eased in, splitting `durationS` by span so the
 * mean rate is the same on both sides. A leg shorter than a second (greatest eclipse at an end of
 * the path) is dropped.
 * @param {{startMs:number, endMs:number, peakMs:number}} path
 * @param {{durationS?:number}} [opts]
 * @returns {{fromMs:number, toMs:number, durationS:number, loop:'once', ease:'in'|'out'}[]}
 */
export function chaseLegs(path, { durationS = CHASE_DURATION_S } = {}) {
    const a = Number(path?.startMs), b = Number(path?.endMs);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(b - a > 2000)) return [];
    const g = Math.min(b, Math.max(a, Number.isFinite(path.peakMs) ? path.peakMs : (a + b) / 2));
    const total = Math.max(1, Number(durationS) || CHASE_DURATION_S);
    const legs = [];
    if (g - a >= 1000) legs.push({ fromMs: a, toMs: g, durationS: Math.max(0.5, (total * (g - a)) / (b - a)), loop: 'once', ease: 'out' });
    if (b - g >= 1000) legs.push({ fromMs: g, toMs: b, durationS: Math.max(0.5, (total * (b - g)) / (b - a)), loop: 'once', ease: legs.length ? 'in' : 'out' });
    return legs;
}

/**
 * rig.follow's target for a path: the centre line at the snapshot's instant and its direction of
 * motion, in the globe's geometry frame (false outside the path: the camera holds).
 * @param {import('../astro/eclipse-path.js').EclipsePath} path
 * @returns {(snap:{tMs:number}, pos:Float64Array, fwd:Float64Array)=>boolean}
 */
export function chaseTarget(path) {
    return (snap, pos, fwd) => Number.isFinite(pathFrameLocal(path, snap?.tMs, pos, fwd, 60e3));
}

/**
 * The shadow chase controller (actions.chaseEclipse / stopChase).
 * @param {{store:any, clock:any, getRig:()=>any, getRibbon:()=>any, eclipsePath:(t:number)=>Promise<any>,
 *          reducedMotion:()=>boolean, toast?:(msg:string, kind?:string)=>void,
 *          setTimeout?:typeof setTimeout, clearTimeout?:typeof clearTimeout}} deps
 * @returns {{start:(target:number|object)=>Promise<boolean>, stop:()=>void, readonly active:boolean}}
 */
export function createEclipseChase(deps) {
    const { store, clock } = deps;
    const later = deps.setTimeout ?? setTimeout;
    const cancelLater = deps.clearTimeout ?? clearTimeout;
    const toast = deps.toast ?? (() => {});
    let seq = 0;
    /** @type {null|{seq:number, path:any, legs:any[], leg:number, range:any, timer:any, off:()=>void}} */
    let run = null;
    let own = 0;

    /** A clock call of the chase's own (its events are not the user's). */
    function mine(fn) {
        own++;
        try {
            return fn();
        } finally {
            own--;
        }
    }

    function reveal(mode) {
        try {
            deps.getRibbon()?.setReveal?.(mode);
        } catch { /* cosmetic */ }
    }

    function end(natural) {
        const r = run;
        if (!r) return;
        run = null;
        if (r.timer !== null) cancelLater(r.timer);
        r.off();
        // A finished chase hands the clock back without its spent last leg, so the time bar leaves
        // 'Timelapse' and Play runs normal time again. A user takeover keeps whatever they set.
        if (natural && r.range && clock.range === r.range) mine(() => clock.setRange(null));
        reveal('time');
        const rig = deps.getRig();
        if (rig?.following) {
            rig.stopFollow?.();
            const g = r.path.greatest;
            if (natural && g && Number.isFinite(g.latDeg)) {
                Promise.resolve(rig.flyToLatLon?.(g.latDeg, g.lonDeg, { distance: CHASE_OVERVIEW_DIST })).catch(() => {});
            }
        }
    }

    function runLeg(r, i) {
        if (run !== r) return;
        r.timer = null;
        const leg = r.legs[i];
        if (!leg) {
            end(true);
            return;
        }
        r.leg = i;
        mine(() => clock.setRange(leg));
        r.range = clock.range;
    }

    function onClock(ev) {
        const r = run;
        if (!r || own > 0 || !ev) return;
        const ours = r.range !== null && clock.range === r.range;
        if (!ours && (ev.type === 'range' || ev.type === 'jump' || ev.type === 'rate' || ev.type === 'live')) {
            // The user took the clock (time, rate, Now, another jump, their own timelapse). Scrubbing
            // inside a running leg is still the chase.
            end(false);
        } else if (ev.type === 'pause' && r.range && clock.range === r.range && clock.progress?.() >= 1) {
            // A leg ran out: hold at greatest eclipse, or finish.
            if (r.leg + 1 < r.legs.length) r.timer = later(() => runLeg(r, r.leg + 1), CHASE_HOLD_MS);
            else end(true);
        }
    }

    function focus(path, target) {
        const ui = store.get().ui;
        // The focus is the global eclipse (local: false), so its kind is the path's: a local event
        // seen from outside the band says 'partial', which would hide 'Stand in the path'.
        const given = target && typeof target === 'object' ? target.eclipseKind : null;
        const kind = given === 'total' || given === 'annular' ? given : path.kind === 'annular' ? 'annular' : 'total';
        const eclipse = { peakMs: path.peakMs, kind, local: false, eventId: (target && typeof target === 'object' && target.id) || null };
        store.set({ ui: { ...ui, eclipse } }, 'actions');
        const view = store.get().view;
        if (view.mode !== 'orbit') store.set({ view: { ...view, mode: 'orbit' } }, 'event');
    }

    /**
     * Starts the chase for the central eclipse near a time or event (its tMs). Resolves true once
     * it runs (or, with reduced motion, once the static frame is set), false when the eclipse has
     * no path on Earth, there is no 3D view, or a newer call superseded it.
     */
    async function start(target) {
        const t = typeof target === 'number' ? target : Number(target?.tMs);
        if (!Number.isFinite(t)) return false;
        stop();
        const mySeq = ++seq;
        let path = null;
        try {
            path = await deps.eclipsePath(t);
        } catch {
            path = null;
        }
        if (mySeq !== seq) return false;
        if (!path) {
            toast('This eclipse has no path of totality or annularity on Earth.', 'info');
            return false;
        }
        const rig = deps.getRig();
        if (!rig?.follow) return false;
        focus(path, target);
        const g = path.greatest;
        if (deps.reducedMotion()) {
            mine(() => {
                clock.pause();
                clock.setTime(path.peakMs);
            });
            reveal('all');
            Promise.resolve(rig.flyToLatLon?.(g.latDeg, g.lonDeg, { distance: CHASE_OVERVIEW_DIST, animate: false })).catch(() => {});
            return true;
        }
        const legs = chaseLegs(path);
        if (!legs.length) return false;
        mine(() => {
            clock.pause();
            clock.setTime(path.startMs);
        });
        reveal('chase');
        const r = { seq: mySeq, path, legs, leg: -1, range: null, timer: null, off: () => {} };
        run = r;
        r.off = clock.onChange(onClock);
        const pose = store.get().quality?.active === 'low' ? CHASE_POSE.low : CHASE_POSE.other;
        let arrived = false;
        const arrive = () => {
            if (arrived || run !== r) return;
            arrived = true;
            runLeg(r, 0);
        };
        Promise.resolve(rig.follow(chaseTarget(path), { ...pose, onArrive: () => Promise.resolve().then(arrive) }))
            .then(() => arrive(), () => arrive());   // cancelled before arriving: still run the clock
        return true;
    }

    /** Ends a running chase where it is (the clock stays put; the camera returns to the controls). */
    function stop() {
        seq++;
        end(false);
    }

    return {
        start,
        stop,
        get active() { return run !== null; },
    };
}
