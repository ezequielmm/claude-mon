#!/usr/bin/env node
/**
 * wrapper.test.mjs — unit tests for scripts/doomclaude.mjs and the
 * --stdin-bridge flag of scripts/control.mjs.
 *
 * Run standalone: node test/wrapper.test.mjs
 * Also wired into test/run.mjs as Phase H (runWrapperTests export).
 *
 * Tests:
 *   1. Bridge: 'w' held key → control.json held contains 0xad
 *   2. Bridge: key released (no bytes for >200ms) → held empty
 *   3. Bridge: tap 'space' → taps contains 0xa2
 *   4. Bridge: sentinel \\x00\\x01 → heartbeat===0 immediately
 *   5. Bridge: 2000ms silence → heartbeat===0 (auto-release)
 *   6. Bridge: bytes after silence → heartbeat > 0 (wakes up)
 *   7. Bridge: stdin close → heartbeat===0
 *   8. doomclaude: --selftest exits 0 (PTY mechanism available)
 *   9. doomclaude: AFK_ARCADE_DRIVE_KEY=f9 → no error on startup
 *  10. doomclaude: AFK_ARCADE_DRIVE_KEY=invalid → falls back to f8 (no crash)
 */

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONTROL_SCRIPT   = path.join(ROOT, 'scripts', 'control.mjs');
const DOOMCLAUDE_SCRIPT = path.join(ROOT, 'scripts', 'doomclaude.mjs');
const NODE             = process.execPath;

const DOOM_TMP     = path.join(os.tmpdir(), 'claude-mon', 'doom');
const CONTROL_JSON = path.join(DOOM_TMP, 'control.json');

// ── Shared test runner ────────────────────────────────────────────────────────

