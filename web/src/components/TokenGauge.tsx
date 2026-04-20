import type { SdkKind, SessionUsageSnapshot } from '../contracts';
import {
  formatTokensShort,
  getWindowForModel,
  totalContextTokens,
} from '../lib/context-window';
import { cn } from '../lib/utils';

interface Props {
  usage: SessionUsageSnapshot;
  sdk: SdkKind;
  /** When true, render the breakdown numbers below the bar (drawer only). */
  showBreakdown?: boolean;
}

/**
 * Horizontal progress bar indicating how full the model's context window is
 * after the most recent turn. Tiers:
 *   <80%  — muted bar
 *   80%+  — warning color
 *   95%+  — destructive color + pulse animation (compact soon)
 *
 * Codex groups may carry no `model` when the group entry has `model=null`
 * in the DB, in which case `getWindowForModel` falls back to a 400k default.
 */
export function TokenGauge({ usage, sdk, showBreakdown }: Props) {
  const used = totalContextTokens(usage);
  const windowSize = getWindowForModel(usage.model, sdk);
  const pct = Math.min(100, Math.round((used / windowSize) * 100));

  const tier = pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : 'normal';
  const barColor =
    tier === 'critical'
      ? 'bg-destructive'
      : tier === 'warning'
        ? 'bg-warning'
        : 'bg-muted-foreground/70';
  const labelColor =
    tier === 'critical'
      ? 'text-destructive'
      : tier === 'warning'
        ? 'text-warning'
        : 'text-muted-foreground';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="text-muted-foreground">컨텍스트</span>
        <span className={cn(labelColor)}>
          {formatTokensShort(used)} / {formatTokensShort(windowSize)}
          <span className="ml-1 opacity-70">({pct}%)</span>
        </span>
      </div>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 transition-[width]',
            barColor,
            tier === 'critical' && 'animate-pulse',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showBreakdown ? <Breakdown usage={usage} /> : null}
    </div>
  );
}

function Breakdown({ usage }: { usage: SessionUsageSnapshot }) {
  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
      <Kv label="입력" value={usage.inputTokens} />
      <Kv label="출력" value={usage.outputTokens} />
      {usage.cacheReadTokens !== undefined && (
        <Kv label="캐시 read" value={usage.cacheReadTokens} />
      )}
      {usage.cacheCreationTokens !== undefined && (
        <Kv label="캐시 write" value={usage.cacheCreationTokens} />
      )}
      {usage.model && (
        <>
          <dt className="text-muted-foreground">모델</dt>
          <dd className="truncate text-right font-mono">{usage.model}</dd>
        </>
      )}
    </dl>
  );
}

function Kv({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{formatTokensShort(value)}</dd>
    </>
  );
}
