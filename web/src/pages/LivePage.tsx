import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { fetchLiveGroups } from '../lib/api';
import { liveStore, useLiveGroups } from '../lib/live-store';
import { GroupLiveCard } from '../components/GroupLiveCard';
import { SessionDetailDrawer } from '../components/SessionDetailDrawer';
import { TranscriptionBanner } from '../components/TranscriptionBanner';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { cn } from '../lib/utils';
import type { LiveGroupState } from '../contracts';

type StatusFilter = 'all' | 'running' | 'idle' | 'error';

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: '전체',
  running: '실행중',
  idle: '대기',
  error: '에러',
};

const FILTER_ORDER: StatusFilter[] = ['all', 'running', 'idle', 'error'];

/**
 * Live — the dashboard's primary view. Answers "what is every registered
 * group doing right now?" via a snapshot from /api/groups/live then
 * mutates per group on each agent event pushed over the WS hub.
 */
export function LivePage() {
  const query = useQuery({
    queryKey: ['groups', 'live'],
    queryFn: fetchLiveGroups,
  });

  useEffect(() => {
    if (query.data) liveStore.hydrate(query.data);
  }, [query.data]);

  useEffect(() => {
    liveStore.startWs();
    return () => {
      liveStore.stopWs();
    };
  }, []);

  const groups = useLiveGroups();
  const counts = useMemo(() => countByStatus(groups), [groups]);

  const [filter, setFilter] = useState<StatusFilter>('all');
  const filteredGroups = useMemo(
    () =>
      filter === 'all'
        ? groups
        : groups.filter((g) => g.containerStatus === filter),
    [groups, filter],
  );

  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  // Re-resolve the selected group on every render so the drawer picks up
  // live-store mutations; if the group has disappeared from the roster,
  // drop it so the drawer closes itself.
  const selected = selectedJid
    ? (groups.find((g) => g.jid === selectedJid) ?? null)
    : null;

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        {groups.length > 0 && (
          <StatusFilterTabs
            counts={counts}
            value={filter}
            onChange={setFilter}
          />
        )}

        <TranscriptionBanner />

        {query.isLoading && groups.length === 0 ? (
          <LoadingSkeleton />
        ) : query.isError && groups.length === 0 ? (
          <ErrorState onRetry={() => query.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : filteredGroups.length === 0 ? (
          <FilteredEmptyState filter={filter} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredGroups.map((g) => (
              <button
                key={g.jid}
                type="button"
                onClick={() => setSelectedJid(g.jid)}
                className="cursor-pointer rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GroupLiveCard group={g} />
              </button>
            ))}
          </div>
        )}
      </div>
      <SessionDetailDrawer
        group={selected}
        onClose={() => setSelectedJid(null)}
      />
    </div>
  );
}

function countByStatus(groups: LiveGroupState[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = {
    all: groups.length,
    running: 0,
    idle: 0,
    error: 0,
  };
  for (const g of groups) {
    counts[g.containerStatus] += 1;
  }
  return counts;
}

function StatusFilterTabs({
  counts,
  value,
  onChange,
}: {
  counts: Record<StatusFilter, number>;
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="컨테이너 상태 필터"
      className="flex flex-wrap items-center gap-1.5"
    >
      {FILTER_ORDER.map((key) => {
        const active = key === value;
        return (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'border-foreground/20 bg-foreground/5 text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <span>{FILTER_LABELS[key]}</span>
            <span
              className={cn(
                'tabular-nums',
                active ? 'text-foreground/80' : 'text-muted-foreground/70',
              )}
            >
              {counts[key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FilteredEmptyState({ filter }: { filter: StatusFilter }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {FILTER_LABELS[filter]} 상태의 그룹이 없습니다
        </p>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-[118px]" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <Inbox className="size-8 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">등록된 그룹이 없습니다</p>
          <p className="text-xs text-muted-foreground">
            Slack 채널에 봇을 초대하고 등록 트리거를 실행하면 여기 나타납니다.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          /api/groups/live 호출에 실패했습니다
        </p>
        <p className="text-xs text-muted-foreground">
          서버가 떠 있는지 확인해주세요
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          다시 시도
        </Button>
      </CardContent>
    </Card>
  );
}
