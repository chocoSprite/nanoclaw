import { useEffect, useState } from 'react';
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
  const running = groups.filter((g) => g.containerStatus === 'running').length;
  const total = groups.length;

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
        <p className="text-xs text-muted-foreground">
          {total > 0
            ? `${total}개 그룹 · ${running}개 동작중 · 이벤트는 WebSocket 으로 실시간 반영`
            : '등록된 그룹 없음'}
        </p>

        <TranscriptionBanner />

        {query.isLoading && groups.length === 0 ? (
          <LoadingSkeleton />
        ) : query.isError && groups.length === 0 ? (
          <ErrorState onRetry={() => query.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
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
