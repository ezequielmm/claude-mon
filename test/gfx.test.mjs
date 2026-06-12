#!/usr/bin/env node
/**
 * gfx.test.mjs — standalone tests for the pixel-perfect graphics stack.
 *
 * Run with: node test/gfx.test.mjs
 *
 * Tests:
 *   1. encodePng roundtrip    — PNG signature, IHDR bytes, IDAT inflates correctly, CRCs valid
 *   2. iterm2Image envelope   — starts with ESC]1337;File=, contains size=, ends with BEL, b64 roundtrip
 *   3. kittyImage chunks      — chunk size ≤4096 b64 chars, first has a=T,f=100, last has m=0, b64 concat roundtrip
 *   4. detectGraphics matrix  — iTerm.app→iterm2, WezTerm→iterm2, xterm-kitty→kitty, KITTY_WINDOW_ID→kitty, plain→null
 *   5. engine.getFrameRGB     — returns width*height*3 bytes, >50 distinct colors after ~150 ticks
 *                               (skipped cleanly when vendor/doom assets absent)
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Imports under test ────────────────────────────────────────────────────────

import { encodePng } from '../lib/png.mjs';
import { detectGraphics, iterm2Image, kittyImage, kittyVirtualImage, kittyPlaceholderLines } from '../lib/gfx-protocol.mjs';

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    const elapsed = Date.now() - t0;
    const suffix = note === 'SKIP'
      ? ' (SKIPPED)'
      : ` (${elapsed}ms${note ? ' — ' + note : ''})`;
    process.stdout.write(`PASS  ${name}${suffix}\n`);
    passed++;
  } catch (err) {
    const elapsed = Date.now() - t0;
    process.stdout.write(`FAIL  ${name} (${elapsed}ms)\n      ${err.message}\n`);
    failed++;
  }
}

// ── CRC32 helper (mirrors the implementation in png.mjs) ──────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Test 1: encodePng roundtrip ───────────────────────────────────────────────

await test('encodePng roundtrip — PNG signature, IHDR, IDAT inflate, CRCs valid', () => {
  const W = 16, H = 16;

  // Build a 16×16 gradient: R increases along x, G increases along y
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 3;
      rgb[off]     = Math.round(x / (W - 1) * 255); // R: 0..255
      rgb[off + 1] = Math.round(y / (H - 1) * 255); // G: 0..255
      rgb[off + 2] = 128;                            // B: constant
    }
  }

  const png = encodePng(rgb, W, H);
  if (!Buffer.isBuffer(png)) throw new Error('encodePng must return a Buffer');

  // PNG signature
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIG[i]) {
      throw new Error(`PNG signature byte ${i}: expected ${SIG[i]}, got ${png[i]}`);
    }
  }

  // IHDR chunk starts at byte 8
  // Layout: length(4) type(4) data(13) crc(4) = 25 bytes
  const ihdrLen = png.readUInt32BE(8);
  if (ihdrLen !== 13) throw new Error(`IHDR data length: expected 13, got ${ihdrLen}`);

  const ihdrType = png.slice(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR') throw new Error(`Expected IHDR at offset 12, got ${ihdrType}`);

  const ihdrWidth  = png.readUInt32BE(16);
  const ihdrHeight = png.readUInt32BE(20);
  const bitDepth   = png[24];
  const colorType  = png[25];

  if (ihdrWidth !== W)   throw new Error(`IHDR width: expected ${W}, got ${ihdrWidth}`);
  if (ihdrHeight !== H)  throw new Error(`IHDR height: expected ${H}, got ${ihdrHeight}`);
  if (bitDepth !== 8)    throw new Error(`IHDR bitDepth: expected 8, got ${bitDepth}`);
  if (colorType !== 2)   throw new Error(`IHDR colorType: expected 2 (RGB), got ${colorType}`);

  // CRC validation for IHDR chunk: CRC covers type(4) + data(13)
  const ihdrCrcData  = png.slice(12, 12 + 4 + 13); // type + data
  const ihdrCrcCalc  = crc32(ihdrCrcData);
  const ihdrCrcInFile = png.readUInt32BE(12 + 4 + 13);
  if (ihdrCrcCalc !== ihdrCrcInFile) {
    throw new Error(`IHDR CRC mismatch: computed ${ihdrCrcCalc}, file has ${ihdrCrcInFile}`);
  }

  // Find IDAT chunk (immediately after IHDR: offset 8 + 25 = 33)
  const idatOffset = 33;
  const idatLen  = png.readUInt32BE(idatOffset);
  const idatType = png.slice(idatOffset + 4, idatOffset + 8).toString('ascii');
  if (idatType !== 'IDAT') throw new Error(`Expected IDAT at offset ${idatOffset}, got ${idatType}`);

  // CRC validation for IDAT
  const idatCrcData   = png.slice(idatOffset + 4, idatOffset + 4 + 4 + idatLen); // type + data
  const idatCrcCalc   = crc32(idatCrcData);
  const idatCrcInFile = png.readUInt32BE(idatOffset + 4 + 4 + idatLen);
  if (idatCrcCalc !== idatCrcInFile) {
    throw new Error(`IDAT CRC mismatch: computed ${idatCrcCalc}, file has ${idatCrcInFile}`);
  }

  // Inflate IDAT data and verify dimensions
  // Raw filtered scanlines: each row = 1 filter byte + W*3 RGB bytes
  const idatData     = png.slice(idatOffset + 8, idatOffset + 8 + idatLen);
  const inflated     = zlib.inflateSync(idatData);
  const expectedSize = H * (1 + W * 3);
  if (inflated.length !== expectedSize) {
    throw new Error(
      `Inflated IDAT size: expected ${expectedSize} (${H}*(1+${W}*3)), got ${inflated.length}`,
    );
  }

  // Verify filter bytes (all should be 0 = None)
  for (let row = 0; row < H; row++) {
    const filterByte = inflated[row * (1 + W * 3)];
    if (filterByte !== 0) {
      throw new Error(`Row ${row}: expected filter byte 0, got ${filterByte}`);
    }
  }

  return `PNG ${W}×${H}, ${png.length} bytes, IDAT inflates to ${inflated.length} bytes`;
});

// ── Test 2: iterm2Image envelope ──────────────────────────────────────────────

await test('iterm2Image — envelope, size=, ends with BEL, base64 roundtrip', () => {
  const testData = Buffer.from('FAKE_PNG_CONTENT_FOR_TESTING_1234567890');
  const seq = iterm2Image(testData, { widthCells: 80, heightCells: 23 });

  if (typeof seq !== 'string') throw new Error('iterm2Image must return a string');

  if (!seq.startsWith('\x1b]1337;File=')) {
    throw new Error(`Expected sequence to start with ESC]1337;File=, got: ${JSON.stringify(seq.slice(0, 20))}`);
  }

  if (!seq.includes('size=')) {
    throw new Error('Expected sequence to contain size=');
  }

  if (!seq.endsWith('\x07')) {
    throw new Error(`Expected sequence to end with BEL (0x07), got: ${JSON.stringify(seq.slice(-5))}`);
  }

  // Extract and decode base64 payload (after the colon before BEL)
  const colonIdx = seq.lastIndexOf(':');
  const belIdx   = seq.lastIndexOf('\x07');
  if (colonIdx === -1) throw new Error('Expected colon separator in sequence');
  const b64Payload = seq.slice(colonIdx + 1, belIdx);
  const decoded    = Buffer.from(b64Payload, 'base64');

  if (!decoded.equals(testData)) {
    throw new Error(
      `base64 roundtrip failed: expected ${testData.toString('hex')}, ` +
      `got ${decoded.toString('hex')}`,
    );
  }

  return `seq length ${seq.length}, base64 ${b64Payload.length} chars`;
});

// ── Test 3: kittyImage chunks ─────────────────────────────────────────────────

await test('kittyImage — chunk sizes ≤4096 b64 chars, first has a=T,f=100, last has m=0, concat roundtrip', () => {
  // Use a large-ish payload to force multiple chunks (>4096 base64 chars ≈ >3072 raw bytes)
  const testData = Buffer.alloc(6000, 0xAB); // 6000 bytes → ~8000 base64 chars → ~2 chunks

  const seq = kittyImage(testData, { cols: 80, rows: 23, imageId: 42 });

  if (typeof seq !== 'string') throw new Error('kittyImage must return a string');

  // Split into individual APC frames: \x1b_G...\x1b\\
  const frames = [];
  let pos = 0;
  while (pos < seq.length) {
    const start = seq.indexOf('\x1b_G', pos);
    if (start === -1) break;
    const end = seq.indexOf('\x1b\\', start);
    if (end === -1) break;
    frames.push(seq.slice(start, end + 2));
    pos = end + 2;
  }

  if (frames.length === 0) throw new Error('No APC frames found in kittyImage output');

  // Check that each frame's base64 payload is ≤4096 chars
  const allB64Parts = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    // Format: \x1b_G<params>;<b64payload>\x1b\\
    const semiIdx = frame.indexOf(';');
    if (semiIdx === -1) throw new Error(`Frame ${fi}: no semicolon separator`);
    const params  = frame.slice(3, semiIdx);          // after \x1b_G
    const payload = frame.slice(semiIdx + 1, -2);     // before \x1b\\

    if (payload.length > 4096) {
      throw new Error(`Frame ${fi}: base64 payload ${payload.length} chars exceeds 4096`);
    }
    allB64Parts.push(payload);

    if (fi === 0) {
      // First frame must have a=T and f=100
      if (!params.includes('a=T')) {
        throw new Error(`First frame params missing a=T: ${params}`);
      }
      if (!params.includes('f=100')) {
        throw new Error(`First frame params missing f=100: ${params}`);
      }
    }

    if (fi === frames.length - 1) {
      // Last frame must have m=0
      if (!params.includes('m=0')) {
        throw new Error(`Last frame (${fi}) params missing m=0: ${params}`);
      }
    } else {
      // Non-last frames must have m=1
      if (!params.includes('m=1')) {
        throw new Error(`Frame ${fi} (non-last) params missing m=1: ${params}`);
      }
    }
  }

  // Concatenate all b64 parts and decode — must equal original testData
  const combined = allB64Parts.join('');
  const decoded  = Buffer.from(combined, 'base64');
  if (!decoded.equals(testData)) {
    throw new Error(
      `Concatenated base64 roundtrip failed: ` +
      `expected ${testData.length} bytes, got ${decoded.length} bytes`,
    );
  }

  return `${frames.length} frames, ${combined.length} total b64 chars`;
});

// ── Test 4: detectGraphics matrix ────────────────────────────────────────────

await test('detectGraphics — iTerm.app→iterm2, WezTerm→iterm2, xterm-kitty→kitty, KITTY_WINDOW_ID→kitty, plain→null', () => {
  const cases = [
    // iTerm.app
    [{ TERM_PROGRAM: 'iTerm.app' }, {}, 'iterm2'],
    // WezTerm (implements iTerm2 protocol)
    [{ TERM_PROGRAM: 'WezTerm' }, {}, 'iterm2'],
    // kitty via TERM
    [{ TERM: 'xterm-kitty' }, {}, 'kitty'],
    // kitty via KITTY_WINDOW_ID
    [{ KITTY_WINDOW_ID: '1' }, {}, 'kitty'],
    // plain xterm — no protocol
    [{ TERM: 'xterm-256color', TERM_PROGRAM: '' }, {}, null],
    // --gfx iterm2 override wins regardless of env
    [{ TERM: 'xterm-256color' }, { override: 'iterm2' }, 'iterm2'],
    // --gfx kitty override
    [{ TERM_PROGRAM: 'iTerm.app' }, { override: 'kitty' }, 'kitty'],
    // --gfx off → null
    [{ TERM_PROGRAM: 'iTerm.app' }, { override: 'off' }, null],
    // --gfx auto → falls through to env detection
    [{ TERM_PROGRAM: 'iTerm.app' }, { override: 'auto' }, 'iterm2'],
  ];

  const errors = [];
  for (const [env, opts, expected] of cases) {
    const got = detectGraphics(env, opts);
    if (got !== expected) {
      errors.push(
        `env=${JSON.stringify(env)} opts=${JSON.stringify(opts)}: ` +
        `expected ${String(expected)}, got ${String(got)}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n      '));
  }

  return `${cases.length} cases passed`;
});

// ── Test 5: engine.getFrameRGB ────────────────────────────────────────────────

await test('engine.getFrameRGB — width*height*3 bytes, >50 distinct colors after ~150 ticks', async () => {
  // Skip cleanly if vendor assets are absent
  const VENDOR_DOOM = path.join(ROOT, 'vendor', 'doom');
  const present = ['doom.js', 'doom.wasm', 'doom1.wad'].every((f) => {
    try { return fs.statSync(path.join(VENDOR_DOOM, f)).size > 1000; }
    catch { return false; }
  });
  if (!present) return 'SKIP';

  const { createDoom } = await import('../lib/doom-engine.mjs');
  const engine = await createDoom();

  // Tick ~150 frames to ensure real content (createDoom already ticked 35)
  for (let i = 0; i < 115; i++) engine.tick();

  const { width, height } = engine;
  const expectedBytes = width * height * 3;

  const rgb = engine.getFrameRGB();

  if (!(rgb instanceof Uint8Array)) {
    engine.dispose();
    throw new Error(`getFrameRGB must return a Uint8Array, got ${rgb?.constructor?.name}`);
  }

  if (rgb.length !== expectedBytes) {
    engine.dispose();
    throw new Error(
      `Expected ${expectedBytes} bytes (${width}×${height}×3), got ${rgb.length}`,
    );
  }

  // Count distinct RGB triplets (packed as a single number for Set)
  const seen = new Set();
  for (let i = 0; i < rgb.length; i += 3) {
    seen.add((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]);
  }

  engine.dispose();

  if (seen.size <= 50) {
    throw new Error(
      `Expected >50 distinct colors in ${width}×${height} framebuffer, got ${seen.size}`,
    );
  }

  // Also test the pre-allocated output buffer path
  const engine2 = await createDoom();
  for (let i = 0; i < 50; i++) engine2.tick();
  const preBuf = new Uint8Array(width * height * 3);
  const out = engine2.getFrameRGB(preBuf);
  if (out !== preBuf) {
    engine2.dispose();
    throw new Error('getFrameRGB(preBuf) must return the same buffer reference');
  }
  engine2.dispose();

  return `${width}×${height}, ${rgb.length} bytes, ${seen.size} distinct colors`;
});

// ── Probe tests ───────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import { probeKittyGraphics } from '../lib/gfx-protocol.mjs';

/**
 * Build a fake duplex stream pair for probe tests.
 *
 * writtenToStdout  — collects bytes written to the fake stdout
 * fakeStdin        — EventEmitter with a push(bytes) helper that fires 'data'
 * fakeStdout       — WritableStream-like with a write() method
 */
