#!/bin/bash
# Restores a backup into a SEPARATE "restore_..." project library.
# It can never overwrite a live library: the target name must start with restore_
#
# Usage:  resolve_db_restore.sh <backup.dump> [restore_library_name]
#
# Recommended (so client PCs can connect too):
#   1. Project Server app: create an empty library named e.g. restore_test and
#      switch "Project Library Enabled" ON
#   2. Close that library in Resolve on every machine
#   3. resolve_db_restore.sh ~/ResolveBackup/db/edit_share_18/<file>.dump restore_test
# The backup is restored into a fresh database which then replaces that empty
# library under the same name. If the library doesn't exist the script creates
# it, but then only this Mac can connect to it.

PG_BIN="/Library/PostgreSQL/13/bin"
PG_HOST="localhost"
PG_PORT="5432"
PG_USER="postgres"
export PGPASSFILE="$HOME/.pgpass"

psql_q() { "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w -X -A -t -d "$1" -c "$2"; }

file="$1"
if [ ! -f "$file" ]; then
  echo "Usage: $0 <backup.dump> [restore_library_name]"
  echo
  echo "Newest backups:"
  ls -1t "$HOME"/ResolveBackup/db/*/*.dump "$HOME"/ResolveBackup/PROTECTED/*.dump 2>/dev/null | head -n 15
  exit 1
fi

name="${2:-restore_$(date +%m%d_%H%M)}"
case "$name" in
  *[!a-z0-9_]*|"") echo "Library name may only use lowercase letters, digits and _ (got: $name)"; exit 1 ;;
esac
case "$name" in
  restore_*) ;;
  *) echo "For safety the target library name must start with restore_ (got: $name)."
     echo "This script never writes into a live library."; exit 1 ;;
esac

exists=$(psql_q postgres "SELECT 1 FROM pg_database WHERE datname = '$name'")
if [ $? -ne 0 ]; then echo "Cannot reach PostgreSQL. Is it running? Is ~/.pgpass set up?"; exit 1; fi

if [ -n "$exists" ]; then
  users=$(psql_q postgres "SELECT count(*) FROM pg_stat_activity WHERE datname = '$name' AND pid <> pg_backend_pid()")
  if [ "${users:-0}" -gt 0 ]; then
    echo "'$name' is open in Resolve somewhere ($users connection(s))."
    echo "Close it (switch to another library) on every machine, then run this again."
    exit 1
  fi
fi

# Always restore into a brand-new database: restoring over an existing library
# leaves its own leftovers behind and Resolve then shows it empty.
tmp="${name}_tmp$$"
echo "Restoring $file ..."
"$PG_BIN/createdb" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w "$tmp" || exit 1
"$PG_BIN/pg_restore" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w -d "$tmp" "$file"
rc=$?

count=$(psql_q "$tmp" 'SELECT count(*) FROM "SM_Project"' 2>/dev/null)
echo
if [ -z "$count" ]; then
  echo "Restore FAILED: the backup did not produce a project table. Nothing was replaced."
  "$PG_BIN/dropdb" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w "$tmp"
  exit 1
fi

# Swap it in under the requested name. A library created in Project Server keeps
# its network access, which is tied to the name.
if [ -n "$exists" ]; then
  "$PG_BIN/dropdb" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -w "$name" || {
    echo "Could not replace '$name' (still open somewhere?). The restored copy is kept as '$tmp'."; exit 1; }
  network_note="Replaced the Project Server library: with 'Project Library Enabled' ON, client PCs can connect."
else
  network_note="Created outside Project Server: only this Mac (127.0.0.1) can connect to it."
fi
psql_q postgres "ALTER DATABASE \"$tmp\" RENAME TO \"$name\"" >/dev/null || {
  echo "Could not rename '$tmp' to '$name'. The restored copy is kept as '$tmp'."; exit 1; }
[ $rc -ne 0 ] && echo "(pg_restore reported some warnings above. Usually harmless if the project count looks right.)"
echo "Restored '$name' with $count project(s)."
echo "$network_note"
cat <<EOF

Next, in DaVinci Resolve (live libraries are untouched):
  1. Project Manager > Network > connect to '$name'
     (Add Project Library > Connect: Name $name, Location 127.0.0.1 on this Mac
      or 192.168.60.136 on a client PC, Username postgres, Password DaVinci)
     If it was already listed, click another library and back to refresh.
     Use the same Resolve version that wrote the library.
  2. Right-click the project(s) you need > Export Project (.drp)
  3. Switch to the live library > right-click > Import Project > pick the .drp
  4. When finished: remove '$name' from the library list in Resolve, then delete
     it in Project Server (or: $PG_BIN/dropdb -h localhost -U postgres $name)
EOF
