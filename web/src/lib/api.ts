import type { LiveGroupState } from '../contracts';

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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>('/api/health');
}

export function fetchLiveGroups(): Promise<LiveGroupState[]> {
  return getJson<GroupsLiveResponse>('/api/groups/live').then((r) => r.groups);
}
