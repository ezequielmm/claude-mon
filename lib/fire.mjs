/**
 * fire.mjs — DOOM PSX fire simulation
 *
 * Classic Fabien Sanglard fire algorithm:
 *   https://fabiensanglard.net/doom_fire_psx/
 *
 * Heat field: 1D Uint8Array of size w×h, values 0..36.
 * Index layout: row 0 = TOP, row h-1 = BOTTOM (heat source).
 * Element at (col, row) = heat[row * w + col].
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Palette ───────────────────────────────────────────────────────────────────

/**
 * Canonical 37-entry DOOM PSX fire palette.
 * Each entry is [r, g, b], index 0 = black/cold, 36 = near-white/hot.
 *
 * Source: Fabien Sanglard's write-up + verified DOOM PSX data.
 * @type {[number, number, number][]}
 */
export const FIRE_PALETTE = [
  [  7,   7,   7],  //  0 — near black
  [ 31,   7,   7],  //  1
  [ 47,  15,   7],  //  2
  [ 71,  15,   7],  //  3
  [ 87,  23,   7],  //  4
  [103,  31,   7],  //  5
  [119,  31,   7],  //  6
  [143,  39,   7],  //  7
  [159,  47,   7],  //  8
  [175,  63,   7],  //  9
  [191,  71,   7],  // 10
  [199,  71,   7],  // 11
  [223,  79,   7],  // 12
  [223,  87,   7],  // 13
  [223,  87,   7],  // 14
  [215,  95,   7],  // 15
  [215,  95,   7],  // 16
  [215, 103,  15],  // 17
  [207, 111,  15],  // 18
  [207, 119,  15],  // 19
  [207, 127,  15],  // 20
  [207, 135,  23],  // 21
  [199, 135,  23],  // 22
  [199, 143,  23],  // 23
  [199, 151,  31],  // 24
  [191, 159,  31],  // 25
  [191, 159,  31],  // 26
  [191, 167,  39],  // 27
  [191, 167,  39],  // 28
  [191, 175,  47],  // 29
  [183, 175,  47],  // 30
  [183, 183,  47],  // 31
  [183, 183,  55],  // 32
  [207, 207, 111],  // 33
  [223, 223, 159],  // 34
  [239, 239, 199],  // 35
  [255, 255, 255],  // 36 — near white
];

// ── Core data structure ───────────────────────────────────────────────────────

/**
 * @typedef {{ w: number, h: number, heat: Uint8Array }} FireState
 */

/**
 * Create a new fire state, fully cold (all zeros).
 * @param {number} w  width in pixels (columns)
 * @param {number} h  height in pixels (rows × 2 because half-block rendering)
 * @returns {FireState}
 */
export function createFire(w, h) {
  return { w, h, heat: new Uint8Array(w * h) };
}

/**
 * Advance the fire simulation by one step.
 *
 * @param {FireState} fire
 * @param {number} intensity  0..1 — controls bottom-row seed temperature and
 *                            spread probability. 1.0 = full inferno,
 *                            0.25 = dying embers.
 */
export function stepFire(fire, intensity) {
  const { w, h, heat } = fire;

  // Seed bottom row with heat proportional to intensity (with random flicker).
  const maxTemp = 36;
  const baseTemp = Math.round(maxTemp * intensity);
  const flickerRange = intensity < 0.5 ? 6 : 3; // wider flicker when dying
  const bottomRow = (h - 1) * w;
  for (let x = 0; x < w; x++) {
    const flicker = Math.floor(Math.random() * flickerRange);
    heat[bottomRow + x] = Math.max(0, Math.min(maxTemp, baseTemp - flicker));
  }

  // Propagate upward: each cell above receives (neighbour below - decay).
  // The decay controls how quickly the fire cools as it rises.
  const maxDecay = intensity < 0.4 ? 4 : 3; // heavier decay at low intensity

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      // Sample below
      const srcX = x + Math.floor(Math.random() * 3) - 1; // wind: -1, 0, +1
      const clampedX = Math.max(0, Math.min(w - 1, srcX));
      const src = heat[(y + 1) * w + clampedX];

      // Decay
      const decay = Math.floor(Math.random() * (maxDecay + 1));
      heat[y * w + x] = src <= decay ? 0 : src - decay;
    }
  }
}

/**
 * Map a heat value (0..36) to an [r, g, b] triple via the palette.
 * @param {number} value
 * @returns {[number, number, number]}
 */
export function heatToRgb(value) {
  const idx = Math.max(0, Math.min(FIRE_PALETTE.length - 1, Math.round(value)));
  return FIRE_PALETTE[idx];
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Binary format:
 *   bytes 0-1: width  as uint16 LE
 *   bytes 2-3: height as uint16 LE
 *   bytes 4..: raw heat values (one byte per cell)
 */

/**
 * Serialize fire state to a Buffer.
 * @param {FireState} fire
 * @returns {Buffer}
 */
function serialiseFire(fire) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(fire.w, 0);
  header.writeUInt16LE(fire.h, 2);
  return Buffer.concat([header, Buffer.from(fire.heat)]);
}

/**
 * Save fire state to a file. Never throws.
 * @param {FireState} fire
 * @param {string} filePath
 */
export function saveFire(fire, filePath) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, serialiseFire(fire));
    fs.renameSync(tmp, filePath);
  } catch {
    // silent — animation continuity is best-effort
  }
}

/**
 * Load fire state from a file.
 * Returns null if the file is missing, corrupt, or dimensions don't match.
 * @param {string} filePath
 * @param {number} expectedW
 * @param {number} expectedH
 * @returns {FireState | null}
 */
export function loadFire(filePath, expectedW, expectedH) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 4) return null;
    const w = buf.readUInt16LE(0);
    const h = buf.readUInt16LE(2);
    if (w !== expectedW || h !== expectedH) return null;
    if (buf.length < 4 + w * h) return null;
    const heat = new Uint8Array(buf.buffer, buf.byteOffset + 4, w * h);
    // Copy into a fresh Uint8Array to detach from the file buffer
    return { w, h, heat: new Uint8Array(heat) };
  } catch {
    return null;
  }
}
