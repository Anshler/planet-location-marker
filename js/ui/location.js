/**
 * Location palette (`role="dialog"`, bound to `state.ui.palette`): Coordinates (`parseLatLon`) →
 * In the sky (from 2 letters: the host's nine bodies, the extras registry and the named stars;
 * `rankSky`; choosing one selects it and opens Details) → Cities (offline) → Online results (400 ms
 * debounce; Nominatim only on Enter) → Recent places (`recentPlaces`, written by
 * actions.setObserver). The footer's status is the one place an outage is reported. The input is
 * an ARIA combobox over a listbox with `aria-activedescendant`; Esc closes in one press.
 *
 * `ui.palette === 'mars'` (Explore's Stand on Mars, or opening it on Mars) swaps the search for
 * the landing sites and an areographic lat/lon form; `'compare'` picks the second place.
 *
 * Each place previews its sky at the simulated time: its local clock and the Sun there ('sunrise
 * in 12 min', 'night'), with 'Moon up', on a pill in the sky's colour (ui/sky-palette.js), from the
 * readout's sub-points (`placeSky`, no astronomy call), refreshed at most once a second.
 *
 * @module ui/location
 */

import { parseLatLon } from '../geo/coords.js';
import { load as loadPref } from '../core/prefs.js';
import { h, on, setText, trapFocus, uid } from './dom.js';
import { icon } from './icons.js';
import { MARS_SITES } from '../astro/mars-clock.js';
import { BODY_INDEX, hostBodies } from '../astro/bodies.js';
import { SKY_LUT, skyLutIndex } from './sky-palette.js';
import { t, N_ } from '../core/i18n.js';

const MAX_RECENT = 6;
const DEBOUNCE_MS = 400;
const PROVIDER_LABEL = { 'open-meteo': 'Open-Meteo', photon: 'Photon', nominatim: 'OSM Nominatim', offline: N_('Offline') };
const PROVIDER_TONE = { 'open-meteo': 'accent', nominatim: 'ok' };
/** The empty palette's examples (shown with t(): 'Jupiter' is 'Sao Mộc' in Vietnamese; names pass through). */
const EXAMPLES = ['Tokyo', 'Jupiter', 'Sirius', 'ISS', 'Halley', '48.86, 2.35'];
const SKY_MAX = 6;
const SEARCH_PLACEHOLDER = N_('Search a place, or a planet, star or comet');
const KIND_WORD = { star: N_('Star'), moon: N_('Natural satellite'), planet: N_('Planet') };
const SKY_ICON = { sun: 'sun', moon: 'moon', star: 'star', comet: 'sparkle', guest: 'sparkle', craft: 'satellite', sat: 'satellite', dso: 'aperture' };

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * "In the sky" matches for `q` (2 letters or more, folded): a name or `also` (a designation such
 * as "M31") that starts with it, then a word that does, then any containing it; at each level the
 * nine bodies first, then index order. Pure.
 * @template {{name:string, also?:string, body?:boolean}} T
 * @param {T[]} index
 * @param {string} q
 * @param {number} [max]
 * @returns {T[]}
 */
export function rankSky(index, q, max = SKY_MAX) {
    const fq = fold(q).trim();
    if (fq.length < 2) return [];
    const hits = [];
    index.forEach((e, i) => {
        let lvl = 3;
        for (const s of [e.name, e.also]) {
            const f = fold(s);
            if (!f) continue;
            lvl = Math.min(lvl, f.startsWith(fq) ? 0 : ` ${f.replace(/[^a-z0-9]+/g, ' ')}`.includes(` ${fq}`) ? 1 : f.includes(fq) ? 2 : 3);
        }
        if (lvl < 3) hits.push({ e, k: 2 * lvl + (e.body ? 0 : 1), i });
    });
    hits.sort((a, b) => a.k - b.k || a.i - b.i);
    return hits.slice(0, max).map((x) => x.e);
}

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

