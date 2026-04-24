const DEFAULT_PORT = 3030;

export interface DashboardConfig {
  enabled: boolean;
  port: number;
}

export function dashboardConfig(): DashboardConfig {
  const enabled = process.env.DASHBOARD_ENABLED === '1';
  const raw = process.env.DASHBOARD_PORT;
  const parsed = raw ? Number(raw) : DEFAULT_PORT;
  const port =
    Number.isFinite(parsed) && parsed > 0 && parsed < 65536
      ? parsed
      : DEFAULT_PORT;
  return { enabled, port };
}

/** Thresholds for log-signals detection. Env-tunable; conservative defaults. */
export interface SignalsConfig {
  crashLoopWindowSec: number;
  crashLoopCount: number;
  upstreamWindowSec: number;
  upstreamCount: number;
  autoResolveHours: number;
  /** sweep tick interval in ms — auto-resolve runs this often. */
  sweepIntervalMs: number;
}

function envInt(key: string, defaultVal: number): number {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

export function signalsConfig(): SignalsConfig {
  return {
    crashLoopWindowSec: envInt('SIGNAL_CRASH_LOOP_WINDOW_SEC', 300),
    crashLoopCount: envInt('SIGNAL_CRASH_LOOP_COUNT', 3),
    upstreamWindowSec: envInt('SIGNAL_UPSTREAM_WINDOW_SEC', 120),
    upstreamCount: envInt('SIGNAL_UPSTREAM_COUNT', 5),
    autoResolveHours: envInt('SIGNAL_AUTO_RESOLVE_HOURS', 24),
    sweepIntervalMs: envInt('SIGNAL_SWEEP_INTERVAL_MS', 300_000),
  };
}

/**
 * Whitelist of Claude model IDs that the dashboard accepts for the
 * groups editor `PATCH /api/groups/:jid` endpoint. Keep in sync with
 * `web/src/contracts.ts::CLAUDE_MODELS`.
 *
 * `null` is also accepted and means "fall back to the SDK default".
 */
export const CLAUDE_MODEL_WHITELIST = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODEL_WHITELIST)[number];

export function isValidClaudeModel(value: unknown): value is ClaudeModelId {
  return (
    typeof value === 'string' &&
    (CLAUDE_MODEL_WHITELIST as readonly string[]).includes(value)
  );
}

/**
 * Whitelist of Codex model IDs the dashboard accepts. Narrow by design —
 * Codex CLI happily passes arbitrary strings through to the model config,
 * so the whitelist protects against typos silently failing at run time.
 * Update together with `web/src/contracts.ts::CODEX_MODELS` and
 * `CODEX_DEFAULT_MODEL_DISPLAY` when Codex CLI upgrades its default.
 *
 * `null` means "fall back to ~/.codex/config.toml's global default".
 */
export const CODEX_MODEL_WHITELIST = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5',
  'o3',
] as const;

export type CodexModelId = (typeof CODEX_MODEL_WHITELIST)[number];

export function isValidCodexModel(value: unknown): value is CodexModelId {
  return (
    typeof value === 'string' &&
    (CODEX_MODEL_WHITELIST as readonly string[]).includes(value)
  );
}
