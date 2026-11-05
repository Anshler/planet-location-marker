/**
 * The intro's title card (ROADMAP first-run-touch-onboarding). As the intro's beams launch
 * (bus 'intro' 'launch' from js/app/intro.js) a short card fades in under the globe:
 * "Ho Chi Minh City" over "21:00 · 3 worlds above you", in the display zone, counting the bodies
 * above the horizon (refracted, as Sky now does). It is announced politely (bus 'announce') and
 * hidden from assistive technology itself. It sits on <body>, outside #ui-root (which the intro
 * hides), takes no input, and leaves after SHOW_MS or at the first pointer or key. Under reduced
 * motion it never shows (a replayed intro there is played on request, the card is not).
 *
 * @module ui/intro-caption
 */

import { h } from './dom.js';
import { t, tn } from '../core/i18n.js';

/** How long the card stays (the beams land and the interface fades in meanwhile). */
export const SHOW_MS = 3400;

/**
 * How many bodies are above the horizon (refracted altitude > 0). Pure.
 * @param {any[]|null|undefined} bodies Snapshot bodies
 * @param {(b:any) => {alt:number}} altAz the UI's apparent altitude
 */
export function worldsAbove(bodies, altAz) {
    let n = 0;
    for (const b of bodies || []) {
        const a = altAz(b)?.alt;
        if (Number.isFinite(a) && a > 0) n += 1;
    }
    return n;
}

/**
 * The card's words: a title (the place), a line ("21:00 · 3 worlds above you") and the spoken form. Pure.
 * @param {string} place
 * @param {string} clock
 * @param {number} n worlds above the horizon
 */
export function introCaption(place, clock, n) {
    const worlds = n > 0 ? tn('{n} world above you', '{n} worlds above you', n) : t('every world below your horizon');
    return { title: place, line: `${clock} · ${worlds}`, spoken: `${place}, ${clock}. ${worlds.charAt(0).toUpperCase()}${worlds.slice(1)}.` };
}

/**
 * Mounts the title card.
 * @param {any} ctx UiCtx (store, bus, ui)
 * @returns {{destroy(): void}}
 */
export function mountIntroCaption(ctx) {
    const { bus, ui, store } = ctx;
    const title = h('span', { class: 'intro-cap__place' });
    const line = h('span', { class: 'intro-cap__line' });
    const el = h('div', { class: 'intro-cap', 'aria-hidden': 'true', hidden: true }, title, line);
    document.body.appendChild(el);
    let timer = 0;
    let offInput = null;

    function hide() {
        offInput?.();
        offInput = null;
        clearTimeout(timer);
        el.classList.remove('is-on');
        timer = setTimeout(() => { el.hidden = true; }, 700);
    }

    function show() {
        const snap = ui.snap;
        if (!snap || ui.reducedMotion() || ui.layout === 'text') return;
        const c = introCaption(ui.placeShort(store.get().observer), ui.fmtClock(snap.tMs), worldsAbove(snap.bodies, ui.altAz));
        title.textContent = c.title;
        line.textContent = c.line;
        clearTimeout(timer);
        el.hidden = false;
        void el.offsetWidth;   // start the fade from the hidden state
        el.classList.add('is-on');
        bus.emit('announce', c.spoken);
        timer = setTimeout(hide, SHOW_MS);
        if (!offInput) {
            const opts = { capture: true, passive: true };
            window.addEventListener('pointerdown', hide, opts);
            window.addEventListener('keydown', hide, opts);
            offInput = () => {
                window.removeEventListener('pointerdown', hide, opts);
                window.removeEventListener('keydown', hide, opts);
            };
        }
    }

    const off = bus.on('intro', (p) => { if (p === 'launch') show(); });
    return {
        destroy() {
            off();
            offInput?.();
            clearTimeout(timer);
            el.remove();
        },
    };
}
