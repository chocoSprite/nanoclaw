/**
 * NanoClaw Agent Runner (Dual SDK)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Supports both Codex SDK and Claude Agent SDK via adapter pattern.
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
import {
  writeOutput, log, drainIpcInput, waitForIpcMessage,
  IPC_INPUT_DIR, IPC_INPUT_CLOSE_SENTINEL,
} from './shared.js';
import type { ContainerInput } from './shared.js';
import type { SdkAdapter } from './sdk-adapter.js';

// --- Instruction loading ---

function readGroupClaudeMd(): string {
  const groupPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupPath)) {
    return fs.readFileSync(groupPath, 'utf-8');
  }
  return '';
}

function readGlobalClaudeMd(isMain: boolean): string {
  if (isMain) return '';
  const globalPath = '/workspace/global/CLAUDE.md';
  if (fs.existsSync(globalPath)) {
    return fs.readFileSync(globalPath, 'utf-8');
  }
  return '';
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

// --- Stdin reading ---

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- Script execution ---

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

// --- Adapter factory ---

async function createAdapter(sdk: 'codex' | 'claude'): Promise<SdkAdapter> {
  if (sdk === 'claude') {
    const { ClaudeAdapter } = await import('./claude-adapter.js');
    return new ClaudeAdapter();
  }
  const { CodexAdapter } = await import('./codex-adapter.js');
  return new CodexAdapter();
}

// --- Main ---

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

  const sdk = containerInput.sdk ?? 'codex';
  log(`Using SDK: ${sdk}`);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Load instructions
  const groupInstructions = readGroupClaudeMd();
  const globalInstructions = readGlobalClaudeMd(containerInput.isMain);
  const instructions = [groupInstructions, globalInstructions]
    .filter(Boolean)
    .join('\n\n---\n\n');

  const extraDirs = discoverExtraDirs();

  // Initialize adapter
  const adapter = await createAdapter(sdk);
  adapter.init({
    mcpServerPath,
    containerInput,
    instructions,
    globalInstructions,
    extraDirs,
  });

  // Prepare IPC
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (SDK-specific instruction injection)
  let prompt: string;
  if (sdk === 'codex' && instructions) {
    // Codex: prepend to first user turn (config.instructions not applied as system prompt)
    prompt = `[SYSTEM INSTRUCTIONS — follow these as your core directives]\n\n${instructions}\n\n[END SYSTEM INSTRUCTIONS]\n\n${containerInput.prompt}`;
  } else {
    // Claude: instructions handled via systemPrompt.append in the adapter
    prompt = containerInput.prompt;
  }

  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Drain pending IPC messages into initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({ status: 'success', result: null });
      return;
    }

    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let sessionId = containerInput.sessionId;
  let resumeAt: string | undefined; // Claude only: assistant UUID

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, sdk: ${sdk})...`);

      let result: Awaited<ReturnType<typeof adapter.runQuery>>;
      try {
        result = await adapter.runQuery(prompt, { sessionId, resumeAt });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sessionId && msg.includes('No conversation found')) {
          log(`Session ${sessionId} not found, retrying without resume`);
          sessionId = undefined;
          resumeAt = undefined;
          result = await adapter.runQuery(prompt, { sessionId: undefined, resumeAt: undefined });
        } else {
          throw err;
        }
      }
      if (result.newSessionId) {
        sessionId = result.newSessionId;
      }
      if (result.lastAssistantUuid) {
        resumeAt = result.lastAssistantUuid;
      }

      if (result.closedDuringQuery) {
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
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
