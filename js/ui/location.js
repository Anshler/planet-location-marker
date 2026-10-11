/**
 * Location palette (`role="dialog"`, bound to `state.ui.palette`).
 *
 * Sections, in order: Coordinates (when `parseLatLon` succeeds) → Cities
 * (offline, instant) → Online results (provider badges, 400 ms debounce;
 * Nominatim only on Enter / "Search more places") → Recent places.
 * Footer: Use my location · Pick on the globe · "Online search: available /
 * unavailable". The input is an ARIA combobox driving a listbox with
 * `aria-activedescendant`; ↑/↓ move, Enter chooses, Esc closes.
 *
 * Recent places are read from `core/prefs` (`recentPlaces`); the app's
 * `actions.setObserver` records every deliberate placement there, so the
 * palette only reads them (Place-like `{name, country, lat, lon, tz}` records).
 *
 * @module ui/location
 */

import { parseLatLon } from '../geo/coords.js';
import { load as loadPref } from '../core/prefs.js';
import { h, on, setText, trapFocus, uid } from './dom.js';
import { icon } from './icons.js';

const MAX_RECENT = 6;
const DEBOUNCE_MS = 400;
const PROVIDER_LABEL = { 'open-meteo': 'Open-Meteo', photon: 'Photon', nominatim: 'OSM Nominatim', offline: 'Offline' };
const EXAMPLES = ['Tokyo', 'Reykjavík', 'São Paulo', '48.86, 2.35', '33°52′S 151°12′E'];

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Splits `text` around the first diacritic-insensitive match of `q`, wrapping it in <mark>. */
function highlight(text, q) {
    const fq = fold(q).trim();
    if (!fq) return [text];
    let folded = '';
    const map = [];
    for (let i = 0; i < text.length; i += 1) {
        const f = fold(text[i]);
        for (let k = 0; k < f.length; k += 1) { folded += f[k]; map.push(i); }
    }
    const at = folded.indexOf(fq);
    if (at < 0) return [text];
    const start = map[at], end = map[at + fq.length - 1] + 1;
    return [text.slice(0, start), h('mark', null, text.slice(start, end)), text.slice(end)];
}

