---
description: "DOOM fullscreen behind this Claude session — opens a new window, conversation continues there"
allowed-tools:
  - "Bash(node:*)"
  - "Read"
---

Launch the DOOM Arcade: a new terminal window running this same Claude
conversation (`claude --continue`) with DOOM compositing fullscreen behind it.

1. Read the file `~/.claude/claude-mon/runtime.json`.
   - If the file does not exist, tell the user: "The claude-mon runtime file is
     missing. Please restart Claude Code so the plugin's SessionStart hook can
     initialize it."
   - If it exists, extract the `pluginRoot` field.

2. Run:

```bash
node "<pluginRoot>/scripts/afk-ctl.mjs" arcade
```

3. Show the script's output verbatim, then tell the user their conversation
   continues in the new window (F8 or Ctrl+] toggles the keyboard between
   Claude and the marine; the heuristic bot plays whenever they don't).

Everything is resolved by absolute path — no PATH setup, no profiles, no
admin, no shims required.
