import { useEffect, useState } from 'react';
import type { LiveGroupState } from '../contracts';

interface Props {
  group: LiveGroupState;
}

const STATUS_DOT: Record<LiveGroupState['containerStatus'], string> = {
  idle: 'bg-slate-500',
  running: 'bg-emerald-400 animate-pulse',
  error: 'bg-rose-500',
};

const SDK_BADGE: Record<LiveGroupState['sdk'], string> = {
  claude: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  codex: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
};

export function GroupLiveCard({ group }: Props) {
  const idle = group.containerStatus === 'idle';
  const elapsedSec = useElapsedSec(group.lastToolAt);
  const stuck =
    group.containerStatus === 'running' && elapsedSec !== null && elapsedSec > 60;

  return (
    <div
      className={[
        'rounded-lg border border-slate-700/60 bg-slate-900/60 p-4',
        'flex flex-col gap-2 transition-opacity',
        idle ? 'opacity-50' : 'opacity-100',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={[
              'inline-block h-2.5 w-2.5 rounded-full shrink-0',
              STATUS_DOT[group.containerStatus],
            ].join(' ')}
          />
          <span className="truncate text-sm font-medium text-slate-100">
            {group.name}
          </span>
        </div>
        <span
          className={[
            'text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border',
            SDK_BADGE[group.sdk],
          ].join(' ')}
        >
          {group.sdk}
        </span>
      </div>

      <div className="text-xs text-slate-400 truncate">
        {group.groupFolder}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <div
          className={[
            'text-sm font-mono truncate',
            group.currentTool
              ? 'text-slate-200'
              : 'text-slate-500 italic',
          ].join(' ')}
        >
          {group.currentTool ?? 'idle'}
        </div>
        {group.containerStatus === 'running' && elapsedSec !== null && (
          <div
            className={[
              'text-xs tabular-nums shrink-0',
              stuck ? 'text-rose-400 animate-pulse' : 'text-slate-500',
            ].join(' ')}
          >
            {elapsedSec}s
          </div>
        )}
      </div>
    </div>
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
