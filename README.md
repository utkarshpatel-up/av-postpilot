# AV PostPilot

Edit-bay assistant for DaVinci Resolve Studio (Windows editing PCs; the library
backup server can be a Mac). It talks to Resolve through Resolve's own script runner
(`fuscript.exe` + `electron/bridge.lua`), so the editing PCs need nothing extra
installed: no Python.

**Current version: 3.2.0** — downloads in `dist/`: Windows installer, Windows portable
ZIP, macOS ZIPs for Apple Silicon (arm64) and Intel (x64), plus SHA-256 checksums.

## New in 3.2
- **Night Queue**: scene cuts, stabilization, renders and encoding as steps that run
  one after another, with one choice for when everything has finished.
- **Dashboard**: the Shutdown card shows only what is running now and its real
  after-queue choice; scene cut, stabilization and night queues appear while active.
- **Notifications**: one line per service; click a service for its settings.
- Sidebar order ends with Notifications, Library Backup, Settings, Activity.

## New in 3.1
- **Premiere Import page**: brings a whole Premiere Pro project into Resolve.
  Premiere's bins are rebuilt with all their media (relinked to where the files are
  now), every sequence becomes a timeline in its own bin, titles are rebuilt as Text+
  matched to Premiere's own frames, and markers show what needs redoing (Lumetri,
  Neat Video, Mocha, speed changes).
- **Premiere link**: a small signed helper inside Premiere (one click, no admin
  rights) so PostPilot can have Premiere export the XML and title frames itself.
- **Episodes**: every new episode gets 5 s of black after its 5 s title.

## New in 3.0
- **Stabilization page**: marked shaky clips on one or more timelines; Fusion
  point tracking on rigid details (Lock by default, Smooth when the camera moves on
  purpose), Resolve's own stabilizer when the shot has no rigid reference, automatic
  edge zoom, live progress with times, Review / Approve / Undo onto your timeline,
  optional marker removal, delete the copies once everything is approved.
- **When the queue finishes** on Scene Cuts, Renders, Encoder and Stabilization:
  *Do nothing* / *Just notify* / *Notify and shut down* (with countdown).
- **Clip Info window**: always-on-top details of the clip under Resolve's playhead
  (**Ctrl+Alt+I**).
- **Library Backup**: *Start / Stop scheduled backups* installs the schedule itself
  (no script to run by hand).
- Menu order follows the workflow (Stabilization before Episodes); the app reopens the
  last page you used (Dashboard on the very first start).

## What it does

| Page | |
|---|---|
| **Dashboard** | Resolve connection, open project/library, auto-save status, shutdown countdown, render queue |
| **New Project** | Creates the project folders, moves (same drive) or copies the satsang day folders into `Satsang Files`, builds the Resolve project with bins, nested footage and `Master-` / `Edit-` timelines |
| **Auto-save** | Exports the open project as `.drp` every N minutes to several locations, only when it changed |
| **Premiere Import** | Report of a Premiere project (sequences, media found/missing, effects, titles, fonts); imports the whole project into Resolve with its bins, relinked media, Text+ titles and fix-up markers |
| **Library Backup** | Monitors existing Mac/NAS database dumps; backs up whole PostgreSQL libraries, roles and optional secondary copies on the server; Start/Stop scheduled backups |
| **Scene Cuts** | Queue of timelines for *Detect Scene Cuts*, run one after another |
| **Stabilization** | Stabilizes marked shaky clips on one or more timelines: Fusion tracking on rigid details (Lock, or Smooth when the camera moves on purpose), Resolve's stabilizer when there is no rigid reference, edge zoom, review/approve onto your timeline, delete approved copies |
| **Episodes** | Creates episode series with a Text+ title (plain or on colour bars) followed by 5 s of black; renames a series later (the `(…)` cue never changes) |
| **Renders** | Copies each finished render, optional HD review pass (one temporary timeline, individual clips, cleaned up afterwards), shutdown with countdown |
| **Night Queue** | Steps in order (scene cuts, stabilization, render jobs, Encoder queue), unattended, one finish choice |
| **Encoder** | Media-Encoder-style queue with Resolve presets in a disposable project; optional copy of finished files |
| **Clip Info** (window) | Always-on-top box with the clip under the playhead; Settings switch, tray, Ctrl+Alt+I |
| **Notifications** | ntfy phone push, Gmail email to personal/office recipients, Telegram and legacy WhatsApp (Whapi.Cloud) |

Footage is never deleted.

