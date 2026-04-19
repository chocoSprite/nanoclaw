import { logger } from '../logger.js';

/**
 * Layer B of dashboard isolation: wraps any synchronous or async callback so
 * an exception cannot escape into the host process. Used by REST handlers,
 * WS callbacks, and bus listeners.
 */
export function runInIsolation<T>(fn: () => T, label: string): T | undefined {
  try {
    const out = fn();
    if (
      out &&
      typeof (out as unknown as Promise<unknown>).then === 'function'
    ) {
      return (out as unknown as Promise<T>).catch((err: unknown) => {
        logger.error(
          { scope: 'dashboard', label, err },
          'isolated async handler failed',
        );
        return undefined as unknown as T;
      }) as unknown as T;
    }
    return out;
  } catch (err) {
    logger.error({ scope: 'dashboard', label, err }, 'isolated handler failed');
    return undefined;
  }
}
