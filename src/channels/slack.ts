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

// Regex to extract [Image: /path] tags from outbound agent text
const IMAGE_TAG_RE = /\[Image:\s*(\/[^\]]+)\]/g;
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
// Markdown image links: [name.png](/path/name.png)
const MD_IMAGE_LINK_RE = /\[[^\]]*\]\((\/[^)]+)\)/g;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages, bot messages, and file shares.
type HandledMessageEvent =
  | GenericMessageEvent
  | BotMessageEvent
  | FileShareMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
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
          { subtype, fileCount: eventFiles.length, hasText: !!(event as { text?: string }).text },
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

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage =
        !!(msg as BotMessageEvent).bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Download image attachments and append [Image: /path] tags
      // Use eventFiles from the raw event — TypeScript union types may
      // strip the files field depending on which branch is narrowed.
      if (eventFiles && eventFiles.length > 0) {
        logger.info(
          {
            files: (eventFiles as Array<{ id?: string; mimetype?: string; url_private?: string }>).map(
              (f) => ({ id: f.id, mimetype: f.mimetype, hasUrl: !!f.url_private }),
            ),
          },
          'Processing file attachments',
        );
        try {
          const imageTags = await this.downloadImageAttachments(
            eventFiles as Array<{
              id: string;
              mimetype: string;
              name: string | null;
              url_private?: string;
              url_private_download?: string;
            }>,
          );
          if (imageTags.length > 0) {
            content = content
              ? `${content}\n${imageTags.join('\n')}`
              : imageTags.join('\n');
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to process image attachments');
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || (msg as BotMessageEvent).bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
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
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    // Extract images from agent output
    const { cleanText, imagePaths } = this.extractImagePaths(text);
    const messageText = cleanText || (imagePaths.length > 0 ? undefined : text);

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

      // Upload image files
      for (const imgPath of imagePaths) {
        try {
          await this.app.client.filesUploadV2({
            channel_id: channelId,
            file: fs.createReadStream(imgPath),
            filename: path.basename(imgPath),
          });
          logger.info({ jid, path: imgPath }, 'Slack image uploaded');
        } catch (err) {
          logger.warn({ jid, path: imgPath, err }, 'Failed to upload image');
        }
      }

      logger.info(
        { jid, textLength: messageText?.length ?? 0, images: imagePaths.length },
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
    return jid.startsWith('slack:');
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
   * Download image files from Slack attachments to local disk.
   * Returns [Image: /path] tags for each successfully downloaded image.
   */
  private async downloadImageAttachments(
    files: Array<{
      id: string;
      mimetype: string;
      name: string | null;
      url_private?: string;
      url_private_download?: string;
    }>,
  ): Promise<string[]> {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const tags: string[] = [];

    for (const file of files) {
      if (!IMAGE_MIMETYPES.has(file.mimetype)) continue;

      try {
        const ext = file.name
          ? path.extname(file.name)
          : `.${file.mimetype.split('/')[1] || 'png'}`;
        const filename = `${Date.now()}-${file.id}${ext}`;
        const filePath = path.join(ATTACHMENTS_DIR, filename);

        // Use url_private from the event payload (no extra API call needed)
        const downloadUrl = file.url_private_download || file.url_private;
        if (!downloadUrl) {
          logger.warn({ fileId: file.id }, 'No download URL in file event');
          continue;
        }

        const env = readEnvFile(['SLACK_BOT_TOKEN']);
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
          redirect: 'follow',
        });
        if (!res.ok) {
          logger.warn(
            { fileId: file.id, status: res.status },
            'Failed to download Slack file',
          );
          continue;
        }

        const buffer = Buffer.from(await res.arrayBuffer());

        // Verify it's actually an image (not an HTML redirect page)
        if (
          buffer.length > 15 &&
          buffer.subarray(0, 15).toString().startsWith('<!DOCTYPE')
        ) {
          logger.warn(
            { fileId: file.id },
            'Downloaded file is HTML, not an image — auth may have failed',
          );
          continue;
        }

        fs.writeFileSync(filePath, buffer);
        tags.push(`[Image: ${filePath}]`);
        logger.info(
          { fileId: file.id, path: filePath, size: buffer.length },
          'Downloaded Slack image attachment',
        );
      } catch (err) {
        logger.warn({ fileId: file.id, err }, 'Error downloading Slack file');
      }
    }

    return tags;
  }

  /**
   * Extract image paths from agent output text.
   * Parses [Image: /path] tags and markdown image links.
   */
  private extractImagePaths(text: string): {
    cleanText: string;
    imagePaths: string[];
  } {
    const imagePaths: string[] = [];

    // Extract [Image: /path] tags
    let cleaned = text.replace(IMAGE_TAG_RE, (_, imgPath: string) => {
      const p = imgPath.trim();
      if (fs.existsSync(p)) imagePaths.push(p);
      return '';
    });

    // Extract markdown image links pointing to local files
    cleaned = cleaned.replace(MD_IMAGE_LINK_RE, (match, linkPath: string) => {
      const p = linkPath.trim();
      if (IMAGE_EXTS.test(p) && fs.existsSync(p)) {
        imagePaths.push(p);
        return '';
      }
      return match;
    });

    return { cleanText: cleaned.trim(), imagePaths };
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
            updateChatName(`slack:${ch.id}`, ch.name);
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
        const channelId = item.jid.replace(/^slack:/, '');
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
