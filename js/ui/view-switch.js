/**
 * View switch cluster: the `Globe | Sky` segmented control, Earth-lock (Globe
 * only), tracking (Sky only: off → the selected body → the stars, K), the angle ruler and 'Point at
 * the sky' (Sky only, ui/sky-tools.js), Expose (Sky only: long exposures, ui/expose.js), Share,
 * Fullscreen and Help. On mobile it becomes a floating column (Globe/Sky, lock, tracking, ruler,
 * point, expose, share).
 *
 * Vantage points (globe view): a menu button offers 'View from L1' and 'Earthrise'
 * (actions.setVantage) and the flat 'World map' (view mode 'map', M); while one is shown a caption
 * pill names it under the top bar with a way back (the map's also keys its twilight lines), and
 * 'Globe' (or Esc) returns to the globe.
 *
 * Owns the share UX (SPEC F.4): the Share button opens a two-option popover. 'Share link' is
 * `actions.share()` → 'shared' (system sheet, no toast) | 'copied' ("Link copied") | 'failed' (a
 * dialog with a selectable link and a Copy button); the S shortcut goes straight there. 'Postcard'
 * opens the postcard dialog (ui/postcard.js), which also saves long exposures; 'Video' (3D view
 * only) the time-lapse recorder's dialog (ui/video.js). Under reduced
 * motion, view and place changes are cuts, so a 200 ms fade overlay softens them.
 *
 * @module ui/view-switch
 */

import { h, on, setAttr, trapFocus, openPopover } from './dom.js';
import { icon, swapIcon } from './icons.js';
import { mountPostcard } from './postcard.js';
import { mountVideo } from './video.js';
import { mountExpose } from './expose.js';
import { mountSkyTools } from './sky-tools.js';

