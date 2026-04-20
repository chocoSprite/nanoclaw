import { NavLink } from 'react-router-dom';
import {
  Activity,
  CalendarClock,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';

export interface NavItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  disabled?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    to: '/live',
    label: 'Live',
    description: '실시간 그룹 상태',
    icon: Activity,
  },
  {
    to: '/automation',
    label: 'Automation',
    description: '예약 작업 · cron',
    icon: CalendarClock,
  },
  {
    to: '/logs',
    label: 'Logs',
    description: '실시간 로그',
    icon: ScrollText,
  },
];

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  return (
    <nav className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center gap-2 px-2 py-1">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">
          N
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold">NanoClaw</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Dashboard
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavItemLink key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="mt-auto px-2 pb-2 pt-3 text-[10px] text-muted-foreground">
        v{(import.meta.env.VITE_APP_VERSION as string) || '0.1'} · P0 β
      </div>
    </nav>
  );
}

function NavItemLink({
  item,
  onNavigate,
}: {
  item: NavItem;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  if (item.disabled) {
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm',
          'text-muted-foreground opacity-60',
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          soon
        </span>
      </div>
    );
  }
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
          isActive
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
    </NavLink>
  );
}
