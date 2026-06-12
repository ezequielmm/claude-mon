/**
 * png.mjs — zero-dependency PNG encoder for Node.js.
 *
 * Produces 8-bit RGB (color type 2) PNG images from a packed RGB Uint8Array.
 * Compression via node:zlib deflateSync; CRC32 via a small table implementation.
 * No external dependencies — node built-ins only.
 *
 * Exports:
 *   encodePng(rgb, width, height, options?)     — level 6 (best balance)
 *   encodePngFast(rgb, width, height, options?) — level 1 (fastest, for streaming)
 *
 * PNG spec references:
 *   https://www.w3.org/TR/PNG/
 *   Chunk layout: length(4) | type(4) | data(length) | crc(4)
 *   IHDR: width(4) | height(4) | bitDepth(1) | colorType(1) | compression(1) | filter(1) | interlace(1)
 *   IDAT: zlib-compressed filtered scanlines; filter byte 0 (None) prepended to each row
 */

import zlib from 'node:zlib';

// ── CRC32 ─────────────────────────────────────────────────────────────────────

/** CRC32 lookup table (IEEE 802.3 polynomial 0xEDB88320). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

/**
 * Compute CRC32 over a Buffer or Uint8Array, optionally with an initial value.
 * @param {Uint8Array|Buffer} buf
 * @param {number} [crc=0xFFFFFFFF]
 * @returns {number}  final CRC32 (XOR'd with 0xFFFFFFFF per spec)
 */
function crc32(buf, crc = 0xFFFFFFFF) {
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Chunk builder ─────────────────────────────────────────────────────────────

/**
 * Build a PNG chunk: 4-byte length + 4-byte type + data + 4-byte CRC.
 * @param {string} type  4-ASCII-char chunk type (e.g. 'IHDR')
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.allocUnsafe(4);
  const crcBuf  = Buffer.allocUnsafe(4);

  lenBuf.writeUInt32BE(data.length, 0);
  // CRC covers type + data
  const c = crc32(data, crc32(typeBuf) ^ 0xFFFFFFFF); // chain: crc32(type || data)
  // Re-compute correctly: crc over concat of type bytes and data bytes
  const combined = Buffer.allocUnsafe(typeBuf.length + data.length);
  typeBuf.copy(combined, 0);
  data.copy(combined, typeBuf.length);
  crcBuf.writeUInt32BE(crc32(combined), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Core encoder ──────────────────────────────────────────────────────────────

/** PNG file signature (8 bytes). */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Encode a packed RGB Uint8Array as a PNG Buffer.
 *
 * @param {Uint8Array} rgb    Packed RGB, row-major, 3 bytes per pixel.
 * @param {number}     width
 * @param {number}     height
 * @param {{ level?: number }} [options]  Deflate compression level (0-9, default 6).
 * @returns {Buffer}  Complete PNG file as a Buffer.
 */
export function encodePng(rgb, width, height, options = {}) {
  const level = options.level ?? 6;
  return _encode(rgb, width, height, level);
}

/**
 * Fast PNG encoder — deflate level 1 for realtime streaming.
 * Produces larger files but runs significantly faster than level 6.
 *
 * @param {Uint8Array} rgb
 * @param {number}     width
 * @param {number}     height
 * @param {{ level?: number }} [options]  Override level if needed (default 1).
 * @returns {Buffer}
 */
export function encodePngFast(rgb, width, height, options = {}) {
  const level = options.level ?? 1;
  return _encode(rgb, width, height, level);
}

/**
 * Internal encoder shared by encodePng and encodePngFast.
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 * @param {number} level   zlib deflate level 0-9
 * @returns {Buffer}
 */
function _encode(rgb, width, height, level) {
  // ── IHDR ──────────────────────────────────────────────────────────────────
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width,  0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 2;  // color type: RGB
  ihdrData[10] = 0;  // compression: deflate
  ihdrData[11] = 0;  // filter: adaptive (we use type 0 per-row)
  ihdrData[12] = 0;  // interlace: none

  // ── Raw scanlines with filter byte 0 (None) prepended to each row ─────────
  const rowBytes = width * 3;
  const rawSize  = height * (1 + rowBytes);
  const raw      = Buffer.allocUnsafe(rawSize);

  for (let y = 0; y < height; y++) {
    const rawOff = y * (1 + rowBytes);
    raw[rawOff] = 0; // filter type 0 = None
    const srcOff = y * rowBytes;
    // Copy RGB row
    for (let x = 0; x < rowBytes; x++) {
      raw[rawOff + 1 + x] = rgb[srcOff + x];
    }
  }

  // ── IDAT — compress raw scanlines ─────────────────────────────────────────
  const compressed = zlib.deflateSync(raw, { level });
  const idatData   = compressed;

  // ── IEND ──────────────────────────────────────────────────────────────────
  const iendData = Buffer.alloc(0);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdrData),
    chunk('IDAT', idatData),
    chunk('IEND', iendData),
  ]);
}
