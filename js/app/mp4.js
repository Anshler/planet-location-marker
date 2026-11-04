// A tiny MP4 (ISO BMFF) muxer for one video track, pure (no DOM): the time-lapse export's
// container (app/recorder.js) for WebCodecs output. H.264 ('avc1' + the encoder's avcC) or VP9
// ('vp09' + vpcC). Samples are kept in memory and written once, 'faststart' (moov before mdat, as
// the share sheets and social sites prefer), in a single chunk:
//
//   ftyp · moov(mvhd · trak(tkhd · mdia(mdhd · hdlr · minf(vmhd · dinf(dref) · stbl(stsd · stts ·
//   [ctts] · stss · stsc · stsz · stco))))) · mdat
//
//   createMp4Muxer({width, height, fps, codec: 'avc'|'vp9'}) → { setConfig(description), add(data,
//   {key, ptsUs}), finish() → Uint8Array[] (the file, in parts), readonly samples }
//
// Timing: timescale 90 000, one sample per frame of 90 000 / fps ticks (decode order = output
// order). A composition offset table (ctts, version 1) is written only if the encoder reordered
// frames (B-frames), from the presentation timestamps it reported.

const TIMESCALE = 90000;
const UNITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/** Big-endian byte writer over a growing array (a muxer writes kilobytes, not megabytes). */
function writer() {
    const b = [];
    return {
        b,
        u8(v) { b.push(v & 255); },
        u16(v) { b.push((v >>> 8) & 255, v & 255); },
        u24(v) { b.push((v >>> 16) & 255, (v >>> 8) & 255, v & 255); },
        u32(v) { b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); },
        str(s) { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 255); },
        bytes(a) { for (let i = 0; i < a.length; i++) b.push(a[i]); },
        zeros(n) { for (let i = 0; i < n; i++) b.push(0); },
    };
}

/** A box: 32-bit size, type, then the body written by `fill(w)`. Full boxes pass version/flags. */
function box(type, fill, full) {
    const w = writer();
    w.u32(0);
    w.str(type);
    if (full) {
        w.u8(full[0]);
        w.u24(full[1]);
    }
    fill?.(w);
    const n = w.b.length;
    w.b[0] = (n >>> 24) & 255; w.b[1] = (n >>> 16) & 255; w.b[2] = (n >>> 8) & 255; w.b[3] = n & 255;
    return w.b;
}

/**
 * The vpcC body for VP9 profile 0, 8-bit 4:2:0, BT.709 (the WebCodecs default for a canvas).
 * @param {number} level VP9 level × 10 (e.g. 40 for 4.0)
 */
function vpcC(level) {
    return box('vpcC', (w) => {
        w.u8(0);            // profile 0
        w.u8(level);
        w.u8((8 << 4) | (1 << 1) | 0);   // bit depth 8, chroma 4:2:0 colocated (1), limited range
        w.u8(1); w.u8(1); w.u8(1);       // BT.709 primaries, transfer, matrix
        w.u16(0);           // no codec initialisation data
    }, [1, 0]);
}

/**
 * @param {{width:number, height:number, fps:number, codec?:'avc'|'vp9', vp9Level?:number}} o
 */
