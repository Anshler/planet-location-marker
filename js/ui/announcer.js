/**
 * Polite screen-reader announcer for `bus 'announce'` strings
 * ("Observer set to Tokyo, Japan", "Time: 12 Oct 2026, 21:00, paused",
 * "Mars selected, 34 degrees up in the south-east").
 *
 * Throttled to one announcement per 2 s: the first speaks at once, later ones
 * wait and the latest wins. A repeat of the last text within 3 s is dropped.
 * Idempotent per bus.
 *
 * @module ui/announcer
 */

import { h } from './dom.js';

const instances = new WeakMap();
const GAP_MS = 2000;

/**
 * Mounts the visually hidden live region.
 * @param {HTMLElement} root container
 * @param {{on(type:string, fn:(p:any)=>void): () => void}} bus
 * @returns {{say(text:string): void, destroy(): void}}
 */
export function mountAnnouncer(root, bus) {
    if (instances.has(bus)) return instances.get(bus);
    const region = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    root.appendChild(region);
    let lastAt = -Infinity;
    let lastText = '';
    let pending = '';
    let timer = 0;

    function flush() {
        timer = 0;
        if (!pending) return;
        // Clearing first makes screen readers re-read identical consecutive strings.
        region.textContent = '';
        const text = pending;
        pending = '';
        requestAnimationFrame(() => { region.textContent = text; });
        lastText = text;
        lastAt = performance.now();
    }

    /** @param {string} text */
    function say(text) {
        if (typeof text !== 'string' || !text.trim()) return;
        const now = performance.now();
        if (text === lastText && now - lastAt < 3000) return;
        pending = text;
        if (timer) return;
        const wait = Math.max(0, lastAt + GAP_MS - now);
        timer = setTimeout(flush, wait);
    }

    const off = bus.on('announce', say);
    const api = {
        say,
        destroy() {
            off();
            clearTimeout(timer);
            region.remove();
            instances.delete(bus);
        },
    };
    instances.set(bus, api);
    return api;
}
