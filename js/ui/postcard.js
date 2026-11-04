/**
 * Sky Postcard (ROADMAP sky-postcard) and the long exposure's 'Save image': one dialog and one
 * export path.
 *
 * - Postcard: the current view rendered at the card's OWN size and aspect (1080×1350 portrait,
 *   1200×630 link preview, 1080×1920 story) through `actions.capture` (app/capture.js: one-task
 *   resize, render, read, restore; labels reprojected for that camera), then a typographic band:
 *   local date and time, the place, 'Up now: …', the selected body's sentence and the brand mark.
 *   Text mode (no 3D view) gets the same band on a drawn night sky.
 * - Photo ('Save image' in a long exposure): the screen frame itself, the stack included, with a
 *   one-line caption.
 *
 * The image is prepared as soon as the dialog opens (and again for another preset), so the Share
 * tap calls navigator.share({files}) at once: iOS only shares with a fresh user activation, which
 * an await of toBlob() would lose. Without file sharing, Download saves it.
 *
 * The UI reaches the renderer only through `actions.capture` (rule R3).
 *
 * @module ui/postcard
 */

import { APP_NAME } from '../version.js';
import { h, on, setText, trapFocus, segmented, clamp } from './dom.js';
import { icon } from './icons.js';

/** Card presets: device px. */
export const POSTCARD_PRESETS = Object.freeze([
    Object.freeze({ id: 'portrait', label: 'Portrait', w: 1080, h: 1350, note: '4:5 · feeds' }),
    Object.freeze({ id: 'wide', label: 'Link', w: 1200, h: 630, note: '1.91:1 · link previews' }),
    Object.freeze({ id: 'story', label: 'Story', w: 1080, h: 1920, note: '9:16 · stories' }),
]);
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ACCENT = '#7cc4ff';
const JPEG_Q = 0.92;

/**
 * The capture's pixel ratio for a card: its shorter side reads like a ~450-CSS-px phone view, so
 * labels, lines and stars keep their on-screen proportions.
 * @param {number} w
 * @param {number} h
 */
export function captureScale(w, h) {
    return clamp(Math.min(w, h) / 450, 1, 3);
}

/**
 * Greedy word wrap into at most `maxLines` lines no wider than `maxW` (the last one ellipsised).
 * @param {string} text
 * @param {number} maxW
 * @param {(s:string)=>number} measure
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function wrapLines(text, maxW, measure, maxLines = 2) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
        const next = cur ? `${cur} ${words[i]}` : words[i];
        if (!cur || measure(next) <= maxW) {
            cur = next;
            continue;
        }
        if (lines.length >= maxLines - 1) {
            // The last line takes the rest and is ellipsised below.
            cur = `${cur} ${words.slice(i).join(' ')}`;
            break;
        }
        lines.push(cur);
        cur = words[i];
    }
    if (cur) lines.push(cur);
    const last = lines.length - 1;
    if (last >= 0 && measure(lines[last]) > maxW) {
        let s = lines[last];
        while (s.length > 1 && measure(`${s}…`) > maxW) s = s.slice(0, -1).trimEnd();
        lines[last] = `${s}…`;
    }
    return lines;
}

/**
 * 'Up now: Saturn 51° NW, Neptune 47° WNW' from {name, alt, dir} rows (highest first), or the
 * empty-sky sentence.
 * @param {{name:string, alt:number, dir:string}[]} up
 */
export function upNowText(up) {
    if (!up.length) return 'Nothing is above the horizon.';
    return `Up now: ${up.map((u) => `${u.name} ${Math.round(u.alt)}° ${u.dir}`).join(', ')}`;
}

/**
 * The card's words from the UI hub and the latest snapshot.
 * @param {any} ctx UiCtx
 * @returns {{stamp:string, place:string, up:string, sentence:string}}
 */
