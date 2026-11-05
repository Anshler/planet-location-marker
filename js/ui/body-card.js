/**
 * Details tab: the selected body's card (docs/roadmap/UI-REDESIGN.md §4.8). The name, phase disc
 * and kind; the verdict once (badge and tonight's best moment); the action row, never more than
 * four: Look at it · Telescope and Follow (aria-pressed) · More (Turn the globe toward it, View the
 * Earth from {name}, Earthrise, Compare…; text mode keeps Compare alone, as a button). Then a
 * satellite's passes, the position sentence (the one place the constellation is named), 'find
 * it' in hands at arm's length (astro/sky-guide.js), the light time, the facts, More positions,
 * What these numbers mean, the Display switches under "Show on the view", the eyepiece
 * (ui/eyepiece.js) and The year ahead (ui/year-planner.js). Without a selection: the nine bodies
 * and "Search for a star, comet or spacecraft".
 *
 * An extra object (core/selection.js `comet:halley`, `star:32349`, …) gets the same card from its
 * provider's ExtraCard (astro/extras.js; ctx.extras).
 *
 * @module ui/body-card
 */

import { BODIES, BODY_INDEX, AU_KM, hostBodies } from '../astro/bodies.js';
import { h, on, setText, setAttr, menu, switchRow } from './dom.js';
import { icon } from './icons.js';
import { moonPhaseName, isUp, lunarEclipseState, solarEclipseState, shownMag } from './sky-now.js';
import { createEyepiece } from './eyepiece.js';
import { createYearPlanner } from './year-planner.js';
import { findIt, guideRefs } from '../astro/sky-guide.js';
import { isExtraId } from '../core/selection.js';
import { extraSky } from '../astro/extras.js';
import { createPassBox } from './sat-passes.js';
import { LAYER_GROUPS } from './layers.js';
import { t, N_, dec } from '../core/i18n.js';

const SYNODIC_DAYS = 29.530589;

const VERDICT = {
    excellent: [N_('Excellent tonight'), 'ok'],
    good: [N_('Good tonight'), 'accent'],
    low: [N_('Low tonight'), 'warn'],
    twilight: [N_('Only in twilight'), 'warn'],
    daytime: [N_('Daytime only'), 'muted'],
    'not-visible': [N_('Not visible tonight'), 'muted'],
};
/** The kind under the name (a 'Moon' kind would read as the Moon's own name in Vietnamese). */
const KIND_LABEL = { star: N_('Star'), moon: N_('Natural satellite'), planet: N_('Planet') };
/** "What these numbers mean": every term the card uses, as whole sentences (R6; no title= hints). */
const MEANINGS = [
    [N_('Altitude'), N_('How high it stands above the horizon, as seen: atmospheric refraction lifts it a little.')],
    [N_('Azimuth'), N_('Its compass direction, measured from north through east.')],
    [N_('Rise · Transit · Set'), N_('Times for your local day. Transit is when it stands highest, due south or due north.')],
    [N_('Magnitude'), N_('Brightness: lower is brighter. The faintest stars the eye can see are about 6.')],
    [N_('Angle from the Sun (elongation)'), N_('How far from the Sun it appears in the sky; close to the Sun it is lost in the glare.')],
    [N_('Sky coordinates (J2000)'), N_('Right ascension and declination (RA/Dec), astrometric, on the mean equator and equinox of J2000.')],
    [N_('Sky coordinates (of date)'), N_('RA/Dec, apparent, on the true equator and equinox of the date.')],
    [N_('Overhead point'), N_('The place on the Earth where it is straight overhead (the sub-point).')],
    [N_('Find it'), N_('Held at arm’s length, a fist covers about 10° of sky and a finger about 1°. Hands differ, so this is approximate.')],
];
const layerLabel = (key) => t(LAYER_GROUPS.flatMap((g) => g.items).find((it) => it[0] === key)?.[1] ?? key);
const EQUIPMENT = { 'naked-eye': N_('naked eye'), binoculars: N_('binoculars'), telescope: N_('telescope') };

/**
 * Where it stands, one sentence: 'Mars is 34° above the south-east horizon, in Leo.'
 * @param {string} name the subject ('The Moon', 'Sirius')
 * @param {boolean} up
 * @param {number} alt
 * @param {string} dir compass words
 * @param {string} con constellation (IAU Latin) or ''
 */
function positionText(name, up, alt, dir, con) {
    const v = { body: name, deg: up ? Math.max(0, Math.round(alt)) : Math.abs(Math.round(alt)), dir, con };
    if (up && alt >= 80) return con ? t('{body} is nearly overhead ({deg}°), in {con}.', v) : t('{body} is nearly overhead ({deg}°).', v);
    if (up) return con ? t('{body} is {deg}° above the {dir} horizon, in {con}.', v) : t('{body} is {deg}° above the {dir} horizon.', v);
    return con ? t('{body} is {deg}° below the {dir} horizon, in {con}.', v) : t('{body} is {deg}° below the {dir} horizon.', v);
}

/**
 * Mounts the Details tab.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void}}
 */
