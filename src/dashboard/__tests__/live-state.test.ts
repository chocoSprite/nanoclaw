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

describe('LiveStateCache — session.usage', () => {
  it('session.usage populates lastUsage with all fields', () => {
    const cache = new LiveStateCache();
    cache.apply(
      ev('session.usage', {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheCreationTokens: 50,
        model: 'claude-sonnet-4-6',
      }),
    );
    expect(cache.get(JID)?.lastUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheCreationTokens: 50,
      model: 'claude-sonnet-4-6',
    });
  });

  it('session.usage with optional fields omitted keeps them undefined', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('session.usage', { inputTokens: 500, outputTokens: 100 }));
    const u = cache.get(JID)?.lastUsage;
    expect(u?.inputTokens).toBe(500);
    expect(u?.outputTokens).toBe(100);
    expect(u?.cacheReadTokens).toBeUndefined();
    expect(u?.cacheCreationTokens).toBeUndefined();
    expect(u?.model).toBeUndefined();
  });

  it('status.started clears lastUsage so the gauge restarts from zero', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('session.usage', { inputTokens: 900, outputTokens: 50 }));
    expect(cache.get(JID)?.lastUsage).not.toBeNull();
    cache.apply(ev('status.started', { sdk: 'claude', sessionId: 'sess_x' }));
    expect(cache.get(JID)?.lastUsage).toBeNull();
  });

  it('container.exited preserves lastUsage until next session', () => {
    const cache = new LiveStateCache();
    cache.apply(ev('session.usage', { inputTokens: 400, outputTokens: 80 }));
    cache.apply(ev('container.exited', { exitCode: 0 }));
    expect(cache.get(JID)?.lastUsage?.inputTokens).toBe(400);
  });

  // Codex adapter deliberately omits cacheReadTokens/cacheCreationTokens
  // because Codex's `cached_input_tokens` is a breakdown of input_tokens,
  // not a disjoint sibling. totalContextTokens() sums all three — if the
  // Codex adapter populated cache fields, it would double-count.
  it('Codex-shaped session.usage (no cache fields) keeps them undefined', () => {
    const cache = new LiveStateCache();
    cache.apply(
      ev('session.usage', {
        inputTokens: 3200,
        outputTokens: 450,
        model: 'gpt-5.4',
      }),
    );
    const u = cache.get(JID)?.lastUsage;
    expect(u?.inputTokens).toBe(3200);
    expect(u?.outputTokens).toBe(450);
    expect(u?.model).toBe('gpt-5.4');
    expect(u?.cacheReadTokens).toBeUndefined();
    expect(u?.cacheCreationTokens).toBeUndefined();
  });
});
