<div align="center">

# 🔴 claude-mon

### Game Boy Advance — fullscreen *behind* your Claude Code session.
**Play it yourself, or let Claude play it by reading the screen.**

[![tests](https://github.com/ezequielmm/claude-mon/actions/workflows/test.yml/badge.svg)](https://github.com/ezequielmm/claude-mon/actions)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![claude code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d77655)](https://github.com/ezequielmm/claude-mon)
[![bring your own ROM](https://img.shields.io/badge/ROM-bring%20your%20own-important)](#-educational--bring-your-own-rom)

<img src="assets/firered-demo.gif" width="480" alt="Pokémon FireRed title screen running through claude-mon's emulator" />

<sub><i>Captured from the claude-mon emulator for illustrative purposes only.
Pokémon FireRed © 2004 Nintendo / Creatures Inc. / GAME FREAK inc. — all rights
reserved by their owners. <b>No ROM is distributed with this project</b>; the
cartridge shown was dumped by its owner.</i></sub>

</div>

---

A text-cell compositor renders a Game Boy Advance behind Claude Code's terminal
UI at **~30 fps**, in **any modern Windows console**, with **zero npm runtime
dependencies**. The whole pipeline is engine-agnostic — it's the GBA-focused
sibling of [**claude-doom**](https://github.com/ezequielmm/claude-doom) (same
compositor, different cartridge).

```
┌─ your terminal ───────────────────────────────────────────────┐
│ Claude Code v2.1.173                                           │
│ > help me refactor this module          ← Claude, floating     │
│ ● Sure — here's the plan...                on top              │
│ ▓▓▒▒░░  ▓▓▓▒▒  ░░▒▓   the GBA game plays behind it, F8 to grab │
│ ▒▒░░▓▓  ▒▒▓▓▓  ▓▓░░   the controls, F9 to hide it entirely     │
└────────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Educational / Bring Your Own ROM

> **claude-mon ships NO game ROMs and downloads NONE.** It vendors only a free,
> open-source GBA emulator core ([gbajs](https://github.com/endrift/gbajs), MIT)
> and homebrew test demos. Commercial game ROMs (Pokémon and everything else)
> are copyrighted — you must supply your **own legally-obtained dump of a
> cartridge you own**, via `/afk rom <path>`. For education and personal use
> with content you are legally entitled to use. The authors do not condone or
> facilitate piracy. *Pokémon*, *Game Boy Advance*, and *Nintendo* are
> trademarks of their respective owners; this project is unaffiliated.

---

## 🚀 Quick Start

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

## 🎮 Controls

| Key | Action |
|:---:|---|
| **F8** · `Ctrl+]` | Toggle **your keyboard** between Claude and the game |
| **F9** | Hide / show the game — Claude keeps running on a clean console |
| arrows | D-pad &nbsp;·&nbsp; **Space** = A &nbsp;·&nbsp; **F** = B &nbsp;·&nbsp; **Enter** = Start &nbsp;·&nbsp; **Esc** = Select &nbsp;·&nbsp; **1/2** = L/R |

## 🧠 Let Claude play it

```
/afk brain on
```

A cheap model reads the **actual on-screen text** each turn — dialogue boxes,
menus, battle prompts — and presses buttons accordingly. It's *"Claude Plays
Pokémon"* running behind your coding session.

```
/afk brain status    # what it just read, e.g.  [a] "PROF OAK: Are you a boy?"
/afk brain off       # hand control back
```

## 🛠️ More commands

| Command | Does |
|---|---|
| `/afk screen on` | plain `claude` ALWAYS boots with the game behind it (same window) |
| `/afk screen off` | back to a normal claude |
| `/afk rom <path>` | load a different ROM — **your file, never downloaded** |
| `/afk game gba` | GBA mode (default) |

Battery saves persist to `~/.claude/claude-mon/saves/` per ROM (SRAM, Flash,
EEPROM). The emulator paces itself to the GBA's real ~60 fps regardless of
daemon cadence.

---

## 🔧 How it works

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

## 👩‍💻 Development

```sh
node scripts/fetch-gba.mjs   # vendor the emulator + homebrew test demos
node test/run.mjs            # test suite (homebrew demos only, no game ROMs)
```

## 📜 License & Credits

Plugin code: **MIT** © Ezequiel Mora Martinez.
Emulator core: [gbajs](https://github.com/endrift/gbajs) by Jeffrey Pfau (MIT).
Homebrew demos: [tonc](https://www.coranac.com/tonc/) by Jasper Vijn.
*Pokémon*, *Game Boy Advance*, *Nintendo* — trademarks of their respective
owners; this project is unaffiliated and bundles no copyrighted game content.
