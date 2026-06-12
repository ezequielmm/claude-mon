---
description: "Launch the GBA arcade — your conversation continues in a new window with your game fullscreen behind it"
allowed-tools:
  - "Bash(node:*)"
  - "Read"
---

Launch claude-mon: a new terminal window running this same Claude
conversation (`claude --continue`) with your Game Boy Advance game
compositing fullscreen behind it.

1. Read the file `~/.claude/claude-mon/runtime.json`.
   - If it does not exist, tell the user to restart Claude Code so the
     SessionStart hook can initialize it.
   - Otherwise extract the `pluginRoot` field.

2. First check a ROM is configured:

```bash
node "<pluginRoot>/scripts/afk-ctl.mjs" rom
```

   - If no ROM is set, tell the user to run `/afk rom <path-to-their.gba>`
     first — claude-mon never ships or downloads game ROMs; the user
     supplies their own legally-dumped file.

3. Then launch:

```bash
node "<pluginRoot>/scripts/afk-ctl.mjs" arcade
```

4. Show the output. Tell the user: F8 toggles their keyboard between
   Claude and the game; F9 hides the game; `/afk brain on` lets Claude
   play by reading the screen.
