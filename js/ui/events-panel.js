/**
 * Events tab: the next 12 months of sky events after the *simulated* time (Moon phases, oppositions,
 * conjunctions, elongations, eclipses, seasons, occultations, transits, apsides, ring-plane
 * crossings, meteor showers), by month; each row jumps there. "Next up" leads, then the filters; All
 * shows 8 weeks (12 events at least), then 'Show the rest'. Satellite passes (ui/sat-passes.js) join
 * them: bright ones under All, every one under Satellites; their row watches the pass. The list
 * comes from the UI hub (`services.astro` `events`, ±1 year). Each event has its glyph
 * (ui/event-glyphs.js); 'Add to calendar' (ui/ics.js) saves an .ics offline: Next up, per row, and
 * every eclipse of the next 12 months (ending the list under All, leading it under Eclipses).
 *
 * @module ui/events-panel
 */

import { BODY_INDEX } from '../astro/bodies.js';
import { h, on, setText, rovingKeys } from './dom.js';
import { icon } from './icons.js';
import { eventGlyph } from './event-glyphs.js';
import { buildCalendar, eclipseBundle, icsFileName, placeKeyOf, saveIcs } from './ics.js';
import { passEvent, isBrightPass } from './sat-passes.js';

const DAY = 86400e3;
/** Under All: the next 8 weeks, or at least this many events, before 'Show the rest'. */
const WINDOW_DAYS = 56, WINDOW_MIN = 12;

const PLANET_KINDS = new Set(['opposition', 'conjunction', 'max-elongation', 'brilliancy', 'ring-plane']);
const MOON_KINDS = new Set(['moon-phase', 'lunar-eclipse', 'occultation', 'lunar-apsis']);

export const FILTERS = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'moon', label: 'Moon', test: (e) => MOON_KINDS.has(e.kind) },
    { id: 'planets', label: 'Planets', test: (e) => PLANET_KINDS.has(e.kind) },
    { id: 'eclipses', label: 'Eclipses', test: (e) => e.kind.includes('eclipse') || e.kind === 'transit' },
    { id: 'meteors', label: 'Meteors', test: (e) => e.kind === 'meteor-shower' },
    { id: 'sats', label: 'Satellites', test: (e) => e.kind === 'sat-pass' },
    { id: 'seasons', label: 'Seasons', test: (e) => e.kind === 'equinox' || e.kind === 'solstice' },
];

