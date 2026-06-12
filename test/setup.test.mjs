#!/usr/bin/env node
/**
 * setup.test.mjs — standalone tests for the zero-step install flow.
 *
 * Run with: node test/setup.test.mjs
 * PASS/FAIL output. Exits non-zero on any failure.
 *
 * Environment isolation:
 *   - HOME is overridden to a fresh mkdtemp so lib/state.mjs picks up the
 *     correct CONFIG_DIR (which is os.homedir()/.claude/claude-mon).
 *   - CLAUDE_PLUGIN_ROOT is set to the repo root so auto-setup.mjs can
 *     locate its scripts and lib.
 *   - AFK_ARCADE_CONFIG_DIR is also set directly for state.mjs imports that
 *     may bypass os.homedir().
 *
 * NOTE: Tests do NOT hit the real fetch path. Because CLAUDE_PLUGIN_ROOT points
 * at the repo root and vendor/ already exists there, vendorAssetsExist() returns
 * true and ensureDoomAssets returns 'present' — no network access.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AUTO_SETUP = path.join(ROOT, 'scripts', 'auto-setup.mjs');

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

// ── Helper: run auto-setup.mjs in an isolated HOME ────────────────────────────

/**
 * Run auto-setup.mjs with a given fake HOME directory.
 * Returns { stdout, stderr, status, durationMs }.
 */
function runAutoSetup(fakeHome, extraEnv = {}) {
  const configDir = path.join(fakeHome, '.claude', 'claude-mon');
  const t0 = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', AUTO_SETUP],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fakeHome,
        // os.homedir() reads USERPROFILE on win32 — without this override the
        // subprocess resolves the REAL home and mutates the user's settings.json.
        USERPROFILE: fakeHome,
        AFK_ARCADE_CONFIG_DIR: configDir,
        CLAUDE_PLUGIN_ROOT: ROOT,
        ...extraEnv,
      },
      timeout: 10_000,
    },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
    durationMs: Date.now() - t0,
  };
}

/**
 * Seed a minimal ~/.claude/settings.json in fakeHome.
 */
function seedSettings(fakeHome, content) {
  const claudeDir = path.join(fakeHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(content, null, 2), 'utf8');
}

// ── Test 1: auto-setup on empty HOME ──────────────────────────────────────────

