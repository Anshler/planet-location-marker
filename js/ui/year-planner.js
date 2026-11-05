/**
 * Details' "The year ahead", a closed <details> with its sentence in the summary.
 *
 * Planets: a 12-month chart from the first of the month. Each column is a night, each row a time
 * from 15:00 to 09:00 (standard time); the background is the sky (day, twilights, night, moonlit
 * night), and the planet's colour fills the hours it is up in darkness, brighter the higher it
 * stands. Ticks mark its oppositions, conjunctions, elongations and greatest brilliancy (Events);
 * a line marks tonight; a click jumps to that night. The sentence: when it is best, how high, how
 * bright. The Sun: its rise and set azimuths and noon altitude at the solstices and the equinox.
 *
 * From the astro worker (`visibilityYear`, `sunFigures`), debounced and cached; the chart is drawn
 * only while open. DOM and a 2D canvas: works in text mode.
 *
 *   createYearPlanner(ctx) → {el, update(snap, id), destroy()}
 *
 * @module ui/year-planner
 */
import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { PLANNER_BODIES, plannerVisible, plannerSummary } from '../astro/planner.js';
import { h, on, setText } from './dom.js';
import { t, N_, locale } from '../core/i18n.js';

const DAY = 86400e3;
const NIGHTS = 365;
const CHART_H = 160;
const PAD_L = 30, PAD_B = 16, PAD_T = 18;
const EVENT_KINDS = new Set(['opposition', 'conjunction', 'max-elongation', 'brilliancy']);
const EVENT_TAG = { opposition: N_('Opp'), conjunction: N_('Conj'), 'max-elongation': N_('Elong'), brilliancy: N_('Bright') };
const SUN_DAY = { june: N_('June solstice'), december: N_('December solstice'), march: N_('Equinox') };

function hexRgb(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [220, 220, 230];
}

/** Sky colour of a sample: day, civil, nautical, astronomical twilight, night (lifted by moonlight). */
function skyRgb(sunAlt, moonAlt, moonPct, out) {
    let r, g, b;
    if (sunAlt >= -1) { r = 52; g = 76; b = 118; }
    else if (sunAlt >= -6) { r = 34; g = 50; b = 84; }
    else if (sunAlt >= -12) { r = 21; g = 31; b = 57; }
    else if (sunAlt >= -18) { r = 13; g = 19; b = 37; }
    else { r = 8; g = 11; b = 22; }
    if (sunAlt < -6 && moonAlt > 0 && moonPct > 15) {
        const k = Math.min(1, moonPct / 100) * 0.55;
        r += (40 - r) * k; g += (48 - g) * k; b += (72 - b) * k;
    }
    out[0] = r; out[1] = g; out[2] = b;
    return out;
}

/** 'early October' ('đầu tháng 10'): the part of the month and its name. */
const part = (d, month) => (d <= 10 ? t('early {month}', { month }) : d <= 20 ? t('mid {month}', { month }) : t('late {month}', { month }));

/**
 * @param {any} ctx UiCtx
 */