const placeKey = (lat, lon) => `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;

/**
 * Mounts the location palette.
 * @param {HTMLElement} root overlay container
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountLocation(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const listId = uid('pal-list');

    // ---------------------------------------------------------------- DOM
    const input = h('input', {
        class: 'palette__input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId,
        'aria-autocomplete': 'list', 'aria-label': 'Search places or enter coordinates', autocomplete: 'off',
        autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
        placeholder: 'Search a city, or type coordinates (e.g. 48.86, 2.35)',
    });
    const clearBtn = h('button', { class: 'icon-btn icon-btn--sm palette__clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('close', { size: 16 }));
    // Phones only (desktop shows the Esc hint): a text "Cancel" so it can't be confused with the clear ×.
    const closeBtn = h('button', { class: 'btn palette__close', type: 'button', 'aria-label': 'Close search' }, 'Cancel');
    const escHint = h('kbd', { class: 'kbd palette__esc', 'aria-hidden': 'true' }, 'Esc');
    const list = h('div', { class: 'palette__list', id: listId, role: 'listbox', 'aria-label': 'Places' });
    const locateLabel = h('span', null, 'Use my location');
    const locateBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('locate', { size: 16 }), locateLabel);
    const pickBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('globe', { size: 16 }), 'Pick on the globe');
    const statusDot = h('span', { class: 'status-dot', 'aria-hidden': 'true' });
    const statusText = h('span');
    const status = h('span', { class: 'palette__status' }, statusDot, statusText);
    const dialog = h('div', { class: 'palette glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Change location' },
        h('div', { class: 'palette__search' },
            h('span', { class: 'palette__icon', 'aria-hidden': 'true' }, icon('search', { size: 20 })),
            input, clearBtn, escHint, closeBtn),
        list,
        h('div', { class: 'palette__foot' }, h('div', { class: 'btn-row' }, locateBtn, pickBtn), status));
    const layer = h('div', { class: 'modal-layer palette-layer', hidden: true }, h('div', { class: 'modal-backdrop' }), dialog);
    root.appendChild(layer);

    // ---------------------------------------------------------------- state
    let query = '';
    /** @type {{lat:number, lon:number}|null} */
    let coords = null;
    /** @type {any[]} */
    let cities = [];
    /** @type {any[]} */
    let online = [];
    let onlineState = 'idle';   // idle | waiting | loading | done | error
    let onlineProvider = '';
    let enterRan = false;
    let debounce = 0;
    let searchCtl = null;
    /** @type {any[]} flat option models in display order */
    let options = [];
    let active = -1;
    let release = null;
    let locating = false;
    /** @type {{name:string, country:string, latDeg:number, lonDeg:number, tz:string|null, cc:string}[]} */
    let recents = [];

    /** Reads recent places (written by actions.setObserver), tolerant of either record shape. */
    function loadRecents() {
        let raw = [];
        try { raw = loadPref('recentPlaces', []); } catch { raw = []; }
        if (!Array.isArray(raw)) raw = [];
        const out = [];
        for (const r of raw) {
            if (!r || typeof r !== 'object') continue;
            const lat = Number(r.lat ?? r.latDeg), lon = Number(r.lon ?? r.lonDeg);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) continue;
            if (out.some((o) => placeKey(o.latDeg, o.lonDeg) === placeKey(lat, lon))) continue;
            out.push({ name: String(r.name || ''), country: String(r.country || ''), latDeg: lat, lonDeg: lon,
                tz: typeof r.tz === 'string' && r.tz ? r.tz : null, cc: String(r.cc || '') });
            if (out.length >= MAX_RECENT) break;
        }
        recents = out;
    }

    // ---------------------------------------------------------------- search
    function runSearch() {
        query = input.value.trim();
        clearBtn.hidden = !query;
        coords = null;
        cities = [];
        try { coords = query ? parseLatLon(query) : null; } catch { coords = null; }
        const svc = ctx.services?.cities;
        if (query && svc?.search) {
            try { cities = (svc.search(query, 8) || []).slice(0, 8); } catch { cities = []; }
        }
        // Online search: debounced, never for coordinates.
        clearTimeout(debounce);
        searchCtl?.abort(); searchCtl = null;
        online = []; onlineProvider = ''; enterRan = false;
        if (query.length >= 3 && !coords && ctx.services?.geocoder?.search && onlineAvailable()) {
            onlineState = 'waiting';
            debounce = setTimeout(() => searchOnline(false), DEBOUNCE_MS);
        } else onlineState = 'idle';
        active = -1;
        render();
    }

    async function searchOnline(enter) {
        const geo = ctx.services?.geocoder;
        if (!geo?.search || !query) return;
        searchCtl?.abort();
        const ac = new AbortController();
        searchCtl = ac;
        onlineState = 'loading';
        if (enter) enterRan = true;
        render(true);
        const q = query;
        try {
            const res = await geo.search(q, { signal: ac.signal, enter });
            if (ac.signal.aborted || q !== query || res?.stale) return;
            const places = Array.isArray(res?.places) ? res.places : [];
            online = dedupe(places);
            onlineProvider = res?.provider || '';
            onlineState = res?.error && !places.length ? 'error' : 'done';
        } catch (err) {
            if (ac.signal.aborted || err?.name === 'AbortError') return;
            onlineState = 'error';
        } finally {
            if (searchCtl === ac) searchCtl = null;
        }
        render(true);
        syncStatus();
    }

    /** Drops online results that duplicate an offline city (same name within ~25 km). */
    function dedupe(places) {
        return places.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
            && !cities.some((c) => fold(c.name) === fold(p.name) && Math.abs(c.lat - p.lat) < 0.25 && Math.abs(c.lon - p.lon) < 0.25))
            .slice(0, 8);
    }

    function onlineAvailable() {
        const st = store.get().status?.onlineSearch;
        let gs = 'unknown';
        try { gs = ctx.services?.geocoder?.status?.() || 'unknown'; } catch { /* ignore */ }
        if (globalThis.navigator?.onLine === false) return false;
        return st !== 'down' && gs !== 'down';
    }

    // ---------------------------------------------------------------- render
    function section(title, extra) {
        return h('div', { class: 'pal-sec', role: 'presentation' }, h('span', null, title), extra || null);
    }

    function optionEl(model, idx) {
        const id = `${listId}-o${idx}`;
        model.elId = id;
        const el = h('div', {
            class: `pal-opt pal-opt--${model.type}`, id, role: 'option', 'aria-selected': 'false', 'data-idx': String(idx),
        }, h('span', { class: 'pal-opt__icon', 'aria-hidden': 'true' }, icon(model.icon, { size: 18 })),
        h('span', { class: 'pal-opt__main' },
            h('span', { class: 'pal-opt__title' }, model.titleNodes || model.title),
            model.sub ? h('span', { class: 'pal-opt__sub' }, model.sub) : null),
        model.meta ? h('span', { class: 'pal-opt__meta' }, model.meta) : null);
        return el;
    }

    function cityModel(p, type) {
        const sub = [p.admin && p.admin !== p.name ? p.admin : '', p.country || ''].filter(Boolean).join(', ');
        const meta = [];
        if (type === 'online' && p.source) meta.push(h('span', { class: `badge badge--provider badge--${p.source}` }, PROVIDER_LABEL[p.source] || p.source));
        meta.push(h('span', { class: 'pal-opt__coords' }, ui.latLonText(p.lat, p.lon, 1)));
        return {
            type, icon: type === 'online' ? 'globe' : 'city', place: p, title: p.name,
            titleNodes: highlight(p.name, query), sub, meta,
            label: `${p.name}${sub ? ', ' + sub : ''}`,
        };
    }

    function render(keepActive = false) {
        const prevActiveKey = keepActive && options[active] ? options[active].key : null;
        const nodes = [];
        options = [];
        const add = (m) => { m.key = `${m.type}:${m.title}:${m.place ? placeKey(m.place.lat ?? m.place.latDeg, m.place.lon ?? m.place.lonDeg) : ''}`; options.push(m); nodes.push(optionEl(m, options.length - 1)); };

        if (coords) {
            nodes.push(section('Coordinates'));
            add({ type: 'coords', icon: 'crosshair', title: `Go to ${ui.latLonText(coords.lat, coords.lon, 4, ', ')}`, place: { lat: coords.lat, lon: coords.lon },
                sub: ui.nearestCityText(coords.lat, coords.lon) ? `near ${ui.nearestCityText(coords.lat, coords.lon)}` : '' });
        }
        if (query) {
            const cityTitle = section('Cities (offline)');
            if (!ctx.services?.cities || ctx.services.cities.ready === false) {
                nodes.push(cityTitle, h('p', { class: 'pal-note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading the city list…'));
            } else if (cities.length) {
                nodes.push(cityTitle);
                cities.forEach((p) => add(cityModel(p, 'city')));
            }
            // Online section.
            if (query.length >= 3 && !coords) {
                const spinner = onlineState === 'loading' || onlineState === 'waiting'
                    ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : null;
                nodes.push(section('Online results', spinner));
                if (!onlineAvailable()) {
                    nodes.push(h('p', { class: 'pal-note' }, 'Online search unavailable — pick a listed city, click the globe, or enter coordinates.'));
                } else if (onlineState === 'error') {
                    nodes.push(h('p', { class: 'pal-note' }, 'Online search unavailable — pick a listed city, click the globe, or enter coordinates.'));
                } else if (onlineState === 'done' && !online.length && enterRan) {
                    nodes.push(h('p', { class: 'pal-note' }, `No online results for “${query}”.`));
                } else if (onlineState === 'waiting' || onlineState === 'loading') {
                    if (!online.length) nodes.push(h('p', { class: 'pal-note pal-note--quiet' }, 'Searching…'));
                }
                online.forEach((p) => add(cityModel(p, 'online')));
                if (!enterRan && onlineState !== 'loading' && onlineAvailable() && ctx.services?.geocoder) {
                    add({ type: 'more', icon: 'search', title: 'Search more places online', sub: 'Includes OpenStreetMap Nominatim',
                        meta: [h('kbd', { class: 'kbd' }, 'Enter')] });
                }
            }
        }
        // Recent places (filtered by the query when there is one).
        const rec = query ? recents.filter((r) => fold(r.name || '').includes(fold(query)) || fold(r.country || '').includes(fold(query))) : recents;
        if (rec.length) {
            nodes.push(section('Recent places'));
            rec.forEach((r) => {
                const label = ui.placeLabel({ name: r.name, country: r.country, latDeg: r.latDeg, lonDeg: r.lonDeg });
                add({ type: 'recent', icon: 'history', title: label.charAt(0).toUpperCase() + label.slice(1), titleNodes: highlight(label.charAt(0).toUpperCase() + label.slice(1), query),
                    place: r, sub: '', meta: [h('span', { class: 'pal-opt__coords' }, ui.latLonText(r.latDeg, r.lonDeg, 1))] });
            });
        }
        if (!query && !rec.length) {
            nodes.push(h('div', { class: 'pal-hello' },
                h('p', null, 'Type a city, or coordinates in decimal or degrees-minutes-seconds.'),
                h('div', { class: 'pal-examples' }, EXAMPLES.map((ex) => h('button', {
                    class: 'chip chip--quick', type: 'button', onClick: () => { input.value = ex; runSearch(); input.focus(); },
                }, ex)))));
        } else if (query && !options.length && onlineState !== 'waiting' && onlineState !== 'loading') {
            nodes.push(h('p', { class: 'pal-empty' }, `No places match “${query}”. Try another spelling, or enter coordinates like 48.86, 2.35.`));
        }
        list.replaceChildren(...nodes);
        // Keep or set the active option (the first one by default, so Enter picks it).
        let idx = prevActiveKey ? options.findIndex((o) => o.key === prevActiveKey) : -1;
        if (idx < 0) idx = options.length ? 0 : -1;
        if (idx >= 0 && options[idx].type === 'more' && options.length > 1 && !prevActiveKey) idx = 0;
        setActive(query ? idx : -1, false);
    }

    function setActive(i, scroll = true) {
        active = i;
        const els = list.querySelectorAll('[role="option"]');
        els.forEach((el, k) => {
            const on_ = k === i;
            el.setAttribute('aria-selected', String(on_));
            el.classList.toggle('is-active', on_);
        });
        if (i >= 0 && options[i]) {
            input.setAttribute('aria-activedescendant', options[i].elId);
            if (scroll) els[i]?.scrollIntoView({ block: 'nearest' });
        } else input.removeAttribute('aria-activedescendant');
    }

    // ---------------------------------------------------------------- choose
    function choose(model) {
        if (!model) return;
        if (model.type === 'more') { searchOnline(true); return; }
        let obs;
        if (model.type === 'coords') {
            obs = { latDeg: model.place.lat, lonDeg: wrapLon(model.place.lon), elevM: 0, name: '', country: '', tz: null, tzApprox: false, source: 'manual' };
        } else if (model.type === 'recent') {
            const r = model.place;
            obs = { latDeg: r.latDeg, lonDeg: r.lonDeg, elevM: 0, name: r.name || '', country: r.country || '', tz: r.tz || null,
                tzApprox: false, source: 'city', ...(r.cc ? { cc: r.cc } : {}) };
        } else {
            const p = model.place;
            obs = { latDeg: p.lat, lonDeg: wrapLon(p.lon), elevM: 0, name: p.name || '', country: p.country || '', tz: p.tz || null, tzApprox: false,
                source: model.type === 'online' ? 'search' : 'city', ...(p.cc ? { cc: p.cc } : {}) };
        }
        ui.act('setObserver', obs, { fly: true });
        ui.closePalette();
    }
    const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

    // actions.setObserver records the placement right after the store changes; re-read on the next tick.
    offs.push(store.subscribe((s) => s.observer, () => {
        if (layer.hidden) return;
        setTimeout(() => { loadRecents(); if (!layer.hidden) render(true); }, 0);
    }));

    // ---------------------------------------------------------------- events
    offs.push(on(input, 'input', runSearch));
    offs.push(on(input, 'keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (options.length) setActive((active + 1) % options.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (options.length) setActive((active - 1 + options.length) % options.length); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (active >= 0 && options[active]) choose(options[active]);
            else if (query) searchOnline(true);
        } else if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            if (input.value) { input.value = ''; runSearch(); } else ui.closePalette();
        }
    }));
    offs.push(on(list, 'pointermove', (e) => {
        const el = /** @type {HTMLElement} */ (e.target).closest('[role="option"]');
        if (el && Number(el.dataset.idx) !== active) setActive(Number(el.dataset.idx), false);
    }));
    offs.push(on(list, 'click', (e) => {
        const el = /** @type {HTMLElement} */ (e.target).closest('[role="option"]');
        if (el) choose(options[Number(el.dataset.idx)]);
    }));
    offs.push(on(clearBtn, 'click', () => { input.value = ''; runSearch(); input.focus(); }));
    offs.push(on(closeBtn, 'click', () => ui.closePalette()));
    offs.push(on(layer.querySelector('.modal-backdrop'), 'click', () => ui.closePalette()));
    offs.push(on(dialog, 'keydown', (e) => {
        if (e.key === 'Escape' && e.target !== input) { e.preventDefault(); e.stopPropagation(); ui.closePalette(); }
    }));
    offs.push(on(locateBtn, 'click', async () => {
        if (locating) return;
        locating = true;
        locateBtn.disabled = true;
        locateBtn.classList.add('is-busy');
        setText(locateLabel, 'Locating…');
        const before = store.get().observer;
        try { await ui.act('locateMe'); } catch { /* actions toasts the reason */ }
        locating = false;
        locateBtn.disabled = false;
        locateBtn.classList.remove('is-busy');
        setText(locateLabel, 'Use my location');
        const after = store.get().observer;
        if (after !== before && after?.source === 'geo') ui.closePalette();
        else if (!layer.hidden) input.focus();
    }));
    offs.push(on(pickBtn, 'click', () => {
        ui.closePalette();
        if (store.get().view?.mode === 'sky') ui.act('setViewMode', 'orbit');
        ui.pickHint(true);
    }));

    function syncStatus() {
        const ok = onlineAvailable();
        let st = 'unknown';
        try { st = store.get().status?.onlineSearch || ctx.services?.geocoder?.status?.() || 'unknown'; } catch { /* ignore */ }
        // Until a request has actually succeeded we only know it *may* work: a neutral dot, no green.
        const confirmed = ok && st === 'ok';
        setText(statusText, `Online search: ${ok ? 'available' : 'unavailable'}`);
        statusDot.classList.toggle('is-ok', confirmed);
        statusDot.classList.toggle('is-down', !ok);
        statusText.parentElement?.setAttribute?.('title', ok
            ? (confirmed ? 'Online place search is working.' : 'Online place search is used when you type 3 or more letters.')
            : 'Online place search is unreachable. Offline cities and coordinates still work.');
    }
    offs.push(store.subscribe((s) => s.status?.onlineSearch, () => { syncStatus(); if (!layer.hidden) render(true); }));
    offs.push(on(window, 'online', syncStatus));
    offs.push(on(window, 'offline', syncStatus));

    // ---------------------------------------------------------------- open / close
    function show(open) {
        if (open === !layer.hidden) return;
        layer.hidden = !open;
        layer.classList.toggle('is-open', open);
        if (open) {
            syncStatus();
            loadRecents();
            input.value = '';
            runSearch();
            release = trapFocus(dialog, { initial: input });
        } else {
            clearTimeout(debounce);
            searchCtl?.abort(); searchCtl = null;
            release?.(); release = null;
        }
    }
    offs.push(store.subscribe((s) => s.ui?.palette, (v) => show(!!v), { immediate: true }));

    return {
        destroy() {
            offs.forEach((off) => off());
            clearTimeout(debounce);
            searchCtl?.abort();
            release?.();
            layer.remove();
        },
    };
}
