#!/bin/bash
# Backs up every DaVinci Resolve project library on this PostgreSQL server.
#  - compressed custom-format dumps, verified after writing
#  - tracks project count per library; if it drops, the last backup taken
#    BEFORE the drop is copied to PROTECTED (never auto-deleted) + notification
#  - copies to the NAS only when the NAS is really mounted
#  - prunes backups older than KEEP_DAYS but always keeps the newest KEEP_MIN
# Started by launchd (com.resolve.db-backup). Restore with resolve_db_restore.sh.

# ---------------- settings ----------------
PG_BIN="/Library/PostgreSQL/13/bin"
PG_HOST="localhost"
PG_PORT="5432"
PG_USER="postgres"
BACKUP_ROOT="$HOME/ResolveBackup"
NAS_MOUNT="/Volumes/Nasshare02"
NAS_DIR="$NAS_MOUNT/Editing/Utkarsh/Premiere Project Files/Project Database Backup"
KEEP_DAYS=30
KEEP_MIN=10
# ------------------------------------------

export PGPASSFILE="$HOME/.pgpass"
LOCAL_DIR="$BACKUP_ROOT/db"
PROTECT_DIR="$BACKUP_ROOT/PROTECTED"
STATE_DIR="$BACKUP_ROOT/state"
LOG="$BACKUP_ROOT/backup.log"
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$LOCAL_DIR/_globals" "$PROTECT_DIR" "$STATE_DIR"

log()    { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"; }
notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Resolve DB Backup\" sound name \"Basso\"" >/dev/null 2>&1; }
q()      { "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w -X -A -t -d "$1" -c "$2" </dev/null 2>>"$LOG"; }

# Delete dumps older than KEEP_DAYS in a folder, but never the newest KEEP_MIN.
prune() {
  ls -1t "$1"/*.dump 2>/dev/null | tail -n +$((KEEP_MIN + 1)) | while IFS= read -r f; do
    if [ -n "$(find "$f" -mtime +$KEEP_DAYS 2>/dev/null)" ]; then
      rm -f "$f" && log "pruned $f"
    fi
  done
}

# One run at a time (a lock older than 2h is left over from a crash).
LOCK="$STATE_DIR/lock"
[ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ] && rmdir "$LOCK"
if ! mkdir "$LOCK" 2>/dev/null; then log "Another backup is running, skipping."; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

log "----- backup run $STAMP -----"

nas_ok=0
if /sbin/mount | grep -q " on $NAS_MOUNT "; then
  nas_ok=1
else
  log "NAS not mounted ($NAS_MOUNT): local copy only."
fi

dbs=$(q postgres "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1")
if [ -z "$dbs" ]; then
  log "ERROR: cannot reach PostgreSQL (check it is running and ~/.pgpass)."
  notify "FAILED: cannot reach the database server"
  exit 1
fi

# Server-wide roles/users (small, lets a restore on a new server keep owners).
"$PG_BIN/pg_dumpall" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w --globals-only \
  -f "$LOCAL_DIR/_globals/globals_$STAMP.sql" </dev/null 2>>"$LOG" || log "WARNING: globals dump failed"
find "$LOCAL_DIR/_globals" -name 'globals_*.sql' -mtime +$KEEP_DAYS -delete 2>/dev/null

failed=0
count_libs=0
while IFS= read -r db; do
  [ -z "$db" ] && continue
  # Only Resolve project libraries have the SM_Project table.
  [ "$(q "$db" "SELECT to_regclass('public.\"SM_Project\"') IS NOT NULL")" = "t" ] || continue
  count_libs=$((count_libs + 1))

  mkdir -p "$LOCAL_DIR/$db"
  out="$LOCAL_DIR/$db/${db}_$STAMP.dump"

  if ! "$PG_BIN/pg_dump" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w -Fc -f "$out.part" "$db" </dev/null 2>>"$LOG"; then
    log "ERROR: dump of $db failed"; rm -f "$out.part"; failed=1; continue
  fi
  if ! "$PG_BIN/pg_restore" --list "$out.part" >/dev/null 2>>"$LOG"; then
    log "ERROR: dump of $db is unreadable, discarded"; rm -f "$out.part"; failed=1; continue
  fi
  mv "$out.part" "$out"

  count=$(q "$db" 'SELECT count(*) FROM "SM_Project"')
  prev=$(cat "$STATE_DIR/$db.count" 2>/dev/null)
  prev_file=$(cat "$STATE_DIR/$db.last" 2>/dev/null)
  log "OK  $db  projects=$count  size=$(du -h "$out" | cut -f1)"

  if [ -n "$prev" ] && [ -n "$count" ] && [ "$count" -lt "$prev" ]; then
    log "WARNING: $db project count dropped $prev -> $count. Protecting $prev_file"
    if [ -f "$prev_file" ]; then
      cp -p "$prev_file" "$PROTECT_DIR/"
      if [ $nas_ok -eq 1 ]; then
        mkdir -p "$NAS_DIR/_PROTECTED" && cp -p "$prev_file" "$NAS_DIR/_PROTECTED/"
      fi
    fi
    notify "$db: projects dropped $prev -> $count. Pre-drop backup kept in PROTECTED."
  fi
  [ -n "$count" ] && echo "$count" > "$STATE_DIR/$db.count"
  echo "$out" > "$STATE_DIR/$db.last"

  prune "$LOCAL_DIR/$db"

  if [ $nas_ok -eq 1 ]; then
    if mkdir -p "$NAS_DIR/$db" 2>>"$LOG" && cp -p "$out" "$NAS_DIR/$db/" 2>>"$LOG"; then
      prune "$NAS_DIR/$db"
    else
      log "ERROR: NAS copy of $db failed"; failed=1
    fi
  fi
done <<EOF
$dbs
EOF

if [ $count_libs -eq 0 ]; then
  log "WARNING: no Resolve project libraries found on this server."
  failed=1
fi

if [ $failed -eq 0 ]; then
  date '+%Y-%m-%d %H:%M' > "$STATE_DIR/last_success"
  log "done: $count_libs librar(y/ies) backed up"
else
  notify "Backup finished with errors. See ~/ResolveBackup/backup.log"
fi

# Keep the log from growing forever.
if [ "$(wc -l < "$LOG")" -gt 5000 ]; then
  tail -n 3000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
