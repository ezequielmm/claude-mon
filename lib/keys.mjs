/**
 * keys.mjs — terminal key decoding and held-key emulation for DOOM.
 *
 * Terminals deliver key events as byte sequences with auto-repeat on hold.
 * DOOM expects explicit key-down / key-up pairs. This module bridges the gap:
 *
 *   decodeKeys(buf)       — parse a raw stdin Buffer into normalized key names
 *   HeldKeyTracker        — tracks which keys are "held" (down), emits up events
 *                           for keys not seen for ~160ms
 *   tapKey(name, tracker) — helper for discrete (non-held) keys: down now,
 *                           up emitted on the next sweep
 *
 * Key names emitted by decodeKeys:
 *   'up', 'down', 'left', 'right'  — arrow keys
 *   ' '                            — space bar
 *   '\r'                           — enter (CR, byte 13)
 *   '\n'                           — enter (LF, byte 10)
 *   '\t'                           — tab (byte 9)
 *   '\x1b'                         — escape (alone, not followed by CSI)
 *   '\x03'                         — Ctrl+C
 *   'a'..'z', '0'..'9', etc.       — printable ASCII (lowercase)
 */

// ── Key decoder ───────────────────────────────────────────────────────────────

/**
 * Decode a raw stdin Buffer into an array of normalized key name strings.
 *
 * Handles:
 *   - CSI arrow sequences: \x1b[A/B/C/D → 'up'/'down'/'right'/'left'
 *   - Escape alone (byte 27 not followed by '[') → '\x1b'
 *   - Ctrl+C (byte 0x03) → '\x03'
 *   - Enter as CR (byte 13) → '\r'
 *   - Enter as LF (byte 10) → '\n'
 *   - Tab (byte 9) → '\t'
 *   - Printable ASCII (32..126) → lowercase character string
 *
 * @param {Buffer} buf  Raw bytes from stdin in raw mode.
 * @returns {string[]}  Array of decoded key names.
 */
export function decodeKeys(buf) {
  const keys = [];
  let i = 0;

  while (i < buf.length) {
    const byte = buf[i];

    if (byte === 0x1b) {
      // Escape or CSI sequence
      if (i + 1 < buf.length && buf[i + 1] === 0x5b) {
        // CSI: \x1b[...
        const code = buf[i + 2];
        if (code === 0x41) { keys.push('up');    i += 3; continue; }
        if (code === 0x42) { keys.push('down');  i += 3; continue; }
        if (code === 0x43) { keys.push('right'); i += 3; continue; }
        if (code === 0x44) { keys.push('left');  i += 3; continue; }
        // Unknown CSI — skip the introducer and the next byte
        i += (i + 2 < buf.length) ? 3 : 2;
      } else {
        // Lone escape
        keys.push('\x1b');
        i += 1;
      }
    } else if (byte === 0x03) {
      keys.push('\x03'); // Ctrl+C
      i += 1;
    } else if (byte === 13) {
      keys.push('\r'); // Enter (CR)
      i += 1;
    } else if (byte === 10) {
      keys.push('\n'); // Enter (LF)
      i += 1;
    } else if (byte === 9) {
      keys.push('\t'); // Tab
      i += 1;
    } else if (byte >= 32 && byte <= 126) {
      // Printable ASCII — normalize to lowercase
      keys.push(String.fromCharCode(byte).toLowerCase());
      i += 1;
    } else {
      // Unknown / control byte — skip
      i += 1;
    }
  }

  return keys;
}

// ── Held-key tracker ──────────────────────────────────────────────────────────

/**
 * HeldKeyTracker: translates terminal auto-repeat into DOOM-style press/release.
 *
 * Usage:
 *   const tracker = new HeldKeyTracker(onDown, onUp);
 *   // Each frame: feed seen keys, then call sweep()
 *   tracker.see('up');   // first time → emits down; repeated → refreshes timestamp
 *   tracker.sweep();     // emits up for keys not seen for > expireMs
 *
 * @param {(key: string) => void} onDown  Called once when a key is first seen.
 * @param {(key: string) => void} onUp    Called when a key expires (not seen for > expireMs).
 * @param {number} [expireMs=160]         Time after last sight before key-up is emitted.
 * @param {() => number} [nowFn]         Inject a custom clock for testing.
 */
export class HeldKeyTracker {
  /**
   * @param {(key: string) => void} onDown
   * @param {(key: string) => void} onUp
   * @param {number} [expireMs=160]
   * @param {() => number} [nowFn]
   */
  constructor(onDown, onUp, expireMs = 160, nowFn = () => Date.now()) {
    this._onDown   = onDown;
    this._onUp     = onUp;
    this._expireMs = expireMs;
    this._now      = nowFn;
    /** @type {Map<string, number>} key → last-seen timestamp */
    this._held = new Map();
    /** @type {Set<string>} keys queued for release on next sweep */
    this._tapRelease = new Set();
  }

  /**
   * Notify the tracker that `key` was seen in the current frame.
   * First sight emits onDown; subsequent sights refresh the timestamp.
   * @param {string} key
   */
  see(key) {
    if (!this._held.has(key)) {
      this._onDown(key);
    }
    this._held.set(key, this._now());
  }

  /**
   * Queue a key for tap-style release on the next sweep.
   * Call this for discrete keys (menu navigation, weapon switch, etc.) that
   * should produce a down-then-immediate-up without waiting for expiry.
   * @param {string} key
   */
  tap(key) {
    this.see(key);
    this._tapRelease.add(key);
  }

  /**
   * Emit up events for:
   *   - Keys in the tap-release queue (immediate release).
   *   - Keys not refreshed for more than expireMs.
   */
  sweep() {
    const now = this._now();

    // Flush tap-release queue first
    for (const key of this._tapRelease) {
      if (this._held.has(key)) {
        this._held.delete(key);
        this._onUp(key);
      }
    }
    this._tapRelease.clear();

    // Expire held keys
    for (const [key, lastSeen] of this._held) {
      if (now - lastSeen > this._expireMs) {
        this._held.delete(key);
        this._onUp(key);
      }
    }
  }

  /**
   * Release all currently held keys immediately (use on cleanup).
   */
  releaseAll() {
    for (const key of this._held.keys()) {
      this._onUp(key);
    }
    this._held.clear();
    this._tapRelease.clear();
  }
}
