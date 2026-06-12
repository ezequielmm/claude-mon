#!/usr/bin/env node
/**
 * doombrain.mjs — the CORTEX: Claude steers the marine's strategy.
 *
 * Cerebellum + cortex architecture:
 *   - The heuristic bot (lib/doom-bot.mjs) keeps playing at 30Hz: aiming via
 *     motion zones, wall unsticking, item pickups. It never stops.
 *   - This sidecar periodically renders frame.rgb as a compact ASCII tactical
 *     grid (text-only — ~10x cheaper and faster than vision), asks a cheap
 *     Claude model for ONE strategic order, and writes it to
 *     brain-orders.json. The daemon feeds fresh orders into bot.update().
 *
 * Orders bias, never replace, the reflex layer: hunt / advance /
 * explore_left / explore_right / retreat / door. Between decisions the
 * current order keeps steering; when it expires the bot is autonomous.
 *
 * Usage:
 *   node scripts/doombrain.mjs [--once]
 *   AFK_BRAIN_MODEL     model alias/id (default: haiku)
 *   AFK_BRAIN_INTERVAL  ms between decisions (default 8000, min 3000)
 *   AFK_BRAIN_MINUTES   auto-stop after N minutes (default 30)
 *   AFK_BRAIN_VISION=png  attach a PNG instead of the ASCII grid (slower)
 *
 * Stop: /afk brain off (doombrain.stop sentinel + pid kill fallback).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TMP_ROOT, readConfig } from '../lib/state.mjs';
import { parseFrameRgb } from '../lib/compose.mjs';
import { encodePngFast } from '../lib/png.mjs';
import {
  extractOrder, frameToAsciiGrid, buildOrderPrompt, BRAIN_PROMPT, extractPlan,
  extractGbaStep, POKEMON_PROMPT, GBA_BUTTON_CODES,
} from '../lib/brain-core.mjs';
import { buildControlState } from '../lib/control-core.mjs';

const DOOM_TMP     = path.join(TMP_ROOT, 'doom');
const FRAME_RGB    = path.join(DOOM_TMP, 'frame.rgb');
const RAW_REQUEST  = path.join(DOOM_TMP, 'raw-request.json');
const BRAIN_ORDERS = path.join(DOOM_TMP, 'brain-orders.json');
const CONTROL_JSON = path.join(DOOM_TMP, 'control.json');
const STATUS_FILE  = path.join(DOOM_TMP, 'doombrain-status.json');
const STOP_FILE    = path.join(DOOM_TMP, 'doombrain.stop');
const FRAME_PNG    = path.join(DOOM_TMP, 'doombrain-frame.png');

const MODEL    = process.env.AFK_BRAIN_MODEL ?? 'haiku';
const INTERVAL = Math.max(3000, parseInt(process.env.AFK_BRAIN_INTERVAL ?? '8000', 10) || 8000);
const MAX_MS   = Math.max(1, parseInt(process.env.AFK_BRAIN_MINUTES ?? '30', 10) || 30) * 60_000;
// Game profile: 'doom' (FPS cortex → orders) or 'pokemon'/'gba' (vision pilot
// reading on-screen text → button taps via control.json). AFK_BRAIN_GAME, or
// inferred from config.game at boot.
const GAME = (process.env.AFK_BRAIN_GAME ?? '').toLowerCase();
const POKEMON = GAME === 'pokemon' || GAME === 'gba'
  || (() => { try { return ['gba'].includes(readConfig().game); } catch { return false; } })();
const USE_PNG  = POKEMON || process.env.AFK_BRAIN_VISION === 'png';
const MEMORY_NOTES = POKEMON ? 8 : 6;
let tapSeq = 1;

const startedAt = Date.now();
let decisions = 0;
let failures = 0;
let memory = [];   // rolling strategist notes
let prevFrame = null;
let lastNote = '';

function writeStatus(extra) {
  try {
    const tmp = STATUS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      pid: process.pid, model: MODEL,
      mode: POKEMON ? 'pokemon' : USE_PNG ? 'png' : 'ascii',
      decisions, failures, note: lastNote, updatedAt: Date.now(), ...extra,
    }));
    fs.renameSync(tmp, STATUS_FILE);
  } catch { /* non-fatal */ }
}

function publishOrder(order) {
  try {
    const tmp = BRAIN_ORDERS + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...order, at: Date.now(), pid: process.pid }));
    fs.renameSync(tmp, BRAIN_ORDERS);
  } catch { /* daemon keeps the previous order until it expires */ }
}

function callModel(prompt, allowRead) {
  // Prompt via STDIN: it contains | and " which cmd.exe would parse as
  // pipeline operators no matter how node quotes the argv.
  const cliArgs = ['/c', 'claude', '-p', '--model', MODEL, '--strict-mcp-config'];
  if (allowRead) cliArgs.push('--allowedTools', 'Read');
  const r = spawnSync('cmd.exe', cliArgs, {
    input: prompt,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, AFK_DOOMSCREEN_INNER: '1' },
  });
  return r.stdout ?? '';
}

