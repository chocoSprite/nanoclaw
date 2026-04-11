#!/bin/bash
# Daily backup of messages.db — keeps last 14 days

DB="/Users/jhheo/Documents/nanoclaw/store/messages.db"
BACKUP_DIR="/Users/jhheo/Documents/nanoclaw/store/backups"
DATE=$(date +%Y%m%d)
MAX_DAYS=14

mkdir -p "$BACKUP_DIR"

# Use sqlite3 .backup for a safe copy (no corruption from write locks)
sqlite3 "$DB" ".backup '$BACKUP_DIR/messages-$DATE.db'"

# Delete backups older than 14 days
find "$BACKUP_DIR" -name "messages-*.db" -mtime +$MAX_DAYS -delete
