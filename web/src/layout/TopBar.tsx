import { useLocation } from 'react-router-dom';
import { Bell, Menu } from 'lucide-react';
import { Dropdown, DropdownItem } from '../components/ui/dropdown';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { useWsStatus } from '../lib/live-store';
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

function NotificationBell() {
  // P1 placeholder. For now the dropdown is empty — no alert detection yet.
  // The slot itself exists so adding probes later only touches this content.
  const count = 0;

  return (
    <Dropdown
      trigger={
        <span className="relative inline-flex size-11 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <Bell className="size-5" />
          {count > 0 && (
            <span className="absolute right-2 top-2 size-2 rounded-full bg-destructive" />
          )}
        </span>
      }
    >
      <div className="px-3 py-2 text-xs font-semibold text-muted-foreground">
        알림
      </div>
      {count === 0 ? (
        <div className="px-3 pb-3 pt-1 text-sm text-muted-foreground">
          이상 없음 — 모든 그룹 정상
        </div>
      ) : (
        <DropdownItem>n건</DropdownItem>
      )}
    </Dropdown>
  );
}
