/**
 * Groups editor service — provides the static-config view for the `/groups`
 * editor page. Distinct from `GroupsService` which produces the live snapshot
 * for the LivePage (currentTool/containerStatus/pendingSinceTs).
 *
 * The editor view is read-heavy and infrequently edited, so we expose it
 * via REST only — no WS frame changes.
 */

import path from 'node:path';

import type { AdditionalMount, RegisteredGroup } from '../../types.js';
import type { StateReader } from '../adapters/state-adapter.js';
import type { SkillScanner, SkillEntry } from './skill-scanner.js';
import type { SdkKind } from '../events.js';
import { isValidClaudeModel, isValidCodexModel } from '../config.js';

export type BotRole = 'main' | 'pat' | 'mat' | 'solo';

export interface GroupSessionInfo {
  sessionId: string | null;
}

export interface GroupEditorView {
  jid: string;
  name: string;
  folder: string;
  sdk: SdkKind;
  model: string | null;
  isMain: boolean;
  botRole: BotRole;
  trigger: string;
  claudeMdPath: string;
  skills: SkillEntry[];
  session: GroupSessionInfo;
  /** User-configured extra host-path mounts. Empty when none declared. */
  additionalMounts: AdditionalMount[];
  /** When the group was registered (ISO timestamp). */
  addedAt: string;
  /** Whether incoming messages need to match the trigger pattern. */
  requiresTrigger: boolean;
  /** Container turn timeout in ms. Undefined → runtime default (5 minutes). */
  containerTimeout?: number;
}

export type PatchError = 'not_found' | 'invalid_model';
export type PatchResult =
  | { ok: true; view: GroupEditorView }
  | { ok: false; error: PatchError };

/**
 * Delegate validation to the sdk-specific whitelist. Both Claude and Codex
 * now accept per-group model override (see `CLAUDE_MODEL_WHITELIST` /
 * `CODEX_MODEL_WHITELIST` in `../config.ts`). An unknown sdk falls through
 * to false, which surfaces as `invalid_model` to the caller.
 */
function isValidModelForSdk(sdk: SdkKind, model: string): boolean {
  if (sdk === 'claude') return isValidClaudeModel(model);
  if (sdk === 'codex') return isValidCodexModel(model);
  return false;
}

export interface GroupsEditorServiceDeps {
  state: StateReader;
  skills: SkillScanner;
  /**
   * Read-only snapshot of the host's in-memory session map. Passing a
   * getter (not the map itself) lets the service stay reactive if the
   * host replaces `state.sessions` (e.g. after a reset).
   */
  getSessions: () => Record<string, string>;
  /** Absolute path to `groups/` — used to build CLAUDE.md paths. */
  groupsDir: string;
  /**
   * Targeted DB UPDATE for the `model` column. Returns true when a row
   * was affected. Injected so tests can stub DB I/O.
   */
  updateGroupModel: (jid: string, model: string | null) => boolean;
  /**
   * Called after a successful DB write so `state.registeredGroups` is
   * resynced from the DB. Downstream (channels/scheduler/ipc) reads the
   * updated snapshot on its next callback invocation, so no fan-out is
   * required here.
   */
  reloadGroupState: () => void;
}

export class GroupsEditorService {
  constructor(private readonly deps: GroupsEditorServiceDeps) {}

  listForEditor(): GroupEditorView[] {
    const sessions = this.deps.getSessions();
    return this.deps.state.listRegisteredGroups().map(({ jid, group }) => {
      const sdk = (group.sdk ?? 'codex') as SdkKind;
      const isMain = group.isMain === true;
      return {
        jid,
        name: group.name,
        folder: group.folder,
        sdk,
        model: group.model ?? null,
        isMain,
        botRole: deriveBotRole(group.folder, isMain),
        trigger: group.trigger,
        claudeMdPath: path.join(this.deps.groupsDir, group.folder, 'CLAUDE.md'),
        skills: this.deps.skills.listSkillsForGroup(group.folder),
        session: {
          sessionId: sessions[group.folder] ?? null,
        },
        additionalMounts: group.containerConfig?.additionalMounts ?? [],
        addedAt: group.added_at,
        requiresTrigger: group.requiresTrigger ?? true,
        containerTimeout: group.containerConfig?.timeout,
      };
    });
  }

  /** Returns one group's editor view, or undefined if the JID is not registered. */
  getOne(jid: string): GroupEditorView | undefined {
    return this.listForEditor().find((g) => g.jid === jid);
  }

  /** Returns the RegisteredGroup for a JID, or undefined. Used by reset handler. */
  lookupGroup(jid: string): RegisteredGroup | undefined {
    return this.deps.state.listRegisteredGroups().find((e) => e.jid === jid)
      ?.group;
  }

  /**
   * Apply a model change:
   *   - 404 equivalent when the JID is unknown
   *   - 400 equivalent when the value is not in the group's sdk whitelist
   *     (Claude and Codex each have their own small whitelist; `null`
   *     always passes and falls back to the SDK default)
   * Validates, writes to DB, reloads in-memory state, and returns the
   * updated view.
   */
  patchModel(jid: string, model: string | null): PatchResult {
    const group = this.lookupGroup(jid);
    if (!group) return { ok: false, error: 'not_found' };
    const sdk = (group.sdk ?? 'codex') as SdkKind;
    if (model !== null && !isValidModelForSdk(sdk, model)) {
      return { ok: false, error: 'invalid_model' };
    }
    const changed = this.deps.updateGroupModel(jid, model);
    if (!changed) return { ok: false, error: 'not_found' };
    this.deps.reloadGroupState();
    const view = this.getOne(jid);
    // Defensive: reload should preserve the entry; if it somehow does not,
    // treat as not_found rather than returning undefined.
    if (!view) return { ok: false, error: 'not_found' };
    return { ok: true, view };
  }
}

/**
 * Derive the bot role from the folder name suffix (`feedback_group_naming_convention.md`):
 *   - isMain=true → 'main' (elevated control group)
 *   - folder ends with '_mat' → 'mat' (mat-lane bot)
 *   - folder ends with '_pat' → 'pat' (pat-lane bot)
 *   - otherwise → 'solo' (legacy groups predating the suffix convention)
 *
 * Structural signals (JID prefix) were tempting, but the user-facing
 * convention is the folder suffix — it's explicit, stable, and already
 * codified in `feedback_group_naming_convention.md`.
 */
export function deriveBotRole(folder: string, isMain: boolean): BotRole {
  if (isMain) return 'main';
  if (folder.endsWith('_mat')) return 'mat';
  if (folder.endsWith('_pat')) return 'pat';
  return 'solo';
}
