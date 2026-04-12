import { ChannelType, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { parseTextStyles } from './text-styles.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    let inner = escapeXml(m.content);

    if (m.reply_to_content) {
      const quotedSender = m.reply_to_sender_name
        ? ` sender="${escapeXml(m.reply_to_sender_name)}"`
        : '';
      inner = `<quoted_message${quotedSender}>${escapeXml(m.reply_to_content)}</quoted_message>\n${inner}`;
    }

    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${inner}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string, channel?: ChannelType): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return channel ? parseTextStyles(text, channel) : text;
}
