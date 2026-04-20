import type {
  LiveGroupState,
  LogEntry,
  LogLevel,
  LogSignal,
  ScheduledTaskDto,
  TaskRunLogDto,
} from '../contracts';

/**
 * Typed fetchers for the dashboard REST surface. Vite dev server proxies
 * `/api` → `http://localhost:3030`; production serves from the same origin.
 */

interface HealthResponse {
  v: 1;
  ok: boolean;
}

interface GroupsLiveResponse {
  v: 1;
  groups: LiveGroupState[];
}

interface TasksResponse {
  v: 1;
  tasks: ScheduledTaskDto[];
}

interface TaskRunsResponse {
  v: 1;
  runs: TaskRunLogDto[];
}

interface TaskMutationResponse {
  v: 1;
  ok: boolean;
  task?: ScheduledTaskDto;
  error?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function mutate<T>(path: string, method: 'POST' | 'DELETE'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>('/api/health');
}

export function fetchLiveGroups(): Promise<LiveGroupState[]> {
  return getJson<GroupsLiveResponse>('/api/groups/live').then((r) => r.groups);
}

export function fetchTasks(): Promise<ScheduledTaskDto[]> {
  return getJson<TasksResponse>('/api/automation/tasks').then((r) => r.tasks);
}

export function fetchTaskRuns(
  id: string,
  limit: number = 10,
): Promise<TaskRunLogDto[]> {
  return getJson<TaskRunsResponse>(
    `/api/automation/tasks/${encodeURIComponent(id)}/runs?limit=${limit}`,
  ).then((r) => r.runs);
}

export function pauseTask(id: string): Promise<TaskMutationResponse> {
  return mutate<TaskMutationResponse>(
    `/api/automation/tasks/${encodeURIComponent(id)}/pause`,
    'POST',
  );
}

export function resumeTask(id: string): Promise<TaskMutationResponse> {
  return mutate<TaskMutationResponse>(
    `/api/automation/tasks/${encodeURIComponent(id)}/resume`,
    'POST',
  );
}

export function triggerTask(id: string): Promise<TaskMutationResponse> {
  return mutate<TaskMutationResponse>(
    `/api/automation/tasks/${encodeURIComponent(id)}/trigger`,
    'POST',
  );
}

export function deleteTask(id: string): Promise<TaskMutationResponse> {
  return mutate<TaskMutationResponse>(
    `/api/automation/tasks/${encodeURIComponent(id)}`,
    'DELETE',
  );
}

interface LogsResponse {
  v: 1;
  entries: LogEntry[];
}

export interface LogsFilterQuery {
  level?: LogLevel;
  group?: string;
  search?: string;
  limit?: number;
}

export function fetchLogs(q: LogsFilterQuery = {}): Promise<LogEntry[]> {
  const params = new URLSearchParams();
  if (q.level) params.set('level', q.level);
  if (q.group) params.set('group', q.group);
  if (q.search) params.set('search', q.search);
  if (q.limit) params.set('limit', String(q.limit));
  const qs = params.toString();
  const path = qs ? `/api/logs/recent?${qs}` : '/api/logs/recent';
  return getJson<LogsResponse>(path).then((r) => r.entries);
}

// --- Log signals ---

interface SignalsResponse {
  v: 1;
  signals: LogSignal[];
}

interface SignalDismissResponse {
  v: 1;
  ok: boolean;
  signal?: LogSignal;
  error?: string;
}

export function fetchSignals(
  status: 'active' | 'resolved' | 'all' = 'active',
): Promise<LogSignal[]> {
  return getJson<SignalsResponse>(`/api/logs/signals?status=${status}`).then(
    (r) => r.signals,
  );
}

export function dismissSignal(id: number): Promise<LogSignal | undefined> {
  return mutate<SignalDismissResponse>(
    `/api/logs/signals/${id}/dismiss`,
    'POST',
  ).then((r) => r.signal);
}