## Each editing PC
1. Either install `AV-PostPilot-<version>-Windows-Setup.exe`, or extract `AV-PostPilot-<version>-Windows-Portable.zip` into a local folder you can write to and double-click `AV PostPilot.exe`. The ZIP needs no installation or administrator rights. Keep all extracted files and folders together; do not run it from inside the ZIP.
2. Resolve: *Preferences → System → General → External scripting using: **Local***.
3. Resolve: *Preferences → User → Editing → Standard Generator Duration* = **5 seconds** (episode title and the black after it; PostPilot warns otherwise).
4. PostPilot: set the Auto-save locations; tokens on the Notifications page.
5. Optional: Settings → *Show the Clip Info window* and its shortcut.
6. On the PC that keeps Premiere Pro: Premiere Import → **Set up Premiere link** (restart Premiere once).

## Development
```
npm install
npm start          # run the app
npm test           # unit tests (no Resolve needed)
npm run dist:win   # build the Windows installer into dist/
npm run dist:zip   # build the complete extract-and-run Windows ZIP into dist/
npm run dist:mac   # macOS ZIPs (on a Mac, or automatically by GitHub Actions on push)
```
The ZIP includes Electron and all app dependencies; target PCs do not need Node.js,
npm or Python. Resolve Studio must already be installed, with local scripting enabled.
Settings, queue state, logs and encrypted tokens stay in the current Windows user's
AppData folder, just as with the installed app. Extracting a newer ZIP does not reset
those settings. Tokens cannot be shared by copying another Windows user's AppData.
You can create a shortcut to `AV PostPilot.exe` yourself. Close PostPilot (including
its tray process) before switching versions. Office application-control policies may
still require IT to allow the executable, even though no installation is needed.

## Gmail email alerts
1. In Google Account security, enable **2-Step Verification**, then create an
   **App Password** named AV PostPilot. See https://support.google.com/accounts/answer/185833.
   If your account does not offer App Passwords, this setup cannot be used.
2. On **Notifications → Email**, enter the Gmail sender address and save that App
   Password (not your usual Gmail password). It is encrypted for the Windows user.
3. Add recipient addresses with **+ Add** (several may be separated by commas): your Gmail address, office address,
   and/or other team addresses. Recipients need no mail-server setup. Switch Email on.
4. Enable ntfy with a matching phone subscription. Use **Test email only** and
   **Test ntfy only** to check each channel, then select the event checkboxes you want.
   Each saved topic or email recipient has an on/off checkbox and an **Alerts** menu
   for choosing its events. Global event checkboxes must also be enabled. Email recipients each
   get a separate message, with the first event line as subject and full text as body.

Email uses Gmail SMTP with TLS on port 465. The office network must allow that
connection. Server acceptance does not guarantee inbox delivery: check spam too.
Gmail sending limits apply. Password changes revoke Google App Passwords; replace
the saved password when needed. Configure credentials separately on each PC.
**Remove password** deletes the email credential and disables email alerts.

## Phone notifications without linking WhatsApp
HTTP notifications use Electron's browser networking to support office system
proxy settings. A website opening does not prove notification publishing is allowed.
If a test fails, Activity includes the available network/certificate error details.
Certificate checks remain enabled; proxy login or firewall restrictions may require IT.

Add personal and group topics with **+ Add**, or **Generate random topic**.
Click a saved topic to copy its name; **✕** removes it. Switch a destination off
to keep it saved without sending there, or use **Alerts** to route specific events.
Each person subscribes to the appropriate topics in
the ntfy phone app. Reuse the team topic on all editing PCs and add personal
topics on the relevant PCs. Subscribing to both topics produces two notifications
for an event sent to both. Existing single-topic settings are preserved on upgrade.

## Stabilization (3.0)
Put a marker on each shaky clip in Resolve. On the Stabilization page tick the
timelines (several run one after another), choose the marker colour, click
**Find marked clips**, then **Stabilize selected clips**. PostPilot saves the
project and works in one duplicate per timeline ("… - PostPilot Stabilized HHMMSS").
Clips with real Fusion work are skipped; empty default comps are reused.

Per clip:
1. **Pick details** from 5 frames (first, +2, +4, middle, last). The whole-picture
   movement is estimated first, so a swinging camera is followed. Details that stay
   put through the clip (chairs, rails, backdrops, banners) are preferred, spread
   across the frame from the edges inwards.
2. **No fixed detail at all** (tight audience shots, blurred crowd) → Resolve's own
   stabilizer is used straight away (whole-picture analysis, default settings).
3. Otherwise about 8 details are **tracked in one Fusion pass** with classic point
   trackers (IntelliTrack drifts and is never used).
