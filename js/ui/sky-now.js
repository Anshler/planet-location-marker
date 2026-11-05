/**
 * Up now: a three-line summary (its ⓘ spells the terms out; Change → Display › Sky conditions),
 * then one row per body: colour dot, name, a mini sky compass, "34° · SE" or a countdown to its
 * rise, rise or set time, magnitude and a 24-h altitude sparkline (ui/tonight.js). Bodies above
 * the horizon come first by altitude, the rest by next rise; a row selects the body. Then one
 * Charts card: the Sky dome (ui/sky-dome.js) or Tonight (ui/tonight.js), only the one shown
 * drawn; its state is the `skyDome` preference (`chartsPref`). The list is the text alternative
 * to the 3D view, so every row has a full spoken label.
 *
 * Two places (store.observer2): a card above the list shows the selected body (else the Moon)
 * from both and the angle between the two directions; for the Moon, its parallax and the distance
 * it implies (astro/parallax.js, `snap.second`).
 *
 * @module ui/sky-now
 */

import { BODIES, BODY_INDEX, hostBodies } from '../astro/bodies.js';
import { marsClockText, marsSeason, marsSiteNear } from '../astro/mars-clock.js';
import { auroraText } from '../astro/geomag.js';
import { compareSight } from '../astro/parallax.js';
import { load as loadPref, save as savePref } from '../core/prefs.js';
import { h, s, on, setText, setAttr, segmented, tpl, uid } from './dom.js';
import { icon } from './icons.js';
import { mountTonight, drawSparkline } from './tonight.js';
import { mountSkyDome } from './sky-dome.js';
import { BORTLE_NAMES } from './layers.js';
import { t, N_, dec } from '../core/i18n.js';

/** The summary's badge, and the twilight's name in its ⓘ. */
const TW_BADGE = { day: N_('Day'), civil: N_('Twilight'), nautical: N_('Twilight'), astronomical: N_('Twilight'), night: N_('Night') };
const TW_NAME = { civil: N_('civil twilight'), nautical: N_('nautical twilight'), astronomical: N_('astronomical twilight'), night: N_('night') };

/**
 * The Charts card's preference from the stored `skyDome` and the older `tonightOpen`. `open` is
 * undefined until the user toggles the card (the layout decides till then); an open Tonight under
 * a closed dome becomes Tonight, open.
 * @param {any} dome stored skyDome ({open?, mode?, chart?}) or null
 * @param {any} tonightOpen
 * @returns {{open?: boolean, mode: string, chart: 'dome'|'tonight'}}
 */
export function chartsPref(dome, tonightOpen) {
    const p = dome && typeof dome === 'object' ? { ...dome } : {};
    p.mode = p.mode === 'map' ? 'map' : 'up';
    if (typeof p.open !== 'boolean') delete p.open;
    if (p.chart !== 'dome' && p.chart !== 'tonight') {
        if (tonightOpen === true && p.open !== true) { p.open = true; p.chart = 'tonight'; } else p.chart = 'dome';
    }
    return p;
}

/**
 * Builds the 32-px mini sky compass used in rows.
 * @returns {{el: SVGElement, needle: SVGGElement, dot: SVGCircleElement}}
 */
function makeCompass() {
    const needle = s('g', { class: 'compass__needle' },
        s('path', { class: 'compass__arm', d: 'M16 16V4.6' }),
        s('path', { class: 'compass__head', d: 'M16 2.6l2.3 3.6h-4.6z' }));
    const dot = s('circle', { class: 'compass__body', cx: 16, cy: 16, r: 2.6 });
    needle.appendChild(dot);
    const el = s('svg', { class: 'compass', viewBox: '0 0 32 32', width: 32, height: 32, 'aria-hidden': 'true' },
        s('circle', { class: 'compass__ring', cx: 16, cy: 16, r: 13 }),
        s('circle', { class: 'compass__mid', cx: 16, cy: 16, r: 6.5 }),
        s('path', { class: 'compass__n', d: 'M16 1.2v2.6' }),
        needle,
        s('circle', { class: 'compass__zenith', cx: 16, cy: 16, r: 1 }));
    return { el, needle, dot };
}

/**
 * Above the horizon? Uses the snapshot's refraction-aware `above` flag (upper limb
 * for the Sun and Moon) when present, else the altitude sign.
 * @param {any} b BodyState
 * @param {number} alt
 */
