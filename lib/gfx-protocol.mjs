/**
 * gfx-protocol.mjs — terminal graphics protocol helpers.
 *
 * Supports two protocols:
 *   - iTerm2 inline images (OSC 1337) — used by iTerm2 and WezTerm.
 *   - Kitty graphics protocol (APC) — used by Kitty and compatible terminals.
 *
 * Both protocols embed a PNG (or other image format) directly in the terminal
 * output stream, replacing character-cell rendering with a rasterized image.
 *
 * Runtime capability probe:
 *   probeKittyGraphics(stdin, stdout, options) — sends a Kitty query and
 *   resolves true only when the terminal responds with an explicit OK.
 */

// ── Runtime Kitty graphics capability probe ──────────────────────────────────

/**
 * Probe whether the terminal speaks the Kitty graphics protocol.
 *
 * Strategy:
 *   1. Send a 1×1 RGB direct-transmission QUERY (a=q) with image id 4242:
 *        \x1b_Gi=4242,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\
 *      followed immediately by a DA1 device-attributes fence:
 *        \x1b[c
 *      A Kitty-capable terminal replies \x1b_Gi=4242;OK\x1b\\ (or ;E... on error).
 *      Every terminal replies to DA1 with \x1b[?...c.
 *   2. Read response bytes in raw mode.  Stop as soon as either:
 *      - We see \x1b_Gi=4242;OK\x1b\\ → resolve true.
 *      - We see the DA1 reply \x1b[? without having seen a Kitty OK → resolve false.
 *      - timeoutMs elapses → resolve false.
 *   3. Any bytes that are not part of the probe responses are buffered and
 *      returned in the `carryOver` Uint8Array so callers can re-emit them.
 *
 * The function sets stdin to raw mode for the duration of the probe and
 * restores the prior state on return.  If stdin is already in raw mode the
 * caller must manage that itself (pass alreadyRaw: true).
 *
 * @param {NodeJS.ReadStream}  stdin     Readable TTY (or fake duplex in tests).
 * @param {NodeJS.WriteStream} stdout    Writable TTY (or fake duplex in tests).
 * @param {{ timeoutMs?: number, alreadyRaw?: boolean }} [options]
 * @returns {Promise<{ supported: boolean, carryOver: Uint8Array }>}
 */