export function cardWords(ctx) {
    const { ui, store } = ctx;
    const snap = ui.snap;
    const st = store.get();
    const t = Number.isFinite(snap?.tMs) ? snap.tMs : ctx.clock?.tMs;
    const stamp = `${ui.fmtDay(t)} · ${ui.fmtClock(t)} ${ui.offsetText(t)}`;
    const place = ui.placeLabel(st.observer);
    const up = [];
    for (const b of snap?.bodies ?? []) {
        const { alt, az } = ui.altAz(b);
        if (Number.isFinite(alt) && alt > 0) up.push({ name: ui.bodyName(b.id), alt, dir: ui.compass(az) });
    }
    up.sort((a, b) => b.alt - a.alt);
    let sentence = '';
    const id = st.selection;
    const b = id ? ui.bodyOf(snap, id) : null;
    if (b) {
        const { alt, az } = ui.altAz(b);
        const con = b.constellation?.name || '';
        const subject = ui.bodySubject(id);
        if (Number.isFinite(alt)) {
            const where = ui.compassWords(az);
            if (alt >= 80) sentence = `${subject} is nearly overhead (${Math.round(alt)}°)`;
            else if (alt > 0) sentence = `${subject} is ${Math.round(alt)}° above the ${where} horizon`;
            else sentence = `${subject} is ${Math.abs(Math.round(alt))}° below the ${where} horizon`;
            sentence += con ? `, in ${con}.` : '.';
        }
    }
    return { stamp, place, up: upNowText(up), sentence };
}