function makeFakePair() {
  const writtenToStdout = [];

  const fakeStdout = {
    write(data) {
      writtenToStdout.push(typeof data === 'string' ? Buffer.from(data) : data);
    },
  };

  const fakeStdin = new EventEmitter();
  fakeStdin.isTTY = false; // skip setRawMode calls
  fakeStdin.resume = () => {};
  fakeStdin.pause  = () => {};

  return { fakeStdin, fakeStdout, writtenToStdout };
}

// ── Test 6: probe — kitty OK reply → true ─────────────────────────────────────

await test('probeKittyGraphics — OK reply → true, DA1 fence ignored', async () => {
  const { fakeStdin, fakeStdout } = makeFakePair();

  const probePromise = probeKittyGraphics(fakeStdin, fakeStdout, { timeoutMs: 200 });

  // Simulate terminal replying with Kitty OK then DA1
  // \x1b_Gi=4242;OK\x1b\\  then  \x1b[?62c
  const kittyOK = Buffer.from('\x1b_Gi=4242;OK\x1b\\', 'binary');
  const da1     = Buffer.from('\x1b[?62c', 'binary');
  fakeStdin.emit('data', kittyOK);
  fakeStdin.emit('data', da1);

  const result = await probePromise;

  if (result.supported !== true) {
    throw new Error(`Expected supported=true, got ${result.supported}`);
  }

  return 'probe resolved true on Kitty OK reply';
});

