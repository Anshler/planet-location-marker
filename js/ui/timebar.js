/**
 * Time bar: step buttons (showing the unit), play, the date button (stamp, zone, chevron), the
 * accuracy badge, the speed and Live / "Return to now", over the scrubber. The date button (and the
 * loop chip's Edit, through `ui.openTime(section)`) opens the Time popover: Go to (in the display
 * zone; Julian before 15 Oct 1582, core/tz.js parseCalendarInput), Stepping, Loop between two
 * moments (a clock range), Show times in and a legend of the scrubber.
 *
 * Scrubber design: a fixed playhead over a timeline that scrolls with time.
 * The visible window depends on |rate| (±12 h, ±3 d, ±30 d, ±1 yr). Its
 * background is the sky's colour by the Sun's altitude at the observer (ui/sky-palette.js: day
 * blues, golden-hour amber, rose-violet civil, indigo nautical, near-black night; worker
 * `sunSeries`, with an analytic low-precision fallback so it is never blank); wide windows show
 * the seasonal day-length instead, because a day/night pattern cannot be resolved there. Up to
 * ±3 d, a thin band along the bottom marks when the Moon is up (brighter the fuller it is) and
 * one along the top when the selected planet is (its colour; worker `altSeries`). Event ticks
 * come from the event list, with gold bars over an eclipse's span. Dragging scrubs relative to
 * the window captured at drag start; release re-centres smoothly. Keyboard: ←/→ = window/48,
 * PageUp/PageDown = window/8.
 *
 * Drawing runs on requestAnimationFrame only while time is animating, the user
 * is dragging, or the re-centre tween runs; otherwise it redraws on demand.
 * The per-frame path reuses preallocated buffers (no typed-array churn), never reads layout
 * (the scrubber is measured when a ResizeObserver flags it), and slides the cached gradient row
 * instead of recomputing every column.
 *
 * @module ui/timebar
 */

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { h, on, setText, setAttr, clamp, openPopover, segmented, switchRow, tpl } from './dom.js';
import { icon, swapIcon } from './icons.js';
import { parseCalendarInput, toCalendar, fromCalendar } from '../core/tz.js';
import { createMarsTime, marsTimeTT, marsClockText, marsSunAltDeg, marsSiteNear } from '../astro/mars-clock.js';
import { SKY_LUT, skyLutIndex, smooth, hexRgb, C_DAY, C_NIGHT } from './sky-palette.js';

const MIN_MS = Date.UTC(1000, 0, 1);
const MAX_MS = Date.UTC(3000, 0, 1);
const HOUR = 3600e3;
const DAY = 86400e3;
const RAD = Math.PI / 180;
const RATE_MAX = 31557600;

/** Step units (`clock.step(kind)`): the popover's name, the buttons' unit, their names' phrase. */
export const STEP_UNITS = [
    { kind: 'minute', label: 'Minute', unit: '1 min', long: '1 minute' },
    { kind: 'hour', label: 'Hour', unit: '1 h', long: '1 hour' },
    { kind: 'day', label: 'Day', unit: '1 d', long: '1 day' },
    { kind: 'siderealDay', label: 'Sidereal day (23 h 56 min)', unit: '1 sid. day', long: '1 sidereal day' },
    { kind: 'month', label: 'Lunar month', unit: '1 mo', long: '1 lunar month' },
    { kind: 'year', label: 'Year', unit: '1 yr', long: '1 year' },
];

/**
 * The clock's zone as whole-phrase tpl() templates: [long form, short form (narrow bar, phone)].
 * @param {'observer'|'device'|'utc'} mode
 * @param {boolean} [approx] the observer's zone is estimated
 * @returns {[string, string]}
 */
export function zoneTemplates(mode, approx = false) {
    if (mode === 'utc') return ['UTC', 'UTC'];
    if (mode === 'device') return ['This device, {offset}', '{offset}'];
    return approx ? ['{place}, {offset} (approx.)', '{offset} (approx.)'] : ['{place}, {offset}', '{offset}'];
}

// The sky palette (SPEC F.2): golden hour, rose-violet civil, indigo nautical, near-black night.
const LUT = SKY_LUT;
const MOON_RGB = [0xd8, 0xdd, 0xe6];
const MOON_UP_DEG = -0.27;          // the Moon's upper limb on the refracted horizon
const BAND_PX = 3;                  // the Moon and selected-body bands, CSS px

/** Event-kind colours for scrubber ticks. */
function tickColor(ev) {
    switch (ev.kind) {
        case 'moon-phase': case 'occultation': case 'lunar-apsis': return '#d8dde6';
        case 'lunar-eclipse': return '#ff8a65';
        case 'solar-eclipse': case 'local-solar-eclipse': case 'transit': return '#ffcc66';
        case 'equinox': case 'solstice': return '#7cc4ff';
        case 'meteor-shower': return '#9fd4ff';
        default: return (ev.bodyId && BODIES[BODY_INDEX[ev.bodyId]]?.color) || '#c9d4e3';
    }
}

/**
 * Low-precision solar altitude (Astronomical Almanac formulae, ~0.1° near the
 * present). Only a fallback for the scrubber gradient until the worker series lands.
 */
function sunAltApprox(tMs, latDeg, lonDeg) {
    const d = (tMs - 946728000000) / 86400000;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 0.00000036 * d) * RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ha = (280.46061837 + 360.98564736629 * d + lonDeg) * RAD - ra;
    const la = latDeg * RAD;
    return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / RAD;
}

/**
 * The Moon's illuminated fraction, low precision (Meeus 48.4 with its leading terms, ~1 %): how
 * bright the scrubber's Moon band is at an instant.
 * @param {number} tMs
 * @returns {number} 0 (new) … 1 (full)
 */
export function moonLitApprox(tMs) {
    const T = (tMs - 946728000000) / 3155760000000;
    const D = (297.8501921 + 445267.1114034 * T) * RAD;
    const M = (357.5291092 + 35999.0502909 * T) * RAD;
    const Mp = (134.9633964 + 477198.8675055 * T) * RAD;
    const i = Math.PI - D - (6.289 * Math.sin(Mp) - 2.1 * Math.sin(M) + 1.274 * Math.sin(2 * D - Mp)
        + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * Mp) + 0.11 * Math.sin(D)) * RAD;
    return (1 + Math.cos(i)) / 2;
}

/**
 * The span an eclipse covers on the time axis: a local solar eclipse from first to last contact
 * here, a lunar eclipse through its umbral phase (else the penumbral one). Writes `out` and
 * returns true, or false for any other event.
 * @param {any} ev AstroEvent
 * @param {{from:number, to:number}} out
 * @returns {boolean}
 */
export function eclipseSpan(ev, out) {
    let a = NaN, b = NaN;
    if (ev?.kind === 'local-solar-eclipse') { a = ev.c1Ms; b = ev.c4Ms; }
    else if (ev?.kind === 'lunar-eclipse') {
        a = Number.isFinite(ev.u1Ms) ? ev.u1Ms : ev.p1Ms;
        b = Number.isFinite(ev.u4Ms) ? ev.u4Ms : ev.p4Ms;
    }
    if (!(Number.isFinite(a) && Number.isFinite(b) && b > a)) return false;
    out.from = a; out.to = b;
    return true;
}

// Standing on Mars (store.host): the scrubber's day/night strip and the stamp follow the Martian
// site's Sun and clock (astro/mars-clock.js). TT ≈ UT + 69.2 s is plenty for a colour strip.
const MT = createMarsTime();
const ttDaysApprox = (tMs) => (tMs - 946728000000) / 86400000 + 69.2 / 86400;
function marsSunAlt(tMs, latDeg, lonDeg) {
    return marsSunAltDeg(marsTimeTT(ttDaysApprox(tMs), lonDeg, MT), latDeg);
}
/** Fraction of the sol the Sun is up at a Martian latitude. */
function marsDayFraction(tMs, latDeg) {
    const dec = marsTimeTT(ttDaysApprox(tMs), 0, MT).solarDecDeg * RAD;
    const la = clamp(latDeg, -89.9, 89.9) * RAD;
    const cosH = (Math.sin(-0.3 * RAD) - Math.sin(la) * Math.sin(dec)) / (Math.cos(la) * Math.cos(dec));
    if (cosH >= 1) return 0;
    if (cosH <= -1) return 1;
    return Math.acos(cosH) / Math.PI;
}

