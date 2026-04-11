import { getCodexUsageSummary } from './codex-usage.js';
import { getAllTasks } from './db.js';
import type { RegisteredGroup } from './types.js';

export interface QueueStatus {
  jid: string;
  active: boolean;
  idleWaiting: boolean;
  isTask: boolean;
  pendingMessages: boolean;
  pendingTaskCount: number;
}

export interface LabDashboardDeps {
  registeredGroups: Record<string, RegisteredGroup>;
  queueStatuses: QueueStatus[];
  sessionCount: number;
  activeContainerCount: number;
  timezone: string;
}

/**
 * Build the lab dashboard message string.
 * Pure read — no side effects, no sendMessage calls.
 */
export async function buildLabDashboard(
  deps: LabDashboardDeps,
): Promise<string> {
  const {
    registeredGroups,
    queueStatuses,
    sessionCount,
    activeContainerCount,
    timezone,
  } = deps;

  const now = new Date();
  const ts = now.toLocaleString('ko-KR', { timeZone: timezone });

  // Registered groups
  const groups = Object.entries(registeredGroups);
  const statusMap = new Map(queueStatuses.map((s) => [s.jid, s]));

  const groupLines = groups.map(([jid, g]) => {
    const qs = statusMap.get(jid);
    let icon = ':white_circle:';
    let detail = '유휴';
    if (qs?.active) {
      icon = qs.isTask ? ':large_orange_circle:' : ':large_green_circle:';
      detail = qs.isTask ? `태스크 실행 중` : '에이전트 실행 중';
      if (qs.idleWaiting) {
        icon = ':large_blue_circle:';
        detail = 'idle 대기';
      }
    }
    const pending: string[] = [];
    if (qs?.pendingMessages) pending.push('메시지 대기');
    if (qs && qs.pendingTaskCount > 0)
      pending.push(`태스크 ${qs.pendingTaskCount}개 대기`);
    const suffix = pending.length > 0 ? ` (${pending.join(', ')})` : '';
    const mainTag = g.isMain ? ' :star:' : '';
    const sdkTag = g.sdk === 'claude' ? ' `Claude`' : ' `Codex`';
    return `${icon} *${g.name}*${mainTag}${sdkTag} — ${detail}${suffix}`;
  });

  // Scheduled tasks
  const tasks = getAllTasks();
  const active = tasks.filter((t) => t.status === 'active');
  const paused = tasks.filter((t) => t.status === 'paused');
  const upcoming = active
    .filter((t) => t.next_run)
    .sort((a, b) => a.next_run!.localeCompare(b.next_run!))
    .slice(0, 5);

  const taskLines = upcoming.map((t) => {
    const nextRun = t.next_run
      ? new Date(t.next_run).toLocaleString('ko-KR', { timeZone: timezone })
      : '—';
    const groupName = t.group_folder;
    let schedLabel = t.schedule_value;
    if (t.schedule_type === 'cron') {
      const parts = t.schedule_value.split(' ');
      if (parts.length >= 5) {
        const h = parts[1].padStart(2, '0');
        const m = parts[0].padStart(2, '0');
        const dayMap: Record<string, string> = {
          '1-5': '평일',
          '*': '매일',
          '0,6': '주말',
        };
        const dayPart = dayMap[parts[4]] ?? parts[4];
        schedLabel = `${dayPart} ${h}:${m}`;
      }
    }
    return `• [${groupName}] ${schedLabel} → ${nextRun}`;
  });

  // Codex usage (fetch in parallel while building the rest)
  const usagePromise = getCodexUsageSummary();

  // Build message (Slack mrkdwn)
  const lines = [
    `:bar_chart: *랩 대시보드* — ${ts}`,
    '',
    `*채널* (${groups.length}개)`,
    ...groupLines,
    '',
    `:gear: *컨테이너* ${activeContainerCount}개 실행 중 | *세션* ${sessionCount}개`,
  ];

  // Codex usage section
  const usage = await usagePromise;
  if (usage) {
    const bar = (pct: number) => {
      const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
      return '\u2588'.repeat(filled) + '\u2591'.repeat(5 - filled);
    };
    lines.push('');
    lines.push(':chart_with_upwards_trend: *Codex 사용량*');
    lines.push(
      `5h  \`${bar(usage.h5pct)}\` ${usage.h5pct}%${usage.h5reset ? ` (리셋 ${usage.h5reset})` : ''}`,
    );
    lines.push(
      `7d  \`${bar(usage.d7pct)}\` ${usage.d7pct}%${usage.d7reset ? ` (리셋 ${usage.d7reset})` : ''}`,
    );
  } else {
    lines.push('');
    lines.push(':chart_with_upwards_trend: *Codex 사용량* — 조회 실패');
  }

  lines.push('');
  lines.push(
    `:calendar: *스케줄 작업* — 활성 ${active.length} / 일시정지 ${paused.length} / 전체 ${tasks.length}`,
  );
  if (taskLines.length > 0) {
    lines.push('다음 실행 예정:');
    lines.push(...taskLines);
  }

  return lines.join('\n');
}
