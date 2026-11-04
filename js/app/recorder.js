// Time-lapse video export (ROADMAP timelapse-video-export), loaded on demand by actions.recordVideo.
//
//   videoPlan(preset, ctx) → {segments, frames}                       (pure, unit-tested)
//   nightSpan(tMs, observer, scratch) → {fromMs, toMs}|null            (pure)
//   pickEncoder(env) → 'webcodecs' | 'mediarecorder' | null
//   recordVideo(deps, opts) → Promise<{blob, name, mime, frames, width, height, fps, method}>
//
// Deterministic frames: the rAF loop is stopped and every frame is one loop.step() on a virtual
// time base (1000/fps ms a frame; the rig's tweens and follow() read the same clock through
// render.video.setNow), so the simulated Δt per frame is fixed and a slow GPU only takes longer.
// Simulated time advances through clock ranges (a timelapse the clock already knows: linear, or
// eased legs for the eclipse chase) and holds. Each frame renders at the video's size inside one
// capture session (rc.beginCapture … endCapture: render/context.js), its labels are reprojected and
// painted (app/capture.js session), then the caller's `paint` burns in the date stamp.
//
// Encoding: WebCodecs VideoEncoder (H.264 High, else VP9) into an in-repo MP4 muxer (app/mp4.js),
// offline and as fast as the GPU allows. Without WebCodecs, MediaRecorder on the 2D canvas's
// captureStream(0) with track.requestFrame() after each frame, paced in real time (MP4 where the
// browser records it, WebM elsewhere). One frame per task: the main thread is never held for long,
// the encoder's queue applies backpressure, and `signal` (AbortSignal) cancels between frames.
//
// Everything the recording changes (clock, view, camera, exposure, the eclipse focus) is put back,
// and a clock change by anyone else cancels it.

import { createSnapshot, computeSnapshot } from '../astro/snapshot.js';
import { trailsLook, nextDarkMs, DARK_SUN_DEG } from './expose.js';
import { chaseLegs, chaseTarget, CHASE_POSE } from './eclipse-chase.js';
import { createMp4Muxer } from './mp4.js';

/** The video presets: id, Share-menu label, how long the clip runs (s). */
export const VIDEO_PRESETS = Object.freeze([
    Object.freeze({ id: 'day', label: 'A day', detail: 'The next 24 hours in this view', seconds: 12 }),
    Object.freeze({ id: 'night', label: 'Star trails', detail: 'Dusk to dawn as a growing long exposure', seconds: 15 }),
    Object.freeze({ id: 'eclipse', label: '2027 eclipse', detail: 'Ride the Moon’s shadow across the Earth, 2 August 2027', seconds: 20 }),
]);
/** Frame sizes (device px). The low tier records at 720p. */
export const VIDEO_SIZES = Object.freeze([
    Object.freeze({ id: 'landscape', label: 'Landscape', w: 1920, h: 1080, lowW: 1280, lowH: 720 }),
    Object.freeze({ id: 'vertical', label: 'Vertical', w: 1080, h: 1920, lowW: 720, lowH: 1280 }),
]);
export const VIDEO_FPS = 30;
/** The 2027 total eclipse's greatest eclipse (the path request finds the event near it). */
export const ECLIPSE_2027_MS = Date.UTC(2027, 7, 2, 10, 7);
/** The chase's glide into the shadow, the hold at greatest eclipse, the final hold (s). */
const GLIDE_S = 1.8;
const HOLD_S = 1.5;
const TAIL_S = 1;
const DAY_MS = 864e5;
const BITRATE_PER_PX = 4;   // bits per pixel per second: ≈ 8 Mb/s at 1080p
const KEY_EVERY_S = 2;
/** Encoder queue depth before the recorder waits (backpressure). */
const MAX_QUEUE = 6;

/**
 * Night at the observer after `tMs`: from the Sun's going below DARK_SUN_DEG to its coming back
 * above it (polar nights end after 14 h), 10-minute resolution. Null without darkness in 30 h.
 * @param {number} tMs
 * @param {any} observer
 * @param {any} scratch a Snapshot
 * @returns {{fromMs:number, toMs:number}|null}
 */
