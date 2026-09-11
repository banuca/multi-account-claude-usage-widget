# Installation Instructions

## Current build and signing status

Read this first: it says which packages actually exist and which have been
started on the platform they target.

| Platform | Packages | Built | Launched and tested | Signed |
| --- | --- | --- | --- | --- |
| Windows x64 | NSIS installer, portable `.exe` | yes | yes — the built app was started twice on a synthetic profile | **no** |
| macOS arm64 / x64 | DMG, ZIP | not yet | not yet | **no** |
| Linux x64 / arm64 | AppImage, `.deb` | not yet | not yet | **no** |

Nothing in this project is code-signed or notarized. There is no signing
identity, and the build is configured so that it cannot pick one up from
whatever machine happens to run it. That means:

- **Windows** shows a SmartScreen warning for an unsigned executable. That
  warning is correct — you are choosing to trust a build you obtained
  yourself.
- **macOS** Gatekeeper will refuse an unsigned application downloaded from the
  internet. Build it yourself from source (below), or wait for a signed
  release. Do not run commands that strip the quarantine attribute to get
  around this; the warning is doing its job.
- **Linux** has no equivalent gate, but the AppImage and `.deb` are equally
  unsigned.

The macOS and Linux packages are produced by the verification workflows in
`.github/workflows/` on native runners. Until those have run, treat the
sections below as instructions for a build you make yourself.

## For End Users

### Windows

