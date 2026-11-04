/**
 * Installing the app (ROADMAP first-run-touch-onboarding):
 *
 * - `mountInstall(ctx)` → `{el, destroy}`: the About tab's 'Install' group. Where the browser
 *   offers its install dialog (`beforeinstallprompt`, kept by index.html in `window.__pcInstall`
 *   so an event that fires before this module loads is not lost) it is an 'Install app' button;
 *   on an iPhone or iPad outside the installed app it says how to add it to the Home Screen;
 *   otherwise (installed, or a browser that offers neither) it is hidden.
 * - `mountInstallHint(ctx)` → `stop()`: on iOS, outside the installed app, a one-time toast with
 *   the same steps, about a minute into the first visit once nothing else is showing (pref
 *   `installHint`).
 *
 * The browser's own install UI (Chrome's mini-infobar, the address bar's icon) is left alone: the
 * event is kept, not cancelled. The helpers above the mount functions are pure.
 *
 * @module ui/install
 */

import { h, on } from './dom.js';
import { icon } from './icons.js';
import { load as loadPref, save as savePref } from '../core/prefs.js';

const IOS_STEPS = 'tap the Share button, then ‘Add to Home Screen’';
const HINT_DELAY_MS = 60e3;

/**
 * An iPhone, iPod or iPad (iPadOS presents itself as a Mac with a touch screen). Pure.
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 */
export function isIos({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
    return /iPhone|iPad|iPod/.test(userAgent) || (/^Mac/.test(platform) && maxTouchPoints > 1);
}

/**
 * What the Install group offers: 'prompt' (the browser's install dialog), 'ios' (Share → Add to
 * Home Screen) or null (already installed, or nothing to offer). Pure.
 * @param {{standalone:boolean, prompt:boolean, ios:boolean}} s
 * @returns {'prompt'|'ios'|null}
 */
export function installOffer({ standalone, prompt, ios }) {
    if (standalone) return null;
    if (prompt) return 'prompt';
    return ios ? 'ios' : null;
}

/** Running as the installed app (a standalone or fullscreen display mode, or iOS's home-screen app). */
function standalone() {
    try {
        if (globalThis.navigator?.standalone === true) return true;
        return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => globalThis.matchMedia?.(`(display-mode: ${m})`).matches);
    } catch { return false; }
}
const onIos = () => isIos(globalThis.navigator || {});

/**
 * The About tab's Install group.
 * @param {any} ctx UiCtx
 * @returns {{el: HTMLElement, destroy(): void}}
 */
export function mountInstall(ctx) {
    const offs = [];
    const btn = h('button', { class: 'btn btn--primary', type: 'button' }, icon('download', { size: 16 }), 'Install app');
    const text = h('p', { class: 'prose' });
    const el = h('div', { class: 'group install', hidden: true }, h('h3', { class: 'group-title' }, 'Install'), text, btn);

    const sync = () => {
        const offer = installOffer({ standalone: standalone(), prompt: !!window.__pcInstall, ios: onIos() });
        el.hidden = !offer;
        btn.hidden = offer !== 'prompt';
        text.textContent = offer === 'ios'
            ? `Add it to your Home Screen: in Safari, ${IOS_STEPS}. It opens full screen and works offline.`
            : 'Add it to your home screen or desktop: it opens in its own window and works offline.';
    };
    offs.push(on(window, 'beforeinstallprompt', (e) => { window.__pcInstall = e; sync(); }));
    offs.push(on(window, 'appinstalled', () => { window.__pcInstall = null; sync(); }));
    offs.push(on(btn, 'click', async () => {
        const ev = window.__pcInstall;
        // One prompt per event: a new one arrives if the browser offers again.
        window.__pcInstall = null;
        sync();
        let outcome = 'failed';
        try {
            await ev.prompt();
            outcome = (await ev.userChoice)?.outcome || 'dismissed';
        } catch { outcome = 'failed'; }
        if (outcome === 'failed') {
            ctx.bus.emit('toast', { message: 'Your browser’s menu can install it: look for ‘Install app’ or ‘Add to Home screen’.', kind: 'info' });
        }
    }));
    sync();
    return { el, destroy() { offs.forEach((off) => off()); } };
}

/**
 * The one-time iOS 'Add to Home Screen' toast. It waits until no intro, tour, coach marks, dialog
 * or hidden interface is in the way.
 * @param {any} ctx UiCtx
 * @returns {() => void} stop
 */
export function mountInstallHint(ctx) {
    if (!onIos() || standalone() || loadPref('installHint', false)) return () => {};
    const { store, ui, bus } = ctx;
    let timer = 0;
    const busy = () => {
        const s = store.get();
        return s.status?.phase !== 'ready' || s.status?.introPlaying || !!s.ui?.tour || s.ui?.palette || s.ui?.help || s.ui?.cinema
            || !!ui.coachOpen?.() || document.visibilityState === 'hidden';
    };
    const tick = () => {
        if (busy()) { timer = setTimeout(tick, 15e3); return; }
        savePref('installHint', true);
        bus.emit('toast', { message: `Keep it on your Home Screen: ${IOS_STEPS}.`, kind: 'info', actionLabel: 'Got it', onAction: () => {}, timeoutMs: 15e3 });
    };
    timer = setTimeout(tick, HINT_DELAY_MS);
    return () => clearTimeout(timer);
}
