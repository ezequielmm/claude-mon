/**
 * doom.test.mjs — Phase B integration tests.
 *
 * Skips cleanly (prints a SKIP notice per test) when vendor/doom assets
 * are absent so CI without fetched assets still passes.
 *
 * Tests:
 *   1. Engine boot — createDoom(), 120 ticks, 64×40 color sample > 50 distinct
 *   2. Daemon e2e  — spawn daemon.mjs, wait for frame.ans, assert aspect-correct
 *                    pillarbox layout (4:3 default: gameW≈27 for pxRows=20, leftPad centered)
 *   3. Statusline doom mode — config game=doom + fake frame.ans → frame content in output
 *   4. Daemon stretch mode — set aspect=stretch, assert full-width content (no pillarbox)
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VENDOR_DOOM  = path.join(ROOT, 'vendor', 'doom');
const DAEMON_SCRIPT = path.join(ROOT, 'scripts', 'daemon.mjs');
const STATUS_SCRIPT = path.join(ROOT, 'scripts', 'statusline.mjs');
const CTL_SCRIPT    = path.join(ROOT, 'scripts', 'afk-ctl.mjs');

// Portable daemon shutdown: write this file so the daemon polls and exits cleanly.
// On Windows, process.kill(pid,'SIGTERM') uses TerminateProcess and never fires the
// SIGTERM handler, leaving the pidfile behind. Writing the shutdown file is the
// cross-platform solution; we still send SIGTERM on non-Windows as a belt-and-suspenders.
const DAEMON_SHUTDOWN_FILE = path.join(os.tmpdir(), 'claude-mon', 'doom', 'daemon.shutdown');

/**
 * Request graceful daemon shutdown and wait for the pidfile to disappear.
 * @param {number} daemonPid
 * @returns {Promise<boolean>} true if pidfile disappeared within 5s
 */
async function shutdownDaemon(daemonPid) {
  const pidFile = path.join(os.tmpdir(), 'claude-mon', 'doom', 'daemon.pid');
  // Write shutdown sentinel — the daemon polls this file every tick (30ms) and exits cleanly.
  try { fs.writeFileSync(DAEMON_SHUTDOWN_FILE, String(daemonPid), 'utf8'); } catch { /* ignore */ }
  // On non-Windows: also send SIGTERM as belt-and-suspenders (fires the SIGTERM handler).
  // On Windows: do NOT send SIGTERM — process.kill uses TerminateProcess which is a hard
  // synchronous kill; it would kill the daemon before the next tick fires and reads the
  // shutdown file, leaving the pidfile behind.
  if (process.platform !== 'win32') {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* ignore */ }
  }
  return waitFor(() => {
    try { fs.statSync(pidFile); return false; } catch { return true; }
  }, 5000, 100);
}

// ── Skip guard ────────────────────────────────────────────────────────────────

