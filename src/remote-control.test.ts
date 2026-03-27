import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config before importing the module under test
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-rc-test',
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import {
  startRemoteControl,
  stopRemoteControl,
  getActiveSession,
  _resetForTesting,
} from './remote-control.js';

describe('remote-control', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('startRemoteControl (Codex runtime)', () => {
    it('returns not-available error since Codex has no remote-control', async () => {
      const result = await startRemoteControl('user1', 'tg:123', '/project');
      expect(result).toEqual({
        ok: false,
        error: 'Remote control is not available with the Codex runtime',
      });
    });
  });

  describe('stopRemoteControl', () => {
    it('returns error when no session is active', () => {
      const result = stopRemoteControl();
      expect(result).toEqual({
        ok: false,
        error: 'No active Remote Control session',
      });
    });
  });

  describe('getActiveSession', () => {
    it('returns null when no session exists', () => {
      expect(getActiveSession()).toBeNull();
    });
  });
});
