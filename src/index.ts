import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { startSessionCleanup } from './session-cleanup.js';
import { tryHandleSessionResetCommand } from './session-reset.js';
import type { SessionResetDeps, SessionHandlerDeps } from './session-reset.js';
import {
  ContainerOutput,
  resolveModel,
  runContainerAgent,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllTasks,
  deleteSession,
  getMessageById,
  getMessagesSince,
  initDatabase,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  ensureOneCLIAgent,
  getAvailableGroups,
  getCursor,
  getOrRecoverCursor,
  getPhysicalChannel,
  loadGroupState,
  registerGroup,
  rollbackCursor,
  setCursor,
  state,
  writeGroupsSnapshot,
} from './group-state.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import {
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './formatting.js';
import { findChannel } from './router.js';
import {
  restoreRemoteControl,
  tryHandleRemoteControlCommand,
  type RemoteControlCommandDeps,
} from './remote-control.js';
import {
  hasAllowedTrigger,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropBySenderAllowlist,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import {
  tryHandleLabDashboardCommand,
  type LabDashboardCommandDeps,
} from './lab-dashboard.js';
import {
  startSchedulerLoop,
  writeAllTasksSnapshots,
} from './task-scheduler.js';
import { Channel, ChannelType, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Bot-to-bot conversation guard: prevent infinite loops.
const MAX_BOT_ROUNDS = 3;

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = state.registeredGroups[chatJid];
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
    delete state.botConversationCount[ch];
  } else if (hasPeerBotMessages) {
    state.botConversationCount[ch] = (state.botConversationCount[ch] || 0) + 1;
    if (state.botConversationCount[ch] > MAX_BOT_ROUNDS) {
      logger.info(
        { group: group.name, rounds: state.botConversationCount[ch] },
        'Bot conversation limit reached, pausing until user intervention',
      );
      // Advance cursor so we don't re-process these messages
      setCursor(chatJid, missedMessages[missedMessages.length - 1].timestamp);
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
            advanceCursor: (ts) => setCursor(chatJid, ts),
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

  if (!hasAllowedTrigger(group, missedMessages, chatJid)) {
    return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = getCursor(chatJid);
  setCursor(chatJid, missedMessages[missedMessages.length - 1].timestamp);

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
      const text = stripInternalTags(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        const threadTs = state.pendingThreadTs[chatJid];
        await channel.sendMessage(
          chatJid,
          text,
          threadTs ? { threadTs } : undefined,
        );
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
    rollbackCursor(chatJid, previousCursor);
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
  const sessionId = state.sessions[group.folder];

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          state.sessions[group.folder] = output.newSessionId;
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
        sdk: group.sdk,
        model: resolveModel(group.sdk, group.model),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      state.sessions[group.folder] = output.newSessionId;
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
      delete state.sessions[group.folder];
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
      const jids = Object.keys(state.registeredGroups);

      for (const chatJid of jids) {
        const group = state.registeredGroups[chatJid];
        if (!group) continue;

        const pending = getMessagesSince(
          chatJid,
          getOrRecoverCursor(chatJid),
          ASSISTANT_NAME,
          MAX_MESSAGES_PER_PROMPT,
        );
        if (pending.length === 0) continue;

        const isMainGroup = group.isMain === true;

        if (!hasAllowedTrigger(group, pending, chatJid)) continue;

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
          setCursor(chatJid, pending[pending.length - 1].timestamp);
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
  for (const [chatJid, group] of Object.entries(state.registeredGroups)) {
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
  loadGroupState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(state.registeredGroups)) {
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

  // --- Command intercept deps (shared by all channels) ---

  const resetDeps: SessionResetDeps = {
    dataDir: DATA_DIR,
    sessions: state.sessions,
    terminateGroup: (jid) => queue.terminateGroup(jid),
    deleteSession,
  };

  // Send text to whichever channel owns the JID. Used by command intercepts
  // that emit raw platform-formatted text (no formatOutbound pass).
  const sendRaw = async (chatJid: string, text: string): Promise<void> => {
    const ch = findChannel(channels, chatJid);
    if (!ch) return;
    await ch.sendMessage(chatJid, text);
  };

  const labDashboardDeps: LabDashboardCommandDeps = {
    registeredGroups: state.registeredGroups,
    getQueueStatuses: () => queue.getStatuses(),
    getSessionCount: () => Object.keys(state.sessions).length,
    getActiveContainerCount: () => queue.activeContainerCount,
    timezone: TIMEZONE,
    sendMessage: sendRaw,
  };

  const sessionResetDeps: SessionHandlerDeps = {
    ...resetDeps,
    registeredGroups: state.registeredGroups,
    sendMessage: sendRaw,
  };

  const remoteControlDeps: RemoteControlCommandDeps = {
    registeredGroups: state.registeredGroups,
    cwd: process.cwd(),
    sendMessage: sendRaw,
  };

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Command intercepts — return early, skip storage
      if (tryHandleLabDashboardCommand(chatJid, msg, labDashboardDeps)) return;
      if (tryHandleSessionResetCommand(chatJid, msg, sessionResetDeps)) return;
      if (tryHandleRemoteControlCommand(chatJid, msg, remoteControlDeps))
        return;
      if (shouldDropBySenderAllowlist(chatJid, msg, state.registeredGroups))
        return;

      // Reset bot conversation counter when a human sends a message
      if (!msg.is_bot_message) {
        const ch = getPhysicalChannel(chatJid);
        delete state.botConversationCount[ch];
      }
      storeMessage(msg);

      // Enrich thread replies with parent message context
      if (msg.thread_id) {
        const parent = getMessageById(msg.thread_id, msg.chat_jid);
        if (parent) {
          msg.reply_to_sender_name = parent.sender_name;
          msg.reply_to_content = parent.content.slice(0, 300);
        }
        state.pendingThreadTs[msg.chat_jid] = msg.thread_id;
      } else {
        delete state.pendingThreadTs[msg.chat_jid];
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => state.registeredGroups,
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
  startSessionCleanup();
  startSchedulerLoop({
    registeredGroups: () => state.registeredGroups,
    getSessions: () => state.sessions,
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
    registeredGroups: () => state.registeredGroups,
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
      writeAllTasksSnapshots(state.registeredGroups, getAllTasks());
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // Write initial snapshots so containers can read tasks/groups from startup
  writeAllTasksSnapshots(state.registeredGroups, getAllTasks());
  {
    const initAvailableGroups = getAvailableGroups();
    const initRegisteredJids = new Set(Object.keys(state.registeredGroups));
    for (const group of Object.values(state.registeredGroups)) {
      writeGroupsSnapshot(
        group.folder,
        group.isMain === true,
        initAvailableGroups,
        initRegisteredJids,
      );
    }
  }

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