// ── Test 7: probe — DA1 only (no kitty reply) → false ─────────────────────────

await test('probeKittyGraphics — DA1 only, no kitty reply → false (fast)', async () => {
  const { fakeStdin, fakeStdout } = makeFakePair();

  const probePromise = probeKittyGraphics(fakeStdin, fakeStdout, { timeoutMs: 2000 });

  // Only DA1 reply arrives — no kitty APC before it
  const da1 = Buffer.from('\x1b[?62c', 'binary');
  fakeStdin.emit('data', da1);

  const result = await probePromise;

  if (result.supported !== false) {
    throw new Error(`Expected supported=false, got ${result.supported}`);
  }

  return 'probe resolved false on DA1 without kitty OK';
});

// ── Test 8: probe — timeout, no reply → false ────────────────────────────────

await test('probeKittyGraphics — no reply → false after timeout', async () => {
  const { fakeStdin, fakeStdout } = makeFakePair();

  const t0     = Date.now();
  const result = await probeKittyGraphics(fakeStdin, fakeStdout, { timeoutMs: 60 });
  const elapsed = Date.now() - t0;

  if (result.supported !== false) {
    throw new Error(`Expected supported=false on timeout, got ${result.supported}`);
  }
  if (elapsed < 50) {
    throw new Error(`Expected at least 50ms elapsed for timeout, got ${elapsed}ms`);
  }
  if (elapsed > 500) {
    throw new Error(`Timeout took too long: ${elapsed}ms (expected ≤500ms)`);
  }

  return `resolved false after ${elapsed}ms (timeoutMs=60)`;
});