export function createMp4Muxer({ width, height, fps, codec = 'avc', vp9Level = 40 }) {
    const W = Math.round(width), H = Math.round(height);
    const delta = Math.round(TIMESCALE / fps);
    /** @type {Uint8Array[]} */
    const data = [];
    const sizes = [];
    const keys = [];
    const pts = [];
    let config = null;

    function stsd() {
        return box('stsd', (w) => {
            w.u32(1);
            w.bytes(box(codec === 'vp9' ? 'vp09' : 'avc1', (e) => {
                e.zeros(6);
                e.u16(1);            // data_reference_index
                e.zeros(16);         // pre_defined, reserved
                e.u16(W);
                e.u16(H);
                e.u32(0x00480000);   // 72 dpi
                e.u32(0x00480000);
                e.u32(0);
                e.u16(1);            // frame_count
                e.zeros(32);         // compressorname
                e.u16(0x0018);       // depth
                e.u16(0xffff);       // pre_defined = −1
                if (codec === 'vp9') e.bytes(vpcC(vp9Level));
                else e.bytes(box('avcC', (c) => c.bytes(config ?? new Uint8Array(0))));
            }));
        }, [0, 0]);
    }

    function moov(mdatOffset) {
        const n = sizes.length;
        const dur = n * delta;
        const matrix = (w) => { for (const v of UNITY) w.u32(v); };
        // Composition offsets, only when output order differs from presentation order.
        const offs = pts.map((p, i) => Math.round((p * TIMESCALE) / 1e6) - i * delta);
        const reordered = offs.some((o) => o !== 0);
        const stbl = box('stbl', (w) => {
            w.bytes(stsd());
            w.bytes(box('stts', (x) => { x.u32(1); x.u32(n); x.u32(delta); }, [0, 0]));
            if (reordered) {
                w.bytes(box('ctts', (x) => {
                    const runs = [];
                    for (const o of offs) {
                        if (runs.length && runs[runs.length - 1][1] === o) runs[runs.length - 1][0]++;
                        else runs.push([1, o]);
                    }
                    x.u32(runs.length);
                    for (const [count, o] of runs) { x.u32(count); x.u32(o >>> 0); }
                }, [1, 0]));
            }
            w.bytes(box('stss', (x) => {
                const k = [];
                keys.forEach((key, i) => { if (key) k.push(i + 1); });
                x.u32(k.length);
                for (const i of k) x.u32(i);
            }, [0, 0]));
            w.bytes(box('stsc', (x) => { x.u32(1); x.u32(1); x.u32(n); x.u32(1); }, [0, 0]));
            w.bytes(box('stsz', (x) => { x.u32(0); x.u32(n); for (const s of sizes) x.u32(s); }, [0, 0]));
            w.bytes(box('stco', (x) => { x.u32(1); x.u32(mdatOffset); }, [0, 0]));
        });
        const minf = box('minf', (w) => {
            w.bytes(box('vmhd', (x) => { x.u16(0); x.u16(0); x.u16(0); x.u16(0); }, [0, 1]));
            w.bytes(box('dinf', (x) => x.bytes(box('dref', (y) => { y.u32(1); y.bytes(box('url ', null, [0, 1])); }, [0, 0]))));
            w.bytes(stbl);
        });
        const mdia = box('mdia', (w) => {
            w.bytes(box('mdhd', (x) => { x.u32(0); x.u32(0); x.u32(TIMESCALE); x.u32(dur); x.u16(0x55c4); x.u16(0); }, [0, 0]));
            w.bytes(box('hdlr', (x) => { x.u32(0); x.str('vide'); x.zeros(12); x.str('VideoHandler'); x.u8(0); }, [0, 0]));
            w.bytes(minf);
        });
        const trak = box('trak', (w) => {
            w.bytes(box('tkhd', (x) => {
                x.u32(0); x.u32(0); x.u32(1); x.u32(0); x.u32(dur);
                x.zeros(8); x.u16(0); x.u16(0); x.u16(0); x.u16(0);
                matrix(x);
                x.u32(W * 65536); x.u32(H * 65536);
            }, [0, 3]));
            w.bytes(mdia);
        });
        return box('moov', (w) => {
            w.bytes(box('mvhd', (x) => {
                x.u32(0); x.u32(0); x.u32(TIMESCALE); x.u32(dur);
                x.u32(0x00010000); x.u16(0x0100); x.zeros(10);
                matrix(x);
                x.zeros(24);
                x.u32(2);
            }, [0, 0]));
            w.bytes(trak);
        });
    }

    return {
        /** The encoder's decoder configuration (avcC for H.264; ignored for VP9). */
        setConfig(description) {
            if (!description) return;
            config = description instanceof Uint8Array ? description.slice()
                : ArrayBuffer.isView(description) ? new Uint8Array(description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength))
                    : new Uint8Array(description.slice(0));
        },
        /**
         * Adds one encoded frame, in the encoder's output (decode) order.
         * @param {Uint8Array} bytes
         * @param {{key:boolean, ptsUs?:number}} info
         */
        add(bytes, { key, ptsUs }) {
            data.push(bytes);
            sizes.push(bytes.length);
            keys.push(!!key);
            pts.push(Number.isFinite(ptsUs) ? ptsUs : (sizes.length - 1) * (1e6 / fps));
        },
        get samples() { return sizes.length; },
        /** True once an H.264 stream has its avcC (VP9 needs none). */
        get ready() { return codec === 'vp9' || config !== null; },
        /** The whole file as parts for a Blob: header (ftyp + moov + mdat header) and the samples. */
        finish() {
            const ftyp = box('ftyp', (w) => {
                w.str('isom'); w.u32(0x200);
                w.str('isom'); w.str('iso2'); w.str(codec === 'vp9' ? 'vp09' : 'avc1'); w.str('mp41');
            });
            let mdatSize = 8;
            for (const s of sizes) mdatSize += s;
            // moov's size does not depend on the offset (one chunk), so measure, then write.
            const probe = moov(0).length;
            const head = [...ftyp, ...moov(ftyp.length + probe + 8)];
            const mdatHead = [(mdatSize >>> 24) & 255, (mdatSize >>> 16) & 255, (mdatSize >>> 8) & 255, mdatSize & 255, 0x6d, 0x64, 0x61, 0x74];
            return [Uint8Array.from([...head, ...mdatHead]), ...data];
        },
    };
}

/**
 * Walks the top-level boxes of an MP4 (tests, diagnostics): [{type, start, size}].
 * @param {Uint8Array} u8
 * @param {number} [from]
 * @param {number} [to]
 */
export function mp4Boxes(u8, from = 0, to = u8.length) {
    const out = [];
    let at = from;
    while (at + 8 <= to) {
        const size = ((u8[at] << 24) >>> 0) + (u8[at + 1] << 16) + (u8[at + 2] << 8) + u8[at + 3];
        const type = String.fromCharCode(u8[at + 4], u8[at + 5], u8[at + 6], u8[at + 7]);
        if (size < 8 || at + size > to) break;
        out.push({ type, start: at, size });
        at += size;
    }
    return out;
}