/** Fraction of the day the Sun is up (0 = polar night, 1 = midnight sun). */
function dayFraction(tMs, latDeg) {
    const d = (tMs - 946728000000) / 86400000;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const dec = Math.asin(Math.sin(23.439 * RAD) * Math.sin(L));
    const la = clamp(latDeg, -89.9, 89.9) * RAD;
    const cosH = (Math.sin(-0.833 * RAD) - Math.sin(la) * Math.sin(dec)) / (Math.cos(la) * Math.cos(dec));
    if (cosH >= 1) return 0;
    if (cosH <= -1) return 1;
    return Math.acos(cosH) / Math.PI;
}

/** Half-width of the scrubber window for a rate (SPEC F.2). */
export function halfWindowFor(rate) {
    const r = Math.abs(rate || 1);
    if (r <= 600) return 12 * HOUR;
    if (r <= 21600) return 3 * DAY;
    if (r <= 604800) return 30 * DAY;
    return 365.25 * DAY;
}

/**
 * Re-aims a cached gradient row (RGBA, a pixel per column) at a window now starting at `start`:
 * under half a column keeps it, more shifts it by whole columns. Sets `out` to the columns left to
 * compute, [from, to), and `cache.start` to the start the row now shows. Allocation-free. `data`
 * may hold several rows (the bands): pixels carried across row ends land only in `out`'s columns.
 * @param {{start: number}} cache
 * @param {Uint8ClampedArray} data `rows * width * 4` bytes
 * @param {number} width columns
 * @param {number} colMs window span / width
 * @param {number} start
 * @param {{from: number, to: number}} out
 * @returns {{from: number, to: number}} `out`
 */
