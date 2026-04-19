import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * cn — tailwind class name merger.
 * Combines clsx (conditional classes) + tailwind-merge (dedupes conflicting
 * utilities, e.g. `p-4 p-6` → `p-6`). Standard shadcn helper.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
