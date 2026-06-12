/**
 * postfx.mjs — in-place post-processing passes on flat RGB Uint8Array buffers.
 *
 * All operations mutate `buf` in-place (or swap via a temp copy) so no extra
 * allocation escapes to the caller between passes.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/** @param {number} n */
function clamp255(n) {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

// ── Unsharp mask ──────────────────────────────────────────────────────────────

/**
 * Sharpen a flat RGB buffer using an unsharp mask.
 *
 * Algorithm: blurred = 3×3 box blur (edge-clamped), then
 *   out = clamp(p + amount * (p - blurred))
 *
 * A temporary copy is used as the blur source so the blur is computed from
 * the original pixel values, not a partially-sharpened pass.
 *
 * @param {Uint8Array} buf  Flat RGB buffer, row-major, 3 bytes per pixel (mutated in place).
 * @param {number} w  Width in pixels.
 * @param {number} h  Height in pixels.
 * @param {number} [amount=0.6]  Sharpening strength (0 = no-op, 1 = full contrast boost).
 */
export function sharpen(buf, w, h, amount = 0.6) {
  // Copy the original pixels so the blur kernel reads unmodified values.
  const src = new Uint8Array(buf);

  const stride = w * 3;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 3×3 box blur (edge-clamped)
      let sumR = 0, sumG = 0, sumB = 0, count = 0;

      for (let dy = -1; dy <= 1; dy++) {
        const sy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const base = sy * stride + sx * 3;
          sumR += src[base];
          sumG += src[base + 1];
          sumB += src[base + 2];
          count++;
        }
      }

      const blurR = sumR / count;
      const blurG = sumG / count;
      const blurB = sumB / count;

      const base = y * stride + x * 3;
      buf[base]     = clamp255(src[base]     + amount * (src[base]     - blurR) + 0.5 | 0);
      buf[base + 1] = clamp255(src[base + 1] + amount * (src[base + 1] - blurG) + 0.5 | 0);
      buf[base + 2] = clamp255(src[base + 2] + amount * (src[base + 2] - blurB) + 0.5 | 0);
    }
  }
}

// ── Tone lift ─────────────────────────────────────────────────────────────────

/**
 * Apply a conservative tone lift to a flat RGB buffer: gamma expansion per
 * channel, then saturation adjustment around the luma value.
 *
 * Both operations keep output in [0, 255].
 *
 * @param {Uint8Array} buf  Flat RGB buffer, mutated in place.
 * @param {{ gamma?: number, saturation?: number }} [opts]
 *   gamma      — < 1 brightens midtones (default 0.88)
 *   saturation — > 1 boosts colour, < 1 desaturates (default 1.12)
 */
export function toneLift(buf, { gamma = 0.88, saturation = 1.12 } = {}) {
  // Pre-compute gamma LUT (256 entries → single integer per channel)
  const gammaLUT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    gammaLUT[i] = Math.round(255 * Math.pow(i / 255, gamma));
  }

  const len = buf.length; // always a multiple of 3
  for (let i = 0; i < len; i += 3) {
    // Apply gamma per channel
    const r = gammaLUT[buf[i]];
    const g = gammaLUT[buf[i + 1]];
    const b = gammaLUT[buf[i + 2]];

    // Luma (BT.601 coefficients)
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    // Saturation: interpolate/extrapolate each channel from luma
    buf[i]     = clamp255(luma + (r - luma) * saturation + 0.5 | 0);
    buf[i + 1] = clamp255(luma + (g - luma) * saturation + 0.5 | 0);
    buf[i + 2] = clamp255(luma + (b - luma) * saturation + 0.5 | 0);
  }
}
