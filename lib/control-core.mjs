/**
 * control-core.mjs — Pure helpers for the user controller sidecar.
 *
 * This module is intentionally free of I/O, TTY access, and side effects so
 * it can be unit-tested without a real terminal.
 *
 * Exports:
 *   mapKeyEventToDoom(keyName)          — translate a decoded key name to a
 *                                         DOOM key code (or null for no-op keys).
 *   buildControlState(held, taps, seq)  — serialize the current input state for
 *                                         TMP_ROOT/doom/control.json.
 *   controlOwner(state, nowMs)          — decide who drives the game: 'user' | 'bot'.
 *
 * Key names are the same strings emitted by lib/keys.mjs decodeKeys():
 *   'w'|'up'  → KEY_UPARROW   0xad   (held)
 *   's'|'down'→ KEY_DOWNARROW 0xaf   (held)
 *   'a'|'left'→ KEY_LEFTARROW 0xac   (held)
 *   'd'|'right'→KEY_RIGHTARROW 0xae  (held)
 *   ' '        → KEY_USE      0xa2   (tap — door-open / interact)
 *   'f'|'x'    → KEY_FIRE     0xa3   (held — fire weapon)
 *   '1'..'7'   → ASCII codes  49..55 (tap — weapon slots)
 *   '\r'|'\n'  → ENTER        13     (tap)
 *   '\x1b'     → ESCAPE       27     (tap)
 *   'q'|'\x03' → quit (null — handled by control.mjs, not forwarded to engine)
 *
 * HELD keys: the user's physical hold is mirrored into the engine via down/up
 * pairs managed by the daemon's ownership loop.
 * TAP keys: discrete events forwarded as quick down+up pulses (~80ms).
 */

// ── Key code constants (from doomgeneric doomkeys.h) ─────────────────────────

export const KEY_UPARROW    = 0xad;
export const KEY_DOWNARROW  = 0xaf;
export const KEY_LEFTARROW  = 0xac;
export const KEY_RIGHTARROW = 0xae;
export const KEY_USE        = 0xa2;
export const KEY_FIRE       = 0xa3;
export const KEY_ESCAPE     = 27;
export const KEY_ENTER      = 13;

/**
 * How long a heartbeat can be absent before we consider the controller stale.
 * 1500ms: generous enough to survive a brief GC pause in the controller process
 * while still reacting promptly when the user closes the terminal tab.
 */
export const CONTROLLER_STALE_MS = 1500;

// ── mapKeyEventToDoom ─────────────────────────────────────────────────────────

/**
 * Map a decoded key name (from lib/keys.mjs decodeKeys) to a DOOM key code.
 *
 * Returns an object:
 *   { code: number, held: boolean }
 *     code  — DOOM key code to send to the engine
 *     held  — true  → should be tracked as a held key (down while pressed)
 *             false → should be sent as a tap (down + scheduled up ~80ms later)
 *
 * Returns null for keys that should not be forwarded to the engine
 * (quit signals 'q' / '\x03', unknown keys, etc.).
 *
 * @param {string} keyName  A decoded key name string from decodeKeys().
 * @returns {{ code: number, held: boolean } | null}
 */
export function mapKeyEventToDoom(keyName) {
  switch (keyName) {
    // ── Movement (held) ───────────────────────────────────────────────────────
    case 'w':
    case 'up':
      return { code: KEY_UPARROW, held: true };
    case 's':
    case 'down':
      return { code: KEY_DOWNARROW, held: true };
    case 'a':
    case 'left':
      return { code: KEY_LEFTARROW, held: true };
    case 'd':
    case 'right':
      return { code: KEY_RIGHTARROW, held: true };

    // ── USE / interact (tap — single activation per key-down) ─────────────────
    // Space is tapped, not held, so the player can strafe-run without holding
    // USE continuously (which would spam interactions every tick).
    case ' ':
      return { code: KEY_USE, held: false };

    // ── FIRE (held — weapon fires continuously while key is down) ─────────────
    case 'f':
    case 'x':
      return { code: KEY_FIRE, held: true };

    // ── Weapon slots (tap — discrete selection) ───────────────────────────────
    case '1': return { code: 49, held: false };
    case '2': return { code: 50, held: false };
    case '3': return { code: 51, held: false };
    case '4': return { code: 52, held: false };
    case '5': return { code: 53, held: false };
    case '6': return { code: 54, held: false };
    case '7': return { code: 55, held: false };

    // ── Menu keys (tap) ───────────────────────────────────────────────────────
    case '\r':
    case '\n':
      return { code: KEY_ENTER, held: false };
    case '\x1b':
      return { code: KEY_ESCAPE, held: false };

    // ── Quit / unknown — not forwarded ────────────────────────────────────────
    case 'q':
    case '\x03': // Ctrl+C
    default:
      return null;
  }
}

// ── buildControlState ─────────────────────────────────────────────────────────

/**
 * Build the JSON payload written to TMP_ROOT/doom/control.json.
 *
 * @param {number[]}         held   Sorted array of DOOM key codes currently held.
 * @param {{ seq: number, code: number }[]} taps   Recent tap events (last ≤8 kept).
 * @param {number}           seq    The sequence counter for the next tap event
 *                                  (monotonically increasing; receivers compare
 *                                   against lastProcessedSeq).
 * @returns {{ heartbeat: number, held: number[], taps: { seq: number, code: number }[], pid: number }}
 */
export function buildControlState(held, taps, seq) {
  // Keep only the last 8 tap events to bound the JSON size.
  const recentTaps = taps.length > 8 ? taps.slice(taps.length - 8) : taps;
  return {
    heartbeat: Date.now(),
    held:      [...held].sort((a, b) => a - b),
    taps:      recentTaps,
    pid:       process.pid,
  };
}

// ── controlOwner ─────────────────────────────────────────────────────────────

/**
 * Decide who currently owns the DOOM controls.
 *
 * USER owns when:
 *   - state is non-null AND
 *   - state.heartbeat > 0 AND
 *   - now - state.heartbeat < CONTROLLER_STALE_MS
 *
 * BOT owns in all other cases (stale heartbeat, heartbeat === 0, or null state).
 *
 * @param {{ heartbeat: number } | null} state  Parsed control.json, or null if absent.
 * @param {number}                       nowMs  Current timestamp (Date.now()).
 * @returns {'user' | 'bot'}
 */
export function controlOwner(state, nowMs) {
  if (
    state !== null &&
    state !== undefined &&
    typeof state.heartbeat === 'number' &&
    state.heartbeat > 0 &&
    nowMs - state.heartbeat < CONTROLLER_STALE_MS
  ) {
    return 'user';
  }
  return 'bot';
}