export function isUp(b, alt) {
    if (typeof b?.above === 'boolean') return b.above;
    return Number.isFinite(alt) && alt > 0;
}

/**
 * Formats rise/set information for a row.
 * @returns {string}
 */
function riseSetText(ui, id, up, now) {
    const rs = ui.riseSetFor(id, now);
    // The next one, so within a day the clock says it ("Sets 02:45", never "Rises Sun 07:28").
    const at = (ms) => (ms - now < 864e5 ? ui.fmtClock(ms) : ui.fmtWhen(ms, now));
    if (up) {
        if (rs.nextSetMs != null) return t('Sets {time}', { time: at(rs.nextSetMs) });
        if (rs.status === 'circumpolar') return t('Up all day');
        return '';
    }
    if (rs.nextRiseMs != null) return t('Rises {time}', { time: at(rs.nextRiseMs) });
    if (rs.status === 'never') return t('Stays below the horizon');
    return '';
}

/**
 * The right-hand column of a row below the horizon: how long until it rises.
 * @returns {string}
 */
export function downText(ui, rs, now) {
    if (rs.nextRiseMs != null) {
        const d = rs.nextRiseMs - now;
        const dur = ui.fmt('fmtDuration', d);
        if (dur !== '—' && Math.abs(d) < 30e3) return t('rising now');
        if (dur !== '—' && d > 0) return t('rises in {time}', { time: dur });
    }
    return rs.status === 'never' ? t('stays down') : t('below horizon');
}

/**
 * Mounts the Up now list.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void}}
 */
