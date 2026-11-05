/**
 * Display tab (UI-REDESIGN §4.11): a switch per layer (actions.toggleLayer), the current view's
 * first (`where`: 'globe', which counts the map and the solar system, 'sky' or 'both'), then the
 * other view's; Quality, Sky conditions, Comfort, About this app (ui/about.js), Replay intro and
 * Reset all settings. Each group is a <details data-reveal> whose summary gives its state; pref
 * `displayOpen` keeps the open ones. Text mode keeps Sky conditions, Comfort, About and the App row.
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

/** Layer switches by meaning: [key, label, keys?, description?, where ('globe' | 'sky' | 'both')]. */
export const LAYER_GROUPS = [
    {
        id: 'beams', title: 'Beams and labels',
        items: [
            ['beams', 'Beams', ['B'], 'A line of sight from you to every body', 'globe'],
            ['ghostBeams', 'Beams through the Earth', null, 'Dashed where a beam passes through the planet', 'globe'],
            ['sunMoonBeams', 'Sun and Moon beams', null, null, 'globe'],
            ['labels', 'Labels', null, null, 'both'],
        ],
    },
    {
        id: 'stars', title: 'Stars',
        items: [
            ['stars', 'Stars', null, null, 'both'],
            ['constellations', 'Constellation lines', ['C'], null, 'both'],
            ['constellationNames', 'Constellation names', ['Shift', 'C'], null, 'both'],
            ['starNames', 'Star names', null, null, 'both'],
            ['milkyWay', 'Milky Way', ['Shift', 'M'], null, 'both'],
            ['deepSky', 'Deep-sky objects', null, 'Galaxies, clusters and nebulae as faint smudges at their true size; zoom in to see them', 'both'],
        ],
    },
    {
        id: 'guides', title: 'Guides',
        items: [
            ['ecliptic', 'Ecliptic', ['E'], 'The Sun’s yearly path; planets stay close to it', 'both'],
            ['eqGrid', 'Equatorial grid (RA/Dec)', ['G'], 'Right ascension and declination of date: the true pole and equinox', 'both'],
            ['precession', 'The pole’s 26,000-year circle (precession)', null, 'The pole’s 26,000-year circle, the pole of date and the equinox points among the stars', 'both'],
            ['sunPath', 'Sun paths and the analemma', null, 'Today’s and the solstices’ paths and the noon figure-8 in Sky view; the subsolar figure-8 on the globe', 'both'],
            ['trails', 'Path ±6 months', ['T'], 'Six months either side, with retrograde loops', 'both'],
            ['altAzGrid', 'Horizon grid', null, 'Altitude and azimuth when standing on the ground', 'sky'],
        ],
    },
    {
        id: 'earth', title: 'Earth',
        items: [
            ['clouds', 'Clouds', null, 'Illustrative, not live weather', 'globe'],
            ['atmosphere', 'Atmosphere', null, null, 'globe'],
            ['horizon', 'Horizon disc', null, 'Your local horizon with compass ticks', 'globe'],
            ['footprint', 'Where it’s up on Earth', ['O'], 'Where on Earth the selected body is up', 'globe'],
            ['subpoints', 'Overhead points', null, 'The spot on Earth directly below each body (always shown on the world map)', 'globe'],
            ['landscape', 'Illustrative landscape', null, 'Invented hills, trees and sea for your place; rise and set times use the flat horizon', 'sky'],
        ],
    },
    {
        id: 'orbit', title: 'In orbit',
        items: [
            ['satellites', 'Satellites', null, 'The ISS, Tiangong, Hubble and bright rocket bodies moving in real time, with their next visible passes', 'both'],
            ['spacecraft', 'Spacecraft', null, 'Faint radio beams to Voyager 1 and 2, New Horizons and JWST, with the one-way radio time', 'both'],
            ['meteors', 'Meteors', null, 'Shower radiants near their peak and illustrative meteors; pause for an hour’s composite', 'sky'],
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
export const BORTLE_NAMES = ['Excellent dark site', 'Typical dark site', 'Rural sky', 'Rural/suburban transition', 'Suburban sky',
    'Bright suburban sky', 'Suburban/urban transition', 'City sky', 'Inner-city sky'];
const TIER_NAME = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
const AURORA_STATE = { quiet: 'Quiet aurora', typical: 'Typical aurora', storm: 'Aurora storm' };

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
    const fill = (t, parts) => tpl(t, parts).textContent;
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
                label, desc: desc || undefined, keys: keys || undefined, checked: !!st0.layers?.[key],
                onChange: (v) => ui.act('toggleLayer', key, v),
            });
        }
        return fold(g.id, g.title);
    }), fold('other', otherTitle)];
    const resetLayers = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('undo', { size: 15 }), 'Reset layers');
    const viewNote = h('p', { class: 'display__view' });
    // The rows are compact; ⓘ shows every layer's description (still each row's aria-describedby).
    const describe = h('button', {
        class: 'icon-btn icon-btn--sm', type: 'button', 'aria-expanded': 'false', 'aria-label': 'What the layers show', 'data-tip': 'What the layers show',
    }, icon('info', { size: 16 }));
    const layersEl = h('div', { class: 'display-layers' },
        h('div', { class: 'section-head' }, viewNote, describe, resetLayers), boxes.map((b) => b.el),
        h('p', { class: 'note' }, 'Layer choices are remembered on this device and included in shared links.'));
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
        setText(otherTitle, view === 'sky' ? 'Only on the globe' : 'Only in Sky view');
        setText(viewNote, view === 'sky' ? 'Layers for the Sky view.' : 'Layers for the globe view.');
    }
    offs.push(on(describe, 'click', () => describe.setAttribute('aria-expanded', String(layersEl.classList.toggle('is-described')))));
    offs.push(on(resetLayers, 'click', () => {
        store.set({ layers: { ...DEFAULT_STATE.layers } });
        ui.flash('Layers reset to their defaults');
        ctx.bus.emit('announce', 'Layers reset to their defaults.');
    }));

    // ---------------------------------------------------------------- quality
    const quality = segmented({
        label: 'Quality',
        options: ['auto', 'low', 'medium', 'high', 'max'].map((v) => ({ value: v, label: v === 'auto' ? 'Auto' : TIER_NAME[v] })),
        value: st0.quality?.setting || 'auto', onChange: (v) => ui.act('setQuality', v),
    });
    // Max is never chosen automatically, so its cost is spelled out next to the choice.
    const maxNote = h('p', { class: 'note' }, 'Everything at full detail: 8K Earth maps, full screen resolution, every effect at its finest. '
        + 'Large download (about 15 MB more); for fast GPUs.');
    const qualityBox = fold('quality', 'Quality', quality.el, maxNote);

    // ---------------------------------------------------------------- sky conditions
    // Light pollution in the Sky view (js/astro/skyglow.js), focused by a reveal.
    const skyDark = h('select', { class: 'select', 'data-autofocus': '' },
        h('option', { value: 'auto' }, 'Auto (from your place)'),
        h('option', { value: 'pristine' }, 'Pristine (no light pollution)'),
        ...BORTLE_NAMES.map((name, i) => h('option', { value: String(i + 1) }, `Bortle ${i + 1} · ${name}`)));
    skyDark.value = st0.display?.skyDark || 'auto';
    const skyHint = h('p', { class: 'note' });
    offs.push(on(skyDark, 'change', () => ui.act('setSkyDark', skyDark.value)));
    // The Kp the modelled ovals are drawn for (js/astro/geomag.js). No live data.
    const aurora = segmented({
        label: 'Aurora',
        options: [{ value: 'quiet', label: 'Quiet' }, { value: 'typical', label: 'Typical' }, { value: 'storm', label: 'Storm' }],
        value: st0.display?.aurora || 'typical', onChange: (v) => ui.act('setAuroraActivity', v),
    });
    const auroraHint = h('p', { class: 'note' });
    const conditions = fold('conditions', 'Sky conditions',
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Light pollution'), skyDark), skyHint,
        h('div', { class: 'field' }, h('span', { class: 'field__label', 'aria-hidden': 'true' }, 'Aurora'), aurora.el), auroraHint);

    // ---------------------------------------------------------------- comfort
    // A device preference (display.red, saved, never in links).
    const red = switchRow({
        label: 'Night vision', keys: ['Shift', 'N'],
        desc: 'A dim red screen that keeps your eyes dark-adapted outdoors. The screen stays awake while it is on',
        checked: !!st0.display?.red, onChange: (v) => ui.act('setNightVision', v),
        note: globalThis.navigator && !('wakeLock' in navigator) ? 'This browser cannot keep the screen awake' : '',
    });
    const motion = h('p', { class: 'note' });
    const comfort = fold('comfort', 'Comfort', red.el, motion);

    // ---------------------------------------------------------------- about, app
    const aboutBox = fold('about', 'About this app');
    aboutBox.set(fill('Version {version}', { version: VERSION }));
    const about = mountAbout(aboutBox.body, ctx);
    const replay = h('button', { class: 'btn btn--soft', type: 'button' }, icon('play', { size: 14 }), 'Replay intro');
    const reset = h('button', { class: 'btn btn--danger-ghost', type: 'button' }, icon('undo', { size: 16 }), 'Reset all settings');
    const confirmYes = h('button', { class: 'btn btn--danger', type: 'button' }, 'Reset');
    const confirmNo = h('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
    const confirm = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm reset', hidden: true },
        h('p', { class: 'confirm__text' }, 'Reset layers, quality and time display to their defaults? Your location is kept.'),
        h('div', { class: 'confirm__actions' }, confirmNo, confirmYes));
    const noGl = h('p', { class: 'note' }, 'Layers are drawn in the 3D view, which this device can’t show.');

    root.append(layersEl, noGl, qualityBox.el, conditions.el, comfort.el, aboutBox.el,
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
        ctx.bus.emit('toast', { message: 'Settings reset to defaults', kind: 'info', timeoutMs: 3000 });
    }));

    const sync = () => {
        const st = store.get();
        const gl = st.status?.webgl !== false;
        layersEl.hidden = qualityBox.el.hidden = replay.hidden = !gl;
        noGl.hidden = gl;
        placeLayers();
        const ly = st.layers || {};
        for (const key in rows) rows[key].set(!!ly[key]);
        boxes.forEach((b, i) => b.set(fill('{n} of {total} on', { n: shown[i].filter((k) => ly[k]).length, total: shown[i].length })));
        rows.clouds.setNote(st.quality?.active === 'low' ? 'Not drawn at Low quality' : '');
        const qs = st.quality?.setting || 'auto';
        const tier = TIER_NAME[st.quality?.active] || 'Medium';
        const chosen = TIER_NAME[qs] || 'Auto';
        quality.set(qs);
        // Auto, or Max held lower (repeated GPU context losses), says what runs.
        qualityBox.set(chosen === tier ? tier : fill('{setting} (running {tier})', { setting: chosen, tier }));
        maxNote.hidden = qs !== 'max';
        const sd = st.display?.skyDark || 'auto';
        if (skyDark.value !== sd) skyDark.value = sd;
        const sg = ui.snap?.skyglow;
        setText(skyHint, sd === 'auto'
            ? `${sg?.auto ? `Estimated Bortle ${sg.bortle} from the cities around ${ui.placeShort(st.observer)}` : 'Estimated from the cities around you'}: moonlight and city glow brighten the sky and hide faint stars.`
            : sd === 'pristine' ? 'No light pollution: the sky of a remote dark site, with moonlight only.'
                : `Bortle ${sd}: the sky of ${BORTLE_NAMES[Number(sd) - 1].toLowerCase()}, wherever you are.`);
        const au = st.display?.aurora || 'typical';
        aurora.set(au);
        setText(auroraHint, ovalSummary(au));
        const bortle = sd === 'auto' ? sg?.auto && sg.bortle : sd !== 'pristine' && sd;
        conditions.set(fill('{sky} · {aurora}', {
            sky: bortle ? fill('Bortle {n}', { n: bortle }) : sd === 'auto' ? 'Auto' : 'No light pollution', aurora: AURORA_STATE[au],
        }));
        red.set(!!st.display?.red);
        comfort.set(st.display?.red ? 'Night vision on' : 'Night vision off');
        setText(motion, st.status?.reducedMotion || ui.reducedMotion()
            ? 'Reduced motion is on (system setting): transitions are cuts and the intro is skipped.'
            : 'Animations follow your system’s motion setting.');
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
