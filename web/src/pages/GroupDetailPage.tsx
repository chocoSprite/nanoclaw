import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Bot, FileText, RotateCcw, Sparkles } from 'lucide-react';
import { fetchGroups, patchGroup, resetGroupSession } from '../lib/api';
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_LABELS,
  CODEX_DEFAULT_MODEL_DISPLAY,
  CODEX_MODELS,
  CODEX_MODEL_LABELS,
  type BotRole,
  type GroupEditorView,
  type SdkKind,
  type SessionResetResult,
} from '../contracts';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../lib/utils';

const ROLE_LABEL: Record<BotRole, string> = {
  main: '메인',
  pat: '패트',
  mat: '매트',
  solo: '단독',
};

const ROLE_VARIANT: Record<BotRole, 'default' | 'pat' | 'mat' | 'muted'> = {
  main: 'default',
  pat: 'pat',
  mat: 'mat',
  solo: 'muted',
};

/**
 * Groups detail — full editor for a single registered group. Reads from
 * the same ['groups', 'editor'] query cache the list uses, so navigating
 * back and forth is instantaneous.
 */
export function GroupDetailPage() {
  const { jid: jidParam } = useParams<{ jid: string }>();
  const jid = jidParam ? decodeURIComponent(jidParam) : '';
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['groups', 'editor'],
    queryFn: fetchGroups,
    refetchInterval: 15_000,
  });

  const group = query.data?.find((g) => g.jid === jid);

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <BackLink />
        {query.isLoading && !group ? (
          <Skeleton className="h-[420px] w-full" />
        ) : !group ? (
          <NotFoundCard
            jid={jid}
            onRetry={() => query.refetch()}
            onBack={() => navigate('/groups')}
          />
        ) : (
          <GroupDetail group={group} />
        )}
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/groups"
      className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      그룹 목록으로
    </Link>
  );
}

