/**
 * Agent event bus — in-process pub/sub shared between host-side producers
 * (container-runner) and dashboard consumers. Defined outside src/dashboard/
 * so the bus survives `rm -rf src/dashboard/` (see CLAUDE.md plan invariant).
 */

export const EVENT_SCHEMA_VERSION = 1 as const;

export interface BaseEvent {
  v: 1;
  kind: string;
  ts: string; // ISO 8601
  groupFolder: string;
  chatJid?: string;
}

export interface StatusStartedEvent extends BaseEvent {
  kind: 'status.started';
  sdk: 'claude' | 'codex';
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

export type AgentEventKind = AgentEventV1['kind'];

type Listener<K extends AgentEventKind | '*'> = K extends '*'
  ? (ev: AgentEventV1) => void
  : (ev: Extract<AgentEventV1, { kind: K }>) => void;

export interface AgentEventBus {
  emit(ev: AgentEventV1): void;
  on<K extends AgentEventKind | '*'>(kind: K, fn: Listener<K>): () => void;
}

/**
 * Minimal in-process bus. No buffering — listeners registered after an emit
 * do not replay. Throws are swallowed per listener so one bad subscriber
 * cannot poison others (dashboard isolation).
 */
export class InProcessEventBus implements AgentEventBus {
  private readonly listeners = new Map<
    AgentEventKind | '*',
    Set<(ev: AgentEventV1) => void>
  >();

  emit(ev: AgentEventV1): void {
    this.dispatch(ev.kind, ev);
    this.dispatch('*', ev);
  }

  on<K extends AgentEventKind | '*'>(kind: K, fn: Listener<K>): () => void {
    const bucket = this.listeners.get(kind) ?? new Set();
    const wrapped = fn as (ev: AgentEventV1) => void;
    bucket.add(wrapped);
    this.listeners.set(kind, bucket);
    return () => {
      const current = this.listeners.get(kind);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) this.listeners.delete(kind);
    };
  }

  listenerCount(kind?: AgentEventKind | '*'): number {
    if (kind) return this.listeners.get(kind)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  private dispatch(kind: AgentEventKind | '*', ev: AgentEventV1): void {
    const bucket = this.listeners.get(kind);
    if (!bucket) return;
    for (const fn of bucket) {
      try {
        fn(ev);
      } catch (err) {
        // Swallow — listener faults must not affect other subscribers or
        // the host. Caller uses logger in production code; here we cannot
        // depend on logger (would create import cycle via dashboard).
        process.stderr.write(
          `[agent-events] listener threw for kind=${kind}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}

export const agentEvents: AgentEventBus = new InProcessEventBus();
