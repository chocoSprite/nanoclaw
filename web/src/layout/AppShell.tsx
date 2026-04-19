import { useState, type ReactNode } from 'react';
import { Sheet } from '../components/ui/sheet';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/**
 * AppShell — desktop shows a fixed left sidebar, mobile shows a Sheet
 * drawer toggled from the top bar hamburger. Breakpoint: lg (1024px).
 * Below lg, sidebar is hidden and only accessible via Sheet.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop sidebar (fixed, persistent) */}
      <aside className="hidden w-64 shrink-0 border-r border-border lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar />
        </div>
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen} side="left">
        <Sidebar onNavigate={() => setMobileOpen(false)} />
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
