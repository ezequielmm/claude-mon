/**
 * render.mjs — framebuffer → ANSI block-element lines
 *
 * Two renderers are provided:
 *
 *  renderHalfBlocks — classic: uses "▀" (U+2580) to pack 2 pixel rows per cell.
 *  renderQuadrants  — adaptive: uses all 16 Block Elements (U+2580–U+259F) to
 *                     pack a 2×2 pixel quad per cell, doubling horizontal detail.
 *
 * Color modes (both renderers):
 *   truecolor  — \x1b[38;2;R;G;Bm / \x1b[48;2;R;G;Bm  (24-bit)
 *   256-color  — \x1b[38;5;Nm    / \x1b[48;5;Nm        (xterm cube + grayscale)
 */

// ── 256-colour quantisation ───────────────────────────────────────────────────

/**
 * Quantise an [r, g, b] triple to the nearest xterm 256-color index.
 *
 * xterm color layout:
 *   0..15   — system/extended colours (skip)
 *  16..231  — 6×6×6 RGB cube: index = 16 + 36*r' + 6*g' + b', each channel 0..5
 * 232..255  — 24-step grayscale ramp from 8..238
 *
 * @param {number} r  0..255
 * @param {number} g  0..255
 * @param {number} b  0..255
 * @returns {number}  xterm color index 16..255
 */
function rgbTo256(r, g, b) {
  // Check if grayscale is a better fit (channels within 10 of each other)
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(r - b) < 10) {
    const avg = (r + g + b) / 3;
    if (avg < 8) return 16;   // black cube cell
    if (avg > 238) return 231; // white cube cell
    const grayIdx = Math.round((avg - 8) / (238 - 8) * 23);
    return 232 + grayIdx;
  }

  // Map each channel 0..255 → 0..5 (cube step)
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

// ── Core renderer ─────────────────────────────────────────────────────────────

/**
 * Render a pixel buffer as an array of ANSI-coloured half-block strings.
 *
 * Each output line covers two rows of pixels:
 *   pixel row 2r   → foreground (top half)
 *   pixel row 2r+1 → background (bottom half)
 *
 * Sequences are batched: only emit a new fg/bg escape when the colour
 * changes from the previous cell in the same output line.
 *
 * @param {(x: number, y: number) => [number, number, number]} getPixel
 *   Function returning [r, g, b] for pixel at (x, y).
 * @param {number} widthCols  Width of the output in terminal columns.
 * @param {number} heightPxRows  Total pixel height (must be even; rendered as heightPxRows/2 lines).
 * @param {{ truecolor: boolean }} options
 * @returns {string[]}  One string per output row.
 */
export function renderHalfBlocks(getPixel, widthCols, heightPxRows, { truecolor }) {
  const outputRows = Math.floor(heightPxRows / 2);
  const lines = [];

  for (let r = 0; r < outputRows; r++) {
    const topY = r * 2;
    const botY = r * 2 + 1;

    let line = '';
    let prevFgCode = '';
    let prevBgCode = '';

    for (let x = 0; x < widthCols; x++) {
      const [fr, fg, fb] = getPixel(x, topY);
      const [br, bg, bb] = getPixel(x, botY);

      let fgCode, bgCode;

      if (truecolor) {
        fgCode = `\x1b[38;2;${fr};${fg};${fb}m`;
        bgCode = `\x1b[48;2;${br};${bg};${bb}m`;
      } else {
        const fgIdx = rgbTo256(fr, fg, fb);
        const bgIdx = rgbTo256(br, bg, bb);
        fgCode = `\x1b[38;5;${fgIdx}m`;
        bgCode = `\x1b[48;5;${bgIdx}m`;
      }

      // Only emit the escape sequence when the colour changes
      let cell = '';
      if (fgCode !== prevFgCode) { cell += fgCode; prevFgCode = fgCode; }
      if (bgCode !== prevBgCode) { cell += bgCode; prevBgCode = bgCode; }
      cell += '▀';

      line += cell;
    }

    line += '\x1b[0m'; // reset at end of each line
    lines.push(line);
  }

  return lines;
}

