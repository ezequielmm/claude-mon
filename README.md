# claude-mon

**Play Game Boy Advance games fullscreen behind your Claude Code session —
or let Claude play them by reading the screen.** A text-cell compositor runs
the emulator behind the terminal UI at ~30 fps in any modern Windows console,
with zero npm runtime dependencies.

> [!IMPORTANT]
> ### Educational project — Bring Your Own ROM
> **claude-mon ships NO game ROMs and downloads NONE.** It vendors only a
> free, open-source GBA emulator core ([gbajs](https://github.com/endrift/gbajs),
> MIT) and homebrew test demos. Commercial game ROMs (Pokémon and everything
> else) are copyrighted — you must supply your **own legally-obtained dump of a
> cartridge you own**, pointed at via `/afk rom <path>`. This project is for
> education and personal use with content you are legally entitled to use. The
> authors do not condone or facilitate piracy. "Pokémon" and "Game Boy Advance"
> are trademarks of Nintendo / Game Freak; this project is unaffiliated.

---

## Quick Start

```sh
# 1. Install
claude plugin marketplace add ezequielmm/claude-mon
claude plugin install claude-mon@claude-mon-marketplace

# 2. Restart Claude Code

# 3. Point it at YOUR legally-dumped ROM, then launch
/afk rom D:\roms\your-cartridge-dump.gba
/pokemon
```

A new window opens where **your same conversation continues
(`claude --continue`) with the game playing fullscreen behind it.**

### Keys

| Key | Action |
|---|---|
| **F8** (or `Ctrl+]`) | Toggle YOUR keyboard between Claude and the game (arrows = D-pad, Space = A, F = B, Enter = Start, Esc = Select, 1/2 = L/R) |
| **F9** | Hide/show the game — Claude keeps running on a clean console |

### Let Claude play it

```
/afk brain on
```

A cheap model (haiku) reads the **actual on-screen text** each turn — dialog
boxes, menus, battle prompts — and presses buttons accordingly. It's "Claude
Plays Pokémon" running behind your coding session. `/afk brain status` shows
what it just read; `/afk brain off` stops it.

### More

```
/afk screen on    # plain `claude` ALWAYS boots with the game behind it (same window)
/afk screen off   # back to a normal claude
/afk rom <path>   # change which ROM is loaded (your file — never downloaded)
/afk game gba     # GBA mode (default)
```

Battery saves persist to `~/.claude/claude-mon/saves/` per ROM (SRAM, Flash,
EEPROM — the Flash 1M chip used by larger carts included). The emulator paces
itself to the GBA's real ~60 fps regardless of daemon cadence.

---

## How it works

```
Claude Code (inside a pseudo-terminal)
        │ its screen → @xterm/headless (virtual screen)
        ▼
   compositor ── merges ──►  real terminal (alt-screen)
        ▲                      Claude's cells win where they have content;
        │                      the game shows through everywhere else
   GBA emulator (gbajs)
   240×160 frame → quadrant text cells
```

The whole pipeline is engine-agnostic — it only ever consumes a frame buffer
and a key contract. claude-mon is the GBA-focused sibling of
[claude-doom](https://github.com/ezequielmm/claude-doom) (same compositor,
different cartridge).

## What gets written to your machine

| Path | What |
|---|---|
| `~/.claude/claude-mon/config.json` | Plugin settings (game, ROM path, rows) |
| `~/.claude/claude-mon/saves/<rom>.sav` | Per-ROM battery saves |
| `<plugin>/vendor/gba/` | gbajs emulator + homebrew test demos (gitignored) |

ROMs are **never** stored in the repo or downloaded.

## Development

```sh
node scripts/fetch-gba.mjs   # vendor the emulator + homebrew test demos
node test/run.mjs            # test suite (uses homebrew demos, no game ROMs)
```

## License & Credits

Plugin code: MIT © Ezequiel Mora Martinez. Emulator core:
[gbajs](https://github.com/endrift/gbajs) by Jeffrey Pfau (MIT). Homebrew test
demos: [tonc](https://www.coranac.com/tonc/) by Jasper Vijn. "Pokémon",
"Game Boy Advance", and "Nintendo" are trademarks of their respective owners;
this project is unaffiliated and bundles no copyrighted game content.
