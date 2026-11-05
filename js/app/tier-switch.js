// Staged quality-tier switches (hitch-free-tier-switch). Pure: no three.js, no DOM.
//
// A tier change needs new shader variants (the modules' defines, the post chain's passes) and new
// maps. Applied in one go, the next frame paid a synchronous compile and link, 0.5–1.8 s measured
// on a desktop GPU, right when the governor had judged frames too slow. main.js switches in steps:
//
//   pause()        drawing stops; the loop keeps ticking the clock and the readouts
//   stage(cfg)     the modules take the tier (setQuality: defines, meshes, map keys) and the
//                  render context builds its post chain at the current size (no canvas resize)
//   compile(cfg)   every variant compiles against the target it will draw into, and maps decoded
//                  meanwhile reach the GPU one per task before anything binds them (a promise)
//   commit(cfg)    the DPR and drawing buffer (a resize clears the canvas, so it comes last)
//   resume()       the next frame draws the new tier with nothing left to compile
//
// A tier with the same variants as the current one (`sameVariants`: a governor DPR step, which
// changes only the DPR cap) is staged and committed at once, without the pause. A request made
// while a switch is staged replaces it: the newer tier is staged before anything is drawn and the
// older one is never committed. A compile that never settles (a lost context, a hidden tab) is
// given up after `timeoutMs`: the switch commits and the first frame compiles what is left. A hook
// that throws is reported through `onError` and the switch carries on, so drawing always resumes.
//
//   const sw = createTierSwitch({current, stage, compile, commit, pause, resume})
//   sw.request(cfg) → Promise<void>   settles once every requested tier is committed
//   sw.current · sw.pending · sw.staged

/** Default `sameVariants`: the same tier name (TierCfgs differing only in the governor's DPR cap). */
export function sameTier(a, b) {
    return !!a && !!b && a.name === b.name;
}

/**
 * @param {{current?:object|null, stage:(cfg:object)=>void, compile:(cfg:object)=>Promise<unknown>|void,
 *   commit:(cfg:object)=>void, pause?:()=>void, resume?:()=>void,
 *   sameVariants?:(from:object|null, to:object)=>boolean, timeoutMs?:number,
 *   onError?:(phase:string, err:unknown)=>void,
 *   setTimer?:(fn:()=>void, ms:number)=>unknown, clearTimer?:(id:unknown)=>void}} hooks
 */
export function createTierSwitch(hooks) {
    const same = hooks.sameVariants ?? sameTier;
    const timeoutMs = Number.isFinite(hooks.timeoutMs) && hooks.timeoutMs > 0 ? hooks.timeoutMs : 10000;
    const setTimer = hooks.setTimer ?? setTimeout;
    const clearTimer = hooks.clearTimer ?? clearTimeout;
    /** The committed tier. */
    let current = hooks.current ?? null;
    /** The tier last asked for. */
    let wanted = current;
    /** A tier the modules hold that is not committed yet (null: none). */
    let staged = null;
    let active = false;
    /** @type {Promise<void>} */
    let run = Promise.resolve();

    function report(phase, err) {
        try { hooks.onError?.(phase, err); } catch { /* reporting must not break the switch */ }
    }

    function call(phase, fn, cfg) {
        try {
            return fn?.(cfg);
        } catch (err) {
            report(phase, err);
            return undefined;
        }
    }

    /** The compile, bounded by timeoutMs; never rejects. */
    function bounded(p) {
        if (!p || typeof p.then !== 'function') return Promise.resolve();
        let timer = null;
        const out = Promise.race([
            Promise.resolve(p).then(() => {}, (err) => report('compile', err)),
            new Promise((resolve) => { timer = setTimer(resolve, timeoutMs); }),
        ]);
        return out.then(() => { clearTimer(timer); });
    }

    async function loop() {
        active = true;
        let paused = false;
        try {
            for (;;) {
                const cfg = wanted;
                if (cfg === current && staged === null) return;
                if (staged === null && same(current, cfg)) {
                    // Nothing to compile: everything at once, as a plain DPR change.
                    call('stage', hooks.stage, cfg);
                    call('commit', hooks.commit, cfg);
                    current = cfg;
                    continue;
                }
                if (!paused) {
                    call('pause', hooks.pause);
                    paused = true;
                }
                staged = cfg;
                call('stage', hooks.stage, cfg);
                await bounded(call('compile', hooks.compile, cfg));
                // A newer request: stage it before anything is drawn (this one is never committed).
                if (wanted !== cfg) continue;
                call('commit', hooks.commit, cfg);
                current = cfg;
                staged = null;
            }
        } finally {
            active = false;
            if (paused) call('resume', hooks.resume);
        }
    }

    return {
        /**
         * Asks for a tier. Applied at once when it has the current variants, otherwise staged;
         * resolves once every tier asked for so far is committed. Never rejects.
         * @param {object} cfg TierCfg
         */
        request(cfg) {
            if (!cfg) return run;
            wanted = cfg;
            if (!active) run = loop();
            return run;
        },
        /** The committed tier. */
        get current() { return current; },
        /** The tier staged and compiling (not drawn yet), or null. */
        get staged() { return staged; },
        /** True while a staged switch holds drawing. */
        get pending() { return active && staged !== null; },
    };
}
