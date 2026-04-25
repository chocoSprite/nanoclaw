/**
 * Container credential injection for NanoClaw.
 *
 * For Claude SDK only: reads the Claude OAuth token from the macOS keychain
 * and injects it into the container via CLAUDE_CODE_OAUTH_TOKEN env var.
 *
 * Codex SDK does not need this path — its auth.json is mounted directly into
 * the container by container-mounts.ts (host ~/.codex/ → group sessions dir).
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

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
 * For sdk === 'claude', append CLAUDE_CODE_OAUTH_TOKEN env arg from keychain.
 * No-op for Codex (auth.json is mounted instead).
 *
 * Mutates `args` in place to preserve the arg-order semantics expected by
 * the container runtime CLI.
 */
export async function applyCredentialArgs(
  args: string[],
  containerName: string,
  sdk: 'codex' | 'claude',
): Promise<void> {
  if (sdk !== 'claude') return;

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
