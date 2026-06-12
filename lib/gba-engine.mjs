/**
 * gba-engine.mjs — GBA emulator adapter (gbajs) with the same contract as
 * lib/doom-engine.mjs, so the daemon / compositor / banner pipeline works
 * unchanged:
 *
 *   { tick, getPixel, getFrameRGB, pushKey, width, height,
 *     dimensionsKnown, dispose }
 *
 * Differences handled here:
 *   - TIMING: the daemon ticks at 26-30ms (33-38Hz) but the GBA runs at
 *     ~59.7fps — tick() advances however many emulator frames real time
 *     owes (capped) so games run at correct speed regardless of cadence.
 *   - INPUT: control.json carries DOOM key codes as the wire format; they
 *     map onto GBA pad bits (arrows→D-pad, USE→A, FIRE→B, ENTER→Start,
 *     ESC→Select, weapon slots 1/2→L/R).
 *   - SAVES: battery saves (SRAM/Flash/EEPROM — FireRed is Flash 1M)
 *     persist to ~/.claude/claude-mon/saves/<rom>.sav, flushed when the
 *     emulator marks them dirty.
 *
 * ROMs are USER-SUPPLIED (config.gbaRom) — never fetched, never bundled.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CONFIG_DIR, mkdirp } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GBAJS_DIR = path.join(ROOT, 'vendor', 'gba', 'gbajs');
const SAVES_DIR = path.join(CONFIG_DIR, 'saves');

export const GBA_WIDTH = 240;
export const GBA_HEIGHT = 160;

/** ~59.73 fps — the GBA's real frame cadence. */
const FRAME_MS = 1000 / 59.7275;
/** Max emulator frames recovered per tick (a stalled daemon must not warp). */
const MAX_FRAMES_PER_TICK = 4;
/** Battery save flush cadence. */
const SAVE_FLUSH_MS = 10_000;

/** DOOM wire codes (control.json lingua franca) → gbajs keypad bit index. */
const PAD_BITS = new Map([
  [0xa2, 0],  // USE   → A
  [0xa3, 1],  // FIRE  → B
  [27, 2],    // ESC   → SELECT
  [13, 3],    // ENTER → START
  [0xae, 4],  // right → RIGHT
  [0xac, 5],  // left  → LEFT
  [0xad, 6],  // up    → UP
  [0xaf, 7],  // down  → DOWN
  [50, 8],    // '2'   → R
  [49, 9],    // '1'   → L
]);

/** True when the vendored emulator is present. */
export function gbaVendorExists() {
  try {
    // bios.bin is a ~220-byte HLE stub (gbajs soft-emulates BIOS calls) —
    // do NOT expect a real 16KB BIOS here.
    return fs.statSync(path.join(GBAJS_DIR, 'js', 'gba.js')).size > 1000 &&
           fs.statSync(path.join(GBAJS_DIR, 'resources', 'bios.bin')).size > 100;
  } catch {
    return false;
  }
}

/**
 * Boot the GBA with a user-supplied ROM.
 *
 * @param {string} romPath  absolute path to the user's ROM
 * @returns {Promise<object>}  engine with the doom-engine contract
 */
export async function createGba(romPath) {
  const require = createRequire(import.meta.url);
  const GameBoyAdvance = require(path.join(GBAJS_DIR, 'js', 'gba.js'));

  const bios = fs.readFileSync(path.join(GBAJS_DIR, 'resources', 'bios.bin'));
  const rom = fs.readFileSync(romPath);

  const gba = new GameBoyAdvance();
  gba.logLevel = gba.LOG_ERROR;
  gba.setBios(bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength));
  gba.setCanvasMemory();
  gba.setRom(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength));

  // ── Battery save restore ───────────────────────────────────────────────────
  mkdirp(SAVES_DIR);
  const savePath = path.join(SAVES_DIR,
    path.basename(romPath).replace(/\.[^.]+$/, '') + '.sav');
  try {
    const sav = fs.readFileSync(savePath);
    gba.setSavedata(sav.buffer.slice(sav.byteOffset, sav.byteOffset + sav.byteLength));
  } catch { /* first run — no save yet */ }

  let lastSaveFlushAt = Date.now();
  function flushSave(force) {
    const save = gba.mmu.save;
    if (!save || !save.buffer) return;
    if (!force && !save.writePending) return;
    try {
      const tmp = savePath + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(save.buffer));
      fs.renameSync(tmp, savePath);
      save.writePending = false;
    } catch { /* retry next flush */ }
  }

  // ── Real-time frame pacing ─────────────────────────────────────────────────
  let frameDebt = 0;
  let lastTickAt = Date.now();

  // The RGBA surface gbajs renders into (MemoryCanvas ImageData)
  const surface = gba.context.pixelData ?? gba.video.renderPath?.pixelData;
  const rgba = () => (surface?.data) ?? gba.screenshot().data;

  const frameRGB = new Uint8Array(GBA_WIDTH * GBA_HEIGHT * 3);

  const engine = {
    width: GBA_WIDTH,
    height: GBA_HEIGHT,
    dimensionsKnown: true,

    tick() {
      const now = Date.now();
      frameDebt += (now - lastTickAt) / FRAME_MS;
      lastTickAt = now;
      let frames = Math.floor(frameDebt);
      if (frames > MAX_FRAMES_PER_TICK) {
        frameDebt = 0;
        frames = MAX_FRAMES_PER_TICK;
      } else {
        frameDebt -= frames;
      }
      for (let i = 0; i < frames; i++) gba.advanceFrame();

      if (now - lastSaveFlushAt >= SAVE_FLUSH_MS) {
        lastSaveFlushAt = now;
        flushSave(false);
      }
    },

    getPixel(x, y) {
      const d = rgba();
      const o = (y * GBA_WIDTH + x) * 4;
      return [d[o], d[o + 1], d[o + 2]];
    },

    getFrameRGB() {
      const d = rgba();
      for (let i = 0, j = 0; i < frameRGB.length; i += 3, j += 4) {
        frameRGB[i] = d[j];
        frameRGB[i + 1] = d[j + 1];
        frameRGB[i + 2] = d[j + 2];
      }
      return frameRGB;
    },

    pushKey(pressed, code) {
      const bit = PAD_BITS.get(code);
      if (bit === undefined) return;
      if (pressed) gba.keypad.currentDown &= ~(1 << bit);
      else gba.keypad.currentDown |= (1 << bit);
    },

    redetectDimensions() { /* fixed 240x160 — nothing to detect */ },

    dispose() {
      flushSave(true);
    },
  };

  // Warm up past the BIOS splash so the first frames have content
  for (let i = 0; i < 5; i++) gba.advanceFrame();
  lastTickAt = Date.now();
  frameDebt = 0;

  return engine;
}
