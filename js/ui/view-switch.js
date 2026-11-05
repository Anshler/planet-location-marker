/**
 * The toolbar (docs/roadmap/UI-REDESIGN.md §4.2), the same four labelled controls in every view:
 * [Globe | Sky | Map] [Tools ▾] [Share ▾] [⋯]. Only Tools follows the view: on the globe, where to
 * look from, Turn with the Earth, Reset the view and Sky view tools…; in Sky view, Follow, the
 * telescope, the ruler and pointing (sky-tools.js) and long exposures (expose.js). Globe stays
 * checked at L1, Earthrise and the solar system, and returns to the close view. Phones get a
 * captioned floating column; text mode keeps Share and ⋯. It sets the camera's mode chips (the
 * viewpoint, the map, the telescope, following) and owns the share flow (SPEC F.4): actions.share()
 * → 'shared' (the system sheet, inside the click) | 'copied' (a toast) | 'failed' (a dialog with
 * the link); S goes straight there. Under reduced motion a 200 ms fade softens view and place cuts.
 *
 * @module ui/view-switch
 */

import { h, on, setAttr, trapFocus, menu, rovingKeys } from './dom.js';
import { icon } from './icons.js';
import { mountPostcard } from './postcard.js';
import { mountVideo } from './video.js';
import { mountExpose, EXPOSE_PRESETS } from './expose.js';
import { mountSkyTools, canPointAtSky } from './sky-tools.js';
import { offerNow, install } from './install.js';
import { t, N_, intl } from '../core/i18n.js';

/** The viewpoints' chips: [title, detail, icon] (English; t() where shown). */
const VANTAGE_CHIP = Object.freeze({
    l1: [N_('View from L1'), N_('1.5 million km sunward'), 'sun'],
    moon: [N_('Earthrise'), N_('Lunar orbit, 150 km up · play time to watch it rise'), 'moon'],
    system: [N_('Solar system'), N_('Distances to scale · planets enlarged, not to scale'), 'planet'],
});
const TOOLS_NAME = { orbit: N_('Tools for the globe'), map: N_('Tools for the map'), sky: N_('Tools for the Sky view') };

/**
 * Mounts the toolbar.
 * @param {HTMLElement} root `.viewbar`
 * @param {any} ctx UiCtx (with ui.modes)
 * @returns {{destroy(): void}}
 */
