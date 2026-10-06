#!/bin/bash
# Run with: bash stop-old-mac-backup.sh
# Use the Mac account that ran the original installer; do not use sudo.
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then echo 'Run this on the Mac backup server.'; exit 1; fi
if [ "$(id -u)" = "0" ]; then echo 'Run as the original Mac user, without sudo.'; exit 1; fi
LABEL='com.resolve.db-backup'
SERVICE="gui/$(id -u)/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if STATUS=$(launchctl print "$SERVICE" 2>/dev/null); then
  if printf '%s\n' "$STATUS" | grep -Eq '^[[:space:]]*pid = [0-9]+'; then
    echo 'An old backup is running. Let it finish, then run this script again.'
    exit 1
  fi
  launchctl bootout "$SERVICE"
fi
launchctl disable "$SERVICE"
if [ -e "$PLIST" ]; then
  ARCHIVE="$HOME/ResolveBackup/disabled-schedules"
  mkdir -p "$ARCHIVE"
  mv "$PLIST" "$ARCHIVE/$LABEL.$(date +%Y%m%d-%H%M%S).$$.plist"
  echo "Old launchd settings saved in: $ARCHIVE"
fi
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo 'Could not unload the old job. Check launchctl before enabling the new schedule.'
  exit 1
fi
echo 'Old Resolve backup launchd job stopped and disabled.'
echo 'Your existing dumps, backup scripts, database and PostPilot schedule are preserved.'
echo 'This script targets launchd only; it does not edit cron or other users/system jobs.'
