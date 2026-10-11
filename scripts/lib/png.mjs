// Minimal, zero-dependency PNG encoder/decoder for the build scripts and tests.
//
// Supports 8-bit, non-interlaced images with 1 (grey), 2 (grey+alpha), 3 (RGB) or
// 4 (RGBA) channels. The encoder picks a filter per row with the usual "minimum sum
// of absolute residuals" heuristic, which typically halves the size of smooth images
// (blurred Milky Way, anti-aliased icons) compared with filter 0 everywhere.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour type for a given channel count (8 bits per channel). */
const COLOR_TYPE_BY_CHANNELS = { 1: 0, 2: 4, 3: 2, 4: 6 };
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 4: 2, 2: 3, 6: 4 };

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

/**
 * CRC-32 (ISO 3309 / PNG) of a byte sequence.
 * @param {Uint8Array} bytes
 * @param {number} [crc=0] running CRC from a previous call
 * @returns {number} unsigned 32-bit CRC
 */
export function crc32(bytes, crc = 0) {
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/**
 * Applies PNG filter `type` to one scanline.
 * @param {number} type 0..4
 * @param {Uint8Array} cur current row
 * @param {Uint8Array} prev previous row (zeros for the first row)
 * @param {number} bpp bytes per pixel
 * @param {Uint8Array} out receives the filtered bytes (same length as `cur`)
 */
function filterRow(type, cur, prev, bpp, out) {
    const n = cur.length;
    for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        switch (type) {
            case 0: v = cur[i]; break;
            case 1: v = cur[i] - a; break;
            case 2: v = cur[i] - b; break;
            case 3: v = cur[i] - ((a + b) >> 1); break;
            default: v = cur[i] - paeth(a, b, c); break;
        }
        out[i] = v & 0xff;
    }
}

/** Sum of |residual| interpreting bytes as signed, the libpng heuristic. */
function residualCost(row) {
    let s = 0;
    for (let i = 0; i < row.length; i++) s += row[i] < 128 ? row[i] : 256 - row[i];
    return s;
}

/**
 * Encodes raw 8-bit pixels as a PNG.
 *
 * Backwards compatible with the spec signature `encodePng(w, h, gray)`: the channel
 * count is inferred from `data.length / (w*h)` unless given explicitly.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray|Buffer} data row-major pixels, `channels` bytes each
 * @param {{channels?:1|2|3|4, level?:number, filter?:'adaptive'|0|1|2|3|4}} [opts]
 * @returns {Buffer} the PNG file bytes
 */
export function encodePng(width, height, data, opts = {}) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
        throw new RangeError(`encodePng: bad size ${width}x${height}`);
    }
    const channels = opts.channels ?? data.length / (width * height);
    const colorType = COLOR_TYPE_BY_CHANNELS[channels];
    if (colorType === undefined || data.length !== width * height * channels) {
        throw new RangeError(`encodePng: ${data.length} bytes do not match ${width}x${height}x${channels}`);
    }
    const stride = width * channels;
    const raw = Buffer.alloc((stride + 1) * height);
    const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
    let prev = new Uint8Array(stride);
    const fixed = opts.filter ?? 'adaptive';
    for (let y = 0; y < height; y++) {
        const cur = data.subarray ? data.subarray(y * stride, (y + 1) * stride) : Uint8Array.from(data.slice(y * stride, (y + 1) * stride));
        let best = 0;
        if (fixed === 'adaptive') {
            let bestCost = Infinity;
            for (let t = 0; t < 5; t++) {
                filterRow(t, cur, prev, channels, candidates[t]);
                const cost = residualCost(candidates[t]);
                if (cost < bestCost) { bestCost = cost; best = t; }
            }
        } else {
            best = fixed;
            filterRow(best, cur, prev, channels, candidates[best]);
        }
        raw[y * (stride + 1)] = best;
        raw.set(candidates[best], y * (stride + 1) + 1);
        prev = cur;
    }
    // Try the two zlib strategies that matter for filtered image data; keep the smaller.
    const level = opts.level ?? 9;
    const a = zlib.deflateSync(raw, { level, memLevel: 9 });
    const b = zlib.deflateSync(raw, { level, memLevel: 9, strategy: zlib.constants.Z_FILTERED });
    const idat = a.length <= b.length ? a : b;

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;            // bit depth
    ihdr[9] = colorType;
    ihdr[10] = 0;           // deflate
    ihdr[11] = 0;           // adaptive filtering
    ihdr[12] = 0;           // no interlace
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

/**
 * Decodes an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA). Palette, 16-bit
 * and interlaced images are rejected — the pipeline never produces them.
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {{width:number, height:number, channels:number, data:Uint8Array}}
 */
export function decodePng(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('decodePng: not a PNG');
    let pos = 8, width = 0, height = 0, channels = 0;
    const idat = [];
    while (pos + 12 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const body = buf.subarray(pos + 8, pos + 8 + len);
        if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) {
            throw new Error(`decodePng: CRC mismatch in ${type}`);
        }
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            const depth = body[8], colorType = body[9], interlace = body[12];
            channels = CHANNELS_BY_COLOR_TYPE[colorType];
            if (depth !== 8 || !channels || interlace !== 0) {
                throw new Error(`decodePng: unsupported depth=${depth} colorType=${colorType} interlace=${interlace}`);
            }
        } else if (type === 'IDAT') {
            idat.push(body);
        } else if (type === 'IEND') {
            break;
        }
        pos += 12 + len;
    }
    if (!width || !channels) throw new Error('decodePng: missing IHDR');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) throw new Error('decodePng: truncated image data');
    const data = new Uint8Array(stride * height);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const ft = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = data.subarray(y * stride, (y + 1) * stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? cur[i - channels] : 0;
            const b = prev[i];
            const c = i >= channels ? prev[i - channels] : 0;
            let p;
            switch (ft) {
                case 0: p = 0; break;
                case 1: p = a; break;
                case 2: p = b; break;
                case 3: p = (a + b) >> 1; break;
                case 4: p = paeth(a, b, c); break;
                default: throw new Error(`decodePng: bad filter ${ft} on row ${y}`);
            }
            cur[i] = (src[i] + p) & 0xff;
        }
        prev = cur;
    }
    return { width, height, channels, data };
}
