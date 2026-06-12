#!/usr/bin/env node
/**
 * capture.mjs — headless screenshot capture for README images.
 *
 * Boots the DOOM engine, advances to key moments in the attract sequence,
 * and writes PNG captures to the captures/ directory.
 *
 * Outputs:
 *   captures/title-1280.png    — title screen (~400 ticks in)
 *   captures/gameplay-1280.png — gameplay/attract demo (~2200 ticks in)
 *   captures/fire.png          — PSX fire effect (320×160, 120 steps at intensity 1.0)
 *
 * Usage:
 *   node scripts/capture.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CAPTURES_DIR = path.join(ROOT, 'captures');

import { createDoom, vendorAssetsExist } from '../lib/doom-engine.mjs';
import { encodePng } from '../lib/png.mjs';
import { createFire, stepFire, heatToRgb } from '../lib/fire.mjs';

// ── Guards ────────────────────────────────────────────────────────────────────

if (!vendorAssetsExist()) {
  process.stderr.write(
    'error: DOOM vendor assets missing.\nRun: node scripts/fetch-doom.mjs\n',
  );
  process.exit(1);
}

fs.mkdirSync(CAPTURES_DIR, { recursive: true });

// ── DOOM captures ─────────────────────────────────────────────────────────────

process.stdout.write('Booting DOOM engine...\n');
const engine = await createDoom();
process.stdout.write(`Engine ready: ${engine.width}×${engine.height}\n`);

/**
 * Advance the engine by `n` ticks, writing progress dots every 100 ticks.
 * @param {number} n
 */
function tick(n) {
  for (let i = 0; i < n; i++) {
    engine.tick();
    if ((i + 1) % 100 === 0) process.stdout.write('.');
  }
  if (n >= 100) process.stdout.write('\n');
}

/**
 * Capture the current framebuffer and write it as a PNG file.
 * @param {string} outPath  Absolute path to the output PNG.
 * @returns {{ path: string, size: number, width: number, height: number }}
 */
function captureFrame(outPath) {
  const { width, height } = engine;
  const rgb = engine.getFrameRGB();
  const png = encodePng(rgb, width, height, { level: 6 });
  fs.writeFileSync(outPath, png);
  return { path: outPath, size: png.length, width, height };
}

// Title screen: advance ~400 ticks from the 35 already done during init warmup
process.stdout.write('Advancing to title screen (~400 ticks)...\n');
tick(365); // createDoom() already ticked 35 frames

const titleOut = path.join(CAPTURES_DIR, 'title-1280.png');
const titleInfo = captureFrame(titleOut);
process.stdout.write(
  `Written: ${titleInfo.path}\n` +
  `  Size: ${(titleInfo.size / 1024).toFixed(1)} KB  Dimensions: ${titleInfo.width}×${titleInfo.height}\n`,
);

// Attract demo: advance ~1800 more ticks
process.stdout.write('Advancing to attract demo (~1800 more ticks)...\n');
tick(1800);

const gameplayOut = path.join(CAPTURES_DIR, 'gameplay-1280.png');
const gameplayInfo = captureFrame(gameplayOut);
process.stdout.write(
  `Written: ${gameplayInfo.path}\n` +
  `  Size: ${(gameplayInfo.size / 1024).toFixed(1)} KB  Dimensions: ${gameplayInfo.width}×${gameplayInfo.height}\n`,
);

engine.dispose();

// ── PSX fire capture ──────────────────────────────────────────────────────────

process.stdout.write('Rendering PSX fire effect (320×160, 120 steps)...\n');

const FIRE_W = 320;
const FIRE_H = 160;
const fire = createFire(FIRE_W, FIRE_H);

for (let step = 0; step < 120; step++) {
  stepFire(fire, 1.0);
}

// Map heat field to RGB
const fireRgb = new Uint8Array(FIRE_W * FIRE_H * 3);
for (let y = 0; y < FIRE_H; y++) {
  for (let x = 0; x < FIRE_W; x++) {
    const heat = fire.heat[y * FIRE_W + x];
    const [r, g, b] = heatToRgb(heat);
    const off = (y * FIRE_W + x) * 3;
    fireRgb[off]     = r;
    fireRgb[off + 1] = g;
    fireRgb[off + 2] = b;
  }
}

const firePng = encodePng(fireRgb, FIRE_W, FIRE_H, { level: 6 });
const fireOut = path.join(CAPTURES_DIR, 'fire.png');
fs.writeFileSync(fireOut, firePng);
process.stdout.write(
  `Written: ${fireOut}\n` +
  `  Size: ${(firePng.length / 1024).toFixed(1)} KB  Dimensions: ${FIRE_W}×${FIRE_H}\n`,
);

process.stdout.write('\ncapture.mjs done\n');