const D2R = Math.PI / 180;
const HOUR = 3600e3;
/** Sunrise and sunset: the upper limb on the refracted horizon. */
const SUN_H0 = -0.833;
/** The Moon's standard altitude in geocentric terms (Meeus 15: 0.7275·π − 34′ with π ≈ 0.95°). */
const MOON_H0 = 0.125;
/** Sunrise or sunset is named when it is this close. */
const SOON_MS = 90 * 60e3;
export const PHASE_LABEL = Object.freeze({ day: N_('day'), civil: N_('civil twilight'), nautical: N_('nautical twilight'), astro: N_('astronomical twilight'), night: N_('night') });

/**
 * A place's sky at one instant from the Sun's and the Moon's sub-points (snapshot BodyState
 * `subLatDeg`/`subLonDeg`): a body's altitude is 90° minus the place's great-circle distance from
 * its sub-point (geocentric; within 0.01° for the Sun), and the sub-solar point moves west at
 * 15°/h, which times the next sunrise or sunset to a minute within the 90 minutes `skyWords`
 * names it (hours ahead, the held declination drifts: up to a few minutes in the Arctic).
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {{subLatDeg:number, subLonDeg:number}|null|undefined} sun
 * @param {{subLatDeg:number, subLonDeg:number}|null|undefined} moon
 * @param {number} tMs the sub-points' instant
 * @returns {{sunAlt:number, phase:'day'|'civil'|'nautical'|'astro'|'night', riseMs:number|null, setMs:number|null,
 *   moonAlt:number, moonUp:boolean}|null} null without a usable Sun (standing on Mars, no readout)
 */
export function placeSky(latDeg, lonDeg, sun, moon, tMs) {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(sun?.subLatDeg) || !Number.isFinite(sun?.subLonDeg)) return null;
    const sp = Math.sin(latDeg * D2R), cp = Math.cos(latDeg * D2R);
    const altOf = (b) => {
        const d = b.subLatDeg * D2R;
        const x = sp * Math.sin(d) + cp * Math.cos(d) * Math.cos((lonDeg - b.subLonDeg) * D2R);
        return Math.asin(Math.max(-1, Math.min(1, x))) / D2R;
    };
    const sunAlt = altOf(sun);
    const phase = sunAlt > SUN_H0 ? 'day' : sunAlt > -6 ? 'civil' : sunAlt > -12 ? 'nautical' : sunAlt > -18 ? 'astro' : 'night';
    let riseMs = null, setMs = null;
    const sd = Math.sin(sun.subLatDeg * D2R), cd = Math.cos(sun.subLatDeg * D2R);
    const cosH0 = (Math.sin(SUN_H0 * D2R) - sp * sd) / (cp * cd);
    if (Number.isFinite(tMs) && cosH0 > -1 && cosH0 < 1) {
        const h0 = Math.acos(cosH0) / D2R;
        const ha = ((((lonDeg - sun.subLonDeg) % 360) + 540) % 360) - 180;
        if (Math.abs(ha) < h0) setMs = tMs + ((h0 - ha) / 15) * HOUR;
        else riseMs = tMs + (((((-h0 - ha) % 360) + 360) % 360) / 15) * HOUR;
    }
    const moonAlt = Number.isFinite(moon?.subLatDeg) && Number.isFinite(moon?.subLonDeg) ? altOf(moon) : NaN;
    return { sunAlt, phase, riseMs, setMs, moonAlt, moonUp: moonAlt > MOON_H0 };
}

/**
 * The words of a place's sky: 'sunrise in 12 min' within 90 minutes of it, else the phase
 * ('night', 'civil twilight'…), and ', Moon up'.
 * @param {NonNullable<ReturnType<typeof placeSky>>} sky
 * @param {number} tMs
 * @param {(ms:number) => string} rel relative time from tMs ('in 12 min', 'now')
 */
