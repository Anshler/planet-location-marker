/**
 * Time-lapse video export (ROADMAP timelapse-video-export): the Share menu's 'Video' dialog.
 * Presets (a day here, a night of turning stars, the 2027 eclipse chase), landscape 1920×1080 or
 * vertical 1080×1920, then Record: progress with a live preview and Cancel, then the clip with
 * Download and (where the browser shares files) Share. The date stamp, the place and the brand are
 * burned into every frame here (`paintStamp`); labels come from the capture.
 *
 * The recording runs in app/recorder.js through `actions.recordVideo` (rule R3: no renderer here).
 * Support: WebCodecs (Chrome, Edge and Opera 94+, Safari 16.4+, Firefox 130+ on desktop) encodes
 * MP4 offline, faster or slower than real time; elsewhere MediaRecorder records in real time (MP4
 * in Safari, WebM elsewhere). Hidden in text mode.
 *
 * @module ui/video
 */

import { APP_NAME } from '../version.js';
import { h, on, setText, trapFocus, segmented } from './dom.js';
import { icon } from './icons.js';
import { drawMark, fileStem } from './postcard.js';

/** Mirrors app/recorder.js VIDEO_PRESETS / VIDEO_SIZES (the recorder loads on the first Record). */
export const VIDEO_UI_PRESETS = Object.freeze([
    Object.freeze({ id: 'day', label: 'A day', detail: 'The next 24 hours from here, in this view · 12 s' }),
    Object.freeze({ id: 'night', label: 'A night of turning stars', detail: 'Dusk to dawn as a growing long exposure · 15 s' }),
    Object.freeze({ id: 'eclipse', label: '2027 eclipse', detail: 'Ride the Moon’s shadow across the Earth, 2 August 2027 · 24 s' }),
]);
const SIZES = Object.freeze([
    Object.freeze({ id: 'landscape', label: '1920 × 1080' }),
    Object.freeze({ id: 'vertical', label: '1080 × 1920' }),
]);
/** Which browsers record, for the dialog. */
const BROWSERS = 'Frame-exact MP4 needs WebCodecs: Chrome, Edge and Opera 94+, Safari 16.4+, Firefox 130+ (desktop). Other browsers with MediaRecorder record in real time.';
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ACCENT = '#7cc4ff';

const ERRORS = Object.freeze({
    unsupported: "This browser can't record video. Chrome, Edge, Firefox 130+ and Safari 16.4+ can.",
    'no-3d': 'Videos need the 3D view.',
    busy: 'A recording is already running.',
    'no-night': "The Sun doesn't set far enough here for star trails.",
    'no-path': 'The eclipse path could not be computed.',
    cancelled: 'Recording cancelled.',
    changed: 'Recording stopped: the time was changed.',
    failed: 'The recording failed. Try again, or try a smaller size.',
});

/**
 * How this browser will record, for the dialog's note.
 * @param {any} [env]
 * @returns {{kind:'webcodecs'|'mediarecorder'|null, text:string}}
 */
export function videoSupport(env = globalThis) {
    if (typeof env.VideoEncoder === 'function' && typeof env.VideoFrame === 'function') {
        return { kind: 'webcodecs', text: 'Encoded on this device as MP4 (WebCodecs), frame by frame: the time step is exact.' };
    }
    if (typeof env.MediaRecorder === 'function' && typeof env.HTMLCanvasElement?.prototype?.captureStream === 'function') {
        return { kind: 'mediarecorder', text: 'Recorded in real time (MediaRecorder): keep this tab in front. MP4 or WebM, as the browser records it.' };
    }
    return { kind: null, text: ERRORS.unsupported };
}

/** The stamp's band at the bottom of a frame, as a share of its shorter side (recorder stampBand). */
export const STAMP_BAND = 230 / 1080;

/**
 * Burns the stamp into a frame: the date and time (eyebrow), the place (or the eclipse), the brand.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 * @param {{stamp:string, place:string}} words
 */