4. **Trust check:** the points must agree with each other over the whole clip.
   Lock: agreeing points drive a Fusion Match Move; when trackers slip, a two-pass
   per-frame median is used instead (Transform node with a per-frame correction).
   If the points still disagree (more than 6 px at 4K) there is no rigid reference
   and Resolve's stabilizer is used instead.
5. **Edge zoom:** the smallest zoom that hides black edges (plus 0.2 %, max 1.03) on
   a Transform node after the tracker.

**Lock** is the default: all camera movement is removed. Tick **Camera moves on
purpose** on a clip (rare) for **Smooth**: slow camera moves are kept and only the
fast shake is removed.

Status: green **Passed**, yellow **Stabilized (Resolve)** (check by eye), orange
**Needs review**. A live bar shows the clip in progress, per-clip time and the total.
When the queue finishes PostPilot can notify (event *The stabilization queue
finishes*) and shut the PC down with a countdown.

**Review and apply:** ▶ Review jumps Resolve to the clip in the copy, ⇄ Original to
the same clip in your timeline. ✔ Approve (or *Approve all passed*) copies the
stabilization onto your clip (exported/imported Fusion comp, or Resolve's stabilizer
run on your clip) and restores its own clip colour; optionally the markers are
removed. ↺ Undo removes a Fusion stabilization again and restores markers; a Resolve
stabilization is reset in the Color page (Tracker > Stabilizer). Approve refuses if
the clip was edited after the run. Once every stabilized clip of a copy is approved,
**🗑 Delete stabilized copies** removes those copy timelines (only timelines PostPilot
created; it switches back to your timeline first). Results:
`stabilization-last-report.json`.

Measured on 4K test shots: rigid backgrounds about half the shake left, no black
edges; tight audience shots via Resolve's stabilizer. Tools for checking new kinds
of footage are in `dev/` (`stab_harness.js`, `measure_shake.js`, `measure_points.js`,
`edge_check.js`).

## Premiere Import (3.1)
For moving older Premiere Pro projects into Resolve.

1. **Open Premiere project…** — PostPilot reads the `.prproj` itself (Premiere need not
   be open) and shows: sequences (format, length, clip counts), media found / missing
   (files moved to another drive are found again through the project folder and
   *Also look for footage in*), what transfers and what has to be redone, title fonts.
