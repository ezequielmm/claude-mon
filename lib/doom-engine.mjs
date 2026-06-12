/**
 * doom-engine.mjs — Node.js host for the doomgeneric WASM engine.
 *
 * Loads the CJS Emscripten glue from vendor/doom/doom.js via createRequire,
 * mounts doom1.wad into the emscripten FS, calls doomgeneric_Create, and
 * exposes a minimal API for ticking and sampling pixels.
 *
 * ABI verified from vendor/doom/doom.js (opentui-doom 0.3.11):
 *   - Factory: createDoomModule(moduleArg?) → Promise<Module>  (CJS default export)
 *   - Module._doomgeneric_Create(argc, argv)  — void, called once
 *   - Module._doomgeneric_Tick()              — void, advance one frame
 *   - Module._DG_GetFrameBuffer()             — i32 ptr into WASM heap
 *   - Module._malloc(size)                    — allocate WASM heap bytes
 *   - Module._free(ptr)                       — free WASM heap
 *   - Module.setValue(ptr, val, type)         — write to WASM heap
 *   - Module.getValue(ptr, type)              — read from WASM heap
 *   - Module.FS                               — emscripten virtual FS
 *   - Module.ccall / Module.cwrap             — available but we use direct calls
 *
 * Framebuffer layout: 1280×800 pixels, each pixel is a 32-bit word
 * in 0xAARRGGBB format. Index: pixel(x,y) = HEAPU32[(fbPtr/4) + y*1280 + x].
 *
 * Memory access strategy (verified via rg on vendor/doom/doom.js):
 *   - HEAPU8 and HEAPU32 are closure-local variables inside the createDoomModule
 *     IIFE — not exported on the Module object by default.
 *   - wasmMemory = wasmExports["memory"] (also closure-local).
 *   - We patch doom.js in-memory at require time (via Module._extensions) to
 *     append `Module.HEAPU8=HEAPU8;Module.HEAPU32=HEAPU32;` inside
 *     updateMemoryViews(), so the views are always current (they are rebound
 *     on memory growth).  The patch is applied once and does NOT modify the
 *     file on disk.
 *   - getFrameRGB uses Module.HEAPU32 for bulk reads (~1.5ms/frame at 1280×800).
 *   - getPixel uses Module.getValue (unchanged) for the banner path.
 *   - If the patch fails to apply (e.g. future doom.js ABI change), getFrameRGB
 *     falls back to getValue (~3.5ms/frame) and logs a one-time warning.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// CJS Module registry — used to patch doom.js in-memory so it exposes
// HEAPU8 and HEAPU32 on the Module object after each updateMemoryViews call.
// This gives getFrameRGB direct typed-array access without requiring any
// changes to the vendor file on disk.
const CJSModule = createRequire(import.meta.url)('module');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'doom');
const DOOM_JS   = path.join(VENDOR, 'doom.js');
const DOOM_WASM = path.join(VENDOR, 'doom.wasm');
const DOOM_WAD  = path.join(VENDOR, 'doom1.wad');

// Framebuffer dimensions are AUTO-DETECTED at init (see detectDimensions).
// The opentui-doom 0.3.11 build renders at 1280×800 (verified empirically:
// vertical-neighbor correlation scores ~4 at stride 1280 vs ~56 at 320/640).
// These exports are the expected size for that build, as a reference only.
export const DOOM_WIDTH  = 1280;
export const DOOM_HEIGHT = 800;

// Candidate (width, height) pairs for detection, the empirically known
// opentui-doom size first so a uniform (all-black) frame ties into it.
const DIMENSION_CANDIDATES = [[1280, 800], [640, 400], [320, 200]];

/**
 * Detect the actual framebuffer dimensions empirically. Each candidate
 * stride is scored by the average luminance difference between vertically
 * adjacent pixels: the true width makes neighbors similar (natural images
 * are smooth), while a wrong stride jumps across the image and scores an
 * order of magnitude worse.
 *
 * @param {object} Module  Emscripten module (getValue access)
 * @param {number} fbPtr   framebuffer base pointer
 * @returns {[number, number]}  [width, height]
 */
