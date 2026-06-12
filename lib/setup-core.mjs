/**
 * setup-core.mjs — shared, side-effect-free setup helpers.
 *
 * All functions:
 *   - Never throw (catch internally, return status objects)
 *   - Are idempotent — safe to call on every SessionStart
 *   - Log to CONFIG_DIR/setup.log only (never stdout/stderr)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { CONFIG_DIR, mkdirp, writeJsonAtomic } from './state.mjs';
import { vendorAssetsExist } from './doom-engine.mjs';

// ── Log helper ─────────────────────────────────────────────────────────────────

const LOG_PATH = path.join(CONFIG_DIR, 'setup.log');
const LOG_MAX_BYTES = 200 * 1024; // 200 KB

/**
 * Append a timestamped line to the setup log.
 * Rotates (truncates) the file if it exceeds LOG_MAX_BYTES.
 * Never throws.
 * @param {string} msg
 */
export function log(msg) {
  try {
    mkdirp(CONFIG_DIR);
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > LOG_MAX_BYTES) {
        fs.writeFileSync(LOG_PATH, line, 'utf8');
        return;
      }
    } catch {
      // File doesn't exist yet — that's fine, appendFileSync will create it
    }
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {
    // Logging must never crash the caller
  }
}

// ── ensurePluginConfig ─────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/**
 * Default config for a first-time DOOM install.
 * The "doom" game and 10 rows give users the full DOOM experience
 * immediately without any extra steps.
 */
const FIRST_INSTALL_DEFAULTS = {
  enabled: true,
  game: 'doom',
  rows: 10,
  aspect: '4:3',
};

/**
 * Ensure config.json exists. Creates it with DOOM-first defaults if missing.
 * Never touches an existing config.
 *
 * @returns {{ created: boolean, config: object }}
 */
export function ensurePluginConfig() {
  try {
    try {
      fs.accessSync(CONFIG_PATH);
      // Config exists — read and return it
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return { created: false, config: JSON.parse(raw) };
    } catch {
      // Doesn't exist — create it
    }

    mkdirp(CONFIG_DIR);
    writeJsonAtomic(CONFIG_PATH, FIRST_INSTALL_DEFAULTS);
    log('ensurePluginConfig: created config.json with doom defaults');
    return { created: true, config: { ...FIRST_INSTALL_DEFAULTS } };
  } catch (err) {
    log(`ensurePluginConfig error: ${err.message}`);
    return { created: false, config: { ...FIRST_INSTALL_DEFAULTS } };
  }
}

// ── ensureShim ─────────────────────────────────────────────────────────────────

const SHIM_PATH = path.join(CONFIG_DIR, 'statusline.sh');
// Windows can't exec a bash shim from settings.json — a .cmd twin is written
// alongside it and settings.json points there instead (see ensureStatusline).
const SHIM_CMD_PATH = path.join(CONFIG_DIR, 'statusline.cmd');

/**
 * Write (or refresh) the statusline shim(s) in CONFIG_DIR.
 *
 * Always writes statusline.sh (bash). On win32 additionally writes
 * statusline.cmd, which is what settings.json references on that platform.
 *
 * Writes/overwrites a shim only when:
 *   - The shim does not exist, OR
 *   - The shim content does not reference the current pluginRoot
 *     (e.g. after a plugin update that changes its install path).
 *
 * Mirrors the logic in hook.mjs without touching that file.
 *
 * @param {string} pluginRoot  Absolute path to the plugin directory.
 * @returns {{ status: 'created' | 'refreshed' | 'present' | 'error' }}
 */
export function ensureShim(pluginRoot) {
  try {
    const shims = [
      {
        file: SHIM_PATH,
        content: `#!/bin/bash\nexec "${process.execPath}" --no-warnings "${pluginRoot}/scripts/statusline.mjs"\n`,
      },
    ];
    if (process.platform === 'win32') {
      shims.push({
        file: SHIM_CMD_PATH,
        content: `@echo off\r\n"${process.execPath}" --no-warnings "${path.join(pluginRoot, 'scripts', 'statusline.mjs')}" %*\r\n`,
      });
    }

    let wrote = false;
    let existedBefore = false;
    for (const { file, content } of shims) {
      let needsWrite = false;
      try {
        const existing = fs.readFileSync(file, 'utf8');
        existedBefore = true;
        needsWrite = !existing.includes(pluginRoot);
      } catch {
        needsWrite = true; // File doesn't exist
      }
      if (!needsWrite) continue;

      mkdirp(CONFIG_DIR);
      fs.writeFileSync(file, content, 'utf8');
      fs.chmodSync(file, 0o755);
      wrote = true;
    }

    if (!wrote) {
      return { status: 'present' };
    }
    const status = existedBefore ? 'refreshed' : 'created';
    log(`ensureShim: ${status} (pluginRoot=${pluginRoot})`);
    return { status };
  } catch (err) {
    log(`ensureShim error: ${err.message}`);
    return { status: 'error' };
  }
}

// ── ensureStatusline ───────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_BACKUP_PATH = path.join(os.homedir(), '.claude', 'settings.json.claude-mon-backup');

// win32: cmd.exe can't run a bash shim and doesn't expand `~` — point at the
// .cmd twin with an absolute path (settings.json is per-machine anyway).
const STATUSLINE_ENTRY = {
  type: 'command',
  command: process.platform === 'win32'
    ? `"${path.join(os.homedir(), '.claude', 'claude-mon', 'statusline.cmd')}"`
    : `/bin/bash ~/.claude/claude-mon/statusline.sh`,
  refreshInterval: 1,
  padding: 0,
};