**Option 1: Installer (Recommended)**
1. Download the latest `AI-Usage-Monitor-{version}-win-Setup.exe` from [Releases](https://github.com/banuca/ai-usage-monitor/releases)
2. Run the installer
3. Launch "AI Usage Monitor" from the Start Menu
4. Login when prompted

**Option 2: Portable (No Installation)**
1. Download the latest `AI-Usage-Monitor-{version}-win-portable.exe` from [Releases](https://github.com/banuca/ai-usage-monitor/releases)
2. Run the portable exe directly
3. No installation needed - runs from wherever you place it

**What Gets Installed (Installer Only):**
- Executable: `%LOCALAPPDATA%\Programs\claude-usage-widget\`
- Settings: `%APPDATA%\claude-usage-widget\` (encrypted)
- Start Menu shortcut
- Desktop shortcut (optional)

---

### macOS

**No signed macOS release exists yet.** Build it yourself:

```bash
git clone https://github.com/banuca/ai-usage-monitor.git
cd claude-usage-widget
npm ci
npm run build:mac        # produces dist/*.dmg and dist/*.zip for this Mac
```

The build is unsigned, so an application you build on your own Mac opens
normally, while one copied from another machine is blocked by Gatekeeper. That
is expected for an unsigned build, and it is not something to work around.

When a signed release exists, the DMG for your Mac will be on the
[Releases](https://github.com/banuca/ai-usage-monitor/releases)
page: `AI-Usage-Monitor-{version}-mac-arm64.dmg` for Apple Silicon,
`-mac-x64.dmg` for Intel. Open it and drag the app to Applications.

**Requires macOS 13 Ventura or later** — that is Electron 44's own minimum, not
a choice this project made.

**What Gets Installed:**
- Application: `/Applications/AI Usage Monitor.app`
- Settings: `~/Library/Application Support/claude-usage-widget/` (encrypted)

---

### Linux

**Installation Steps:**
1. Download the latest AppImage for your architecture:
   - Intel/AMD (64-bit): `AI-Usage-Monitor-{version}-linux-x86_64.AppImage`
   - ARM (64-bit): `AI-Usage-Monitor-{version}-linux-arm64.AppImage`
   - Available from [Releases](https://github.com/banuca/ai-usage-monitor/releases)
2. Make it executable:
   ```bash
   chmod +x AI-Usage-Monitor-*.AppImage
   ```
3. Run it:
   ```bash
   ./AI-Usage-Monitor-*.AppImage
   ```

**Ubuntu 22.04+ Dependency:**

If the AppImage doesn't run, install libfuse2:
```bash
sudo apt install libfuse2
```

**Optional: Desktop Launcher & Autostart**

For desktop integration (application menu icon, auto-start on login), see the detailed guide in the [Linux Setup Section](#linux-desktop-launcher--autostart-optional) below.

**What Gets Created:**
- Settings: `~/.config/claude-usage-widget/` (encrypted)
- Desktop launcher (if configured): `~/.local/share/applications/claude-usage-widget.desktop`
- Autostart entry (if configured): `~/.config/autostart/claude-usage-widget.desktop`

---

## First Time Setup (All Platforms)

1. **Launch the widget** — a small frameless window appears.
2. **Choose how to track usage** — the first screen offers three routes:
   - **Claude** — sign in to claude.ai and let the widget read your usage.
   - **ChatGPT** — sign in to chatgpt.com and let the widget read your usage.
   - **Enter usage manually** — no sign-in at all; you type the numbers. This
     is a different thing from "paste session key", which is a fallback *for*
     signing in when the embedded login is blocked.
3. **Widget activates** — usage appears, or your manual numbers do.
4. **Add more accounts** — Settings → Accounts → *+ Add account*. Multiple
   accounts per provider are fine; each gets its own isolated login.
5. **Minimise to tray** — the minus icon (Windows/Linux) or the Dock (macOS).

> **If automatic reading fails**, the card says which state it is in — stale,
> unavailable, or falling back to your manual numbers — and never shows a
> figure it did not read. Your saved login is kept; a failed read is not
> treated as a failed login.

---

## System Requirements

**All Platforms:**
- RAM: 200 MB
- Disk: 300 MB
- Internet: required for automatic reading. Manual tracking works offline.
- A working OS credential store (Windows DPAPI, macOS Keychain, or a Linux
  keyring such as GNOME Keyring / KWallet). Without one the widget will not
  save a provider login at all — it says so, and manual tracking still works.
  See "Secure storage" in the troubleshooting section.

**Platform-Specific:**
- **Windows:** Windows 10 or later (64-bit only — 32-bit is no longer supported)
- **macOS:** macOS 13 Ventura or later
- **Linux:** Any modern distribution with AppImage support (x64 or 64-bit ARM)

---

## Linux: Desktop Launcher & Autostart (Optional)

*Contributed by [@sergkuzn](https://github.com/sergkuzn)*

This section shows how to integrate the AppImage into your Linux desktop environment with an application menu icon and auto-start on login.

### Step 1: Place the AppImage

Move the AppImage to a permanent location:
```bash
mkdir -p ~/.local/bin
mv AI-Usage-Monitor-*.AppImage ~/.local/bin/claude-usage-widget.AppImage
```

### Step 2: Create Desktop Launcher

Create `~/.local/share/applications/claude-usage-widget.desktop`:
```ini
[Desktop Entry]
Name=AI Usage Monitor
Comment=Monitor Claude.ai usage
Exec=/home/YOUR_USERNAME/.local/bin/claude-usage-widget.AppImage
Icon=/home/YOUR_USERNAME/.local/share/icons/claude-usage-widget.png
Terminal=false
Type=Application
Categories=Utility;
```

**Important:** Replace `YOUR_USERNAME` with your actual username.

### Step 3: Add an Icon (Optional)

Download an icon and place it at:
```bash
mkdir -p ~/.local/share/icons
# Place your icon file as:
# ~/.local/share/icons/claude-usage-widget.png
```

The icon will appear in your application menu.

### Step 4: Enable Autostart (Optional)

Create `~/.config/autostart/claude-usage-widget.desktop`:
```bash
mkdir -p ~/.config/autostart
cp ~/.local/share/applications/claude-usage-widget.desktop ~/.config/autostart/
```

The widget will now launch automatically when you log in.

**Desktop Environment Notes:**
- **GNOME:** Icon may not appear in app grid immediately - log out/in to refresh
- **KDE Plasma:** Should appear instantly in application launcher
- **XFCE:** Icon appears in Whisker Menu after refresh

---

## Build from Source (All Platforms)

**Prerequisites:**
- Node.js **22.12.0 or later** ([Download](https://nodejs.org)) — this is
  Electron 44's own requirement, not a preference. Node 20 cannot install or
  rebuild it.
- npm 10+ (comes with Node.js)

**Build Steps:**
```bash
git clone https://github.com/banuca/ai-usage-monitor.git
cd claude-usage-widget
npm ci          # from the committed lockfile
npm start
```

**Platform-Specific Builds** (each must run on the platform it targets — a
cross-build produces a package that has never been started):
```bash
npm run build:win    # Windows: NSIS installer + portable exe (x64)
npm run build:mac    # macOS: DMG + ZIP (arm64 and x64, requires macOS)
npm run build:linux  # Linux: AppImage + deb (x64 and arm64)
```

**Verifying a build you made:**
```bash
npm test                                          # unit tests
npm run test:electron:all                         # Electron suites
node test/verify-package-contents.cjs --app dist/win-unpacked
node test/packaged-smoke.cjs --exe dist/win-unpacked/AI-Usage-Monitor.exe
```

---

## Uninstallation

### Windows (Installer)
- Use "Add or Remove Programs" in Windows Settings
- Or run the uninstaller from the Start Menu folder

### Windows (Portable)
- Simply delete the executable

### macOS
- Drag "AI Usage Monitor" from Applications to Trash
- Optionally delete settings: `~/Library/Application Support/claude-usage-widget/`

### Linux
- Delete the AppImage file
- Optionally delete settings: `~/.config/claude-usage-widget/`
- Remove desktop launcher: `rm ~/.local/share/applications/claude-usage-widget.desktop`
- Remove autostart entry: `rm ~/.config/autostart/claude-usage-widget.desktop`

---

## Troubleshooting

**A card says "Not connected" or "Session expired"**
"Session expired" means the provider actually rejected the saved login;
"Not connected" means there is no saved login for that account. Either way,
click the action on the card, or use Settings → Accounts → *Connect/Reconnect*.
Your history and manual settings are untouched by reconnecting, and the old
login is kept until the new one is saved.

**A card says "Secure storage unavailable"**
The saved login is still there, but the OS credential store will not open it —
a locked keychain, or no keyring running. Reconnecting cannot fix that, so the
widget does not pretend it can. Unlock your keyring (on Linux, start
gnome-keyring or KWallet) and refresh. Nothing has been deleted.

**Settings says logins cannot be saved**
The OS offers no protected credential storage — most often a Linux session with
no keyring, or one where Chromium falls back to `basic_text`, which provides no
real protection. Rather than write your session key to a plain file, the widget
refuses to save it and offers manual tracking instead.

**A banner says the settings file could not be read**
Nothing was deleted. The original file is kept next to the new one as
`config.unreadable-<timestamp>.json` in the settings folder, and the widget
started fresh so you can use it. If the banner instead says changes will not be
saved, the file could not be opened at all and has been left exactly as it was.

**ChatGPT shows no numbers**  
OpenAI may have changed the internal readout. Use Settings → Accounts → Manual to enter your used/limit numbers.

**Widget not updating**  
Check internet connection, click refresh manually, or try re-logging in from the tray menu.

**Build errors**  
Clean reinstall resolves most issues:
```bash
rm -rf node_modules package-lock.json
npm install
```

**macOS: "app is damaged" or "cannot be opened"**
The build is unsigned, so Gatekeeper blocks a copy that came from another
machine. Build it on the Mac you want to run it on (`npm run build:mac`), or
wait for a signed release. Stripping the quarantine attribute is not a fix —
it disables the check that is telling you something true.

**Linux: AppImage won't run**  
Install libfuse2: `sudo apt install libfuse2`

If issues persist, open a [Support Discussion](https://github.com/banuca/ai-usage-monitor/discussions/categories/support) with your OS, Node.js version, and full error output.
