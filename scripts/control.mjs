#!/usr/bin/env node
/**
 * control.mjs — user controller sidecar for the claude-mon DOOM backdrop.
 *
 * Run in a dedicated terminal tab (launched by `afk-ctl control`):
 *   node scripts/control.mjs
 *
 * Requires a TTY (stdin must be a real terminal). Exits with an error message
 * if no TTY is available.
 *
 * --stdin-bridge flag:
 *   node scripts/control.mjs --stdin-bridge
 *
 * In bridge mode stdin is a pipe (not a TTY). Raw bytes are read from stdin,
 * decoded via decodeKeys/HeldKeyTracker, and written to control.json at ~15Hz
 * exactly as the interactive mode would. No screen output. Bridge mode is
 * used by doomclaude.mjs to relay keyboard input from the doomclaude wrapper
 * while the user is in DRIVE mode.
 *
 * Sentinel: when the wrapper exits DRIVE mode it writes \\x00\\x01 to the
 * bridge. The bridge releases all held keys and writes heartbeat:0 immediately.
 *
 * Heartbeat management in bridge mode:
 *   - While bytes arrive: heartbeat ticks at ~15Hz (keeps daemon in user mode).
 *   - 2000ms silence: heartbeat is set to 0 once (bot resumes).
 *   - Sentinel \\x00\\x01 received: immediate heartbeat:0 + held:[].
 *
 * The daemon reads TMP_ROOT/doom/control.json on every tick. When the
 * heartbeat is fresh (<1500ms old) the daemon lets the user drive;
 * when it goes stale or heartbeat===0 the bot resumes automatically.
 *
 * Controls (interactive mode):
 *   w / up-arrow      move forward
 *   s / down-arrow    move backward
 *   a / left-arrow    turn left
 *   d / right-arrow   turn right
 *   space             use (open door / interact) — tap
 *   f or x            fire weapon — held
 *   1-7               select weapon — tap
 *   enter             confirm / menu select — tap
 *   esc               menu / escape — tap
 *   q / ctrl+c        quit and hand control back to bot
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKeys, HeldKeyTracker } from '../lib/keys.mjs';
import {
  mapKeyEventToDoom,
  buildControlState,
  KEY_FIRE,
} from '../lib/control-core.mjs';
import { TMP_ROOT } from '../lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Flag detection ─────────────────────────────────────────────────────────────

const STDIN_BRIDGE_MODE = process.argv.includes('--stdin-bridge');

// ── Require TTY (interactive mode only) ──────────────────────────────────────

if (!STDIN_BRIDGE_MODE) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    process.stderr.write(
      'control.mjs: stdin must be a TTY.\n' +
      'Run this command in a fresh interactive terminal tab — not piped or scripted.\n',
    );
    process.exit(1);
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DOOM_TMP      = path.join(TMP_ROOT, 'doom');
const CONTROL_JSON  = path.join(DOOM_TMP, 'control.json');
const DAEMON_PIDFILE = path.join(DOOM_TMP, 'daemon.pid');

// ── Shared atomic write helper (used by both modes) ──────────────────────────

function mkdirpSync_shared(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeReleaseState_shared() {
  try {
    mkdirpSync_shared(DOOM_TMP);
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ heartbeat: 0, held: [], taps: [], pid: process.pid }), 'utf8');
    fs.renameSync(tmp, CONTROL_JSON);
  } catch {
    // Best effort
  }
}

// ── stdin-bridge mode ─────────────────────────────────────────────────────────

if (STDIN_BRIDGE_MODE) {
  // Single startup line to stderr so the wrapper knows we're alive
  process.stderr.write('control.mjs[bridge]: started — reading from stdin\n');

  // The wrapper spawns us on a PTY (expect's spawn), which defaults to
  // CANONICAL mode — input would be line-buffered (keystrokes trapped until
  // a newline) and echoed back onto the user's screen. Raw mode fixes both.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try { process.stdin.setRawMode(true); } catch { /* pipe stdin — fine */ }
  }

  const bridgeHeld = new Set();
  const bridgeTaps = [];
  let bridgeTapSeq = 1;
  let bridgeLastInputMs = 0;
  let bridgeIdle = false; // true after we've written heartbeat:0 once

  function bridgeWriteState() {
    try {
      mkdirpSync_shared(DOOM_TMP);
      const state = buildControlState(Array.from(bridgeHeld), bridgeTaps, bridgeTapSeq);
      const tmp = CONTROL_JSON + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, CONTROL_JSON);
    } catch {
      // Non-fatal
    }
  }

  const bridgeTracker = new HeldKeyTracker(
    (keyName) => {
      const mapping = mapKeyEventToDoom(keyName);
      if (!mapping || !mapping.held) return;
      bridgeHeld.add(mapping.code);
      bridgeWriteState();
    },
    (keyName) => {
      const mapping = mapKeyEventToDoom(keyName);
      if (!mapping || !mapping.held) return;
      bridgeHeld.delete(mapping.code);
      bridgeWriteState();
    },
    160,
  );

  // ~15Hz heartbeat timer — keeps daemon in user mode while input is active
  const bridgeHeartbeat = setInterval(() => {
    const now = Date.now();
    bridgeTracker.sweep();

    if (now - bridgeLastInputMs > 2000) {
      // 2000ms silence — write heartbeat:0 once and become idle
      if (!bridgeIdle) {
        bridgeIdle = true;
        bridgeHeld.clear();
        bridgeTracker.releaseAll();
        writeReleaseState_shared();
      }
      // Do NOT keep writing — we're idle until input arrives
    } else {
      bridgeIdle = false;
      bridgeWriteState();
    }
  }, 66); // ~15Hz

  // Stdin data handler
  process.stdin.on('data', (buf) => {
    // Check for sentinel \x00\x01 — wrapper signaling drive-exit
    // Scan for sentinel anywhere in the buffer
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0x00 && buf[i + 1] === 0x01) {
        // Sentinel received: release immediately but STAY ALIVE — the wrapper
        // owns our lifetime and will route the next drive session to us.
        // (Exiting here killed the bridge after the first drive toggle, making
        // every later F8 forward keys to a corpse.)
        bridgeTracker.releaseAll();
        bridgeHeld.clear();
        bridgeTaps.length = 0;
        bridgeIdle = true;
        bridgeLastInputMs = 0;
        writeReleaseState_shared();
        return;
      }
    }

    // Normal input
    bridgeLastInputMs = Date.now();
    bridgeIdle = false;

    const keyNames = decodeKeys(buf);
    for (const keyName of keyNames) {
      // Skip quit keys — bridge doesn't quit on q/ctrl+c
      if (keyName === 'q' || keyName === '\x03') continue;

      const mapping = mapKeyEventToDoom(keyName);
      if (!mapping) continue;

      if (mapping.held) {
        bridgeTracker.see(keyName);
      } else {
        bridgeTaps.push({ seq: bridgeTapSeq++, code: mapping.code });
        if (bridgeTaps.length > 16) bridgeTaps.splice(0, bridgeTaps.length - 16);
        bridgeWriteState();
      }
    }
  });

  process.stdin.on('end', () => {
    // Stdin closed — release and exit
    clearInterval(bridgeHeartbeat);
    bridgeTracker.releaseAll();
    bridgeHeld.clear();
    writeReleaseState_shared();
    process.exit(0);
  });

  process.on('SIGINT',  () => { writeReleaseState_shared(); process.exit(0); });
  process.on('SIGTERM', () => { writeReleaseState_shared(); process.exit(0); });

  // Resume stdin as a raw binary stream — no encoding, no TTY needed
  process.stdin.resume();

  // Bridge mode ends here — the rest of this else-branch is interactive-mode-only
} else {
  // ── INTERACTIVE MODE ──────────────────────────────────────────────────────────
  //    (runs only when --stdin-bridge is NOT set)

// ── State ─────────────────────────────────────────────────────────────────────

// Set of DOOM key codes currently held by the user.
const heldCodes = new Set();

// Pending tap events not yet written to control.json.
// Each entry: { seq: number, code: number }
const pendingTaps = [];

// Monotonically increasing sequence counter for tap events.
let nextTapSeq = 1;

// ── Atomic write helper ───────────────────────────────────────────────────────

function mkdirpSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Atomically write the current control state to control.json.
 * Uses tmp+rename so readers never see a partial file.
 */
function writeControlState() {
  try {
    mkdirpSync(DOOM_TMP);
    const state = buildControlState(Array.from(heldCodes), pendingTaps, nextTapSeq);
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, CONTROL_JSON);
  } catch {
    // Non-fatal — the daemon will see a stale heartbeat and resume bot control
  }
}

