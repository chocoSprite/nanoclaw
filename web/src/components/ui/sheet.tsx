import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Minimal Sheet (side drawer) without Radix dependency. Enough for the
 * mobile sidebar toggle; not a full Radix Dialog port — no focus trap or
 * ARIA tree. For a personal-use dashboard that's acceptable; if we later
 * need richer behavior, swap for @radix-ui/react-dialog.
 */

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'left' | 'right';
  children: ReactNode;
  className?: string;
}

export function Sheet({
  open,
  onOpenChange,
  side = 'left',
  children,
  className,
}: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    // Lock body scroll while open
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  return (
    <div
      aria-hidden={!open}
      className={cn(
        'fixed inset-0 z-50 transition-opacity',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="닫기"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'absolute top-0 h-full w-[85%] max-w-[320px] border-border bg-card shadow-xl transition-transform duration-200',
          side === 'left'
            ? `left-0 border-r ${open ? 'translate-x-0' : '-translate-x-full'}`
            : `right-0 border-l ${open ? 'translate-x-0' : 'translate-x-full'}`,
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