// ── Quadrant renderer ─────────────────────────────────────────────────────────

/**
 * Glyph table for 4-pixel quadrant blocks.
 *
 * Bit layout of the mask (0..15):
 *   bit 0 = TL (top-left)
 *   bit 1 = TR (top-right)
 *   bit 2 = BL (bottom-left)
 *   bit 3 = BR (bottom-right)
 * A set bit means that pixel is rendered in the FOREGROUND colour.
 *
 * All 16 glyphs are in the universally-supported Block Elements range
 * (U+2580–U+259F) — same coverage as the "▀" used in renderHalfBlocks.
 */
const QUAD_GLYPHS = [
  ' ',   // 0  0000  — all background
  '▘',   // 1  0001  U+2598  TL
  '▝',   // 2  0010  U+259D  TR
  '▀',   // 3  0011  U+2580  TL+TR (top half)
  '▖',   // 4  0100  U+2596  BL
  '▌',   // 5  0101  U+258C  TL+BL (left half)
  '▞',   // 6  0110  U+259E  TR+BL (diagonal /)
  '▛',   // 7  0111  U+259B  TL+TR+BL
  '▗',   // 8  1000  U+2597  BR
  '▚',   // 9  1001  U+259A  TL+BR (diagonal \)
  '▐',   // 10 1010  U+2590  TR+BR (right half)
  '▜',   // 11 1011  U+259C  TL+TR+BR
  '▄',   // 12 1100  U+2584  BL+BR (bottom half)
  '▙',   // 13 1101  U+2599  TL+BL+BR
  '▟',   // 14 1110  U+259F  TR+BL+BR
  '█',   // 15 1111  U+2588  — all foreground
];

/**
 * Compute the squared Euclidean distance between two RGB triples (in-place,
 * no allocation).  Used for the optimal mask search.
 * @param {number} r0 @param {number} g0 @param {number} b0
 * @param {number} r1 @param {number} g1 @param {number} b1
 * @returns {number}
 */
function sqDist(r0, g0, b0, r1, g1, b1) {
  const dr = r0 - r1, dg = g0 - g1, db = b0 - b1;
  return dr * dr + dg * dg + db * db;
}

/**
 * Compute the optimal quad-block cell for a 2×2 pixel patch.
 *
 * Input: flat 12-element array [r0,g0,b0, r1,g1,b1, r2,g2,b2, r3,g3,b3]
 *   index 0 = TL, 1 = TR, 2 = BL, 3 = BR
 *
 * Returns an object:
 *   { glyph: string, fgR, fgG, fgB, bgR, bgG, bgB, mask: number }
 *
 * This is the per-cell core extracted from renderQuadrants so the compositor
 * (scripts/doomscreen.mjs) can call it without building a full row.
 * renderQuadrants calls this internally — output is byte-identical.
 *
 * @param {number[]} px4  12-element flat RGB array (TL TR BL BR)
 * @param {boolean} truecolor  true → 24-bit SGR, false → 256-colour SGR
 * @returns {{ glyph: string, fgR: number, fgG: number, fgB: number,
 *             bgR: number, bgG: number, bgB: number, mask: number,
 *             fgCode: string, bgCode: string }}
 */
