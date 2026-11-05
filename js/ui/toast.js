/**
 * Toasts (`bus 'toast'` → `{message, kind, actionLabel?, actionIcon?, onAction?, timeoutMs?}`). The
 * shortcut flash is the status stack's (ui/modes.js). Messages and labels arrive translated; an
 * Undo action (t('Undo'), or `actionIcon: 'undo'`) shows its icon.
 *
 * - At most three toasts are visible; the oldest leaves first.
 * - An identical message already on screen is refreshed instead of duplicated.
 * - Only one toast per action label (e.g. one "Undo") is kept: a newer one replaces it.
 * - Timers pause while the pointer or focus is on a toast. `timeoutMs: 0` keeps it until it is
 *   dismissed or acted on ("A new version is ready · Reload").
 *
 * `mountToasts` is idempotent per bus, so the app may also call it safely.
 *
 * @module ui/toast
 */

import { h, on } from './dom.js';
import { icon } from './icons.js';
import { t } from '../core/i18n.js';

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
    const stack = h('div', { class: 'toasts', role: 'region', 'aria-label': t('Notifications') });
    root.appendChild(stack);
    /** @type {{el:HTMLElement, message:string, actionLabel?:string, timer:number, remaining:number, started:number, paused:boolean}[]} */
    const live = [];

    function dismiss(toast, immediate = false) {
        const i = live.indexOf(toast);
        if (i < 0) return;
        live.splice(i, 1);
        clearTimeout(toast.timer);
        toast.el.classList.add('is-leaving');
        const kill = () => toast.el.remove();
        if (immediate || document.body.classList.contains('is-reduced-motion')) kill();
        else setTimeout(kill, 200);
    }

    function arm(toast) {
        clearTimeout(toast.timer);
        if (!Number.isFinite(toast.remaining) || toast.remaining <= 0) return;
        toast.started = performance.now();
        toast.timer = setTimeout(() => dismiss(toast), toast.remaining);
    }

    /** @param {{message:string, kind?:'info'|'warn'|'error', actionLabel?:string, actionIcon?:string, onAction?:()=>void, timeoutMs?:number}} p */
    function show(p) {
        if (!p || !p.message) return;
        const kind = p.kind === 'warn' || p.kind === 'error' ? p.kind : 'info';
        const timeout = Number.isFinite(p.timeoutMs) ? p.timeoutMs : p.actionLabel ? 8000 : kind === 'error' ? 10000 : 4500;
        const same = live.find((x) => x.message === p.message);
        if (same) {
            same.remaining = timeout;
            arm(same);
            same.el.classList.remove('is-bump');
            void same.el.offsetWidth; // restart the bump animation
            same.el.classList.add('is-bump');
            return;
        }
        if (p.actionLabel) {
            const prev = live.find((x) => x.actionLabel === p.actionLabel);
            if (prev) dismiss(prev, true);
        }
        const undo = p.actionIcon === 'undo' || p.actionLabel === t('Undo') || p.actionLabel === 'Undo';
        const actionBtn = p.actionLabel ? h('button', { class: 'btn btn--toast', type: 'button' },
            undo ? icon('undo', { size: 15 }) : null, p.actionLabel) : null;
        const closeBtn = h('button', { class: 'icon-btn icon-btn--sm toast__close', type: 'button', 'aria-label': t('Dismiss notification') }, icon('close', { size: 14 }));
        const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
            h('span', { class: 'toast__icon', 'aria-hidden': 'true' }, icon(kind === 'info' ? 'info' : 'warning', { size: 18 })),
            h('span', { class: 'toast__msg' }, p.message),
            actionBtn, closeBtn);
        const toast = { el, message: p.message, actionLabel: p.actionLabel, timer: 0, remaining: timeout, started: 0, paused: false };
        if (actionBtn) {
            on(actionBtn, 'click', () => {
                try { p.onAction?.(); } catch (err) { console.error('[ui] toast action failed', err); }
                dismiss(toast);
            });
        }
        on(closeBtn, 'click', () => dismiss(toast));
        const pause = () => {
            if (toast.paused || !(toast.remaining > 0)) return;   // a sticky toast has no timer to pause
            toast.paused = true;
            clearTimeout(toast.timer);
            toast.remaining = Math.max(1500, toast.remaining - (performance.now() - toast.started));
        };
        const resume = () => { if (!toast.paused) return; toast.paused = false; arm(toast); };
        on(el, 'pointerenter', pause);
        on(el, 'pointerleave', resume);
        on(el, 'focusin', pause);
        on(el, 'focusout', resume);
        stack.appendChild(el);
        live.push(toast);
        while (live.length > MAX_VISIBLE) dismiss(live[0], true);
        arm(toast);
    }

    const off = bus.on('toast', show);
    const api = {
        show,
        destroy() {
            off();
            for (const x of [...live]) dismiss(x, true);
            stack.remove();
            instances.delete(bus);
        },
    };
    instances.set(bus, api);
    return api;
}
