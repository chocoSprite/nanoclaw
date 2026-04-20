import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ScrollText, X } from 'lucide-react';
import { dismissSignal, fetchLogs } from '../lib/api';
import { signalsStore, useSignalById } from '../lib/signals-store';
import { WsClient } from '../lib/ws-client';
import type { LogEntry, LogLevel, LogSignal, LogSignalKind } from '../contracts';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../lib/utils';

/**
 * Logs — structured JSON log viewer. Hydrates from /api/logs/recent then
 * attaches a WebSocket subscriber; new entries append to the end.
 *
 * The filter bar is client-authoritative for now — server returns the
 * requested window on refetch, but live frames come un-filtered and we apply
 * the filter in-memory. Good enough for tail-style browsing.
 */

const MAX_ENTRIES = 500;
const HYDRATE_LIMIT = 200;

export function LogsPage() {
  const [searchParams] = useSearchParams();
  const signalIdParam = searchParams.get('signalId');
  const signalId = signalIdParam ? Number.parseInt(signalIdParam, 10) : null;
  const focusedSignal = useSignalById(
    Number.isFinite(signalId) ? signalId : null,
  );

  const [level, setLevel] = useState<'' | LogLevel>('');
  const [group, setGroup] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [signalDetail, setSignalDetail] = useState<LogSignal | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // When navigating in via ?signalId=, auto-prime the group filter once so
  // the tail narrows to the signal's group. null groupFolder (upstream_outage)
  // sets no filter — operator sees the global error stream.
  useEffect(() => {
    if (!focusedSignal) return;
    if (focusedSignal.groupFolder) {
      setGroup(focusedSignal.groupFolder);
    }
    setLevel('error');
    // run once per signal id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSignal?.id]);

  // Debounce search input
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  // Re-hydrate on filter change
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchLogs({
      level: level || undefined,
      group: group || undefined,
      search: debouncedSearch || undefined,
      limit: HYDRATE_LIMIT,
    })
      .then((rows) => {
        // server returns newest-first; reverse for append-only chronological UI
        setEntries([...rows].reverse());
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, [level, group, debouncedSearch]);

  // WS live tail
  useEffect(() => {
    const client = new WsClient({
      onFrame: (msg) => {
        if (msg.type !== 'log') return;
        setEntries((prev) => {
          const next = [...prev, msg.entry];
          // Cap buffer
          if (next.length > MAX_ENTRIES)
            next.splice(0, next.length - MAX_ENTRIES);
          return next;
        });
      },
    });
    client.start();
    return () => client.stop();
  }, []);

  // Apply client-side filter to the buffer (covers WS-delivered frames)
  const visible = useMemo(() => {
    return entries.filter((e) =>
      passesFilter(e, level, group, debouncedSearch),
    );
  }, [entries, level, group, debouncedSearch]);

  // Auto-scroll
  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        {focusedSignal && (
          <SignalBanner
            signal={focusedSignal}
            onDetail={() => setSignalDetail(focusedSignal)}
          />
        )}

        <FilterBar
          level={level}
          group={group}
          search={search}
          onLevel={setLevel}
          onGroup={setGroup}
          onSearch={setSearch}
          autoScroll={autoScroll}
          onAutoScroll={setAutoScroll}
          total={visible.length}
        />

        {loading && entries.length === 0 ? (
          <LoadingSkeleton />
        ) : error && entries.length === 0 ? (
          <ErrorState message={error} />
        ) : visible.length === 0 ? (
          <EmptyState />
        ) : (
          <Card>
            <CardContent className="p-0 sm:p-0">
              <div
                ref={listRef}
                className="scrollbar-thin max-h-[70vh] overflow-auto py-2 font-mono text-[11px]"
              >
                {visible.map((e, i) => (
                  <LogRow
                    key={`${e.time}-${i}`}
                    entry={e}
                    onSelect={() => setSelected(e)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {selected && (
          <LogDetailOverlay
            entry={selected}
            onClose={() => setSelected(null)}
          />
        )}

        {signalDetail && (
          <SignalDetailOverlay
            signal={signalDetail}
            onClose={() => setSignalDetail(null)}
          />
        )}
      </div>
    </div>
  );
}

const SIGNAL_LABEL: Record<LogSignalKind, string> = {
  oauth_failure: '인증 실패 (401/403)',
  crash_loop: '크래시 루프',
  upstream_outage: '외부 API 이상 (5xx)',
};

function SignalBanner({
  signal,
  onDetail,
}: {
  signal: LogSignal;
  onDetail: () => void;
}) {
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-destructive">
              {SIGNAL_LABEL[signal.kind]}
            </span>
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              ×{signal.count}
            </Badge>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            {signal.groupFolder ?? '전역'} · {formatRange(signal.firstSeen, signal.lastSeen)}
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onDetail}>
            상세
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              signalsStore.dismissLocal(signal.id);
              void dismissSignal(signal.id);
            }}
          >
            무시
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SignalDetailOverlay({
  signal,
  onClose,
}: {
  signal: LogSignal;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="닫기"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">{SIGNAL_LABEL[signal.kind]}</span>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
          <span>{signal.groupFolder ?? '전역'}</span>
          <span>
            {formatRange(signal.firstSeen, signal.lastSeen)} · ×{signal.count}
          </span>
        </div>
        <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded-md bg-background/60 p-3 font-mono text-[11px]">
          {JSON.stringify(signal.details, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function formatRange(firstIso: string, lastIso: string): string {
  const f = new Date(Date.parse(firstIso));
  const l = new Date(Date.parse(lastIso));
  const fStr = f.toLocaleString('ko-KR');
  const lStr = l.toLocaleString('ko-KR');
  return fStr === lStr ? fStr : `${fStr} ~ ${lStr}`;
}

function passesFilter(
  e: LogEntry,
  level: '' | LogLevel,
  group: string,
  search: string,
): boolean {
  if (level) {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
    const minIdx = order.indexOf(level);
    const entIdx = order.indexOf(e.level);
    if (entIdx < minIdx) return false;
  }
  if (group && e.group !== group) return false;
  if (search) {
    const q = search.toLowerCase();
    if (
      !e.msg.toLowerCase().includes(q) &&
      !JSON.stringify(e.raw).toLowerCase().includes(q)
    ) {
      return false;
    }
  }
  return true;
}

interface FilterBarProps {
  level: '' | LogLevel;
  group: string;
  search: string;
  onLevel: (v: '' | LogLevel) => void;
  onGroup: (v: string) => void;
  onSearch: (v: string) => void;
  autoScroll: boolean;
  onAutoScroll: (v: boolean) => void;
  total: number;
}

function FilterBar({
  level,
  group,
  search,
  onLevel,
  onGroup,
  onSearch,
  autoScroll,
  onAutoScroll,
  total,
}: FilterBarProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={level}
          onChange={(e) => onLevel(e.target.value as '' | LogLevel)}
          className="h-9 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">all levels</option>
          <option value="debug">debug+</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">error+</option>
          <option value="fatal">fatal</option>
        </select>
        <input
          type="text"
          placeholder="group"
          value={group}
          onChange={(e) => onGroup(e.target.value)}
          className="h-9 w-32 rounded-md border border-border bg-background px-2 text-xs font-mono"
        />
        <input
          type="search"
          placeholder="검색"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="h-9 flex-1 min-w-[10rem] rounded-md border border-border bg-background px-2 text-xs"
        />
      </div>
      <div className="flex items-center gap-3 sm:ml-auto">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => onAutoScroll(e.target.checked)}
          />
          자동 스크롤
        </label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {total}개 표시
        </span>
      </div>
    </div>
  );
}

function LogRow({
  entry,
  onSelect,
}: {
  entry: LogEntry;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2 border-b border-border/40 px-2 py-1 text-left hover:bg-accent/30',
        entry.level === 'error' && 'text-destructive',
        entry.level === 'warn' && 'text-warning',
        entry.level === 'fatal' && 'text-destructive',
      )}
    >
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatTime(entry.time)}
      </span>
      <LevelBadge level={entry.level} />
      {entry.group && (
        <span className="shrink-0 truncate max-w-[8rem] text-muted-foreground">
          {entry.group}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{entry.msg}</span>
    </button>
  );
}

function LevelBadge({ level }: { level: LogLevel }) {
  const variant =
    level === 'error' || level === 'fatal'
      ? 'destructive'
      : level === 'warn'
        ? 'warning'
        : level === 'info'
          ? 'info'
          : 'muted';
  return (
    <Badge
      variant={variant}
      className="shrink-0 px-1 py-0 text-[9px] uppercase"
    >
      {level}
    </Badge>
  );
}

function LogDetailOverlay({
  entry,
  onClose,
}: {
  entry: LogEntry;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="닫기"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <LevelBadge level={entry.level} />
            {entry.group && (
              <span className="font-mono text-xs text-muted-foreground">
                {entry.group}
              </span>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              {new Date(entry.time).toLocaleString('ko-KR')}
            </span>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X />
          </Button>
        </div>
        <p className="font-mono text-sm">{entry.msg}</p>
        <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded-md bg-background/60 p-3 font-mono text-[11px]">
          {JSON.stringify(entry.raw, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-5" />
        ))}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <ScrollText className="size-8 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">표시할 로그가 없습니다</p>
          <p className="text-xs text-muted-foreground">
            필터 조건에 맞는 항목이 없거나, 로그가 아직 쌓이지 않았습니다.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          /api/logs/recent 호출 실패
        </p>
        <p className="text-xs text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

function formatTime(time: number): string {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
