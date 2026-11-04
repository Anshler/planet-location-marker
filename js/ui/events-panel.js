/**
 * Events tab: the next 12 months of sky events after the *simulated* time
 * (Moon phases, oppositions, conjunctions, greatest elongations, eclipses —
 * including partial solar eclipses visible from the observer — equinoxes and
 * solstices; star occultations, Venus at greatest brilliancy, transits, the
 * Moon's perigee and apogee extremes, Saturn's ring-plane crossings and meteor
 * showers), grouped by month, each with a Jump button. A "Next up" card leads.
 * Above them, the guided tours (core/tour-catalog.js; actions.startTour). Below them, history
 * (ROADMAP historic-skies): the Moments library and the Famous comets (core/moments.js, links that
 * set the URL hash, so the app flies there like any shared link), and 'The sky you were born under'
 * (a date, a time, sky view at that instant and a caption from astro/sky-caption.js).
 *
 * Data comes from the UI hub, which keeps the list covering ±1 year around the
 * simulated time via `services.astro` (`events` op) and the app's `bus 'events'`.
 *
 * @module ui/events-panel
 */

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { TOURS } from '../core/tour-catalog.js';
import { MOMENTS, FAMOUS_COMETS } from '../core/moments.js';
import { skyCaption } from '../astro/sky-caption.js';
import { h, on, setText } from './dom.js';
import { icon } from './icons.js';

const DAY = 86400e3;

const PLANET_KINDS = new Set(['opposition', 'conjunction', 'max-elongation', 'brilliancy', 'ring-plane']);
const MOON_KINDS = new Set(['moon-phase', 'lunar-eclipse', 'occultation', 'lunar-apsis']);

export const FILTERS = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'moon', label: 'Moon', test: (e) => MOON_KINDS.has(e.kind) },
    { id: 'planets', label: 'Planets', test: (e) => PLANET_KINDS.has(e.kind) },
    { id: 'eclipses', label: 'Eclipses', test: (e) => e.kind.includes('eclipse') || e.kind === 'transit' },
    { id: 'meteors', label: 'Meteors', test: (e) => e.kind === 'meteor-shower' },
    { id: 'seasons', label: 'Seasons', test: (e) => e.kind === 'equinox' || e.kind === 'solstice' },
];

export const KIND_ICON = {
    'moon-phase': 'moon-phase', opposition: 'opposition', conjunction: 'conjunction', 'max-elongation': 'elongation',
    'lunar-eclipse': 'eclipse', 'solar-eclipse': 'eclipse', 'local-solar-eclipse': 'eclipse', equinox: 'season', solstice: 'season',
    occultation: 'occultation', brilliancy: 'brilliancy', transit: 'transit', 'lunar-apsis': 'apsis', 'ring-plane': 'rings',
    'meteor-shower': 'meteor',
};

