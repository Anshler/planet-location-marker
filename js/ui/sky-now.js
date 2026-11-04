/**
 * Sky Now: one row per body — colour dot, name, a mini sky compass (needle at the
 * azimuth, dot at the polar-projected altitude), "34° · SE" or, below the horizon, a countdown
 * ("rises in 3 h 36 min"), "Rises 21:14" / "Sets 05:02", magnitude, an Up / Down badge and a
 * 24-h altitude sparkline (tonight's noon-to-noon series, ui/tonight.js). Bodies above
 * the horizon come first by altitude, then the rest by next rise. Clicking a row
 * selects the body (fly in orbit view, aim in sky view) and opens Details. The Tonight card
 * (ui/tonight.js: the dusk-to-dawn chart) sits at the top.
 *
 * This list is also the text alternative to the 3D view (and the main content
 * of text mode), so every row carries a full spoken label.
 *
 * `mountBodyStrip` renders the mobile peek strip of body chips (dot, name, alt).
 *
 * Two places (store.observer2, ROADMAP two-observers): a card above the list sets the selected body
 * (else the Moon) as seen from both side by side, altitude and azimuth, and how far apart its two
 * directions are: for the Moon, its parallax and the distance it implies (astro/parallax.js). It
 * reads `snap.second` of the readout, so it works in text mode too.
 *
 * @module ui/sky-now
 */

import { BODIES, BODY_INDEX, hostBodies } from '../astro/bodies.js';
import { marsClockText, marsSeason, marsSiteNear } from '../astro/mars-clock.js';
import { auroraText } from '../astro/geomag.js';
import { compareSight } from '../astro/parallax.js';
import { h, s, on, setText, setAttr } from './dom.js';
import { icon } from './icons.js';
import { mountTonight, drawSparkline } from './tonight.js';

const TWILIGHT_LABEL = {
    day: 'Daytime', civil: 'Civil twilight', nautical: 'Nautical twilight', astronomical: 'Astronomical twilight', night: 'Night',
};

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
function riseSetText(ui, id, up, t) {
    const rs = ui.riseSetFor(id, t);
    if (up) {
        if (rs.nextSetMs != null) return `Sets ${ui.fmtWhen(rs.nextSetMs, t)}`;
        if (rs.status === 'circumpolar') return 'Up all day';
        return '';
    }
    if (rs.nextRiseMs != null) return `Rises ${ui.fmtWhen(rs.nextRiseMs, t)}`;
    if (rs.status === 'never') return 'Stays below the horizon';
    return '';
}

/**
 * The right-hand column of a row below the horizon: how long until it rises.
 * @returns {string}
 */
export function downText(ui, rs, t) {
    if (rs.nextRiseMs != null) {
        const rel = ui.fmt('fmtRelative', rs.nextRiseMs, t);
        if (rel === 'now') return 'rising now';
        if (rel !== '—' && !rel.endsWith('ago')) return `rises ${rel}`;
    }
    return rs.status === 'never' ? 'stays down' : 'below horizon';
}

/**
 * Mounts the Sky Now list.
 * @param {HTMLElement} root tab panel
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void}}
 */