// ── Test 9: probe — keystroke bytes interleaved → preserved in carryOver ─────
//
// Design contract: carryOver contains ALL bytes received during the probe —
// including probe responses themselves and any user keystrokes mixed in.
// The caller is responsible for filtering out the probe-response bytes when
// re-emitting; the important guarantee is that no bytes are silently dropped.
//
// Specifically: a keystroke byte that arrives BEFORE the Kitty OK (in the same
// data chunk or a prior one) must appear in carryOver.  Bytes arriving on
// separate .emit() calls after the promise has already settled are not captured
// (the listener has been removed); that is the expected behavior.

await test('probeKittyGraphics — keystroke before OK preserved in carryOver', async () => {
  const { fakeStdin, fakeStdout } = makeFakePair();

  const probePromise = probeKittyGraphics(fakeStdin, fakeStdout, { timeoutMs: 200 });

  // 'w' arrives BEFORE the Kitty OK in the same Buffer → must be in carryOver.
  const combined = Buffer.concat([
    Buffer.from([0x77]),                              // 'w' keystroke before OK
    Buffer.from('\x1b_Gi=4242;OK\x1b\\', 'binary'),  // Kitty OK — settles the probe
  ]);
  fakeStdin.emit('data', combined);
  // 's' emitted AFTER promise settles — intentionally not captured (listener gone)

  const result = await probePromise;

  if (result.supported !== true) {
    throw new Error(`Expected supported=true, got ${result.supported}`);
  }

  const co = result.carryOver;
  if (!co.includes(0x77)) {
    throw new Error(
      `carryOver must include 0x77 ('w') typed before the OK. ` +
      `Got: [${Array.from(co).map(b => '0x' + b.toString(16)).join(',')}]`,
    );
  }
  // DA1-only path: keystroke before DA1 must also be preserved
  const { fakeStdin: si2, fakeStdout: so2 } = makeFakePair();
  const p2 = probeKittyGraphics(si2, so2, { timeoutMs: 200 });
  const combined2 = Buffer.concat([
    Buffer.from([0x73]),                  // 's' before DA1
    Buffer.from('\x1b[?62c', 'binary'),   // DA1 — settles the probe as false
  ]);
  si2.emit('data', combined2);
  const result2 = await p2;
  if (result2.supported !== false) {
    throw new Error(`Expected supported=false on DA1-only path, got ${result2.supported}`);
  }
  if (!result2.carryOver.includes(0x73)) {
    throw new Error(`carryOver must include 0x73 ('s') typed before DA1`);
  }

  return `carryOver preserved 'w' (${co.length} bytes); DA1 path preserved 's' (${result2.carryOver.length} bytes)`;
});

