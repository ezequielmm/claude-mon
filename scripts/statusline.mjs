#!/usr/bin/env node
/**
 * statusline.mjs — animated arcade banner renderer for Claude Code's statusline.
 *
 * Claude Code pipes a JSON payload to stdin, reads stdout, and renders it
 * below the input box. Multi-line output = multiple rows. ANSI colours are
 * supported. Target: <50ms, ~1fps animation via refreshInterval.
 *
 * On ANY error: print "claude-mon ⚠" and exit 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, resolveSessionState, TMP_ROOT, readJson } from '../lib/state.mjs';
import { upsertTtyRegistry, removeTtyEntry } from '../lib/registry.mjs';
import { createFire, stepFire, heatToRgb, saveFire, loadFire } from '../lib/fire.mjs';
import { renderHalfBlocks, renderQuadrants } from '../lib/render.mjs';
import { kittyVirtualImage, kittyPlaceholderLines, kittyDeleteImage } from '../lib/gfx-protocol.mjs';
import { debugEnabled, dbgLog } from '../lib/debug.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const FIRE_SESSION_DIR = path.join(TMP_ROOT, 'sessions');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp a number to [lo, hi]. */
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * Read all of stdin, race against a timeout so we never hang.
 * @returns {Promise<string>}
 */
function readStdinWithTimeout(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let resolved = false;

    const finish = (str) => {
      if (resolved) return;
      resolved = true;
      resolve(str);
    };

    const timer = setTimeout(() => {
      finish(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);

    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

/** Detect truecolor support from environment. */
function detectTruecolor() {
  return /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
}

/** ANSI SGR codes for HUD styling. */
const SGR = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  blink:  '\x1b[5m',
  fgRed:  '\x1b[38;5;196m',
  fgOrng: '\x1b[38;5;208m',
  fgYlw:  '\x1b[38;5;220m',
  fgGrn:  '\x1b[38;5;70m',
  fgCyan: '\x1b[38;5;51m',
  fgDimG: '\x1b[38;5;65m',
  fgGray: '\x1b[38;5;244m',
};

// ── HUD line ──────────────────────────────────────────────────────────────────

/**
 * Build the single HUD status line.
 *
 * @param {object} params
 * @param {{ mode: string, attention: boolean }} params.state
 * @param {object|undefined} params.modelObj
 * @param {object|undefined} params.ctxObj
 * @param {number} params.width
 * @param {string|undefined} params.extraSuffix
 * @param {{ playing: boolean, aggressive: boolean, owner?: string }|null} [params.botStatus]
 * @returns {string}  ANSI-styled string, truncated to `width` visible chars.
 */
function buildHudLine({ state, modelObj, ctxObj, width, extraSuffix, botStatus }) {
  const modelName = modelObj?.display_name ?? modelObj?.id ?? 'claude';
  const usedPct = ctxObj?.used_percentage;

  const now = Date.now();
  const evenSecond = Math.floor(now / 1000) % 2 === 0;

  let statusPart;
  let statusColor;

  // User-controller HUD override: when the user has the wheel, show it
  // regardless of Claude's session mode (attention/working/idle/afk).
  if (botStatus?.playing && botStatus?.owner === 'user') {
    statusColor = SGR.fgGrn;
    statusPart = `${statusColor}you're driving 🎮${SGR.reset}`;
  } else if (state.attention) {
    // Alternating bold on even seconds (blink-style without actual blink)
    const prefix = evenSecond ? `${SGR.bold}${SGR.fgYlw}` : `${SGR.fgYlw}`;
    statusPart = `${prefix}⚠ claude needs your input${SGR.reset}`;
    statusColor = '';
  } else {
    switch (state.mode) {
      case 'working':
        // Check bot status: if bot is active and aggressive, show bot text
        if (botStatus?.playing && botStatus?.aggressive) {
          statusColor = SGR.fgOrng;
          statusPart = `${statusColor}claude is playing — go grab a coffee ◈${SGR.reset}`;
        } else {
          statusColor = SGR.fgOrng;
          statusPart = `${statusColor}claude is working — go grab a coffee${SGR.reset}`;
        }
        break;
      case 'afk':
        if (botStatus?.playing) {
          statusColor = SGR.fgCyan;
          statusPart = `${statusColor}autopilot · type away${SGR.reset}`;
        } else {
          statusColor = SGR.fgCyan;
          statusPart = `${statusColor}AFK · demo mode${SGR.reset}`;
        }
        break;
      case 'idle':
      default:
        if (botStatus?.playing) {
          statusColor = SGR.fgCyan;
          statusPart = `${statusColor}autopilot · type away${SGR.reset}`;
        } else {
          statusColor = SGR.fgDimG;
          statusPart = `${statusColor}done — waiting for you${SGR.reset}`;
        }
        break;
    }
  }

  // Assemble visible segments (for length estimation)
  let visibleParts = ` ▶ claude-mon · ${stripAnsi(statusPart)} · ${modelName}`;
  if (usedPct !== undefined && usedPct !== null) {
    visibleParts += ` · ctx ${usedPct}%`;
  }
  if (extraSuffix) {
    visibleParts += ` · ${extraSuffix}`;
  }

  // Build the styled version
  let styled = `${SGR.dim} ▶ claude-mon${SGR.reset} · ${statusPart} · ${SGR.fgGray}${modelName}${SGR.reset}`;
  if (usedPct !== undefined && usedPct !== null) {
    styled += ` · ${SGR.fgGray}ctx ${usedPct}%${SGR.reset}`;
  }
  if (extraSuffix) {
    styled += ` · ${SGR.dim}${extraSuffix}${SGR.reset}`;
  }

  // Truncate to width (visible chars only — crude but safe)
  const visible = stripAnsi(styled);
  if (visible.length > width) {
    // Rebuild truncated plain version
    const truncated = visibleParts.slice(0, width - 1) + '…';
    return truncated;
  }

  return styled;
}

/** Strip ANSI escape codes for length measurement. */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Find the terminal device of the nearest ancestor process that has one.
 *
 * Claude Code spawns statusline children without a controlling terminal
 * (/dev/tty → ENXIO), but the claude process itself sits on a real tty
 * (e.g. ttys011). Walking up the parent chain with `ps -o ppid=,tty=`
 * finds it; that device is owned by the same user and is writable, giving
 * us an out-of-band channel to the terminal for kitty graphics.
 *
 * @returns {string|null}  e.g. "/dev/ttys011", or null if none found
 */
function discoverAncestorTty() {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    let out = '';
    try {
      const r = spawnSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 800,
      });
      out = r.stdout ?? '';
    } catch {
      return null;
    }
    const m = out.trim().match(/^(\d+)\s+(\S+)/);
    if (!m) return null;
    const ppid = parseInt(m[1], 10);
    const tty = m[2];
    if (tty && tty !== '??' && tty !== '-') {
      return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
    }
    pid = ppid;
  }
  return null;
}

