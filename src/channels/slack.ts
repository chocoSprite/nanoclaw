import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type {
  GenericMessageEvent,
  BotMessageEvent,
  FileShareMessageEvent,
} from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { DATA_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  isAudioMimetype,
  isWhisperAvailable,
  transcribeAudio,
} from '../transcribe.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const IMAGE_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
]);

// Regex to extract [Image: /path] and [File: /path] tags from outbound agent text
const IMAGE_TAG_RE = /\[Image:\s*(\/[^\]]+)\]/g;
const FILE_TAG_RE = /\[File:\s*(\/[^\]]+)\]/g;
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
// Markdown image links: [name.png](/path/name.png)
const MD_IMAGE_LINK_RE = /\[[^\]]*\]\((\/[^)]+)\)/g;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages, bot messages, and file shares.
type HandledMessageEvent =
  | GenericMessageEvent
  | BotMessageEvent
  | FileShareMessageEvent;

export interface SlackChannelConfig {
  /** .env key for Bot User OAuth Token (default: 'SLACK_BOT_TOKEN') */
  botTokenKey?: string;
  /** .env key for App-Level Token (default: 'SLACK_APP_TOKEN') */
  appTokenKey?: string;
  /** JID prefix used to namespace this channel (default: 'slack') */
  jidPrefix?: string;
  /** Slack user IDs whose @mentions this channel should ignore */
  ignoreMentions?: string[];
  /** If true, only process messages that @mention this bot (default: false) */
  requireMention?: boolean;
  /** Name to use when translating @mentions into trigger format (default: ASSISTANT_NAME) */
  triggerName?: string;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  config?: SlackChannelConfig;
}

// Module-level shared map: triggerName → Slack user ID.
// Populated by each SlackChannel on connect(). Used to translate
// outbound @mentions (e.g. "@매트") into Slack <@UID> format.
const botMentionMap = new Map<string, string>();

export class SlackChannel implements Channel {
  name: string;

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;
  private jidPrefix: string;
  private botTokenKey: string;
  private ignoreMentions: string[];
  private requireMention: boolean;
  private triggerName: string;
  private ownBotId: string | undefined;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    const cfg = opts.config ?? {};
    this.jidPrefix = cfg.jidPrefix ?? 'slack';
    this.botTokenKey = cfg.botTokenKey ?? 'SLACK_BOT_TOKEN';
    this.ignoreMentions = cfg.ignoreMentions ?? [];
    this.requireMention = cfg.requireMention ?? false;
    this.triggerName = cfg.triggerName ?? ASSISTANT_NAME;
    this.name = this.jidPrefix;

    const appTokenKey = cfg.appTokenKey ?? 'SLACK_APP_TOKEN';

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile([this.botTokenKey, appTokenKey]);
    const botToken = env[this.botTokenKey];
    const appToken = env[appTokenKey];

