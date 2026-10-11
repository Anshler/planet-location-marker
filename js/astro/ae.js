/**
 * Single gateway to the vendored astronomy-engine 2.1.19 (MIT, Don Cross).
 *
 * Every pure module reaches astronomy-engine through this file, and always by a
 * relative path: importmaps do not apply inside Web Workers or Node, so a bare
 * specifier here would break the almanac worker and the test suite.
 *
 * Time convention used across js/astro: astronomy-engine is fed UT only, via
 * `AE.MakeTime(new Date(utcMs))`; it applies its own ΔT internally. Never pass TT.
 *
 * @module astro/ae
 */
export * as AE from '../../vendor/astronomy-engine/astronomy.js';