// ── Fire persistence ──────────────────────────────────────────────────────────

/**
 * Load (or create) fire state, step it proportionally to elapsed time,
 * and save it back.
 *
 * @param {string} fireFile  Path to the .fire binary file.
 * @param {number} w  Pixel width.
 * @param {number} h  Pixel height.
 * @param {number} intensity  0..1
 * @returns {import('../lib/fire.mjs').FireState}
 */
function loadStepSaveFire(fireFile, w, h, intensity) {
  let fire = null;
  let lastMtime = 0;

  try {
    const stat = fs.statSync(fireFile);
    lastMtime = stat.mtimeMs;
    fire = loadFire(fireFile, w, h);
  } catch {
    // File doesn't exist yet — fire will be null
  }

  if (!fire) {
    fire = createFire(w, h);
    lastMtime = 0; // force several steps to warm up
  }

  const elapsed = Date.now() - lastMtime;
  // ~120ms per step (≈8fps effective at 1fps terminal refresh)
  const steps = clamp(Math.round(elapsed / 120), 1, 8);

  for (let i = 0; i < steps; i++) {
    stepFire(fire, intensity);
  }

  saveFire(fire, fireFile);
  return fire;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  // Diagnostic accumulator — filled throughout main(), flushed at exit.
  const diag = {
    sid: null,
    style: null,
    game: null,
    rows: null,
    cols: null,
    env: {
      tp:   process.env.TERM_PROGRAM ?? null,
      term: process.env.TERM ?? null,
      ct:   process.env.COLORTERM ?? null,
      sz:   `${process.env.COLUMNS ?? '?'}x${process.env.LINES ?? '?'}`,
    },
    mode: null,
    out:  null,
    tMs:  null,
  };

  // 1. Read stdin (race with 150ms timeout)
  const raw = await readStdinWithTimeout(150);

  // 2. Parse defensively
  let json = {};
  try {
    if (raw.trim()) json = JSON.parse(raw);
  } catch {
    // proceed with empty object — fire with fallback session
  }

  // 3. Load config
  const config = readConfig();
  const dbgOn  = debugEnabled(config);

  if (config.enabled === false) {
    if (dbgOn) {
      diag.tMs = Date.now() - t0;
      diag.out  = { kind: 'empty', lines: 0, bytes: 0, sample: null };
      dbgLog('statusline', diag);
    }
    // Print nothing
    process.exit(0);
  }

  // HUD-only mode: inside the doomscreen compositor the game IS the whole
  // screen — banner rows would float over it as an orphaned blob (their
  // centered game cells win the composition). Same when the user disables
  // the banner (`/afk banner off`) but keeps the status HUD.
  if (process.env.AFK_DOOMSCREEN_INNER === '1' || config.banner === false) {
    const cols0 = parseInt(process.env.COLUMNS, 10) || 80;
    const botStatusPath = path.join(TMP_ROOT, 'doom', 'bot-status.json');
    const bs = (() => {
      try {
        const b = readJson(botStatusPath, null);
        return b && Date.now() - (b.updatedAt ?? 0) < 5000 ? b : null;
      } catch { return null; }
    })();
    const hudOnly = buildHudLine({
      state, modelObj: json.model, ctxObj: json.context_window,
      width: clamp(cols0, 20, 280),
      extraSuffix: process.env.AFK_DOOMSCREEN_INNER === '1' ? 'doom: fullscreen' : '',
      botStatus: bs,
    }) + '\n';
    process.stdout.write(hudOnly);
    if (dbgOn) {
      diag.tMs = Date.now() - t0;
      diag.out = { kind: 'doomscreen-hud', lines: 1, bytes: hudOnly.length, sample: null };
      dbgLog('statusline', diag);
    }
    process.exit(0);
  }

  // 4. Terminal dimensions
  const cols = parseInt(process.env.COLUMNS, 10) || 80;
  const width = clamp(cols, 20, 280);
  const rows = clamp(config.rows, 2, 40);
  const pixH = rows * 2; // pixel height (2px per terminal row)

  diag.sid   = json.session_id ?? null;
  diag.style = config.style ?? 'quad';
  diag.game  = config.game  ?? 'fire';
  diag.rows  = rows;
  diag.cols  = width;

  // 5. Session state → fire intensity
  const sessionId = json.session_id;
  const state = resolveSessionState(sessionId);
  diag.mode = state.mode;

  const intensityMap = { working: 1.0, afk: 0.85, idle: 0.25 };
  const intensity = intensityMap[state.mode] ?? 0.25;

  // 6. Fire persistence
  const style = config.style ?? 'quad';
  // Quad and pixel modes run the fire simulation at double width (each cell covers 2 columns).
  // Pixel mode falls back to quad-style fire when DOOM is not running.
  const fireW = (style === 'quad' || style === 'pixel') ? width * 2 : width;

  const fireFileId = sessionId ?? 'global';
  const fireFile = path.join(FIRE_SESSION_DIR, `${fireFileId}.fire`);
  const fire = loadStepSaveFire(fireFile, fireW, pixH, intensity);

  // Helper: flush diag and exit cleanly.
  // `outputStr` is what we already wrote to stdout.
  const exitWithDiag = (outputStr, kind) => {
    if (dbgOn) {
      const outputLines = outputStr.split('\n').filter(l => l.length > 0);
      const secondLine  = outputLines[1] ?? '';
      diag.out = {
        kind,
        lines: outputLines.length,
        bytes: Buffer.byteLength(outputStr, 'utf8'),
        sample: JSON.stringify(secondLine.slice(0, 80)),
      };
      diag.tMs = Date.now() - t0;
      dbgLog('statusline', diag);
    }
    process.exit(0);
  };

  // 7. Phase B contract: DOOM daemon frame handling
  let extraSuffix;
  if (config.game === 'doom') {
    const doomDir  = path.join(TMP_ROOT, 'doom');
    const doomFrame  = path.join(doomDir, 'frame.ans');
    const viewportFile = path.join(doomDir, 'viewport.json');
    const pidFile    = path.join(doomDir, 'daemon.pid');

    // Always write the current viewport spec so the daemon knows our dimensions.
    // Atomic write is fine (it's not critical path for correctness).
    try {
      const truecolor = detectTruecolor();
      const viewportObj = { cols: width, pxRows: rows * 2, truecolor };
      const vTmp = viewportFile + '.tmp';
      fs.mkdirSync(doomDir, { recursive: true });
      fs.writeFileSync(vTmp, JSON.stringify(viewportObj), 'utf8');
      fs.renameSync(vTmp, viewportFile);
    } catch { /* non-fatal */ }

    // Check for a fresh daemon frame (< 5s old)
    let frameAge = Infinity;
    let frameStat = null;
    try {
      frameStat = fs.statSync(doomFrame);
      frameAge = Date.now() - frameStat.mtimeMs;
    } catch { /* frame absent */ }

    // 12s window: a daemon self-recycle takes ~3-5s (exit + statusline respawn
    // + engine boot). Serving the last frame through that gap freezes the game
    // for a beat instead of flashing the fire fallback.
    if (frameAge < 12000) {
      // Daemon is alive and fresh — use its frame.
      // For pixel style, attempt out-of-band PNG transmission + placeholder text.
      const doomFramePng = path.join(doomDir, 'frame.png');

      // Pixel mode requires a real terminal-ish environment: ancestor-tty
      // discovery from headless contexts (tests, CI) would otherwise find an
      // unrelated tty up the process tree and spray kitty escapes at it.
      const hasTerminalEnv = Boolean(process.env.TERM_PROGRAM || process.env.TERM);

      // Backdrop OFF cleanup: remove this session's registry entry and send
      // a one-time kitty delete if we previously had a tty registered.
      if (config.backdrop !== true) {
        // Legacy backdrop-tx bookkeeping cleanup (from pre-0.6 versions)
        const txJsonPath = path.join(TMP_ROOT, `backdrop-tx-${sessionId ?? 'global'}.json`);
        try {
          const txState = JSON.parse(fs.readFileSync(txJsonPath, 'utf8'));
          if (typeof txState.ttyPath === 'string') {
            try {
              const fd = fs.openSync(txState.ttyPath, 'w');
              fs.writeSync(fd, kittyDeleteImage(77));
              fs.closeSync(fd);
            } catch { /* tty gone — nothing to clean */ }
          }
          fs.unlinkSync(txJsonPath);
        } catch { /* no leftover backdrop — nothing to do */ }

        // Remove from daemon TTY registry
        removeTtyEntry(sessionId ?? 'global');
      }

      // ── Backdrop mode: register this session's tty for daemon streaming ──
      // The daemon reads the tty registry and sends kitty backdrop frames
      // out-of-band at backdropFps (default 24fps).  The statusline only
      // needs to UPSERT the registry entry; no image transmission here.
      // The visible banner collapses to the single HUD line.
      //
      // PER-TERMINAL AUTO-DEGRADE: backdrop requires kitty graphics. In
      // terminals that don't speak it (e.g. Apple Terminal) the images are
      // silently ignored — collapsing the banner there left users with a bare
      // HUD line and "nothing playing". Sessions in non-kitty terminals skip
      // the backdrop entirely and render the full quad banner instead.
      const kittyCapableTerm = /warpterminal|kitty|wezterm|ghostty/i.test(
        `${process.env.TERM_PROGRAM ?? ''} ${process.env.TERM ?? ''}`,
      );
      if (config.backdrop === true && !process.env.AFK_ARCADE_NO_PIXEL && hasTerminalEnv && kittyCapableTerm) {
        diag.backdrop = { registry: null };

        // Discover this session's tty (use per-session cache file for discovery cache)
        const txJsonPath = path.join(TMP_ROOT, `backdrop-tx-${sessionId ?? 'global'}.json`);
        const txState = (() => {
          try { return JSON.parse(fs.readFileSync(txJsonPath, 'utf8')); } catch { return {}; }
        })();

        let ttyPathUsed = null;
        const tryFindTty = (p) => {
          try { fs.openSync(p, 'w'); fs.closeSync(fs.openSync(p, 'w')); ttyPathUsed = p; return true; } catch { return false; }
        };
        // Try in order: /dev/tty → cached tty → discover via ps-walk
        // We only need to know the path is usable; we don't write here
        const tryProbe = (p) => {
          try {
            const fd = fs.openSync(p, 'w');
            fs.closeSync(fd);
            ttyPathUsed = p;
            return true;
          } catch { return false; }
        };
        // Wrapper override first: doomclaude exports the REAL terminal tty so
        // frames bypass the wrapper pty (game stays live during drive mode).
        const realTty = process.env.AFK_ARCADE_REAL_TTY;
        if (!(typeof realTty === 'string' && realTty.startsWith('/dev/') && tryProbe(realTty))) {
          if (!tryProbe('/dev/tty')) {
            if (!(typeof txState.ttyPath === 'string' && txState.ttyPath !== '/dev/tty' && tryProbe(txState.ttyPath))) {
              const discovered = discoverAncestorTty();
              if (discovered) tryProbe(discovered);
            }
          }
        }

        if (ttyPathUsed) {
          const fullCols = parseInt(process.env.COLUMNS, 10) || 80;
          const fullLines = parseInt(process.env.LINES, 10) || 24;
          const sid = sessionId ?? 'global';
          upsertTtyRegistry(sid, { ttyPath: ttyPathUsed, cols: fullCols, lines: fullLines });
          diag.backdrop.registry = { sid, ttyPath: ttyPathUsed, cols: fullCols, lines: fullLines };

          // Persist tty cache so next invocation can skip discovery
          try {
            const t = txJsonPath + '.tmp';
            fs.writeFileSync(t, JSON.stringify({ ttyPath: ttyPathUsed }), 'utf8');
            fs.renameSync(t, txJsonPath);
          } catch { /* non-fatal */ }
        }

        // Read bot status for HUD
        const botStatusPath = path.join(TMP_ROOT, 'doom', 'bot-status.json');
        const botStatus = (() => {
          try {
            const bs = readJson(botStatusPath, null);
            if (bs && typeof bs.playing === 'boolean') {
              const age = Date.now() - (bs.updatedAt ?? 0);
              return age < 5000 ? bs : null;
            }
            return null;
          } catch { return null; }
        })();

        const hudOnly = buildHudLine({
          state, modelObj: json.model, ctxObj: json.context_window,
          width, extraSuffix: 'backdrop', botStatus,
        }) + '\n';
        process.stdout.write(hudOnly);
        exitWithDiag(hudOnly, 'backdrop');
        return;
      }
      if (style === 'pixel' && !process.env.AFK_ARCADE_NO_PIXEL && hasTerminalEnv) {
        // Pixel path: transmit PNG directly to /dev/tty, emit placeholder lines to stdout.
        //
        // Preconditions (all must hold — otherwise fall through to quad frame.ans):
        //   1. frame.png exists and is fresh (< 5s old)
        //   2. /dev/tty is writable
        //
        // The pixel-tx.json bookkeeping file (TMP_ROOT/pixel-tx.json) tracks the
        // last transmitted mtime so we only re-transmit when the PNG has changed.
        // This limits /dev/tty writes to ≤4/s (daemon frame rate) while keeping
        // placeholder-text regeneration cheap on every statusline poll (~1/s).
        //
        // Escape hatch: AFK_ARCADE_NO_PIXEL=1 hard-disables; `/afk style quad` reverts.

        // Init pixel diag sub-object
        diag.pixel = {
          tty: null,
          png: null,
          tx:  null,
          fellBack: null,
        };

        let pixelOk = false;
        try {
          let pngStat = null;
          try {
            pngStat = fs.statSync(doomFramePng);
          } catch {
            diag.pixel.png = 'missing';
            diag.pixel.fellBack = 'png-missing';
          }

          if (pngStat) {
            const pngAgeMs = Date.now() - pngStat.mtimeMs;
            if (pngAgeMs >= 5000) {
              diag.pixel.png = { ageMs: pngAgeMs, bytes: pngStat.size };
              diag.pixel.fellBack = `png-stale-${pngAgeMs}ms`;
            } else {
              diag.pixel.png = { ageMs: pngAgeMs, bytes: pngStat.size };

              // Bookkeeping is read early so the cached ancestor-tty path is
              // available to the open chain below.
              const txJsonPath = path.join(TMP_ROOT, `pixel-tx-${sessionId ?? 'global'}.json`);
              const txState = (() => {
                try { return JSON.parse(fs.readFileSync(txJsonPath, 'utf8')); } catch { return {}; }
              })();

              // Open a terminal device for writing. Chain:
              //   1. /dev/tty            — works only with a controlling terminal
              //   2. cached ancestor tty — discovered on a previous poll
              //   3. ps-walk discovery   — find the claude ancestor's tty device
              // Claude Code gives statusline children NO controlling terminal
              // (ENXIO), so 2/3 are the real path on macOS.
              let ttyFd = -1;
              let ttyPathUsed = null;
              const tryOpen = (p) => {
                try { ttyFd = fs.openSync(p, 'w'); ttyPathUsed = p; return true; } catch { return false; }
              };

              if (tryOpen('/dev/tty')) {
                diag.pixel.tty = 'ok:/dev/tty';
              } else if (typeof txState.ttyPath === 'string' && txState.ttyPath !== '/dev/tty' && tryOpen(txState.ttyPath)) {
                diag.pixel.tty = `ok:cached:${txState.ttyPath}`;
              } else {
                const discovered = discoverAncestorTty();
                if (discovered && tryOpen(discovered)) {
                  diag.pixel.tty = `ok:discovered:${discovered}`;
                } else {
                  diag.pixel.tty = discovered
                    ? `err:open-failed:${discovered}`
                    : 'err:no-ancestor-tty';
                  diag.pixel.fellBack = 'tty-open-failed';
                }
              }

              if (ttyFd >= 0) {
                try {
                  // Compute game dimensions (same math as daemon.mjs / quad path).
                  const { computeGameWidth: cgw } = await import('../lib/scale.mjs');
                  const pixelAspect = config.aspect ?? '4:3';
                  const gameW       = cgw(pixelAspect, rows * 2, width);
                  const leftPad     = Math.floor((width - gameW) / 2);

                  // Re-transmit only when the PNG file has changed since last time.
                  if (pngStat.mtimeMs !== (txState.lastMtime ?? 0)) {
                    const pngBuf  = fs.readFileSync(doomFramePng);
                    const txStr   = kittyVirtualImage(pngBuf, { imageId: 42, cols: gameW, rows });
                    const tTxStart = Date.now();
                    fs.writeSync(ttyFd, txStr);
                    const tTxMs = Date.now() - tTxStart;

                    diag.pixel.tx = {
                      sent:   true,
                      bytes:  Buffer.byteLength(txStr, 'utf8'),
                      chunks: (txStr.match(/\x1b_G/g) ?? []).length,
                      ms:     tTxMs,
                    };

                    // Persist bookkeeping (non-fatal if write fails).
                    try {
                      const txTmp = txJsonPath + '.tmp';
                      fs.writeFileSync(txTmp, JSON.stringify({
                        lastMtime: pngStat.mtimeMs,
                        attempts: (txState.attempts ?? 0) + 1,
                        since:    txState.since ?? Date.now(),
                        ttyPath:  ttyPathUsed,
                      }), 'utf8');
                      fs.renameSync(txTmp, txJsonPath);
                    } catch { /* non-fatal */ }
                  } else {
                    diag.pixel.tx = { sent: false, skip: 'mtime-unchanged' };
                  }

                  fs.closeSync(ttyFd);

                  // Emit placeholder text to stdout (flows through Claude Code renderer).
                  const hudLine = buildHudLine({
                    state, modelObj: json.model, ctxObj: json.context_window,
                    width, extraSuffix: 'pixel',
                  });
                  const phLines = kittyPlaceholderLines({ imageId: 42, cols: gameW, rows, leftPad });
                  const pixelOut = hudLine + '\n' + phLines.join('\n') + '\n';
                  process.stdout.write(pixelOut);
                  pixelOk = true;

                  exitWithDiag(pixelOut, 'pixel');
                } catch (innerErr) {
                  if (diag.pixel.fellBack == null) diag.pixel.fellBack = `tx-error:${innerErr.message}`;
                  try { fs.closeSync(ttyFd); } catch { /* ignore */ }
                }
              }
            }
          }
        } catch (pixelErr) {
          if (diag.pixel.fellBack == null) diag.pixel.fellBack = `outer-error:${pixelErr.message}`;
        }

        if (pixelOk) return; // exitWithDiag already called
        // Fall through to quad frame.ans below.
      }

      // Quad / half / pixel-fallback path: use frame.ans text content.
      try {
        // Read bot status for HUD (fresh <5s)
        const botStatusPath2 = path.join(TMP_ROOT, 'doom', 'bot-status.json');
        const botStatus2 = (() => {
          try {
            const bs = readJson(botStatusPath2, null);
            if (bs && typeof bs.playing === 'boolean') {
              const age = Date.now() - (bs.updatedAt ?? 0);
              return age < 5000 ? bs : null;
            }
            return null;
          } catch { return null; }
        })();

        const hudLine = buildHudLine({
          state,
          modelObj: json.model,
          ctxObj: json.context_window,
          width,
          extraSuffix: undefined,
          botStatus: botStatus2,
        });
        const frameContent = fs.readFileSync(doomFrame, 'utf8');
        const doomOut = hudLine + '\n' + frameContent + '\n';
        process.stdout.write(doomOut);
        exitWithDiag(doomOut, 'doom-frame');
        return;
      } catch { /* fall through to fire */ }
    }

    // Frame is stale or absent — maybe daemon is dead; try to spawn it.
    // Guard with a spawn-lock directory so concurrent statusline runs never
    // double-spawn.
    const lockDir = path.join(doomDir, 'spawn.lock');
    let daemonIsAlive = false;
    try {
      const pidRaw = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = parseInt(pidRaw, 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 0); daemonIsAlive = true; } catch { /* stale pid */ }
      }
    } catch { /* pidfile absent */ }

    if (!daemonIsAlive) {
      // Attempt spawn lock (mkdir is atomic on POSIX)
      let gotLock = false;
      try {
        // Check if lock is stale (> 30s)
        try {
          const lockStat = fs.statSync(lockDir);
          if (Date.now() - lockStat.mtimeMs > 30_000) {
            fs.rmdirSync(lockDir);
          }
        } catch { /* lock doesn't exist */ }

        fs.mkdirSync(lockDir);
        gotLock = true;
      } catch { /* lock held by another concurrent run */ }

      if (gotLock) {
        try {
          const daemonScript = path.join(__dirname, 'daemon.mjs');
          const child = spawn(process.execPath, ['--no-warnings', daemonScript], {
            detached: true,
            stdio: 'ignore',
          });
          child.unref();
        } catch { /* spawn failed — non-fatal */ }

        // Keep the lock — the daemon needs a moment to claim its pidfile, and
        // concurrent statusline polls (multiple sessions) must not double-spawn.
        // The stale check above clears it after 30s, which also rate-limits
        // respawn attempts if the daemon crashes on boot.
      }
    }

    // While daemon is warming up (or offline), show fire with "doom: warming up"
    extraSuffix = daemonIsAlive ? 'doom: warming up' : 'doom: warming up';
  }

  // 8. Build HUD line
  const hudLine = buildHudLine({
    state,
    modelObj: json.model,
    ctxObj: json.context_window,
    width,
    extraSuffix,
  });

  // 9. Render fire — quad or half-block depending on config
  const truecolor = detectTruecolor();
  const heatGetPixel = (x, y) => {
    const idx = clamp(y, 0, pixH - 1) * fireW + clamp(x, 0, fireW - 1);
    return heatToRgb(fire.heat[idx]);
  };
  // Pixel style falls back to quad rendering for the fire (no DOOM frame available).
  const fireLines = (style === 'quad' || style === 'pixel')
    ? renderQuadrants(heatGetPixel, fireW, pixH, { truecolor })
    : renderHalfBlocks(heatGetPixel, width, pixH, { truecolor });

  // Determine output kind
  const outputKind = style === 'pixel' ? 'quad' // pixel without doom falls back to quad fire
    : style === 'quad' ? 'quad'
    : 'half';

  // 10. Output: HUD line first, then fire rows
  const output = [hudLine, ...fireLines].join('\n') + '\n';
  process.stdout.write(output);
  exitWithDiag(output, outputKind);
}

main().catch((err) => {
  // Best-effort diagnostic on the error path — AFK_ARCADE_DEBUG env is enough to gate it.
  if (process.env.AFK_ARCADE_DEBUG === '1') {
    try {
      dbgLog('statusline', {
        err:   err?.message ?? String(err),
        stack: err?.stack?.split('\n')[1]?.trim() ?? null,
        tMs:   null,
      });
    } catch { /* truly last resort */ }
  }
  process.stdout.write('claude-mon ⚠\n');
  process.exit(0);
});
