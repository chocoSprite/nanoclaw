/**
 * Slack Review Channel
 *
 * Second Slack bot for code review in multi-agent channels.
 * Reuses SlackChannel with different tokens and JID prefix.
 * Only processes messages that @mention this bot (requireMention).
 * Ignores messages that @mention the primary bot (ignoreMentions).
 */

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { SlackChannel } from './slack.js';

registerChannel('slack-review', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SLACK_MAT_BOT_TOKEN',
    'SLACK_MAT_APP_TOKEN',
    'MAT_ASSISTANT_NAME',
  ]);
  if (!envVars.SLACK_MAT_BOT_TOKEN || !envVars.SLACK_MAT_APP_TOKEN) {
    logger.info(
      'Slack Review: SLACK_MAT_BOT_TOKEN or SLACK_MAT_APP_TOKEN not set, skipping',
    );
    return null;
  }

  return new SlackChannel({
    ...opts,
    config: {
      botTokenKey: 'SLACK_MAT_BOT_TOKEN',
      appTokenKey: 'SLACK_MAT_APP_TOKEN',
      jidPrefix: 'slack-review',
      requireMention: true,
      triggerName: envVars.MAT_ASSISTANT_NAME || 'Reviewer',
    },
  });
});
