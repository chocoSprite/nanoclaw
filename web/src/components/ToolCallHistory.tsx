import type { RecentToolCall } from '../contracts';
import { cn } from '../lib/utils';

interface Props {
  tools: RecentToolCall[];
  /**
   * When false, show the full inputSummary without clipping. Defaults to true
   * so the LivePage card stays compact; the SessionDetailDrawer passes false.
   */
  truncate?: boolean;
  /**
   * When true, animate the first entry as "currently running" (a matching
   * tool.result has not yet arrived). LivePage sets this from the container
   * status; the drawer can follow the same signal.
   */
  pulseFirst?: boolean;
}

const TRUNCATE_LEN = 80;

function clip(s: string, max = TRUNCATE_LEN): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Vertical list of recent tool calls (newest first). Used inside the Live card
 * (truncated) and the session detail drawer (full). Dot color indicates the
 * tool's result state: pending (gray), ok (success), error (destructive).
 */
export function ToolCallHistory({ tools, truncate = true, pulseFirst }: Props) {
  if (tools.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {tools.map((t, i) => {
        const dotClass =
          t.isError === true
            ? 'bg-destructive'
            : t.isError === false
              ? 'bg-success'
              : 'bg-muted-foreground/50';
        const pulse = pulseFirst && i === 0 && t.isError === undefined;
        return (
          <li
            key={`${t.toolUseId ?? t.at}-${i}`}
            className="flex items-start gap-1.5"
          >
            <span
              className={cn(
                'mt-1.5 inline-block size-1.5 shrink-0 rounded-full',
                dotClass,
                pulse && 'animate-pulse',
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs">{t.toolName}</div>
              {t.inputSummary ? (
                <div
                  className={cn(
                    'font-mono text-[11px] text-muted-foreground',
                    truncate ? 'truncate' : 'whitespace-pre-wrap break-words',
                  )}
                  title={truncate ? t.inputSummary : undefined}
                >
                  {truncate ? clip(t.inputSummary) : t.inputSummary}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