export function renderQuadCell(px4, truecolor) {
  const r0 = px4[0], g0 = px4[1], b0 = px4[2];
  const r1 = px4[3], g1 = px4[4], b1 = px4[5];
  const r2 = px4[6], g2 = px4[7], b2 = px4[8];
  const r3 = px4[9], g3 = px4[10], b3 = px4[11];

  const pR = [r0, r1, r2, r3];
  const pG = [g0, g1, g2, g3];
  const pB = [b0, b1, b2, b3];

  let bestMask, bestFgR, bestFgG, bestFgB, bestBgR, bestBgG, bestBgB;

  // Fast path: all pixels near-equal → mask 0 (space + bg)
  const maxSq = sqDist(r0, g0, b0, r1, g1, b1);
  const isFlat = maxSq < 12 &&
    sqDist(r0, g0, b0, r2, g2, b2) < 12 &&
    sqDist(r0, g0, b0, r3, g3, b3) < 12;

  if (isFlat) {
    bestMask = 0;
    bestFgR = r0; bestFgG = g0; bestFgB = b0;
    bestBgR = r0; bestBgG = g0; bestBgB = b0;
  } else {
    let bestError = Infinity;
    bestMask = 0;
    bestFgR = r0; bestFgG = g0; bestFgB = b0;
    bestBgR = r0; bestBgG = g0; bestBgB = b0;

    for (let mask = 0; mask < 16; mask++) {
      let fgR = 0, fgG = 0, fgB = 0, fgN = 0;
      let bgR = 0, bgG = 0, bgB = 0, bgN = 0;

      for (let bit = 0; bit < 4; bit++) {
        if (mask & (1 << bit)) {
          fgR += pR[bit]; fgG += pG[bit]; fgB += pB[bit]; fgN++;
        } else {
          bgR += pR[bit]; bgG += pG[bit]; bgB += pB[bit]; bgN++;
        }
      }

      const mfR = fgN ? (fgR / fgN + 0.5) | 0 : 0;
      const mfG = fgN ? (fgG / fgN + 0.5) | 0 : 0;
      const mfB = fgN ? (fgB / fgN + 0.5) | 0 : 0;
      const mbR = bgN ? (bgR / bgN + 0.5) | 0 : 0;
      const mbG = bgN ? (bgG / bgN + 0.5) | 0 : 0;
      const mbB = bgN ? (bgB / bgN + 0.5) | 0 : 0;

      let err = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (mask & (1 << bit)) {
          err += sqDist(pR[bit], pG[bit], pB[bit], mfR, mfG, mfB);
        } else {
          err += sqDist(pR[bit], pG[bit], pB[bit], mbR, mbG, mbB);
        }
      }

      if (err < bestError) {
        bestError = err;
        bestMask = mask;
        bestFgR = mfR; bestFgG = mfG; bestFgB = mfB;
        bestBgR = mbR; bestBgG = mbG; bestBgB = mbB;
      }
    }

    // Low-contrast collapse
    if (bestMask !== 0) {
      const dR = bestFgR - bestBgR;
      const dG = bestFgG - bestBgG;
      const dB = bestFgB - bestBgB;
      if (dR * dR + dG * dG + dB * dB < 24 * 24) {
        const avgR = (bestFgR + bestBgR) >> 1;
        const avgG = (bestFgG + bestBgG) >> 1;
        const avgB = (bestFgB + bestBgB) >> 1;
        bestMask = 0;
        bestFgR = avgR; bestFgG = avgG; bestFgB = avgB;
        bestBgR = avgR; bestBgG = avgG; bestBgB = avgB;
      }
    }
  }

  // Build SGR codes
  let fgCode, bgCode;
  if (bestMask === 0) {
    if (truecolor) {
      fgCode = `\x1b[38;2;${bestBgR};${bestBgG};${bestBgB}m`;
      bgCode = `\x1b[48;2;${bestBgR};${bestBgG};${bestBgB}m`;
    } else {
      const idx = rgbTo256(bestBgR, bestBgG, bestBgB);
      fgCode = `\x1b[38;5;${idx}m`;
      bgCode = `\x1b[48;5;${idx}m`;
    }
  } else if (bestMask === 15) {
    if (truecolor) {
      fgCode = `\x1b[38;2;${bestFgR};${bestFgG};${bestFgB}m`;
      bgCode = `\x1b[48;2;${bestFgR};${bestFgG};${bestFgB}m`;
    } else {
      const idx = rgbTo256(bestFgR, bestFgG, bestFgB);
      fgCode = `\x1b[38;5;${idx}m`;
      bgCode = `\x1b[48;5;${idx}m`;
    }
  } else {
    if (truecolor) {
      fgCode = `\x1b[38;2;${bestFgR};${bestFgG};${bestFgB}m`;
      bgCode = `\x1b[48;2;${bestBgR};${bestBgG};${bestBgB}m`;
    } else {
      const fgIdx = rgbTo256(bestFgR, bestFgG, bestFgB);
      const bgIdx = rgbTo256(bestBgR, bestBgG, bestBgB);
      fgCode = `\x1b[38;5;${fgIdx}m`;
      bgCode = `\x1b[48;5;${bgIdx}m`;
    }
  }

  return {
    glyph: QUAD_GLYPHS[bestMask],
    mask: bestMask,
    fgR: bestFgR, fgG: bestFgG, fgB: bestFgB,
    bgR: bestBgR, bgG: bestBgG, bgB: bestBgB,
    fgCode,
    bgCode,
  };
}