    if (!botToken || !appToken) {
      throw new Error(
        `${this.botTokenKey} and ${appTokenKey} must be set in .env`,
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      const eventFiles = (event as { files?: unknown[] }).files;
      if (eventFiles?.length) {
        logger.info(
          {
            subtype,
            fileCount: eventFiles.length,
            hasText: !!(event as { text?: string }).text,
          },
          'Slack message with files received',
        );
      }
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      const msg = event as HandledMessageEvent;

      const hasFiles = !!eventFiles?.length;
      if (!msg.text && !hasFiles) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `${this.jidPrefix}:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(
        jid,
        timestamp,
        undefined,
        this.jidPrefix,
        isGroup,
      );

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      // Detect messages from THIS bot vs other bots in the channel.
      // We check both user ID and bot_id for reliable self-detection.
      // Other bots' messages are treated as regular messages so they can
      // trigger processing (enabling bot-to-bot conversation).
      const isFromThisBot =
        msg.user === this.botUserId ||
        (msg as BotMessageEvent).bot_id === this.ownBotId;
      const isAnyBot = !!(msg as BotMessageEvent).bot_id;

      // Skip messages that @mention a bot we should ignore
      const rawText = msg.text || '';
      if (
        !isFromThisBot &&
        this.ignoreMentions.some((uid) => rawText.includes(`<@${uid}>`))
      ) {
        return;
      }

      // If requireMention is set, only process messages that @mention this bot.
      // Accept both Slack-encoded <@UBOTID> and plain text @triggerName
      // (the latter enables bot-to-bot mentions without Slack encoding).
      if (
        this.requireMention &&
        !isFromThisBot &&
        this.botUserId &&
        !rawText.includes(`<@${this.botUserId}>`) &&
        !rawText.includes(`@${this.triggerName}`)
      ) {
        return;
      }

      let senderName: string;
      if (isFromThisBot) {
        senderName = this.triggerName;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into trigger format.
      // Slack encodes @mentions as <@U12345>, which won't match trigger patterns,
      // so we prepend the trigger name when this bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isFromThisBot) {
        const mentionPattern = `<@${this.botUserId}>`;
        const triggerPrefix = `@${this.triggerName}`;
        if (
          content.includes(mentionPattern) &&
          !content.startsWith(triggerPrefix)
        ) {
          content = `${triggerPrefix} ${content}`;
        }
      }

      // Download file attachments (images + audio) and append tags
      // Use eventFiles from the raw event — TypeScript union types may
      // strip the files field depending on which branch is narrowed.
      if (eventFiles && eventFiles.length > 0) {
        logger.info(
          {
            files: (eventFiles as Array<Record<string, unknown>>).map((f) => ({
              id: f.id,
              mimetype: f.mimetype,
              filetype: f.filetype,
              name: f.name,
              hasUrl: !!f.url_private,
            })),
          },
          'Processing file attachments',
        );
        try {
          const tags = await this.downloadAttachments(
            eventFiles as Array<{
              id: string;
              mimetype: string;
              name: string | null;
              url_private?: string;
              url_private_download?: string;
            }>,
            msg.channel,
          );
          if (tags.length > 0) {
            content = content
              ? `${content}\n${tags.join('\n')}`
              : tags.join('\n');
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to process file attachments');
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || (msg as BotMessageEvent).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromThisBot,
        is_bot_message: isAnyBot,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID and bot ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.ownBotId = auth.bot_id as string | undefined;
      botMentionMap.set(this.triggerName, this.botUserId);
      logger.info(
        { botUserId: this.botUserId, botId: this.ownBotId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(new RegExp(`^${this.jidPrefix}:`), '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    // Translate @mentions (e.g. "@매트") to Slack <@UID> format
    const mentionTranslated = this.translateOutboundMentions(text);

    // Extract files (images + general) from agent output
    const { cleanText, filePaths } = this.extractFilePaths(mentionTranslated);
    const messageText = cleanText || (filePaths.length > 0 ? undefined : text);

    try {
      // Send text message
      if (messageText && messageText.length > 0) {
        if (messageText.length <= MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: messageText,
          });
        } else {
          for (let i = 0; i < messageText.length; i += MAX_MESSAGE_LENGTH) {
            await this.app.client.chat.postMessage({
              channel: channelId,
              text: messageText.slice(i, i + MAX_MESSAGE_LENGTH),
            });
          }
        }
      }

      // Upload files (images + general attachments)
      for (const filePath of filePaths) {
        try {
          await this.app.client.filesUploadV2({
            channel_id: channelId,
            file: fs.createReadStream(filePath),
            filename: path.basename(filePath),
          });
          logger.info({ jid, path: filePath }, 'Slack file uploaded');
        } catch (err) {
          logger.warn({ jid, path: filePath, err }, 'Failed to upload file');
        }
      }

      logger.info(
        {
          jid,
          textLength: messageText?.length ?? 0,
          files: filePaths.length,
        },
        'Slack message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`${this.jidPrefix}:`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Translate plain-text @mentions to Slack <@UID> format in outbound messages.
   * Checks bot names (shared botMentionMap) and known user names (userNameCache).
   */
  private translateOutboundMentions(text: string): string {
    if (!text.includes('@')) return text;
    let result = text;

    // Bot mentions (e.g. @매트 → <@U...>)
    for (const [name, uid] of botMentionMap) {
      if (result.includes(`@${name}`)) {
        result = result.replaceAll(`@${name}`, `<@${uid}>`);
      }
    }

    // User mentions — reverse lookup from userNameCache
    for (const [uid, name] of this.userNameCache) {
      if (result.includes(`@${name}`)) {
        result = result.replaceAll(`@${name}`, `<@${uid}>`);
      }
    }

    return result;
  }

  /**
   * Download a single file from Slack to local disk.
   * Returns the local file path, or null on failure.
   */
  private async downloadSlackFile(file: {
    id: string;
    mimetype: string;
    name: string | null;
    url_private?: string;
    url_private_download?: string;
  }): Promise<string | null> {
    const ext = file.name
      ? path.extname(file.name)
      : `.${file.mimetype.split('/')[1] || 'bin'}`;
    const filename = `${Date.now()}-${file.id}${ext}`;
    const filePath = path.join(ATTACHMENTS_DIR, filename);

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      logger.warn({ fileId: file.id }, 'No download URL in file event');
      return null;
    }

    const env = readEnvFile([this.botTokenKey]);
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${env[this.botTokenKey]}` },
      redirect: 'follow',
    });
    if (!res.ok) {
      logger.warn(
        { fileId: file.id, status: res.status },
        'Failed to download Slack file',
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Verify it's not an HTML redirect page
    if (
      buffer.length > 15 &&
      buffer.subarray(0, 15).toString().startsWith('<!DOCTYPE')
    ) {
      logger.warn(
        { fileId: file.id },
        'Downloaded file is HTML, not binary — auth may have failed',
      );
      return null;
    }

    fs.writeFileSync(filePath, buffer);
    logger.info(
      { fileId: file.id, path: filePath, size: buffer.length },
      'Downloaded Slack file attachment',
    );
    return filePath;
  }

  /**
   * Download file attachments (images + audio) from Slack.
   * Images → [Image: /path] tags
   * Audio → transcribe with whisper → [Transcript: /path] tags
   */
  private async downloadAttachments(
    files: Array<{
      id: string;
      mimetype: string;
      name: string | null;
      url_private?: string;
      url_private_download?: string;
    }>,
    channelId: string,
  ): Promise<string[]> {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const tags: string[] = [];

    for (const file of files) {
      // Slack sometimes sends empty mimetype — infer from file extension
      const mime = file.mimetype || this.inferMimeFromName(file.name);
      const isImage = IMAGE_MIMETYPES.has(mime);
      const isAudio = isAudioMimetype(mime);

      try {
        const filePath = await this.downloadSlackFile(file);
        if (!filePath) continue;

        if (isImage) {
          tags.push(`[Image: ${filePath}]`);
        } else if (isAudio) {
          // Transcribe audio with progress updates in Slack
          const transcriptPath = await this.transcribeWithProgress(
            filePath,
            channelId,
            file.name || 'audio',
          );
          if (transcriptPath) {
            tags.push(`[Transcript: ${transcriptPath}]`);
          } else {
            tags.push(`[Audio: ${filePath} (transcription unavailable)]`);
          }
        } else {
          // General file (PDF, documents, etc.)
          tags.push(`[File: ${filePath}]`);
        }
      } catch (err) {
        logger.warn({ fileId: file.id, err }, 'Error processing Slack file');
      }
    }

    return tags;
  }

  /**
   * Transcribe audio file with Slack progress updates.
   * Posts a status message and updates it as transcription progresses.
   */
  private async transcribeWithProgress(
    audioPath: string,
    channelId: string,
    fileName: string,
  ): Promise<string | null> {
    if (!isWhisperAvailable()) {
      logger.warn('Whisper not available, skipping transcription');
      return null;
    }

    // Post initial progress message
    let progressTs: string | undefined;
    try {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: `${fileName} 전사 중...`,
      });
      progressTs = result.ts as string;
    } catch {
      // Non-critical: progress updates are nice-to-have
    }

    let lastUpdateTime = 0;
    const updateInterval = 30_000; // Update Slack message every 30s

    const transcriptPath = await transcribeAudio(audioPath, (progress) => {
      const now = Date.now();
      if (!progressTs || now - lastUpdateTime < updateInterval) return;
      lastUpdateTime = now;

      const timeInfo = progress.currentTime ? ` [${progress.currentTime}]` : '';
      this.app.client.chat
        .update({
          channel: channelId,
          ts: progressTs!,
          text: `${fileName} 전사 중...${timeInfo}`,
        })
        .catch(() => {});
    });

    // Update progress message and send completion notification
    if (progressTs) {
      const finalText = transcriptPath
        ? `${fileName} 전사 완료`
        : `${fileName} 전사 실패`;
      this.app.client.chat
        .update({
          channel: channelId,
          ts: progressTs,
          text: finalText,
        })
        .catch(() => {});
    }
    if (transcriptPath) {
      this.app.client.chat
        .postMessage({
          channel: channelId,
          text: `${fileName} 전사가 완료되었습니다. 회의록을 작성합니다.`,
        })
        .catch(() => {});
    }

    return transcriptPath;
  }

  /**
   * Infer MIME type from file name extension.
   * Fallback when Slack sends empty mimetype.
   */
  private inferMimeFromName(name: string | null): string {
    if (!name) return '';
    const ext = path.extname(name).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.webm': 'audio/webm',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.opus': 'audio/opus',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
    };
    return mimeMap[ext] || '';
  }

  /**
   * Extract image paths from agent output text.
   * Parses [Image: /path] tags and markdown image links.
   */
  private extractFilePaths(text: string): {
    cleanText: string;
    filePaths: string[];
  } {
    const filePaths: string[] = [];

    // Extract [Image: /path] tags
    let cleaned = text.replace(IMAGE_TAG_RE, (_, imgPath: string) => {
      const p = imgPath.trim();
      if (fs.existsSync(p)) filePaths.push(p);
      return '';
    });

    // Extract [File: /path] tags
    cleaned = cleaned.replace(FILE_TAG_RE, (_, filePath: string) => {
      const p = filePath.trim();
      if (fs.existsSync(p)) filePaths.push(p);
      return '';
    });

    // Extract markdown image links pointing to local files
    cleaned = cleaned.replace(MD_IMAGE_LINK_RE, (match, linkPath: string) => {
      const p = linkPath.trim();
      if (IMAGE_EXTS.test(p) && fs.existsSync(p)) {
        filePaths.push(p);
        return '';
      }
      return match;
    });

    return { cleanText: cleaned.trim(), filePaths };
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`${this.jidPrefix}:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(
          new RegExp(`^${this.jidPrefix}:`),
          '',
        );
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
