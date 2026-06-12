#!/usr/bin/env node
/**
 * doomscreen.mjs — the universal backdrop: DOOM behind Claude Code in ANY
 * terminal, no graphics protocols, no sidecar tab, no external terminal.
 *
 *   ┌─ real terminal (alt-screen, we own every cell) ──────────────┐
 *   │  DOOM frame (frame.rgb → quadrant glyphs)         ← base     │
 *   │  Claude Code's screen (@xterm/headless, composed) ← top      │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Claude runs inside a pseudo-terminal; its output feeds a headless xterm
 * (the virtual screen). Each tick we composite game + claude into a text
 * grid and diff-paint the real terminal. Claude never touches the real
 * screen directly.
 *
 * PTY layer:
 *   win32 — `conhost.exe --headless` spawned directly (inbox binary; plain
 *           text input + in-band resize CSI 8;rows;cols t verified).
 *           Keyboard is OURS: F8 / Ctrl+] toggles claude ↔ marine. (§5
 *           input capture absorbed — no expect, no Tcl.)
 *   macOS — `/usr/bin/script -q /dev/null` with inherited stdin (keyboard
 *           flows natively to claude; game input stays on the sidecar).
 *   linux — `script -qfc` equivalent, same native-keyboard caveat.
 *
 * Usage:
 *   node scripts/doomscreen.mjs [--selftest] [-- <command> [args…]]
 *   AFK_DOOMSCREEN_FPS   compositor rate, 5..35 (default 24)
 *   AFK_DOOMSCREEN_CMD   wrapped command (default "claude") — drills use cmd.exe
 *   AFK_DOOMSCREEN_DEBUG=1  JSONL telemetry via lib/debug.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { TMP_ROOT, readConfig } from '../lib/state.mjs';
import { parseFrameRgb, composeGrid, renderDiff } from '../lib/compose.mjs';
import { decodeKeys } from '../lib/keys.mjs';
import { mapKeyEventToDoom, buildControlState } from '../lib/control-core.mjs';
import { xtermVendorValid } from './fetch-xterm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DOOM_TMP     = path.join(TMP_ROOT, 'doom');
const RAW_REQUEST  = path.join(DOOM_TMP, 'raw-request.json');
const FRAME_RGB    = path.join(DOOM_TMP, 'frame.rgb');
const CONTROL_JSON = path.join(DOOM_TMP, 'control.json');
const PID_FILE     = path.join(DOOM_TMP, 'daemon.pid');
const SPAWN_LOCK   = path.join(DOOM_TMP, 'spawn.lock');

const FPS = Math.max(5, Math.min(35,
  parseInt(process.env.AFK_DOOMSCREEN_FPS ?? '30', 10) || 30));
/** A frozen frame older than this is dropped (hides daemon recycles). */
const FRAME_FRESH_MS = 12_000;
/** Toggle keys: F8 (CSI 19~) and Ctrl+] (0x1d, survives chunk splits). */
const F8_SEQ = Buffer.from('\x1b[19~');
const CTRL_RBRACKET = 0x1d;
/** F9: hide/show the game layer live (claude keeps running untouched). */
const F9_SEQ = Buffer.from('\x1b[20~');

// ── Debug telemetry (optional) ────────────────────────────────────────────────

let dbg = () => {};
if (process.env.AFK_DOOMSCREEN_DEBUG === '1') {
  try {
    const { dbgLog } = await import('../lib/debug.mjs');
    dbg = (data) => dbgLog('doomscreen', data);
  } catch { /* debug module unavailable — stay silent */ }
}

// ── PTY layer ─────────────────────────────────────────────────────────────────

/**
 * Spawn the wrapped command inside a pseudo-terminal.
 *
 * @param {string[]} cmdArgs  [command, ...args]
 * @param {number} cols
 * @param {number} rows
 * @returns {{ child: import('node:child_process').ChildProcess,
 *             routedInput: boolean }}
 *   routedInput true → we own the keyboard (write child.stdin);
 *   false → keyboard flows natively (stdin inherited by the pty).
 */
