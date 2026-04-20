import { Link } from 'react-router-dom';
import { Bot, ExternalLink, Sparkles } from 'lucide-react';
import { Sheet } from './ui/sheet';
import { Badge } from './ui/badge';
import { ToolCallHistory } from './ToolCallHistory';
import { TokenGauge } from './TokenGauge';
import type { LiveGroupState } from '../contracts';

interface Props {
  group: LiveGroupState | null;
  onClose: () => void;
}

const CONTAINER_LABEL: Record<LiveGroupState['containerStatus'], string> = {
  idle: 'idle',
  running: 'running',
  error: 'error',
};

/**
 * Right-side drawer triggered from a Live card click. Shows the same live
 * snapshot as the card but with room to breathe: full tool history without
 * truncation, per-bucket token breakdown, and a jump link to the Groups
 * editor for static settings (model, skills, session reset).
 *
 * The group reference is looked up fresh from the live store by the caller,
 * so fields update in real time while the drawer is open. When the group
 * disappears from the snapshot (roster change), the caller passes null and
 * the drawer closes itself.
 */
export function SessionDetailDrawer({ group, onClose }: Props) {
  const isOpen = group != null;
  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      side="right"
      className="max-w-sm"
    >
      {group ? <DrawerBody group={group} /> : null}
    </Sheet>
  );
}

function DrawerBody({ group }: { group: LiveGroupState }) {
  const SdkIcon = group.sdk === 'claude' ? Sparkles : Bot;
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{group.name}</h2>
            <code className="block truncate font-mono text-[11px] text-muted-foreground">
              {group.groupFolder}
            </code>
          </div>
          <Badge variant={group.sdk === 'claude' ? 'info' : 'warning'}>
            <SdkIcon className="size-3" />
            {group.sdk}
          </Badge>
        </div>
        <Link
          to={`/groups/${encodeURIComponent(group.jid)}`}
          className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" />
          그룹 상세 보기
        </Link>
      </header>

      <div className="flex flex-1 flex-col gap-5 px-4 py-4">
        <Section title="현재 상태">
          <KV label="컨테이너">
            <span className="font-mono text-xs">
              {CONTAINER_LABEL[group.containerStatus]}
            </span>
          </KV>
          <KV label="현재 tool">
            {group.currentTool ? (
              <code className="break-all font-mono text-xs">
                {group.currentTool}
              </code>
            ) : (
              <span className="italic text-xs text-muted-foreground">
                없음
              </span>
            )}
          </KV>
        </Section>

        {group.recentTools.length > 0 && (
          <Section title={`최근 tool · ${group.recentTools.length}개`}>
            <ToolCallHistory
              tools={group.recentTools}
              truncate={false}
              pulseFirst={group.containerStatus === 'running'}
            />
          </Section>
        )}

        {group.lastUsage ? (
          <Section title="토큰">
            <TokenGauge
              usage={group.lastUsage}
              sdk={group.sdk}
              showBreakdown
            />
          </Section>
        ) : (
          <Section title="토큰">
            <span className="text-[11px] italic text-muted-foreground">
              턴이 완료되면 게이지가 표시됩니다
            </span>
          </Section>
        )}

        <Section title="세션 식별">
          <KV label="세션 ID">
            {group.sessionId ? (
              <code className="break-all font-mono text-[11px]">
                {group.sessionId}
              </code>
            ) : (
              <span className="italic text-xs text-muted-foreground">없음</span>
            )}
          </KV>
          <KV label="JID">
            <code className="break-all font-mono text-[11px]">{group.jid}</code>
          </KV>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function KV({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5rem_1fr] items-start gap-2">
      <span className="pt-0.5 text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
