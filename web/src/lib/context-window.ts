import type { SdkKind, SessionUsageSnapshot } from '../contracts';

/**
 * Context window sizes in tokens, keyed by model id. Known Claude models map
 * explicitly; anything else falls back to a per-SDK default via
 * {@link getWindowForModel}. Keep in sync with `CLAUDE_MODELS` in contracts
 * when new models ship.
 */
const WINDOW_BY_MODEL: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

/** Fallback window for unknown models, picked by SDK. */
export const DEFAULT_WINDOW = {
  claude: 200_000,
  codex: 400_000,
} as const;

export function getWindowForModel(
  model: string | undefined,
  sdk: SdkKind,
): number {
  if (model && WINDOW_BY_MODEL[model] !== undefined) {
    return WINDOW_BY_MODEL[model];
  }
  return DEFAULT_WINDOW[sdk];
}

/**
 * Total tokens loaded into the context window for the most recently
 * completed turn. Cached (read) and cache-creation tokens count toward
 * the live context; output tokens do not (they leave the window as
 * they're generated).
 *
 * Invariant: callers must emit `cacheReadTokens` / `cacheCreationTokens`
 * only when they are **disjoint** from `inputTokens` (Anthropic's
 * contract). Codex's `cached_input_tokens` is a *breakdown* of
 * `input_tokens`, not a sibling — so the Codex adapter deliberately
 * omits those fields here to avoid double-counting. See
 * `container/agent-runner/src/codex-usage.ts` and promptfoo#7546.
 */
export function totalContextTokens(u: SessionUsageSnapshot): number {
  return (
    u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0)
  );
}

/** Short human label for numbers in the thousands: 34_210 → "34k". */
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
