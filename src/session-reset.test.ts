import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AUTO_RESET_MARKER,
  autoResetPairedLanes,
  cleanSdkSessionFiles,
  findGroupByInput,
  findPairedLanes,
  resetGroupSession,
  stripAutoResetMarker,
  tryHandleSessionResetCommand,
} from './session-reset.js';
import type { SessionHandlerDeps, SessionResetDeps } from './session-reset.js';
import type { NewMessage, RegisteredGroup } from './types.js';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-reset-test-'));
}

describe('cleanSdkSessionFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('codex', () => {
    it('deletes sessions/ dir and state_5.sqlite* files', () => {
      // Setup: sessions dir with content
      fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'sessions', 'abc.json'), '{}');
      // Setup: state_5.sqlite + WAL/SHM
      fs.writeFileSync(path.join(tmpDir, 'state_5.sqlite'), 'data');
      fs.writeFileSync(path.join(tmpDir, 'state_5.sqlite-wal'), 'wal');
      fs.writeFileSync(path.join(tmpDir, 'state_5.sqlite-shm'), 'shm');
      // Setup: other files that should be preserved
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');

      const errors = cleanSdkSessionFiles(tmpDir, 'codex');

      expect(errors).toEqual([]);
      expect(fs.existsSync(path.join(tmpDir, 'sessions'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'state_5.sqlite'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'state_5.sqlite-wal'))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(tmpDir, 'state_5.sqlite-shm'))).toBe(
        false,
      );
      // Preserved
      expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
    });

    it('returns empty errors when sdkBase does not exist', () => {
      const errors = cleanSdkSessionFiles('/nonexistent/path', 'codex');
      expect(errors).toEqual([]);
    });
  });

  describe('claude', () => {
    it('deletes sessions/, backups/, .jsonl, subagents/ but preserves memory/', () => {
      // Setup: sessions and backups dirs
      fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'sessions', 'sess.json'), '{}');
      fs.mkdirSync(path.join(tmpDir, 'backups'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'backups', 'backup.json'), '{}');

      // Setup: projects tree with .jsonl, subagents, and memory
      const projectDir = path.join(tmpDir, 'projects', 'proj1');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'conversation.jsonl'), 'data');
      fs.writeFileSync(path.join(projectDir, 'other.txt'), 'keep');

      // subagents dir
      const subagentsDir = path.join(projectDir, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'agent.json'), '{}');

      // memory dir (MUST be preserved)
      const memoryDir = path.join(projectDir, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory');
      fs.writeFileSync(path.join(memoryDir, 'user_role.md'), 'role');

      const errors = cleanSdkSessionFiles(tmpDir, 'claude');

      expect(errors).toEqual([]);
      // Deleted
      expect(fs.existsSync(path.join(tmpDir, 'sessions'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'backups'))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, 'conversation.jsonl'))).toBe(
        false,
      );
      expect(fs.existsSync(subagentsDir)).toBe(false);
      // Preserved
      expect(fs.existsSync(memoryDir)).toBe(true);
      expect(fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(
        '# Memory',
      );
      expect(
        fs.readFileSync(path.join(memoryDir, 'user_role.md'), 'utf8'),
      ).toBe('role');
      expect(fs.existsSync(path.join(projectDir, 'other.txt'))).toBe(true);
    });

    it('returns empty errors when sdkBase does not exist', () => {
      const errors = cleanSdkSessionFiles('/nonexistent/path', 'claude');
      expect(errors).toEqual([]);
    });

    it('preserves memory/ in nested project directories', () => {
      // Setup: nested projects with memory at different levels
      const proj = path.join(tmpDir, 'projects', 'a', 'b');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'data.jsonl'), 'x');

      const mem = path.join(proj, 'memory');
      fs.mkdirSync(mem, { recursive: true });
      fs.writeFileSync(path.join(mem, 'note.md'), 'note');

      const errors = cleanSdkSessionFiles(tmpDir, 'claude');

      expect(errors).toEqual([]);
      expect(fs.existsSync(path.join(proj, 'data.jsonl'))).toBe(false);
      expect(fs.existsSync(mem)).toBe(true);
      expect(fs.readFileSync(path.join(mem, 'note.md'), 'utf8')).toBe('note');
    });
  });
});

