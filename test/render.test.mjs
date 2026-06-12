#!/usr/bin/env node
/**
 * render.test.mjs — standalone unit tests for:
 *   • renderQuadrants (glyph selection, color assignment, SGR batching)
 *   • sharpen          (range clamping, local contrast increase)
 *   • toneLift         (monotonicity, clamping)
 *   • renderQuadrants 160×60 performance benchmark
 *
 * Run standalone:  node test/render.test.mjs
 * Also wired into: node test/run.mjs  (via runRenderTests export)
 */

import { renderQuadrants } from '../lib/render.mjs';
import { sharpen, toneLift } from '../lib/postfx.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Build a constant-color getPixel returning [r,g,b]. */
function solidPixel(r, g, b) {
  return () => [r, g, b];
}

/** Build a getPixel where top row = colorA, bottom row = colorB. */
function topBotPixel(colorA, colorB) {
  return (_x, y) => y === 0 ? colorA : colorB;
}

/** Build a getPixel where left col = colorA, right col = colorB. */
function leftRightPixel(colorA, colorB) {
  return (x, _y) => x === 0 ? colorA : colorB;
}

/** Build a getPixel where TL+BR = colorA, TR+BL = colorB. */
function diagPixel(colorA, colorB) {
  return (x, y) => (x === y) ? colorA : colorB;
}

// ── Test cases (synchronous, as objects) ─────────────────────────────────────

