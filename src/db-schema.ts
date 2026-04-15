/**
 * Database schema creation and version-based migrations.
 * Separated from db.ts so that query-only work doesn't require
 * reading ~200 lines of write-once schema/migration code.
 */
import Database from 'better-sqlite3';

import { PAT_ASSISTANT_NAME } from './config.js';

export function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      thread_id TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      script TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      review_config TEXT,
      mat_config TEXT,
      sdk TEXT DEFAULT 'codex',
      model TEXT
    );
  `);

  runMigrations(database);
}

// --- Version-based migrations (PRAGMA user_version) ---

type Migration = (database: Database.Database) => void;

/**
 * Sequential migrations. Index 0 upgrades user_version 0→1, etc.
 * Existing DBs (user_version=0) already have these columns from the old
 * try/catch pattern — the ALTER TABLEs fail silently via try/catch.
 * New DBs have all columns in CREATE TABLE, so ALTER TABLEs also fail silently.
 */
const migrations: Migration[] = [
  // 1: scheduled_tasks.context_mode
  (db) => {
    try {
      db.exec(
        `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
      );
    } catch {
      /* already exists */
    }
  },
  // 2: scheduled_tasks.script
  (db) => {
    try {
      db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
    } catch {
      /* already exists */
    }
  },
  // 3: messages.is_bot_message + backfill
  (db) => {
    try {
      db.exec(
        `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
      );
      db.prepare(
        `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
      ).run(`${PAT_ASSISTANT_NAME}:%`);
    } catch {
      /* already exists */
    }
  },
  // 4: registered_groups.is_main + backfill
  (db) => {
    try {
      db.exec(
        `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
      );
      db.exec(`UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`);
    } catch {
      /* already exists */
    }
  },
  // 5: registered_groups.review_config
  (db) => {
    try {
      db.exec(`ALTER TABLE registered_groups ADD COLUMN review_config TEXT`);
    } catch {
      /* already exists */
    }
  },
  // 6: registered_groups.sdk
  (db) => {
    try {
      db.exec(
        `ALTER TABLE registered_groups ADD COLUMN sdk TEXT DEFAULT 'codex'`,
      );
    } catch {
      /* already exists */
    }
  },
  // 7: registered_groups.model
  (db) => {
    try {
      db.exec(`ALTER TABLE registered_groups ADD COLUMN model TEXT`);
    } catch {
      /* already exists */
    }
  },
  // 8: messages.thread_id
  (db) => {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
    } catch {
      /* already exists */
    }
  },
  // 9: chats.channel + chats.is_group + backfill
  (db) => {
    try {
      db.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
      db.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
      db.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
      );
      db.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
      );
      db.exec(
        `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
      );
      db.exec(
        `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
      );
    } catch {
      /* already exists */
    }
  },
  // 10: remove __group_sync__ sentinel from chats
  (db) => {
    db.exec(`DELETE FROM chats WHERE jid = '__group_sync__'`);
  },
  // 11: slack-review → slack-mat rename + review_config → mat_config column
  //     Atomic: all-or-nothing via transaction. No-op on fresh installs
  //     (UPDATE ... WHERE jid LIKE 'slack-review:%' matches 0 rows).
  //
  //     defer_foreign_keys: messages.chat_jid → chats.jid FK would fire
  //     mid-transaction as we rename chats and messages in sequence. Deferring
  //     postpones the check until COMMIT, by which time all tables are consistent.
  (db) => {
    const tx = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      try {
        db.exec(`ALTER TABLE registered_groups ADD COLUMN mat_config TEXT`);
      } catch {
        /* already exists (fresh CREATE TABLE covers it) */
      }
      db.exec(
        `UPDATE registered_groups SET mat_config = review_config
         WHERE review_config IS NOT NULL AND mat_config IS NULL`,
      );
      db.exec(
        `UPDATE registered_groups SET jid = REPLACE(jid, 'slack-review:', 'slack-mat:')
         WHERE jid LIKE 'slack-review:%'`,
      );
      db.exec(
        `UPDATE chats SET jid = REPLACE(jid, 'slack-review:', 'slack-mat:')
         WHERE jid LIKE 'slack-review:%'`,
      );
      db.exec(
        `UPDATE messages SET chat_jid = REPLACE(chat_jid, 'slack-review:', 'slack-mat:')
         WHERE chat_jid LIKE 'slack-review:%'`,
      );
      db.exec(
        `UPDATE scheduled_tasks SET chat_jid = REPLACE(chat_jid, 'slack-review:', 'slack-mat:')
         WHERE chat_jid LIKE 'slack-review:%'`,
      );
      db.exec(
        `UPDATE router_state SET value = REPLACE(value, 'slack-review:', 'slack-mat:')
         WHERE value LIKE '%slack-review:%'`,
      );
    });
    tx();
  },
];

/** Current schema version (= migrations.length). Exported for tests. */
export const SCHEMA_VERSION = migrations.length;

function runMigrations(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number;

  for (let i = current; i < migrations.length; i++) {
    migrations[i](database);
    database.pragma(`user_version = ${i + 1}`);
  }
}
