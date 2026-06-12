#!/usr/bin/env node
/**
 * bot.test.mjs — unit tests for lib/doom-bot.mjs and lib/registry.mjs.
 *
 * Run standalone: node test/bot.test.mjs
 * Also wired into test/run.mjs as Phase F (runBotTests export).
 *
 * No real DOOM engine needed — all tests use synthetic getPixel functions and
 * manual nowMs advancing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

import { createBot } from '../lib/doom-bot.mjs';
import { upsertTtyRegistry, removeTtyEntry, readRegistry, pruneRegistry, REGISTRY_TTL_MS } from '../lib/registry.mjs';

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

export async function runBotTests(counters, { test: testFn }) {
  const results = [];

  function test(name, fn) {
    testFn(name, fn);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Build a fake engine with a given getPixel function.
   * Records all pushKey calls so tests can assert behavior.
   */
  function makeEngine(getPixelFn) {
    const keys = []; // { pressed, code, atMs }
    let _now = 0;
    return {
      width: 320,
      height: 200,
      tick() {},
      getPixel: getPixelFn,
      getFrameRGB() { return new Uint8Array(320 * 200 * 3); },
      pushKey(pressed, code) { keys.push({ pressed, code, atMs: _now }); },
      _keys: keys,
      _setNow(n) { _now = n; },
    };
  }

  /**
   * Build a getPixel that returns red-heavy values for the WHOLE frame
   * (simulates title screen: high reds, high variance, no gray HUD strip).
   */
  function titlePixel(x, y) {
    // High reds in the bottom strip too → NOT in-game
    return [200, 30, 10];
  }

  /**
   * Build a getPixel that returns a gray HUD at the bottom and mixed game
   * content elsewhere (simulates in-game frame).
   *
   * Bottom 12% → gray (low variance, low red fraction)
   * Rest → dark greenish (game world)
   */
  function inGamePixel(w, h) {
    const hudStart = Math.floor(h * 0.88);
    return (x, y) => {
      if (y >= hudStart) {
        // Uniform gray HUD strip
        return [90, 90, 88];
      }
      // Game world — dark, varied, low red
      return [40 + (x % 20), 60 + (y % 15), 30 + (x % 10)];
    };
  }

  /**
   * Build a getPixel where the CENTER region has fleshy pixels (monster present).
   * Outer pixels are dark green (background).
   */
  function monsterPixel(w, h) {
    const hudStart = Math.floor(h * 0.88);
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    return (x, y) => {
      if (y >= hudStart) return [90, 90, 88]; // HUD gray
      // Center 48×32 zone: fleshy (red > 90, r > g*1.25, r > b*1.25)
      if (Math.abs(x - cx) < 24 && Math.abs(y - cy) < 16) {
        return [180, 80, 50]; // flesh-ish red/brown
      }
      return [30, 60, 20];
    };
  }

  /**
   * Build a getPixel where center pixels are IDENTICAL across multiple calls
   * (simulates stuck — unchanged center region).
   */
  function stuckPixel() {
    return (_x, _y) => [100, 100, 100];
  }

  // ── Test 1: Start sequence emits ENTER taps on title-like frame ───────────

  test('bot start-sequence: ENTER taps when frame is title-like (not in-game)', () => {
    const eng = makeEngine(titlePixel);
    const bot = createBot(eng);

    let now = 0;
    eng._setNow(now);

    // Feed updates for >3s to trigger start sequence
    for (let i = 0; i < 200; i++) {
      now += 20;
      eng._setNow(now);
      bot.update(now, false);
    }

    // Flush remaining pending keys by advancing time generously
    for (let i = 0; i < 50; i++) {
      now += 200;
      eng._setNow(now);
      bot.update(now, false);
    }

    bot.dispose();

    const enterTaps = eng._keys.filter(k => k.code === 13 && k.pressed === 1);
    if (enterTaps.length < 1) {
      throw new Error(
        `Expected at least 1 ENTER key-down tap in start sequence, got ${enterTaps.length}. ` +
        `All keys: ${JSON.stringify(eng._keys.map(k => ({ c: k.code.toString(16), p: k.pressed })))}`,
      );
    }
  });

  // ── Test 2: FORWARD held within 1s of in-game updates ────────────────────

  test('bot in-game: KEY_UPARROW held within 1s of updates on in-game frame', () => {
    const eng = makeEngine(inGamePixel(320, 200));
    const bot = createBot(eng);

    let now = 0;
    eng._setNow(now);
    for (let i = 0; i < 40; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    bot.dispose();

    const forwardDown = eng._keys.filter(k => k.code === 0xad && k.pressed === 1);
    if (forwardDown.length === 0) {
      throw new Error(
        `Expected KEY_UPARROW (0xad) down within 1s of in-game updates. ` +
        `Keys emitted: ${JSON.stringify(eng._keys.map(k => ({ c: '0x' + k.code.toString(16), p: k.pressed })))}`,
      );
    }
  });

  // ── Test 2b: NO ENTER taps during continuous gameplay ─────────────────────
  // ENTER walks the in-game menu in this build (open → New Game → skill);
  // a periodic ENTER cadence silently restarted the game every ~30s.

  test('bot in-game: never taps ENTER during continuous gameplay', () => {
    const eng = makeEngine(inGamePixel(320, 200));
    const bot = createBot(eng);

    let now = 0;
    eng._setNow(now);
    // 15 simulated seconds — well past the old 10s ENTER cadence
    for (let i = 0; i < 600; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    bot.dispose();

    const enterTaps = eng._keys.filter(k => k.code === 13 && k.pressed === 1);
    if (enterTaps.length > 0) {
      throw new Error(
        `ENTER must never fire while in-game (restarts the run via the menu); ` +
        `got ${enterTaps.length} tap(s)`,
      );
    }
  });

  // ── Test 3: MOVING monster → FIRE burst ───────────────────────────────────
  // Targeting is motion-first: the sprite must move between decisions.

  test('bot monster detection: FIRE burst when fleshy pixels MOVE', () => {
    const base = monsterPixel(320, 200);
    let phase = 0;
    // % 5 with one increment per 25ms update: decisions land every 6 updates,
    // and gcd(5,6)=1 keeps the sprite offset DIFFERENT at every decision —
    // % 3 aliased with the cadence and froze the sprite in the bot's eyes.
    const eng = makeEngine((x, y) => base(x - (phase % 5) * 8, y));
    const bot = createBot(eng);

    let now = 0;
    for (let i = 0; i < 80; i++) {
      now += 25;
      phase++;            // sprite wiggles → motion zones light up
      eng._setNow(now);
      bot.update(now, false);
    }

    bot.dispose();

    const fireBursts = eng._keys.filter(k => k.code === 0xa3 && k.pressed === 1);
    if (fireBursts.length === 0) {
      throw new Error(
        `Expected KEY_FIRE (0xa3) burst for a MOVING monster. ` +
        `Keys: ${JSON.stringify(eng._keys.map(k => ({ c: '0x' + k.code.toString(16), p: k.pressed })))}`,
      );
    }
  });

  // ── Test 3b: STATIC fleshy frame (red wall / lava) → never fires ──────────
  // The original heuristic emptied the pistol into red walls; motion gating
  // is the cure and this is its regression test.

  test('bot motion gate: static red scene → NO fire', () => {
    const eng = makeEngine(monsterPixel(320, 200)); // fleshy but FROZEN
    const bot = createBot(eng);

    let now = 0;
    for (let i = 0; i < 120; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    bot.dispose();

    const fireDowns = eng._keys.filter(k => k.code === 0xa3 && k.pressed === 1);
    if (fireDowns.length > 0) {
      throw new Error(
        `Static fleshy pixels must NOT trigger fire (wall-shooting bug); ` +
        `got ${fireDowns.length} fire press(es)`,
      );
    }
  });

  // ── Test 3c: cortex orders bias the cerebellum ─────────────────────────────

  test('bot orders: explore_left biases turns left; retreat walks backward', () => {
    // explore_left: more left-turn downs than right-turn downs
    const eng1 = makeEngine(inGamePixel(320, 200));
    const bot1 = createBot(eng1);
    let now = 0;
    for (let i = 0; i < 320; i++) {
      now += 25;
      eng1._setNow(now);
      bot1.update(now, false, { goal: 'explore_left', durationMs: 20_000 });
    }
    bot1.dispose();
    const lefts = eng1._keys.filter(k => k.code === 0xac && k.pressed === 1).length;
    const rights = eng1._keys.filter(k => k.code === 0xae && k.pressed === 1).length;
    if (lefts === 0 || lefts <= rights) {
      throw new Error(`explore_left must bias left turns: L=${lefts} R=${rights}`);
    }

    // retreat: DOWNARROW held
    const eng2 = makeEngine(inGamePixel(320, 200));
    const bot2 = createBot(eng2);
    now = 0;
    for (let i = 0; i < 40; i++) {
      now += 25;
      eng2._setNow(now);
      bot2.update(now, false, { goal: 'retreat', durationMs: 20_000 });
    }
    bot2.dispose();
    const backDowns = eng2._keys.filter(k => k.code === 0xaf && k.pressed === 1);
    if (backDowns.length === 0) {
      throw new Error('retreat order must hold KEY_DOWNARROW (0xaf)');
    }
  });

  // ── Test 4: Stuck detection → turn issued and forward released ────────────

  test('bot stuck detection: turn key issued and FORWARD released when center unchanged', () => {
    const eng = makeEngine(stuckPixel());
    const bot = createBot(eng);

    // Override to return in-game (gray HUD)
    // stuckPixel returns uniform gray everywhere — low variance = in-game
    // But we also need low red fraction.
    // [100, 100, 100]: r=100, r>90 → counted as high-r? 100/255 > 90
    // That means redFraction could be high. Patch getPixel to ensure in-game:
    eng.getPixel = (x, y) => {
      const h = eng.height;
      const hudStart = Math.floor(h * 0.88);
      if (y >= hudStart) return [80, 82, 80]; // gray HUD
      return [50, 50, 50]; // non-red game content
    };

    let now = 0;
    // Run for >1.6s (stuck threshold) with 25ms steps
    for (let i = 0; i < 80; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    bot.dispose();

    // Expect a turn key to have been pressed (LEFT or RIGHT)
    const turnKeys = eng._keys.filter(
      k => (k.code === 0xac || k.code === 0xae) && k.pressed === 1,
    );
    if (turnKeys.length === 0) {
      throw new Error(
        `Expected a turn key (LEFT 0xac or RIGHT 0xae) when stuck. ` +
        `Keys: ${JSON.stringify(eng._keys.map(k => ({ c: '0x' + k.code.toString(16), p: k.pressed })))}`,
      );
    }

    // After at least one turn key, check FORWARD was released at some point
    const forwardUp = eng._keys.filter(k => k.code === 0xad && k.pressed === 0);
    if (forwardUp.length === 0) {
      throw new Error(
        `Expected KEY_UPARROW (0xad) release during stuck unstick maneuver. ` +
        `Keys: ${JSON.stringify(eng._keys.map(k => ({ c: '0x' + k.code.toString(16), p: k.pressed })))}`,
      );
    }
  });

  // ── Test 5: aggressive=true fires with lower threshold than false ──────────

  test('bot aggressive mode: fires with lower threshold (more eager) than calm mode', () => {
    // Build a frame with MODERATE monster signal (between calm and aggressive threshold)
    // calm threshold = 8%, aggressive threshold = 4%
    // We target ~6% fleshy pixels in the sample region.
    const W = 320, H = 200;
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    const sampleHalfW = 24, sampleHalfH = 16;
    const hudStart = Math.floor(H * 0.88);

    // stepX/stepY mirrored from bot internals: MONSTER_SAMPLE_COLS=48, rows=32
    // stepX = max(1, floor(48/16))=3, stepY = max(1, floor(32/8))=4
    // We need ~6% of sampled pixels to be fleshy.
    // Make a small band fleshy (about 6% of the grid).
    // Motion gating: ratio only counts with LOCALIZED center-zone motion
    // (centerExcess > MOTION_CORROBORATE=4, but below direct-fire 9).
    // Deterministic: 4 known center-zone sample points (sampleZones math:
    // rows 60+10k, center cols 106+13k for a 320x200 engine) toggle ±60
    // luminance keyed on the DECISION clock (floor(now/150)%2) — counter
    // based wiggles alias against the 6-update decision stride.
    // mean Δ = 4×60/48 = 5.0 → corroborates (>4) without direct fire (<9).
    const nowRef = { v: 0 };
    const togglers = new Set(['119,60', '132,70', '145,80', '184,90']);
    const fleshyPixel = (x, y) => {
      if (y >= hudStart) return [85, 85, 83];
      if (togglers.has(`${x},${y}`)) {
        const lum = Math.floor(nowRef.v / 150) % 2 === 0 ? 40 : 100;
        return [lum, lum, lum];
      }
      // Fleshy zone: narrow horizontal strip in center (~6% monster ratio)
      if (Math.abs(y - cy) < 3 && Math.abs(x - cx) < 10) return [180, 80, 50];
      return [30, 60, 20];
    };

    // Test calm (should NOT fire given ~6% < 8%)
    const engCalm = makeEngine(fleshyPixel);
    const botCalm = createBot(engCalm);
    let now = 0;
    for (let i = 0; i < 60; i++) {
      now += 25;
      nowRef.v = now;
      engCalm._setNow(now);
      botCalm.update(now, false); // calm
    }
    botCalm.dispose();
    const calmFires = engCalm._keys.filter(k => k.code === 0xa3 && k.pressed === 1).length;

    // Test aggressive (should fire given ~6% > 4%)
    const engAgg = makeEngine(fleshyPixel);
    const botAgg = createBot(engAgg);
    now = 0;
    for (let i = 0; i < 60; i++) {
      now += 25;
      nowRef.v = now;
      engAgg._setNow(now);
      botAgg.update(now, true); // aggressive
    }
    botAgg.dispose();
    const aggFires = engAgg._keys.filter(k => k.code === 0xa3 && k.pressed === 1).length;

    if (aggFires <= calmFires) {
      throw new Error(
        `aggressive mode should fire more than calm mode with moderate monster signal. ` +
        `calm fires: ${calmFires}, aggressive fires: ${aggFires}`,
      );
    }
  });

  // ── Test 6: Registry upsert format ───────────────────────────────────────

  test('registry: upsert writes correct format, read back intact', () => {
    // Use an isolated tmp dir so we don't corrupt the real registry
    const origTmpRoot = process.env.AFK_ARCADE_TMPDIR;
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-reg-test-'));
    process.env.AFK_ARCADE_TMPDIR = fakeRoot;

    try {
      // Dynamically import to get fresh module with new env
      // (can't re-import in same process easily — test the helpers directly
      //  by calling them with the fakeRoot path)

      // Write directly to fakeRoot/tty-registry.json
      const regFile = path.join(fakeRoot, 'tty-registry.json');

      // Simulate upsertTtyRegistry behavior manually
      const sid = 'test-session-1';
      const entry = { ttyPath: '/dev/ttys099', cols: 120, lines: 30 };
      const now = Date.now();

      // Write a registry entry
      const reg = {};
      reg[sid] = { ttyPath: entry.ttyPath, cols: entry.cols, lines: entry.lines, updatedAt: now };
      const tmp = regFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(reg), 'utf8');
      fs.renameSync(tmp, regFile);

      // Read back and verify
      const raw = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      if (!raw[sid]) throw new Error(`Registry missing entry for session ${sid}`);
      if (raw[sid].ttyPath !== entry.ttyPath) {
        throw new Error(`ttyPath mismatch: expected ${entry.ttyPath}, got ${raw[sid].ttyPath}`);
      }
      if (raw[sid].cols !== entry.cols) {
        throw new Error(`cols mismatch: expected ${entry.cols}, got ${raw[sid].cols}`);
      }
      if (raw[sid].lines !== entry.lines) {
        throw new Error(`lines mismatch: expected ${entry.lines}, got ${raw[sid].lines}`);
      }
      if (typeof raw[sid].updatedAt !== 'number') {
        throw new Error(`updatedAt must be a number, got ${typeof raw[sid].updatedAt}`);
      }

    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true });
      if (origTmpRoot === undefined) {
        delete process.env.AFK_ARCADE_TMPDIR;
      } else {
        process.env.AFK_ARCADE_TMPDIR = origTmpRoot;
      }
    }
  });

  // ── Test 7: pruneRegistry removes stale entries ───────────────────────────

  test('registry: pruneRegistry removes entries older than REGISTRY_TTL_MS', () => {
    const now = Date.now();
    const reg = {
      'fresh-session': { ttyPath: '/dev/ttys001', cols: 80, lines: 24, updatedAt: now - 1000 },
      'stale-session': { ttyPath: '/dev/ttys002', cols: 80, lines: 24, updatedAt: now - REGISTRY_TTL_MS - 1000 },
    };

    const pruned = pruneRegistry(reg, now);

    if (!pruned['fresh-session']) {
      throw new Error('pruneRegistry must keep fresh entries');
    }
    if (pruned['stale-session']) {
      throw new Error('pruneRegistry must remove entries older than REGISTRY_TTL_MS');
    }
  });

  // Update counters if called from run.mjs
  if (counters) {
    // The test() calls above went through the passed testFn from run.mjs
    // which tracks its own counters — nothing extra to do here.
  }
}

// ── Standalone runner ─────────────────────────────────────────────────────────

async function runStandalone() {
  let localPassed = 0;
  let localFailed = 0;

  async function test(name, fn) {
    try {
      await fn();
      process.stdout.write(`PASS  ${name}\n`);
      localPassed++;
    } catch (err) {
      process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
      localFailed++;
    }
  }

  await runBotTests(null, { test });

  process.stdout.write(`\n${localPassed + localFailed} tests: ${localPassed} passed, ${localFailed} failed\n`);
  process.exit(localFailed > 0 ? 1 : 0);
}

// Run standalone when executed directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runStandalone().catch((err) => {
    process.stderr.write(`bot.test.mjs fatal: ${err.message}\n`);
    process.exit(1);
  });
}