function decide() {
  let frame;
  try {
    frame = parseFrameRgb(fs.readFileSync(FRAME_RGB));
  } catch { frame = null; }
  if (!frame) {
    writeStatus({ waiting: 'frame.rgb' });
    return;
  }

  // Write an upscaled, dim-corrected PNG for any vision path
  function snapshotPng() {
    const scale = frame.w >= 220 ? 3 : 4;
    const W = frame.w * scale;
    const H = frame.h * scale;
    const out = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const so = (((y / scale) | 0) * frame.w + ((x / scale) | 0)) * 3;
        const o = (y * W + x) * 3;
        out[o] = Math.min(255, frame.data[so] * 2.5);
        out[o + 1] = Math.min(255, frame.data[so + 1] * 2.5);
        out[o + 2] = Math.min(255, frame.data[so + 2] * 2.5);
      }
    }
    const tmp = FRAME_PNG + '.tmp';
    fs.writeFileSync(tmp, encodePngFast(out, W, H));
    fs.renameSync(tmp, FRAME_PNG);
  }

  // ── Pokémon / GBA pilot: read the screen text, press buttons ──────────────
  if (POKEMON) {
    snapshotPng();
    const reply = callModel(`Read the file ${FRAME_PNG} (a Game Boy Advance screen). ${POKEMON_PROMPT}`, true);
    const step = extractGbaStep(reply);
    if (step && step.buttons.length) {
      // Each button → a tap; the daemon pulses down+up (~80ms) per tap. A
      // staggered seq lets the daemon process them as distinct presses.
      const taps = step.buttons.map((b) => ({ seq: tapSeq++, code: GBA_BUTTON_CODES[b] }));
      try {
        const tmp = CONTROL_JSON + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(buildControlState([], taps, tapSeq)));
        fs.renameSync(tmp, CONTROL_JSON);
      } catch { /* daemon reads the next one */ }
      decisions++;
      lastNote = `[${step.buttons.join('+')}] ${step.note}`;
      memory.push(`[${new Date().toISOString().slice(11, 19)}] ${lastNote}`);
      if (memory.length > MEMORY_NOTES) memory.shift();
    } else {
      failures++;
    }
    writeStatus({ lastModelMs: Date.now() });
    return;
  }

  let order = null;
  if (USE_PNG) {
    snapshotPng();
    const reply = callModel(
      `Read the file ${FRAME_PNG} (a DOOM screenshot). ${BRAIN_PROMPT}`, true);
    // Translate a tactical plan into the nearest strategic order
    const plan = extractPlan(reply);
    if (plan) {
      order = {
        goal: plan.fire ? 'hunt'
          : plan.use ? 'door'
          : plan.move === 'back' ? 'retreat'
          : plan.turn === 'left' ? 'explore_left'
          : plan.turn === 'right' ? 'explore_right'
          : 'advance',
        durationMs: 12_000,
        note: plan.note,
      };
    }
  } else {
    const grid = frameToAsciiGrid(frame, prevFrame);
    prevFrame = frame;
    const reply = callModel(buildOrderPrompt(grid, memory.join('\n')), false);
    order = extractOrder(reply);
  }

  if (order) {
    decisions++;
    lastNote = `${order.goal}: ${order.note}`;
    memory.push(`[${new Date().toISOString().slice(11, 19)}] ${lastNote}`);
    if (memory.length > MEMORY_NOTES) memory.shift();
    publishOrder(order);
  } else {
    failures++;
  }
  writeStatus({ lastModelMs: Date.now() });
}

async function main() {
  try { fs.unlinkSync(STOP_FILE); } catch { /* clean start */ }
  process.stdout.write(
    `doombrain: mode=${POKEMON ? 'pokemon' : USE_PNG ? 'png' : 'ascii'} model=${MODEL} ` +
    `interval=${INTERVAL}ms max=${MAX_MS / 60000}min\n`);

  // Keep raw frames flowing even without a compositor attached
  const writeReq = () => {
    try {
      fs.mkdirSync(DOOM_TMP, { recursive: true });
      const tmp = RAW_REQUEST + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ cols: 120, rows: 40, pid: process.pid }));
      fs.renameSync(tmp, RAW_REQUEST);
    } catch { /* ignore */ }
  };
  writeReq();
  const rawReq = setInterval(writeReq, 5000);

  const once = process.argv.includes('--once');

  for (;;) {
    if (fs.existsSync(STOP_FILE)) break;
    if (Date.now() - startedAt > MAX_MS) break;

    try { decide(); } catch (err) {
      failures++;
      writeStatus({ error: err.message.slice(0, 120) });
    }

    if (once) break;
    await new Promise((r) => setTimeout(r, INTERVAL));
  }

  clearInterval(rawReq);
  try { fs.unlinkSync(STOP_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(BRAIN_ORDERS); } catch { /* let the bot go autonomous */ }
  writeStatus({ stopped: true });
  process.stdout.write(
    `doombrain: stopped — ${decisions} decisions, ${failures} failures\n`);
}

main().catch((err) => {
  process.stderr.write(`doombrain fatal: ${err.message}\n`);
  process.exit(1);
});
