// Simulation clock (SPEC §C.3, §B.15).
//
// Two time bases meet here:
//   - `now()` (injected, default Date.now) is the real epoch time that Live mode follows;
//   - `tick(wallMs)` receives the frame timestamp (requestAnimationFrame / performance.now base) and
//     uses only its DIFFERENCES to advance simulated time at `rate` sim-ms per wall-ms.
// Wall deltas are capped (maxDtMs) so a hidden tab or a long hitch never teleports the simulation.
//
// Modes, in priority order inside tick():
//   tween  setTime/goLive with animateMs: a log-time sweep toward the target (pauses nothing)
//   live   playing, rate 1, tMs = now()
//   range  timelapse: tMs = from + progress·(to − from), progress advanced by wall time
//   free   tMs += rate·dt while playing
//
// Change notifications are coalesced per operation and delivered in a fixed order
// (range, rate, jump, pause, play, live, clamp), each as its own `{type, tMs, rate, playing, live}`.
// tick() allocates nothing unless it has an event to deliver.

/** Signed rate ladder in sim-seconds per wall-second (SPEC §C.3). */
export const RATES = Object.freeze([-31557600, -2592000, -604800, -86400, -21600, -3600, -600, -60, -10, -1,
    1, 10, 60, 600, 3600, 21600, 86400, 604800, 2592000, 31557600]);
/** Step sizes in ms. `month` is the mean synodic month, `year` the Julian year. */
export const STEP = Object.freeze({ minute: 6e4, hour: 36e5, day: 864e5, siderealDay: 86164090.5, month: 29.530589 * 864e5, year: 31557600e3 });
/** Supported time span: 1000-01-01T00:00Z … 3000-01-01T00:00Z. */
export const MIN_MS = Date.UTC(1000, 0, 1), MAX_MS = Date.UTC(3000, 0, 1);
/** Largest |rate| accepted (1 yr/s). */
export const MAX_RATE = 31557600;

/** Scale below which log-time easing becomes linear: sub-minute differences are not worth a sweep. */
const EASE_TAU_MS = 60e3;
const EVENT_ORDER = ['range', 'rate', 'jump', 'pause', 'play', 'live', 'clamp'];
const BIT = { range: 1, rate: 2, jump: 4, pause: 8, play: 16, live: 32, clamp: 64 };

/** @param {number} x */
function clampT(x) {
    return x < MIN_MS ? MIN_MS : x > MAX_MS ? MAX_MS : x;
}

/** @param {number} x */
function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Validates a rate: finite, non-zero, clamped to ±MAX_RATE. Returns null when unusable.
 * @param {unknown} x
 * @returns {number|null}
 */
export function sanitizeRate(x) {
    const v = Number(x);
    if (!Number.isFinite(v) || v === 0) return null;
    return Math.max(-MAX_RATE, Math.min(MAX_RATE, v));
}

/**
 * Snaps any rate to the nearest ladder value of the same sign (nearest in log space),
 * e.g. 5000 → 3600, −7 → −10. Returns null for 0 or non-finite input.
 * @param {unknown} rate
 * @returns {number|null}
 */
export function snapRate(rate) {
    const v = Number(rate);
    if (!Number.isFinite(v) || v === 0) return null;
    const sign = v < 0 ? -1 : 1;
    const lv = Math.log(Math.abs(v));
    let best = sign, bestD = Infinity;
    for (const r of RATES) {
        if (Math.sign(r) !== sign) continue;
        const d = Math.abs(Math.log(Math.abs(r)) - lv);
        if (d < bestD) { bestD = d; best = r; }
    }
    return best;
}

/**
 * Next ladder value strictly above (`dir` > 0, "faster") or below (`dir` < 0, "slower") `rate`
 * on the SIGNED ladder, so faster from −1 is +1 and slower from +1 is −1. Saturates at the ends.
 * Off-ladder rates move to the nearest ladder value in that direction.
 * @param {number} rate
 * @param {number} dir
 * @returns {number}
 */
export function nextRate(rate, dir) {
    const eps = Math.abs(rate) * 1e-9;
    if (dir > 0) {
        for (const r of RATES) if (r > rate + eps) return r;
        return RATES[RATES.length - 1];
    }
    for (let i = RATES.length - 1; i >= 0; i--) if (RATES[i] < rate - eps) return RATES[i];
    return RATES[0];
}

/**
 * Half-width (ms) of the scrubber track for a given rate (SPEC §F.2): ±12 h up to 10 min/s,
 * ±3 d up to 6 h/s, ±30 d up to 7 d/s, ±1 yr beyond.
 * @param {number} rate
 * @returns {number}
 */