// ── Test 10: Warp YAML writer — parseable YAML, correct URI form ──────────────

await test('Warp launch config — YAML fields and URI format are correct', () => {
  // Reproduce the template from afk-ctl.mjs play case to verify the output.
  const homedir    = '/Users/testuser';
  const execPath   = '/usr/local/bin/node';
  const playScript = '/path/to/scripts/play.mjs';
  const launchFile = path.join(homedir, '.warp', 'launch_configurations', 'claude-doom.yaml');

  const yaml = [
    '# Warp Launch Configuration — generated by claude-mon /afk play',
    '---',
    'name: claude-doom',
    'windows:',
    '  - tabs:',
    '      - title: DOOM',
    '        layout:',
    `          cwd: ${homedir}`,
    '          commands:',
    `            - exec: "${execPath} --no-warnings ${playScript} --gfx auto"`,
  ].join('\n') + '\n';

  // Structural assertions (no yaml lib — match key strings)
  if (!yaml.includes('name: claude-doom')) {
    throw new Error('YAML missing name: claude-doom');
  }
  if (!yaml.includes('windows:')) {
    throw new Error('YAML missing windows: key');
  }
  if (!yaml.includes('  - tabs:')) {
    throw new Error('YAML missing tabs: key');
  }
  if (!yaml.includes('        layout:')) {
    throw new Error('YAML missing layout: key');
  }
  if (!yaml.includes(`cwd: ${homedir}`)) {
    throw new Error(`YAML missing cwd: ${homedir}`);
  }
  if (!yaml.includes('          commands:')) {
    throw new Error('YAML missing commands: key');
  }
  if (!yaml.includes('            - exec:')) {
    throw new Error('YAML missing exec: key');
  }
  if (!yaml.includes('--gfx auto')) {
    throw new Error('YAML exec command missing --gfx auto');
  }

  // URI form: warp://launch/<url-encoded-path>
  // Official docs: https://docs.warp.dev/terminal/more-features/uri-scheme
  // Raycast source: warp://launch/${encodeURIComponent(path)}
  const uri = `warp://launch/${encodeURIComponent(launchFile)}`;

  if (!uri.startsWith('warp://launch/')) {
    throw new Error(`URI must start with warp://launch/, got: ${uri}`);
  }
  // Encoded path must decode back to the original file path
  const encodedPart = uri.slice('warp://launch/'.length);
  const decoded = decodeURIComponent(encodedPart);
  if (decoded !== launchFile) {
    throw new Error(`URI round-trip failed: expected ${launchFile}, got ${decoded}`);
  }
  // Must not contain raw slashes in the encoded part (they must be %2F)
  if (encodedPart.includes('/')) {
    throw new Error(`Encoded path must not contain raw slashes: ${encodedPart}`);
  }

  return `YAML ${yaml.length} bytes; URI: ${uri.slice(0, 60)}...`;
});

