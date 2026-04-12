import fs from 'fs';

import { getTriggerPattern, SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

// In-memory cache — invalidated by file mtime change
let _cached: SenderAllowlistConfig | null = null;
let _cachedMtime = 0;

/** Clear the in-memory cache (for tests). */
export function _clearAllowlistCache(): void {
  _cached = null;
  _cachedMtime = 0;
}

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const useCache = !pathOverride;

  // Fast path: return cached config if file hasn't changed
  if (useCache && _cached) {
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      if (mtime === _cachedMtime) return _cached;
    } catch {
      /* fall through to full load */
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return _cached ?? DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return DEFAULT_CONFIG;
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  const result: SenderAllowlistConfig = {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };

  if (useCache) {
    try {
      _cachedMtime = fs.statSync(filePath).mtimeMs;
    } catch {
      /* ignore */
    }
    _cached = result;
  }

  return result;
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

/**
 * Returns true if the group should be processed: main/no-trigger groups always pass;
 * otherwise at least one message must match the trigger pattern AND come from an
 * allowlisted sender (or from the bot itself).
 */
export function hasAllowedTrigger(
  group: RegisteredGroup,
  messages: NewMessage[],
  chatJid: string,
): boolean {
  if (group.isMain === true) return true;
  if (group.requiresTrigger === false) return true;

  const pattern = getTriggerPattern(group.trigger);
  const cfg = loadSenderAllowlist();
  return messages.some(
    (m) =>
      pattern.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowed(chatJid, m.sender, cfg)),
  );
}

/**
 * Returns true if the message should be dropped before storage (drop mode + sender denied).
 * Ignores bot/self messages and messages to unregistered groups.
 */
export function shouldDropBySenderAllowlist(
  chatJid: string,
  msg: NewMessage,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (msg.is_from_me || msg.is_bot_message) return false;
  if (!registeredGroups[chatJid]) return false;
  const cfg = loadSenderAllowlist();
  if (!shouldDropMessage(chatJid, cfg)) return false;
  if (isSenderAllowed(chatJid, msg.sender, cfg)) return false;
  if (cfg.logDenied) {
    logger.debug(
      { chatJid, sender: msg.sender },
      'sender-allowlist: dropping message (drop mode)',
    );
  }
  return true;
}
