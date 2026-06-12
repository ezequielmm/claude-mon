#!/usr/bin/env node
/**
 * debug.test.mjs — standalone tests for lib/debug.mjs and related instrumentation.
 *
 * Run standalone:  node test/debug.test.mjs
 * Also wired into: node test/run.mjs (via runDebugTests export)
 *
 * Tests:
 *   1. dbgLog writes a parseable JSON line with ts and c fields
 *   2. Rotation triggers when file > 500 KB (rename to debug.log.1, old .1 overwritten)
 *   3. statusline run with AFK_ARCADE_DEBUG=1 produces a log line with known out.kind
 *      and correct env.sz dimensions (headless — no DOOM assets required)
 *   4. debug off (no env, no config.debug) — no log file created in a fresh HOME
 *
 * Isolation: every test that touches the filesystem uses AFK_ARCADE_CONFIG_DIR
 * pointing at a fresh mkdtemp directory so the user's real debug.log is never touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATUSLINE = path.join(ROOT, 'scripts', 'statusline.mjs');

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    const elapsed = Date.now() - t0;
    const suffix = note ? ` — ${note}` : '';
    process.stdout.write(`PASS  ${name} (${elapsed}ms${suffix})\n`);
    passed++;
  } catch (err) {
    const elapsed = Date.now() - t0;
    process.stdout.write(`FAIL  ${name} (${elapsed}ms)\n      ${err.message}\n`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}

// ── Helper: isolated config dir ───────────────────────────────────────────────

function isolatedConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'afk-debug-test-'));
}

// ── Helper: run statusline with overrides ─────────────────────────────────────

function runStatusline(configDir, extraEnv = {}, stdin = '') {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', STATUSLINE],
    {
      input:    stdin,
      encoding: 'utf8',
      timeout:  5000,
      env: {
        ...process.env,
        AFK_ARCADE_CONFIG_DIR: configDir,
        AFK_ARCADE_TMPDIR:     path.join(configDir, 'tmp'),
        COLUMNS: '80',
        LINES:   '24',
        // Clear pixel-affecting vars so we land on fire/quad in CI
        AFK_ARCADE_NO_PIXEL: '1',
        TERM_PROGRAM: '',
        COLORTERM:    '',
        KITTY_WINDOW_ID: '',
        ...extraEnv,
      },
    },
  );
  return {
    stdout:    result.stdout ?? '',
    stderr:    result.stderr ?? '',
    status:    result.status ?? -1,
    timedOut:  result.signal === 'SIGTERM',
  };
}

// ── Test 1: dbgLog writes a parseable JSONL line ──────────────────────────────

await test('dbgLog writes parseable JSON line with ts and c fields', async () => {
  const configDir = isolatedConfigDir();
  try {
    // Dynamically import with the isolated CONFIG_DIR override
    // We need to trick state.mjs into using our configDir — use env override
    // so the module picks it up at import time.
    //
    // Because ESM caches modules by resolved URL (not env), we use a sub-process
    // to get a fresh state.mjs + debug.mjs with our env set.
    const script = `
      import { dbgLog } from '${pathToFileURL(path.join(ROOT, 'lib', 'debug.mjs')).href}';
      dbgLog('test-component', { hello: 'world', num: 42 });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input:    script,
      encoding: 'utf8',
      timeout:  5000,
      env: {
        ...process.env,
        AFK_ARCADE_CONFIG_DIR: configDir,
        AFK_ARCADE_DEBUG:      '1',
      },
    });

    assert(result.status === 0, `sub-process exited ${result.status}: ${result.stderr}`);

    const debugLog = path.join(configDir, 'debug.log');
    assert(fs.existsSync(debugLog), 'debug.log must exist after dbgLog call');

    const content = fs.readFileSync(debugLog, 'utf8').trim();
    assert(content.length > 0, 'debug.log must not be empty');

    // Must parse as JSON
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error(`debug.log line is not valid JSON: ${content.slice(0, 120)}`);
    }

    // Must have ts (ISO-8601) and c fields
    assert(typeof parsed.ts === 'string', `ts must be a string, got ${typeof parsed.ts}`);
    assert(/^\d{4}-\d{2}-\d{2}T/.test(parsed.ts), `ts must be ISO-8601, got ${parsed.ts}`);
    assert(parsed.c === 'test-component', `c must be 'test-component', got ${parsed.c}`);
    assert(parsed.hello === 'world', `hello field must be 'world', got ${parsed.hello}`);
    assert(parsed.num === 42, `num field must be 42, got ${parsed.num}`);

    return `line: ${content.slice(0, 60)}…`;
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ── Test 2: rotation triggers when file > 500 KB ─────────────────────────────

await test('rotation: file > 500 KB → renamed to debug.log.1, new line written to debug.log', async () => {
  const configDir = isolatedConfigDir();
  try {
    const debugLog  = path.join(configDir, 'debug.log');
    const debugLog1 = path.join(configDir, 'debug.log.1');

    // Pre-populate debug.log with > 500 KB of data
    const bigChunk = Buffer.alloc(501 * 1024, 'x');
    fs.writeFileSync(debugLog, bigChunk);

    assert(fs.statSync(debugLog).size > 500 * 1024, 'pre-condition: file must be > 500 KB');

    // Call dbgLog via sub-process
    const script = `
      import { dbgLog } from '${pathToFileURL(path.join(ROOT, 'lib', 'debug.mjs')).href}';
      dbgLog('rotation-test', { trigger: true });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input:    script,
      encoding: 'utf8',
      timeout:  5000,
      env: {
        ...process.env,
        AFK_ARCADE_CONFIG_DIR: configDir,
        AFK_ARCADE_DEBUG:      '1',
      },
    });

    assert(result.status === 0, `sub-process exited ${result.status}: ${result.stderr}`);

    // debug.log.1 must now exist (old file renamed)
    assert(fs.existsSync(debugLog1), 'debug.log.1 must exist after rotation');

    // debug.log must be a short new file containing only the new JSON line
    const newContent = fs.readFileSync(debugLog, 'utf8').trim();
    assert(newContent.length > 0, 'new debug.log must not be empty');
    assert(newContent.length < 10_000, `new debug.log should be small, got ${newContent.length} bytes`);

    // The new line must be parseable JSON with our fields
    let parsed;
    try { parsed = JSON.parse(newContent); } catch {
      throw new Error(`new debug.log is not valid JSON: ${newContent.slice(0, 100)}`);
    }
    assert(parsed.c === 'rotation-test', `c must be 'rotation-test', got ${parsed.c}`);
    assert(parsed.trigger === true, 'trigger field must be true');

    // The .1 file must contain the big chunk (the rotated content)
    const rotatedSize = fs.statSync(debugLog1).size;
    assert(rotatedSize > 500 * 1024, `debug.log.1 must contain the old big file, got ${rotatedSize} bytes`);

    return `rotated ${rotatedSize} bytes to .1; new log: ${newContent.length} bytes`;
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ── Test 3: statusline with AFK_ARCADE_DEBUG=1 produces a log line ────────────

await test('statusline AFK_ARCADE_DEBUG=1 → debug.log has statusline entry with known out.kind', async () => {
  const configDir = isolatedConfigDir();
  try {
    // Seed a minimal config (fire mode, no DOOM — so we get a fire/quad frame)
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ enabled: true, game: 'fire', rows: 3, style: 'quad' }),
      'utf8',
    );

    const stdin = JSON.stringify({
      session_id: 'dbg-test-1',
      model: { id: 'claude-test', display_name: 'Test' },
    });

    const r = runStatusline(configDir, { AFK_ARCADE_DEBUG: '1' }, stdin);

    assert(r.status === 0, `statusline must exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert(!r.timedOut, 'statusline must not time out');

    const debugLog = path.join(configDir, 'debug.log');
    assert(fs.existsSync(debugLog), 'debug.log must exist after statusline run with AFK_ARCADE_DEBUG=1');

    const lines = fs.readFileSync(debugLog, 'utf8').split('\n').filter(l => l.trim().length > 0);
    assert(lines.length >= 1, `Expected at least 1 log line, got ${lines.length}`);

    // Find the statusline entry
    let entry = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.c === 'statusline') { entry = obj; break; }
      } catch { /* skip malformed lines */ }
    }

    assert(entry !== null, `No statusline entry found in debug.log. Lines: ${lines.join(' | ')}`);

    // Verify required fields
    assert(typeof entry.ts === 'string', 'entry.ts must be a string');
    assert(entry.c === 'statusline', `entry.c must be 'statusline', got ${entry.c}`);
    assert(entry.out != null, 'entry.out must be present');

    const KNOWN_KINDS = ['pixel', 'quad', 'half', 'fire', 'doom-frame', 'empty'];
    assert(
      KNOWN_KINDS.includes(entry.out.kind),
      `entry.out.kind must be one of ${KNOWN_KINDS.join('|')}, got ${entry.out.kind}`,
    );

    // env.sz must reflect COLUMNS=80
    assert(entry.env != null, 'entry.env must be present');
    assert(
      typeof entry.env.sz === 'string' && entry.env.sz.startsWith('80x'),
      `entry.env.sz must start with '80x', got ${entry.env.sz}`,
    );

    // tMs must be a non-negative number
    assert(typeof entry.tMs === 'number' && entry.tMs >= 0, `entry.tMs must be >=0, got ${entry.tMs}`);

    return `out.kind=${entry.out.kind}, tMs=${entry.tMs}ms, env.sz=${entry.env.sz}`;
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ── Test 4: debug off → no debug.log created ─────────────────────────────────

