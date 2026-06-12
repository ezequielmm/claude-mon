/**
 * scale.mjs — aspect-correct box-filter scaler shared by daemon.mjs and play.mjs.
 *
 * Extracted from daemon.mjs so both the statusline daemon and the standalone
 * player use exactly one implementation.
 */

// ── Aspect math ───────────────────────────────────────────────────────────────

/**
 * Compute game width from aspect ratio, pixel-row count, and available columns.
 *
 * Each "▀" half-block cell is approximately square because terminal cells are
 * ~2:1 tall and we pack 2 pixel rows per cell.  A 4:3 image therefore needs
 * gameW ≈ round(pxRows * 4/3).
 *
 * @param {'4:3'|'16:10'|'stretch'} aspect
 * @param {number} pxRows  Total pixel height used for the game.
 * @param {number} cols    Available terminal columns.
 * @returns {number}  Game width in terminal columns (always ≤ cols).
 */
export function computeGameWidth(aspect, pxRows, cols) {
  if (aspect === 'stretch') return cols;
  const ratio = aspect === '16:10' ? 1.6 : 4 / 3;
  return Math.max(8, Math.min(cols, Math.round(pxRows * ratio)));
}

// ── Box-filter scaler ─────────────────────────────────────────────────────────

/**
 * Build a pre-scaled RGB buffer using a box filter (area average) from a
 * srcW×srcH framebuffer into a dstW×dstH pixel grid.
 *
 * For each destination pixel (x, y) the source rectangle
 *   [x*srcW/dstW .. (x+1)*srcW/dstW) × [y*srcH/dstH .. (y+1)*srcH/dstH)
 * is averaged.  Integer bounds are sufficient — at 36×30 target each pixel
 * covers ~80 source samples; the quantisation error is imperceptible.
 *
 * @param {(x: number, y: number) => [number, number, number]} srcGetPixel
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8Array}  Flat RGB buffer, row-major, 3 bytes per pixel.
 */
export function buildScaledBuffer(srcGetPixel, srcW, srcH, dstW, dstH) {
  const buf = new Uint8Array(dstW * dstH * 3);

  for (let dy = 0; dy < dstH; dy++) {
    // Source row range [y0, y1)
    const y0 = Math.floor(dy * srcH / dstH);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * srcH / dstH));

    for (let dx = 0; dx < dstW; dx++) {
      // Source column range [x0, x1)
      const x0 = Math.floor(dx * srcW / dstW);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * srcW / dstW));

      // Subsample large boxes: cap at ~8 samples per axis so high-resolution
      // sources (e.g. a 1280×800 framebuffer read through getValue) stay cheap
      // while keeping the average representative.
      const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 8));

      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let sy = y0; sy < y1; sy += stepY) {
        for (let sx = x0; sx < x1; sx += stepX) {
          const [r, g, b] = srcGetPixel(sx, sy);
          sumR += r; sumG += g; sumB += b;
          count++;
        }
      }

      const base = (dy * dstW + dx) * 3;
      buf[base]     = Math.round(sumR / count);
      buf[base + 1] = Math.round(sumG / count);
      buf[base + 2] = Math.round(sumB / count);
    }
  }

  return buf;
}

/**
 * Build a getPixel accessor over a flat RGB buffer with the given width.
 *
 * @param {Uint8Array} buf
 * @param {number} bufW
 * @returns {(x: number, y: number) => [number, number, number]}
 */
export function bufferGetPixel(buf, bufW) {
  return (x, y) => {
    const base = (y * bufW + x) * 3;
    return [buf[base], buf[base + 1], buf[base + 2]];
  };
}
