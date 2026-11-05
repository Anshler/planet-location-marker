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

/** The viewpoints' chips: [title, detail, icon]. */
const VANTAGE_CHIP = Object.freeze({
    l1: ['View from L1', '1.5 million km sunward', 'sun'],
    moon: ['Earthrise', 'Lunar orbit, 150 km up · play time to watch it rise', 'moon'],
    system: ['Solar system', 'Distances to scale · planets enlarged, not to scale', 'planet'],
});
const RED_DETAIL = 'A dim red screen for dark-adapted eyes, kept awake';
const TOOLS_NAME = { orbit: 'Tools for the globe', map: 'Tools for the map', sky: 'Tools for the Sky view' };

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
    const segs = [segBtn('orbit', 'globe', 'Globe', 'Globe view', 'V'), segBtn('sky', 'sky', 'Sky', 'Stand here and look up', 'V'),
        segBtn('map', 'map', 'Map', 'The world map', 'M')];
    const seg = h('div', { class: 'seg seg--view glass', role: 'radiogroup', 'aria-label': 'View' }, ...segs);
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
    const toolsBtn = btn('vb-tools', 'tools', 'Tools', 'Camera and sky tools');
    toolsBtn.append(h('span', { class: 'vb-btn__dot', 'aria-hidden': 'true' }));
    const shareBtn = btn('vb-share', 'share', 'Share', 'Share', 'S');
    const moreBtn = btn('vb-more', 'more', 'More', 'More');
    moreBtn.setAttribute('aria-label', 'More');
    root.append(seg, toolsBtn, shareBtn, moreBtn);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'View controls');
    const placement = () => (ui.layout === 'mobile' ? 'bottom' : 'top');

    const pointable = canPointAtSky(typeof window !== 'undefined' ? window : null, !!(ctx.env?.coarse ?? st().status?.coarse));
    const view = () => st().view || {};
    const vt = () => (view().system ? 'system' : view().vantage ?? 'none');
    const look = (kind, iconName, name, detail) => ({
        kind: 'radio', group: 'Look from', icon: iconName, name, detail, checked: () => vt() === kind,
        run: () => (kind === 'system' ? (ui.act('setSystem', true), sync()) : vt() === 'system' ? leaveSystem() : ui.act('setVantage', kind)),
    });
    const reset = { group: 9, icon: 'home', name: 'Reset the view', detail: 'Back to the starting framing', kbd: 'Home', run: () => ui.act('resetCamera') };
    const follow = (kind, name, detail) => ({
        kind: 'radio', group: 'Follow', icon: kind === 'stars' ? 'star' : kind === 'body' ? 'crosshair' : 'sky', name, detail, kbd: 'K',
        checked: () => (view().track ?? 'none') === kind, run: () => ui.act('setTracking', kind),
        ...(kind === 'body' ? { disabled: () => !sel(), disabledText: 'Select something first' } : null),
    });
    const toolsItems = () => {
        const mode = view().mode;
        if (mode === 'sky') {
            const x = st().ui.expose;
            return [
                follow('none', 'Look around freely', 'The view stays where you point it'),
                follow('body', () => (sel() ? `Follow ${selName()}` : 'Follow the selection'), 'Keep it centred as time runs'),
                follow('stars', 'Follow the stars', 'Turn with the sky, as a tracking mount does'),
                { kind: 'check', group: 'Follow', icon: 'eye', name: () => (sel() ? `Telescope on ${selName()}` : 'Telescope'),
                    detail: 'Its true size and orientation, followed', disabled: () => !sel(), disabledText: 'Select something first',
                    checked: () => !!st().ui.scope, run: () => (st().ui.scope ? ui.act('leaveTelescope') : ui.act('telescope', sel())) },
                { kind: 'check', group: 'Measure and point', icon: 'ruler', name: 'Angle ruler', kbd: 'A',
                    detail: 'Tap two things to measure the angle between them', checked: () => !!st().ui.ruler, run: () => ui.act('setRuler') },
                { kind: 'check', group: 'Measure and point', icon: 'phone', name: 'Point the phone at the sky', detail: 'The view follows your phone',
                    hidden: () => !pointable, checked: () => !!st().ui.aim, run: () => ui.act('pointAtSky') },
                ...(x ? [{ group: 'Long exposure (one image)', icon: 'aperture', name: 'Stop the exposure', detail: `Long exposure: ${EXPOSE_PRESETS.find((p) => p.id === x)?.title ?? x}`, run: () => ui.act('expose', null) }]
                    : EXPOSE_PRESETS.map((p) => ({ id: p.id, group: 'Long exposure (one image)', icon: 'aperture', name: p.title, detail: p.desc, run: () => ui.act('expose', p.id) }))),
                ...(st().quality?.active === 'low' ? [{ note: 'Low quality stacks without the glow (bloom).', group: 'Long exposure (one image)' }] : []),
                reset,
            ];
        }
        const skyTools = { group: 10, icon: 'sky', name: 'Sky view tools…', detail: 'Follow, telescope, angle ruler and long exposure',
            run: () => { ui.act('setViewMode', 'sky'); requestAnimationFrame(() => tools.open()); } };
        if (mode === 'map') return [reset, skyTools];
        return [
            look('none', 'globe', 'Near the Earth', 'Orbit the globe from close by'),
            look('l1', 'sun', 'The L1 point', 'The sunlit Earth from 1.5 million km, as NASA’s DSCOVR sees it'),
            look('moon', 'moon', 'Earthrise', 'The Earth rising over the Moon’s limb, from lunar orbit'),
            look('system', 'planet', 'The whole solar system', 'Zoom out until the beams become lines across the solar system'),
            { kind: 'check', group: 9, icon: 'globe', name: 'Turn with the Earth', detail: 'Your place stays in view as the Earth turns', kbd: 'L',
                hidden: () => vt() !== 'none', checked: () => !!view().earthLock, run: () => ui.act('setEarthLock', !view().earthLock) },
            reset, skyTools,
        ];
    };
    const tools = menu({ button: toolsBtn, label: 'Tools', items: toolsItems, host, placement });

    const shareMenu = menu({
        button: shareBtn, label: 'Share', host, placement, items: () => [
            // Inside the click, so the system share sheet keeps its user activation.
            { icon: 'link', name: 'Share link', detail: () => (gl() ? 'Opens exactly this view: place, time, camera and layers' : 'Opens this place and time'), kbd: 'S', run: () => share() },
            { icon: 'postcard', name: 'Postcard…', detail: 'A designed image of this view, ready to post', run: () => postcard.open() },
            { icon: 'video', name: 'Time-lapse video…', detail: 'A clip of a day here, a night of turning stars or the 2027 eclipse',
                hidden: () => !gl(), run: () => videoDlg.open() },
        ],
    });

    const fsOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
    const coarse = () => document.body.classList.contains('is-coarse');
    const moreMenu = menu({
        button: moreBtn, label: 'More', host, placement, items: () => [
            { icon: gl() && coarse() ? 'help' : 'keyboard', name: !gl() ? 'Keyboard shortcuts' : coarse() ? 'Gestures and help' : 'Keyboard shortcuts and mouse', kbd: '?',
                detail: !gl() ? 'The keys, and what each one does' : coarse() ? 'Drag, pinch and tap: what each one does' : 'The keys, and what the mouse does', run: () => ui.toggleHelp(true) },
            { icon: 'sparkle', name: 'Interface tips', detail: 'The three tips from the first visit, again', hidden: () => !gl(), run: () => ui.showTips() },
            { kind: 'check', icon: 'eye', name: 'Night vision', kbd: 'Shift+N', checked: () => !!st().display?.red,
                // In red the accent is no cue, so the words say it is on.
                detail: () => (st().display?.red ? 'On: choose again for full colour' : RED_DETAIL), run: () => ui.act('setNightVision') },
            { icon: 'eye-off', name: 'Hide the interface', detail: () => (coarse() ? 'Just the view; tap Show interface to return' : 'Just the view; move the pointer to return'), kbd: 'H',
                hidden: () => !gl(), run: () => ui.act('toggleCinema') },
            { kind: 'check', icon: 'fullscreen', name: 'Fullscreen', detail: 'Use the whole screen', kbd: 'F', checked: fsOn,
                hidden: () => !gl() || (!document.fullscreenEnabled && !document.webkitFullscreenEnabled), run: () => ui.act('toggleFullscreen') },
            { icon: 'download', name: 'Install the app', detail: 'Open it like an app, offline too', hidden: () => !offerNow(), run: () => install(ctx) },
            { icon: 'info', name: 'About, credits and help', detail: 'Version, accuracy, credits, privacy, report a problem',
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
        setAttr(toolsBtn, 'aria-label', TOOLS_NAME[mode]);
        const k = vt();
        const trk = v.track ?? 'none';
        const busy = k !== 'none' || trk !== 'none' || !!(s.ui.scope || s.ui.ruler || s.ui.aim || s.ui.expose);
        toolsBtn.classList.toggle('is-on', busy);
        if (!gl()) return;
        const m = ui.modes;
        const back = { label: 'Back to the globe', done: 'Back to the globe', run: () => (v.system ? leaveSystem() : ui.act('setViewMode', 'orbit')) };
        if (mode === 'orbit' && VANTAGE_CHIP[k]) m.set('view', { icon: VANTAGE_CHIP[k][2], title: VANTAGE_CHIP[k][0], detail: VANTAGE_CHIP[k][1], exit: back });
        else m.clear('view');
        if (mode === 'map') {
            m.set('map', { icon: 'map', title: 'World map', exit: back,
                detail: 'Lines: sunset, civil, nautical and astronomical twilight. Dots: overhead now.' });
        } else m.clear('map');
        const sc = s.ui.scope;
        if (sc) {
            const f = +sc.fovDeg.toPrecision(2);
            m.set('scope', { icon: 'eye', title: `Telescope on ${ui.bodyName(sc.id)}`, detail: trk === 'body' ? `${f}° field, followed` : `${f}° field`,
                exit: { label: 'Leave the telescope', done: 'Telescope off', run: () => ui.act('leaveTelescope') } });
        } else m.clear('scope');
        if (mode === 'sky' && trk !== 'none' && !sc) {
            m.set('follow', { icon: trk === 'stars' ? 'star' : 'crosshair', title: trk === 'stars' ? 'Following the stars' : `Following ${selName()}`,
                detail: trk === 'stars' ? 'The view turns with the sky' : 'Kept centred as time runs',
                exit: { label: 'Stop following', done: 'Not following', run: () => ui.act('setTracking', 'none') } });
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
        copyMsg.textContent = ok ? 'Link copied.' : `Press ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+C to copy the selected link.`;
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
        if (result === 'copied') bus.emit('toast', { message: 'Link copied', kind: 'info', timeoutMs: 2500 });
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