const TESTS = [
  // ── Glyph table ─────────────────────────────────────────────────────────────

  {
    name: 'QUAD_GLYPHS mask 0 (all bg) → space glyph',
    fn() {
      const lines = renderQuadrants(solidPixel(100, 100, 100), 2, 2, { truecolor: true });
      eq(lines.length, 1, `expected 1 line, got ${lines.length}`);
      const stripped = stripAnsi(lines[0]);
      ok(stripped === ' ', `expected single space, got: ${JSON.stringify(stripped)}`);
    },
  },

  {
    name: 'QUAD_GLYPHS top=red bottom=blue → ▀ (mask 3, TL+TR fg)',
    fn() {
      const lines = renderQuadrants(
        topBotPixel([255, 0, 0], [0, 0, 255]),
        2, 2, { truecolor: true },
      );
      const stripped = stripAnsi(lines[0]);
      ok(stripped === '▀', `expected ▀, got: ${JSON.stringify(stripped)}`);
    },
  },

  {
    name: 'QUAD_GLYPHS left=white right=black → ▌ (mask 5, TL+BL fg)',
    fn() {
      const lines = renderQuadrants(
        leftRightPixel([255, 255, 255], [0, 0, 0]),
        2, 2, { truecolor: true },
      );
      const stripped = stripAnsi(lines[0]);
      ok(stripped === '▌', `expected ▌, got: ${JSON.stringify(stripped)}`);
    },
  },

  {
    name: 'QUAD_GLYPHS diagonal TL+BR=white TR+BL=black → ▚ or ▞ (complements, equal error)',
    fn() {
      // bit0(TL)+bit3(BR) = mask 9 = ▚,  or its complement bit1(TR)+bit2(BL) = mask 6 = ▞
      // Both partitions give identical total error — either is correct.
      const lines = renderQuadrants(
        diagPixel([255, 255, 255], [0, 0, 0]),
        2, 2, { truecolor: true },
      );
      const stripped = stripAnsi(lines[0]);
      ok(stripped === '▚' || stripped === '▞',
        `expected diagonal glyph ▚ (mask 9) or ▞ (mask 6), got: ${JSON.stringify(stripped)}`);
    },
  },

  // ── Color codes ──────────────────────────────────────────────────────────────

  {
    name: 'renderQuadrants truecolor=true emits 38;2; fg + 48;2; bg codes',
    fn() {
      const lines = renderQuadrants(
        topBotPixel([200, 50, 10], [10, 50, 200]),
        2, 2, { truecolor: true },
      );
      ok(lines[0].includes('\x1b[38;2;'), 'expected 24-bit fg code');
      ok(lines[0].includes('\x1b[48;2;'), 'expected 24-bit bg code');
    },
  },

  {
    name: 'renderQuadrants truecolor=false emits 38;5; fg + 48;5; bg codes',
    fn() {
      const lines = renderQuadrants(
        topBotPixel([200, 50, 10], [10, 50, 200]),
        2, 2, { truecolor: false },
      );
      ok(lines[0].includes('\x1b[38;5;'), 'expected 256-color fg code');
      ok(lines[0].includes('\x1b[48;5;'), 'expected 256-color bg code');
    },
  },

  {
    name: 'renderQuadrants resets ANSI at end of each line',
    fn() {
      const lines = renderQuadrants(
        topBotPixel([200, 50, 10], [10, 50, 200]),
        4, 2, { truecolor: true },
      );
      for (const line of lines) {
        ok(line.endsWith('\x1b[0m'), `line does not end with reset: ${JSON.stringify(line.slice(-10))}`);
      }
    },
  },

  // ── SGR batching ─────────────────────────────────────────────────────────────

  {
    name: 'renderQuadrants SGR batching — uniform image → ≤2 fg codes',
    fn() {
      const lines = renderQuadrants(solidPixel(128, 64, 32), 8, 2, { truecolor: true });
      const fgMatches = (lines[0].match(/\x1b\[38;2;/g) ?? []).length;
      ok(fgMatches <= 2, `expected ≤2 fg codes for uniform image, got ${fgMatches}`);
    },
  },

  // ── Output dimensions ────────────────────────────────────────────────────────

  {
    name: 'renderQuadrants output: pxW/2 cols × pxH/2 rows',
    fn() {
      const pxW = 20, pxH = 10;
      const lines = renderQuadrants(solidPixel(0, 0, 0), pxW, pxH, { truecolor: true });
      eq(lines.length, pxH / 2, `expected ${pxH / 2} lines, got ${lines.length}`);
      const stripped = stripAnsi(lines[0]);
      eq(stripped.length, pxW / 2, `expected ${pxW / 2} cells per row, got ${stripped.length}`);
    },
  },

  // ── sharpen ──────────────────────────────────────────────────────────────────

  {
    name: 'sharpen keeps all values in [0, 255] (aggressive amount=2.0)',
    fn() {
      const w = 20, h = 20;
      const buf = new Uint8Array(w * h * 3);
      for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
      sharpen(buf, w, h, 2.0);
      for (let i = 0; i < buf.length; i++) {
        ok(buf[i] >= 0 && buf[i] <= 255, `out-of-range at index ${i}: ${buf[i]}`);
      }
    },
  },

  {
    name: 'sharpen increases local contrast on a horizontal step edge',
    fn() {
      const w = 4, h = 4;
      const buf = new Uint8Array(w * h * 3);
      // Top half = 50, bottom half = 200
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = y < h / 2 ? 50 : 200;
          const base = (y * w + x) * 3;
          buf[base] = buf[base + 1] = buf[base + 2] = v;
        }
      }
      const belowBefore = buf[(h / 2) * w * 3]; // first pixel of bottom half

      sharpen(buf, w, h, 0.6);

      const belowAfter = buf[(h / 2) * w * 3];
      ok(
        belowAfter > belowBefore,
        `pixel just below edge should be brighter after sharpen (was ${belowBefore}, now ${belowAfter})`,
      );
    },
  },

  // ── toneLift ─────────────────────────────────────────────────────────────────

  {
    name: 'toneLift keeps all values in [0, 255]',
    fn() {
      const buf = new Uint8Array(256 * 3);
      for (let i = 0; i < 256; i++) {
        buf[i * 3] = buf[i * 3 + 1] = buf[i * 3 + 2] = i;
      }
      toneLift(buf, { gamma: 0.5, saturation: 3 });
      for (let i = 0; i < buf.length; i++) {
        ok(buf[i] >= 0 && buf[i] <= 255, `out-of-range at index ${i}: ${buf[i]}`);
      }
    },
  },

  {
    name: 'toneLift gamma<1 is monotonically non-decreasing on a gray ramp',
    fn() {
      const n = 64;
      const buf = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = Math.round(i / (n - 1) * 255);
        buf[i * 3] = buf[i * 3 + 1] = buf[i * 3 + 2] = v;
      }
      toneLift(buf, { gamma: 0.88, saturation: 1.0 }); // saturation=1 → no hue shift on gray
      for (let i = 1; i < n; i++) {
        ok(
          buf[i * 3] >= buf[(i - 1) * 3],
          `non-monotonic at step ${i}: ${buf[(i - 1) * 3]} → ${buf[i * 3]}`,
        );
      }
    },
  },

  {
    name: 'toneLift gamma=1 saturation=1 is near-identity (±1 rounding)',
    fn() {
      const buf = new Uint8Array([100, 150, 200, 50, 80, 30]);
      const expected = new Uint8Array(buf);
      toneLift(buf, { gamma: 1.0, saturation: 1.0 });
      for (let i = 0; i < buf.length; i++) {
        ok(Math.abs(buf[i] - expected[i]) <= 1, `channel ${i}: expected ${expected[i]} ≈ ${buf[i]}`);
      }
    },
  },

  // ── Performance benchmark ────────────────────────────────────────────────────

  {
    name: 'renderQuadrants 160×60 completes in <50ms (CI budget)',
    fn() {
      const pxW = 160, pxH = 60;
      function getPixel(x, y) {
        return [(x * 7 + y * 13 + 37) % 256, (x * 17 + y * 3 + 80) % 256, (x + y * 5 + 120) % 256];
      }
      const t0 = Date.now();
      const lines = renderQuadrants(getPixel, pxW, pxH, { truecolor: true });
      const elapsed = Date.now() - t0;

      eq(lines.length, pxH / 2, `expected ${pxH / 2} lines`);
      process.stdout.write(`      bench: renderQuadrants 160×60 → ${elapsed}ms\n`);
      ok(elapsed < 50, `160×60 took ${elapsed}ms, expected <50ms`);
    },
  },

  // ── Glyph variety ────────────────────────────────────────────────────────────

  {
    name: 'renderQuadrants patchwork image produces diverse block-element glyphs',
    fn() {
      const pxW = 40, pxH = 8;
      function getPixel(x, y) {
        if (y % 2 === 0) return [(x * 60) % 256, 30, 80];
        return [20, (x * 40 + 100) % 256, 150];
      }
      const lines = renderQuadrants(getPixel, pxW, pxH, { truecolor: true });
      const allStripped = lines.map(stripAnsi).join('');
      const quadrantGlyphs = '▘▝▖▌▞▛▗▚▐▜▄▙▟█';
      const found = [...quadrantGlyphs].filter(g => allStripped.includes(g));
      process.stdout.write(`      glyph variety: ${found.join('')} (${found.length} distinct)\n`);
      // Log first 2 lines (escaped) for visual inspection
      for (let i = 0; i < Math.min(2, lines.length); i++) {
        const escaped = JSON.stringify(lines[i]);
        process.stdout.write(`      line ${i}: ${escaped.slice(0, 120)}${escaped.length > 120 ? '…' : ''}\n`);
      }
      ok(found.length >= 2, `expected ≥2 distinct quadrant glyphs, found: ${found.join('') || 'none'}`);
    },
  },
];

