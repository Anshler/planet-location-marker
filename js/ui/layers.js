/**
 * Display tab (UI-REDESIGN §4.11): a switch per layer (actions.toggleLayer), the current view's
 * first (`where`: 'globe', which counts the map and the solar system, 'sky' or 'both'), then the
 * other view's; Quality, Sky conditions, Comfort, About this app (ui/about.js), Replay intro and
 * Reset all settings. Each group is a <details data-reveal> whose summary gives its state; pref
 * `displayOpen` keeps the open ones. Language · Ngôn ngữ (titled in both, so it is found in either)
 * saves the choice and reloads (actions.setLanguage; core/i18n.js). Text mode keeps Sky conditions,
 * Comfort, Language, About and the App row. Tables are English (N_), translated where shown.
 *
 * @module ui/layers
 */

import { DEFAULT_STATE } from '../core/store.js';
import { load as loadPref, save as savePref } from '../core/prefs.js';
import { ovalSummary } from '../astro/geomag.js';
import { VERSION } from '../version.js';
import { h, on, setText, segmented, switchRow, tpl } from './dom.js';
import { icon } from './icons.js';
import { mountAbout } from './about.js';
import { t, N_, LOCALES, locale } from '../core/i18n.js';

/** Layer switches by meaning: [key, label, keys?, description?, where ('globe' | 'sky' | 'both')]. */
export const LAYER_GROUPS = [
    {
        id: 'beams', title: N_('Beams and labels'),
        items: [
            ['beams', N_('Beams'), ['B'], N_('A line of sight from you to every body'), 'globe'],
            ['ghostBeams', N_('Beams through the Earth'), null, N_('Dashed where a beam passes through the planet'), 'globe'],
            ['sunMoonBeams', N_('Sun and Moon beams'), null, null, 'globe'],
            ['labels', N_('Labels'), null, null, 'both'],
        ],
    },
    {
        id: 'stars', title: N_('Stars'),
        items: [
            ['stars', N_('Stars'), null, null, 'both'],
            ['constellations', N_('Constellation lines'), ['C'], null, 'both'],
            ['constellationNames', N_('Constellation names'), ['Shift', 'C'], null, 'both'],
            ['starNames', N_('Star names'), null, null, 'both'],
            ['milkyWay', N_('Milky Way'), ['Shift', 'M'], null, 'both'],
            ['deepSky', N_('Deep-sky objects'), null, N_('Galaxies, clusters and nebulae as faint smudges at their true size; zoom in to see them'), 'both'],
        ],
    },
    {
        id: 'guides', title: N_('Guides'),
        items: [
            ['ecliptic', N_('Ecliptic'), ['E'], N_('The Sun’s yearly path; planets stay close to it'), 'both'],
            ['eqGrid', N_('Equatorial grid (RA/Dec)'), ['G'], N_('Right ascension and declination of date: the true pole and equinox'), 'both'],
            ['precession', N_('The pole’s 26,000-year circle (precession)'), null, N_('The pole’s 26,000-year circle, the pole of date and the equinox points among the stars'), 'both'],
            ['sunPath', N_('Sun paths and the analemma'), null, N_('Today’s and the solstices’ paths and the noon figure-8 in Sky view; the subsolar figure-8 on the globe'), 'both'],
            ['trails', N_('Path ±6 months'), ['T'], N_('Six months either side, with retrograde loops'), 'both'],
            ['altAzGrid', N_('Horizon grid'), null, N_('Altitude and azimuth when standing on the ground'), 'sky'],
        ],
    },
    {
        id: 'earth', title: N_('Earth'),
        items: [
            ['clouds', N_('Clouds'), null, N_('Illustrative, not live weather'), 'globe'],
            ['atmosphere', N_('Atmosphere'), null, null, 'globe'],
            ['horizon', N_('Horizon disc'), null, N_('Your local horizon with compass ticks'), 'globe'],
            ['footprint', N_('Where it’s up on Earth'), ['O'], N_('Where on Earth the selected body is up'), 'globe'],
            ['subpoints', N_('Overhead points'), null, N_('The spot on Earth directly below each body (always shown on the world map)'), 'globe'],
            ['landscape', N_('Illustrative landscape'), null, N_('Invented hills, trees and sea for your place; rise and set times use the flat horizon'), 'sky'],
        ],
    },
    {
        id: 'orbit', title: N_('In orbit'),
        items: [
            ['satellites', N_('Satellites'), null, N_('The ISS, Tiangong, Hubble and bright rocket bodies moving in real time, with their next visible passes'), 'both'],
            ['spacecraft', N_('Spacecraft'), null, N_('Faint radio beams to Voyager 1 and 2, New Horizons and JWST, with the one-way radio time'), 'both'],
            ['meteors', N_('Meteors'), null, N_('Shower radiants near their peak and illustrative meteors; pause for an hour’s composite'), 'sky'],
        ],
    },
];