function vendorPresent() {
  for (const f of ['doom.js', 'doom.wasm', 'doom1.wad']) {
    try {
      if (fs.statSync(path.join(VENDOR_DOOM, f)).size < 1000) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const SKIP = !vendorPresent();

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * @type {{ name: string, fn: () => Promise<void> | void }[]}
 */
const tests = [];

/**
 * Wait up to `maxMs` for `predicate()` to return true, polling every `intervalMs`.
 * @param {() => boolean} predicate
 * @param {number} maxMs
 * @param {number} [intervalMs=200]
 * @returns {Promise<boolean>}
 */
function waitFor(predicate, maxMs, intervalMs = 200) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      if (predicate()) {
        resolve(true);
      } else if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Test 1: Engine boot + color count
tests.push({
  name: 'doom engine boot — 120 ticks, >50 distinct colors in 64×40 sample',
  async fn() {
    if (SKIP) return 'SKIP';

    const { createDoom } = await import('../lib/doom-engine.mjs');

    const engine = await createDoom();
    if (!engine) throw new Error('createDoom() returned falsy');

    // Tick 120 times
    for (let i = 0; i < 120; i++) engine.tick();

    // Sample a 64×40 grid
    const seen = new Set();
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 64; x++) {
        const sx = Math.min(engine.width  - 1, Math.floor(x / 64 * engine.width));
        const sy = Math.min(engine.height - 1, Math.floor(y / 40 * engine.height));
        const [r, g, b] = engine.getPixel(sx, sy);
        seen.add((r << 16) | (g << 8) | b);
      }
    }

    engine.dispose();

    const distinctColors = seen.size;
    if (distinctColors <= 50) {
      throw new Error(`Expected >50 distinct colors, got ${distinctColors}`);
    }

    return `${distinctColors} distinct colors`;
  },
});

// Test 2: Daemon e2e — aspect-correct 4:3 pillarbox layout
tests.push({
  name: 'doom daemon e2e — spawns, writes frame.ans with pillarbox centering (4:3, cols=80, pxRows=20)',
  async fn() {
    if (SKIP) return 'SKIP';

    const doomDir    = path.join(os.tmpdir(), 'claude-mon', 'doom');
    const pidFile    = path.join(doomDir, 'daemon.pid');
    const frameFile  = path.join(doomDir, 'frame.ans');
    const viewportFile = path.join(doomDir, 'viewport.json');
    const configDir  = path.join(os.homedir(), '.claude', 'claude-mon');
    const configFile = path.join(configDir, 'config.json');

    // Clean state
    for (const f of [pidFile, frameFile, viewportFile]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    fs.mkdirSync(doomDir, { recursive: true });

    // Ensure config has aspect=4:3 (the default — write explicitly so it's definitive)
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      fs.writeFileSync(configFile, JSON.stringify({ ...existing, aspect: '4:3' }), 'utf8');
    } catch {
      // config may not exist — the daemon falls back to defaults (4:3)
    }

    // Write a viewport: cols=80, pxRows=20 → gameW = round(20 * 4/3) = 27
    const COLS = 80;
    const PX_ROWS = 20;
    const EXPECTED_GAME_W = Math.round(PX_ROWS * 4 / 3); // 27
    const EXPECTED_LEFT_PAD = Math.floor((COLS - EXPECTED_GAME_W) / 2); // 26

    fs.writeFileSync(viewportFile, JSON.stringify({ cols: COLS, pxRows: PX_ROWS, truecolor: true }), 'utf8');

    // Spawn daemon
    const child = spawn(process.execPath, ['--no-warnings', DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Poll up to 20s for a fresh frame.ans that contains a block-element glyph and ANSI escapes.
    // Accept any Unicode Block Elements (U+2580–U+259F) — quad mode produces all 16, half-block
    // mode produces only ▀.  The regex covers the entire range.
    const BLOCK_RE = /[▀-▟]/;
    const deadline = Date.now() + 20_000;
    const ok = await waitFor(() => {
      try {
        const stat = fs.statSync(frameFile);
        if (Date.now() - stat.mtimeMs > 5000) return false;
        const content = fs.readFileSync(frameFile, 'utf8');
        return BLOCK_RE.test(content) && content.includes('\x1b[');
      } catch {
        return false;
      }
    }, 20_000, 300);

    if (!ok) {
      try { fs.writeFileSync(DAEMON_SHUTDOWN_FILE, String(child.pid), 'utf8'); } catch { /* ignore */ }
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
      throw new Error(`frame.ans not written within 20s (deadline ${deadline})`);
    }

    // ── Layout assertions ──────────────────────────────────────────────────────
    const frameContent = fs.readFileSync(frameFile, 'utf8');
    const frameLines = frameContent.split('\n').filter(l => l.length > 0);

    // Strip ANSI escape sequences for layout measurement
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

    // Every line must start with leading spaces (pillarbox gutter)
    const firstLine = frameLines[0];
    const firstStripped = stripAnsi(firstLine);
    const leadingSpaces = firstStripped.length - firstStripped.trimStart().length;

    if (leadingSpaces < 1) {
      throw new Error(
        `Expected leading pillarbox spaces, got none. First stripped line: ${JSON.stringify(firstStripped.slice(0, 60))}`,
      );
    }

    // Leading pad must be within 8 of expected: the low-contrast collapse in
    // renderQuadrants turns near-uniform DARK edge cells into colored spaces,
    // which strip to plain spaces and inflate the measured pad on dark scenes.
    if (Math.abs(leadingSpaces - EXPECTED_LEFT_PAD) > 8) {
      throw new Error(
        `Expected leftPad≈${EXPECTED_LEFT_PAD} (±8), got ${leadingSpaces}. ` +
        `(cols=${COLS}, gameW=${EXPECTED_GAME_W})`,
      );
    }

    // Content per line ≈ EXPECTED_GAME_W columns (±8: edge cells may collapse
    // to colored spaces and get trimmed — see low-contrast collapse note above)
    for (const line of frameLines) {
      const stripped = stripAnsi(line);
      const trimmed  = stripped.trim();
      const glyphCount = [...trimmed].length;
      if (Math.abs(glyphCount - EXPECTED_GAME_W) > 8) {
        throw new Error(
          `Expected game content ≈${EXPECTED_GAME_W} cols (±8), got ${glyphCount}. ` +
          `Line: ${JSON.stringify(trimmed.slice(0, 40))}`,
        );
      }
    }

    // ── Shutdown + cleanup ─────────────────────────────────────────────────────
    let daemonPid = 0;
    try {
      daemonPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      throw new Error('daemon.pid not written');
    }

    if (isNaN(daemonPid) || daemonPid <= 0) {
      throw new Error('daemon.pid contains invalid value');
    }

    const pidGone = await shutdownDaemon(daemonPid);

    if (!pidGone) {
      throw new Error('daemon.pid still present after shutdown request');
    }

    return `frame.ans OK — gameW=${EXPECTED_GAME_W}, leftPad=${leadingSpaces}, pid ${daemonPid} cleaned up`;
  },
});

// Test 3: Statusline doom mode with fake frame
tests.push({
  name: 'statusline doom mode — reads fake frame.ans and includes it in output',
  fn() {
    if (SKIP) return 'SKIP';

    const doomDir    = path.join(os.tmpdir(), 'claude-mon', 'doom');
    const frameFile  = path.join(doomDir, 'frame.ans');

    fs.mkdirSync(doomDir, { recursive: true });

    // Write a recognisable fake frame (fresh mtime)
    const fakeFrame = '\x1b[38;2;255;0;0m▀\x1b[0m DOOM_TEST_FRAME';
    fs.writeFileSync(frameFile, fakeFrame, 'utf8');

    // Switch config to doom (will stay for this test, restored after)
    spawnSync(process.execPath, ['--no-warnings', CTL_SCRIPT, 'game', 'doom'], {
      encoding: 'utf8',
    });

    try {
      const payload = JSON.stringify({
        session_id: 'doom-test-session',
        model: { id: 'claude-test', display_name: 'Test' },
      });

      const r = spawnSync(process.execPath, ['--no-warnings', STATUS_SCRIPT], {
        input: payload,
        encoding: 'utf8',
        // AFK_ARCADE_NO_PIXEL: this test asserts the frame.ans text path —
        // never let ancestor-tty discovery route it into pixel placeholders.
        env: { ...process.env, COLUMNS: '80', COLORTERM: 'truecolor', AFK_ARCADE_NO_PIXEL: '1' },
        timeout: 5000,
      });

      if (r.status !== 0) throw new Error(`statusline exited ${r.status}: ${r.stderr}`);
      if (!r.stdout.includes('DOOM_TEST_FRAME')) {
        throw new Error(
          `Expected fake frame content in output.\nstdout: ${JSON.stringify(r.stdout.slice(0, 300))}`,
        );
      }
    } finally {
      // Restore config to fire
      spawnSync(process.execPath, ['--no-warnings', CTL_SCRIPT, 'game', 'fire'], {
        encoding: 'utf8',
      });
      // Clean up fake frame
      try { fs.unlinkSync(frameFile); } catch { /* ignore */ }
    }
  },
});

// Test 4: Daemon stretch mode — full-width, no pillarbox
tests.push({
  name: 'doom daemon stretch mode — full-width content, no pillarbox (aspect=stretch, cols=60, pxRows=10)',
  async fn() {
    if (SKIP) return 'SKIP';

    const doomDir    = path.join(os.tmpdir(), 'claude-mon', 'doom');
    const pidFile    = path.join(doomDir, 'daemon.pid');
    const frameFile  = path.join(doomDir, 'frame.ans');
    const viewportFile = path.join(doomDir, 'viewport.json');
    const configDir  = path.join(os.homedir(), '.claude', 'claude-mon');
    const configFile = path.join(configDir, 'config.json');

    // Clean state
    for (const f of [pidFile, frameFile, viewportFile]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    fs.mkdirSync(doomDir, { recursive: true });

    // Set aspect=stretch in config
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      fs.writeFileSync(configFile, JSON.stringify({ ...existing, aspect: 'stretch' }), 'utf8');
    } catch {
      // Config may not exist yet — write a fresh one
      try {
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify({ enabled: true, game: 'doom', rows: 5, aspect: 'stretch' }), 'utf8');
      } catch { /* non-fatal */ }
    }

    const COLS = 60;
    const PX_ROWS = 10;

    fs.writeFileSync(viewportFile, JSON.stringify({ cols: COLS, pxRows: PX_ROWS, truecolor: true }), 'utf8');

    // Spawn daemon
    const child = spawn(process.execPath, ['--no-warnings', DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Poll up to 20s for frame.ans — accept any block-element glyph (quad or half-block mode)
    const BLOCK_RE_STRETCH = /[▀-▟]/;
    const deadline = Date.now() + 20_000;
    const ok = await waitFor(() => {
      try {
        const stat = fs.statSync(frameFile);
        if (Date.now() - stat.mtimeMs > 5000) return false;
        const content = fs.readFileSync(frameFile, 'utf8');
        return BLOCK_RE_STRETCH.test(content) && content.includes('\x1b[');
      } catch {
        return false;
      }
    }, 20_000, 300);

    if (!ok) {
      try { fs.writeFileSync(DAEMON_SHUTDOWN_FILE, String(child.pid), 'utf8'); } catch { /* ignore */ }
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ }
      throw new Error(`frame.ans not written within 20s (deadline ${deadline})`);
    }

    // ── Layout assertions: stretch = full width, gameW == cols ─────────────────
    const frameContent = fs.readFileSync(frameFile, 'utf8');
    const frameLines = frameContent.split('\n').filter(l => l.length > 0);

    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

    for (const line of frameLines) {
      const stripped = stripAnsi(line);
      const trimmed  = stripped.trim();
      const glyphCount = [...trimmed].length;
      // Stretch: content fills the full COLS width (±8 — edge cells may
      // collapse to colored spaces under the low-contrast rule and get trimmed)
      if (Math.abs(glyphCount - COLS) > 8) {
        throw new Error(
          `Stretch mode: expected content ≈${COLS} cols (±8), got ${glyphCount}. ` +
          `Line: ${JSON.stringify(trimmed.slice(0, 40))}`,
        );
      }
      // No pillarbox in stretch mode — but a few leading cells may collapse to
      // colored spaces under the low-contrast rule, so allow a small margin.
      const leadingSpaces = stripped.length - stripped.trimStart().length;
      if (leadingSpaces > 8) {
        throw new Error(
          `Stretch mode: expected ≤8 leading spaces (low-contrast collapse), got ${leadingSpaces}. ` +
          `Line: ${JSON.stringify(stripped.slice(0, 40))}`,
        );
      }
    }

    // ── Shutdown + cleanup ─────────────────────────────────────────────────────
    let daemonPid = 0;
    try {
      daemonPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      throw new Error('daemon.pid not written');
    }

    const pidGone = await shutdownDaemon(daemonPid);

    if (!pidGone) {
      throw new Error('daemon.pid still present after shutdown request');
    }

    // Restore aspect to 4:3 so other tests run with the default
    try {
      const existing = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      fs.writeFileSync(configFile, JSON.stringify({ ...existing, aspect: '4:3' }), 'utf8');
    } catch { /* non-fatal */ }

    return `stretch OK — cols=${COLS}, no pillarbox, pid ${daemonPid} cleaned up`;
  },
});

// ── Export runner ─────────────────────────────────────────────────────────────

/**
 * Run all doom tests, appending results to the shared counters.
 *
 * @param {{ passed: { value: number }, failed: { value: number } }} counters
 * @param {{ test: (name: string, fn: () => void) => void }} runner
 */
export async function runDoomTests(counters, runner) {
  if (SKIP) {
    process.stdout.write(
      '\nSKIP  [doom] vendor/doom assets absent — run: node scripts/fetch-doom.mjs\n',
    );
    return;
  }

  process.stdout.write('\n── doom tests ─────────────────────────────────────────\n');

  // The daemon singleton is global: a live daemon from a real session would make
  // the test daemons yield and the e2e tests fail. Shut it down gracefully and
  // clear its files — any live statusline respawns it within seconds.
  const doomTmpDir = path.join(os.tmpdir(), 'claude-mon', 'doom');
  const existingPidFile = path.join(doomTmpDir, 'daemon.pid');
  try {
    const existingPid = parseInt(fs.readFileSync(existingPidFile, 'utf8').trim(), 10);
    if (existingPid > 0) {
      await shutdownDaemon(existingPid);
    }
  } catch { /* no live daemon */ }
  // On non-Windows, also try pkill as a belt-and-suspenders fallback
  if (process.platform !== 'win32') {
    spawnSync('pkill', ['-f', path.join(ROOT, 'scripts', 'daemon.mjs')]);
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const f of ['daemon.pid', 'daemon.sock', 'spawn.lock', 'daemon.shutdown']) {
    try { fs.rmSync(path.join(doomTmpDir, f), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  for (const t of tests) {
    const t0 = Date.now();
    try {
      const note = await t.fn();
      const elapsed = Date.now() - t0;
      const suffix = note === 'SKIP' ? ' (SKIPPED)' : ` (${elapsed}ms${note ? ' — ' + note : ''})`;
      process.stdout.write(`PASS  ${t.name}${suffix}\n`);
      counters.passed.value++;
    } catch (err) {
      const elapsed = Date.now() - t0;
      process.stdout.write(`FAIL  ${t.name} (${elapsed}ms)\n      ${err.message}\n`);
      counters.failed.value++;
    }
  }
}
