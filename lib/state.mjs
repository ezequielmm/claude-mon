/**
 * state.mjs — shared paths, config, and session state helpers
 *
 * Environment overrides (purpose: test isolation; also useful for parallel CI):
 *   AFK_ARCADE_CONFIG_DIR  — override the user config directory
 *                            (default: ~/.claude/claude-mon)
 *   AFK_ARCADE_TMPDIR      — override the runtime tmp root
 *                            (default: <os.tmpdir()>/claude-mon)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Paths ─────────────────────────────────────────────────────────────────────

export const CONFIG_DIR  = process.env.AFK_ARCADE_CONFIG_DIR
  ?? path.join(os.homedir(), '.claude', 'claude-mon');
export const CONFIG_PATH  = path.join(CONFIG_DIR, 'config.json');
export const RUNTIME_PATH = path.join(CONFIG_DIR, 'runtime.json');

/** Runtime tmp root — all transient files live under here. */
export const TMP_ROOT   = process.env.AFK_ARCADE_TMPDIR
  ?? path.join(os.tmpdir(), 'claude-mon');
export const SESSION_DIR = path.join(TMP_ROOT, 'sessions');

/**
 * Default configuration values.
 *
 * style: 'quad' | 'half' | 'pixel'
 *   quad  — adaptive 2×2 quadrant blocks (default; universal)
 *   half  — classic ▀ half-block rendering
 *   pixel — experimental kitty Unicode placeholder banner (requires Warp / kitty /
 *            WezTerm / Ghostty with kitty graphics + U=1 support; revert with
 *            `/afk style quad` or set AFK_ARCADE_NO_PIXEL=1 to hard-disable)
 */
export const CONFIG_DEFAULTS = {
  enabled: true,
  game: 'gba',
  rows: 5,
  aspect: '4:3',
  style: 'quad',
  // Backdrop mode: the darkened game frame becomes the whole terminal's
  // background via kitty z=-2 (requires kitty graphics; verified in Warp).
  backdrop: false,
  backdropDim: 0.4,
  // Daemon-side backdrop streaming: frames per second (clamped 5..35).
  backdropFps: 24,
  // Heuristic bot player: drives the engine while the banner is shown.
  bot: false,
};

// ── Low-level helpers ─────────────────────────────────────────────────────────

/**
 * Ensure a directory exists (mkdir -p style). Never throws.
 * @param {string} dir
 */
export function mkdirp(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — either already exists or unrecoverable (we'll fail later on write)
  }
}

/**
 * Read and parse a JSON file. Returns `fallback` on any error.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Atomically write `obj` as JSON to `file` (write to .tmp, then rename).
 * Creates parent directories as needed. Never throws.
 * @param {string} file
 * @param {unknown} obj
 */
export function writeJsonAtomic(file, obj) {
  try {
    mkdirp(path.dirname(file));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // silent — statusline/hook must never crash
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Read the plugin config, merging missing keys from defaults.
 * @returns {{ enabled: boolean, game: string, rows: number }}
 */
export function readConfig() {
  const stored = readJson(CONFIG_PATH, {});
  return { ...CONFIG_DEFAULTS, ...stored };
}

/**
 * Persist a partial config update (merges with current config).
 * @param {Partial<typeof CONFIG_DEFAULTS>} patch
 */
export function writeConfig(patch) {
  const current = readConfig();
  writeJsonAtomic(CONFIG_PATH, { ...current, ...patch });
}

/**
 * Ensure config.json exists with defaults (idempotent).
 */
export function ensureConfig() {
  try {
    fs.accessSync(CONFIG_PATH);
  } catch {
    mkdirp(CONFIG_DIR);
    writeJsonAtomic(CONFIG_PATH, CONFIG_DEFAULTS);
  }
}

// ── Session state ─────────────────────────────────────────────────────────────

/**
 * Path to a session's state file.
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionStatePath(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

/**
 * Write session state for a session.
 * @param {string} sessionId
 * @param {{ mode: string, attention: boolean, since?: number }} state
 */
export function writeSessionState(sessionId, state) {
  const file = sessionStatePath(sessionId);
  const now = Date.now();
  writeJsonAtomic(file, {
    mode: state.mode ?? 'idle',
    attention: state.attention ?? false,
    since: state.since ?? now,
    updatedAt: now,
  });
}

/**
 * Resolve session state for a given session ID.
 *
 * Resolution order:
 *   1. Exact file for `sessionId` (if it exists).
 *   2. Most recently updated session file younger than 10 minutes.
 *   3. Default: { mode: "idle", attention: false }.
 *
 * @param {string | undefined} sessionId
 * @returns {{ mode: string, attention: boolean, since: number, updatedAt: number }}
 */
export function resolveSessionState(sessionId) {
  const _default = { mode: 'idle', attention: false, since: Date.now(), updatedAt: Date.now() };

  // 1. Exact match
  if (sessionId) {
    const exact = readJson(sessionStatePath(sessionId), null);
    if (exact) return exact;
  }

  // 2. Most recently updated session file < 10 min old
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
    const cutoff = Date.now() - 10 * 60 * 1000;
    let best = null;
    let bestTime = 0;
    for (const f of files) {
      const data = readJson(path.join(SESSION_DIR, f), null);
      if (data && typeof data.updatedAt === 'number' && data.updatedAt > cutoff) {
        if (data.updatedAt > bestTime) {
          bestTime = data.updatedAt;
          best = data;
        }
      }
    }
    if (best) return best;
  } catch {
    // SESSION_DIR may not exist yet
  }

  return _default;
}