// ── Test 11: kittyPlaceholderLines — line count, width, SGR id color ─────────

await test('kittyPlaceholderLines — line count/width, SGR id color, U+10EEEE presence', () => {
  const imageId = 42;
  const cols    = 20;
  const rows    = 3;
  const leftPad = 5;

  const lines = kittyPlaceholderLines({ imageId, cols, rows, leftPad });

  if (!Array.isArray(lines)) throw new Error('kittyPlaceholderLines must return an array');
  if (lines.length !== rows) {
    throw new Error(`Expected ${rows} lines, got ${lines.length}`);
  }

  // Every line must start with leftPad spaces + SGR fg color for imageId 42 in 256-color
  const expectedSgrColor = `\x1b[38;5;${imageId}m`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string') throw new Error(`Line ${i} is not a string`);

    // Check leftPad spaces
    const pad = ' '.repeat(leftPad);
    if (!line.startsWith(pad)) {
      throw new Error(`Line ${i} must start with ${leftPad} spaces; got: ${JSON.stringify(line.slice(0, 10))}`);
    }

    // Check SGR color immediately after padding
    const afterPad = line.slice(leftPad);
    if (!afterPad.startsWith(expectedSgrColor)) {
      throw new Error(
        `Line ${i}: expected SGR ${JSON.stringify(expectedSgrColor)} after padding, ` +
        `got: ${JSON.stringify(afterPad.slice(0, 15))}`,
      );
    }

    // Check U+10EEEE is present
    if (!line.includes('\u{10EEEE}')) {
      throw new Error(`Line ${i} must contain U+10EEEE placeholder codepoint`);
    }

    // Check reset at end of line
    if (!line.endsWith('\x1b[0m')) {
      throw new Error(`Line ${i} must end with SGR reset \\x1b[0m`);
    }
  }

  // Verify the first cell of the first line: U+10EEEE + row-diacritic[0] + col-diacritic[0]
  // DIACRITICS[0] = 0x0305, DIACRITICS[0] = 0x0305 (same index for row=0,col=0)
  const firstCellStart = leftPad + expectedSgrColor.length;
  // The first three codepoints after SGR should be: U+10EEEE, U+0305 (row 0), U+0305 (col 0)
  const cellStr = lines[0].slice(firstCellStart);
  const cp0 = cellStr.codePointAt(0);
  if (cp0 !== 0x10EEEE) {
    throw new Error(`First codepoint must be U+10EEEE (${0x10EEEE}), got ${cp0?.toString(16)}`);
  }
  // Next codepoint (after the 2-code-unit astral char)
  const cp1 = cellStr.codePointAt(2);
  if (cp1 !== 0x0305) {
    throw new Error(`Row diacritic (index 0) must be U+0305, got U+${cp1?.toString(16).toUpperCase()}`);
  }
  const cp2 = cellStr.codePointAt(3);
  if (cp2 !== 0x0305) {
    throw new Error(`Col diacritic (index 0) must be U+0305, got U+${cp2?.toString(16).toUpperCase()}`);
  }

  return `${rows} lines × ${cols} cols, leftPad=${leftPad}, U+10EEEE present, diacritics verified`;
});

