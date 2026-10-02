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
| **Scene Edit** | Queue of timelines for *Detect Scene Cuts*, run one after another |
| **Episodes** | Creates episode series with a Text+ title; renames a series later (the `(…)` cue never changes) |
| **Renders** | Copies each finished render, optional HD review pass (one temporary timeline, individual clips, cleaned up afterwards), shutdown with countdown |
| **Notifications** | Telegram bot and WhatsApp (Whapi.Cloud), people and groups |

Footage is never deleted.

## Each editing PC
1. Install `AV-PostPilot-<version>-Windows-Setup.exe` (from `npm run dist:win`).
2. Resolve: *Preferences → System → General → External scripting using: **Local***.
3. Resolve: *Preferences → User → Editing → Standard Generator Duration* = episode title length.
4. PostPilot: set the Auto-save locations; tokens on the Notifications page.

## Development
```
npm install
npm start          # run the app
npm test           # unit tests (no Resolve needed)
npm run dist:win   # build the Windows installer into dist/
```
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
