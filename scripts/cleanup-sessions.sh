#!/bin/bash
# Cleanup stale session files from data/sessions/
# Preserves active sessions (looked up from DB).
# Usage: cleanup-sessions.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SESSIONS_DIR="$PROJECT_DIR/data/sessions"
DB="$PROJECT_DIR/store/messages.db"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# Retention periods (days)
JSONL_DAYS=7
WAL_DAYS=3
TMP_DAYS=3
SNAPSHOT_DAYS=3

total_freed=0

delete_old_files() {
  local dir="$1"
  local pattern="$2"
  local days="$3"
  local label="$4"

  [[ -d "$dir" ]] || return 0

  while IFS= read -r -d '' file; do
    local size
    size=$(wc -c < "$file" 2>/dev/null || echo 0)

    if $DRY_RUN; then
      echo "[dry-run] would delete: $file ($size bytes)"
    else
      rm -f "$file"
    fi
    total_freed=$((total_freed + size))
  done < <(find "$dir" -name "$pattern" -mtime +"$days" -type f -print0 2>/dev/null)
}

if [[ ! -d "$SESSIONS_DIR" ]]; then
  echo "No sessions directory found at $SESSIONS_DIR"
  exit 0
fi

for group_dir in "$SESSIONS_DIR"/*/; do
  [[ -d "$group_dir" ]] || continue
  group_name=$(basename "$group_dir")

  # Codex SDK sessions: .codex/sessions/**/*.jsonl
  delete_old_files "$group_dir/.codex/sessions" "*.jsonl" "$JSONL_DAYS" "$group_name/jsonl"

  # WAL/SHM files (non-active)
  delete_old_files "$group_dir/.codex" "state_*.sqlite-wal" "$WAL_DAYS" "$group_name/wal"
  delete_old_files "$group_dir/.codex" "state_*.sqlite-shm" "$WAL_DAYS" "$group_name/shm"

  # Temp files
  delete_old_files "$group_dir/.codex/.tmp" "*" "$TMP_DAYS" "$group_name/tmp"

  # Shell snapshots
  delete_old_files "$group_dir/.codex/shell_snapshots" "*" "$SNAPSHOT_DAYS" "$group_name/snapshots"

  # Claude SDK: sessions/, backups/
  delete_old_files "$group_dir/.claude/sessions" "*.jsonl" "$JSONL_DAYS" "$group_name/claude-sessions"
  delete_old_files "$group_dir/.claude/backups" "*" "$JSONL_DAYS" "$group_name/claude-backups"
done

# Remove empty directories
find "$SESSIONS_DIR" -type d -empty -delete 2>/dev/null || true

if [[ "$total_freed" -gt 0 ]]; then
  freed_mb=$((total_freed / 1024 / 1024))
  if $DRY_RUN; then
    echo "Would free: ${freed_mb}MB (${total_freed} bytes)"
  else
    echo "Freed: ${freed_mb}MB (${total_freed} bytes)"
  fi
else
  echo "Nothing to clean up"
fi
