/**
 * gba.test.mjs — GBA engine adapter + daemon integration.
 *
 * Skips cleanly when vendor/gba is absent (run scripts/fetch-gba.mjs).
 * The daemon e2e runs FULLY ISOLATED (own config dir, own TMP root, own
 * pipe suffix) so it never fights the user's live daemon.
 *
 * Standalone:  node test/gba.test.mjs
 * Integrated:  Phase J in test/run.mjs (runGbaTests export)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_ROM = path.join(ROOT, 'vendor', 'gba', 'test', 'brin_demo.gba');

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed');
}

function vendorPresent() {
  try {
    return fs.statSync(path.join(ROOT, 'vendor', 'gba', 'gbajs', 'js', 'gba.js')).size > 1000 &&
           fs.statSync(TEST_ROM).size > 1000;
  } catch {
    return false;
  }
}

const waitFor = (pred, maxMs, step = 250) => new Promise((resolve) => {
  const deadline = Date.now() + maxMs;
  const poll = () => {
    if (pred()) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(poll, step);
  };
  poll();
});

export async function runGbaTests(counters, { test: testFn }) {
  if (!vendorPresent()) {
    process.stdout.write(
      'SKIP  [gba] vendor/gba absent — run: node scripts/fetch-gba.mjs\n');
    return;
  }

  await testFn('gba engine: contract — boot, realtime tick, frame, input', async () => {
    const { createGba } = await import('../lib/gba-engine.mjs');
    const eng = await createGba(TEST_ROM);
    assert(eng.width === 240 && eng.height === 160, 'GBA dims');
    assert(eng.dimensionsKnown === true, 'dimensions are fixed/known');

    // ~600ms of real time should advance ~36 emulator frames via pacing
    const t0 = Date.now();
    while (Date.now() - t0 < 600) {
      eng.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    const rgb1 = Buffer.from(eng.getFrameRGB());
    assert(rgb1.length === 240 * 160 * 3, 'frame RGB length');
    assert(rgb1.some((b) => b > 0), 'frame has content');

    // Hold RIGHT (DOOM wire code 0xae) — brin_demo scrolls its map
    eng.pushKey(1, 0xae);
    const t1 = Date.now();
    while (Date.now() - t1 < 700) {
      eng.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    eng.pushKey(0, 0xae);
    const rgb2 = Buffer.from(eng.getFrameRGB());
    assert(!rgb1.equals(rgb2), 'input must move the view');
    eng.dispose();
  });

  await testFn('gba daemon e2e (isolated): frame.rgb streams, user control drives', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-gba-iso-'));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-gba-cfg-'));
    const P = path.join(tmpRoot, 'doom');
    const f = (n) => path.join(P, n);
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
      enabled: true, game: 'gba', gbaRom: TEST_ROM,
    }));
    fs.mkdirSync(P, { recursive: true });
    fs.writeFileSync(f('viewport.json'),
      JSON.stringify({ cols: 80, pxRows: 20, truecolor: true }));
    fs.writeFileSync(f('raw-request.json'), JSON.stringify({ cols: 120, rows: 40 }));

    const env = {
      ...process.env,
      AFK_ARCADE_CONFIG_DIR: cfgDir,
      AFK_ARCADE_TMPDIR: tmpRoot,
      AFK_ARCADE_PIPE_SUFFIX: '-gbatest',
    };
    const daemon = spawn(process.execPath,
      ['--no-warnings', path.join(ROOT, 'scripts', 'daemon.mjs')],
      { detached: true, stdio: 'ignore', env });
    daemon.unref();

    const keep = setInterval(() => {
      try { fs.writeFileSync(f('raw-request.json'), JSON.stringify({ cols: 120, rows: 40 })); }
      catch { /* ignore */ }
    }, 4000);

    const sig = () => {
      try {
        const b = fs.readFileSync(f('frame.rgb'));
        let s = 0;
        for (let i = 4; i < b.length; i += 97) s += b[i] * (i % 251);
        return s;
      } catch { return -1; }
    };

    try {
      const streaming = await waitFor(() => sig() !== -1, 20_000);
      assert(streaming, 'frame.rgb must appear (GBA daemon boot)');
      const b = fs.readFileSync(f('frame.rgb'));
      assert(b.readUInt16LE(0) === 240 && b.readUInt16LE(2) === 80,
        `raw dims must be 240x80, got ${b.readUInt16LE(0)}x${b.readUInt16LE(2)}`);

      const s1 = sig();
      const ut = setInterval(() => {
        try {
          fs.writeFileSync(f('control.json'), JSON.stringify(
            { heartbeat: Date.now(), held: [0xae], taps: [], pid: 1 }));
        } catch { /* ignore */ }
      }, 150);
      await new Promise((r) => setTimeout(r, 2500));
      clearInterval(ut);
      fs.writeFileSync(f('control.json'),
        JSON.stringify({ heartbeat: 0, held: [], taps: [], pid: 1 }));
      const s2 = sig();
      assert(s1 !== s2,
        'user control (held RIGHT) must scroll the GBA view — arbitration must run without a bot');
    } finally {
      clearInterval(keep);
      try { fs.writeFileSync(f('daemon.shutdown'), 'gba-test'); } catch { /* ignore */ }
      await waitFor(() => {
        try { fs.statSync(f('daemon.pid')); return false; } catch { return true; }
      }, 6000);
      try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
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
  await runGbaTests(null, { test });
  process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runStandalone().catch((err) => {
    process.stderr.write(`gba.test.mjs fatal: ${err.message}\n`);
    process.exit(1);
  });
}
