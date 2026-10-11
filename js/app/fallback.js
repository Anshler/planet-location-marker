// Degraded-mode surfaces (SPEC §E.8 failure matrix).
//
//   showFallback(reason)   the "3D view isn't available" banner for text mode (no WebGL2, no import
//                          maps, or a renderer that died). The UI keeps running without a canvas.
//   showContextLost()      a non-blocking overlay while the GPU context is being restored.
//   hideContextLost()
//   showFatal(err)         hands an unrecoverable boot error to the inline loader in index.html.
//
// Everything here is self-styled (one injected <style>), so it still reads correctly when
// css/app.css failed to load, and nothing here imports three.js: text mode must work in browsers
// that cannot even resolve the 'three' import-map entry.

import { APP_NAME } from '../version.js';

const STYLE_ID = 'pc-fallback-style';
const BANNER_ID = 'pc-fallback';
const LOST_ID = 'pc-context-lost';
/** After this long without a 'restored' event the overlay offers a reload. */
const LOST_RELOAD_AFTER_MS = 8000;

/** @typedef {'no-webgl2'|'no-importmap'|'context-failed'} FallbackReason */

const COPY = {
    'no-webgl2': {
        title: "3D view isn't available on this device — the sky tables below still work.",
        detail: 'Your browser or graphics driver does not provide WebGL 2, which the globe needs.',
        reload: false,
    },
    'no-importmap': {
        title: "3D view isn't available on this device — the sky tables below still work.",
        detail: 'This browser is too old to load the 3D engine. Updating it will bring the globe back.',
        reload: false,
    },
    'context-failed': {
        title: 'The 3D view stopped working — the sky tables below still work.',
        detail: 'The graphics context could not be created or kept alive. Reloading the page may restore it.',
        reload: true,
    },
};

const CSS = `
.pc-fb{position:relative;z-index:1200;margin:calc(16px + env(safe-area-inset-top,0px)) auto 0;
 width:min(748px,calc(100vw - 32px));box-sizing:border-box;display:flex;gap:12px;align-items:flex-start;padding:12px 12px 12px 14px;
 border-radius:12px;background:rgba(12,16,26,.94);border:1px solid rgba(255,204,102,.35);color:#e8edf6;
 font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.pc-fb__icon{flex:none;width:20px;height:20px;margin-top:1px;color:#ffcc66}
.pc-fb__body{flex:1;min-width:0}
.pc-fb__title{margin:0;font-weight:600}
.pc-fb__detail{margin:4px 0 0;color:#9aa6b8;font-size:13px}
.pc-fb__actions{display:flex;gap:8px;margin-top:8px}
.pc-fb button{font:inherit;font-size:13px;color:#e8edf6;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);
 border-radius:8px;padding:5px 10px;cursor:pointer}
.pc-fb button:hover{background:rgba(255,255,255,.12)}
.pc-fb button:focus-visible,.pc-cl button:focus-visible{outline:2px solid #7cc4ff;outline-offset:2px}
.pc-fb__close{flex:none;width:28px;height:28px;padding:0!important;display:grid;place-items:center;line-height:1}
.pc-cl{position:fixed;inset:0;z-index:1500;display:grid;place-items:center;pointer-events:none;
 background:radial-gradient(ellipse at center,rgba(3,6,13,.55),rgba(3,6,13,.82));
 font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8edf6}
.pc-cl__box{display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px 24px;border-radius:16px;
 background:rgba(12,16,26,.9);border:1px solid rgba(255,255,255,.08);box-shadow:0 12px 32px rgba(0,0,0,.45);text-align:center}
.pc-cl__spin{width:28px;height:28px;border-radius:50%;border:2px solid rgba(124,196,255,.22);border-top-color:#7cc4ff;
 animation:pc-cl-spin 1s linear infinite}
.pc-cl button{pointer-events:auto;font:inherit;font-size:13px;color:#03060d;background:#7cc4ff;border:0;border-radius:8px;
 padding:6px 14px;cursor:pointer}
@keyframes pc-cl-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.pc-cl__spin{animation:none;border-top-color:rgba(124,196,255,.22)}}
`;

const WARN_ICON = '<svg class="pc-fb__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"/>'
    + '<path d="M12 10v5"/><path d="M12 18h.01"/></svg>';

/** Injects the shared stylesheet once. */
function ensureStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

