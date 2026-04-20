/**
 * Codex usage delta calculation.
 *
 * Codex CLI's JSONL stream emits `turn.completed.usage` as **cumulative**
 * thread totals, not per-turn increments. The interactive SDK carries a
 * per-request `ThreadTokenUsage.last` field, but that field is discarded
 * during `codex exec --experimental-json` serialization.
 * See: https://github.com/openai/codex/issues/17539
 *
 * To keep the token gauge consistent with Claude's per-turn `msg.usage`,
 * the adapter holds the previous cumulative snapshot and converts each
 * incoming payload into a delta before emitting `session.usage`.
 *
 * Separately, Codex's `cached_input_tokens` is a **breakdown** of
 * `input_tokens` (a subset), not an additive sibling — unlike Anthropic
 * where `cache_read` / `cache_creation` are disjoint from input. The
 * caller in codex-adapter deliberately omits `cacheReadTokens` from the
 * emitted event so the web-side `totalContextTokens` (which sums the
 * three) does not double-count. See promptfoo#7546 for the same bug.
 */

export interface CodexUsageCumulative {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export interface CodexUsageBaseline {
  input: number;
  cached: number;
  output: number;
}

export interface CodexUsageDeltaResult {
  deltaInput: number;
  deltaOutput: number;
  nextBaseline: CodexUsageBaseline;
}

/**
 * Compute per-turn deltas from cumulative thread totals.
 *
 * - `prev === null` means "no prior turn observed" (fresh thread, or
 *   session reset). The delta equals the cumulative in that case —
 *   correct as a one-shot, since the replayed prompt is still the input
 *   of this turn.
 * - `Math.max(0, ...)` guards against codex CLI edge cases where the
 *   internal counter might reset or regress mid-stream. Worst case we
 *   skip one turn's delta rather than emit a negative number.
 */
export function codexUsageDelta(
  cumulative: CodexUsageCumulative,
  prev: CodexUsageBaseline | null,
): CodexUsageDeltaResult {
  const baseline = prev ?? { input: 0, cached: 0, output: 0 };
  const curInput = cumulative.input_tokens ?? 0;
  const curCached = cumulative.cached_input_tokens ?? 0;
  const curOutput = cumulative.output_tokens ?? 0;

  return {
    deltaInput: Math.max(0, curInput - baseline.input),
    deltaOutput: Math.max(0, curOutput - baseline.output),
    nextBaseline: { input: curInput, cached: curCached, output: curOutput },
  };
}