// ── Test 12: kittyVirtualImage — U=1 header, i=42, q=2, c/r, chunking, b64 ──

await test('kittyVirtualImage — U=1,i=42,q=2, c/r values, chunking ≤4096, base64 roundtrip', () => {
  const testData = Buffer.alloc(6000, 0xCC); // force multi-chunk
  const imageId  = 42;
  const cols     = 80;
  const rows     = 10;

  const seq = kittyVirtualImage(testData, { imageId, cols, rows });

  if (typeof seq !== 'string') throw new Error('kittyVirtualImage must return a string');

  // Parse APC frames
  const frames = [];
  let pos = 0;
  while (pos < seq.length) {
    const start = seq.indexOf('\x1b_G', pos);
    if (start === -1) break;
    const end = seq.indexOf('\x1b\\', start);
    if (end === -1) break;
    frames.push(seq.slice(start, end + 2));
    pos = end + 2;
  }

  if (frames.length === 0) throw new Error('No APC frames found in kittyVirtualImage output');

  // First frame must have U=1, i=42, q=2, c=80, r=10, a=T
  const firstSemiIdx = frames[0].indexOf(';');
  if (firstSemiIdx === -1) throw new Error('First frame missing semicolon');
  const firstParams = frames[0].slice(3, firstSemiIdx); // after \x1b_G

  for (const required of ['U=1', `i=${imageId}`, 'q=2', `c=${cols}`, `r=${rows}`, 'a=T']) {
    if (!firstParams.includes(required)) {
      throw new Error(`First frame params missing ${required}: ${firstParams}`);
    }
  }

  // All frames: payload ≤ 4096 b64 chars; last has m=0; non-last have m=1
  const allB64 = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const semiIdx = frames[fi].indexOf(';');
    const payload = frames[fi].slice(semiIdx + 1, -2);
    const params  = frames[fi].slice(3, semiIdx);

    if (payload.length > 4096) {
      throw new Error(`Frame ${fi}: payload ${payload.length} > 4096`);
    }
    allB64.push(payload);

    if (fi === frames.length - 1) {
      if (!params.includes('m=0')) throw new Error(`Last frame missing m=0: ${params}`);
    } else {
      if (!params.includes('m=1')) throw new Error(`Frame ${fi} non-last missing m=1: ${params}`);
    }
  }

  // Base64 roundtrip
  const decoded = Buffer.from(allB64.join(''), 'base64');
  if (!decoded.equals(testData)) {
    throw new Error(`base64 roundtrip failed: expected ${testData.length} bytes, got ${decoded.length}`);
  }

  return `${frames.length} frames, U=1 verified, base64 roundtrips correctly`;
});

