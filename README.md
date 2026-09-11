# AI Usage Monitor

A minimal, freely resizable desktop widget for **Windows and Linux** that tracks your AI usage across **multiple Claude and ChatGPT accounts** in real time — all in one clean, black interface.

> **Project notice:** This is a fork maintained at `banuca/ai-usage-monitor`. It adds multi-account monitoring (e.g. personal + work), free window resizing, and a full visual redesign on top of the original Claude-only widget. v3.0 adds **ChatGPT support** and fixed usage colors; v4.0 moves the interface to the VS Code Dark Modern palette with the platform's own UI typeface (no fonts are bundled), runs on Electron 44, and adds manual-only tracking, honest read/credential states and non-destructive configuration recovery. The original MIT licence and copyright notice are retained.

---

## Contents

- [Features](#features)
- [What's New in v3.0.0](#whats-new-in-v300)
- [Settings](#settings)
- [Installation](#installation)
- [Usage](#usage)
- [Understanding the Display](#understanding-the-display)
- [Privacy & Security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Support](#support)

---

## Features

👥 **Claude + ChatGPT, multi-account** — One card per account (personal, work, and more), any mix of providers, each polled independently
🎛️ **VS Code Dark Modern interface** — one dark surface, thin separators, the platform's own UI font. No theme picker, no gradients, no decorative chrome
🚦 **One color language** — Every usage number is **green from 0–79%**, **orange from 80–94%**, **red from 95–100%** — fixed, on cards, tray and alerts alike

🔍 **Readings you can trust** — A missing or unreadable percentage shows as `—`, never as a green 0%. If a refresh fails, the card keeps the last good numbers and tags them `stale` with the time they were actually read; with nothing to fall back on it says `unavailable`
🖱️ **Free resize** — Drag any edge or corner; the layout adapts as the window narrows
🎯 **Per-window rows** — One compact row per usage window: label, bar, % and a countdown to the reset (Claude's 5-hour session + 7-day weekly, ChatGPT's server-reported windows). Hover a row for the exact reset date/time
✍️ **Manual entry fallback** — If automatic reading ever fails, enter used/limit numbers yourself (per account)
🚨 **"Closest to limit" label** — Marks whichever account needs attention when you're tracking more than one
📈 **Usage history graph** — Per-account chips switch between accounts' history over the last 7 days. The panel sizes itself to the window and steps aside in a short one, so the account list and footer are never pushed off screen; your graph setting is kept and the panel returns on its own when the window grows
🔄 **Auto-refresh** — Configurable interval with an animated refresh indicator
📍 **Always on top** — User-controlled, stays visible across workspaces
💾 **System tray** — Minimize to tray, with an optional per-account usage rollup in the tray tooltip
⚙️ **Settings panel** — Persistent preferences for accounts, startup, tray, alerts, and date/time formats
🔔 **Update notifications** — Automatic check for new releases on startup
🕐 **Configurable date & time formats** — 12h/24h time and flexible weekly reset date display
🔒 **Secure** — Credentials stored locally in per-account encrypted storage
🐧 **Native Linux integration** — `.deb` and AppImage builds, correct taskbar icon, pinnable, and autostart support

---

## What's New in v3.0.0

### 🤖 ChatGPT support

Accounts now have a provider: **Claude** or **ChatGPT**. Add either from the same flow. ChatGPT usage is read automatically from your logged-in chatgpt.com session. Because that readout is an internal, undocumented endpoint that OpenAI can change at any time, every account also has an optional **Manual entry** (used / limit) in Settings — if auto-reading fails, the widget falls back to your numbers automatically.

### 🖤 Minimalist black redesign

The theme picker is gone — the widget is always black. All the old accent colors, gradients and purple/blue bars are replaced by one fixed color language: usage is **green below 80%**, turns **orange from 80%**, and **red for the last 5% (95%+)**. These thresholds are fixed by design (no threshold settings anymore); the same colors drive the tray badges and the usage alerts.

### 🐛 Fixes & cleanup

- Removed the Light/System themes and the warn/danger threshold settings (simplification)
- Tray badges and notifications now follow the same green/orange/red bands
- Per-account manual usage entries for both providers

---

## Settings

- 👥 **Accounts** — Add or remove Claude / ChatGPT accounts; rename any card; per-account manual usage entry
- ⚙️ **Launch at startup** — Auto-start with login (Windows, and Linux)
- 🫥 **Hide from taskbar** — Tray-only mode
- 📌 **Always on top** — Keep the widget above other windows
- 📊 **Show tray stats** — Per-account usage rollup in the tray
- 🔔 **Usage alerts** — Desktop notifications when an account crosses 80% (orange) or 95% (red)
- 🕐 **Time format** — 12h or 24h
- 📅 **Date format** — Controls how the weekly reset date is displayed
- ⏱️ **Auto-refresh** — How often usage is polled
- 🌗 **Theme** — A button at the bottom of the Settings panel switches between
  the dark and light themes. Both are Microsoft's own VS Code defaults (Dark
  Modern and Light Modern); the choice is remembered and is applied before the
  window paints, so there is no flash of the other palette at startup.

---

## Installation

### Download Pre-built Release

**Windows:**
1. Download the latest `AI-Usage-Monitor-{version}-win-Setup.exe` (installer) or `AI-Usage-Monitor-{version}-win-portable.exe` (no install needed) from [Releases](../../releases)
2. Run the installer or portable exe
3. Launch "AI Usage Monitor" from the Start Menu (installer) or directly (portable)
4. **To launch at Windows startup (portable only):** Press `Win+R`, type `shell:startup`, and copy the portable `.exe` into that folder. To update, copy the new version in and delete the old one.

**Linux — `.deb` (recommended for Debian/Ubuntu and derivatives):**
1. Download the latest `AI-Usage-Monitor-{version}-linux-amd64.deb` (Intel/AMD) or `AI-Usage-Monitor-{version}-linux-arm64.deb` (ARM) from [Releases](../../releases)
2. Install it: `sudo apt install ./AI-Usage-Monitor-*.deb`
3. Launch "AI Usage Monitor" from your application menu

The `.deb` registers the app, icon, and menu entry for you — it shows the correct icon in the taskbar out of the box and is pinnable immediately.

**Linux — AppImage (portable, no install):**
1. Download the latest `AI-Usage-Monitor-{version}-linux-x86_64.AppImage` (Intel/AMD) or `AI-Usage-Monitor-{version}-linux-arm64.AppImage` (ARM) from [Releases](../../releases)
2. Make it executable: `chmod +x AI-Usage-Monitor-*.AppImage`
3. Run it: `./AI-Usage-Monitor-*.AppImage`

> **Note:** AppImage runs without installation on most Linux distributions. On Ubuntu 22.04+, you may need to install a dependency first:
> ```bash
> sudo apt install libfuse2
> ```

On first run, the AppImage automatically registers a desktop entry and icon (`~/.local/share/applications/claude-usage-widget.desktop` + a hicolor icon) so it gets a correct taskbar icon and can be pinned, the same as the `.deb` gets automatically. If you move or update the AppImage file, this re-registers itself the next time you run it — no manual steps needed.

**Autostart at login (deb or AppImage):** enable "Launch at startup" in Settings — this works on Linux too, via a `~/.config/autostart` entry the app manages for you.

---

### Build from Source

**Prerequisites:**
- Node.js 22.12+ ([Download](https://nodejs.org)) — required by Electron 44
- npm (comes with Node.js)

```bash
git clone https://github.com/banuca/ai-usage-monitor.git
cd ai-usage-monitor
npm install
npm start
```

---

## Usage

### First Launch

1. Launch the widget
2. Click "Add account" when prompted, and pick **Claude** or **ChatGPT**
3. A browser window will open — log in to that provider
4. The widget automatically captures your session and starts displaying usage

Repeat "Add account" (from Settings) for each additional account you want to track — any mix of providers.

### Manual entry (fallback)

If automatic reading ever fails for an account (or you want to type the numbers yourself): open **Settings → Accounts → Manual** for that account, tick "Use manual entry", enter your **used / limit** numbers and Save. The card switches to the manual row (tagged `manual`). Untick it to go back to automatic reading.

When an automatic read fails and a manual entry exists but is *not* ticked, the widget shows your manual numbers anyway — tagged both `manual` and `fallback`, so a stand-in is never mistaken for a successful automatic reading. A manual entry with no usable limit shows `—` rather than 0%.

### What the card tells you about a reading

| Marking | Meaning |
|---|---|
| a number, no tag | A fresh, successful automatic reading. `0%` here is a real zero |
| `—` in the Used column | That reading was missing or unreadable in the provider's response. It is **not** 0% |
| `stale` tag | This refresh failed; the numbers are the last successful reading. Hover for the error and the time they were read |
| `unavailable` tag | The read failed and there is no earlier reading to show |
| `manual` tag | Your own numbers (Settings → Accounts → Manual) |
| `fallback` tag | Your manual numbers standing in for a failed automatic read |

The footer's **Updated** time is the most recent *successful* reading — redrawing the window, changing a setting or a failed refresh never moves it. With more than one account it also shows how many are not currently reading, e.g. `Updated 14:07 · 1/3 not current · refresh 5m`. Before any account has ever read successfully it says `Never updated`.

A failed or unreadable refresh writes no history sample and fires no alert: the usage graph shows a gap rather than a dip to zero, and an alert that has already fired is not re-sent just because a reading went missing.

### Widget Controls

- **Drag** — Click and drag the title bar to move the widget
- **Resize** — Drag any edge or corner to resize freely (min 480×150); the size is remembered across restarts
- **Settings** — Click the sliders icon to open Settings
- **Refresh** — Click the refresh icon to update data immediately
- **Graph** — Click the graph icon to show usage history; switch accounts with the chips above the chart
- **Minimize** — Click the minus icon to hide to system tray / dock
- **Close** — Click the X to close the app

### System Tray

Right-click the tray icon for: Show/Hide, Refresh, per-account details, Settings, and Exit.

---

## Understanding the Display

Each account card has up to two rows — the usage windows the provider reports (Claude: **current session** 5-hour window + **weekly limit** 7-day window; ChatGPT: the short and weekly windows reported by its API) — with the same columns:

| Column | Description |
|---|---|
| Label | Which window this row is (`Current session`, `Weekly limit`, `Manual usage`, …) |
| Bar + % | Utilization for that window, colored by that row's own % |
| Resets in | Time remaining until that window resets. Hover the row for the exact reset time (session) or date (weekly), in your chosen format |

A row that reports no reset window — a manual entry, or a read that reported
nothing — shows no reset column at all rather than an empty one.

If you're tracking two or more accounts, whichever one is closest to its limit gets a **"closest to limit"** label next to its name once it crosses 80%.

**One color language, everywhere (fixed, not configurable):**

- 🟩 **Green** — below 80% used
- 🟧 **Orange** — 80% to 94% used
- 🟥 **Red** — 95% used and up (the last 5%)

The bars, the percentages, the tray badges, and the desktop alerts all use exactly these three colors. The rest of the app is black.

---

## Privacy & Security

- Credentials stored **locally only**, in per-account encrypted storage
- No data sent to any third-party servers
- Only communicates with the official Claude.ai API and chatgpt.com
- Removing an account clears its session data, cookies, and Electron session partition

> **Note on ChatGPT:** the widget reads chatgpt.com's internal, undocumented usage endpoint from your own logged-in session. OpenAI may change or remove it at any time — that's what the manual entry fallback is for.

---

## Troubleshooting

**"Session expired" keeps appearing** — That account's session may have expired. Click "Reconnect" on the account card to re-authenticate.

**ChatGPT shows no numbers** — OpenAI may have changed the internal readout. The card shows `—` with an `unavailable` or `stale` tag rather than a misleading 0%. Use the manual entry (Settings → Accounts → Manual) until an update restores automatic reading.

**Widget not updating** — Check the footer: if it says `not current`, or a card carries a `stale` / `unavailable` tag, the last refresh failed (hover the tag for the reason). Check your internet connection, click refresh manually, or reconnect the affected account.

**Build errors** — A clean reinstall resolves most issues:
```bash
rm -rf node_modules package-lock.json
npm install
```

If issues persist, open a [Support discussion](../../discussions/categories/support) with your OS, Node.js version, and full error output.

---

## Roadmap

- [x] Linux support
- [x] Settings panel
- [x] Remember window position
- [x] Configurable date & time formats
- [x] Update notifications
- [x] Multi-account monitoring
- [x] Organization/Teams support
- [x] Free window resizing
- [x] Native Linux packaging (deb, autostart, taskbar integration)
- [x] ChatGPT account support (v3.0)
- [x] Minimalist black redesign with fixed green/orange/red usage bands (v3.0)
- [ ] Keyboard shortcuts

---

## Support

If this widget is useful to you, you can support development here:

☕ **[buymeacoffee.com/banuca](https://buymeacoffee.com/banuca)**

---

## Credits

Built as a fork of the original Claude Usage Widget. Thanks to the upstream author and contributors whose work this builds on:

- [@cwil2072](https://github.com/cwil2072) — macOS minimize/restore fix, usage history graph
- [@dion-jy](https://github.com/dion-jy) — Login flow architecture improvements
- [@goooseman](https://github.com/goooseman) — Login window security improvements
- [@sergkuzn](https://github.com/sergkuzn) — Linux desktop launcher & autostart documentation

ChatGPT support is built on the community's research into chatgpt.com's internal `backend-api/wham/usage` endpoint (see [openai/codex](https://github.com/openai/codex), [opencode-mystatus](https://github.com/vbgate/opencode-mystatus), [OpenTokenUsage](https://github.com/PowerUserZ/OpenTokenUsage)).

---

## License

This project is licensed under the [MIT License](LICENSE) — see the LICENSE file for details.

---

*Built with Electron · [Releases](../../releases) · [Discussions](../../discussions)*
