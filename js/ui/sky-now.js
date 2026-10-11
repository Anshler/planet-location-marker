/**
 * Sky Now: one row per body — colour dot, name, a mini sky compass (needle at the
 * azimuth, dot at the polar-projected altitude), "34° · SE" or "below horizon",
 * "Rises 21:14" / "Sets 05:02", magnitude and an Up / Down badge. Bodies above
 * the horizon come first by altitude, then the rest by next rise. Clicking a row
 * selects the body (fly in orbit view, aim in sky view) and opens Details.
 *
 * This list is also the text alternative to the 3D view (and the main content
 * of text mode), so every row carries a full spoken label.
 *
 * `mountBodyStrip` renders the mobile peek strip of body chips (dot, name, alt).
 *
 * @module ui/sky-now
 */

import { BODIES } from '../astro/bodies.js';
import { h, s, on, setText, setAttr } from './dom.js';
import { icon } from './icons.js';

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

    root.append(
        h('div', { class: 'section-head' }, h('h2', { class: 'panel-title' }, 'Sky now'), status),
        summary, empty, list,
        h('p', { class: 'note' }, 'Tip: press ', h('kbd', { class: 'kbd' }, '1'), '–', h('kbd', { class: 'kbd' }, '9'),
            ' to select a body, ', h('kbd', { class: 'kbd' }, 'V'), ' to stand on the ground and look up.'));

    /** @type {Record<string, any>} */
    const rows = {};
    for (const b of BODIES) {
        const comp = makeCompass();
        const badge = h('span', { class: 'badge body-row__badge' });
        const name = h('span', { class: 'body-row__name' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), b.name, badge);
        const sub = h('span', { class: 'body-row__sub' });
        const alt = h('span', { class: 'body-row__alt' });
        const dir = h('span', { class: 'body-row__dir' });
        const button = h('button', {
            class: 'body-row', type: 'button', 'data-id': b.id, style: { '--c': `var(--body-${b.id})` },
        }, h('span', { class: 'body-row__compass' }, comp.el),
        h('span', { class: 'body-row__main' }, name, sub),
        h('span', { class: 'body-row__pos' }, alt, h('span', { class: 'body-row__sep', 'aria-hidden': 'true' }, '·'), dir));
        const li = h('li', { class: 'body-list__item' }, button);
        rows[b.id] = { li, button, comp, sub, alt, dir, badge, up: null, order: -1 };
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
        for (const b of snap.bodies) {
            const r = rows[b.id];
            if (!r) continue;
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
            const altTxt = up ? `${Math.max(0, Math.round(alt))}°` : 'below horizon';
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
                : `${ui.bodyName(b.id)}: below the horizon.`;
            setAttr(r.button, 'aria-label', `${spoken} ${rsTxt ? rsTxt + '.' : ''} ${magTxt ? 'Magnitude ' + ui.fmt('fmtMag', b.mag) + '.' : ''}`.trim());
            r.up = up;
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
        setText(status, `${state}${Number.isFinite(sunAlt) ? ` · Sun ${ui.fmt('fmtAlt', sunAlt)}` : ''}`);
        status.dataset.tw = tw || '';
        setText(summary, summaryText(snap));
    }

    function summaryText(snap) {
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
        return parts.join(' · ');
    }

    offs.push(store.subscribe((st) => st.selection, () => { if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('almanac', () => { if (ui.snap) update(ui.snap); }));
    offs.push(ui.on('display', () => { if (ui.snap) update(ui.snap); }));
    if (ui.snap) update(ui.snap);

    return {
        update,
        destroy() { offs.forEach((off) => off()); root.textContent = ''; },
    };
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
 * fraction of the Sun's disc; `kind` ('total' | 'annular' | 'partial') comes from the topocentric
 * disc sizes and separation, `geo` (arcseconds) when the snapshot carries them.
 * @param {any} snap
 * @returns {{kind:string, covered:number, pct:string, text:string, geo:{sep:number, rS:number, rM:number, pa:number}|null} | null}
 */
export function solarEclipseState(snap) {
    const o = snap?.eclipse?.obscurationAtObserver;
    if (!Number.isFinite(o) || o < 0.001) return null;
    const covered = Math.min(1, Math.max(0, o));
    const geo = solarDiscGeometry(snap);
    let kind = 'partial';
    if (geo ? geo.rM >= geo.rS && geo.sep <= geo.rM - geo.rS : covered >= 0.99995) kind = 'total';
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
 * facing the Sun), or null without directions and sizes.
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
        chips[b.id] = { chip, alt };
    }
    offs.push(on(scroller, 'click', (e) => {
        const chip = /** @type {HTMLElement} */ (e.target).closest('.bchip');
        if (!chip) return;
        ui.act('select', chip.dataset.id, { fly: true });
        ui.openPanel('details', { sheet: 'half' });
    }));
    offs.push(store.subscribe((st) => st.selection, (sel) => {
        for (const id in chips) {
            chips[id].chip.setAttribute('aria-pressed', String(sel === id));
            chips[id].chip.classList.toggle('is-selected', sel === id);
        }
        if (sel && chips[sel]) chips[sel].chip.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: ui.reducedMotion() ? 'auto' : 'smooth' });
    }, { immediate: true }));

    function update(snap) {
        if (!snap?.bodies) return;
        for (const b of snap.bodies) {
            const c = chips[b.id];
            if (!c) continue;
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