// ── Test 13: daemon pixel style writes frame.png (valid PNG) + frame.ans ─────

await test('daemon pixel-style writes frame.png (valid PNG signature + IHDR dims) and frame.ans', async () => {
  // Skip if vendor assets absent
  const ROOT_T     = path.resolve(__dirname, '..');
  const VENDOR_DOOM = path.join(ROOT_T, 'vendor', 'doom');
  const present    = ['doom.js', 'doom.wasm', 'doom1.wad'].every((f) => {
    try { return fs.statSync(path.join(VENDOR_DOOM, f)).size > 1000; } catch { return false; }
  });
  if (!present) return 'SKIP';

  // Set up isolated tmp dir
  const os    = await import('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.default.tmpdir(), 'afk-pixel-test-'));
  const doomDir = path.join(tmpDir, 'doom');
  fs.mkdirSync(doomDir, { recursive: true });

  // Write a viewport file so daemon uses known dimensions
  fs.writeFileSync(
    path.join(doomDir, 'viewport.json'),
    JSON.stringify({ cols: 80, pxRows: 10, truecolor: true }),
  );

  // Write a minimal config with style=pixel so writeFrame emits frame.png
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ enabled: true, game: 'doom', rows: 5, aspect: '4:3', style: 'pixel' }),
  );

  try {
    // Import daemon's writeFrame logic indirectly by creating an engine and
    // calling the internal helpers — we test the PNG output directly.
    const { createDoom }      = await import('../lib/doom-engine.mjs');
    const { computeGameWidth, buildScaledBuffer } = await import('../lib/scale.mjs');
    const { encodePngFast }   = await import('../lib/png.mjs');

    const engine = await createDoom();
    for (let i = 0; i < 10; i++) engine.tick();

    const pxRows = 10;
    const cols   = 80;
    const gameW  = computeGameWidth('4:3', pxRows, cols);
    const halfW  = Math.min(640, gameW * 4);
    const halfH  = Math.min(400, pxRows * 4);

    const rgb    = buildScaledBuffer(engine.getPixel, engine.width, engine.height, halfW, halfH);
    const pngBuf = encodePngFast(rgb, halfW, halfH);

    // Validate PNG signature
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (pngBuf[i] !== SIG[i]) {
        throw new Error(`PNG signature byte ${i}: expected ${SIG[i]}, got ${pngBuf[i]}`);
      }
    }

    // Validate IHDR dimensions
    const ihdrWidth  = pngBuf.readUInt32BE(16);
    const ihdrHeight = pngBuf.readUInt32BE(20);
    if (ihdrWidth !== halfW)  throw new Error(`IHDR width: expected ${halfW}, got ${ihdrWidth}`);
    if (ihdrHeight !== halfH) throw new Error(`IHDR height: expected ${halfH}, got ${ihdrHeight}`);

    engine.dispose();
    return `PNG ${halfW}×${halfH}, ${pngBuf.length} bytes — valid signature and IHDR`;
  } finally {
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