/**
 * Write a zero-heartbeat sentinel so the daemon immediately releases user
 * ownership and re-arms the bot. This is called on clean exit only.
 */
function writeReleaseState() {
  try {
    mkdirpSync(DOOM_TMP);
    const tmp = CONTROL_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ heartbeat: 0, held: [], taps: [], pid: process.pid }), 'utf8');
    fs.renameSync(tmp, CONTROL_JSON);
  } catch {
    // Best effort — daemon will also recover via stale-heartbeat detection
  }
}

// ── Status line rendering ─────────────────────────────────────────────────────

// ANSI helpers
const RESET    = '\x1b[0m';
const BOLD     = '\x1b[1m';
const DIM      = '\x1b[2m';
const FG_GREEN = '\x1b[38;5;70m';
const FG_CYAN  = '\x1b[38;5;51m';
const FG_GRAY  = '\x1b[38;5;244m';
const FG_YLW   = '\x1b[38;5;220m';

/** Check if the daemon pid file is present (daemon running). */
function isDaemonRunning() {
  try {
    const raw = fs.readFileSync(DAEMON_PIDFILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // throws if no such process
    return true;
  } catch {
    return false;
  }
}

/** Build a compact human-readable list of currently held codes. */
function heldSummary() {
  if (heldCodes.size === 0) return '(none)';
  const names = {
    [0xad]: 'W↑', [0xaf]: 'S↓', [0xac]: 'A←', [0xae]: 'D→',
    [0xa3]: 'FIRE',
  };
  return Array.from(heldCodes)
    .map(c => names[c] ?? `0x${c.toString(16)}`)
    .join(' ');
}

/** Overwrite the current terminal line (no newline). */
function writeStatusLine() {
  const daemonUp = isDaemonRunning();
  const daemonText = daemonUp
    ? `${FG_GREEN}daemon running${RESET}`
    : `${FG_GRAY}daemon not detected${RESET}`;
  const heldText = heldCodes.size > 0
    ? `${FG_YLW}${heldSummary()}${RESET}`
    : `${FG_GRAY}(no keys)${RESET}`;
  const line = `\r${DIM}[afk-ctrl]${RESET} ${FG_CYAN}${BOLD}you're driving${RESET} · ${daemonText} · held: ${heldText}   `;
  process.stdout.write(line);
}

// ── Key event handling ────────────────────────────────────────────────────────

/** Held-key tracker for movement and fire keys. */
const tracker = new HeldKeyTracker(
  // onDown: key starts being held
  (keyName) => {
    const mapping = mapKeyEventToDoom(keyName);
    if (!mapping || !mapping.held) return;
    heldCodes.add(mapping.code);
    writeControlState();
    writeStatusLine();
  },
  // onUp: key released (auto-repeat expired)
  (keyName) => {
    const mapping = mapKeyEventToDoom(keyName);
    if (!mapping || !mapping.held) return;
    heldCodes.delete(mapping.code);
    writeControlState();
    writeStatusLine();
  },
  160, // expireMs — matches play.mjs
);

/**
 * Process a batch of decoded key names from a single stdin data event.
 * Held keys go through the tracker; tap keys are added to pendingTaps
 * and written immediately.
 */
function handleKeys(keyNames) {
  let stateChanged = false;

  for (const keyName of keyNames) {
    // Quit signal
    if (keyName === 'q' || keyName === '\x03') {
      cleanup();
      return;
    }

    const mapping = mapKeyEventToDoom(keyName);
    if (!mapping) continue;

    if (mapping.held) {
      // Feed into the held-key tracker (which calls onDown/onUp itself)
      tracker.see(keyName);
      stateChanged = true;
    } else {
      // Tap: add to pending list and write immediately
      pendingTaps.push({ seq: nextTapSeq++, code: mapping.code });
      // Keep pending taps bounded at 16 (daemon drains them quickly)
      if (pendingTaps.length > 16) pendingTaps.splice(0, pendingTaps.length - 16);
      stateChanged = true;
    }
  }

  if (stateChanged) {
    writeControlState();
    writeStatusLine();
  }
}

// ── Heartbeat timer (~15Hz) ───────────────────────────────────────────────────

// Write state at ~15Hz even if nothing changed, to keep the heartbeat fresh.
// Also call tracker.sweep() to release expired held keys.
const heartbeatTimer = setInterval(() => {
  tracker.sweep();
  writeControlState();
  writeStatusLine();
}, 66); // ~15Hz

// ── Cleanup ───────────────────────────────────────────────────────────────────

let cleaningUp = false;

function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;

  clearInterval(heartbeatTimer);

  // Release all held keys and flush tracker
  tracker.releaseAll();
  heldCodes.clear();

  // Restore terminal
  try {
    process.stdin.setRawMode(false);
  } catch { /* ignore — may already be restored */ }

  process.stdin.pause();

  // Write zero-heartbeat so daemon resumes bot immediately
  writeReleaseState();

  // Move to a new line so the terminal prompt appears cleanly
  process.stdout.write('\r\n');
  process.exit(0);
}

process.on('SIGINT',  cleanup);
process.on('SIGTERM', cleanup);

// ── Setup stdin raw mode ──────────────────────────────────────────────────────

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buf) => {
  const keyNames = decodeKeys(buf);
  handleKeys(keyNames);
});

// ── Initial display ───────────────────────────────────────────────────────────

// Print a small header (fixed, not overwritten by the status line)
process.stdout.write(
  `${BOLD}claude-mon controller${RESET} — you take the wheel while Claude thinks.\n` +
  `  ${FG_CYAN}WASD/arrows${RESET} move · ${FG_CYAN}SPACE${RESET} use · ${FG_CYAN}F/X${RESET} fire · ` +
  `${FG_CYAN}1-7${RESET} weapons · ${FG_CYAN}ESC${RESET} menu · ${FG_CYAN}Q/^C${RESET} quit\n`,
);

// Write initial status
writeControlState();
writeStatusLine();

} // end if (!STDIN_BRIDGE_MODE)