/**
 * Add the statusLine entry to ~/.claude/settings.json, if not already present.
 *
 * Rules:
 *   - If settings.json cannot be read/parsed → return { status: 'unreadable' }, touch nothing.
 *   - If "statusLine" key already exists (any value) → return { status: 'present' }, touch nothing.
 *   - Otherwise:
 *       1. Write a one-time backup to settings.json.claude-mon-backup (skip if backup exists).
 *       2. Add the statusLine key, preserving all other keys.
 *       3. Atomic write (tmp + rename).
 *       4. Return { status: 'added' }.
 *
 * @returns {{ status: 'added' | 'present' | 'unreadable' }}
 */
export function ensureStatusline() {
  try {
    let raw;
    try {
      raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    } catch {
      // File doesn't exist — create it fresh with just the statusLine key
      raw = '{}';
    }

    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      log('ensureStatusline: settings.json is not valid JSON — leaving untouched');
      return { status: 'unreadable' };
    }

    if ('statusLine' in settings) {
      return { status: 'present' };
    }

    // Write backup (once only)
    try {
      fs.accessSync(SETTINGS_BACKUP_PATH);
      // Backup already exists — skip
    } catch {
      try {
        fs.writeFileSync(SETTINGS_BACKUP_PATH, raw, 'utf8');
        log('ensureStatusline: wrote settings.json backup');
      } catch (err) {
        log(`ensureStatusline: backup write failed: ${err.message}`);
      }
    }

    // Add statusLine, preserving all other keys
    const updated = { ...settings, statusLine: STATUSLINE_ENTRY };
    const tmpPath = SETTINGS_PATH + '.claude-mon-setup.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmpPath, SETTINGS_PATH);

    log('ensureStatusline: added statusLine to settings.json');
    return { status: 'added' };
  } catch (err) {
    log(`ensureStatusline error: ${err.message}`);
    return { status: 'unreadable' };
  }
}

// ── ensureDoomAssets ───────────────────────────────────────────────────────────

const FETCH_LOCK_DIR = path.join(CONFIG_DIR, 'fetch.lock');
const FETCH_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Ensure DOOM vendor assets are present.
 *
 * If assets are valid → return { status: 'present' }.
 * If detached=true → spawn fetch-doom.mjs detached with a staleness-guarded lock,
 *                    stdout/stderr → CONFIG_DIR/setup.log → { status: 'fetching' }.
 * If detached=false → run fetch-doom.mjs with stdio:inherit (blocking) →
 *                     { status: 'done' | 'failed' }.
 *
 * @param {string} pluginRoot  Absolute path to the plugin directory.
 * @param {{ detached?: boolean }} [options]
 * @returns {{ status: 'present' | 'fetching' | 'done' | 'failed' }}
 */
export function ensureDoomAssets(pluginRoot, { detached = false } = {}) {
  try {
    if (vendorAssetsExist()) {
      return { status: 'present' };
    }

    const fetchScript = path.join(pluginRoot, 'scripts', 'fetch-doom.mjs');

    if (detached) {
      // Guard against concurrent fetch with a lock directory (atomic mkdir)
      try {
        fs.mkdirSync(FETCH_LOCK_DIR);
        // Lock acquired — we own this fetch
      } catch {
        // Lock exists — check staleness
        try {
          const stat = fs.statSync(FETCH_LOCK_DIR);
          if (Date.now() - stat.mtimeMs < FETCH_LOCK_STALE_MS) {
            log('ensureDoomAssets: fetch already in progress (lock held), skipping');
            return { status: 'fetching' };
          }
          // Lock is stale — remove it and try again
          fs.rmdirSync(FETCH_LOCK_DIR);
          fs.mkdirSync(FETCH_LOCK_DIR);
        } catch (err) {
          log(`ensureDoomAssets: lock handling error: ${err.message}`);
          return { status: 'fetching' };
        }
      }

      try {
        mkdirp(CONFIG_DIR);
        // Open setup.log for append; stdout and stderr of the child go here
        const logFd = fs.openSync(LOG_PATH, 'a');
        const child = spawn(process.execPath, ['--no-warnings', fetchScript], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
        child.on('exit', () => {
          // Clean up lock when fetch completes
          try { fs.rmdirSync(FETCH_LOCK_DIR); } catch { /* ignore */ }
        });
        child.unref();
        fs.closeSync(logFd);
        log('ensureDoomAssets: spawned fetch-doom.mjs detached');
        return { status: 'fetching' };
      } catch (err) {
        // Remove lock on spawn failure
        try { fs.rmdirSync(FETCH_LOCK_DIR); } catch { /* ignore */ }
        log(`ensureDoomAssets spawn error: ${err.message}`);
        return { status: 'failed' };
      }
    } else {
      // Synchronous (non-detached): run inline with inherited stdio
      const result = spawnSync(process.execPath, ['--no-warnings', fetchScript], {
        stdio: 'inherit',
      });
      const ok = result.status === 0;
      log(`ensureDoomAssets: fetch-doom exited ${result.status}`);
      return { status: ok ? 'done' : 'failed' };
    }
  } catch (err) {
    log(`ensureDoomAssets error: ${err.message}`);
    return { status: 'failed' };
  }
}
