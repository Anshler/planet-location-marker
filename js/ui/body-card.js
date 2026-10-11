/**
 * Details tab: the card for the selected body.
 *
 * - title with colour dot, a canvas phase disc and the tonight verdict badge;
 * - the position sentence ("Mars is 34° above the south-east horizon, in Taurus.");
 * - the light-time sentence ("The light you see from Mars left 12 min 31 s ago.");
 * - Moon extras: phase name and age;
 * - actions: Look from here · Center · Path ±6 months · Show where it's visible;
 * - fact grid: altitude/azimuth (refracted), rise · transit · set, distance,
 *   magnitude, phase, elongation, angular size, constellation, RA/Dec J2000 and
 *   of date, sub-point.
 *
 * Without a selection it shows a chooser with the nine bodies.
 *
 * @module ui/body-card
 */

import { BODIES, BODY_INDEX, AU_KM } from '../astro/bodies.js';
import { h, on, setText, setAttr } from './dom.js';
import { icon } from './icons.js';
import { moonPhaseName, isUp, lunarEclipseState, solarEclipseState, shownMag } from './sky-now.js';

const SYNODIC_DAYS = 29.530589;

const VERDICT = {
    excellent: ['Excellent tonight', 'ok'],
    good: ['Good tonight', 'accent'],
    low: ['Low tonight', 'warn'],
    twilight: ['Only in twilight', 'warn'],
    daytime: ['Daytime only', 'muted'],
    'not-visible': ['Not visible tonight', 'muted'],
};
const KIND_LABEL = { star: 'Star', moon: 'Moon', planet: 'Planet' };
const EQUIPMENT = { 'naked-eye': 'naked eye', binoculars: 'binoculars', telescope: 'telescope' };

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
    const pickGrid = h('div', { class: 'pick-grid', role: 'group', 'aria-label': 'Choose a body' },
        BODIES.map((b) => h('button', {
            class: 'bchip bchip--pick', type: 'button', 'data-id': b.id, style: { '--c': `var(--body-${b.id})` },
        }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'bchip__name' }, b.name),
        h('kbd', { class: 'kbd kbd--ghost', 'aria-hidden': 'true' }, b.key))));
    const empty = h('div', { class: 'card-empty' },
        h('div', { class: 'card-empty__icon', 'aria-hidden': 'true' }, icon('target', { size: 28 })),
        h('h2', { class: 'card-empty__title' }, 'Pick a body'),
        h('p', { class: 'card-empty__text' }, 'Click a planet in the sky, a row in Sky now, or press 1–9.'),
        pickGrid);
    offs.push(on(pickGrid, 'click', (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-id]');
        if (b) ui.act('select', b.dataset.id, { fly: true });
    }));

    // ---------------------------------------------------------------- card
    const disc = h('canvas', { class: 'phase-disc', width: 64, height: 64, role: 'img', 'aria-label': '' });
    const nameEl = h('h2', { class: 'card__name' });
    const kindEl = h('p', { class: 'card__kind' });
    const verdict = h('span', { class: 'badge card__verdict', hidden: true });
    const sentence = h('p', { class: 'card__sentence' });
    const lightText = h('span');
    const lightAgo = h('span', { class: 'card__light-ago' });
    const light = h('p', { class: 'card__light' }, h('span', { class: 'card__light-icon', 'aria-hidden': 'true' }, icon('sparkle', { size: 16 })),
        h('span', null, lightText, ' ', lightAgo));
    const moonLine = h('p', { class: 'card__moon', hidden: true });

    const actLook = actionBtn('sky', 'Look from here', 'Stand at the observer and look toward it');
    const actCenter = actionBtn('target', 'Center', 'Turn the view toward it');
    const actPath = actionBtn('path', 'Path ±6 months', 'Show its apparent path for six months either side', true);
    const actFoot = actionBtn('footprint', 'Show where it’s visible', 'Highlight where on Earth it is above the horizon', true);
    const actions = h('div', { class: 'card__actions' }, actLook, actCenter, actPath, actFoot);

    const facts = {};
    const fact = (key, label, { wide = false, hint } = {}) => {
        const dd = h('dd', { class: 'fact__value' });
        const el = h('div', { class: `fact${wide ? ' fact--wide' : ''}` }, h('dt', { class: 'fact__label', title: hint || null }, label), dd);
        facts[key] = { el, dd };
        return el;
    };
    const grid = h('dl', { class: 'facts' },
        fact('alt', 'Altitude', { hint: 'Apparent, including atmospheric refraction' }),
        fact('az', 'Azimuth', { hint: 'Measured from north through east' }),
        fact('rts', 'Rise · Transit · Set', { wide: true, hint: 'For the observer’s local day' }),
        fact('dist', 'Distance', { wide: true }),
        fact('mag', 'Magnitude', { hint: 'Lower is brighter' }),
        fact('phase', 'Phase'),
        fact('elong', 'Elongation', { hint: 'Angle from the Sun' }),
        fact('size', 'Angular size'),
        fact('con', 'Constellation', { wide: true }),
        fact('j2000', 'RA / Dec (J2000)', { wide: true, hint: 'Astrometric, mean equator and equinox of J2000' }),
        fact('date', 'RA / Dec (of date)', { wide: true, hint: 'Apparent, true equator and equinox of date' }),
        fact('sub', 'Sub-point', { wide: true, hint: 'Where on Earth it is straight overhead' }));
    const tonight = h('p', { class: 'card__tonight', hidden: true });

    // Rise · Transit · Set as three labelled cells (a day's set can come before its rise).
    const rtsCell = (iconName, label) => {
        const time = h('span', { class: 'rts__time' }, '—');
        const extra = h('span', { class: 'rts__extra' });
        const el = h('span', { class: 'rts__cell' }, h('span', { class: 'rts__label' }, icon(iconName, { size: 14 }), label), time, extra);
        return { el, time, extra };
    };
    const rtsRise = rtsCell('rise', 'Rise');
    const rtsTransit = rtsCell('arrow', 'Transit');
    const rtsSet = rtsCell('set', 'Set');
    const rtsMsg = h('span', { class: 'rts__msg', hidden: true });
    facts.rts.dd.append(h('span', { class: 'rts' }, rtsRise.el, rtsTransit.el, rtsSet.el), rtsMsg);

    const card = h('article', { class: 'card', 'aria-live': 'off' },
        h('header', { class: 'card__head' },
            h('div', { class: 'card__disc' }, disc),
            h('div', { class: 'card__titles' }, nameEl, kindEl),
            verdict),
        sentence, light, moonLine, actions, tonight, grid,
        h('p', { class: 'note' }, 'Tables show apparent, refracted values; the 3D view draws astrometric J2000 directions.'));

    root.append(empty, card);

    function actionBtn(iconName, label, tip, toggle = false) {
        return h('button', {
            class: 'btn btn--soft card__action', type: 'button', title: tip, ...(toggle ? { 'aria-pressed': 'false' } : {}),
        }, icon(iconName, { size: 16 }), h('span', null, label));
    }

    const sel = () => store.get().selection;
    offs.push(on(actLook, 'click', () => {
        const id = sel();
        if (!id) return;
        if (store.get().view?.mode === 'sky') ui.act('select', id, { fly: true });
        else { ui.act('select', id, { fly: false }); ui.act('setViewMode', 'sky'); }
    }));
    offs.push(on(actCenter, 'click', () => { const id = sel(); if (id) ui.act('flyToBody', id); }));
    offs.push(on(actPath, 'click', () => ui.act('toggleLayer', 'trails', !store.get().layers?.trails)));
    offs.push(on(actFoot, 'click', () => ui.act('toggleLayer', 'footprint', !store.get().layers?.footprint)));

    // ---------------------------------------------------------------- rendering
    let shownId = null;
    let discKey = '';

    function showFor(id) {
        const has = !!id && id in BODY_INDEX;
        empty.hidden = has;
        card.hidden = !has;
        if (!has) { shownId = null; return; }
        if (id !== shownId) {
            shownId = id;
            const b = BODIES[BODY_INDEX[id]];
            card.style.setProperty('--c', `var(--body-${id})`);
            nameEl.replaceChildren(h('span', { class: 'dot dot--lg', 'aria-hidden': 'true' }), b.name);
            actPath.hidden = b.kind !== 'planet';
            discKey = '';
        }
    }

    function syncLayerButtons() {
        const ly = store.get().layers || {};
        setAttr(actPath, 'aria-pressed', String(!!ly.trails));
        setAttr(actFoot, 'aria-pressed', String(!!ly.footprint));
        const sky = store.get().view?.mode === 'sky';
        actLook.lastChild.textContent = sky ? 'Aim here' : 'Look from here';
    }

    function update(snap) {
        const id = sel();
        showFor(id);
        if (!id || !snap?.bodies) return;
        const b = ui.bodyOf(snap, id);
        if (!b) return;
        const info = BODIES[BODY_INDEX[id]];
        const t = snap.tMs;
        const { alt, az } = ui.altAz(b);
        const up = isUp(b, alt);
        const con = b.constellation?.name || '';
        const subject = ui.bodySubject(id);

        setText(kindEl, `${KIND_LABEL[info.kind] || ''}${con ? ` · in ${con}` : ''}`);

        // Position sentence.
        let sent = '';
        if (Number.isFinite(alt)) {
            const where = ui.compassWords(az);
            if (up && alt >= 80) sent = `${subject} is nearly overhead (${Math.round(alt)}°)`;
            else if (up) sent = `${subject} is ${Math.max(0, Math.round(alt))}° above the ${where} horizon`;
            else sent = `${subject} is ${Math.abs(Math.round(alt))}° below the ${where} horizon`;
            sent += con ? `, in ${con}.` : '.';
        }
        setText(sentence, sent);

        // Light-time sentence.
        if (Number.isFinite(b.lightTimeS)) {
            setText(lightText, `The light you see from ${ui.bodySubject(id, false)} left ${ui.fmt('fmtLightTime', b.lightTimeS)} ago.`);
            setText(lightAgo, b.lightTimeS >= 60 ? `It set out at ${ui.fmtClock(t - b.lightTimeS * 1000, { seconds: true })}.` : '');
            light.hidden = false;
        } else light.hidden = true;

        // Moon extras.
        if (id === 'moon' && Number.isFinite(snap.moonPhaseDeg)) {
            const age = ((((snap.moonPhaseDeg % 360) + 360) % 360) / 360) * SYNODIC_DAYS;
            const ecl = lunarEclipseState(snap);
            const sol = solarEclipseState(snap);
            const eclTxt = ecl ? ` · ${ecl.text}` : sol ? ` · in front of the Sun (${sol.kind === 'total' ? 'total' : sol.kind} solar eclipse)` : '';
            setText(moonLine, `${moonPhaseName(snap.moonPhaseDeg)} · ${age.toFixed(1)} days old${eclTxt}`);
            moonLine.hidden = false;
        } else if (id === 'sun' && solarEclipseState(snap)) {
            const sol = solarEclipseState(snap);
            setText(moonLine, sol.kind === 'total' ? 'Total solar eclipse: the Moon hides the whole Sun.'
                : sol.kind === 'annular' ? `${sol.text}: a ring of Sun around the Moon.` : `${sol.text}.`);
            moonLine.hidden = false;
        } else moonLine.hidden = true;

        // Verdict + tonight line.
        const rep = id === 'sun' ? null : ui.tonightFor(id);
        if (rep && VERDICT[rep.verdict]) {
            const [label, tone] = VERDICT[rep.verdict];
            setText(verdict, label);
            verdict.className = `badge card__verdict badge--${tone}`;
            verdict.hidden = false;
            const bits = [];
            if (Number.isFinite(rep.bestMs) && rep.verdict !== 'not-visible' && rep.verdict !== 'daytime') {
                bits.push(`best around ${ui.fmtWhen(rep.bestMs, t)}${Number.isFinite(rep.bestAltDeg) ? `, ${Math.round(rep.bestAltDeg)}° high` : ''}${Number.isFinite(rep.bestAzDeg) ? ` in the ${ui.compassWords(rep.bestAzDeg)}` : ''}`);
            }
            if (Number.isFinite(rep.windowStartMs) && Number.isFinite(rep.windowEndMs) && rep.windowEndMs > rep.windowStartMs) {
                bits.push(`visible ${ui.fmtClock(rep.windowStartMs)}–${ui.fmtClock(rep.windowEndMs)}`);
            }
            if (rep.equipment && EQUIPMENT[rep.equipment] && rep.verdict !== 'not-visible') bits.push(EQUIPMENT[rep.equipment]);
            setText(tonight, bits.length ? `Tonight: ${bits.join(' · ')}` : '');
            tonight.hidden = !bits.length;
        } else { verdict.hidden = true; tonight.hidden = true; }

        // Facts.
        setText(facts.alt.dd, Number.isFinite(alt) ? ui.fmt('fmtAlt', alt) : '—');
        setText(facts.az.dd, Number.isFinite(az) ? ui.fmt('fmtAz', az) : '—');
        renderRts(id, t);
        if (id === 'moon') {
            setText(facts.dist.dd, Number.isFinite(b.distAU) ? `${ui.fmt('fmtDistKm', b.distAU * AU_KM)} · ${(b.distER || b.distAU * AU_KM / 6378.137).toFixed(1)} Earth radii` : '—');
        } else {
            setText(facts.dist.dd, Number.isFinite(b.distAU) ? ui.fmt('fmtDistAU', b.distAU) : '—');
        }
        setText(facts.mag.dd, shownMag(b) !== null ? ui.fmt('fmtMag', b.mag) : '—');
        const isSun = id === 'sun';
        facts.phase.el.hidden = isSun;
        facts.elong.el.hidden = isSun;
        if (!isSun) {
            const ecl = id === 'moon' ? lunarEclipseState(snap) : null;
            let phase = Number.isFinite(b.phaseFrac) ? `${Math.round(b.phaseFrac * 100)}% lit` : '—';
            if (ecl && phase !== '—') phase += ecl.total ? ' · totally eclipsed' : ` · ${Math.round(ecl.sunlit * 100)}% sunlit`;
            setText(facts.phase.dd, phase);
            const side = b.elongSide === 'morning' ? ' · morning sky' : b.elongSide === 'evening' ? ' · evening sky' : '';
            setText(facts.elong.dd, Number.isFinite(b.elongDeg) ? `${b.elongDeg.toFixed(1)}°${side}` : '—');
        }
        const size = ui.fmt('fmtAngSize', b.angDiamArcsec);
        setText(facts.size.dd, size !== '—' ? size : angSize(b.angDiamArcsec));
        setText(facts.con.dd, con ? `${con}${b.constellation?.symbol ? ` (${b.constellation.symbol})` : ''}` : '—');
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
                ? (sol ? `The Sun’s disc, ${sol.kind === 'total' ? 'hidden by the Moon' : `${sol.pct}% covered by the Moon`}` : 'The Sun’s disc')
                : `${info.name}: ${Math.round(frac * 100)}% of the disc lit, lit side ${litRight ? 'right' : 'left'}`);
        }
        syncLayerButtons();
    }

    function renderRts(id, t) {
        const rs = ui.riseSetFor(id, t);
        const rtsBox = facts.rts.dd.firstChild;
        let msg = '';
        if (!rs.known) msg = 'Computing…';
        else if (rs.status === 'circumpolar' && rs.riseMs == null && rs.setMs == null) msg = 'Up all day — it never sets here today';
        else if (rs.status === 'never' && rs.riseMs == null) msg = 'Stays below the horizon all day';
        rtsMsg.hidden = !msg;
        setText(rtsMsg, msg);
        rtsBox.hidden = !!msg && msg !== '' && rs.transitMs == null;
        setText(rtsRise.time, rs.riseMs != null ? ui.fmtClock(rs.riseMs) : '—');
        setText(rtsSet.time, rs.setMs != null ? ui.fmtClock(rs.setMs) : '—');
        setText(rtsTransit.time, rs.transitMs != null ? ui.fmtClock(rs.transitMs) : '—');
        setText(rtsTransit.extra, rs.transitAltDeg != null && rs.transitMs != null ? `${Math.round(rs.transitAltDeg)}° high` : '');
        setText(rtsRise.extra, '');
        setText(rtsSet.extra, '');
    }

    offs.push(store.subscribe((st) => st.selection, (id) => { showFor(id); if (ui.snap) update(ui.snap); }, { immediate: true }));
    offs.push(store.subscribe((st) => st.layers, syncLayerButtons));
    offs.push(store.subscribe((st) => st.view, syncLayerButtons));
    offs.push(ui.on('almanac', () => { if (ui.snap && sel()) update(ui.snap); }));
    offs.push(ui.on('display', () => { if (ui.snap && sel()) update(ui.snap); }));
    syncLayerButtons();

    return {
        update,
        destroy() { offs.forEach((off) => off()); root.textContent = ''; },
    };
}

/** "31′ 36″" for discs ≥ 1′, else "17.3″". */
function angSize(as) {
    if (!Number.isFinite(as) || as <= 0) return '—';
    if (as >= 60) {
        const m = Math.floor(as / 60);
        const sec = Math.round(as - m * 60);
        return sec === 60 ? `${m + 1}′ 00″` : `${m}′ ${String(sec).padStart(2, '0')}″`;
    }
    return `${as.toFixed(1)}″`;
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

function hexRgb(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [220, 220, 230];
}
function mixRgb(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