export function skyWords(sky, tMs, rel) {
    let s = t(PHASE_LABEL[sky.phase]);
    if (sky.riseMs !== null && sky.riseMs - tMs <= SOON_MS) s = t('sunrise {when}', { when: rel(sky.riseMs) });
    else if (sky.setMs !== null && sky.setMs - tMs <= SOON_MS) s = t('sunset {when}', { when: rel(sky.setMs) });
    return sky.moonUp ? t('{sky}, Moon up', { sky: s }) : s;
}

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
        'aria-autocomplete': 'list', 'aria-label': t('Search places and the sky, or enter coordinates'), autocomplete: 'off',
        autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
        placeholder: t(SEARCH_PLACEHOLDER),
    });
    const clearBtn = h('button', { class: 'icon-btn icon-btn--sm palette__clear', type: 'button', 'aria-label': t('Clear search'), hidden: true }, icon('close', { size: 16 }));
    // Phones only (desktop shows the Esc hint): a text "Cancel" so it can't be confused with the clear ×.
    const closeBtn = h('button', { class: 'btn palette__close', type: 'button', 'aria-label': t('Close search') }, t('Cancel'));
    const escHint = h('kbd', { class: 'kbd palette__esc', 'aria-hidden': 'true' }, 'Esc');
    const list = h('div', { class: 'palette__list', id: listId, role: 'listbox', 'aria-label': t('Places and sky objects') });
    const locateLabel = h('span', null, t('Use my location'));
    const locateBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('locate', { size: 16 }), locateLabel);
    const pickBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('globe', { size: 16 }), t('Pick on the globe'));
    // A second place to compare with (two-observers; opened from Explore and Details): `ui.palette ===
    // 'compare'` turns the palette into its picker, whose foot offers to remove it.
    const uncompareBtn = h('button', { class: 'btn btn--soft', type: 'button', hidden: true }, icon('close', { size: 16 }), t('Remove second place'));
    const compareHead = h('p', { class: 'palette__mode', hidden: true });
    // Stand on Mars (ROADMAP stand-on-mars; opened from Explore): the landing sites and an areographic lat/lon.
    const marsLat = h('input', { class: 'input input--num', type: 'number', min: '-90', max: '90', step: 'any', inputmode: 'decimal', 'aria-label': t('Latitude on Mars, degrees north') });
    const marsLon = h('input', { class: 'input input--num', type: 'number', min: '-180', max: '360', step: 'any', inputmode: 'decimal', 'aria-label': t('Longitude on Mars, degrees east') });
    const marsErr = h('p', { class: 'pop__error', role: 'alert', hidden: true });
    const marsForm = h('form', { class: 'mars-coords', novalidate: true },
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('Latitude °N')), marsLat),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('Longitude °E')), marsLon),
        h('button', { class: 'btn btn--primary', type: 'submit' }, t('Stand here')));
    const marsSites = h('div', { class: 'mars-sites', role: 'group', 'aria-label': t('Landing sites') },
        MARS_SITES.map((st) => h('button', { class: 'mars-site', type: 'button', 'data-site': st.id },
            h('span', { class: 'mars-site__name' }, t(st.name)),
            h('span', { class: 'mars-site__sub' }, `${st.mission} · ${ui.latLonText(st.latDeg, st.lonDeg, 1)}`))));
    const earthSearchBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('search', { size: 16 }), t('Search places on Earth'));
    const homeBtn = h('button', { class: 'btn btn--soft', type: 'button', hidden: true }, icon('globe', { size: 16 }), t('Back to Earth'));
    const marsBox = h('div', { class: 'palette__mars', hidden: true },
        h('p', { class: 'palette__mode' }, t('Stand on Mars: the sky from a landing site, with the Earth and the Moon as a bright evening or morning pair. The globe stays the Earth’s.')),
        marsSites,
        h('p', { class: 'note' }, t('Or any place, in planetocentric degrees (east longitude):')),
        marsForm, marsErr,
        h('div', { class: 'btn-row' }, earthSearchBtn, homeBtn));
    const statusText = h('span', { class: 'badge badge--dot badge--muted' });
    const status = h('span', { class: 'palette__status' }, statusText);
    const dialog = h('div', { class: 'palette glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Change location') },
        compareHead,
        h('div', { class: 'palette__search' },
            h('span', { class: 'palette__icon', 'aria-hidden': 'true' }, icon('search', { size: 20 })),
            input, clearBtn, escHint, closeBtn),
        list,
        marsBox,
        h('div', { class: 'palette__foot' }, h('div', { class: 'btn-row' }, locateBtn, pickBtn, uncompareBtn), status));
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
    /** @type {{el: HTMLElement, lat: number, lon: number, tz: string|null}[]} the options' sky lines */
    let skyEls = [];
    let skyAt = 0;
    let active = -1;
    let release = null;
    let locating = false;
    let comparing = false;
    /** @type {{name:string, country:string, latDeg:number, lonDeg:number, tz:string|null, cc:string}[]} */
    let recents = [];
    /** @type {any[]} the In the sky matches */
    let sky = [];
    /** @type {{id:string, name:string, also?:string, body?:boolean, kind:string, label:string, dir?:ArrayLike<number>}[]|null} */
    let skyIndex = null;
    let starNames = null, askedStars = false;

    /** The sky index, rebuilt when the registry changes or the star names arrive. */
    function buildSky() {
        const mars = store.get().host?.id === 'mars';
        // The locale's name first ('Sao Mộc'); the English one ('Jupiter') still finds it.
        const out = hostBodies(mars ? 'mars' : 'earth').map((b) => ({ id: b.id, name: t(b.name), also: t(b.name) !== b.name ? b.name : '', body: true, kind: b.id,
            label: KIND_WORD[b.kind] ? t(KIND_WORD[b.kind]) : '' }));
        const ex = ctx.extras;
        for (const id of ex?.ids?.() ?? []) {
            const m = ex.meta(id);
            if (!m || m.kind === 'star' || (m.kind === 'moon' && !mars) || (m.kind === 'sat' && mars)) continue;
            out.push({ id, name: t(m.name), also: m.short && m.short !== m.name ? m.short : t(m.name) !== m.name ? m.name : '', kind: m.kind, label: t(m.kindLabel || '') });
        }
        for (const st of starNames ?? []) out.push({ id: `star:${st.hip}`, name: st.name, kind: 'star', label: t('Star'), dir: st.dirS });
        skyIndex = out;
        if (!askedStars && typeof ctx.services?.catalog === 'function') {
            askedStars = true;
            Promise.resolve(ctx.services.catalog()).then((k) => {
                const names = (k?.starNames ?? []).filter((x) => x?.name && Number.isInteger(x.hip));
                if (!names.length) { askedStars = false; return; }
                starNames = names.sort((a, b) => a.mag - b.mag);
                skyIndex = null;
                if (!layer.hidden && query) { runSearch(); }
            }, () => { askedStars = false; });
        }
    }
    if (ctx.extras?.onChange) offs.push(ctx.extras.onChange(() => { skyIndex = null; }));
    offs.push(store.subscribe((st) => st.host?.id, () => { skyIndex = null; }));

    /** "Planet · 25° up in the east", "Star · below the horizon", or the kind alone while unknown. */
    function skySub(e) {
        const snap = ui.snap;
        let alt = NaN, az = NaN;
        if (e.dir && snap?.observer?.upS) {
            const o = snap.observer, d = e.dir;
            const dot = (v) => d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
            alt = Math.asin(Math.max(-1, Math.min(1, dot(o.upS)))) * 180 / Math.PI;
            az = ((Math.atan2(dot(o.eastS), dot(o.northS)) * 180 / Math.PI) + 360) % 360;
        } else {
            const b = ui.bodyOf(snap, e.id);
            if (b) ({ alt, az } = ui.altAz(b));
        }
        if (!Number.isFinite(alt)) return e.label;
        return alt > 0 ? t('{kind} · {deg}° up in the {dir}', { kind: e.label, deg: Math.round(alt), dir: ui.compassWords(az) }) : t('{kind} · below the horizon', { kind: e.label });
    }

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
        sky = [];
        if (!coords && !comparing && query.length >= 2) {
            if (!skyIndex) buildSky();
            sky = rankSky(skyIndex, query);
        }
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
            model.sub ? h('span', { class: 'pal-opt__sub' }, model.sub) : null,
            model.sky ? skyLine(model.sky) : null),
        model.meta ? h('span', { class: 'pal-opt__meta' }, model.meta) : null);
        return el;
    }

    /**
     * An option's 'local time · sky' line, filled (and kept fresh) by refreshSky. A place without a
     * zone takes the nearest city's within 300 km, as the observer would (actions.normalizeObserver).
     */
    function skyLine({ lat, lon, tz }) {
        const el = h('span', { class: 'pal-opt__sky', hidden: true });
        let zone = tz || null;
        if (!zone) {
            try {
                const r = ctx.services?.cities?.nearest?.(+lat, +lon, 300);
                if (r?.city?.tz && r.km <= 300) zone = r.city.tz;
            } catch { zone = null; }
        }
        skyEls.push({ el, lat: +lat, lon: +lon, tz: zone });
        return el;
    }

    function refreshSky() {
        skyAt = performance.now();
        const snap = ui.snap, now = snap?.tMs;
        for (const s of skyEls) {
            const sky = placeSky(s.lat, s.lon, snap?.bodies?.[0], snap?.bodies?.[1], now);
            s.el.hidden = !sky;
            if (!sky) continue;
            const clock = ui.fmtClock(now, { tzName: s.tz || ui.observerTz({ lonDeg: s.lon }) });
            setText(s.el, `${s.tz ? '' : '≈ '}${clock} · ${skyWords(sky, now, (ms) => ui.fmt('fmtRelative', ms, now))}`);
            const tip = s.tz ? t('Local time there ({zone}) and its sky', { zone: s.tz }) : t('Approximate local time there (the zone is estimated from the longitude) and its sky');
            if (s.el.title !== tip) s.el.title = tip;
            const i = skyLutIndex(sky.sunAlt);
            s.el.style.setProperty('--sky', `rgb(${SKY_LUT[i]}, ${SKY_LUT[i + 1]}, ${SKY_LUT[i + 2]})`);
        }
    }

    function cityModel(p, type) {
        const sub = [p.admin && p.admin !== p.name ? p.admin : '', ui.countryText(p)].filter(Boolean).join(', ');
        const meta = [];
        if (type === 'online' && p.source) meta.push(h('span', { class: `badge badge--${PROVIDER_TONE[p.source] || 'muted'}` }, PROVIDER_LABEL[p.source] ? t(PROVIDER_LABEL[p.source]) : p.source));
        meta.push(h('span', { class: 'pal-opt__coords' }, ui.latLonText(p.lat, p.lon, 1)));
        return {
            type, icon: type === 'online' ? 'globe' : 'city', place: p, title: p.name,
            titleNodes: highlight(p.name, query), sub, meta, sky: { lat: p.lat, lon: p.lon, tz: p.tz },
            label: `${p.name}${sub ? ', ' + sub : ''}`,
        };
    }

    function render(keepActive = false) {
        const prevActiveKey = keepActive && options[active] ? options[active].key : null;
        const nodes = [];
        options = [];
        skyEls = [];
        const add = (m) => { m.key = `${m.type}:${m.title}:${m.place ? placeKey(m.place.lat ?? m.place.latDeg, m.place.lon ?? m.place.lonDeg) : ''}`; options.push(m); nodes.push(optionEl(m, options.length - 1)); };

        if (coords) {
            nodes.push(section(t('Coordinates')));
            const near = ui.nearestCityText(coords.lat, coords.lon);
            add({ type: 'coords', icon: 'crosshair', title: t('Go to {coords}', { coords: ui.latLonText(coords.lat, coords.lon, 4, ', ') }), place: { lat: coords.lat, lon: coords.lon },
                sub: near ? t('near {place}', { place: near }) : '',
                sky: { lat: coords.lat, lon: coords.lon, tz: null } });
        }
        if (sky.length) {
            nodes.push(section(t('In the sky')));
            sky.forEach((e) => add({ type: 'sky', icon: SKY_ICON[e.kind] || (e.body ? 'planet' : 'star'), title: e.name, titleNodes: highlight(e.name, query),
                sub: skySub(e), skyId: e.id }));
        }
        if (query) {
            const cityTitle = section(t('Cities (offline)'));
            if (!ctx.services?.cities || ctx.services.cities.ready === false) {
                nodes.push(cityTitle, h('p', { class: 'note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('Loading the city list…')));
            } else if (cities.length) {
                nodes.push(cityTitle);
                cities.forEach((p) => add(cityModel(p, 'city')));
            }
            // Unavailable or failed: the footer says so, once.
            if (query.length >= 3 && !coords && onlineAvailable() && onlineState !== 'error') {
                const spinner = onlineState === 'loading' || onlineState === 'waiting'
                    ? h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }) : null;
                nodes.push(section(t('Online results'), spinner));
                if (onlineState === 'done' && !online.length && enterRan) {
                    nodes.push(h('p', { class: 'note' }, t('No online results for “{query}”.', { query })));
                } else if (onlineState === 'waiting' || onlineState === 'loading') {
                    if (!online.length) nodes.push(h('p', { class: 'note' }, t('Searching…')));
                }
                online.forEach((p) => add(cityModel(p, 'online')));
                if (!enterRan && onlineState !== 'loading' && onlineAvailable() && ctx.services?.geocoder) {
                    add({ type: 'more', icon: 'search', title: t('Search more places online'), sub: t('Includes OpenStreetMap Nominatim'),
                        meta: [h('kbd', { class: 'kbd' }, 'Enter')] });
                }
            }
        }
        // Recent places (filtered by the query when there is one).
        const rec = query ? recents.filter((r) => fold(r.name || '').includes(fold(query)) || fold(r.country || '').includes(fold(query))) : recents;
        if (rec.length) {
            nodes.push(section(t('Recent places')));
            rec.forEach((r) => {
                const label = ui.placeLabel({ name: r.name, country: r.country, latDeg: r.latDeg, lonDeg: r.lonDeg });
                add({ type: 'recent', icon: 'history', title: label.charAt(0).toUpperCase() + label.slice(1), titleNodes: highlight(label.charAt(0).toUpperCase() + label.slice(1), query),
                    place: r, sub: '', sky: { lat: r.latDeg, lon: r.lonDeg, tz: r.tz },
                    meta: [h('span', { class: 'pal-opt__coords' }, ui.latLonText(r.latDeg, r.lonDeg, 1))] });
            });
        }
        if (!query && !rec.length) {
            nodes.push(h('div', { class: 'pal-hello' },
                h('p', null, t('Try Tokyo, Jupiter, Sirius, ISS or Halley.')),
                h('div', { class: 'pal-examples' }, EXAMPLES.map((ex) => h('button', {
                    class: 'chip', type: 'button', onClick: () => { input.value = t(ex); runSearch(); input.focus(); },
                }, t(ex))))));
        } else if (query && !options.length && onlineState !== 'waiting' && onlineState !== 'loading') {
            nodes.push(h('p', { class: 'pal-empty' }, t('Nothing matches “{query}”. Try another spelling, or enter coordinates like 48.86, 2.35.', { query })));
        }
        list.replaceChildren(...nodes);
        refreshSky();
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
        if (model.type === 'sky') {
            ui.act('select', model.skyId, { fly: true });
            ui.closePalette();
            ui.openPanel('details', { sheet: 'half' });
            return;
        }
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
        if (comparing) ui.act('setObserver2', obs);
        else ui.act('setObserver', obs, { fly: true });
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
            // One press closes, whatever was typed (× clears the text).
            e.preventDefault(); e.stopPropagation();
            ui.closePalette();
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
        setText(locateLabel, t('Locating…'));
        const before = store.get().observer;
        try { await ui.act('locateMe'); } catch { /* actions toasts the reason */ }
        locating = false;
        locateBtn.disabled = false;
        locateBtn.classList.remove('is-busy');
        setText(locateLabel, t('Use my location'));
        const after = store.get().observer;
        if (after !== before && after?.source === 'geo') ui.closePalette();
        else if (!layer.hidden) input.focus();
    }));
    offs.push(on(uncompareBtn, 'click', () => {
        ui.act('setObserver2', null);
        ui.closePalette();
    }));
    offs.push(on(marsSites, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('.mars-site');
        const st = b && MARS_SITES.find((x) => x.id === b.dataset.site);
        if (!st) return;
        if (ui.act('standOnMars', { latDeg: st.latDeg, lonDeg: st.lonDeg, name: st.name }) !== false) ui.closePalette();
    }));
    offs.push(on(marsForm, 'submit', (e) => {
        e.preventDefault();
        const la = Number(marsLat.value), lo = Number(marsLon.value);
        const bad = marsLat.value.trim() === '' || marsLon.value.trim() === '' || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90;
        marsErr.hidden = !bad;
        if (bad) { setText(marsErr, t('Enter a latitude from −90 to 90 and a longitude in degrees east.')); return; }
        if (ui.act('standOnMars', { latDeg: la, lonDeg: lo }) !== false) ui.closePalette();
    }));
    offs.push(on(earthSearchBtn, 'click', () => {
        store.set({ ui: { ...store.get().ui, palette: 'earth' } });
        input.focus();
    }));
    offs.push(on(homeBtn, 'click', () => {
        ui.act('leaveMars');
        ui.closePalette();
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
        setText(statusText, ok ? t('Online search: available') : t('Online search: unavailable'));
        statusText.className = `badge badge--dot badge--${confirmed ? 'ok' : ok ? 'muted' : 'warn'}`;
        statusText.parentElement?.setAttribute?.('title', ok
            ? (confirmed ? t('Online place search is working.') : t('Online place search is used when you type 3 or more letters.'))
            : t('Online place search is unreachable. Offline cities and coordinates still work.'));
    }
    offs.push(store.subscribe((s) => s.status?.onlineSearch, () => { syncStatus(); if (!layer.hidden) render(true); }));
    // The sky lines follow the readout while the palette is open (at most once a second).
    offs.push(ui.on('snap', () => { if (!layer.hidden && skyEls.length && performance.now() - skyAt >= 1000) refreshSky(); }));
    offs.push(ui.on('display', () => { if (!layer.hidden && skyEls.length) refreshSky(); }));
    offs.push(on(window, 'online', syncStatus));
    offs.push(on(window, 'offline', syncStatus));

    // ---------------------------------------------------------------- open / close
    /** Normal search, or the second place's picker ('compare'). */
    function setCompare(on) {
        comparing = on;
        const o2 = store.get().observer2;
        compareHead.hidden = !on;
        compareHead.textContent = on
            ? (o2 ? t('Compare with a second place (now {place}): its beams are drawn dashed, in amber.', { place: ui.placeLabel(o2, { country: false }) })
                : t('Compare with a second place: its own pin and dashed amber beams, side by side in Up now.'))
            : '';
        dialog.setAttribute('aria-label', on ? t('Compare with a second place') : t('Change location'));
        input.placeholder = on ? t('Search the second place, or type coordinates') : t(SEARCH_PLACEHOLDER);
        locateBtn.hidden = on;
        pickBtn.hidden = on;
        uncompareBtn.hidden = !on || !o2;
        dialog.classList.toggle('is-compare', on);
    }

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
    /** The Mars sites instead of the search ('mars', or any opening while standing on Mars). */
    function setMars(on) {
        marsBox.hidden = !on;
        dialog.classList.toggle('is-mars', on);
        // The search row and the list go; the foot's buttons follow the compare mode as setCompare left them.
        compareHead.nextElementSibling.hidden = on;
        list.hidden = on;
        for (const el of [locateBtn, pickBtn]) el.hidden = on || comparing;
        if (on) {
            const host = store.get().host;
            homeBtn.hidden = host?.id !== 'mars';
            marsLat.value = String(Math.round(host.latDeg * 1e4) / 1e4);
            marsLon.value = String(Math.round(host.lonDeg * 1e4) / 1e4);
            marsErr.hidden = true;
        }
        dialog.setAttribute('aria-label', on ? t('Stand on Mars') : comparing ? t('Compare with a second place') : t('Change location'));
    }
    offs.push(store.subscribe((s) => s.ui?.palette, (v) => {
        const was = comparing;
        setCompare(v === 'compare');
        const mars = v === 'mars' || (v === true && store.get().host?.id === 'mars');
        show(!!v);
        setMars(mars);
        if (mars) marsSites.querySelector('button')?.focus();
        else if (v && was !== comparing) { input.value = ''; runSearch(); input.focus(); }
    }, { immediate: true }));

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
