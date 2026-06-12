#!/usr/bin/env node
/**
 * test/run.mjs — integration tests for claude-mon.
 *
 * Run with: node test/run.mjs
 * No test framework — uses node:child_process and node:assert.
 * Prints PASS/FAIL per test. Exits non-zero if any test fails.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDoomTests } from './doom.test.mjs';
import { runPlayTests } from './play.test.mjs';
import { runRenderTests } from './render.test.mjs';
import { runDebugTests } from './debug.test.mjs';
import { runBotTests } from './bot.test.mjs';
import { runControlTests } from './control.test.mjs';
import { runWrapperTests } from './wrapper.test.mjs';
import { runScreenTests } from './screen.test.mjs';
import { runGbaTests } from './gba.test.mjs';

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOOK   = path.join(ROOT, 'scripts', 'hook.mjs');
const STATUS = path.join(ROOT, 'scripts', 'statusline.mjs');
const CTL    = path.join(ROOT, 'scripts', 'afk-ctl.mjs');

const SESSION_DIR = path.join(os.tmpdir(), 'claude-mon', 'sessions');
const FIRE_DIR    = path.join(os.tmpdir(), 'claude-mon', 'sessions');
const TEST_SESSION = 't1';

// ── User config protection ────────────────────────────────────────────────────
// Tests mutate the real user config through afk-ctl (off/on, game switches).
// Snapshot it now and restore on exit so test runs never clobber user choices.

const USER_CONFIG_PATH = path.join(os.homedir(), '.claude', 'claude-mon', 'config.json');
let userConfigSnapshot = null;
try { userConfigSnapshot = fs.readFileSync(USER_CONFIG_PATH, 'utf8'); } catch { /* no config yet */ }
process.on('exit', () => {
  try {
    if (userConfigSnapshot !== null) fs.writeFileSync(USER_CONFIG_PATH, userConfigSnapshot);
  } catch { /* best effort */ }
});

