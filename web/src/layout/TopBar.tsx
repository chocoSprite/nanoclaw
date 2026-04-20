import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  CloudOff,
  KeyRound,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Dropdown } from '../components/ui/dropdown';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { useWsStatus } from '../lib/live-store';
import {
  signalsStore,
  useActiveSignalCount,
  useActiveSignals,
} from '../lib/signals-store';
import { dismissSignal } from '../lib/api';
import type { LogSignal, LogSignalKind } from '../contracts';
import { NAV_ITEMS } from './Sidebar';
import { cn } from '../lib/utils';

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const location = useLocation();
  const wsStatus = useWsStatus();

  const currentNav = NAV_ITEMS.find((n) => location.pathname.startsWith(n.to));
  const title = currentNav?.label ?? 'Dashboard';
  const subtitle = currentNav?.description ?? '';

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onMenuClick}
        aria-label="메뉴 열기"
      >
        <Menu />
      </Button>

      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-semibold sm:text-base">
          {title}
        </span>
        {subtitle && (
          <span className="truncate text-[11px] text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>

      <WsBadge status={wsStatus} />
      <NotificationBell />
    </header>
  );
}

function WsBadge({ status }: { status: ReturnType<typeof useWsStatus> }) {
  const label: Record<typeof status, string> = {
    connecting: '접속중',
    open: 'LIVE',
    closed: '재접속',
    error: '에러',
  };
  const variant: Record<
    typeof status,
    'success' | 'warning' | 'muted' | 'destructive'
  > = {
    connecting: 'warning',
    open: 'success',
    closed: 'muted',
    error: 'destructive',
  };
  return (
    <Badge variant={variant[status]}>
      <span
        className={cn(
          'size-1.5 rounded-full bg-current',
          status === 'open' && 'animate-pulse',
        )}
      />
      {label[status]}
    </Badge>
  );
}

const KIND_ICON: Record<LogSignalKind, LucideIcon> = {
  oauth_failure: KeyRound,
  crash_loop: AlertTriangle,
  upstream_outage: CloudOff,
};

const KIND_LABEL: Record<LogSignalKind, string> = {
  oauth_failure: '인증 실패',
  crash_loop: '크래시 루프',
  upstream_outage: '외부 API 이상',
};

function NotificationBell() {
  const signals = useActiveSignals();
  const count = useActiveSignalCount();

  return (
    <Dropdown
      trigger={
        <button
          type="button"
          aria-label={count > 0 ? `알림 ${count}건` : '알림 없음'}
          className="relative inline-flex size-11 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <Bell className="size-5" />
          {count > 0 && (
            <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
              {count >= 10 ? '9+' : count}
            </span>
          )}
        </button>
      }
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold">
        <span className="text-muted-foreground">알림</span>
        {count > 0 && (
          <span className="text-[10px] text-muted-foreground">{count}건</span>
        )}
      </div>
      {count === 0 ? (
        <div className="px-3 pb-3 pt-1 text-sm text-muted-foreground">
          이상 없음 — 모든 그룹 정상
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          {signals.map((s) => (
            <SignalRow key={s.id} signal={s} />
          ))}
        </div>
      )}
    </Dropdown>
  );
}

function SignalRow({ signal }: { signal: LogSignal }) {
  const navigate = useNavigate();
  const Icon = KIND_ICON[signal.kind];
  const relative = formatRelative(signal.lastSeen);
  return (
    <div className="flex items-start gap-2 border-t border-border/60 px-3 py-2 text-sm first:border-t-0">
      <Icon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">
            {KIND_LABEL[signal.kind]}
          </span>
          {signal.count > 1 && (
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              ×{signal.count}
            </Badge>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {signal.groupFolder ?? '전역'} · {relative}
        </div>
        <button
          type="button"
          onClick={() => {
            navigate(`/logs?signalId=${signal.id}`);
          }}
          className="w-fit text-[11px] text-muted-foreground hover:text-foreground"
        >
          로그에서 보기 →
        </button>
      </div>
      <button
        type="button"
        aria-label="알림 닫기"
        onClick={(e) => {
          e.stopPropagation();
          signalsStore.dismissLocal(signal.id);
          void dismissSignal(signal.id);
        }}
        className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  if (delta < 60_000) return `${Math.round(delta / 1000)}초 전`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}분 전`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}시간 전`;
  return new Date(t).toLocaleDateString('ko-KR');
}
