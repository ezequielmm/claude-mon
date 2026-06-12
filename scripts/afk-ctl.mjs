#!/usr/bin/env node
/**
 * afk-ctl.mjs — config CLI for the claude-mon plugin.
 *
 * Usage:
 *   node afk-ctl.mjs status
 *   node afk-ctl.mjs on | off
 *   node afk-ctl.mjs game fire | game doom
 *   node afk-ctl.mjs rows <N>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readConfig,
  writeConfig,
  CONFIG_PATH,
  SESSION_DIR,
  readJson,
} from '../lib/state.mjs';
import { DEBUG_LOG } from '../lib/debug.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR_DOOM = path.join(ROOT, 'vendor', 'doom');

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function printConfig(cfg) {
  const backdropFps = cfg.backdropFps ?? 24;
  const bot = cfg.bot ?? false;
  process.stdout.write(
    `claude-mon: game=${cfg.game} rows=${cfg.rows} aspect=${cfg.aspect ?? '4:3'} style=${cfg.style ?? 'quad'} enabled=${cfg.enabled} backdropFps=${backdropFps} bot=${bot}\n`,
  );
}

function activeSessionSummary() {
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
    if (!files.length) {
      process.stdout.write('  (no active sessions)\n');
      return;
    }
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 min
    for (const f of files) {
      const data = readJson(path.join(SESSION_DIR, f), null);
      if (!data) continue;
      const sessionId = f.replace(/\.json$/, '');
      const fresh = data.updatedAt > cutoff;
      const age = Math.round((Date.now() - data.updatedAt) / 1000);
      const label = fresh ? `${data.mode}${data.attention ? ' ⚠ATTENTION' : ''}` : `(stale ${age}s)`;
      process.stdout.write(`  session ${sessionId}: ${label}\n`);
    }
  } catch {
    process.stdout.write('  (session dir not found)\n');
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

const cfg = readConfig();

switch (cmd) {
  case 'status': {
    process.stdout.write(`config: ${CONFIG_PATH}\n`);
    printConfig(cfg);
    process.stdout.write('sessions:\n');
    activeSessionSummary();
    break;
  }

  case 'on': {
    writeConfig({ enabled: true });
    printConfig({ ...cfg, enabled: true });
    break;
  }

  case 'off': {
    writeConfig({ enabled: false });
    printConfig({ ...cfg, enabled: false });
    break;
  }

  case 'game': {
    const game = args[1];
    if (!['fire', 'doom', 'gba'].includes(game)) {
      process.stdout.write(`claude-mon: unknown game "${game ?? ''}". Valid options: fire, doom, gba\n`);
      process.exit(1);
    }
    if (game === 'gba') {
      const cfgNow = readConfig();
      if (typeof cfgNow.gbaRom !== 'string' || !fs.existsSync(cfgNow.gbaRom)) {
        process.stdout.write(
          'claude-mon: no ROM configured. Point the plugin at YOUR legally-dumped\n' +
          'GBA file first:  /afk rom <absolute-path-to-your.gba>\n' +
          '(Game ROMs are never downloaded or bundled.)\n',
        );
        process.exit(1);
      }
      const vendorOk = fs.existsSync(path.join(ROOT, 'vendor', 'gba', 'gbajs', 'js', 'gba.js'));
      if (!vendorOk) {
        process.stdout.write('Fetching the GBA emulator (one-time)…\n');
        const r = spawnSync(process.execPath,
          ['--no-warnings', path.join(ROOT, 'scripts', 'fetch-gba.mjs')], { stdio: 'inherit' });
        if (r.status !== 0) process.exit(1);
      }
    }
    if (game === 'doom') {
      // Verify vendor assets exist before switching
      const vendorFiles = ['doom.js', 'doom.wasm', 'doom1.wad'];
      const missing = vendorFiles.filter((f) => {
        try { return fs.statSync(path.join(VENDOR_DOOM, f)).size < 1000; } catch { return true; }
      });
      if (missing.length > 0) {
        process.stdout.write(
          `claude-mon: DOOM vendor assets missing: ${missing.join(', ')}\n` +
          `  Run:  node ${path.join(ROOT, 'scripts', 'fetch-doom.mjs')}\n` +
          `  Or:   /afk fetch-doom\n`,
        );
        process.exit(1);
      }
    }
    writeConfig({ game });
    // The engine is chosen at daemon boot — recycle so the switch is live
    try {
      fs.writeFileSync(path.join(os.tmpdir(), 'claude-mon', 'doom', 'daemon.shutdown'), 'game-switch');
    } catch { /* daemon not running */ }
    printConfig({ ...cfg, game });
    break;
  }

  case 'fetch-doom': {
    const fetchScript = path.join(ROOT, 'scripts', 'fetch-doom.mjs');
    const result = spawnSync(process.execPath, ['--no-warnings', fetchScript], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 0);
    break;
  }

  case 'setup': {
    const setupScript = path.join(ROOT, 'scripts', 'setup.mjs');
    // Pass through --yes and --no-iterm flags if present
    const setupArgs = args.slice(1).filter(a => a === '--yes' || a === '--no-iterm');
    const result = spawnSync(process.execPath, ['--no-warnings', setupScript, ...setupArgs], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 0);
    break;
  }

  case 'rows': {
    const raw = parseInt(args[1], 10);
    if (isNaN(raw)) {
      process.stdout.write(`claude-mon: "rows" requires a number. Usage: afk-ctl.mjs rows <2..30>\n`);
      process.exit(1);
    }
    const rows = clamp(raw, 2, 40);
    writeConfig({ rows });
    printConfig({ ...cfg, rows });
    break;
  }

  case 'aspect': {
    const aspect = args[1];
    if (!['4:3', '16:10', 'stretch'].includes(aspect)) {
      process.stdout.write(
        `claude-mon: unknown aspect "${aspect ?? ''}". Valid options: 4:3, 16:10, stretch\n`,
      );
      process.exit(1);
    }
    writeConfig({ aspect });
    printConfig({ ...cfg, aspect });
    break;
  }

  case 'style': {
    const style = args[1];
    if (!['quad', 'half', 'pixel'].includes(style)) {
      process.stdout.write(
        `claude-mon: unknown style "${style ?? ''}". Valid options: quad, half, pixel\n` +
        '  quad  — adaptive 2×2 quadrant blocks (2× horizontal detail, default)\n' +
        '  half  — classic half-block ▀ rendering\n' +
        '  pixel — EXPERIMENTAL: kitty Unicode placeholder banner (kitty/Warp/WezTerm/Ghostty\n' +
        '          with kitty graphics + U=1 support required; revert with /afk style quad)\n',
      );
      process.exit(1);
    }
    writeConfig({ style });
    printConfig({ ...cfg, style });
    break;
  }

  case 'backdrop': {
    const sub = args[1];
    if (sub === 'fps') {
      // backdrop fps <N>
      const raw = parseInt(args[2], 10);
      if (isNaN(raw)) {
        process.stdout.write(`claude-mon: usage: backdrop fps <5..35>\n`);
        process.exit(1);
      }
      const fps = Math.min(35, Math.max(5, raw));
      writeConfig({ backdropFps: fps });
      printConfig({ ...cfg, backdropFps: fps });
      break;
    }
    const value = sub;
    if (!['on', 'off'].includes(value)) {
      process.stdout.write(
        `claude-mon: usage: backdrop <on|off|fps <5..35>>\n` +
        '  on          — the darkened game frame becomes the WHOLE terminal background\n' +
        '                (daemon streams at backdropFps; kitty z=-2; Claude Code UI floats on top;\n' +
        '                verified in Warp). The banner collapses to a single HUD line.\n' +
        '  off         — remove the backdrop image and restore the normal banner\n' +
        '  fps <5..35> — set backdrop streaming fps (default: 24; DOOM tic rate cap: 35)\n',
      );
      process.exit(1);
    }
    writeConfig({ backdrop: value === 'on' });
    printConfig({ ...cfg, backdrop: value === 'on' });
    if (value === 'on') {
      process.stdout.write('Backdrop enabled — the daemon will stream at backdropFps (see /afk status).\n');
    }
    break;
  }

  case 'bot': {
    const value = args[1];
    if (!['on', 'off'].includes(value)) {
      process.stdout.write(
        `claude-mon: usage: bot <on|off>\n` +
        '  on  — heuristic bot plays DOOM: calm autopilot while you type,\n' +
        '        ramps up aggression while Claude is in working state.\n' +
        '  off — disable bot (engine runs attract demo)\n',
      );
      process.exit(1);
    }
    writeConfig({ bot: value === 'on' });
    printConfig({ ...cfg, bot: value === 'on' });
    if (value === 'on') {
      process.stdout.write('Bot enabled — restart the daemon (/afk game doom) for it to take effect.\n');
    }
    break;
  }

  case 'act': {
    // One-shot game input for agentic play (/doom — Claude takes the controls).
    // Writes control.json with the given keys held, keeps the heartbeat alive
    // for --ms (max 3000), then releases. The daemon's ownership logic treats
    // this exactly like a human controller: bot suspends, keys apply, bot
    // resumes ~1.5s after the heartbeat stops.
    const KEYMAP = {
      w: 0xad, up: 0xad, s: 0xaf, down: 0xaf,
      a: 0xac, left: 0xac, d: 0xae, right: 0xae,
      f: 0xa3, x: 0xa3, fire: 0xa3,
      space: 0xa2, use: 0xa2,
      esc: 27, enter: 13,
      1: 49, 2: 50, 3: 51, 4: 52, 5: 53, 6: 54, 7: 55,
    };
    const keysArg = (args[1] ?? '').toLowerCase();
    const msFlag = args.indexOf('--ms');
    const holdMs = Math.min(3000, Math.max(200, msFlag > -1 ? parseInt(args[msFlag + 1], 10) || 1200 : 1200));
    const names = keysArg.split(',').map(k => k.trim()).filter(Boolean);
    const codes = names.map(k => KEYMAP[k]).filter(c => c !== undefined);
    if (!codes.length) {
      process.stdout.write(
        'claude-mon: usage: act <keys> [--ms <200..3000>]\n' +
        '  keys: comma-separated — w,a,s,d,up,down,left,right,f|fire,space|use,esc,enter,1-7\n' +
        '  example: act w,f --ms 1500   (run forward firing for 1.5s)\n' +
        `  frame to look at: ${path.join(os.tmpdir(), 'claude-mon', 'doom', 'backdrop.png')}\n`,
      );
      process.exit(1);
    }
    const controlFile = path.join(os.tmpdir(), 'claude-mon', 'doom', 'control.json');
    const writeControl = (held, hb) => {
      try {
        const tmp = controlFile + '.tmp';
        fs.mkdirSync(path.dirname(controlFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ heartbeat: hb, held, taps: [], pid: process.pid }), 'utf8');
        fs.renameSync(tmp, controlFile);
      } catch { /* daemon absent — harmless */ }
    };
    writeControl(codes, Date.now());
    const refresher = setInterval(() => writeControl(codes, Date.now()), 400);
    setTimeout(() => {
      clearInterval(refresher);
      writeControl([], 0);
      process.stdout.write(`acted: [${names.join(' ')}] held ${holdMs}ms — frame: ${path.join(os.tmpdir(), 'claude-mon', 'doom', 'backdrop.png')}\n`);
      process.exit(0);
    }, holdMs);
    break;
  }

  case 'debug': {
    const sub = args[1];

    if (sub === 'on') {
      writeConfig({ debug: true });
      process.stdout.write('claude-mon: debug logging enabled — logs go to ' + DEBUG_LOG + '\n');
      process.stdout.write('  Disable with:  /afk debug off\n');
      process.stdout.write('  Tail with:     /afk debug tail\n');
      process.stdout.write('  Or set env:    AFK_ARCADE_DEBUG=1\n');
      break;
    }

    if (sub === 'off') {
      writeConfig({ debug: false });
      process.stdout.write('claude-mon: debug logging disabled\n');
      break;
    }

    if (sub === 'tail' || sub === undefined) {
      const n = sub === 'tail' && args[2] ? parseInt(args[2], 10) : 30;
      const lineCount = isNaN(n) || n < 1 ? 30 : n;

      let raw;
      try {
        raw = fs.readFileSync(DEBUG_LOG, 'utf8');
      } catch {
        process.stdout.write('(no debug log yet — enable with: /afk debug on)\n');
        break;
      }

      const allLines = raw.split('\n').filter(l => l.length > 0);
      if (allLines.length === 0) {
        process.stdout.write('(debug log is empty)\n');
        break;
      }

      const tail = allLines.slice(-lineCount);
      process.stdout.write(tail.join('\n') + '\n');
      break;
    }

    // Unknown sub-command
    process.stdout.write([
      'claude-mon debug commands:',
      '  debug on           — enable JSONL debug logging to ' + DEBUG_LOG,
      '  debug off          — disable debug logging',
      '  debug tail [n]     — print last n lines from debug.log (default: 30)',
      '',
      'Or set env:  AFK_ARCADE_DEBUG=1  (enables without touching config)',
    ].join('\n') + '\n');
    break;
  }

  case 'control': {
    const controlScript = path.join(ROOT, 'scripts', 'control.mjs');
    const controlCmd = `${process.execPath} --no-warnings ${controlScript}`;
    const CONTROL_TIP = 'Controls: WASD/arrows move · SPACE use · F/X fire · 1-7 weapons · ESC menu · Q quit';

    if (process.platform === 'darwin') {
      const warpInstalled = fs.existsSync('/Applications/Warp.app');

      if (warpInstalled) {
        const launchDir = path.join(os.homedir(), '.warp', 'launch_configurations');
        fs.mkdirSync(launchDir, { recursive: true });

        // Warp deduplicates launch-config URIs by config name for the app's lifetime.
        // Always generate a unique timestamped name to guarantee a fresh tab is opened.
        const epoch = Date.now();
        const launchFile = path.join(launchDir, `claude-doom-ctl-${epoch}.yaml`);

        // Clean up generated claude-doom-ctl-* configs older than 1 day to avoid litter.
        try {
          const cutoff = epoch - 24 * 60 * 60 * 1000;
          const entries = fs.readdirSync(launchDir);
          for (const entry of entries) {
            if (/^claude-doom-ctl-\d+\.yaml$/.test(entry)) {
              const match = entry.match(/claude-doom-ctl-(\d+)\.yaml/);
              if (match && parseInt(match[1], 10) < cutoff) {
                try { fs.unlinkSync(path.join(launchDir, entry)); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* non-fatal */ }

        const yaml = [
          '# Warp Launch Configuration — generated by claude-mon /afk control',
          '---',
          `name: claude-doom-ctl-${epoch}`,
          'windows:',
          '  - tabs:',
          '      - title: DOOM Controller',
          '        layout:',
          `          cwd: ${os.homedir()}`,
          '          commands:',
          `            - exec: "${process.execPath} --no-warnings ${controlScript}"`,
        ].join('\n') + '\n';

        fs.writeFileSync(launchFile, yaml, 'utf8');

        const uri = `warp://launch/${encodeURIComponent(launchFile)}`;

        let launched = false;
        try {
          execFileSync('open', [uri], { timeout: 5000 });
          launched = true;
        } catch {
          /* open failed — fall through to manual instructions */
        }

        if (launched) {
          process.stdout.write(
            `Launched DOOM controller in a Warp tab.\n` +
            `${CONTROL_TIP}\n`,
          );
        } else {
          process.stdout.write(
            `Could not open Warp automatically. Run this command in a fresh Warp tab:\n\n` +
            `  ${controlCmd}\n\n` +
            `${CONTROL_TIP}\n`,
          );
        }
        break;
      }
    }

    // Non-darwin or no Warp
    process.stdout.write(
      `Run this command in a fresh terminal tab to take the wheel:\n\n` +
      `  ${controlCmd}\n\n` +
      `${CONTROL_TIP}\n`,
    );
    break;
  }

  case 'play': {
    const playScript = path.join(ROOT, 'scripts', 'play.mjs');
    const CONTROLS = 'Controls: WASD/arrows move \xB7 SPACE use \xB7 F fire \xB7 1-7 weapons \xB7 ESC menu \xB7 Q quit';
    const playCmd  = `${process.execPath} --no-warnings ${playScript} --gfx auto`;

    if (process.platform === 'darwin') {
      const warpInstalled  = fs.existsSync('/Applications/Warp.app');
      const itermInstalled = fs.existsSync('/Applications/iTerm.app');

      if (warpInstalled) {
        // Write a Warp Launch Configuration YAML and open it via the URI scheme.
        // Schema: https://docs.warp.dev/terminal/sessions/launch-configurations
        // URI:    warp://launch/<url-encoded-path-to-yaml>
        const launchDir  = path.join(os.homedir(), '.warp', 'launch_configurations');
        const launchFile = path.join(launchDir, 'claude-doom.yaml');

        // Ensure the directory exists
        fs.mkdirSync(launchDir, { recursive: true });

        // Build the YAML — single window, single tab, one command.
        // cwd must be an absolute path (~ is not accepted by Warp).
        const yaml = [
          '# Warp Launch Configuration — generated by claude-mon /afk play',
          '---',
          'name: claude-doom',
          'windows:',
          '  - tabs:',
          '      - title: DOOM',
          '        layout:',
          `          cwd: ${os.homedir()}`,
          '          commands:',
          `            - exec: "${process.execPath} --no-warnings ${playScript} --gfx auto"`,
        ].join('\n') + '\n';

        fs.writeFileSync(launchFile, yaml, 'utf8');

        // URI: warp://launch/<url-encoded absolute path>
        const uri = `warp://launch/${encodeURIComponent(launchFile)}`;

        let launched = false;
        try {
          execFileSync('open', [uri], { timeout: 5000 });
          launched = true;
        } catch {
          /* open failed — fall through to manual instructions */
        }

        if (launched) {
          process.stdout.write(
            `Launched DOOM in a Warp tab.\n` +
            `${CONTROLS}\n`,
          );
        } else {
          process.stdout.write(
            `Could not open Warp automatically. Run this command in a fresh Warp tab:\n\n` +
            `  ${playCmd}\n\n` +
            `${CONTROLS}\n`,
          );
        }
        break;
      }

      if (itermInstalled) {
        process.stdout.write(
          `Run this command inside iTerm2 for pixel-perfect mode:\n\n` +
          `  ${playCmd}\n\n` +
          `${CONTROLS}\n`,
        );
        break;
      }
    }

    // Non-darwin or no supported terminal detected
    process.stdout.write(
      `Run this command in a fresh terminal tab:\n\n` +
      `  ${playCmd}\n\n` +
      `${CONTROLS}\n`,
    );
    break;
  }

  case 'rom': {
    const romPath = args[1];
    if (!romPath) {
      const cur = readConfig().gbaRom;
      process.stdout.write(cur
        ? `Current ROM: ${cur}\n`
        : 'No ROM configured. Usage: rom <absolute-path-to-your.gba>\n');
      break;
    }
    const abs = path.resolve(romPath);
    if (!fs.existsSync(abs)) {
      process.stdout.write(`claude-mon: file not found: ${abs}\n`);
      process.exit(1);
    }
    const size = fs.statSync(abs).size;
    if (size < 1_000_000 || size > 64 * 1024 * 1024) {
      process.stdout.write(`claude-mon: ${abs} doesn't look like a GBA ROM (size ${size}B)\n`);
      process.exit(1);
    }
    writeConfig({ gbaRom: abs });
    process.stdout.write(
      `ROM set: ${abs}\n` +
      'Switch with: /afk game gba   (battery saves persist to ~/.claude/claude-mon/saves/)\n',
    );
    break;
  }

  case 'banner': {
    const v = args[1];
    if (v !== 'on' && v !== 'off') {
      process.stdout.write('Usage: banner <on|off> — game rows in the statusline (HUD text stays)\n');
      break;
    }
    writeConfig({ banner: v === 'on' });
    process.stdout.write(v === 'on'
      ? 'banner ON — game rows back in the statusline.\n'
      : 'banner OFF — statusline shows the HUD text line only (no floating game block).\n');
    break;
  }

  case 'arcade': {
    // Launch a NEW terminal window running claude (--continue, same project)
    // inside the doomscreen compositor. Everything by ABSOLUTE path — zero
    // dependence on PATH shims, profiles, broadcasts or elevation. This is
    // the no-dance activation: install plugin → /arcade.
    const screenScript = path.join(ROOT, 'scripts', 'doomscreen.mjs');
    const dry = args.includes('--print');

    if (process.platform !== 'win32') {
      process.stdout.write(
        'On macOS/Linux run in a fresh terminal:\n' +
        `  ${process.execPath} --no-warnings ${screenScript}\n`,
      );
      break;
    }

    // Resolve the real claude (skip our shim bin if present)
    const shimBin = path.join(os.homedir(), '.claude', 'claude-mon', 'bin');
    let realClaude = null;
    try {
      const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      realClaude = lines.find((l) => l.toLowerCase().endsWith('.cmd') &&
                                     !l.toLowerCase().startsWith(shimBin.toLowerCase()))
                ?? lines.find((l) => !l.toLowerCase().startsWith(shimBin.toLowerCase()));
    } catch { /* not on PATH */ }
    if (!realClaude) {
      process.stdout.write('No pude resolver `claude` en el PATH de este proceso.\n');
      break;
    }

    // Direct mode (no --wrap): explicit launch always composites.
    // ARGUMENT ARRAYS ONLY — composing a command string and feeding it
    // through cmd /c double-parses quotes (a cwd ending in \ escaped its
    // own closing quote: error 0x8007010b "Could not access starting
    // directory"). node quotes array args correctly on its own.
    const cwd = process.cwd().replace(/[\\/]+$/, '');
    const innerArgs = [
      process.execPath, '--no-warnings', screenScript, '--', realClaude, '--continue',
    ];

    let hasWt = false;
    try { execFileSync('where.exe', ['wt.exe'], { stdio: 'ignore' }); hasWt = true; } catch { /* no wt */ }

    if (dry) {
      const show = hasWt
        ? ['wt', '-d', cwd, 'cmd', '/c', ...innerArgs]
        : ['conhost.exe', 'cmd', '/c', ...innerArgs];
      process.stdout.write(show.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') + '\n');
      break;
    }

    try {
      const { spawn } = await import('node:child_process');
      const child = hasWt
        ? spawn('wt.exe', ['-d', cwd, 'cmd', '/c', ...innerArgs],
          { detached: true, stdio: 'ignore' })
        : spawn('conhost.exe', ['cmd', '/c', ...innerArgs],
          { detached: true, stdio: 'ignore', cwd });
      child.unref();
      process.stdout.write([
        'Ventana DOOM Arcade lanzada — tu conversación continúa allí (claude --continue)',
        'con el juego fullscreen de fondo. F8 o Ctrl+] toggle teclado ↔ marine.',
        'Podés cerrar esta sesión cuando quieras.',
        '',
        'SAME-WINDOW (sin ventana nueva):',
        '  /afk screen on   → desde el PRÓXIMO `claude`, la misma ventana donde lo',
        '                     tipeás arranca compositada (el plugin "precargado").',
        '  /afk backdrop on → detrás de la sesión ACTUAL, solo Warp/kitty.',
        '',
      ].join('\n'));
    } catch (err) {
      process.stdout.write(`No pude lanzar la ventana: ${err.message}\n`);
    }
    break;
  }

  case 'brain': {
    const brainScript = path.join(ROOT, 'scripts', 'doombrain.mjs');
    const doomTmp = path.join(os.tmpdir(), 'claude-mon', 'doom');
    const statusFile = path.join(doomTmp, 'doombrain-status.json');
    const stopFile = path.join(doomTmp, 'doombrain.stop');
    const sub = args[1];

    if (sub === 'on') {
      // Already running?
      try {
        const st = readJson(statusFile, null);
        if (st?.pid && !st.stopped && Date.now() - (st.updatedAt ?? 0) < 10_000) {
          process.kill(st.pid, 0);
          process.stdout.write(`doombrain already running (pid ${st.pid})\n`);
          break;
        }
      } catch { /* stale */ }
      const { spawn } = await import('node:child_process');
      const logPath = path.join(os.homedir(), '.claude', 'claude-mon', 'brain.log');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const logFd = fs.openSync(logPath, 'a');
      // In GBA mode the brain auto-switches to the vision pilot that reads
      // on-screen text (Pokémon dialog/menus) and presses buttons.
      const brainEnv = { ...process.env };
      try { if (readConfig().game === 'gba') brainEnv.AFK_BRAIN_GAME = 'pokemon'; } catch { /* default */ }
      const child = spawn(process.execPath, ['--no-warnings', brainScript], {
        detached: true, stdio: ['ignore', logFd, logFd], env: brainEnv,
      });
      child.unref();
      fs.closeSync(logFd);
      process.stdout.write([
        `doombrain launched (pid ${child.pid}) — Claude pilots the marine.`,
        `  model:    ${process.env.AFK_BRAIN_MODEL ?? 'haiku'} (AFK_BRAIN_MODEL to change)`,
        `  cadence:  every ${process.env.AFK_BRAIN_INTERVAL ?? 4000}ms, auto-stop ${process.env.AFK_BRAIN_MINUTES ?? 30}min`,
        `  log:      ${logPath}`,
        'The heuristic bot yields while the brain heartbeat is fresh.',
        'Stop with: /afk brain off',
        '',
      ].join('\n'));
      break;
    }

    if (sub === 'off') {
      try { fs.writeFileSync(stopFile, 'afk-ctl'); } catch { /* ignore */ }
      try {
        const st = readJson(statusFile, null);
        if (st?.pid) setTimeout(() => { try { process.kill(st.pid); } catch { /* gone */ } }, 6000).unref();
      } catch { /* ignore */ }
      process.stdout.write('doombrain stopping (stop sentinel written; pid killed in 6s if needed).\n');
      break;
    }

    // status / no subcommand
    const st = readJson(statusFile, null);
    if (!st) {
      process.stdout.write('doombrain: not running. Start with /afk brain on\n');
    } else {
      const age = ((Date.now() - (st.updatedAt ?? 0)) / 1000) | 0;
      process.stdout.write(
        `doombrain: ${st.stopped ? 'STOPPED' : 'running'} pid=${st.pid} model=${st.model} ` +
        `decisions=${st.decisions} failures=${st.failures} note="${st.note ?? ''}" (${age}s ago)\n`,
      );
    }
    break;
  }

  case 'screen': {
    const screenScript = path.join(ROOT, 'scripts', 'doomscreen.mjs');
    const screenCmd = `${process.execPath} --no-warnings ${screenScript}`;
    const isWin = process.platform === 'win32';
    const sub = args[1];

    if (sub === 'off') {
      writeConfig({ screen: false });
      process.stdout.write(
        'doomscreen shim disabled — `claude` runs plain again (config screen=false).\n' +
        'Re-enable with: /afk screen on\n',
      );
      break;
    }

    if (sub === 'on') {
      if (!isWin) {
        process.stdout.write(
          'Automatic shim install is Windows-only for now.\n' +
          `Add an alias to your shell rc instead:\n\n` +
          `  alias claude='${screenCmd} --wrap "$(command -v claude)" --'\n`,
        );
        break;
      }

      // 1. Resolve the REAL claude (skip our own shim directory)
      const binDir = path.join(os.homedir(), '.claude', 'claude-mon', 'bin');
      let real = null;
      try {
        const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        real = lines.find((l) => l.toLowerCase().endsWith('.cmd') &&
                                 !l.toLowerCase().startsWith(binDir.toLowerCase()))
            ?? lines.find((l) => !l.toLowerCase().startsWith(binDir.toLowerCase()));
      } catch { /* not found */ }
      if (!real) {
        process.stdout.write('Could not resolve the real `claude` on PATH — is Claude Code installed?\n');
        break;
      }

      // 2. Write the shims: .cmd (cmd.exe), .ps1 (PowerShell resolves it
      //    before .cmd), and extensionless sh (Git Bash)
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'claude.cmd'),
        '@echo off\r\n' +
        `"${process.execPath}" --no-warnings "${screenScript}" --wrap "${real}" -- %*\r\n`);
      fs.writeFileSync(path.join(binDir, 'claude.ps1'),
        '# claude-mon shim\r\n' +
        `& "${process.execPath}" --no-warnings "${screenScript}" --wrap "${real}" -- @args\r\n` +
        'exit $LASTEXITCODE\r\n');
      fs.writeFileSync(path.join(binDir, 'claude'),
        '#!/bin/sh\n' +
        `exec "${process.execPath.replace(/\\/g, '/')}" --no-warnings ` +
        `"${screenScript.replace(/\\/g, '/')}" --wrap "${real.replace(/\\/g, '/')}" -- "$@"\n`);

      // 3. Prepend the bin dir to the USER Path (PowerShell API — setx
      //    truncates at 1024 chars and must never be used for Path)
      let pathNote = 'already on PATH';
      try {
        const get = `[Environment]::GetEnvironmentVariable('Path','User')`;
        const current = execFileSync('powershell.exe',
          ['-NoProfile', '-Command', get], { encoding: 'utf8' }).trim();
        const onPath = current.toLowerCase().split(';').some(
          (p) => p.trim().toLowerCase() === binDir.toLowerCase());
        if (!onPath) {
          const set = `[Environment]::SetEnvironmentVariable('Path','${binDir};' + ${get},'User')`;
          execFileSync('powershell.exe', ['-NoProfile', '-Command', set]);
          pathNote = 'prepended to user PATH (NEW terminals pick it up)';
        }
      } catch (err) {
        pathNote = `PATH update failed (${err.message.slice(0, 60)}) — add manually: ${binDir}`;
      }

      // 4. PowerShell profile function — PATH propagation on Windows is a
      //    minefield (apps cache env; elevated consoles build theirs
      //    differently), but profiles load in EVERY interactive PowerShell.
      let profileNote = 'profile function installed';
      try {
        const MARK_S = '# >>> claude-mon claude shim >>>';
        const MARK_E = '# <<< claude-mon claude shim <<<';
        const fnBlock = [
          MARK_S,
          'function claude {',
          `  & "${path.join(binDir, 'claude.cmd')}" @args`,
          '}',
          MARK_E,
        ].join('\r\n');
        // NEVER assume ~\Documents: OneDrive redirection moves it (and
        // localizes the name — this machine: OneDrive\Documentos). Ask
        // Windows for the real folder.
        let docs;
        try {
          docs = execFileSync('powershell.exe',
            ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"],
            { encoding: 'utf8' }).trim();
        } catch { docs = ''; }
        if (!docs) docs = path.join(os.homedir(), 'Documents');
        for (const dir of [path.join(docs, 'WindowsPowerShell'), path.join(docs, 'PowerShell')]) {
          fs.mkdirSync(dir, { recursive: true });
          const prof = path.join(dir, 'profile.ps1');
          let cur = '';
          try { cur = fs.readFileSync(prof, 'utf8'); } catch { /* new profile */ }
          if (cur.includes(MARK_S)) {
            cur = cur.replace(
              new RegExp(`${MARK_S.replace(/[>]/g, '\\>')}[\\s\\S]*?${MARK_E.replace(/[<]/g, '\\<')}`),
              fnBlock);
          } else {
            cur = cur + (cur === '' || cur.endsWith('\n') ? '' : '\r\n') + fnBlock + '\r\n';
          }
          fs.writeFileSync(prof, cur);
        }
      } catch (err) {
        profileNote = `profile update failed: ${err.message.slice(0, 60)}`;
      }

      // 5. Broadcast WM_SETTINGCHANGE so Explorer (and listening apps)
      //    refresh their environment — without this, consoles launched from
      //    the taskbar keep the pre-install PATH until logoff.
      try {
        const bc = [
          `Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);'`,
          `$r=[UIntPtr]::Zero;[W.N]::SendMessageTimeout([IntPtr]0xffff,0x001A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)|Out-Null`,
        ].join(';');
        execFileSync('powershell.exe', ['-NoProfile', '-Command', bc]);
      } catch { /* non-fatal — a logoff/logon also refreshes */ }

      writeConfig({ screen: true });
      process.stdout.write([
        'doomscreen shim ON — from your NEXT `claude`, the SAME window you type it',
        'in boots composited (DOOM behind Claude, F8 toggles the keyboard).',
        `  shim:     ${path.join(binDir, 'claude.cmd')}`,
        `  real:     ${real}`,
        `  PATH:     ${pathNote}`,
        `  profiles: ${profileNote} (WindowsPowerShell + PowerShell)`,
        '',
        'Transparent passthrough: pipes/scripts, --version/--help/-p/mcp/plugin,',
        'and `/afk screen off` all run the real claude untouched.',
        'F8 or Ctrl+] toggles your keyboard between Claude and the marine.',
        '',
      ].join('\n'));
      break;
    }

    // No subcommand — status + manual launch info
    const cfgScreen = readConfig().screen;
    process.stdout.write([
      'Universal backdrop — DOOM behind Claude Code in ANY terminal.',
      '',
      `Shim state: ${cfgScreen === false ? 'OFF (claude runs plain)' : 'ON when installed (config.screen !== false)'}`,
      '  /afk screen on   — install PATH shim: plain `claude` gets the backdrop',
      '  /afk screen off  — disable (shim passes through untouched)',
      '',
      'Manual launch (no shim needed):',
      `  ${screenCmd}`,
      '',
      isWin
        ? 'Keyboard: F8 or Ctrl+] toggles your keys between Claude and the marine.'
        : 'Keyboard flows natively to claude; use /afk control for game input.',
      'Wrap a different command:  ' + screenCmd + ' -- <command> [args]',
      'Tune fps with AFK_DOOMSCREEN_FPS (5..35, default 30).',
      '',
    ].join('\n'));
    break;
  }

  default: {
    process.stdout.write([
      'claude-mon control CLI',
      '',
      'Commands:',
      '  status               — show current config and active sessions',
      '  on / off             — enable or disable the banner',
      '  game fire            — switch to DOOM fire effect',
      '  game doom            — switch to DOOM WASM daemon frame',
      '  game gba             — Game Boy Advance (bring your own ROM via `rom`)',
      '  rom <path>           — point the GBA mode at YOUR legally-dumped .gba file',
      '  rows <N>             — set banner height (2..40 rows)',
      '  aspect <4:3|16:10|stretch> — set DOOM frame aspect ratio (default: 4:3)',
      '  backdrop <on|off>    — game as the WHOLE terminal background (kitty z=-2),',
      '                         daemon streams at backdropFps; banner becomes HUD-only',
      '  backdrop fps <5..35> — set backdrop streaming fps (default: 24)',
      '  bot <on|off>         — heuristic bot plays DOOM: calm autopilot while typing,',
      '                         aggressive "claude is playing" while Claude is working',
      '  control              — take the wheel: open a controller tab so YOU play DOOM.',
      '                         The bot autoplays when the controller is not connected.',
      '  style <quad|half|pixel>',
      '                       — set render style: quad (2×2 blocks, default), half (▀ classic),',
      '                         or pixel (EXPERIMENTAL kitty Unicode placeholder banner)',
      '  debug on             — enable JSONL diagnostics (written to ~/.claude/claude-mon/debug.log)',
      '  debug off            — disable diagnostics',
      '  debug tail [n]       — print last n lines from debug.log (default: 30)',
      '  fetch-doom           — download DOOM WASM assets into vendor/doom/',
      '  play                 — print the command to play DOOM in a fresh terminal',
      '  arcade               — NEW window: this conversation continues (claude',
      '                         --continue) with DOOM fullscreen behind it. Zero setup.',
      '  banner <on|off>      — game rows in the statusline (off = HUD text only)',
      '  screen [on|off]      — universal backdrop: DOOM behind Claude in ANY terminal',
      '                         (on = plain `claude` boots with it; F8 toggles keyboard)',
      '  brain [on|off|status]— Claude pilots the marine: a cheap model (haiku) reads',
      '                         frames and plays via control.json; bot yields meanwhile',
      '  setup [--yes] [--no-iterm]',
      '                       — one-shot installer: wires statusline, downloads DOOM assets,',
      '                         offers iTerm2 on macOS (--yes to accept all, --no-iterm to skip)',
    ].join('\n') + '\n');
    break;
  }
}
