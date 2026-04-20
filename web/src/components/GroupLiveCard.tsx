import { useEffect, useState } from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader } from './ui/card';
import { Badge } from './ui/badge';
import { ToolCallHistory } from './ToolCallHistory';
import { cn } from '../lib/utils';
import type { LiveGroupState } from '../contracts';

interface Props {
  group: LiveGroupState;
}

const STATUS_DOT: Record<LiveGroupState['containerStatus'], string> = {
  idle: 'bg-muted-foreground/50',
  running: 'bg-success animate-pulse',
  error: 'bg-destructive',
};

const STATUS_LABEL: Record<LiveGroupState['containerStatus'], string> = {
  idle: 'idle',
  running: 'running',
  error: 'error',
};

export function GroupLiveCard({ group }: Props) {
  const idle = group.containerStatus === 'idle';
  const elapsedSec = useElapsedSec(group.lastToolAt);
  const pendingSec = useElapsedFromMs(group.pendingSinceTs);
  const stuck =
    group.containerStatus === 'running' &&
    elapsedSec !== null &&
    elapsedSec > 60;
  const pendingStuck = pendingSec !== null && pendingSec > 60;
  const SdkIcon = group.sdk === 'claude' ? Sparkles : Bot;

  return (
    <Card className={cn('transition-opacity', idle && 'opacity-60')}>
      <CardHeader className="gap-2 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'inline-block size-2 shrink-0 rounded-full',
                STATUS_DOT[group.containerStatus],
              )}
              aria-label={STATUS_LABEL[group.containerStatus]}
            />
            <span className="truncate text-sm font-semibold">{group.name}</span>
          </div>
          <Badge variant={group.sdk === 'claude' ? 'info' : 'warning'}>
            <SdkIcon className="size-3" />
            {group.sdk}
          </Badge>
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {group.groupFolder}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0 sm:pt-0">
        <div className="flex items-center justify-between gap-2">
          <div
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-sm',
              group.currentTool
                ? 'text-foreground'
                : 'italic text-muted-foreground',
            )}
          >
            {group.currentTool ?? 'idle'}
          </div>
          {pendingSec !== null && (
            <span
              className={cn(
                'shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums',
                pendingStuck
                  ? 'border-destructive/30 bg-destructive/10 text-destructive animate-pulse'
                  : 'border-warning/40 bg-warning/10 text-warning',
              )}
              aria-label="pending lag"
              title="메시지 대기 시간"
            >
              ⏳ {pendingSec}s
            </span>
          )}
          {group.containerStatus === 'running' && elapsedSec !== null && (
            <span
              className={cn(
                'shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums',
                stuck
                  ? 'border-destructive/30 bg-destructive/10 text-destructive animate-pulse'
                  : 'border-border text-muted-foreground',
              )}
            >
              {elapsedSec}s
            </span>
          )}
        </div>
        {group.recentTools.length > 0 && (
          <ToolCallHistory
            tools={group.recentTools}
            pulseFirst={group.containerStatus === 'running'}
          />
        )}
      </CardContent>
    </Card>
  );
}

function useElapsedSec(lastToolAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lastToolAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [lastToolAt]);
  if (!lastToolAt) return null;
  const t = Date.parse(lastToolAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 1000));
}

function useElapsedFromMs(sinceMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sinceMs == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [sinceMs]);
  if (sinceMs == null) return null;
  return Math.max(0, Math.floor((now - sinceMs) / 1000));
}