function spawnPty(cmdArgs, cols, rows) {
  // The child resolves `claude` through the same PATH shim that may have
  // launched us — AFK_DOOMSCREEN_INNER makes the shim pass straight through.
  const childEnv = { ...process.env, AFK_DOOMSCREEN_INNER: '1' };

  if (process.platform === 'win32') {
    // cmd.exe /c resolves .cmd/.bat shims (claude installs as claude.cmd)
    const child = spawn('conhost.exe', [
      '--headless', '--width', String(cols), '--height', String(rows), '--',
      'cmd.exe', '/c', ...cmdArgs,
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    return { child, routedInput: true };
  }

  if (process.platform === 'darwin') {
    // Verified on macOS: `script` works with INHERITED stdin only — a pipe
    // raises "tcgetattr: not supported on socket" (HANDOFF §4).
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', ...cmdArgs], {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: childEnv,
    });
    return { child, routedInput: false };
  }

  // linux (util-linux script syntax)
  const quoted = cmdArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const child = spawn('script', ['-qfc', quoted, '/dev/null'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: childEnv,
  });
  return { child, routedInput: false };
}

/** Ask the pty to adopt a new size. */
function resizePty(child, routedInput, cols, rows) {
  if (process.platform === 'win32') {
    // In-band resize — verified intercepted by conhost --headless.
    try { child.stdin.write(`\x1b[8;${rows};${cols}t`); } catch { /* gone */ }
  } else {
    try { process.kill(child.pid, 'SIGWINCH'); } catch { /* gone */ }
  }
}

// ── Daemon liveness (same spawn-lock dance as the statusline) ─────────────────

function ensureDaemon() {
  let alive = false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pid > 0) { process.kill(pid, 0); alive = true; }
  } catch { /* absent or dead */ }
  if (alive) return;

  try {
    try {
      const lockStat = fs.statSync(SPAWN_LOCK);
      if (Date.now() - lockStat.mtimeMs > 30_000) fs.rmdirSync(SPAWN_LOCK);
    } catch { /* no lock */ }
    fs.mkdirSync(SPAWN_LOCK);
  } catch {
    return; // another process is spawning
  }
  try {
    const daemon = spawn(process.execPath,
      ['--no-warnings', path.join(__dirname, 'daemon.mjs')],
      { detached: true, stdio: 'ignore' });
    daemon.unref();
    dbg({ event: 'daemon-spawned' });
  } catch { /* non-fatal — game layer stays blank */ }
}

// ── raw-request / frame.rgb plumbing ──────────────────────────────────────────

function writeRawRequest(cols, rows) {
  try {
    fs.mkdirSync(DOOM_TMP, { recursive: true });
    const tmp = RAW_REQUEST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cols, rows, pid: process.pid }));
    fs.renameSync(tmp, RAW_REQUEST);
  } catch { /* non-fatal */ }
}

/** Stateful frame.rgb reader — re-reads only on mtime change. */
function makeFrameReader() {
  let lastMtime = 0;
  let frame = null;
  let frameAt = 0;
  return () => {
    try {
      const stat = fs.statSync(FRAME_RGB);
      if (stat.mtimeMs !== lastMtime) {
        const parsed = parseFrameRgb(fs.readFileSync(FRAME_RGB));
        if (parsed) {
          lastMtime = stat.mtimeMs;
          frame = parsed;
          frameAt = Date.now();
        }
      }
    } catch { /* absent — keep last */ }
    if (frame && Date.now() - frameAt > FRAME_FRESH_MS) return null;
    return frame;
  };
}

// ── Game input (F8 mode) — control.json, zero Tcl ─────────────────────────────

class GameControls {
  constructor() {
    /** @type {Map<number, number>} code → last keydown ms */
    this.held = new Map();
    this.taps = [];
    this.seq = 1;
    this.timer = null;
  }

  start() {
    // Heartbeat + held-key expiry sweep. Terminals auto-repeat held keys, so
    // a key not re-seen for 300ms has been released (same window as the
    // stdin bridge in control.mjs).
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [code, at] of this.held) {
        if (now - at > 300) this.held.delete(code);
      }
      this.flush();
    }, 120);
  }

  feed(buf) {
    for (const name of decodeKeys(buf)) {
      const mapped = mapKeyEventToDoom(name);
      if (!mapped) continue;
      if (mapped.held) {
        this.held.set(mapped.code, Date.now());
      } else {
        this.taps.push({ seq: this.seq++, code: mapped.code });
        if (this.taps.length > 8) this.taps.shift();
      }
    }
    this.flush();
  }

  flush() {
    const state = buildControlState([...this.held.keys()], this.taps, this.seq);
    try {
      const tmp = CONTROL_JSON + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, CONTROL_JSON);
    } catch { /* daemon will see the next one */ }
  }

  /** Release ownership back to the bot (heartbeat 0 sentinel). */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.held.clear();
    this.taps = [];
    try {
      const tmp = CONTROL_JSON + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(
        { heartbeat: 0, held: [], taps: [], pid: process.pid }));
      fs.renameSync(tmp, CONTROL_JSON);
    } catch { /* ignore */ }
  }
}

