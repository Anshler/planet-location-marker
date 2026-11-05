/**
 * Standing on Mars (ROADMAP stand-on-mars, phase 1): the wiring between the store's `host` slice,
 * the frame loop and the render stack. Loaded by main.js (dynamic import) the first time the host
 * is Mars, so the Earth-only visit never downloads it; render/mars-sky.js is imported from here
 * once a renderer exists.
 *
 * enter():  the loop computes Mars snapshots (astro/host-mars.js), the render modules hear
 *           setHost('mars') (ground: Mars colours; bodies: the Earth in slot 4 and the Moon as a
 *           glyph; edge chips: names), the Earth-only groups main.js keeps in R.earthGroups (the
 *           globe, its atmosphere and aurora, beams, pins, paths, meteors, comets, spacecraft) hide,
 *           and the Mars sky (dome, Phobos and Deimos, the light from home) is added once.
 * leave():  the reverse; the Mars sky module stays loaded but draws nothing on Earth.
 * Idempotent: main.js calls enter() again once the render stack exists (a `host=mars` link boots
 * the loop before the renderer).
 *
 * @module app/mars-host
 */
import { computeMarsSnapshot, createMarsMoonsProvider } from '../astro/host-mars.js';

/**
 * @param {{store:any, loop:any, extras?:any, R:any, getLayers?:()=>object}} deps
 *   `R` is main.js's runtime registry (rc, mods, earthGroups); `getLayers` the layers as drawn.
 * @returns {{enter():void, leave():void, siteChanged():void, readonly active:boolean}}
 */
export function createMarsHost({ store, loop, extras = null, R, getLayers = () => store.get().layers }) {
    let active = false;
    let offProvider = null;
    let sky = null;
    let skyP = null;
    const compute = {
        compute(t, out, opt) {
            computeMarsSnapshot(t, store.get().host, out, opt);
        },
    };

    function showEarth(on) {
        for (const g of R.earthGroups ?? []) g.visible = on;
    }

    function loadSky() {
        if (skyP || !R.rc) return;
        skyP = import('../render/mars-sky.js').then((m) => {
            const rc = R.rc;
            sky = m.createMarsSky(rc, { reducedMotion: !!store.get().status.reducedMotion });
            rc.scene.add(sky.object3d);
            loop.replaceModule(null, sky, 'marsSky');
            R.mods.marsSky = sky;
            loop.callModule(sky, 'setLayers', getLayers());
            loop.invalidate();
        }).catch((err) => {
            console.error('[mars] the Mars sky could not be loaded', err);
        });
    }

    return {
        enter() {
            if (extras && !offProvider) {
                try { offProvider = extras.register(createMarsMoonsProvider()); } catch (err) { console.error('[mars] moons provider', err); }
            }
            active = true;
            loop.setHost(compute);
            loop.broadcast('setHost', 'mars');
            showEarth(false);
            loadSky();
            loop.invalidate();
        },
        leave() {
            if (!active) return;
            active = false;
            loop.setHost(null);
            loop.broadcast('setHost', 'earth');
            showEarth(true);
            loop.invalidate();
        },
        /** A new Mars site: both snapshots are recomputed. */
        siteChanged() {
            if (active) loop.setHost(compute);
        },
        get active() { return active; },
    };
}
