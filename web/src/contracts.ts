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

export type AgentEventV1 =
  | StatusStartedEvent
  | StatusEndedEvent
  | ContainerSpawnedEvent
  | ContainerExitedEvent
  | ToolUseEvent
  | ToolResultEvent;

export type WsMessage =
  | { type: 'snapshot'; groups: LiveGroupState[] }
  | { type: 'event'; event: AgentEventV1 }
  | { type: 'roster'; groups: RegisteredGroupLite[] };
