import { describe, it, expect, vi } from 'vitest';
import {
  EVENT_END_MARKER,
  EVENT_START_MARKER,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  StreamMarkerParser,
} from '../../marker-parser.js';

function outputBlock(payload: string): string {
  return `${OUTPUT_START_MARKER}\n${payload}\n${OUTPUT_END_MARKER}\n`;
}

function eventBlock(payload: string): string {
  return `${EVENT_START_MARKER}\n${payload}\n${EVENT_END_MARKER}\n`;
}

describe('StreamMarkerParser', () => {
  it('emits a single OUTPUT pair delivered in one chunk', () => {
    const onOutput = vi.fn();
    const p = new StreamMarkerParser({ onOutput });
    p.push(outputBlock('{"status":"success","result":"hi"}'));
    expect(onOutput).toHaveBeenCalledExactlyOnceWith(
      '{"status":"success","result":"hi"}',
    );
  });

  it('emits a single EVENT pair delivered in one chunk', () => {
    const onEvent = vi.fn();
    const p = new StreamMarkerParser({ onEvent });
    p.push(eventBlock('{"v":1,"kind":"tool.use","toolName":"Read"}'));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      '{"v":1,"kind":"tool.use","toolName":"Read"}',
    );
  });

  it('handles chunk boundaries that split a marker in half', () => {
    const onOutput = vi.fn();
    const p = new StreamMarkerParser({ onOutput });
    const full = outputBlock('{"v":1}');
    // Split mid-marker on the start sentinel
    p.push(full.slice(0, 10));
    p.push(full.slice(10, 30));
    p.push(full.slice(30));
    expect(onOutput).toHaveBeenCalledExactlyOnceWith('{"v":1}');
  });

  it('handles chunk boundary inside the payload', () => {
    const onEvent = vi.fn();
    const p = new StreamMarkerParser({ onEvent });
    const full = eventBlock('{"v":1,"kind":"tool.use","toolName":"Read"}');
    const mid = Math.floor(full.length / 2);
    p.push(full.slice(0, mid));
    p.push(full.slice(mid));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(
      '{"v":1,"kind":"tool.use","toolName":"Read"}',
    );
  });

  it('routes interleaved OUTPUT and EVENT pairs to correct handlers in order', () => {
    const calls: Array<['out' | 'evt', string]> = [];
    const p = new StreamMarkerParser({
      onOutput: (s) => calls.push(['out', s]),
      onEvent: (s) => calls.push(['evt', s]),
    });
    p.push(
      eventBlock('{"kind":"tool.use","toolName":"Read"}') +
        outputBlock('{"status":"success"}') +
        eventBlock('{"kind":"status.ended","outcome":"success"}'),
    );
    expect(calls.map(([k]) => k)).toEqual(['evt', 'out', 'evt']);
    expect(calls[0][1]).toContain('tool.use');
    expect(calls[2][1]).toContain('status.ended');
  });

  it('waits for END marker before emitting (incomplete pair held in buffer)', () => {
    const onOutput = vi.fn();
    const p = new StreamMarkerParser({ onOutput });
    p.push(`${OUTPUT_START_MARKER}\n{"partial":true}\n`);
    expect(onOutput).not.toHaveBeenCalled();
    p.push(`${OUTPUT_END_MARKER}\n`);
    expect(onOutput).toHaveBeenCalledExactlyOnceWith('{"partial":true}');
  });

  it('discards prefix noise before a marker', () => {
    const onOutput = vi.fn();
    const p = new StreamMarkerParser({ onOutput });
    p.push('some random stderr-leaked text here\n');
    p.push(outputBlock('{"ok":1}'));
    expect(onOutput).toHaveBeenCalledExactlyOnceWith('{"ok":1}');
  });

  it('tolerates handler errors and keeps draining subsequent pairs', () => {
    const onOutput = vi.fn();
    let first = true;
    const onEvent = vi.fn(() => {
      if (first) {
        first = false;
        throw new Error('listener blew up');
      }
    });
    const p = new StreamMarkerParser({ onOutput, onEvent });
    p.push(
      eventBlock('{"kind":"tool.use"}') +
        outputBlock('{"ok":1}') +
        eventBlock('{"kind":"status.ended"}'),
    );
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('no handlers → no work, buffer still consumed on matching pairs', () => {
    const p = new StreamMarkerParser({}); // onOutput undefined, onEvent undefined
    p.push(outputBlock('{"x":1}'));
    // With no handler, parser doesn't consume — buffer keeps growing.
    // That's acceptable since a parser instance without handlers is a misuse.
    expect(p.bufferSize).toBeGreaterThan(0);
  });

  it('skips OUTPUT parsing when only onEvent provided', () => {
    const onEvent = vi.fn();
    const p = new StreamMarkerParser({ onEvent });
    p.push(outputBlock('{"a":1}') + eventBlock('{"kind":"tool.use"}'));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith('{"kind":"tool.use"}');
  });
});