export async function runWrapperTests(counters, { test: testFn }) {
  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Read and parse control.json; returns null if missing/malformed. */
  function readControlJson() {
    try {
      return JSON.parse(fs.readFileSync(CONTROL_JSON, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Delete control.json before a test to start fresh. */
  function clearControlJson() {
    try { fs.unlinkSync(CONTROL_JSON); } catch { /* ignore */ }
  }

  /**
   * Spawn the bridge, write bytes, wait, then kill it.
   * Returns a promise that resolves to the final control.json content.
   *
   * @param {Buffer[]} writes       Array of buffers to write in sequence
   * @param {number[]} delays       Milliseconds to wait after each write (same length as writes)
   * @param {number}   finalWaitMs  Final wait before killing and reading
   */
  function runBridge(writes, delays, finalWaitMs) {
    return new Promise((resolve, reject) => {
      clearControlJson();

      const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let idx = 0;

      function doNext() {
        if (idx >= writes.length) {
          // All writes done — wait then read
          setTimeout(() => {
            proc.kill('SIGTERM');
            setTimeout(() => {
              resolve(readControlJson());
            }, 100);
          }, finalWaitMs);
          return;
        }
        const buf = writes[idx];
        const delay = delays[idx] ?? 0;
        idx++;
        proc.stdin.write(buf, () => {
          setTimeout(doNext, delay);
        });
      }

      proc.on('error', reject);
      proc.on('close', () => {
        // Process may have already exited (sentinel) — read the file
      });

      // Give the bridge a moment to start
      setTimeout(doNext, 250);
    });
  }

  // ── Test 1: 'w' held → held contains 0xad ────────────────────────────────

  await testFn('bridge: w held → held contains KEY_UPARROW (0xad)', async () => {
    clearControlJson();

    const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    await new Promise(r => setTimeout(r, 250)); // let bridge start

    // Send 'w' repeatedly to simulate auto-repeat (hold key)
    for (let i = 0; i < 6; i++) {
      await new Promise((res, rej) => proc.stdin.write(Buffer.from('w'), err => err ? rej(err) : res()));
      await new Promise(r => setTimeout(r, 60));
    }

    // Read control.json BEFORE killing (so heartbeat is still live)
    await new Promise(r => setTimeout(r, 100));
    const state = readControlJson();

    proc.kill('SIGTERM');

    if (!state) throw new Error('control.json not written');
    if (typeof state.heartbeat !== 'number' || state.heartbeat === 0) {
      throw new Error(`Expected live heartbeat, got ${state.heartbeat}`);
    }
    if (!Array.isArray(state.held)) throw new Error('held is not an array');
    if (!state.held.includes(0xad)) {
      throw new Error(`Expected 0xad in held, got ${JSON.stringify(state.held)}`);
    }
  });

  // ── Test 2: key released after silence → held empty ──────────────────────

  await testFn('bridge: key released after 300ms silence → held []', async () => {
    const wBuf = Buffer.from('w');
    // Send 'w' a few times, then wait 400ms (> 160ms expire threshold)
    const state = await runBridge([wBuf, wBuf], [60, 60], 400);

    if (!state) throw new Error('control.json not written');
    // held should be empty after 400ms silence (HeldKeyTracker expires at 160ms)
    if (!Array.isArray(state.held)) throw new Error('held is not an array');
    // After the sweep, held should be empty
    if (state.held.length !== 0) {
      // The sweep runs at ~66ms intervals so after 400ms it should have fired
      // However the test reads right after kill — let's allow it to still be held
      // only if heartbeat is still live (within 160ms of last key)
      // Actually after 400ms of silence, the HeldKeyTracker MUST have expired
      throw new Error(`Expected held=[], got ${JSON.stringify(state.held)}`);
    }
  });

  // ── Test 3: space tap → taps contains 0xa2 ────────────────────────────────

  await testFn('bridge: space tap → taps contains KEY_USE (0xa2)', async () => {
    clearControlJson();

    const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    await new Promise(r => setTimeout(r, 250)); // let bridge start

    // Send space
    await new Promise((res, rej) => proc.stdin.write(Buffer.from(' '), err => err ? rej(err) : res()));
    await new Promise(r => setTimeout(r, 150)); // let heartbeat fire

    const state = readControlJson();
    proc.kill('SIGTERM');

    if (!state) throw new Error('control.json not written');
    if (!Array.isArray(state.taps)) throw new Error('taps is not an array');
    const hasTap = state.taps.some(t => t.code === 0xa2);
    if (!hasTap) {
      throw new Error(`Expected tap code 0xa2, got ${JSON.stringify(state.taps)}`);
    }
  });

  // ── Test 4: sentinel \x00\x01 → heartbeat===0 ────────────────────────────

  await testFn('bridge: sentinel \\x00\\x01 → heartbeat===0 immediately', async () => {
    clearControlJson();

    const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    await new Promise(r => setTimeout(r, 250)); // let bridge start

    // First send 'w' to create a live heartbeat
    await new Promise((res, rej) => proc.stdin.write(Buffer.from('w'), err => err ? rej(err) : res()));
    await new Promise(r => setTimeout(r, 150));

    // Verify heartbeat is live
    const stateBefore = readControlJson();
    if (!stateBefore || stateBefore.heartbeat === 0) {
      proc.kill('SIGTERM');
      throw new Error(`Expected live heartbeat before sentinel, got ${stateBefore?.heartbeat}`);
    }

    // Send sentinel
    await new Promise((res, rej) =>
      proc.stdin.write(Buffer.from([0x00, 0x01]), err => err ? rej(err) : res()),
    );

    // Bridge exits on sentinel — wait for it
    await new Promise((res) => {
      proc.on('close', res);
      setTimeout(res, 500); // fallback timeout
    });

    const stateAfter = readControlJson();
    if (!stateAfter) throw new Error('control.json not found after sentinel');
    if (stateAfter.heartbeat !== 0) {
      throw new Error(`Expected heartbeat===0 after sentinel, got ${stateAfter.heartbeat}`);
    }
    if (!Array.isArray(stateAfter.held) || stateAfter.held.length !== 0) {
      throw new Error(`Expected held=[] after sentinel, got ${JSON.stringify(stateAfter.held)}`);
    }
  });

  // ── Test 5: 2000ms silence → heartbeat===0 ───────────────────────────────

  await testFn('bridge: 2000ms silence → heartbeat===0 (auto-release)', async () => {
    clearControlJson();

    const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    await new Promise(r => setTimeout(r, 250));

    // Send a key to establish live heartbeat
    await new Promise((res, rej) => proc.stdin.write(Buffer.from('w'), err => err ? rej(err) : res()));
    await new Promise(r => setTimeout(r, 150));

    const stateBefore = readControlJson();
    if (!stateBefore || stateBefore.heartbeat === 0) {
      proc.kill('SIGTERM');
      throw new Error(`Expected live heartbeat before silence, got ${stateBefore?.heartbeat}`);
    }

    // Wait 2200ms for auto-release (> 2000ms threshold)
    await new Promise(r => setTimeout(r, 2200));

    const stateAfter = readControlJson();
    proc.kill('SIGTERM');

    if (!stateAfter) throw new Error('control.json not found after silence');
    if (stateAfter.heartbeat !== 0) {
      throw new Error(`Expected heartbeat===0 after 2200ms silence, got ${stateAfter.heartbeat}`);
    }
  });

  // ── Test 6: bytes after silence → heartbeat live again ───────────────────

  await testFn('bridge: bytes after silence → heartbeat > 0 (wakes up)', async () => {
    clearControlJson();

    const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    await new Promise(r => setTimeout(r, 250));

    // Send key → silence 2200ms → send key again
    await new Promise((res, rej) => proc.stdin.write(Buffer.from('w'), err => err ? rej(err) : res()));
    await new Promise(r => setTimeout(r, 2200)); // become idle

    // Send another key to wake up
    await new Promise((res, rej) => proc.stdin.write(Buffer.from('d'), err => err ? rej(err) : res()));
    await new Promise(r => setTimeout(r, 200)); // let heartbeat write

    const stateAfter = readControlJson();
    proc.kill('SIGTERM');

    if (!stateAfter) throw new Error('control.json not found after wake');
    if (stateAfter.heartbeat === 0) {
      throw new Error(`Expected live heartbeat after wake, got ${stateAfter.heartbeat}`);
    }
  });

  // ── Test 7: stdin close → heartbeat===0 ──────────────────────────────────

  await testFn('bridge: stdin close → heartbeat===0', async () => {
    clearControlJson();

    const proc = spawn(NODE, ['--no-warnings', CONTROL_SCRIPT, '--stdin-bridge'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    await new Promise(r => setTimeout(r, 250));

    // Send a key to make heartbeat live
    await new Promise((res, rej) => proc.stdin.write(Buffer.from('s'), err => err ? rej(err) : res()));
    await new Promise(r => setTimeout(r, 150));

    // Close stdin
    proc.stdin.end();

    // Wait for bridge to exit
    await new Promise((res) => {
      proc.on('close', res);
      setTimeout(res, 500);
    });

    const state = readControlJson();
    if (!state) throw new Error('control.json not found after stdin close');
    if (state.heartbeat !== 0) {
      throw new Error(`Expected heartbeat===0 after stdin close, got ${state.heartbeat}`);
    }
  });

  // ── Test 8: doomclaude --selftest exits 0 ────────────────────────────────

  // The F8 wrapper drives /usr/bin/expect + /usr/bin/script — unix-only by
  // design (HANDOFF §5: it gets retired once the compositor absorbs input).
  // Skip wherever those binaries are absent: win32 AND bare CI runners
  // (GitHub's ubuntu image ships no expect — CI was red since 0.8.0).
  const WRAPPER_UNSUPPORTED = process.platform === 'win32' ||
    !fs.existsSync('/usr/bin/expect') || !fs.existsSync('/usr/bin/script');

  if (WRAPPER_UNSUPPORTED) {
    process.stdout.write(
      'SKIP  doomclaude selftests (3) — expect/script PTY tooling unavailable\n',
    );
    return;
  }

  await testFn('doomclaude: --selftest exits 0 (PTY mechanism works)', async () => {
    const result = spawnSync(NODE, ['--no-warnings', DOOMCLAUDE_SCRIPT, '--selftest'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env },
    });
    // Must exit 0
    if (result.status !== 0) {
      throw new Error(
        `doomclaude --selftest exited ${result.status}\n` +
        `stderr: ${(result.stderr ?? '').slice(0, 400)}\n` +
        `stdout: ${(result.stdout ?? '').slice(0, 400)}`,
      );
    }
    // Must print PASS (with or without size detail) in stderr
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    if (!combined.includes('PASS')) {
      throw new Error(
        `Expected "PASS" in selftest output, got:\n${combined.slice(0, 400)}`,
      );
    }
  });

  // ── Test 9: AFK_ARCADE_DRIVE_KEY=f9 → no startup error ──────────────────

  await testFn('doomclaude: AFK_ARCADE_DRIVE_KEY=f9 is accepted', async () => {
    // We can't run doomclaude normally (it would try to launch claude),
    // but --selftest validates the startup path including key resolution
    const result = spawnSync(NODE, ['--no-warnings', DOOMCLAUDE_SCRIPT, '--selftest'], {
      encoding: 'utf8',
      timeout: 25000,
      env: { ...process.env, AFK_ARCADE_DRIVE_KEY: 'f9' },
    });
    if (result.status !== 0) {
      throw new Error(
        `doomclaude f9 selftest exited ${result.status}\nstderr: ${result.stderr?.slice(0, 300)}`,
      );
    }
  });

  // ── Test 10: AFK_ARCADE_DRIVE_KEY=invalid → warning, falls back to f8 ────

  await testFn('doomclaude: invalid AFK_ARCADE_DRIVE_KEY falls back to f8 without crash', async () => {
    const result = spawnSync(NODE, ['--no-warnings', DOOMCLAUDE_SCRIPT, '--selftest'], {
      encoding: 'utf8',
      timeout: 25000,
      env: { ...process.env, AFK_ARCADE_DRIVE_KEY: 'invalid_key' },
    });
    if (result.status !== 0) {
      throw new Error(
        `doomclaude invalid-key selftest crashed: exit ${result.status}\nstderr: ${result.stderr?.slice(0, 300)}`,
      );
    }
    // Must warn about the invalid key
    const combined = (result.stdout ?? '') + (result.stderr ?? '');
    if (!combined.includes('unknown AFK_ARCADE_DRIVE_KEY') && !combined.includes('Defaulting to f8')) {
      throw new Error(
        `Expected warning about invalid key, got:\n${combined.slice(0, 300)}`,
      );
    }
  });
}

// ── Standalone runner ──────────────────────────────────────────────────────────

async function runStandalone() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      process.stdout.write(`PASS  ${name}\n`);
      passed++;
    } catch (err) {
      process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
      failed++;
    }
  }

  await runWrapperTests(null, { test });

  process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runStandalone().catch((err) => {
    process.stderr.write(`wrapper.test.mjs fatal: ${err.message}\n`);
    process.exit(1);
  });
}
