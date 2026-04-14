/**
 * Translate container-side absolute paths (e.g. `/workspace/group/foo.md`)
 * into the corresponding host paths, using the mount topology NanoClaw
 * builds for each group in `container-mounts.ts`.
 *
 * Used by outbound channel code to validate `[File: ...]` / `[Image: ...]`
 * tags the agent emits: the agent sees container paths, but NanoClaw needs
 * host paths to `fs.existsSync` + upload.
 */
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import type { RegisteredGroup } from './types.js';

/**
 * Expand `~` / `~/` to the user's home. Anything else is returned as-is
 * (after `path.resolve` to normalize).
 */
function expandHome(p: string): string {
  const home = process.env.HOME || os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.resolve(p);
}

/**
 * Build an ordered list of `[containerPrefix, hostPrefix]` pairs for a group.
 * Longest prefix first so nested mounts (e.g. `/workspace/project/store`
 * inside `/workspace/project`) resolve correctly.
 */
function buildPrefixMap(group: RegisteredGroup): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  if (group.isMain) {
    pairs.push(['/workspace/project/store', STORE_DIR]);
    pairs.push(['/workspace/project', process.cwd()]);
  }

  pairs.push(['/workspace/group', resolveGroupFolderPath(group.folder)]);
  pairs.push(['/workspace/global', path.join(GROUPS_DIR, 'global')]);
  pairs.push(['/workspace/attachments', path.join(DATA_DIR, 'attachments')]);

  const extras = group.containerConfig?.additionalMounts ?? [];
  for (const m of extras) {
    const containerName = m.containerPath || path.basename(m.hostPath);
    // additionalMounts are validated against the allowlist at spawn time,
    // but the declared hostPath (after ~ expansion) is what the mount uses
    // for existence checks here. Symlinks are followed by fs.existsSync.
    pairs.push([`/workspace/extra/${containerName}`, expandHome(m.hostPath)]);
  }

  // Longest prefix first
  pairs.sort(([a], [b]) => b.length - a.length);
  return pairs;
}

/**
 * Translate a container absolute path to the corresponding host path,
 * using the given group's mount topology. Returns `null` if the path
 * doesn't match any known container mount.
 *
 * Accepts both exact prefix matches (`/workspace/group`) and subpaths
 * (`/workspace/group/foo/bar.md`).
 */
export function translateContainerPath(
  containerPath: string,
  group: RegisteredGroup,
): string | null {
  if (!containerPath.startsWith('/')) return null;

  const normalized = path.posix.normalize(containerPath);
  // Refuse traversal attempts — normalize should have collapsed them,
  // but `..` escaping the prefix would silently rewrite into a different
  // host root.
  if (normalized.includes('/../') || normalized.endsWith('/..')) return null;

  for (const [prefix, hostPrefix] of buildPrefixMap(group)) {
    if (normalized === prefix) return hostPrefix;
    if (normalized.startsWith(prefix + '/')) {
      return hostPrefix + normalized.slice(prefix.length);
    }
  }

  return null;
}
