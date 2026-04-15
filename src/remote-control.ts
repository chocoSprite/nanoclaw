import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup } from './types.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;
const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const STDOUT_FILE = path.join(DATA_DIR, 'remote-control.stdout');
const STDERR_FILE = path.join(DATA_DIR, 'remote-control.stderr');

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(session));
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise, clean up.
 */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    return;
  }

  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (session.pid && isProcessAlive(session.pid)) {
      activeSession = session;
      logger.info(
        { pid: session.pid, url: session.url },
        'Restored Remote Control session from previous run',
      );
    } else {
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeSession = null;
}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return STATE_FILE;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    // Verify the process is still alive
    if (isProcessAlive(activeSession.pid)) {
      return { ok: true, url: activeSession.url };
    }
    // Process died — clean up and start a new one
    activeSession = null;
    clearState();
  }

  // Redirect stdout/stderr to files so the process has no pipes to the parent.
  // This prevents SIGPIPE when NanoClaw restarts.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stdoutFd = fs.openSync(STDOUT_FILE, 'w');
  const stderrFd = fs.openSync(STDERR_FILE, 'w');

  let proc;
  try {
    proc = spawn('claude', ['remote-control', '--name', 'NanoClaw Remote'], {
      cwd,
      stdio: ['pipe', stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err: unknown) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to start: ${message}` };
  }

  // Auto-accept the "Enable Remote Control?" prompt
  if (proc.stdin) {
    proc.stdin.write('y\n');
    proc.stdin.end();
  }

  // Close FDs in the parent — the child inherited copies
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Fully detach from parent
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    return { ok: false, error: 'Failed to get process PID' };
  }

  // Poll the stdout file for the URL
  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      // Check if process died
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      // Check for URL in stdout file
      let content = '';
      try {
        content = fs.readFileSync(STDOUT_FILE, 'utf-8');
      } catch {
        // File might not have content yet
      }

      const match = content.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: new Date().toISOString(),
        };
        activeSession = session;
        saveState(session);

        logger.info(
          { url: match[0], pid, sender, chatJid },
          'Remote Control session started',
        );
        resolve({ ok: true, url: match[0] });
        return;
      }

      // Timeout check
      if (Date.now() - startTime >= URL_TIMEOUT_MS) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already dead
          }
        }
        resolve({
          ok: false,
          error: 'Timed out waiting for Remote Control URL',
        });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };

    poll();
  });
}

/**
 * High-level handler for /remote-control and /remote-control-end commands.
 * Checks isMain, dispatches to start/stop, and sends the result message.
 */
export async function handleRemoteControlCommand(
  command: '/remote-control' | '/remote-control-end',
  chatJid: string,
  cwd: string,
  deps: {
    isMainGroup: boolean;
    sender: string;
    sendMessage: (text: string) => Promise<void>;
  },
): Promise<void> {
  if (!deps.isMainGroup) {
    logger.warn(
      { chatJid, sender: deps.sender },
      'Remote control rejected: not main group',
    );
    return;
  }

  if (command === '/remote-control') {
    const result = await startRemoteControl(deps.sender, chatJid, cwd);
    if (result.ok) {
      await deps.sendMessage(result.url);
    } else {
      await deps.sendMessage(`Remote Control failed: ${result.error}`);
    }
  } else {
    const result = stopRemoteControl();
    if (result.ok) {
      await deps.sendMessage('Remote Control session ended.');
    } else {
      await deps.sendMessage(result.error);
    }
  }
}

export interface RemoteControlCommandDeps {
  registeredGroups: Record<string, RegisteredGroup>;
  cwd: string;
  sendMessage: (chatJid: string, text: string) => Promise<void>;
}

/**
 * Intercept "/remote-control" and "/remote-control-end" commands.
 * Returns true if handled (caller should stop pipeline), false otherwise.
 * isMain enforcement happens inside handleRemoteControlCommand (silently rejects non-main).
 * Dispatch is fire-and-forget; errors are logged.
 */
export function tryHandleRemoteControlCommand(
  chatJid: string,
  msg: NewMessage,
  deps: RemoteControlCommandDeps,
): boolean {
  const trimmed = msg.content.trim();
  if (trimmed !== '/remote-control' && trimmed !== '/remote-control-end') {
    return false;
  }

  handleRemoteControlCommand(
    trimmed as '/remote-control' | '/remote-control-end',
    chatJid,
    deps.cwd,
    {
      isMainGroup: deps.registeredGroups[chatJid]?.isMain === true,
      sender: msg.sender,
      sendMessage: (text) => deps.sendMessage(chatJid, text),
    },
  ).catch((err) =>
    logger.error({ err, chatJid }, 'Remote control command error'),
  );

  return true;
}

export function stopRemoteControl():
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { pid } = activeSession;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead
  }
  activeSession = null;
  clearState();
  logger.info({ pid }, 'Remote Control session stopped');
  return { ok: true };
}
