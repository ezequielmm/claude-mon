/**
 * screen.test.mjs — universal compositor (doomscreen) test suite.
 *
 * Covers:
 *   1. parseFrameRgb — header validation and pixel payload integrity
 *   2. composeGrid — claude-wins precedence, game transparency, no-frame base
 *   3. renderDiff — full paint, no-change short-circuit, minimal repaint runs
 *   4. xtermCellToCompose — colour modes, attributes, wide-char continuation
 *   5. conhost --headless roundtrip (win32 only — the PTY layer doomscreen
 *      uses on Windows; skipped elsewhere)
 *
 * Standalone:  node test/screen.test.mjs
 * Integrated:  wired as a phase in test/run.mjs (runScreenTests export)
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseFrameRgb,
  composeGrid,
  renderDiff,
  xtermCellToCompose,
} from '../lib/compose.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────────────────────

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}

/**
 * Build a frame.rgb buffer filled with a single colour.
 */
function solidFrame(w, h, [r, g, b]) {
  const buf = Buffer.alloc(4 + w * h * 3);
  buf.writeUInt16LE(w, 0);
  buf.writeUInt16LE(h, 2);
  for (let i = 0; i < w * h; i++) {
    buf[4 + i * 3] = r;
    buf[4 + i * 3 + 1] = g;
    buf[4 + i * 3 + 2] = b;
  }
  return buf;
}

/**
 * Duck-typed fake of an xterm buffer cell.
 */
function fakeCell({
  ch = ' ', width = 1,
  bold = false, dim = false, italic = false, underline = false, inverse = false,
  fgMode = 'default', fgColor = 0,
  bgMode = 'default', bgColor = 0,
} = {}) {
  return {
    getChars: () => ch === ' ' ? '' : ch,
    getWidth: () => width,
    isBold: () => bold,
    isDim: () => dim,
    isItalic: () => italic,
    isUnderline: () => underline,
    isInverse: () => inverse,
    isFgDefault: () => fgMode === 'default',
    isFgPalette: () => fgMode === 'palette',
    isFgRGB: () => fgMode === 'rgb',
    getFgColor: () => fgColor,
    isBgDefault: () => bgMode === 'default',
    isBgPalette: () => bgMode === 'palette',
    isBgRGB: () => bgMode === 'rgb',
    getBgColor: () => bgColor,
  };
}

const blankTerm = () => null;

// ── Shared test runner ────────────────────────────────────────────────────────