export async function probeKittyGraphics(stdin, stdout, options = {}) {
  const { timeoutMs = 500, alreadyRaw = false } = options;

  // The exact query + DA1 fence
  const PROBE_SEQ = '\x1b_Gi=4242,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\\x1b[c';

  // We match against these byte sequences in the response stream.
  // Kitty OK response:     \x1b _ G i = 4 2 4 2 ; O K \x1b \\
  // Kitty error response:  \x1b _ G i = 4 2 4 2 ; E ...  \x1b \\
  // DA1 fence reply:       \x1b [ ?  (CSI ? ...)
  const KITTY_OK_BYTES    = [0x1b, 0x5f, 0x47, 0x69, 0x3d, 0x34, 0x32, 0x34, 0x32, 0x3b, 0x4f, 0x4b]; // \x1b_Gi=4242;OK
  const KITTY_PROBE_BYTES = [0x1b, 0x5f, 0x47, 0x69, 0x3d, 0x34, 0x32, 0x34, 0x32, 0x3b];              // \x1b_Gi=4242;
  const DA1_PREFIX_BYTES  = [0x1b, 0x5b, 0x3f];                                                          // \x1b[?

  return new Promise((resolve) => {
    let settled    = false;
    let rawBuf     = Buffer.alloc(0);   // accumulates all received bytes
    let kittyMatch = 0;                 // progress through KITTY_OK_BYTES
    let kittyAny   = 0;                 // progress through KITTY_PROBE_BYTES (any response)
    let da1Match   = 0;                 // progress through DA1_PREFIX_BYTES
    let inKittyAPC = false;             // currently inside an APC response for id 4242
    let kittyWasOK = false;             // the matched APC response had ;OK

    function finish(supported) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.pause();
      if (!alreadyRaw && stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch { /* ignore */ }
      }
      // Bytes not consumed by the probe are carried over for the caller.
      resolve({ supported, carryOver: new Uint8Array(rawBuf) });
    }

    const timer = setTimeout(() => finish(false), timeoutMs);

    function onData(chunk) {
      if (settled) return;

      // Scan each incoming byte for probe-response patterns.
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        rawBuf = Buffer.concat([rawBuf, Buffer.from([b])]);

        // --- Kitty APC response matching ---
        // Phase 1: match KITTY_PROBE_BYTES (\x1b_Gi=4242;)
        if (!inKittyAPC) {
          if (b === KITTY_PROBE_BYTES[kittyAny]) {
            kittyAny++;
            if (kittyAny === KITTY_PROBE_BYTES.length) {
              inKittyAPC = true;
              kittyAny   = 0;
              kittyMatch = KITTY_PROBE_BYTES.length; // already matched through ;
              da1Match   = 0; // reset DA1 if we're inside a kitty APC
            }
          } else {
            kittyAny = (b === KITTY_PROBE_BYTES[0]) ? 1 : 0;
          }
        } else {
          // Phase 2: we're inside the APC response; check for OK suffix or APC terminator
          if (kittyMatch < KITTY_OK_BYTES.length) {
            if (b === KITTY_OK_BYTES[kittyMatch]) {
              kittyMatch++;
              if (kittyMatch === KITTY_OK_BYTES.length) {
                kittyWasOK = true;
              }
            } else {
              // Not ;OK — this is an error response (;E...) or something else; still a kitty reply
              kittyWasOK = false;
            }
          }
          // Detect APC terminator \x1b\\ (ST)
          // We look for ESC \ in the stream while inside APC
          if (b === 0x5c && rawBuf.length >= 2 && rawBuf[rawBuf.length - 2] === 0x1b) {
            // APC response complete
            inKittyAPC = false;
            if (kittyWasOK) {
              finish(true);
              return;
            }
            // Error response — probe spoken but not OK; resolve false when DA1 arrives
          }
        }

        // --- DA1 fence matching (only while not mid-APC) ---
        if (!inKittyAPC) {
          if (b === DA1_PREFIX_BYTES[da1Match]) {
            da1Match++;
            if (da1Match === DA1_PREFIX_BYTES.length) {
              // DA1 reply seen — if no Kitty OK was received, resolve false
              if (!kittyWasOK) {
                finish(false);
                return;
              }
            }
          } else {
            da1Match = (b === DA1_PREFIX_BYTES[0]) ? 1 : 0;
          }
        }
      }
    }

    if (!alreadyRaw && stdin.isTTY && typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch { /* ignore */ }
    }

    stdin.resume();
    stdin.on('data', onData);
    stdout.write(PROBE_SEQ);
  });
}

// ── Protocol detection ────────────────────────────────────────────────────────

/**
 * Detect the preferred terminal graphics protocol from the environment.
 *
 * Priority:
 *   1. Explicit override via `override` option (used for --gfx flag).
 *   2. TERM_PROGRAM=iTerm.app or TERM_PROGRAM=WezTerm → 'iterm2'
 *      (WezTerm implements the iTerm2 inline-images protocol).
 *   3. TERM contains 'kitty' OR KITTY_WINDOW_ID is set → 'kitty'
 *   4. Otherwise → null (no protocol detected; fall back to half-blocks).
 *
 * @param {Record<string, string | undefined>} env  process.env or equivalent.
 * @param {{ override?: string }} [options]
 *   override: 'iterm2' | 'kitty' | 'off' | 'auto' — explicit --gfx flag value.
 * @returns {'iterm2' | 'kitty' | null}
 */
export function detectGraphics(env, options = {}) {
  const override = options.override;

  if (override && override !== 'auto') {
    if (override === 'off') return null;
    if (override === 'iterm2') return 'iterm2';
    if (override === 'kitty') return 'kitty';
  }

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (termProgram === 'iterm.app' || termProgram === 'wezterm') {
    return 'iterm2';
  }

  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('kitty') || env.KITTY_WINDOW_ID !== undefined) {
    return 'kitty';
  }

  return null;
}

// ── iTerm2 inline images (OSC 1337) ──────────────────────────────────────────

