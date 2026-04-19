import { describe, it, expect, vi } from 'vitest';
import { InProcessEventBus, type AgentEventV1 } from '../../agent-events.js';

function toolUse(overrides: Partial<AgentEventV1> = {}): AgentEventV1 {
  return {
    v: 1,
    kind: 'tool.use',
    ts: '2026-04-19T00:00:00.000Z',
    groupFolder: 'test_group',
    chatJid: 'slack:C0000000001',
    toolName: 'Read',
    ...overrides,
  } as AgentEventV1;
}

function statusStarted(): AgentEventV1 {
  return {
    v: 1,
    kind: 'status.started',
    ts: '2026-04-19T00:00:00.000Z',
    groupFolder: 'test_group',
    chatJid: 'slack:C0000000001',
    sdk: 'claude',
  };
}

describe('InProcessEventBus', () => {
  it('delivers events to specific-kind listeners', () => {
    const bus = new InProcessEventBus();
    const seen: AgentEventV1[] = [];
    bus.on('tool.use', (ev) => seen.push(ev));

    bus.emit(toolUse());
    bus.emit(statusStarted());

    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('tool.use');
  });

  it('delivers events to wildcard listeners', () => {
    const bus = new InProcessEventBus();
    const seen: AgentEventV1[] = [];
    bus.on('*', (ev) => seen.push(ev));

    bus.emit(toolUse());
    bus.emit(statusStarted());

    expect(seen.map((e) => e.kind)).toEqual(['tool.use', 'status.started']);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new InProcessEventBus();
    const fn = vi.fn();
    const off = bus.on('tool.use', fn);

    bus.emit(toolUse());
    expect(fn).toHaveBeenCalledTimes(1);

    off();
    bus.emit(toolUse());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listenerCount reflects current subscribers', () => {
    const bus = new InProcessEventBus();
    expect(bus.listenerCount()).toBe(0);

    const off1 = bus.on('tool.use', () => {});
    const off2 = bus.on('*', () => {});
    expect(bus.listenerCount()).toBe(2);
    expect(bus.listenerCount('tool.use')).toBe(1);

    off1();
    off2();
    expect(bus.listenerCount()).toBe(0);
  });

  it('swallowed listener errors do not block siblings', () => {
    const bus = new InProcessEventBus();
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const good = vi.fn();

    bus.on('tool.use', () => {
      throw new Error('boom');
    });
    bus.on('tool.use', good);

    bus.emit(toolUse());
    expect(good).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