export function nightSpan(tMs, observer, scratch) {
    const from = nextDarkMs(tMs, observer, scratch);
    if (from === null) return null;
    let to = from + 14 * 36e5;
    for (let t = from + 6e5; t <= from + 14 * 36e5; t += 6e5) {
        computeSnapshot(t, observer, scratch, { detail: 'frame' });
        if (scratch.observer.sunAltDeg >= DARK_SUN_DEG) {
            to = t;
            break;
        }
    }
    return { fromMs: from, toMs: to };
}

/**
 * The frame plan: holds (the clock still) and ranges (a clock timelapse over `frames` frames:
 * frame k of a range shows progress k/frames, k = 1…frames). Every plan starts with a hold, the
 * first frame at the start time.
 * @param {'day'|'night'|'eclipse'} preset
 * @param {{fps?:number, seconds?:number, startMs?:number, night?:{fromMs:number, toMs:number}|null,
 *          path?:{startMs:number, endMs:number, peakMs:number}|null}} c
 * @returns {{startMs:number, frames:number, segments:({kind:'hold', frames:number}|{kind:'range',
 *   fromMs:number, toMs:number, ease:null|'in'|'out', frames:number})[]}|null}
 */
export function videoPlan(preset, { fps = VIDEO_FPS, seconds, startMs, night = null, path = null } = {}) {
    const p = VIDEO_PRESETS.find((x) => x.id === preset);
    if (!p) return null;
    const total = Math.max(2, Math.round((seconds ?? p.seconds) * fps));
    const seg = [];
    let start;
    if (preset === 'day') {
        if (!Number.isFinite(startMs)) return null;
        start = startMs;
        seg.push({ kind: 'hold', frames: 1 }, { kind: 'range', fromMs: start, toMs: start + DAY_MS, ease: null, frames: total - 1 });
    } else if (preset === 'night') {
        if (!night) return null;
        start = night.fromMs;
        seg.push({ kind: 'hold', frames: 1 }, { kind: 'range', fromMs: night.fromMs, toMs: night.toMs, ease: null, frames: total - 1 });
    } else {
        if (!path) return null;
        const legs = chaseLegs(path, { durationS: (seconds ?? p.seconds) });
        if (!legs.length) return null;
        start = legs[0].fromMs;
        seg.push({ kind: 'hold', frames: Math.round(GLIDE_S * fps) });
        legs.forEach((l, i) => {
            if (i > 0) seg.push({ kind: 'hold', frames: Math.round(HOLD_S * fps) });
            seg.push({ kind: 'range', fromMs: l.fromMs, toMs: l.toMs, ease: l.ease, frames: Math.max(1, Math.round(l.durationS * fps)) });
        });
        seg.push({ kind: 'hold', frames: Math.round(TAIL_S * fps) });
    }
    return { startMs: start, frames: seg.reduce((n, s) => n + s.frames, 0), segments: seg };
}

/**
 * Which encoder this browser offers: WebCodecs (VideoEncoder and VideoFrame), else MediaRecorder
 * with canvas.captureStream, else none.
 * @param {any} [env] globalThis
 * @returns {'webcodecs'|'mediarecorder'|null}
 */
export function pickEncoder(env = globalThis) {
    if (typeof env?.VideoEncoder === 'function' && typeof env?.VideoFrame === 'function') return 'webcodecs';
    return canMediaRecord(env) ? 'mediarecorder' : null;
}

/** MediaRecorder and canvas.captureStream exist (the real-time fallback). */
function canMediaRecord(env) {
    return typeof env?.MediaRecorder === 'function' && typeof env?.HTMLCanvasElement?.prototype?.captureStream === 'function';
}

