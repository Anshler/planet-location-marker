/**
 * Inline SVG icon set: original 24-px stroke icons (round caps and joins,
 * `currentColor`), so they inherit text colour and scale crisply at any DPR.
 *
 * `icon(name, {size, title})` returns a fresh SVGElement. Icons are decorative
 * (`aria-hidden`) unless a `title` is given, in which case they get `role="img"`
 * and a <title>.
 *
 * Spec names: play pause step-back step-fwd reverse live search locate pin globe sky
 * lock unlock share layers info calendar settings close help fullscreen chevron-up
 * sun moon planet eye eye-off undo copy — plus UI extras listed in ICON_NAMES.
 *
 * @module ui/icons
 */

import { svgNS } from './dom.js';

/**
 * Icon geometry: each entry is a list of [tag, attrs]. `F` marks filled shapes
 * (fill currentColor, no stroke), used sparingly for media glyphs and dots.
 */
const F = { fill: 'currentColor', stroke: 'none' };

/** @type {Record<string, Array<[string, Record<string, string|number>]>>} */
const ICONS = {
    play: [['path', { d: 'M8.2 5.6v12.8a.9.9 0 0 0 1.37.77l10.2-6.4a.9.9 0 0 0 0-1.54L9.57 4.83a.9.9 0 0 0-1.37.77z', ...F }]],
    pause: [['rect', { x: 6.6, y: 5.2, width: 3.6, height: 13.6, rx: 1.1, ...F }], ['rect', { x: 13.8, y: 5.2, width: 3.6, height: 13.6, rx: 1.1, ...F }]],
    'step-back': [['path', { d: 'M6.5 5.5v13' }], ['path', { d: 'M18.2 6.6v10.8a.8.8 0 0 1-1.25.66L9.4 12.66a.8.8 0 0 1 0-1.32l7.55-5.4a.8.8 0 0 1 1.25.66z', ...F }]],
    'step-fwd': [['path', { d: 'M17.5 5.5v13' }], ['path', { d: 'M5.8 6.6v10.8a.8.8 0 0 0 1.25.66l7.55-5.4a.8.8 0 0 0 0-1.32L7.05 5.94a.8.8 0 0 0-1.25.66z', ...F }]],
    reverse: [['path', { d: 'M4 8.5h14.5' }], ['path', { d: 'M15 5l3.5 3.5L15 12' }], ['path', { d: 'M20 15.5H5.5' }], ['path', { d: 'M9 12l-3.5 3.5L9 19' }]],
    live: [['circle', { cx: 12, cy: 12, r: 2.3, ...F }], ['path', { d: 'M8.4 8.4a5.1 5.1 0 0 0 0 7.2M15.6 8.4a5.1 5.1 0 0 1 0 7.2' }], ['path', { d: 'M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8' }]],
    search: [['circle', { cx: 10.8, cy: 10.8, r: 6.3 }], ['path', { d: 'M15.5 15.5L20 20' }]],
    locate: [['circle', { cx: 12, cy: 12, r: 6.5 }], ['circle', { cx: 12, cy: 12, r: 2.2, ...F }], ['path', { d: 'M12 2.8v2.7M12 18.5v2.7M2.8 12h2.7M18.5 12h2.7' }]],
    pin: [['path', { d: 'M12 21.2s-6.6-5.7-6.6-11.1a6.6 6.6 0 0 1 13.2 0c0 5.4-6.6 11.1-6.6 11.1z' }], ['circle', { cx: 12, cy: 10.1, r: 2.4 }]],
    globe: [['circle', { cx: 12, cy: 12, r: 8.8 }], ['path', { d: 'M3.6 9.2h16.8M3.6 14.8h16.8' }], ['path', { d: 'M12 3.2c2.4 2.5 3.6 5.4 3.6 8.8s-1.2 6.3-3.6 8.8c-2.4-2.5-3.6-5.4-3.6-8.8s1.2-6.3 3.6-8.8z' }]],
    sky: [['path', { d: 'M3 19.5h18' }], ['path', { d: 'M5.2 19.5c1.4-2.6 3.9-4.2 6.8-4.2s5.4 1.6 6.8 4.2' }], ['path', { d: 'M12 3.6l1.05 2.55 2.55 1.05-2.55 1.05L12 10.8l-1.05-2.55L8.4 7.2l2.55-1.05z', ...F }], ['circle', { cx: 18.4, cy: 5.4, r: 0.95, ...F }], ['circle', { cx: 5.6, cy: 9.6, r: 0.95, ...F }]],
    lock: [['rect', { x: 5.2, y: 10.6, width: 13.6, height: 9.6, rx: 2.2 }], ['path', { d: 'M8.3 10.6V8a3.7 3.7 0 0 1 7.4 0v2.6' }], ['path', { d: 'M12 14.4v2.2' }]],
    unlock: [['rect', { x: 5.2, y: 10.6, width: 13.6, height: 9.6, rx: 2.2 }], ['path', { d: 'M8.3 10.6V8a3.7 3.7 0 0 1 7.15-1.35' }], ['path', { d: 'M12 14.4v2.2' }]],
    share: [['path', { d: 'M12 3.4v11.2' }], ['path', { d: 'M8 7.2l4-3.8 4 3.8' }], ['path', { d: 'M8.5 10.5H7a2 2 0 0 0-2 2v6.1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.1a2 2 0 0 0-2-2h-1.5' }]],
    layers: [['path', { d: 'M12 3.6l8.4 4.6L12 12.8 3.6 8.2z' }], ['path', { d: 'M3.6 12.2l8.4 4.6 8.4-4.6' }], ['path', { d: 'M3.6 16.1l8.4 4.6 8.4-4.6' }]],
    info: [['circle', { cx: 12, cy: 12, r: 8.8 }], ['path', { d: 'M12 11v5.6' }], ['circle', { cx: 12, cy: 7.7, r: 1.05, ...F }]],
    calendar: [['rect', { x: 3.8, y: 5.2, width: 16.4, height: 15, rx: 2.6 }], ['path', { d: 'M3.8 10h16.4M8.3 3.2v3.6M15.7 3.2v3.6' }], ['circle', { cx: 8.5, cy: 14.2, r: 1, ...F }], ['circle', { cx: 12, cy: 14.2, r: 1, ...F }], ['circle', { cx: 15.5, cy: 14.2, r: 1, ...F }]],
    settings: [['path', { d: 'M4 7h9.2M17.8 7H20M4 17h2.2M10.8 17H20' }], ['circle', { cx: 15.5, cy: 7, r: 2.3 }], ['circle', { cx: 8.5, cy: 17, r: 2.3 }]],
    close: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
    help: [['circle', { cx: 12, cy: 12, r: 8.8 }], ['path', { d: 'M9.6 9.6a2.5 2.5 0 1 1 3.6 2.25c-.75.36-1.2 1-1.2 1.8v.5' }], ['circle', { cx: 12, cy: 16.9, r: 1.05, ...F }]],
    fullscreen: [['path', { d: 'M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3' }]],
    'fullscreen-exit': [['path', { d: 'M9 4v3a2 2 0 0 1-2 2H4M20 9h-3a2 2 0 0 1-2-2V4M15 20v-3a2 2 0 0 1 2-2h3M4 15h3a2 2 0 0 1 2 2v3' }]],
    'chevron-up': [['path', { d: 'M6 14.8l6-6 6 6' }]],
    'chevron-down': [['path', { d: 'M6 9.2l6 6 6-6' }]],
    'chevron-left': [['path', { d: 'M14.8 6l-6 6 6 6' }]],
    'chevron-right': [['path', { d: 'M9.2 6l6 6-6 6' }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.35 5.35l1.5 1.5M17.15 17.15l1.5 1.5M5.35 18.65l1.5-1.5M17.15 6.85l1.5-1.5' }]],
    moon: [['path', { d: 'M19.6 14.6A8.2 8.2 0 1 1 9.4 4.4a6.6 6.6 0 0 0 10.2 10.2z' }]],
    planet: [['circle', { cx: 12, cy: 12, r: 5.2 }], ['path', { d: 'M7.1 15.2c-2.7 1.7-4 3.2-3.5 4 .8 1.4 6.3-.7 11.1-3.6s8.2-6.6 7.4-8c-.5-.8-2.3-.6-5 .5' }]],
    eye: [['path', { d: 'M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z' }], ['circle', { cx: 12, cy: 12, r: 2.9 }]],
    'eye-off': [['path', { d: 'M9.9 5.8A9.9 9.9 0 0 1 12 5.6C18 5.6 21.4 12 21.4 12a17 17 0 0 1-2.4 3.2M14.1 14.2A2.9 2.9 0 0 1 9.8 10M6.6 7.1C4 8.9 2.6 12 2.6 12S6 18.4 12 18.4a9.4 9.4 0 0 0 4.9-1.4' }], ['path', { d: 'M3.5 3.5l17 17' }]],
    undo: [['path', { d: 'M8.8 13.8L4.2 9.2l4.6-4.6' }], ['path', { d: 'M4.2 9.2h10.3a5.3 5.3 0 0 1 0 10.6H11' }]],
    copy: [['rect', { x: 8.6, y: 8.6, width: 11.6, height: 11.6, rx: 2.2 }], ['path', { d: 'M15.4 8.6V6a2.2 2.2 0 0 0-2.2-2.2H6A2.2 2.2 0 0 0 3.8 6v7.2A2.2 2.2 0 0 0 6 15.4h2.6' }]],
    // ---- UI extras -------------------------------------------------------
    minus: [['path', { d: 'M5.5 12h13' }]],
    plus: [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
    check: [['path', { d: 'M5 12.6l4.4 4.4L19 7.4' }]],
    external: [['path', { d: 'M14 4h6v6M20 4l-8.6 8.6' }], ['path', { d: 'M18 14.2v3.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.8' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 8.8 }], ['path', { d: 'M12 7.2V12l3.2 2' }]],
    events: [['path', { d: 'M12 3.4l1.8 5.1 5.4.2-4.3 3.3 1.5 5.2L12 14.2l-4.4 3 1.5-5.2-4.3-3.3 5.4-.2z' }]],
    timelapse: [['path', { d: 'M17 3.4l3 3-3 3' }], ['path', { d: 'M4 11.2v-.8a4 4 0 0 1 4-4h12' }], ['path', { d: 'M7 20.6l-3-3 3-3' }], ['path', { d: 'M20 12.8v.8a4 4 0 0 1-4 4H4' }]],
    target: [['circle', { cx: 12, cy: 12, r: 7.6 }], ['circle', { cx: 12, cy: 12, r: 2.6 }], ['path', { d: 'M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6' }]],
    path: [['path', { d: 'M3.6 17.4c2.8-6.6 6.2-9.9 9.8-9.4 2.4.4 3.4 2.6 2.2 4.2-1.2 1.5-3.6.9-3.2-1 .5-2.6 3.8-4.6 8-4.4', 'stroke-dasharray': '2.2 2.6' }], ['circle', { cx: 20.4, cy: 6.8, r: 1.4, ...F }]],
    footprint: [['circle', { cx: 12, cy: 12, r: 2.2, ...F }], ['path', { d: 'M7.6 16.4a6.2 6.2 0 0 1 0-8.8M16.4 7.6a6.2 6.2 0 0 1 0 8.8' }], ['path', { d: 'M4.8 19.2a10.2 10.2 0 0 1 0-14.4M19.2 4.8a10.2 10.2 0 0 1 0 14.4' }]],
    keyboard: [['rect', { x: 2.6, y: 6, width: 18.8, height: 12, rx: 2.4 }], ['path', { d: 'M6.4 10h.01M9.5 10h.01M12.6 10h.01M15.7 10h.01M8 14.2h8', 'stroke-width': 2 }]],
    panel: [['rect', { x: 3.6, y: 4.2, width: 16.8, height: 15.6, rx: 2.6 }], ['path', { d: 'M14.6 4.2v15.6' }]],
    'panel-close': [['rect', { x: 3.6, y: 4.2, width: 16.8, height: 15.6, rx: 2.6 }], ['path', { d: 'M14.6 4.2v15.6' }], ['path', { d: 'M8.2 9.6l2.4 2.4-2.4 2.4' }]],
    'panel-open': [['rect', { x: 3.6, y: 4.2, width: 16.8, height: 15.6, rx: 2.6 }], ['path', { d: 'M14.6 4.2v15.6' }], ['path', { d: 'M10.6 9.6L8.2 12l2.4 2.4' }]],
    warning: [['path', { d: 'M10.4 4.6a1.85 1.85 0 0 1 3.2 0l7.2 12.6a1.85 1.85 0 0 1-1.6 2.8H4.8a1.85 1.85 0 0 1-1.6-2.8z' }], ['path', { d: 'M12 9.6v4.2' }], ['circle', { cx: 12, cy: 16.7, r: 1, ...F }]],
    city: [['path', { d: 'M3.6 20.4h16.8' }], ['path', { d: 'M5.4 20.4V9.6l5-2.6v13.4' }], ['path', { d: 'M10.4 20.4V4.4l8.2 3.4v12.6' }], ['path', { d: 'M13.2 9.8h2.6M13.2 13h2.6M13.2 16.2h2.6M7.6 12.4h.6M7.6 15.6h.6' }]],
    history: [['path', { d: 'M3.6 12a8.4 8.4 0 1 0 2.5-6' }], ['path', { d: 'M3.4 4.4v3.8h3.8' }], ['path', { d: 'M12 7.8V12l2.8 1.8' }]],
    crosshair: [['circle', { cx: 12, cy: 12, r: 8.4 }], ['path', { d: 'M12 3.6v4.2M12 16.2v4.2M3.6 12h4.2M16.2 12h4.2' }]],
    star: [['path', { d: 'M12 4.2l2.3 4.75 5.2.75-3.75 3.65.9 5.15L12 16.05l-4.65 2.45.9-5.15L4.5 9.7l5.2-.75z' }]],
    grid: [['circle', { cx: 12, cy: 12, r: 8.8 }], ['path', { d: 'M3.6 12h16.8M12 3.2v17.6' }], ['path', { d: 'M5.2 7.2h13.6M5.2 16.8h13.6' }]],
    signal: [['path', { d: 'M4.4 9.4a11 11 0 0 1 15.2 0M7.2 12.6a7 7 0 0 1 9.6 0M10 15.8a3 3 0 0 1 4 0' }], ['circle', { cx: 12, cy: 19, r: 1.1, ...F }]],
    'signal-off': [['path', { d: 'M4.4 9.4a11 11 0 0 1 4.6-2.7M14.6 6.6a11 11 0 0 1 5 2.8M7.2 12.6a7 7 0 0 1 3-1.6M16.8 12.6l-.4-.4M10 15.8a3 3 0 0 1 4 0' }], ['circle', { cx: 12, cy: 19, r: 1.1, ...F }], ['path', { d: 'M3.5 3.5l17 17' }]],
    sparkle: [['path', { d: 'M12 3.4l1.6 5.2 5.2 1.6-5.2 1.6L12 17l-1.6-5.2-5.2-1.6 5.2-1.6z', ...F }], ['path', { d: 'M18.6 15.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z', ...F }]],
    arrow: [['path', { d: 'M12 19V5M6.5 10.5L12 5l5.5 5.5' }]],
    'arrow-right': [['path', { d: 'M5 12h14M13.5 6.5L19 12l-5.5 5.5' }]],
    home: [['path', { d: 'M4.2 11.2L12 4.4l7.8 6.8' }], ['path', { d: 'M6.4 9.6v9.2a1.2 1.2 0 0 0 1.2 1.2h8.8a1.2 1.2 0 0 0 1.2-1.2V9.6' }]],
    eclipse: [['circle', { cx: 12, cy: 12, r: 8.4 }], ['path', { d: 'M15.2 4.2a8.4 8.4 0 0 1 0 15.6 8.4 8.4 0 0 0 0-15.6z', ...F }]],
    season: [['circle', { cx: 12, cy: 12, r: 8.4 }], ['path', { d: 'M12 3.6v16.8' }], ['path', { d: 'M12 3.6a8.4 8.4 0 0 1 0 16.8z', fill: 'currentColor', stroke: 'none', opacity: 0.35 }]],
    'moon-phase': [['circle', { cx: 12, cy: 12, r: 8.4 }], ['path', { d: 'M12 3.6a8.4 8.4 0 0 1 0 16.8 4.4 8.4 0 0 0 0-16.8z', ...F }]],
    opposition: [['circle', { cx: 4.8, cy: 12, r: 2.2, ...F }], ['circle', { cx: 12, cy: 12, r: 1.6 }], ['circle', { cx: 19.2, cy: 12, r: 2.2 }], ['path', { d: 'M7.6 12h2.4M14 12h2.4', 'stroke-dasharray': '1.2 1.6' }]],
    conjunction: [['circle', { cx: 9.4, cy: 12, r: 4.2 }], ['circle', { cx: 15.6, cy: 12, r: 2.4, ...F }]],
    elongation: [['circle', { cx: 6, cy: 15.8, r: 2.6, ...F }], ['path', { d: 'M6 15.8L18.4 6.6' }], ['circle', { cx: 18.4, cy: 6.6, r: 1.8 }], ['path', { d: 'M11 15.8a5 5 0 0 0-1-3', 'stroke-dasharray': '1 1.4' }]],
    rise: [['path', { d: 'M3 17.6h18' }], ['path', { d: 'M6.6 17.6a5.4 5.4 0 0 1 10.8 0' }], ['path', { d: 'M12 3.4v6.2M9.4 6.2L12 3.6l2.6 2.6' }]],
    set: [['path', { d: 'M3 17.6h18' }], ['path', { d: 'M6.6 17.6a5.4 5.4 0 0 1 10.8 0' }], ['path', { d: 'M12 3.4v6.2M9.4 6.8L12 9.4l2.6-2.6' }]],
    menu: [['path', { d: 'M4.5 7h15M4.5 12h15M4.5 17h15' }]],
    dot: [['circle', { cx: 12, cy: 12, r: 4, ...F }]],
};

/** All available icon names (spec set plus UI extras). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** Cached template per name; cloneNode is far cheaper than rebuilding paths. */
const templates = new Map();

function template(name) {
    let t = templates.get(name);
    if (t) return t;
    const spec = ICONS[name] || ICONS.dot;
    t = document.createElementNS(svgNS(), 'svg');
    t.setAttribute('viewBox', '0 0 24 24');
    t.setAttribute('fill', 'none');
    t.setAttribute('stroke', 'currentColor');
    t.setAttribute('stroke-width', '1.7');
    t.setAttribute('stroke-linecap', 'round');
    t.setAttribute('stroke-linejoin', 'round');
    t.setAttribute('class', `icon icon-${name}`);
    for (const [tag, attrs] of spec) {
        const el = document.createElementNS(svgNS(), tag);
        for (const k in attrs) el.setAttribute(k, String(attrs[k]));
        t.appendChild(el);
    }
    templates.set(name, t);
    return t;
}

/**
 * Returns a new inline SVG icon.
 * @param {string} name Icon name (unknown names render a dot rather than throwing).
 * @param {{size?: number, title?: string, className?: string}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 20, title, className } = {}) {
    const svg = /** @type {SVGSVGElement} */ (template(name).cloneNode(true));
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    if (className) svg.setAttribute('class', `icon icon-${name} ${className}`);
    if (title) {
        svg.setAttribute('role', 'img');
        const t = document.createElementNS(svgNS(), 'title');
        t.textContent = title;
        svg.insertBefore(t, svg.firstChild);
    } else {
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
    }
    return svg;
}

/**
 * Swaps the icon inside a button (keeps any text siblings).
 * @param {Element} host Element containing exactly one `svg.icon` child to replace.
 * @param {string} name
 * @param {number} [size=20]
 */
export function swapIcon(host, name, size = 20) {
    const old = host.querySelector('svg.icon');
    if (old && old.classList.contains(`icon-${name}`)) return;
    const next = icon(name, { size });
    if (old) old.replaceWith(next); else host.prepend(next);
}
