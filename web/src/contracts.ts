/**
 * Frontend mirror of src/dashboard/events.ts + src/agent-events.ts.
 *
 * Kept as a manual copy (not a path alias into src/) because the web workspace
 * builds independently and we don't want to couple the client tsconfig to the
 * host project. If the server schema changes, update both sides.
 */

export type ContainerStatus = 'idle' | 'running' | 'error';
export type SdkKind = 'claude' | 'codex';

export interface LiveGroupState {
  jid: string;
  groupFolder: string;
  name: string;
  currentTool: string | null;
  lastToolAt: string | null;
  containerStatus: ContainerStatus;
  sdk: SdkKind;
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

export type WsMessage =
  | { type: 'snapshot'; groups: LiveGroupState[] }
  | { type: 'event'; event: AgentEventV1 }
  | { type: 'roster'; groups: RegisteredGroupLite[] }
  | { type: 'log'; entry: LogEntry };