export function mountBodyCard(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];

    // ---------------------------------------------------------------- empty state
    const pickGrid = h('div', { class: 'pick-grid', role: 'group', 'aria-label': t('Choose a body') },
        BODIES.map((b) => h('button', {
            class: 'bchip bchip--pick', type: 'button', 'data-id': b.id, style: { '--c': `var(--body-${b.id})` },
        }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'bchip__name' }, t(b.name)),
        h('kbd', { class: 'kbd kbd--ghost', 'aria-hidden': 'true' }, b.key))));
    const findBtn = h('button', { class: 'btn btn--soft', type: 'button' }, icon('search', { size: 16 }), t('Search for a star, comet or spacecraft'));
    const empty = h('div', { class: 'card-empty' },
        h('div', { class: 'card-empty__icon', 'aria-hidden': 'true' }, icon('target', { size: 28 })),
        h('h3', { class: 'card-empty__title' }, t('Pick a body')),
        h('p', { class: 'card-empty__text for-fine for-3d' }, t('Click a planet in the sky, a row in Up now, or press 1–9.')),
        h('p', { class: 'card-empty__text for-coarse for-3d' }, t('Tap a world at the end of its beam, a row in Up now, or a name below.')),
        h('p', { class: 'card-empty__text for-text' }, t('Choose a row in Up now or a name below.')),
        pickGrid, findBtn);
    offs.push(on(pickGrid, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-id]');
        if (b) ui.act('select', b.dataset.id, { fly: true });
    }));
    offs.push(on(findBtn, 'click', () => ui.openPalette()));

    // ---------------------------------------------------------------- card
    const disc = h('canvas', { class: 'phase-disc', width: 64, height: 64, role: 'img', 'aria-label': '' });
    const nameEl = h('h3', { class: 'card__name' });
    const kindEl = h('p', { class: 'card__kind' });
    const verdictBadge = h('span', { class: 'badge' });
    const verdictText = h('span');
    const verdict = h('p', { class: 'card__verdict', hidden: true }, verdictBadge, ' ', verdictText);
    const sentence = h('p', { class: 'card__sentence' });
    const lightText = h('span');
    const lightAgo = h('span', { class: 'card__light-ago' });
    const light = h('p', { class: 'card__light' }, icon('sparkle', { size: 14 }), h('span', null, lightText, ' ', lightAgo));
    const moonLine = h('p', { class: 'card__moon', hidden: true });
    const findText = h('span');
    const findLine = h('p', { class: 'card__find', hidden: true }, icon('ruler', { size: 14 }),
        h('span', null, h('span', { class: 'card__find-label' }, `${t('Find it')}: `), findText));
    const eyepiece = createEyepiece();
    const scopeGroup = h('div', { class: 'group' }, h('h4', { class: 'group-title' }, t('Through a small telescope')), eyepiece.el);
    const planner = createYearPlanner(ctx);
    const passBox = createPassBox(ctx);

    const actLook = h('button', { class: 'btn btn--soft btn--accent', type: 'button' }, t('Look at it'));
    const toggleBtn = (name, label, tip) => h('button', { class: 'btn btn--soft btn--toggle', type: 'button', 'aria-pressed': 'false', 'data-tip': tip },
        icon(name, { size: 16 }), icon('check', { size: 16 }), label);
    const actScope = toggleBtn('eye', t('Telescope'), t('Its true size and orientation, followed'));
    const actTrack = toggleBtn('crosshair', t('Follow'), t('Keep it centred as time runs (K)'));
    const actMore = h('button', { class: 'btn btn--soft card__more', type: 'button', 'aria-label': t('More actions'), 'data-tip': t('More actions') }, icon('more', { size: 16 }));
    // Text mode: no camera, so Compare alone, as a button.
    const actCompare = h('button', { class: 'btn btn--soft', type: 'button' }, icon('compare', { size: 16 }), t('Compare from a second place…'));
    const actions = h('div', { class: 'card__actions' }, actLook, actScope, actTrack, actMore, actCompare);

    const sel = () => store.get().selection;
    const mode = () => {
        const st = store.get();
        return st.status?.webgl === false ? 'text' : st.view?.mode === 'sky' ? 'sky' : st.view?.system ? 'system' : 'globe';
    };
    /** Who the "Earth from" item names: "the Sun", "the Moon", "Mars". */
    const fromName = () => { const id = sel(); return id === 'sun' || id === 'moon' ? ui.bodySubject(id, false) : ui.bodyName(id); };
    const moreItems = [
        { icon: 'target', name: t('Turn the globe toward it'), detail: t('Bring the side where it is overhead to the front'), hidden: () => mode() !== 'globe', run: () => ui.act('flyToBody', sel()) },
        { icon: 'globe', name: () => t('View the Earth from {body}', { body: fromName() }), detail: t('The side of the Earth that faces it'),
            hidden: () => mode() !== 'globe' || isExtraId(sel()) || ui.onMars?.(), run: () => ui.act('viewFromBody', sel()) },
        { kind: 'check', icon: 'vantage', name: t('Earthrise'), detail: t('The Earth rising over the Moon’s limb, from lunar orbit'), checked: () => store.get().view?.vantage === 'moon',
            hidden: () => mode() !== 'globe' || sel() !== 'moon' || ui.onMars?.(), run: () => ui.act('setVantage', store.get().view?.vantage === 'moon' ? 'none' : 'moon') },
        { icon: 'compare', name: t('Compare from a second place…'), detail: t('Its own pin and beams, side by side in Up now'),
            hidden: () => isExtraId(sel()) || ui.onMars?.(), run: () => ui.act('compareWith') },
    ];
    const moreMenu = menu({ button: actMore, label: t('More actions'), items: moreItems, host: ui.root, placement: 'bottom' });

    // The Display switches themselves (R1's documented exception).
    const swPath = switchRow({ label: layerLabel('trails'), keys: ['T'], checked: false, onChange: (v) => ui.act('toggleLayer', 'trails', v) });
    const swFoot = switchRow({ label: layerLabel('footprint'), keys: ['O'], checked: false, onChange: (v) => ui.act('toggleLayer', 'footprint', v) });
    const swSun = switchRow({ label: layerLabel('sunPath'), checked: false, onChange: (v) => ui.act('toggleLayer', 'sunPath', v) });
    const showGroup = h('div', { class: 'group' }, h('h4', { class: 'group-title' }, t('Show on the view')), swPath.el, swFoot.el, swSun.el);

    const facts = {};
    const fact = (key, label, wide = false) => {
        const dd = h('dd', { class: 'fact__value' });
        const el = h('div', { class: `fact${wide ? ' fact--wide' : ''}` }, h('dt', { class: 'fact__label' }, label), dd);
        facts[key] = { el, dd };
        return el;
    };
    const grid = h('dl', { class: 'facts' },
        fact('alt', t('Altitude')), fact('az', t('Azimuth')), fact('rts', t('Rise · Transit · Set'), true), fact('dist', t('Distance'), true),
        fact('mag', t('Magnitude')), fact('phase', t('Phase')), fact('size', t('Angular size')));
    const morePos = h('details', { class: 'fold' }, h('summary', null, t('More positions')), h('dl', { class: 'facts' },
        fact('elong', t('Angle from the Sun (elongation)'), true), fact('j2000', t('Sky coordinates (J2000)'), true),
        fact('date', t('Sky coordinates (of date)'), true), fact('sub', t('Overhead point'), true)));
    const meaning = h('details', { class: 'fold' }, h('summary', null, t('What these numbers mean')), h('dl', { class: 'meanings note' },
        ...MEANINGS.flatMap(([k, v]) => [h('dt', null, t(k)), h('dd', null, t(v))])));
    // Extra objects: the provider's sentences, extra facts, honesty note and sources.
    const xLines = h('div', { class: 'card__xlines', hidden: true });
    const xFacts = h('dl', { class: 'facts facts--extra' });
    const xCaveat = h('p', { class: 'note card__caveat' });
    const xSources = h('p', { class: 'note card__sources' });
    const xBox = h('div', { class: 'card__extra', hidden: true }, xFacts, xCaveat, xSources);
    const tableNote = h('p', { class: 'note' }, t('Tables show apparent, refracted values; the 3D view draws astrometric J2000 directions.'));

    // Rise · Transit · Set as three labelled cells (a day's set can come before its rise).
    const rtsCell = (iconName, label) => {
        const time = h('span', { class: 'rts__time' }, '—');
        const extra = h('span', { class: 'rts__extra' });
        const el = h('span', { class: 'rts__cell' }, h('span', { class: 'rts__label' }, icon(iconName, { size: 14 }), label), time, extra);
        return { el, time, extra };
    };
    const rtsRise = rtsCell('rise', t('Rise'));
    const rtsTransit = rtsCell('arrow', t('Transit'));
    const rtsSet = rtsCell('set', t('Set'));
    const rtsMsg = h('span', { class: 'rts__msg', hidden: true });
    facts.rts.dd.append(h('span', { class: 'rts' }, rtsRise.el, rtsTransit.el, rtsSet.el), rtsMsg);

    const card = h('article', { class: 'card', 'aria-live': 'off' },
        h('header', { class: 'card__head' }, h('div', { class: 'card__disc' }, disc), h('div', { class: 'card__titles' }, nameEl, kindEl)),
        verdict, actions, passBox.el, sentence, findLine, light, moonLine, xLines, grid, xBox, morePos, meaning,
        showGroup, scopeGroup, planner.el, tableNote);

    root.append(empty, card);

    offs.push(on(actLook, 'click', () => {
        const id = sel();
        if (!id) return;
        if (mode() === 'sky') ui.act('select', id, { fly: true });
        else { ui.act('select', id, { fly: false }); ui.act('setViewMode', 'sky'); }
    }));
    offs.push(on(actScope, 'click', () => {
        const id = sel();
        if (!id) return;
        if (store.get().ui?.scope?.id === id) ui.act('leaveTelescope'); else ui.act('telescope', id);
    }));
    offs.push(on(actTrack, 'click', () => ui.act('setTracking', store.get().view?.track === 'body' ? 'none' : 'body')));
    offs.push(on(actCompare, 'click', () => ui.act('compareWith')));

    // ---------------------------------------------------------------- rendering
    let shownId = null;
    let shownExtraName = '';
    let discKey = '';

    /** The card for an extra object: what the nine's card has, minus the disc-only parts. */
    function showExtra(id) {
        const m = ctx.extras?.meta?.(id) ?? null;
        // Same object, same name (a star's name arrives with data/starinfo.json): nothing to redo.
        if (id === shownId && (m?.name ?? id) === shownExtraName) return;
        shownId = id;
        shownExtraName = m?.name ?? id;
        card.style.setProperty('--c', m?.color ?? 'var(--accent)');
        nameEl.replaceChildren(h('span', { class: 'dot dot--lg', 'aria-hidden': 'true' }), m?.name ? t(m.name) : id);
        drawExtraGlyph(disc, m?.color ?? '#cfe0ff', m?.kind ?? '');
        disc.setAttribute('aria-label', t(m?.kindLabel ?? ''));
        xBox.hidden = false;
        xLines.hidden = false;
        for (const k of ['phase', 'elong', 'size', 'date', 'sub']) facts[k].el.hidden = true;
        verdict.hidden = true;
        moonLine.hidden = true;
        eyepiece.el.hidden = true;
        scopeGroup.hidden = true;
        discKey = '';
    }

    function showFor(id) {
        const extra = isExtraId(id);
        const has = !!id && (id in BODY_INDEX || extra);
        empty.hidden = has;
        card.hidden = !has;
        card.classList.toggle('card--extra', extra);
        if (!has) { shownId = null; return; }
        if (extra) { showExtra(id); return; }
        // Standing on Mars slot 4 is the Earth (astro/bodies.js hostBodies): the key carries the host.
        const mars = !!ui.onMars?.();
        const key = mars ? `${id}@mars` : id;
        if (key !== shownId) {
            shownId = key;
            xBox.hidden = true;
            xLines.hidden = true;
            passBox.update(null, null);
            eyepiece.el.hidden = false;
            for (const k of ['phase', 'elong', 'size', 'date', 'sub']) facts[k].el.hidden = false;
            // No sub-points from Mars (they are places on the Earth).
            facts.sub.el.hidden = mars;
            const b = hostBodies(mars ? 'mars' : 'earth')[BODY_INDEX[id]];
            card.style.setProperty('--c', `var(--body-${id})`);
            nameEl.replaceChildren(h('span', { class: 'dot dot--lg', 'aria-hidden': 'true' }), t(b.name));
            discKey = '';
        }
    }

    /** The action row and the switches, for the view, the body and the host. */
    function syncLayerButtons() {
        const st = store.get();
        const ly = st.layers || {};
        const id = sel();
        const m = mode();
        const text = m === 'text';
        const extra = isExtraId(id);
        // On Mars the globe-side tools have no globe: footprint, compare, Earthrise, paths.
        const mars = !!ui.onMars?.();
        actLook.hidden = actScope.hidden = actMore.hidden = text;
        actTrack.hidden = m !== 'sky';
        actCompare.hidden = !text || extra || mars;
        // More holds nothing for an extra object in Sky view: no button then.
        if (!text) actMore.hidden = !moreItems.some((it) => !it.hidden());
        setAttr(actScope, 'aria-pressed', String(!!id && st.ui?.scope?.id === id));
        setAttr(actTrack, 'aria-pressed', String(m === 'sky' && st.view?.track === 'body'));
        const kind = id in BODY_INDEX ? BODIES[BODY_INDEX[id]].kind : '';
        swPath.el.hidden = text || mars || (kind !== 'planet' && id !== 'moon');
        swFoot.el.hidden = mars || extra || m !== 'globe';
        swSun.el.hidden = text || id !== 'sun';
        showGroup.hidden = swPath.el.hidden && swFoot.el.hidden && swSun.el.hidden;
        swPath.set(!!ly.trails);
        swFoot.set(!!ly.footprint);
        swSun.set(!!ly.sunPath);
    }

    /** An extra object's card (4 Hz): position, find it, the provider's ExtraCard. */
    function updateExtra(snap, id) {
        const m = ctx.extras?.meta?.(id) ?? null;
        const st = ui.bodyOf(snap, id);
        const info = st ? ctx.extras?.card?.(id, snap) ?? null : null;
        const name = m?.name ? t(m.name) : id;
        passBox.update(id, snap);
        if (!st) {
            setText(kindEl, m ? t(m.kindLabel || '') : t('Loading…'));
            const mars = !!ui.onMars?.();
            setText(sentence, !m ? t('Its data is still loading.') : m.kind === 'sat' && mars
                ? t('Earth satellites are seen from the Earth: use Back to Earth to follow {name}.', { name })
                : m.kind === 'sat'
                    ? t('{name} is not shown at this date: its orbital elements are only used {n} days either side of their own date.', { name, n: ctx.extras?.provider?.('sat')?.validDays ?? 14 })
                    : m.kind === 'moon' && !mars ? t('{name} is seen from Mars: Stand on Mars to see it.', { name })
                        : t('{name} is not in the sky at this date.', { name }));
            findLine.hidden = true;
            light.hidden = true;
            morePos.hidden = true;
            xLines.replaceChildren();
            xFacts.replaceChildren();
            setText(xCaveat, '');
            setText(xSources, '');
            grid.hidden = true;
            syncLayerButtons();
            return;
        }
        grid.hidden = false;
        morePos.hidden = false;
        const sky = extraSky(st);
        const con = sky.constellation?.name || '';
        setText(kindEl, info?.kindLabel || t(m?.kindLabel || ''));
        const { alt, az } = ui.altAz(st);
        let sent = Number.isFinite(alt) ? positionText(name, !!st.above, alt, ui.compassWords(az), con) : '';
        if (info?.subtitle) sent = `${info.subtitle}. ${sent}`;
        setText(sentence, sent);
        // A catalogue star is not its own signpost: by identity (the guide's J2000 places do not
        // follow proper motion, so far from 2000 its own ghost is not where it is), and by place.
        const selfHip = id.startsWith('star:') ? Number(id.slice(5)) : NaN;
        const notSelf = (r) => r.hip !== selfHip && (Math.abs(r.altDeg - alt) > 0.3 || Math.abs(((r.azDeg - az + 540) % 360) - 180) * Math.cos(alt * Math.PI / 180) > 0.3);
        const guide = st.above && Number.isFinite(alt) && Number.isFinite(st.mag) && st.mag < 6
            ? findIt({ azDeg: az, altDeg: alt, mag: st.mag }, guideRefs(snap, null).filter(notSelf)) : null;
        if (guide) setText(findText, lowerFirst(guide.text));
        findLine.hidden = !guide;
        light.hidden = true;
        xLines.replaceChildren(...(info?.lines ?? []).map((line) => h('p', { class: 'card__xline' }, line)));
        xFacts.replaceChildren(...(info?.facts ?? []).map(([k, v]) => h('div', { class: 'fact fact--wide' },
            h('dt', { class: 'fact__label' }, k), h('dd', { class: 'fact__value' }, v))));
        setText(xCaveat, info?.caveat ?? '');
        xCaveat.hidden = !info?.caveat;
        setText(xSources, info?.sources?.length ? t('Sources: {list}.', { list: info.sources.join('; ') }) : '');
        xSources.hidden = !info?.sources?.length;
        setText(facts.alt.dd, Number.isFinite(alt) ? ui.fmt('fmtAlt', alt) : '—');
        setText(facts.az.dd, Number.isFinite(az) ? ui.fmt('fmtAz', az) : '—');
        const rts = info?.rts ?? null;
        facts.rts.el.hidden = !rts;
        if (rts) {
            rtsMsg.hidden = true;
            facts.rts.dd.firstChild.hidden = false;
            setText(rtsRise.time, rts.riseMs != null ? ui.fmtClock(rts.riseMs) : '—');
            setText(rtsSet.time, rts.setMs != null ? ui.fmtClock(rts.setMs) : '—');
            setText(rtsTransit.time, rts.transitMs != null ? ui.fmtClock(rts.transitMs) : '—');
            setText(rtsTransit.extra, rts.transitAltDeg != null && rts.transitMs != null ? t('{deg}° high', { deg: Math.round(rts.transitAltDeg) }) : '');
        }
        // The provider's own 'Distance' (with km) replaces the generic one.
        facts.dist.el.hidden = !Number.isFinite(st.distAU) || !!info?.facts?.some(([k]) => k === 'Distance' || k === t('Distance'));
        if (Number.isFinite(st.distAU)) setText(facts.dist.dd, ui.fmt('fmtDistAU', st.distAU));
        facts.mag.el.hidden = !Number.isFinite(st.mag);
        if (Number.isFinite(st.mag)) setText(facts.mag.dd, st.approx ? t('{mag} (approx.)', { mag: ui.fmt('fmtMag', st.mag) }) : ui.fmt('fmtMag', st.mag));
        setText(facts.j2000.dd, `${ui.fmt('fmtRA', sky.raH)} / ${ui.fmt('fmtDec', sky.decDeg)}`);
        syncLayerButtons();
    }

    function update(snap) {
        const id = sel();
        showFor(id);
        if (id && isExtraId(id) && snap) { updateExtra(snap, id); return; }
        if (!id || !snap?.bodies) return;
        grid.hidden = false;
        morePos.hidden = false;
        facts.rts.el.hidden = false;
        facts.dist.el.hidden = false;
        facts.mag.el.hidden = false;
        const b = ui.bodyOf(snap, id);
        if (!b) return;
        const info = hostBodies(snap.host)[BODY_INDEX[id]];
        const now = snap.tMs;
        const { alt, az } = ui.altAz(b);
        const up = isUp(b, alt);
        const con = b.constellation?.name || '';
        const subject = ui.bodySubject(id);

        setText(kindEl, KIND_LABEL[info.kind] ? t(KIND_LABEL[info.kind]) : '');

        // Position sentence.
        setText(sentence, Number.isFinite(alt) ? positionText(subject, up, alt, ui.compassWords(az), con) : '');

        // Find it: which way to face, how many fists up, and from the nearest bright neighbour.
        // Never for the Sun (nobody should look for it by eye).
        const guide = up && id !== 'sun' && Number.isFinite(alt)
            ? findIt({ azDeg: az, altDeg: alt, mag: id === 'moon' ? -10 : b.mag }, guideRefs(snap, id)) : null;
        if (guide) setText(findText, lowerFirst(guide.text));
        findLine.hidden = !guide;

        // Light-time sentence.
        if (Number.isFinite(b.lightTimeS)) {
            setText(lightText, t('The light you see from {body} left {time} ago.', { body: ui.bodySubject(id, false), time: ui.fmt('fmtLightTime', b.lightTimeS) }));
            setText(lightAgo, b.lightTimeS >= 60 ? t('It set out at {time}.', { time: ui.fmtClock(now - b.lightTimeS * 1000, { seconds: true }) }) : '');
            light.hidden = false;
        } else light.hidden = true;

        // Moon extras (the Earth's: from Mars its phase name and age would contradict the lit fraction).
        if (id === 'moon' && snap.host !== 'mars' && Number.isFinite(snap.moonPhaseDeg)) {
            const age = ((((snap.moonPhaseDeg % 360) + 360) % 360) / 360) * SYNODIC_DAYS;
            const ecl = lunarEclipseState(snap);
            const sol = solarEclipseState(snap);
            const eclTxt = ecl ? ` · ${ecl.text}` : !sol ? '' : ` · ${sol.kind === 'total' ? t('in front of the Sun (total solar eclipse)')
                : sol.kind === 'annular' ? t('in front of the Sun (annular solar eclipse)') : t('in front of the Sun (partial solar eclipse)')}`;
            setText(moonLine, t('{phase} · {age} days old', { phase: moonPhaseName(snap.moonPhaseDeg), age: dec(age, 1) }) + eclTxt);
            moonLine.hidden = false;
        } else if (id === 'sun' && solarEclipseState(snap)) {
            const sol = solarEclipseState(snap);
            setText(moonLine, sol.kind === 'total' ? t('Total solar eclipse: the Moon hides the whole Sun.')
                : sol.kind === 'annular' ? t('{eclipse}: a ring of Sun around the Moon.', { eclipse: sol.text }) : `${sol.text}.`);
            moonLine.hidden = false;
        } else moonLine.hidden = true;

        const rep = id === 'sun' ? null : ui.tonightFor(id);
        if (rep && VERDICT[rep.verdict]) {
            const [label, tone] = VERDICT[rep.verdict];
            setText(verdictBadge, t(label));
            verdictBadge.className = `badge badge--${tone}`;
            const bits = [];
            if (Number.isFinite(rep.bestMs) && rep.verdict !== 'not-visible' && rep.verdict !== 'daytime') {
                const v = { time: Math.abs(rep.bestMs - now) < 864e5 ? ui.fmtClock(rep.bestMs) : ui.fmtWhen(rep.bestMs, now), deg: Math.round(rep.bestAltDeg), dir: ui.compassWords(rep.bestAzDeg) };
                bits.push(!Number.isFinite(rep.bestAltDeg) ? t('best around {time}', v)
                    : Number.isFinite(rep.bestAzDeg) ? t('best around {time}, {deg}° high in the {dir}', v) : t('best around {time}, {deg}° high', v));
            }
            if (Number.isFinite(rep.windowStartMs) && Number.isFinite(rep.windowEndMs) && rep.windowEndMs > rep.windowStartMs) {
                bits.push(t('visible {from}–{to}', { from: ui.fmtClock(rep.windowStartMs), to: ui.fmtClock(rep.windowEndMs) }));
            }
            if (rep.equipment && EQUIPMENT[rep.equipment] && rep.verdict !== 'not-visible') bits.push(t(EQUIPMENT[rep.equipment]));
            setText(verdictText, bits.join(' · '));
            verdict.hidden = false;
        } else verdict.hidden = true;

        // Facts.
        setText(facts.alt.dd, Number.isFinite(alt) ? ui.fmt('fmtAlt', alt) : '—');
        setText(facts.az.dd, Number.isFinite(az) ? ui.fmt('fmtAz', az) : '—');
        renderRts(id, now);
        if (id === 'moon') {
            setText(facts.dist.dd, Number.isFinite(b.distAU) ? t('{km} · {n} Earth radii', { km: ui.fmt('fmtDistKm', b.distAU * AU_KM), n: dec(b.distER || b.distAU * AU_KM / 6378.137, 1) }) : '—');
        } else {
            setText(facts.dist.dd, Number.isFinite(b.distAU) ? ui.fmt('fmtDistAU', b.distAU) : '—');
        }
        setText(facts.mag.dd, shownMag(b) !== null ? ui.fmt('fmtMag', b.mag) : '—');
        const isSun = id === 'sun';
        facts.phase.el.hidden = isSun;
        facts.elong.el.hidden = isSun;
        if (!isSun) {
            const ecl = id === 'moon' ? lunarEclipseState(snap) : null;
            const pv = { pct: Math.round(b.phaseFrac * 100), sunlit: Math.round((ecl?.sunlit ?? 1) * 100) };
            setText(facts.phase.dd, !Number.isFinite(b.phaseFrac) ? '—' : !ecl ? t('{pct}% lit', pv)
                : ecl.total ? t('{pct}% lit · totally eclipsed', pv) : t('{pct}% lit · {sunlit}% sunlit', pv));
            const ev = { deg: dec(b.elongDeg, 1) };
            setText(facts.elong.dd, !Number.isFinite(b.elongDeg) ? '—' : b.elongSide === 'morning' ? t('{deg}° · morning sky', ev)
                : b.elongSide === 'evening' ? t('{deg}° · evening sky', ev) : `${ev.deg}°`);
        }
        const size = ui.fmt('fmtAngSize', b.angDiamArcsec);
        setText(facts.size.dd, size !== '—' ? size : angSize(b.angDiamArcsec));
        setText(facts.j2000.dd, Number.isFinite(b.raJ2000H) ? `${ui.fmt('fmtRA', b.raJ2000H)} / ${ui.fmt('fmtDec', b.decJ2000Deg)}` : '—');
        setText(facts.date.dd, Number.isFinite(b.raDateH) ? `${ui.fmt('fmtRA', b.raDateH)} / ${ui.fmt('fmtDec', b.decDateDeg)}` : '—');
        setText(facts.sub.dd, Number.isFinite(b.subLatDeg) ? ui.latLonText(b.subLatDeg, b.subLonDeg, 2, ', ') : '—');

        // Phase disc.
        const obsLat = snap.observer?.latDeg ?? store.get().observer?.latDeg ?? 0;
        let evening = b.elongSide === 'evening';
        if (id === 'moon' && Number.isFinite(snap.moonPhaseDeg)) evening = (((snap.moonPhaseDeg % 360) + 360) % 360) < 180;
        const litRight = evening !== (obsLat < 0);
        const frac = isSun ? 1 : (Number.isFinite(b.phaseFrac) ? b.phaseFrac : 1);
        // A lunar eclipse turns the thumbnail copper as the direct sunlight goes; in a solar
        // eclipse the Sun's thumbnail shows the Moon's disc in front of it.
        const shadow = id === 'moon' ? 1 - (lunarEclipseState(snap)?.sunlit ?? 1) : 0;
        const sol = isSun ? solarEclipseState(snap) : null;
        const cover = sol?.geo ? { d: sol.geo.sep / sol.geo.rS, r: sol.geo.rM / sol.geo.rS, pa: sol.geo.pa } : null;
        const key = `${id}|${frac.toFixed(3)}|${litRight}|${shadow.toFixed(2)}|${cover ? `${cover.d.toFixed(2)},${cover.r.toFixed(3)},${cover.pa.toFixed(2)}` : ''}`;
        if (key !== discKey) {
            discKey = key;
            drawPhaseDisc(disc, { frac, litRight, color: info.color, sun: isSun, moon: id === 'moon', shadow, cover });
            disc.setAttribute('aria-label', isSun
                ? (!sol ? t('The Sun’s disc') : sol.kind === 'total' ? t('The Sun’s disc, hidden by the Moon') : t('The Sun’s disc, {pct}% covered by the Moon', { pct: sol.pct }))
                : litRight ? t('{body}: {pct}% of the disc lit, lit side right', { body: t(info.name), pct: Math.round(frac * 100) })
                    : t('{body}: {pct}% of the disc lit, lit side left', { body: t(info.name), pct: Math.round(frac * 100) }));
        }
        // From Mars: no eyepiece portrait of the Earth (slot 4 draws Mars's maps) or of the Moon (its
        // libration is the Earth's view), and no year planner (the astro worker plans for the Earth observer).
        const marsSky = snap.host === 'mars';
        eyepiece.el.hidden = marsSky && (id === 'mars' || id === 'moon');
        if (!eyepiece.el.hidden) eyepiece.update(snap, id);
        scopeGroup.hidden = eyepiece.el.hidden;
        if (marsSky) planner.el.hidden = true;
        else planner.update(snap, id);
        syncLayerButtons();
    }

    function renderRts(id, now) {
        const rs = ui.riseSetFor(id, now);
        const rtsBox = facts.rts.dd.firstChild;
        let msg = '';
        if (!rs.known) msg = ui.onMars?.() ? t('Rise and set times are not computed on Mars yet') : t('Computing…');
        else if (rs.status === 'circumpolar' && rs.riseMs == null && rs.setMs == null) msg = t('Up all day — it never sets here today');
        else if (rs.status === 'never' && rs.riseMs == null) msg = t('Stays below the horizon all day');
        rtsMsg.hidden = !msg;
        setText(rtsMsg, msg);
        rtsBox.hidden = !!msg && msg !== '' && rs.transitMs == null;
        setText(rtsRise.time, rs.riseMs != null ? ui.fmtClock(rs.riseMs) : '—');
        setText(rtsSet.time, rs.setMs != null ? ui.fmtClock(rs.setMs) : '—');
        setText(rtsTransit.time, rs.transitMs != null ? ui.fmtClock(rs.transitMs) : '—');
        setText(rtsTransit.extra, rs.transitAltDeg != null && rs.transitMs != null ? t('{deg}° high', { deg: Math.round(rs.transitAltDeg) }) : '');
        setText(rtsRise.extra, '');
        setText(rtsSet.extra, '');
    }

    offs.push(store.subscribe((st) => st.selection, (id) => { showFor(id); if (ui.snap) update(ui.snap); }, { immediate: true }));
    // A provider registering (its data arrived) completes an extra object's card.
    if (ctx.extras?.onChange) offs.push(ctx.extras.onChange(() => { if (isExtraId(sel())) { shownId = null; if (ui.snap) update(ui.snap); } }));
    offs.push(store.subscribe((st) => st.layers, syncLayerButtons));
    offs.push(store.subscribe((st) => st.view, syncLayerButtons));
    offs.push(store.subscribe((st) => st.status?.webgl, syncLayerButtons));
    offs.push(store.subscribe((st) => st.ui?.scope, syncLayerButtons));
    offs.push(store.subscribe((st) => st.host?.id, () => { showFor(store.get().selection); syncLayerButtons(); if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('almanac', () => { if (ui.snap && sel()) update(ui.snap); }));
    offs.push(ui.on('display', () => { if (ui.snap && sel()) update(ui.snap); }));
    syncLayerButtons();

    return {
        update,
        destroy() { offs.forEach((off) => off()); moreMenu.destroy(); eyepiece.destroy(); planner.destroy(); passBox.destroy(); root.textContent = ''; },
    };
}

function lowerFirst(s) {
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** "31′ 36″" for discs ≥ 1′, else "17.3″". */
function angSize(as) {
    if (!Number.isFinite(as) || as <= 0) return '—';
    if (as >= 60) {
        const m = Math.floor(as / 60);
        const sec = Math.round(as - m * 60);
        return sec === 60 ? `${m + 1}′ 00″` : `${m}′ ${String(sec).padStart(2, '0')}″`;
    }
    return `${dec(as, 1)}″`;
}

/**
 * Draws a phase disc: dark disc, lit region bounded by the limb and the
 * terminator (an ellipse of half-width |1 − 2k|·r), limb darkening and a glow.
 * @param {HTMLCanvasElement} cv
 * @param {{frac:number, litRight:boolean, color:string, sun?:boolean, moon?:boolean, shadow?:number}} o
 *        `shadow` (0…1): the share of the Moon's direct sunlight a lunar eclipse has taken away.
 *        `cover` ({d, r, pa}): the Moon in front of the Sun — centre distance and radius in Sun
 *        radii, position angle in radians from screen-up toward the right.
 */
export function drawPhaseDisc(cv, { frac, litRight, color, sun = false, moon = false, shadow = 0, cover = null }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = 64;
    if (cv.width !== S * dpr) { cv.width = S * dpr; cv.height = S * dpr; cv.style.width = `${S}px`; cv.style.height = `${S}px`; }
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);
    const cx = S / 2, cy = S / 2, r = 21;
    const rgb = hexRgb(color);
    // Glow.
    const glow = c.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.5);
    glow.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${sun ? 0.45 : 0.16 * Math.max(0.25, frac)})`);
    glow.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    c.fillStyle = glow;
    c.fillRect(0, 0, S, S);
    if (sun) {
        const g = c.createRadialGradient(cx - 4, cy - 4, 2, cx, cy, r);
        g.addColorStop(0, '#fffdf2');
        g.addColorStop(0.55, '#ffe9a8');
        g.addColorStop(1, '#ffc24d');
        c.fillStyle = g;
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
        if (cover && Number.isFinite(cover.d) && Number.isFinite(cover.r) && cover.d < 1 + cover.r) {
            const mx = cx + Math.sin(cover.pa || 0) * cover.d * r, my = cy - Math.cos(cover.pa || 0) * cover.d * r;
            c.fillStyle = '#0b0f18';
            c.beginPath(); c.arc(mx, my, cover.r * r, 0, Math.PI * 2); c.fill();
        }
        return;
    }
    // Night side (with a hint of earthshine for the Moon).
    c.fillStyle = moon ? '#1d2330' : '#131824';
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.lineWidth = 1;
    c.stroke();
    const k = Math.min(1, Math.max(0, frac));
    if (k < 0.004) return;
    const sgn = litRight ? 1 : -1;
    const N = 48;
    c.beginPath();
    for (let i = 0; i <= N; i += 1) {           // limb, top → bottom
        const y = -r + (2 * r * i) / N;
        const w = Math.sqrt(Math.max(0, r * r - y * y));
        c.lineTo(cx + sgn * w, cy + y);
    }
    for (let i = N; i >= 0; i -= 1) {           // terminator, bottom → top
        const y = -r + (2 * r * i) / N;
        const w = Math.sqrt(Math.max(0, r * r - y * y));
        c.lineTo(cx + sgn * (1 - 2 * k) * w, cy + y);
    }
    c.closePath();
    const lit = c.createRadialGradient(cx + sgn * r * 0.35, cy - r * 0.25, r * 0.1, cx, cy, r * 1.05);
    const sh = Math.min(1, Math.max(0, Number(shadow) || 0));
    const hi = moon ? mixRgb([236, 240, 246], [168, 74, 40], sh) : mixRgb(rgb, [255, 255, 255], 0.35);
    const lo = moon ? mixRgb([150, 156, 168], [72, 26, 14], sh) : mixRgb(rgb, [40, 44, 56], 0.35);
    lit.addColorStop(0, `rgb(${hi[0]},${hi[1]},${hi[2]})`);
    lit.addColorStop(1, `rgb(${lo[0]},${lo[1]},${lo[2]})`);
    c.fillStyle = lit;
    c.fill();
}

/**
 * The thumbnail of an extra object: a comet's head and tail, a spacecraft's diamond, a deep-sky
 * object's smudge, or a star's glow with spikes (guest and catalogue stars).
 * @param {HTMLCanvasElement} cv
 * @param {string} color
 * @param {string} kind
 */
export function drawExtraGlyph(cv, color, kind) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = 64;
    if (cv.width !== S * dpr) { cv.width = S * dpr; cv.height = S * dpr; cv.style.width = `${S}px`; cv.style.height = `${S}px`; }
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);
    const [r, g, b] = hexRgb(color);
    const glow = (x, y, rad, a) => {
        const gr = c.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, `rgba(255,255,255,${a})`);
        gr.addColorStop(0.25, `rgba(${r},${g},${b},${a * 0.8})`);
        gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
        c.fillStyle = gr;
        c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
    };
    if (kind === 'comet') {
        const tail = c.createLinearGradient(40, 24, 8, 56);
        tail.addColorStop(0, `rgba(${r},${g},${b},0.75)`);
        tail.addColorStop(1, `rgba(${r},${g},${b},0)`);
        c.fillStyle = tail;
        c.beginPath(); c.moveTo(44, 18); c.lineTo(4, 50); c.lineTo(10, 60); c.closePath(); c.fill();
        glow(42, 22, 12, 1);
    } else if (kind === 'dso') {
        // A deep-sky object: a soft, tilted smudge with a brighter core.
        c.save();
        c.translate(32, 32);
        c.rotate(-0.6);
        c.scale(1, 0.45);
        const gr = c.createRadialGradient(0, 0, 0, 0, 0, 27);
        gr.addColorStop(0, `rgba(255,255,255,0.85)`);
        gr.addColorStop(0.18, `rgba(${r},${g},${b},0.55)`);
        gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
        c.fillStyle = gr;
        c.beginPath(); c.arc(0, 0, 27, 0, Math.PI * 2); c.fill();
        c.restore();
    } else if (kind === 'craft') {
        c.strokeStyle = `rgb(${r},${g},${b})`;
        c.lineWidth = 2.5;
        c.beginPath(); c.moveTo(32, 18); c.lineTo(46, 32); c.lineTo(32, 46); c.lineTo(18, 32); c.closePath(); c.stroke();
        c.setLineDash([3, 4]);
        c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(4, 60); c.lineTo(22, 42); c.stroke();
        c.setLineDash([]);
    } else if (kind === 'sat') {
        // A satellite: a bright body between two panels, on a dashed arc across the sky.
        c.strokeStyle = `rgba(${r},${g},${b},0.6)`;
        c.lineWidth = 1.4;
        c.setLineDash([3, 4]);
        c.beginPath(); c.arc(32, 64, 40, Math.PI * 1.15, Math.PI * 1.85); c.stroke();
        c.setLineDash([]);
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.fillRect(13, 24, 13, 8);
        c.fillRect(38, 24, 13, 8);
        glow(32, 28, 9, 1);
    } else {
        glow(32, 32, 22, 1);
        c.strokeStyle = `rgba(${r},${g},${b},0.55)`;
        c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(32, 6); c.lineTo(32, 58); c.moveTo(6, 32); c.lineTo(58, 32); c.stroke();
    }
}

function hexRgb(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [220, 220, 230];
}
function mixRgb(a, b, f) { return a.map((v, i) => Math.round(v + (b[i] - v) * f)); }