export function paintStamp(ctx, W, H, words) {
    const s = Math.min(W, H) / 1080;
    const pad = Math.round(44 * s);
    const band = STAMP_BAND * Math.min(W, H);
    const g = ctx.createLinearGradient(0, H - band, 0, H);
    g.addColorStop(0, 'rgba(3, 6, 13, 0)');
    g.addColorStop(1, 'rgba(3, 6, 13, .7)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - band, W, band);
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0, 0, 0, .55)';
    ctx.shadowBlur = 8 * s;
    ctx.font = `800 ${Math.round(24 * s)}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.1em';
    ctx.fillStyle = ACCENT;
    ctx.fillText(words.stamp.toUpperCase(), pad, H - pad - 52 * s);
    ctx.font = `760 ${Math.round(40 * s)}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.01em';
    ctx.fillStyle = '#f4f7fc';
    ctx.fillText(words.place, pad, H - pad);
    ctx.shadowBlur = 0;
    const mark = Math.round(30 * s);
    ctx.font = `760 ${Math.round(22 * s)}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.01em';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#eef3fb';
    const nameW = ctx.measureText(APP_NAME).width;
    // Under the place on a narrow (vertical) frame, beside it on a wide one.
    const wide = W > H;
    const y = wide ? H - pad : pad + mark;
    ctx.fillText(APP_NAME, W - pad, y - (wide ? 4 * s : 6 * s));
    drawMark(ctx, W - pad - nameW - mark - 10 * s, y - mark, mark);
    ctx.restore();
}

/**
 * Mounts the video dialog.
 * @param {HTMLElement} host
 * @param {any} ctx UiCtx
 * @returns {{open():void, destroy():void}}
 */
export function mountVideo(host, ctx) {
    const { ui, bus, store } = ctx;
    const offs = [];
    let preset = VIDEO_UI_PRESETS[0].id;
    let size = SIZES[0].id;
    let abort = null;
    let file = null;
    let url = '';

    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, icon('close', { size: 18 }));
    const presetSeg = segmented({
        label: 'Time-lapse', options: VIDEO_UI_PRESETS.map((p) => ({ value: p.id, label: p.label })), value: preset,
        onChange: (v) => { preset = v; syncDetail(); }, className: 'vid__presets',
    });
    const sizeSeg = segmented({
        label: 'Frame', options: SIZES.map((p) => ({ value: p.id, label: p.label })), value: size,
        onChange: (v) => { size = v; }, className: 'vid__sizes',
    });
    const detail = h('p', { class: 'vid__detail' });
    const support = h('p', { class: 'vid__support' });
    const preview = h('canvas', { class: 'vid__preview', width: 320, height: 180, 'aria-hidden': 'true' });
    const player = h('video', { class: 'vid__player', controls: true, loop: true, muted: true, playsinline: true, hidden: true });
    const frameBox = h('div', { class: 'pc__frame vid__frame' }, preview, player);
    const bar = h('div', { class: 'vid__bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Recording progress' },
        h('span', { class: 'vid__fill' }));
    const status = h('p', { class: 'pc__note vid__status', role: 'status' });
    const recordBtn = h('button', { class: 'btn btn--primary', type: 'button' }, icon('video', { size: 16 }), 'Record');
    const cancelBtn = h('button', { class: 'btn btn--ghost', type: 'button', hidden: true }, 'Cancel');
    const dlBtn = h('button', { class: 'btn btn--ghost', type: 'button', hidden: true }, icon('download', { size: 16 }), 'Download');
    const shareBtn = h('button', { class: 'btn btn--primary', type: 'button', hidden: true }, icon('share', { size: 16 }), 'Share');
    const setup = h('div', { class: 'vid__setup' }, presetSeg.el, detail, sizeSeg.el, support);
    const dialog = h('div', { class: 'dialog pc vid glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'vid-title' },
        h('header', { class: 'dialog__head' }, h('h2', { class: 'dialog__title', id: 'vid-title' }, icon('video', { size: 20 }), 'Time-lapse video'), closeBtn),
        setup, frameBox, bar, status,
        h('div', { class: 'pc__actions' }, cancelBtn, dlBtn, shareBtn, recordBtn));
    const layer = h('div', { class: 'modal-layer vid-layer', hidden: true }, h('div', { class: 'modal-backdrop' }), dialog);
    host.appendChild(layer);
    let release = null;
    const pctx = preview.getContext('2d');
    player.muted = true;

    function syncDetail() {
        setText(detail, VIDEO_UI_PRESETS.find((p) => p.id === preset)?.detail ?? '');
    }

    function revoke() {
        if (url) URL.revokeObjectURL(url);
        url = '';
    }

    function setPhase(phase) {
        const rec = phase === 'recording';
        layer.classList.toggle('is-recording', rec);
        document.documentElement.classList.toggle('is-recording', rec);
        setup.hidden = rec || phase === 'done';
        recordBtn.hidden = rec;
        setText(recordBtn.lastChild, phase === 'done' ? 'Record another' : 'Record');
        cancelBtn.hidden = !rec;
        bar.hidden = !rec;
        frameBox.hidden = phase === 'setup';
        preview.hidden = phase === 'done';
        player.hidden = phase !== 'done';
        dlBtn.hidden = shareBtn.hidden = phase !== 'done';
        closeBtn.disabled = rec;
    }

    /** The stamp's words: the observer's local date and place, or the eclipse in UTC. */
    function wordsAt(t) {
        if (preset === 'eclipse') {
            const d = new Date(t);
            const pad2 = (n) => String(n).padStart(2, '0');
            return { stamp: `${d.getUTCDate()} August ${d.getUTCFullYear()} · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`, place: 'Total solar eclipse' };
        }
        return { stamp: `${ui.fmtDay(t)} · ${ui.fmtClock(t)} ${ui.offsetText(t)}`, place: ui.placeLabel(store.get().observer) };
    }

    async function record() {
        if (abort) return;
        const sup = videoSupport();
        if (!sup.kind) { setText(status, ERRORS.unsupported); return; }
        revoke();
        file = null;
        player.removeAttribute('src');
        const vertical = size === 'vertical';
        preview.width = vertical ? 180 : 320;
        preview.height = vertical ? 320 : 180;
        pctx.fillStyle = '#02040a';
        pctx.fillRect(0, 0, preview.width, preview.height);
        abort = new AbortController();
        setPhase('recording');
        setText(status, 'Preparing…');
        const t0 = performance.now();
        const stem = fileStem(ctx, ctx.clock.tMs);
        const res = await ui.act('recordVideo', {
            preset, size, signal: abort.signal, name: stem,
            paint: (c2d, W, H, t) => paintStamp(c2d, W, H, wordsAt(t)), stampBand: STAMP_BAND,
            onProgress: ({ done, total, preview: frame }) => {
                const pct = Math.round((100 * done) / total);
                bar.firstChild.style.width = `${pct}%`;
                bar.setAttribute('aria-valuenow', String(pct));
                const el = (performance.now() - t0) / 1000;
                const left = done > 3 ? Math.max(0, Math.round((el / done) * (total - done))) : null;
                setText(status, `Frame ${done} of ${total}${left !== null ? ` · about ${left} s left` : ''}`);
                if (frame) pctx.drawImage(frame, 0, 0, preview.width, preview.height);
            },
        });
        abort = null;
        if (!res || res.error) {
            setPhase('setup');
            setText(status, ERRORS[res?.error] ?? ERRORS.failed);
            return;
        }
        try {
            file = new File([res.blob], res.name, { type: res.mime, lastModified: Date.now() });
        } catch {
            file = /** @type {any} */ (res.blob);
            file.name = res.name;
        }
        url = URL.createObjectURL(res.blob);
        player.src = url;
        setPhase('done');
        const secs = (res.frames / res.fps).toFixed(1);
        setText(status, `${res.width} × ${res.height} · ${secs} s at ${res.fps} fps · ${Math.max(1, Math.round(res.blob.size / 1024))} KB · ${res.method}`);
        shareBtn.hidden = !canShareFiles(file);
        player.play?.()?.catch?.(() => {});
        bus.emit('toast', { message: 'Video ready', kind: 'info', timeoutMs: 2500 });
    }

    function canShareFiles(f) {
        try {
            return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] });
        } catch {
            return false;
        }
    }

    function download() {
        if (!file || !url) return;
        const a = h('a', { href: url, download: file.name || 'timelapse.mp4', hidden: true });
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function share() {
        if (!file) return;
        navigator.share({ files: [file], title: APP_NAME, text: APP_NAME }).catch((err) => {
            if (err?.name !== 'AbortError') download();
        });
    }

    function close() {
        if (layer.hidden || abort) return;
        layer.hidden = true;
        layer.classList.remove('is-open');
        release?.(); release = null;
        player.pause?.();
        player.removeAttribute('src');
        revoke();
        file = null;
    }

    function open() {
        setPhase('setup');
        syncDetail();
        const sup = videoSupport();
        setText(support, `${sup.text} ${BROWSERS}`);
        recordBtn.disabled = !sup.kind;
        setText(status, '');
        layer.hidden = false;
        layer.classList.add('is-open');
        release = trapFocus(dialog, { initial: recordBtn });
    }

    offs.push(on(closeBtn, 'click', close));
    offs.push(on(layer.querySelector('.modal-backdrop'), 'click', close));
    offs.push(on(dialog, 'keydown', (e) => {
        // Keys stay in the dialog while it is open (the app's shortcuts would change the clock).
        e.stopPropagation();
        if (e.key === 'Escape') {
            e.preventDefault();
            if (abort) abort.abort();
            else close();
        }
    }));
    offs.push(on(recordBtn, 'click', () => {
        if (abort) return;
        if (!setup.hidden) record();
        else { setPhase('setup'); setText(status, ''); }
    }));
    offs.push(on(cancelBtn, 'click', () => abort?.abort()));
    offs.push(on(dlBtn, 'click', download));
    offs.push(on(shareBtn, 'click', share));

    return {
        open,
        destroy() {
            abort?.abort();
            abort = null;
            close();
            offs.forEach((off) => off());
            layer.remove();
        },
    };
}
