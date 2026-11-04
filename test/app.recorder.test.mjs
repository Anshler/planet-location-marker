// Tests for the time-lapse export's pure parts: the MP4 muxer (js/app/mp4.js) and the frame plans
// and encoder choice of js/app/recorder.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMp4Muxer, mp4Boxes } from '../js/app/mp4.js';
import { videoPlan, nightSpan, pickEncoder, VIDEO_PRESETS, VIDEO_SIZES, ECLIPSE_2027_MS } from '../js/app/recorder.js';
import { createSnapshot } from '../js/astro/snapshot.js';
import { CHASE_DURATION_S } from '../js/app/eclipse-chase.js';

const u32 = (u8, at) => ((u8[at] << 24) >>> 0) + (u8[at + 1] << 16) + (u8[at + 2] << 8) + u8[at + 3];
const concat = (parts) => {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
};
/** The first box of `type` anywhere inside [from, to) (a depth-first walk of container boxes). */
function find(u8, type, from = 0, to = u8.length) {
    for (const b of mp4Boxes(u8, from, to)) {
        if (b.type === type) return b;
        if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf'].includes(b.type)) {
            const r = find(u8, type, b.start + 8, b.start + b.size);
            if (r) return r;
        }
    }
    return null;
}

function mux(codec, frames = 5, opts = {}) {
    const m = createMp4Muxer({ width: 1920, height: 1080, fps: 30, codec });
    m.setConfig(new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]));
    for (let i = 0; i < frames; i++) {
        m.add(new Uint8Array(10 + i).fill(i + 1), { key: i % 3 === 0, ptsUs: opts.pts ? opts.pts[i] : Math.round((i * 1e6) / 30) });
    }
    return concat(m.finish());
}

test('mp4: faststart layout (ftyp, moov, mdat) whose sizes add up', () => {
    const f = mux('avc');
    const top = mp4Boxes(f);
    assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
    assert.equal(top.reduce((s, b) => s + b.size, 0), f.length);
    assert.equal(String.fromCharCode(...f.subarray(8, 12)), 'isom');
});

test('mp4: sample tables point at the samples', () => {
    const f = mux('avc', 5);
    const stsz = find(f, 'stsz');
    assert.equal(u32(f, stsz.start + 16), 5, 'sample count');
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => u32(f, stsz.start + 20 + 4 * i)), [10, 11, 12, 13, 14]);
    const stco = find(f, 'stco');
    const off = u32(f, stco.start + 16);
    const mdat = mp4Boxes(f).find((b) => b.type === 'mdat');
    assert.equal(off, mdat.start + 8, 'one chunk at the start of mdat');
    assert.equal(f[off], 1);
    assert.equal(f[off + 10], 2, 'the second sample follows the first');
    const stss = find(f, 'stss');
    assert.equal(u32(f, stss.start + 12), 2);
    assert.deepEqual([u32(f, stss.start + 16), u32(f, stss.start + 20)], [1, 4], 'key frames, 1-based');
    const stts = find(f, 'stts');
    assert.deepEqual([u32(f, stts.start + 16), u32(f, stts.start + 20)], [5, 3000], '90 kHz, 30 fps');
    assert.equal(find(f, 'ctts'), null, 'no reordering, no composition offsets');
    const mvhd = find(f, 'mvhd');
    assert.equal(u32(f, mvhd.start + 24), 5 * 3000, 'duration');
});

test('mp4: avcC carries the encoder description; vp09 gets a vpcC; reordered frames get a ctts', () => {
    const avc = mux('avc');
    const avcC = find(avc, 'avcC', find(avc, 'stsd').start + 16 + 86);
    assert.ok(avcC && avc[avcC.start + 8] === 1 && avc[avcC.start + 9] === 0x64);
    const tkhd = find(avc, 'tkhd');
    assert.equal(u32(avc, tkhd.start + 84) / 65536, 1920);
    assert.equal(u32(avc, tkhd.start + 88) / 65536, 1080);
    const vp9 = mux('vp9');
    assert.ok(vp9.includes(0x76) && String.fromCharCode(...vp9).includes('vp09') && String.fromCharCode(...vp9).includes('vpcC'));
    const re = mux('avc', 3, { pts: [0, 66667, 33333] });
    const ctts = find(re, 'ctts');
    assert.ok(ctts, 'B-frame order is described');
    assert.equal(re[ctts.start + 8], 1, 'version 1: signed offsets');
});

