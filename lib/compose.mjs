/**
 * compose.mjs — pure compositor core for the universal backdrop
 * (scripts/doomscreen.mjs).
 *
 * Combines two layers into one text-cell grid:
 *   base   — the DOOM frame (frame.rgb) rendered as quadrant glyphs
 *   top    — Claude Code's virtual screen (an @xterm/headless buffer)
 *
 * Precedence per cell: Claude wins when it has a non-space character OR a
 * non-default background; otherwise the cell is transparent and the game
 * shows through. Winning cells keep their own background if they set one,
 * else get bg 49 (terminal default) as a legibility halo over the game.
 *
 * Everything here is pure and synchronous — no xterm import, no fs. The
 * xterm adapter is duck-typed so tests can use plain fake cells.
 */

import { renderQuadCell } from './render.mjs';

// ── frame.rgb parsing ─────────────────────────────────────────────────────────

/**
 * Parse a frame.rgb buffer: [u16-LE width][u16-LE height][R G B ...].
 *
 * @param {Buffer} buf
 * @returns {{ w: number, h: number, data: Buffer } | null}  null when invalid
 */
export function parseFrameRgb(buf) {
  if (!buf || buf.length < 4) return null;
  const w = buf.readUInt16LE(0);
  const h = buf.readUInt16LE(2);
  if (w === 0 || h === 0 || w > 1024 || h > 512) return null;
  if (buf.length !== 4 + w * h * 3) return null;
  return { w, h, data: buf.subarray(4) };
}

// ── xterm cell adapter ────────────────────────────────────────────────────────

/**
 * Convert an xterm buffer cell (duck-typed ICellData) into a compose cell.
 *
 * @param {object} cell  Needs: getChars, getWidth, isBold, isDim, isItalic,
 *   isUnderline, isInverse, isFgDefault, isFgPalette, isFgRGB, getFgColor,
 *   isBgDefault, isBgPalette, isBgRGB, getBgColor
 * @returns {{ ch: string, width: number, fg: string, bg: string, wins: boolean }}
 */
export function xtermCellToCompose(cell) {
  const width = cell.getWidth();
  // Width-0 cells are the trailing half of a wide character — they carry no
  // glyph of their own and must not repaint over the wide char.
  if (width === 0) {
    return { ch: '', width: 0, fg: '', bg: '', wins: true };
  }

  const rawCh = cell.getChars();
  const ch = rawCh === '' ? ' ' : rawCh;
  const hasBg = !cell.isBgDefault();
  const wins = ch !== ' ' || hasBg;

  // Foreground SGR (attributes + colour) — built only for winning cells.
  let fg = '';
  if (wins) {
    let attrs = '';
    if (cell.isBold())      attrs += ';1';
    if (cell.isDim())       attrs += ';2';
    if (cell.isItalic())    attrs += ';3';
    if (cell.isUnderline()) attrs += ';4';
    if (cell.isInverse())   attrs += ';7';

    let colour = '';
    if (cell.isFgPalette())  colour = `;38;5;${cell.getFgColor()}`;
    else if (cell.isFgRGB()) {
      const v = cell.getFgColor();
      colour = `;38;2;${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}`;
    }
    // default fg → no colour fragment (the run prefix resets to defaults)

    fg = `\x1b[0${attrs}${colour}m`;
  }

  let bg = '';
  if (wins) {
    if (cell.isBgPalette())      bg = `\x1b[48;5;${cell.getBgColor()}m`;
    else if (cell.isBgRGB()) {
      const v = cell.getBgColor();
      bg = `\x1b[48;2;${(v >> 16) & 0xff};${(v >> 8) & 0xff};${v & 0xff}m`;
    } else {
      // No own background → terminal-default halo for legibility
      bg = '\x1b[49m';
    }
  }

  return { ch, width, fg, bg, wins };
}

// ── Grid composition ──────────────────────────────────────────────────────────

/**
 * Compose one full grid.
 *
 * @param {object} opts
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @param {{ w: number, h: number, data: Buffer } | null} opts.frame
 *   Parsed frame.rgb, or null (no game layer → blank base).
 * @param {(col: number, row: number) => object | null} opts.getTermCell
 *   Returns the duck-typed xterm cell at (col, row), or null for blank.
 * @param {boolean} opts.truecolor
 * @returns {{ ch: string[], fg: string[], bg: string[] }}  flat cols×rows
 */
