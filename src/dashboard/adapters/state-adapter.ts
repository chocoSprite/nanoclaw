import { state } from '../../group-state.js';
import type { RegisteredGroup } from '../../types.js';

export interface RegisteredGroupEntry {
  jid: string;
  group: RegisteredGroup;
}

/**
 * Dashboard's read-only view over `state.registeredGroups`. Abstracted so the
 * dashboard never couples to the mutable host state directly and the rest of
 * the dashboard can be tested with in-memory fakes.
 */
export interface StateReader {
  listRegisteredGroups(): RegisteredGroupEntry[];
}

export class LiveStateReader implements StateReader {
  listRegisteredGroups(): RegisteredGroupEntry[] {
    return Object.entries(state.registeredGroups).map(([jid, group]) => ({
      jid,
      group,
    }));
  }
}