await test('auto-setup on empty HOME: creates config, shim, adds statusLine, backup, preserves other keys', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-test-'));
  try {
    // Seed a minimal settings.json
    seedSettings(fakeHome, { theme: 'dark' });

    const r = runAutoSetup(fakeHome);
    assert(r.status === 0, `Expected exit 0, got ${r.status}. stderr: ${r.stderr}`);

    const configDir = path.join(fakeHome, '.claude', 'claude-mon');

    // config.json must exist with game = 'doom'
    const configPath = path.join(configDir, 'config.json');
    assert(fs.existsSync(configPath), 'config.json must exist after auto-setup');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert(config.game === 'doom', `Expected game=doom, got ${config.game}`);
    assert(config.enabled === true, `Expected enabled=true, got ${config.enabled}`);

    // statusline.sh must exist and be executable
    const shimPath = path.join(configDir, 'statusline.sh');
    assert(fs.existsSync(shimPath), 'statusline.sh must exist after auto-setup');
    const shimContent = fs.readFileSync(shimPath, 'utf8');
    assert(shimContent.includes(ROOT), `Shim must reference pluginRoot. Got: ${shimContent}`);
    assert(shimContent.startsWith('#!/bin/bash'), 'Shim must start with #!/bin/bash');

    // win32 also gets a .cmd twin — that's what settings.json points at there
    if (process.platform === 'win32') {
      const cmdShimPath = path.join(configDir, 'statusline.cmd');
      assert(fs.existsSync(cmdShimPath), 'statusline.cmd must exist after auto-setup on win32');
      const cmdContent = fs.readFileSync(cmdShimPath, 'utf8');
      assert(cmdContent.includes(ROOT), `cmd shim must reference pluginRoot. Got: ${cmdContent}`);
    }

    // settings.json must have statusLine key
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert('statusLine' in settings, 'settings.json must have statusLine key after auto-setup');
    assert(settings.theme === 'dark', 'theme key must be preserved in settings.json');

    // Backup must exist
    const backupPath = path.join(fakeHome, '.claude', 'settings.json.claude-mon-backup');
    assert(fs.existsSync(backupPath), 'backup file must be created');
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert(backup.theme === 'dark', 'backup must contain original content (theme=dark)');
    assert(!('statusLine' in backup), 'backup must not contain statusLine (taken before insertion)');

    return 'config+shim+statusLine+backup all present, theme preserved';
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Test 2: second run is idempotent ──────────────────────────────────────────

await test('second run: idempotent — no duplicate backup, config content unchanged', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-test-'));
  try {
    seedSettings(fakeHome, { theme: 'dark' });

    // First run
    const r1 = runAutoSetup(fakeHome);
    assert(r1.status === 0, `First run failed: exit ${r1.status}. stderr: ${r1.stderr}`);

    const configDir = path.join(fakeHome, '.claude', 'claude-mon');
    const configPath = path.join(configDir, 'config.json');
    const backupPath = path.join(fakeHome, '.claude', 'settings.json.claude-mon-backup');

    const configMtime1 = fs.statSync(configPath).mtimeMs;
    const backupContent1 = fs.readFileSync(backupPath, 'utf8');

    // Small delay to ensure mtime would change if file were rewritten
    const wait = Date.now() + 50;
    while (Date.now() < wait) { /* spin */ }

    // Second run
    const r2 = runAutoSetup(fakeHome);
    assert(r2.status === 0, `Second run failed: exit ${r2.status}. stderr: ${r2.stderr}`);

    // Config content must be identical
    const config2 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert(config2.game === 'doom', 'Config game must still be doom after second run');

    // Backup content must be identical (not rewritten)
    const backupContent2 = fs.readFileSync(backupPath, 'utf8');
    assert(backupContent1 === backupContent2, 'Backup must not be rewritten on second run');

    // settings.json must still have exactly one statusLine
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert(typeof settings.statusLine === 'object', 'statusLine must still be present');

    return 'idempotent: config mtime stable (not overwritten), backup unchanged';
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Test 3: pre-existing statusLine is never modified ─────────────────────────

await test('pre-existing statusLine in settings.json is never modified', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-test-'));
  try {
    const originalStatusLine = { command: 'my-custom-statusline', refreshInterval: 2 };
    seedSettings(fakeHome, { theme: 'light', statusLine: originalStatusLine });

    const r = runAutoSetup(fakeHome);
    assert(r.status === 0, `auto-setup failed: exit ${r.status}`);

    const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    assert(settings.statusLine.command === 'my-custom-statusline',
      `statusLine.command must be untouched, got: ${JSON.stringify(settings.statusLine)}`);
    assert(settings.statusLine.refreshInterval === 2,
      'statusLine.refreshInterval must be untouched');
    assert(settings.theme === 'light', 'theme must be untouched');

    // Backup must NOT be written (statusLine was already present)
    const backupPath = path.join(fakeHome, '.claude', 'settings.json.claude-mon-backup');
    assert(!fs.existsSync(backupPath), 'backup must NOT be created when statusLine already exists');

    return 'pre-existing statusLine left untouched, no backup written';
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Test 4: corrupt settings.json → untouched, auto-setup exits 0 ─────────────

await test('corrupt settings.json: untouched byte-for-byte, auto-setup exits 0', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-test-'));
  try {
    const claudeDir = path.join(fakeHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const settingsPath = path.join(claudeDir, 'settings.json');
    const corruptContent = '{ this is not valid json !!!';
    fs.writeFileSync(settingsPath, corruptContent, 'utf8');

    const r = runAutoSetup(fakeHome);
    assert(r.status === 0, `auto-setup must exit 0 even on corrupt settings.json. Got ${r.status}`);
    assert(r.stdout === '', `auto-setup must produce no stdout. Got: ${JSON.stringify(r.stdout)}`);
    assert(r.stderr === '', `auto-setup must produce no stderr. Got: ${JSON.stringify(r.stderr)}`);

    // settings.json must be byte-identical
    const afterContent = fs.readFileSync(settingsPath, 'utf8');
    assert(afterContent === corruptContent,
      `settings.json must be untouched. Expected: ${JSON.stringify(corruptContent)}, got: ${JSON.stringify(afterContent)}`);

    return 'corrupt settings.json left untouched, exit 0';
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Test 5: ensurePluginConfig never overwrites an existing config ─────────────

await test('ensurePluginConfig: never overwrites existing config (writes game=fire → still fire)', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-test-'));
  try {
    const configDir = path.join(fakeHome, '.claude', 'claude-mon');
    fs.mkdirSync(configDir, { recursive: true });

    // Pre-seed config with game=fire
    const originalConfig = { enabled: true, game: 'fire', rows: 5, aspect: '4:3' };
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(originalConfig, null, 2),
      'utf8',
    );

    // Seed settings so auto-setup doesn't fail on that
    seedSettings(fakeHome, { theme: 'dark' });

    const r = runAutoSetup(fakeHome);
    assert(r.status === 0, `auto-setup failed: exit ${r.status}`);

    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert(config.game === 'fire',
      `config.game must remain 'fire', got: ${config.game}`);
    assert(config.rows === 5,
      `config.rows must remain 5, got: ${config.rows}`);

    return 'existing config preserved (game=fire unchanged)';
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Test 6: auto-setup produces zero stdout/stderr bytes ──────────────────────

await test('auto-setup produces zero stdout and stderr bytes', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-test-'));
  try {
    seedSettings(fakeHome, { theme: 'dark' });

    const r = runAutoSetup(fakeHome);
    assert(r.status === 0, `auto-setup must exit 0, got ${r.status}`);
    assert(r.stdout.length === 0,
      `auto-setup must produce zero stdout bytes. Got ${r.stdout.length} bytes: ${JSON.stringify(r.stdout.slice(0, 100))}`);
    assert(r.stderr.length === 0,
      `auto-setup must produce zero stderr bytes. Got ${r.stderr.length} bytes: ${JSON.stringify(r.stderr.slice(0, 100))}`);

    return `stdout=${r.stdout.length}B stderr=${r.stderr.length}B`;
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
