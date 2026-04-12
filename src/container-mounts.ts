/**
 * Container mount configuration for NanoClaw.
 * Builds volume mount specifications and normalizes OneCLI cert mounts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Normalize OneCLI cert file mounts for Apple Container compatibility.
 * Apple Container (VirtioFS) only supports directory mounts, not file mounts.
 * OneCLI creates temp .pem cert files and mounts them individually — this
 * copies them into a single directory and replaces file mounts with one
 * directory mount.
 * Also fixes host.docker.internal → 192.168.64.1 for Apple Container networking.
 */
export function normalizeOneCLIMounts(args: string[]): void {
  const onecliDir = path.join(DATA_DIR, 'onecli');
  fs.mkdirSync(onecliDir, { recursive: true });
  const replacements = new Map<string, string>();
  const keptArgs: string[] = [];
  const appleContainerHost =
    CONTAINER_RUNTIME_BIN === 'container' && os.platform() === 'darwin'
      ? '192.168.64.1'
      : null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-v' || i === args.length - 1) {
      keptArgs.push(args[i]);
      continue;
    }

    const mountSpec = args[i + 1];
    const firstColon = mountSpec.indexOf(':');
    if (firstColon === -1) {
      keptArgs.push(args[i], args[i + 1]);
      i++;
      continue;
    }

    const hostPath = mountSpec.slice(0, firstColon);
    const remainder = mountSpec.slice(firstColon + 1);
    const containerPath = remainder.split(':')[0];

    if (
      !hostPath.endsWith('.pem') ||
      !containerPath.startsWith('/tmp/onecli-') ||
      !fs.existsSync(hostPath)
    ) {
      keptArgs.push(args[i], args[i + 1]);
      i++;
      continue;
    }

    const copiedPath = path.join(onecliDir, path.basename(hostPath));
    fs.copyFileSync(hostPath, copiedPath);
    fs.chmodSync(copiedPath, 0o644);
    replacements.set(
      containerPath,
      `/tmp/onecli-certs/${path.basename(hostPath)}`,
    );
    i++;
  }

  for (let i = 0; i < keptArgs.length - 1; i++) {
    if (keptArgs[i] !== '-e') continue;
    const [key, ...rest] = keptArgs[i + 1].split('=');
    if (!key || rest.length === 0) continue;
    let value = rest.join('=');
    value = replacements.get(value) ?? value;
    if (appleContainerHost) {
      value = value.replaceAll('host.docker.internal', appleContainerHost);
    }
    keptArgs[i + 1] = `${key}=${value}`;
  }

  args.splice(0, args.length, ...keptArgs);

  if (replacements.size > 0) {
    args.push('-v', `${onecliDir}:/tmp/onecli-certs:ro`);
  }
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, SDK sessions) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // .env shadow is handled by the container entrypoint via mount --bind
    // (Apple Container only supports directory mounts, not file mounts,
    // so we can't shadow .env with a /dev/null file mount here)

    // Main gets writable store access (SQLite direct access)
    const storeDir = path.join(projectRoot, 'store');
    if (fs.existsSync(storeDir)) {
      mounts.push({
        hostPath: storeDir,
        containerPath: '/workspace/project/store',
        readonly: false,
      });
    }

    // Main gets writable global memory (can update shared context)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group SDK sessions directory (isolated from other groups)
  // Each group gets their own .codex/ or .claude/ to prevent cross-group session access
  const sdkType = group.sdk;
  const sdkDirName = sdkType === 'claude' ? '.claude' : '.codex';
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    sdkDirName,
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  if (sdkType === 'claude') {
    // Seed Claude SDK settings with experimental features
    const settingsFile = path.join(groupSessionsDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify(
          {
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
              CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            },
          },
          null,
          2,
        ) + '\n',
      );
    }
    // Claude OAuth is handled in buildContainerArgs (keychain → CLAUDE_CODE_OAUTH_TOKEN).
  } else {
    // Seed group session from host Codex login so subscription users don't need API keys.
    // Copy auth.json (OAuth tokens) and config.toml (model/MCP settings).
    // Only overwrite if host file is newer (preserves container-refreshed tokens).
    const hostCodexDir = path.join(os.homedir(), '.codex');
    for (const file of ['auth.json', 'config.toml']) {
      const hostFile = path.join(hostCodexDir, file);
      const groupFile = path.join(groupSessionsDir, file);
      if (fs.existsSync(hostFile)) {
        const hostMtime = fs.statSync(hostFile).mtimeMs;
        const groupMtime = fs.existsSync(groupFile)
          ? fs.statSync(groupFile).mtimeMs
          : 0;
        if (hostMtime > groupMtime) {
          fs.copyFileSync(hostFile, groupFile);
        }
      }
    }
  }

  // Sync skills from container/skills/ into each group's SDK skills dir
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: `/home/node/${sdkDirName}`,
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Check if any source file is newer than its cached copy
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      fs.readdirSync(agentRunnerSrc).some((file) => {
        const srcFile = path.join(agentRunnerSrc, file);
        const cachedFile = path.join(groupAgentRunnerDir, file);
        return (
          !fs.existsSync(cachedFile) ||
          fs.statSync(srcFile).mtimeMs > fs.statSync(cachedFile).mtimeMs
        );
      });
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Mount attachments directory so agent can access downloaded images
  const attachmentsDir = path.join(DATA_DIR, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  mounts.push({
    hostPath: attachmentsDir,
    containerPath: '/workspace/attachments',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}
