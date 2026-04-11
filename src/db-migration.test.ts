import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { SCHEMA_VERSION } from './db.js';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('fresh DB reaches latest schema version', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      vi.resetModules();
      const { initDatabase, _closeDatabase } = await import('./db.js');

      initDatabase();

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const db = new Database(dbPath, { readonly: true });
      const version = db.pragma('user_version', { simple: true });
      db.close();

      expect(version).toBe(SCHEMA_VERSION);

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('legacy DB (user_version=0) migrates all columns', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      // Create a minimal legacy DB missing all migration columns
      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me INTEGER,
          PRIMARY KEY (id, chat_jid)
        );
        CREATE TABLE scheduled_tasks (
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
          created_at TEXT NOT NULL
        );
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1
        );
        CREATE TABLE router_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE sessions (
          group_folder TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        );
        CREATE TABLE task_run_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          run_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT
        );
      `);
      // Insert a __group_sync__ sentinel that should be cleaned up
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('__group_sync__', '__group_sync__', '2024-01-01T00:00:00.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      // Verify version
      const db = new Database(dbPath, { readonly: true });
      const version = db.pragma('user_version', { simple: true });

      // Verify all migration columns exist
      const schedCols = db
        .prepare(`PRAGMA table_info(scheduled_tasks)`)
        .all() as Array<{ name: string }>;
      const msgCols = db
        .prepare(`PRAGMA table_info(messages)`)
        .all() as Array<{ name: string }>;
      const regCols = db
        .prepare(`PRAGMA table_info(registered_groups)`)
        .all() as Array<{ name: string }>;
      const chatCols = db
        .prepare(`PRAGMA table_info(chats)`)
        .all() as Array<{ name: string }>;
      db.close();

      expect(version).toBe(SCHEMA_VERSION);

      const colNames = (cols: Array<{ name: string }>) =>
        cols.map((c) => c.name);
      expect(colNames(schedCols)).toContain('context_mode');
      expect(colNames(schedCols)).toContain('script');
      expect(colNames(msgCols)).toContain('is_bot_message');
      expect(colNames(msgCols)).toContain('thread_id');
      expect(colNames(regCols)).toContain('is_main');
      expect(colNames(regCols)).toContain('review_config');
      expect(colNames(regCols)).toContain('sdk');
      expect(colNames(regCols)).toContain('model');
      expect(colNames(chatCols)).toContain('channel');
      expect(colNames(chatCols)).toContain('is_group');

      // Verify __group_sync__ sentinel was removed
      const chats = getAllChats();
      expect(chats.find((c) => c.jid === '__group_sync__')).toBeUndefined();

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