/**
 * Build an iTerm2 inline-image escape sequence.
 *
 * Protocol: ESC ] 1337 ; File=inline=1;size=N;width=W;height=H;<options>:<base64> BEL
 *
 * The `width` and `height` parameters specify the number of terminal character
 * cells to occupy.  The terminal scales the image to fit while preserving
 * aspect ratio when `preserveAspectRatio=1`.
 *
 * @param {Buffer}  pngBuffer  Raw PNG file bytes.
 * @param {{ widthCells: number, heightCells: number }} options
 * @returns {string}  Complete escape sequence (with surrounding BEL).
 */
export function iterm2Image(pngBuffer, { widthCells, heightCells }) {
  const b64 = pngBuffer.toString('base64');
  return (
    '\x1b]1337;File=inline=1' +
    `;size=${pngBuffer.length}` +
    `;width=${widthCells}` +
    `;height=${heightCells}` +
    ';preserveAspectRatio=1' +
    `:${b64}` +
    '\x07'
  );
}

// ── Kitty graphics protocol (APC) ────────────────────────────────────────────

// Max base64 payload per APC chunk (bytes of base64 text, not binary).
const KITTY_CHUNK_SIZE = 4096;

// ── Kitty Unicode placeholder support (U=1 virtual placements) ───────────────
//
// Spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
//
// Protocol summary:
//   1. Transmit the image OUT-OF-BAND directly to /dev/tty using an APC
//      sequence with U=1 (virtual placement) and a=T (transmit+display):
//        \x1b_Ga=T,U=1,i=<id>,q=2,f=100,c=<cols>,r=<rows>,m=<0|1>;<b64>\x1b\\
//      The image is associated with a virtual placement identified by `i`.
//      Re-transmitting with the same `i` replaces the image (animation).
//
//   2. Place the image via PURE TEXT in the terminal output stream:
//      For each cell (row, col), emit:
//        SGR fg = image id (256-color: \x1b[38;5;<id>m)
//        U+10EEEE  (the placeholder codepoint — Private Use Area, astral plane)
//        DIACRITICS[row]  (row index as a combining diacritic above)
//        DIACRITICS[col]  (column index as a combining diacritic above)
//      Then reset SGR at end of line.
//
//   Row/column diacritics — the spec's official table, downloaded from:
//     https://sw.kovidgoyal.net/kitty/_downloads/f0a0de9ec8d9ff4456206db8e0814937/rowcolumn-diacritics.txt
//
//   Index 0 = U+0305, Index 1 = U+030D, Index 2 = U+030E, Index 3 = U+0310, ...
//   (241 entries total — supports up to 241 rows or columns)
//
//   Image ID in foreground color:
//     IDs 1–255 → 256-color mode: \x1b[38;5;<id>m
//     IDs 256+  → 24-bit mode:    \x1b[38;2;<b2>;<b1>;<b0>m where id = b2<<16|b1<<8|b0
//   We keep id ≤ 255 to avoid 24-bit encoding complexity and the third-diacritic
//   high-byte mechanism entirely.
//
//   q=2 suppresses ALL terminal responses (both OK and error) — CRITICAL so
//   response bytes never land in Claude Code's stdin.

/** Diacritic codepoints for row/column encoding (index = row or column number). */
const DIACRITICS = [
  0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F,
  0x0346, 0x034A, 0x034B, 0x034C, 0x0350, 0x0351, 0x0352, 0x0357,
  0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484,
  0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
  0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611,
  0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
  0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8,
  0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
  0x06E4, 0x06E7, 0x06E8, 0x06EB, 0x06EC, 0x0730, 0x0732, 0x0733,
  0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE,
  0x07EF, 0x07F0, 0x07F1, 0x07F3, 0x0816, 0x0817, 0x0818, 0x0819,
  0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C,
  0x082D, 0x0951, 0x0953, 0x0954, 0x0F82, 0x0F83, 0x0F86, 0x0F87,
  0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
  0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D,
  0x1B6E, 0x1B6F, 0x1B70, 0x1B71, 0x1B72, 0x1B73, 0x1CD0, 0x1CD1,
  0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
  0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1,
  0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5, 0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9,
  0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
  0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1,
  0x20D4, 0x20D5, 0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, 0x20E7,
  0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
  0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA,
  0x2DEB, 0x2DEC, 0x2DED, 0x2DEE, 0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2,
  0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
  0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D,
  0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1, 0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5,
  0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED,
  0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7,
  0xAAB8, 0xAABE, 0xAABF, 0xAAC1, 0xFE20, 0xFE21, 0xFE22, 0xFE23,
  0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186, 0x1D187,
  0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242,
  0x1D243, 0x1D244,
];

