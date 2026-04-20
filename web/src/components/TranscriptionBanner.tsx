import { Mic, CheckCircle2, AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TranscriptionEntry } from '../contracts';
import { useTranscriptionSnapshot } from '../lib/transcription-store';
import { cn } from '../lib/utils';

/**
 * Live transcription banner — shows above the group grid on LivePage. Renders
 * only when WhisperX is running, has queued jobs, or recently finished a job
 * (recentTerminal retain window ~30s, server-controlled).
 *
 * Why route-level (not global TopBar): the signal primarily belongs next to
 * "what's happening" which is LivePage. Putting it in TopBar would steal
 * vertical space from pages that don't care (Groups editor, Logs detail).
 */
export function TranscriptionBanner() {
  const snap = useTranscriptionSnapshot();

  if (
    snap.active.length === 0 &&
    snap.queued.length === 0 &&
    snap.recentTerminal.length === 0
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {snap.active.map((e) => (
        <ActiveRow key={e.id} entry={e} />
      ))}
      {snap.queued.length > 0 && (
        <QueuedRow count={snap.queued.length} next={snap.queued[0]} />
      )}
      {snap.recentTerminal.map((e) => (
        <TerminalRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

function ActiveRow({ entry }: { entry: TranscriptionEntry }) {
  const elapsed = useElapsedSince(entry.startedAt);
  const stageLabel = entry.stageT
    ? `${entry.stage ?? '…'} · ${entry.stageT}`
    : (entry.stage ?? '대기');
  return (
    <div className="flex items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs">
      <Mic className="size-3.5 shrink-0 animate-pulse text-info" />
      <span className="text-info">전사 중</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {entry.fileName}
      </code>
      <span className="shrink-0 text-muted-foreground">{stageLabel}</span>
      <span className="shrink-0 font-mono text-muted-foreground">
        {elapsed}
      </span>
    </div>
  );
}

function QueuedRow({
  count,
  next,
}: {
  count: number;
  next: TranscriptionEntry;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
      <Mic className="size-3 shrink-0" />
      <span>대기 {count}개</span>
      <span className="text-muted-foreground/70">·</span>
      <code className="min-w-0 flex-1 truncate font-mono">
        다음: {next.fileName}
      </code>
    </div>
  );
}

function TerminalRow({ entry }: { entry: TranscriptionEntry }) {
  const isOk = entry.status === 'completed';
  const Icon = isOk ? CheckCircle2 : AlertCircle;
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px]',
        isOk
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span>{isOk ? '완료' : '실패'}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-foreground/80">
        {entry.fileName}
      </code>
      {entry.durationMs != null && (
        <span className="shrink-0 font-mono text-muted-foreground">
          {formatDuration(entry.durationMs)}
        </span>
      )}
    </div>
  );
}

function useElapsedSince(iso: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return '—';
  const ms = Math.max(0, now - Date.parse(iso));
  return formatDuration(ms);
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
