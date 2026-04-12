/**
 * Container credential injection for NanoClaw.
 *
 * Applies OneCLI gateway credentials and (for Claude SDK) reads the Claude OAuth
 * token from the macOS keychain, injecting it into the container's env.
 *
 * Kept separate from container-runner's spawn-arg assembly because the
 * dependencies (OneCLI SDK, `execSync` on keychain, log warnings for
 * gateway reachability) are a distinct concern from mount translation
 * and UID/GID mapping.
 */
import { execSync } from 'child_process';

import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_URL } from './config.js';
import { normalizeOneCLIMounts } from './container-mounts.js';
import { logger } from './logger.js';

const onecli = new OneCLI({ url: ONECLI_URL });

function readClaudeOAuthToken(): string | null {
  try {
    const creds = JSON.parse(
      execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim(),
    );
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply OneCLI credential injection and (for Claude SDK) keychain OAuth token
 * to container args. Mutates `args` in place to preserve arg-order semantics
 * expected by the container runtime CLI.
 *
 * Side effects:
 * - Calls OneCLI gateway (may append `-e` / `-v` entries)
 * - Strips `ANTHROPIC_API_KEY` placeholder (unused by both Codex and Claude SDK)
 * - For `sdk === 'claude'`: strips `CLAUDE_CODE_OAUTH_TOKEN` placeholder,
 *   then injects the real token read from the macOS keychain if available.
 * - Emits warn logs when the gateway is unreachable or the keychain read fails.
 */
export async function applyCredentialArgs(
  args: string[],
  containerName: string,
  agentIdentifier: string | undefined,
  sdk: 'codex' | 'claude',
): Promise<void> {
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });

  if (!onecliApplied) {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
    return;
  }

  normalizeOneCLIMounts(args);

  // OneCLI injects ANTHROPIC_API_KEY=placeholder by default — strip it unconditionally.
  // Neither Codex nor Claude SDK uses this; Codex uses OpenAI, Claude uses OAuth.
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '-e' && args[i + 1]?.startsWith('ANTHROPIC_API_KEY=')) {
      args.splice(i, 2);
    }
  }

  // Claude SDK: inject OAuth token from macOS keychain.
  // OneCLI proxy is kept for other services (kakao, etc).
  if (sdk === 'claude') {
    // Remove any CLAUDE_CODE_OAUTH_TOKEN placeholder from OneCLI
    for (let i = args.length - 1; i >= 0; i--) {
      if (
        args[i] === '-e' &&
        args[i + 1]?.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')
      ) {
        args.splice(i, 2);
      }
    }
    const oauthToken = readClaudeOAuthToken();
    if (oauthToken) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
    } else {
      logger.warn(
        { containerName },
        'Failed to read Claude OAuth token from keychain',
      );
    }
  }

  logger.info({ containerName }, 'OneCLI gateway config applied');
}