/** Placeholder codepoint (Private Use Area, astral plane). */
const PLACEHOLDER_CP = 0x10EEEE;

// Pre-build the placeholder character string (Node handles astral-plane correctly).
const PLACEHOLDER_CHAR = String.fromCodePoint(PLACEHOLDER_CP);

/**
 * Build a kitty virtual placement image transmission sequence (U=1 mode).
 *
 * The output must be written DIRECTLY to /dev/tty (not stdout/Claude Code),
 * so terminal response bytes never land in Claude Code's stdin.
 *
 * Virtual placement (U=1) allows placing the image via pure text placeholder
 * codepoints (see kittyPlaceholderLines) rather than cursor-position rewriting.
 *
 * Re-transmitting with the same imageId replaces the image — this is how
 * animation works: send a new PNG, the existing placeholder lines update.
 *
 * @param {Buffer}  pngBuffer  Raw PNG file bytes.
 * @param {{ imageId: number, cols: number, rows: number }} options
 *   imageId — 1–255 (keep ≤255 to avoid 24-bit color and third-diacritic complexity)
 *   cols    — width of the virtual placement in terminal columns
 *   rows    — height of the virtual placement in terminal rows
 * @returns {string}  Complete APC sequence (write directly to /dev/tty, not stdout).
 */
export function kittyVirtualImage(pngBuffer, { imageId, cols, rows }) {
  return _kittyChunks(pngBuffer, {
    firstHeader: `a=T,U=1,i=${imageId},q=2,f=100,c=${cols},r=${rows}`,
  });
}

/**
 * Build a full-screen BACKDROP transmission: the image is placed at cell 1;1
 * spanning cols×rows with a NEGATIVE z-index, so the terminal composites it
 * UNDER the text layer (cells with default background show the image through).
 * Verified working in Warp: Claude Code's UI floats over the game.
 *
 * The sequence wraps the placement in cursor save/home/restore so it can be
 * written out-of-band to a busy tty: kitty places images at the cursor, and
 * we must not disturb the foreground application's cursor position. A racing
 * cursor move between save and transmit misplaces one frame; the next
 * transmission self-heals.
 *
 * @param {Buffer} pngBuffer
 * @param {{ imageId: number, cols: number, rows: number }} options
 * @returns {string}  Complete sequence (write directly to the tty, not stdout).
 */
export function kittyBackdropImage(pngBuffer, { imageId, cols, rows }) {
  const placement = _kittyChunks(pngBuffer, {
    firstHeader: `a=T,f=100,i=${imageId},q=2,z=-2,c=${cols},r=${rows}`,
  });
  return `\x1b7\x1b[1;1H${placement}\x1b8`;
}

/**
 * Delete a kitty image (and its placements) by id.
 * @param {number} imageId
 * @returns {string}
 */
export function kittyDeleteImage(imageId) {
  return `\x1b_Ga=d,d=i,i=${imageId},q=2\x1b\\`;
}

/**
 * Backdrop transmission by FILE PATH (kitty t=f): the APC payload is just the
 * base64 of the PNG's path (~80-120 bytes total), so the whole sequence fits
 * in a single small atomic write. This is the ONLY safe way to stream frames
 * at high fps to a tty that another process (Claude Code) is concurrently
 * writing to — inlined t=d payloads (tens of KB across many chunks) interleave
 * with the foreground app's writes, losing APC terminators and spilling raw
 * base64 as text onto the screen (observed live at 24fps).
 *
 * The terminal re-reads the file on every transmission; the writer must
 * replace it atomically (tmp + rename).
 *
 * @param {string} filePath  Absolute path to a PNG file.
 * @param {{ imageId: number, cols: number, rows: number }} options
 * @returns {string}
 */
