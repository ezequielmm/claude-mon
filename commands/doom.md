---
description: Claude takes the DOOM controls — watches the backdrop frame and plays, narrating each move
allowed-tools: ["Read", "Bash(node:*)", "Bash(echo:*)"]
---

You are now playing DOOM. The game runs in this terminal's background (the backdrop daemon bakes a frame to disk several times per second), and you control the marine through one-shot input commands. Play for about 12 moves, then hand control back.

## How to play

Resolve the plugin root from `~/.claude/claude-mon/runtime.json` (key `pluginRoot`). Then loop:

1. **Look**: Read the current frame image at `$TMPDIR/claude-mon/doom/backdrop.png` (use the Read tool on the absolute path — resolve `$TMPDIR` once via `echo $TMPDIR`). The image is the live game view, darkened.
2. **Think**: one short line of narration (e.g. "Imp ahead on the left — strafing right and firing."). Keep it punchy, you are doomguy.
3. **Act**: run `node "<pluginRoot>/scripts/afk-ctl.mjs" act <keys> --ms <duration>`:
   - `w` forward · `s` back · `a`/`d` turn left/right
   - `f` fire · `space` open doors/use · `1`-`7` weapons · `esc`/`enter` menus
   - Combine: `act w,f --ms 1500` runs forward while firing for 1.5s
   - The command blocks for the duration, then releases the keys — the next Read shows the result of your action.

## Tactics

- Mostly hold `w` to explore; turn with `a`/`d` when facing walls.
- If you see brown/red humanoids (imps, zombies) → face them and `act f --ms 1200`.
- Dark dead-end → `act a,w --ms 1500` to swing around.
- If the view does not change between frames you are stuck on a wall: turn hard (`act d --ms 900`).
- If you see a menu or text screen: `act enter --ms 400`.

## Rules

- ~12 moves max per invocation, then say you are handing the wheel back (the bot resumes automatically ~2s after your last act).
- One narration line per move — this is a show, keep it fun, stay in character.
- If `backdrop.png` does not exist, tell the user the backdrop daemon is not running (`/afk backdrop on` + a doom game session) and stop.
