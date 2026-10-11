/**
 * View switch cluster: the `Globe | Sky` segmented control, Earth-lock (Globe
 * only), Share, Fullscreen and Help. On mobile it becomes a floating column
 * (Globe/Sky, lock, share).
 *
 * Owns the share UX (SPEC F.4): `actions.share()` → 'shared' (system sheet, no
 * toast) | 'copied' ("Link copied") | 'failed' (a dialog with a selectable link
 * and a Copy button). Under reduced motion, view and place changes are cuts, so
 * a 200 ms fade overlay softens them.
 *
 * @module ui/view-switch
 */

import { h, on, setAttr, trapFocus } from './dom.js';
import { icon, swapIcon } from './icons.js';

/**
 * Mounts the view switch.
 * @param {HTMLElement} root `.viewbar`
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountViewSwitch(root, ctx) {
    const { store, ui, bus } = ctx;
    const offs = [];

    // ---------------------------------------------------------------- Globe | Sky
    const globeBtn = h('button', { class: 'seg__btn', type: 'button', role: 'radio', 'aria-checked': 'true', 'data-mode': 'orbit', 'data-tip': 'Globe view', 'data-kbd': 'V' },
        icon('globe', { size: 18 }), h('span', { class: 'seg__label' }, 'Globe'));
    const skyBtn = h('button', { class: 'seg__btn', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-mode': 'sky', 'data-tip': 'Stand here and look up', 'data-kbd': 'V' },
        icon('sky', { size: 18 }), h('span', { class: 'seg__label' }, 'Sky'));
    const seg = h('div', { class: 'seg seg--view glass', role: 'radiogroup', 'aria-label': 'View' }, globeBtn, skyBtn);
    const lockBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-lock', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Lock view to Earth', 'data-tip': 'Lock view to Earth', 'data-kbd': 'L' },
        icon('lock', { size: 19 }));
    const shareBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-share', type: 'button', 'aria-label': 'Share a link to this view', 'data-tip': 'Share link', 'data-kbd': 'S' },
        icon('share', { size: 19 }));
    const fsBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-fs', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Fullscreen', 'data-tip': 'Fullscreen', 'data-kbd': 'F' },
        icon('fullscreen', { size: 19 }));
    const helpBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-help', type: 'button', 'aria-label': 'Keyboard shortcuts and help', 'data-tip': 'Shortcuts', 'data-kbd': '?' },
        icon('help', { size: 19 }));
    root.append(seg, lockBtn, shareBtn, fsBtn, helpBtn);
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'View');

    const setMode = (mode) => {
        if (store.get().view?.mode === mode) return;
        ui.act('setViewMode', mode);
    };
    offs.push(on(globeBtn, 'click', () => setMode('orbit')));
    offs.push(on(skyBtn, 'click', () => setMode('sky')));
    offs.push(on(seg, 'keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const next = store.get().view?.mode === 'sky' ? 'orbit' : 'sky';
        setMode(next);
        (next === 'sky' ? skyBtn : globeBtn).focus();
    }));
    offs.push(on(lockBtn, 'click', () => ui.act('setEarthLock', !store.get().view?.earthLock)));
    offs.push(on(fsBtn, 'click', () => ui.act('toggleFullscreen')));
    offs.push(on(helpBtn, 'click', () => ui.toggleHelp(true)));
    offs.push(on(shareBtn, 'click', () => ui.share()));
    if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) fsBtn.hidden = true;

    function syncView() {
        const v = store.get().view || {};
        const sky = v.mode === 'sky';
        setAttr(globeBtn, 'aria-checked', String(!sky));
        setAttr(skyBtn, 'aria-checked', String(sky));
        globeBtn.tabIndex = sky ? -1 : 0;
        skyBtn.tabIndex = sky ? 0 : -1;
        globeBtn.classList.toggle('is-on', !sky);
        skyBtn.classList.toggle('is-on', sky);
        seg.dataset.mode = sky ? 'sky' : 'orbit';
        lockBtn.hidden = sky;
        setAttr(lockBtn, 'aria-pressed', String(!!v.earthLock));
        swapIcon(lockBtn, v.earthLock ? 'lock' : 'unlock', 19);
        lockBtn.dataset.tip = v.earthLock ? 'View locked to Earth' : 'View free — lock to Earth';
        lockBtn.classList.toggle('is-on', !!v.earthLock);
    }
    offs.push(store.subscribe((s) => s.view, syncView, { immediate: true }));

    const syncFs = () => {
        const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        setAttr(fsBtn, 'aria-pressed', String(fs));
        swapIcon(fsBtn, fs ? 'fullscreen-exit' : 'fullscreen', 19);
        fsBtn.dataset.tip = fs ? 'Exit fullscreen' : 'Fullscreen';
    };
    offs.push(on(document, 'fullscreenchange', syncFs));
    offs.push(on(document, 'webkitfullscreenchange', syncFs));
    syncFs();

    // ---------------------------------------------------------------- reduced-motion fade
    const fade = h('div', { class: 'fade-overlay', 'aria-hidden': 'true' });
    (ui.root || document.body).appendChild(fade);
    let fadeTimer = 0;
    const flashFade = () => {
        if (!ui.reducedMotion()) return;
        fade.classList.remove('is-on');
        void fade.offsetWidth;
        fade.classList.add('is-on');
        clearTimeout(fadeTimer);
        fadeTimer = setTimeout(() => fade.classList.remove('is-on'), 220);
    };
    offs.push(store.subscribe((s) => s.view?.mode, flashFade));
    offs.push(store.subscribe((s) => s.observer, flashFade));

    // ---------------------------------------------------------------- share
    const urlInput = h('input', { class: 'input input--url', type: 'text', readonly: true, 'aria-label': 'Link to this view', spellcheck: 'false' });
    const copyBtn = h('button', { class: 'btn btn--primary', type: 'button' }, icon('copy', { size: 16 }), 'Copy');
    const copyMsg = h('p', { class: 'share__msg', role: 'status' });
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, icon('close', { size: 18 }));
    const dialog = h('div', { class: 'dialog share glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title' },
        h('header', { class: 'dialog__head' }, h('h2', { class: 'dialog__title', id: 'share-title' }, icon('share', { size: 20 }), 'Share this view'), closeBtn),
        h('p', { class: 'prose' }, 'This link opens exactly what you see: the place, the time, the view and the layers.'),
        h('div', { class: 'share__row' }, urlInput, copyBtn),
        copyMsg);
    const layer = h('div', { class: 'modal-layer share-layer', hidden: true }, h('div', { class: 'modal-backdrop' }), dialog);
    (ui.root || document.body).appendChild(layer);
    let release = null;
    const closeShare = () => {
        if (layer.hidden) return;
        layer.hidden = true;
        layer.classList.remove('is-open');
        release?.(); release = null;
    };
    function openShare(url) {
        urlInput.value = url;
        copyMsg.textContent = '';
        layer.hidden = false;
        layer.classList.add('is-open');
        release = trapFocus(dialog, { initial: urlInput });
        requestAnimationFrame(() => urlInput.select());
    }
    offs.push(on(closeBtn, 'click', closeShare));
    offs.push(on(layer.querySelector('.modal-backdrop'), 'click', closeShare));
    offs.push(on(dialog, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeShare(); } }));
    offs.push(on(urlInput, 'focus', () => urlInput.select()));
    offs.push(on(copyBtn, 'click', async () => {
        urlInput.select();
        let ok = false;
        try { await navigator.clipboard.writeText(urlInput.value); ok = true; } catch { ok = false; }
        if (!ok) { try { ok = document.execCommand?.('copy') === true; } catch { ok = false; } }
        copyMsg.textContent = ok ? 'Link copied.' : `Press ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+C to copy the selected link.`;
    }));

    /** Share flow shared by the button and the S shortcut. */
    async function share() {
        let url = String(globalThis.location?.href || '');
        try { url = ctx.actions?.shareUrl?.() || url; } catch { /* keep location.href */ }
        let result;
        if (typeof ctx.actions?.share === 'function') {
            try { result = await ctx.actions.share(); } catch { result = 'failed'; }
        } else {
            try { await navigator.clipboard.writeText(url); result = 'copied'; } catch { result = 'failed'; }
        }
        if (result === 'copied') bus.emit('toast', { message: 'Link copied', kind: 'info', timeoutMs: 2500 });
        else if (result === 'failed') openShare(url);
        return result;
    }
    ui.share = share;

    return {
        destroy() {
            offs.forEach((off) => off());
            clearTimeout(fadeTimer);
            release?.();
            layer.remove();
            fade.remove();
            root.textContent = '';
        },
    };
}