export function scrubSpanMs(rate) {
    const a = Math.abs(Number(rate) || 1);
    if (a <= 600) return 12 * 36e5;
    if (a <= 21600) return 3 * 864e5;
    if (a <= 604800) return 30 * 864e5;
    return 365.25 * 864e5;
}

/**
 * Log-time easing between two instants. The sweep accelerates exponentially away from `from` and
 * decelerates exponentially into `to`, so every order of magnitude of the jump (minutes, days,
 * years, centuries) gets equal screen time: the date visibly spins through time and settles.
 * Smoothstep on `e` gives zero velocity at both ends. Exact endpoints and an exact midpoint at e=½.
 * @param {number} from
 * @param {number} to
 * @param {number} e  0..1
 * @returns {number}
 */
export function logEase(from, to, e) {
    const d = to - from;
    if (d === 0 || e >= 1) return to;
    if (e <= 0) return from;
    const u = e * e * (3 - 2 * e);
    const s = d < 0 ? -1 : 1;
    const k = Math.log1p(Math.abs(d) / 2 / EASE_TAU_MS);
    if (u <= 0.5) return from + s * EASE_TAU_MS * Math.expm1(2 * u * k);
    return to - s * EASE_TAU_MS * Math.expm1(2 * (1 - u) * k);
}

/**
 * Creates the simulation clock.
 *
 * With no `tMs` the clock starts Live (when playing at rate 1) at `now()`. A start time outside
 * MIN_MS..MAX_MS is clamped and the clock starts paused.
 *
 * Semantics (SPEC §C.3):
 * - Live = playing, rate 1, synced to `now()`. Any setTime/step/seek/rate change/pause leaves Live;
 *   only goLive() enters it.
 * - setRate/faster/slower walk the signed ladder (faster from −1 s/s is +1 s/s). During a range they
 *   end the range and continue freely from the current time; reverse() instead flips the range's
 *   playback direction.
 * - setTime/step clamp into range; a clamped jump also pauses and emits 'clamp'. Running into a
 *   bound while playing does the same.
 * - setRange starts a timelapse at `fromMs` and plays it; `once` pauses at the end (play() replays),
 *   `loop` wraps, `pingpong` bounces. While a range runs, `rate` reports the effective signed rate.
 * - isAnimating() is true while a tween runs or while playing off-Live faster than real time, i.e.
 *   whenever continuous redraw is worthwhile. Live 1× (and paused) report false.
 *
 * @param {{now?:()=>number, tMs?:number|null, rate?:number, playing?:boolean, maxDtMs?:number,
 *          onError?:(err:unknown)=>void}} [opts]
 * @returns {import('./types.js').Clock}
 */
