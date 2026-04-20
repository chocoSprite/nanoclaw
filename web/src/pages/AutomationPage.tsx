import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Play,
  Pause as PauseIcon,
  Trash2,
  Zap,
  CalendarClock,
} from 'lucide-react';
import {
  fetchTasks,
  fetchTaskRuns,
  pauseTask,
  resumeTask,
  triggerTask,
  deleteTask,
} from '../lib/api';
import type { ScheduledTaskDto, TaskRunLogDto } from '../contracts';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../lib/utils';

/**
 * Automation — answers "what cron-ish jobs are registered, did they run OK?".
 * Mirror of scheduled_tasks / task_run_logs over the REST surface.
 */
export function AutomationPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['automation', 'tasks'],
    queryFn: fetchTasks,
    refetchInterval: 5_000,
  });

  const tasks = query.data ?? [];

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <Header
          total={tasks.length}
          active={tasks.filter((t) => t.status === 'active').length}
        />

        {query.isLoading && tasks.length === 0 ? (
          <LoadingSkeleton />
        ) : query.isError && tasks.length === 0 ? (
          <ErrorState onRetry={() => query.refetch()} />
        ) : tasks.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-2.5">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onMutate={() =>
                  qc.invalidateQueries({ queryKey: ['automation', 'tasks'] })
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ total, active }: { total: number; active: number }) {
  return (
    <p className="text-xs text-muted-foreground">
      {total > 0
        ? `${total}개 작업 · ${active}개 활성 · 최근 실행은 확장해서 확인`
        : '등록된 예약 작업이 없습니다'}
    </p>
  );
}

type PendingAction = 'trigger' | 'delete' | null;

function TaskRow({
  task,
  onMutate,
}: {
  task: ScheduledTaskDto;
  onMutate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<PendingAction>(null);
  const [busy, setBusy] = useState<'pause' | 'resume' | PendingAction>(null);

  const runsQuery = useQuery({
    queryKey: ['automation', 'runs', task.id],
    queryFn: () => fetchTaskRuns(task.id, 10),
    enabled: expanded,
    refetchInterval: expanded ? 5_000 : false,
  });

  const runAction = async (
    action: 'pause' | 'resume' | 'trigger' | 'delete',
  ) => {
    setBusy(action);
    try {
      if (action === 'pause') await pauseTask(task.id);
      else if (action === 'resume') await resumeTask(task.id);
      else if (action === 'trigger') await triggerTask(task.id);
      else if (action === 'delete') await deleteTask(task.id);
      onMutate();
    } catch (err) {
      console.error(`${action} failed`, err);
    } finally {
      setBusy(null);
      if (action === 'trigger' || action === 'delete') setDialog(null);
    }
  };

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-start gap-2 text-left"
          >
            <span className="mt-0.5 text-muted-foreground">
              {expanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono text-sm font-semibold">
                  {task.group_folder}
                </span>
                <StatusBadge status={task.status} />
                <Badge variant="outline" className="text-[10px] uppercase">
                  {task.schedule_type}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {task.schedule_value}
                </span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                다음: {formatNextRun(task.next_run, task.status)}
                {task.last_run && (
                  <> · 마지막: {formatRelative(task.last_run)}</>
                )}
              </div>
              <div className="line-clamp-2 text-xs text-foreground/80">
                {task.prompt}
              </div>
            </div>
          </button>

          <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 pt-3">
            {task.status === 'paused' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => runAction('resume')}
                disabled={busy !== null}
              >
                <Play />
                Resume
              </Button>
            ) : task.status === 'active' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => runAction('pause')}
                disabled={busy !== null}
              >
                <PauseIcon />
                Pause
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog('trigger')}
              disabled={busy !== null}
            >
              <Zap />
              Trigger Now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDialog('delete')}
              disabled={busy !== null}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 />
              Delete
            </Button>
          </div>

          {expanded && <RunHistory runsQuery={runsQuery} taskId={task.id} />}
        </CardContent>
      </Card>

      <Dialog
        open={dialog === 'trigger'}
        onClose={() => setDialog(null)}
        title="지금 실행"
        description={
          <>
            이 작업을 즉시 실행합니다 (예약 시간 무시). 실제 실행은 스케줄러
            polling 후 최대 30초 이내에 시작됩니다.
          </>
        }
        impact={
          <div className="flex flex-col gap-1">
            <span className="font-mono text-foreground">
              {task.group_folder}
            </span>
            <span className="line-clamp-2 text-muted-foreground">
              {task.prompt}
            </span>
          </div>
        }
        confirmLabel="지금 실행"
        confirmVariant="default"
        onConfirm={() => runAction('trigger')}
        busy={busy === 'trigger'}
      />
      <Dialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title="작업 삭제"
        description={
          <>
            이 작업이 영구 삭제됩니다. 실행 이력까지 함께 제거되며 되돌릴 수
            없습니다.
          </>
        }
        impact={
          <div className="flex flex-col gap-1">
            <span className="font-mono text-foreground">
              {task.group_folder}
            </span>
            <span className="text-muted-foreground">
              {task.schedule_type} · {task.schedule_value}
            </span>
          </div>
        }
        confirmLabel="삭제"
        confirmVariant="destructive"
        onConfirm={() => runAction('delete')}
        busy={busy === 'delete'}
      />
    </>
  );
}