export async function runScreenTests(counters, { test: testFn }) {
  // ── parseFrameRgb ───────────────────────────────────────────────────────────

  await testFn('parseFrameRgb: valid buffer roundtrips dims and payload', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [10, 20, 30]));
    assert(frame !== null, 'valid frame must parse');
    assert(frame.w === 8 && frame.h === 4, `dims must be 8x4, got ${frame.w}x${frame.h}`);
    assert(frame.data.length === 8 * 4 * 3, 'payload length must match dims');
    assert(frame.data[0] === 10 && frame.data[1] === 20 && frame.data[2] === 30,
      'first pixel must be (10,20,30)');
  });

  await testFn('parseFrameRgb: truncated / corrupt buffers return null', () => {
    assert(parseFrameRgb(null) === null, 'null buffer');
    assert(parseFrameRgb(Buffer.alloc(2)) === null, 'short buffer');
    const bad = solidFrame(8, 4, [0, 0, 0]).subarray(0, 20);
    assert(parseFrameRgb(bad) === null, 'truncated payload');
    const zero = Buffer.alloc(4);
    assert(parseFrameRgb(zero) === null, 'zero dims');
  });

  // ── composeGrid precedence ──────────────────────────────────────────────────

  await testFn('composeGrid: claude char wins over the game layer', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [200, 0, 0]));
    const cells = { 0: fakeCell({ ch: 'X' }) };
    const grid = composeGrid({
      cols: 4, rows: 2, frame,
      getTermCell: (c, r) => cells[r * 4 + c] ?? null,
      truecolor: true,
    });
    assert(grid.ch[0] === 'X', `cell 0 must be claude's X, got ${JSON.stringify(grid.ch[0])}`);
    assert(grid.bg[0] === '\x1b[49m', 'claude cell without own bg gets the 49 halo');
    assert(grid.bg[1].includes('48;2;200;0;0') || grid.fg[1].includes('38;2;200;0;0'),
      `cell 1 must carry game red, got fg=${JSON.stringify(grid.fg[1])} bg=${JSON.stringify(grid.bg[1])}`);
  });

  await testFn('composeGrid: space with explicit bg wins (claude highlight)', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [0, 200, 0]));
    const cells = { 0: fakeCell({ ch: ' ', bgMode: 'palette', bgColor: 4 }) };
    const grid = composeGrid({
      cols: 4, rows: 2, frame,
      getTermCell: (c, r) => cells[r * 4 + c] ?? null,
      truecolor: true,
    });
    assert(grid.ch[0] === ' ', 'cell stays a space');
    assert(grid.bg[0] === '\x1b[48;5;4m', `bg must be palette 4, got ${JSON.stringify(grid.bg[0])}`);
  });

  await testFn('composeGrid: space with default bg is transparent (game shows)', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [0, 0, 180]));
    const grid = composeGrid({
      cols: 4, rows: 2, frame,
      getTermCell: () => fakeCell({ ch: ' ' }),
      truecolor: true,
    });
    const blue = grid.bg[0].includes('0;0;180') || grid.fg[0].includes('0;0;180');
    assert(blue, `game blue must show through, got fg=${JSON.stringify(grid.fg[0])} bg=${JSON.stringify(grid.bg[0])}`);
  });

  await testFn('composeGrid: no frame → blank default-bg base', () => {
    const grid = composeGrid({
      cols: 3, rows: 2, frame: null, getTermCell: blankTerm, truecolor: true,
    });
    assert(grid.ch.every((c) => c === ' '), 'all cells blank');
    assert(grid.bg.every((b) => b === '\x1b[49m'), 'all cells default bg');
  });

  // ── renderDiff ──────────────────────────────────────────────────────────────

  await testFn('renderDiff: full paint positions every row and parks cursor', () => {
    const frame = parseFrameRgb(solidFrame(8, 4, [120, 60, 30]));
    const grid = composeGrid({
      cols: 4, rows: 2, frame, getTermCell: blankTerm, truecolor: true,
    });
    const out = renderDiff(null, grid, 4, 2, { x: 1, y: 1, visible: true });
    assert(out.includes('\x1b[1;1H'), 'row 1 positioned');
    assert(out.includes('\x1b[2;1H'), 'row 2 positioned');
    assert(out.startsWith('\x1b[?2026h'), 'sync-output begin');
    assert(out.endsWith('\x1b[?2026l'), 'sync-output end');
    assert(out.includes('\x1b[2;2H\x1b[?25h'), 'cursor parked at (1,1) and visible');
  });

  await testFn('renderDiff: identical grids → cursor park only, no sync wrap', () => {
    const grid = composeGrid({
      cols: 3, rows: 2, frame: null, getTermCell: blankTerm, truecolor: true,
    });
    const out = renderDiff(grid, grid, 3, 2, { x: 0, y: 0, visible: false });
    assert(!out.includes('\x1b[?2026h'), 'no sync wrapper when nothing changed');
    assert(out === '\x1b[1;1H\x1b[?25l', `park only, got ${JSON.stringify(out)}`);
  });

  await testFn('renderDiff: single cell change → exactly one reposition', () => {
    const a = composeGrid({
      cols: 5, rows: 3, frame: null, getTermCell: blankTerm, truecolor: true,
    });
    const cells = { [1 * 5 + 2]: fakeCell({ ch: 'Z' }) };
    const b = composeGrid({
      cols: 5, rows: 3, frame: null,
      getTermCell: (c, r) => cells[r * 5 + c] ?? null,
      truecolor: true,
    });
    const out = renderDiff(a, b, 5, 3, { x: 0, y: 0, visible: true });
    const repositions = out.match(/\x1b\[\d+;\d+H/g) ?? [];
    // One for the changed run + one cursor park
    assert(repositions.length === 2, `expected 2 positionings, got ${repositions.length}: ${JSON.stringify(out)}`);
    assert(out.includes('\x1b[2;3H'), `run must start at row 2 col 3, got ${JSON.stringify(out)}`);
    assert(out.includes('Z'), 'changed glyph present');
  });

  // ── xtermCellToCompose ──────────────────────────────────────────────────────

  await testFn('xtermCellToCompose: RGB fg and attributes encode into SGR', () => {
    const cell = fakeCell({ ch: 'A', bold: true, fgMode: 'rgb', fgColor: (250 << 16) | (100 << 8) | 25 });
    const c = xtermCellToCompose(cell);
    assert(c.wins, 'printable char wins');
    assert(c.fg === '\x1b[0;1;38;2;250;100;25m', `got ${JSON.stringify(c.fg)}`);
  });

  await testFn('xtermCellToCompose: width-0 continuation emits nothing, skipped by diff', () => {
    const cont = xtermCellToCompose(fakeCell({ width: 0 }));
    assert(cont.ch === '' && cont.wins, 'continuation: empty glyph, still claims the cell');

    const cells = { 0: fakeCell({ ch: '日', width: 2 }), 1: fakeCell({ width: 0 }) };
    const grid = composeGrid({
      cols: 3, rows: 1, frame: null,
      getTermCell: (c, r) => cells[r * 3 + c] ?? null,
      truecolor: true,
    });
    const out = renderDiff(null, grid, 3, 1, { x: 0, y: 0, visible: true });
    const wideIdx = out.indexOf('日');
    assert(wideIdx !== -1, 'wide char rendered');
    // The continuation cell must not inject a glyph between 日 and the next cell
    const after = out.slice(wideIdx + '日'.length);
    assert(!after.startsWith('日'), 'no duplicate wide glyph');
  });

  // ── Brain core (pure) ───────────────────────────────────────────────────────

  await testFn('brain: extractPlan digs JSON out of prose/fences and normalizes', async () => {
    const { extractPlan } = await import('../lib/brain-core.mjs');
    const p1 = extractPlan('Sure! ```json\n{"move":"forward","turn":"left","turnMs":500,"fire":true,"use":false,"note":"monster ahead"}\n```');
    assert(p1 !== null && p1.move === 'forward' && p1.turn === 'left' && p1.turnMs === 500 && p1.fire === true,
      `plan must parse, got ${JSON.stringify(p1)}`);
    const p2 = extractPlan('{"move":"weird","turn":"right"}');
    assert(p2.move === 'forward' && p2.turn === 'right' && p2.turnMs === 300,
      `invalid move falls back to forward, default turnMs 300; got ${JSON.stringify(p2)}`);
    assert(extractPlan('no json here') === null, 'prose without JSON → null');
    assert(extractPlan('{broken') === null, 'broken JSON → null');
  });

  await testFn('pokemon brain: extractGbaStep reads buttons + dialog, filters junk, caps length', async () => {
    const { extractGbaStep, GBA_BUTTON_CODES } = await import('../lib/brain-core.mjs');
    const dlg = extractGbaStep('ok ```json\n{"buttons":["a"],"note":"PROF OAK: Are you a boy?"}\n```');
    assert(dlg && dlg.buttons.length === 1 && dlg.buttons[0] === 'a', `dialog advance, got ${JSON.stringify(dlg)}`);
    assert(dlg.note.includes('OAK'), 'note carries the read text');
    const menu = extractGbaStep('{"buttons":["down","down","a","jump","select"],"note":"menu"}');
    assert(JSON.stringify(menu.buttons) === '["down","down","a","select"]',
      `invalid "jump" dropped, valid kept, got ${JSON.stringify(menu.buttons)}`);
    const overrun = extractGbaStep('{"buttons":["a","a","a","a","a","a","a","a"]}');
    assert(overrun.buttons.length === 6, `capped at 6, got ${overrun.buttons.length}`);
    assert(extractGbaStep('{"press":"start"}').buttons[0] === 'start', 'press alias works');
    assert(GBA_BUTTON_CODES.a === 0xa2 && GBA_BUTTON_CODES.b === 0xa3, 'A/B map to USE/FIRE wire codes');
    assert(extractGbaStep('no json here') === null, 'prose → null');
  });

  await testFn('brain: planHeldKeys expires the turn, keeps movement and fire', async () => {
    const { extractPlan, planHeldKeys } = await import('../lib/brain-core.mjs');
    const plan = extractPlan('{"move":"forward","turn":"right","turnMs":400,"fire":true}');
    const early = planHeldKeys(plan, 100);
    assert(early.includes(0xad) && early.includes(0xae) && early.includes(0xa3),
      `early: forward+right+fire, got ${JSON.stringify(early)}`);
    const late = planHeldKeys(plan, 900);
    assert(late.includes(0xad) && !late.includes(0xae) && late.includes(0xa3),
      `after turnMs: turn released, rest held; got ${JSON.stringify(late)}`);
  });

  await testFn('cortex: extractOrder normalizes goals and clamps duration', async () => {
    const { extractOrder } = await import('../lib/brain-core.mjs');
    const o1 = extractOrder('plan: {"goal":"explore_left","durationMs":9000,"note":"dark opening west"}');
    assert(o1 !== null && o1.goal === 'explore_left' && o1.durationMs === 9000,
      `order must parse, got ${JSON.stringify(o1)}`);
    const o2 = extractOrder('{"goal":"dance","durationMs":999999}');
    assert(o2.goal === 'advance' && o2.durationMs === 25_000,
      `unknown goal → advance, duration clamped; got ${JSON.stringify(o2)}`);
    assert(extractOrder('nope') === null, 'no JSON → null');
  });

  await testFn('cortex: frameToAsciiGrid marks red, bright, dark and MOTION', async () => {
    const { frameToAsciiGrid } = await import('../lib/brain-core.mjs');
    const { parseFrameRgb: parse } = await import('../lib/compose.mjs');
    const mk = (paint) => {
      const w = 80, h = 24;
      const buf = Buffer.alloc(4 + w * h * 3);
      buf.writeUInt16LE(w, 0); buf.writeUInt16LE(h, 2);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [r, g, b] = paint(x, y);
        const o = 4 + (y * w + x) * 3;
        buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
      }
      return parse(buf);
    };
    const a = mk((x) => x < 20 ? [200, 30, 10] : x < 40 ? [150, 150, 150] : [20, 20, 20]);
    const grid1 = frameToAsciiGrid(a, null, 20, 6);
    assert(grid1.includes('%'), 'red zone marked %');
    assert(grid1.includes('#'), 'bright zone marked #');
    assert(grid1.includes(' '), 'dark zone marked space');
    // Same scene with a moved bright block → motion glyphs
    const b = mk((x) => x < 20 ? [200, 30, 10] : x < 40 ? [20, 20, 20] : x < 60 ? [150, 150, 150] : [20, 20, 20]);
    const grid2 = frameToAsciiGrid(b, a, 20, 6);
    assert(grid2.includes('!'), `moved block must be marked !, got:\n${grid2}`);
  });

  // ── Statusline inside the compositor: HUD only, no floating banner ─────────

  await testFn('statusline: AFK_DOOMSCREEN_INNER emits a single HUD line (no banner rows)', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath,
      ['--no-warnings', path.join(ROOT, 'scripts', 'statusline.mjs')], {
        input: '{"model":{"display_name":"T"},"session_id":"s"}',
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, AFK_DOOMSCREEN_INNER: '1', COLUMNS: '80', LINES: '30' },
      });
    const lines = (r.stdout ?? '').split('\n').filter((l) => l.length > 0);
    assert(lines.length === 1, `exactly one HUD line, got ${lines.length}`);
    assert(!r.stdout.includes('▀') && !r.stdout.includes('▄') && !r.stdout.includes('▌'),
      'no block glyphs — the banner must not float over the fullscreen game');
  });

  if (process.platform === 'win32') {
    await testFn('afk-ctl arcade --print composes an absolute-path launch command', async () => {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath,
        ['--no-warnings', path.join(ROOT, 'scripts', 'afk-ctl.mjs'), 'arcade', '--print'],
        { encoding: 'utf8', timeout: 30_000 });
      assert(r.status === 0, `exit 0 expected, got ${r.status}`);
      const cmd = r.stdout.trim();
      assert(cmd.includes('doomscreen.mjs'), `must launch the compositor, got: ${cmd.slice(0, 160)}`);
      assert(cmd.includes('--continue'), 'must resume the conversation (claude --continue)');
      assert(/claude\.cmd|npm[\\/]claude/i.test(cmd), `must wrap the REAL claude by absolute path, got: ${cmd.slice(0, 200)}`);
      assert(!cmd.includes('claude-mon\\bin'), 'must NOT depend on the PATH shim');
    });
  }

  // ── conhost --headless roundtrip (win32 only) ──────────────────────────────

  if (process.platform === 'win32') {
    await testFn('conhost --headless: VT output + plain input roundtrip + exit code', async () => {
      const result = await new Promise((resolve) => {
        const c = spawn('conhost.exe', [
          '--headless', '--width', '80', '--height', '24', '--',
          'cmd.exe', '/v:on', '/c', 'set /p X=prompt: && echo GOT=!X!',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        setTimeout(() => c.stdin.write('hello\r\n'), 1500);
        const t = setTimeout(() => { c.kill(); resolve({ out, code: -1 }); }, 15_000);
        c.on('exit', (code) => { clearTimeout(t); resolve({ out, code }); });
      });
      assert(result.code === 0, `conhost child must exit 0, got ${result.code}`);
      assert(result.out.includes('GOT=hello'),
        `input must roundtrip, output tail: ${JSON.stringify(result.out.slice(-120))}`);
      assert(result.out.includes('\x1b['), 'output must be a VT stream');
    });
    await testFn('doomscreen e2e: typing reaches child, F8-mode drives control.json, alt-screen', async () => {
      const os = await import('node:os');
      const fs = await import('node:fs');
      const CONTROL = path.join(os.tmpdir(), 'claude-mon', 'doom', 'control.json');
      try { fs.unlinkSync(CONTROL); } catch { /* absent */ }

      // doomscreen needs a TTY — an outer headless conhost provides one, and
      // we drive its keyboard from out here. Full §5 drill, no human needed.
      // Note: this spawns the shared daemon; the doom phase / watchdog owns
      // its lifecycle, so no teardown here.
      const result = await new Promise((resolve) => {
        const outer = spawn('conhost.exe', [
          '--headless', '--width', '100', '--height', '30', '--',
          'node', '--no-warnings', path.join(ROOT, 'scripts', 'doomscreen.mjs'),
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, AFK_DOOMSCREEN_CMD: 'cmd.exe' },
        });
        let out = '';
        outer.stdout.on('data', (d) => { out += d; });
        setTimeout(() => outer.stdin.write('echo HELLO_E2E\r'), 5000);
        setTimeout(() => outer.stdin.write('\x1d'), 8000);            // Ctrl+] → game
        let wTimer = null;
        setTimeout(() => {
          // hold W only after the toggle — terminal-autorepeat style
          wTimer = setInterval(() => {
            try { outer.stdin.write('w'); } catch { /* closing */ }
          }, 100);
        }, 8600);
        setTimeout(() => {
          clearInterval(wTimer);
          let ctl = null;
          try { ctl = JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch { /* missing */ }
          outer.kill();
          resolve({ out, ctl });
        }, 11_500);
      });

      assert(result.out.includes('\x1b[?1049h'), 'alt-screen must be entered');
      assert(result.out.includes('HELLO_E2E'),
        'typed command must reach the wrapped child and composite back');
      assert(result.out.includes('F8: back to Claude'), 'game-mode badge must render');
      assert(result.ctl !== null, 'control.json must exist after game-mode input');
      assert(Array.isArray(result.ctl.held) && result.ctl.held.includes(0xad),
        `held W must map to KEY_UPARROW 0xad, got ${JSON.stringify(result.ctl?.held)}`);
    });
    await testFn('wrap shim: piped invocation passes through untouched (no alt-screen)', async () => {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [
        '--no-warnings', path.join(ROOT, 'scripts', 'doomscreen.mjs'),
        '--wrap', 'cmd.exe', '--', '/c', 'echo WRAP_PASS',
      ], { encoding: 'utf8', timeout: 30_000 });
      assert(r.status === 0, `exit must be 0, got ${r.status}; stderr: ${r.stderr?.slice(0, 200)}`);
      assert(r.stdout.includes('WRAP_PASS'), `real command output must flow, got ${JSON.stringify(r.stdout.slice(0, 120))}`);
      assert(!r.stdout.includes('\x1b[?1049h'), 'no alt-screen on a pipe — transparent passthrough');
    });

    await testFn('wrap shim: config screen=false passes through even on a TTY', async () => {
      const os2 = await import('node:os');
      const fs2 = await import('node:fs');
      const cfgDir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'afk-shim-cfg-'));
      fs2.writeFileSync(path.join(cfgDir, 'config.json'),
        JSON.stringify({ enabled: true, game: 'doom', screen: false }));
      try {
        const result = await new Promise((resolve) => {
          const outer = spawn('conhost.exe', [
            '--headless', '--width', '90', '--height', '25', '--',
            'node', '--no-warnings', path.join(ROOT, 'scripts', 'doomscreen.mjs'),
            '--wrap', 'cmd.exe', '--', '/c', 'echo SCREEN_OFF_PASS',
          ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, AFK_ARCADE_CONFIG_DIR: cfgDir },
          });
          let out = '';
          outer.stdout.on('data', (d) => { out += d; });
          const t = setTimeout(() => { outer.kill(); resolve({ out, code: -1 }); }, 20_000);
          outer.on('exit', (code) => { clearTimeout(t); resolve({ out, code }); });
        });
        assert(result.code === 0, `exit must be 0, got ${result.code}`);
        assert(result.out.includes('SCREEN_OFF_PASS'), 'real output must flow');
        assert(!result.out.includes('\x1b[?1049h'),
          'screen=false must NOT composite even on a real console');
      } finally {
        try { fs2.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    await testFn('wrap shim: opt-in only — composites with screen:true, passes through otherwise', async () => {
      const os2 = await import('node:os');
      const fs2 = await import('node:fs');
      const run = (cfgJson) => new Promise((resolve) => {
        const cfgDir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'afk-optin-'));
        fs2.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfgJson));
        const outer = spawn('conhost.exe', [
          '--headless', '--width', '90', '--height', '25', '--',
          'node', '--no-warnings', path.join(ROOT, 'scripts', 'doomscreen.mjs'),
          '--wrap', 'cmd.exe', '--', '/c', 'echo OPTIN_PROBE',
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, AFK_ARCADE_CONFIG_DIR: cfgDir },
        });
        let out = '';
        outer.stdout.on('data', (d) => { out += d; });
        const t = setTimeout(() => { outer.kill(); resolve(out); }, 12_000);
        outer.on('exit', () => { clearTimeout(t); setTimeout(() => resolve(out), 300); });
      });
      const on = await run({ enabled: true, game: 'doom', screen: true });
      assert(on.includes('\x1b[?1049h'),
        `screen:true must composite, got ${JSON.stringify(on.slice(0, 120))}`);
      const unset = await run({ enabled: true, game: 'doom' });
      assert(!unset.includes('\x1b[?1049h') && unset.includes('OPTIN_PROBE'),
        'screen unset must pass through (opt-in default)');
    });
  } else {
    process.stdout.write('SKIP  conhost --headless roundtrip — win32 only\n');
    process.stdout.write('SKIP  doomscreen e2e — win32 only\n');
  }

  // ── Compositor-implied bot (daemon contract, needs vendor assets) ──────────

  const fs = await import('node:fs');
  const os = await import('node:os');
  const vendorOk = ['doom.js', 'doom.wasm', 'doom1.wad'].every((f) => {
    try { return fs.statSync(path.join(ROOT, 'vendor', 'doom', f)).size > 1000; }
    catch { return false; }
  });

  if (vendorOk) {
    await testFn('daemon: fresh raw-request implies bot even with config.bot=false', async () => {
      const doomTmp = path.join(os.tmpdir(), 'claude-mon', 'doom');
      const pidFile = path.join(doomTmp, 'daemon.pid');
      const shutdownFile = path.join(doomTmp, 'daemon.shutdown');
      const botStatus = path.join(doomTmp, 'bot-status.json');
      const rawRequest = path.join(doomTmp, 'raw-request.json');

      const waitFor = (pred, maxMs, step = 250) => new Promise((resolve) => {
        const deadline = Date.now() + maxMs;
        const poll = () => {
          if (pred()) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, step);
        };
        poll();
      });
      const shutdown = async () => {
        try { fs.writeFileSync(shutdownFile, 'screen-test'); } catch { /* ignore */ }
        await waitFor(() => { try { fs.statSync(pidFile); return false; } catch { return true; } }, 6000);
      };

      // The daemon is a machine-wide singleton (named pipe on win32) — stop
      // any live instance first, exactly like the doom phase does.
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid > 0) await shutdown();
      } catch { /* none running */ }
      // A doomscreen lingering from the e2e drill above keeps rewriting
      // raw-request every 5s and would poison the negative phase — it
      // publishes its pid in the file; kill it, then re-delete after a
      // grace beat in case a final write raced the first unlink.
      try {
        const req = JSON.parse(fs.readFileSync(rawRequest, 'utf8'));
        if (req.pid > 0) { try { process.kill(req.pid); } catch { /* gone */ } }
      } catch { /* absent or unreadable */ }
      for (const f of [botStatus, rawRequest, shutdownFile]) {
        try { fs.unlinkSync(f); } catch { /* absent */ }
      }
      await new Promise((r) => setTimeout(r, 1200));
      for (const f of [botStatus, rawRequest]) {
        try { fs.unlinkSync(f); } catch { /* absent */ }
      }

      // Isolated config dir with bot explicitly OFF
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-screen-cfg-'));
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        enabled: true, game: 'fire', rows: 5, bot: false,
      }));

      const daemon = spawn(process.execPath,
        ['--no-warnings', path.join(ROOT, 'scripts', 'daemon.mjs')],
        { env: { ...process.env, AFK_ARCADE_CONFIG_DIR: cfgDir }, stdio: 'ignore', detached: true });
      daemon.unref();

      try {
        const booted = await waitFor(() => {
          try { return fs.statSync(pidFile).size > 0; } catch { return false; }
        }, 15_000);
        assert(booted, 'daemon must boot (pidfile)');

        // No raw-request yet → no bot block → no bot-status.json
        await new Promise((r) => setTimeout(r, 3500));
        assert(!fs.existsSync(botStatus),
          'bot-status.json must NOT appear while config.bot=false and no compositor');

        // Compositor arrives
        fs.writeFileSync(rawRequest, JSON.stringify({ cols: 60, rows: 20 }));
        const botLive = await waitFor(() => fs.existsSync(botStatus), 20_000);
        assert(botLive, 'bot-status.json must appear once raw-request is fresh (implied bot)');
      } finally {
        await shutdown();
        try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  } else {
    process.stdout.write('SKIP  compositor-implied bot — vendor/doom assets absent\n');
  }
}

// ── Standalone runner ─────────────────────────────────────────────────────────

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

  await runScreenTests(null, { test });

  process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runStandalone().catch((err) => {
    process.stderr.write(`screen.test.mjs fatal: ${err.message}\n`);
    process.exit(1);
  });
}
