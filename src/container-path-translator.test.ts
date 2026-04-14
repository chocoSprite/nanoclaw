import path from 'path';

import { describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { translateContainerPath } from './container-path-translator.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Jonesy',
    added_at: '2024-01-01T00:00:00.000Z',
    sdk: 'codex',
    ...overrides,
  };
}

describe('translateContainerPath', () => {
  it('translates /workspace/group/* to the group folder host path', () => {
    const group = makeGroup({ folder: 'family-chat' });
    const translated = translateContainerPath(
      '/workspace/group/memo.md',
      group,
    );
    expect(translated).toBe(path.join(GROUPS_DIR, 'family-chat', 'memo.md'));
  });

  it('translates /workspace/global/* to the global host path', () => {
    const translated = translateContainerPath(
      '/workspace/global/CLAUDE.md',
      makeGroup(),
    );
    expect(translated).toBe(path.join(GROUPS_DIR, 'global', 'CLAUDE.md'));
  });

  it('translates /workspace/attachments/* to the data attachments path', () => {
    const translated = translateContainerPath(
      '/workspace/attachments/photo.png',
      makeGroup(),
    );
    expect(translated).toBe(path.join(DATA_DIR, 'attachments', 'photo.png'));
  });

  it('returns exact host path for prefix-only container path', () => {
    const translated = translateContainerPath(
      '/workspace/group',
      makeGroup({ folder: 'family-chat' }),
    );
    expect(translated).toBe(path.join(GROUPS_DIR, 'family-chat'));
  });

  it('translates /workspace/project only for main groups', () => {
    const nonMain = translateContainerPath(
      '/workspace/project/src/index.ts',
      makeGroup(),
    );
    expect(nonMain).toBeNull();

    const main = translateContainerPath(
      '/workspace/project/src/index.ts',
      makeGroup({ isMain: true }),
    );
    expect(main).toBe(path.join(process.cwd(), 'src', 'index.ts'));
  });

  it('prefers /workspace/project/store over /workspace/project (longer prefix)', () => {
    const main = translateContainerPath(
      '/workspace/project/store/messages.db',
      makeGroup({ isMain: true }),
    );
    expect(main).toBe(path.join(STORE_DIR, 'messages.db'));
  });

  it('translates additional mount paths under /workspace/extra/', () => {
    const group = makeGroup({
      containerConfig: {
        additionalMounts: [
          {
            hostPath: '/Users/jhheo/Documents/Projects/agent-board',
            containerPath: 'agent-board',
          },
        ],
      },
    });
    const translated = translateContainerPath(
      '/workspace/extra/agent-board/package.json',
      group,
    );
    expect(translated).toBe(
      '/Users/jhheo/Documents/Projects/agent-board/package.json',
    );
  });

  it('returns null for paths outside mount topology', () => {
    expect(translateContainerPath('/etc/passwd', makeGroup())).toBeNull();
    expect(translateContainerPath('/tmp/other', makeGroup())).toBeNull();
    expect(
      translateContainerPath('/workspace/unknown/foo', makeGroup()),
    ).toBeNull();
  });

  it('returns null for non-absolute container paths', () => {
    expect(translateContainerPath('group/foo.md', makeGroup())).toBeNull();
  });

  it('rejects traversal attempts that escape the mount prefix', () => {
    expect(
      translateContainerPath(
        '/workspace/group/../../../etc/passwd',
        makeGroup(),
      ),
    ).toBeNull();
  });
});
