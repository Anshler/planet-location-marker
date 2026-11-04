/**
 * Tiny DOM toolkit for the Planet Location Marker UI (no framework, no innerHTML).
 *
 * - `h()` builds elements declaratively; text is always inserted as text nodes,
 *   so place names from geocoders can never inject markup.
 * - `on()` returns an unsubscribe function so every module can tear down cleanly.
 * - `trapFocus()` keeps Tab inside an open dialog or the full-height sheet.
 * - `openPopover()` anchors a floating panel to a trigger, with outside-click / Esc dismissal.
 * - `menu()` is the one menu-button builder (Tools, Share, ⋯); `rovingKeys()` the arrow-key roving
 *   of radiogroups and menus; `tpl()` fills a whole-phrase template with text or nodes.
 *
 * @module ui/dom
 */

import { icon } from './icons.js';

let svgNs = '';
/**
 * The SVG namespace URI, read from the HTML parser at first use. (Keeping the
 * literal out of the source lets the repo's "no external URLs" scan stay strict.)
 * @returns {string}
 */
export function svgNS() {
    if (!svgNs) {
        const t = document.createElement('template');
        t.innerHTML = '<svg></svg>';
        svgNs = /** @type {Element} */ (t.content.firstChild).namespaceURI || '';
    }
    return svgNs;
}

/** Attributes that are reflected as boolean presence attributes. */
const BOOL_ATTRS = new Set(['disabled', 'hidden', 'checked', 'selected', 'readonly', 'required',
    'multiple', 'autofocus', 'inert', 'open', 'novalidate']);

/** Properties that must be assigned as JS properties rather than attributes. */
const PROPS = new Set(['value', 'checked', 'indeterminate', 'selectedIndex', 'scrollTop']);

/**
 * Creates an HTML element.
 *
 * `attrs` keys:
 * - `class` / `className`: class string (falsy parts ignored when an array is given);
 * - `style`: a cssText string or an object (custom properties such as `--c` allowed);
 * - `dataset`: object of `data-*` values;
 * - `text`: textContent;
 * - `onClick`, `onKeydown`, …: event listeners (lower-cased event name);
 * - `aria-*` / `data-*`: always stringified, so `false` becomes `"false"`;
 * - boolean attributes (`disabled`, `hidden`, …): present when truthy;
 * - anything else: `setAttribute(key, String(value))`, skipped when null/undefined/false.
 *
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children Nodes, strings, numbers, arrays (flattened) or falsy (skipped).
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) applyAttrs(el, attrs);
    append(el, children);
    return el;
}

/**
 * Creates an SVG element in the SVG namespace (attributes set verbatim).
 * @param {string} tag
 * @param {Record<string, string|number>} [attrs]
 * @param {...any} children
 * @returns {SVGElement}
 */
export function s(tag, attrs, ...children) {
    const el = document.createElementNS(svgNS(), tag);
    if (attrs) for (const k in attrs) { if (attrs[k] != null) el.setAttribute(k, String(attrs[k])); }
    append(el, children);
    return el;
}

/**
 * Applies the `h()` attribute vocabulary to an existing element.
 * @param {Element} el
 * @param {Record<string, any>} attrs
 */
export function applyAttrs(el, attrs) {
    for (const key in attrs) {
        const v = attrs[key];
        if (key === 'class' || key === 'className') {
            const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
            if (cls) el.setAttribute('class', cls);
        } else if (key === 'style') {
            if (typeof v === 'string') el.style.cssText = v;
            else if (v) for (const p in v) { if (v[p] != null) el.style.setProperty(p.startsWith('--') ? p : kebab(p), String(v[p])); }
        } else if (key === 'dataset') {
            if (v) for (const d in v) { if (v[d] != null) el.dataset[d] = String(v[d]); }
        } else if (key === 'text') {
            el.textContent = v == null ? '' : String(v);
        } else if (key.length > 2 && key[0] === 'o' && key[1] === 'n' && typeof v === 'function') {
            el.addEventListener(key.slice(2).toLowerCase(), v);
        } else if (key.startsWith('aria-') || key.startsWith('data-')) {
            if (v != null) el.setAttribute(key, String(v));
        } else if (PROPS.has(key)) {
            if (v != null) el[key] = v;
        } else if (BOOL_ATTRS.has(key)) {
            el.toggleAttribute(key, !!v);
        } else if (key === 'htmlFor') {
            if (v != null) el.setAttribute('for', String(v));
        } else if (v != null && v !== false) {
            el.setAttribute(key, v === true ? '' : String(v));
        }
    }
}

