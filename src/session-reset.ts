import fs from 'fs';
import path from 'path';

import type { NewMessage, RegisteredGroup } from './types.js';

import { getPhysicalChannel } from './group-state.js';
import { logger } from './logger.js';

/**
 * Sentinel marker an agent includes in its final output text to request
 * automatic session reset for itself + paired-lane peers (e.g. pat's marker
 * resets both pat and mat in a 2-bot meeting-notes channel).
 *
 * Orchestrator pipeline:
 *   agent output text → stripAutoResetMarker (strip + flag)
 *                    → sendMessage (visible text, marker hidden)
 *                    → autoResetPairedLanes (after agent run completes)
 *
 * Sentinel is ASCII-safe and unlikely to appear in normal user/agent text.
 */
export const AUTO_RESET_MARKER = '<<AUTO_RESET_SESSIONS>>';

/**
 * Strip the auto-reset sentinel from agent output text and return whether
 * the marker was present. Also collapses runs of >=3 newlines that the
 * removal may leave behind.
 */
export function stripAutoResetMarker(text: string): {
  text: string;
  hasMarker: boolean;
} {
  if (!text.includes(AUTO_RESET_MARKER)) {
    return { text, hasMarker: false };
  }
  const stripped = text
    .split(AUTO_RESET_MARKER)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, hasMarker: true };
}

/**
 * Find all registered group JIDs sharing the same physical channel as `jid`.
 * For pat/mat 2-bot Slack channels this returns both lanes; for single-bot
 * channels (or unregistered JIDs) it returns just the input.
 */
export function findPairedLanes(
  jid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string[] {
  const physical = getPhysicalChannel(jid);
  return Object.keys(registeredGroups).filter(
    (other) => getPhysicalChannel(other) === physical,
  );
}

/** Dependencies injected by the orchestrator. */
export interface SessionResetDeps {
  dataDir: string;
  sessions: Record<string, string>;
  terminateGroup: (jid: string) => Promise<void>;
  deleteSession: (folder: string) => void;
}

/** Extended deps for the high-level session reset handlers. */
export interface SessionHandlerDeps extends SessionResetDeps {
  registeredGroups: Record<string, RegisteredGroup>;
  sendMessage: (chatJid: string, text: string) => Promise<void>;
}

export interface ResetResult {
  groupName: string;
  folder: string;
  sdkType: 'codex' | 'claude';
  errors: string[];
}

/**
 * Clean SDK session files on disk for a single group.
 * Codex: deletes sessions/ dir + state_5.sqlite* files.
 * Claude: deletes sessions/, backups/, .jsonl files, and subagents/ dirs
 *         but preserves memory/ directories.
 *
 * @returns Array of error descriptions (empty = success).
 */
export function cleanSdkSessionFiles(
  sdkBase: string,
  sdkType: 'codex' | 'claude',
): string[] {
  const errors: string[] = [];

  if (sdkType === 'codex') {
    // Codex: delete sessions/ dir + state_5.sqlite*
    for (const target of ['sessions']) {
      const p = path.join(sdkBase, target);
      try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
      } catch (err) {
        errors.push(`${target}: ${err}`);
      }
    }
    // Delete state_5.sqlite and WAL/SHM files
    const sdkEntries = fs.existsSync(sdkBase) ? fs.readdirSync(sdkBase) : [];
    for (const f of sdkEntries.filter((n) => n.startsWith('state_5.sqlite'))) {
      try {
        fs.unlinkSync(path.join(sdkBase, f));
      } catch (err) {
        errors.push(`${f}: ${err}`);
      }
    }
  } else {
    // Claude: delete sessions/, backups/, and project session files (preserve memory/)
    for (const dir of ['sessions', 'backups']) {
      const p = path.join(sdkBase, dir);
      try {
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
      } catch (err) {
        errors.push(`${dir}: ${err}`);
      }
    }
    // Clean projects: delete *.jsonl and subagents/ but preserve memory/
    const projectsDir = path.join(sdkBase, 'projects');
    if (fs.existsSync(projectsDir)) {
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.name === 'memory') continue; // preserve
          if (entry.isDirectory()) {
            if (entry.name === 'subagents') {
              try {
                fs.rmSync(full, { recursive: true });
              } catch (err) {
                errors.push(`subagents: ${err}`);
              }
            } else {
              walk(full);
            }
          } else if (entry.name.endsWith('.jsonl')) {
            try {
              fs.unlinkSync(full);
            } catch (err) {
              errors.push(`${entry.name}: ${err}`);
            }
          }
        }
      };
      walk(projectsDir);
    }
  }

  return errors;
}

/**
 * Reset a single group's session: terminate container, clear in-memory + DB + SDK files.
 * Preserves agent memory, auth, config, and skills.
 */
export async function resetGroupSession(
  groupJid: string,
  group: RegisteredGroup,
  deps: SessionResetDeps,
): Promise<ResetResult> {
  const sdkType = group.sdk;

  // 1. Terminate running container
  await deps.terminateGroup(groupJid);

  // 2. Clear in-memory session
  delete deps.sessions[group.folder];

  // 3. Clear DB session record
  deps.deleteSession(group.folder);

  // 4. Clean SDK session files on disk
  const sdkDirName = sdkType === 'claude' ? '.claude' : '.codex';
  const sdkBase = path.join(deps.dataDir, 'sessions', group.folder, sdkDirName);
  const errors = cleanSdkSessionFiles(sdkBase, sdkType);

  return { groupName: group.name, folder: group.folder, sdkType, errors };
}

/**
 * Match user input to a registered group.
 * Accepts: short name (agent-meeting-notes), full folder (slack_agent_meeting_notes_pat), or display name (패트).
 */
