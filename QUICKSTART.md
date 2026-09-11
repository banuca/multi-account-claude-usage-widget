# Quick Start Guide

Get up and running with the Usage Widget in under 2 minutes.

## Step 1: Get the app

Nothing here is code-signed, and only the Windows packages have been built and
started so far — see the status table at the top of
[INSTALL.md](INSTALL.md) before you download anything.

- **Windows:** `AI-Usage-Monitor-{version}-win-Setup.exe` (installer) or
  `-win-portable.exe` (no installation), from
  [Releases](https://github.com/banuca/ai-usage-monitor/releases).
  Windows will warn you that the publisher is unverified, because it is.
- **macOS and Linux:** build from source for now
  (`npm ci && npm run build:mac` / `npm run build:linux`, Node 22.12+).

## Step 2: Install

### Windows
1. Run the downloaded `.exe` installer
2. Follow the installation wizard
3. Launch from Start Menu

**Or use the portable version** (no installation):
Download `AI-Usage-Monitor-{version}-win-portable.exe` and run it directly.

### Linux
1. Make the AppImage executable:
   ```bash
   chmod +x AI-Usage-Monitor-*.AppImage
   ```
2. Run it:
   ```bash
   ./AI-Usage-Monitor-*.AppImage
   ```

**Ubuntu 22.04+:** If it doesn't run, install libfuse2 first:
```bash
sudo apt install libfuse2
```

## Step 3: Add an account

1. **Launch the widget** — a small dark window appears.
2. **Choose how to track usage** — three routes on the first screen:
   - **Claude** or **ChatGPT** — sign in and the widget reads your usage.
   - **Enter usage manually** — no sign-in at all, you type the numbers.
     Useful if the embedded login is blocked, or if you just want a tracker.
3. **Done** — usage appears, or your manual numbers do.

Repeat from **Settings → + Add account** for each additional account (any mix
of providers). Each account keeps its own isolated login.

> Signing in needs a working OS credential store (Keychain on macOS, DPAPI on
> Windows, a keyring on Linux). If there isn't one, the widget says so and
> offers manual tracking rather than saving your session key unprotected.

## What You'll See

Each account card shows up to two usage rows with:

- **Label** — Which window the row is (current session, weekly limit, manual usage)
- **Bar + %** — How much of that window is used
- **Resets in** — Time left until the limit resets. Hover the row for the exact reset time or date

The usage graph (the ~ button) fits itself to the window. Make the window short
and it hides itself rather than squeezing out your accounts — it comes back on
its own when there is room again, and your setting is remembered either way.

**The color language (always the same):**

- 🟩 **Green** — below 80%
- 🟧 **Orange** — 80% to 94%
- 🟥 **Red** — 95% and up

## Daily Use

**Opening the widget:**
- Click the tray icon (Windows/Linux)

**Refreshing data:**
- Auto-refreshes on your chosen interval (default every 5 minutes)
- Click the refresh button for a manual update

**Minimizing:**
- Click the minus button (−) to hide to tray/dock

**Settings:**
- Click the sliders icon to customize:
  - Accounts (add/remove/rename, manual entry per account)
  - Launch at startup, always on top, tray stats, usage alerts
  - Time/date format (12h vs 24h)
  - Auto-refresh interval
  - Theme — the button at the bottom of the panel switches between the dark
    and light themes (VS Code Dark Modern / Light Modern). It says which theme
    it will switch to, and the choice is remembered.

**Manual entry (fallback):**
If automatic reading ever fails for an account, open Settings → Accounts → **Manual** and type your used/limit numbers. The widget falls back to them automatically, tagging the card `manual` + `fallback` so a stand-in is never mistaken for a live reading.

**When a reading is missing:**
A percentage the provider did not send shows as `—`, never as a green 0%. A failed refresh keeps the last good numbers with a `stale` tag; with nothing to fall back on the card says `unavailable`. The footer's **Updated** time only ever moves on a successful read, and says how many accounts are not current.

## System Tray Icons (Windows)

Two small icons in your system tray show usage at a glance, colored by the same green/orange/red bands:

- **Left:** Weekly usage percentage
- **Right:** Short-window (session) usage percentage
- **Red X:** Appears when usage reaches 99–100%

Hover over the icons to see exact percentages per account.

## Need Help?

- **Installation issues:** See [INSTALL.md](INSTALL.md) for detailed platform-specific guides
- **Feature questions:** Check the [README](README.md)
- **Problems:** Open a [Support Discussion](https://github.com/banuca/ai-usage-monitor/discussions/categories/support)

---

**That's it!** You're now tracking your Claude and ChatGPT usage. 🎉
