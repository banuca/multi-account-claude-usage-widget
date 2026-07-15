# Claude Usage Widget

A beautiful, freely resizable desktop widget for **Windows and Linux** that tracks your Claude.ai usage across **multiple accounts** in real time, with a clean table-style card for each account.

> **Project notice:** This is a fork maintained at `banuca/multi-account-claude-usage-widget`. It adds multi-account monitoring (e.g. personal + work), free window resizing, and a full visual redesign on top of the original widget. The original MIT licence and copyright notice are retained.

---

## Contents

- [Features](#features)
- [What's New in v2.1.0](#whats-new-in-v210)
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

👥 **Multi-account monitoring** — One table block per account (personal, work, and more), each polled independently
🖱️ **Free resize** — Drag any edge or corner; the layout adapts, hiding lower-priority columns as the window narrows
🎯 **Session & weekly rows** — Bar + %, an elapsed-window ring, and resets-in/resets-at for both the current session and the weekly limit
🚨 **"Closest to limit" badge** — A pulsing badge marks whichever account needs attention when you're tracking more than one
📈 **Usage history graph** — Per-account chips switch between accounts' session/weekly history over the last 7 days
🎨 **Dark / Light / System** — Switch instantly in Settings, no restart; System follows your OS live
🚦 **Fixed status colors** — Accent, warn, and danger colors stay identical in Dark and Light, so the limit signal is always readable
🔤 **Crafted typography** — Geist for the UI, Geist Mono for every number and label, Source Serif 4 for the wordmark (all bundled — no network fonts)
🔄 **Auto-refresh** — Configurable interval with an animated refresh indicator
📍 **Always on top** — User-controlled, stays visible across workspaces
💾 **System tray** — Minimize to tray, with an optional per-account usage rollup in the tray tooltip
⚙️ **Settings panel** — Persistent preferences for accounts, theme, startup, tray, thresholds, and date/time formats
🔔 **Update notifications** — Automatic check for new releases on startup
🕐 **Configurable date & time formats** — 12h/24h time and flexible weekly reset date display
🔒 **Secure** — Session keys stored locally in per-account encrypted storage
🐧 **Native Linux integration** — `.deb` and AppImage builds, correct taskbar icon, pinnable, and autostart support

---

## What's New in v2.1.0

### Reliability fixes for portable and long-running sessions

- Prevented duplicate app instances from competing when launched from startup/manual shortcuts.
- Kept minimize-to-tray recoverable even when usage-stat tray badges are disabled.
- Hardened background usage fetch windows and made auto-refresh non-overlapping.


### 🖱️ Free resize by dragging

The window is no longer a fixed size — drag any edge or corner to resize it. The account list scrolls if it doesn't fit, and columns hide themselves as the window narrows (resets-at below 560px, the elapsed ring below 500px) instead of the app forcing a size on you.

### 🎨 Full visual redesign

Every surface has been rebuilt around a cleaner table layout: a name row (with a pulsing "closest to limit" badge when tracking multiple accounts), column headers, and two data rows — current session and weekly limit — each with a bar, a percentage, an elapsed-window ring, and resets-in/resets-at times. New self-hosted typography (Geist, Geist Mono, Source Serif 4) and a Dark/Light/System theme switcher replace the previous 5-theme picker.

### 🐛 Bug fixes

- The usage history graph now actually records data (a wiring bug meant it was permanently empty in the previous multi-account release)
- Usage alerts (the warn/danger notification toggle) are now wired up and fire per account
- Closing the window with tray stats off now quits the app instead of leaving a headless background process

### 🐧 Linux packaging

`.deb` packages (in addition to AppImage) for correct taskbar integration out of the box, a proper icon, AppImage desktop-entry registration so it's pinnable too, and working autostart via the XDG autostart spec.

> For full release history, see the [Releases](../../releases) page.

---

## Settings

- 👥 **Accounts** — Add or remove Claude.ai accounts; rename any card
- 🎨 **Theme** — Dark / Light / System
- ⚙️ **Launch at startup** — Auto-start with login (Windows, and now Linux too)
- 🫥 **Hide from taskbar** — Tray-only mode
- 📌 **Always on top** — Keep the widget above other windows
- 📊 **Show tray stats** — Per-account usage rollup in the tray
- 🔔 **Usage alerts** — Desktop notifications when an account crosses the warn/danger threshold
- 🕐 **Time format** — 12h or 24h
- 📅 **Date format** — Controls how the weekly reset date is displayed
- ⏱️ **Auto-refresh** — How often usage is polled
- ⚠️ **Warn at** — Configurable amber (warn) and red (at-limit) thresholds

---

## Installation

### Download Pre-built Release

**Windows:**
1. Download the latest `Claude-Usage-Widget-{version}-win-Setup.exe` (installer) or `Claude-Usage-Widget-{version}-win-portable.exe` (no install needed) from [Releases](../../releases)
2. Run the installer or portable exe
3. Launch "Claude Usage Widget" from the Start Menu (installer) or directly (portable)
4. **To launch at Windows startup (portable only):** Press `Win+R`, type `shell:startup`, and copy the portable `.exe` into that folder. To update, copy the new version in and delete the old one.

**Linux — `.deb` (recommended for Debian/Ubuntu and derivatives):**
1. Download the latest `Claude-Usage-Widget-{version}-linux-amd64.deb` (Intel/AMD) or `Claude-Usage-Widget-{version}-linux-arm64.deb` (ARM) from [Releases](../../releases)
2. Install it: `sudo apt install ./Claude-Usage-Widget-*.deb`
3. Launch "Claude Usage Widget" from your application menu

The `.deb` registers the app, icon, and menu entry for you — it shows the correct icon in the taskbar out of the box and is pinnable immediately.

**Linux — AppImage (portable, no install):**
1. Download the latest `Claude-Usage-Widget-{version}-linux-x86_64.AppImage` (Intel/AMD) or `Claude-Usage-Widget-{version}-linux-arm64.AppImage` (ARM) from [Releases](../../releases)
2. Make it executable: `chmod +x Claude-Usage-Widget-*.AppImage`
3. Run it: `./Claude-Usage-Widget-*.AppImage`

> **Note:** AppImage runs without installation on most Linux distributions. On Ubuntu 22.04+, you may need to install a dependency first:
> ```bash
> sudo apt install libfuse2
> ```

On first run, the AppImage automatically registers a desktop entry and icon (`~/.local/share/applications/claude-usage-widget.desktop` + a hicolor icon) so it gets a correct taskbar icon and can be pinned, the same as the `.deb` gets automatically. If you move or update the AppImage file, this re-registers itself the next time you run it — no manual steps needed. (In earlier releases this required manually creating a `.desktop` file yourself; that's no longer necessary.)

**Autostart at login (deb or AppImage):** enable "Launch at startup" in Settings — this now works on Linux too, via a `~/.config/autostart` entry the app manages for you.

---

### Build from Source

**Prerequisites:**
- Node.js 18+ ([Download](https://nodejs.org))
- npm (comes with Node.js)

```bash
git clone https://github.com/banuca/multi-account-claude-usage-widget.git
cd multi-account-claude-usage-widget
npm install
npm start
```

---

## Usage

### First Launch

1. Launch the widget
2. Click "Add account" when prompted
3. A browser window will open — log in to your Claude.ai account
4. The widget will automatically capture your session
5. Usage data starts displaying immediately

Repeat "Add account" (from Settings) for each additional account you want to track.

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

Each account gets two rows — **Current Session** (the 5-hour window) and **Weekly Limit** (the 7-day window) — with the same columns:

| Column | Description |
|---|---|
| Bar + % | Utilization for that window; amber for session, blue for weekly, swapping to red once that row crosses the danger threshold |
| Elapsed ring | Fraction of the reset window elapsed (not the same as usage %) — turns red once the reset is imminent (≥90% elapsed) |
| Resets in | Time remaining until that window resets |
| Resets at | The local clock time (session) or date (weekly) the window resets |

If you're tracking two or more accounts, whichever one is closest to its limit gets a pulsing **"closest to limit"** badge next to its name once it crosses the warn threshold.

**Fixed colors (identical in Dark and Light):**
- 🟣 Accent (purple) — the elapsed ring's default color
- 🟠 Amber — warn threshold crossed (default 75%), and the "closest to limit" badge
- 🔴 Red — danger threshold crossed (default 90%) — bars, and the elapsed ring past 90% elapsed

Only the window background, text, and surface colors change between Dark and Light — the limit signal always reads the same.

---

## Privacy & Security

- Session keys stored **locally only**, in per-account encrypted storage
- No data sent to any third-party servers
- Only communicates with the official Claude.ai API
- Removing an account clears its session data, cookies, and Electron session partition

---

## Troubleshooting

**"Session expired" keeps appearing** — That account's session may have expired. Click "Reconnect" on the account card to re-authenticate.

**Widget not updating** — Check your internet connection, click refresh manually, or reconnect the affected account.

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
- [x] Custom warning thresholds
- [x] Configurable date & time formats
- [x] Update notifications
- [x] Multi-account monitoring
- [x] Themeable redesign (5 themes → Dark/Light/System in v2.0)
- [x] Organization/Teams support
- [x] Free window resizing
- [x] Native Linux packaging (deb, autostart, taskbar integration)
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

---

## License

This project is licensed under the [MIT License](LICENSE) — see the LICENSE file for details.

---

*Built with Electron · [Releases](../../releases) · [Discussions](../../discussions)*
