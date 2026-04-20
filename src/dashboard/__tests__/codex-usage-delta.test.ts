import { describe, it, expect } from 'vitest';
// The function lives in the container/agent-runner package (a sibling
// workspace, not listed in root tsconfig's rootDir). Vitest resolves the
// .ts source at run time — we test it from the host so the pre-commit
// vitest gate covers it without needing a separate runner.
import { codexUsageDelta } from '../../../container/agent-runner/src/codex-usage.js';

describe('codexUsageDelta', () => {
  it('first turn (prev=null) returns delta equal to cumulative', () => {
    const result = codexUsageDelta(
      { input_tokens: 1500, cached_input_tokens: 400, output_tokens: 200 },
      null,
    );
    expect(result.deltaInput).toBe(1500);
    expect(result.deltaOutput).toBe(200);
    expect(result.nextBaseline).toEqual({
      input: 1500,
      cached: 400,
      output: 200,
    });
  });

  it('second turn subtracts prior baseline to yield per-turn delta', () => {
    const result = codexUsageDelta(
      { input_tokens: 2200, cached_input_tokens: 900, output_tokens: 350 },
      { input: 1500, cached: 400, output: 200 },
    );
    expect(result.deltaInput).toBe(700);
    expect(result.deltaOutput).toBe(150);
    expect(result.nextBaseline).toEqual({
      input: 2200,
      cached: 900,
      output: 350,
    });
  });

  it('reset path (prev=null after new thread) treats first payload as fresh', () => {
    // Simulates the adapter resetting lastUsage on thread.started after
    // a previous thread had accumulated 5000/1000 tokens.
    const firstTurnOfNewThread = codexUsageDelta(
      { input_tokens: 800, cached_input_tokens: 100, output_tokens: 60 },
      null,
    );
    expect(firstTurnOfNewThread.deltaInput).toBe(800);
    expect(firstTurnOfNewThread.deltaOutput).toBe(60);
  });

  it('regression guard: cumulative below prior baseline clamps to zero', () => {
    // Defensive: if the codex CLI internal counter ever regresses (e.g.
    // mid-stream reset on resume), we must not emit a negative delta.
    const result = codexUsageDelta(
      { input_tokens: 500, cached_input_tokens: 0, output_tokens: 30 },
      { input: 1200, cached: 300, output: 150 },
    );
    expect(result.deltaInput).toBe(0);
    expect(result.deltaOutput).toBe(0);
    // Baseline still tracks the latest cumulative, so subsequent turns
    // compute against the post-reset counter, not the stale high-water.
    expect(result.nextBaseline).toEqual({
      input: 500,
      cached: 0,
      output: 30,
    });
  });

  it('missing usage fields default to zero without throwing', () => {
    const result = codexUsageDelta({}, null);
    expect(result.deltaInput).toBe(0);
    expect(result.deltaOutput).toBe(0);
    expect(result.nextBaseline).toEqual({ input: 0, cached: 0, output: 0 });
  });
});
