/**
 * Toasts (`bus 'toast'` → `{message, kind, actionLabel?, onAction?, timeoutMs?}`)
 * and the shortcut "flash" pill.
 *
 * - At most three toasts are visible; the oldest leaves first.
 * - An identical message already on screen is refreshed instead of duplicated.
 * - Only one toast per action label (e.g. one "Undo") is kept: a newer one replaces it.
 * - Timers pause while the pointer or focus is on a toast.
 *
 * `mountToasts` is idempotent per bus, so the app may also call it safely.
 *
 * @module ui/toast
 */

import { h, on } from './dom.js';
import { icon } from './icons.js';

const instances = new WeakMap();
const MAX_VISIBLE = 3;

/**
 * Mounts the toast stack and subscribes to `bus 'toast'`.
 * @param {HTMLElement} root container
 * @param {{on(type:string, fn:(p:any)=>void): () => void}} bus
 * @returns {{show(p:any): void, destroy(): void}}
 */
export function mountToasts(root, bus) {
    if (instances.has(bus)) return instances.get(bus);
    const stack = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
    root.appendChild(stack);
    /** @type {{el:HTMLElement, message:string, actionLabel?:string, timer:number, remaining:number, started:number, paused:boolean}[]} */
    const live = [];

    function dismiss(t, immediate = false) {
        const i = live.indexOf(t);
        if (i < 0) return;
        live.splice(i, 1);
        clearTimeout(t.timer);
        t.el.classList.add('is-leaving');
        const kill = () => t.el.remove();
        if (immediate || document.body.classList.contains('is-reduced-motion')) kill();
        else setTimeout(kill, 200);
    }

    function arm(t) {
        clearTimeout(t.timer);
        if (!Number.isFinite(t.remaining) || t.remaining <= 0) return;
        t.started = performance.now();
        t.timer = setTimeout(() => dismiss(t), t.remaining);
    }

    /** @param {{message:string, kind?:'info'|'warn'|'error', actionLabel?:string, onAction?:()=>void, timeoutMs?:number}} p */
    function show(p) {
        if (!p || !p.message) return;
        const kind = p.kind === 'warn' || p.kind === 'error' ? p.kind : 'info';
        const timeout = Number.isFinite(p.timeoutMs) ? p.timeoutMs : p.actionLabel ? 8000 : kind === 'error' ? 10000 : 4500;
        const same = live.find((t) => t.message === p.message);
        if (same) {
            same.remaining = timeout;
            arm(same);
            same.el.classList.remove('is-bump');
            void same.el.offsetWidth; // restart the bump animation
            same.el.classList.add('is-bump');
            return;
        }
        if (p.actionLabel) {
            const prev = live.find((t) => t.actionLabel === p.actionLabel);
            if (prev) dismiss(prev, true);
        }
        const actionBtn = p.actionLabel ? h('button', { class: 'btn btn--toast', type: 'button' },
            p.actionLabel === 'Undo' ? icon('undo', { size: 15 }) : null, p.actionLabel) : null;
        const closeBtn = h('button', { class: 'icon-btn icon-btn--sm toast__close', type: 'button', 'aria-label': 'Dismiss notification' }, icon('close', { size: 14 }));
        const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
            h('span', { class: 'toast__icon', 'aria-hidden': 'true' }, icon(kind === 'info' ? 'info' : 'warning', { size: 18 })),
            h('span', { class: 'toast__msg' }, p.message),
            actionBtn, closeBtn);
        const t = { el, message: p.message, actionLabel: p.actionLabel, timer: 0, remaining: timeout, started: 0, paused: false };
        if (actionBtn) {
            on(actionBtn, 'click', () => {
                try { p.onAction?.(); } catch (err) { console.error('[ui] toast action failed', err); }
                dismiss(t);
            });
        }
        on(closeBtn, 'click', () => dismiss(t));
        const pause = () => {
            if (t.paused) return;
            t.paused = true;
            clearTimeout(t.timer);
            t.remaining = Math.max(1500, t.remaining - (performance.now() - t.started));
        };
        const resume = () => { if (!t.paused) return; t.paused = false; arm(t); };
        on(el, 'pointerenter', pause);
        on(el, 'pointerleave', resume);
        on(el, 'focusin', pause);
        on(el, 'focusout', resume);
        stack.appendChild(el);
        live.push(t);
        while (live.length > MAX_VISIBLE) dismiss(live[0], true);
        arm(t);
    }

    const off = bus.on('toast', show);
    const api = {
        show,
        destroy() {
            off();
            for (const t of [...live]) dismiss(t, true);
            stack.remove();
            instances.delete(bus);
        },
    };
    instances.set(bus, api);
    return api;
}

/**
 * Mounts the shortcut feedback pill ("Beams off", "Speed 1 h/s").
 * Purely visual: the announcer covers screen readers.
 * @param {HTMLElement} root container
 * @returns {{show(text:string): void, destroy(): void}}
 */
export function mountFlash(root) {
    const el = h('div', { class: 'flash', 'aria-hidden': 'true' });
    root.appendChild(el);
    let timer = 0;
    return {
        show(text) {
            if (!text) return;
            el.textContent = text;
            el.classList.remove('is-on');
            void el.offsetWidth;
            el.classList.add('is-on');
            clearTimeout(timer);
            timer = setTimeout(() => el.classList.remove('is-on'), 1200);
        },
        destroy() { clearTimeout(timer); el.remove(); },
    };
}
