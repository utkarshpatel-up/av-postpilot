# AV PostPilot

Edit-bay assistant for DaVinci Resolve Studio (Windows). It talks to Resolve through
Resolve's own script runner (`fuscript.exe` + `electron/bridge.lua`), so the editing
PCs need nothing extra installed: no Python.

## What it does

| Page | |
|---|---|
| **Dashboard** | Resolve connection, open project/library, auto-save status, shutdown countdown, render queue |
| **New Project** | Creates the project folders, moves (same drive) or copies the satsang day folders into `Satsang Files`, builds the Resolve project with bins, nested footage and `Master-` / `Edit-` timelines |
| **Auto-save** | Exports the open project as `.drp` every N minutes to several locations, only when it changed |
| **Scene Cuts** | Queue of timelines for *Detect Scene Cuts*, run one after another |
| **Episodes** | Creates episode series with a Text+ title; renames a series later (the `(…)` cue never changes) |
| **Renders** | Copies each finished render, optional HD review pass (one temporary timeline, individual clips, cleaned up afterwards), shutdown with countdown |
| **New Project** · **Episodes** · **Encoder** | Project folders / bins / Master-Edit timelines; episode series with plain or colour-bar titles; Media-Encoder-style queue with Resolve presets |
| **Notifications** | ntfy phone push (works on the office network), Telegram bot, WhatsApp (Whapi.Cloud) |

Footage is never deleted.

## Each editing PC
1. Either install `AV-PostPilot-<version>-Windows-Setup.exe`, or extract `AV-PostPilot-<version>-Windows-Portable.zip` into a local folder you can write to and double-click `AV PostPilot.exe`. The ZIP needs no installation or administrator rights. Keep all extracted files and folders together; do not run it from inside the ZIP.
2. Resolve: *Preferences → System → General → External scripting using: **Local***.
3. Resolve: *Preferences → User → Editing → Standard Generator Duration* = episode title length.
4. PostPilot: set the Auto-save locations; tokens on the Notifications page.

## Development
```
npm install
npm start          # run the app
npm test           # unit tests (no Resolve needed)
npm run dist:win   # build the Windows installer into dist/
npm run dist:zip   # build the complete extract-and-run Windows ZIP into dist/
```
The ZIP includes Electron and all app dependencies; target PCs do not need Node.js,
npm or Python. Resolve Studio must already be installed, with local scripting enabled.
Settings, queue state, logs and encrypted tokens stay in the current Windows user's
AppData folder, just as with the installed app. Extracting a newer ZIP does not reset
those settings. Tokens cannot be shared by copying another Windows user's AppData.
You can create a shortcut to `AV PostPilot.exe` yourself. Close PostPilot (including
its tray process) before switching versions. Office application-control policies may
still require IT to allow the executable, even though no installation is needed.

## Phone notifications without linking WhatsApp
For office alerts without linking your primary WhatsApp number, use the existing
ntfy phone push or Telegram bot integration. For ntfy, subscribe on the phone and
set the same topic on every editing PC, then use **Send test message**.
An unprotected topic is readable by anyone who knows its name; use a protected topic
on a configured server when alerts need access control.

The existing WhatsApp integration uses Whapi.Cloud. A different provider or phone
forwarding automation cannot guarantee that a linked WhatsApp account will avoid
restrictions. Do not link your primary number for office automation. An official
Meta Cloud API integration would need a business sender number and approved message
templates for proactive alerts; it is not implemented in this version.

`dev/` holds probe and live-test scripts that drive a running Resolve.
`AVPP_SCREENSHOT=<folder>` with `AVPP_PAGES=dashboard,renders,…` saves screenshots of pages;
`AVPP_USERDATA=<folder>` runs a separate copy with its own settings.

## Resolve quirks handled (found in live tests)
- Imported clips don't come back in order: clips are sorted by `Clip-NN`.
- Timeline names must be unique in a project.
- Loading the render preset that's already selected is ignored: switch away first.
- While rendering, Resolve doesn't report the open library; between jobs it briefly reports "not rendering" (15 s settle).
- Individual-clips renders add a frame number to file names; web presets can't render individual clips.

## Also in this repo
`resolve-db-backup/`: backup and restore scripts for the Mac PostgreSQL project server (launchd, project-count alarm, restore into a separate `restore_…` library). See `resolve-db-backup/HOW_TO_RESTORE.txt`.
