import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { getCodexUsageSummary } from './codex-usage.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  deleteSession,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Bot-to-bot conversation guard: prevent infinite loops.
// Tracks consecutive bot-triggered rounds per physical channel.
// Resets when a human message arrives.
const MAX_BOT_ROUNDS = 3;
const botConversationCount: Record<string, number> = {};

function getPhysicalChannel(jid: string): string {
  return jid.replace(/^[^:]+:/, '');
}

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
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

function loadState(): void {
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
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

  registeredGroups[jid] = group;
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

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
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
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Bot-to-bot conversation guard: prevent infinite loops.
  // If all pending messages are from peer bots, increment counter.
  // If any human message is present, reset counter.
  const ch = getPhysicalChannel(chatJid);
  const hasHumanMessages = missedMessages.some((m) => !m.is_bot_message);
  const hasPeerBotMessages = missedMessages.some((m) => m.is_bot_message);

  if (hasHumanMessages) {
    delete botConversationCount[ch];
  } else if (hasPeerBotMessages) {
    botConversationCount[ch] = (botConversationCount[ch] || 0) + 1;
    if (botConversationCount[ch] > MAX_BOT_ROUNDS) {
      logger.info(
        { group: group.name, rounds: botConversationCount[ch] },
        'Bot conversation limit reached, pausing until user intervention',
      );
      // Advance cursor so we don't re-process these messages
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      await channel.sendMessage(
        chatJid,
        `[대화 ${MAX_BOT_ROUNDS}라운드 완료 — 사용자 입력을 기다립니다]`,
      );
      return true;
    }
  }

  // --- Session command interception (before trigger check) ---
  // Only Claude SDK groups support session commands (/compact)
  const cmdResult =
    group.sdk === 'claude'
      ? await handleSessionCommand({
          missedMessages,
          isMainGroup,
          groupName: group.name,
          triggerPattern: getTriggerPattern(group.trigger),
          timezone: TIMEZONE,
          deps: {
            sendMessage: (text) => channel.sendMessage(chatJid, text),
            setTyping: (typing) =>
              channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
            runAgent: (prompt, onOutput) =>
              runAgent(group, prompt, chatJid, onOutput),
            closeStdin: () => queue.closeStdin(chatJid),
            advanceCursor: (ts) => {
              lastAgentTimestamp[chatJid] = ts;
              saveState();
            },
            formatMessages,
            canSenderInteract: (msg) => {
              const hasTrigger = getTriggerPattern(group.trigger).test(
                msg.content.trim(),
              );
              const reqTrigger =
                !isMainGroup && group.requiresTrigger !== false;
              return (
                isMainGroup ||
                !reqTrigger ||
                (hasTrigger &&
                  (msg.is_from_me ||
                    isTriggerAllowed(
                      chatJid,
                      msg.sender,
                      loadSenderAllowlist(),
                    )))
              );
            },
          },
        })
      : null;
  if (cmdResult?.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        sdk: group.sdk ?? 'codex',
        model: group.model,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    // Clean up stale sessions so the next attempt starts fresh
    const isStaleSession =
      sessionId &&
      output.error &&
      /no conversation found|ENOENT.*\.jsonl|session.*not found|no rollout found/i.test(
        output.error,
      );
    if (isStaleSession) {
      logger.warn(
        { group: group.name, sessionId },
        'Stale session detected, clearing',
      );
      delete sessions[group.folder];
      deleteSession(group.folder);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);

      for (const chatJid of jids) {
        const group = registeredGroups[chatJid];
        if (!group) continue;

        const pending = getMessagesSince(
          chatJid,
          getOrRecoverCursor(chatJid),
          ASSISTANT_NAME,
          MAX_MESSAGES_PER_PROMPT,
        );
        if (pending.length === 0) continue;

        const isMainGroup = group.isMain === true;
        const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

        if (needsTrigger) {
          const triggerPattern = getTriggerPattern(group.trigger);
          const allowlistCfg = loadSenderAllowlist();
          const hasTrigger = pending.some(
            (m) =>
              triggerPattern.test(m.content.trim()) &&
              (m.is_from_me ||
                isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
          );
          if (!hasTrigger) continue;
        }

        const channel = findChannel(channels, chatJid);
        if (!channel) continue;

        const formatted = formatMessages(pending, TIMEZONE);

        // --- Session command interception (message loop, Claude SDK only) ---
        const loopCmdMsg =
          group.sdk === 'claude'
            ? pending.find(
                (m) =>
                  extractSessionCommand(
                    m.content,
                    getTriggerPattern(group.trigger),
                  ) !== null,
              )
            : null;

        if (loopCmdMsg) {
          if (
            isSessionCommandAllowed(isMainGroup, loopCmdMsg.is_from_me === true)
          ) {
            queue.closeStdin(chatJid);
          }
          queue.enqueueMessageCheck(chatJid);
          continue;
        }
        // --- End session command interception ---

        if (queue.sendMessage(chatJid, formatted)) {
          lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
          saveState();
          channel
            .setTyping?.(chatJid, true)
            ?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
        } else {
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // --- Session reset command ---

  /**
   * Match user input to a registered group.
   * Accepts: short name (agent-meeting-notes), full folder (slack_agent_meeting_notes), or display name (패트).
   */
  function findGroupByInput(input: string): [string, RegisteredGroup] | null {
    const normalized = input.trim().toLowerCase().replace(/-/g, '_');
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.folder.toLowerCase() === normalized) return [jid, group];
      const unprefixed = group.folder.replace(
        /^(slack|whatsapp|telegram|discord)_/,
        '',
      );
      if (unprefixed.toLowerCase() === normalized) return [jid, group];
      if (group.name.toLowerCase() === input.trim().toLowerCase())
        return [jid, group];
    }
    return null;
  }

  /**
   * Reset a group's session: terminate container, clear in-memory + DB + SDK files.
   * Preserves agent memory, auth, config, and skills.
   */
  async function handleSessionReset(
    chatJid: string,
    targetInput: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const match = findGroupByInput(targetInput);
    if (!match) {
      const list = Object.values(registeredGroups)
        .map(
          (g) =>
            `  ${g.folder}`,
        )
        .join('\n');
      await channel.sendMessage(
        chatJid,
        `그룹을 찾을 수 없습니다: ${targetInput}\n\n사용 가능:\n${list}`,
      );
      return;
    }

    const [targetJid, group] = match;
    const sdkType = group.sdk ?? 'codex';
    const errors: string[] = [];

    // 1. Terminate running container
    await queue.terminateGroup(targetJid);

    // 2. Clear in-memory session
    delete sessions[group.folder];

    // 3. Clear DB session record
    deleteSession(group.folder);

    // 4. Clean SDK session files on disk
    const sdkDirName = sdkType === 'claude' ? '.claude' : '.codex';
    const sdkBase = path.join(DATA_DIR, 'sessions', group.folder, sdkDirName);

    if (sdkType === 'codex') {
      // Codex: delete sessions/ dir + state_5.sqlite*
      for (const target of ['sessions']) {
        const p = path.join(sdkBase, target);
        try {
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
        } catch (err) {
          errors.push(`${target}: ${err}`);
        }
      }
      // Delete state_5.sqlite and WAL/SHM files
      const sdkEntries = fs.existsSync(sdkBase) ? fs.readdirSync(sdkBase) : [];
      for (const f of sdkEntries.filter((n) =>
        n.startsWith('state_5.sqlite'),
      )) {
        try {
          fs.unlinkSync(path.join(sdkBase, f));
        } catch (err) {
          errors.push(`${f}: ${err}`);
        }
      }
    } else {
      // Claude: delete sessions/, backups/, and project session files (preserve memory/)
      for (const dir of ['sessions', 'backups']) {
        const p = path.join(sdkBase, dir);
        try {
          if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
        } catch (err) {
          errors.push(`${dir}: ${err}`);
        }
      }
      // Clean projects: delete *.jsonl and subagents/ but preserve memory/
      const projectsDir = path.join(sdkBase, 'projects');
      if (fs.existsSync(projectsDir)) {
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.name === 'memory') continue; // preserve
            if (entry.isDirectory()) {
              if (entry.name === 'subagents') {
                try {
                  fs.rmSync(full, { recursive: true });
                } catch (err) {
                  errors.push(`subagents: ${err}`);
                }
              } else {
                walk(full);
              }
            } else if (entry.name.endsWith('.jsonl')) {
              try {
                fs.unlinkSync(full);
              } catch (err) {
                errors.push(`${entry.name}: ${err}`);
              }
            }
          }
        };
        walk(projectsDir);
      }
    }

    const status =
      errors.length === 0 ? 'OK' : `부분 성공 (${errors.join(', ')})`;
    logger.info(
      { group: group.name, folder: group.folder, sdk: sdkType, errors },
      'Session reset',
    );
    await channel.sendMessage(
      chatJid,
      `:arrows_counterclockwise: *세션 초기화 완료*\n그룹: *${group.name}* (${group.folder})\nSDK: ${sdkType}\n상태: ${status}`,
    );
  }

  // Handle "랩대시보드" — respond with host-side status snapshot, no container
  async function handleLabDashboard(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const now = new Date();
    const ts = now.toLocaleString('ko-KR', { timeZone: TIMEZONE });

    // Registered groups
    const groups = Object.entries(registeredGroups);
    const queueStatuses = queue.getStatuses();
    const statusMap = new Map(queueStatuses.map((s) => [s.jid, s]));

    const groupLines = groups.map(([jid, g]) => {
      const qs = statusMap.get(jid);
      let icon = ':white_circle:';
      let detail = '유휴';
      if (qs?.active) {
        icon = qs.isTask ? ':large_orange_circle:' : ':large_green_circle:';
        detail = qs.isTask ? `태스크 실행 중` : '에이전트 실행 중';
        if (qs.idleWaiting) {
          icon = ':large_blue_circle:';
          detail = 'idle 대기';
        }
      }
      const pending: string[] = [];
      if (qs?.pendingMessages) pending.push('메시지 대기');
      if (qs && qs.pendingTaskCount > 0)
        pending.push(`태스크 ${qs.pendingTaskCount}개 대기`);
      const suffix = pending.length > 0 ? ` (${pending.join(', ')})` : '';
      const mainTag = g.isMain ? ' :star:' : '';
      const sdkTag = g.sdk === 'claude' ? ' `Claude`' : ' `Codex`';
      return `${icon} *${g.name}*${mainTag}${sdkTag} — ${detail}${suffix}`;
    });

    // Scheduled tasks
    const tasks = getAllTasks();
    const active = tasks.filter((t) => t.status === 'active');
    const paused = tasks.filter((t) => t.status === 'paused');
    const upcoming = active
      .filter((t) => t.next_run)
      .sort((a, b) => a.next_run!.localeCompare(b.next_run!))
      .slice(0, 5);

    const taskLines = upcoming.map((t) => {
      const nextRun = t.next_run
        ? new Date(t.next_run).toLocaleString('ko-KR', { timeZone: TIMEZONE })
        : '—';
      const groupName = t.group_folder;
      let schedLabel = t.schedule_value;
      if (t.schedule_type === 'cron') {
        const parts = t.schedule_value.split(' ');
        if (parts.length >= 5) {
          const h = parts[1].padStart(2, '0');
          const m = parts[0].padStart(2, '0');
          const dayMap: Record<string, string> = {
            '1-5': '평일',
            '*': '매일',
            '0,6': '주말',
          };
          const dayPart = dayMap[parts[4]] ?? parts[4];
          schedLabel = `${dayPart} ${h}:${m}`;
        }
      }
      return `• [${groupName}] ${schedLabel} → ${nextRun}`;
    });

    // Sessions
    const sessionCount = Object.keys(sessions).length;

    // Active containers
    const activeContainers = queue.activeContainerCount;

    // Codex usage (fetch in parallel while building the rest)
    const usagePromise = getCodexUsageSummary();

    // Build message (Slack mrkdwn)
    const lines = [
      `:bar_chart: *랩 대시보드* — ${ts}`,
      '',
      `*채널* (${groups.length}개)`,
      ...groupLines,
      '',
      `:gear: *컨테이너* ${activeContainers}개 실행 중 | *세션* ${sessionCount}개`,
    ];

    // Codex usage section
    const usage = await usagePromise;
    if (usage) {
      const bar = (pct: number) => {
        const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
        return '\u2588'.repeat(filled) + '\u2591'.repeat(5 - filled);
      };
      lines.push('');
      lines.push(':chart_with_upwards_trend: *Codex 사용량*');
      lines.push(
        `5h  \`${bar(usage.h5pct)}\` ${usage.h5pct}%${usage.h5reset ? ` (리셋 ${usage.h5reset})` : ''}`,
      );
      lines.push(
        `7d  \`${bar(usage.d7pct)}\` ${usage.d7pct}%${usage.d7reset ? ` (리셋 ${usage.d7reset})` : ''}`,
      );
    } else {
      lines.push('');
      lines.push(':chart_with_upwards_trend: *Codex 사용량* — 조회 실패');
    }

    lines.push('');
    lines.push(
      `:calendar: *스케줄 작업* — 활성 ${active.length} / 일시정지 ${paused.length} / 전체 ${tasks.length}`,
    );
    if (taskLines.length > 0) {
      lines.push('다음 실행 예정:');
      lines.push(...taskLines);
    }

    await channel.sendMessage(chatJid, lines.join('\n'));
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Lab dashboard — intercept before storage, main group only
      const trimmed = msg.content.trim();
      if (trimmed === '랩대시보드' && registeredGroups[chatJid]?.isMain) {
        handleLabDashboard(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Lab dashboard error'),
        );
        return;
      }

      // Session reset — intercept before storage, main group only
      if (
        trimmed.startsWith('세션초기화 ') &&
        registeredGroups[chatJid]?.isMain
      ) {
        const targetInput = trimmed.slice('세션초기화 '.length).trim();
        if (targetInput) {
          handleSessionReset(chatJid, targetInput).catch((err) =>
            logger.error({ err, chatJid }, 'Session reset error'),
          );
          return;
        }
      }

      // Remote control commands — intercept before storage
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Reset bot conversation counter when a human sends a message
      if (!msg.is_bot_message) {
        const ch = getPhysicalChannel(chatJid);
        delete botConversationCount[ch];
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
