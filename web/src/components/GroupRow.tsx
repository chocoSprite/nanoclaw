import { NavLink } from 'react-router-dom';
import { Bot, ChevronRight, Sparkles } from 'lucide-react';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';
import {
  CLAUDE_MODEL_LABELS,
  CODEX_DEFAULT_MODEL_DISPLAY,
  type BotRole,
  type ClaudeModelId,
  type GroupEditorView,
} from '../contracts';

interface Props {
  group: GroupEditorView;
}

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

export function GroupRow({ group }: Props) {
  const SdkIcon = group.sdk === 'claude' ? Sparkles : Bot;
  const hasSession = group.session.sessionId != null;
  const modelLabel =
    group.model && (group.model as string) in CLAUDE_MODEL_LABELS
      ? CLAUDE_MODEL_LABELS[group.model as ClaudeModelId]
      : group.model;

  return (
    <NavLink
      to={`/groups/${encodeURIComponent(group.jid)}`}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-sm transition-colors',
          'hover:bg-accent/40',
          isActive && 'bg-accent/60',
        )
      }
    >
      <span
        className={cn(
          'inline-block size-2 shrink-0 rounded-full',
          hasSession ? 'bg-success' : 'bg-muted-foreground/40',
        )}
        aria-label={hasSession ? '활성 세션' : '세션 없음'}
        title={hasSession ? '활성 세션' : '세션 없음'}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{group.name}</span>
          <Badge variant={ROLE_VARIANT[group.botRole]} className="text-[10px]">
            {ROLE_LABEL[group.botRole]}
          </Badge>
        </div>
        <code className="truncate font-mono text-[11px] text-muted-foreground">
          {group.folder}
        </code>
      </div>

      <Badge variant={group.sdk === 'claude' ? 'info' : 'warning'}>
        <SdkIcon className="size-3" />
        {group.sdk}
      </Badge>

      <span className="hidden min-w-[6.5rem] shrink-0 text-right font-mono text-[11px] text-muted-foreground sm:inline">
        {group.sdk === 'claude'
          ? (modelLabel ?? '기본')
          : CODEX_DEFAULT_MODEL_DISPLAY}
      </span>

      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </NavLink>
  );
}