export function mountSkyNow(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];

    // ---------------------------------------------------------------- summary
    const badge = h('span', { class: 'badge' });
    const dark = h('span');
    const sun = h('p', { class: 'sum__line' });
    const skyEl = h('span');
    const change = h('button', { class: 'link', type: 'button', 'aria-label': t('Change the light pollution') }, t('Change'));
    const moreId = uid('sum');
    const more = h('div', { class: 'sum__more note', id: moreId, tabindex: '-1', hidden: true });
    const info = h('button', {
        class: 'icon-btn icon-btn--sm sum__info', type: 'button', 'aria-expanded': 'false', 'aria-controls': moreId,
        'aria-label': t('What these mean'), 'data-tip': t('What these mean'),
    }, icon('info', { size: 16 }));
    const summary = h('section', { class: 'sum', 'aria-label': t('Tonight’s sky') },
        h('p', { class: 'sum__line sum__line--head' }, badge, dark, info), sun,
        h('p', { class: 'sum__line' }, skyEl, ' ', change), more);
    offs.push(on(info, 'click', () => {
        more.hidden = !more.hidden;
        setAttr(info, 'aria-expanded', String(!more.hidden));
        if (!more.hidden) more.focus();
    }));
    offs.push(on(change, 'click', () => ui.openPanel('display', { reveal: 'conditions' })));
    const list = h('ul', { class: 'body-list', 'aria-label': t('Bodies, above the horizon first') });
    const upHead = h('li', { class: 'body-list__group', 'aria-hidden': 'true' }, h('span', null, t('Above the horizon')), h('span', { class: 'body-list__count' }));
    const downHead = h('li', { class: 'body-list__group', 'aria-hidden': 'true' }, h('span', null, t('Below the horizon')), h('span', { class: 'body-list__count' }));
    const empty = h('p', { class: 'empty' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('Computing positions…'));

    // ---------------------------------------------------------------- two places
    const cmpTitle = h('h3', { class: 'compare__title' });
    const cmpShow = h('button', { class: 'btn btn--soft btn--sm', type: 'button', title: t('Frame the Earth and the Moon so both places’ beams can be seen meeting at it') },
        icon('compare', { size: 15 }), t('Show both beams'));
    const cmpEdit = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': t('Change the second place'), title: t('Change the second place') }, icon('search', { size: 15 }));
    const cmpRemove = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': t('Remove the second place'), title: t('Remove the second place') }, icon('close', { size: 15 }));
    const cmpCol = (cls) => {
        const place = h('span', { class: 'compare__place' });
        const pos = h('span', { class: 'compare__pos' });
        const sub = h('span', { class: 'compare__sub' });
        return { el: h('div', { class: `compare__col ${cls}` }, place, pos, sub), place, pos, sub };
    };
    const cmpA = cmpCol('compare__col--a');
    const cmpB = cmpCol('compare__col--b');
    const cmpNote = h('p', { class: 'compare__note' });
    const compare = h('section', { class: 'compare', 'aria-label': t('Two places compared'), hidden: true },
        h('div', { class: 'compare__head' }, cmpTitle, h('span', { class: 'compare__tools' }, cmpShow, cmpEdit, cmpRemove)),
        h('div', { class: 'compare__grid', role: 'group' }, cmpA.el, cmpB.el),
        cmpNote);
    offs.push(on(cmpShow, 'click', () => ui.act('frameObservers')));
    offs.push(on(cmpEdit, 'click', () => ui.act('compareWith')));
    offs.push(on(cmpRemove, 'click', () => ui.act('setObserver2', null)));
    const sight = { sepDeg: 0, baselineKm: 0, perpKm: 0, distKm: NaN };

    // ---------------------------------------------------------------- charts
    const pref = chartsPref(loadPref('skyDome', null), loadPref('tonightOpen', null));
    let chosen = typeof pref.open === 'boolean';
    let open = chosen ? pref.open : false;
    let chart = pref.chart;
    const dome = mountSkyDome(ctx);
    const tonightCard = mountTonight(ctx);
    const chartsId = uid('charts');
    const chartsToggle = h('button', { class: 'charts__toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': chartsId },
        h('span', { class: 'charts__title' }, t('Charts')), icon('chevron-down', { size: 16 }));
    const chartSeg = segmented({
        label: t('Chart'), className: 'charts__seg', value: chart,
        options: [{ value: 'dome', label: t('Sky dome') }, { value: 'tonight', label: t('Tonight') }],
        onChange: (v) => { chart = v === 'tonight' ? 'tonight' : 'dome'; setCharts(true, true); },
    });
    const chartsBody = h('div', { class: 'charts__body', id: chartsId, hidden: true }, dome.el, tonightCard.el);
    const charts = h('section', { class: 'charts card', 'aria-label': t('Charts') }, h('div', { class: 'charts__head' }, chartsToggle, chartSeg.el), chartsBody);
    /** `save`: a user's choice, kept in `skyDome`. */
    function setCharts(o, save) {
        if (save) { chosen = true; savePref('skyDome', { ...chartsPref(loadPref('skyDome', null), null), open: o, chart }); }
        open = o;
        const mars = !!ui.onMars?.();
        const which = mars ? 'dome' : chart;
        chartSeg.el.hidden = mars;
        chartsBody.hidden = !open;
        charts.classList.toggle('is-open', open);
        setAttr(chartsToggle, 'aria-expanded', String(open));
        dome.el.hidden = which !== 'dome';
        tonightCard.el.hidden = which !== 'tonight';
        dome.setShown(open && which === 'dome');
        tonightCard.setShown(open && which === 'tonight');
        if (ui.snap) { dome.update(ui.snap); tonightCard.update(ui.snap); }
    }
    offs.push(on(chartsToggle, 'click', () => setCharts(!open, true)));
    // Until the user chooses: open on a tall desktop and in text mode.
    const byLayout = () => { if (!chosen) setCharts(ui.layout === 'text' || (ui.layout === 'desktop' && window.innerHeight >= 800), false); };
    offs.push(ui.on('layout', byLayout));
    offs.push(store.subscribe((st) => st.host?.id, () => setCharts(open, false)));

    const coarseTip = t('Tip: tap a row, or a world at the end of its beam, to meet it. Sky view stands you on the ground to look up.');
    const keys = () => h('span', null, h('kbd', { class: 'kbd' }, '1'), '–', h('kbd', { class: 'kbd' }, '9'));
    root.append(
        summary, compare, empty, list, charts,
        // Keys on a mouse and keyboard, gestures on a touch-first device (body.is-coarse, css/app.css).
        h('p', { class: 'note for-fine skynow__tip' }, tpl(t('Tip: press {keys} to select a body and {v} for Sky view.'), { keys: keys(), v: h('kbd', { class: 'kbd' }, 'V') })),
        h('p', { class: 'note for-coarse skynow__tip' }, coarseTip),
        h('p', { class: 'note skynow__tip skynow__tip--text' }, tpl(t('Tip: press {keys} to select a body.'), { keys: keys() })));
    byLayout();

    /** @type {Record<string, any>} */
    const rows = {};
    for (const b of BODIES) {
        const comp = makeCompass();
        const nameText = document.createTextNode(t(b.name));
        const name = h('span', { class: 'body-row__name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), nameText);
        const sub = h('span', { class: 'body-row__sub' });
        const alt = h('span', { class: 'body-row__alt' });
        const dir = h('span', { class: 'body-row__dir' });
        const spark = h('canvas', { class: 'body-row__spark', 'aria-hidden': 'true', hidden: true });
        const button = h('button', {
            class: 'body-row', type: 'button', 'data-id': b.id, style: { '--c': `var(--body-${b.id})` },
        }, h('span', { class: 'body-row__compass' }, comp.el),
        h('span', { class: 'body-row__main' }, name, sub),
        h('span', { class: 'body-row__pos' },
            h('span', { class: 'body-row__now' }, alt, h('span', { class: 'body-row__sep', 'aria-hidden': 'true' }, '·'), dir), spark));
        const li = h('li', { class: 'body-list__item' }, button);
        rows[b.id] = { li, button, comp, sub, alt, dir, nameText, spark, sparkKey: '', up: null, order: -1 };
    }
    offs.push(on(list, 'click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target).closest('.body-row');
        if (!btn) return;
        const id = btn.dataset.id;
        ui.act('select', id, { fly: true });
        ui.openPanel('details');
    }));

    let lastOrder = '';
    function update(snap) {
        if (!snap?.bodies?.length) return;
        empty.hidden = true;
        const now = snap.tMs;
        const sel = store.get().selection;
        const items = [];
        // Standing on Mars, slot 4 is the Earth (astro/bodies.js hostBodies).
        const table = hostBodies(snap.host);
        // Tonight's noon-to-noon altitudes (the Earth observer's) feed the sparklines.
        const series = snap.host === 'mars' ? null : ui.almanac.night?.tonight?.series ?? null;
        for (const b of snap.bodies) {
            const r = rows[b.id];
            if (!r) continue;
            const nm = t(table[BODY_INDEX[b.id]].name);
            if (r.nameText.data !== nm) r.nameText.data = nm;
            const { alt, az } = ui.altAz(b);
            const up = isUp(b, alt);
            const rs = ui.riseSetFor(b.id, now);
            items.push({ id: b.id, up, alt, rise: rs.nextRiseMs ?? (rs.status === 'never' ? Infinity : 9e15) });
            // Compass: needle to azimuth; the dot sits at the polar-projected altitude when up.
            if (Number.isFinite(az)) r.comp.needle.setAttribute('transform', `rotate(${az.toFixed(1)} 16 16)`);
            const rad = up ? 12.2 * (1 - Math.min(90, Math.max(0, alt)) / 90) : 13;
            r.comp.dot.setAttribute('cy', (16 - rad).toFixed(2));
            r.button.classList.toggle('is-down', !up);
            r.button.classList.toggle('is-selected', sel === b.id);
            setAttr(r.button, 'aria-current', sel === b.id ? 'true' : null);
            const altTxt = up ? `${Math.max(0, Math.round(alt))}°` : downText(ui, rs, now);
            const dirTxt = up ? ui.compass(az) : '';
            setText(r.alt, altTxt);
            setText(r.dir, dirTxt);
            const rsTxt = riseSetText(ui, b.id, up, now);
            const mag = b.id !== 'sun' && shownMag(b) !== null ? ui.fmt('fmtMag', b.mag) : '';
            setText(r.sub, [rsTxt, mag && t('mag {m}', { m: mag })].filter(Boolean).join(' · '));
            const body = ui.bodyName(b.id);
            const rising = !up && altTxt !== t('stays down') && altTxt !== t('below horizon');
            const spoken = up ? t('{body}: {deg} degrees up in the {dir}.', { body, deg: Math.round(alt), dir: ui.compassWords(az) })
                : rising ? t('{body}: below the horizon, {when}.', { body, when: altTxt }) : t('{body}: below the horizon.', { body });
            setAttr(r.button, 'aria-label', `${spoken} ${rsTxt ? rsTxt + '.' : ''} ${mag ? t('Magnitude {m}.', { m: mag }) : ''}`.trim());
            r.up = up;
            updateSpark(r, b.id, now, series);
        }
        items.sort((a, b) => (a.up !== b.up ? (a.up ? -1 : 1) : a.up ? b.alt - a.alt : a.rise - b.rise));
        const nUp = items.filter((i) => i.up).length;
        const order = items.map((i) => i.id).join(',') + '|' + nUp;
        if (order !== lastOrder) {
            lastOrder = order;
            const frag = [];
            if (nUp) frag.push(upHead);
            items.forEach((it, k) => {
                if (k === nUp && nUp < items.length) frag.push(downHead);
                frag.push(rows[it.id].li);
            });
            list.replaceChildren(...frag);
            setText(upHead.lastChild, String(nUp));
            setText(downHead.lastChild, String(items.length - nUp));
        }
        updateSummary(snap);
        updateCompare(snap);
        dome.update(snap);
        tonightCard.update(snap);
    }

    /** A row's 24-h sparkline, redrawn when the series changes or the now dot moves a pixel. */
    const SPARK_W = 44, SPARK_H = 16;
    let sparkRev = 0, sparkOf = null;
    function updateSpark(r, id, now, s) {
        const i = s && id !== 'sun' ? s.ids.indexOf(id) : -1;
        const row = !s ? -2 : id === 'sun' ? -1 : i >= 0 ? i : -2;
        const show = row >= -1;
        if (r.spark.hidden === show) r.spark.hidden = !show;
        if (!show) return;
        if (s !== sparkOf) { sparkOf = s; sparkRev += 1; }
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
        const key = `${sparkRev}|${dpr}|${Math.round(((now - s.t0Ms) / ((s.n - 1) * s.stepMs)) * SPARK_W)}`;
        if (key === r.sparkKey) return;
        r.sparkKey = key;
        if (r.spark.width !== SPARK_W * dpr) { r.spark.width = SPARK_W * dpr; r.spark.height = SPARK_H * dpr; }
        const c = r.spark.getContext('2d');
        if (c) drawSparkline(c, SPARK_W, SPARK_H, dpr, s, row, now, BODIES[BODY_INDEX[id]].color);
    }

    /** The two-places card: the selected body (else the Moon) from both, and their angle apart. */
    function updateCompare(snap) {
        const s2 = snap.second ?? null;
        const st = store.get();
        const o2 = st.observer2;
        compare.hidden = !s2 || !o2;
        if (compare.hidden) return;
        const id = st.selection && st.selection in BODY_INDEX ? st.selection : 'moon';
        const i = BODY_INDEX[id];
        const name = ui.bodyName(id);
        setText(cmpTitle, t('{body} from two places', { body: name }));
        cmpShow.hidden = st.status?.webgl === false;
        const fill = (col, b, placeName) => {
            const { alt, az } = ui.altAz(b);
            const up = isUp(b, alt);
            setText(col.place, placeName);
            setText(col.pos, Number.isFinite(alt) ? `${ui.fmt('fmtAlt', alt)} · ${ui.compass(az)}` : '—');
            const dir = ui.compassWords(az);
            setText(col.sub, up ? t('Up, in the {dir}', { dir }) : t('Below the horizon'));
            col.el.classList.toggle('is-down', !up);
            setAttr(col.el, 'aria-label', up ? t('From {place}: {body} {deg} degrees up in the {dir}.', { place: placeName, body: name, deg: Math.round(alt), dir })
                : t('From {place}: {body} below the horizon.', { place: placeName, body: name }));
        };
        fill(cmpA, snap.bodies[i], ui.placeName(st.observer?.name) || t('Your location'));
        fill(cmpB, s2.bodies[i], ui.placeName(o2.name) || t('Second place'));
        const r = compareSight(snap, s2, i, sight);
        let note = '';
        if (r) {
            const apart = r.sepDeg >= 0.1 ? `${dec(r.sepDeg, 2)}°` : r.sepDeg >= 0.001 ? `${dec(r.sepDeg * 3600, 1)}″` : t('less than 0.001°');
            note = id === 'moon' && Number.isFinite(r.distKm)
                ? t('Its direction differs by {apart} between the two places: the Moon’s parallax. {base} km of baseline across the line of sight ÷ {sep}° ≈ {dist} to the Moon, as Lalande and Lacaille measured it from Berlin and the Cape in 1751.',
                    { apart, base: ui.fmt('fmtInt', r.perpKm), sep: dec(r.sepDeg, 2), dist: ui.fmt('fmtDistKm', Math.round(r.distKm / 1000) * 1000) })
                : id === 'sun' ? t('Its direction differs by {apart} between the two places (the Sun’s tiny parallax): too far away for the sightlines to meet in view.', { apart })
                    : t('Its direction differs by {apart} between the two places: too far away for the sightlines to meet in view.', { apart });
        }
        setText(cmpNote, note);
    }
    offs.push(store.subscribe((st) => st.observer2, () => { if (ui.snap) update(ui.snap); }));

    /** The three lines and the sentences behind ⓘ, whole phrases (R6, R7). */
    let moreKey = '';
    function updateSummary(snap) {
        const tw = snap.observer?.twilight;
        const sunAlt = snap.observer?.sunAltDeg;
        const sol = solarEclipseState(snap);
        setText(badge, sol ? (sol.kind === 'total' ? t('Total solar eclipse') : t('Solar eclipse')) : t(TW_BADGE[tw] || 'Sky'));
        badge.className = `badge${sol || tw === 'day' ? ' badge--warn' : TW_BADGE[tw] === 'Twilight' ? ' badge--accent' : ''}`;
        const why = [];
        if (Number.isFinite(sunAlt)) {
            const a = ui.fmt('fmtAlt', Math.abs(sunAlt));
            why.push(sunAlt >= 0 ? t('The Sun is {alt} above the horizon.', { alt: a })
                : TW_NAME[tw] ? t('The Sun is {alt} below the horizon: {phase}.', { alt: a, phase: t(TW_NAME[tw]) }) : t('The Sun is {alt} below the horizon.', { alt: a }));
        }
        let l1 = '', l2 = '', l3 = '';
        const mars = snap.host === 'mars' && snap.mars;
        if (mars) {
            // Standing on Mars: the site and its clock, its season, and the light from home.
            const m = snap.mars;
            const site = marsSiteNear(m.site.latDeg, m.site.lonDeg, 0.5);
            l1 = `${t(m.site.name || 'Mars')} · ${marsClockText(m.time, site ? { ...site, lonDeg: m.site.lonDeg } : { lonDeg: m.site.lonDeg }).text}`;
            l2 = t('Ls {ls}°, {season}', { ls: Math.round(m.time.lsDeg), season: t(marsSeason(m.time.lsDeg, m.site.latDeg)) });
            const e = snap.bodies[BODY_INDEX.mars];
            if (e && Number.isFinite(e.lightTimeS)) l3 = t('The light from home left {n} min ago', { n: Math.max(1, Math.round(e.lightTimeS / 60)) });
            why.push(t('Rise and set times are not computed on Mars yet.'));
        } else {
            const n = ui.almanac.night?.twilight;
            if (n && Number.isFinite(n.astroDuskMs) && Number.isFinite(n.astroDawnMs)) {
                l1 = t('Fully dark {from}–{to}', { from: ui.fmtClock(n.astroDuskMs), to: ui.fmtClock(n.astroDawnMs) });
                why.push(t('Fully dark is astronomical night: the Sun more than 18° below the horizon, when the faintest stars show.'));
            } else if (n && Number.isFinite(n.sunsetMs)) {
                l1 = t('No full darkness tonight');
                why.push(t('Tonight the Sun never gets 18° below the horizon, so the sky never gets fully dark.'));
            }
            if (n && Number.isFinite(n.sunsetMs) && Number.isFinite(n.sunriseMs)) l2 = t('Sunset {set} · Sunrise {rise}', { set: ui.fmtClock(n.sunsetMs), rise: ui.fmtClock(n.sunriseMs) });
            const moon = ui.bodyOf(snap, 'moon');
            let m = '';
            if (moon && Number.isFinite(moon.phaseFrac) && Number.isFinite(snap.moonPhaseDeg)) {
                const ecl = lunarEclipseState(snap);
                const phase = moonPhaseName(snap.moonPhaseDeg);
                m = sol ? (sol.kind === 'total' ? t('The Moon covers the whole Sun') : t('The Moon covers {pct}% of the Sun', { pct: sol.pct }))
                    : ecl ? moonEclipseText(phase, ecl) : t('{phase}, {pct}% lit', { phase, pct: Math.round(moon.phaseFrac * 100) });
            }
            if (m) l2 = l2 ? `${l2} · ${m}` : m;
            const sky = skyDarknessText(snap);
            l3 = sky;
            if (sky) {
                why.push(t('The Bortle scale rates a night sky from 1, a pristine dark site, to 9, an inner city.'));
                if (darkEnough(snap)) why.push(t('The magnitude is that of the faintest stars a dark-adapted eye can see overhead, with the Moon and light pollution counted. Larger numbers are fainter.'));
            }
            const aur = auroraText(snap);
            if (aur) why.push(`${aur}.`);
        }
        setText(dark, l1);
        setText(sun, l2);
        sun.hidden = !l2;
        setText(skyEl, l3);
        change.hidden = !!mars || !snap.skyglow;
        const key = why.join(' ');
        if (key !== moreKey) { moreKey = key; more.replaceChildren(...why.map((w) => h('p', null, w))); }
    }

    offs.push(store.subscribe((st) => st.selection, () => { if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('almanac', () => { if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('display', () => { if (ui.snap) update(ui.snap); }));
    if (ui.snap) update(ui.snap);

    return {
        update,
        destroy() { offs.forEach((off) => off()); dome.destroy(); tonightCard.destroy(); root.textContent = ''; },
    };
}

/**
 * The light pollution in plain words (snap.skyglow, astro/skyglow.js): 'Inner-city sky: stars to
 * magnitude 3.6 (Bortle 9)', the zenith's naked-eye limit once the Sun is 15° down; by day
 * 'Inner-city sky (Bortle 9)'. Empty without a skyglow.
 * @param {any} snap
 * @returns {string}
 */
export function skyDarknessText(snap) {
    const sg = snap?.skyglow;
    if (!sg || !Number.isFinite(sg.bortle)) return '';
    const n = Math.min(9, Math.max(1, Math.round(sg.bortle)));
    const name = t(BORTLE_NAMES[n - 1]);
    if (darkEnough(snap)) return t('{name}: stars to magnitude {mag} (Bortle {n})', { name, mag: dec(sg.limitMag, 1), n });
    return t('{name} (Bortle {n})', { name, n });
}

/** Dark enough for the naked-eye limit: the Sun 15° down and a limit computed. */
const darkEnough = (snap) => snap.observer?.sunAltDeg <= -15 && Number.isFinite(snap.skyglow?.limitMag);

/**
 * Moon phase name from the Sun–Moon ecliptic elongation (0 = new, 180 = full).
 * Principal phases are named within ±6° (about half a day).
 * @param {number} deg
 * @returns {string}
 */
export function moonPhaseName(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 6 || d > 354) return t('New Moon');
    if (Math.abs(d - 90) < 6) return t('First quarter');
    if (Math.abs(d - 180) < 6) return t('Full Moon');
    if (Math.abs(d - 270) < 6) return t('Last quarter');
    if (d < 90) return t('Waxing crescent');
    if (d < 180) return t('Waxing gibbous');
    if (d < 270) return t('Waning gibbous');
    return t('Waning crescent');
}

/**
 * The Moon's lunar-eclipse state from a snapshot, or null when it is not noticeably shadowed.
 * `sunlit` is the disc's direct-sunlight fraction (snap.eclipse.moonLitFraction); the geometric
 * phase (phaseFrac) stays near 100 % through an eclipse, so the panels say so separately.
 * @param {any} snap
 * @returns {{total:boolean, sunlit:number, text:string} | null}
 */
export function lunarEclipseState(snap) {
    const e = snap?.eclipse;
    const lit = e?.moonLitFraction;
    if (!e?.lunar || !Number.isFinite(lit) || lit >= 0.99) return null;
    const sunlit = Math.min(1, Math.max(0, lit));
    const total = sunlit < 0.005;
    return { total, sunlit, text: total ? t('in total eclipse') : t('in eclipse, {pct}% sunlit', { pct: Math.round(sunlit * 100) }) };
}

/**
 * The Moon's phase and its eclipse as one phrase: 'Full Moon in total eclipse', 'Full Moon in
 * eclipse, 42% sunlit'.
 * @param {string} phase moonPhaseName
 * @param {{total:boolean, sunlit:number}} ecl lunarEclipseState
 */
export function moonEclipseText(phase, ecl) {
    return ecl.total ? t('{phase} in total eclipse', { phase }) : t('{phase} in eclipse, {pct}% sunlit', { phase, pct: Math.round(ecl.sunlit * 100) });
}

/**
 * The Sun's solar-eclipse state seen from the observer, or null when the Moon covers none of it
 * (snap.eclipse.obscurationAtObserver is 0 while the Sun is down). `covered` is the obscured
 * fraction of the Sun's disc. `kind` is 'total' exactly while that is 1 (the snapshot computes it
 * from the same topocentric discs as `geo`, so this is between second and third contact), else
 * 'annular' while the Moon's disc sits inside the Sun's, else 'partial'; a partial phase therefore
 * never reads 100 %. `geo` (arcseconds) when the snapshot carries the discs.
 * @param {any} snap
 * @returns {{kind:string, covered:number, pct:string, text:string, geo:{sep:number, rS:number, rM:number, pa:number}|null} | null}
 */
export function solarEclipseState(snap) {
    const o = snap?.eclipse?.obscurationAtObserver;
    if (!Number.isFinite(o) || o < 0.001) return null;
    const covered = Math.min(1, Math.max(0, o));
    const geo = solarDiscGeometry(snap);
    let kind = 'partial';
    if (covered >= 1) kind = 'total';
    else if (geo && geo.rM < geo.rS && geo.sep <= geo.rS - geo.rM) kind = 'annular';
    // Never round a partial phase up to 100 %: 99.96 % reads "99.9 %".
    const pct = covered > 0.99 ? dec(Math.floor(covered * 1000) / 10, 1) : String(Math.round(covered * 100));
    const text = kind === 'total' ? t('Total solar eclipse')
        : kind === 'annular' ? t('Annular solar eclipse, {pct}% of the Sun covered', { pct }) : t('Partial solar eclipse, {pct}% of the Sun covered', { pct });
    return { kind, covered, pct, text, geo };
}

/**
 * Topocentric Sun and Moon discs: separation, radii (arcsec) and the Moon's position angle from
 * the Sun's centre on the observer's sky (0 = up toward the zenith, 90° = toward the right when
 * facing the Sun), or null without directions and sizes. Both `dirS` are astrometric (the Moon's
 * is aberration-matched in the snapshot), so the separation is the apparent one.
 * @param {any} snap
 */
export function solarDiscGeometry(snap) {
    const bodies = snap?.bodies;
    const sun = bodies?.find?.((b) => b.id === 'sun');
    const moon = bodies?.find?.((b) => b.id === 'moon');
    const a = sun?.dirS, m = moon?.dirS, up = snap?.observer?.upS;
    if (!a || !m || !(sun.angDiamArcsec > 0) || !(moon.angDiamArcsec > 0)) return null;
    const cx = a[1] * m[2] - a[2] * m[1], cy = a[2] * m[0] - a[0] * m[2], cz = a[0] * m[1] - a[1] * m[0];
    const dot = a[0] * m[0] + a[1] * m[1] + a[2] * m[2];
    const sep = Math.atan2(Math.hypot(cx, cy, cz), dot) * 206264.806;
    let pa = 0;
    if (up) {
        // Screen axes at the Sun: "up" is the zenith projected on the sky plane, "right" = sun × up.
        const k = up[0] * a[0] + up[1] * a[1] + up[2] * a[2];
        const ux = up[0] - k * a[0], uy = up[1] - k * a[1], uz = up[2] - k * a[2];
        const rx = a[1] * uz - a[2] * uy, ry = a[2] * ux - a[0] * uz, rz = a[0] * uy - a[1] * ux;
        const dx = m[0] - dot * a[0], dy = m[1] - dot * a[1], dz = m[2] - dot * a[2];
        pa = Math.atan2(dx * rx + dy * ry + dz * rz, dx * ux + dy * uy + dz * uz);
    }
    return { sep, rS: sun.angDiamArcsec / 2, rM: moon.angDiamArcsec / 2, pa };
}

/**
 * The magnitude worth showing, or null: Astronomy Engine's lunar model still returns about −4
 * for a 0 %-lit new Moon, which is not visible at all.
 * @param {any} b BodyState
 * @returns {number|null}
 */
export function shownMag(b) {
    if (!Number.isFinite(b?.mag)) return null;
    if (b.id === 'moon' && Number.isFinite(b.phaseFrac) && b.phaseFrac < 0.005) return null;
    return b.mag;
}