/** CSS colour for an event's icon. */
function eventColor(ev) {
    switch (ev.kind) {
        case 'moon-phase': case 'occultation': case 'lunar-apsis': return 'var(--body-moon)';
        case 'lunar-eclipse': return '#ff8a65';
        case 'solar-eclipse': case 'local-solar-eclipse': case 'transit': return 'var(--warn)';
        case 'equinox': case 'solstice': return 'var(--accent)';
        case 'meteor-shower': return '#9fd4ff';
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
    const tourBtns = TOURS.map((t) => h('button', {
        class: 'tour-card', type: 'button', 'data-tour': t.id, 'aria-pressed': 'false',
        'aria-label': `Play the guided tour ${t.title}: ${t.blurb}`,
    }, h('span', { class: 'tour-card__title' }, icon('play', { size: 14 }), t.title), h('span', { class: 'tour-card__blurb' }, t.blurb)));
    // History: Moments and Famous comets are deep links (core/moments.js).
    const momentLink = (m, cls) => h('a', { class: cls, href: m.hash, 'data-moment': m.id },
        h('span', { class: `${cls}__title` }, m.title),
        h('span', { class: `${cls}__when` }, m.when ?? m.detail),
        m.caption ? h('span', { class: `${cls}__caption` }, m.caption) : null,
        m.sources ? h('span', { class: `${cls}__src` }, m.sources.join(' · ')) : null);
    const moments = h('div', { class: 'moments', role: 'list', 'aria-label': 'Moments in history' },
        MOMENTS.map((m) => h('div', { role: 'listitem' }, momentLink(m, 'moment'))));
    const comets = h('div', { class: 'moments moments--comets', role: 'list', 'aria-label': 'Famous comets' },
        FAMOUS_COMETS.map((m) => h('div', { role: 'listitem' }, momentLink(m, 'moment'))));
    const bornDate = h('input', { class: 'input', type: 'date', min: '1000-01-01', max: '2999-12-31', required: true, 'aria-label': 'Date of birth' });
    const bornTime = h('input', { class: 'input', type: 'time', value: '21:00', 'aria-label': 'Time (optional)' });
    const bornCaption = h('p', { class: 'born__caption', 'aria-live': 'polite', hidden: true });
    const bornForm = h('form', { class: 'born', novalidate: true },
        h('div', { class: 'born__row' },
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Date'), bornDate),
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Time'), bornTime),
            h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, icon('sky', { size: 16 }), 'Show my sky')),
        bornCaption);
    root.append(
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Guided tours'), h('span', { class: 'pill' }, 'Narrated')),
        h('div', { class: 'tours', role: 'group', 'aria-label': 'Guided tours' }, tourBtns),
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Upcoming events'), h('span', { class: 'pill' }, 'Next 12 months')),
        filterBar, next, list, empty,
        h('p', { class: 'note' }, 'Times are shown in the time-bar zone. Jump moves the clock (and the view, where useful) to the event.'),
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'The sky you were born under')),
        h('p', { class: 'pop__hint' }, 'Your birthday, from where you are now (change the place first for another one).'),
        bornForm,
        h('div', { class: 'section-head section-head--moments' }, h('h2', { class: 'panel-title' }, 'Moments in history'), h('span', { class: 'pill' }, 'Links')),
        moments,
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Famous comets'), h('span', { class: 'pill' }, 'Halley')),
        comets,
        h('p', { class: 'note' }, 'Dates before 15 October 1582 are Julian, as the records give them. Positions before 1600 are less certain (ΔT); comet tails and supernova light curves are models.'));

    // A moment closes the phone sheet to its peek, so the sky it opens is in view.
    offs.push(on(root, 'click', (e) => {
        const a = /** @type {HTMLElement} */ (e.target).closest('[data-moment]');
        if (!a) return;
        const st = ctx.store.get();
        if (st.ui.sheet !== 'peek') ctx.store.set({ ui: { ...st.ui, sheet: 'peek' } }, 'events');
    }));

    // 'The sky you were born under': that instant in sky view, then a caption from the readout.
    let bornWait = null;
    offs.push(on(bornForm, 'submit', (e) => {
        e.preventDefault();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bornDate.value || '');
        if (!m) { bornDate.setAttribute('aria-invalid', 'true'); bornDate.focus(); return; }
        bornDate.removeAttribute('aria-invalid');
        const tm = /^(\d{2}):(\d{2})/.exec(bornTime.value || '') || ['', '21', '00'];
        const ms = ui.toUtc({ y: +m[1], mo: +m[2], d: +m[3], h: +tm[1], mi: +tm[2], s: 0, cal: 'gregorian' });
        if (!Number.isFinite(ms)) return;
        clock.pause?.();
        clock.setTime?.(ms, { animateMs: 0 });
        ui.act('setViewMode', 'sky');
        bornCaption.hidden = false;
        bornCaption.textContent = 'Reading the sky…';
        bornWait?.();
        const done = ui.on('snap', (snap) => {
            if (!snap || Math.abs(snap.tMs - ms) > 1000) return;
            done();
            bornWait = null;
            const text = skyCaption(snap);
            bornCaption.textContent = `${ui.fmtDay(ms)}, ${ui.fmtClock(ms)}: ${text}`;
            ctx.bus?.emit?.('announce', text);
        });
        bornWait = done;
    }));
    offs.push(ctx.store.subscribe((s) => s.ui.tour?.id ?? '', (id) => {
        for (const b of tourBtns) b.setAttribute('aria-pressed', String(b.dataset.tour === id));
    }, { immediate: true }));

    offs.push(on(filterBar, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-filter]');
        if (!b) return;
        filter = b.dataset.filter;
        for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.filter === filter));
        render(true);
    }));
    offs.push(on(root, 'click', (e) => {
        const tb = /** @type {HTMLElement} */ (e.target).closest('[data-tour]');
        if (tb) {
            ui.act('startTour', tb.dataset.tour);
            return;
        }
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
        destroy() { bornWait?.(); offs.forEach((off) => off()); root.textContent = ''; },
    };
}

/** Exported for tests / other panels: body colour by id. */
export const bodyColor = (id) => BODIES[BODY_INDEX[id]]?.color ?? '#c9d4e3';
