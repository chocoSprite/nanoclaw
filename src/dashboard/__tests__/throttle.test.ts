import { describe, it, expect, vi } from 'vitest';
import { EventThrottle } from '../throttle.js';
import type { AgentEventV1 } from '../../agent-events.js';

function toolUse(toolName: string, chatJid = 'slack:C1'): AgentEventV1 {
  return {
    v: 1,
    kind: 'tool.use',
    ts: '2026-04-19T00:00:00.000Z',
    groupFolder: 'g',
    chatJid,
    toolName,
  };
}

function statusEnded(chatJid = 'slack:C1'): AgentEventV1 {
  return {
    v: 1,
    kind: 'status.ended',
    ts: '2026-04-19T00:00:00.000Z',
    groupFolder: 'g',
    chatJid,
    outcome: 'success',
  };
}

describe('EventThrottle', () => {
  it('collapses duplicate toolName within window', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read'), 0);
    t.push(toolUse('Read'), 100);
    t.push(toolUse('Read'), 500);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('passes toolName change immediately', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read'), 0);
    t.push(toolUse('Grep'), 50);
    t.push(toolUse('Read'), 100);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('re-emits same toolName after window elapses', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read'), 0);
    t.push(toolUse('Read'), 1001);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('status/container events always pass through', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read'), 0);
    t.push(statusEnded(), 10);
    t.push(statusEnded(), 20);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('status.ended resets toolName so next use emits immediately', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read'), 0);
    t.push(statusEnded(), 10);
    t.push(toolUse('Read'), 20);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('throttle keys by chatJid so groups are independent', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read', 'slack:A'), 0);
    t.push(toolUse('Read', 'slack:B'), 1);
    t.push(toolUse('Read', 'slack:A'), 2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('reset(key) wipes per-key state', () => {
    const emit = vi.fn();
    const t = new EventThrottle(emit, 1000);
    t.push(toolUse('Read', 'slack:A'), 0);
    t.reset('slack:A');
    t.push(toolUse('Read', 'slack:A'), 1);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