export function findGroupByInput(
  input: string,
  registeredGroups: Record<string, RegisteredGroup>,
): [string, RegisteredGroup] | null {
  const normalized = input.trim().toLowerCase().replace(/-/g, '_');
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder.toLowerCase() === normalized) return [jid, group];
    const unprefixed = group.folder.replace(
      /^(slack|whatsapp|telegram|discord)_/,
      '',
    );
    if (unprefixed.toLowerCase() === normalized) return [jid, group];
    if (group.name.toLowerCase() === input.trim().toLowerCase())
      return [jid, group];
  }
  return null;
}

/**
 * Reset a single group's session and send the result message.
 */
export async function handleSessionReset(
  chatJid: string,
  targetInput: string,
  deps: SessionHandlerDeps,
): Promise<void> {
  const match = findGroupByInput(targetInput, deps.registeredGroups);
  if (!match) {
    const list = Object.values(deps.registeredGroups)
      .map((g) => `  ${g.folder}`)
      .join('\n');
    await deps.sendMessage(
      chatJid,
      `그룹을 찾을 수 없습니다: ${targetInput}\n\n사용 가능:\n${list}`,
    );
    return;
  }

  const [targetJid, group] = match;
  const result = await resetGroupSession(targetJid, group, deps);

  const status =
    result.errors.length === 0
      ? 'OK'
      : `부분 성공 (${result.errors.join(', ')})`;
  logger.info(
    {
      group: group.name,
      folder: group.folder,
      sdk: result.sdkType,
      errors: result.errors,
    },
    'Session reset',
  );
  await deps.sendMessage(
    chatJid,
    `:arrows_counterclockwise: *세션 초기화 완료*\n그룹: *${group.name}* (${group.folder})\nSDK: ${result.sdkType}\n상태: ${status}`,
  );
}

/**
 * Reset ALL group sessions at once and send the summary message.
 */
export async function handleSessionResetAll(
  chatJid: string,
  deps: SessionHandlerDeps,
): Promise<void> {
  const groups = Object.entries(deps.registeredGroups);
  if (groups.length === 0) {
    await deps.sendMessage(chatJid, '등록된 그룹이 없습니다.');
    return;
  }

  await deps.sendMessage(
    chatJid,
    `:hourglass_flowing_sand: 전체 세션 초기화 시작 (${groups.length}개 그룹)...`,
  );

  const results: string[] = [];
  for (const [targetJid, group] of groups) {
    const result = await resetGroupSession(targetJid, group, deps);

    const status = result.errors.length === 0 ? 'OK' : result.errors.join(', ');
    results.push(`${group.name} (${result.sdkType}): ${status}`);
    logger.info(
      {
        group: group.name,
        folder: group.folder,
        sdk: result.sdkType,
        errors: result.errors,
      },
      'Session reset (all)',
    );
  }

  await deps.sendMessage(
    chatJid,
    `:arrows_counterclockwise: *전체 세션 초기화 완료* (${groups.length}개)\n${results.map((r) => `• ${r}`).join('\n')}`,
  );
}

/**
 * Reset sessions for all lanes paired with `triggerJid` (same physical
 * channel). Used by the `<<AUTO_RESET_SESSIONS>>` marker path: when an agent
 * finishes a task and wants to clear its own context + the peer lane's (e.g.
 * pat finalizing a meeting note also resets mat's review session).
 *
 * Emits a single compact notification to each reset lane. Errors per lane
 * are logged and do not abort the others.
 */
export async function autoResetPairedLanes(
  triggerJid: string,
  deps: SessionHandlerDeps,
): Promise<void> {
  const lanes = findPairedLanes(triggerJid, deps.registeredGroups);
  if (lanes.length === 0) {
    logger.warn(
      { triggerJid },
      'Auto reset requested but no paired lanes found',
    );
    return;
  }

  for (const targetJid of lanes) {
    const group = deps.registeredGroups[targetJid];
    if (!group) continue;
    try {
      const result = await resetGroupSession(targetJid, group, deps);
      logger.info(
        {
          trigger: 'auto-reset-marker',
          triggerJid,
          target: group.folder,
          sdk: result.sdkType,
          errors: result.errors,
        },
        'Auto session reset via marker',
      );
      const status = result.errors.length === 0 ? 'OK' : 'partial';
      await deps.sendMessage(
        targetJid,
        `:arrows_counterclockwise: 세션 자동 초기화 (${status})`,
      );
    } catch (err) {
      logger.error(
        { err, targetJid, group: group.name },
        'Auto session reset failed',
      );
    }
  }
}

/**
 * Intercept "세션초기화 <target>" or "세션초기화 전체" on the main group.
 * Returns true if handled (caller should stop pipeline), false otherwise.
 * Bare "세션초기화" with no target is NOT intercepted — falls through to normal message flow.
 * Dispatch is fire-and-forget; errors are logged.
 */
export function tryHandleSessionResetCommand(
  chatJid: string,
  msg: NewMessage,
  deps: SessionHandlerDeps,
): boolean {
  const trimmed = msg.content.trim();
  if (!trimmed.startsWith('세션초기화')) return false;
  if (!deps.registeredGroups[chatJid]?.isMain) return false;

  const targetInput = trimmed.slice('세션초기화'.length).trim();

  if (targetInput === '전체') {
    handleSessionResetAll(chatJid, deps).catch((err) =>
      logger.error({ err, chatJid }, 'Session reset all error'),
    );
    return true;
  }
  if (targetInput) {
    handleSessionReset(chatJid, targetInput, deps).catch((err) =>
      logger.error({ err, chatJid }, 'Session reset error'),
    );
    return true;
  }
  return false;
}
