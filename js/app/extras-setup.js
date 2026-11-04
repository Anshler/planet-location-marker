/**
 * Registers the extra-object providers (astro/extras.js) at boot: the guest stars and Halley's
 * Comet at once (their data is in the code), the spacecraft once data/craft.json has arrived and the
 * deep-sky objects once data/dso.json has (both fetched at boot, off the critical path; the service
 * worker precaches them, so they work offline from the first visit on, text mode included). No
 * three.js, no DOM.
 *
 * Catalogue stars ('star:<hip>') register with `registerStars` once the sky catalogue is decoded:
 * their provider keeps a registry slot only for the star being looked at (astro/stars.js), follows
 * the selection (`syncStarSelection`), and fetches data/starinfo.json (designations, parallaxes)
 * the first time a star is selected (precached by the service worker too).
 *
 * @module app/extras-setup
 */

import { createGuestProvider } from '../astro/guest-stars.js';
import { createCometProvider } from '../astro/comets.js';
import { createCraftProvider, decodeCraft } from '../astro/craft.js';
import { createDsoProvider, decodeDso } from '../astro/dso.js';
import { createStarProvider } from '../astro/stars.js';
import { decodeStarInfo } from '../data/starinfo.js';

/** The spacecraft ephemerides (scripts/build-craft.mjs). */
export const CRAFT_URL = 'data/craft.json';
/** The deep-sky showpieces (scripts/build-dso.mjs). */
export const DSO_URL = 'data/dso.json';
/** Star designations and parallaxes (scripts/build-sky.mjs). */
export const STARINFO_URL = 'data/starinfo.json';

/**
 * @param {ReturnType<import('../astro/extras.js').createExtras>} extras
 * @param {{fetchJson:(url:string)=>Promise<any>, onDso?:(provider:any)=>void}} deps `fetchJson`
 *   resolves null on failure; `onDso` receives the deep-sky provider (render/dso.js draws its list)
 * @returns {Promise<boolean>} resolves once the spacecraft and deep-sky objects are in (false if either is missing)
 */
export function registerExtras(extras, { fetchJson, onDso = () => {} }) {
    try {
        extras.register(createGuestProvider());
        extras.register(createCometProvider());
    } catch (err) {
        console.error('[extras] providers failed', err);
    }
    const craft = fetchJson(CRAFT_URL).then((json) => {
        if (!json) return false;
        try {
            extras.register(createCraftProvider(decodeCraft(json)));
            return true;
        } catch (err) {
            console.error('[extras] data/craft.json could not be decoded', err);
            return false;
        }
    });
    const dso = fetchJson(DSO_URL).then((json) => {
        if (!json) return false;
        try {
            const p = createDsoProvider(decodeDso(json));
            extras.register(p);
            onDso(p);
            return true;
        } catch (err) {
            console.error('[extras] data/dso.json could not be decoded', err);
            return false;
        }
    });
    return Promise.all([craft, dso]).then(([a, b]) => a && b);
}

/**
 * Registers the catalogue-star provider.
 * @param {ReturnType<import('../astro/extras.js').createExtras>} extras
 * @param {{getCatalog:()=>any, fetchJson:(url:string)=>Promise<any>, onInfo?:()=>void}} deps
 *   `getCatalog` the current SkyCatalog; `onInfo` runs once data/starinfo.json is decoded
 * @returns {{provider:ReturnType<typeof createStarProvider>, sync(selection:string|null):void}}
 */
export function registerStars(extras, { getCatalog, fetchJson, onInfo = () => {} }) {
    let info = null;
    let asked = false;
    let retryAt = 0;
    const provider = createStarProvider({
        getCatalog,
        getInfo: () => info,
        needInfo: () => {
            if (asked || info || Date.now() < retryAt) return;
            asked = true;
            fetchJson(STARINFO_URL).then((json) => {
                if (!json) { asked = false; retryAt = Date.now() + 30000; return; }
                try {
                    info = decodeStarInfo(json, getCatalog()?.srcHip ?? []);
                    extras.refresh();   // names change from 'HIP n' to 'α Orionis'
                    onInfo();
                } catch (err) {
                    console.error('[extras] data/starinfo.json could not be decoded', err);
                }
            });
        },
    });
    extras.register(provider);
    return {
        provider,
        /** Follows store.selection: a star id gets its slot (and the registry is refreshed). */
        sync(selection) {
            if (provider.track(selection ?? null)) extras.refresh();
        },
    };
}