function detectDimensions(Module, fbPtr) {
  const lum = (k) => {
    const px = Module.getValue(fbPtr + k * 4, 'i32') >>> 0;
    return ((px >>> 16) & 0xff) * 0.299 + ((px >>> 8) & 0xff) * 0.587 + (px & 0xff) * 0.114;
  };
  let best = DIMENSION_CANDIDATES[0];
  let bestScore = Infinity;
  for (const [w, h] of DIMENSION_CANDIDATES) {
    const maxK = w * (h - 2);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const k = (i * 7919 + 13) % maxK;
      sum += Math.abs(lum(k) - lum(k + w));
    }
    const score = sum / n;
    if (score < bestScore) {
      bestScore = score;
      best = [w, h];
    }
  }
  return best;
}

// ── Asset check ───────────────────────────────────────────────────────────────

/**
 * Returns true if all vendor assets are present and valid.
 */
export function vendorAssetsExist() {
  for (const f of [DOOM_JS, DOOM_WASM, DOOM_WAD]) {
    try {
      const stat = fs.statSync(f);
      if (stat.size < 1000) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and initialise the DOOM engine.
 *
 * @returns {Promise<{
 *   tick(): void,
 *   getPixel(x: number, y: number): [number, number, number],
 *   getFrameRGB(out?: Uint8Array): Uint8Array,
 *   width: number,
 *   height: number,
 *   dispose(): void,
 * }>}
 */
export async function createDoom() {
  if (!vendorAssetsExist()) {
    throw new Error(
      'DOOM vendor assets missing. Run: node scripts/fetch-doom.mjs',
    );
  }

  // Load doom.js via createRequire, patching it in-memory so updateMemoryViews
  // also assigns Module.HEAPU8 and Module.HEAPU32.  The patch targets the unique
  // string `HEAPU64=new BigUint64Array(b)}` which is the final assignment in
  // updateMemoryViews.  We do NOT touch the file on disk.
  //
  // Cache note: the _extensions handler only fires on first require (cache miss).
  // On subsequent calls doom.js is already in the CJS cache — but that cached
  // version IS the patched one, so Module.HEAPU32 will be set after init.
  // We detect patch presence by checking Module.HEAPU32 after instantiation
  // rather than relying on the handler firing.
  const require = createRequire(import.meta.url);
  const origHandler = CJSModule._extensions['.js'];
  CJSModule._extensions['.js'] = function patchedHandler(mod, filename) {
    if (filename === DOOM_JS) {
      let src = fs.readFileSync(filename, 'utf8');
      const patched = src.replace(
        /(HEAPU64=new BigUint64Array\(b\))(})/,
        '$1;if(typeof Module!=="undefined"){Module.HEAPU8=HEAPU8;Module.HEAPU32=HEAPU32;}$2',
      );
      mod._compile(patched, filename);
    } else {
      origHandler(mod, filename);
    }
  };
  const createDoomModule = require(DOOM_JS);
  CJSModule._extensions['.js'] = origHandler; // restore immediately

  // State captured during init
  let Module = null;
  let fbPtr = 0;    // pointer returned by _DG_GetFrameBuffer()
  let actualWidth  = 320;
  let actualHeight = 200;

  // Instantiate the Emscripten module.
  // We silence console output (doom prints a lot to stdout/stderr) and
  // provide locateFile so it can find doom.wasm.
  Module = await createDoomModule({
    locateFile: (name) => path.join(VENDOR, name),
    // Silence engine output — daemon must not emit to stdout/stderr
    print:    () => {},
    printErr: () => {},
    // Pre-allocate a 4MB+ stack to avoid stack overflow during init
    INITIAL_MEMORY: 64 * 1024 * 1024,
  });

  // Mount doom1.wad into the emscripten virtual FS
  const wadBuffer = fs.readFileSync(DOOM_WAD);
  Module.FS.writeFile('doom1.wad', wadBuffer);

  // Build argv in WASM memory: ["doom", "-iwad", "doom1.wad"]
  const argStrings = ['doom', '-iwad', 'doom1.wad'];
  const argc = argStrings.length;

  // Allocate each string and write its bytes into WASM heap
  const argPtrs = argStrings.map((s) => {
    const bytes = Buffer.from(s + '\0', 'utf8');
    const ptr = Module._malloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      Module.setValue(ptr + i, bytes[i], 'i8');
    }
    return ptr;
  });

  // Allocate the argv pointer array (argc + 1 null terminator, 4 bytes each)
  const argvPtr = Module._malloc((argc + 1) * 4);
  for (let i = 0; i < argc; i++) {
    Module.setValue(argvPtr + i * 4, argPtrs[i], 'i32');
  }
  Module.setValue(argvPtr + argc * 4, 0, 'i32'); // null terminator

  // Call doomgeneric_Create — this initialises the engine and starts the
  // title/attract sequence. It blocks briefly for WASM wasm init work.
  Module._doomgeneric_Create(argc, argvPtr);

  // Warm up: tick enough frames for real content to appear (title fade-in),
  // so the dimension probe below has image structure to measure.
  for (let i = 0; i < 35; i++) Module._doomgeneric_Tick();
  fbPtr = Module._DG_GetFrameBuffer();

  // Known-build fast path: the exact opentui-doom 0.3.11 doom.wasm we fetch
  // (381,189 bytes) renders 1280×800 — set it deterministically and skip the
  // statistical probe entirely. A single bad probe roll (e.g. sampling during
  // DOOM's screen-melt wipe, which is pure vertical noise) used to pick a
  // wrong stride and stick for the daemon's whole lifetime, rendering as a
  // black-and-white interleave maze. Detection now only runs for UNKNOWN
  // builds, and can be re-run later via redetectDimensions().
  const KNOWN_WASM_SIZES = new Map([[381189, [1280, 800]]]);
  let known = null;
  try { known = KNOWN_WASM_SIZES.get(fs.statSync(DOOM_WASM).size) ?? null; } catch { /* stat failed */ }
  if (known) {
    [actualWidth, actualHeight] = known;
  } else {
    [actualWidth, actualHeight] = detectDimensions(Module, fbPtr);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Advance the engine by one tick. Safe to call at any rate.
   */
  function tick() {
    Module._doomgeneric_Tick();
    // Refresh fbPtr each tick in case the engine reallocated the framebuffer
    fbPtr = Module._DG_GetFrameBuffer();
  }

  /**
   * Read a single pixel from the current framebuffer.
   *
   * The framebuffer is stored as 32-bit words in 0xAARRGGBB format
   * (big-endian component order within the 32-bit word). We use
   * Module.getValue(addr, 'i32') which reads HEAP32[addr>>2], then
   * extract R, G, B from the signed 32-bit value.
   *
   * @param {number} x  0..width-1
   * @param {number} y  0..height-1
   * @returns {[number, number, number]}  [r, g, b]
   */
  function getPixel(x, y) {
    if (!fbPtr) return [0, 0, 0];
    const addr = fbPtr + (y * actualWidth + x) * 4;
    // getValue returns signed i32 — treat it as unsigned with >>> 0
    const px = Module.getValue(addr, 'i32') >>> 0;
    // 0xAARRGGBB: bits 23-16 = R, bits 15-8 = G, bits 7-0 = B
    const r = (px >>> 16) & 0xff;
    const g = (px >>> 8)  & 0xff;
    const b =  px         & 0xff;
    return [r, g, b];
  }

  /**
   * Copy the current framebuffer as packed RGB (width×height×3 bytes).
   *
   * Uses a direct Uint32Array view over the WASM memory buffer for bulk reads
   * (~1.5ms for 1280×800).  The view is obtained from Module.HEAPU32, which is
   * kept up-to-date by the in-memory patch applied at module load time.
   * If the patch was not applied (future ABI change), falls back to getValue
   * (~3.5ms) with a one-time stderr warning.
   *
   * WASM memory may grow (WebAssembly.Memory.grow), which detaches the current
   * ArrayBuffer and causes TypedArray views to become zero-length.  We detect
   * this by checking `Module.HEAPU32.buffer === lastBuffer`; if it changed we
   * rebuild the view reference.
   *
   * Pixel format: 0xAARRGGBB (32-bit LE word), same as getPixel.
   *
   * @param {Uint8Array} [out]  Optional pre-allocated output buffer (width*height*3).
   *                            A new Uint8Array is allocated if omitted.
   * @returns {Uint8Array}  Packed RGB, row-major.
   */
  let _heapU32Warned = false;
  let _lastBuffer = null;
  let _cachedHeapU32 = null;

  function getFrameRGB(out) {
    const n = actualWidth * actualHeight;
    const rgb = out instanceof Uint8Array && out.length >= n * 3
      ? out
      : new Uint8Array(n * 3);

    if (!fbPtr) return rgb;

    // Module.HEAPU32 is set by the in-memory patch to doom.js (updateMemoryViews
    // appends Module.HEAPU32=HEAPU32 after each TypedArray rebind).  It is
    // present on every createDoom() call once doom.js has been loaded with the
    // patch, whether on the first require or from the CJS cache.
    if (Module.HEAPU32) {
      // Refresh cached view reference if buffer identity changed (memory growth)
      if (Module.HEAPU32.buffer !== _lastBuffer) {
        _lastBuffer = Module.HEAPU32.buffer;
        _cachedHeapU32 = Module.HEAPU32;
      }
      const u32 = _cachedHeapU32;
      const base = fbPtr >>> 2;
      for (let i = 0; i < n; i++) {
        const px = u32[base + i];
        rgb[i * 3]     = (px >>> 16) & 0xff;
        rgb[i * 3 + 1] = (px >>> 8)  & 0xff;
        rgb[i * 3 + 2] =  px         & 0xff;
      }
    } else {
      // Fallback: Module.getValue (closure HEAP32) — ~3.5ms/frame at 1280×800
      // This fires only if the doom.js ABI changed and the patch did not apply.
      if (!_heapU32Warned) {
        _heapU32Warned = true;
        process.stderr.write(
          'doom-engine: HEAPU32 not found on Module — getFrameRGB using getValue fallback ' +
          '(performance will be ~2× slower; doom.js ABI may have changed)\n',
        );
      }
      for (let i = 0; i < n; i++) {
        const px = Module.getValue(fbPtr + i * 4, 'i32') >>> 0;
        rgb[i * 3]     = (px >>> 16) & 0xff;
        rgb[i * 3 + 1] = (px >>> 8)  & 0xff;
        rgb[i * 3 + 2] =  px         & 0xff;
      }
    }

    return rgb;
  }

  /**
   * Release WASM heap allocations. The module itself stays loaded
   * (there's no clean way to unload it), but we free our allocations.
   */
  function dispose() {
    _cachedHeapU32 = null;
    _lastBuffer = null;
    try {
      Module._free(argvPtr);
      for (const ptr of argPtrs) Module._free(ptr);
    } catch { /* ignore — module may already be torn down */ }
  }

  /**
   * Push a key event into the DOOM engine.
   *
   * ABI verified: Module["_DG_PushKeyEvent"] is exported by vendor/doom/doom.js
   * (opentui-doom 0.3.11). Signature matches doomgeneric's DG_PushKeyEvent(pressed, key):
   *   pressed — 1 = key down, 0 = key up
   *   key     — doomgeneric key code (doomkeys.h values)
   *
   * Key constants (from doomgeneric doomkeys.h):
   *   KEY_RIGHTARROW 0xae, KEY_LEFTARROW 0xac, KEY_UPARROW 0xad, KEY_DOWNARROW 0xaf
   *   KEY_USE 0xa2, KEY_FIRE 0xa3
   *   KEY_ESCAPE 27, KEY_ENTER 13, KEY_TAB 9
   *   Weapons: ASCII '1'..'7' (49..55)
   *
   * @param {0|1} pressed  1 = down, 0 = up
   * @param {number} keyCode  doomgeneric key code
   */
  function pushKey(pressed, keyCode) {
    try {
      Module._DG_PushKeyEvent(pressed, keyCode);
    } catch {
      // Engine may not be ready — ignore silently
    }
  }

  /**
   * Re-run the statistical dimension probe against the CURRENT frame and
   * adopt the result. Only useful for unknown builds where the boot-time
   * probe may have sampled a degenerate frame (screen-melt wipe, black).
   * Cost ~1ms.
   * @returns {[number, number]}  the adopted [width, height]
   */
  function redetectDimensions() {
    const [w, h] = detectDimensions(Module, fbPtr);
    actualWidth = w;
    actualHeight = h;
    return [w, h];
  }

  return {
    tick,
    getPixel,
    getFrameRGB,
    pushKey,
    // Live getters: dimensions can be re-adopted post-boot for unknown builds.
    get width()  { return actualWidth; },
    get height() { return actualHeight; },
    dimensionsKnown: Boolean(known),
    redetectDimensions,
    dispose,
  };
}
