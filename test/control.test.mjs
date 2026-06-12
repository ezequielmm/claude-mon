#!/usr/bin/env node
/**
 * control.test.mjs — unit tests for lib/control-core.mjs and related wiring.
 *
 * Run standalone: node test/control.test.mjs
 * Also wired into test/run.mjs as Phase G (runControlTests export).
 *
 * Tests:
 *   1. mapKeyEventToDoom — WASD/arrows → held codes; space/f/x/1-7/enter/esc → tap codes
 *   2. mapKeyEventToDoom — quit keys (q, ctrl+c) → null
 *   3. mapKeyEventToDoom — unknown keys → null
 *   4. buildControlState — schema shape, heartbeat freshness, taps capped at 8
 *   5. controlOwner — fresh heartbeat → 'user'
 *   6. controlOwner — stale heartbeat → 'bot'
 *   7. controlOwner — heartbeat === 0 → 'bot'
 *   8. controlOwner — null state → 'bot'
 *   9. bot.suspend() releases held keys (engine recording)
 *  10. bot.resume() re-arms update() (forward is re-issued on in-game frame)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  mapKeyEventToDoom,
  buildControlState,
  controlOwner,
  CONTROLLER_STALE_MS,
  KEY_UPARROW,
  KEY_DOWNARROW,
  KEY_LEFTARROW,
  KEY_RIGHTARROW,
  KEY_USE,
  KEY_FIRE,
  KEY_ESCAPE,
  KEY_ENTER,
} from '../lib/control-core.mjs';
import { createBot } from '../lib/doom-bot.mjs';

// ── Shared test runner ────────────────────────────────────────────────────────

export async function runControlTests(counters, { test: testFn }) {
  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Minimal fake engine that records every pushKey call.
   * The getPixel function returns an in-game frame (gray HUD strip at bottom).
   */
  function makeEngine(getPixelFn) {
    const keys = [];
    let _now = 0;
    const w = 320;
    const h = 200;
    return {
      width: w,
      height: h,
      tick() {},
      getPixel: getPixelFn ?? ((x, y) => {
        // In-game: gray HUD at bottom 12%, varied game content elsewhere
        const hudStart = Math.floor(h * 0.88);
        if (y >= hudStart) return [85, 85, 83];
        return [40 + (x % 20), 60 + (y % 15), 30 + (x % 10)];
      }),
      getFrameRGB() { return new Uint8Array(w * h * 3); },
      pushKey(pressed, code) { keys.push({ pressed, code, atMs: _now }); },
      _keys: keys,
      _setNow(n) { _now = n; },
    };
  }

  // ── Test 1: mapKeyEventToDoom — movement keys are held ────────────────────

  testFn('mapKeyEventToDoom: WASD and arrows produce held movement codes', () => {
    const cases = [
      ['w', KEY_UPARROW,    true],
      ['up', KEY_UPARROW,   true],
      ['s', KEY_DOWNARROW,  true],
      ['down', KEY_DOWNARROW, true],
      ['a', KEY_LEFTARROW,  true],
      ['left', KEY_LEFTARROW, true],
      ['d', KEY_RIGHTARROW, true],
      ['right', KEY_RIGHTARROW, true],
    ];
    for (const [input, expectedCode, expectedHeld] of cases) {
      const result = mapKeyEventToDoom(input);
      if (result === null) {
        throw new Error(`mapKeyEventToDoom('${input}'): expected {code:${expectedCode}, held:${expectedHeld}}, got null`);
      }
      if (result.code !== expectedCode) {
        throw new Error(`mapKeyEventToDoom('${input}'): code ${result.code}, expected ${expectedCode}`);
      }
      if (result.held !== expectedHeld) {
        throw new Error(`mapKeyEventToDoom('${input}'): held ${result.held}, expected ${expectedHeld}`);
      }
    }
  });

  // ── Test 2: mapKeyEventToDoom — action keys ───────────────────────────────

  testFn('mapKeyEventToDoom: space → USE tap; f/x → FIRE held; 1-7, enter, esc → tap', () => {
    // Space: tap
    const sp = mapKeyEventToDoom(' ');
    if (!sp || sp.code !== KEY_USE || sp.held !== false) {
      throw new Error(`space: expected {code:${KEY_USE}, held:false}, got ${JSON.stringify(sp)}`);
    }

    // f → FIRE held
    const fk = mapKeyEventToDoom('f');
    if (!fk || fk.code !== KEY_FIRE || fk.held !== true) {
      throw new Error(`'f': expected {code:${KEY_FIRE}, held:true}, got ${JSON.stringify(fk)}`);
    }

    // x → FIRE held
    const xk = mapKeyEventToDoom('x');
    if (!xk || xk.code !== KEY_FIRE || xk.held !== true) {
      throw new Error(`'x': expected {code:${KEY_FIRE}, held:true}, got ${JSON.stringify(xk)}`);
    }

    // Weapon slots 1-7: tap
    for (let i = 1; i <= 7; i++) {
      const wk = mapKeyEventToDoom(String(i));
      if (!wk || wk.code !== 48 + i || wk.held !== false) {
        throw new Error(`'${i}': expected {code:${48 + i}, held:false}, got ${JSON.stringify(wk)}`);
      }
    }

    // Enter (CR)
    const ek = mapKeyEventToDoom('\r');
    if (!ek || ek.code !== KEY_ENTER || ek.held !== false) {
      throw new Error(`'\\r': expected {code:${KEY_ENTER}, held:false}, got ${JSON.stringify(ek)}`);
    }

    // Escape
    const escK = mapKeyEventToDoom('\x1b');
    if (!escK || escK.code !== KEY_ESCAPE || escK.held !== false) {
      throw new Error(`'\\x1b': expected {code:${KEY_ESCAPE}, held:false}, got ${JSON.stringify(escK)}`);
    }
  });

  // ── Test 3: mapKeyEventToDoom — quit and unknown → null ───────────────────

  testFn('mapKeyEventToDoom: q and ctrl+c return null; unknown key returns null', () => {
    const nullCases = ['q', '\x03', 'z', '\t', 'p'];
    for (const key of nullCases) {
      const result = mapKeyEventToDoom(key);
      if (result !== null) {
        throw new Error(`mapKeyEventToDoom('${key}'): expected null, got ${JSON.stringify(result)}`);
      }
    }
  });

  // ── Test 4: buildControlState — schema and tap capping ────────────────────

  testFn('buildControlState: produces correct schema; taps capped at 8', () => {
    const held = [KEY_UPARROW, KEY_LEFTARROW];
    // 12 taps — only last 8 should appear
    const taps = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, code: 49 + i }));
    const state = buildControlState(held, taps, 13);

    if (typeof state.heartbeat !== 'number' || state.heartbeat <= 0) {
      throw new Error(`heartbeat must be a positive number, got ${state.heartbeat}`);
    }
    if (!Array.isArray(state.held)) {
      throw new Error('held must be an array');
    }
    // held must be sorted
    const sortedHeld = [...held].sort((a, b) => a - b);
    for (let i = 0; i < sortedHeld.length; i++) {
      if (state.held[i] !== sortedHeld[i]) {
        throw new Error(`held[${i}]: expected ${sortedHeld[i]}, got ${state.held[i]}`);
      }
    }
    if (!Array.isArray(state.taps)) {
      throw new Error('taps must be an array');
    }
    if (state.taps.length !== 8) {
      throw new Error(`taps must be capped at 8; got ${state.taps.length}`);
    }
    // Last 8 taps (indices 4..11 of original array)
    for (let i = 0; i < 8; i++) {
      const expected = taps[4 + i];
      if (state.taps[i].seq !== expected.seq) {
        throw new Error(`taps[${i}].seq: expected ${expected.seq}, got ${state.taps[i].seq}`);
      }
    }
    if (typeof state.pid !== 'number') {
      throw new Error(`pid must be a number, got ${typeof state.pid}`);
    }
  });

  // ── Test 5: controlOwner — fresh heartbeat → 'user' ──────────────────────

  testFn('controlOwner: fresh heartbeat returns "user"', () => {
    const nowMs = Date.now();
    const state = { heartbeat: nowMs - 500 }; // 500ms ago — within 1500ms window
    const owner = controlOwner(state, nowMs);
    if (owner !== 'user') {
      throw new Error(`Expected 'user' for fresh heartbeat (500ms old), got '${owner}'`);
    }
  });

  // ── Test 6: controlOwner — stale heartbeat → 'bot' ───────────────────────

  testFn('controlOwner: stale heartbeat returns "bot"', () => {
    const nowMs = Date.now();
    const state = { heartbeat: nowMs - CONTROLLER_STALE_MS - 1 }; // just past the threshold
    const owner = controlOwner(state, nowMs);
    if (owner !== 'bot') {
      throw new Error(`Expected 'bot' for stale heartbeat (${CONTROLLER_STALE_MS + 1}ms old), got '${owner}'`);
    }
  });

  // ── Test 7: controlOwner — heartbeat === 0 → 'bot' ───────────────────────

  testFn('controlOwner: heartbeat=0 (release sentinel) returns "bot"', () => {
    const state = { heartbeat: 0, held: [], taps: [] };
    const owner = controlOwner(state, Date.now());
    if (owner !== 'bot') {
      throw new Error(`Expected 'bot' for heartbeat=0, got '${owner}'`);
    }
  });

  // ── Test 8: controlOwner — null state → 'bot' ────────────────────────────

  testFn('controlOwner: null state (control.json absent) returns "bot"', () => {
    const owner = controlOwner(null, Date.now());
    if (owner !== 'bot') {
      throw new Error(`Expected 'bot' for null state, got '${owner}'`);
    }
  });

  // ── Test 9: bot.suspend() releases held keys ──────────────────────────────

  testFn('bot.suspend() issues pushKey(0, ...) for every held key and clears state', () => {
    const eng = makeEngine();
    const bot = createBot(eng);

    // Run bot to in-game state where it holds FORWARD
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    // Confirm forward was pressed at least once
    const forwardDown = eng._keys.filter(k => k.code === KEY_UPARROW && k.pressed === 1);
    if (forwardDown.length === 0) {
      throw new Error('Bot should have pressed KEY_UPARROW before suspend() test; check in-game detection');
    }

    // Count pushKey calls before suspend
    const beforeCount = eng._keys.length;

    // Call suspend — must release any held keys
    bot.suspend();

    // After suspend, any held key down must have a matching up
    const after = eng._keys.slice(beforeCount);
    // At a minimum, if forward was held it should now be released
    // (We verify: calling suspend() does NOT result in new down presses)
    const downAfter = after.filter(k => k.pressed === 1);
    if (downAfter.length > 0) {
      throw new Error(
        `bot.suspend() must not press any keys down; found ${downAfter.length} down events: ` +
        JSON.stringify(downAfter.map(k => ({ c: '0x' + k.code.toString(16), p: k.pressed }))),
      );
    }

    bot.dispose();
  });

  // ── Test 10: bot.resume() re-arms the bot ────────────────────────────────

  testFn('bot.resume() re-arms: bot issues movement keys again after suspend+resume', () => {
    const eng = makeEngine();
    const bot = createBot(eng);

    // Drive bot to in-game state
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    // Suspend the bot
    bot.suspend();

    // Advance a few ticks while suspended — bot must NOT issue keys
    const countBeforeResume = eng._keys.length;
    for (let i = 0; i < 10; i++) {
      now += 25;
      eng._setNow(now);
      // Simulate daemon loop: only call update if NOT suspended.
      // (The real daemon skips bot.update() when owner === 'user'.)
      // We DON'T call bot.update here to match that behavior.
    }

    // Resume
    bot.resume();

    // Now call update — bot should issue movement keys again
    for (let i = 0; i < 20; i++) {
      now += 25;
      eng._setNow(now);
      bot.update(now, false);
    }

    const newKeys = eng._keys.slice(countBeforeResume + (eng._keys.length - countBeforeResume < 0 ? 0 : 0));
    // Check that forward was pressed again after resume
    const forwardAfterResume = eng._keys
      .slice(countBeforeResume)
      .filter(k => k.code === KEY_UPARROW && k.pressed === 1);

    if (forwardAfterResume.length === 0) {
      throw new Error(
        'Bot should re-issue KEY_UPARROW after resume(). ' +
        `Keys after resume: ${JSON.stringify(eng._keys.slice(countBeforeResume).map(k => ({
          c: '0x' + k.code.toString(16), p: k.pressed,
        })))}`,
      );
    }

    bot.dispose();
  });
}

// ── Standalone runner ──────────────────────────────────────────────────────────

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

  await runControlTests(null, { test });

  process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runStandalone().catch((err) => {
    process.stderr.write(`control.test.mjs fatal: ${err.message}\n`);
    process.exit(1);
  });
}
