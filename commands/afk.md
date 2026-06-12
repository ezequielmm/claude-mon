---
description: "Control the claude-mon banner (on/off, game, rows, status)"
allowed-tools:
  - "Bash(node:*)"
  - "Read"
---

To control the claude-mon banner, first locate the plugin root:

1. Read the file `~/.claude/claude-mon/runtime.json`.
   - If the file does not exist, tell the user: "The claude-mon runtime file is missing. Please restart Claude Code so the plugin's SessionStart hook can initialize it."
   - If it exists, extract the `pluginRoot` field.

2. Run the control CLI with the user's arguments:

```bash
node "<pluginRoot>/scripts/afk-ctl.mjs" $ARGUMENTS
```

3. Show the script's output verbatim.

**Available commands:**

- `/afk status` — show current config and active session modes
- `/afk on` — enable the banner
- `/afk off` — disable the banner
- `/afk game fire` — switch to DOOM PSX fire effect
- `/afk game doom` — switch to DOOM WASM daemon mode (auto-spawns daemon on first use)
- `/afk rows <N>` — set banner height (2–15 rows)
- `/afk aspect <4:3|16:10|stretch>` — set DOOM frame aspect ratio (default: `4:3` — authentic CRT look, centered with pillarbox gutters; `stretch` restores full-width legacy behavior)
- `/afk fetch-doom` — download DOOM WASM assets into vendor/doom/ (required before game doom)
- `/afk play` — print the command to copy into a fresh terminal to play DOOM fullscreen
- `/afk setup [--yes] [--no-iterm]` — one-shot installer: wires statusline, downloads DOOM assets, offers iTerm2 on macOS for pixel-perfect mode

**Zero-step install (new users):**

The `SessionStart` auto-setup hook handles everything automatically after install:
- Creates `~/.claude/claude-mon/config.json` (if missing)
- Writes `~/.claude/claude-mon/statusline.sh` (if missing or stale)
- Adds `statusLine` to `~/.claude/settings.json` (if not already present, with backup)
- Downloads DOOM assets in the background (detached, logs to `~/.claude/claude-mon/setup.log`)

Run `/afk setup` for the guided installer which also offers iTerm2 on macOS.

**Phase B first-time setup (manual alternative):**

```
/afk fetch-doom
/afk game doom
```

The daemon starts automatically when the statusline first renders in doom mode.
Switch back with `/afk game fire` — the daemon stops within 10 minutes.

**Play DOOM fullscreen in your terminal:**

```
/afk play
```

This prints the exact command to copy into a fresh terminal tab. Paste and run it there — Claude Code's own terminal cannot be taken over by the player.

Controls: `WASD` / arrow keys move · `SPACE` use · `F` fire · `1`–`7` weapons · `ESC` menu · `Q` quit.
