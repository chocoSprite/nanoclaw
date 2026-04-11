import fs from 'fs';
import path from 'path';

import type { RegisteredGroup } from './types.js';

/** Dependencies injected by the orchestrator. */
export interface SessionResetDeps {
  dataDir: string;
  sessions: Record<string, string>;
  terminateGroup: (jid: string) => Promise<void>;
  deleteSession: (folder: string) => void;
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
    for (const f of sdkEntries.filter((n) =>
      n.startsWith('state_5.sqlite'),
    )) {
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
  const sdkType = group.sdk ?? 'codex';

  // 1. Terminate running container
  await deps.terminateGroup(groupJid);

  // 2. Clear in-memory session
  delete deps.sessions[group.folder];

  // 3. Clear DB session record
  deps.deleteSession(group.folder);

  // 4. Clean SDK session files on disk
  const sdkDirName = sdkType === 'claude' ? '.claude' : '.codex';
  const sdkBase = path.join(
    deps.dataDir,
    'sessions',
    group.folder,
    sdkDirName,
  );
  const errors = cleanSdkSessionFiles(sdkBase, sdkType);

  return { groupName: group.name, folder: group.folder, sdkType, errors };
}