await test('debug off (no env, no config.debug) → no debug.log created', async () => {
  const configDir = isolatedConfigDir();
  try {
    // Seed config WITHOUT debug:true
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ enabled: true, game: 'fire', rows: 3, style: 'quad' }),
      'utf8',
    );

    const stdin = JSON.stringify({
      session_id: 'dbg-test-off',
      model: { id: 'claude-test', display_name: 'Test' },
    });

    // Run WITHOUT AFK_ARCADE_DEBUG and with a clean env (strip it if present)
    const envWithoutDebug = { ...process.env };
    delete envWithoutDebug.AFK_ARCADE_DEBUG;

    const r = spawnSync(
      process.execPath,
      ['--no-warnings', STATUSLINE],
      {
        input:    stdin,
        encoding: 'utf8',
        timeout:  5000,
        env: {
          ...envWithoutDebug,
          AFK_ARCADE_CONFIG_DIR: configDir,
          AFK_ARCADE_TMPDIR:     path.join(configDir, 'tmp'),
          COLUMNS:               '80',
          LINES:                 '24',
          AFK_ARCADE_NO_PIXEL:   '1',
          TERM_PROGRAM:          '',
          COLORTERM:             '',
          KITTY_WINDOW_ID:       '',
          // Explicitly unset AFK_ARCADE_DEBUG
          AFK_ARCADE_DEBUG:      '',
        },
      },
    );

    assert(r.status === 0, `statusline must exit 0, got ${r.status}`);

    const debugLog = path.join(configDir, 'debug.log');
    assert(
      !fs.existsSync(debugLog),
      `debug.log must NOT exist when debug is off. Found it at: ${debugLog}`,
    );

    return 'no debug.log created — correct';
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ── Export for run.mjs ────────────────────────────────────────────────────────

/**
 * Run all debug tests, appending results to shared counters.
 *
 * @param {{ passed: { value: number }, failed: { value: number } }} counters
 * @param {{ test: Function }} _runner  (unused — we use local test() above)
 */
export async function runDebugTests(counters, _runner) {
  // Tests already ran above when this module was imported and executed.
  // Add our local totals to the shared counters.
  counters.passed.value += passed;
  counters.failed.value += failed;
}

// ── Standalone entry point ────────────────────────────────────────────────────

const isMainModule = process.argv[1]?.endsWith('debug.test.mjs');
if (isMainModule) {
  const total = passed + failed;
  process.stdout.write(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}