/** The brand mark (topbar.js brandMark) drawn at (x, y), `size` px square. */
function drawMark(ctx, x, y, size) {
    const k = size / 24;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    const g = ctx.createRadialGradient(9.6 - 7.2 * 0.28, 14.4 - 7.2 * 0.32, 0, 9.6, 14.4, 7.2 * 1.44);
    g.addColorStop(0, '#a8dcff');
    g.addColorStop(0.55, '#3a7fc4');
    g.addColorStop(1, '#0f2a4d');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(9.6, 14.4, 7.2, 0, Math.PI * 2); ctx.fill();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.moveTo(9.6, 14.4); ctx.lineTo(19.6, 4.4); ctx.stroke();
    ctx.fillStyle = '#ff6a3d';
    ctx.beginPath(); ctx.arc(19.9, 4.1, 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(9.6, 14.4, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}

function setFont(ctx, weight, px, track = 0, italic = false) {
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(px)}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${track}em`;
}

/** A night sky for text mode: a deep gradient and deterministic stars. */
function drawNight(ctx, W, H, seed) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#02040b');
    g.addColorStop(0.7, '#0a1530');
    g.addColorStop(1, '#16264a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    let s = (seed >>> 0) || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const n = Math.round((W * H) / 2600);
    for (let i = 0; i < n; i++) {
        const x = rnd() * W, y = rnd() * H * 0.85, m = rnd();
        const r = 0.5 + 1.8 * m * m * m;
        ctx.globalAlpha = 0.25 + 0.75 * m;
        ctx.fillStyle = m > 0.93 ? '#ffe6c4' : m > 0.86 ? '#cfe0ff' : '#ffffff';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
}

/**
 * Lays out the postcard band (bottom-up: footer, sentence, 'Up now', place, date). `top` is where
 * the text block starts: the capture keeps the scene's centre and its labels above it.
 * @param {CanvasRenderingContext2D} ctx any 2D context (for measuring)
 * @param {number} W
 * @param {number} H
 * @param {{stamp:string, place:string, up:string, sentence:string}} words
 * @param {{site?:string, story?:boolean}} [opts] site: host + path for the footer
 */
export function layoutBand(ctx, W, H, words, { site = '', story = false } = {}) {
    const wide = W > H;
    const s = (Math.min(W, H) / 1080) * (wide ? 1.3 : 1);
    const pad = Math.round((wide ? 52 : 68) * s);
    const maxW = W - 2 * pad;
    // Stories keep clear of the apps' own bottom UI.
    const bottom = H - Math.round((story ? 230 : wide ? 36 : 54) * s);
    const sz = { eye: 25 * s, place: 62 * s, up: 30 * s, sent: 28 * s, foot: 24 * s };
    const measureWith = (weight, px, track, italic) => (t) => { setFont(ctx, weight, px, track, italic); return ctx.measureText(t).width; };
    const placeLines = wrapLines(words.place, maxW, measureWith(780, sz.place, -0.01), 2);
    const upLines = wrapLines(words.up, maxW, measureWith(520, sz.up, 0), wide ? 1 : 2);
    const sentLines = words.sentence ? wrapLines(words.sentence, maxW, measureWith(500, sz.sent, 0, true), wide ? 1 : 2) : [];
    const gap = 14 * s;
    const footH = sz.foot * 1.2;
    let y = bottom;
    const footY = y - footH / 2;
    y -= footH + gap * 1.6;
    const sentY = y - sentLines.length * sz.sent * 1.3;
    y = sentY - (sentLines.length ? gap : 0);
    const upY = y - upLines.length * sz.up * 1.3;
    y = upY - gap * 0.8;
    const placeY = y - placeLines.length * sz.place * 1.08;
    y = placeY - gap * 0.6;
    const eyeY = y - sz.eye * 1.2;
    return {
        W, H, s, pad, maxW, sz, gap, footH, footY, sentY, upY, placeY, eyeY, top: eyeY - 24 * s,
        placeLines, upLines, sentLines, stamp: words.stamp, site,
    };
}

/**
 * Paints a laid-out band over the canvas (the scene is already there).
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof layoutBand>} L
 */
export function paintBand(ctx, L) {
    const { W, H, s, pad, maxW, sz, gap, footH, footY, sentY, upY, placeY, eyeY, placeLines, upLines, sentLines, site } = L;
    const top = eyeY - 60 * s;
    // The band: a soft fade from the scene into deep night blue.
    const g = ctx.createLinearGradient(0, Math.max(0, top - 120 * s), 0, H);
    g.addColorStop(0, 'rgba(3, 6, 13, 0)');
    g.addColorStop(0.35, 'rgba(3, 6, 13, 0.62)');
    g.addColorStop(1, 'rgba(3, 6, 13, 0.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, Math.max(0, top - 120 * s), W, H);

    ctx.save();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.shadowColor = 'rgba(0, 0, 0, .55)';
    ctx.shadowBlur = 10 * s;
    setFont(ctx, 800, sz.eye, 0.12);
    ctx.fillStyle = ACCENT;
    ctx.fillText(L.stamp.toUpperCase(), pad, eyeY);
    setFont(ctx, 780, sz.place, -0.01);
    ctx.fillStyle = '#f4f7fc';
    placeLines.forEach((l, i) => ctx.fillText(l, pad, placeY + i * sz.place * 1.08));
    setFont(ctx, 520, sz.up, 0);
    ctx.fillStyle = '#d5dde9';
    upLines.forEach((l, i) => ctx.fillText(l, pad, upY + i * sz.up * 1.3));
    setFont(ctx, 500, sz.sent, 0, true);
    ctx.fillStyle = '#a9b5c7';
    sentLines.forEach((l, i) => ctx.fillText(l, pad, sentY + i * sz.sent * 1.3));
    ctx.shadowBlur = 0;
    // Footer: hairline, brand mark + name, the site.
    ctx.fillStyle = 'rgba(255, 255, 255, .14)';
    ctx.fillRect(pad, footY - footH / 2 - gap * 0.8, maxW, Math.max(1, Math.round(1.5 * s)));
    const mark = Math.round(sz.foot * 1.25);
    drawMark(ctx, pad, footY - mark / 2, mark);
    ctx.textBaseline = 'middle';
    setFont(ctx, 760, sz.foot, 0.01);
    ctx.fillStyle = '#eef3fb';
    ctx.fillText(APP_NAME, pad + mark + 10 * s, footY);
    if (site) {
        setFont(ctx, 500, sz.foot * 0.86, 0.01);
        ctx.fillStyle = '#8f9bb0';
        ctx.textAlign = 'right';
        const nameW = (setFont(ctx, 760, sz.foot, 0.01), ctx.measureText(APP_NAME).width);
        setFont(ctx, 500, sz.foot * 0.86, 0.01);
        if (ctx.measureText(site).width < maxW - mark - nameW - 40 * s) ctx.fillText(site, W - pad, footY);
    }
    ctx.restore();
}

/**
 * A one-line caption along the bottom of a saved photo (long exposure).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W
 * @param {number} H
 * @param {string} caption
 */
export function drawCaption(ctx, W, H, caption) {
    const s = Math.max(0.6, Math.min(W, H) / 1080);
    const pad = Math.round(28 * s);
    const fs = 22 * s;
    const g = ctx.createLinearGradient(0, H - 110 * s, 0, H);
    g.addColorStop(0, 'rgba(3, 6, 13, 0)');
    g.addColorStop(1, 'rgba(3, 6, 13, .78)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - 110 * s, W, 110 * s);
    ctx.save();
    ctx.textBaseline = 'middle';
    const y = H - pad - fs * 0.5;
    const mark = Math.round(fs * 1.3);
    setFont(ctx, 760, fs, 0.01);
    const nameW = ctx.measureText(APP_NAME).width;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#eef3fb';
    ctx.fillText(APP_NAME, W - pad, y);
    drawMark(ctx, W - pad - nameW - mark - 8 * s, y - mark / 2, mark);
    ctx.textAlign = 'left';
    setFont(ctx, 560, fs, 0.01);
    ctx.fillStyle = '#d5dde9';
    const room = W - 2 * pad - nameW - mark - 40 * s;
    ctx.fillText(wrapLines(caption, room, (t) => ctx.measureText(t).width, 1)[0] ?? '', pad, y);
    ctx.restore();
}

/** canvas → Blob (JPEG), null on failure. */
function toBlob(canvas) {
    return new Promise((resolve) => {
        try {
            canvas.toBlob((b) => resolve(b ?? null), 'image/jpeg', JPEG_Q);
        } catch {
            resolve(null);
        }
    });
}

/** "paranal-2026-11-10-0100" from the place and the local time. */
function fileStem(ctx, t) {
    const z = ctx.ui.zoned(t);
    const pad2 = (n) => String(n).padStart(2, '0');
    const place = ctx.ui.placeShort(ctx.store.get().observer).toLowerCase().normalize('NFKD')
        .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'sky';
    return `${place}-${z.y}-${pad2(z.mo)}-${pad2(z.d)}-${pad2(z.h)}${pad2(z.mi)}`;
}

/**
 * Mounts the postcard / photo dialog.
 * @param {HTMLElement} host where the modal layer lives
 * @param {any} ctx UiCtx
 * @returns {{open(opts?:{mode?:'postcard'|'photo', caption?:string}):void, destroy():void}}
 */
export function mountPostcard(host, ctx) {
    const { ui, bus } = ctx;
    const offs = [];
    let preset = POSTCARD_PRESETS[0];
    let mode = 'postcard';
    let caption = '';
    let file = null;
    let url = '';
    let seq = 0;

    const titleText = h('span', null, 'Postcard');
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, icon('close', { size: 18 }));
    const seg = segmented({
        label: 'Card size',
        options: POSTCARD_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        value: preset.id,
        onChange: (v) => {
            preset = POSTCARD_PRESETS.find((p) => p.id === v) ?? POSTCARD_PRESETS[0];
            prepare();
        },
        className: 'pc__presets',
    });
    const img = h('img', { class: 'pc__img', alt: '' });
    const busy = h('div', { class: 'pc__busy', role: 'status' }, 'Rendering…');
    const frame = h('div', { class: 'pc__frame' }, img, busy);
    const note = h('p', { class: 'pc__note' });
    const dlBtn = h('button', { class: 'btn btn--ghost', type: 'button', disabled: true }, icon('download', { size: 16 }), 'Download');
    const shareBtn = h('button', { class: 'btn btn--primary', type: 'button', disabled: true, hidden: true }, icon('share', { size: 16 }), 'Share');
    const dialog = h('div', { class: 'dialog pc glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pc-title' },
        h('header', { class: 'dialog__head' }, h('h2', { class: 'dialog__title', id: 'pc-title' }, icon('postcard', { size: 20 }), titleText), closeBtn),
        seg.el, frame, note,
        h('div', { class: 'pc__actions' }, dlBtn, shareBtn));
    const layer = h('div', { class: 'modal-layer pc-layer', hidden: true }, h('div', { class: 'modal-backdrop' }), dialog);
    host.appendChild(layer);
    let release = null;

    function revoke() {
        if (url) URL.revokeObjectURL(url);
        url = '';
    }

    function canShareFiles(f) {
        try {
            return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [f] });
        } catch {
            return false;
        }
    }

    /** Renders the card (one task), then encodes it; Share and Download wait for the file. */
    async function prepare() {
        const my = ++seq;
        file = null;
        dlBtn.disabled = shareBtn.disabled = true;
        busy.hidden = false;
        layer.classList.add('is-busy');
        // Let the dialog and the spinner paint before the (synchronous) render.
        await new Promise((r) => setTimeout(r, 30));
        if (my !== seq || layer.hidden) return;
        const t = Number.isFinite(ui.snap?.tMs) ? ui.snap.tMs : ctx.clock.tMs;
        let canvas = null;
        let W, H;
        if (mode === 'photo') {
            canvas = ui.act('capture', { labels: false }) ?? null;
            if (canvas) {
                W = canvas.width; H = canvas.height;
                drawCaption(canvas.getContext('2d'), W, H, caption);
            }
        } else {
            W = preset.w; H = preset.h;
            let site = '';
            try { site = `${location.host}${location.pathname}`.replace(/\/index\.html$/, '/').replace(/\/$/, ''); } catch { site = ''; }
            const measure = document.createElement('canvas').getContext('2d');
            const band = layoutBand(measure, W, H, cardWords(ctx), { site, story: preset.id === 'story' });
            // The scene centres on, and its labels stay in, the part above the text.
            const scale = captureScale(W, H);
            canvas = ui.act('capture', { width: W, height: H, scale, labels: true, insetBottom: (H - band.top) / scale }) ?? null;
            if (!canvas) {
                // Text mode (or a lost context): the band on a drawn night sky.
                canvas = document.createElement('canvas');
                canvas.width = W; canvas.height = H;
                drawNight(canvas.getContext('2d'), W, H, Math.floor(t / 864e5));
            }
            paintBand(canvas.getContext('2d'), band);
        }
        if (!canvas) {
            busy.hidden = true;
            setText(note, "The image couldn't be rendered. Try again in a moment.");
            return;
        }
        const blob = await toBlob(canvas);
        if (my !== seq || layer.hidden) return;
        busy.hidden = true;
        layer.classList.remove('is-busy');
        if (!blob) {
            setText(note, "The image couldn't be saved on this device.");
            return;
        }
        const name = `${fileStem(ctx, t)}${mode === 'photo' ? '-exposure' : `-${preset.id}`}.jpg`;
        try {
            file = new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
        } catch {
            file = /** @type {any} */ (blob);
            file.name = name;
        }
        revoke();
        url = URL.createObjectURL(blob);
        img.src = url;
        img.alt = mode === 'photo' ? 'The long exposure as it will be saved' : `Postcard preview, ${preset.w} × ${preset.h}`;
        setText(note, `${W} × ${H} px · JPEG · ${Math.max(1, Math.round(blob.size / 1024))} KB${mode === 'photo' ? '' : ` · ${preset.note}`}`);
        dlBtn.disabled = false;
        shareBtn.hidden = !canShareFiles(file);
        shareBtn.disabled = shareBtn.hidden;
    }

    function download() {
        if (!file || !url) return;
        const a = h('a', { href: url, download: file.name || 'postcard.jpg', hidden: true });
        document.body.appendChild(a);
        a.click();
        a.remove();
        bus.emit('toast', { message: 'Image saved', kind: 'info', timeoutMs: 2500 });
    }

    function share() {
        if (!file) return;
        let link = '';
        try { link = ctx.actions?.shareUrl?.() || ''; } catch { link = ''; }
        const data = { files: [file], title: APP_NAME, text: link ? `${APP_NAME} — ${link}` : APP_NAME };
        // Called straight from the tap: the file is ready, so the user activation is still fresh.
        navigator.share(data).catch((err) => {
            if (err?.name !== 'AbortError') download();
        });
    }

    function close() {
        if (layer.hidden) return;
        seq++;
        layer.hidden = true;
        layer.classList.remove('is-open', 'is-busy');
        release?.(); release = null;
        revoke();
        img.removeAttribute('src');
        file = null;
    }

    function open({ mode: m = 'postcard', caption: c = '' } = {}) {
        mode = m === 'photo' ? 'photo' : 'postcard';
        caption = c;
        setText(titleText, mode === 'photo' ? 'Save the exposure' : 'Postcard');
        seg.el.hidden = mode === 'photo';
        layer.classList.toggle('is-photo', mode === 'photo');
        setText(note, '');
        layer.hidden = false;
        layer.classList.add('is-open');
        release = trapFocus(dialog, { initial: mode === 'photo' ? dlBtn : seg.el.querySelector('.is-on') });
        prepare();
    }

    offs.push(on(closeBtn, 'click', close));
    offs.push(on(layer.querySelector('.modal-backdrop'), 'click', close));
    offs.push(on(dialog, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }));
    offs.push(on(dlBtn, 'click', download));
    offs.push(on(shareBtn, 'click', share));

    return {
        open,
        destroy() {
            close();
            offs.forEach((off) => off());
            layer.remove();
        },
    };
}
