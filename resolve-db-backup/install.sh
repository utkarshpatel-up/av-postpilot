#!/bin/bash
# One-time installer for the Resolve database backup, run on the Mac server:
#   bash install.sh
# Safe to run again (e.g. after changing TIMES).

# Backup times, 24h clock. The gap between two runs is what you could lose.
TIMES="11:00 14:00 17:00 20:00 23:00"

LABEL="com.resolve.db-backup"
PG_BIN="/Library/PostgreSQL/13/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/ResolveBackup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

set -e
mkdir -p "$DEST/scripts" "$HOME/Library/LaunchAgents"
for f in resolve_db_backup.sh resolve_db_restore.sh; do
  tr -d '\r' < "$HERE/$f" > "$DEST/scripts/$f"   # strip Windows line endings if any
  chmod 755 "$DEST/scripts/$f"
done
echo "✔ Scripts installed in $DEST/scripts"

# Password file so backups can log in unattended (covers every library).
read -r -s -p "PostgreSQL password for user 'postgres' [DaVinci]: " PW; echo
PW="${PW:-DaVinci}"
touch "$HOME/.pgpass"; chmod 600 "$HOME/.pgpass"
grep -v '^localhost:5432:\*:postgres:' "$HOME/.pgpass" > "$HOME/.pgpass.tmp" || true
echo "localhost:5432:*:postgres:$PW" >> "$HOME/.pgpass.tmp"
mv "$HOME/.pgpass.tmp" "$HOME/.pgpass"; chmod 600 "$HOME/.pgpass"
if ! PGPASSFILE="$HOME/.pgpass" "$PG_BIN/psql" -h localhost -U postgres -w -X -A -t -d postgres -c 'SELECT 1' >/dev/null; then
  echo "✘ Could not log in to PostgreSQL with that password. Nothing scheduled."; exit 1
fi
echo "✔ Database login works"

# Remove the old cron backup/cleanup lines (a copy of the old crontab is kept).
if crontab -l >/dev/null 2>&1; then
  crontab -l > "$DEST/old_crontab_$(date +%Y%m%d_%H%M).txt"
  crontab -l | grep -v -e 'pg_dump' -e 'Project Database Backup' -e '^PATH=' > "$DEST/crontab.new" || true
  if grep -q '[^[:space:]]' "$DEST/crontab.new"; then crontab "$DEST/crontab.new"; else crontab -r; fi
  rm -f "$DEST/crontab.new"
  echo "✔ Old cron backup lines removed (copy saved in $DEST)"
fi

# launchd job
{
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DEST/scripts/resolve_db_backup.sh</string></array>
  <key>StandardOutPath</key><string>$DEST/launchd.log</string>
  <key>StandardErrorPath</key><string>$DEST/launchd.log</string>
  <key>StartCalendarInterval</key>
  <array>
EOF
  for t in $TIMES; do
    h=$((10#${t%%:*})); m=$((10#${t##*:}))
    echo "    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"
  done
  cat <<EOF
  </array>
</dict>
</plist>
EOF
} > "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ Scheduled daily at: $TIMES"

# First run now, through launchd (same way it will run every day).
echo "Running a first backup now..."
launchctl kickstart "gui/$(id -u)/$LABEL"
sleep 3
while [ -d "$DEST/state/lock" ]; do sleep 2; done
echo
tail -n 15 "$DEST/backup.log"
echo
echo "Backups:  $DEST/db   (and the NAS folder when mounted)"
echo "Log:      $DEST/backup.log"
echo "Restore:  $DEST/scripts/resolve_db_restore.sh <file.dump>"