export function mountViewSwitch(root, ctx) {
    const { store, ui, bus } = ctx;
    const host = ui.root || document.body;
    const offs = [];
    const st = () => store.get();
    const gl = () => st().status?.webgl !== false;
    const sel = () => st().selection;
    const selName = () => ui.bodyName(sel());

    // ---------------------------------------------------------------- [Globe | Sky | Map]
    const segBtn = (mode, iconName, label, tip, kbd) => h('button', {
        class: 'seg__btn', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-mode': mode, 'data-tip': tip, 'data-kbd': kbd,
    }, icon(iconName, { size: 18 }), h('span', { class: 'seg__label' }, label));
    const segs = [segBtn('orbit', 'globe', t('Globe'), t('Globe view'), 'V'), segBtn('sky', 'sky', t('Sky'), t('Stand here and look up'), 'V'),
        segBtn('map', 'map', t('Map'), t('The world map'), 'M')];
    const seg = h('div', { class: 'seg seg--view glass', role: 'radiogroup', 'aria-label': t('View') }, ...segs);
    // Its chip goes at once (view.system lasts the fly-back's first half).
    const leaveSystem = () => { ui.modes?.clear('view'); ui.act('setSystem', false); };
    const setMode = (mode) => {
        const v = st().view;
        // Globe is also the way back from a viewpoint and from the solar system.
        if (mode === 'orbit' && v?.mode === 'orbit' && v?.system) leaveSystem();
        else if (v?.mode !== mode || (v?.vantage ?? 'none') !== 'none') ui.act('setViewMode', mode);
    };
    offs.push(on(seg, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-mode]');
        if (b) setMode(b.dataset.mode);
    }));
    offs.push(rovingKeys(seg, segs, (b) => { setMode(b.dataset.mode); b.focus(); }));

    // ---------------------------------------------------------------- Tools, Share, ⋯
    const btn = (cls, iconName, label, tip, kbd) => h('button', { class: `vb-btn glass ${cls}`, type: 'button', 'data-tip': tip, 'data-kbd': kbd },
        icon(iconName, { size: 19 }), h('span', { class: 'vb-btn__label' }, label), cls === 'vb-more' ? null : icon('chevron-down', { size: 14, className: 'vb-btn__chev' }));
    const toolsBtn = btn('vb-tools', 'tools', t('Tools'), t('Camera and sky tools'));
    toolsBtn.append(h('span', { class: 'vb-btn__dot', 'aria-hidden': 'true' }));
    const shareBtn = btn('vb-share', 'share', t('Share'), t('Share'), 'S');
    const moreBtn = btn('vb-more', 'more', t('More'), t('More'));
    moreBtn.setAttribute('aria-label', t('More'));
    root.append(seg, toolsBtn, shareBtn, moreBtn);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', t('View controls'));
    const placement = () => (ui.layout === 'mobile' ? 'bottom' : 'top');

    const pointable = canPointAtSky(typeof window !== 'undefined' ? window : null, !!(ctx.env?.coarse ?? st().status?.coarse));
    const view = () => st().view || {};
    const vt = () => (view().system ? 'system' : view().vantage ?? 'none');
    const look = (kind, iconName, name, detail) => ({
        kind: 'radio', group: t('Look from'), icon: iconName, name, detail, checked: () => vt() === kind,
        run: () => (kind === 'system' ? (ui.act('setSystem', true), sync()) : vt() === 'system' ? leaveSystem() : ui.act('setVantage', kind)),
    });
    const reset = () => ({ group: 9, icon: 'home', name: t('Reset the view'), detail: t('Back to the starting framing'), kbd: 'Home', run: () => ui.act('resetCamera') });
    const follow = (kind, name, detail) => ({
        kind: 'radio', group: t('Follow'), icon: kind === 'stars' ? 'star' : kind === 'body' ? 'crosshair' : 'sky', name, detail, kbd: 'K',
        checked: () => (view().track ?? 'none') === kind, run: () => ui.act('setTracking', kind),
        ...(kind === 'body' ? { disabled: () => !sel(), disabledText: t('Select something first') } : null),
    });
    const toolsItems = () => {
        const mode = view().mode;
        if (mode === 'sky') {
            const x = st().ui.expose;
            const lx = t('Long exposure (one image)');
            return [
                follow('none', t('Look around freely'), t('The view stays where you point it')),
                follow('body', () => (sel() ? t('Follow {body}', { body: selName() }) : t('Follow the selection')), t('Keep it centred as time runs')),
                follow('stars', t('Follow the stars'), t('Turn with the sky, as a tracking mount does')),
                { kind: 'check', group: t('Follow'), icon: 'eye', name: () => (sel() ? t('Telescope on {body}', { body: selName() }) : t('Telescope')),
                    detail: t('Its true size and orientation, followed'), disabled: () => !sel(), disabledText: t('Select something first'),
                    checked: () => !!st().ui.scope, run: () => (st().ui.scope ? ui.act('leaveTelescope') : ui.act('telescope', sel())) },
                { kind: 'check', group: t('Measure and point'), icon: 'ruler', name: t('Angle ruler'), kbd: 'A',
                    detail: t('Tap two things to measure the angle between them'), checked: () => !!st().ui.ruler, run: () => ui.act('setRuler') },
                { kind: 'check', group: t('Measure and point'), icon: 'phone', name: t('Point the phone at the sky'), detail: t('The view follows your phone'),
                    hidden: () => !pointable, checked: () => !!st().ui.aim, run: () => ui.act('pointAtSky') },
                ...(x ? [{ group: lx, icon: 'aperture', name: t('Stop the exposure'), detail: t('Long exposure: {preset}', { preset: t(EXPOSE_PRESETS.find((p) => p.id === x)?.title ?? x) }), run: () => ui.act('expose', null) }]
                    : EXPOSE_PRESETS.map((p) => ({ id: p.id, group: lx, icon: 'aperture', name: t(p.title), detail: t(p.desc), run: () => ui.act('expose', p.id) }))),
                ...(st().quality?.active === 'low' ? [{ note: t('Low quality stacks without the glow (bloom).'), group: lx }] : []),
                reset(),
            ];
        }
        const skyTools = { group: 10, icon: 'sky', name: t('Sky view tools…'), detail: t('Follow, telescope, angle ruler and long exposure'),
            run: () => { ui.act('setViewMode', 'sky'); requestAnimationFrame(() => tools.open()); } };
        if (mode === 'map') return [reset(), skyTools];
        return [
            look('none', 'globe', t('Near the Earth'), t('Orbit the globe from close by')),
            look('l1', 'sun', t('The L1 point'), t('The sunlit Earth from 1.5 million km, as NASA’s DSCOVR sees it')),
            look('moon', 'moon', t('Earthrise'), t('The Earth rising over the Moon’s limb, from lunar orbit')),
            look('system', 'planet', t('The whole solar system'), t('Zoom out until the beams become lines across the solar system')),
            { kind: 'check', group: 9, icon: 'globe', name: t('Turn with the Earth'), detail: t('Your place stays in view as the Earth turns'), kbd: 'L',
                hidden: () => vt() !== 'none', checked: () => !!view().earthLock, run: () => ui.act('setEarthLock', !view().earthLock) },
            reset(), skyTools,
        ];
    };
    const tools = menu({ button: toolsBtn, label: t('Tools'), items: toolsItems, host, placement });

    const shareMenu = menu({
        button: shareBtn, label: t('Share'), host, placement, items: () => [
            // Inside the click, so the system share sheet keeps its user activation.
            { icon: 'link', name: t('Share link'), detail: () => (gl() ? t('Opens exactly this view: place, time, camera and layers') : t('Opens this place and time')), kbd: 'S', run: () => share() },
            { icon: 'postcard', name: t('Postcard…'), detail: t('A designed image of this view, ready to post'), run: () => postcard.open() },
            { icon: 'video', name: t('Time-lapse video…'), detail: t('A clip of a day here, a night of turning stars or the 2027 eclipse'),
                hidden: () => !gl(), run: () => videoDlg.open() },
        ],
    });

    const fsOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
    const coarse = () => document.body.classList.contains('is-coarse');
    const moreMenu = menu({
        button: moreBtn, label: t('More'), host, placement, items: () => [
            { icon: gl() && coarse() ? 'help' : 'keyboard', name: !gl() ? t('Keyboard shortcuts') : coarse() ? t('Gestures and help') : t('Keyboard shortcuts and mouse'), kbd: '?',
                detail: !gl() ? t('The keys, and what each one does') : coarse() ? t('Drag, pinch and tap: what each one does') : t('The keys, and what the mouse does'), run: () => ui.toggleHelp(true) },
            { icon: 'sparkle', name: t('Interface tips'), detail: t('The three tips from the first visit, again'), hidden: () => !gl(), run: () => ui.showTips() },
            { kind: 'check', icon: 'eye', name: t('Night vision'), kbd: 'Shift+N', checked: () => !!st().display?.red,
                // In red the accent is no cue, so the words say it is on.
                detail: () => (st().display?.red ? t('On: choose again for full colour') : t('A dim red screen for dark-adapted eyes, kept awake')), run: () => ui.act('setNightVision') },
            { icon: 'eye-off', name: t('Hide the interface'), detail: () => (coarse() ? t('Just the view; tap Show interface to return') : t('Just the view; move the pointer to return')), kbd: 'H',
                hidden: () => !gl(), run: () => ui.act('toggleCinema') },
            { kind: 'check', icon: 'fullscreen', name: t('Fullscreen'), detail: t('Use the whole screen'), kbd: 'F', checked: fsOn,
                hidden: () => !gl() || (!document.fullscreenEnabled && !document.webkitFullscreenEnabled), run: () => ui.act('toggleFullscreen') },
            { icon: 'download', name: t('Install the app'), detail: t('Open it like an app, offline too'), hidden: () => !offerNow(), run: () => install(ctx) },
            { icon: 'info', name: t('About, credits and help'), detail: t('Version, accuracy, credits, privacy, report a problem'),
                run: () => ui.openPanel('display', { reveal: 'about' }) },
        ],
    });

    // A menu open across a change of view would offer the other view's items.
    offs.push(store.subscribe((s) => s.view?.mode, () => tools.close()));

    // ---------------------------------------------------------------- state → toolbar and chips
    function sync() {
        const s = st();
        const v = s.view || {};
        const mode = v.mode === 'sky' || v.mode === 'map' ? v.mode : 'orbit';
        for (const b of segs) {
            const on_ = b.dataset.mode === mode;
            setAttr(b, 'aria-checked', String(on_));
            b.tabIndex = on_ ? 0 : -1;
            b.classList.toggle('is-on', on_);
        }
        setAttr(toolsBtn, 'aria-label', t(TOOLS_NAME[mode]));
        const k = vt();
        const trk = v.track ?? 'none';
        const busy = k !== 'none' || trk !== 'none' || !!(s.ui.scope || s.ui.ruler || s.ui.aim || s.ui.expose);
        toolsBtn.classList.toggle('is-on', busy);
        const m = ui.modes;
        if (!gl()) {
            // Text mode (from the start, or a fall mid-session): no 3D view, so no view chips, and
            // Esc goes on to clear the selection.
            for (const id of ['view', 'map', 'scope', 'follow']) m.clear(id);
            return;
        }
        const back = { label: t('Back to the globe'), done: t('Back to the globe'), run: () => (v.system ? leaveSystem() : ui.act('setViewMode', 'orbit')) };
        if (mode === 'orbit' && VANTAGE_CHIP[k]) m.set('view', { icon: VANTAGE_CHIP[k][2], title: t(VANTAGE_CHIP[k][0]), detail: t(VANTAGE_CHIP[k][1]), exit: back });
        else m.clear('view');
        if (mode === 'map') {
            m.set('map', { icon: 'map', title: t('World map'), exit: back,
                detail: t('Lines: sunset, civil, nautical and astronomical twilight. Dots: overhead now.') });
        } else m.clear('map');
        const sc = s.ui.scope;
        if (sc) {
            const f = intl(Intl.NumberFormat, { maximumSignificantDigits: 2 }).format(sc.fovDeg);
            m.set('scope', { icon: 'eye', title: t('Telescope on {body}', { body: ui.bodyName(sc.id) }), detail: trk === 'body' ? t('{f}° field, followed', { f }) : t('{f}° field', { f }),
                exit: { label: t('Leave the telescope'), done: t('Telescope off'), run: () => ui.act('leaveTelescope') } });
        } else m.clear('scope');
        if (mode === 'sky' && trk !== 'none' && !sc) {
            m.set('follow', { icon: trk === 'stars' ? 'star' : 'crosshair', title: trk === 'stars' ? t('Following the stars') : t('Following {body}', { body: selName() }),
                detail: trk === 'stars' ? t('The view turns with the sky') : t('Kept centred as time runs'),
                exit: { label: t('Stop following'), done: t('Not following'), run: () => ui.act('setTracking', 'none') } });
        } else m.clear('follow');
    }
    for (const sel_ of [(s) => s.view, (s) => s.selection, (s) => s.ui.scope, (s) => s.ui.ruler, (s) => s.ui.aim, (s) => s.ui.expose, (s) => s.status?.webgl]) {
        offs.push(store.subscribe(sel_, sync));
    }

    // ---------------------------------------------------------------- reduced-motion fade
    const fade = h('div', { class: 'fade-overlay', 'aria-hidden': 'true' });
    host.appendChild(fade);
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
    const urlInput = h('input', { class: 'input input--url', type: 'text', readonly: true, 'aria-label': t('Link to this view'), spellcheck: 'false' });
    const copyBtn = h('button', { class: 'btn btn--primary', type: 'button' }, icon('copy', { size: 16 }), t('Copy'));
    const copyMsg = h('p', { class: 'share__msg', role: 'status' });
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Close') }, icon('close', { size: 18 }));
    const dialog = h('div', { class: 'dialog share glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title' },
        h('header', { class: 'dialog__head' }, h('h2', { class: 'dialog__title', id: 'share-title' }, icon('share', { size: 20 }), t('Share this view')), closeBtn),
        h('p', { class: 'prose' }, t('This link opens exactly what you see: the place, the time, the view and the layers.')),
        h('div', { class: 'share__row' }, urlInput, copyBtn),
        copyMsg);
    const layer = h('div', { class: 'modal-layer share-layer', hidden: true }, h('div', { class: 'modal-backdrop' }), dialog);
    host.appendChild(layer);
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
        copyMsg.textContent = ok ? t('Link copied.') : t('Press {key}+C to copy the selected link.', { key: /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl' });
    }));

    /** Share flow shared by the menu and the S shortcut. */
    async function share() {
        let url = String(globalThis.location?.href || '');
        try { url = ctx.actions?.shareUrl?.() || url; } catch { /* keep location.href */ }
        let result;
        if (typeof ctx.actions?.share === 'function') {
            try { result = await ctx.actions.share(); } catch { result = 'failed'; }
        } else {
            try { await navigator.clipboard.writeText(url); result = 'copied'; } catch { result = 'failed'; }
        }
        if (result === 'copied') bus.emit('toast', { message: t('Link copied'), kind: 'info', timeoutMs: 2500 });
        else if (result === 'failed') openShare(url);
        return result;
    }
    ui.share = share;

    const postcard = mountPostcard(host, ctx);
    ui.openPostcard = (opts) => postcard.open(opts);
    const videoDlg = mountVideo(host, ctx);
    ui.openVideo = () => videoDlg.open();
    const subs = [mountExpose(ctx, { savePhoto: (caption) => postcard.open({ mode: 'photo', caption }) }), mountSkyTools(ctx), tools, shareMenu, moreMenu, postcard, videoDlg];
    sync();

    return {
        destroy() {
            offs.forEach((off) => off());
            subs.forEach((x) => x.destroy());
            clearTimeout(fadeTimer);
            release?.();
            layer.remove();
            fade.remove();
            root.textContent = '';
        },
    };
}