2. **Import whole project into Resolve** — by default into a Resolve project named
   after the Premiere project, created with the sequence's frame rate and size (or
   *into the project open in Resolve*, under `Premiere Import / <project>`):
   - Premiere's bins are rebuilt with **all** their media, also clips no sequence uses;
   - each sequence comes from Premiere's Final Cut Pro XML (exported by the Premiere
     link, or exported by hand into the project folder) with footage paths pointed at
     where the files are now, and goes into its Premiere bin, linked to that media;
   - **titles** become a clip on the same track and time with a **Text+** inside
     (same text, font, size, colour, position). With the Premiere link, Premiere
     renders the frame with and without the title and each line is fitted to it
     (measured within a few pixels, also over bars or footage, also legacy titles);
   - Premiere's **Bars and Tone** becomes Resolve's SMPTE bars still, **Black Video**
     becomes black, both with their exact length (title lengths come from the XML,
     not from Resolve's generator duration);
   - markers: **Purple** = redo (Mocha, speed changes, title parts Text+ can't copy),
     **Sky** = the clip's Lumetri settings.
3. **Grade once per look** — clips that had identical Lumetri (+ Neat Video) settings:
   grade the first clip, then *Copy its grade to the others*.

Lumetri, Neat Video and Mocha do not transfer (Premiere leaves them out of the XML);
Neat Video profile names are listed per look.

### Premiere link
Premiere Import → **Set up Premiere link** copies a signed helper into the user's own
`%APPDATA%\Adobe\CEP\extensions` (no administrator rights, nothing in Program Files);
restart Premiere once. PostPilot then starts Premiere when needed, opens the project,
exports XML and title frames, and closes the project again without saving if it opened
it. Premiere's informational *Load Project* notice (missing plugins) is closed
automatically; any other dialog is reported. The helper only runs a fixed set of
commands, given through job files in `%APPDATA%\av-postpilot-link`.

Developers: the helper's source is `cep/postpilot-link`; `node dev/sign_link.js` signs
it with `dev/tools/ZXPSignCmd.exe` and the self-signed certificate in `dev/tools` (not in
git — keep a copy) and unpacks the signed copy into `electron/premiere-link`, which ships
with the app (`.gitattributes` keeps its bytes exact).

## Night Queue
Add steps in the order they should run, then **Start night queue**:
- **Scene cuts** on ticked timelines;
- **Stabilize** marked clips on ticked timelines (one step; more timelines join it).
  It only makes the stabilized copies, as on the Stabilization page: nothing is applied
  to a timeline until someone reviews it there. The queue won't start while the last
  stabilization still waits for review, because it would replace that list;
- **Render** ticked jobs from Resolve's render queue (PostPilot starts them; copies and
  the HD review pass from the Renders page still happen);
- **Encode** whatever waits on the Encoder page. It closes the project, so it is always
  the last step, and PostPilot asks for that when the queue is started.

A render of a timeline that is also in the stabilization step is flagged with a caution
(when adding it and when starting): that render uses the original, un-reviewed clips.
While the queue runs, only its own **When everything finishes** choice counts; the
modules' own choices are not used. A failed step is reported and the next one runs; a
render stopped in Resolve stops the queue and the PC stays on. Steps are kept when
PostPilot is closed.

## When a queue finishes (all modules)
Scene Cuts, Renders, Encoder and Stabilization each have **When the queue finishes**:
- **Do nothing** — that module sends no messages (render failures and shutdown
  warnings are still sent);
- **Just notify** — messages go to the enabled channels and events on Notifications;
- **Notify and shut down** — plus a shutdown with the module's own min/s countdown,
  cancellable from the app, the Dashboard and the tray.

The global switches and per-event checkboxes on Notifications still apply on top.

## Clip Info window
Settings → *Show the Clip Info window* (or tray, or **Ctrl+Alt+I**, changeable in
Settings): a small always-on-top box with the clip under Resolve's playhead —
duration, length in frames, timeline In/Out, resolution, frame rate, codec;
**+ more** adds source In/Out, file path, markers and the clip name.

## Scheduled library backups (3.0)
Library Backup → **Start scheduled backups** installs the schedule itself (launchd
on Mac, Task Scheduler on Windows) for the daily times, together with the hourly
health check; **Stop** removes both. The page shows *Scheduled daily at …*. Press
Start again after changing the times. Runs while PostPilot is closed; the user must
stay logged in (a locked screen is fine). Needs the installed/packaged app, not
`npm start`. The old script export is still under *Advanced* (for example for a
logged-out Windows task, which asks for the account password).

## Encoder
Encoder asks before saving and closing the current Resolve project, then uses a
uniquely named disposable empty project for its queue. No open project is required.
After finishing or stopping, it deletes the temporary project and leaves the
original project closed. If saving fails, encoding does not start. Keep the
temporary project open during encoding; a project switch stops the queue safely.
An interrupted connection or crash may leave the temporary project for manual cleanup.

Each group can enable **Copy finished files** and choose a destination. The folder
field appears when checked; switching copying off hides it and clears its path.
Copies keep the original export, avoid existing names, and verify matching size.
Group completion messages include the copied count and destination. The after-queue
action waits for copies and cleanup; copy or cleanup errors prevent automatic shutdown.

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
- Fusion comp frame 0 is the clip's first frame on the timeline (`COMPN_GlobalStart` is the source start).
- The Tracker tool's first tracker is IntelliTrack, which drifts slowly; PostPilot adds classic point trackers.
- Scripts cannot move the playhead while the Fusion page is open: PostPilot returns to the Edit page first.
- Opening a clip on the Fusion page creates an empty comp; empty comps don't count as Fusion work.
- Stabilizer settings of `TimelineItem:Stabilize()` can't be set by script (defaults are used) or reset by script.
- Approving copies Fusion stabilization with `ExportFusionComp` / `ImportFusionComp`.
- A timeline clip's length can't be changed by script; inserted titles/generators take the *Standard Generator Duration*. Lengths from an imported XML are kept exactly.
- `InsertFusionTitleIntoTimeline` ripples every track; Premiere titles go in as placeholder clips through the XML instead.
- XML imports with a Premiere title (`GraphicAndType…`) fail completely; Premiere's Bars and Tone / Black Video can't be imported either: PostPilot swaps them before importing.
- Fusion comps on generator clips can't be made by script; on still and video clips they can (playhead on the clip, Fusion page, `ConnectInput`).
- Track on/off is only reported for the current timeline, and switching it on the Deliver page doesn't stick.
- Resolve's unsaved *Untitled Project* refuses project settings and asks for a name when saved.
- Premiere's ExtendScript reads chained `a ? b : c ? d : e` left to right; the Premiere helper avoids it.

## Also in this repo
`resolve-db-backup/`: backup and restore scripts for the Mac PostgreSQL project server (launchd, project-count alarm, restore into a separate `restore_…` library). See `resolve-db-backup/HOW_TO_RESTORE.txt`.

## Library backup setup

On editing computers, select **Library Backup → Monitor shared backups** and choose
the shared backup folder from the server running PostPilot.
The page refreshes every 30 seconds while open, showing each library's latest dump,
saved project count, size, stale status, protected snapshots and the available log.
On editing PCs, select the shared Mac folder or the NAS `Project Database Backup`
folder. NAS-only copies may have no counts/log. This checks files and timestamps;
it does not query PostgreSQL or prove that a dump restores successfully.

For migration from the original Mac script, run `bash stop-old-mac-backup.sh` on
the server as the Mac account that ran its installer, without sudo. This stops and
disables only `com.resolve.db-backup`, archiving its LaunchAgent plist under
`~/ResolveBackup/disabled-schedules`. If a backup is active, it asks you to rerun
after completion. Existing dumps, database, scripts and PostPilot jobs are preserved.
It does not edit cron or another account's jobs. The legacy installer is no longer
exported or packaged by the app.

On the Mac or Windows database server, choose **Run PostgreSQL backups here**, select the
installed PostgreSQL `bin` folder (client tools must match the server version or be
compatible), local backup folder, database host/user/port and optional existing NAS
folder. Save the database password, **Test connection & list libraries**, then
**Back up now**. The engine also runs manually on Mac with its PostgreSQL bin path.
It creates a dedicated `AV-PostPilot-Libraries` folder and never modifies the database.
On Mac, **Start scheduled backups** installs a user launchd agent for the new engine
(the exported `install.sh` route remains under *Advanced*). Keep the configuring Mac
user logged in with the login keychain unlocked. Disable the original backup schedule before replacing
it. The new engine uses the app's ntfy/email settings.
It uses custom-format `pg_dump`, checks the archive listing, backs up roles/users,
and copies to the secondary destination. Failed secondary copies are reported while
local backups continue. Credentials are encrypted for the configuring OS account.

An observed project-count drop or a previously tracked library disappearing preserves
the previous dump under `PROTECTED/<library>` and triggers a notification. This cannot
detect a deletion followed by an addition that leaves the count unchanged. Retention
only prunes this engine's timestamped files older than the configured days, keeping
at least the specified minimum. Protected dumps are never automatically pruned.
Use a separate root per PostgreSQL server. Database names must use letters, numbers,
hyphens or underscores. Footage is not backed up. Test restores separately before
relying on backups; the app does not restore or overwrite live libraries.

Daily backup times appear as editable AM/PM chips. Click a chip to edit it, choose
hour/minute/AM or PM, and save; **+ Add time** adds another trigger and **×** removes
one. At least one time is required and duplicates are rejected. Existing 24-hour
settings are preserved. Press **Start scheduled backups** again after changing times;
the scheduler uses the server's local clock.

On Windows, **Start scheduled backups** registers the Task Scheduler tasks for the
Windows account that saved PostPilot settings and credentials; that user must stay
logged in. For a task that runs while logged out, use *Advanced → Export Windows
schedule setup* (it prompts for that account's password; local policy may require IT
assistance). PostPilot need not remain open. Keep its folder at the same path, use UNC
NAS paths, and press Start again after changing times or moving the app. An existing backup
lock blocks concurrent runs; after an interrupted run remove it only when no backup
process is active. Failure and deletion alerts use enabled notification channels;
successful-backup alerts are optional on Notifications.

**Library backup is overdue** on Notifications enables age-based phone/email alerts
on the computer set to server mode. Its threshold is **Notify me if older than** in
Library Backup. The server checks every five minutes while the app runs. The installed
schedule includes a separate hourly health task so missed backup jobs can be detected
with the app closed. Server
power/network and the scheduling account's credentials must be available; a powered-off
server cannot send an alert. Mac user launchd requires the account to remain logged in.
Editing computers in monitor mode do not send these alerts. Each library alerts once
per overdue incident; a fresh observed backup resets it. Failed delivery is retried.
If no dump exists, the threshold starts from the first enabled health check. An hourly
check can report up to about an hour after the age threshold passes.

### macOS distribution

Run `npm ci` then `npm run dist:mac` **on a Mac**, or run the repository's
**Build macOS distributions** GitHub Actions workflow. It produces separate Intel
(`x64`) and Apple Silicon (`arm64`) ZIPs containing `AV PostPilot.app`, including the
PostPilot backup engine. Extract and open the matching app; no PostgreSQL tools are bundled.
Mac starts with automatic Resolve launch disabled, suitable for the library server.
The build uses an ad-hoc signature, not Apple Developer ID signing/notarization;
macOS may require approval in Privacy & Security. Windows cannot build this macOS
target with electron-builder. The existing editing workflows remain Windows-tested;
Mac Resolve integration and real PostgreSQL backups need validation on the Mac server.
