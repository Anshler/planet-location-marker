/**
 * Events tab: the next 12 months of sky events after the *simulated* time
 * (Moon phases, oppositions, conjunctions, greatest elongations, eclipses —
 * including partial solar eclipses visible from the observer — equinoxes and
 * solstices), grouped by month, each with a Jump button. A "Next up" card leads.
 *
 * Data comes from the UI hub, which keeps the list covering ±1 year around the
 * simulated time via `services.astro` (`events` op) and the app's `bus 'events'`.
 *
 * @module ui/events-panel
 */

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { h, on, setText } from './dom.js';
import { icon } from './icons.js';

const DAY = 86400e3;

const FILTERS = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'moon', label: 'Moon', test: (e) => e.kind === 'moon-phase' || e.kind === 'lunar-eclipse' },
    { id: 'planets', label: 'Planets', test: (e) => e.kind === 'opposition' || e.kind === 'conjunction' || e.kind === 'max-elongation' },
    { id: 'eclipses', label: 'Eclipses', test: (e) => e.kind.includes('eclipse') },
    { id: 'seasons', label: 'Seasons', test: (e) => e.kind === 'equinox' || e.kind === 'solstice' },
];

const KIND_ICON = {
    'moon-phase': 'moon-phase', opposition: 'opposition', conjunction: 'conjunction', 'max-elongation': 'elongation',
    'lunar-eclipse': 'eclipse', 'solar-eclipse': 'eclipse', 'local-solar-eclipse': 'eclipse', equinox: 'season', solstice: 'season',
};

/** CSS colour for an event's icon. */
function eventColor(ev) {
    switch (ev.kind) {
        case 'moon-phase': return 'var(--body-moon)';
        case 'lunar-eclipse': return '#ff8a65';
        case 'solar-eclipse': case 'local-solar-eclipse': return 'var(--warn)';
        case 'equinox': case 'solstice': return 'var(--accent)';
        default: return ev.bodyId && ev.bodyId in BODY_INDEX ? `var(--body-${ev.bodyId})` : 'var(--muted)';
    }
}

/**
 * Mounts the Events tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void, shown(): void}}
 */
