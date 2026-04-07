/**
 * SDK Adapter interface for dual-SDK support.
 * Each adapter owns its SDK initialization, query execution, and IPC handling.
 */

import type { ContainerInput } from './shared.js';

export interface SdkAdapter {
  /** Initialize the SDK client. Called once at startup. */
  init(options: SdkInitOptions): void;

  /**
   * Run a single query turn.
   * IPC polling is handled internally by each adapter:
   * - Codex: close sentinel only, mid-turn IPC dropped
   * - Claude: MessageStream push for mid-turn injection, close → stream.end()
   */
  runQuery(prompt: string, options: RunQueryOptions): Promise<RunQueryResult>;
}

export interface SdkInitOptions {
  mcpServerPath: string;
  containerInput: ContainerInput;
  instructions: string;        // Group + global merged (Codex: prepend to user turn)
  globalInstructions: string;  // Global CLAUDE.md only (Claude: systemPrompt.append)
  extraDirs: string[];
}

export interface RunQueryOptions {
  sessionId?: string;
  resumeAt?: string;  // Claude only: assistant UUID for granular resume
}

export interface RunQueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;  // Claude only
  resultText: string | null;
  closedDuringQuery: boolean;
}
