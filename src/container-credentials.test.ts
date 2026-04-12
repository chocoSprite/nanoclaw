import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  ONECLI_URL: 'http://localhost:10254',
}));

// Hoisted mocks — vi.mock factories run before top-level consts,
// so shared handles must come from vi.hoisted().
const { warnMock, infoMock, applyMock, execSyncMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  infoMock: vi.fn(),
  applyMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
  },
}));

// Mock container-mounts: normalizeOneCLIMounts is a no-op stub in tests
vi.mock('./container-mounts.js', () => ({
  normalizeOneCLIMounts: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = applyMock;
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
    applyMock.mockReset();
    execSyncMock.mockReset();
    warnMock.mockReset();
    infoMock.mockReset();
  });

  it('logs warn and leaves args unchanged when OneCLI is unreachable', async () => {
    applyMock.mockResolvedValue(false);
    const args = ['run', '-i', '--rm'];

    await applyCredentialArgs(args, 'test-container', undefined, 'codex');

    expect(args).toEqual(['run', '-i', '--rm']);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'test-container' }),
      expect.stringContaining('not reachable'),
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('strips ANTHROPIC_API_KEY placeholder when OneCLI applies it', async () => {
    applyMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
      args.push('-e', 'SOMETHING_ELSE=keep');
      return true;
    });
    const args: string[] = [];

    await applyCredentialArgs(args, 'test-container', undefined, 'codex');

    expect(args).not.toContain('ANTHROPIC_API_KEY=placeholder');
    expect(args).toContain('SOMETHING_ELSE=keep');
  });

  it('replaces Claude OAuth placeholder with keychain token when sdk=claude', async () => {
    applyMock.mockImplementation(async (args: string[]) => {
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
      return true;
    });
    execSyncMock.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'real-token-abc' } }),
    );
    const args: string[] = [];

    await applyCredentialArgs(args, 'test-container', undefined, 'claude');

    // Placeholder stripped
    expect(args).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    // Real token injected
    expect(args).toContain('CLAUDE_CODE_OAUTH_TOKEN=real-token-abc');
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it('logs warn and skips injection when keychain read fails for sdk=claude', async () => {
    applyMock.mockResolvedValue(true);
    execSyncMock.mockImplementation(() => {
      throw new Error('keychain denied');
    });
    const args: string[] = [];

    await applyCredentialArgs(args, 'test-container', undefined, 'claude');

    expect(args).not.toContain(
      expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN='),
    );
    expect(
      warnMock.mock.calls.some((c) =>
        String(c[1] ?? '').includes('Failed to read Claude OAuth token'),
      ),
    ).toBe(true);
  });

  it('does not call keychain for sdk=codex', async () => {
    applyMock.mockResolvedValue(true);
    const args: string[] = [];

    await applyCredentialArgs(args, 'test-container', undefined, 'codex');

    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