export function mountEventsPanel(root, ctx) {
    const { ui, clock } = ctx;
    const offs = [];
    let filter = 'all';

    const chips = FILTERS.map((f) => h('button', {
        class: 'chip chip--filter', type: 'button', 'aria-pressed': String(f.id === filter), 'data-filter': f.id,
    }, f.label));
    const filterBar = h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter events' }, chips);
    const next = h('div', { class: 'ev-next', hidden: true });
    const list = h('ol', { class: 'ev-list', 'aria-label': 'Upcoming events' });
    const empty = h('p', { class: 'empty' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Computing upcoming events…');
    root.append(
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Upcoming events'), h('span', { class: 'pill' }, 'Next 12 months')),
        filterBar, next, list, empty,
        h('p', { class: 'note' }, 'Times are shown in the time-bar zone. Jump moves the clock (and the view, where useful) to the event.'));

    offs.push(on(filterBar, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-filter]');
        if (!b) return;
        filter = b.dataset.filter;
        for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.filter === filter));
        render(true);
    }));
    offs.push(on(root, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-ev]');
        if (!b) return;
        const ev = shownEvents[Number(b.dataset.ev)];
        if (ev) ui.act('jumpToEvent', ev);
    }));

    /** @type {any[]} */
    let shownEvents = [];
    let lastKey = '';
    let lastRel = 0;
    /** @type {{ev:any, meta:HTMLElement}[]} */
    let metaEls = [];

    const simNow = () => (Number.isFinite(clock?.tMs) ? clock.tMs : ui.snap?.tMs ?? Date.now());

    function render(force = false) {
        const t = simNow();
        const all = ui.events?.list;
        if (!all) {
            empty.hidden = false;
            if (!ctx.services?.astro) setText(empty, 'Upcoming events are unavailable on this device.');
            return;
        }
        const f = FILTERS.find((x) => x.id === filter) || FILTERS[0];
        const upcoming = all.filter((e) => e && Number.isFinite(e.tMs) && e.tMs >= t - 30 * 60e3 && e.tMs <= t + 366 * DAY && f.test(e));
        const key = `${filter}|${upcoming.length}|${upcoming[0]?.id ?? ''}|${upcoming.at(-1)?.id ?? ''}|${ui.displayTz()}|${ctx.store.get().display?.hour12}`;
        if (!force && key === lastKey) { refreshRelative(t); return; }
        lastKey = key;
        empty.hidden = true;
        shownEvents = upcoming;
        metaEls = [];

        // "Next up" hero card.
        const first = upcoming[0];
        if (first) {
            const meta = h('span', { class: 'ev-next__when' });
            metaEls.push({ ev: first, meta, hero: true });
            next.replaceChildren(
                h('span', { class: 'ev-next__eyebrow' }, 'Next up'),
                h('div', { class: 'ev-next__row' },
                    h('span', { class: 'ev__icon ev__icon--lg', style: { '--c': eventColor(first) }, 'aria-hidden': 'true' }, icon(KIND_ICON[first.kind] || 'events', { size: 22 })),
                    h('div', { class: 'ev__main' }, h('span', { class: 'ev-next__title' }, first.title), meta,
                        first.detail ? h('span', { class: 'ev__detail' }, first.detail) : null),
                    h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-ev': '0', 'aria-label': `Jump to ${first.title}` },
                        icon('arrow-right', { size: 16 }), 'Jump')));
            next.hidden = false;
        } else next.hidden = true;

        const items = [];
        let month = '';
        upcoming.forEach((ev, i) => {
            if (i === 0) return; // shown in the hero card
            const z = ui.zoned(ev.tMs);
            const m = `${ui.MONTHS_LONG[z.mo - 1]} ${z.y}`;
            if (m !== month) { month = m; items.push(h('li', { class: 'ev-month', 'aria-hidden': 'true' }, m)); }
            const meta = h('span', { class: 'ev__meta' });
            metaEls.push({ ev, meta });
            items.push(h('li', { class: 'ev' },
                h('span', { class: 'ev__icon', style: { '--c': eventColor(ev) }, 'aria-hidden': 'true' }, icon(KIND_ICON[ev.kind] || 'events', { size: 18 })),
                h('div', { class: 'ev__main' },
                    h('span', { class: 'ev__title' }, ev.title),
                    meta,
                    ev.detail ? h('span', { class: 'ev__detail' }, ev.detail) : null),
                h('button', { class: 'btn btn--soft btn--sm ev__jump', type: 'button', 'data-ev': String(i), 'aria-label': `Jump to ${ev.title}, ${ui.fmtSpoken(ev.tMs)}` },
                    'Jump')));
        });
        if (!upcoming.length) {
            items.push(h('li', { class: 'ev-none' }, filter === 'all' ? 'No events in the next 12 months.' : 'No events of this kind in the next 12 months.'));
        }
        list.replaceChildren(...items);
        refreshRelative(t, true);
    }

    function refreshRelative(t, force = false) {
        const now = performance.now();
        if (!force && now - lastRel < 1000) return;
        lastRel = now;
        for (const { ev, meta, hero } of metaEls) {
            const when = `${ui.fmtDay(ev.tMs, { year: false })} · ${ui.fmtClock(ev.tMs)}`;
            const rel = ui.fmt('fmtRelative', ev.tMs, t);
            setText(meta, hero ? `${rel === '—' ? '' : rel + ' · '}${when}` : `${when}${rel === '—' ? '' : ' · ' + rel}`);
        }
    }

    offs.push(ui.on('events', () => render(true)));
    offs.push(ui.on('display', () => render(true)));
    offs.push(ctx.store.subscribe((s) => s.observer, () => { lastKey = ''; }));
    render(true);

    return {
        update() { render(false); },
        shown() { render(true); },
        destroy() { offs.forEach((off) => off()); root.textContent = ''; },
    };
}

/** Exported for tests / other panels: body colour by id. */
export const bodyColor = (id) => BODIES[BODY_INDEX[id]]?.color ?? '#c9d4e3';