export function composeGrid({ cols, rows, frame, getTermCell, truecolor }) {
  const n = cols * rows;
  const ch = new Array(n);
  const fg = new Array(n);
  const bg = new Array(n);

  const px4 = new Array(12);
  // Scale factors map cell-quadrant pixel space (cols*2 × rows*2) onto the
  // actual frame dimensions, so any frame size renders full-bleed.
  const sx = frame ? frame.w / (cols * 2) : 0;
  const sy = frame ? frame.h / (rows * 2) : 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;

      const termCell = getTermCell(c, r);
      const top = termCell ? xtermCellToCompose(termCell) : null;
      if (top && top.wins) {
        ch[i] = top.ch;
        fg[i] = top.fg;
        bg[i] = top.bg;
        continue;
      }

      if (!frame) {
        ch[i] = ' ';
        fg[i] = '';
        bg[i] = '\x1b[49m';
        continue;
      }

      // Game base: 2×2 pixel block for this cell
      for (let q = 0; q < 4; q++) {
        const qx = (c * 2 + (q & 1)) * sx | 0;
        const qy = (r * 2 + (q >> 1)) * sy | 0;
        const px = Math.min(qx, frame.w - 1);
        const py = Math.min(qy, frame.h - 1);
        const off = (py * frame.w + px) * 3;
        px4[q * 3]     = frame.data[off];
        px4[q * 3 + 1] = frame.data[off + 1];
        px4[q * 3 + 2] = frame.data[off + 2];
      }
      const quad = renderQuadCell(px4, truecolor);
      ch[i] = quad.glyph;
      fg[i] = quad.fgCode;
      bg[i] = quad.bgCode;
    }
  }

  return { ch, fg, bg };
}

// ── Diff renderer ─────────────────────────────────────────────────────────────

/**
 * Render the ANSI string that transforms `prev` into `next`.
 *
 * Pass prev = null for a full repaint. Output is wrapped in synchronized
 * output (\x1b[?2026h/l — ignored by terminals without support) and ends
 * with the cursor parked at the virtual cursor position.
 *
 * Runs of changed cells are emitted together; gaps of up to GAP_BRIDGE
 * unchanged cells are bridged (re-emitting them is cheaper than a new
 * cursor reposition).
 *
 * @param {{ ch: string[], fg: string[], bg: string[] } | null} prev
 * @param {{ ch: string[], fg: string[], bg: string[] }} next
 * @param {number} cols
 * @param {number} rows
 * @param {{ x: number, y: number, visible: boolean }} cursor
 * @returns {string}  '' when nothing changed (cursor still appended)
 */
export function renderDiff(prev, next, cols, rows, cursor) {
  const GAP_BRIDGE = 4;
  let out = '';

  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let c = 0;
    while (c < cols) {
      // Find next changed cell
      while (c < cols && !cellChanged(prev, next, base + c)) c++;
      if (c >= cols) break;

      const runStart = c;
      let runEnd = c;            // exclusive
      let gap = 0;
      let probe = c;
      while (probe < cols) {
        if (cellChanged(prev, next, base + probe)) {
          runEnd = probe + 1;
          gap = 0;
        } else {
          gap++;
          if (gap > GAP_BRIDGE) break;
        }
        probe++;
      }

      out += `\x1b[${r + 1};${runStart + 1}H`;
      let prevFg = null;
      let prevBg = null;
      for (let k = runStart; k < runEnd; k++) {
        const i = base + k;
        if (next.ch[i] === '') continue; // wide-char continuation
        if (next.fg[i] !== prevFg || next.bg[i] !== prevBg) {
          out += '\x1b[0m' + next.fg[i] + next.bg[i];
          prevFg = next.fg[i];
          prevBg = next.bg[i];
        }
        out += next.ch[i];
      }
      out += '\x1b[0m';
      c = runEnd;
    }
  }

  // Cursor parking — always emitted so claude's input box feels native.
  const park = `\x1b[${cursor.y + 1};${cursor.x + 1}H` +
               (cursor.visible ? '\x1b[?25h' : '\x1b[?25l');

  if (out === '') return park;
  return '\x1b[?2026h\x1b[?25l' + out + park + '\x1b[?2026l';
}

/**
 * @param {{ ch: string[], fg: string[], bg: string[] } | null} prev
 * @param {{ ch: string[], fg: string[], bg: string[] }} next
 * @param {number} i
 */
function cellChanged(prev, next, i) {
  if (!prev) return true;
  return prev.ch[i] !== next.ch[i] ||
         prev.fg[i] !== next.fg[i] ||
         prev.bg[i] !== next.bg[i];
}