/** CSS colour for an event's glyph tile (its tint). */
function eventColor(ev) {
    switch (ev.kind) {
        case 'moon-phase': case 'occultation': case 'lunar-apsis': return 'var(--body-moon)';
        case 'lunar-eclipse': return 'var(--ev-copper)';
        case 'solar-eclipse': case 'local-solar-eclipse': case 'transit': return 'var(--warn)';
        case 'equinox': case 'solstice': return 'var(--accent)';
        case 'meteor-shower': return 'var(--ev-meteor)';
        case 'sat-pass': return ev.color || 'var(--accent)';
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
    const { ui, clock, store } = ctx;
    const offs = [];
    let filter = 'all';

    const chips = FILTERS.map((f) => h('button', {
        class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(f.id === filter), tabindex: f.id === filter ? '0' : '-1', 'data-filter': f.id,
    }, f.label));
    const filterBar = h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Show' }, chips);
    const next = h('div', { class: 'ev-next', hidden: true });
    const list = h('ol', { class: 'ev-list', 'aria-label': 'Upcoming events' });
    // 'All eclipses in the next year' as one calendar file (shown under All and Eclipses).
    const bundleBtn = h('button', { class: 'btn btn--soft btn--sm ev-bundle', type: 'button', hidden: true }, icon('calendar', { size: 16 }), h('span'));
    const moreBtn = h('button', { class: 'btn btn--soft btn--sm ev-bundle', type: 'button', hidden: true });
    const empty = h('p', { class: 'empty' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Computing upcoming events…');
    // Standing on Mars (ROADMAP stand-on-mars, phase 1): the events are the Earth observer's.
    const marsNote = h('p', { class: 'note note--mars', hidden: true },
        'You are standing on Mars: these events, times and jumps are for your place on the Earth.');
    offs.push(store.subscribe((st) => st.host?.id, (id) => { marsNote.hidden = id !== 'mars'; }, { immediate: true }));
    root.append(marsNote, next, filterBar, list, empty, moreBtn, bundleBtn,
        h('p', { class: 'note' }, 'Times are in the time bar’s zone. Choosing an event moves the clock, and the view where useful.'));

    /** Under All, the rows past the window wait for 'Show the rest'; another filter shows them all. */
    let expanded = false;
    offs.push(on(moreBtn, 'click', () => {
        const from = list.querySelectorAll('.ev').length;
        expanded = true;
        render(true);
        const n = list.querySelectorAll('.ev').length - from;
        list.querySelectorAll('.ev')[from]?.focus();
        ctx.bus?.emit?.('announce', n === 1 ? '1 more event shown.' : `${n} more events shown.`);
    }));
    const choose = (id) => {
        filter = id;
        expanded = false;
        for (const c of chips) {
            c.setAttribute('aria-checked', String(c.dataset.filter === id));
            c.tabIndex = c.dataset.filter === id ? 0 : -1;
        }
        render(true);
    };
    offs.push(rovingKeys(filterBar, chips, (b) => { b.focus(); choose(b.dataset.filter); }));

    offs.push(on(filterBar, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-filter]');
        if (b) choose(b.dataset.filter);
    }));
    offs.push(on(root, 'click', (e) => {
        const cal = /** @type {HTMLElement} */ (e.target).closest('[data-cal]');
        if (cal) {
            const ev = shownEvents[Number(cal.dataset.cal)];
            if (!ev) return;
            const z = ui.zoned(ev.tMs), p2 = (n) => String(n).padStart(2, '0');
            addToCalendar([ev], ev.title, icsFileName(ev, `${z.y}-${p2(z.mo)}-${p2(z.d)}`), false);
            return;
        }
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-ev]');
        if (!b) return;
        const ev = shownEvents[Number(b.dataset.ev)];
        if (ev) ui.act(ev.kind === 'sat-pass' ? 'watchPass' : 'jumpToEvent', ev.kind === 'sat-pass' ? ev.pass : ev);
    }));
    offs.push(on(bundleBtn, 'click', () => {
        if (!bundle.length) return;
        const y0 = new Date(bundle[0].tMs).getUTCFullYear(), y1 = new Date(bundle.at(-1).tMs).getUTCFullYear();
        const years = y0 === y1 ? String(y0) : `${y0}-${y1}`;
        addToCalendar(bundle, `Eclipses ${years.replace('-', '–')}`, `eclipses-${years}.ics`, true);
    }));

    /**
     * Saves events as an .ics file (share sheet on touch devices, else a download). Each entry
     * links back to its sky; times are UTC, so any calendar shows them in its own zone.
     * @param {any[]} evs
     * @param {string} name the share sheet's title (and, for a bundle, the calendar's name)
     * @param {string} fileName
     * @param {boolean} named
     */
    function addToCalendar(evs, name, fileName, named) {
        const o = store.get().observer;
        let text;
        try {
            // Only a bundle names its calendar (X-WR-CALNAME): one event joins the user's own.
            text = buildCalendar(evs, { nowMs: Date.now(), name: named ? name : '', place: ui.placeLabel(o), placeKey: placeKeyOf(o),
                urlFor: (ev) => ui.act('shareUrl', { event: ev }) || '' });
        } catch { text = ''; }
        const toast = (message, kind = 'info') => ctx.bus?.emit?.('toast', { message, kind, timeoutMs: 3500 });
        if (!text) { toast("The calendar file couldn't be made.", 'warn'); return; }
        saveIcs(text, fileName, { title: name }).then((r) => {
            if (r === 'saved') toast(evs.length > 1 ? `Saved ${evs.length} events as ${fileName}: open it to add them to your calendar` : `Saved ${fileName}: open it to add it to your calendar`);
            else if (r === 'failed') toast("The calendar file couldn't be saved on this device.", 'warn');
        });
    }

    /** @type {any[]} */
    let shownEvents = [];
    /** @type {any[]} the eclipses of the next 12 months (the bundle) */
    let bundle = [];
    let lastKey = '';
    let lastRel = 0;
    /** @type {{ev:any, meta:HTMLElement}[]} */
    let metaEls = [];

    const simNow = () => (Number.isFinite(clock?.tMs) ? clock.tMs : ui.snap?.tMs ?? Date.now());

    function render(force = false) {
        const t = simNow();
        const all = withPasses(ui.events?.list, t);
        if (!all) {
            empty.hidden = false;
            if (!ctx.services?.astro) setText(empty, 'Upcoming events are unavailable on this device.');
            return;
        }
        const f = FILTERS.find((x) => x.id === filter) || FILTERS[0];
        const upcoming = all.filter((e) => e && Number.isFinite(e.tMs) && e.tMs >= t - 30 * 60e3 && e.tMs <= t + 366 * DAY && f.test(e));
        const south = ctx.store.get().observer?.latDeg < 0;
        const key = `${filter}|${expanded}|${upcoming.length}|${upcoming[0]?.id ?? ''}|${upcoming.at(-1)?.id ?? ''}|${ui.displayTz()}|${ctx.store.get().display?.hour12}|${south}`;
        if (!force && key === lastKey) { refreshRelative(t); return; }
        lastKey = key;
        empty.hidden = true;
        shownEvents = upcoming;
        metaEls = [];
        bundle = eclipseBundle(ui.events?.list, t - 30 * 60e3, t + 366 * DAY);
        bundleBtn.hidden = !bundle.length || (filter !== 'all' && filter !== 'eclipses');
        // Under the Eclipses filter it leads the list; under All it ends it.
        if (filter === 'eclipses') { if (bundleBtn.previousElementSibling !== filterBar) filterBar.after(bundleBtn); } else if (bundleBtn.previousElementSibling !== moreBtn) moreBtn.after(bundleBtn);
        setText(bundleBtn.lastChild, bundle.length === 1 ? 'Add the eclipse of the next 12 months to a calendar'
            : `Add all ${bundle.length} eclipses of the next 12 months to a calendar`);
        const calBtn = (ev, i, text) => h('button', {
            class: `btn btn--soft btn--sm ${text ? '' : 'ev__cal'}`, type: 'button', 'data-cal': String(i),
            'aria-label': `Add ${ev.title} to a calendar`, title: 'Add to calendar (.ics)',
        }, icon('calendar', { size: 16 }), text);
        const sat = (ev) => ev.kind === 'sat-pass';

        // "Next up" hero card.
        const first = upcoming[0];
        if (first) {
            const meta = h('span', { class: 'ev-next__when' });
            metaEls.push({ ev: first, meta, hero: true });
            next.replaceChildren(
                h('span', { class: 'ev-next__label' }, 'Next up'),
                h('div', { class: 'ev-next__row' },
                    h('span', { class: 'ev__icon ev__icon--lg', style: { '--c': eventColor(first) }, 'aria-hidden': 'true' }, eventGlyph(first, { size: 34, south })),
                    h('div', { class: 'ev__main' }, h('span', { class: 'ev-next__title' }, first.title), meta,
                        first.detail ? h('span', { class: 'ev__detail' }, first.detail) : null)),
                h('div', { class: 'btn-row' },
                    h('button', { class: 'btn btn--primary btn--sm', type: 'button', 'data-ev': '0', 'aria-label': `${sat(first) ? 'Watch' : 'Jump to'} ${first.title}` },
                        icon('arrow-right', { size: 16 }), sat(first) ? 'Watch this pass' : 'Jump to it'),
                    calBtn(first, 0, 'Add to calendar')));
            next.hidden = false;
        } else next.hidden = true;

        const items = [];
        let month = '';
        // Under All: the next 8 weeks, or the first 12 events, whichever is more.
        let shown = upcoming.length;
        if (filter === 'all' && !expanded) {
            const cut = upcoming.findIndex((e) => e.tMs > t + WINDOW_DAYS * DAY);
            if (cut >= 0) shown = Math.max(cut, Math.min(WINDOW_MIN, shown));
        }
        upcoming.slice(0, shown).forEach((ev, i) => {
            if (i === 0) return; // shown in the hero card
            const ym = ui.fmtDate(ev.tMs, { month: 'long', year: 'numeric' });
            const m = ym.charAt(0).toUpperCase() + ym.slice(1);
            if (m !== month) { month = m; items.push(h('li', { class: 'ev-month', 'aria-hidden': 'true' }, m)); }
            const meta = h('span', { class: 'ev__meta' });
            metaEls.push({ ev, meta });
            // The row is the Jump (Watch) button; its detail is its description.
            items.push(h('li', { class: 'ev-item' },
                h('button', {
                    class: 'ev', type: 'button', 'data-ev': String(i), 'aria-describedby': ev.detail ? `ev-d${i}` : null,
                    'aria-label': `${sat(ev) ? 'Watch' : 'Jump to'} ${ev.title}, ${ui.fmtSpoken(ev.tMs)}`,
                },
                h('span', { class: 'ev__icon', style: { '--c': eventColor(ev) }, 'aria-hidden': 'true' }, eventGlyph(ev, { size: 26, south })),
                h('span', { class: 'ev__main' },
                    h('span', { class: 'ev__title' }, ev.title),
                    meta,
                    ev.detail ? h('span', { class: 'ev__detail', id: `ev-d${i}` }, ev.detail) : null),
                icon('chevron-right', { size: 16 })),
                calBtn(ev, i)));
        });
        const rest = upcoming.length - shown;
        moreBtn.hidden = rest <= 0;
        setText(moreBtn, rest === 1 ? 'Show the rest of the 12 months (1 more)' : `Show the rest of the 12 months (${rest} more)`);
        if (!upcoming.length) {
            items.push(h('li', { class: 'ev-none' }, filter === 'all' ? 'No events in the next 12 months.' : 'No events of this kind in the next 12 months.'));
        }
        list.replaceChildren(...items);
        refreshRelative(t, true);
    }

    /** The year's events plus the satellite passes this filter shows (cached per pass list). */
    let passCache = { list: null, filter: '', tz: '', evs: [] };
    function withPasses(list, t) {
        if (!list) return list;
        const pl = ui.passes?.list;
        if (!Array.isArray(pl) || !pl.length) return list;
        const tz = ui.displayTz();
        if (passCache.list !== pl || passCache.filter !== filter || passCache.tz !== tz) {
            passCache = { list: pl, filter, tz, evs: pl.filter((p) => filter === 'sats' || isBrightPass(p)).map((p) => passEvent(p, ui)) };
        }
        const evs = passCache.evs.filter((e) => e.pass.endMs >= t - 60e3);
        return evs.length ? list.concat(evs).sort((a, b) => a.tMs - b.tMs) : list;
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
    offs.push(ui.on('passes', () => render(true)));
    offs.push(ui.on('display', () => render(true)));
    offs.push(ctx.store.subscribe((s) => s.observer, () => { lastKey = ''; }));
    render(true);

    return {
        update() { render(false); },
        shown() { render(true); },
        destroy() { bornWait?.(); offs.forEach((off) => off()); root.textContent = ''; },
    };
}
