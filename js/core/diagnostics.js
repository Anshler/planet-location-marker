// The 'Copy diagnostics' report (context-loss-backoff-and-diagnostics): one JSON blob a user can
// paste into an issue instead of "it's blank". Built on demand only (About → Copy diagnostics,
// actions.copyDiagnostics); nothing is sent anywhere and nothing runs at boot.
//
// Privacy: the observer's place never goes in. The URL hash keeps only the keys in
// DIAG_HASH_KEYS, so the location, its name, country, zone and elevation, the second place, the
// Mars site and the camera (its sub-point sits over the observer) are dropped, and URL fragments,
// queries and loc= pairs are cut out of the error messages.

/** URL-hash keys (core/url-state.js) a report keeps; every other key is dropped. */
export const DIAG_HASH_KEYS = Object.freeze(['t', 'r', 'p', 'view', 'lock', 'sel', 'ly', 'q', 'sky', 'au', 'trk', 'vt', 'host',
    'intro', 'debug', 'tour']);
/** The newest errors a report carries, and the longest one kept. */
export const DIAG_MAX_ERRORS = 20;
const ERROR_CHARS = 800;

/**
 * The hash with the allowed keys only, as {key: value}.
 * @param {string} hash location.hash ('#…' or '')
 * @returns {Record<string, string>}
 */
export function diagHash(hash) {
    const out = {};
    for (const part of String(hash ?? '').replace(/^#/, '').split('&')) {
        const i = part.indexOf('=');
        const k = i < 0 ? part : part.slice(0, i);
        let v = i < 0 ? '' : part.slice(i + 1);
        try { v = decodeURIComponent(v); } catch { /* keep it raw */ }
        if (DIAG_HASH_KEYS.includes(k)) out[k] = v.slice(0, 64);
    }
    return out;
}

/**
 * An error line without URL fragments, queries or loc= pairs, at most 800 characters.
 * @param {unknown} e
 * @returns {string}
 */
export function scrubError(e) {
    return String(e ?? '').replace(/#[^\s'"`)<>]*/g, '#').replace(/\?[^\s'"`)<>:]*/g, '?')
        .replace(/\b(h?loc2?|cam)=[^&\s]*/g, '$1=…').slice(0, ERROR_CHARS);
}

const num = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/**
 * Builds the report from what main.js gathers. Every field is optional; the output has a fixed
 * shape and holds no location (see the module notes).
 * @param {{version?:string, nowMs?:number, decision?:any, quality?:any, renderer?:string, maxTex?:number,
 *   dpr?:number, renderDpr?:number, viewport?:number[], coarse?:boolean, userAgent?:string, webgl?:boolean,
 *   governor?:any, tierLog?:any[], strikes?:Record<string, number>, disabled?:string[], losses?:any,
 *   errors?:unknown[], stats?:any, hash?:string, sw?:{version?:string|null, controlled?:boolean, waiting?:string|null}}} d
 *   `sw`: the service worker serving the page (`__app.sw`): which deploy the report comes from.
 * @returns {object}
 */
export function buildDiagnostics(d = {}) {
    const q = d.quality ?? {};
    const g = d.governor ?? null;
    const dec = d.decision ?? {};
    const errors = Array.isArray(d.errors) ? d.errors.slice(-DIAG_MAX_ERRORS).map(scrubError) : [];
    return {
        app: {
            version: d.version ?? null, at: Number.isFinite(d.nowMs) ? new Date(d.nowMs).toISOString() : null,
            sw: d.sw ? { version: d.sw.version ?? null, controlled: !!d.sw.controlled, waiting: d.sw.waiting ?? null } : null,
        },
        tier: {
            decision: { tier: dec.tier ?? null, ceiling: dec.ceiling ?? null, reason: dec.reason ?? null },
            setting: q.setting ?? null, active: q.active ?? null,
            governor: g ? {
                start: g.start ?? null, pinned: g.pinned ?? null, dprCap: num(g.dprCap), budgetMs: num(g.budgetMs, 1), cadenceMs: num(g.cadenceMs, 1),
            } : null,
            steps: Array.isArray(d.tierLog) ? d.tierLog.slice(-DIAG_MAX_ERRORS) : [],
        },
        device: {
            renderer: d.renderer || null, maxTex: Number.isFinite(d.maxTex) && d.maxTex > 0 ? d.maxTex : null, dpr: num(d.dpr),
            renderDpr: num(d.renderDpr), viewport: Array.isArray(d.viewport) ? d.viewport.map((v) => Math.round(v)) : null,
            coarse: !!d.coarse, webgl: d.webgl !== false, userAgent: d.userAgent ? String(d.userAgent).slice(0, 300) : null,
        },
        modules: { disabled: Array.isArray(d.disabled) ? d.disabled : [], strikes: d.strikes ?? {} },
        contextLosses: {
            count: Number.isInteger(d.losses?.n) ? d.losses.n : 0, cap: d.losses?.cap ?? null, textMode: d.losses?.text === true,
        },
        errors,
        stats: d.stats ?? null,
        hash: diagHash(d.hash),
    };
}
