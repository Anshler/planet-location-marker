/**
 * Coach marks (ROADMAP first-run-touch-onboarding): three one-sentence tips, each a spotlight
 * cut out of a dimmed screen around the control it names:
 *
 *   1. a world: its label at the end of its beam (desktop), its chip under the time bar (phone)
 *      or its row in Sky now: the highest body up other than the Sun;
 *   2. the time bar's scrubber;
 *   3. the Globe | Sky switch.
 *
 * They run once, after the first visit's intro (bus 'intro' 'done'; on that visit under reduced
 * motion, when the app is ready), never in text mode, during a tour or with the interface hidden,
 * and are remembered in prefs (`coachSeen`). `ui.showTips()` replays them (Settings, the help
 * dialog, the phone's ⋯ menu). Esc, Skip or a tap outside the tip ends them; a tap on the
 * spotlight or Next moves on. The tip is a modal dialog: focus moves to Next, stays inside, and
 * returns where it was; each step is announced politely. A missing or off-screen target skips its
 * step. Motion follows the interface's reduced-motion rules (the spotlight then jumps).
 *
 * The geometry helpers (`featuredWorld`, `spotRect`, `placeTip`) are pure.
 *
 * @module ui/coach
 */

import { h, on, trapFocus } from './dom.js';
import { load as loadPref, save as savePref } from '../core/prefs.js';

const PAD = 6;
const GAP = 12;
const MARGIN = 12;

/** The steps: [id, title, text with a mouse, text on touch]; the world step's text names its target. */
export const COACH_STEPS = Object.freeze([
    ['world', 'Meet a world', 'Click a world, at the end of its beam or in Sky now, to see where it is, when it rises and how to find it. Keys 1–9 pick one too.',
        'Tap a world, at the end of its beam or here, to see where it is, when it rises and how to find it.'],
    ['time', 'Travel in time', 'Drag the time bar to move through hours and days. Space plays and pauses; Now brings you back.',
        'Drag the time bar to move through hours and days. ▶ plays time; Now brings you back.'],
    ['view', 'Look up', 'Sky stands you on the ground under the real sky; Globe takes you back to space (V).',
        'Sky stands you on the ground under the real sky; Globe takes you back to space.'],
]);

/**
 * The world to point at: the highest above the horizon other than the Sun, else the Sun, else the
 * Moon. Pure.
 * @param {any[]|null|undefined} bodies Snapshot bodies
 * @param {(b:any) => {alt:number}} altAz
 * @returns {string[]} body ids, best first: everything above the horizon by altitude, the Sun last
 */
export function featuredWorld(bodies, altAz) {
    const up = [];
    for (const b of bodies || []) {
        const a = altAz(b)?.alt;
        if (Number.isFinite(a) && a > 0) up.push([b.id, b.id === 'sun' ? -1 : a]);
    }
    up.sort((p, q) => q[1] - p[1]);
    const ids = up.map((p) => p[0]);
    if (!ids.includes('moon')) ids.push('moon');
    return ids;
}

/**
 * The spotlight around a target rect: padded, clamped to the viewport. Pure.
 * @param {{left:number, top:number, width:number, height:number}} r
 * @param {{w:number, h:number}} view
 * @param {number} [pad]
 */
