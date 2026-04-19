import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * Minimal scroll container with styled scrollbar. Not a full Radix
 * ScrollArea port — just enough for sidebar/dropdown overflow in the
 * dashboard. Falls back to native scrolling on touch devices.
 */
export const ScrollArea = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('scrollbar-thin overflow-auto', className)}
    {...props}
  >
    {children}
  </div>
));
ScrollArea.displayName = 'ScrollArea';
