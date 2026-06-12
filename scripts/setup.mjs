#!/usr/bin/env node
/**
 * setup.mjs — guided one-shot installer for claude-mon.
 *
 * Usage:
 *   node scripts/setup.mjs [--yes] [--no-iterm]
 *
 * Flags:
 *   --yes       Non-interactive: accept all prompts automatically.
 *   --no-iterm  Skip the iTerm2 install offer entirely.
 *
 * Steps:
 *   1. Node.js version check (>= 20)
 *   2. Plugin config + shim + statusline wiring
 *   3. DOOM vendor assets (downloads if missing)
 *   4. Graphics terminal detection
 *   5. macOS only: offer iTerm2 for pixel-perfect mode
 *   6. Final summary
 *
 * Exit codes:
 *   0 — all steps succeeded (or skipped gracefully)
 *   1 — a hard failure occurred
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import {
  ensurePluginConfig,
  ensureShim,
  ensureStatusline,
  ensureDoomAssets,
} from '../lib/setup-core.mjs';
import { detectGraphics } from '../lib/gfx-protocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Argument parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const NO_ITERM = args.includes('--no-iterm');
const IS_MAC = process.platform === 'darwin';

// ── Output helpers ─────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const DIM   = '\x1b[2m';

function ok(msg)   { process.stdout.write(`  ${GREEN}✓${RESET} ${msg}\n`); }
function pend(msg) { process.stdout.write(`  ${YELLOW}→${RESET} ${msg}\n`); }
function fail(msg) { process.stdout.write(`  ${RED}✗${RESET} ${msg}\n`); }
function info(msg) { process.stdout.write(`    ${DIM}${msg}${RESET}\n`); }
function header(msg) { process.stdout.write(`\n${BOLD}${msg}${RESET}\n`); }

// ── Step 1: Node.js version check ─────────────────────────────────────────────

let hardFailure = false;

header('claude-mon setup');
process.stdout.write(`\n`);

// Step 1
{
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 20) {
    ok(`Node.js ${process.version} (>= 20 required)`);
  } else {
    fail(`Node.js ${process.version} is too old — version >= 20 required`);
    info('Download: https://nodejs.org/');
    hardFailure = true;
  }
}

// ── Step 2: Plugin config + shim + statusline ─────────────────────────────────

// Resolve pluginRoot: prefer CLAUDE_PLUGIN_ROOT (when run via hook), else use __dirname parent
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? ROOT;

{
  const configResult = ensurePluginConfig();
  if (configResult.created) {
    ok('Plugin config created (doom mode, 10 rows)');
  } else {
    ok('Plugin config already present');
  }

  const shimResult = ensureShim(pluginRoot);
  if (shimResult.status === 'created') {
    ok('Statusline shim created at ~/.claude/claude-mon/statusline.sh');
  } else if (shimResult.status === 'refreshed') {
    ok('Statusline shim refreshed (plugin path updated)');
  } else if (shimResult.status === 'present') {
    ok('Statusline shim already present');
  } else {
    fail('Failed to write statusline shim');
    hardFailure = true;
  }

  const statuslineResult = ensureStatusline();
  if (statuslineResult.status === 'added') {
    ok('statusLine added to ~/.claude/settings.json (backup saved as settings.json.claude-mon-backup)');
  } else if (statuslineResult.status === 'present') {
    ok('statusLine already present in ~/.claude/settings.json — left untouched');
  } else {
    // unreadable
    fail('~/.claude/settings.json could not be parsed — add the snippet manually:');
    process.stdout.write(`\n`);
    process.stdout.write(`  ${CYAN}"statusLine": {\n`);
    process.stdout.write(`    "type": "command",\n`);
    process.stdout.write(`    "command": "/bin/bash ~/.claude/claude-mon/statusline.sh",\n`);
    process.stdout.write(`    "refreshInterval": 1,\n`);
    process.stdout.write(`    "padding": 0\n`);
    process.stdout.write(`  }${RESET}\n\n`);
  }
}

// ── Step 3: DOOM vendor assets ─────────────────────────────────────────────────

{
  const assetsResult = ensureDoomAssets(pluginRoot, { detached: false });
  if (assetsResult.status === 'present') {
    ok('DOOM assets already present (doom.js, doom.wasm, doom1.wad)');
  } else if (assetsResult.status === 'done') {
    ok('DOOM assets downloaded successfully');
  } else {
    fail('DOOM asset download failed');
    info('Retry manually: node scripts/fetch-doom.mjs');
    hardFailure = true;
  }
}

// ── Step 4: Graphics terminal detection ───────────────────────────────────────

{
  const protocol = detectGraphics(process.env);
  if (protocol === 'iterm2') {
    ok('Terminal graphics: iTerm2 / WezTerm (pixel-perfect mode available)');
  } else if (protocol === 'kitty') {
    ok('Terminal graphics: Kitty protocol (pixel-perfect mode available)');
  } else {
    pend('Terminal graphics: half-block mode (no pixel-perfect protocol detected)');
    info('Run inside iTerm2 or kitty + pass --gfx auto for pixel-perfect');
  }
}

// ── Step 5: macOS — offer iTerm2 ──────────────────────────────────────────────

if (IS_MAC && !NO_ITERM) {
  const itermInstalled = fs.existsSync('/Applications/iTerm.app');

  if (itermInstalled) {
    ok('iTerm2 is installed — pixel-perfect mode available');
  } else {
    pend('iTerm2 not found at /Applications/iTerm.app');
    info('iTerm2 is required for the pixel-perfect DOOM mode (1280×800 PNG frames)');

    const hasBrew = (() => {
      try {
        // Check common Homebrew locations first (faster than spawning)
        if (fs.existsSync('/opt/homebrew/bin/brew') || fs.existsSync('/usr/local/bin/brew')) return true;
        // Fallback: check PATH
        const result = spawnSync('which', ['brew'], { encoding: 'utf8' });
        return result.status === 0 && result.stdout.trim().length > 0;
      } catch {
        return false;
      }
    })();

    let shouldInstall = YES;

    if (!YES) {
      // Interactive: ask the user (TTY check)
      if (process.stdin.isTTY) {
        const answer = await new Promise((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(
            `  ${YELLOW}→${RESET} Install iTerm2 via Homebrew for pixel-perfect mode? [y/N] `,
            (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            },
          );
        });
        shouldInstall = answer === 'y' || answer === 'yes';
      } else {
        info('Non-interactive session — skipping iTerm2 install prompt (use --yes to auto-install)');
      }
    }

    if (shouldInstall) {
      if (hasBrew) {
        process.stdout.write(`  ${YELLOW}→${RESET} Running: brew install --cask iterm2\n`);
        const brewBin = fs.existsSync('/opt/homebrew/bin/brew')
          ? '/opt/homebrew/bin/brew'
          : 'brew';
        const result = spawnSync(brewBin, ['install', '--cask', 'iterm2'], {
          stdio: 'inherit',
        });
        if (result.status === 0) {
          ok('iTerm2 installed via Homebrew');
        } else {
          fail('Homebrew install failed — install manually:');
          info('brew install --cask iterm2');
          info('or download from https://iterm2.com');
        }
      } else {
        fail('Homebrew not found — install iTerm2 manually:');
        info('Install Homebrew first: https://brew.sh');
        info('Then run: brew install --cask iterm2');
        info('Or download directly: https://iterm2.com');
      }
    } else {
      pend('iTerm2 install skipped — half-block mode will be used');
      if (!YES) {
        info('To install later: brew install --cask iterm2');
        info('Or download from: https://iterm2.com');
      }
    }
  }
}

// ── Step 6: Final summary ──────────────────────────────────────────────────────

const playScript = path.join(pluginRoot, 'scripts', 'play.mjs');

process.stdout.write('\n');
if (hardFailure) {
  process.stdout.write(`${BOLD}${RED}Setup completed with errors — fix the issues above and re-run.${RESET}\n`);
} else {
  process.stdout.write(`${BOLD}${GREEN}Setup complete!${RESET} Restart Claude Code to activate the banner.\n`);
  process.stdout.write('\n');
  process.stdout.write(`  Banner modes:  fire (default) or DOOM attract demo\n`);
  process.stdout.write(`  Play DOOM:     Run in iTerm2:\n`);
  process.stdout.write(`    ${CYAN}node ${playScript} --gfx auto${RESET}\n`);
  process.stdout.write('\n');
  process.stdout.write(`  Configuration: /afk status | /afk on | /afk game doom | /afk rows <N>\n`);
}
process.stdout.write('\n');

process.exit(hardFailure ? 1 : 0);