export function spotRect(r, view, pad = PAD) {
    const x0 = Math.max(2, r.left - pad), y0 = Math.max(2, r.top - pad);
    const x1 = Math.min(view.w - 2, r.left + r.width + pad), y1 = Math.min(view.h - 2, r.top + r.height + pad);
    return { left: x0, top: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Where the tip goes: below the spotlight when it fits, else above, else whichever side has more
 * room; centred on it and kept inside the viewport. Pure.
 * @param {{left:number, top:number, width:number, height:number}} spot
 * @param {{w:number, h:number}} tip
 * @param {{w:number, h:number}} view
 * @returns {{x:number, y:number, side:'below'|'above'}}
 */
export function placeTip(spot, tip, view) {
    const below = view.h - (spot.top + spot.height) - GAP - MARGIN;
    const above = spot.top - GAP - MARGIN;
    const side = below >= tip.h || below >= above ? 'below' : 'above';
    let y = side === 'below' ? spot.top + spot.height + GAP : spot.top - GAP - tip.h;
    y = Math.max(MARGIN, Math.min(view.h - MARGIN - tip.h, y));
    let x = spot.left + spot.width / 2 - tip.w / 2;
    x = Math.max(MARGIN, Math.min(view.w - MARGIN - tip.w, x));
    return { x: Math.round(x), y: Math.round(y), side };
}

/** A target that is laid out and wholly on screen. */
function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
}

/**
 * Mounts the coach marks (nothing is drawn until they start).
 * @param {HTMLElement} root the overlay container inside #ui-root
 * @param {any} ctx UiCtx (store, bus, ui, env)
 * @returns {{start(force?: boolean): void, stop(): void, destroy(): void}}
 */
export function mountCoach(root, ctx) {
    const { store, bus, ui } = ctx;
    const offs = [];
    const spot = h('div', { class: 'coach__spot', 'aria-hidden': 'true' });
    const count = h('p', { class: 'coach__count' });
    const title = h('h2', { class: 'coach__title', id: 'coach-title' });
    const text = h('p', { class: 'coach__text' });
    const skipBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Skip');
    const nextBtn = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Next');
    const tip = h('div', { class: 'coach__tip glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'coach-title' },
        count, title, text, h('div', { class: 'coach__acts' }, skipBtn, nextBtn));
    const layer = h('div', { class: 'coach', hidden: true }, spot, tip);
    root.appendChild(layer);

    let steps = [];
    let index = -1;
    let target = null;
    let release = null;
    let poll = 0;
    let startTimer = 0;
    const coarse = () => !!store.get().status?.coarse;
    const view = () => ({ w: innerWidth, h: innerHeight });

    /** The step's target element, or null when it is not on screen. */
    function find(id) {
        const q = (sel) => root.ownerDocument.querySelector(sel);
        if (id === 'time') return visible(q('.ui .tb-scrub')) ? q('.ui .tb-scrub') : null;
        if (id === 'view') return visible(q('.ui .seg--view')) ? q('.ui .seg--view') : null;
        const ids = featuredWorld(ui.snap?.bodies, ui.altAz);
        const panel = q('.ui .panel')?.getBoundingClientRect();
        for (const sel of ui.layout === 'mobile' ? ['.ui .strip .bchip[data-id="?"]'] : ['#labels-root .lbl--body[data-id="?"]:not(.is-hidden)', '.ui .tabpanel--sky:not([hidden]) .body-row[data-id="?"]']) {
            for (const b of ids) {
                const el = q(sel.replace('?', b));
                // A beam label under the desktop panel does not count.
                if (visible(el) && !(sel.startsWith('#labels') && panel && el.getBoundingClientRect().right > panel.left && ui.layout === 'desktop')) return el;
            }
        }
        return null;
    }

    function measure() {
        if (!target) return;
        if (!target.isConnected) { target = null; return; }
        const v = view();
        const s = spotRect(target.getBoundingClientRect(), v);
        spot.style.cssText = `left:${s.left}px;top:${s.top}px;width:${s.width}px;height:${s.height}px`;
        const p = placeTip(s, { w: tip.offsetWidth, h: tip.offsetHeight }, v);
        tip.style.left = `${p.x}px`;
        tip.style.top = `${p.y}px`;
        tip.dataset.side = p.side;
    }

    function show(i) {
        while (i < steps.length) {
            const el = find(steps[i][0]);
            if (el) {
                index = i;
                target = el;
                const [, t, fine, touch] = steps[i];
                count.textContent = `Tip ${i + 1} of ${steps.length}`;
                title.textContent = t;
                text.textContent = coarse() ? touch : fine;
                nextBtn.textContent = i === steps.length - 1 ? 'Done' : 'Next';
                measure();
                bus.emit('announce', `${t}. ${text.textContent}`);
                return;
            }
            i += 1;
        }
        stop();
    }

    function start(force = false) {
        clearTimeout(startTimer);
        if (!layer.hidden) return;
        const s = store.get();
        if (!force && loadPref('coachSeen', false)) return;
        if (ui.layout === 'text' || s.status?.webgl === false || s.ui?.tour || s.ui?.cinema || s.status?.introPlaying) return;
        // The phone's sheet comes down to its peek, where the chips and the time bar are.
        const wait = ui.layout === 'mobile' && s.ui?.sheet !== 'peek' ? 380 : 0;
        if (wait) store.set({ ui: { ...s.ui, sheet: 'peek' } });
        startTimer = setTimeout(() => {
            steps = COACH_STEPS.slice();
            layer.hidden = false;
            document.body.classList.add('is-coaching');
            show(0);
            if (layer.hidden) return;   // nothing to point at
            release = trapFocus(tip, { initial: nextBtn });
            poll = setInterval(measure, 250);
        }, wait);
    }

    function stop() {
        clearTimeout(startTimer);
        if (layer.hidden) return;
        layer.hidden = true;
        document.body.classList.remove('is-coaching');
        clearInterval(poll);
        target = null;
        index = -1;
        savePref('coachSeen', true);
        release?.();
        release = null;
        ui.emit('coach', 'done');
    }

    const next = () => show(index + 1);
    offs.push(on(nextBtn, 'click', next));
    offs.push(on(skipBtn, 'click', stop));
    offs.push(on(tip, 'keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        stop();
    }));
    // A tap on the spotlight is 'next'; anywhere else outside the tip ends the tips.
    offs.push(on(layer, 'click', (e) => {
        if (tip.contains(/** @type {Node} */ (e.target))) return;
        const r = spot.getBoundingClientRect();
        const inSpot = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (inSpot) next();
        else stop();
    }));
    offs.push(on(window, 'resize', measure));
    // A tour, the hidden interface or text mode ends them.
    offs.push(store.subscribe((s) => `${!!s.ui?.tour}|${!!s.ui?.cinema}|${s.status?.webgl}`, () => {
        const s = store.get();
        if (s.ui?.tour || s.ui?.cinema || s.status?.webgl === false) stop();
    }));

    // The first visit: after the intro, or once ready when reduced motion skips it.
    if (ctx.env?.firstRun && !loadPref('coachSeen', false)) {
        let armed = true;
        const arm = (ms) => {
            if (!armed) return;
            armed = false;
            startTimer = setTimeout(() => start(false), ms);
        };
        if (ctx.env.reducedMotion) offs.push(store.subscribe((s) => s.status?.phase, (p) => { if (p === 'ready') arm(1200); }, { immediate: true }));
        else offs.push(bus.on('intro', (p) => { if (p === 'done') arm(1500); }));
    }

    ui.showTips = () => start(true);
    ui.coachOpen = () => !layer.hidden;
    return {
        start, stop,
        destroy() {
            offs.forEach((off) => off());
            clearTimeout(startTimer);
            clearInterval(poll);
            release?.();
            layer.remove();
        },
    };
}
