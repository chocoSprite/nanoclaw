/**
 * Skill scanner — enumerates skill directories visible to a given group.
 *
 * NanoClaw skills are filesystem-based (no DB registration):
 *   - Global skills: `container/skills/<skill>/` — loaded into every agent
 *     container at spawn time.
 *   - Per-group skills: `groups/<folder>/skills/<skill>/` — additional
 *     skills scoped to a single group (rare but allowed).
 *
 * This scanner is **read-only** and does not attempt to determine which
 * skills are "enabled" — there is no enable/disable mechanism today.
 * It reports every directory the container will see. The UI should label
 * this as "available skills" rather than "enabled skills" to avoid
 * overclaiming.
 *
 * Missing directories return an empty list rather than throwing; fresh
 * groups or a missing `container/skills/` dir must not break the editor.
 */

import fs from 'node:fs';
import path from 'node:path';

export type SkillOrigin = 'global' | 'group';

export interface SkillEntry {
  name: string;
  origin: SkillOrigin;
}

export interface SkillScannerOptions {
  /** Absolute path to `container/skills/`. */
  globalSkillsDir: string;
  /** Absolute path to `groups/` — each group's skills live under `<groupsDir>/<folder>/skills/`. */
  groupsDir: string;
}

export class SkillScanner {
  constructor(private readonly opts: SkillScannerOptions) {}

  listSkillsForGroup(folder: string): SkillEntry[] {
    const out: SkillEntry[] = [];
    for (const name of listDirEntries(this.opts.globalSkillsDir)) {
      out.push({ name, origin: 'global' });
    }
    const groupSkills = path.join(this.opts.groupsDir, folder, 'skills');
    for (const name of listDirEntries(groupSkills)) {
      out.push({ name, origin: 'group' });
    }
    return out;
  }
}

function listDirEntries(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}
