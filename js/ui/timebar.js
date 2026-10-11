/**
 * Time bar: play / step / rate / reverse, the date-time button (popover with a
 * `datetime-local` input interpreted in the display timezone), the timezone
 * chip (Observer → Device → UTC), the Live pill / "Return to now", the
 * Timelapse (range loop) popover and the scrubber.
 *
 * Scrubber design: a fixed playhead over a timeline that scrolls with time.
 * The visible window depends on |rate| (±12 h, ±3 d, ±30 d, ±1 yr). Its
 * background is the day/night gradient of the Sun's altitude at the observer
 * (worker `sunSeries`, with an analytic low-precision fallback so it is never
 * blank); wide windows show the seasonal day-length instead, because a
 * day/night pattern cannot be resolved there. Event ticks come from the event
 * list. Dragging scrubs relative to the window captured at drag start; release
 * re-centres smoothly. Keyboard: ←/→ = window/48, PageUp/PageDown = window/8.
 *
 * Drawing runs on requestAnimationFrame only while time is animating, the user
 * is dragging, or the re-centre tween runs; otherwise it redraws on demand.
 * The per-frame path reuses preallocated buffers (no typed-array churn).
 *
 * @module ui/timebar
 */

import { BODIES, BODY_INDEX } from '../astro/bodies.js';
import { h, on, setText, setAttr, clamp, openPopover, uid } from './dom.js';
import { icon, swapIcon } from './icons.js';

const MIN_MS = Date.UTC(1000, 0, 1);
const MAX_MS = Date.UTC(3000, 0, 1);
const HOUR = 3600e3;
const DAY = 86400e3;
const RAD = Math.PI / 180;
const RATE_MAX = 31557600;

/** Step choices for the step buttons (`clock.step(kind)`). */
const STEP_UNITS = [
    { kind: 'minute', label: 'Minute', long: '1 minute' },
    { kind: 'hour', label: 'Hour', long: '1 hour' },
    { kind: 'day', label: 'Day', long: '1 day' },
    { kind: 'siderealDay', label: 'Sid. day', long: '1 sidereal day' },
    { kind: 'month', label: 'Month', long: '1 lunar month' },
    { kind: 'year', label: 'Year', long: '1 year' },
];

/** Day/night palette (SPEC F.2) as RGB. */
const C_DAY = [0x2d, 0x4a, 0x6b];
const C_NOON = [0x3a, 0x62, 0x8e];
const C_CIVIL = [0x24, 0x30, 0x4a];
const C_NAUT = [0x18, 0x20, 0x3a];
const C_ASTRO = [0x10, 0x15, 0x2a];
const C_NIGHT = [0x0a, 0x0d, 0x18];

/** Altitude → colour lookup, −30°..+60° in 0.1° steps (built once). */
const LUT_MIN = -30, LUT_STEP = 0.1, LUT_N = 901;
const LUT = buildLut();

