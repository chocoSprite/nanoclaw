import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchLiveGroups } from '../lib/api';
import { liveStore, useLiveGroups, useWsStatus } from '../lib/live-store';
import { GroupLiveCard } from '../components/GroupLiveCard';

/**
 * P0 LivePage — answers "what is every registered group doing right now?"
 *
 * Hydration order:
 *   1. TanStack Query fetches /api/groups/live for the initial snapshot.
 *   2. WsClient opens /ws and receives a `snapshot` frame (also hydrates).
 *   3. Subsequent `event` frames mutate the store via the shared reducer.
 *
 * The WS snapshot wins if it arrives second, which is fine — same shape,
 * same data, just fresher.
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
  const wsStatus = useWsStatus();

  return (
    <div className="min-h-screen px-6 py-6">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">NanoClaw Live</h1>
          <p className="text-xs text-slate-500">
            등록된 모든 그룹의 현재 상태 — tool.use 실시간 반영
          </p>
        </div>
        <WsStatusBadge status={wsStatus} />
      </header>

      {query.isLoading && groups.length === 0 ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError && groups.length === 0 ? (
        <div className="text-sm text-rose-400">
          /api/groups/live 호출 실패 — 서버가 떠 있는지 확인
        </div>
      ) : groups.length === 0 ? (
        <div className="text-sm text-slate-500">등록된 그룹이 없음</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {groups.map((g) => (
            <GroupLiveCard key={g.jid} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function WsStatusBadge({
  status,
}: {
  status: ReturnType<typeof useWsStatus>;
}) {
  const label: Record<typeof status, string> = {
    connecting: 'connecting',
    open: 'live',
    closed: 'reconnecting',
    error: 'error',
  };
  const color: Record<typeof status, string> = {
    connecting: 'text-amber-300 border-amber-500/40',
    open: 'text-emerald-300 border-emerald-500/40',
    closed: 'text-slate-400 border-slate-600',
    error: 'text-rose-300 border-rose-500/40',
  };
  return (
    <span
      className={[
        'text-[10px] uppercase tracking-wide px-2 py-1 rounded border',
        color[status],
      ].join(' ')}
    >
      ws: {label[status]}
    </span>
  );
}