/** Yields to the event loop (a message, not a throttled timer). */
function yieldTask() {
    return new Promise((resolve) => {
        if (typeof MessageChannel === 'function') {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
            ch.port2.postMessage(0);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first H.264 / VP9 configuration the browser can encode at this size. */
async function webCodecsConfig(env, w, h, fps) {
    const bitrate = Math.round(w * h * BITRATE_PER_PX * (fps / 30));
    const cands = [
        { codec: 'avc1.640028', avc: { format: 'avc' } },   // High 4.0
        { codec: 'avc1.4d0028', avc: { format: 'avc' } },   // Main 4.0
        { codec: 'avc1.42e028', avc: { format: 'avc' } },   // Constrained Baseline 4.0
        { codec: 'vp09.00.40.08' },
    ];
    for (const c of cands) {
        const cfg = { ...c, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' };
        try {
            const r = await env.VideoEncoder.isConfigSupported(cfg);
            if (r?.supported) return { cfg: r.config ?? cfg, codec: c.codec.startsWith('vp09') ? 'vp9' : 'avc' };
        } catch { /* try the next */ }
    }
    return null;
}

/** MediaRecorder's best container for this browser. */
function recorderMime(env) {
    const types = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const t of types) {
        try { if (env.MediaRecorder.isTypeSupported?.(t)) return t; } catch { /* next */ }
    }
    return '';
}

/**
 * Records a time-lapse.
 * @param {{store:any, clock:any, render:any, eclipsePath:(t:number)=>Promise<any>, env?:any}} deps
 *   render: main's holder (rig, capture, eclipsePath ribbon, video: {getLoop, getRc, setNow})
 * @param {{preset:'day'|'night'|'eclipse', size?:'landscape'|'vertical', fps?:number, seconds?:number, labels?:boolean,
 *          signal?:AbortSignal, onProgress?:(p:{done:number, total:number, preview?:HTMLCanvasElement})=>void,
 *          paint?:(ctx:CanvasRenderingContext2D, w:number, h:number, tMs:number)=>void, name?:string}} opts
 * @returns {Promise<{blob:Blob, name:string, mime:string, frames:number, width:number, height:number, fps:number,
 *   method:string}|{error:string}>} error: 'unsupported' | 'busy' | 'no-3d' | 'no-night' | 'no-path' | 'cancelled' | 'changed' | 'failed'
 */
export async function recordVideo(deps, opts) {
    const { store, clock, render } = deps;
    const env = deps.env ?? globalThis;
    const video = render?.video;
    const loop = video?.getLoop?.(), rc = video?.getRc?.(), rig = render?.rig;
    if (!loop?.step || !rc?.beginCapture || !rig || !render.capture?.session) return { error: 'no-3d' };
    if (rc.capturing) return { error: 'busy' };
    const method = pickEncoder(env);
    if (!method) return { error: 'unsupported' };
    const fps = opts.fps > 0 ? Math.round(opts.fps) : VIDEO_FPS;
    const frameMs = 1000 / fps;
    const size = VIDEO_SIZES.find((s) => s.id === opts.size) ?? VIDEO_SIZES[0];
    const low = store.get().quality?.active === 'low';
    const W = low ? size.lowW : size.w, H = low ? size.lowH : size.h;
    const preset = opts.preset;
    const signal = opts.signal ?? null;

    // ---- the plan ---------------------------------------------------------------------------
    const st0 = store.get();
    const scratch = createSnapshot();
    let path = null, night = null;
    if (preset === 'night') {
        night = nightSpan(clock.tMs, st0.observer, scratch);
        if (!night) return { error: 'no-night' };
    } else if (preset === 'eclipse') {
        try { path = await deps.eclipsePath(ECLIPSE_2027_MS); } catch { path = null; }
        if (!path) return { error: 'no-path' };
    }
    const seconds = opts.seconds > 0 ? opts.seconds : undefined;
    const plan = videoPlan(preset, { fps, seconds, startMs: clock.tMs, night, path });
    if (!plan) return { error: 'failed' };
    if (signal?.aborted) return { error: 'cancelled' };

    // ---- the encoder ------------------------------------------------------------------------
    let enc = null;
    if (method === 'webcodecs') {
        const wc = await webCodecsConfig(env, W, H, fps);
        if (wc) enc = { kind: 'webcodecs', ...wc };
    }
    if (!enc && canMediaRecord(env)) enc = { kind: 'mediarecorder', mime: recorderMime(env) };
    if (!enc) return { error: 'unsupported' };

    // ---- state to restore, and the setup ----------------------------------------------------
    const saved = {
        view: st0.view, ui: st0.ui, cam: rig.getView?.() ?? null,
        clock: {
            tMs: clock.tMs, rate: clock.baseRate ?? clock.rate, playing: clock.playing, live: clock.live,
            range: clock.range ? { ...clock.range } : null, progress: clock.progress?.() ?? null,
        },
    };
    let own = 0;
    let changed = false;
    const mine = (fn) => { own++; try { return fn(); } finally { own--; } };
    const offClock = clock.onChange?.(() => { if (own === 0) changed = true; }) ?? (() => {});
    const ribbon = render.eclipsePath ?? null;
    // The virtual time base continues from the real one, so tweens already running carry on.
    let vNow = performance.now();
    video.setNow?.(vNow);
    loop.stop();

    let session = null;
    let encoder = null, muxer = null, mr = null, mrChunks = [], stream = null;
    let failure = null;
    try {
        // The setup's own store changes may touch the clock (ending a running analemma): ours too.
        own++;
        clock.setRange(null);
        clock.pause();
        clock.setTime(plan.startMs);
        if (preset === 'night') {
            const look = trailsLook(st0.observer.latDeg);
            if (st0.view.vantage !== 'none') rig.setVantage?.('none', { animate: false });
            if ((st0.view.track ?? 'none') !== 'none') rig.setTracking?.('none', null);
            // Not awaited: the rig lands on its next update (the warm-up frame below); the loop is stopped.
            Promise.resolve(rig.setMode('sky', { animate: false, look })).catch(() => {});
            store.set({ view: { ...store.get().view, mode: 'sky', vantage: 'none', track: 'none' }, ui: { ...store.get().ui, expose: 'trails' } }, 'event');
        } else if (preset === 'eclipse') {
            if (st0.view.vantage !== 'none') rig.setVantage?.('none', { animate: false });
            Promise.resolve(rig.setMode('orbit', { animate: false })).catch(() => {});
            const kind = path.kind === 'annular' ? 'annular' : 'total';
            store.set({
                view: { ...store.get().view, mode: 'orbit', vantage: 'none' },
                ui: { ...store.get().ui, expose: null, eclipse: { peakMs: path.peakMs, kind, local: false, eventId: null } },
            }, 'event');
            try {
                ribbon?.show?.(path);
                ribbon?.setReveal?.('chase');
            } catch { /* cosmetic */ }
            const pose = low ? CHASE_POSE.low : CHASE_POSE.other;
            rig.follow?.(chaseTarget(path), { ...pose })?.catch?.(() => {});
        }
        // A warm-up frame at the screen's size: the view and the exposure settle (Expose builds its
        // stack there), then the session takes the video's size.
        loop.step(vNow, frameMs);
        loop.step(vNow, frameMs);
        own--;
        const scale = Math.min(W, H) / 540;
        session = render.capture.session({ width: W, height: H, scale, labels: opts.labels !== false, stack: preset === 'night' });
        if (!session) throw new Error('capture session unavailable');
        const canvas = session.canvas;

        if (enc.kind === 'webcodecs') {
            muxer = createMp4Muxer({ width: W, height: H, fps, codec: enc.codec });
            encoder = new env.VideoEncoder({
                output: (chunk, meta) => {
                    if (meta?.decoderConfig?.description) muxer.setConfig(meta.decoderConfig.description);
                    const buf = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(buf);
                    muxer.add(buf, { key: chunk.type === 'key', ptsUs: chunk.timestamp });
                },
                error: (e) => { failure = e; },
            });
            encoder.configure(enc.cfg);
        } else {
            stream = canvas.captureStream(0);
            const track = stream.getVideoTracks()[0];
            mr = new env.MediaRecorder(stream, { ...(enc.mime ? { mimeType: enc.mime } : {}), videoBitsPerSecond: Math.round(W * H * BITRATE_PER_PX) });
            mr.ondataavailable = (e) => { if (e.data?.size) mrChunks.push(e.data); };
            mr.start(1000);
            enc.track = track;
            enc.t0 = performance.now();
        }

        // ---- frames -----------------------------------------------------------------------------
        let done = 0;
        const total = plan.frames;
        const emit = async () => {
            vNow += frameMs;
            video.setNow?.(vNow);
            const out = mine(() => session.frame(vNow, frameMs));
            if (!out) throw new Error('frame not rendered');
            opts.paint?.(out.getContext('2d'), out.width, out.height, clock.tMs);
            if (enc.kind === 'webcodecs') {
                const frame = new env.VideoFrame(out, { timestamp: Math.round(done * 1e6 / fps), duration: Math.round(1e6 / fps) });
                encoder.encode(frame, { keyFrame: done % (KEY_EVERY_S * fps) === 0 });
                frame.close();
                while (encoder.encodeQueueSize > MAX_QUEUE && !failure) await sleep(4);
            } else {
                enc.track.requestFrame?.();
                // Real time: the recorder stamps frames with the wall clock.
                const due = enc.t0 + (done + 1) * frameMs;
                const wait = due - performance.now();
                if (wait > 1) await sleep(wait);
            }
            done++;
            opts.onProgress?.({ done, total, preview: done % 6 === 1 || done === total ? out : undefined });
            await yieldTask();
            if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
            if (changed) throw Object.assign(new Error('changed'), { code: 'changed' });
            if (failure) throw failure;
        };
        for (const seg of plan.segments) {
            if (seg.kind === 'range') {
                mine(() => {
                    clock.setRange({ fromMs: seg.fromMs, toMs: seg.toMs, durationS: (seg.frames * frameMs) / 1000, loop: 'once', ease: seg.ease });
                    // Primes the range's wall clock, so the next tick advances exactly one frame.
                    clock.tick(vNow);
                });
            } else {
                mine(() => clock.pause());
            }
            for (let k = 0; k < seg.frames; k++) await emit();
        }

        // ---- finish -----------------------------------------------------------------------------
        let blob, mime;
        if (enc.kind === 'webcodecs') {
            await encoder.flush();
            if (failure) throw failure;
            mime = 'video/mp4';
            blob = new Blob(muxer.finish(), { type: mime });
        } else {
            const stopped = new Promise((r) => { mr.onstop = r; });
            mr.stop();
            await stopped;
            mime = (mr.mimeType || enc.mime || 'video/webm').split(';')[0];
            blob = new Blob(mrChunks, { type: mime });
        }
        const ext = mime === 'video/mp4' ? 'mp4' : 'webm';
        return {
            blob, mime, name: `${opts.name || 'timelapse'}-${preset}.${ext}`, frames: total, width: W, height: H, fps,
            method: enc.kind === 'webcodecs' ? `WebCodecs ${enc.codec === 'vp9' ? 'VP9' : 'H.264'}` : 'MediaRecorder',
        };
    } catch (err) {
        own = 0;
        if (err?.code === 'cancelled' || err?.code === 'changed') return { error: err.code };
        console.error('[recorder] recording failed', err);
        return { error: 'failed' };
    } finally {
        try { encoder?.state !== 'closed' && encoder?.close(); } catch { /* closed */ }
        try { if (mr && mr.state !== 'inactive') mr.stop(); } catch { /* stopped */ }
        try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        try { session?.end(); } catch (err) { console.error('[recorder] session end failed', err); }
        restore();
        offClock();
        video.setNow?.(null);
        loop.start();
    }

    function restore() {
        mine(() => {
            try { rig.stopFollow?.(); } catch { /* not following */ }
            try { ribbon?.setReveal?.('time'); } catch { /* cosmetic */ }
            const cur = store.get();
            store.set({ ui: { ...cur.ui, expose: saved.ui.expose, eclipse: saved.ui.eclipse } }, 'actions');
            if (saved.cam) {
                try { rig.setView?.(saved.cam); } catch { /* the view mode still returns */ }
            }
            store.set({ view: { ...saved.view } }, 'event');
            if (saved.view.vantage && saved.view.vantage !== 'none') rig.setVantage?.(saved.view.vantage, { animate: false });
            const c = saved.clock;
            clock.setRange(null);
            if (c.live) {
                clock.goLive?.();
            } else if (c.range) {
                clock.setRange(c.range);
                if (Number.isFinite(c.progress)) clock.seek?.(c.progress);
                if (!c.playing) clock.pause();
            } else {
                clock.pause();
                clock.setTime(c.tMs);
                if (Number.isFinite(c.rate)) clock.setRate?.(c.rate);
                if (c.playing) clock.play();
            }
        });
    }
}
