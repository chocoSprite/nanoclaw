import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  },
}));

import {
  _resetNotifiedKeysForTest,
  isAuthExpired,
  notifyAuthExpired,
} from './notifications.js';
import type { Channel, RegisteredGroup } from './types.js';

const MAIN_JID = 'slack:C0AQFDF3EBS';

function makeGroup(folder: string, name = folder): RegisteredGroup {
  return {
    name,
    jid: `slack-mat:somechannel`,
    folder,
    sdk: 'claude',
    isMain: false,
  } as RegisteredGroup;
}

function makeChannel(ownsMain: boolean): {
  channel: Channel;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const sendSpy = vi.fn().mockResolvedValue(undefined);
  const channel: Channel = {
    name: 'slack',
    connect: vi.fn(),
    sendMessage: sendSpy,
    isConnected: () => true,
    ownsJid: (jid: string) => ownsMain && jid === MAIN_JID,
    disconnect: vi.fn(),
  };
  return { channel, sendSpy };
}

describe('isAuthExpired', () => {
  it('matches Claude SDK 401 stderr', () => {
    const stderr =
      'Container exited with code 1: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}';
    expect(isAuthExpired(stderr)).toBe(true);
  });

  it('matches a generic 401 unauthorized line', () => {
    expect(isAuthExpired('HTTP 401 Unauthorized')).toBe(true);
  });

  it('matches Codex-style oauth failure (spec)', () => {
    expect(
      isAuthExpired(
        'codex: 401 oauth refresh failed, please run `codex login`',
      ),
    ).toBe(true);
  });

  it('matches codex natural-language refresh-token rejection (2026-04-28)', () => {
    // Real stderr captured from meeting_notes_pat infinite-retry incident.
    // Note: no 4xx digit anywhere in the message — pure natural language.
    const stderr =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    expect(isAuthExpired(stderr)).toBe(true);
  });

  it('matches "invalid_grant" OAuth error code', () => {
    expect(isAuthExpired('error=invalid_grant; refresh failed')).toBe(true);
  });

  it('matches "please run `codex login`" hint phrasing', () => {
    expect(
      isAuthExpired('auth setup expired — please run `codex login` to reauth'),
    ).toBe(true);
  });

  it('matches "please run `claude setup-token`" hint phrasing', () => {
    expect(
      isAuthExpired('credential expired — please re-run claude setup-token'),
    ).toBe(true);
  });

  it('returns false for 429 rate-limit', () => {
    expect(isAuthExpired('HTTP 429 Too Many Requests')).toBe(false);
  });

  it('returns false for 5xx server error', () => {
    expect(isAuthExpired('HTTP 500 Internal Server Error')).toBe(false);
  });

  it('returns false when 401 appears in unrelated context (false positive guard)', () => {
    // Number 401 appears but no auth keyword AND-condition
    expect(isAuthExpired('processed 401 lines successfully')).toBe(false);
  });

  it('returns false when number contains 401 but is not word-bounded', () => {
    // 4013 should not match \b40[13]\b
    expect(isAuthExpired('listening on port 4013, oauth ready')).toBe(false);
  });
});

describe('notifyAuthExpired', () => {
  beforeEach(() => {
    _resetNotifiedKeysForTest();
    warnMock.mockReset();
  });

  afterEach(() => {
    _resetNotifiedKeysForTest();
  });

  it('sends a notification on first call for a (group, sdk) key', async () => {
    const { channel, sendSpy } = makeChannel(true);
    const group = makeGroup(
      'slack_agent_meeting_notes_mat',
      'meeting_notes_mat',
    );

    await notifyAuthExpired({ group, sdk: 'claude', channels: [channel] });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toBe(MAIN_JID);
    const text = sendSpy.mock.calls[0][1] as string;
    expect(text).toContain('meeting_notes_mat');
    expect(text).toContain('claude');
    expect(text).toContain('인증 만료');
    expect(text).toContain('claude -p');
  });

  it('suppresses second call for same (group, sdk) key until reset', async () => {
    const { channel, sendSpy } = makeChannel(true);
    const group = makeGroup('slack_agent_meeting_notes_mat');

    await notifyAuthExpired({ group, sdk: 'claude', channels: [channel] });
    await notifyAuthExpired({ group, sdk: 'claude', channels: [channel] });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('sends separately for different sdk on the same group', async () => {
    const { channel, sendSpy } = makeChannel(true);
    const group = makeGroup('slack_agent_labs_pat');

    await notifyAuthExpired({ group, sdk: 'claude', channels: [channel] });
    await notifyAuthExpired({ group, sdk: 'codex', channels: [channel] });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[1][1]).toContain('codex login');
  });

  it('logs warn and does not throw when no channel owns slack_main jid', async () => {
    const { channel, sendSpy } = makeChannel(false);
    const group = makeGroup('slack_agent_meeting_notes_mat');

    await expect(
      notifyAuthExpired({ group, sdk: 'claude', channels: [channel] }),
    ).resolves.toBeUndefined();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(
      warnMock.mock.calls.some((c) =>
        String(c[1] ?? '').includes('no channel owns slack_main jid'),
      ),
    ).toBe(true);
  });

  it('swallows sendMessage errors and logs warn', async () => {
    const sendSpy = vi.fn().mockRejectedValue(new Error('slack down'));
    const channel: Channel = {
      name: 'slack',
      connect: vi.fn(),
      sendMessage: sendSpy,
      isConnected: () => true,
      ownsJid: (jid: string) => jid === MAIN_JID,
      disconnect: vi.fn(),
    };
    const group = makeGroup('slack_agent_meeting_notes_mat');

    await expect(
      notifyAuthExpired({ group, sdk: 'claude', channels: [channel] }),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      warnMock.mock.calls.some((c) =>
        String(c[1] ?? '').includes('Failed to send auth-expired notification'),
      ),
    ).toBe(true);
  });
});
