/**
 * Frontend mirror of src/dashboard/events.ts + src/agent-events.ts.
 *
 * Kept as a manual copy (not a path alias into src/) because the web workspace
 * builds independently and we don't want to couple the client tsconfig to the
 * host project. If the server schema changes, update both sides.
 */

export type ContainerStatus = 'idle' | 'running' | 'error';
export type SdkKind = 'claude' | 'codex';

export interface RecentToolCall {
  toolName: string;
  inputSummary?: string;
  at: string;
  isError?: boolean;
  toolUseId?: string;
}

export interface SessionUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
}

export interface LiveGroupState {
  jid: string;
  groupFolder: string;
  name: string;
  currentTool: string | null;
  lastToolAt: string | null;
  containerStatus: ContainerStatus;
  sdk: SdkKind;
  /** ms since epoch when pendingMessages flipped true on the server, null if no pending. */
  pendingSinceTs: number | null;
  recentTools: RecentToolCall[];
  sessionId: string | null;
  lastUsage: SessionUsageSnapshot | null;
}

export interface RegisteredGroupLite {
  jid: string;
  groupFolder: string;
  name: string;
  active: boolean;
  sdk: SdkKind;
}

export interface BaseEvent {
  v: 1;
  kind: string;
  ts: string;
  groupFolder: string;
  chatJid?: string;
}

export interface StatusStartedEvent extends BaseEvent {
  kind: 'status.started';
  sdk: SdkKind;
  sessionId?: string;
}
export interface StatusEndedEvent extends BaseEvent {
  kind: 'status.ended';
  outcome: 'success' | 'error';
  error?: string;
}
export interface ContainerSpawnedEvent extends BaseEvent {
  kind: 'container.spawned';
  containerName: string;
}
export interface ContainerExitedEvent extends BaseEvent {
  kind: 'container.exited';
  exitCode: number | null;
}
export interface ToolUseEvent extends BaseEvent {
  kind: 'tool.use';
  toolName: string;
  toolUseId?: string;
  inputSummary?: string;
}
export interface ToolResultEvent extends BaseEvent {
  kind: 'tool.result';
  toolUseId?: string;
  isError: boolean;
}
export interface SessionUsageEvent extends BaseEvent {
  kind: 'session.usage';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
}
export interface AutomationTaskRunStartedEvent extends BaseEvent {
  kind: 'automation.task.run_started';
  taskId: string;
}
export interface AutomationTaskRunCompletedEvent extends BaseEvent {
  kind: 'automation.task.run_completed';
  taskId: string;
  outcome: 'success' | 'error';
  durationMs: number;
  error?: string;
}

export type AgentEventV1 =
  | StatusStartedEvent
  | StatusEndedEvent
  | ContainerSpawnedEvent
  | ContainerExitedEvent
  | ToolUseEvent
  | ToolResultEvent
  | SessionUsageEvent
  | AutomationTaskRunStartedEvent
  | AutomationTaskRunCompletedEvent;

// --- Automation (REST DTOs) ---

export type TaskStatus = 'active' | 'paused' | 'completed';
export type TaskScheduleType = 'cron' | 'interval' | 'once';

export interface ScheduledTaskDto {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: TaskScheduleType;
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: TaskStatus;
  created_at: string;
}

export interface TaskRunLogDto {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Logs ---

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  levelNum: number;
  time: number;
  pid?: number;
  msg: string;
  group?: string;
  raw: Record<string, unknown>;
}

// --- Log signals (derived signals on the bell dropdown + LogsPage banner) ---

export type LogSignalKind = 'oauth_failure' | 'crash_loop' | 'upstream_outage';

export type SignalChangeStatus = 'active' | 'resolved';

export interface LogSignal {
  id: number;
  kind: LogSignalKind;
  groupFolder: string | null;
  severity: 'warn' | 'error';
  firstSeen: string;
  lastSeen: string;
  count: number;
  details: Record<string, unknown>;
  resolvedAt: string | null;
  dismissedAt: string | null;
}

// --- Transcription (host WhisperX subprocess observability) ---

export type TranscriptionStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TranscriptionEntry {
  id: string;
  audioPath: string;
  fileName: string;
  sizeBytes: number;
  status: TranscriptionStatus;
  queuePosition?: number;
  stage?: string;
  stageT?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  outputPath?: string;
}

export interface TranscriptionSnapshot {
  active: TranscriptionEntry[];
  queued: TranscriptionEntry[];
  recentTerminal: TranscriptionEntry[];
}

export type WsMessage =
  | { type: 'snapshot'; groups: LiveGroupState[] }
  | { type: 'event'; event: AgentEventV1 }
  | { type: 'roster'; groups: RegisteredGroupLite[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'signal'; status: SignalChangeStatus; signal: LogSignal }
  | { type: 'transcription'; snapshot: TranscriptionSnapshot };

// --- Groups editor (REST DTOs) ---

export type BotRole = 'main' | 'pat' | 'mat' | 'solo';
export type SkillOrigin = 'global' | 'group';

export interface SkillEntry {
  name: string;
  origin: SkillOrigin;
}

export interface GroupSessionInfo {
  sessionId: string | null;
}

/** Mirror of `src/types.ts::AdditionalMount`. */
export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

export interface GroupEditorView {
  jid: string;
  name: string;
  folder: string;
  sdk: SdkKind;
  model: string | null;
  isMain: boolean;
  botRole: BotRole;
  trigger: string;
  claudeMdPath: string;
  skills: SkillEntry[];
  session: GroupSessionInfo;
  additionalMounts: AdditionalMount[];
  addedAt: string;
  requiresTrigger: boolean;
  containerTimeout?: number;
}

export interface SessionResetResult {
  groupName: string;
  folder: string;
  sdkType: 'codex' | 'claude';
  errors: string[];
}

/**
 * Claude model IDs the dashboard editor will send. Keep in sync with
 * `src/dashboard/config.ts::CLAUDE_MODEL_WHITELIST`.
 */
export const CLAUDE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number];

export const CLAUDE_MODEL_LABELS: Record<ClaudeModelId, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

/**
 * Display-only label for Codex groups' "fall back to Codex CLI default"
 * option. Reflects what `~/.codex/config.toml` carries as the global
 * default at the time of writing. Update this constant (and the relevant
 * memory) when Codex CLI upgrades its default model.
 */
export const CODEX_DEFAULT_MODEL_DISPLAY = 'gpt-5.4';

/**
 * Codex model IDs the dashboard editor will send. Keep in sync with
 * `src/dashboard/config.ts::CODEX_MODEL_WHITELIST`.
 */
export const CODEX_MODELS = ['gpt-5.4', 'gpt-5', 'o3'] as const;

export type CodexModelId = (typeof CODEX_MODELS)[number];

export const CODEX_MODEL_LABELS: Record<CodexModelId, string> = {
  'gpt-5.4': 'GPT-5.4',
  'gpt-5': 'GPT-5',
  o3: 'o3',
};
