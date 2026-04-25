/**
 * Container mount configuration for NanoClaw.
 * Builds volume mount specifications.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
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

  // Mirror the host user's ~/.gitconfig so in-container commits carry the
  // real GitHub identity (needed for Vercel attribution on projects that
  // agents push). Apple Container (VirtioFS) doesn't support file mounts,
  // so we stage a copy in data/gitconfig/ and mount the directory. Git
  // reads it via GIT_CONFIG_GLOBAL (set in container-runner.ts).
  const hostGitconfig = path.join(os.homedir(), '.gitconfig');
  if (fs.existsSync(hostGitconfig)) {
    const gitconfigDir = path.join(DATA_DIR, 'gitconfig');
    fs.mkdirSync(gitconfigDir, { recursive: true });
    fs.copyFileSync(hostGitconfig, path.join(gitconfigDir, '.gitconfig'));
    mounts.push({
      hostPath: gitconfigDir,
      containerPath: '/etc/nanoclaw-git',
      readonly: true,
    });
  }

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
