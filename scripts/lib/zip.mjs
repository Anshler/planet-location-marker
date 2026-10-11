// Minimal, zero-dependency ZIP reader (enough for GeoNames dumps).
//
// Parses the End Of Central Directory record, walks the central directory, and inflates
// the requested entry with zlib's raw inflate. Stored (0) and deflated (8) entries are
// supported; CRC-32 is verified. ZIP64 archives and encrypted entries are rejected.

import zlib from 'node:zlib';
import { crc32 } from './png.mjs';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function findEocd(buf) {
    // The EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
    const stop = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= stop; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    throw new Error('zip: end of central directory not found');
}

/**
 * Lists the entries of a ZIP archive.
 * @param {Buffer} buf whole archive
 * @returns {{name:string, method:number, crc:number, compSize:number, size:number, localOffset:number, flags:number}[]}
 */
export function listZipEntries(buf) {
    const eocd = findEocd(buf);
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip: ZIP64 is not supported');
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error(`zip: bad central directory entry #${i}`);
        const flags = buf.readUInt16LE(p + 8);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        entries.push({
            name: buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
            method: buf.readUInt16LE(p + 10),
            crc: buf.readUInt32LE(p + 16),
            compSize: buf.readUInt32LE(p + 20),
            size: buf.readUInt32LE(p + 24),
            localOffset: buf.readUInt32LE(p + 42),
            flags,
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * Reads and decompresses one entry of a ZIP archive.
 * @param {Buffer} buf whole archive
 * @param {string} name entry path inside the archive
 * @returns {Buffer} the uncompressed bytes
 */
export function readZipEntry(buf, name) {
    const entry = listZipEntries(buf).find((e) => e.name === name);
    if (!entry) throw new Error(`zip: entry ${name} not found`);
    if (entry.flags & 0x1) throw new Error(`zip: entry ${name} is encrypted`);
    const p = entry.localOffset;
    if (buf.readUInt32LE(p) !== SIG_LOC) throw new Error(`zip: bad local header for ${name}`);
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const raw = buf.subarray(start, start + entry.compSize);
    let out;
    if (entry.method === 0) out = Buffer.from(raw);
    else if (entry.method === 8) out = zlib.inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${entry.method} for ${name}`);
    if (out.length !== entry.size) throw new Error(`zip: size mismatch for ${name}`);
    if (crc32(out) !== entry.crc) throw new Error(`zip: CRC mismatch for ${name}`);
    return out;
}
