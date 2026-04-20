/**
 * Dashboard event types — re-exports the authoritative schema from
 * src/agent-events.ts plus dashboard-local types (live snapshot, WS frames).
 *
 * The WS frame types in this file mirror what web/src/contracts.ts declares;
 * keep them in sync.
 */

export {
  EVENT_SCHEMA_VERSION,
  type AgentEventBus,
  type AgentEventKind,
  type AgentEventV1,
  type AutomationTaskRunCompletedEvent,
  type AutomationTaskRunStartedEvent,
  type BaseEvent,
  type ContainerExitedEvent,
  type ContainerSpawnedEvent,
  type StatusEndedEvent,
  type StatusStartedEvent,
  type ToolResultEvent,
  type ToolUseEvent,
} from '../agent-events.js';

export type ContainerStatus = 'idle' | 'running' | 'error';
export type SdkKind = 'claude' | 'codex';

/**
 * One entry in the per-group recent tool call ring buffer. Populated from
 * `tool.use` events and updated when the matching `tool.result` arrives.
 */
export interface RecentToolCall {
  toolName: string;
  inputSummary?: string;
  at: string; // ISO 8601
  isError?: boolean;
  toolUseId?: string;
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
  /** Most recent tool calls in this session, newest-first, capped at 5. */
  recentTools: RecentToolCall[];
  /** Session id carried on the most recent `status.started` for this group. */
  sessionId: string | null;
}

export interface RegisteredGroupLite {
  jid: string;
  groupFolder: string;
  name: string;
  active: boolean;
  sdk: SdkKind;
}

import type { AgentEventV1 } from '../agent-events.js';
import type { LogEntry } from './services/logs-service.js';
import type {
  LogSignal,
  SignalChangeStatus,
} from './services/log-signals-service.js';
import type {
  BotRole,
  GroupEditorView,
  GroupSessionInfo,
} from './services/groups-editor-service.js';
import type { SkillEntry, SkillOrigin } from './services/skill-scanner.js';

export type { LogSignal, SignalChangeStatus };
export type {
  BotRole,
  GroupEditorView,
  GroupSessionInfo,
  SkillEntry,
  SkillOrigin,
};

export type WsMessage =
  | { type: 'snapshot'; groups: LiveGroupState[] }
  | { type: 'event'; event: AgentEventV1 }
  | { type: 'roster'; groups: RegisteredGroupLite[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'signal'; status: SignalChangeStatus; signal: LogSignal };
