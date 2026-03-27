/**
 * NanoClaw Agent Runner (Codex Edition)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per turn).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Build instructions from AGENTS.md (with CLAUDE.md fallback).
 * Non-main groups also get global instructions.
 */
function buildInstructions(containerInput: ContainerInput): string {
  const parts: string[] = [];

  // Group-level instructions
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const p = `/workspace/group/${name}`;
    if (fs.existsSync(p)) {
      parts.push(fs.readFileSync(p, 'utf-8'));
      break;
    }
  }

  // Global instructions (non-main only)
  if (!containerInput.isMain) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const p = `/workspace/global/${name}`;
      if (fs.existsSync(p)) {
        parts.push(fs.readFileSync(p, 'utf-8'));
        break;
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Discover additional directories mounted at /workspace/extra/*
 */
function discoverExtraDirs(): string[] {
  const extraBase = '/workspace/extra';
  const dirs: string[] = [];
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        dirs.push(fullPath);
      }
    }
  }
  if (dirs.length > 0) {
    log(`Additional directories: ${dirs.join(', ')}`);
  }
  return dirs;
}

/**
 * Append a conversation turn to the archive file.
 */
function appendConversationArchive(prompt: string, result: string | null, assistantName?: string): void {
  if (!result) return;

  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}-conversation.md`;
  const filePath = path.join(conversationsDir, filename);

  const sender = assistantName || 'Assistant';
  const timestamp = new Date().toLocaleString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const entry = [
    `**User** (${timestamp}): ${prompt.length > 500 ? prompt.slice(0, 500) + '...' : prompt}`,
    '',
    `**${sender}**: ${result.length > 2000 ? result.slice(0, 2000) + '...' : result}`,
    '',
    '---',
    '',
  ].join('\n');

  fs.appendFileSync(filePath, entry);
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query turn and stream results via writeOutput.
 * Buffers IPC follow-up messages during active turn (Codex TS SDK
 * does not support mid-turn injection like Claude's MessageStream).
 */
async function runQuery(
  prompt: string,
  thread: Thread,
  containerInput: ContainerInput,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean }> {
  // Set up IPC polling + abort controller
  const abortController = new AbortController();
  let closedDuringQuery = false;
  let ipcPolling = true;

  const pollIpc = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, aborting turn');
      closedDuringQuery = true;
      abortController.abort();
      ipcPolling = false;
      return;
    }
    // Buffer follow-up messages — they'll become the next turn's prompt
    // (Codex TS SDK doesn't support mid-turn injection)
    drainIpcInput(); // messages are consumed but buffered implicitly by next waitForIpcMessage
    setTimeout(pollIpc, IPC_POLL_MS);
  };
  setTimeout(pollIpc, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let resultCount = 0;

  try {
    const { events } = await thread.runStreamed(prompt, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          newSessionId = (event as { thread_id: string }).thread_id;
          log(`Thread initialized: ${newSessionId}`);
          break;

        case 'item.completed': {
          const item = (event as { item: { type: string; text?: string; message?: string } }).item;
          if (item.type === 'agent_message' && item.text) {
            resultCount++;
            const text = item.text.trim();
            // Strip <internal>...</internal> blocks
            const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            log(`Result #${resultCount}: ${cleaned.slice(0, 200)}`);
            if (cleaned) {
              resultText = cleaned;
              writeOutput({
                status: 'success',
                result: cleaned,
                newSessionId,
              });
            }
          }
          if (item.type === 'error') {
            log(`Item error: ${item.message || 'unknown'}`);
          }
          break;
        }

        case 'turn.failed': {
          const error = (event as { error: { message: string } }).error;
          log(`Turn failed: ${error.message}`);
          throw new Error(error.message);
        }

        case 'error': {
          const msg = (event as { message: string }).message;
          log(`Stream error: ${msg}`);
          throw new Error(msg);
        }
      }
    }
  } catch (err) {
    if (closedDuringQuery && (err as Error).name === 'AbortError') {
      log('Turn aborted by close sentinel');
    } else {
      throw err;
    }
  } finally {
    ipcPolling = false;
  }

  // Archive conversation turn
  appendConversationArchive(prompt, resultText, containerInput.assistantName);

  log(`Query done. Results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Build instructions from AGENTS.md / CLAUDE.md
  const instructions = buildInstructions(containerInput);

  // Initialize Codex with MCP server and instructions
  const codex = new Codex({
    config: {
      mcp_servers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      instructions,
    },
  });

  const threadOpts = {
    workingDirectory: '/workspace/group' as const,
    skipGitRepoCheck: true,
    approvalPolicy: 'never' as const,
    sandboxMode: 'danger-full-access' as const,
    networkAccessEnabled: true,
    webSearchEnabled: true,
    additionalDirectories: discoverExtraDirs(),
  };

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Create or resume thread
  let thread: Thread;
  if (sessionId) {
    try {
      thread = codex.resumeThread(sessionId, threadOpts);
      log(`Resuming thread: ${sessionId}`);
    } catch (err) {
      log(`Failed to resume thread ${sessionId}, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
      thread = codex.startThread(threadOpts);
    }
  } else {
    thread = codex.startThread(threadOpts);
    log('Starting new thread');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, thread, containerInput);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