/**
 * Render a pixel buffer as an array of ANSI-coloured quadrant-block strings.
 *
 * Each output cell covers a 2×2 pixel square:
 *   p0 = (cellX*2,   cellY*2)   — TL
 *   p1 = (cellX*2+1, cellY*2)   — TR
 *   p2 = (cellX*2,   cellY*2+1) — BL
 *   p3 = (cellX*2+1, cellY*2+1) — BR
 *
 * For each cell the 4-bit partition mask that minimises total squared RGB error
 * is chosen:  fg = mean(set pixels), bg = mean(unset pixels).
 *
 * SGR batching mirrors renderHalfBlocks: codes are emitted only when the colour
 * changes from the previous cell; the line is reset at the end.
 *
 * @param {(x: number, y: number) => [number, number, number]} getPixel
 * @param {number} pxW  Pixel width (must be even).
 * @param {number} pxH  Pixel height (must be even).
 * @param {{ truecolor: boolean }} options
 * @returns {string[]}  One string per cell row (pxH/2 rows total).
 */
export function renderQuadrants(getPixel, pxW, pxH, { truecolor }) {
  const cellCols = pxW >> 1;   // pxW / 2
  const cellRows = pxH >> 1;   // pxH / 2
  const lines = [];

  // Reusable 12-element buffer to avoid allocation per cell
  const px4 = new Array(12);

  for (let cr = 0; cr < cellRows; cr++) {
    const topY = cr * 2;
    const botY = cr * 2 + 1;

    let line = '';
    let prevFgCode = '';
    let prevBgCode = '';

    for (let cc = 0; cc < cellCols; cc++) {
      const leftX  = cc * 2;
      const rightX = cc * 2 + 1;

      // Gather the 4 pixels into the shared buffer
      const [r0, g0, b0] = getPixel(leftX,  topY);
      const [r1, g1, b1] = getPixel(rightX, topY);
      const [r2, g2, b2] = getPixel(leftX,  botY);
      const [r3, g3, b3] = getPixel(rightX, botY);
      px4[0] = r0; px4[1] = g0; px4[2] = b0;
      px4[3] = r1; px4[4] = g1; px4[5] = b1;
      px4[6] = r2; px4[7] = g2; px4[8] = b2;
      px4[9] = r3; px4[10] = g3; px4[11] = b3;

      const { glyph, fgCode, bgCode } = renderQuadCell(px4, truecolor);

      // ── SGR batching ──────────────────────────────────────────────────────
      let cell = '';
      if (fgCode !== prevFgCode) { cell += fgCode; prevFgCode = fgCode; }
      if (bgCode !== prevBgCode) { cell += bgCode; prevBgCode = bgCode; }
      cell += glyph;

      line += cell;
    }

    line += '\x1b[0m'; // reset at end of each line
    lines.push(line);
  }

  return lines;
}
