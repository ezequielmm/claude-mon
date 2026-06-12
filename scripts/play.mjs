#!/usr/bin/env node
/**
 * play.mjs — fullscreen standalone DOOM player.
 *
 * Run with:  node scripts/play.mjs [options]
 * Self-test: node scripts/play.mjs --selftest
 *
 * Options:
 *   --gfx <auto|iterm2|kitty|off>  Terminal graphics protocol (default: auto).
 *   --res <full|half>              Render resolution (default: full = 1280×800;
 *                                  half = 640×400 via 2×2 box average).
 *
 * Controls:
 *   WASD / Arrow keys  — move / turn
 *   SPACE              — use (open doors)
 *   F or X             — fire
 *   1–7                — switch weapon
 *   ESC                — menu
 *   ENTER / TAB        — menu navigation
 *   Q or Ctrl+C        — quit
 *
 * Terminal requirements:
 *   - stdin and stdout must be a TTY (unless --selftest).
 *   - Truecolor detected from COLORTERM env var (falls back to 256-color).
 *   - Pixel-perfect mode requires iTerm2, WezTerm, or Kitty terminal.
 *
 * DOOM key codes (doomgeneric doomkeys.h):
 *   KEY_LEFTARROW  0xac   KEY_UPARROW   0xad
 *   KEY_RIGHTARROW 0xae   KEY_DOWNARROW 0xaf
 *   KEY_USE  0xa2         KEY_FIRE 0xa3
 *   KEY_ESCAPE 27         KEY_ENTER 13    KEY_TAB 9
 *   Weapons: ASCII '1'..'7' (49..55)
 *
 * Verified: Module["_DG_PushKeyEvent"] is exported by vendor/doom/doom.js
 * (opentui-doom 0.3.11 — confirmed via rg of doom.js wasmExports assignment).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SELF_TEST = process.argv.includes('--selftest');

// ── CLI flags ─────────────────────────────────────────────────────────────────

/** Parse a named string flag from argv: --flag value */
function parseFlag(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const GFX_FLAG = parseFlag('--gfx') ?? 'auto';   // auto|iterm2|kitty|off
const RES_FLAG = parseFlag('--res') ?? 'full';   // full|half

// ── TTY guard ─────────────────────────────────────────────────────────────────

if (!SELF_TEST) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('error: play.mjs requires a TTY (run in a terminal, not piped)\n');
    process.exit(1);
  }
}

// ── Imports ───────────────────────────────────────────────────────────────────

import { createDoom, vendorAssetsExist } from '../lib/doom-engine.mjs';
import { renderHalfBlocks, renderQuadrants } from '../lib/render.mjs';
import { computeGameWidth, buildScaledBuffer, bufferGetPixel } from '../lib/scale.mjs';
import { sharpen, toneLift } from '../lib/postfx.mjs';
import { readConfig } from '../lib/state.mjs';
import { decodeKeys, HeldKeyTracker } from '../lib/keys.mjs';
import { detectGraphics, probeKittyGraphics, iterm2Image, kittyImage } from '../lib/gfx-protocol.mjs';
import { encodePngFast } from '../lib/png.mjs';

// ── DOOM key codes ────────────────────────────────────────────────────────────

const KEY_LEFTARROW  = 0xac;
const KEY_UPARROW    = 0xad;
const KEY_RIGHTARROW = 0xae;
const KEY_DOWNARROW  = 0xaf;
const KEY_USE        = 0xa2;
const KEY_FIRE       = 0xa3;
const KEY_ESCAPE     = 27;
const KEY_ENTER      = 13;
const KEY_TAB        = 9;

/** Map from normalized key name → DOOM key code */
const KEY_MAP = {
  up:    KEY_UPARROW,
  down:  KEY_DOWNARROW,
  left:  KEY_LEFTARROW,
  right: KEY_RIGHTARROW,
  w:     KEY_UPARROW,
  s:     KEY_DOWNARROW,
  a:     KEY_LEFTARROW,
  d:     KEY_RIGHTARROW,
  ' ':   KEY_USE,
  f:     KEY_FIRE,
  x:     KEY_FIRE,
  '\x1b': KEY_ESCAPE,
  '\r':   KEY_ENTER,
  '\n':   KEY_ENTER,
  '\t':   KEY_TAB,
};

// Weapon keys: '1'..'7' → their ASCII codes
for (let i = 1; i <= 7; i++) {
  KEY_MAP[String(i)] = 48 + i; // '1'=49 .. '7'=55
}

/** Keys that should be treated as taps (down + immediate up) rather than held */
const TAP_KEYS = new Set(['\x1b', '\r', '\n', '\t', '1', '2', '3', '4', '5', '6', '7']);

// ── Color detection ───────────────────────────────────────────────────────────