export function createYearPlanner(ctx) {
    const { store, ui } = ctx;
    const offs = [];
    const cv = h('canvas', { class: 'planner__cv', width: 320, height: CHART_H, role: 'img', 'aria-label': t('Visibility chart'), tabindex: '-1' });
    const summary = h('span', { class: 'fold__sub' });
    const legend = h('p', { class: 'note' },
        t('Approximate. Each column is a night, each row an hour from 15:00 to 09:00 (standard time). Coloured where it is at least 10° up in darkness; lighter bands are moonlit. Click a night to go there.'));
    const bestBtn = h('button', { class: 'btn btn--soft btn--sm planner__best', type: 'button', hidden: true }, t('Jump to its best night'));
    const sunText = h('p', { class: 'planner__sun', hidden: true });
    const el = h('details', { class: 'fold planner', hidden: true },
        h('summary', null, h('span', null, t('The year ahead')), summary), cv, bestBtn, legend, sunText);
    offs.push(on(el, 'toggle', () => { drawKey = ''; if (el.open && ui.snap && shownId) update(ui.snap, shownId); }));

    /** @type {Map<string, any>} key → PlannerYear */
    const cache = new Map();
    let year = null;
    let yearKey = '';
    let pending = '';
    let timer = 0;
    let shownId = null;
    let drawKey = '';
    let sunKey = '';
    let sunPending = '';
    let ac = null;
    let peak = null;

    const zoneOf = () => ui.observerTz(store.get().observer);

    /** UT ms of local standard-time midnight on the 1st of the month containing t (observer zone). */
    function firstMidnight(ms) {
        const zone = zoneOf();
        const z = ui.zoned(ms, zone);
        const jan = ui.zoned(Date.UTC(z.y, 0, 15, 12), zone).offsetMin, jul = ui.zoned(Date.UTC(z.y, 6, 15, 12), zone).offsetMin;
        const std = Math.min(Number.isFinite(jan) ? jan : 0, Number.isFinite(jul) ? jul : 0);
        return { ms: Date.UTC(z.y, z.mo - 1, 1) - std * 60e3, stdOffMin: std };
    }

    function request(ms) {
        const astro = ctx.services?.astro;
        if (!astro?.call) return;
        const fm = firstMidnight(ms);
        const key = `${ui.observerKey()}|${fm.ms}`;
        if (key === yearKey || key === pending) return;
        if (cache.has(key)) { year = cache.get(key); yearKey = key; drawKey = ''; return; }
        pending = key;
        clearTimeout(timer);
        timer = setTimeout(() => {
            ac?.abort();
            ac = typeof AbortController === 'function' ? new AbortController() : null;
            let p;
            try {
                p = astro.call('visibilityYear', { observer: ui.astroObserver(), firstMidnightMs: fm.ms, nights: NIGHTS }, ac ? { signal: ac.signal } : {});
            } catch { pending = ''; return; }
            Promise.resolve(p).then((res) => {
                if (pending !== key || !res?.bodies) return;
                pending = '';
                res.stdOffMin = fm.stdOffMin;
                cache.set(key, res);
                if (cache.size > 3) cache.delete(cache.keys().next().value);
                year = res;
                yearKey = key;
                drawKey = '';
                if (ui.snap && shownId) update(ui.snap, shownId);
            }, () => { if (pending === key) pending = ''; });
        }, 350);
    }

    // ---------------------------------------------------------------- the Sun
    function requestSun(snap) {
        const astro = ctx.services?.astro;
        if (!astro?.call) return;
        const key = `${ui.observerKey()}|${new Date(snap.tMs).getUTCFullYear()}`;
        if (key === sunKey || key === sunPending) return;
        sunPending = key;
        Promise.resolve(astro.call('sunFigures', { observer: ui.astroObserver(), tMs: snap.tMs })).then((f) => {
            if (sunPending !== key || !f?.arcs) return;
            sunPending = '';
            sunKey = key;
            const bits = [];
            for (const k of ['june', 'december', 'march']) {
                const a = f.arcs.find((x) => x.key === k);
                if (!a) continue;
                const az = (v) => (Number.isFinite(v) ? `${Math.round(v)}° ${ui.compass(v)}` : '—');
                const ok = Number.isFinite(a.riseAzDeg) && Number.isFinite(a.setAzDeg);
                const day = t(SUN_DAY[k]);
                bits.push(ok ? t('{day}: rises {rise}, sets {set}, {deg}° high at noon', { day, rise: az(a.riseAzDeg), set: az(a.setAzDeg), deg: Math.round(a.noonAltDeg) })
                    : a.noonAltDeg > 0 ? t('{day}: up all day', { day }) : t('{day}: below the horizon all day', { day }));
            }
            setText(sunText, t('Sun paths here — {list}.', { list: bits.join('; ') }));
            sunText.hidden = shownId !== 'sun';
        }, () => { if (sunPending === key) sunPending = ''; });
    }

    // ---------------------------------------------------------------- drawing
    const rgb = [0, 0, 0];
    let off = null;

    function nightIndex(ms) {
        return year ? Math.floor((ms - year.firstMidnightMs + DAY / 2) / DAY) : -1;
    }

    function draw(id, now) {
        const W = Math.max(240, Math.round(cv.clientWidth || cv.parentElement?.clientWidth || 320));
        const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(CHART_H * dpr)) {
            cv.width = Math.round(W * dpr); cv.height = Math.round(CHART_H * dpr);
        }
        const c = cv.getContext('2d');
        if (!c || !year) return;
        const N = year.nights, S = year.samples;
        // The grid at one pixel per cell, scaled into the plot.
        off ??= document.createElement('canvas');
        if (off.width !== N || off.height !== S) { off.width = N; off.height = S; }
        const oc = off.getContext('2d');
        if (!oc) return;
        const img = oc.createImageData(N, S);
        const px = img.data;
        const b = year.bodies[id];
        const col = hexRgb(BODIES[BODY_INDEX[id]]?.color);
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < S; j++) {
                const k = i * S + j;
                skyRgb(year.sun[k], year.moon[k], year.moonPct[i], rgb);
                let a = 0;
                if (b) {
                    if (plannerVisible(year, id, i, j)) a = 0.35 + 0.65 * Math.min(1, Math.max(0, (b.alt[k] - 10) / 50));
                    else if (b.alt[k] >= 0) a = 0.12;
                }
                const o = (j * N + i) * 4;
                px[o] = rgb[0] + (col[0] - rgb[0]) * a;
                px[o + 1] = rgb[1] + (col[1] - rgb[1]) * a;
                px[o + 2] = rgb[2] + (col[2] - rgb[2]) * a;
                px[o + 3] = 255;
            }
        }
        oc.putImageData(img, 0, 0);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, CHART_H);
        const pw = W - PAD_L - 4, ph = CHART_H - PAD_B - PAD_T;
        c.imageSmoothingEnabled = true;
        c.drawImage(off, PAD_L, PAD_T, pw, ph);
        c.font = '10px system-ui, sans-serif';
        c.textBaseline = 'middle';
        // Hours (standard time): 18, 21, 0, 3, 6.
        c.fillStyle = 'rgba(200,210,225,.75)';
        c.textAlign = 'right';
        for (const hr of [18, 21, 0, 3, 6]) {
            const min = ((hr < 12 ? hr + 24 : hr) - 24) * 60;
            const j = (min - year.startMin) / year.stepMin;
            if (j < 0 || j > S - 1) continue;
            const y = PAD_T + (j / (S - 1)) * ph;
            c.fillText(`${String(hr).padStart(2, '0')}h`, PAD_L - 4, y);
            c.fillStyle = 'rgba(255,255,255,.06)';
            c.fillRect(PAD_L, Math.round(y), pw, 1);
            c.fillStyle = 'rgba(200,210,225,.75)';
        }
        // Months.
        c.textAlign = 'center';
        c.textBaseline = 'alphabetic';
        const zone = zoneOf();
        let prevMo = -1, monthX = PAD_L;
        for (let i = 0; i <= N; i++) {
            const z = i < N ? ui.zoned(year.firstMidnightMs + i * DAY + DAY / 2, zone) : null;
            if (z && z.mo === prevMo) continue;
            const x = PAD_L + (i / N) * pw;
            if (prevMo >= 0) {
                c.fillStyle = 'rgba(200,210,225,.75)';
                // A column is ~26 px: 'Nov', or Intl's narrow month outside English ('11', not 'Tháng 11').
                c.fillText(ui.fmtDate(year.firstMidnightMs + (i - 1) * DAY + DAY / 2, { month: locale() === 'en' ? 'short' : 'narrow' }, zone), (monthX + x) / 2, CHART_H - 4);
            }
            if (z && i > 0) { c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(Math.round(x), PAD_T, 1, ph); }
            monthX = x;
            prevMo = z ? z.mo : -1;
        }
        // Events for this planet.
        const evs = ui.events?.list || [];
        c.textBaseline = 'middle';
        for (const ev of evs) {
            if (ev.bodyId !== id || !EVENT_KINDS.has(ev.kind) || ev.bodyIds) continue;
            const i = nightIndex(ev.tMs);
            if (i < 0 || i >= N) continue;
            const x = PAD_L + ((i + 0.5) / N) * pw;
            const col = ev.kind === 'opposition' ? '#ffe28a' : ev.kind === 'brilliancy' ? '#fff3c4' : 'rgba(220,230,245,.9)';
            // A thin line through the night and a marker with its tag above the chart.
            c.fillStyle = 'rgba(255,255,255,.28)';
            c.fillRect(Math.round(x), PAD_T, 1, ph);
            c.fillStyle = col;
            c.beginPath(); c.moveTo(x - 4, PAD_T - 11); c.lineTo(x + 4, PAD_T - 11); c.lineTo(x, PAD_T - 3); c.closePath(); c.fill();
            c.textAlign = x > W - 44 ? 'right' : 'left';
            c.fillText(EVENT_TAG[ev.kind] ? t(EVENT_TAG[ev.kind]) : '', x + (x > W - 44 ? -6 : 6), PAD_T - 7);
        }
        // Tonight.
        const iNow = nightIndex(now);
        if (iNow >= 0 && iNow < N) {
            const x = PAD_L + ((iNow + 0.5) / N) * pw;
            c.fillStyle = 'rgba(124,196,255,.95)';
            c.fillRect(Math.round(x) - 0.5, PAD_T, 1.5, ph);
        }
    }

    function sentence(id) {
        const info = BODIES[BODY_INDEX[id]];
        const s = plannerSummary(year, id);
        peak = null;
        const name = t(info.name);
        if (!s || s.visibleNights === 0) return t('{body}: not well placed from here in the next 12 months (too low, or too close to the Sun).', { body: name });
        const zone = zoneOf();
        const nightMs = (i) => year.firstMidnightMs + i * DAY;
        // Intl's standalone month is capitalised in Vietnamese ('Tháng 8'); mid-sentence it is 'tháng 8'.
        const month = (ms) => { const m = ui.fmtDate(ms, { month: 'long' }, zone); return locale() === 'en' ? m : m.toLocaleLowerCase(); };
        const when = (i) => part(ui.zoned(nightMs(i) + DAY / 2, zone).d, month(nightMs(i) + DAY / 2));
        const yearOf = (i) => ui.zoned(nightMs(i) + DAY / 2, zone).y;
        let maxMin = 0;
        for (let i = s.bestFrom; i <= s.bestTo; i++) maxMin = Math.max(maxMin, s.minutes[i]);
        const bits = [];
        // The year, whenever the best stretch ends in another year than the chart's first night.
        const to = yearOf(s.bestTo) !== yearOf(0) ? t('{when} {year}', { when: when(s.bestTo), year: yearOf(s.bestTo) }) : when(s.bestTo);
        bits.push(s.bestFrom === s.bestTo ? t('best around {when}', { when: when(s.bestFrom) }) : t('best from {from} to {to}', { from: when(s.bestFrom), to }));
        bits.push(maxMin >= 90 ? t('up to {n} h a night in darkness', { n: Math.round(maxMin / 60) }) : t('up to {n} min a night in darkness', { n: maxMin }));
        if (s.peakNight >= 0) {
            const tPeak = nightMs(s.peakNight) + (year.startMin + s.peakSample * year.stepMin) * 60e3;
            peak = { tMs: tPeak };
            bits.push(t('highest {deg}° around {time} in {when}', { deg: Math.round(s.peakAltDeg), time: ui.fmtClock(tPeak), when: when(s.peakNight) }));
        }
        if (s.brightestNight >= 0 && Number.isFinite(s.brightestMag)) {
            bits.push(t('brightest {mag} in {when}', { mag: ui.fmt('fmtMag', s.brightestMag), when: when(s.brightestNight) }));
        }
        return `${name}: ${bits.join('; ')}.`;
    }

    // ---------------------------------------------------------------- update
    function update(snap, id) {
        shownId = id;
        const planet = !!id && PLANNER_BODIES.includes(id);
        const isSun = id === 'sun';
        el.hidden = !(planet || isSun);
        cv.hidden = summary.hidden = legend.hidden = !planet;
        if (isSun) {
            bestBtn.hidden = true;
            sunText.hidden = !sunKey;
            if (snap) requestSun(snap);
            return;
        }
        sunText.hidden = true;
        if (!planet || !snap) return;
        request(snap.tMs);
        if (!year) { setText(summary, t('Computing the year ahead…')); bestBtn.hidden = true; return; }
        const iNow = nightIndex(snap.tMs);
        const key = `${yearKey}|${id}|${iNow}|${ui.events?.list?.length ?? 0}|${el.open ? Math.round(cv.clientWidth) : 0}|${store.get().display?.hour12}`;
        if (key === drawKey) return;
        drawKey = key;
        if (el.open) draw(id, snap.tMs);
        const text = sentence(id);
        setText(summary, text);
        cv.setAttribute('aria-label', t('Visibility chart for the next 12 months. {text}', { text }));
        bestBtn.hidden = !peak;
    }

    function jumpTo(tMs, id) {
        if (!Number.isFinite(tMs) || !id) return;
        ui.act('jumpToEvent', { id: 'planner', kind: 'planner', tMs, title: '', detail: '', select: id, view: 'sky' });
    }

    offs.push(on(cv, 'click', (e) => {
        if (!year || !shownId || !PLANNER_BODIES.includes(shownId)) return;
        const r = cv.getBoundingClientRect();
        const W = r.width, ph = CHART_H - PAD_B - PAD_T, pw = W - PAD_L - 4;
        const x = e.clientX - r.left - PAD_L, y = (e.clientY - r.top) * (CHART_H / r.height) - PAD_T;
        if (x < 0 || x > pw) return;
        const i = Math.min(year.nights - 1, Math.max(0, Math.floor((x / pw) * year.nights)));
        const j = Math.min(year.samples - 1, Math.max(0, Math.round((Math.min(ph, Math.max(0, y)) / ph) * (year.samples - 1))));
        jumpTo(year.firstMidnightMs + i * DAY + (year.startMin + j * year.stepMin) * 60e3, shownId);
    }));
    offs.push(on(bestBtn, 'click', () => { if (peak) jumpTo(peak.tMs, shownId); }));
    offs.push(store.subscribe((s) => s.observer, () => { yearKey = ''; drawKey = ''; sunKey = ''; year = null; }));
    offs.push(ui.on('events', () => { drawKey = ''; if (ui.snap && shownId) update(ui.snap, shownId); }));

    return {
        el,
        update,
        destroy() {
            clearTimeout(timer);
            ac?.abort();
            offs.forEach((f) => f());
        },
    };
}
