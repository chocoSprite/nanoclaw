import { describe, it, expect } from 'vitest';
import { LiveStateCache, RECENT_TOOLS_CAP } from '../live-state.js';
import type { AgentEventV1 } from '../../agent-events.js';

const JID = 'slack:C000TEST';
const FOLDER = 'test_group';

function ev<K extends AgentEventV1['kind']>(
  kind: K,
  extra: Omit<
    Extract<AgentEventV1, { kind: K }>,
    'v' | 'kind' | 'ts' | 'groupFolder' | 'chatJid'
  >,
  ts = '2026-04-20T00:00:00.000Z',
): AgentEventV1 {
  return {
    v: 1,
    kind,
    ts,
    groupFolder: FOLDER,
    chatJid: JID,
    ...extra,
  } as AgentEventV1;
}

describe('LiveStateCache — recentTools & sessionId', () => {
  it('status.started captures sessionId and clears history', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('tool.use', { toolName: 'Read', toolUseId: 'tu_1' }));
    cache.apply(ev('status.started', { sdk: 'claude', sessionId: 'sess_abc' }));
    const s = cache.get(JID);
    expect(s?.sessionId).toBe('sess_abc');
    expect(s?.recentTools).toEqual([]);
  });

  it('status.started without sessionId leaves sessionId null', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('status.started', { sdk: 'codex' }));
    expect(cache.get(JID)?.sessionId).toBeNull();
  });

  it('tool.use pushes newest-first up to 5 entries', () => {
    const cache = new LiveStateCache();
    for (let i = 0; i < 7; i++) {
      cache.apply(
        ev(
          'tool.use',
          {
            toolName: `Tool${i}`,
            toolUseId: `tu_${i}`,
            inputSummary: `arg${i}`,
          },
          `2026-04-20T00:00:0${i}.000Z`,
        ),
      );
    }
    const s = cache.get(JID)!;
    expect(s.recentTools).toHaveLength(RECENT_TOOLS_CAP);
    // newest first
    expect(s.recentTools.map((t) => t.toolName)).toEqual([
      'Tool6',
      'Tool5',
      'Tool4',
      'Tool3',
      'Tool2',
    ]);
    expect(s.recentTools[0].inputSummary).toBe('arg6');
  });

  it('tool.result matches toolUseId and stamps isError', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('tool.use', { toolName: 'Read', toolUseId: 'tu_1' }));
    cache.apply(ev('tool.use', { toolName: 'Write', toolUseId: 'tu_2' }));
    cache.apply(ev('tool.result', { toolUseId: 'tu_1', isError: false }));
    cache.apply(ev('tool.result', { toolUseId: 'tu_2', isError: true }));
    const s = cache.get(JID)!;
    // newest first → Write then Read
    expect(s.recentTools[0].toolName).toBe('Write');
    expect(s.recentTools[0].isError).toBe(true);
    expect(s.recentTools[1].toolName).toBe('Read');
    expect(s.recentTools[1].isError).toBe(false);
  });

  it('tool.result without toolUseId falls back to newest entry', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('tool.use', { toolName: 'Read' }));
    cache.apply(ev('tool.use', { toolName: 'Write' }));
    cache.apply(ev('tool.result', { isError: true }));
    const s = cache.get(JID)!;
    expect(s.recentTools[0].toolName).toBe('Write');
    expect(s.recentTools[0].isError).toBe(true);
    expect(s.recentTools[1].isError).toBeUndefined();
  });

  it('tool.result on empty history is a no-op', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('tool.result', { toolUseId: 'tu_1', isError: true }));
    expect(cache.get(JID)?.recentTools).toEqual([]);
  });

  it('container.exited preserves recentTools and sessionId until next session', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('status.started', { sdk: 'claude', sessionId: 'sess_a' }));
    cache.apply(ev('tool.use', { toolName: 'Read', toolUseId: 'tu_1' }));
    cache.apply(ev('container.exited', { exitCode: 0 }));
    let s = cache.get(JID)!;
    expect(s.recentTools).toHaveLength(1);
    expect(s.sessionId).toBe('sess_a');
    // next session clears
    cache.apply(ev('status.started', { sdk: 'claude', sessionId: 'sess_b' }));
    s = cache.get(JID)!;
    expect(s.recentTools).toEqual([]);
    expect(s.sessionId).toBe('sess_b');
  });

  it('tool.use populates optional fields only when present', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('tool.use', { toolName: 'Read' }));
    const entry = cache.get(JID)!.recentTools[0];
    expect(entry.toolName).toBe('Read');
    expect(entry.toolUseId).toBeUndefined();
    expect(entry.inputSummary).toBeUndefined();
    expect(entry.isError).toBeUndefined();
  });
});
