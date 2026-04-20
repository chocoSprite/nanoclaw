import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { fetchGroups } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { GroupRow } from '../components/GroupRow';

/**
 * Groups list — thin rows, click a row to open the detail editor at
 * `/groups/:jid`. The list is read-only; edits live on the detail page.
 */
export function GroupsPage() {
  const query = useQuery({
    queryKey: ['groups', 'editor'],
    queryFn: fetchGroups,
    refetchInterval: 15_000,
  });

  const groups = query.data ?? [];

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <Header count={groups.length} />

        {query.isLoading && groups.length === 0 ? (
          <LoadingSkeleton />
        ) : query.isError && groups.length === 0 ? (
          <ErrorState onRetry={() => query.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-1.5">
            {groups.map((g) => (
              <GroupRow key={g.jid} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ count }: { count: number }) {
  return (
    <p className="text-xs text-muted-foreground">
      {count > 0
        ? `${count}개 그룹 · 행을 눌러 상세 열기`
        : '등록된 그룹이 없습니다'}
    </p>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <Boxes className="size-10 text-muted-foreground/60" />
        <div className="text-sm font-medium">그룹 없음</div>
        <div className="max-w-sm text-xs text-muted-foreground">
          Slack 에서 <code className="font-mono">/add-slack</code> 또는{' '}
          <code className="font-mono">/add-gmail</code> 스킬로 그룹을 먼저
          등록하세요.
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-sm font-medium text-destructive">로드 실패</div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          다시 시도
        </button>
      </CardContent>
    </Card>
  );
}