function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function smooth(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

function buildLut() {
    const lut = new Uint8ClampedArray(LUT_N * 3);
    // Zone colours with short blends across the twilight boundaries (−18, −12, −6, −0.833°).
    const zone = (alt) => {
        if (alt < -18) return C_NIGHT;
        if (alt < -12) return C_ASTRO;
        if (alt < -6) return C_NAUT;
        if (alt < -0.833) return C_CIVIL;
        return mix(C_DAY, C_NOON, smooth(6, 50, alt));
    };
    for (let i = 0; i < LUT_N; i += 1) {
        const alt = LUT_MIN + i * LUT_STEP;
        const c = mix(zone(alt - 0.6), zone(alt + 0.6), 0.5);
        lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
    }
    return lut;
}

/** Event-kind colours for scrubber ticks. */
function tickColor(ev) {
    switch (ev.kind) {
        case 'moon-phase': return '#d8dde6';
        case 'lunar-eclipse': return '#ff8a65';
        case 'solar-eclipse': case 'local-solar-eclipse': return '#ffcc66';
        case 'equinox': case 'solstice': return '#7cc4ff';
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

const pad2 = (n) => (n < 10 ? '0' : '') + n;
const easeOutCubic = (x) => 1 - (1 - x) ** 3;

/**
 * Mounts the time bar.
 * @param {HTMLElement} root `<section class="timebar">`
 * @param {any} ctx UiCtx
 * @returns {{update(snap:any): void, destroy(): void, toolsEl: HTMLElement}}
 */
export function mountTimebar(root, ctx) {
    const { store, clock, ui } = ctx;
    const offs = [];
    let unit = STEP_UNITS[1];

    // ================================================================ controls
    const btn = (cls, label, iconName, tip, kbdHint) => h('button', {
        class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, 'data-tip': tip || label,
        ...(kbdHint ? { 'data-kbd': kbdHint } : {}),
    }, icon(iconName, { size: 20 }));

    const btnBack = btn('tb-back', 'Step back 1 hour', 'step-back', 'Step back', ',');
    const btnPlay = btn('tb-play icon-btn--primary', 'Pause', 'pause', 'Pause', 'Space');
    const btnFwd = btn('tb-fwd', 'Step forward 1 hour', 'step-fwd', 'Step forward', '.');
    const unitSel = h('select', { class: 'select tb-unit', 'aria-label': 'Step size', 'data-tip': 'Step size' },
        STEP_UNITS.map((u) => h('option', { value: u.kind }, u.label)));
    unitSel.value = unit.kind;

    const btnSlower = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': 'Slower', 'data-tip': 'Slower', 'data-kbd': '[' }, icon('minus', { size: 16 }));
    const rateOut = h('output', { class: 'tb-rate__value', 'aria-live': 'off' }, 'Real time');
    const btnFaster = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': 'Faster', 'data-tip': 'Faster', 'data-kbd': ']' }, icon('plus', { size: 16 }));
    const rateGroup = h('div', { class: 'tb-rate', role: 'group', 'aria-label': 'Speed' }, btnSlower, rateOut, btnFaster);
    const btnReverse = btn('tb-reverse', 'Reverse time', 'reverse', 'Reverse', 'R');
    btnReverse.setAttribute('aria-pressed', 'false');

    const stampDay = h('span', { class: 'stamp__day' });
    const stampSep = h('span', { class: 'stamp__sep', 'aria-hidden': 'true' }, '·');
    const stampTime = h('span', { class: 'stamp__time' });
    const dateBtn = h('button', {
        class: 'tb-date', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': 'Go to a date and time',
    }, h('span', { class: 'tb-date__icon' }, icon('calendar', { size: 18 })), h('span', { class: 'stamp' }, stampDay, stampSep, stampTime));
    const badge = h('span', { class: 'badge badge--warn tb-accuracy', hidden: true, title: 'Planet positions are most accurate between 1800 and 2200' },
        icon('warning', { size: 14 }), h('span', { class: 'tb-accuracy__text' }, 'Reduced accuracy'));
    const tzChip = h('button', { class: 'chip tb-tz', type: 'button', 'data-tip': 'Change time zone' });
    const lapseBtn = h('button', {
        class: 'btn btn--ghost tb-lapse', type: 'button', 'aria-label': 'Timelapse', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': 'Loop between two moments',
    }, icon('timelapse', { size: 18 }), h('span', { class: 'tb-lapse__label' }, 'Timelapse'));
    const livePill = h('span', { class: 'live-pill', role: 'status', 'aria-label': 'Live: showing the current time' },
        h('span', { class: 'live-pill__dot', 'aria-hidden': 'true' }), 'LIVE');
    const nowBtn = h('button', { class: 'btn btn--now', type: 'button', 'data-tip': 'Back to the current time', 'data-kbd': 'N' },
        icon('live', { size: 18 }), h('span', { class: 'btn--now__long' }, 'Return to now'), h('span', { class: 'btn--now__short' }, 'Now'));
    const liveWrap = h('div', { class: 'tb-live' }, livePill, nowBtn);

    const rowMain = h('div', { class: 'tb-row tb-main' });
    const zoneL = h('div', { class: 'tb-zone tb-zone--left' });
    const zoneC = h('div', { class: 'tb-zone tb-zone--center' });
    const zoneR = h('div', { class: 'tb-zone tb-zone--right' });
    const toolsEl = h('div', { class: 'tb-row tb-tools' });

    // ================================================================ scrubber
    const canvas = h('canvas', { class: 'tb-scrub__canvas', 'aria-hidden': 'true' });
    const thumb = h('span', { class: 'tb-scrub__thumb', 'aria-hidden': 'true' }, h('span', { class: 'tb-scrub__knob' }));
    const tip = h('span', { class: 'tb-scrub__tip', 'aria-hidden': 'true', hidden: true });
    const scrubId = uid('scrub');
    const scrub = h('div', {
        class: 'tb-scrub', id: scrubId, role: 'slider', tabindex: '0', 'aria-label': 'Time',
        'aria-valuemin': '0', 'aria-valuemax': '1', 'aria-valuenow': '0',
    }, canvas, thumb, tip);
    root.append(rowMain, scrub, toolsEl);

    // ================================================================ popovers
    const popHost = ui.root || document.body;
    const dateInput = h('input', {
        class: 'input', type: 'datetime-local', step: '1', min: '1000-01-01T00:00', max: '3000-01-01T00:00',
        'data-autofocus': '',
    });
    const dateZone = h('span', { class: 'pop__zone' });
    const quick = h('div', { class: 'pop__quick', role: 'group', 'aria-label': 'Quick jumps' });
    const goBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Go');
    const dateForm = h('form', { class: 'pop__form', novalidate: true },
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Date and time ', dateZone), dateInput),
        quick,
        h('div', { class: 'pop__actions' }, goBtn));
    const datePop = h('div', { class: 'popover pop-date', role: 'dialog', 'aria-label': 'Go to date and time', hidden: true },
        h('div', { class: 'pop__title' }, icon('calendar', { size: 16 }), 'Go to date & time'), dateForm);

    const fromInput = h('input', { class: 'input', type: 'datetime-local', step: '1', min: '1000-01-01T00:00', max: '3000-01-01T00:00', 'data-autofocus': '' });
    const toInput = h('input', { class: 'input', type: 'datetime-local', step: '1', min: '1000-01-01T00:00', max: '3000-01-01T00:00' });
    const durInput = h('input', { class: 'input input--num', type: 'number', min: '1', max: '600', step: '1', value: '10', inputmode: 'numeric' });
    const modeName = uid('lapse-mode');
    const modes = [['loop', 'Loop'], ['pingpong', 'Ping-pong'], ['once', 'Once']].map(([v, l], i) =>
        h('label', { class: 'seg__opt' }, h('input', { type: 'radio', name: modeName, value: v, checked: i === 0 }), h('span', null, l)));
    const lapseErr = h('p', { class: 'pop__error', role: 'alert', hidden: true });
    const stopBtn = h('button', { class: 'btn btn--ghost', type: 'button', hidden: true }, 'Stop');
    const startBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, icon('play', { size: 14 }), 'Start');
    const lapseZone = h('span', { class: 'pop__zone' });
    const lapseForm = h('form', { class: 'pop__form', novalidate: true },
        h('p', { class: 'pop__hint' }, 'Loop the clock between two moments. Times in ', lapseZone, '.'),
        h('div', { class: 'pop__grid' },
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'From'), fromInput),
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'To'), toInput)),
        h('div', { class: 'pop__grid pop__grid--2' },
            h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Duration (seconds)'), durInput),
            h('div', { class: 'field' }, h('span', { class: 'field__label', id: `${modeName}-l` }, 'Playback'),
                h('div', { class: 'seg seg--radio', role: 'radiogroup', 'aria-labelledby': `${modeName}-l` }, modes))),
        lapseErr,
        h('div', { class: 'pop__actions' }, stopBtn, startBtn));
    const lapsePop = h('div', { class: 'popover pop-lapse', role: 'dialog', 'aria-label': 'Timelapse', hidden: true },
        h('div', { class: 'pop__title' }, icon('timelapse', { size: 16 }), 'Timelapse'), lapseForm);
    popHost.append(datePop, lapsePop);

    // ================================================================ arrangement per layout
    function arrange(layout) {
        if (layout === 'mobile') {
            rowMain.replaceChildren(btnPlay, dateBtn, rateGroup, liveWrap);
            toolsEl.replaceChildren(btnBack, unitSel, btnFwd, btnReverse, lapseBtn, tzChip, badge);
            toolsEl.hidden = false;
        } else {
            // Three zones: transport · date & zone · speed, timelapse and live.
            zoneL.replaceChildren(btnBack, btnPlay, btnFwd, unitSel);
            zoneC.replaceChildren(dateBtn, badge, tzChip);
            zoneR.replaceChildren(rateGroup, btnReverse, lapseBtn, liveWrap);
            rowMain.replaceChildren(zoneL, zoneC, zoneR);
            toolsEl.replaceChildren();
            toolsEl.hidden = true;
        }
        geomDirty = true;
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
    offs.push(on(btnReverse, 'click', () => { clock.reverse(); syncControls(); }));
    offs.push(on(nowBtn, 'click', () => { clock.goLive(); syncControls(); }));
    offs.push(on(tzChip, 'click', () => {
        const order = ['observer', 'device', 'utc'];
        const cur = store.get().display?.tzMode || 'observer';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        if (ui.act('setTzMode', next) === undefined && typeof ctx.actions?.setTzMode !== 'function') {
            store.set({ display: { ...store.get().display, tzMode: next } });
        }
    }));

    // -- date popover -------------------------------------------------------
    let datePopCtl = null;
    function toInputValue(ms) {
        const z = ui.zoned(clamp(ms, MIN_MS, MAX_MS - 1000));
        return `${String(z.y).padStart(4, '0')}-${pad2(z.mo)}-${pad2(z.d)}T${pad2(z.h)}:${pad2(z.mi)}:${pad2(z.s)}`;
    }
    function fromInputValue(v) {
        const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v || '');
        if (!m) return NaN;
        return ui.toUtc({ y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) });
    }
    function zoneText() {
        const st = store.get();
        const mode = st.display?.tzMode || 'observer';
        const off = ui.offsetText(clock.tMs);
        if (mode === 'utc') return '(UTC)';
        if (mode === 'device') return `(this device · ${off})`;
        return `(${ui.placeShort(st.observer)} · ${off}${st.observer?.tzApprox ? ', approx.' : ''})`;
    }
    function quickJumps() {
        const t = clock.tMs;
        const items = [];
        items.push(['Now', null, () => clock.goLive()]);
        const tw = ui.almanac.night?.twilight;
        if (tw && Number.isFinite(tw.sunsetMs)) items.push(['Sunset', tw.sunsetMs, null]);
        const z = ui.zoned(t);
        const midnight = ui.toUtc({ y: z.y, mo: z.mo, d: z.d + 1, h: 0, mi: 0, s: 0 });
        items.push(['Midnight', midnight, null]);
        if (tw && Number.isFinite(tw.sunriseMs)) items.push(['Sunrise', tw.sunriseMs, null]);
        quick.replaceChildren(...items.map(([label, ms, fn]) => h('button', {
            class: 'chip chip--quick', type: 'button',
            onClick: () => { if (fn) fn(); else jumpTo(ms); closeDate(); },
        }, h('span', null, label), ms != null ? h('span', { class: 'chip__meta' }, ui.fmtClock(ms)) : null)));
    }
    function jumpTo(ms) {
        if (!Number.isFinite(ms)) return;
        const target = clamp(ms, MIN_MS, MAX_MS);
        const dist = Math.abs(target - clock.tMs);
        clock.setTime(target, { animateMs: reduced() || dist < 60e3 ? 0 : clamp(500 + Math.log10(1 + dist / HOUR) * 450, 500, 1600) });
        kick();
    }
    function openDate() {
        if (datePopCtl) { closeDate(); return; }
        closeLapse();
        dateInput.value = toInputValue(clock.tMs);
        dateInput.removeAttribute('aria-invalid');
        setText(dateZone, zoneText());
        quickJumps();
        datePopCtl = openPopover(dateBtn, datePop, { placement: 'top', within: root, onClose: () => { datePopCtl = null; } });
    }
    function closeDate() { datePopCtl?.close(); datePopCtl = null; }
    offs.push(on(dateBtn, 'click', openDate));
    offs.push(on(dateForm, 'submit', (e) => {
        e.preventDefault();
        const ms = fromInputValue(dateInput.value);
        if (!Number.isFinite(ms)) { dateInput.setAttribute('aria-invalid', 'true'); dateInput.focus(); return; }
        jumpTo(ms);
        closeDate();
    }));

    // -- timelapse popover ----------------------------------------------------
    let lapsePopCtl = null;
    function openLapse() {
        if (lapsePopCtl) { closeLapse(); return; }
        closeDate();
        const r = clock.range;
        const t = clock.tMs;
        fromInput.value = toInputValue(r ? r.fromMs : t);
        toInput.value = toInputValue(r ? r.toMs : t + DAY);
        durInput.value = String(r ? Math.round(r.durationS) : 10);
        const mode = r?.loop || 'loop';
        for (const m of modes) { const inp = m.querySelector('input'); inp.checked = inp.value === mode; }
        stopBtn.hidden = !r;
        lapseErr.hidden = true;
        setText(lapseZone, zoneText().replace(/^\(|\)$/g, ''));
        lapsePopCtl = openPopover(lapseBtn, lapsePop, { placement: 'top', within: root, onClose: () => { lapsePopCtl = null; } });
    }
    function closeLapse() { lapsePopCtl?.close(); lapsePopCtl = null; }
    offs.push(on(lapseBtn, 'click', openLapse));
    offs.push(on(stopBtn, 'click', () => { clock.setRange(null); closeLapse(); syncControls(); }));
    offs.push(on(lapseForm, 'submit', (e) => {
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
        const loop = modes.map((m) => m.querySelector('input')).find((i) => i.checked)?.value || 'loop';
        clock.setRange({ fromMs: a, toMs: b, durationS: dur, loop });
        if (!clock.playing) clock.play();
        closeLapse();
        syncControls();
    }));

    // ================================================================ control state
    let lastStampAt = 0;
    let lastYear = NaN;
    function syncControls(force = false) {
        const playing = clock.playing;
        const live = clock.live;
        const rate = clock.rate;
        const range = clock.range;
        swapIcon(btnPlay, playing ? 'pause' : 'play', 20);
        setAttr(btnPlay, 'aria-label', playing ? 'Pause' : 'Play');
        btnPlay.dataset.tip = playing ? 'Pause' : 'Play';
        const unitLong = unit.long;
        setAttr(btnBack, 'aria-label', `Step back ${unitLong}`);
        setAttr(btnFwd, 'aria-label', `Step forward ${unitLong}`);
        btnBack.dataset.tip = `Back ${unitLong}`;
        btnFwd.dataset.tip = `Forward ${unitLong}`;
        setText(rateOut, range ? 'Timelapse' : ui.fmt('fmtRate', rate));
        rateOut.classList.toggle('is-reverse', rate < 0 && !range);
        btnSlower.disabled = !!range || rate <= -RATE_MAX;
        btnFaster.disabled = !!range || rate >= RATE_MAX;
        setAttr(btnReverse, 'aria-pressed', String(rate < 0));
        btnReverse.classList.toggle('is-on', rate < 0);
        livePill.hidden = !live;
        nowBtn.hidden = live;
        root.classList.toggle('is-live', live);
        root.classList.toggle('is-paused', !playing);
        lapseBtn.classList.toggle('is-on', !!range);
        setAttr(lapseBtn, 'aria-pressed', String(!!range));
        syncStamp(force);
        syncTz();
    }
    function syncStamp(force) {
        const now = performance.now();
        if (!force && now - lastStampAt < 90) return;
        lastStampAt = now;
        const t = clock.tMs;
        setText(stampDay, ui.fmtDay(t));
        setText(stampTime, ui.fmtClock(t, { seconds: true }));
        setAttr(dateBtn, 'aria-label', `Date and time: ${ui.fmtSpoken(t)}. Change`);
        const y = new Date(t).getUTCFullYear();
        if (y !== lastYear) {
            lastYear = y;
            badge.hidden = !(y < 1800 || y > 2200);
        }
    }
    function syncTz() {
        const st = store.get();
        const mode = st.display?.tzMode || 'observer';
        const off = ui.offsetText(clock.tMs);
        let text, place = '', label;
        if (mode === 'utc') { text = 'UTC'; label = 'Times in UTC. Switch to observer time'; }
        else if (mode === 'device') { text = off; place = ' · This device'; label = `Times in this device's zone, ${off}. Switch to UTC`; }
        else if (st.observer?.tzApprox) { text = `${off} (approx.)`; label = `Times at the observer, ${off}, approximate. Switch to this device's time`; }
        else { const p = ui.placeShort(st.observer); text = off; place = ` · ${p}`; label = `Times in ${p}, ${off}. Switch to this device's time`; }
        // The place part is its own span so the phone layout can drop it (the top bar already names the place).
        if (tzChip.textContent !== text + place) tzChip.replaceChildren(text, place ? h('span', { class: 'tb-tz__place' }, place) : '');
        setAttr(tzChip, 'aria-label', label);
    }

    // ================================================================ scrubber engine
    const g2d = canvas.getContext('2d', { alpha: true });
    const lineCanvas = document.createElement('canvas');
    lineCanvas.height = 1;
    const lineCtx = lineCanvas.getContext('2d');
    let lineImg = null;
    let cssW = 0, cssH = 0, dpr = 1;
    let geomDirty = true;
    let geom = { tickY: 0, trackY: 10, trackH: 18, labelY: 34 };
    const series = { fromMs: 0, toMs: 0, n: 0, values: null, key: '' };
    let seriesCtl = null, seriesLast = 0, seriesFails = 0;
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
    let win = { start: 0, span: 1, range: false };

    function resizeCanvas() {
        const r = scrub.getBoundingClientRect();
        const w = Math.max(40, Math.round(r.width));
        const hgt = Math.max(24, Math.round(r.height));
        const d = Math.min(2, window.devicePixelRatio || 1);
        if (w === cssW && hgt === cssH && d === dpr && !geomDirty) return;
        cssW = w; cssH = hgt; dpr = d;
        canvas.width = Math.round(w * d);
        canvas.height = Math.round(hgt * d);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${hgt}px`;
        lineCanvas.width = canvas.width;
        lineImg = lineCtx.createImageData(canvas.width, 1);
        const compact = ui.layout === 'mobile';
        geom = compact
            ? { tickY: 1, trackY: 8, trackH: Math.max(12, hgt - 22), labelY: hgt - 3 }
            : { tickY: 1, trackY: 10, trackH: Math.max(14, hgt - 26), labelY: hgt - 3 };
        geomDirty = false;
    }

    function computeWindow() {
        const range = clock.range;
        if (range && Number.isFinite(range.fromMs) && range.toMs > range.fromMs) {
            win = { start: range.fromMs, span: range.toMs - range.fromMs, range: true };
            return;
        }
        const W = halfWindowFor(clock.rate);
        const t = clock.tMs;
        const centre = drag ? drag.centre : t + offsetMs;
        win = { start: centre - W, span: 2 * W, range: false };
    }

    function ensureSeries() {
        if (win.span > 6.5 * DAY) return;
        const key = ui.observerKey();
        const s0 = win.start, s1 = win.start + win.span;
        const margin = win.span * 0.25;
        const ok = series.values && series.key === key && s0 >= series.fromMs + margin && s1 <= series.toMs - margin;
        if (ok) return;
        const app = ui.almanac.sun;
        if (app?.values?.length > 1 && app.key === key && s0 >= app.fromMs && s1 <= app.toMs
            && !(series.values && series.key === key && s0 >= series.fromMs && s1 <= series.toMs)) {
            series.fromMs = app.fromMs; series.toMs = app.toMs; series.n = app.values.length; series.values = app.values; series.key = key;
        }
        const astro = ctx.services?.astro;
        if (!astro?.call || seriesCtl) return;
        if (performance.now() - seriesLast < Math.min(30000, 300 * 2 ** seriesFails)) return;
        const c = win.start + win.span / 2;
        const fromMs = c - 1.5 * win.span, toMs = c + 1.5 * win.span, n = 288;
        const ac = new AbortController();
        seriesCtl = ac;
        seriesLast = performance.now();
        let p;
        try { p = astro.call('sunSeries', { observer: ui.astroObserver(), fromMs, toMs, n }, { signal: ac.signal }); }
        catch { seriesCtl = null; seriesFails += 1; return; }
        Promise.resolve(p).then((vals) => {
            seriesCtl = null;
            const values = vals?.values || vals;
            if (!values || !(values.length > 1)) { seriesFails += 1; return; }
            seriesFails = 0;
            series.fromMs = fromMs; series.toMs = toMs; series.n = values.length; series.values = values; series.key = key;
            kick();
        }, () => { seriesCtl = null; if (!ac.signal.aborted) seriesFails += 1; });
    }
    offs.push(store.subscribe((s) => s.observer, () => { seriesCtl?.abort(); seriesCtl = null; seriesLast = 0; series.values = null; kick(); }));

    function drawGradient(obs) {
        const cw = canvas.width;
        const data = lineImg.data;
        const lat = obs.latDeg, lon = obs.lonDeg;
        const wide = win.span > 6.5 * DAY;
        const key = ui.observerKey(obs);
        const useSeries = !wide && series.values && series.key === key;
        const sv = series.values, sn = series.n, sf = series.fromMs, sspan = series.toMs - series.fromMs;
        for (let x = 0; x < cw; x += 1) {
            const t = win.start + ((x + 0.5) / cw) * win.span;
            let r, g, b;
            if (wide) {
                const k = smooth(0.22, 0.78, dayFraction(t, lat));
                r = C_NIGHT[0] + (C_DAY[0] - C_NIGHT[0]) * k;
                g = C_NIGHT[1] + (C_DAY[1] - C_NIGHT[1]) * k;
                b = C_NIGHT[2] + (C_DAY[2] - C_NIGHT[2]) * k;
            } else {
                let alt;
                if (useSeries && t >= sf && t <= sf + sspan) {
                    const f = ((t - sf) / sspan) * (sn - 1);
                    const i = Math.min(sn - 2, Math.max(0, Math.floor(f)));
                    const u = f - i;
                    alt = sv[i] * (1 - u) + sv[i + 1] * u;
                } else {
                    alt = sunAltApprox(t, lat, lon);
                }
                const li = Math.round((clamp(alt, LUT_MIN, LUT_MIN + (LUT_N - 1) * LUT_STEP) - LUT_MIN) / LUT_STEP) * 3;
                r = LUT[li]; g = LUT[li + 1]; b = LUT[li + 2];
            }
            const o = x * 4;
            data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
        lineCtx.putImageData(lineImg, 0, 0);
        const y = geom.trackY * dpr, th = geom.trackH * dpr;
        g2d.save();
        roundRect(g2d, 0, y, cw, th, Math.min(8, geom.trackH / 2) * dpr);
        g2d.clip();
        g2d.imageSmoothingEnabled = false;
        g2d.drawImage(lineCanvas, 0, 0, cw, 1, 0, y, cw, th);
        // Soft top sheen for depth.
        const sheen = g2d.createLinearGradient(0, y, 0, y + th);
        sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
        sheen.addColorStop(0.45, 'rgba(255,255,255,0.0)');
        sheen.addColorStop(1, 'rgba(0,0,0,0.18)');
        g2d.fillStyle = sheen;
        g2d.fillRect(0, y, cw, th);
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
                const dom = new Date(t + offMs).getUTCDate();
                if (dom === 1 || (dom % 5 === 0 && dom < 30)) majors.push(t);
            }
        } else {
            const z = ui.zoned(start);
            for (let k = 0; k < 30; k += 1) {
                const t = Date.UTC(z.y, z.mo - 1 + k, 1) - offMs;
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

    function majorLabel(kind, t, offMs) {
        const d = new Date(t + offMs);
        const hh = d.getUTCHours();
        if (kind === 'h') {
            if (hh === 0) return `${ui.WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
            if (store.get().display?.hour12) return `${hh % 12 || 12} ${hh < 12 ? 'AM' : 'PM'}`;
            return `${pad2(hh)}:00`;
        }
        if (kind === 'd') return `${ui.WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
        if (kind === 'D') return `${d.getUTCDate()} ${ui.MONTHS[d.getUTCMonth()]}`;
        return d.getUTCMonth() === 0 ? `${ui.MONTHS[0]} ${d.getUTCFullYear()}` : ui.MONTHS[d.getUTCMonth()];
    }

    function drawTicks() {
        tickCount = 0;
        const list = ui.events?.list;
        if (!list || !list.length) return;
        const start = win.start, end = start + win.span, cw = canvas.width;
        const y = (geom.tickY + 3.5) * dpr;
        const r = 2.6 * dpr;
        // Binary search the first event in the window (list is sorted).
        let lo = 0, hi = list.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].tMs < start) lo = mid + 1; else hi = mid; }
        for (let i = lo; i < list.length && tickCount < tickX.length; i += 1) {
            const ev = list[i];
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
        const obs = store.get().observer;
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
    const xFromEvent = (e) => clamp(e.clientX - scrub.getBoundingClientRect().left, 0, cssW);
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
    offs.push(on(scrub, 'pointerleave', () => { hoverX = -1; if (!drag) tip.hidden = true; }));
    offs.push(on(scrub, 'pointerdown', (e) => {
        if (e.button > 0) return;
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
    offs.push(ui.on('events', kick));
    offs.push(ui.on('almanac', kick));
    offs.push(on(window, 'resize', () => { geomDirty = true; kick(); }));
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { geomDirty = true; kick(); }) : null;
    ro?.observe(scrub);
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
        toolsEl,
        update() { if (!raf) { syncControls(); kick(); } },
        destroy() {
            offs.forEach((off) => off());
            ro?.disconnect();
            clearTimeout(secTimer);
            if (raf) cancelAnimationFrame(raf);
            seriesCtl?.abort();
            closeDate(); closeLapse();
            datePop.remove(); lapsePop.remove();
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
