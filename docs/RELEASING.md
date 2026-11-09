# Releasing a Windows update

Installed copies (the Windows **Setup** installer) update themselves from GitHub releases of
`utkarshpatel-up/av-postpilot`. They check 30 seconds after start and every 4 hours, download in the
background, and show **Settings → Updates → Restart to install**. Nothing installs or quits by itself,
and installing is refused while a job is running or Feedback Cutter audio is unsaved.

## Publish a new version
1. Bump `version` in `package.json` (e.g. `3.4.0`), commit, push to `main`.
2. Tag and push: `git tag v3.4.0 && git push origin v3.4.0`.
3. The **Publish Windows release** workflow checks the tag equals the version, runs the tests, builds
   the NSIS installer and publishes a stable release containing, together:
   `AV-PostPilot-<version>-Windows-Setup.exe`, `AV-PostPilot-<version>-Windows-Setup.exe.blockmap`, `latest.yml`.

By hand instead (Windows, with Python for the audio engine; `GH_TOKEN` = a token with repo contents write):
```
npm ci && npm test
node scripts/fetch-handbrake.js win && node scripts/build-feedback-engine.js
npx electron-builder --win nsis --x64 --publish always
```
Never publish a draft or pre-release and never upload the three files separately or edit `latest.yml`:
updates are verified against the SHA-512 recorded in it. Do not remove or rename files of a published version.

## Limits
- Copies installed **before** this feature (3.3.1 and older) must be upgraded once by hand with the new Setup installer.
- Portable ZIP, development runs and macOS do not auto-update (the Mac app is ad-hoc signed; updates need an Apple Developer ID). They show why in Settings → Updates.
- Windows builds are unsigned, so SmartScreen may warn on a manual download; auto-updates still check the SHA-512.