/** The vantage menu: [kind, name, detail]. */
const VANTAGE_ITEMS = Object.freeze([
    ['none', 'Globe', 'Orbit the Earth from close by'],
    ['map', 'World map', 'The globe unrolled: night, twilight and where each body is overhead (M)'],
    ['l1', 'View from L1', 'The sunlit Earth from 1.5 million km, as NASA’s DSCOVR sees it'],
    ['moon', 'Earthrise', 'The Earth rising over the Moon’s limb, from lunar orbit'],
]);
const VANTAGE_CAPTION = Object.freeze({
    l1: ['View from L1', '1.5 million km sunward'],
    moon: ['Earthrise', 'Lunar orbit, 150 km up · play time to watch it rise'],
    map: ['World map', 'Lines: sunset · civil · nautical · astronomical twilight · dots: overhead now'],
});
const ITEM_ICON = Object.freeze({ none: 'globe', map: 'map', l1: 'sun', moon: 'moon' });

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
    const shareBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-share', type: 'button', 'aria-label': 'Share this view', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': 'Share', 'data-kbd': 'S' },
        icon('share', { size: 19 }));
    const exposeBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-expose', type: 'button', 'aria-pressed': 'false', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Long exposure', 'data-tip': 'Long exposure' },
        icon('aperture', { size: 19 }));
    const fsBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-fs', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Fullscreen', 'data-tip': 'Fullscreen', 'data-kbd': 'F' },
        icon('fullscreen', { size: 19 }));
    const helpBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-help', type: 'button', 'aria-label': 'Keyboard shortcuts and help', 'data-tip': 'Shortcuts', 'data-kbd': '?' },
        icon('help', { size: 19 }));
    const trackBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-track', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Tracking', 'data-tip': 'Track', 'data-kbd': 'K' },
        icon('crosshair', { size: 19 }));
    const vantBtn = h('button', { class: 'icon-btn icon-btn--glass glass vb-vantage', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Vantage points', 'data-tip': 'Vantage points' },
        icon('vantage', { size: 19 }));
    const tools = mountSkyTools(ui.root || document.body, ctx);
    root.append(seg, lockBtn, vantBtn, trackBtn, tools.rulerBtn, tools.pointBtn, exposeBtn, shareBtn, fsBtn, helpBtn);
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'View');

    const setMode = (mode) => {
        const v = store.get().view;
        // 'Globe' is also the way back from a vantage point.
        if (v?.mode === mode && (v?.vantage ?? 'none') === 'none') return;
        ui.act('setViewMode', mode);
    };

    // ---------------------------------------------------------------- vantage points
    const vantItems = VANTAGE_ITEMS.map(([kind, name, detail]) => h('button', {
        class: 'vmenu__item', type: 'button', role: 'menuitemradio', 'aria-checked': 'false', 'data-kind': kind,
    }, icon(ITEM_ICON[kind] ?? 'globe', { size: 18 }),
    h('span', { class: 'vmenu__text' }, h('span', { class: 'vmenu__name' }, name), h('span', { class: 'vmenu__detail' }, detail))));
    const vantMenu = h('div', { class: 'popover vmenu', role: 'menu', 'aria-label': 'Vantage points', hidden: true }, ...vantItems);
    (ui.root || document.body).appendChild(vantMenu);
    let vantPop = null;
    const closeVant = () => { vantPop?.close(); vantPop = null; };
    offs.push(on(vantBtn, 'click', () => {
        if (vantPop) { closeVant(); return; }
        const v = store.get().view;
        const cur = v?.mode === 'map' ? 'map' : v?.vantage ?? 'none';
        for (const b of vantItems) setAttr(b, 'aria-checked', String(b.dataset.kind === cur));
        vantPop = openPopover(vantBtn, vantMenu, { placement: 'top', onClose: () => { vantPop = null; } });
    }));
    offs.push(on(vantMenu, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-kind]');
        if (!b) return;
        closeVant();
        if (b.dataset.kind === 'map') ui.act('setViewMode', 'map');
        else if (b.dataset.kind === 'none' && store.get().view?.mode === 'map') ui.act('setViewMode', 'orbit');
        else ui.act('setVantage', b.dataset.kind);
    }));
    offs.push(on(vantMenu, 'keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = vantItems.indexOf(/** @type {any} */ (document.activeElement));
        vantItems[(i + (e.key === 'ArrowDown' ? 1 : vantItems.length - 1)) % vantItems.length].focus();
    }));
    // The caption while a vantage is shown.
    const capName = h('span', { class: 'vcap__name' });
    const capDetail = h('span', { class: 'vcap__detail' });
    const capBack = h('button', { class: 'btn btn--soft vcap__back', type: 'button', 'aria-label': 'Back to the globe (Esc)', title: 'Back to the globe (Esc)' },
        icon('globe', { size: 16 }), h('span', null, 'Globe'));
    const caption = h('div', { class: 'vcap glass', role: 'status', hidden: true },
        h('span', { class: 'vcap__icon', 'aria-hidden': 'true' }, icon('vantage', { size: 18 })),
        h('span', { class: 'vcap__text' }, capName, capDetail), capBack);
    (ui.root || document.body).appendChild(caption);
    offs.push(on(capBack, 'click', () => {
        if (store.get().view?.mode === 'map') ui.act('setViewMode', 'orbit');
        else ui.act('setVantage', 'none');
    }));
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
    offs.push(on(trackBtn, 'click', () => ui.act('cycleTracking')));
    offs.push(on(fsBtn, 'click', () => ui.act('toggleFullscreen')));
    offs.push(on(helpBtn, 'click', () => ui.toggleHelp(true)));
    if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) fsBtn.hidden = true;

    function syncView() {
        const v = store.get().view || {};
        const sky = v.mode === 'sky';
        const map = v.mode === 'map';
        // The map shares the vantage caption and menu (it is another way of looking at the Earth).
        const vt = map ? 'map' : v.vantage ?? 'none';
        const noGl = store.get().status?.webgl === false;
        // In a vantage point (or the map) 'Globe' is the way back, so it reads as not selected.
        const globe = !sky && vt === 'none';
        setAttr(globeBtn, 'aria-checked', String(globe));
        setAttr(skyBtn, 'aria-checked', String(sky));
        globeBtn.tabIndex = sky ? -1 : 0;
        skyBtn.tabIndex = sky ? 0 : -1;
        globeBtn.classList.toggle('is-on', globe);
        skyBtn.classList.toggle('is-on', sky);
        seg.dataset.mode = sky ? 'sky' : 'orbit';
        vantBtn.hidden = sky || noGl;
        vantBtn.classList.toggle('is-on', vt !== 'none');
        caption.hidden = vt === 'none' || noGl;
        if (vt !== 'none' && VANTAGE_CAPTION[vt]) {
            capName.textContent = VANTAGE_CAPTION[vt][0];
            capDetail.textContent = VANTAGE_CAPTION[vt][1];
        }
        if (sky) closeVant();
        lockBtn.hidden = sky || vt !== 'none';
        setAttr(lockBtn, 'aria-pressed', String(!!v.earthLock));
        swapIcon(lockBtn, v.earthLock ? 'lock' : 'unlock', 19);
        lockBtn.dataset.tip = v.earthLock ? 'View locked to Earth' : 'View free — lock to Earth';
        lockBtn.classList.toggle('is-on', !!v.earthLock);
        const trk = v.track ?? 'none';
        trackBtn.hidden = !sky || store.get().status?.webgl === false;
        setAttr(trackBtn, 'aria-pressed', String(trk !== 'none'));
        trackBtn.classList.toggle('is-on', trk !== 'none');
        swapIcon(trackBtn, trk === 'stars' ? 'star' : 'crosshair', 19);
        const next = trk === 'none' ? (store.get().selection ? 'Track the selected body' : 'Lock to the stars')
            : trk === 'body' ? 'Tracking the body — next: lock to the stars' : 'Locked to the stars — next: tracking off';
        trackBtn.dataset.tip = next;
        setAttr(trackBtn, 'aria-label', next);
        exposeBtn.hidden = !sky || store.get().status?.webgl === false;
    }
    offs.push(store.subscribe((s) => s.view, syncView, { immediate: true }));
    offs.push(store.subscribe((s) => s.selection, syncView));

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

    // ---------------------------------------------------------------- share menu, postcard, expose
    const host = ui.root || document.body;
    const postcard = mountPostcard(host, ctx);
    ui.openPostcard = (opts) => postcard.open(opts);
    const shareOpt = (iconName, title, desc) => h('button', { class: 'share-opt', type: 'button' }, icon(iconName, { size: 20 }),
        h('span', { class: 'share-opt__text' }, h('span', { class: 'share-opt__title' }, title), h('span', { class: 'share-opt__desc' }, desc)));
    const linkOpt = shareOpt('link', 'Share link', 'Opens exactly this view: place, time, camera and layers.');
    const cardOpt = shareOpt('postcard', 'Postcard', 'A designed image of this view, ready to post.');
    const videoOpt = shareOpt('video', 'Video', 'A time-lapse clip: a day here, a night of star trails or the 2027 eclipse.');
    const sharePop = h('div', { class: 'popover pop-share', role: 'dialog', 'aria-label': 'Share', hidden: true }, linkOpt, cardOpt, videoOpt);
    const videoDlg = mountVideo(host, ctx);
    ui.openVideo = () => videoDlg.open();
    host.appendChild(sharePop);
    let sharePopCtl = null;
    const closeSharePop = () => { sharePopCtl?.close(); sharePopCtl = null; };
    offs.push(on(shareBtn, 'click', () => {
        if (sharePopCtl) { closeSharePop(); return; }
        // Videos render the 3D view.
        videoOpt.hidden = store.get().status?.webgl === false;
        sharePopCtl = openPopover(shareBtn, sharePop, {
            placement: ui.layout === 'mobile' ? 'bottom' : 'top', onClose: () => { sharePopCtl = null; },
        });
    }));
    // Both run inside the tap, so the system share sheet keeps its user activation.
    offs.push(on(linkOpt, 'click', () => { closeSharePop(); share(); }));
    offs.push(on(cardOpt, 'click', () => { closeSharePop(); postcard.open(); }));
    offs.push(on(videoOpt, 'click', () => { closeSharePop(); videoDlg.open(); }));
    const expose = mountExpose(exposeBtn, host, ctx, { savePhoto: (caption) => postcard.open({ mode: 'photo', caption }) });

    return {
        destroy() {
            offs.forEach((off) => off());
            closeSharePop();
            sharePop.remove();
            postcard.destroy();
            videoDlg.destroy();
            expose.destroy();
            tools.destroy();
            clearTimeout(fadeTimer);
            release?.();
            closeVant();
            vantMenu.remove();
            caption.remove();
            layer.remove();
            fade.remove();
            root.textContent = '';
        },
    };
}
