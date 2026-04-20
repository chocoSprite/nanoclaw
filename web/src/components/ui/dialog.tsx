import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';

/**
 * Minimal confirmation Dialog without Radix dependency. Used for destructive /
 * important actions (Delete / Trigger Now etc.) per the user's preference —
 * browser confirm() is not acceptable because it can't carry context and
 * looks out of place on mobile Safari (Tailnet is the primary access path).
 *
 * Not a full a11y-complete modal (no focus trap). Sufficient for
 * single-user Tailnet-only dashboard; upgrade to Radix if we ever expose
 * the dashboard to broader audiences.
 */

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  impact?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: 'default' | 'destructive';
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  impact,
  confirmLabel = '실행',
  confirmVariant = 'default',
  onConfirm,
  busy = false,
  className,
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, busy, onClose]);

  return (
    <div
      aria-hidden={!open}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <button
        type="button"
        aria-label="닫기"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={cn(
          'relative flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-xl transition-transform duration-150',
          open ? 'translate-y-0 scale-100' : 'translate-y-2 scale-95',
          className,
        )}
      >
        <div className="flex flex-col gap-1.5">
          <h2 id="dialog-title" className="text-base font-semibold">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>

        {impact && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
            {impact}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            취소
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            size="sm"
            onClick={() => {
              void onConfirm();
            }}
            disabled={busy}
          >
            {busy ? '실행중…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
