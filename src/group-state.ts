/**
 * Group state container.
 *
 * Holds mutable orchestrator state (registered groups, sessions, message
 * cursor, bot-conversation guards, pending thread anchors) and the
 * registration/recovery helpers that mutate it. Separated from index.ts so
 * message-loop edits don't require reading state-management boilerplate.
 *
 * `lastAgentTimestamp` is private; mutate via `setCursor` / `rollbackCursor`
 * to ensure the DB write happens. Other state is exposed on the `state`
 * object for direct access.
 */
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  ONECLI_URL,
} from './config.js';
import {
  AvailableGroup,
  writeGroupsSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getLastBotMessageTimestamp,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const state = {
  sessions: {} as Record<string, string>,
  registeredGroups: {} as Record<string, RegisteredGroup>,
  // Bot-to-bot conversation guard: tracks consecutive bot-triggered rounds
  // per physical channel. Resets when a human message arrives.
  botConversationCount: {} as Record<string, number>,
  // Most recent triggering message's thread_ts per chat — agent replies in
  // the same thread.
  pendingThreadTs: {} as Record<string, string>,
};

// Private: cursor of last processed agent timestamp per chat. Mutate via
// setCursor / rollbackCursor so the DB stays in sync.
let lastAgentTimestamp: Record<string, string> = {};

const onecli = new OneCLI({ url: ONECLI_URL });

export function getPhysicalChannel(jid: string): string {
  return jid.replace(/^[^:]+:/, '');
}

export function ensureOneCLIAgent(
  jid: string,
  group: RegisteredGroup,
): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

export function loadGroupState(): void {
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  state.sessions = getAllSessions();
  state.registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(state.registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
export function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    setCursor(chatJid, botTs);
    return botTs;
  }
  return '';
}

export function getCursor(chatJid: string): string {
  return lastAgentTimestamp[chatJid] || '';
}

export function setCursor(chatJid: string, ts: string): void {
  lastAgentTimestamp[chatJid] = ts;
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

export function rollbackCursor(chatJid: string, ts: string): void {
  if (ts) lastAgentTimestamp[chatJid] = ts;
  else delete lastAgentTimestamp[chatJid];
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

export function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  state.registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  // Update groups snapshot for all groups (new group is now visible)
  const availGroups = getAvailableGroups();
  const rjids = new Set(Object.keys(state.registeredGroups));
  for (const g of Object.values(state.registeredGroups)) {
    writeGroupsSnapshot(g.folder, g.isMain === true, availGroups, rjids);
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(state.registeredGroups));

  return chats
    .filter((c) => c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  state.registeredGroups = groups;
}
