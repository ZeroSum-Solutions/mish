#!/bin/sh
# codegraph-worktree: give a checkout a CodeGraph index without a full rebuild.
#
#   sh scripts/agents/codegraph-worktree.sh [<checkout dir>]   (default: the current checkout)
#   sh scripts/agents/codegraph-worktree.sh --hook             (Claude Code SessionStart hook)
#
# A full `codegraph init` parses all ~6,500 files with one worker per core and peaks at
# several GB; doing that in every new worktree is what slowed the machine down. Instead,
# a linked worktree clones the main checkout's index (APFS clone: no extra disk until
# pages change), checks it, and runs `codegraph sync`, which reparses only the files that
# differ. The main checkout itself is indexed with `codegraph init` once, at low priority.
#
# Every CodeGraph process this script starts uses the worker caps below. The same caps sit
# in `.claude/settings.json` so the MCP daemons Claude Code starts honour them too.
#
# Why this is a shell script and not TypeScript: it runs from a session hook before the
# workspace is installed, and only drives the codegraph, git and sqlite3 executables.
#
# Exit: 0 index ready, already present, or skipped (no codegraph) · 1 failed · 64 usage

set -u

export CODEGRAPH_PARSE_WORKERS="${CODEGRAPH_PARSE_WORKERS:-2}"
export CODEGRAPH_RESOLVE_WORKERS="${CODEGRAPH_RESOLVE_WORKERS:-2}"
export CODEGRAPH_QUERY_POOL_SIZE="${CODEGRAPH_QUERY_POOL_SIZE:-2}"

HOOK=0
WT=""
case "${1:-}" in
  --hook) HOOK=1 ;;
  -h|--help) sed -n '3,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) WT="$1" ;;
esac

if [ "$HOOK" = 1 ]; then
  # The hook passes JSON on stdin; only `cwd` matters. Never block or fail a session start.
  WT=$(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).cwd||"")}catch{}})' 2>/dev/null)
fi
[ -n "$WT" ] || WT=$(pwd)
WT=$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null) || { [ "$HOOK" = 1 ] && exit 0; echo "codegraph-worktree: not a checkout: $WT" >&2; exit 64; }

command -v codegraph >/dev/null 2>&1 || { [ "$HOOK" = 1 ] || echo "codegraph-worktree: codegraph is not installed; skipping" >&2; exit 0; }

DB="$WT/.codegraph/codegraph.db"
[ -s "$DB" ] && { [ "$HOOK" = 1 ] || echo "index present: $WT/.codegraph"; exit 0; }

COMMON=$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)
MAIN=$(dirname "$COMMON")
STATE="$COMMON/mish-codegraph"
mkdir -p "$STATE"
KEY=$(printf '%s' "$WT" | shasum | cut -c1-16)
LOG="$STATE/$KEY.log"

if [ "$HOOK" = 1 ]; then
  # Detach: the clone and sync take a minute and must not delay the session.
  nohup sh "$0" "$WT" >>"$LOG" 2>&1 </dev/null &
  echo "CodeGraph index for this worktree is being prepared in the background (log: $LOG). Until it is ready, codegraph answers from the main checkout's index; confirm branch-specific code by reading the file."
  exit 0
fi

# One bootstrap per checkout at a time.
LOCK="$STATE/$KEY.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ $(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) )) -lt 1800 ]; then
    echo "codegraph-worktree: another bootstrap is running for $WT"; exit 0
  fi
  rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" || exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

echo "[$(date -u +%FT%TZ)] bootstrap $WT"

if [ "$WT" = "$MAIN" ]; then
  echo "main checkout: building the index once at low priority"
  nice -n 15 codegraph init -y "$WT"
  exit $?
fi

SRC="$MAIN/.codegraph/codegraph.db"
if [ ! -s "$SRC" ]; then
  echo "main checkout has no index; build it first: sh scripts/agents/codegraph-worktree.sh $MAIN"
  exit 1
fi

mkdir -p "$WT/.codegraph"
[ -f "$MAIN/.codegraph/.gitignore" ] && cp "$MAIN/.codegraph/.gitignore" "$WT/.codegraph/.gitignore"
TMP="$WT/.codegraph/codegraph.db.tmp"
rm -f "$TMP" "$TMP-wal" "$TMP-shm"

# Fold the WAL into the main file (PASSIVE never blocks the main daemon), then clone.
sqlite3 "$SRC" 'PRAGMA wal_checkpoint(PASSIVE);' >/dev/null 2>&1
cloned=0
if cp -c "$SRC" "$TMP" 2>/dev/null; then
  [ -s "$SRC-wal" ] && cp -c "$SRC-wal" "$TMP-wal" 2>/dev/null
  if [ "$(sqlite3 "$TMP" 'PRAGMA quick_check;' 2>/dev/null)" = "ok" ]; then
    cloned=1
  else
    echo "clone failed its integrity check (main index changed mid-copy); using an online backup"
    rm -f "$TMP" "$TMP-wal" "$TMP-shm"
  fi
fi
if [ "$cloned" = 0 ]; then
  sqlite3 "$SRC" ".backup '$TMP'" || { echo "backup of the main index failed"; exit 1; }
fi
sqlite3 "$TMP" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1
rm -f "$TMP-wal" "$TMP-shm"
mv "$TMP" "$DB"

echo "index copied from $MAIN; syncing changed files"
nice -n 15 codegraph sync "$WT"
rc=$?
echo "[$(date -u +%FT%TZ)] done (exit $rc)"
exit $rc
