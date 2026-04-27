/**
 * Auth-expiry detection + slack_main notification.
 *
 * When a container exits with a 401-ish error, the message cursor is rolled
 * back (handled by the caller) but retry is skipped — instead a single
 * notification is sent to slack_main so the user can refresh tokens
 * (`claude -p "hi"` for Claude, `codex login` for Codex) and `launchctl
 * kickstart` nanoclaw. Once the next inbound message arrives, the rolled-back
 * cursor causes pending messages to be re-processed automatically.
 *
 * Per-(group, sdk) suppression set is in-memory only — nanoclaw restart
 * resets it so a fresh kickstart yields a fresh notification on next failure.
 */
import { logger } from './logger.js';
import { findChannel } from './router.js';
import type { Channel, RegisteredGroup } from './types.js';

// 1인 fork 환경 — slack_main 채널 ID 직접 사용. 다른 환경 옮길 때 손봄.
const MAIN_JID = 'slack:C0AQFDF3EBS';

const notifiedKeys = new Set<string>();

/**
 * Match container error text (typically the tail of stderr surfaced as
 * `Container exited with code N: ...`) against patterns that indicate a
 * 401/403 authentication failure that the user must resolve manually.
 *
 * Word-boundary `\b40[13]\b` AND an auth-related keyword to avoid false
 * positives like "401 lines processed" or "port 4013".
 */
export function isAuthExpired(errorText: string): boolean {
  if (!/\b40[13]\b/.test(errorText)) return false;
  return /authentication_error|invalid authentication|unauthorized|oauth/i.test(
    errorText,
  );
}

export interface NotifyAuthExpiredOpts {
  group: RegisteredGroup;
  sdk: 'claude' | 'codex';
  channels: Channel[];
}

export async function notifyAuthExpired(
  opts: NotifyAuthExpiredOpts,
): Promise<void> {
  const key = `${opts.group.folder}:${opts.sdk}`;
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);

  const channel = findChannel(opts.channels, MAIN_JID);
  if (!channel) {
    logger.warn(
      { group: opts.group.name, sdk: opts.sdk, mainJid: MAIN_JID },
      'Auth expired but no channel owns slack_main jid, notification skipped',
    );
    return;
  }

  const recovery =
    opts.sdk === 'claude'
      ? '호스트에서 `claude -p "hi"` 실행 → `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`'
      : '호스트에서 `codex login` 재실행 → `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`';

  const text =
    `🔴 [${opts.group.name} / ${opts.sdk}] 인증 만료\n` +
    `복구: ${recovery}\n` +
    `복구 후 cursor 보존된 메시지 자동 재처리됨.`;

  try {
    await channel.sendMessage(MAIN_JID, text);
  } catch (err) {
    logger.warn(
      { err, group: opts.group.name, sdk: opts.sdk },
      'Failed to send auth-expired notification to slack_main',
    );
  }
}

// Test-only — production callers should never reset.
export function _resetNotifiedKeysForTest(): void {
  notifiedKeys.clear();
}