describe('resetGroupSession', () => {
  it('calls all 4 reset steps in order and returns result', async () => {
    const callOrder: string[] = [];
    const sessions: Record<string, string> = { 'test-folder': 'session-123' };

    const deps: SessionResetDeps = {
      dataDir: '/tmp/nonexistent-data',
      sessions,
      terminateGroup: vi.fn(async () => {
        callOrder.push('terminate');
      }),
      deleteSession: vi.fn(() => {
        callOrder.push('deleteSession');
      }),
    };

    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-folder',
      trigger: '@test',
      added_at: '2026-01-01',
      sdk: 'codex',
    };

    const result = await resetGroupSession('jid123', group, deps);

    expect(callOrder).toEqual(['terminate', 'deleteSession']);
    expect(deps.terminateGroup).toHaveBeenCalledWith('jid123');
    expect(deps.deleteSession).toHaveBeenCalledWith('test-folder');
    expect(sessions['test-folder']).toBeUndefined();
    expect(result).toEqual({
      groupName: 'Test Group',
      folder: 'test-folder',
      sdkType: 'codex',
      errors: [],
    });
  });

  it('uses sdk from group config', async () => {
    const deps: SessionResetDeps = {
      dataDir: '/tmp/nonexistent-data',
      sessions: {},
      terminateGroup: vi.fn(async () => {}),
      deleteSession: vi.fn(),
    };

    const group: RegisteredGroup = {
      name: 'Codex SDK',
      folder: 'codex-sdk',
      trigger: '@bot',
      added_at: '2026-01-01',
      sdk: 'codex',
    };

    const result = await resetGroupSession('jid', group, deps);

    expect(result.sdkType).toBe('codex');
  });
});

// --- findGroupByInput ---

describe('findGroupByInput', () => {
  const groups: Record<string, RegisteredGroup> = {
    'slack:C001': {
      name: '패트',
      folder: 'slack_pat_main',
      trigger: '@패트',
      added_at: '2026-01-01',
      isMain: true,
      sdk: 'codex',
    },
    'slack:C002': {
      name: '매트',
      folder: 'slack_mat_news',
      trigger: '@매트',
      added_at: '2026-01-01',
      sdk: 'codex',
    },
  };

  it('matches by full folder name', () => {
    const result = findGroupByInput('slack_pat_main', groups);
    expect(result).toEqual(['slack:C001', groups['slack:C001']]);
  });

  it('matches by unprefixed folder name (case-insensitive)', () => {
    const result = findGroupByInput('PAT_MAIN', groups);
    expect(result).toEqual(['slack:C001', groups['slack:C001']]);
  });

  it('matches by display name', () => {
    const result = findGroupByInput('매트', groups);
    expect(result).toEqual(['slack:C002', groups['slack:C002']]);
  });

  it('matches hyphenated input to underscored folder', () => {
    const result = findGroupByInput('mat-news', groups);
    expect(result).toEqual(['slack:C002', groups['slack:C002']]);
  });

  it('returns null for non-existent group', () => {
    const result = findGroupByInput('nonexistent', groups);
    expect(result).toBeNull();
  });
});

describe('tryHandleSessionResetCommand', () => {
  function makeMsg(content: string): NewMessage {
    return {
      id: 'm1',
      chat_jid: 'main-jid',
      sender: 'alice',
      sender_name: 'Alice',
      content,
      timestamp: '2026-04-12T00:00:00Z',
    };
  }

  function makeDeps(tmpDir: string): SessionHandlerDeps {
    return {
      dataDir: tmpDir,
      sessions: {},
      terminateGroup: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn(),
      registeredGroups: {
        'main-jid': {
          name: '패트',
          folder: 'slack_pat_main',
          trigger: '@패트',
          added_at: '2026-01-01',
          isMain: true,
          sdk: 'codex',
        },
        'target-jid': {
          name: '매트',
          folder: 'slack_mat_news',
          trigger: '@매트',
          added_at: '2026-01-01',
          sdk: 'codex',
        },
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  }

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when content does not start with 세션초기화', () => {
    expect(
      tryHandleSessionResetCommand(
        'main-jid',
        makeMsg('hello'),
        makeDeps(tmpDir),
      ),
    ).toBe(false);
  });

  it('returns false on non-main group', () => {
    expect(
      tryHandleSessionResetCommand(
        'target-jid',
        makeMsg('세션초기화 slack_mat_news'),
        makeDeps(tmpDir),
      ),
    ).toBe(false);
  });

  it('returns false for bare 세션초기화 with no target', () => {
    expect(
      tryHandleSessionResetCommand(
        'main-jid',
        makeMsg('세션초기화'),
        makeDeps(tmpDir),
      ),
    ).toBe(false);
  });

  it('returns true and dispatches for 세션초기화 전체', async () => {
    const deps = makeDeps(tmpDir);
    expect(
      tryHandleSessionResetCommand(
        'main-jid',
        makeMsg('세션초기화 전체'),
        deps,
      ),
    ).toBe(true);

    // Wait for fire-and-forget
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.terminateGroup).toHaveBeenCalled();
  });

  it('returns true and dispatches for 세션초기화 <target>', async () => {
    const deps = makeDeps(tmpDir);
    expect(
      tryHandleSessionResetCommand(
        'main-jid',
        makeMsg('세션초기화 mat_news'),
        deps,
      ),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.terminateGroup).toHaveBeenCalledWith('target-jid');
  });
});

