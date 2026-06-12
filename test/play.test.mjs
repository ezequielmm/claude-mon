/**
 * play.test.mjs — tests for play.mjs and lib/keys.mjs.
 *
 * Skips the selftest block cleanly when vendor/doom assets are absent.
 * Exports runPlayTests(counters, runner) for use by test/run.mjs.
 *
 * Tests:
 *   1. play.mjs --selftest exits 0 and prints "selftest ok"   [skipped without vendor assets]
 *   2. decodeKeys — CSI arrows, letters, Ctrl+C
 *   3. HeldKeyTracker — single down on repeat, up after expiry
 *   4. HeldKeyTracker tap — immediate release on next sweep
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeKeys, HeldKeyTracker } from '../lib/keys.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const PLAY_SCRIPT  = path.join(ROOT, 'scripts', 'play.mjs');
const VENDOR_DOOM  = path.join(ROOT, 'vendor', 'doom');

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

const DOOM_PRESENT = vendorPresent();

// ── Export runner ─────────────────────────────────────────────────────────────

/**
 * Run all play tests, appending results to the shared counters.
 *
 * The selftest (requires vendor/doom) is handled inline like doom.test.mjs does
 * so it can emit SKIP cleanly. Pure unit tests use runner.test().
 *
 * @param {{ passed: { value: number }, failed: { value: number } }} counters
 * @param {{ test: (name: string, fn: () => void) => void }} runner
 */
