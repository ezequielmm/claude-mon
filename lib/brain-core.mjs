/**
 * brain-core.mjs — pure helpers for the Claude-piloted DOOM brain.
 *
 * The brain sidecar (scripts/doombrain.mjs) asks a cheap Claude model for a
 * short play plan from a frame screenshot, then drives the daemon through
 * control.json exactly like a human controller (owner: user — the heuristic
 * bot suspends while the brain's heartbeat is fresh).
 *
 * Everything here is pure: plan parsing and plan→keys translation, no I/O.
 */

import {
  KEY_UPARROW,
  KEY_DOWNARROW,
  KEY_LEFTARROW,
  KEY_RIGHTARROW,
  KEY_USE,
  KEY_FIRE,
} from './control-core.mjs';

/**
 * Extract the first JSON object from a model reply (models love prose and
 * code fences no matter how hard the prompt says "ONLY JSON").
 *
 * @param {string} text
 * @returns {object | null}
 */
export function extractPlan(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Walk to the matching close brace (plans are flat, but be tolerant)
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return normalizePlan(JSON.parse(text.slice(start, i + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Clamp a raw parsed object into a well-formed plan.
 *
 * @param {object} raw
 * @returns {{ move: 'forward'|'back'|'none', turn: 'left'|'right'|'none',
 *             turnMs: number, fire: boolean, use: boolean, note: string }}
 */
export function normalizePlan(raw) {
  const move = raw.move === 'back' ? 'back' : raw.move === 'none' ? 'none' : 'forward';
  const turn = raw.turn === 'left' ? 'left' : raw.turn === 'right' ? 'right' : 'none';
  const turnMs = Math.max(0, Math.min(1200, Number(raw.turnMs) || 0));
  return {
    move,
    turn,
    turnMs: turn === 'none' ? 0 : (turnMs || 300),
    fire: raw.fire === true,
    use: raw.use === true,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 60) : '',
  };
}

/**
 * Translate a plan into the held-key set for a moment in time.
 *
 * The turn key is held only for the first plan.turnMs of the plan's life —
 * after that the marine keeps moving straight (prevents orbiting).
 *
 * @param {ReturnType<typeof normalizePlan>} plan
 * @param {number} planAgeMs  ms since this plan was adopted
 * @returns {number[]}  sorted DOOM key codes to hold right now
 */
export function planHeldKeys(plan, planAgeMs) {
  const held = [];
  if (plan.move === 'forward') held.push(KEY_UPARROW);
  else if (plan.move === 'back') held.push(KEY_DOWNARROW);
  if (plan.turn !== 'none' && planAgeMs < plan.turnMs) {
    held.push(plan.turn === 'left' ? KEY_LEFTARROW : KEY_RIGHTARROW);
  }
  if (plan.fire) held.push(KEY_FIRE);
  return held.sort((a, b) => a - b);
}

/**
 * Tap list for a freshly adopted plan (USE fires once per plan).
 *
 * @param {ReturnType<typeof normalizePlan>} plan
 * @param {number} seq  next tap sequence number
 * @returns {{ taps: { seq: number, code: number }[], nextSeq: number }}
 */
export function planTaps(plan, seq) {
  if (!plan.use) return { taps: [], nextSeq: seq };
  return { taps: [{ seq, code: KEY_USE }], nextSeq: seq + 1 };
}

/** The prompt sent alongside every frame. Kept terse — haiku-friendly. */
export const BRAIN_PROMPT = [
  'You are piloting the marine in DOOM. The attached image is the current frame.',
  'Reply with ONLY minified JSON, no prose, no code fences:',
  '{"move":"forward|back|none","turn":"left|right|none","turnMs":<0-1200>,"fire":<bool>,"use":<bool>,"note":"<max 8 words>"}',
  'Tactics: if a monster is visible, turn to center it and fire.',
  'If a wall/door fills most of the view, turn 400-800ms toward open space;',
  'use:true when a door or switch is close ahead. Prefer unexplored dark',
  'openings over walls. Keep moving — standing still is death.',
].join(' ');

// ── Cortex v2: strategic ORDERS for the heuristic cerebellum ─────────────────

/** Order vocabulary the bot understands (lib/doom-bot.mjs applies the bias). */
export const ORDER_GOALS = ['hunt', 'advance', 'explore_left', 'explore_right', 'retreat', 'door'];

/**
 * Clamp a raw parsed object into a well-formed strategic order.
 *
 * @param {object} raw
 * @returns {{ goal: string, durationMs: number, note: string } | null}
 */
export function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const goal = ORDER_GOALS.includes(raw.goal) ? raw.goal : 'advance';
  const durationMs = Math.max(4000, Math.min(25_000, Number(raw.durationMs) || 12_000));
  return {
    goal,
    durationMs,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 80) : '',
  };
}

/**
 * Extract the first JSON object from model text and normalize as an order.
 *
 * @param {string} text
 * @returns {ReturnType<typeof normalizeOrder> | null}
 */
export function extractOrder(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return normalizeOrder(JSON.parse(text.slice(start, i + 1))); }
        catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Render a frame as a compact ASCII tactical grid — text-only prompts are
 * ~10x cheaper and faster than vision, and motion is marked explicitly.
 *
 * Legend: '!' moving (likely enemy/projectile) · '%' red-fleshy static ·
 * '#' bright (wall/light) · '.' mid floor · ' ' dark.
 *
 * @param {{ w: number, h: number, data: Buffer }} frame   parsed frame.rgb
 * @param {{ w: number, h: number, data: Buffer } | null} prevFrame  for motion
 * @param {number} [gw=40]  grid columns
 * @param {number} [gh=12]  grid rows
 * @returns {string}  gh lines joined with \n
 */
export function frameToAsciiGrid(frame, prevFrame, gw = 40, gh = 12) {
  const lines = [];
  const samePrev = prevFrame && prevFrame.w === frame.w && prevFrame.h === frame.h;
  for (let gy = 0; gy < gh; gy++) {
    let line = '';
    for (let gx = 0; gx < gw; gx++) {
      const px = Math.min(frame.w - 1, ((gx + 0.5) * frame.w / gw) | 0);
      const py = Math.min(frame.h - 1, ((gy + 0.5) * frame.h / gh) | 0);
      const o = (py * frame.w + px) * 3;
      const r = frame.data[o];
      const g = frame.data[o + 1];
      const b = frame.data[o + 2];
      const lum = (r + g + b) / 3;
      let ch;
      if (samePrev) {
        const po = o;
        const motion = Math.abs(r - prevFrame.data[po]) +
                       Math.abs(g - prevFrame.data[po + 1]) +
                       Math.abs(b - prevFrame.data[po + 2]);
        if (motion > 60) { line += '!'; continue; }
      }
      if (r > 60 && r > g * 1.3 && r > b * 1.3) ch = '%';
      else if (lum > 90) ch = '#';
      else if (lum > 35) ch = '.';
      else ch = ' ';
      line += ch;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Cortex prompt: tactical grid + rolling memory → one strategic order. */
export function buildOrderPrompt(grid, memory) {
  return [
    'You are the strategic cortex of a DOOM bot. Below is a 40x12 ASCII view',
    'of the current frame (legend: ! moving enemy/projectile, % red flesh,',
    '# bright wall/light, . floor, space = dark/opening) and your recent notes.',
    'A reflex layer handles aiming and wall avoidance — you choose STRATEGY.',
    'Reply ONLY minified JSON:',
    `{"goal":"${ORDER_GOALS.join('|')}","durationMs":<4000-25000>,"note":"<max 12 words: what you see + plan>"}`,
    'hunt=chase the !, advance=push forward, explore_left/right=sweep that way,',
    'retreat=back off (low health or cornered), door=spam USE ahead.',
    'Dark openings (spaces) are unexplored paths. Vary exploration; do not ping-pong.',
    '',
    'VIEW:',
    grid,
    '',
    'RECENT NOTES (oldest first):',
    memory || '(none yet)',
  ].join('\n');
}

// ── GBA / Pokémon brain (vision: reads on-screen TEXT) ───────────────────────

/** GBA buttons the brain can press (mapped to control.json wire codes). */
export const GBA_BUTTON_CODES = {
  a: 0xa2,        // A     → USE wire code
  b: 0xa3,        // B     → FIRE wire code
  up: 0xad,
  down: 0xaf,
  left: 0xac,
  right: 0xae,
  start: 13,      // ENTER wire code
  select: 27,     // ESC wire code
};
const GBA_BUTTONS = Object.keys(GBA_BUTTON_CODES);

/**
 * Parse a GBA play step: a short button SEQUENCE (taps), not held keys —
 * Pokémon is menu/dialog driven, so discrete presses fit. Each button is
 * issued as a tap; `note` carries what the model read on screen.
 *
 * @param {string} text
 * @returns {{ buttons: string[], note: string } | null}
 */
export function extractGbaStep(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return normalizeGbaStep(JSON.parse(text.slice(start, i + 1))); }
        catch { return null; }
      }
    }
  }
  return null;
}

