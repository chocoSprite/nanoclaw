import type {
  LiveGroupState,
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
