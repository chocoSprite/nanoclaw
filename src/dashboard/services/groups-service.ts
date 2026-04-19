import type { StateReader } from '../adapters/state-adapter.js';
import type { QueueReader, QueueStatus } from '../adapters/queue-adapter.js';
import type {
  LiveGroupState,
  RegisteredGroupLite,
  ContainerStatus,
  SdkKind,
} from '../events.js';
import type { LiveStateCache } from '../live-state.js';

/**
 * Merges three inputs into the LivePage snapshot:
 *   - StateReader  : all registered groups (roster)
 *   - QueueReader  : which groups have an active container right now
 *   - LiveStateCache: per-jid currentTool/containerStatus from the event bus
 *
 * Registered groups are always present in the output; the LivePage requirement
 * is "show every group, idle ones grayed". Live cache overrides queue-derived
 * containerStatus when an event has been observed.
 */
export class GroupsService {
  constructor(
    private readonly state: StateReader,
    private readonly queue: QueueReader,
    private readonly live: LiveStateCache,
  ) {}

  listLive(): LiveGroupState[] {
    const qByJid = indexQueue(this.queue.getStatuses());
    const out: LiveGroupState[] = [];
    for (const { jid, group } of this.state.listRegisteredGroups()) {
      const live = this.live.get(jid);
      const q = qByJid.get(jid);
      const containerStatus: ContainerStatus = deriveStatus(live, q);
      out.push({
        jid,
        groupFolder: group.folder,
        name: group.name,
        currentTool: live?.currentTool ?? null,
        lastToolAt: live?.lastToolAt ?? null,
        containerStatus,
        sdk: (group.sdk ?? 'codex') as SdkKind,
      });
    }
    return out;
  }

  listRoster(): RegisteredGroupLite[] {
    const qByJid = indexQueue(this.queue.getStatuses());
    return this.state.listRegisteredGroups().map(({ jid, group }) => ({
      jid,
      groupFolder: group.folder,
      name: group.name,
      active: qByJid.get(jid)?.active ?? false,
      sdk: (group.sdk ?? 'codex') as SdkKind,
    }));
  }
}

function indexQueue(statuses: QueueStatus[]): Map<string, QueueStatus> {
  return new Map(statuses.map((s) => [s.jid, s]));
}

function deriveStatus(
  live: { containerStatus: ContainerStatus } | undefined,
  q: QueueStatus | undefined,
): ContainerStatus {
  if (live) return live.containerStatus;
  if (q?.active) return 'running';
  return 'idle';
}