/**
 * A view's layers by group, and the other view's, in group order. Pure.
 * @param {'globe'|'sky'} view
 * @returns {{groups: [string, string[]][], other: string[]}}
 */
export function layersFor(view) {
    const other = [];
    const groups = LAYER_GROUPS.map((g) => [g.title, g.items.filter((it) => {
        const here = it[4] === 'both' || it[4] === view;
        if (!here) other.push(it[0]);
        return here;
    }).map((it) => it[0])]);
    return { groups, other };
}

/** Bortle's names for classes 1…9. */
export const BORTLE_NAMES = [N_('Excellent dark site'), N_('Typical dark site'), N_('Rural sky'), N_('Rural/suburban transition'), N_('Suburban sky'),
    N_('Bright suburban sky'), N_('Suburban/urban transition'), N_('City sky'), N_('Inner-city sky')];
const TIER_NAME = { low: N_('Low'), medium: N_('Medium'), high: N_('High'), max: N_('Max') };
const AURORA_STATE = { quiet: N_('Quiet aurora'), typical: N_('Typical aurora'), storm: N_('Aurora storm') };

/**
 * Mounts the Display tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{destroy(): void}}
 */
export function mountDisplay(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const st0 = store.get();
    const opened = loadPref('displayOpen', ['beams']);
    const fill = (text, parts) => tpl(text, parts).textContent;
    /** A group: its summary is its title and its state (`set`). */
    const fold = (id, title, ...kids) => {
        const state = h('span', { class: 'fold__state' });
        const el = h('details', { class: 'fold', 'data-reveal': id, open: opened.includes(id) },
            h('summary', null, title, ' ', state), h('div', { class: 'fold__body' }, ...kids));
        return { el, body: el.lastChild, set: (text) => setText(state, text) };
    };
    // Each group stays as the user leaves it (a reveal counts).
    offs.push(on(root, 'toggle', () => savePref('displayOpen', [...root.querySelectorAll('[data-reveal][open]')].map((d) => d.dataset.reveal)), true));

    // ---------------------------------------------------------------- layers
    /** @type {Record<string, ReturnType<typeof switchRow>>} */
    const rows = {};
    const otherTitle = h('span');
    const boxes = [...LAYER_GROUPS.map((g) => {
        for (const [key, label, keys, desc] of g.items) {
            rows[key] = switchRow({
                label: t(label), desc: desc ? t(desc) : undefined, keys: keys || undefined, checked: !!st0.layers?.[key],
                onChange: (v) => ui.act('toggleLayer', key, v),
            });
        }
        return fold(g.id, t(g.title));
    }), fold('other', otherTitle)];
    const resetLayers = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('undo', { size: 15 }), t('Reset layers'));
    const viewNote = h('p', { class: 'display__view' });
    // The rows are compact; ⓘ shows every layer's description (still each row's aria-describedby).
    const describe = h('button', {
        class: 'icon-btn icon-btn--sm', type: 'button', 'aria-expanded': 'false', 'aria-label': t('What the layers show'), 'data-tip': t('What the layers show'),
    }, icon('info', { size: 16 }));
    const layersEl = h('div', { class: 'display-layers' },
        h('div', { class: 'section-head' }, viewNote, describe, resetLayers), boxes.map((b) => b.el),
        h('p', { class: 'note' }, t('Layer choices are remembered on this device and included in shared links.')));
    /** Each box's keys in this view. */
    let shown = [];
    let shownView = '';
    function placeLayers() {
        const view = store.get().view?.mode === 'sky' ? 'sky' : 'globe';
        if (view === shownView) return;
        shownView = view;
        const { groups, other: rest } = layersFor(view);
        shown = [...groups.map(([, keys]) => keys), rest];
        boxes.forEach((b, i) => b.body.replaceChildren(...shown[i].map((k) => rows[k].el)));
        setText(otherTitle, view === 'sky' ? t('Only on the globe') : t('Only in Sky view'));
        setText(viewNote, view === 'sky' ? t('Layers for the Sky view.') : t('Layers for the globe view.'));
    }
    offs.push(on(describe, 'click', () => describe.setAttribute('aria-expanded', String(layersEl.classList.toggle('is-described')))));
    offs.push(on(resetLayers, 'click', () => {
        store.set({ layers: { ...DEFAULT_STATE.layers } });
        ui.flash(t('Layers reset to their defaults'));
        ctx.bus.emit('announce', t('Layers reset to their defaults.'));
    }));

    // ---------------------------------------------------------------- quality
    const quality = segmented({
        label: t('Quality'),
        options: ['auto', 'low', 'medium', 'high', 'max'].map((v) => ({ value: v, label: v === 'auto' ? t('Auto') : t(TIER_NAME[v]) })),
        value: st0.quality?.setting || 'auto', onChange: (v) => ui.act('setQuality', v),
    });
    // Max is never chosen automatically, so its cost is spelled out next to the choice.
    const maxNote = h('p', { class: 'note' }, [t('Everything at full detail: 8K Earth maps, full screen resolution, every effect at its finest.'),
        t('Large download (about 15 MB more); for fast GPUs.')].join(' '));
    const qualityBox = fold('quality', t('Quality'), quality.el, maxNote);

    // ---------------------------------------------------------------- sky conditions
    // Light pollution in the Sky view (js/astro/skyglow.js), focused by a reveal.
    const skyDark = h('select', { class: 'select', 'data-autofocus': '' },
        h('option', { value: 'auto' }, t('Auto (from your place)')),
        h('option', { value: 'pristine' }, t('Pristine (no light pollution)')),
        ...BORTLE_NAMES.map((name, i) => h('option', { value: String(i + 1) }, `Bortle ${i + 1} · ${t(name)}`)));
    skyDark.value = st0.display?.skyDark || 'auto';
    const skyHint = h('p', { class: 'note' });
    offs.push(on(skyDark, 'change', () => ui.act('setSkyDark', skyDark.value)));
    // The Kp the modelled ovals are drawn for (js/astro/geomag.js). No live data.
    const aurora = segmented({
        label: t('Aurora'),
        options: [{ value: 'quiet', label: t('Quiet') }, { value: 'typical', label: t('Typical') }, { value: 'storm', label: t('Storm') }],
        value: st0.display?.aurora || 'typical', onChange: (v) => ui.act('setAuroraActivity', v),
    });
    const auroraHint = h('p', { class: 'note' });
    const conditions = fold('conditions', t('Sky conditions'),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('Light pollution')), skyDark), skyHint,
        h('div', { class: 'field' }, h('span', { class: 'field__label', 'aria-hidden': 'true' }, t('Aurora')), aurora.el), auroraHint);

    // ---------------------------------------------------------------- comfort
    // A device preference (display.red, saved, never in links).
    const red = switchRow({
        label: t('Night vision'), keys: ['Shift', 'N'],
        desc: t('A dim red screen that keeps your eyes dark-adapted outdoors. The screen stays awake while it is on'),
        checked: !!st0.display?.red, onChange: (v) => ui.act('setNightVision', v),
        note: globalThis.navigator && !('wakeLock' in navigator) ? t('This browser cannot keep the screen awake') : '',
    });
    const motion = h('p', { class: 'note' });
    const comfort = fold('comfort', t('Comfort'), red.el, motion);

    // ---------------------------------------------------------------- language
    // Titled in both languages, each choice in its own: findable whatever the page speaks.
    const langSeg = segmented({
        label: 'Language · Ngôn ngữ', options: Object.entries(LOCALES).map(([value, label]) => ({ value, label })),
        value: locale(), onChange: (v) => ui.act('setLanguage', v),
    });
    for (const b of langSeg.el.children) b.setAttribute('lang', b.dataset.value);
    const langBox = fold('lang', 'Language · Ngôn ngữ', langSeg.el, h('p', { class: 'note' }, t('Changing the language reloads the page; the place, time and view stay.')));
    langBox.set(LOCALES[locale()]);

    // ---------------------------------------------------------------- about, app
    const aboutBox = fold('about', t('About this app'));
    aboutBox.set(t('Version {version}', { version: VERSION }));
    const about = mountAbout(aboutBox.body, ctx);
    const replay = h('button', { class: 'btn btn--soft', type: 'button' }, icon('play', { size: 14 }), t('Replay intro'));
    const reset = h('button', { class: 'btn btn--danger-ghost', type: 'button' }, icon('undo', { size: 16 }), t('Reset all settings'));
    const confirmYes = h('button', { class: 'btn btn--danger', type: 'button' }, t('Reset'));
    const confirmNo = h('button', { class: 'btn btn--ghost', type: 'button' }, t('Cancel'));
    const confirm = h('div', { class: 'confirm', role: 'group', 'aria-label': t('Confirm reset'), hidden: true },
        h('p', { class: 'confirm__text' }, t('Reset layers, quality and time display to their defaults? Your location is kept.')),
        h('div', { class: 'confirm__actions' }, confirmNo, confirmYes));
    const noGl = h('p', { class: 'note' }, t('Layers are drawn in the 3D view, which this device can’t show.'));

    root.append(layersEl, noGl, qualityBox.el, conditions.el, comfort.el, langBox.el, aboutBox.el,
        h('div', { class: 'group group--actions' }, h('div', { class: 'btn-row' }, replay, reset), confirm));

    offs.push(on(replay, 'click', () => ui.act('replayIntro')));
    offs.push(on(reset, 'click', () => { confirm.hidden = false; reset.hidden = true; confirmNo.focus(); }));
    offs.push(on(confirmNo, 'click', () => { confirm.hidden = true; reset.hidden = false; reset.focus(); }));
    offs.push(on(confirmYes, 'click', () => {
        const d = DEFAULT_STATE;
        store.set({ layers: { ...d.layers }, display: { ...d.display } });
        ui.act('setQuality', d.quality.setting);
        ui.act('setTzMode', d.display.tzMode);
        ui.act('setEarthLock', d.view.earthLock);
        confirm.hidden = true;
        reset.hidden = false;
        reset.focus();
        ctx.bus.emit('toast', { message: t('Settings reset to defaults'), kind: 'info', timeoutMs: 3000 });
    }));

    const sync = () => {
        const st = store.get();
        const gl = st.status?.webgl !== false;
        layersEl.hidden = qualityBox.el.hidden = replay.hidden = !gl;
        noGl.hidden = gl;
        placeLayers();
        const ly = st.layers || {};
        for (const key in rows) rows[key].set(!!ly[key]);
        boxes.forEach((b, i) => b.set(t('{n} of {total} on', { n: shown[i].filter((k) => ly[k]).length, total: shown[i].length })));
        rows.clouds.setNote(st.quality?.active === 'low' ? t('Not drawn at Low quality') : '');
        const qs = st.quality?.setting || 'auto';
        const tier = t(TIER_NAME[st.quality?.active] || 'Medium');
        const chosen = TIER_NAME[qs] ? t(TIER_NAME[qs]) : t('Auto');
        quality.set(qs);
        // Auto, or Max held lower (repeated GPU context losses), says what runs.
        qualityBox.set(chosen === tier ? tier : t('{setting} (running {tier})', { setting: chosen, tier }));
        maxNote.hidden = qs !== 'max';
        const sd = st.display?.skyDark || 'auto';
        if (skyDark.value !== sd) skyDark.value = sd;
        const sg = ui.snap?.skyglow;
        setText(skyHint, sd === 'auto'
            ? sg?.auto ? t('Estimated Bortle {n} from the cities around {place}: moonlight and city glow brighten the sky and hide faint stars.', { n: sg.bortle, place: ui.placeShort(st.observer) })
                : t('Estimated from the cities around you: moonlight and city glow brighten the sky and hide faint stars.')
            : sd === 'pristine' ? t('No light pollution: the sky of a remote dark site, with moonlight only.')
                : t('{name} (Bortle {n}), wherever you are.', { n: sd, name: t(BORTLE_NAMES[Number(sd) - 1]) }));
        const au = st.display?.aurora || 'typical';
        aurora.set(au);
        setText(auroraHint, ovalSummary(au));
        const bortle = sd === 'auto' ? sg?.auto && sg.bortle : sd !== 'pristine' && sd;
        conditions.set(fill('{sky} · {aurora}', {
            sky: bortle ? fill('Bortle {n}', { n: bortle }) : sd === 'auto' ? t('Auto') : t('No light pollution'), aurora: t(AURORA_STATE[au]),
        }));
        red.set(!!st.display?.red);
        comfort.set(st.display?.red ? t('Night vision on') : t('Night vision off'));
        setText(motion, st.status?.reducedMotion || ui.reducedMotion()
            ? t('Reduced motion is on (system setting): transitions are cuts and the intro is skipped.')
            : t('Animations follow your system’s motion setting.'));
    };
    for (const k of ['layers', 'quality', 'display', 'observer', 'status']) offs.push(store.subscribe((s) => s[k], sync));
    offs.push(store.subscribe((s) => s.view?.mode, sync));
    // The estimated class arrives with the readouts (snap.skyglow).
    let lastSky = '';
    offs.push(ui.on('snap', (snap) => {
        const key = `${snap?.skyglow?.auto}|${snap?.skyglow?.bortle}`;
        if (key !== lastSky) { lastSky = key; sync(); }
    }));
    sync();

    return { destroy() { offs.forEach((off) => off()); about.destroy(); root.textContent = ''; } };
}
