import { updateScene, getUTCDate } from './ui.js';
import { state } from './state.js';

/* ---------------- DOM REFS ---------------- */

const animToggleBtn = document.getElementById('animToggleBtn');
const animControls  = document.getElementById('animControls');
const modeRealtime  = document.getElementById('modeRealtime');
const modeTimelapse = document.getElementById('modeTimelapse');
const tlDateRange   = document.getElementById('tlDateRange');
const tlFromInput   = document.getElementById('tlFromInput');
const tlToInput     = document.getElementById('tlToInput');
const tlDuration    = document.getElementById('tlDuration');
const animPlayBtn   = document.getElementById('animPlayBtn');
const animSlider    = document.getElementById('animSlider');

/* ---------------- HELPERS ---------------- */

function formatForTimezone(date, tz) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return {
        dateStr: `${p.year}-${p.month}-${p.day}`,
        timeStr: `${p.hour}:${p.minute}:${p.second}`
    };
}

function getAnimDuration() {
    return Math.max(1, Number.parseFloat(tlDuration.value) || 1);
}

function getSwappedRange() {
    let from = new Date(tlFromInput.value);
    let to   = new Date(tlToInput.value);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
    if (from > to) { [from, to] = [to, from]; }
    return { from, to };
}

/* ---------------- ANIMATION LOOP ---------------- */

function animLoop(ts) {
    state.animRafHandle = requestAnimationFrame(animLoop);
    if (ts - state.animLastTs < 33.3) return;
    state.animLastTs = ts;

    const tz = timezoneSelect.value;

    if (state.animMode === 'timelapse') {
        const wallElapsed_s  = (performance.now() - state.animStartWall) / 1000;
        const totalElapsed_s = state.animPausedAt / 1000 + wallElapsed_s;
        const progress       = Math.min(totalElapsed_s / state.animDuration, 1);
        const simTime        = new Date(state.animFromDate.getTime() + progress * (state.animToDate - state.animFromDate));

        const { dateStr, timeStr } = formatForTimezone(simTime, tz);
        dateTimeInput.value = `${dateStr}T${timeStr}`;
        animSlider.value    = Math.round(progress * 100);
        updateScene();

        if (progress >= 1) stopAnimation();
    } else {
        const wallElapsed = performance.now() - state.animStartWall;
        const simTime     = new Date(state.animRealtimeBase.getTime() + wallElapsed);

        const { dateStr, timeStr } = formatForTimezone(simTime, tz);
        dateTimeInput.value = `${dateStr}T${timeStr}`;
        updateScene();
    }
}

/* ---------------- LIFECYCLE ---------------- */

function stopAnimation() {
    if (state.animRafHandle) cancelAnimationFrame(state.animRafHandle);
    state.animRafHandle = null;
    state.animPlaying   = false;
    state.animPausedAt  = 0;
    state.animLastTs    = 0;

    animPlayBtn.textContent = '▶';
    animSlider.value = 0;

    if (state.animMode === 'timelapse' && state.animFromDate) {
        const { dateStr, timeStr } = formatForTimezone(state.animFromDate, timezoneSelect.value);
        dateTimeInput.value = `${dateStr}T${timeStr}`;
        updateScene();
    }
}

function pauseAnimation() {
    if (state.animRafHandle) cancelAnimationFrame(state.animRafHandle);
    state.animRafHandle = null;

    if (state.animMode === 'timelapse') {
        state.animPausedAt += performance.now() - state.animStartWall;
    } else {
        state.animRealtimeBase = new Date(state.animRealtimeBase.getTime() + (performance.now() - state.animStartWall));
    }

    state.animPlaying = false;
    animPlayBtn.textContent = '▶';
}

function startAnimation() {
    if (!state.redMarker) return;

    if (state.animMode === 'timelapse') {
        const range = getSwappedRange();
        if (!range) return;
        if (range.from.getTime() === range.to.getTime()) return;
        state.animFromDate = range.from;
        state.animToDate   = range.to;
        state.animDuration = getAnimDuration();
    } else if (state.animRealtimeBase === null) {
        state.animRealtimeBase = getUTCDate();
    }

    state.animStartWall = performance.now();
    state.animPlaying   = true;
    animPlayBtn.textContent = '⏸';
    state.animRafHandle = requestAnimationFrame(animLoop);
}

/* ---------------- UI EVENT HANDLERS ---------------- */

export function updatePlayBtnState() {
    animPlayBtn.disabled = !state.redMarker;
}

animToggleBtn.addEventListener('click', () => {
    const visible = animControls.style.display === 'none';
    animControls.style.display = visible ? '' : 'none';
    if (!visible) {
        stopAnimation();
        setMainPickerDisabled(false);
        modeRealtime.checked = true;
        state.animMode = 'realtime';
        tlDateRange.style.display = 'none';
        animSlider.style.opacity  = '0.35';
    }
});

animPlayBtn.addEventListener('click', () => {
    if (state.animPlaying) pauseAnimation();
    else startAnimation();
});

function setMainPickerDisabled(disabled) {
    dateTimeInput.style.pointerEvents = disabled ? 'none' : '';
}

function onModeChange(mode) {
    state.animMode = mode;
    if (state.animPlaying) stopAnimation();
    tlDateRange.style.display  = mode === 'timelapse' ? '' : 'none';
    animSlider.style.opacity   = mode === 'timelapse' ? '1' : '0.35';
    setMainPickerDisabled(mode === 'timelapse');
}

modeRealtime.addEventListener('change',  () => onModeChange(modeRealtime.value));
modeTimelapse.addEventListener('change', () => onModeChange(modeTimelapse.value));

[tlFromInput, tlToInput, tlDuration].forEach(el => {
    el.addEventListener('change', () => {
        stopAnimation();
    });
});

/* ---------------- EXTERNAL CHANGE HANDLER ---------------- */

export function handleExternalChange() {
    stopAnimation();
    state.animRealtimeBase = null;
}

/* ---------------- INIT ---------------- */

state.onMarkerSet      = updatePlayBtnState;
state.onExternalChange = handleExternalChange;
updatePlayBtnState();
