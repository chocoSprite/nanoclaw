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
 *
 * Migration notes (Claude Agent SDK → Codex SDK):
 *   - query() async iterable → Codex class + Thread.runStreamed()
 *   - MessageStream (mid-turn injection) → buffer IPC messages, pass as next turn prompt
 *   - PreCompactHook (transcript archiving) → simple appendConversationArchive()
 *   - resume: sessionId → codex.resumeThread(sessionId)
 *   - mcpServers → config.mcp_servers
 *   - permissionMode: 'bypassPermissions' → approvalPolicy: 'never'
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
 * Build instructions from CLAUDE.md files.
 * Group-level CLAUDE.md is the primary instruction source.
 * Non-main groups also get global CLAUDE.md appended.
 *
 * Note: We read CLAUDE.md explicitly rather than relying on Codex SDK's
 * auto-discovery (project_doc_fallback_filenames) because:
 * 1. We need to merge group + global instructions
 * 2. SDK auto-discovery behavior may vary by version
 */
function buildInstructions(containerInput: ContainerInput): string {
  const parts: string[] = [];

  // Group-level instructions
  const groupPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupPath)) {
    parts.push(fs.readFileSync(groupPath, 'utf-8'));
  }

  // Global instructions (non-main groups only)
  if (!containerInput.isMain) {
    const globalPath = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalPath)) {
      parts.push(fs.readFileSync(globalPath, 'utf-8'));
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Discover additional directories mounted at /workspace/extra/*
 * These provide extra context (e.g. shared repos, docs) to the agent.
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
 * Replaces Claude SDK's PreCompactHook-based transcript archiving.
 * Simpler but functionally equivalent — archives each turn as it completes.
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
 * Returns messages found, or empty array.
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
 *
 * Key difference from Claude SDK version:
 * - Claude SDK used MessageStream (async iterable) to inject IPC messages mid-turn
 * - Codex SDK does NOT support mid-turn message injection
 * - Instead: IPC messages arriving during a turn are buffered and become the next turn's prompt
 * - Close sentinel during a turn triggers abort via AbortController
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
    // Note: IPC messages during active turn are consumed by drainIpcInput()
    // but since we can't inject mid-turn, they're effectively dropped here.
    // The next waitForIpcMessage() call after the turn ends picks up new messages.
    drainIpcInput();
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
            // Strip <internal>...</internal> blocks (used by NanoClaw for internal routing)
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

      // Parse last non-empty line of stdout as JSON
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

  // Build instructions from CLAUDE.md files
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

  // Build initial prompt: prepend CLAUDE.md instructions so Codex treats them
  // as part of the first user turn (config.instructions is not applied as a
  // system prompt by the Codex CLI).
  let prompt = instructions
    ? `[SYSTEM INSTRUCTIONS — follow these as your core directives]\n\n${instructions}\n\n[END SYSTEM INSTRUCTIONS]\n\n${containerInput.prompt}`
    : containerInput.prompt;
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

    // Script says wake agent — enrich prompt with script data
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

      // If _close was consumed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
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