describe('stripAutoResetMarker', () => {
  it('leaves text unchanged and reports hasMarker=false when absent', () => {
    const { text, hasMarker } = stripAutoResetMarker('meeting note done.');
    expect(text).toBe('meeting note done.');
    expect(hasMarker).toBe(false);
  });

  it('strips the sentinel and reports hasMarker=true', () => {
    const input = `done.\n\n${AUTO_RESET_MARKER}`;
    const { text, hasMarker } = stripAutoResetMarker(input);
    expect(text).toBe('done.');
    expect(hasMarker).toBe(true);
  });

  it('strips multiple occurrences and collapses blank-line runs', () => {
    const input = `head\n\n${AUTO_RESET_MARKER}\n\n\nmiddle\n\n${AUTO_RESET_MARKER}\ntail`;
    const { text, hasMarker } = stripAutoResetMarker(input);
    expect(text).toBe('head\n\nmiddle\n\ntail');
    expect(hasMarker).toBe(true);
  });
});

describe('findPairedLanes', () => {
  const groups = {
    'slack:C0AP71364H5': {
      folder: 'slack_agent_meeting_notes_pat',
    } as RegisteredGroup,
    'slack-mat:C0AP71364H5': {
      folder: 'slack_agent_meeting_notes_mat',
    } as RegisteredGroup,
    'slack:C0OTHER99999': {
      folder: 'slack_unrelated',
    } as RegisteredGroup,
  };

  it('returns both lanes for a pat+mat 2-bot channel', () => {
    const paired = findPairedLanes('slack:C0AP71364H5', groups).sort();
    expect(paired).toEqual(
      ['slack:C0AP71364H5', 'slack-mat:C0AP71364H5'].sort(),
    );
  });

  it('returns just the input jid for a single-bot channel', () => {
    expect(findPairedLanes('slack:C0OTHER99999', groups)).toEqual([
      'slack:C0OTHER99999',
    ]);
  });

  it('returns empty when the physical channel has no registered lanes', () => {
    expect(findPairedLanes('slack:UNKNOWN_CHAN', groups)).toEqual([]);
  });
});

describe('autoResetPairedLanes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGroup(folder: string): RegisteredGroup {
    return {
      name: folder,
      folder,
      trigger: '@pat',
      sdk: 'codex',
    } as RegisteredGroup;
  }

  it('resets both lanes of a pat+mat pair and notifies each', async () => {
    const registeredGroups = {
      'slack:C0CHAN': makeGroup('slack_pair_pat'),
      'slack-mat:C0CHAN': makeGroup('slack_pair_mat'),
    };
    // Create SDK dirs so cleanSdkSessionFiles has something to touch.
    for (const folder of ['slack_pair_pat', 'slack_pair_mat']) {
      const base = path.join(tmpDir, 'sessions', folder, '.codex');
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'state_5.sqlite'), 'data');
    }

    const sessions: Record<string, string> = {
      slack_pair_pat: 'sess-pat',
      slack_pair_mat: 'sess-mat',
    };
    const terminateGroup = vi.fn(async () => {});
    const deleteSession = vi.fn();
    const sendMessage = vi.fn(async () => {});

    const deps: SessionHandlerDeps = {
      dataDir: tmpDir,
      sessions,
      terminateGroup,
      deleteSession,
      registeredGroups,
      sendMessage,
    };

    await autoResetPairedLanes('slack:C0CHAN', deps);

    expect(terminateGroup).toHaveBeenCalledWith('slack:C0CHAN');
    expect(terminateGroup).toHaveBeenCalledWith('slack-mat:C0CHAN');
    expect(deleteSession).toHaveBeenCalledWith('slack_pair_pat');
    expect(deleteSession).toHaveBeenCalledWith('slack_pair_mat');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sessions).not.toHaveProperty('slack_pair_pat');
    expect(sessions).not.toHaveProperty('slack_pair_mat');
  });

  it('logs and returns early when no paired lanes are registered', async () => {
    const deps: SessionHandlerDeps = {
      dataDir: tmpDir,
      sessions: {},
      terminateGroup: vi.fn(async () => {}),
      deleteSession: vi.fn(),
      registeredGroups: {},
      sendMessage: vi.fn(async () => {}),
    };

    await autoResetPairedLanes('slack:UNKNOWN', deps);

    expect(deps.terminateGroup).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
