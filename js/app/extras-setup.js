/**
 * Registers the extra-object providers (astro/extras.js) at boot: the guest stars and Halley's
 * Comet at once (their data is in the code), the spacecraft once data/craft.json has arrived
 * (fetched at boot, off the critical path; the service worker precaches it, so it works offline
 * from the first visit on). No three.js, no DOM.
 *
 * Later kinds (catalogue stars 'star:', deep-sky objects 'dso:') register the same way:
 * `extras.register(provider)` whenever their data is ready.
 *
 * @module app/extras-setup
 */

import { createGuestProvider } from '../astro/guest-stars.js';
import { createCometProvider } from '../astro/comets.js';
import { createCraftProvider, decodeCraft } from '../astro/craft.js';

/** The spacecraft ephemerides (scripts/build-craft.mjs). */
export const CRAFT_URL = 'data/craft.json';

/**
 * @param {ReturnType<import('../astro/extras.js').createExtras>} extras
 * @param {{fetchJson:(url:string)=>Promise<any>}} deps `fetchJson` resolves null on failure
 * @returns {Promise<boolean>} resolves once the spacecraft are registered (false without them)
 */
export function registerExtras(extras, { fetchJson }) {
    try {
        extras.register(createGuestProvider());
        extras.register(createCometProvider());
    } catch (err) {
        console.error('[extras] providers failed', err);
    }
    return fetchJson(CRAFT_URL).then((json) => {
        if (!json) return false;
        try {
            extras.register(createCraftProvider(decodeCraft(json)));
            return true;
        } catch (err) {
            console.error('[extras] data/craft.json could not be decoded', err);
            return false;
        }
    });
}