function StatusBadge({ status }: { status: ScheduledTaskDto['status'] }) {
  if (status === 'active') return <Badge variant="success">active</Badge>;
  if (status === 'paused') return <Badge variant="muted">paused</Badge>;
  return <Badge variant="outline">completed</Badge>;
}

function RunHistory({
  runsQuery,
  taskId,
}: {
  runsQuery: ReturnType<typeof useQuery<TaskRunLogDto[]>>;
  taskId: string;
}) {
  if (runsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/20 p-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }
  if (runsQuery.isError) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
        실행 이력 로드 실패
      </p>
    );
  }
  const runs = runsQuery.data ?? [];
  if (runs.length === 0) {
    return (
      <p className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
        실행 이력 없음
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        최근 {runs.length}회 · taskId {taskId.slice(0, 12)}…
      </div>
      {runs.map((run, i) => (
        <RunRow key={`${run.run_at}-${i}`} run={run} />
      ))}
    </div>
  );
}

function RunRow({ run }: { run: TaskRunLogDto }) {
  const [open, setOpen] = useState(false);
  const clickable = Boolean(run.error) || Boolean(run.result);
  return (
    <div className="rounded-sm px-1.5 py-1">
      <button
        type="button"
        onClick={() => clickable && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 text-left',
          clickable ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span
          className={cn(
            'inline-block size-1.5 shrink-0 rounded-full',
            run.status === 'success' ? 'bg-success' : 'bg-destructive',
          )}
        />
        <span className="tabular-nums text-muted-foreground">
          {formatAbsShort(run.run_at)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatDuration(run.duration_ms)}
        </span>
        <span
          className={cn(
            'truncate',
            run.status === 'error' ? 'text-destructive' : 'text-foreground/80',
          )}
        >
          {run.error ?? run.result ?? run.status}
        </span>
      </button>
      {open && (run.result || run.error) && (
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-sm bg-background/60 p-2 font-mono text-[11px]">
          {run.error ?? run.result}
        </pre>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[96px]" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <CalendarClock className="size-8 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">등록된 예약 작업이 없습니다</p>
          <p className="text-xs text-muted-foreground">
            Slack 에서 "xx시마다 …" 같이 지시하면 여기 나타납니다.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm font-medium text-destructive">
          /api/automation/tasks 호출에 실패했습니다
        </p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          다시 시도
        </Button>
      </CardContent>
    </Card>
  );
}

// --- Date helpers ---

function formatNextRun(
  next: string | null,
  status: ScheduledTaskDto['status'],
) {
  if (status === 'completed') return '—';
  if (status === 'paused') return '(일시정지)';
  if (!next) return '—';
  const ts = Date.parse(next);
  if (Number.isNaN(ts)) return next;
  const delta = ts - Date.now();
  if (delta <= 0) return '대기중 (polling 기다림)';
  if (delta < 60_000) return `${Math.round(delta / 1000)}초 후`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}분 후`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}시간 후`;
  return new Date(ts).toLocaleString('ko-KR');
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  if (delta < 60_000) return `${Math.round(delta / 1000)}초 전`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}분 전`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}시간 전`;
  return new Date(t).toLocaleDateString('ko-KR');
}

function formatAbsShort(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}