export function createClock({ now = () => Date.now(), tMs, rate = 1, playing = true, maxDtMs = 250, onError } = {}) {
    const report = typeof onError === 'function' ? onError : (err) => console.error('[clock] listener failed:', err);
    const nowFn = typeof now === 'function' ? now : () => Date.now();
    const maxDt = Number.isFinite(maxDtMs) && maxDtMs > 0 ? maxDtMs : 250;

    /** Reads the injected wall clock, falling back to Date.now() if it misbehaves. */
    function readNow() {
        let v;
        try {
            v = Number(nowFn());
        } catch {
            v = Number.NaN;
        }
        return Number.isFinite(v) ? v : Date.now();
    }

    let r = sanitizeRate(rate) ?? 1;
    let isPlaying = playing !== false;
    let live = false;
    let t;
    const start = tMs === null || tMs === undefined ? Number.NaN : Number(tMs);
    if (Number.isFinite(start)) {
        t = start;
    } else {
        t = readNow();
        live = isPlaying && r === 1;
    }
    if (t < MIN_MS || t > MAX_MS) {
        t = clampT(t);
        live = false;
        isPlaying = false;
    }

    /** @type {number|null} */
    let lastWall = null;
    /** @type {{from:number, to:number, durMs:number, elapsed:number, toLive:boolean}|null} */
    let tween = null;
    /** @type {Readonly<{fromMs:number, toMs:number, durationS:number, loop:'once'|'loop'|'pingpong'}>|null} */
    let range = null;
    let rangeP = 0;
    let rangeDir = 1;
    /** @type {((ev:object)=>void)[]} */
    let listeners = [];
    let queued = 0;

    function effRate() {
        return range ? (rangeDir * (range.toMs - range.fromMs)) / (range.durationS * 1000) : r;
    }

    function queue(type) {
        queued |= BIT[type];
    }

    function flush() {
        if (!queued) return;
        const q = queued;
        queued = 0;
        for (const type of EVENT_ORDER) {
            if (!(q & BIT[type]) || !listeners.length) continue;
            const ev = Object.freeze({ type, tMs: t, rate: effRate(), playing: isPlaying, live });
            for (const fn of listeners) {
                try {
                    fn(ev);
                } catch (err) {
                    report(err);
                }
            }
        }
    }

    /** Ends a running range (if any), queueing 'range' and, if the rate changes, 'rate'. */
    function endRange() {
        if (!range) return;
        const before = effRate();
        range = null;
        queue('range');
        if (r !== before) queue('rate');
    }

    /** A goLive tween that is no longer going Live keeps its current target and stops chasing now(). */
    function freezeLiveTween() {
        if (tween?.toLive) {
            tween.to = clampT(readNow());
            tween.toLive = false;
        }
    }

    /** Stops at a bound: clamp, pause, leave Live, emit 'clamp'. */
    function clampStop(x) {
        t = clampT(x);
        tween = null;
        live = false;
        if (isPlaying) {
            isPlaying = false;
            queue('pause');
        }
        queue('clamp');
    }

    function stepTween(dt) {
        tween.elapsed += dt;
        const target = tween.toLive ? clampT(readNow()) : tween.to;
        if (tween.elapsed >= tween.durMs) {
            t = target;
            tween = null;
        } else {
            t = logEase(tween.from, target, tween.elapsed / tween.durMs);
        }
    }

    function advanceRange(dt) {
        let p = rangeP + (rangeDir * dt) / (range.durationS * 1000);
        if (range.loop === 'loop') {
            p -= Math.floor(p);
        } else if (range.loop === 'pingpong') {
            if (p > 1) {
                p = 2 - p;
                rangeDir = -1;
                queue('rate');
            } else if (p < 0) {
                p = -p;
                rangeDir = 1;
                queue('rate');
            }
            p = clamp01(p);
        } else if (p >= 1 || p <= 0) {
            p = clamp01(p);
            isPlaying = false;
            queue('pause');
        }
        rangeP = p;
        t = range.fromMs + p * (range.toMs - range.fromMs);
    }

    function tick(wallMs) {
        const w = Number.isFinite(wallMs) ? wallMs : readNow();
        let dt = lastWall === null ? 0 : w - lastWall;
        lastWall = w;
        if (!(dt > 0)) dt = 0;
        else if (dt > maxDt) dt = maxDt;

        if (tween) {
            stepTween(dt);
        } else if (live) {
            const n = readNow();
            if (n >= MIN_MS && n <= MAX_MS) t = n;
            else clampStop(n);
        } else if (isPlaying && dt > 0) {
            if (range) {
                advanceRange(dt);
            } else {
                const next = t + r * dt;
                if (next > MAX_MS || next < MIN_MS) clampStop(next);
                else t = next;
            }
        }
        flush();
        return t;
    }

    function play() {
        if (isPlaying) return;
        if (range) {
            // A finished 'once' timelapse replays from its start (or end, when reversed).
            if (range.loop === 'once' && rangeDir > 0 && rangeP >= 1) {
                rangeP = 0;
                t = range.fromMs;
                queue('jump');
            } else if (range.loop === 'once' && rangeDir < 0 && rangeP <= 0) {
                rangeP = 1;
                t = range.toMs;
                queue('jump');
            }
        } else if ((t >= MAX_MS && r > 0) || (t <= MIN_MS && r < 0)) {
            // Playing would run straight out of the supported span.
            queue('clamp');
            flush();
            return;
        }
        isPlaying = true;
        lastWall = null;
        queue('play');
        flush();
    }

    function pause() {
        if (!isPlaying) return;
        isPlaying = false;
        live = false;
        freezeLiveTween();
        queue('pause');
        flush();
    }

    function setRate(x) {
        const s = sanitizeRate(x);
        if (s === null) return;
        const before = effRate();
        if (range) {
            range = null;
            queue('range');
        }
        if (!live || s !== 1) {
            r = s;
            if (live) {
                live = false;
                freezeLiveTween();
            }
        }
        if (effRate() !== before) queue('rate');
        flush();
    }

    function reverse() {
        if (range) {
            rangeDir = -rangeDir;
            queue('rate');
            flush();
            return;
        }
        setRate(-r);
    }

    function setTime(ms, opts) {
        const x = Number(ms);
        if (!Number.isFinite(x)) return;
        const animateMs = Math.max(0, Number(opts?.animateMs) || 0);
        endRange();
        live = false;
        const target = clampT(x);
        if (animateMs > 0 && target !== t) {
            tween = { from: t, to: target, durMs: animateMs, elapsed: 0, toLive: false };
        } else {
            tween = null;
            t = target;
        }
        queue('jump');
        if (target !== x) {
            if (isPlaying) {
                isPlaying = false;
                queue('pause');
            }
            queue('clamp');
        }
        flush();
    }

    function step(kind, n = 1, opts) {
        let unit = Number.NaN;
        if (typeof kind === 'number') unit = kind;
        else if (typeof kind === 'string' && Object.hasOwn(STEP, kind)) unit = STEP[kind];
        const k = Number(n);
        if (!Number.isFinite(unit) || !Number.isFinite(k) || unit === 0 || k === 0) return;
        // Steps accumulate onto an in-flight tween's destination, so rapid presses add up.
        let base = t;
        if (tween) base = tween.toLive ? readNow() : tween.to;
        setTime(base + unit * k, opts);
    }

    function goLive(opts) {
        const animateMs = Math.max(0, Number(opts?.animateMs) || 0);
        const before = effRate();
        if (range) {
            range = null;
            queue('range');
        }
        const n = readNow();
        if (n < MIN_MS || n > MAX_MS) {
            // The device clock itself is outside the supported span.
            r = 1;
            if (effRate() !== before) queue('rate');
            queue('jump');
            clampStop(n);
            flush();
            return;
        }
        const wasPlaying = isPlaying;
        const wasLive = live;
        r = 1;
        isPlaying = true;
        live = true;
        lastWall = null;
        if (animateMs > 0 && Math.abs(n - t) > 1000) {
            tween = { from: t, to: n, durMs: animateMs, elapsed: 0, toLive: true };
        } else {
            tween = null;
            t = n;
        }
        if (effRate() !== before) queue('rate');
        if (!wasLive) queue('jump');
        if (!wasPlaying) queue('play');
        if (!wasLive) queue('live');
        flush();
    }

    function setRange(cfg) {
        if (cfg === null || cfg === undefined) {
            if (range) {
                endRange();
                flush();
            }
            return true;
        }
        if (typeof cfg !== 'object') return false;
        const from = Number(cfg.fromMs), to = Number(cfg.toMs);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
        const f = clampT(from), e = clampT(to);
        if (Math.abs(e - f) < 1000) return false;
        let dur = 20;
        if (cfg.durationS !== undefined && cfg.durationS !== null) {
            dur = Number(cfg.durationS);
            if (!Number.isFinite(dur) || dur <= 0) return false;
        }
        dur = Math.max(0.5, Math.min(86400, dur));
        const loop = cfg.loop === 'once' || cfg.loop === 'pingpong' ? cfg.loop : 'loop';

        const before = effRate();
        const wasPlaying = isPlaying;
        range = Object.freeze({ fromMs: f, toMs: e, durationS: dur, loop });
        rangeP = 0;
        rangeDir = 1;
        tween = null;
        live = false;
        t = f;
        isPlaying = true;
        lastWall = null;
        queue('range');
        if (effRate() !== before) queue('rate');
        queue('jump');
        if (!wasPlaying) queue('play');
        flush();
        return true;
    }

    function seek(p) {
        if (!range) return false;
        const x = Number(p);
        if (!Number.isFinite(x)) return false;
        rangeP = clamp01(x);
        t = range.fromMs + rangeP * (range.toMs - range.fromMs);
        tween = null;
        queue('jump');
        flush();
        return true;
    }

    function onChange(cb) {
        if (typeof cb !== 'function') return () => {};
        listeners = listeners.concat(cb);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            listeners = listeners.filter((f) => f !== cb);
        };
    }

    return {
        get tMs() { return t; },
        get rate() { return effRate(); },
        get baseRate() { return r; },
        get playing() { return isPlaying; },
        get live() { return live; },
        get range() { return range; },
        get tweening() { return tween !== null; },
        tick,
        play,
        pause,
        toggle() {
            if (isPlaying) pause();
            else play();
        },
        setRate,
        faster() { setRate(nextRate(effRate(), +1)); },
        slower() { setRate(nextRate(effRate(), -1)); },
        reverse,
        setTime,
        step,
        goLive,
        setRange,
        progress() { return range ? rangeP : null; },
        seek,
        isAnimating() { return tween !== null || (isPlaying && !live && Math.abs(effRate()) > 1); },
        onChange,
    };
}
