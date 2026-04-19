const DEFAULT_PORT = 3030;

export interface DashboardConfig {
  enabled: boolean;
  port: number;
}

export function dashboardConfig(): DashboardConfig {
  const enabled = process.env.DASHBOARD_ENABLED === '1';
  const raw = process.env.DASHBOARD_PORT;
  const parsed = raw ? Number(raw) : DEFAULT_PORT;
  const port =
    Number.isFinite(parsed) && parsed > 0 && parsed < 65536
      ? parsed
      : DEFAULT_PORT;
  return { enabled, port };
}