export function kittyBackdropFileImage(filePath, { imageId, cols, rows }) {
  const b64 = Buffer.from(filePath, 'utf8').toString('base64');
  return `\x1b7\x1b[1;1H\x1b_Ga=T,t=f,f=100,i=${imageId},q=2,z=-2,c=${cols},r=${rows};${b64}\x1b\\\x1b8`;
}

/**
 * Build placeholder lines for a kitty virtual image placement.
 *
 * Each line is a string of `cols` placeholder cells with SGR fg set to the
 * image ID using 256-color mode (\x1b[38;5;<id>m).  Each cell contains:
 *   U+10EEEE + DIACRITICS[rowIndex] + DIACRITICS[colIndex]
 *
 * The SGR reset (\x1b[0m) is appended at the end of each line.
 * Left-padding (plain spaces, no color) is prepended when leftPad > 0.
 *
 * Both row and column diacritics are emitted on EVERY cell — this is the most
 * robust encoding per the spec, and handles terminals that reflow text.
 *
 * @param {{ imageId: number, cols: number, rows: number, leftPad?: number }} options
 * @returns {string[]}  Array of `rows` lines (no trailing newline per line).
 */
export function kittyPlaceholderLines({ imageId, cols, rows, leftPad = 0 }) {
  const pad = leftPad > 0 ? ' '.repeat(leftPad) : '';
  const fgColor = `\x1b[38;5;${imageId}m`;
  const reset = '\x1b[0m';
  const lines = [];

  for (let r = 0; r < rows; r++) {
    const rowDiacritic = String.fromCodePoint(DIACRITICS[r % DIACRITICS.length]);
    let line = pad + fgColor;
    for (let c = 0; c < cols; c++) {
      const colDiacritic = String.fromCodePoint(DIACRITICS[c % DIACRITICS.length]);
      line += PLACEHOLDER_CHAR + rowDiacritic + colDiacritic;
    }
    line += reset;
    lines.push(line);
  }

  return lines;
}

/**
 * Internal chunking helper shared by kittyImage and kittyVirtualImage.
 *
 * @param {Buffer} pngBuffer
 * @param {{ firstHeader: string }} opts  firstHeader — APC params for the first chunk (no m=)
 * @returns {string}
 */
function _kittyChunks(pngBuffer, { firstHeader }) {
  const b64 = pngBuffer.toString('base64');
  const totalChunks = Math.ceil(b64.length / KITTY_CHUNK_SIZE) || 1;
  let result = '';

  for (let i = 0; i < totalChunks; i++) {
    const chunkB64 = b64.slice(i * KITTY_CHUNK_SIZE, (i + 1) * KITTY_CHUNK_SIZE);
    const isLast = i === totalChunks - 1;
    const m = isLast ? 0 : 1;

    if (i === 0) {
      result += `\x1b_G${firstHeader},m=${m};${chunkB64}\x1b\\`;
    } else {
      result += `\x1b_Gm=${m};${chunkB64}\x1b\\`;
    }
  }

  return result;
}

/**
 * Build a Kitty graphics protocol image transmission sequence.
 *
 * Transmits an image as a series of APC (Application Program Command) chunks.
 * Each chunk is at most KITTY_CHUNK_SIZE base64 characters.
 *
 * APC frame format:
 *   \x1b_G<key=value,...>;<base64-chunk>\x1b\\
 *
 * Key parameters used:
 *   a=T    — action: transmit (display immediately)
 *   f=100  — format: PNG
 *   i=<id> — image ID (reusing the same ID on subsequent frames replaces the image)
 *   q=2    — quiet: suppress OK/error responses
 *   c=<n>  — columns to occupy
 *   r=<n>  — rows to occupy
 *   m=1    — more data follows (all chunks except the last)
 *   m=0    — final chunk (last chunk only)
 *
 * @param {Buffer}  pngBuffer  Raw PNG file bytes.
 * @param {{ cols: number, rows: number, imageId: number }} options
 * @returns {string}  Complete APC sequence (all chunks concatenated).
 */
export function kittyImage(pngBuffer, { cols, rows, imageId }) {
  return _kittyChunks(pngBuffer, {
    firstHeader: `a=T,f=100,i=${imageId},q=2,c=${cols},r=${rows}`,
  });
}
