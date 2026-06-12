/**
 * debug.mjs — lightweight JSONL debug logging for claude-mon.
 *
 * Usage:
 *   import { debugEnabled, dbgLog } from '../lib/debug.mjs';
 *
 *   const enabled = debugEnabled(config);
 *   if (enabled) dbgLog('statusline', { mode, style, ... });
 *
 * When enabled, each call appends ONE JSON line to CONFIG_DIR/debug.log.
 * Rotation: if the file exceeds 500 KB the old file is renamed to debug.log.1
 * (overwriting any existing .1) before the new line is appended.
 *
 * The module never throws — all errors are swallowed so callers cannot crash.
 *
 * Enable via config:
 *   { "debug": true }  in ~/.claude/claude-mon/config.json
 *
 * Enable via environment (takes precedence):
 *   AFK_ARCADE_DEBUG=1
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './state.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────

export const DEBUG_LOG = path.join(CONFIG_DIR, 'debug.log');
const DEBUG_LOG_1 = path.join(CONFIG_DIR, 'debug.log.1');

/** Maximum file size before rotation. */
const ROTATE_BYTES = 500 * 1024; // 500 KB

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Returns true when debug logging is active.
 *
 * Active when ANY of the following hold:
 *   1. process.env.AFK_ARCADE_DEBUG === '1'
 *   2. config.debug === true  (config may be undefined)
 *
 * @param {object|undefined} config  Parsed plugin config object.
 * @returns {boolean}
 */
export function debugEnabled(config) {
  if (process.env.AFK_ARCADE_DEBUG === '1') return true;
  return config != null && config.debug === true;
}

/**
 * Append one JSON line to CONFIG_DIR/debug.log.
 *
 * The line format is:
 *   { "ts": "<ISO-8601>", "c": "<component>", ...fields }
 *
 * Rotation: when the log file exceeds 500 KB, it is renamed to debug.log.1
 * (overwriting any existing .1) before the new line is written.
 *
 * Never throws. Single appendFileSync call for atomicity per line.
 *
 * @param {string} component  Short source identifier, e.g. 'statusline', 'daemon'.
 * @param {object} fields     Additional fields to merge into the log line.
 */
export function dbgLog(component, fields) {
  try {
    // Build the log line first (cheap — keep I/O minimal on the hot path)
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      c: component,
      ...fields,
    }) + '\n';

    // Ensure the directory exists
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch {
      // Already exists or unrecoverable — let the write attempt surface the real error
    }

    // Rotate if file exceeds ROTATE_BYTES
    try {
      const stat = fs.statSync(DEBUG_LOG);
      if (stat.size > ROTATE_BYTES) {
        // Rename current log to .1 (overwrite any existing .1)
        fs.renameSync(DEBUG_LOG, DEBUG_LOG_1);
      }
    } catch {
      // File does not exist yet — nothing to rotate
    }

    // Append the line
    fs.appendFileSync(DEBUG_LOG, line, 'utf8');
  } catch {
    // Logging must never crash the caller
  }
}
