// Visual-regression comparison for scripts/golden.mjs (pure: no browser, no file system).
//
// A golden is a PNG of the WebGL canvas alone (the DOM interface and labels hidden), rendered by
// SwiftShader in a pinned Chrome. Two renders match when at most MAX_CHANGED_FRACTION of their
// pixels differ in luma by more than LUMA_THRESHOLD (out of 255): SwiftShader is deterministic
// for a given Chrome build, so the tolerance only absorbs rounding, while a moved beam, a missing
// layer or a shader change moves far more pixels than that. Text mode has no canvas: its golden
// is the page's structure (domSummary), compared line by line.
//
// meta.json records the Chrome version, platform and WebGL renderer the goldens were made with;
// goldenUsable() says whether this run can be judged against them at all.

/** A pixel changed when its luma moved by more than this (0–255). */
export const LUMA_THRESHOLD = 6;
/** A render fails when more than this fraction of its pixels changed. */
export const MAX_CHANGED_FRACTION = 0.005;

/**
 * Rec. 709 luma of an 8-bit sRGB pixel (0–255), on the encoded values: a perceptual-enough
 * measure for "did this pixel visibly change".
 */
export function luma(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Compares two decoded images (decodePng's {width, height, channels, data}; alpha ignored).
 * The heat map is RGB: the golden dimmed to a quarter of its luma, changed pixels from red
 * (just over the threshold) to yellow (32 levels and more).
 * @param {{width:number, height:number, channels:number, data:Uint8Array}} golden
 * @param {{width:number, height:number, channels:number, data:Uint8Array}} actual
 * @param {{threshold?:number, maxFraction?:number, heat?:boolean}} [opts]
 * @returns {{ok:boolean, reason:string|null, changed:number, total:number, fraction:number, maxDelta:number,
 *   heat:Uint8Array|null, width:number, height:number}}
 */
export function compareImages(golden, actual, { threshold = LUMA_THRESHOLD, maxFraction = MAX_CHANGED_FRACTION, heat = true } = {}) {
    const { width, height } = golden;
    if (actual.width !== width || actual.height !== height) {
        return { ok: false, reason: `size ${actual.width}×${actual.height}, golden ${width}×${height}`, changed: 0,
            total: width * height, fraction: 1, maxDelta: 255, heat: null, width, height };
    }
    const ca = golden.channels, cb = actual.channels;
    if (ca < 3 || cb < 3) throw new RangeError('compareImages: RGB or RGBA images only');
    const total = width * height;
    const out = heat ? new Uint8Array(total * 3) : null;
    let changed = 0, maxDelta = 0;
    for (let i = 0; i < total; i++) {
        const a = i * ca, b = i * cb;
        const la = luma(golden.data[a], golden.data[a + 1], golden.data[a + 2]);
        const d = Math.abs(luma(actual.data[b], actual.data[b + 1], actual.data[b + 2]) - la);
        if (d > maxDelta) maxDelta = d;
        if (!out) {
            if (d > threshold) changed++;
            continue;
        }
        const o = i * 3;
        if (d > threshold) {
            changed++;
            const k = Math.min(1, (d - threshold) / 32);
            out[o] = 255;
            out[o + 1] = Math.round(48 + 207 * k);
            out[o + 2] = 0;
        } else {
            const v = Math.round(la * 0.25);
            out[o] = v; out[o + 1] = v; out[o + 2] = v;
        }
    }
    const fraction = changed / total;
    const ok = fraction <= maxFraction;
    return { ok, reason: ok ? null : `${(fraction * 100).toFixed(2)} % of pixels changed (max ${(maxFraction * 100).toFixed(2)} %)`,
        changed, total, fraction, maxDelta: Math.round(maxDelta * 10) / 10, heat: out, width, height };
}

/**
 * Whether goldens made under `meta` can judge a run in `env`. A golden is only meaningful for
 * the browser build and renderer that made it, so anything else is a skip with a reason, never
 * a failure: no goldens yet, another Chrome version, another platform, another WebGL renderer
 * (`env.renderer` may be null before the first WebGL scene has reported it).
 * @param {object|null} meta test/golden/meta.json, or null when missing
 * @param {{chrome:string, platform:string, renderer?:string|null}} env
 * @returns {{usable:boolean, reason:string|null}}
 */
export function goldenUsable(meta, env) {
    if (!meta || typeof meta !== 'object' || !meta.scenes) return { usable: false, reason: 'no goldens (test/golden/meta.json is missing)' };
    if (meta.chrome !== env.chrome) return { usable: false, reason: `goldens were made with Chrome ${meta.chrome}, this is ${env.chrome}` };
    if (meta.platform !== env.platform) return { usable: false, reason: `goldens were made on ${meta.platform}, this is ${env.platform}` };
    if (env.renderer && meta.renderer && meta.renderer !== env.renderer) {
        return { usable: false, reason: `goldens were made with the renderer '${meta.renderer}', this is '${env.renderer}'` };
    }
    return { usable: true, reason: null };
}

/**
 * Runs in the page (scripts/golden.mjs evaluates `(${domSummary})()`): the text-mode page's
 * structure, one line per element that has an id, a role or an aria-label, indented by depth.
 * A hidden one is marked and its subtree left out (closed dialogs and menus are not what text
 * mode shows). Text content is left out, and digits in labels are masked.
 * @returns {string[]}
 */
export function domSummary() {
    const lines = [];
    const walk = (el, depth) => {
        for (const c of el.children) {
            if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE' || c.tagName === 'TEMPLATE') continue;
            const id = c.id, role = c.getAttribute('role'), label = c.getAttribute('aria-label');
            const marked = !!(id || role || label);
            const vis = typeof c.checkVisibility === 'function' ? c.checkVisibility({ visibilityProperty: true }) : c.getClientRects().length > 0;
            if (marked) {
                lines.push(`${'  '.repeat(depth)}${c.tagName.toLowerCase()}${id ? `#${id}` : ''}${role ? `[role=${role}]` : ''}`
                    + `${label ? ` "${label.replace(/\d/g, '#')}"` : ''}${vis ? '' : ' (hidden)'}`);
            }
            if (vis) walk(c, marked ? depth + 1 : depth);
        }
    };
    walk(document.body, 0);
    return lines;
}

/**
 * Line diff of two structure summaries (golden first): the lines only one of them has, as
 * '- line' (golden only) and '+ line' (this run only), in order, at most `max`.
 * @param {string[]} golden
 * @param {string[]} actual
 * @param {number} [max=20]
 * @returns {string[]} empty when they match
 */
export function diffLines(golden, actual, max = 20) {
    // Longest common subsequence over lines (summaries are a few hundred lines at most).
    const n = golden.length, m = actual.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) L[i][j] = golden[i] === actual[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while ((i < n || j < m) && out.length < max) {
        if (i < n && j < m && golden[i] === actual[j]) { i++; j++; continue; }
        if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push(`+ ${actual[j++]}`);
        else out.push(`- ${golden[i++]}`);
    }
    return out;
}