// Deterministic baseline for the base test phase: fire game at 5 rows.
// Safe because the snapshot above restores the user's real values on exit.
spawnSync(process.execPath, [CTL, 'game', 'fire'], { encoding: 'utf8' });
spawnSync(process.execPath, [CTL, 'rows', '5'], { encoding: 'utf8' });
spawnSync(process.execPath, [CTL, 'banner', 'on'], { encoding: 'utf8' });

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    // Async test: settle before reporting. Without this, a rejected promise
    // printed PASS and the final process.exit(0) outran the unhandled
    // rejection — every async test failure was a silent false positive.
    if (r && typeof r.then === 'function') {
      return r.then(
        () => {
          process.stdout.write(`PASS  ${name}\n`);
          passed++;
        },
        (err) => {
          process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
          failed++;
        },
      );
    }
    process.stdout.write(`PASS  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}

/**
 * Run a script synchronously with given stdin and env.
 * Returns { stdout, stderr, status, durationMs }.
 */
function runScript(scriptPath, { stdin = '', env = {} } = {}) {
  const t0 = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', scriptPath],
    {
      input: stdin,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        // Provide a HOME so lib/state.mjs can resolve CONFIG_DIR (read-only for tests)
      },
      timeout: 5000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    durationMs: Date.now() - t0,
    timedOut: result.signal === 'SIGTERM',
  };
}

/**
 * Read a session state file, return parsed object or null.
 */
function readSessionState(sessionId) {
  const file = path.join(SESSION_DIR, `${sessionId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Clean up test session files.
 */
function cleanupSession(sessionId) {
  const stateFile = path.join(SESSION_DIR, `${sessionId}.json`);
  const fireFile  = path.join(FIRE_DIR, `${sessionId}.fire`);
  for (const f of [stateFile, fireFile]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

// ── Sample payload ────────────────────────────────────────────────────────────

const SAMPLE_PAYLOAD = JSON.stringify({
  session_id: TEST_SESSION,
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp',
  model: { id: 'claude-opus-4-8', display_name: 'Opus' },
  context_window: { used_percentage: 8, remaining_percentage: 92, context_window_size: 200000 },
  cost: { total_cost_usd: 0.012, total_duration_ms: 45000 },
  vim: { mode: 'NORMAL' },
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// Test 1: hook UserPromptSubmit → state file with mode "working", no stdout
test('hook UserPromptSubmit → mode=working, no stdout', () => {
  const payload = JSON.stringify({ session_id: TEST_SESSION, hook_event_name: 'UserPromptSubmit' });
  const r = runScript(HOOK, { stdin: payload });

  assert(r.status === 0, `Expected exit 0, got ${r.status}`);
  assert(r.stdout === '', `Expected no stdout, got: ${JSON.stringify(r.stdout)}`);

  const state = readSessionState(TEST_SESSION);
  assert(state !== null, 'Session state file not found');
  assert(state.mode === 'working', `Expected mode=working, got ${state.mode}`);
});

// Test 2: hook Stop → idle; Notification idle_prompt → afk; Notification permission_prompt → attention
test('hook Stop → idle', () => {
  const payload = JSON.stringify({ session_id: TEST_SESSION, hook_event_name: 'Stop' });
  const r = runScript(HOOK, { stdin: payload });

  assert(r.status === 0, `Expected exit 0, got ${r.status}`);
  assert(r.stdout === '', `Expected no stdout, got: ${JSON.stringify(r.stdout)}`);

  const state = readSessionState(TEST_SESSION);
  assert(state !== null, 'Session state file not found');
  assert(state.mode === 'idle', `Expected mode=idle, got ${state.mode}`);
});

test('hook Notification idle_prompt → mode=afk', () => {
  const payload = JSON.stringify({
    session_id: TEST_SESSION,
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
  });
  const r = runScript(HOOK, { stdin: payload });

  assert(r.status === 0, `Expected exit 0, got ${r.status}`);
  assert(r.stdout === '', `Expected no stdout, got: ${JSON.stringify(r.stdout)}`);

  const state = readSessionState(TEST_SESSION);
  assert(state !== null, 'Session state file not found');
  assert(state.mode === 'afk', `Expected mode=afk, got ${state.mode}`);
});

test('hook Notification permission_prompt → attention=true', () => {
  const payload = JSON.stringify({
    session_id: TEST_SESSION,
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
  });
  const r = runScript(HOOK, { stdin: payload });

  assert(r.status === 0, `Expected exit 0, got ${r.status}`);
  assert(r.stdout === '', `Expected no stdout, got: ${JSON.stringify(r.stdout)}`);

  const state = readSessionState(TEST_SESSION);
  assert(state !== null, 'Session state file not found');
  assert(state.attention === true, `Expected attention=true, got ${state.attention}`);
});

// Test 3: statusline with valid payload → correct line count, ANSI chars, exits 0 in <500ms
test('statusline valid payload → correct output structure', () => {
  const config = readConfig_safe();
  const expectedRows = config.rows + 1; // 1 HUD + N fire rows

  const r = runScript(STATUS, {
    stdin: SAMPLE_PAYLOAD,
    env: { COLUMNS: '80', LINES: '30' },
  });

  assert(r.status === 0, `Expected exit 0, got ${r.status}`);
  assert(!r.timedOut, 'Script timed out');

  const lines = r.stdout.split('\n').filter(l => l.length > 0);
  assert(
    lines.length === expectedRows,
    `Expected ${expectedRows} lines, got ${lines.length}. stdout: ${JSON.stringify(r.stdout.slice(0, 200))}`,
  );

  // Must contain a block-element glyph (▀–▟ range covers half-block and all quadrant glyphs)
  assert(/[▀-▟]/.test(r.stdout), 'Output should contain a block-element glyph (▀–▟)');
  // Must contain an ANSI escape sequence
  assert(r.stdout.includes('\x1b['), 'Output should contain ANSI escape sequences');

  // Line lengths should be sane (not massively overlong)
  for (const line of lines) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert(stripped.length <= 82, `Line too long: ${stripped.length} chars`); // width+2 for safety
  }

  assert(r.durationMs < 500, `Script took ${r.durationMs}ms, expected <500ms`);
});

// Test 4: garbage stdin → exits 0 and prints something
test('statusline garbage stdin → exits 0 and prints something', () => {
  const r = runScript(STATUS, {
    stdin: 'not json !!!',
    env: { COLUMNS: '80', LINES: '30' },
  });

  assert(r.status === 0, `Expected exit 0, got ${r.status}`);
  assert(r.stdout.trim().length > 0, 'Expected some output even on garbage stdin');
});

// Test 5: fire persistence — two consecutive runs → .fire file exists, bytes differ
test('fire persistence — bytes advance between runs', () => {
  // Ensure t1 session state exists (working mode so fire is hot)
  const payload = JSON.stringify({ session_id: TEST_SESSION, hook_event_name: 'UserPromptSubmit' });
  runScript(HOOK, { stdin: payload });

  const fireFile = path.join(FIRE_DIR, `${TEST_SESSION}.fire`);
  try { fs.unlinkSync(fireFile); } catch { /* may not exist */ }

  runScript(STATUS, { stdin: SAMPLE_PAYLOAD, env: { COLUMNS: '80' } });
  assert(fs.existsSync(fireFile), '.fire file should exist after first run');

  const bytes1 = fs.readFileSync(fireFile);

  // Small delay to ensure mtime differs
  const wait = Date.now() + 50;
  while (Date.now() < wait) { /* spin */ }

  runScript(STATUS, { stdin: SAMPLE_PAYLOAD, env: { COLUMNS: '80' } });
  const bytes2 = fs.readFileSync(fireFile);

  // The heat bytes (after 4-byte header) should differ (fire advanced)
  const heat1 = bytes1.slice(4);
  const heat2 = bytes2.slice(4);
  let anyDiff = false;
  for (let i = 0; i < Math.min(heat1.length, heat2.length); i++) {
    if (heat1[i] !== heat2[i]) { anyDiff = true; break; }
  }
  assert(anyDiff, 'Fire heat bytes should differ between consecutive runs (animation advanced)');
});

// Test 6: COLORTERM unset → 256-color; COLORTERM=truecolor → 24-bit
test('COLORTERM unset → 256-colour codes ([38;5;)', () => {
  const env = { COLUMNS: '80' };
  delete env.COLORTERM;

  const r = runScript(STATUS, {
    stdin: SAMPLE_PAYLOAD,
    env: { ...env, COLORTERM: '' },
  });

  assert(r.status === 0, `Exit ${r.status}`);
  assert(r.stdout.includes('[38;5;'), `Expected 256-colour codes, got: ${r.stdout.slice(0, 200)}`);
});

test('COLORTERM=truecolor → 24-bit codes ([38;2;)', () => {
  const r = runScript(STATUS, {
    stdin: SAMPLE_PAYLOAD,
    env: { COLUMNS: '80', COLORTERM: 'truecolor' },
  });

  assert(r.status === 0, `Exit ${r.status}`);
  assert(r.stdout.includes('[38;2;'), `Expected 24-bit colour codes, got: ${r.stdout.slice(0, 200)}`);
});

// Test 7: config off → empty output; then on again → output
test('config off → empty output; on → output restored', () => {
  // Turn off
  const off = runScript(CTL, { stdin: '', env: {} });
  // Use args
  const offResult = spawnSync(
    process.execPath,
    ['--no-warnings', CTL, 'off'],
    { encoding: 'utf8', timeout: 3000 },
  );
  assert(offResult.status === 0, `afk-ctl off failed: ${offResult.stderr}`);

  const rOff = runScript(STATUS, {
    stdin: SAMPLE_PAYLOAD,
    env: { COLUMNS: '80' },
  });
  assert(rOff.status === 0, `Expected exit 0, got ${rOff.status}`);
  // When disabled, output should be empty (no lines with content)
  const linesOff = rOff.stdout.split('\n').filter(l => l.trim().length > 0);
  assert(linesOff.length === 0, `Expected empty output when disabled, got ${linesOff.length} lines`);

  // Turn back on
  const onResult = spawnSync(
    process.execPath,
    ['--no-warnings', CTL, 'on'],
    { encoding: 'utf8', timeout: 3000 },
  );
  assert(onResult.status === 0, `afk-ctl on failed: ${onResult.stderr}`);

  const rOn = runScript(STATUS, {
    stdin: SAMPLE_PAYLOAD,
    env: { COLUMNS: '80' },
  });
  assert(rOn.status === 0, `Expected exit 0, got ${rOn.status}`);
  const linesOn = rOn.stdout.split('\n').filter(l => l.trim().length > 0);
  assert(linesOn.length > 0, 'Expected output when re-enabled');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

cleanupSession(TEST_SESSION);

// ── Phase B: doom tests (async, skips cleanly if vendor assets absent) ────────

// Wrap counters as boxed objects so runDoomTests / runPlayTests can increment them
const counters = { passed: { value: passed }, failed: { value: failed } };
await runDoomTests(counters, { test });
passed = counters.passed.value;
failed = counters.failed.value;

// ── Phase C: play tests (async, selftest skips if vendor assets absent) ───────

const playCounters = { passed: { value: passed }, failed: { value: failed } };
await runPlayTests(playCounters, { test });
passed = playCounters.passed.value;
failed = playCounters.failed.value;

// ── Phase D: render / postfx unit tests ───────────────────────────────────────

const renderCounters = { passed: { value: passed }, failed: { value: failed } };
await runRenderTests(renderCounters, { test });
passed = renderCounters.passed.value;
failed = renderCounters.failed.value;

// ── Phase E: diagnostics / debug module tests ─────────────────────────────────

const debugCounters = { passed: { value: passed }, failed: { value: failed } };
await runDebugTests(debugCounters, { test });
passed = debugCounters.passed.value;
failed = debugCounters.failed.value;

// ── Phase F: bot + registry unit tests ───────────────────────────────────────

// Phases F-H count through test() directly (module-level passed/failed).
// Reassigning from a boxed pre-phase snapshot here wiped their results —
// the dummy boxes below only satisfy the runner signatures.

await runBotTests({ passed: { value: 0 }, failed: { value: 0 } }, { test });

// ── Phase G: control-core + bot handoff tests ─────────────────────────────────

await runControlTests({ passed: { value: 0 }, failed: { value: 0 } }, { test });

// ── Phase H: doomclaude wrapper + stdin-bridge tests ──────────────────────────

await runWrapperTests({ passed: { value: 0 }, failed: { value: 0 } }, { test });

// ── Phase I: universal compositor (doomscreen) tests ──────────────────────────

await runScreenTests({ passed: { value: 0 }, failed: { value: 0 } }, { test });

// ── Phase J: GBA engine adapter tests ─────────────────────────────────────────

await runGbaTests({ passed: { value: 0 }, failed: { value: 0 } }, { test });

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

// ── Helper (avoid circular import issues in tests) ────────────────────────────

function readConfig_safe() {
  try {
    const configPath = path.join(os.homedir(), '.claude', 'claude-mon', 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { rows: 5, game: 'fire', enabled: true };
  }
}
