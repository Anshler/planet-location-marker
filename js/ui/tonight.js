/**
 * Tonight: a dusk-to-dawn chart, one of Up now's Charts (ui/sky-now.js). The columns are the sky's
 * colour by the Sun's altitude (ui/sky-palette.js); each body has a lane whose ribbon shows when it
 * is up, more opaque the higher it stands; a dot marks its best moment; a line follows the clock,
 * and a drag scrubs time (a click jumps). The window runs from an hour before sunset to an hour
 * after sunrise, or the whole 24 h under the midnight sun and in polar night, with a note.
 *
 * Everything comes from the almanac's tonight() report (`ui.almanac.night.tonight.series`), so the
 * chart costs no extra computation. The sky and ribbons go at one pixel per CSS column into one
 * reused ImageData, rebuilt when the data, width or window changes. `drawSparkline` draws Up now's
 * 24-h sparklines from the same series. Nothing is drawn while hidden (`setShown`).
 *
 *   mountTonight(ctx) → {el, update(snap), setShown(on), destroy()}
 *
 * @module ui/tonight
 */

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { h, on, setText, setAttr, clamp } from './dom.js';
import { SKY_LUT, skyLutIndex, hexRgb } from './sky-palette.js';
import { t, N_, locale, intl } from '../core/i18n.js';

const HOUR = 3600e3;
const PAD_MS = HOUR;                 // context either side of the night
const GUTTER = 60;                   // the names column's least width, CSS px (wider for longer names)
const RIGHT = 6;
const TOP = 6, LANE = 15, RIBBON = 9, AXIS = 17;
const SUN_UP_DEG = -0.833;
const STEPS_H = [1, 2, 3, 6];
const VERDICT = {
    excellent: N_('excellent'), good: N_('good'), low: N_('low'), twilight: N_('in twilight only'), daytime: N_('by day only'), 'not-visible': N_('not visible'),
};
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * The chart's window for a tonight() result: an hour either side of sunset and sunrise, clipped
 * to its noon-to-noon grid; the whole grid under the midnight sun and in polar night.
 * @param {any} res tonight() result with `series`
 * @returns {{fromMs:number, toMs:number, kind:'night'|'midnight-sun'|'polar-night'} | null}
 */
export function nightWindow(res) {
    const s = res?.series;
    if (!s || !(s.n > 1) || !Number.isFinite(s.t0Ms)) return null;
    const first = s.t0Ms, last = s.t0Ms + (s.n - 1) * s.stepMs;
    const a = res.nightStartMs, b = res.nightEndMs;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { fromMs: first, toMs: last, kind: 'midnight-sun' };
    if (a <= first + 60e3 && b >= last - 60e3) return { fromMs: first, toMs: last, kind: 'polar-night' };
    return { fromMs: Math.max(first, a - PAD_MS), toMs: Math.min(last, b + PAD_MS), kind: 'night' };
}

/**
 * Altitude at tMs from a tonight series, linear between its samples; row −1 is the Sun. NaN
 * outside the series.
 * @param {{t0Ms:number, stepMs:number, n:number, alt:Float32Array, sunAlt:Float32Array}} s
 * @param {number} row
 * @param {number} tMs
 * @returns {number}
 */
export function seriesAlt(s, row, tMs) {
    const f = (tMs - s.t0Ms) / s.stepMs;
    if (!(f >= 0 && f <= s.n - 1)) return NaN;
    const i = Math.min(s.n - 2, Math.floor(f)), u = f - i;
    const v = row < 0 ? s.sunAlt : s.alt, o = row < 0 ? 0 : row * s.n;
    return v[o + i] * (1 - u) + v[o + i + 1] * u;
}

/**
 * A ribbon's opacity: clear below the horizon, a quarter at it, full from 60° up; a third of
 * that while the Sun is up.
 * @param {number} alt the body's altitude
 * @param {number} sunAlt the Sun's
 * @returns {number} 0..1
 */
export function ribbonAlpha(alt, sunAlt) {
    if (!(alt > 0)) return 0;
    const a = 0.25 + 0.75 * Math.min(1, alt / 60);
    return sunAlt > SUN_UP_DEG ? a / 3 : a;
}

/**
 * A 24-h altitude sparkline: the horizon, the curve (filled above the horizon) and a dot at
 * `nowMs`. Allocation-free.
 * @param {CanvasRenderingContext2D} c
 * @param {number} w CSS px
 * @param {number} hgt CSS px
 * @param {number} dpr
 * @param {any} s tonight series
 * @param {number} row −1 for the Sun
 * @param {number} nowMs
 * @param {string} color
 */
