/**
 * registry.mjs — TTY registry helpers for daemon-side backdrop streaming.
 *
 * The daemon writes to a shared TMP_ROOT/tty-registry.json that maps session
 * IDs to their discovered tty path + terminal dimensions.  The statusline
 * upserts its own entry on every backdrop-ON render; the daemon reads the
 * registry on a ~1s cadence and streams frames to all registered ttys.
 *
 * Atomic read-modify-write (tmp+rename) prevents torn reads.  Corruption
 * (non-JSON) resets the registry to {}.  Entries older than REGISTRY_TTL_MS
 * are considered stale and should be pruned before streaming.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TMP_ROOT, mkdirp } from './state.mjs';

export const REGISTRY_FILE = path.join(TMP_ROOT, 'tty-registry.json');

/** Entries older than this are pruned (ms). */
export const REGISTRY_TTL_MS = 30_000;

/**
 * Read the current registry, tolerating missing file or JSON corruption.
 * @returns {Record<string, { ttyPath: string, cols: number, lines: number, updatedAt: number }>}
 */
export function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Upsert a session entry into the registry (atomic write).
 *
 * @param {string} sessionId
 * @param {{ ttyPath: string, cols: number, lines: number }} entry
 */
export function upsertTtyRegistry(sessionId, entry) {
  try {
    mkdirp(TMP_ROOT);
    const current = readRegistry();
    current[sessionId] = {
      ttyPath:   entry.ttyPath,
      cols:      entry.cols,
      lines:     entry.lines,
      updatedAt: Date.now(),
    };
    const tmp = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current), 'utf8');
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch {
    // Non-fatal — the daemon will just skip this tty until next upsert
  }
}

/**
 * Remove a session's entry from the registry (atomic write).
 *
 * @param {string} sessionId
 */
export function removeTtyEntry(sessionId) {
  try {
    const current = readRegistry();
    delete current[sessionId];
    const tmp = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current), 'utf8');
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch {
    // Non-fatal
  }
}

/**
 * Return a copy of the registry with entries older than REGISTRY_TTL_MS removed.
 *
 * @param {ReturnType<typeof readRegistry>} registry
 * @param {number} [nowMs]
 * @returns {ReturnType<typeof readRegistry>}
 */
export function pruneRegistry(registry, nowMs) {
  const now = nowMs ?? Date.now();
  const result = {};
  for (const [sid, entry] of Object.entries(registry)) {
    if (typeof entry.updatedAt === 'number' && now - entry.updatedAt < REGISTRY_TTL_MS) {
      result[sid] = entry;
    }
  }
  return result;
}