function kebab(p) { return p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()); }

/**
 * Appends children (flattening arrays, skipping null/undefined/booleans).
 * @param {Node} el
 * @param {any[]} children
 */
export function append(el, children) {
    for (const c of children) {
        if (c == null || c === false || c === true) continue;
        if (Array.isArray(c)) append(el, c);
        else if (c instanceof Node) el.appendChild(c);
        else el.appendChild(document.createTextNode(String(c)));
    }
}

/**
 * querySelector shorthand.
 * @param {string} sel
 * @param {ParentNode} [root=document]
 * @returns {Element|null}
 */
export function qs(sel, root = document) { return root.querySelector(sel); }

/**
 * querySelectorAll shorthand returning a real array.
 * @param {string} sel
 * @param {ParentNode} [root=document]
 * @returns {Element[]}
 */
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

/**
 * addEventListener that returns its own remover.
 * @param {EventTarget} el
 * @param {string} type
 * @param {(e: any) => void} fn
 * @param {AddEventListenerOptions|boolean} [opts]
 * @returns {() => void} off
 */
export function on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    return () => el.removeEventListener(type, fn, opts);
}

/**
 * Sets textContent only when it changed (avoids needless layout at 4 Hz).
 * @param {Node} el
 * @param {string} text
 */
export function setText(el, text) {
    const t = text == null ? '' : String(text);
    if (el.textContent !== t) el.textContent = t;
}

/**
 * Sets (or removes, when value is null) an attribute only when it changed.
 * @param {Element} el
 * @param {string} name
 * @param {string|number|boolean|null} value
 */
export function setAttr(el, name, value) {
    if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); return; }
    const v = String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/**
 * Clamps a number into [lo, hi].
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

let uidCounter = 0;
/**
 * Page-unique id for ARIA wiring.
 * @param {string} [prefix='pc']
 * @returns {string}
 */
export function uid(prefix = 'pc') { uidCounter += 1; return `${prefix}-${uidCounter}`; }

/**
 * Minimal synchronous event emitter for UI-internal plumbing.
 * @returns {{on(type:string, fn:(p:any)=>void): () => void, emit(type:string, payload?:any): void, clear(): void}}
 */
export function createEmitter() {
    /** @type {Map<string, Set<Function>>} */
    const map = new Map();
    return {
        on(type, fn) {
            let set = map.get(type);
            if (!set) { set = new Set(); map.set(type, set); }
            set.add(fn);
            return () => set.delete(fn);
        },
        emit(type, payload) {
            const set = map.get(type);
            if (!set) return;
            for (const fn of [...set]) {
                try { fn(payload); } catch (err) { reportError(err); }
            }
        },
        clear() { map.clear(); },
    };
}

/** Rethrows asynchronously so one faulty listener never breaks its siblings. */
function reportError(err) { setTimeout(() => { throw err; }, 0); }