export async function runPlayTests(counters, runner) {
  process.stdout.write('\n── play tests ─────────────────────────────────────────\n');

  // ── Test 1: play.mjs --selftest (requires vendor assets) ──────────────────

  {
    const name = 'play.mjs --selftest exits 0 and prints "selftest ok"';
    const t0   = Date.now();
    if (!DOOM_PRESENT) {
      process.stdout.write(`PASS  ${name} (SKIPPED — vendor/doom absent)\n`);
      counters.passed.value++;
    } else {
      try {
        const result = spawnSync(
          process.execPath,
          ['--no-warnings', PLAY_SCRIPT, '--selftest'],
          {
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, COLORTERM: '' },
          },
        );

        if (result.signal === 'SIGTERM') {
          throw new Error('play.mjs --selftest timed out after 30s');
        }
        if (result.status !== 0) {
          throw new Error(
            `Expected exit 0, got ${result.status}. stderr: ${result.stderr.slice(0, 200)}`,
          );
        }
        if (!result.stdout.includes('selftest ok')) {
          throw new Error(
            `Expected "selftest ok" in stdout.\n  stdout: ${JSON.stringify(result.stdout.slice(0, 300))}`,
          );
        }
        if (!result.stdout.includes('▀')) {
          throw new Error('selftest output does not contain ▀');
        }
        if (!result.stdout.includes('\x1b[')) {
          throw new Error('selftest output does not contain ANSI escape codes');
        }

        const elapsed = Date.now() - t0;
        process.stdout.write(`PASS  ${name} (${elapsed}ms)\n`);
        counters.passed.value++;
      } catch (err) {
        const elapsed = Date.now() - t0;
        process.stdout.write(`FAIL  ${name} (${elapsed}ms)\n      ${err.message}\n`);
        counters.failed.value++;
      }
    }
  }

  // ── Tests 2–7: pure unit tests (always run) ──────────────────────────────

  runner.test('decodeKeys — CSI arrows decoded correctly', () => {
    const up    = decodeKeys(Buffer.from([0x1b, 0x5b, 0x41])); // ESC [ A
    const down  = decodeKeys(Buffer.from([0x1b, 0x5b, 0x42])); // ESC [ B
    const right = decodeKeys(Buffer.from([0x1b, 0x5b, 0x43])); // ESC [ C
    const left  = decodeKeys(Buffer.from([0x1b, 0x5b, 0x44])); // ESC [ D

    if (up[0]    !== 'up')    throw new Error(`expected 'up', got '${up[0]}'`);
    if (down[0]  !== 'down')  throw new Error(`expected 'down', got '${down[0]}'`);
    if (right[0] !== 'right') throw new Error(`expected 'right', got '${right[0]}'`);
    if (left[0]  !== 'left')  throw new Error(`expected 'left', got '${left[0]}'`);
  });

  runner.test('decodeKeys — letters normalized to lowercase', () => {
    // W A S D uppercase bytes → should decode as lowercase
    const keys = decodeKeys(Buffer.from([0x57, 0x41, 0x53, 0x44]));
    if (keys.join('') !== 'wasd') {
      throw new Error(`Expected 'wasd', got '${keys.join('')}'`);
    }
  });

  runner.test('decodeKeys — Ctrl+C → "\\x03"', () => {
    const keys = decodeKeys(Buffer.from([0x03]));
    if (keys[0] !== '\x03') {
      throw new Error(`Expected '\\x03', got ${JSON.stringify(keys[0])}`);
    }
  });

  runner.test('decodeKeys — lone ESC → "\\x1b"', () => {
    const keys = decodeKeys(Buffer.from([0x1b]));
    if (keys[0] !== '\x1b') {
      throw new Error(`Expected '\\x1b', got ${JSON.stringify(keys[0])}`);
    }
  });

  runner.test('decodeKeys — space, enter (CR), tab', () => {
    const keys = decodeKeys(Buffer.from([0x20, 13, 9]));
    if (keys[0] !== ' ')   throw new Error(`Expected ' ', got ${JSON.stringify(keys[0])}`);
    if (keys[1] !== '\r')  throw new Error(`Expected '\\r', got ${JSON.stringify(keys[1])}`);
    if (keys[2] !== '\t')  throw new Error(`Expected '\\t', got ${JSON.stringify(keys[2])}`);
  });

  runner.test('HeldKeyTracker — single down on repeat, up after expiry', () => {
    const downs = [];
    const ups   = [];
    let fakeNow = 0;

    const tracker = new HeldKeyTracker(
      (k) => downs.push(k),
      (k) => ups.push(k),
      100,              // expireMs
      () => fakeNow,   // injected clock
    );

    // First see → down
    fakeNow = 0;
    tracker.see('w');
    if (downs.length !== 1 || downs[0] !== 'w') {
      throw new Error(`Expected 1 down for 'w' after first see, got ${JSON.stringify(downs)}`);
    }

    // Repeated see — no extra down
    fakeNow = 50;
    tracker.see('w');
    tracker.see('w');
    if (downs.length !== 1) {
      throw new Error(`Expected no extra down on repeat, got ${downs.length} downs`);
    }

    // Sweep at 50ms — not expired yet (expireMs=100)
    tracker.sweep();
    if (ups.length !== 0) {
      throw new Error(`Expected no up yet at 50ms, got ${ups.length}`);
    }

    // Advance past expiry — key was last seen at fakeNow=50, expires after 150
    fakeNow = 160;
    tracker.sweep();
    if (ups.length !== 1 || ups[0] !== 'w') {
      throw new Error(`Expected up for 'w' after expiry, got ${JSON.stringify(ups)}`);
    }
  });

  runner.test('HeldKeyTracker tap — emits down immediately, up on next sweep', () => {
    const downs = [];
    const ups   = [];
    let fakeNow = 0;

    const tracker = new HeldKeyTracker(
      (k) => downs.push(k),
      (k) => ups.push(k),
      5000,             // very long expiry so only tap releases it
      () => fakeNow,
    );

    tracker.tap('1');

    if (downs.length !== 1 || downs[0] !== '1') {
      throw new Error(`Expected down for '1' after tap, got ${JSON.stringify(downs)}`);
    }
    if (ups.length !== 0) {
      throw new Error(`Expected no up yet (before sweep), got ${JSON.stringify(ups)}`);
    }

    // Sweep — tap-release queue fires
    tracker.sweep();
    if (ups.length !== 1 || ups[0] !== '1') {
      throw new Error(`Expected up for '1' after sweep, got ${JSON.stringify(ups)}`);
    }

    // Key is no longer held — another sweep does nothing
    fakeNow = 100;
    tracker.sweep();
    if (ups.length !== 1) {
      throw new Error(`Expected no duplicate up, got ${ups.length} ups`);
    }
  });
}