export function drawSparkline(c, w, hgt, dpr, s, row, nowMs, color) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hgt);
    const mid = hgt / 2, k = (mid - 1.5) / 90, n = s.n;
    const v = row < 0 ? s.sunAlt : s.alt, o = row < 0 ? 0 : row * n;
    const xs = w / (n - 1);
    c.beginPath();
    for (let i = 0; i < n; i++) {
        const y = mid - v[o + i] * k;
        if (i === 0) c.moveTo(0, y); else c.lineTo(i * xs, y);
    }
    // Above the horizon, filled.
    c.save();
    c.beginPath();
    c.rect(0, 0, w, mid);
    c.clip();
    c.beginPath();
    c.moveTo(0, mid);
    for (let i = 0; i < n; i++) c.lineTo(i * xs, mid - v[o + i] * k);
    c.lineTo(w, mid);
    c.closePath();
    c.globalAlpha = 0.28;
    c.fillStyle = color;
    c.fill();
    c.restore();
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(0, Math.round(mid * dpr) / dpr, w, 1 / dpr);
    c.beginPath();
    for (let i = 0; i < n; i++) {
        const y = mid - v[o + i] * k;
        if (i === 0) c.moveTo(0, y); else c.lineTo(i * xs, y);
    }
    c.strokeStyle = color;
    c.lineWidth = 1.25;
    c.globalAlpha = 0.9;
    c.stroke();
    c.globalAlpha = 1;
    const alt = seriesAlt(s, row, nowMs);
    if (alt === alt) {
        c.beginPath();
        c.arc(((nowMs - s.t0Ms) / ((n - 1) * s.stepMs)) * w, mid - alt * k, 2, 0, Math.PI * 2);
        c.fillStyle = '#fff';
        c.fill();
    }
}

/**
 * Mounts the Tonight card. The caller places `el` (Sky now puts it under the Sky dome) and
 * forwards its 4 Hz `update(snap)`.
 * @param {any} ctx UiCtx
 * @returns {{el: HTMLElement, update(snap:any): void, destroy(): void}}
 */