/**
 * @param {object} raw
 * @returns {{ buttons: string[], note: string }}
 */
export function normalizeGbaStep(raw) {
  const list = Array.isArray(raw?.buttons) ? raw.buttons
    : (typeof raw?.press === 'string' ? [raw.press] : []);
  const buttons = list
    .map((b) => String(b).toLowerCase().trim())
    .filter((b) => GBA_BUTTONS.includes(b))
    .slice(0, 6); // cap a step so one decision can't run away with the pad
  return {
    buttons,
    note: typeof raw?.note === 'string' ? raw.note.slice(0, 100) : '',
  };
}

/** Vision prompt for the Pokémon pilot — it READS the screen text. */
export const POKEMON_PROMPT = [
  'You are playing a Pokémon game on a Game Boy Advance. The attached image is',
  'the current screen (240x160). READ any on-screen text carefully and decide',
  'the next button presses. Reply ONLY minified JSON, no prose, no fences:',
  '{"buttons":["a"|"b"|"up"|"down"|"left"|"right"|"start"|"select", ...],"note":"<≤14 words: what the screen says + your intent>"}',
  'Rules of thumb:',
  '- A dialogue/text box open → press ["a"] to advance it (repeat across turns to read on).',
  '- A yes/no or menu prompt → move the cursor (up/down) then ["a"] to confirm.',
  '- In a battle → read HP/move menu; ["a"] to FIGHT then pick a move, or navigate first.',
  '- Free roam (overworld, no text box) → walk with up/down/left/right toward unexplored areas or NPCs/doors.',
  '- Title/intro/save screens → ["a"] or ["start"] to proceed.',
  'Prefer 1-3 buttons per step. Put what you READ in note (e.g. "PROF OAK: are you a boy?").',
].join(' ');
