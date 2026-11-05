/**
 * The status stack (docs/roadmap/UI-REDESIGN.md §4.4): a chip per active mode under the top bar,
 * oldest first, then the shortcut flash, so the flash never covers a chip. `ui.modes`:
 * set(id, {icon, title, detail, live?, actions?: [{label, run, disabled?}], exit: {label, run, done?},
 * guard?}) · update(id, {detail}) · clear(id) · top() · exitTop() · flash(text). Esc (shortcuts.js)
 * calls exitTop, which flashes `exit.done`; a `guard()` warning (an exposure with frames) asks for
 * a second Esc within 3 s. The owners set their chips (view-switch.js, sky-tools.js, expose.js,
 * shell.js; the loop's is here, its Edit opens Time › Loop); the actions announce entering and leaving.
 *
 * @module ui/modes
 */

import { h, on, setText } from './dom.js';
import { icon, swapIcon } from './icons.js';
import { t } from '../core/i18n.js';

/**
 * The stack without the DOM: chips in activation order (a Map keeps it), the newest on top.
 * @param {{now?: () => number}} [o]
 */
export function createModeStack({ now = () => Date.now() } = {}) {
    const chips = new Map();
    let armed = null;
    const top = () => [...chips.keys()].pop() ?? null;
    return {
        /** @returns {boolean} the chip is new */
        set(id, spec) {
            const cur = chips.get(id);
            chips.set(id, { ...cur, ...spec });
            return !cur;
        },
        get: (id) => chips.get(id) ?? null,
        clear(id) { if (armed?.id === id) armed = null; return chips.delete(id); },
        ids: () => [...chips.keys()],
        top,
        /** Leaves the newest chip, or arms its guard. @returns {{id:string, warn?:string, done?:string}|null} */
        exitTop() {
            const id = top();
            if (!id) return null;
            const c = chips.get(id);
            const warn = c.guard?.();
            if (warn && !(armed?.id === id && now() < armed.until)) {
                armed = { id, until: now() + 3000 };
                return { id, warn };
            }
            armed = null;
            c.exit?.run?.();
            return { id, done: c.exit?.done };
        },
    };
}

/**
 * Mounts the stack as `ui.modes` (and `ui.flash`, its alias).
 * @param {HTMLElement} host
 * @param {any} ctx UiCtx
 * @returns {{el: HTMLElement, destroy(): void}}
 */
export function mountModes(host, ctx) {
    const { ui, clock } = ctx;
    const core = createModeStack();
    const flashEl = h('div', { class: 'flash', 'aria-hidden': 'true' });
    const more = h('button', { class: 'mode-more glass', type: 'button', hidden: true });
    const el = h('div', { class: 'status-stack', role: 'region', 'aria-label': t('Active modes') }, more, flashEl);
    host.appendChild(el);
    const doms = new Map();
    let n = 0;
    let timer = 0;

    function build(id) {
        const d = { title: h('span', { class: 'mode__title', id: `mode-${++n}` }), detail: h('span', { class: 'mode__detail' }),
            acts: h('span', { class: 'mode__acts' }), exit: h('button', { class: 'btn btn--soft mode__btn mode__exit', type: 'button' }), key: '' };
        d.root = h('div', { class: 'mode glass', role: 'group', 'aria-labelledby': d.title.id, 'data-mode': id },
            h('span', { class: 'mode__icon', 'aria-hidden': 'true' }, icon('dot', { size: 18 })),
            h('span', { class: 'mode__text' }, d.title, d.detail), d.acts, d.exit);
        on(d.root, 'click', (e) => {
            const b = /** @type {HTMLElement} */ (e.target).closest('button');
            const c = core.get(id);
            (b === d.exit ? c?.exit : c?.actions?.[b?.dataset.i])?.run?.();
        });
        el.insertBefore(d.root, flashEl);
        return d;
    }

    function set(id, spec) {
        core.set(id, spec);
        const c = core.get(id);
        const d = doms.get(id) ?? doms.set(id, build(id)).get(id);
        swapIcon(d.root.firstChild, c.icon || 'dot', 18);
        setText(d.title, c.title);
        fill(d, c.detail);
        if (c.live) d.detail.setAttribute('aria-live', 'polite');
        // Rebuilt only when the labels change, so a focused button keeps its focus.
        const acts = c.actions ?? [];
        const key = acts.map((a) => a.label) + c.exit?.label;
        if (key !== d.key) {
            d.key = key;
            d.acts.replaceChildren(...acts.map((a, i) => h('button', { class: 'btn btn--soft mode__btn', type: 'button', 'data-i': i }, a.label)));
            d.exit.replaceChildren(c.exit?.label ?? '', h('kbd', { class: 'kbd mode__kbd' }, 'Esc'));
        }
        acts.forEach((a, i) => { d.acts.children[i].disabled = !!a.disabled; });
        syncMore();
    }
    function fill(d, text) {
        setText(d.detail, text);
        d.detail.hidden = !text;
    }
    function clear(id) {
        core.clear(id);
        doms.get(id)?.root.remove();
        doms.delete(id);
        syncMore();
    }
    // Phones show the newest two chips; '+n more' unfolds the rest.
    function syncMore() {
        const extra = doms.size - 2;
        more.hidden = extra < 1;
        if (extra < 1) el.classList.remove('is-all');
        else setText(more, el.classList.contains('is-all') ? t('Show fewer') : t('+{n} more', { n: extra }));
    }
    on(more, 'click', () => { el.classList.toggle('is-all'); syncMore(); });

    function flash(text) {
        if (!text) return;
        flashEl.textContent = text;
        flashEl.classList.remove('is-on');
        void flashEl.offsetWidth;
        flashEl.classList.add('is-on');
        clearTimeout(timer);
        timer = setTimeout(() => flashEl.classList.remove('is-on'), 1200);
    }

    ui.modes = {
        set,
        update(id, { detail }) {
            if (!doms.has(id)) return;
            core.set(id, { detail });
            fill(doms.get(id), detail);
        },
        clear,
        top: core.top,
        exitTop() {
            const r = core.exitTop();
            flash(r?.warn ?? r?.done);
            // The flash is aria-hidden: a warning is said too.
            if (r?.warn) ctx.bus?.emit?.('announce', r.warn);
            return !!r;
        },
        flash,
    };
    ui.flash = flash;

    // A loop between two moments (not the analemma's daily stride: that is the exposure's).
    const syncLoop = () => {
        const r = clock?.range;
        if (!r || r.strideMs) return clear('loop');
        const from = ui.fmtWhen(r.fromMs, clock.tMs), to = ui.fmtWhen(r.toMs, r.fromMs), once = r.loop === 'once', run = () => clock.setRange(null);
        const v = { from, to, s: r.durationS };
        set('loop', {
            icon: 'timelapse', title: once ? t('Playing {from} → {to}', v) : t('Looping {from} → {to}', v),
            detail: once ? t('Once through in {s} s', v) : r.loop === 'pingpong' ? t('{s} s per loop, back and forth', v) : t('{s} s per loop, repeating', v),
            actions: [{ label: t('Edit'), run: () => ui.openTime?.('loop') }],
            exit: once ? { label: t('Stop'), done: t('Playback stopped'), run } : { label: t('Stop the loop'), done: t('Loop stopped'), run },
        });
    };
    const offClock = clock?.onChange?.((ev) => { if (ev?.type === 'range') syncLoop(); });
    syncLoop();

    return { el, destroy() { offClock?.(); clearTimeout(timer); el.remove(); } };
}