const FOCUSABLE = [
    'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

/**
 * Visible, enabled, tabbable descendants of `root` in DOM order.
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
export function focusables(root) {
    return qsa(FOCUSABLE, root).filter((el) => {
        if (el.closest('[inert],[hidden]')) return false;
        if (el.getAttribute('tabindex') === '-1') return false;
        return el.getClientRects().length > 0;
    });
}

/**
 * Keeps keyboard focus inside `el` (or several roots, in Tab order: the phone sheet and its tab
 * bar) until released. Tab / Shift+Tab wrap around, and focus that escapes (e.g. a click on the
 * canvas) is pulled back in. An open popover (the Time popover from the phone sheet at full)
 * counts as inside.
 *
 * @param {HTMLElement|HTMLElement[]} roots
 * @param {{initial?: HTMLElement|null, restore?: boolean}} [opts]
 *   `initial`: element to focus now (default: first focusable, else the first root itself);
 *   `restore`: return focus to the previously focused element on release (default true).
 * @returns {() => void} release
 */
export function trapFocus(roots, { initial = null, restore = true } = {}) {
    const previous = /** @type {HTMLElement|null} */ (document.activeElement);
    const all = [roots].flat();
    const el = all[0];
    const within = (n) => all.some((r) => r.contains(n));
    const list = () => all.flatMap(focusables);
    const inside = (n) => within(n) || !!n?.closest?.('.popover');
    const onKey = (e) => {
        if (e.key !== 'Tab') return;
        const items = list();
        if (!items.length) { e.preventDefault(); el.focus({ preventScroll: true }); return; }
        const first = items[0], last = items[items.length - 1];
        const active = document.activeElement;
        if (!within(active) && inside(active)) return;
        if (e.shiftKey && (active === first || !inside(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !inside(active))) { e.preventDefault(); first.focus(); }
    };
    const onFocusIn = (e) => {
        if (!inside(/** @type {Element} */ (e.target))) (list()[0] || el).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    const target = initial || list()[0] || el;
    if (target === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    // Defer so the opening click/keypress does not immediately steal focus back.
    requestAnimationFrame(() => { if (el.isConnected) target.focus({ preventScroll: true }); });
    let released = false;
    return () => {
        if (released) return;
        released = true;
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('focusin', onFocusIn, true);
        if (restore && previous && previous.isConnected && typeof previous.focus === 'function') {
            previous.focus({ preventScroll: true });
        }
    };
}

/**
 * Opens `panel` as a floating popover anchored to `anchor` (fixed positioning,
 * placed above the anchor by default, clamped to the viewport). Closes on
 * outside pointerdown, Esc, or when `close()` is called. Focus moves into the
 * panel and returns to the anchor when it closes.
 *
 * @param {HTMLElement} anchor
 * @param {HTMLElement} panel  Must already be in the DOM (any container).
 * @param {{placement?: 'top'|'bottom', onClose?: () => void, gap?: number, focus?: boolean,
 *          fullWidthBelow?: number}} [opts]
 *   `fullWidthBelow`: viewport width under which the popover spans the viewport minus 24 px.
 *   `within`: keep the popover horizontally inside this element's box when it fits.
 * @returns {{close(): void, reposition(): void}}
 */
export function openPopover(anchor, panel, { placement = 'top', onClose, gap = 10, focus = true, fullWidthBelow = 560, within = null } = {}) {
    panel.hidden = false;
    panel.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    const reposition = () => {
        const r = anchor.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const narrow = vw < fullWidthBelow;
        panel.style.position = 'fixed';
        panel.style.maxWidth = `${vw - 24}px`;
        if (narrow) panel.style.width = `${vw - 24}px`;
        else panel.style.removeProperty('width');
        const pw = panel.offsetWidth, ph = panel.offsetHeight;
        // Horizontal range: the viewport, or `within`'s box when the popover fits inside it.
        let lo = 12, hi = vw - pw - 12;
        const wr = within?.getBoundingClientRect?.();
        if (wr && wr.width >= pw) { lo = Math.max(lo, wr.left); hi = Math.min(hi, wr.right - pw); }
        let left = narrow ? 12 : clamp(r.left + r.width / 2 - pw / 2, lo, Math.max(lo, hi));
        let top = placement === 'top' ? r.top - gap - ph : r.bottom + gap;
        if (placement === 'top' && top < 12) top = Math.min(r.bottom + gap, vh - ph - 12);
        if (placement === 'bottom' && top + ph > vh - 12) top = Math.max(12, r.top - gap - ph);
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(clamp(top, 12, Math.max(12, vh - ph - 12)))}px`;
        panel.style.setProperty('--origin-x', `${Math.round(clamp(r.left + r.width / 2 - left, 16, pw - 16))}px`);
    };
    reposition();
    const onDown = (e) => {
        const t = /** @type {Node} */ (e.target);
        if (!panel.contains(t) && !anchor.contains(t)) close();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(true); }
    };
    const offs = [
        on(document, 'pointerdown', onDown, true),
        on(panel, 'keydown', onKey),
        on(window, 'resize', reposition),
    ];
    if (focus) {
        requestAnimationFrame(() => {
            const first = panel.querySelector('[data-autofocus]') || focusables(panel)[0];
            if (first) /** @type {HTMLElement} */ (first).focus({ preventScroll: true });
        });
    }
    let closed = false;
    function close(returnFocus = false) {
        if (closed) return;
        closed = true;
        offs.forEach((off) => off());
        panel.classList.remove('is-open');
        panel.hidden = true;
        anchor.setAttribute('aria-expanded', 'false');
        if (returnFocus || panel.contains(document.activeElement)) anchor.focus({ preventScroll: true });
        onClose?.();
    }
    return { close: () => close(false), reposition };
}

/**
 * True when the user (or the app, via `body.is-reduced-motion`) asked for reduced motion.
 * @returns {boolean}
 */
export function prefersReducedMotion() {
    if (document.body?.classList.contains('is-reduced-motion')) return true;
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Segmented single-choice control (ARIA radiogroup with roving tabindex).
 * @param {{label: string, options: Array<{value: string, label: string}>, value: string,
 *          onChange: (v: string) => void, className?: string}} o
 * @returns {{el: HTMLElement, set(value: string): void}}
 */
export function segmented({ label, options, value, onChange, className = '' }) {
    const el = h('div', { class: `seg ${className}`.trim(), role: 'radiogroup', 'aria-label': label });
    const btns = options.map((o) => h('button', {
        class: 'seg__btn', type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-value': o.value,
    }, o.label));
    el.append(...btns);
    let cur = '';
    function set(v) {
        cur = v;
        for (const b of btns) {
            const on_ = b.dataset.value === v;
            b.setAttribute('aria-checked', String(on_));
            b.tabIndex = on_ ? 0 : -1;
            b.classList.toggle('is-on', on_);
        }
        if (!btns.some((b) => b.dataset.value === v) && btns[0]) btns[0].tabIndex = 0;
    }
    el.addEventListener('click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('.seg__btn');
        if (!b || b.dataset.value === cur) return;
        set(b.dataset.value);
        onChange(b.dataset.value);
    });
    rovingKeys(el, btns, (b) => {
        set(b.dataset.value);
        b.focus();
        onChange(b.dataset.value);
    });
    set(value);
    return { el, set };
}

/**
 * A full-width switch row: `<button role="switch">` with label, optional
 * description and keyboard hint.
 * @param {{label: string, desc?: string, keys?: string[], checked: boolean, onChange: (on: boolean) => void,
 *          note?: string}} o
 * @returns {{el: HTMLElement, set(on: boolean): void, setNote(text: string): void}}
 */
export function switchRow({ label, desc, keys, checked, onChange, note }) {
    const id = uid('sw');
    const noteEl = h('span', { class: 'switch-row__note', hidden: !note }, note || '');
    const el = h('button', {
        class: 'switch-row', type: 'button', role: 'switch', 'aria-checked': String(!!checked),
        'aria-labelledby': `${id}-l`, ...(desc ? { 'aria-describedby': `${id}-d` } : {}),
    },
    h('span', { class: 'switch-row__text' },
        h('span', { class: 'switch-row__label', id: `${id}-l` }, label),
        desc ? h('span', { class: 'switch-row__desc', id: `${id}-d` }, desc) : null,
        noteEl),
    keys && keys.length ? h('span', { class: 'switch-row__keys', 'aria-hidden': 'true' }, kbd(...keys)) : null,
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch__knob' })));
    let state = !!checked;
    el.addEventListener('click', () => { onChange(!state); });
    return {
        el,
        set(v) { state = !!v; el.setAttribute('aria-checked', String(state)); },
        setNote(text) { noteEl.textContent = text || ''; noteEl.hidden = !text; },
    };
}

/**
 * Formats a key-cap list for display, e.g. kbd('Shift', 'C').
 * @param {...string} keys
 * @returns {HTMLElement}
 */
export function kbd(...keys) {
    const wrap = h('span', { class: 'kbds' });
    keys.forEach((k, i) => {
        if (i) wrap.appendChild(document.createTextNode('+'));
        wrap.appendChild(h('kbd', { class: 'kbd' }, k));
    });
    return wrap;
}

/**
 * Fills a whole-phrase template: each `{name}` becomes `parts[name]`, a string or a Node.
 * @param {string} template
 * @param {Record<string, string|number|Node>} [parts]
 * @returns {DocumentFragment}
 */
export function tpl(template, parts = {}) {
    const f = document.createDocumentFragment();
    String(template).split(/\{(\w+)\}/).forEach((t, i) => {
        if (i % 2) append(f, [parts[t] ?? `{${t}}`]);
        else if (t) f.appendChild(document.createTextNode(t));
    });
    return f;
}

/**
 * Arrow-key roving in a radiogroup or menu: → ↓ next, ← ↑ previous (wrapping), Home, End.
 * @param {HTMLElement} el
 * @param {HTMLElement[]|(() => HTMLElement[])} items
 * @param {(item: HTMLElement, i: number) => void} onMove
 * @returns {() => void} off
 */
export function rovingKeys(el, items, onMove) {
    return on(el, 'keydown', (e) => {
        const list = typeof items === 'function' ? items() : items;
        const n = list.length;
        let i = list.indexOf(/** @type {any} */ (document.activeElement));
        if (i < 0) i = list.findIndex((b) => b.tabIndex === 0);
        const k = e.key;
        const j = k === 'Home' ? 0 : k === 'End' ? n - 1 : k === 'ArrowRight' || k === 'ArrowDown' ? (i + 1) % n
            : k === 'ArrowLeft' || k === 'ArrowUp' ? (i - 1 + n) % n : -1;
        if (j < 0 || !n) return;
        e.preventDefault();
        e.stopPropagation();
        onMove(list[j], j);
    });
}

const MENU_ROLE = { radio: 'menuitemradio', check: 'menuitemcheckbox' };

/**
 * A menu button (§4.3): `button` opens a `role=menu` popover rebuilt from `items` on every open, so
 * it is always fresh. Items: `{kind?: 'radio'|'check', icon, name, detail?, kbd?, group?, hidden?(),
 * disabled?(), disabledText?, checked?(), run()}` or `{note, group?}`; name and detail may be
 * functions. A new `group` starts a section after a separator, titled when it is a string. Opening
 * focuses the checked radio or the first enabled item; ↑ ↓ Home End move; a choice closes the menu
 * first (focus back on the button), then runs; Esc returns focus to the button; Tab moves on.
 * @param {{button: HTMLElement, label: string, items: any[]|(() => any[]), host?: HTMLElement,
 *          placement?: 'top'|'bottom'|(() => 'top'|'bottom')}} o
 * @returns {{open(): void, close(): void, destroy(): void}}
 */
export function menu({ button, label, items, host = document.body, placement = 'top' }) {
    const panel = h('div', { class: 'popover vmenu', role: 'menu', 'aria-label': label, hidden: true });
    host.appendChild(panel);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const val = (v) => (typeof v === 'function' ? v() : v);
    let ctl = null;
    let rows = [];
    function build() {
        rows = [];
        panel.textContent = '';
        let sec = null;
        let key;
        for (const it of val(items)) {
            if (it.hidden?.()) continue;
            if (!sec || it.group !== key) {
                if (sec) panel.append(h('div', { class: 'vmenu__sep', role: 'separator' }));
                key = it.group;
                sec = typeof key === 'string' ? h('div', { role: 'group', 'aria-label': key }, h('div', { class: 'vmenu__title', 'aria-hidden': 'true' }, key)) : panel;
                if (sec !== panel) panel.append(sec);
            }
            if (it.note) { sec.append(h('p', { class: 'vmenu__note' }, it.note)); continue; }
            const off = !!it.disabled?.();
            const detail = off && it.disabledText ? it.disabledText : val(it.detail);
            const b = h('button', {
                class: 'vmenu__item', type: 'button', role: MENU_ROLE[it.kind] ?? 'menuitem', tabindex: '-1',
                'aria-checked': MENU_ROLE[it.kind] ? String(!!it.checked?.()) : null, 'aria-disabled': off ? 'true' : null,
            }, icon(it.icon, { size: 18 }),
            h('span', { class: 'vmenu__text' }, h('span', { class: 'vmenu__name' }, val(it.name)), detail ? h('span', { class: 'vmenu__detail' }, detail) : null),
            it.kbd ? h('kbd', { class: 'kbd vmenu__kbd' }, it.kbd) : null);
            b.onclick = () => { if (!off) { close(); it.run(); } };
            sec.append(b);
            rows.push(b);
        }
    }
    rovingKeys(panel, () => rows, (b) => b.focus());
    panel.addEventListener('keydown', (e) => { if (e.key === 'Tab') close(); });
    function open() {
        build();
        ctl = openPopover(button, panel, { placement: val(placement), focus: false, onClose: () => { ctl = null; } });
        (rows.find((b) => b.matches('[role=menuitemradio][aria-checked=true]')) ?? rows.find((b) => !b.hasAttribute('aria-disabled')))?.focus();
    }
    function close() { ctl?.close(); }
    const offClick = on(button, 'click', () => (ctl ? close() : open()));
    return { open: () => ctl || open(), close, destroy() { offClick(); close(); panel.remove(); } };
}
