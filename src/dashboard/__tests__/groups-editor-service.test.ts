import { describe, expect, it } from 'vitest';
import path from 'node:path';

import type {
  RegisteredGroupEntry,
  StateReader,
} from '../adapters/state-adapter.js';
import {
  deriveBotRole,
  GroupsEditorService,
  type GroupsEditorServiceDeps,
} from '../services/groups-editor-service.js';
import type { SkillEntry, SkillScanner } from '../services/skill-scanner.js';
import type { RegisteredGroup } from '../../types.js';

function group(
  folder: string,
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@bot',
    added_at: '2026-04-19',
    sdk: 'claude',
    ...overrides,
  };
}

class FakeState implements StateReader {
  private entries: RegisteredGroupEntry[];
  constructor(entries: RegisteredGroupEntry[]) {
    this.entries = entries;
  }
  listRegisteredGroups(): RegisteredGroupEntry[] {
    return this.entries;
  }
  setGroupModel(jid: string, model: string | null): boolean {
    const entry = this.entries.find((e) => e.jid === jid);
    if (!entry) return false;
    entry.group = { ...entry.group, model: model ?? undefined };
    return true;
  }
}

class FakeSkillScanner {
  constructor(private readonly skillsByFolder: Record<string, SkillEntry[]>) {}
  listSkillsForGroup(folder: string): SkillEntry[] {
    return this.skillsByFolder[folder] ?? [];
  }
}

function makeSvc(
  entries: RegisteredGroupEntry[],
  overrides: Partial<GroupsEditorServiceDeps> = {},
): { svc: GroupsEditorService; state: FakeState; reloadCalls: number } {
  const state = new FakeState(entries);
  let reloadCalls = 0;
  const svc = new GroupsEditorService({
    state,
    skills: new FakeSkillScanner({}) as unknown as SkillScanner,
    getSessions: () => ({}),
    groupsDir: '/g',
    updateGroupModel: (jid, model) => state.setGroupModel(jid, model),
    reloadGroupState: () => {
      reloadCalls++;
    },
    ...overrides,
  });
  return {
    svc,
    state,
    get reloadCalls() {
      return reloadCalls;
    },
  };
}

describe('GroupsEditorService', () => {
  it('builds a view entry per registered group with all fields', () => {
    const state = new FakeState([
      {
        jid: 'slack:A',
        group: group('alpha', {
          model: 'claude-opus-4-6',
          sdk: 'claude',
        }),
      },
    ]);
    const skills = new FakeSkillScanner({
      alpha: [{ name: 'status', origin: 'global' }],
    }) as unknown as SkillScanner;
    const svc = new GroupsEditorService({
      state,
      skills,
      getSessions: () => ({ alpha: 'sess-123' }),
      groupsDir: '/root/groups',
      updateGroupModel: () => true,
      reloadGroupState: () => {},
    });

    const [view] = svc.listForEditor();
    expect(view.jid).toBe('slack:A');
    expect(view.folder).toBe('alpha');
    expect(view.sdk).toBe('claude');
    expect(view.model).toBe('claude-opus-4-6');
    expect(view.isMain).toBe(false);
    expect(view.claudeMdPath).toBe(
      path.join('/root/groups', 'alpha', 'CLAUDE.md'),
    );
    expect(view.skills).toEqual([{ name: 'status', origin: 'global' }]);
    expect(view.session.sessionId).toBe('sess-123');
    // Scope B fields — default shape when containerConfig / matConfig /
    // requiresTrigger are absent on the underlying RegisteredGroup.
    expect(view.additionalMounts).toEqual([]);
    expect(view.matConfig).toBeUndefined();
    expect(view.addedAt).toBe('2026-04-19');
    expect(view.requiresTrigger).toBe(true);
    expect(view.containerTimeout).toBeUndefined();
  });

  it('defaults sdk to codex and model to null when absent', () => {
    const g = group('bravo');
    delete (g as Partial<RegisteredGroup>).sdk;
    const state = new FakeState([{ jid: 'slack:B', group: g }]);
    const svc = new GroupsEditorService({
      state,
      skills: new FakeSkillScanner({}) as unknown as SkillScanner,
      getSessions: () => ({}),
      groupsDir: '/g',
      updateGroupModel: () => true,
      reloadGroupState: () => {},
    });
    const [view] = svc.listForEditor();
    expect(view.sdk).toBe('codex');
    expect(view.model).toBeNull();
    expect(view.session.sessionId).toBeNull();
  });

  it('forwards additionalMounts, matConfig, requiresTrigger, and timeout', () => {
    const { svc } = makeSvc([
      {
        jid: 'slack:P',
        group: group('gamma_pat', {
          requiresTrigger: false,
          containerConfig: {
            timeout: 600_000,
            additionalMounts: [
              { hostPath: '/Users/me/vault', readonly: true },
              {
                hostPath: '/Users/me/work',
                containerPath: 'work',
                readonly: false,
              },
            ],
          },
          matConfig: {
            enabled: true,
            matJid: 'slack-mat:M1',
            matFolder: 'gamma_mat',
            maxRounds: 3,
          },
        }),
      },
    ]);
    const [view] = svc.listForEditor();
    expect(view.additionalMounts).toHaveLength(2);
    expect(view.additionalMounts[0]).toMatchObject({
      hostPath: '/Users/me/vault',
      readonly: true,
    });
    expect(view.additionalMounts[1]).toMatchObject({
      hostPath: '/Users/me/work',
      containerPath: 'work',
      readonly: false,
    });
    expect(view.matConfig).toEqual({
      enabled: true,
      matJid: 'slack-mat:M1',
      matFolder: 'gamma_mat',
      maxRounds: 3,
    });
    expect(view.requiresTrigger).toBe(false);
    expect(view.containerTimeout).toBe(600_000);
  });

  it('getOne returns undefined for unknown jid', () => {
    const { svc } = makeSvc([{ jid: 'slack:A', group: group('alpha') }]);
    expect(svc.getOne('slack:A')?.folder).toBe('alpha');
    expect(svc.getOne('slack:missing')).toBeUndefined();
  });
});

