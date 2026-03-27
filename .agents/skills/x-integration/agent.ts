/**
 * X Integration - IPC Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation is in host.ts.
 *
 * In the Codex runtime, these are registered as MCP tools via the nanoclaw
 * MCP server (ipc-mcp-stdio.ts). The SKILL.md instructs how to wire them.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'x_results');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function waitForResult(requestId: string, maxWait = 60000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

// Tool schemas for MCP registration
export const xToolSchemas = {
  x_post: {
    description: 'Post a tweet to X (Twitter). Main group only.',
    inputSchema: { content: z.string().max(280).describe('The tweet content (max 280 characters)') },
  },
  x_like: {
    description: 'Like a tweet on X (Twitter). Main group only.',
    inputSchema: { tweet_url: z.string().describe('The tweet URL or tweet ID') },
  },
  x_reply: {
    description: 'Reply to a tweet on X (Twitter). Main group only.',
    inputSchema: {
      tweet_url: z.string().describe('The tweet URL or tweet ID'),
      content: z.string().max(280).describe('The reply content (max 280 characters)'),
    },
  },
  x_retweet: {
    description: 'Retweet a tweet on X (Twitter). Main group only.',
    inputSchema: { tweet_url: z.string().describe('The tweet URL or tweet ID') },
  },
  x_quote: {
    description: 'Quote tweet on X (Twitter). Main group only.',
    inputSchema: {
      tweet_url: z.string().describe('The tweet URL or tweet ID'),
      comment: z.string().max(280).describe('Your comment (max 280 characters)'),
    },
  },
};

/**
 * Create X integration tool handlers
 */
export function createXTools(ctx: SkillToolsContext) {
  const { groupFolder, isMain } = ctx;

  const mainOnly = () => ({ success: false, message: 'Only the main group can interact with X.' });

  return {
    async x_post(args: { content: string }) {
      if (!isMain) return mainOnly();
      if (args.content.length > 280) return { success: false, message: `Tweet exceeds 280 char limit (${args.content.length})` };
      const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_post', requestId, content: args.content, groupFolder, timestamp: new Date().toISOString() });
      return waitForResult(requestId);
    },

    async x_like(args: { tweet_url: string }) {
      if (!isMain) return mainOnly();
      const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_like', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
      return waitForResult(requestId);
    },

    async x_reply(args: { tweet_url: string; content: string }) {
      if (!isMain) return mainOnly();
      const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_reply', requestId, tweetUrl: args.tweet_url, content: args.content, groupFolder, timestamp: new Date().toISOString() });
      return waitForResult(requestId);
    },

    async x_retweet(args: { tweet_url: string }) {
      if (!isMain) return mainOnly();
      const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_retweet', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
      return waitForResult(requestId);
    },

    async x_quote(args: { tweet_url: string; comment: string }) {
      if (!isMain) return mainOnly();
      const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { type: 'x_quote', requestId, tweetUrl: args.tweet_url, comment: args.comment, groupFolder, timestamp: new Date().toISOString() });
      return waitForResult(requestId);
    },
  };
}