function GroupDetail({ group }: { group: GroupEditorView }) {
  const qc = useQueryClient();
  const SdkIcon = group.sdk === 'claude' ? Sparkles : Bot;
  const [resetOpen, setResetOpen] = useState(false);
  const [resetResult, setResetResult] = useState<SessionResetResult | null>(
    null,
  );

  const modelMutation = useMutation({
    mutationFn: (model: string | null) => patchGroup(group.jid, { model }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups', 'editor'] }),
  });

  const resetMutation = useMutation({
    mutationFn: () => resetGroupSession(group.jid),
    onSuccess: (result) => {
      setResetResult(result);
      qc.invalidateQueries({ queryKey: ['groups', 'editor'] });
    },
  });

  return (
    <>
      <Card>
        <CardHeader className="gap-3 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold">{group.name}</h1>
              <code className="block truncate font-mono text-xs text-muted-foreground">
                {group.folder}
              </code>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Badge variant={group.sdk === 'claude' ? 'info' : 'warning'}>
                <SdkIcon className="size-3" />
                {group.sdk}
              </Badge>
              <Badge variant={ROLE_VARIANT[group.botRole]}>
                {ROLE_LABEL[group.botRole]}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {/* Identity */}
          <Section title="식별">
            <KV label="JID">
              <code className="font-mono text-xs">{group.jid}</code>
            </KV>
            <KV label="트리거">
              <code className="font-mono text-xs">{group.trigger}</code>
            </KV>
            {group.isMain && (
              <KV label="메인 그룹">
                <span className="text-xs">
                  elevated privileges · 트리거 없이 메시지 수신
                </span>
              </KV>
            )}
          </Section>

          {/* Model */}
          <Section title="모델">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {group.sdk === 'claude'
                  ? 'Claude SDK 모델 선택'
                  : 'Codex SDK 모델 선택'}
              </span>
              <ModelSelect
                sdk={group.sdk}
                value={group.model}
                disabled={modelMutation.isPending}
                onChange={(next) => modelMutation.mutate(next)}
              />
            </div>
            {modelMutation.isError && (
              <div className="mt-1 text-[11px] text-destructive">
                모델 저장 실패 — 다시 시도해주세요
              </div>
            )}
          </Section>

          {/* Files */}
          <Section title="파일">
            <KV label="CLAUDE.md">
              <div className="flex items-start gap-1.5">
                <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <code className="break-all font-mono text-[11px]">
                  {group.claudeMdPath}
                </code>
              </div>
            </KV>
          </Section>

          {/* Skills */}
          <Section
            title={`스킬 · ${group.skills.length}개`}
            hint="컨테이너가 보는 디렉토리 (읽기 전용)"
          >
            <div className="flex flex-wrap gap-1">
              {group.skills.length === 0 ? (
                <span className="text-[11px] italic text-muted-foreground">
                  없음
                </span>
              ) : (
                group.skills.map((s) => (
                  <Badge
                    key={`${s.origin}:${s.name}`}
                    variant={s.origin === 'group' ? 'info' : 'muted'}
                    className="text-[10px]"
                  >
                    {s.name}
                    {s.origin === 'group' && (
                      <span className="ml-0.5 text-[9px] opacity-70">
                        (그룹)
                      </span>
                    )}
                  </Badge>
                ))
              )}
            </div>
          </Section>

          {/* Session */}
          <Section title="세션">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs">
                {group.session.sessionId ? (
                  <>
                    <span className="text-muted-foreground">활성 · </span>
                    <code className="font-mono">{group.session.sessionId}</code>
                  </>
                ) : (
                  <span className="italic text-muted-foreground">없음</span>
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setResetResult(null);
                  setResetOpen(true);
                }}
                disabled={resetMutation.isPending}
              >
                <RotateCcw className="size-3.5" />
                세션 리셋
              </Button>
            </div>
          </Section>
        </CardContent>
      </Card>

      <Dialog
        open={resetOpen}
        onClose={() => {
          if (!resetMutation.isPending) {
            setResetOpen(false);
            setResetResult(null);
            resetMutation.reset();
          }
        }}
        title={`세션 초기화: ${group.name}`}
        description={
          <span>
            이 그룹의 컨테이너 · 세션 파일 · DB 세션 레코드를 삭제합니다. 메모리
            · CLAUDE.md · 스킬은 보존됩니다.
          </span>
        }
        impact={
          <div className="flex flex-col gap-1">
            <div>
              <span className="text-muted-foreground">영향 범위 · </span>
              <code className="font-mono">{group.folder}</code>
              <span className="text-muted-foreground"> 의 </span>
              <span className="font-semibold">{group.sdk}</span>
              <span className="text-muted-foreground"> 세션</span>
            </div>
            {resetResult && (
              <div className="mt-1 border-t border-border/50 pt-1.5">
                {resetResult.errors.length === 0 ? (
                  <div className="text-success">✓ 초기화 완료</div>
                ) : (
                  <div className="text-warning">
                    부분 성공: {resetResult.errors.join(', ')}
                  </div>
                )}
              </div>
            )}
            {resetMutation.isError && !resetResult && (
              <div className="mt-1 text-destructive">
                실패: {String(resetMutation.error)}
              </div>
            )}
          </div>
        }
        confirmLabel={resetResult ? '닫기' : '초기화'}
        confirmVariant={resetResult ? 'default' : 'destructive'}
        busy={resetMutation.isPending}
        onConfirm={() => {
          if (resetResult) {
            setResetOpen(false);
            setResetResult(null);
            resetMutation.reset();
            return;
          }
          resetMutation.mutate();
        }}
      />
    </>
  );
}

function ModelSelect({
  sdk,
  value,
  disabled,
  onChange,
}: {
  sdk: SdkKind;
  value: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  const { options, labels, defaultHint } =
    sdk === 'claude'
      ? {
          options: CLAUDE_MODELS as readonly string[],
          labels: CLAUDE_MODEL_LABELS as Record<string, string>,
          defaultHint: 'SDK 기본값',
        }
      : {
          options: CODEX_MODELS as readonly string[],
          labels: CODEX_MODEL_LABELS as Record<string, string>,
          defaultHint: `기본값: ${CODEX_DEFAULT_MODEL_DISPLAY}`,
        };
  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === '' ? null : v);
      }}
      disabled={disabled}
      className={cn(
        'rounded-md border border-border bg-background px-2 py-1 text-xs',
        'min-w-[12rem]',
        disabled && 'opacity-60',
      )}
    >
      <option value="">({defaultHint})</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {labels[m]}
        </option>
      ))}
    </select>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {hint && (
          <span className="text-[10px] text-muted-foreground/70">{hint}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-start gap-2">
      <span className="pt-0.5 text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function NotFoundCard({
  jid,
  onRetry,
  onBack,
}: {
  jid: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-sm font-medium">그룹을 찾을 수 없습니다</div>
        <code className="font-mono text-[11px] text-muted-foreground">
          {jid}
        </code>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            다시 로드
          </Button>
          <Button type="button" size="sm" onClick={onBack}>
            목록으로
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
