#!/usr/bin/env bash
# Migrate running install from slack-review → slack-mat + review_config → mat_config.
#
# Idempotent & safe:
#  1. launchctl unload           (stop service to release DB lock)
#  2. DB backup                  (store/backups/pre-pat-mat-YYYYMMDD-HHMMSS.db)
#  3. npm run build              (ensure dist/ matches committed src/)
#  4. launchctl load             (DB migration #12 runs automatically on startup)
#  5. Verify JIDs in DB          (slack-review:* should be 0, slack-mat:* should match prior count)
#  6. Tail startup logs
#
# If anything fails, the backup can be restored with:
#   cp store/backups/pre-pat-mat-<timestamp>.db store/messages.db

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DB="$PROJECT_ROOT/store/messages.db"
BACKUP_DIR="$PROJECT_ROOT/store/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/pre-pat-mat-$TIMESTAMP.db"
LOG_FILE="$PROJECT_ROOT/logs/nanoclaw.log"
PLIST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"

blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }

if [[ ! -f "$DB" ]]; then
  red "FATAL: $DB not found"
  exit 1
fi

if [[ ! -f "$PLIST" ]]; then
  red "FATAL: $PLIST not found — NanoClaw service not installed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 0: pre-flight checks
# ---------------------------------------------------------------------------
blue "[0/6] Pre-flight checks"

PRE_REVIEW_JIDS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE 'slack-review:%'")
PRE_MAT_JIDS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE 'slack-mat:%'")
PRE_REVIEW_MSGS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE chat_jid LIKE 'slack-review:%'")

echo "  slack-review JIDs in registered_groups: $PRE_REVIEW_JIDS"
echo "  slack-mat    JIDs in registered_groups: $PRE_MAT_JIDS"
echo "  messages with slack-review chat_jid:    $PRE_REVIEW_MSGS"

if [[ "$PRE_REVIEW_JIDS" == "0" && "$PRE_MAT_JIDS" -gt "0" ]]; then
  green "Already migrated — nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1: stop service
# ---------------------------------------------------------------------------
blue "[1/6] launchctl unload (stop service)"
launchctl unload "$PLIST" 2>/dev/null || true
# Give it a moment to release the DB
sleep 1

if pgrep -f "dist/index.js" > /dev/null; then
  red "WARN: nanoclaw process still running — kill manually if needed"
fi

# ---------------------------------------------------------------------------
# Step 2: backup
# ---------------------------------------------------------------------------
blue "[2/6] DB backup → $BACKUP_FILE"
mkdir -p "$BACKUP_DIR"
sqlite3 "$DB" ".backup '$BACKUP_FILE'"
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | awk '{print $1}')
echo "  backup size: $BACKUP_SIZE"

# ---------------------------------------------------------------------------
# Step 3: build
# ---------------------------------------------------------------------------
blue "[3/6] npm run build"
npm run build

# ---------------------------------------------------------------------------
# Step 4: start service (migration #12 runs automatically on startup)
# ---------------------------------------------------------------------------
blue "[4/6] launchctl load (start service; migration runs automatically)"
launchctl load "$PLIST"

# Wait briefly for startup + migration
echo "  waiting 4s for startup…"
sleep 4

# ---------------------------------------------------------------------------
# Step 5: verify
# ---------------------------------------------------------------------------
blue "[5/6] Verify migration results"

POST_REVIEW_JIDS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE 'slack-review:%'")
POST_MAT_JIDS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM registered_groups WHERE jid LIKE 'slack-mat:%'")
POST_REVIEW_MSGS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE chat_jid LIKE 'slack-review:%'")
POST_MAT_MSGS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages WHERE chat_jid LIKE 'slack-mat:%'")
MAT_CONFIG_EXISTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('registered_groups') WHERE name = 'mat_config'")

echo "  slack-review JIDs remaining: $POST_REVIEW_JIDS (expected 0)"
echo "  slack-mat    JIDs after:     $POST_MAT_JIDS (expected $PRE_REVIEW_JIDS)"
echo "  messages review→mat:         $PRE_REVIEW_MSGS → $POST_MAT_MSGS  (remaining: $POST_REVIEW_MSGS)"
echo "  mat_config column exists:    $MAT_CONFIG_EXISTS (expected 1)"

FAIL=0
if [[ "$POST_REVIEW_JIDS" != "0" ]]; then red "  FAIL: slack-review JIDs still present in registered_groups"; FAIL=1; fi
if [[ "$POST_MAT_JIDS" != "$PRE_REVIEW_JIDS" ]]; then red "  FAIL: mat JID count does not match expected"; FAIL=1; fi
if [[ "$POST_REVIEW_MSGS" != "0" ]]; then red "  FAIL: messages still reference slack-review"; FAIL=1; fi
if [[ "$MAT_CONFIG_EXISTS" != "1" ]]; then red "  FAIL: mat_config column missing"; FAIL=1; fi

if [[ "$FAIL" == "1" ]]; then
  red "Migration verification FAILED. Restore: cp $BACKUP_FILE $DB && launchctl unload $PLIST && launchctl load $PLIST"
  exit 2
fi

green "Migration verified."

# ---------------------------------------------------------------------------
# Step 6: tail logs
# ---------------------------------------------------------------------------
blue "[6/6] Recent startup log (last 30 lines)"
if [[ -f "$LOG_FILE" ]]; then
  tail -n 30 "$LOG_FILE"
else
  echo "  (log file not yet created)"
fi

green "Done. Backup at $BACKUP_FILE"