const truecolor = (process.env.COLORTERM ?? '').toLowerCase().includes('truecolor') ||
                  (process.env.COLORTERM ?? '').toLowerCase().includes('24bit');

// ── Cleanup guard ─────────────────────────────────────────────────────────────

let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;

  // Restore terminal state
  if (!SELF_TEST) {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    // Show cursor + leave alternate screen
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => {
  cleanup();
  process.stderr.write(`uncaught: ${err.message}\n`);
  process.exit(1);
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!vendorAssetsExist()) {
    process.stderr.write(
      'error: DOOM vendor assets missing.\n' +
      'Run: node scripts/fetch-doom.mjs\n',
    );
    process.exit(1);
  }

  // Boot the engine
  const engine = await createDoom();

  // ── Self-test path ──────────────────────────────────────────────────────────
  if (SELF_TEST) {
    // Tick 60 times then render one frame to stdout
    for (let i = 0; i < 60; i++) engine.tick();

    const cols   = 80;
    const pxRows = 20;
    const gameW  = computeGameWidth('4:3', pxRows, cols);
    const scaledBuf = buildScaledBuffer(engine.getPixel, engine.width, engine.height, gameW, pxRows);
    const gp        = bufferGetPixel(scaledBuf, gameW);
    const lines     = renderHalfBlocks(gp, gameW, pxRows, { truecolor: false });

    const frameStr = lines.join('\n');

    // Assertions
    if (!frameStr.includes('▀')) {
      process.stderr.write('selftest fail: frame does not contain ▀\n');
      engine.dispose();
      process.exit(1);
    }
    if (!frameStr.includes('\x1b[')) {
      process.stderr.write('selftest fail: frame does not contain ANSI escape codes\n');
      engine.dispose();
      process.exit(1);
    }

    process.stdout.write(frameStr + '\n');
    process.stdout.write('selftest ok\n');
    engine.dispose();
    process.exit(0);
  }

  // ── Interactive path ────────────────────────────────────────────────────────

  // ── Detect graphics protocol ────────────────────────────────────────────────
  //
  // Resolution order for --gfx auto:
  //   1. Explicit --gfx kitty|iterm2|off → use directly, skip probing.
  //   2. env says iTerm2 or WezTerm → 'iterm2' (no probe needed).
  //   3. env says kitty (TERM/KITTY_WINDOW_ID) → 'kitty'.
  //   4. Otherwise (including TERM_PROGRAM=WarpTerminal, unknown terminals) →
  //      run probeKittyGraphics on the real TTY → 'kitty' if true, else null.
  //
  // The probe is run BEFORE entering the alternate screen so its response bytes
  // never appear visibly on screen.  The probe leaves stdin raw; we resume it
  // below.  Any keystrokes typed during the probe are carried over.

  let gfxProtocol;
  let probeCarryOver = null; // bytes typed during the probe, if any

  if (GFX_FLAG !== 'auto') {
    // Explicit value — use detectGraphics() directly (handles off/kitty/iterm2)
    gfxProtocol = detectGraphics(process.env, { override: GFX_FLAG });
    if (gfxProtocol === undefined && GFX_FLAG !== 'off') {
      process.stderr.write(`play.mjs: unknown --gfx value '${GFX_FLAG}', using half-blocks\n`);
      gfxProtocol = null;
    }
  } else {
    // auto: first try env-based detection
    const envDetected = detectGraphics(process.env, { override: 'auto' });
    if (envDetected !== null) {
      // env gave us a definitive answer
      gfxProtocol = envDetected;
    } else {
      // Probe the terminal at runtime — works for Warp (kitty graphics support
      // since ~2024) and any other terminal not identified by env vars.
      const probe = await probeKittyGraphics(process.stdin, process.stdout, {
        timeoutMs: 500,
        alreadyRaw: false,
      });
      gfxProtocol = probe.supported ? 'kitty' : null;
      if (probe.carryOver.length > 0) {
        probeCarryOver = probe.carryOver;
      }
    }
  }

  // Decide status-row gfx label (shown in status line after startup)
  let gfxLabel;
  if (gfxProtocol === 'kitty') {
    // Distinguish probe-detected kitty from env-detected kitty
    const envDetectedKitty =
      (process.env.TERM ?? '').toLowerCase().includes('kitty') ||
      process.env.KITTY_WINDOW_ID !== undefined;
    gfxLabel = envDetectedKitty ? 'gfx:kitty' : 'gfx:kitty(probe)';
  } else if (gfxProtocol === 'iterm2') {
    gfxLabel = 'gfx:iterm2';
  } else {
    gfxLabel = 'text:quad';
  }

  if (!gfxProtocol && GFX_FLAG === 'auto') {
    process.stderr.write(
      'play.mjs: terminal does not support iTerm2 or Kitty graphics — using half-block rendering\n',
    );
  }

  // Persist the resolved graphics decision so tooling (and the orchestrating
  // assistant) can read what the probe concluded on this terminal.
  try {
    const decisionDir = path.join(os.tmpdir(), 'claude-mon');
    fs.mkdirSync(decisionDir, { recursive: true });
    fs.writeFileSync(
      path.join(decisionDir, 'gfx-decision.json'),
      JSON.stringify({
        mode: gfxProtocol ?? 'text-quad',
        label: gfxLabel,
        termProgram: process.env.TERM_PROGRAM ?? null,
        term: process.env.TERM ?? null,
        at: new Date().toISOString(),
      }),
      'utf8',
    );
  } catch { /* non-fatal */ }

  // Enter alternate screen, hide cursor, enable raw mode
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Re-inject any bytes typed during the probe so they are not lost
  if (probeCarryOver && probeCarryOver.length > 0) {
    process.stdin.emit('data', Buffer.from(probeCarryOver));
  }

  // Geometry (computed fresh on each resize)
  let termCols = process.stdout.columns  || 80;
  let termRows = process.stdout.rows     || 24;

  function computeGeometry() {
    termCols = process.stdout.columns  || 80;
    termRows = process.stdout.rows     || 24;
  }

  process.stdout.on('resize', () => {
    computeGeometry();
    // Clear screen so next render fills the new size cleanly
    process.stdout.write('\x1b[2J');
  });

  // Help/status line (last text row)
  const HELP = 'WASD/arrows move \xB7 SPACE use \xB7 F fire \xB7 1-7 weapons \xB7 ESC menu \xB7 Q quit';

  // ── Input wiring ──────────────────────────────────────────────────────────

  const tracker = new HeldKeyTracker(
    (key) => {
      const code = KEY_MAP[key];
      if (code !== undefined) engine.pushKey(1, code);
    },
    (key) => {
      const code = KEY_MAP[key];
      if (code !== undefined) engine.pushKey(0, code);
    },
  );

  process.stdin.on('data', (buf) => {
    const keys = decodeKeys(buf);
    for (const key of keys) {
      // Quit keys — handled before forwarding
      if (key === 'q' || key === '\x03') {
        tracker.releaseAll();
        engine.dispose();
        cleanup();
        process.exit(0);
      }
      if (TAP_KEYS.has(key)) {
        tracker.tap(key);
      } else {
        tracker.see(key);
      }
    }
  });

  // ── Game loop ────────────────────────────────────────────────────────────

  const TICK_MS   = 28;  // ~35 Hz engine tick

  // Adaptive pacing state for gfx mode
  let _gfxNextDelay = 50;   // ms until next render (starts at 20fps target)
  let _gfxImageId   = 1;    // stable Kitty image ID — reused to replace in-place
  let _gfxRgbBuf    = null; // reusable RGB buffer to avoid allocations per frame

  // Engine tick (same rate regardless of render path)
  const tickTimer = setInterval(() => {
    engine.tick();
  }, TICK_MS);

  // Render + sweep
  let renderTimer;

  function scheduleNextRender() {
    renderTimer = setTimeout(() => {
      tracker.sweep();
      renderFrame(engine);
      // scheduleNextRender is called at the end of renderFrame (or here for half-blocks)
      if (!gfxProtocol) {
        scheduleNextRender();
      }
    }, gfxProtocol ? _gfxNextDelay : 50);
  }

  function renderFrame(eng) {
    if (gfxProtocol) {
      renderFrameGfx(eng);
    } else {
      renderFrameHalfBlocks(eng);
    }
  }

  // ── Half-block / quadrant render path ────────────────────────────────────

  function renderFrameHalfBlocks(eng) {
    const cols   = termCols;
    const rows   = termRows;
    // Reserve last row for help text; pixel rows = (rows-1)*2 (must stay even)
    const pxRows = Math.max(2, (rows - 1)) * 2;

    // Read style from config (re-read each frame so live /afk style changes work)
    const cfg   = readConfig();
    const style = cfg.style ?? 'quad';

    const gameWcells = computeGameWidth('4:3', pxRows, cols);
    const leftPad    = Math.max(0, Math.floor((cols - gameWcells) / 2));
    const pad        = leftPad > 0 ? ' '.repeat(leftPad) : '';
    const RESET      = '\x1b[0m';

    let gameLines;
    if (style === 'quad') {
      // Quad path: sample at 2× horizontal resolution → double detail
      // On a 271-col terminal gameWcells ≈ 135, dstW ≈ 270 → ~270×(pxRows) samples
      const dstW = gameWcells * 2;
      const scaledBuf = buildScaledBuffer(eng.getPixel, eng.width, eng.height, dstW, pxRows);
      sharpen(scaledBuf, dstW, pxRows);
      toneLift(scaledBuf);
      const gp = bufferGetPixel(scaledBuf, dstW);
      gameLines = renderQuadrants(gp, dstW, pxRows, { truecolor });
    } else {
      // Classic half-block path with post-fx
      const scaledBuf = buildScaledBuffer(eng.getPixel, eng.width, eng.height, gameWcells, pxRows);
      sharpen(scaledBuf, gameWcells, pxRows);
      toneLift(scaledBuf);
      const gp = bufferGetPixel(scaledBuf, gameWcells);
      gameLines = renderHalfBlocks(gp, gameWcells, pxRows, { truecolor });
    }

    // Status row indicator
    const styleLabel = style === 'quad' ? 'quad' : 'half';

    // Build full frame string: cursor home + all game rows + help row
    let frame = '\x1b[H';
    for (const line of gameLines) {
      frame += `${RESET}${pad}${line}\r\n`;
    }

    // Help line — truncated to terminal width
    const helpSuffix = ` [${styleLabel}]`;
    const helpTrunc = (HELP + helpSuffix).slice(0, cols - 1);
    frame += `${RESET}${helpTrunc}`;

    // Synchronized output (BSP § 2026) to reduce tearing
    process.stdout.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }

  // ── Pixel-perfect gfx render path ────────────────────────────────────────

  function renderFrameGfx(eng) {
    const t0 = Date.now();

    const cols = termCols;
    const rows = termRows;
    // Image height = rows-1 cells (last row reserved for status)
    const imgRows = Math.max(1, rows - 1);

    // Determine source resolution
    let srcW, srcH;
    let rgb;
    if (RES_FLAG === 'half') {
      // Downsample 1280×800 → 640×400 via simple 2×2 box average
      srcW = Math.floor(eng.width  / 2);
      srcH = Math.floor(eng.height / 2);
      const full = eng.getFrameRGB();
      const W = eng.width;
      rgb = new Uint8Array(srcW * srcH * 3);
      for (let y = 0; y < srcH; y++) {
        for (let x = 0; x < srcW; x++) {
          const sx = x * 2, sy = y * 2;
          const i00 = (sy * W + sx) * 3;
          const i10 = (sy * W + sx + 1) * 3;
          const i01 = ((sy + 1) * W + sx) * 3;
          const i11 = ((sy + 1) * W + sx + 1) * 3;
          const di = (y * srcW + x) * 3;
          rgb[di]     = (full[i00]     + full[i10]     + full[i01]     + full[i11])     >> 2;
          rgb[di + 1] = (full[i00 + 1] + full[i10 + 1] + full[i01 + 1] + full[i11 + 1]) >> 2;
          rgb[di + 2] = (full[i00 + 2] + full[i10 + 2] + full[i01 + 2] + full[i11 + 2]) >> 2;
        }
      }
    } else {
      // Full resolution: reuse buffer to avoid allocation pressure
      srcW = eng.width;
      srcH = eng.height;
      if (!_gfxRgbBuf || _gfxRgbBuf.length !== srcW * srcH * 3) {
        _gfxRgbBuf = new Uint8Array(srcW * srcH * 3);
      }
      rgb = eng.getFrameRGB(_gfxRgbBuf);
    }

    // Encode to PNG (level 1 for speed)
    const png = encodePngFast(rgb, srcW, srcH);

    // Build image escape
    let imgEscape;
    if (gfxProtocol === 'iterm2') {
      imgEscape = iterm2Image(png, { widthCells: cols, heightCells: imgRows });
    } else {
      // kitty
      imgEscape = kittyImage(png, { cols, rows: imgRows, imageId: _gfxImageId });
    }

    // Status line: achieved fps + gfx label + controls hint
    const elapsed = Date.now() - t0;
    const fps = elapsed > 0 ? Math.round(1000 / elapsed) : 99;
    const statusLine = `${fps}fps [${gfxLabel}] ${HELP}`.slice(0, cols - 1);

    // Emit: cursor home + synchronized output wrapper + image + cursor to status row + status
    const frame =
      '\x1b[H' +
      '\x1b[?2026h' +
      imgEscape +
      `\x1b[${rows};1H` +         // move cursor to last row
      '\x1b[0m' + statusLine +
      '\x1b[?2026l';

    process.stdout.write(frame);

    // Adaptive pacing: next delay = max(50ms, measured * 1.2)
    // This targets ≥10fps at full res and never busy-spins.
    _gfxNextDelay = Math.max(50, Math.round(elapsed * 1.2));
    scheduleNextRender();
  }

  // Start the render loop
  scheduleNextRender();

  // Handle clean exit when stdin closes (e.g. EOF)
  process.stdin.on('end', () => {
    clearInterval(tickTimer);
    clearTimeout(renderTimer);
    tracker.releaseAll();
    engine.dispose();
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`play.mjs fatal: ${err.message}\n`);
  process.exit(1);
});
