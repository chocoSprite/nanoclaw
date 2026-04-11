import { execFile } from 'child_process';
import path from 'path';

import { logger } from './logger.js';

const CLEANUP_SCRIPT = path.join(process.cwd(), 'scripts', 'cleanup-sessions.sh');
const INITIAL_DELAY = 30_000; // 30 seconds after startup
const INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

function runCleanup(): void {
  execFile('bash', [CLEANUP_SCRIPT], (err, stdout, stderr) => {
    if (err) {
      logger.warn({ err }, 'Session cleanup failed');
      return;
    }
    const output = (stdout || '').trim();
    if (output && !output.includes('Nothing to clean up')) {
      logger.info({ output }, 'Session cleanup completed');
    }
  });
}

export function startSessionCleanup(): void {
  setTimeout(() => {
    runCleanup();
    setInterval(runCleanup, INTERVAL);
  }, INITIAL_DELAY);
  logger.info('Session cleanup scheduled (30s initial, 24h interval)');
}