export function mountTonight(ctx) {
    const { store, clock, ui } = ctx;
    const offs = [];
    let open = false;
    const cv = h('canvas', { class: 'tonight__cv', role: 'img', 'aria-label': t('Tonight’s visibility chart') });
    const note = h('p', { class: 'note', hidden: true });
    const el = h('div', { class: 'tonight' }, cv, note, h('div', { class: 'charts__foot' }, h('details', { class: 'fold' }, h('summary', null, t('How to read this')),
        h('p', { class: 'note' }, t('Bars show when each is up, brighter the higher it stands; dots mark its best moment. Drag across to move through the night.')))));

    const c = cv.getContext('2d');
    const layer = document.createElement('canvas');
    const lc = layer.getContext('2d');
    let img = null;
    let src = null, res = null, win = null, rows = BODIES.length - 1;   // the height is kept while data is pending
    let layerKey = '';
    let cssW = 0, cssH = 0, dpr = 1, plotW = 0, sizeDirty = true, gutter = 0;
    let drawnX = NaN, drawnKey = '';
    let drag = null;
    const rgb = BODIES.map((b) => hexRgb(b.color));

    /** Shown in the open Charts card, or not: hidden, nothing is drawn. */
    function setShown(on_) {
        if (on_ === open) return;
        open = on_;
        sizeDirty = true;
        drawnKey = '';
        if (open && ui.snap) update(ui.snap);
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { sizeDirty = true; drawnKey = ''; if (ui.snap) update(ui.snap); }) : null;
    ro?.observe(cv);

    const xOf = (ms) => gutter + ((ms - win.fromMs) / (win.toMs - win.fromMs)) * plotW;
    const tOf = (x) => win.fromMs + clamp((x - gutter) / Math.max(1, plotW), 0, 1) * (win.toMs - win.fromMs);

    /** Measures the canvas only when something flagged it (no layout read per redraw). */
    function ensureSize() {
        if (!sizeDirty && ro) return;
        const w = Math.round(cv.clientWidth || cv.parentElement?.clientWidth || 320);
        const d = Math.min(2, globalThis.devicePixelRatio || 1);
        const hgt = TOP + rows * LANE + AXIS;
        sizeDirty = false;
        if (!gutter) {
            // The names column fits the locale's longest name ('Sao Thiên Vương'), measured once.
            c.font = `600 11px ${FONT}`;
            gutter = Math.max(GUTTER, ...BODIES.slice(1).map((b) => Math.ceil(c.measureText(ui.bodyName(b.id)).width) + 8));
        }
        if (w === cssW && hgt === cssH && d === dpr) return;
        cssW = w; cssH = hgt; dpr = d;
        plotW = Math.max(40, cssW - gutter - RIGHT);
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(cssH * dpr);
        cv.style.height = `${cssH}px`;
        layerKey = '';
    }

    /** The sky row and one ribbon row per body, one pixel per CSS column of the plot. */
    function buildLayer() {
        const s = res.series;
        const key = `${plotW}|${s.t0Ms}|${win.fromMs}|${win.toMs}`;
        if (key === layerKey && img) return;
        layerKey = key;
        if (!img || img.width !== plotW || img.height !== rows + 1) {
            layer.width = plotW; layer.height = rows + 1;
            img = lc.createImageData(plotW, rows + 1);
        }
        const px = img.data;
        for (let x = 0; x < plotW; x++) {
            const ms = win.fromMs + ((x + 0.5) / plotW) * (win.toMs - win.fromMs);
            const sun = seriesAlt(s, -1, ms);
            const li = skyLutIndex(sun);
            px[x * 4] = SKY_LUT[li]; px[x * 4 + 1] = SKY_LUT[li + 1]; px[x * 4 + 2] = SKY_LUT[li + 2]; px[x * 4 + 3] = 255;
            for (let r = 0; r < rows; r++) {
                const col = rgb[BODY_INDEX[s.ids[r]]] || rgb[1];
                const o = ((r + 1) * plotW + x) * 4;
                px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2];
                px[o + 3] = Math.round(255 * ribbonAlpha(seriesAlt(s, r, ms), sun));
            }
        }
        lc.putImageData(img, 0, 0);
    }

    function hourLabel(ms) {
        const z = ui.zoned(ms);
        if (store.get().display?.hour12) {
            return locale() === 'en' ? `${z.h % 12 || 12} ${z.h < 12 ? 'AM' : 'PM'}`
                : intl(Intl.DateTimeFormat, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 1, z.h));
        }
        return `${z.h < 10 ? '0' : ''}${z.h}:00`;
    }

    function draw(tNow) {
        ensureSize();
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, cssW, cssH);
        if (!res || !win) return;
        buildLayer();
        const plotH = rows * LANE;
        c.imageSmoothingEnabled = false;
        c.drawImage(layer, 0, 0, plotW, 1, gutter, TOP, plotW, plotH);
        for (let r = 0; r < rows; r++) {
            c.drawImage(layer, 0, r + 1, plotW, 1, gutter, TOP + r * LANE + (LANE - RIBBON) / 2, plotW, RIBBON);
        }
        // Hours in the display zone, spaced to fit.
        const span = win.toMs - win.fromMs;
        let step = 6 * HOUR;
        for (const hrs of STEPS_H) if (((hrs * HOUR) / span) * plotW >= 46) { step = hrs * HOUR; break; }
        const offMs = ui.zoned(win.fromMs + span / 2).offsetMin * 60e3;
        c.font = `10.5px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'alphabetic';
        for (let ms = Math.ceil((win.fromMs + offMs) / step) * step - offMs; ms <= win.toMs; ms += step) {
            const x = Math.round(xOf(ms)) + 0.5;
            c.fillStyle = 'rgba(255,255,255,0.08)';
            c.fillRect(x - 0.5, TOP, 1, plotH);
            if (x < gutter + 14 || x > gutter + plotW - 14) continue;
            c.fillStyle = 'rgba(154,166,184,0.95)';
            c.fillText(hourLabel(ms), x, TOP + plotH + 13);
        }
        // Names, and each body's best moment.
        c.textAlign = 'left';
        c.textBaseline = 'middle';
        c.font = `600 11px ${FONT}`;
        for (let r = 0; r < rows; r++) {
            const id = res.series.ids[r];
            const rep = res.reports[r];
            const y = TOP + r * LANE + LANE / 2;
            const seen = rep && rep.verdict !== 'not-visible';
            c.fillStyle = seen ? BODIES[BODY_INDEX[id]].color : 'rgba(154,166,184,0.8)';
            c.fillText(ui.bodyName(id), 2, y + 0.5);
            if (seen && Number.isFinite(rep.bestMs) && rep.bestMs >= win.fromMs && rep.bestMs <= win.toMs) {
                c.beginPath();
                c.arc(xOf(rep.bestMs), y, 3.4, 0, Math.PI * 2);
                c.fillStyle = '#fff';
                c.strokeStyle = 'rgba(0,0,0,0.6)';
                c.lineWidth = 1.5;
                c.stroke();
                c.fill();
            }
        }
        // The clock's time.
        drawnX = NaN;
        if (tNow >= win.fromMs && tNow <= win.toMs) {
            const x = Math.round(xOf(tNow) * dpr) / dpr;
            drawnX = x;
            c.fillStyle = 'rgba(124,196,255,0.95)';
            c.fillRect(x - 0.75, TOP - 2, 1.5, plotH + 4);
            c.beginPath();
            c.moveTo(x - 4, TOP - 5); c.lineTo(x + 4, TOP - 5); c.lineTo(x, TOP);
            c.closePath();
            c.fill();
        }
    }

    function describe() {
        const tw = res.twilight;
        const n = win.kind === 'night' ? '' : win.kind === 'polar-night' ? t('The Sun stays below the horizon all day: the chart shows the whole 24 hours.')
            : t('No darkness tonight: the Sun stays up, so the chart shows the whole 24 hours.');
        setText(note, n);
        note.hidden = !n;
        const bits = res.reports.map((r) => {
            const v = { body: ui.bodyName(r.id), verdict: VERDICT[r.verdict] ? t(VERDICT[r.verdict]) : r.verdict };
            return Number.isFinite(r.bestMs) ? t('{body} {verdict}, best at {time}', { ...v, time: ui.fmtClock(r.bestMs) }) : t('{body} {verdict}', v);
        });
        setAttr(cv, 'aria-label', `${win.kind === 'night' ? t('Tonight, sunset to sunrise {from} – {to}', { from: ui.fmtClock(tw?.sunsetMs ?? res.nightStartMs), to: ui.fmtClock(tw?.sunriseMs ?? res.nightEndMs) })
            : win.kind === 'polar-night' ? t('Tonight, polar night') : t('Tonight, no darkness')}. ${bits.join('. ')}.`);
    }

    function update(snap) {
        const r = ui.onMars() ? null : ui.almanac.night?.tonight ?? null;
        if (r !== src) {
            src = r;
            res = r?.series && Array.isArray(r.reports) ? r : null;
            win = res ? nightWindow(res) : null;
            if (res) rows = res.series.ids.length;
            layerKey = ''; drawnKey = ''; sizeDirty = true;
            if (res && win) describe();
            else note.hidden = true;
        }
        if (!open) return;
        const now = drag ? drag.t : (snap?.tMs ?? clock.tMs);
        const key = `${store.get().display?.hour12}|${ui.displayTz()}|${cssW}`;
        const x = res && win && now >= win.fromMs && now <= win.toMs ? xOf(now) : NaN;
        if (key === drawnKey && !sizeDirty && (Math.abs(x - drawnX) < 0.5 || (x !== x && drawnX !== drawnX))) return;
        drawnKey = key;
        draw(now);
    }

    // Dragging scrubs the clock across the night, as the time bar does; a click jumps there.
    let left = 0;
    offs.push(on(cv, 'pointerdown', (e) => {
        if (e.button > 0 || !res || !win) return;
        left = cv.getBoundingClientRect().left;
        if (e.clientX - left < gutter - 6) return;
        try { cv.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
        drag = { id: e.pointerId, x0: e.clientX, moved: false, paused: false, t: clock.tMs };
        ui.scrubbing = true;
    }));
    offs.push(on(cv, 'pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            cv.classList.add('is-dragging');
            if (clock.playing && !clock.range) { clock.pause(); drag.paused = true; }
        }
        drag.t = tOf(e.clientX - left);
        clock.setTime(drag.t);
        draw(drag.t);
    }));
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        cv.classList.remove('is-dragging');
        if (!d.moved && e.type === 'pointerup') {
            const target = tOf(e.clientX - left);
            clock.setTime(target, { animateMs: ui.reducedMotion() ? 0 : 400 });
        } else if (d.paused) clock.play();
        ui.scrubbing = false;
        ctx.bus?.emit?.('announce', t('Time: {time}', { time: ui.fmtSpoken(clock.tMs) }));
        drawnKey = '';
        update(ui.snap);
    };
    offs.push(on(cv, 'pointerup', endDrag));
    offs.push(on(cv, 'pointercancel', endDrag));
    offs.push(ui.on('display', () => { if (res && win) describe(); drawnKey = ''; }));

    return {
        el,
        update,
        setShown,
        destroy() {
            offs.forEach((off) => off());
            ro?.disconnect();
            el.remove();
        },
    };
}