describe('GroupsEditorService.patchModel', () => {
  it('updates model + reloads state + returns new view on valid input', () => {
    const { svc, state } = makeSvc([{ jid: 'slack:A', group: group('alpha') }]);
    let reloadCalls = 0;
    const svcWithSpy = new GroupsEditorService({
      state,
      skills: new FakeSkillScanner({}) as unknown as SkillScanner,
      getSessions: () => ({}),
      groupsDir: '/g',
      updateGroupModel: (jid, model) => state.setGroupModel(jid, model),
      reloadGroupState: () => {
        reloadCalls++;
      },
    });
    const r = svcWithSpy.patchModel('slack:A', 'claude-opus-4-6');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.view.model).toBe('claude-opus-4-6');
    expect(reloadCalls).toBe(1);
    // listForEditor sees updated model too
    expect(svc.listForEditor()[0].model).toBe('claude-opus-4-6');
  });

  it('accepts null (clear override) for claude group', () => {
    const { svc } = makeSvc([
      {
        jid: 'slack:A',
        group: group('alpha', { model: 'claude-opus-4-6' }),
      },
    ]);
    const r = svc.patchModel('slack:A', null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.view.model).toBeNull();
  });

  it('rejects unknown jid with not_found', () => {
    const { svc } = makeSvc([{ jid: 'slack:A', group: group('alpha') }]);
    const r = svc.patchModel('slack:MISSING', 'claude-opus-4-6');
    expect(r).toEqual({ ok: false, error: 'not_found' });
  });

  it('accepts codex group with whitelisted codex model', () => {
    const { svc, state } = makeSvc([
      { jid: 'slack:A', group: group('alpha', { sdk: 'codex' }) },
    ]);
    const svcWithWrite = new GroupsEditorService({
      state,
      skills: new FakeSkillScanner({}) as unknown as SkillScanner,
      getSessions: () => ({}),
      groupsDir: '/g',
      updateGroupModel: (jid, model) => state.setGroupModel(jid, model),
      reloadGroupState: () => {},
    });
    const r = svcWithWrite.patchModel('slack:A', 'gpt-5.4');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.view.model).toBe('gpt-5.4');
    expect(svc.listForEditor()[0].model).toBe('gpt-5.4');
  });

  it('rejects codex group with non-whitelisted model', () => {
    const { svc } = makeSvc([
      { jid: 'slack:A', group: group('alpha', { sdk: 'codex' }) },
    ]);
    const r = svc.patchModel('slack:A', 'gpt-4o');
    expect(r).toEqual({ ok: false, error: 'invalid_model' });
  });

  it('rejects cross-sdk model (claude group, codex-whitelisted id)', () => {
    // 'gpt-5' is in the Codex whitelist, but the group is sdk=claude, so
    // `isValidClaudeModel('gpt-5')` is false → invalid_model (not a bypass).
    const { svc } = makeSvc([{ jid: 'slack:A', group: group('alpha') }]);
    const r = svc.patchModel('slack:A', 'gpt-5');
    expect(r).toEqual({ ok: false, error: 'invalid_model' });
  });

  it('does not reload state when update fails', () => {
    const state = new FakeState([{ jid: 'slack:A', group: group('alpha') }]);
    let reloadCalls = 0;
    const svc = new GroupsEditorService({
      state,
      skills: new FakeSkillScanner({}) as unknown as SkillScanner,
      getSessions: () => ({}),
      groupsDir: '/g',
      updateGroupModel: () => false, // simulate unaffected rows
      reloadGroupState: () => {
        reloadCalls++;
      },
    });
    const r = svc.patchModel('slack:A', 'claude-opus-4-6');
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(reloadCalls).toBe(0);
  });
});

describe('deriveBotRole', () => {
  it('returns main when isMain is true (suffix ignored)', () => {
    expect(deriveBotRole('slack_main', true)).toBe('main');
    expect(deriveBotRole('slack_main_pat', true)).toBe('main');
  });

  it('returns mat for _mat suffix', () => {
    expect(deriveBotRole('slack_agent_labs_mat', false)).toBe('mat');
  });

  it('returns pat for _pat suffix', () => {
    expect(deriveBotRole('slack_agent_labs_pat', false)).toBe('pat');
  });

  it('returns solo for legacy folders without _pat/_mat suffix', () => {
    expect(deriveBotRole('slack_legacy', false)).toBe('solo');
  });
});
