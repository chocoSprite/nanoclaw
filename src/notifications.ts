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
 * `Container exited with code N: ...`) against patterns that indicate an
 * authentication failure the user must resolve manually.
 *
 * Two complementary matchers (OR):
 *   1. Numeric:  word-boundary 401/403 AND an auth keyword. Catches HTTP-
 *      style errors (Anthropic Claude SDK 401, classical 401 unauthorized).
 *   2. Natural:  refresh-token / sign-in / invalid_grant phrasings. Catches
 *      the codex CLI 's natural-language wording where the numeric code is
 *      absent — observed 2026-04-28: "Your access token could not be
 *      refreshed because your refresh token was already used. Please log
 *      out and sign in again." That message is functionally a 401 but
 *      contains no 4xx digits, so the numeric path missed it and an
 *      unbounded retry loop ensued.
 *
 * False-positive guards in the numeric path: "processed 401 lines",
 * "port 4013", etc. fail because they lack the auth keyword (AND).
 */
export function isAuthExpired(errorText: string): boolean {
  const numericMatch =
    /\b40[13]\b/.test(errorText) &&
    /authentication_error|invalid authentication|unauthorized|oauth|failed to authenticate/i.test(
      errorText,
    );
  if (numericMatch) return true;

  // Natural-language matchers — each is specific enough on its own that
  // false positives are unlikely in agent stderr / error messages.
  return (
    /refresh[_ ]?token (?:was|is)?\s*(?:already used|expired|revoked|invalid)/i.test(
      errorText,
    ) ||
    /\binvalid[_ ]grant\b/i.test(errorText) ||
    /please (?:log out and )?sign in again/i.test(errorText) ||
    /please (?:re-?)?run\s+`?(?:claude setup-token|codex login)`?/i.test(
      errorText,
    )
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