export function mountSkyNow(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];

    const status = h('span', { class: 'pill skynow__status' });
    const summary = h('p', { class: 'skynow__summary' });
    const list = h('ul', { class: 'body-list', 'aria-label': 'Bodies, above the horizon first' });
    const upHead = h('li', { class: 'body-list__group', 'aria-hidden': 'true' }, h('span', null, 'Above the horizon'), h('span', { class: 'body-list__count' }));
    const downHead = h('li', { class: 'body-list__group', 'aria-hidden': 'true' }, h('span', null, 'Below the horizon'), h('span', { class: 'body-list__count' }));
    const empty = h('p', { class: 'empty' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Computing positions…');

    // ---------------------------------------------------------------- two places
    const cmpTitle = h('h3', { class: 'compare__title' });
    const cmpShow = h('button', { class: 'btn btn--soft btn--sm', type: 'button', title: 'Frame the Earth and the Moon so both places’ beams can be seen meeting at it' },
        icon('compare', { size: 15 }), 'Show both beams');
    const cmpEdit = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': 'Change the second place', title: 'Change the second place' }, icon('search', { size: 15 }));
    const cmpRemove = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': 'Remove the second place', title: 'Remove the second place' }, icon('close', { size: 15 }));
    const cmpCol = (cls) => {
        const place = h('span', { class: 'compare__place' });
        const pos = h('span', { class: 'compare__pos' });
        const sub = h('span', { class: 'compare__sub' });
        return { el: h('div', { class: `compare__col ${cls}` }, place, pos, sub), place, pos, sub };
    };
    const cmpA = cmpCol('compare__col--a');
    const cmpB = cmpCol('compare__col--b');
    const cmpNote = h('p', { class: 'compare__note' });
    const compare = h('section', { class: 'compare', 'aria-label': 'Two places compared', hidden: true },
        h('div', { class: 'compare__head' }, cmpTitle, h('span', { class: 'compare__tools' }, cmpShow, cmpEdit, cmpRemove)),
        h('div', { class: 'compare__grid', role: 'group' }, cmpA.el, cmpB.el),
        cmpNote);
    offs.push(on(cmpShow, 'click', () => ui.act('frameObservers')));
    offs.push(on(cmpEdit, 'click', () => ui.act('compareWith')));
    offs.push(on(cmpRemove, 'click', () => ui.act('setObserver2', null)));
    const sight = { sepDeg: 0, baselineKm: 0, perpKm: 0, distKm: NaN };

    const tonightCard = mountTonight(ctx);
    root.append(
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Sky now'), status),
        summary, tonightCard.el, compare, empty, list,
        h('p', { class: 'note' }, 'Tip: press ', h('kbd', { class: 'kbd' }, '1'), '–', h('kbd', { class: 'kbd' }, '9'),
            ' to select a body, ', h('kbd', { class: 'kbd' }, 'V'), ' to stand on the ground and look up.'));

    /** @type {Record<string, any>} */
    const rows = {};
    for (const b of BODIES) {
        const comp = makeCompass();
        const badge = h('span', { class: 'badge body-row__badge' });
        const nameText = document.createTextNode(b.name);
        const name = h('span', { class: 'body-row__name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), nameText, badge);
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
        rows[b.id] = { li, button, comp, sub, alt, dir, badge, nameText, spark, sparkKey: '', up: null, order: -1 };
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
        const t = snap.tMs;
        const sel = store.get().selection;
        const items = [];
        // Standing on Mars, slot 4 is the Earth (astro/bodies.js hostBodies).
        const table = hostBodies(snap.host);
        // Tonight's noon-to-noon altitudes (the Earth observer's) feed the sparklines.
        const series = snap.host === 'mars' ? null : ui.almanac.night?.tonight?.series ?? null;
        for (const b of snap.bodies) {
            const r = rows[b.id];
            if (!r) continue;
            const nm = table[BODY_INDEX[b.id]].name;
            if (r.nameText.data !== nm) r.nameText.data = nm;
            const { alt, az } = ui.altAz(b);
            const up = isUp(b, alt);
            const rs = ui.riseSetFor(b.id, t);
            items.push({ id: b.id, up, alt, rise: rs.nextRiseMs ?? (rs.status === 'never' ? Infinity : 9e15) });
            // Compass: needle to azimuth; the dot sits at the polar-projected altitude when up.
            if (Number.isFinite(az)) r.comp.needle.setAttribute('transform', `rotate(${az.toFixed(1)} 16 16)`);
            const rad = up ? 12.2 * (1 - Math.min(90, Math.max(0, alt)) / 90) : 13;
            r.comp.dot.setAttribute('cy', (16 - rad).toFixed(2));
            r.button.classList.toggle('is-down', !up);
            r.button.classList.toggle('is-selected', sel === b.id);
            setAttr(r.button, 'aria-current', sel === b.id ? 'true' : null);
            const altTxt = up ? `${Math.max(0, Math.round(alt))}°` : downText(ui, rs, t);
            const dirTxt = up ? ui.compass(az) : '';
            setText(r.alt, altTxt);
            setText(r.dir, dirTxt);
            const rsTxt = riseSetText(ui, b.id, up, t);
            const magTxt = shownMag(b) !== null ? `mag ${ui.fmt('fmtMag', b.mag)}` : '';
            setText(r.sub, [rsTxt, magTxt].filter(Boolean).join(' · '));
            setText(r.badge, up ? 'Up' : 'Down');
            r.badge.classList.toggle('badge--up', up);
            r.badge.classList.toggle('badge--down', !up);
            const spoken = up
                ? `${ui.bodyName(b.id)}: ${Math.round(alt)} degrees up in the ${ui.compassWords(az)}.`
                : `${ui.bodyName(b.id)}: below the horizon${altTxt.startsWith('rises') ? `, ${altTxt}` : ''}.`;
            setAttr(r.button, 'aria-label', `${spoken} ${rsTxt ? rsTxt + '.' : ''} ${magTxt ? 'Magnitude ' + ui.fmt('fmtMag', b.mag) + '.' : ''}`.trim());
            r.up = up;
            updateSpark(r, b.id, t, series);
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
        // Header: twilight state (or a solar eclipse in progress) and tonight's darkness.
        const tw = snap.observer?.twilight;
        const sunAlt = snap.observer?.sunAltDeg;
        const sol = solarEclipseState(snap);
        const state = sol ? (sol.kind === 'total' ? 'Total solar eclipse' : 'Solar eclipse') : TWILIGHT_LABEL[tw] || 'Sky';
        setText(status, `${snap.host === 'mars' ? 'Mars · ' : ''}${state}${Number.isFinite(sunAlt) ? ` · Sun ${ui.fmt('fmtAlt', sunAlt)}` : ''}`);
        status.dataset.tw = tw || '';
        setText(summary, summaryText(snap));
        updateCompare(snap);
        tonightCard.update(snap);
    }

    /** A row's 24-h sparkline, redrawn when the series changes or the now dot moves a pixel. */
    const SPARK_W = 44, SPARK_H = 16;
    let sparkRev = 0, sparkOf = null;
    function updateSpark(r, id, t, s) {
        const i = s && id !== 'sun' ? s.ids.indexOf(id) : -1;
        const row = !s ? -2 : id === 'sun' ? -1 : i >= 0 ? i : -2;
        const show = row >= -1;
        if (r.spark.hidden === show) r.spark.hidden = !show;
        if (!show) return;
        if (s !== sparkOf) { sparkOf = s; sparkRev += 1; }
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
        const key = `${sparkRev}|${dpr}|${Math.round(((t - s.t0Ms) / ((s.n - 1) * s.stepMs)) * SPARK_W)}`;
        if (key === r.sparkKey) return;
        r.sparkKey = key;
        if (r.spark.width !== SPARK_W * dpr) { r.spark.width = SPARK_W * dpr; r.spark.height = SPARK_H * dpr; }
        const c = r.spark.getContext('2d');
        if (c) drawSparkline(c, SPARK_W, SPARK_H, dpr, s, row, t, BODIES[BODY_INDEX[id]].color);
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
        setText(cmpTitle, `${name} from two places`);
        cmpShow.hidden = st.status?.webgl === false;
        const fill = (col, b, placeName) => {
            const { alt, az } = ui.altAz(b);
            const up = isUp(b, alt);
            setText(col.place, placeName);
            setText(col.pos, Number.isFinite(alt) ? `${ui.fmt('fmtAlt', alt)} · ${ui.compass(az)}` : '—');
            setText(col.sub, up ? `Up, in the ${ui.compassWords(az)}` : 'Below the horizon');
            col.el.classList.toggle('is-down', !up);
            setAttr(col.el, 'aria-label', `From ${placeName}: ${name} ${up ? `${Math.round(alt)} degrees up in the ${ui.compassWords(az)}` : 'below the horizon'}.`);
        };
        fill(cmpA, snap.bodies[i], st.observer?.name || 'Your location');
        fill(cmpB, s2.bodies[i], o2.name || 'Second place');
        const r = compareSight(snap, s2, i, sight);
        let note = '';
        if (r) {
            const apart = r.sepDeg >= 0.1 ? `${r.sepDeg.toFixed(2)}°` : r.sepDeg >= 0.001 ? `${(r.sepDeg * 3600).toFixed(1)}″` : 'less than 0.001°';
            note = id === 'moon' && Number.isFinite(r.distKm)
                ? `Its direction differs by ${apart} between the two places: the Moon’s parallax. ${ui.fmt('fmtInt', r.perpKm)} km of baseline across the line of sight ÷ ${r.sepDeg.toFixed(2)}° ≈ ${ui.fmt('fmtDistKm', Math.round(r.distKm / 1000) * 1000)} to the Moon, as Lalande and Lacaille measured it from Berlin and the Cape in 1751.`
                : `Its direction differs by ${apart} between the two places${id === 'sun' ? ' (the Sun’s tiny parallax)' : ''}: too far away for the sightlines to meet in view.`;
        }
        setText(cmpNote, note);
    }
    offs.push(store.subscribe((st) => st.observer2, () => { if (ui.snap) update(ui.snap); }));

    function summaryText(snap) {
        if (snap.host === 'mars' && snap.mars) return marsSummary(snap);
        const t = snap.tMs;
        const parts = [];
        const sol = solarEclipseState(snap);
        if (sol) parts.push(sol.text);
        const tw = ui.almanac.night?.twilight;
        if (tw) {
            if (Number.isFinite(tw.sunsetMs) && Number.isFinite(tw.sunriseMs)) {
                parts.push(`Sunset ${ui.fmtWhen(tw.sunsetMs, t)} · Sunrise ${ui.fmtWhen(tw.sunriseMs, t)}`);
            }
            if (Number.isFinite(tw.astroDuskMs) && Number.isFinite(tw.astroDawnMs)) {
                parts.push(`Dark ${ui.fmtClock(tw.astroDuskMs)}–${ui.fmtClock(tw.astroDawnMs)}`);
            } else if (Number.isFinite(tw.sunsetMs)) {
                parts.push('No full darkness tonight');
            }
        }
        const moon = ui.bodyOf(snap, 'moon');
        if (moon && Number.isFinite(moon.phaseFrac) && Number.isFinite(snap.moonPhaseDeg)) {
            const ecl = lunarEclipseState(snap);
            parts.push(ecl
                ? `${moonPhaseName(snap.moonPhaseDeg)} ${ecl.text}`
                : sol ? `${moonPhaseName(snap.moonPhaseDeg)} in front of the Sun`
                    : `Moon ${Math.round(moon.phaseFrac * 100)}% lit, ${moonPhaseName(snap.moonPhaseDeg).toLowerCase()}`);
        }
        const sky = skyDarknessText(snap);
        if (sky) parts.push(sky);
        const aur = auroraText(snap);
        if (aur) parts.push(aur);
        return parts.join(' · ');
    }

    /** Standing on Mars: the site, its clock and season, and the light from home. */
    function marsSummary(snap) {
        const m = snap.mars;
        const site = marsSiteNear(m.site.latDeg, m.site.lonDeg, 0.5);
        const clockTxt = marsClockText(m.time, site ? { ...site, lonDeg: m.site.lonDeg } : { lonDeg: m.site.lonDeg }).text;
        const parts = [`${m.site.name || 'Mars'} · ${clockTxt}`, `Ls ${Math.round(m.time.lsDeg)}°, ${marsSeason(m.time.lsDeg, m.site.latDeg)}`];
        const e = snap.bodies[BODY_INDEX.mars];
        if (e && Number.isFinite(e.lightTimeS)) parts.push(`The light from home left ${Math.max(1, Math.round(e.lightTimeS / 60))} min ago`);
        parts.push('Rise and set times are not computed on Mars yet');
        return parts.join(' · ');
    }

    offs.push(store.subscribe((st) => st.selection, () => { if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('almanac', () => { if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('display', () => { if (ui.snap) update(ui.snap); }));
    if (ui.snap) update(ui.snap);

    return {
        update,
        destroy() { offs.forEach((off) => off()); tonightCard.destroy(); root.textContent = ''; },
    };
}

/**
 * The site's sky class and, once the Sun is 15° down, the naked-eye limiting magnitude at the
 * zenith (Moon and light pollution included; snap.skyglow, js/astro/skyglow.js):
 * 'Bortle 8 · limiting mag 4.1', by day 'Bortle 8 sky'. Empty without a skyglow.
 * @param {any} snap
 * @returns {string}
 */
export function skyDarknessText(snap) {
    const sg = snap?.skyglow;
    if (!sg || !Number.isFinite(sg.bortle)) return '';
    const sunAlt = snap.observer?.sunAltDeg;
    if (Number.isFinite(sunAlt) && sunAlt <= -15 && Number.isFinite(sg.limitMag)) {
        return `Bortle ${sg.bortle} · limiting mag ${sg.limitMag.toFixed(1)}`;
    }
    return `Bortle ${sg.bortle} sky`;
}

/**
 * Moon phase name from the Sun–Moon ecliptic elongation (0 = new, 180 = full).
 * Principal phases are named within ±6° (about half a day).
 * @param {number} deg
 * @returns {string}
 */
export function moonPhaseName(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 6 || d > 354) return 'New Moon';
    if (Math.abs(d - 90) < 6) return 'First quarter';
    if (Math.abs(d - 180) < 6) return 'Full Moon';
    if (Math.abs(d - 270) < 6) return 'Last quarter';
    if (d < 90) return 'Waxing crescent';
    if (d < 180) return 'Waxing gibbous';
    if (d < 270) return 'Waning gibbous';
    return 'Waning crescent';
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
    return { total, sunlit, text: total ? 'in total eclipse' : `in eclipse, ${Math.round(sunlit * 100)}% sunlit` };
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
    const pct = covered > 0.99 ? (Math.floor(covered * 1000) / 10).toFixed(1) : String(Math.round(covered * 100));
    const text = kind === 'total' ? 'Total solar eclipse'
        : `${kind === 'annular' ? 'Annular' : 'Partial'} solar eclipse, ${pct}% of the Sun covered`;
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

/**
 * Mounts the mobile peek strip of body chips.
 * @param {HTMLElement} root `.strip`
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void}}
 */
export function mountBodyStrip(root, ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const scroller = h('div', { class: 'strip__scroll', role: 'group', 'aria-label': 'Bodies' });
    root.append(scroller);
    /** @type {Record<string, {chip: HTMLElement, alt: HTMLElement}>} */
    const chips = {};
    for (const b of BODIES) {
        const alt = h('span', { class: 'bchip__alt' }, '—');
        const chip = h('button', {
            class: 'bchip', type: 'button', 'data-id': b.id, style: { '--c': `var(--body-${b.id})` }, 'aria-pressed': 'false',
        }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'bchip__name' }, b.name), alt);
        scroller.appendChild(chip);
        chips[b.id] = { chip, alt, name: chip.querySelector('.bchip__name') };
    }
    offs.push(on(scroller, 'click', (e) => {
        const chip = /** @type {HTMLElement} */ (e.target).closest('.bchip');
        if (!chip) return;
        ui.act('select', chip.dataset.id, { fly: true });
        ui.openPanel('details', { sheet: 'half' });
    }));
    /**
     * Scrolls the strip (and only the strip: never the page or the sheet) so the selected chip
     * is fully visible. A no-op while the strip is detached, as it is at mount and on desktop.
     * @param {boolean} smooth
     */
    function reveal(smooth) {
        const sel = store.get().selection;
        const chip = sel && chips[sel]?.chip;
        if (!chip || !scroller.isConnected || !scroller.clientWidth) return;
        const s = scroller.getBoundingClientRect(), c = chip.getBoundingClientRect();
        const dx = c.left < s.left ? c.left - s.left - 4 : c.right > s.right ? c.right - s.right + 4 : 0;
        if (Math.abs(dx) < 1) return;
        const left = scroller.scrollLeft + dx;
        if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ left, behavior: smooth && !ui.reducedMotion() ? 'smooth' : 'auto' });
        else scroller.scrollLeft = left;
    }
    offs.push(store.subscribe((st) => st.selection, (sel) => {
        for (const id in chips) {
            chips[id].chip.setAttribute('aria-pressed', String(sel === id));
            chips[id].chip.classList.toggle('is-selected', sel === id);
        }
        reveal(true);
    }, { immediate: true }));
    // The strip joins the sheet on the phone layout after mount (a shared link's selection is
    // already set by then), and the sheet settles a frame later.
    offs.push(ui.on('layout', () => {
        reveal(false);
        requestAnimationFrame(() => reveal(false));
    }));

    function update(snap) {
        if (!snap?.bodies) return;
        const table = hostBodies(snap.host);
        for (const b of snap.bodies) {
            const c = chips[b.id];
            if (!c) continue;
            const nm = table[BODY_INDEX[b.id]].name;
            if (c.name.textContent !== nm) c.name.textContent = nm;
            const { alt, az } = ui.altAz(b);
            if (!Number.isFinite(alt)) continue;
            const up = isUp(b, alt);
            const r = Math.round(alt);
            setText(c.alt, up ? `${Math.max(0, r)}°` : `${r < 0 ? '−' : ''}${Math.abs(r)}°`);
            c.chip.classList.toggle('is-down', !up);
            setAttr(c.chip, 'aria-label', up
                ? `${ui.bodyName(b.id)}, ${Math.round(alt)} degrees up, ${ui.compassWords(az)}`
                : `${ui.bodyName(b.id)}, below the horizon`);
        }
    }
    if (ui.snap) update(ui.snap);

    return { update, destroy() { offs.forEach((off) => off()); root.textContent = ''; } };
}

/** Exposed for the details card and events panel icons. */
export const bodyIcon = (id) => icon(id === 'sun' ? 'sun' : id === 'moon' ? 'moon' : 'planet', { size: 16 });