test('videoPlan: a day is 24 h of linear time after a first frame', () => {
    const start = Date.UTC(2027, 1, 6, 10);
    const p = videoPlan('day', { fps: 30, startMs: start });
    assert.equal(p.frames, VIDEO_PRESETS.find((x) => x.id === 'day').seconds * 30);
    assert.equal(p.segments[0].kind, 'hold');
    assert.deepEqual(p.segments[1], { kind: 'range', fromMs: start, toMs: start + 864e5, ease: null, frames: p.frames - 1 });
    assert.equal(videoPlan('day', { fps: 30, startMs: start, seconds: 2 }).frames, 60);
    assert.equal(videoPlan('day', {}), null, 'needs a start');
    assert.equal(videoPlan('nope', { startMs: start }), null);
});

test('videoPlan: the eclipse chase glides in, eases into greatest eclipse, holds and runs out', () => {
    const path = { startMs: 1000, peakMs: 1000 + 2 * 36e5, endMs: 1000 + 3 * 36e5 };
    const p = videoPlan('eclipse', { fps: 30, path });
    const kinds = p.segments.map((s) => s.kind);
    assert.deepEqual(kinds, ['hold', 'range', 'hold', 'range', 'hold']);
    assert.equal(p.startMs, path.startMs);
    assert.equal(p.segments[1].ease, 'out');
    assert.equal(p.segments[3].ease, 'in');
    assert.equal(p.segments[1].toMs, path.peakMs);
    assert.equal(p.segments[3].toMs, path.endMs);
    const legFrames = p.segments[1].frames + p.segments[3].frames;
    assert.ok(Math.abs(legFrames - VIDEO_PRESETS.find((x) => x.id === 'eclipse').seconds * 30) <= 1, 'the legs share the clip');
    assert.ok(VIDEO_PRESETS.find((x) => x.id === 'eclipse').seconds < CHASE_DURATION_S, 'shorter than the live chase');
    assert.equal(videoPlan('eclipse', { fps: 30 }), null, 'needs the path');
    assert.ok(Number.isFinite(ECLIPSE_2027_MS));
});

test('nightSpan: dusk to dawn at Luxor; none in the polar summer', () => {
    const luxor = { latDeg: 25.7, lonDeg: 32.6, elevM: 0 };
    const n = nightSpan(Date.parse('2027-02-06T10:00:00Z'), luxor, createSnapshot());
    assert.ok(n && n.toMs > n.fromMs);
    const h = (n.toMs - n.fromMs) / 36e5;
    assert.ok(h > 9 && h < 12, `${h.toFixed(1)} h of darkness`);
    const p = videoPlan('night', { fps: 30, night: n });
    assert.equal(p.startMs, n.fromMs);
    assert.equal(p.segments[1].toMs, n.toMs);
    const svalbard = { latDeg: 78.2, lonDeg: 15.6, elevM: 0 };
    assert.equal(nightSpan(Date.parse('2027-06-21T00:00:00Z'), svalbard, createSnapshot()), null);
});

test('pickEncoder: WebCodecs first, MediaRecorder on a capturable canvas, else none', () => {
    const fn = function () {};
    assert.equal(pickEncoder({ VideoEncoder: fn, VideoFrame: fn }), 'webcodecs');
    assert.equal(pickEncoder({ VideoEncoder: fn, MediaRecorder: fn, HTMLCanvasElement: { prototype: { captureStream: fn } } }), 'mediarecorder');
    assert.equal(pickEncoder({ MediaRecorder: fn, HTMLCanvasElement: { prototype: {} } }), null);
    assert.equal(pickEncoder({}), null);
    assert.deepEqual(VIDEO_SIZES.map((s) => [s.w, s.h]), [[1920, 1080], [1080, 1920]]);
});
