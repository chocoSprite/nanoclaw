import { describe, it, expect, beforeEach, vi } from 'vitest';

const { warnMock, execSyncMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  },
}));

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

import { applyCredentialArgs } from './container-credentials.js';

describe('applyCredentialArgs', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    warnMock.mockReset();
  });

  it('is a no-op for sdk=codex', async () => {
    const args: string[] = [];
    await applyCredentialArgs(args, 'test-container', 'codex');
    expect(args).toEqual([]);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('appends CLAUDE_CODE_OAUTH_TOKEN from keychain for sdk=claude', async () => {
    execSyncMock.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'real-token-abc' } }),
    );
    const args: string[] = [];
    await applyCredentialArgs(args, 'test-container', 'claude');
    expect(args).toEqual(['-e', 'CLAUDE_CODE_OAUTH_TOKEN=real-token-abc']);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('logs warn and leaves args unchanged when keychain read fails', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('keychain denied');
    });
    const args: string[] = [];
    await applyCredentialArgs(args, 'test-container', 'claude');
    expect(args).toEqual([]);
    expect(
      warnMock.mock.calls.some((c) =>
        String(c[1] ?? '').includes('Failed to read Claude OAuth token'),
      ),
    ).toBe(true);
  });
});