// ── Assertion helpers ────────────────────────────────────────────────────────

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${a} === ${b}`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all render/postfx tests, appending results to shared counters.
 *
 * @param {{ passed: { value: number }, failed: { value: number } }} counters
 * @param {{ test: (name: string, fn: () => void) => void }} _runner  (unused — matches doom/play API)
 */
export async function runRenderTests(counters, _runner) {
  process.stdout.write('\n── render / postfx tests ──────────────────────────────\n');

  for (const t of TESTS) {
    const t0 = Date.now();
    try {
      t.fn();
      const elapsed = Date.now() - t0;
      process.stdout.write(`PASS  ${t.name} (${elapsed}ms)\n`);
      counters.passed.value++;
    } catch (err) {
      const elapsed = Date.now() - t0;
      process.stdout.write(`FAIL  ${t.name} (${elapsed}ms)\n      ${err.message}\n`);
      counters.failed.value++;
    }
  }
}

// ── Standalone entry point ────────────────────────────────────────────────────

// When run directly (not via run.mjs), use the counters object directly.
const isMainModule = process.argv[1]?.endsWith('render.test.mjs');
if (isMainModule) {
  const counters = { passed: { value: 0 }, failed: { value: 0 } };
  await runRenderTests(counters, {});

  const total = counters.passed.value + counters.failed.value;
  process.stdout.write(`\n${total} tests: ${counters.passed.value} passed, ${counters.failed.value} failed\n`);
  process.exit(counters.failed.value > 0 ? 1 : 0);
}