/**
 * Small element factory (text content only, never HTML from data).
 * @param {string} tag
 * @param {Record<string,string>} [attrs]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, text = '') {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text) e.textContent = text;
    return e;
}

/**
 * Switches the page to text mode and shows the explanatory banner. Idempotent: a second call
 * only updates the wording (e.g. 'no-webgl2' at boot, then never again).
 *
 * Text mode means: body gets `no-webgl` (G7 lays the panels out over a plain background, Sky Now
 * prominent), the canvas and label layer are hidden, and the loader is dismissed by main.js.
 *
 * @param {FallbackReason} reason
 * @returns {HTMLElement|null} the banner element
 */
export function showFallback(reason) {
    if (typeof document === 'undefined' || !document.body) return null;
    const copy = COPY[reason] ?? COPY['no-webgl2'];
    ensureStyle();
    document.body.classList.add('no-webgl');
    const canvas = document.getElementById('scene');
    if (canvas) canvas.setAttribute('aria-hidden', 'true');

    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
        banner = el('div', { id: BANNER_ID, class: 'pc-fb', role: 'status', 'data-reason': reason });
        // In the flow above the interface (text mode scrolls as a document), never over the top bar.
        const root = document.getElementById('ui-root');
        if (root) document.body.insertBefore(banner, root);
        else document.body.appendChild(banner);
    }
    banner.dataset.reason = reason;
    banner.replaceChildren();
    banner.insertAdjacentHTML('afterbegin', WARN_ICON);

    const body = el('div', { class: 'pc-fb__body' });
    body.append(el('p', { class: 'pc-fb__title' }, copy.title), el('p', { class: 'pc-fb__detail' }, copy.detail));
    if (copy.reload) {
        const actions = el('div', { class: 'pc-fb__actions' });
        const reload = el('button', { type: 'button' }, 'Reload');
        reload.addEventListener('click', () => location.reload());
        actions.append(reload);
        body.append(actions);
    }
    const close = el('button', { type: 'button', class: 'pc-fb__close', 'aria-label': 'Dismiss this message' }, '×');
    close.addEventListener('click', () => banner.remove());
    banner.append(body, close);
    return banner;
}

let lostTimer = 0;

/**
 * Shows the "Graphics were reset — restoring…" overlay. It never blocks the panels (pointer-events
 * pass through) because the sky tables keep working while the GPU context is gone. If the browser
 * has not restored the context after a few seconds, a Reload button appears.
 */
export function showContextLost() {
    if (typeof document === 'undefined' || !document.body) return;
    ensureStyle();
    let box = document.getElementById(LOST_ID);
    if (!box) {
        box = el('div', { id: LOST_ID, class: 'pc-cl', role: 'status', 'aria-live': 'polite' });
        const inner = el('div', { class: 'pc-cl__box' });
        inner.append(el('div', { class: 'pc-cl__spin', 'aria-hidden': 'true' }), el('p', { class: 'pc-cl__msg' }, 'Graphics were reset — restoring…'));
        box.append(inner);
        document.body.appendChild(box);
    }
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
        const inner = box.querySelector('.pc-cl__box');
        if (!inner || inner.querySelector('button')) return;
        const msg = inner.querySelector('.pc-cl__msg');
        if (msg) msg.textContent = 'The graphics context has not come back yet.';
        const reload = el('button', { type: 'button' }, 'Reload');
        reload.addEventListener('click', () => location.reload());
        inner.append(reload);
    }, LOST_RELOAD_AFTER_MS);
}

/** Removes the context-lost overlay (after 'webglcontextrestored'). */
export function hideContextLost() {
    clearTimeout(lostTimer);
    lostTimer = 0;
    if (typeof document === 'undefined') return;
    document.getElementById(LOST_ID)?.remove();
}

/**
 * Reports an unrecoverable boot failure through the inline loader (index.html installs
 * `window.__pcLoader`). Falls back to a plain message if the loader script is missing.
 * @param {unknown} err
 */
export function showFatal(err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err ?? 'Unknown error');
    const loader = typeof window !== 'undefined' ? window.__pcLoader : null;
    if (loader && typeof loader.fatal === 'function') {
        loader.fatal(detail);
        return;
    }
    if (typeof document === 'undefined' || !document.body) return;
    ensureStyle();
    const box = el('div', { class: 'pc-fb', role: 'alert' });
    box.append(el('p', { class: 'pc-fb__title' }, `Something went wrong loading ${APP_NAME}.`), el('pre', { class: 'pc-fb__detail' }, detail));
    document.body.appendChild(box);
}