export function slideGradientRow(cache, data, width, colMs, start, out) {
    const k = Math.round((start - cache.start) / colMs);
    out.from = 0; out.to = 0;
    if (k === 0) return out;
    const end = data.length;
    if (k > 0 && k < width) {
        data.copyWithin(0, k * 4, end);
        out.from = width - k; out.to = width;
        cache.start += k * colMs;
    } else if (k < 0 && -k < width) {
        data.copyWithin(-k * 4, 0, end + k * 4);
        out.to = -k;
        cache.start += k * colMs;
    } else {
        out.to = width;
        cache.start = start;
    }
    return out;
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;
const easeOutCubic = (x) => 1 - (1 - x) ** 3;

/**
 * Mounts the time bar and its Time popover, which `ui.openTime(section)` opens too.
 * @param {HTMLElement} root `<section class="timebar">`
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void}}
 */
export function mountTimebar(root, ctx) {
    const { store, clock, ui } = ctx;
    const offs = [];
    let unit = STEP_UNITS[1];

    // ================================================================ the bar
    const iconBtn = (cls, label, name, size, kbdHint) => h('button', {
        class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, 'data-tip': label, 'data-kbd': kbdHint,
    }, icon(name, { size }));
    // The step buttons name their unit; the tooltip's second line gives the modifiers (CSS data-tip2).
    const unitBack = h('span', { class: 'tb-step__unit' });
    const unitFwd = h('span', { class: 'tb-step__unit' });
    const stepBtn = (cls, key, ...kids) => h('button', {
        class: `icon-btn tb-step ${cls}`, type: 'button', 'data-kbd': key, 'data-tip2': 'Shift: 1 day · Alt: 1 sidereal day',
    }, ...kids);
    const btnBack = stepBtn('tb-back', ',', icon('step-back', { size: 20 }), unitBack);
    const btnFwd = stepBtn('tb-fwd', '.', unitFwd, icon('step-fwd', { size: 20 }));
    const btnPlay = iconBtn('tb-play icon-btn--primary', 'Pause', 'pause', 20, 'Space');
    const btnSlower = iconBtn('icon-btn--sm', 'Slower', 'minus', 16, '[');
    const rateOut = h('output', { class: 'tb-rate__value', 'aria-live': 'off' }, 'Real time');
    const btnFaster = iconBtn('icon-btn--sm', 'Faster', 'plus', 16, ']');
    const rateGroup = h('div', { class: 'tb-rate', role: 'group', 'aria-label': 'Speed' }, btnSlower, rateOut, btnFaster);

    const stampDay = h('span', { class: 'stamp__day' });
    // Before 15 Oct 1582 the date is Julian, as records give it; the tag says so (title: the Gregorian date).
    const stampCal = h('span', { class: 'stamp__cal', hidden: true }, 'Julian');
    const stampTime = h('span', { class: 'stamp__time' });
    // The zone the clock shows: the long form, or the short one in a narrow bar and on the phone (CSS).
    const zoneLong = h('span', { class: 'stamp__zl' });
    const zoneShort = h('span', { class: 'stamp__zs' });
    // Standing on Mars: the site's mission sol (or Mars Sol Date) and local mean solar time.
    const stampMars = h('span', { class: 'tb-sol', hidden: true, title: 'Local mean solar time at the Martian site (Allison & McEwen 2000, as Mars24)' });
    const dateBtn = h('button', {
        class: 'tb-date', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'pop-time',
        'data-tip': 'Go to a date, step, loop or change the time zone',
    }, h('span', { class: 'tb-date__icon' }, icon('calendar', { size: 18 })),
    h('span', { class: 'stamp' }, stampDay, stampCal, h('span', { class: 'stamp__sep', 'aria-hidden': 'true' }, '·'), stampTime,
        h('span', { class: 'stamp__zone' }, zoneLong, zoneShort), icon('chevron-down', { size: 16, className: 'tb-date__chev' })), stampMars);
    const badge = h('span', { class: 'badge badge--warn tb-accuracy', hidden: true, title: 'Planet positions are most accurate between 1800 and 2200' },
        icon('warning', { size: 14 }), h('span', { class: 'tb-accuracy__text' }, 'Reduced accuracy'));
    const livePill = h('span', { class: 'badge badge--live', role: 'status', 'aria-label': 'Live: showing the current time' },
        h('span', { class: 'badge__pulse', 'aria-hidden': 'true' }), 'LIVE');
    const nowBtn = h('button', { class: 'btn btn--now', type: 'button', 'data-tip': 'Back to the current time', 'data-kbd': 'N' },
        icon('live', { size: 18 }), h('span', { class: 'btn--now__long' }, 'Return to now'), h('span', { class: 'btn--now__short' }, 'Now'));
    const liveWrap = h('div', { class: 'tb-live' }, livePill, nowBtn);
    const rowMain = h('div', { class: 'tb-row tb-main' });

    // ================================================================ scrubber
    const canvas = h('canvas', { class: 'tb-scrub__canvas', 'aria-hidden': 'true' });
    const thumb = h('span', { class: 'tb-scrub__thumb', 'aria-hidden': 'true' }, h('span', { class: 'tb-scrub__knob' }));
    const tip = h('span', { class: 'tb-scrub__tip', 'aria-hidden': 'true', hidden: true });
    const scrub = h('div', {
        class: 'tb-scrub', role: 'slider', tabindex: '0', 'aria-label': 'Time',
        'aria-valuemin': '0', 'aria-valuemax': '1', 'aria-valuenow': '0',
    }, canvas, thumb, tip);
    root.append(rowMain, scrub);

    // ================================================================ the Time popover (§4.5)
    const dtInput = () => h('input', { class: 'input', type: 'datetime-local', step: '1', min: '1000-01-01T00:00', max: '3000-01-01T00:00' });
    const field = (label, control, cls = 'field') => h('label', { class: cls }, h('span', { class: 'field__label' }, label), control);
    const title = (text) => h('h3', { class: 'group-title' }, text);
    const zoneSpan = () => h('span', { class: 'pop__zone' });

    // Go to.
    const dateInput = dtInput();
    const zoneGo = zoneSpan();
    // The native picker is Gregorian: a Julian-only day (29 Feb 1500) needs the text entry.
    const julBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Type a Julian date');
    const quick = h('div', { class: 'pop__quick', role: 'group', 'aria-label': 'Quick jumps' });
    const accuracy = h('p', { class: 'note pt__warn', hidden: true }, icon('warning', { size: 14 }), 'Positions are less accurate before 1800 and after 2200.');
    const goForm = h('form', { class: 'pt__sec', novalidate: true }, title('Go to'),
        h('div', { class: 'pt__row' }, field(tpl('Date and time ({zone})', { zone: zoneGo }), dateInput, 'field pt__grow'),
            h('button', { class: 'btn btn--primary', type: 'submit' }, 'Go')),
        quick,
        h('p', { class: 'note' }, tpl('Dates before 15 October 1582 are Julian. {button}', { button: julBtn })),
        accuracy);

    // Stepping.
    const unitSel = h('select', { class: 'select' }, STEP_UNITS.map((u) => h('option', { value: u.kind }, u.label)));
    const runs = segmented({
        label: 'Time runs', options: [{ value: 'fwd', label: 'Forward' }, { value: 'back', label: 'Backward' }], value: 'fwd',
        onChange: (v) => { if ((v === 'back') !== (clock.rate < 0)) clock.reverse(); syncControls(); },
    });
    // Phone only: the bar has no step buttons there, so arrange() moves them in here.
    const stepRow = h('div', { class: 'pt__row pt__steps', hidden: true });
    const stepping = h('div', { class: 'pt__sec' }, title('Stepping'),
        field('Step buttons move by', unitSel, 'pt__row'),
        h('p', { class: 'note for-fine' }, 'Shift-click: 1 day. Alt-click: 1 sidereal day.'),
        h('div', { class: 'pt__row' }, h('span', { class: 'field__label', 'aria-hidden': 'true' }, 'Time runs'), runs.el, h('kbd', { class: 'kbd' }, 'R')),
        stepRow);

    // Loop between two moments.
    const fromInput = dtInput();
    const toInput = dtInput();
    const durInput = h('input', { class: 'input input--num', type: 'number', min: '1', max: '600', step: '1', value: '10', inputmode: 'numeric' });
    let playback = 'loop';
    const playSeg = segmented({
        label: 'Playback', options: [{ value: 'loop', label: 'Loop' }, { value: 'pingpong', label: 'Back and forth' }, { value: 'once', label: 'Once' }],
        value: playback, onChange: (v) => { playback = v; },
    });
    const zoneLoop = zoneSpan();
    const lapseErr = h('p', { class: 'pop__error', role: 'alert', hidden: true });
    const stopBtn = h('button', { class: 'btn btn--ghost', type: 'button', hidden: true }, 'Stop');
    const loopForm = h('form', { class: 'pt__body', novalidate: true },
        h('p', { class: 'note' }, tpl('Times are in {zone}.', { zone: zoneLoop })),
        field('From', fromInput), field('To', toInput),
        h('label', { class: 'field__label pt__row' }, tpl('One loop takes {seconds} s', { seconds: durInput })),
        playSeg.el,
        lapseErr,
        h('div', { class: 'pt__row pt__end' }, stopBtn, h('button', { class: 'btn btn--primary', type: 'submit' }, icon('play', { size: 14 }), 'Start')));
    const loopBox = h('details', { class: 'fold' }, h('summary', null, 'Loop between two moments'), loopForm);

    // Show times in.
    const tzSeg = segmented({
        label: 'Show times in', className: 'seg--fit', options: [{ value: 'observer', label: 'Your place' }, { value: 'device', label: 'This device' }, { value: 'utc', label: 'UTC' }],
        value: 'observer',
        onChange: (v) => { ui.act('setTzMode', v); ctx.bus.emit('announce', `Times in ${zoneText}.`); },
    });
    const clock24 = switchRow({
        label: '24-hour clock', checked: !store.get().display?.hour12,
        onChange: (on24) => store.set({ display: { ...store.get().display, hour12: !on24 } }),
    });
    const legend = h('details', { class: 'fold' }, h('summary', null, 'What the time bar shows'),
        h('ul', { class: 'pt__body pt__legend' }, ['The colour is the Sun’s height: day, twilight, night.', 'The top edge shows when the selected planet is up.',
            'The bottom edge shows when the Moon is up.', 'Gold bars are eclipses, and ticks are events.'].map((t) => h('li', null, t))));

    const closeBtn = iconBtn('icon-btn--sm', 'Close', 'close', 16);
    const pop = h('div', { class: 'popover pop-time', id: 'pop-time', role: 'dialog', 'aria-labelledby': 'pop-time-title', hidden: true },
        h('div', { class: 'pt__head' }, h('h2', { class: 'pt__title', id: 'pop-time-title' }, 'Time'), closeBtn),
        goForm, stepping, loopBox,
        h('div', { class: 'pt__sec' }, title('Show times in'), tzSeg.el, clock24.el),
        legend);
    (ui.root || document.body).append(pop);

    // ================================================================ arrangement per layout
    function arrange(layout) {
        if (layout === 'mobile') {
            rowMain.replaceChildren(btnPlay, dateBtn, badge, rateGroup, liveWrap);
            stepRow.replaceChildren(btnBack, btnFwd);
        } else {
            // Three zones: transport · date and zone · speed and live.
            rowMain.replaceChildren(h('div', { class: 'tb-zone tb-zone--left' }, btnBack, btnPlay, btnFwd),
                h('div', { class: 'tb-zone tb-zone--center' }, dateBtn, badge), h('div', { class: 'tb-zone tb-zone--right' }, rateGroup, liveWrap));
        }
        stepRow.hidden = layout !== 'mobile';
        geomDirty = true;
        syncControls(true); // the rate label is compact and the step buttons spelled out on the phone
        kick();
    }

    // ================================================================ control actions
    const reduced = () => ui.reducedMotion();
    const stepKind = (e) => (e.altKey ? 'siderealDay' : e.shiftKey ? 'day' : unit.kind);
    offs.push(on(btnPlay, 'click', () => { clock.toggle(); syncControls(); }));
    offs.push(on(btnBack, 'click', (e) => { clock.step(stepKind(e), -1); kick(); }));
    offs.push(on(btnFwd, 'click', (e) => { clock.step(stepKind(e), 1); kick(); }));
    offs.push(on(unitSel, 'change', () => {
        unit = STEP_UNITS.find((u) => u.kind === unitSel.value) || STEP_UNITS[1];
        syncControls();
    }));
    offs.push(on(btnSlower, 'click', () => { clock.slower(); syncControls(); }));
    offs.push(on(btnFaster, 'click', () => { clock.faster(); syncControls(); }));
    offs.push(on(nowBtn, 'click', () => { clock.goLive(); syncControls(); }));

    // -- the popover ----------------------------------------------------------
    let popCtl = null;
    /** The display calendar's date and time (Julian before 15 Oct 1582: ui.zoned). */
    function toInputValue(ms) {
        const z = ui.zoned(clamp(ms, MIN_MS, MAX_MS - 1000));
        return `${String(z.y).padStart(4, '0')}-${pad2(z.mo)}-${pad2(z.d)}T${pad2(z.h)}:${pad2(z.mi)}:${pad2(z.s)}`;
    }
    /** A typed date: on or before 4 Oct 1582 it is Julian, from 15 Oct Gregorian (tz.parseCalendarInput). */
    function fromInputValue(v) {
        const p = parseCalendarInput(v || '');
        return p ? ui.toUtc(p) : NaN;
    }
    /**
     * The native picker is Gregorian and refuses Julian-only days (29 Feb 1500), so an input showing
     * a Julian date becomes a text field ('1066-04-24T20:00:00' or '24 Apr 1066 20:00').
     */
    function inputFor(input, ms) {
        const jul = ui.zoned(clamp(ms, MIN_MS, MAX_MS - 1000)).cal === 'julian';
        const type = jul ? 'text' : 'datetime-local';
        if (input.type !== type) input.type = type;
        input.placeholder = jul ? 'YYYY-MM-DD HH:MM (Julian)' : '';
        input.value = toInputValue(ms);
    }
    function quickJumps() {
        const tw = ui.almanac.night?.twilight;
        const z = ui.zoned(clock.tMs);
        const items = [['Now', null], ['Sunset', tw?.sunsetMs], ['Midnight', ui.toUtc({ y: z.y, mo: z.mo, d: z.d + 1, h: 0, mi: 0, s: 0, cal: z.cal })],
            ['Sunrise', tw?.sunriseMs]].filter(([, ms]) => ms === null || Number.isFinite(ms));
        quick.replaceChildren(...items.map(([label, ms]) => h('button', {
            class: 'chip', type: 'button',
            onClick: () => { if (ms === null) clock.goLive(); else jumpTo(ms); closeTime(); },
        }, h('span', null, label), ms !== null ? h('span', { class: 'chip__meta' }, ui.fmtClock(ms)) : null)));
    }
    function jumpTo(ms) {
        if (!Number.isFinite(ms)) return;
        const target = clamp(ms, MIN_MS, MAX_MS);
        const dist = Math.abs(target - clock.tMs);
        clock.setTime(target, { animateMs: reduced() || dist < 60e3 ? 0 : clamp(500 + Math.log10(1 + dist / HOUR) * 450, 500, 1600) });
        kick();
    }
    /** What each section focuses when `ui.openTime(section)` opens it. */
    const FIRST = { go: () => dateInput, step: () => unitSel, loop: () => fromInput, zone: () => tzSeg.el.querySelector('[tabindex="0"]') };
    /** Opens the Time popover at a section ('go' | 'step' | 'loop' | 'zone') and focuses its first control. */
    function openTime(section = 'go') {
        if (!popCtl) {
            inputFor(dateInput, clock.tMs);
            julBtn.hidden = dateInput.type === 'text';
            dateInput.removeAttribute('aria-invalid');
            quickJumps();
            const r = clock.range;
            inputFor(fromInput, r ? r.fromMs : clock.tMs);
            inputFor(toInput, r ? r.toMs : clock.tMs + DAY);
            durInput.value = String(r ? Math.round(r.durationS) : 10);
            playback = r?.loop || 'loop';
            playSeg.set(playback);
            lapseErr.hidden = true;
            loopBox.open = !!r;
            popCtl = openPopover(dateBtn, pop, { placement: 'top', within: root, focus: false, onClose: () => { popCtl = null; } });
            syncPop();
        }
        if (section === 'loop') loopBox.open = true;
        popCtl.reposition();
        const el = (FIRST[section] || FIRST.go)();
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: 'nearest' });
    }
    function closeTime() { popCtl?.close(); }
    ui.openTime = openTime;
    offs.push(on(dateBtn, 'click', () => (popCtl ? closeTime() : openTime())));
    offs.push(on(closeBtn, 'click', closeTime));
    for (const d of [loopBox, legend]) offs.push(on(d, 'toggle', () => popCtl?.reposition()));
    offs.push(on(julBtn, 'click', () => {
        const v = dateInput.value || toInputValue(clock.tMs);
        dateInput.type = 'text';
        dateInput.placeholder = 'YYYY-MM-DD HH:MM (Julian before 15 Oct 1582)';
        dateInput.value = v;
        dateInput.removeAttribute('aria-invalid');
        julBtn.hidden = true;
        dateInput.focus();
    }));
    offs.push(on(goForm, 'submit', (e) => {
        e.preventDefault();
        const ms = fromInputValue(dateInput.value);
        if (!Number.isFinite(ms)) { dateInput.setAttribute('aria-invalid', 'true'); dateInput.focus(); return; }
        jumpTo(ms);
        closeTime();
    }));
    offs.push(on(stopBtn, 'click', () => { clock.setRange(null); closeTime(); syncControls(); }));
    offs.push(on(loopForm, 'submit', (e) => {
        e.preventDefault();
        let a = fromInputValue(fromInput.value), b = fromInputValue(toInput.value);
        const dur = clamp(Math.round(Number(durInput.value) || 10), 1, 600);
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            lapseErr.textContent = 'Enter both a start and an end time.';
            lapseErr.hidden = false;
            return;
        }
        if (b < a) [a, b] = [b, a];
        if (b - a < 60e3) b = a + HOUR;
        a = clamp(a, MIN_MS, MAX_MS); b = clamp(b, MIN_MS, MAX_MS);
        clock.setRange({ fromMs: a, toMs: b, durationS: dur, loop: playback });
        if (!clock.playing) clock.play();
        closeTime();
        syncControls();
    }));

    // ================================================================ control state
    let lastStampAt = 0;
    let lastYear = NaN;
    let zoneMode = '', zoneOff = NaN;
    let zoneText = '';               // the zone's long form: accessible names, the popover, announcements
    let zoneFit = null;              // [long template, place, short form, offset] for fitZone
    function syncControls(force = false) {
        const { playing, live, rate, range } = clock;
        const mobile = ui.layout === 'mobile';
        swapIcon(btnPlay, playing ? 'pause' : 'play', 20);
        setAttr(btnPlay, 'aria-label', playing ? 'Pause' : 'Play');
        btnPlay.dataset.tip = playing ? 'Pause' : 'Play';
        setAttr(btnBack, 'aria-label', `Step back ${unit.long}`);
        setAttr(btnFwd, 'aria-label', `Step forward ${unit.long}`);
        btnBack.dataset.tip = `Back ${unit.long}`;
        btnFwd.dataset.tip = `Forward ${unit.long}`;
        // In the bar the unit alone ('1 h'); in the phone's popover the whole phrase.
        setText(unitBack, mobile ? `Back ${unit.long}` : unit.unit);
        setText(unitFwd, mobile ? `Forward ${unit.long}` : unit.unit);
        // The phone row is tight: real time reads '1×' there so the date keeps its year.
        const rateText = range ? (range.loop === 'once' ? 'Playing' : 'Loop') : ui.fmt('fmtRate', rate, { compact: mobile });
        setText(rateOut, rateText);
        setAttr(rateOut, 'aria-label', playing ? `Speed: ${rateText}` : `Speed: ${rateText}, paused`);
        rateOut.classList.toggle('is-reverse', rate < 0 && !range);
        rateOut.classList.toggle('is-paused', !playing);
        btnSlower.disabled = !!range || rate <= -RATE_MAX;
        btnFaster.disabled = !!range || rate >= RATE_MAX;
        // The ladder goes from 1× to −1×: the next Slower turns time around.
        btnSlower.dataset.tip = rate > 0 && rate <= 1 ? 'Slower (then backward)' : 'Slower';
        livePill.hidden = !live;
        nowBtn.hidden = live;
        stampTime.classList.toggle('is-h12', !!store.get().display?.hour12);
        syncStamp(force);
        if (popCtl) syncPop();
    }
    /** The popover's state from the clock and the store (while it is open). */
    function syncPop() {
        const st = store.get();
        if (unitSel.value !== unit.kind) unitSel.value = unit.kind;
        runs.set(clock.rate < 0 ? 'back' : 'fwd');
        stopBtn.hidden = !clock.range;
        accuracy.hidden = badge.hidden;
        tzSeg.set(st.display?.tzMode || 'observer');
        setText(tzSeg.el.firstChild, ui.placeShort(st.observer) || 'Your place');
        clock24.set(!st.display?.hour12);
    }
    /** The zone's long and short forms (zoneTemplates) in the date button and the popover. */
    function syncZone(t, mode) {
        const obs = store.get().observer;
        const [long, short] = zoneTemplates(mode, !!obs?.tzApprox);
        const offset = ui.offsetText(t);
        const place = ui.placeShort(obs) || 'Your place';
        const text = tpl(long, { place, offset }).textContent;
        if (text === zoneText) return;
        zoneText = zoneLong.textContent = text;
        zoneFit = [long, place, tpl(short, { offset }).textContent, offset];
        setText(zoneShort, zoneFit[2]);
        setText(zoneGo, text);
        setText(zoneLoop, text);
        fitZone();
    }
    /**
     * The place gives way before the offset does. It is cut here, not by CSS's ellipsis, which can
     * leave a glyph's gap before the comma; with room for under six letters the short form shows.
     */
    function fitZone() {
        const [long, place, short, offset] = zoneFit || [];
        if (!long?.includes('{place}')) return;
        let pl = zoneLong.firstElementChild;
        if (pl?.textContent === place && pl.scrollWidth <= pl.clientWidth) return;
        pl = h('span', { class: 'stamp__place' }, place);
        zoneLong.replaceChildren(tpl(long, { place: pl, offset }));
        const w = pl.clientWidth;
        if (!w || pl.scrollWidth <= w) return;
        let lo = 0, hi = place.length;
        while (lo < hi) {
            const m = (lo + hi + 1) >> 1;
            pl.textContent = `${place.slice(0, m).trimEnd()}…`;
            if (pl.scrollWidth < w) lo = m; else hi = m - 1;
        }
        if (lo > 5) pl.textContent = `${place.slice(0, lo).trimEnd()}…`; else zoneLong.textContent = short;
    }
    function syncStamp(force) {
        const now = performance.now();
        if (!force && now - lastStampAt < 90) return;
        lastStampAt = now;
        const t = clock.tMs;
        const z = ui.zoned(t);
        setText(stampDay, ui.fmtDay(t));
        setText(stampTime, ui.fmtClock(t, { seconds: true }));
        const jul = z.cal === 'julian';
        if (stampCal.hidden === jul) stampCal.hidden = !jul;
        if (jul) {
            const g = new Date(t + z.offsetMin * 60e3);
            const tipText = `Julian calendar, as records of the time give it. Gregorian (proleptic): ${g.getUTCDate()} ${ui.MONTHS[g.getUTCMonth()]} ${g.getUTCFullYear()}`;
            if (stampCal.title !== tipText) stampCal.title = tipText;
        }
        const st = store.get();
        const mode = st.display?.tzMode || 'observer';
        if (force || mode !== zoneMode || z.offsetMin !== zoneOff) { zoneMode = mode; zoneOff = z.offsetMin; syncZone(t, mode); }
        const stamp = ui.fmtSpoken(t);
        const host = st.host;
        const mars = host?.id === 'mars';
        if (stampMars.hidden === mars) stampMars.hidden = !mars;
        let sol = '';
        if (mars) {
            const site = marsSiteNear(host.latDeg, host.lonDeg, 0.5);
            sol = marsClockText(marsTimeTT(ttDaysApprox(t), host.lonDeg, MT), site ? { ...site, lonDeg: host.lonDeg } : { lonDeg: host.lonDeg }).text;
            setText(stampMars, sol);
        }
        setAttr(dateBtn, 'aria-label', mars ? `Earth date and time: ${stamp}, ${zoneText}. On Mars: ${sol}. Open the time panel`
            : jul ? `Date and time: ${stamp} (Julian calendar), ${zoneText}. Open the time panel`
                : `Date and time: ${stamp}, ${zoneText}. Open the time panel`);
        const y = new Date(t).getUTCFullYear();
        if (y !== lastYear) {
            lastYear = y;
            badge.hidden = !(y < 1800 || y > 2200);
        }
    }

    // ================================================================ scrubber engine
    const g2d = canvas.getContext('2d', { alpha: true });
    // Three rows: the gradient (0), the Moon band (1) and the selected body's band (2).
    const lineCanvas = document.createElement('canvas');
    lineCanvas.height = 3;
    const lineCtx = lineCanvas.getContext('2d');
    let lineImg = null;
    let cssW = 0, cssH = 0, dpr = 1;
    // Set by the ResizeObserver, window resizes and layout switches. Without a ResizeObserver
    // the scrubber is measured on every draw, as a fallback.
    let geomDirty = true;
    const observesSize = typeof ResizeObserver === 'function';
    let scrubLeft = 0;                // viewport x of the scrubber, read with its first size and per gesture
    let geom = { tickY: 0, trackY: 10, trackH: 18, labelY: 34 };
    // Altitude series from the worker: the Sun's (the gradient), the Moon's and the selected
    // planet's (the bands; ROADMAP sky-ribbon-scrubber), each over three windows around the view.
    const newSeries = (id) => ({ id, fromMs: 0, toMs: 0, n: 0, values: null, key: '', ctl: null, last: 0, fails: 0 });
    const series = newSeries('sun');
    const moonSeries = newSeries('moon');
    const bodySeries = newSeries('');
    let seriesRev = 0;                // bumped whenever a series gets new values (gradient cache key)
    let bodyRgb = MOON_RGB;
    // Gradient cache: `lineImg` holds the gradient of a window that started at `grad.start`.
    // While the window slides, whole columns are shifted and only the exposed ones computed.
    const grad = { start: 0, span: 0, width: 0, wide: false, useSeries: false, rev: -1, obsKey: '' };
    const gradCols = { from: 0, to: 0 };
    let sheen = null, sheenY = -1, sheenH = -1;
    const spanScratch = { from: 0, to: 0 };
    const labelCache = new Map();
    const tickX = new Float32Array(512);
    const tickEv = new Array(512);
    let tickCount = 0;
    let offsetMs = 0;                 // centre − tMs (re-centre tween)
    let recenter = null;              // {from, t0, dur}
    let drag = null;
    let raf = 0;
    let hoverX = -1;
    let lastAria = 0;
    const win = { start: 0, span: 1, range: false };

    let roW = 0, roH = 0;             // the scrubber's box as the ResizeObserver last reported it
    /**
     * Sizes the canvas when flagged, from the ResizeObserver's entry, so draw() never reads layout
     * (only a first draw before the observer's entry, or a browser without one, reads the box).
     */
    function resizeCanvas() {
        if (!geomDirty && observesSize) return;
        let bw = roW, bh = roH;
        if (!(bw > 0 && bh > 0)) {
            const r = scrub.getBoundingClientRect();
            scrubLeft = r.left;
            bw = r.width;
            bh = r.height;
        }
        const w = Math.max(40, Math.round(bw));
        const hgt = Math.max(24, Math.round(bh));
        const d = Math.min(2, window.devicePixelRatio || 1);
        if (w === cssW && hgt === cssH && d === dpr && !geomDirty) return;
        if (w !== cssW || hgt !== cssH || d !== dpr || !lineImg) {
            cssW = w; cssH = hgt; dpr = d;
            canvas.width = Math.round(w * d);
            canvas.height = Math.round(hgt * d);
            canvas.style.width = `${w}px`;
            canvas.style.height = `${hgt}px`;
            lineCanvas.width = canvas.width;
            lineImg = lineCtx.createImageData(canvas.width, 3);
            grad.width = 0;
        }
        const compact = ui.layout === 'mobile';
        geom = compact
            ? { tickY: 1, trackY: 8, trackH: Math.max(12, hgt - 22), labelY: hgt - 3 }
            : { tickY: 1, trackY: 10, trackH: Math.max(14, hgt - 26), labelY: hgt - 3 };
        geomDirty = false;
    }

    /** Updates `win` in place (it is read every frame). */
    function computeWindow() {
        const range = clock.range;
        if (range && Number.isFinite(range.fromMs) && range.toMs > range.fromMs) {
            win.start = range.fromMs; win.span = range.toMs - range.fromMs; win.range = true;
            return;
        }
        const W = halfWindowFor(clock.rate);
        const t = clock.tMs;
        const centre = drag ? drag.centre : t + offsetMs;
        win.start = centre - W; win.span = 2 * W; win.range = false;
    }

    /** The planet whose band the strip shows: the selection, unless it is the Sun or the Moon. */
    function bandBody() {
        const sel = store.get().selection;
        return sel && sel !== 'sun' && sel !== 'moon' && sel in BODY_INDEX ? sel : '';
    }

    function ensureSeries() {
        if (win.span > 6.5 * DAY) return;
        const key = ui.observerKey();
        const s0 = win.start, s1 = win.start + win.span;
        const app = ui.almanac.sun;
        if (app?.values?.length > 1 && app.key === key && s0 >= app.fromMs && s1 <= app.toMs
            && !(series.values && series.key === key && s0 >= series.fromMs && s1 <= series.toMs)) {
            series.fromMs = app.fromMs; series.toMs = app.toMs; series.n = app.values.length; series.values = app.values; series.key = key;
            seriesRev += 1;
        }
        ensureOne(series, key);
        if (store.get().host?.id === 'mars') return;   // the bands are the Earth observer's
        ensureOne(moonSeries, key);
        const id = bandBody();
        if (id !== bodySeries.id) {
            dropSeries(bodySeries);
            bodySeries.id = id;
            bodyRgb = id ? hexRgb(BODIES[BODY_INDEX[id]].color, MOON_RGB) : MOON_RGB;
            seriesRev += 1;
        }
        if (id) ensureOne(bodySeries, key);
    }

    /** Requests a series for three windows around the view once it no longer covers it (backing off on failures). */
    function ensureOne(sr, key) {
        const s0 = win.start, s1 = win.start + win.span;
        const margin = win.span * 0.25;
        if (sr.values && sr.key === key && s0 >= sr.fromMs + margin && s1 <= sr.toMs - margin) return;
        const astro = ctx.services?.astro;
        if (!astro?.call || sr.ctl) return;
        if (performance.now() - sr.last < Math.min(30000, 300 * 2 ** sr.fails)) return;
        const c = win.start + win.span / 2;
        const fromMs = c - 1.5 * win.span, toMs = c + 1.5 * win.span, n = 288;
        const ac = new AbortController();
        const id = sr.id;
        sr.ctl = ac;
        sr.last = performance.now();
        const observer = ui.astroObserver();
        let p;
        try {
            p = id === 'sun' ? astro.call('sunSeries', { observer, fromMs, toMs, n }, { signal: ac.signal })
                : astro.call('altSeries', { bodyId: id, observer, fromMs, toMs, n, refraction: 'normal' }, { signal: ac.signal });
        } catch { sr.ctl = null; sr.fails += 1; return; }
        Promise.resolve(p).then((vals) => {
            if (sr.ctl !== ac) return;
            sr.ctl = null;
            // A Float32Array, or {values} (a typed array's own .values is its iterator method).
            const values = ArrayBuffer.isView(vals) ? vals : vals?.values;
            if (!ArrayBuffer.isView(values) || !(values.length > 1)) { sr.fails += 1; return; }
            sr.fails = 0;
            sr.fromMs = fromMs; sr.toMs = toMs; sr.n = values.length; sr.values = values; sr.key = key;
            seriesRev += 1;
            kick();
        }, () => { if (sr.ctl === ac) sr.ctl = null; if (!ac.signal.aborted) sr.fails += 1; });
    }
    function dropSeries(sr) { sr.ctl?.abort(); sr.ctl = null; sr.last = 0; sr.fails = 0; sr.values = null; }
    offs.push(store.subscribe((s) => s.observer, () => { dropSeries(series); dropSeries(moonSeries); dropSeries(bodySeries); seriesRev += 1; kick(); }));
    offs.push(store.subscribe((s) => s.selection, kick));

    /** A series' value at t (linear), or NaN outside it. */
    function seriesAt(sr, key, t) {
        if (!sr.values || sr.key !== key || t < sr.fromMs || t > sr.toMs) return NaN;
        const f = ((t - sr.fromMs) / (sr.toMs - sr.fromMs)) * (sr.n - 1);
        const i = Math.min(sr.n - 2, Math.max(0, Math.floor(f)));
        const u = f - i;
        return sr.values[i] * (1 - u) + sr.values[i + 1] * u;
    }

    /**
     * Updates the cached gradient row for the window, computing only the columns a slide exposed,
     * so steady fast time costs a few columns of trig per frame.
     * @returns {boolean} whether the row changed
     */
    function updateGradient(obs) {
        const cw = canvas.width;
        const wide = win.span > 6.5 * DAY;
        const key = ui.observerKey(obs);
        const useSeries = !!(!wide && series.values && series.key === key);
        if (grad.width === cw && grad.span === win.span && grad.wide === wide && grad.useSeries === useSeries
            && grad.rev === seriesRev && grad.obsKey === key) {
            slideGradientRow(grad, lineImg.data, cw, win.span / cw, win.start, gradCols);
            if (gradCols.to <= gradCols.from) return false;
        } else {
            grad.start = win.start; grad.span = win.span; grad.width = cw;
            grad.wide = wide; grad.useSeries = useSeries; grad.rev = seriesRev; grad.obsKey = key;
            gradCols.from = 0; gradCols.to = cw;
        }
        fillGradient(obs, gradCols.from, gradCols.to, wide, useSeries);
        lineCtx.putImageData(lineImg, 0, 0);
        return true;
    }

    /**
     * Computes columns [from, to) of the cached rows: the sky's colour by the Sun's altitude, where
     * the Moon is up (brighter the fuller) and the selected planet (its colour); no bands on wide
     * windows or on Mars.
     */
    function fillGradient(obs, from, to, wide, useSeries) {
        const cw = canvas.width;
        const data = lineImg.data;
        const row = cw * 4;
        const lat = obs.latDeg, lon = obs.lonDeg;
        const mars = obs.mars === true;
        const key = ui.observerKey(obs);
        const bands = !wide && !mars;
        const body = bands && bodySeries.id ? bodyRgb : null;
        for (let x = from; x < to; x += 1) {
            const t = grad.start + ((x + 0.5) / cw) * grad.span;
            let r, g, b;
            if (wide) {
                const k = smooth(0.22, 0.78, mars ? marsDayFraction(t, lat) : dayFraction(t, lat));
                r = C_NIGHT[0] + (C_DAY[0] - C_NIGHT[0]) * k;
                g = C_NIGHT[1] + (C_DAY[1] - C_NIGHT[1]) * k;
                b = C_NIGHT[2] + (C_DAY[2] - C_NIGHT[2]) * k;
            } else {
                let alt = useSeries ? seriesAt(series, key, t) : NaN;
                if (alt !== alt) alt = mars ? marsSunAlt(t, lat, lon) : sunAltApprox(t, lat, lon);
                const li = skyLutIndex(alt);
                r = LUT[li]; g = LUT[li + 1]; b = LUT[li + 2];
            }
            const o = x * 4;
            data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
            const mo = o + row;
            const moonUp = bands && seriesAt(moonSeries, key, t) > MOON_UP_DEG;
            data[mo] = MOON_RGB[0]; data[mo + 1] = MOON_RGB[1]; data[mo + 2] = MOON_RGB[2];
            data[mo + 3] = moonUp ? 70 + 185 * moonLitApprox(t) : 0;
            const bo = mo + row;
            const bodyUp = body !== null && seriesAt(bodySeries, key, t) > 0;
            data[bo] = bodyRgb[0]; data[bo + 1] = bodyRgb[1]; data[bo + 2] = bodyRgb[2];
            data[bo + 3] = bodyUp ? 235 : 0;
        }
    }

    let marsObsCache = null;
    /** The Martian site as a gradient 'observer' (never matches an Earth series key). */
    function marsObs(host) {
        if (!marsObsCache || marsObsCache.latDeg !== host.latDeg || marsObsCache.lonDeg !== host.lonDeg) {
            marsObsCache = { latDeg: host.latDeg, lonDeg: host.lonDeg, elevM: -999999, mars: true };
        }
        return marsObsCache;
    }

    function drawGradient(obs) {
        updateGradient(obs);
        const cw = canvas.width;
        const y = geom.trackY * dpr, th = geom.trackH * dpr;
        g2d.save();
        roundRect(g2d, 0, y, cw, th, Math.min(8, geom.trackH / 2) * dpr);
        g2d.clip();
        g2d.imageSmoothingEnabled = false;
        g2d.drawImage(lineCanvas, 0, 0, cw, 1, 0, y, cw, th);
        // Soft top sheen for depth (rebuilt only when the track moves).
        if (!sheen || sheenY !== y || sheenH !== th) {
            sheen = g2d.createLinearGradient(0, y, 0, y + th);
            sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
            sheen.addColorStop(0.45, 'rgba(255,255,255,0.0)');
            sheen.addColorStop(1, 'rgba(0,0,0,0.18)');
            sheenY = y; sheenH = th;
        }
        g2d.fillStyle = sheen;
        g2d.fillRect(0, y, cw, th);
        // The bands: the selected planet along the top edge, the Moon along the bottom.
        const bh = Math.round(BAND_PX * dpr);
        g2d.drawImage(lineCanvas, 0, 2, cw, 1, 0, y, cw, bh);
        g2d.drawImage(lineCanvas, 0, 1, cw, 1, 0, y + th - bh, cw, bh);
        g2d.restore();
    }

    function labelFor(key, make) {
        let s = labelCache.get(key);
        if (s === undefined) {
            if (labelCache.size > 300) labelCache.clear();
            s = make();
            labelCache.set(key, s);
        }
        return s;
    }

    function drawGrid() {
        const span = win.span, start = win.start, end = start + span;
        const cw = canvas.width;
        const xOf = (t) => ((t - start) / span) * cw;
        const offMs = ui.zoned(start + span / 2).offsetMin * 60e3;
        const y0 = geom.trackY * dpr, y1 = (geom.trackY + geom.trackH) * dpr;
        g2d.font = `${Math.round(10.5 * dpr)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        g2d.textBaseline = 'alphabetic';
        g2d.textAlign = 'center';
        const ly = geom.labelY * dpr;
        let minorStep, majorStep, kind;
        if (span <= 2 * DAY) { minorStep = HOUR; majorStep = span <= 26 * HOUR ? 3 * HOUR : 6 * HOUR; kind = 'h'; }
        else if (span <= 8 * DAY) { minorStep = 6 * HOUR; majorStep = DAY; kind = 'd'; }
        else if (span <= 70 * DAY) { minorStep = DAY; majorStep = 0; kind = 'D'; }
        else { minorStep = 0; majorStep = 0; kind = 'M'; }
        const minGap = (kind === 'h' ? 46 : 56) * dpr;
        // Narrow tracks: widen the hour stride (3 h → 6 h → 12 h) so labels stay evenly spaced
        // instead of the greedy skip below dropping every other one unevenly.
        if (kind === 'h') while (majorStep < 12 * HOUR && (majorStep / span) * cw < minGap) majorStep *= 2;
        g2d.lineWidth = Math.max(1, dpr);
        // Minor ticks along the bottom edge of the track.
        if (minorStep) {
            g2d.strokeStyle = 'rgba(255,255,255,0.16)';
            g2d.beginPath();
            const first = Math.ceil((start + offMs) / minorStep) * minorStep - offMs;
            for (let t = first; t <= end; t += minorStep) {
                const x = Math.round(xOf(t)) + 0.5;
                g2d.moveTo(x, y1 - 4 * dpr); g2d.lineTo(x, y1);
            }
            g2d.stroke();
        }
        const majors = [];
        if (kind === 'h' || kind === 'd') {
            const first = Math.ceil((start + offMs) / majorStep) * majorStep - offMs;
            for (let t = first; t <= end; t += majorStep) majors.push(t);
        } else if (kind === 'D') {
            const first = Math.ceil((start + offMs) / DAY) * DAY - offMs;
            for (let t = first; t <= end; t += DAY) {
                const dom = calOf(t + offMs).d;
                if (dom === 1 || (dom % 5 === 0 && dom < 30)) majors.push(t);
            }
        } else {
            // Month starts in the display calendar (Julian before 15 Oct 1582).
            const z = ui.zoned(start);
            for (let k = 0; k < 30; k += 1) {
                const yy = z.y + Math.floor((z.mo - 1 + k) / 12), mm = ((z.mo - 1 + k) % 12) + 1;
                const g = fromCalendar(yy, mm, 1);
                const t = Date.UTC(g.y, g.mo - 1, g.d) - offMs;
                if (t > end) break;
                if (t >= start) majors.push(t);
            }
        }
        g2d.strokeStyle = 'rgba(255,255,255,0.28)';
        g2d.beginPath();
        let lastLabelX = -1e9;
        // Keep labels clear of the playhead so its line never cuts through the text.
        const thumbX = xOf(drag ? drag.t : clock.tMs);
        for (const t of majors) {
            const x = Math.round(xOf(t)) + 0.5;
            g2d.moveTo(x, y0); g2d.lineTo(x, y1);
            if (x - lastLabelX < minGap || x < 18 * dpr || x > cw - 18 * dpr || Math.abs(x - thumbX) < 20 * dpr) continue;
            lastLabelX = x;
            const lab = labelFor(`${kind}${t}`, () => majorLabel(kind, t, offMs));
            const isDay = lab.charCodeAt(0) > 64; // weekday / month names start with a letter
            g2d.fillStyle = isDay ? 'rgba(232,237,246,0.92)' : 'rgba(154,166,184,0.95)';
            g2d.fillText(lab, x, ly);
        }
        g2d.stroke();
    }

    /** The display-calendar date of a wall-clock instant (ms with the zone offset added). */
    const calScratch = {};
    function calOf(wallMs) {
        const d = new Date(wallMs);
        calScratch.y = d.getUTCFullYear(); calScratch.mo = d.getUTCMonth() + 1; calScratch.d = d.getUTCDate();
        return toCalendar(calScratch, calScratch);
    }

    function majorLabel(kind, t, offMs) {
        const d = new Date(t + offMs);
        const hh = d.getUTCHours();
        const c = calOf(t + offMs);
        if (kind === 'h') {
            if (hh === 0) return `${ui.WEEKDAYS[d.getUTCDay()]} ${c.d}`;
            if (store.get().display?.hour12) return `${hh % 12 || 12} ${hh < 12 ? 'AM' : 'PM'}`;
            return `${pad2(hh)}:00`;
        }
        if (kind === 'd') return `${ui.WEEKDAYS[d.getUTCDay()]} ${c.d}`;
        if (kind === 'D') return `${c.d} ${ui.MONTHS[c.mo - 1]}`;
        return c.mo === 1 ? `${ui.MONTHS[0]} ${c.y}` : ui.MONTHS[c.mo - 1];
    }

    function drawTicks() {
        tickCount = 0;
        const list = ui.events?.list;
        if (!list || !list.length) return;
        const start = win.start, end = start + win.span, cw = canvas.width;
        const y = (geom.tickY + 3.5) * dpr;
        const r = 2.6 * dpr;
        // Binary search the first event in the window (list is sorted), 8 h early for eclipse spans.
        let lo = 0, hi = list.length;
        const from = start - 8 * HOUR;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].tMs < from) lo = mid + 1; else hi = mid; }
        // Eclipses: a gold bar from first to last contact, under their ticks.
        g2d.fillStyle = 'rgba(255, 204, 102, 0.8)';
        for (let i = lo; i < list.length; i += 1) {
            const ev = list[i];
            if (ev.tMs > end + 8 * HOUR) break;
            if (!eclipseSpan(ev, spanScratch) || spanScratch.to < start || spanScratch.from > end) continue;
            const x0 = Math.max(0, ((spanScratch.from - start) / win.span) * cw);
            const x1 = Math.min(cw, ((spanScratch.to - start) / win.span) * cw);
            g2d.fillRect(x0, y - dpr, Math.max(2 * dpr, x1 - x0), 2 * dpr);
        }
        for (let i = lo; i < list.length && tickCount < tickX.length; i += 1) {
            const ev = list[i];
            if (ev.tMs < start) continue;
            if (ev.tMs > end) break;
            const x = ((ev.tMs - start) / win.span) * cw;
            tickX[tickCount] = x / dpr;
            tickEv[tickCount] = ev;
            tickCount += 1;
            g2d.fillStyle = tickColor(ev);
            g2d.beginPath();
            if (ev.kind === 'moon-phase') {
                g2d.arc(x, y, r * 0.9, 0, Math.PI * 2);
            } else {
                const k = ev.kind.includes('eclipse') ? 1.35 : 1;
                g2d.moveTo(x, y - r * k); g2d.lineTo(x + r * k, y); g2d.lineTo(x, y + r * k); g2d.lineTo(x - r * k, y);
                g2d.closePath();
            }
            g2d.fill();
        }
    }

    function drawNowMarker() {
        if (clock.live || win.range) return;
        const now = Date.now();
        if (now < win.start || now > win.start + win.span) return;
        const x = Math.round(((now - win.start) / win.span) * canvas.width) + 0.5;
        g2d.strokeStyle = 'rgba(255,90,90,0.85)';
        g2d.lineWidth = Math.max(1, 1.5 * dpr);
        g2d.beginPath();
        g2d.moveTo(x, geom.trackY * dpr); g2d.lineTo(x, (geom.trackY + geom.trackH) * dpr);
        g2d.stroke();
    }

    function draw() {
        resizeCanvas();
        // Re-centre tween after a drag / click.
        if (recenter) {
            const k = clamp((performance.now() - recenter.t0) / recenter.dur, 0, 1);
            offsetMs = recenter.from * (1 - easeOutCubic(k));
            if (k >= 1) { recenter = null; offsetMs = 0; }
        }
        computeWindow();
        ensureSeries();
        const host = store.get().host;
        // On Mars the strip shows the Martian site's day and night (elevM marks its key apart).
        const obs = host?.id === 'mars' ? marsObs(host) : store.get().observer;
        g2d.clearRect(0, 0, canvas.width, canvas.height);
        if (obs && lineImg) drawGradient(obs);
        drawGrid();
        drawTicks();
        drawNowMarker();
        // Thumb.
        const t = drag ? drag.t : clock.tMs;
        const x = clamp(((t - win.start) / win.span) * cssW, 0, cssW);
        thumb.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
        syncStamp(false);
        const now = performance.now();
        if (now - lastAria > 1000 || drag) {
            lastAria = now;
            syncAria();
        }
        if (hoverX >= 0 && !drag) showTip(hoverX);
    }

    function syncAria() {
        const t = clock.tMs;
        setAttr(scrub, 'aria-valuemin', String(Math.round(win.start)));
        setAttr(scrub, 'aria-valuemax', String(Math.round(win.start + win.span)));
        setAttr(scrub, 'aria-valuenow', String(Math.round(t)));
        setAttr(scrub, 'aria-valuetext', `${ui.fmtDay(t)}, ${ui.fmtClock(t, { seconds: true })}`);
    }

    function continuous() {
        return !!drag || !!recenter || (typeof clock.isAnimating === 'function' ? clock.isAnimating() : (clock.playing && !clock.live));
    }
    function frame() {
        raf = 0;
        try { draw(); } catch (err) { console.error('[ui] scrubber draw failed', err); return; }
        if (continuous() && !document.hidden) raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    // -- interaction ---------------------------------------------------------
    // The scrubber's left edge is read once per gesture (pointerenter / pointerdown), not per move.
    const readLeft = () => { scrubLeft = scrub.getBoundingClientRect().left; };
    const xFromEvent = (e) => clamp(e.clientX - scrubLeft, 0, cssW);
    function tickAt(x, maxPx = 6) {
        let best = -1, bd = maxPx;
        for (let i = 0; i < tickCount; i += 1) {
            const d = Math.abs(tickX[i] - x);
            if (d <= bd) { bd = d; best = i; }
        }
        return best >= 0 ? tickEv[best] : null;
    }
    function showTip(x) {
        const ev = tickAt(x);
        const t = win.start + (x / Math.max(1, cssW)) * win.span;
        let text;
        if (ev) text = `${ev.title} · ${ui.fmtWhen(ev.tMs, clock.tMs)}`;
        else text = win.span > 8 * DAY ? ui.fmtDay(t) : `${ui.fmtDay(t, { year: false })} · ${ui.fmtClock(t)}`;
        setText(tip, text);
        tip.hidden = false;
        tip.classList.toggle('is-event', !!ev);
        const w = tip.offsetWidth;
        tip.style.transform = `translate3d(${clamp(x - w / 2, 0, Math.max(0, cssW - w)).toFixed(1)}px, 0, 0)`;
    }
    offs.push(on(scrub, 'pointermove', (e) => {
        if (drag) {
            if (e.pointerId !== drag.id) return;
            const x = xFromEvent(e);
            if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
            if (!drag.moved) {
                drag.moved = true;
                scrub.classList.add('is-dragging');
                if (clock.playing && !win.range) { clock.pause(); drag.paused = true; }
            }
            setFromX(x);
            kick();
            return;
        }
        if (e.pointerType === 'mouse') { hoverX = xFromEvent(e); showTip(hoverX); }
    }));
    offs.push(on(scrub, 'pointerenter', readLeft));
    offs.push(on(scrub, 'pointerleave', () => { hoverX = -1; if (!drag) tip.hidden = true; }));
    offs.push(on(scrub, 'pointerdown', (e) => {
        if (e.button > 0) return;
        readLeft();
        computeWindow();
        try { scrub.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
        drag = {
            id: e.pointerId, x0: e.clientX, t0: performance.now(), moved: false, paused: false,
            start: win.start, span: win.span, range: win.range, centre: win.start + win.span / 2, t: clock.tMs,
        };
        ui.scrubbing = true;
        scrub.focus({ preventScroll: true });
        kick();
    }));
    function setFromX(x) {
        const p = clamp(x / Math.max(1, cssW), 0, 1);
        const t = drag.start + p * drag.span;
        drag.t = t;
        if (drag.range) clock.seek(p);
        else clock.setTime(clamp(t, MIN_MS, MAX_MS));
    }
    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        const x = xFromEvent(e);
        if (!d.moved) {
            const ev = e.pointerType === 'mouse' || e.pointerType === 'pen' ? tickAt(x) : tickAt(x, 10);
            drag = null;
            if (ev) {
                ui.act('jumpToEvent', ev);
            } else if (d.range) {
                clock.seek(clamp(x / Math.max(1, cssW), 0, 1));
            } else {
                // A click jumps there; the tween keeps the playhead visually continuous.
                const target = clamp(d.start + (x / Math.max(1, cssW)) * d.span, MIN_MS, MAX_MS);
                offsetMs = (d.start + d.span / 2) - target;
                recenter = { from: offsetMs, t0: performance.now(), dur: reduced() ? 1 : 360 };
                clock.setTime(target);
            }
        } else {
            drag = null;
            scrub.classList.remove('is-dragging');
            if (!d.range) {
                offsetMs = d.centre - clock.tMs;
                recenter = { from: offsetMs, t0: performance.now(), dur: reduced() ? 1 : 260 };
            }
            if (d.paused) clock.play();
        }
        ui.scrubbing = false;
        ctx.bus.emit('announce', `Time: ${ui.fmtSpoken(clock.tMs)}`);
        kick();
    };
    offs.push(on(scrub, 'pointerup', endDrag));
    offs.push(on(scrub, 'pointercancel', endDrag));
    offs.push(on(scrub, 'keydown', (e) => {
        let frac = 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') frac = 1 / 48;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') frac = -1 / 48;
        else if (e.key === 'PageUp') frac = 1 / 8;
        else if (e.key === 'PageDown') frac = -1 / 8;
        else return;
        e.preventDefault();
        e.stopPropagation();
        computeWindow();
        if (win.range) {
            const p = clamp((clock.progress?.() ?? 0) + frac, 0, 1);
            clock.seek(p);
        } else {
            clock.setTime(clamp(clock.tMs + frac * win.span, MIN_MS, MAX_MS));
        }
        lastAria = performance.now();
        syncAria(); // immediately, so screen readers announce the new value with the key press
        kick();
    }));

    // ================================================================ wiring
    offs.push(ui.on('layout', arrange));
    arrange(ui.layout);
    if (clock.onChange) offs.push(clock.onChange(() => { syncControls(true); kick(); }));
    offs.push(store.subscribe((s) => s.display, () => { labelCache.clear(); syncControls(true); kick(); }));
    offs.push(store.subscribe((s) => s.observer, () => { labelCache.clear(); syncControls(true); kick(); }));
    offs.push(store.subscribe((s) => s.host, () => { syncControls(true); kick(); requestAnimationFrame(fitZone); }));
    offs.push(ui.on('events', kick));
    offs.push(ui.on('almanac', kick));
    offs.push(on(window, 'resize', () => { geomDirty = true; kick(); }));
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        const box = e?.borderBoxSize?.[0];
        roW = box ? box.inlineSize : e?.contentRect?.width ?? 0;
        roH = box ? box.blockSize : e?.contentRect?.height ?? 0;
        geomDirty = true;
        kick();
    }) : null;
    ro?.observe(scrub);
    // The room the zone has: the phone's LIVE or Now, a layout switch, the window.
    const zro = ro && new ResizeObserver(() => fitZone());
    zro?.observe(dateBtn);
    // Live 1× does not animate the clock: refresh the seconds on the second boundary.
    let secTimer = 0;
    const secondTick = () => {
        secTimer = setTimeout(secondTick, 1000 - (Date.now() % 1000) + 8);
        if (!raf && !document.hidden) { syncStamp(true); if (clock.playing) kick(); }
    };
    secondTick();
    offs.push(on(document, 'visibilitychange', () => { if (!document.hidden) kick(); }));

    syncControls(true);
    kick();

    return {
        update() { if (!raf) { syncControls(); kick(); } },
        destroy() {
            offs.forEach((off) => off());
            ro?.disconnect();
            zro?.disconnect();
            clearTimeout(secTimer);
            if (raf) cancelAnimationFrame(raf);
            dropSeries(series); dropSeries(moonSeries); dropSeries(bodySeries);
            closeTime();
            pop.remove();
            if (ui.openTime === openTime) delete ui.openTime;
            root.textContent = '';
        },
    };
}

/** Path helper: rounded rectangle (uses the native roundRect when present). */
function roundRect(c, x, y, w, hgt, r) {
    c.beginPath();
    if (typeof c.roundRect === 'function') { c.roundRect(x, y, w, hgt, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + hgt, r);
    c.arcTo(x + w, y + hgt, x, y + hgt, r);
    c.arcTo(x, y + hgt, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}