// ── Game-mode overlay badge ───────────────────────────────────────────────────

const BADGE = '  DOOM — F8: back to Claude · WASD move · F fire · Space use  ';

function stampBadge(grid, cols) {
  const start = Math.max(0, cols - BADGE.length);
  for (let k = 0; k < BADGE.length && start + k < cols; k++) {
    const i = start + k;
    grid.ch[i] = BADGE[k];
    grid.fg[i] = '\x1b[0;1;38;5;220m';
    grid.bg[i] = '\x1b[48;5;52m';
  }
}

// ── Selftest ──────────────────────────────────────────────────────────────────

async function runSelftest() {
  process.stderr.write('doomscreen: --selftest: PTY layer roundtrip…\n');
  if (process.platform !== 'win32') {
    process.stderr.write(
      'doomscreen: selftest: PASS (full check is win32-only; unix uses script(1))\n');
    process.exit(0);
  }
  const marker = 'DOOMSCREEN_SELFTEST_OK';
  const result = await new Promise((resolve) => {
    const { child } = spawnPty([`echo ${marker}`], 80, 24);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const t = setTimeout(() => { child.kill(); resolve({ out, code: -1 }); }, 15_000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ out, code }); });
  });
  if (result.code === 0 && result.out.includes(marker) && result.out.includes('\x1b[')) {
    process.stderr.write('doomscreen: selftest: PASS — conhost VT roundtrip works\n');
    process.exit(0);
  }
  process.stderr.write(
    `doomscreen: selftest: FAIL — exit ${result.code}, ` +
    `tail ${JSON.stringify(result.out.slice(-80))}\n`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest') {
    await runSelftest();
    return;
  }

  // ── Shim mode (`--wrap <real>`) ────────────────────────────────────────────
  // The PATH shim claude.cmd routes EVERY `claude` invocation here, so this
  // mode must be perfectly transparent whenever the backdrop doesn't apply:
  // exec the real binary untouched and mirror its exit code.
  const wrapIdx = argv.indexOf('--wrap');
  const wrapTarget = wrapIdx !== -1 ? argv[wrapIdx + 1] : null;

  const dashDash = argv.indexOf('--');
  const userArgs = dashDash !== -1 ? argv.slice(dashDash + 1) : [];
  const cmdArgs = wrapTarget
    ? [wrapTarget, ...userArgs]
    : (userArgs.length > 0
      ? userArgs
      : [process.env.AFK_DOOMSCREEN_CMD ?? 'claude']);

  const passthrough = () => {
    const [target, ...args] = cmdArgs;
    const r = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', target, ...args], { stdio: 'inherit' })
      : spawnSync(target, args, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  };

  if (wrapTarget) {
    // 1. Recursion guard — the compositor's own child resolves `claude`
    //    through the same PATH shim.
    if (process.env.AFK_DOOMSCREEN_INNER === '1') passthrough();
    // 2. Pipes, scripts, CI: only real interactive consoles get a backdrop.
    if (!process.stdout.isTTY || !process.stdin.isTTY) passthrough();
    // 3. OPT-IN toggle: the backdrop wraps plain `claude` ONLY when the
    //    user asked for it (`/afk screen on` → screen:true). Default is a
    //    transparent passthrough — /arcade is the explicit activation path.
    let cfg = {};
    try { cfg = readConfig(); } catch { /* no config — passthrough */ }
    if (cfg.screen !== true || cfg.enabled === false) passthrough();
    // 4. Quick non-UI invocations skip the compositor entirely.
    const NONINTERACTIVE = new Set([
      '--version', '-v', '--help', '-h', '-p', '--print',
      'doctor', 'update', 'mcp', 'plugin', 'migrate-installer', 'setup-token',
    ]);
    if (userArgs.some((a) => NONINTERACTIVE.has(a))) passthrough();
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('doomscreen: needs a real terminal (stdin+stdout TTY)\n');
    process.exit(1);
  }

  // Vendor the virtual terminal on first run
  if (!(await xtermVendorValid())) {
    process.stderr.write('doomscreen: vendoring @xterm/headless (first run)…\n');
    const r = spawnSync(process.execPath,
      ['--no-warnings', path.join(__dirname, 'fetch-xterm.mjs')],
      { stdio: 'inherit' });
    if (r.status !== 0 || !(await xtermVendorValid())) {
      process.stderr.write('doomscreen: vendor failed — run: node scripts/fetch-xterm.mjs\n');
      process.exit(1);
    }
  }
  const require = createRequire(import.meta.url);
  const { Terminal } = require(path.join(ROOT, 'vendor', 'xterm'));

  let cols = process.stdout.columns ?? 120;
  let rows = process.stdout.rows ?? 30;

  ensureDaemon();
  writeRawRequest(cols, rows);

  // ── Virtual screen ──────────────────────────────────────────────────────────
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  let cursorVisible = true;

  const { child, routedInput } = spawnPty(cmdArgs, cols, rows);

  let termGen = 0; // bumped on every child output chunk — compose skip key
  child.stdout.on('data', (chunk) => {
    termGen++;
    term.write(chunk);
    // Track DECTCEM so the real cursor mirrors claude's (xterm doesn't expose it)
    const s = chunk.toString('latin1');
    const lastShow = s.lastIndexOf('\x1b[?25h');
    const lastHide = s.lastIndexOf('\x1b[?25l');
    if (lastShow !== -1 || lastHide !== -1) cursorVisible = lastShow > lastHide;
  });
  // Query responses (DA/DSR/CPR…) from the virtual terminal go back to claude
  if (routedInput) {
    term.onData((d) => { try { child.stdin.write(d); } catch { /* gone */ } });
  }

  // ── Real screen setup ───────────────────────────────────────────────────────
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');

  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    try { clearInterval(renderTimer); } catch { /* not yet armed */ }
    try { clearInterval(rawReqTimer); } catch { /* not yet armed */ }
    controls.stop();
    try { process.stdin.setRawMode(false); } catch { /* not a tty */ }
    process.stdin.pause();
    process.stdout.write('\x1b[?2026l\x1b[0m\x1b[?1049l\x1b[?25h');
  };

  child.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  // ── Keyboard routing (win32 conhost path) ───────────────────────────────────
  let mode = 'claude'; // 'claude' | 'game'
  const controls = new GameControls();

  if (routedInput) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
      // Debug: shape only — never the full keystroke bytes (debug.log is no
      // place for a keylogger). 4 bytes is enough to identify ESC sequences.
      dbg({ event: 'stdin', len: buf.length, head: buf.toString('hex').slice(0, 8) });
      // F9: game layer on/off (never forwarded)
      if (buf.includes(F9_SEQ)) {
        setGameVisible(!gameVisible);
        return;
      }
      // Toggle detection: F8 (CSI 19~, within-chunk) or Ctrl+] (single byte)
      let toggle = false;
      if (buf.includes(CTRL_RBRACKET) || buf.includes(F8_SEQ)) toggle = true;

      if (toggle) {
        mode = mode === 'claude' ? 'game' : 'claude';
        dbg({ event: 'toggle', mode });
        if (mode === 'game') {
          if (!gameVisible) setGameVisible(true); // no driving a hidden game
          controls.start();
        } else {
          controls.stop();
        }
        forceRepaint = true;
        return; // toggle chunks are never forwarded
      }

      if (mode === 'claude') {
        try { child.stdin.write(buf); } catch { /* child gone */ }
      } else {
        controls.feed(buf);
      }
    });
  }

  // ── Resize ──────────────────────────────────────────────────────────────────
  process.stdout.on('resize', () => {
    cols = process.stdout.columns ?? cols;
    rows = process.stdout.rows ?? rows;
    term.resize(cols, rows);
    resizePty(child, routedInput, cols, rows);
    writeRawRequest(cols, rows);
    prevGrid = null; // full repaint
    dbg({ event: 'resize', cols, rows });
  });

  // ── Game-layer visibility (live off-switch, claude keeps running) ──────────
  // F9 toggles instantly; in shim mode `/afk screen off` from INSIDE claude
  // is honoured within ~2s via config polling. Hidden = compose with a null
  // frame (clean dark background) and let the daemon relax to banner pace.
  let gameVisible = true;
  const setGameVisible = (v) => {
    if (gameVisible === v) return;
    gameVisible = v;
    if (!v && mode === 'game') { mode = 'claude'; controls.stop(); }
    forceRepaint = true;
    dbg({ event: 'game-layer', visible: v });
  };
  // EDGE-triggered config follow: only a CHANGE in config.screen overrides
  // the current state — level-triggered polling re-asserted screen:true
  // every 2s and silently undid the manual F9 hide.
  if (wrapTarget) {
    let lastCfgScreen = null;
    setInterval(() => {
      try {
        const v = readConfig().screen === true;
        if (lastCfgScreen === null) { lastCfgScreen = v; return; }
        if (v !== lastCfgScreen) {
          lastCfgScreen = v;
          setGameVisible(v);
        }
      } catch { /* keep current state */ }
    }, 2000);
  }

  // ── Compositor loop ─────────────────────────────────────────────────────────
  const readFrame = makeFrameReader();
  let prevGrid = null;
  let forceRepaint = false;
  let painting = false;

  const rawReqTimer = setInterval(() => {
    if (gameVisible) writeRawRequest(cols, rows);
  }, 5_000);

  let lastFrameRef = null;
  let lastTermGen = -1;

  // Accumulator pacing — Windows clamps setTimeout to ~15.6ms, so a plain
  // setInterval(33) drifts to ~21fps. Late fires are repaid via
  // setImmediate until the schedule catches up; long stalls are forgiven
  // (clamped to one interval of debt) instead of bursting.
  const paintIntervalMs = 1000 / FPS;
  let nextPaintDue = Date.now() + paintIntervalMs;
  let renderTimer = null;
  const schedulePaint = () => {
    if (exiting) return;
    nextPaintDue = Math.max(nextPaintDue + paintIntervalMs, Date.now() - paintIntervalMs);
    const delay = nextPaintDue - Date.now();
    renderTimer = delay <= 0 ? setImmediate(paintOnce) : setTimeout(paintOnce, delay);
  };
  const paintOnce = () => {
    if (exiting) return;
    if (painting) { schedulePaint(); return; }
    painting = true;
    try {
      const frame = gameVisible ? readFrame() : null;
      // Idle skip: same game frame object AND no new claude output since the
      // last paint → the grid cannot have changed; save the 16k-cell compose.
      // (return passes through finally, which reschedules the loop.)
      if (!forceRepaint && frame === lastFrameRef && termGen === lastTermGen && prevGrid) {
        return;
      }
      lastFrameRef = frame;
      lastTermGen = termGen;
      const bufA = term.buffer.active;
      const vy = bufA.viewportY;
      const lineCache = new Array(rows).fill(undefined);
      const getTermCell = (c, r) => {
        let line = lineCache[r];
        if (line === undefined) {
          line = bufA.getLine(vy + r) ?? null;
          lineCache[r] = line;
        }
        return line ? (line.getCell(c) ?? null) : null;
      };

      const grid = composeGrid({ cols, rows, frame, getTermCell, truecolor: true });
      if (mode === 'game') stampBadge(grid, cols);

      if (forceRepaint) { prevGrid = null; forceRepaint = false; }
      const out = renderDiff(prevGrid, grid, cols, rows, {
        x: Math.min(bufA.cursorX, cols - 1),
        y: Math.min(bufA.cursorY, rows - 1),
        visible: mode === 'claude' && cursorVisible,
      });
      prevGrid = grid;
      if (out) process.stdout.write(out);
    } catch (err) {
      dbg({ event: 'render-error', message: err.message });
    } finally {
      // Reschedule HERE so every exit path (including the idle-skip early
      // return above) keeps the loop alive — recursive pacing has no
      // setInterval safety net.
      painting = false;
      schedulePaint();
    }
  };
  renderTimer = setTimeout(paintOnce, paintIntervalMs);

  dbg({ event: 'boot', cols, rows, fps: FPS, routedInput, cmd: cmdArgs });
}

main().catch((err) => {
  try { process.stdout.write('\x1b[0m\x1b[?1049l\x1b[?25h'); } catch { /* tty gone */ }
  process.stderr.write(`doomscreen fatal: ${err.message}\n`);
  process.exit(1);
});
