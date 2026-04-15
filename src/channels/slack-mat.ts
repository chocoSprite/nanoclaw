/**
 * Slack Mat Channel
 *
 * Second Slack bot (매트) in multi-agent channels. Paired with the
 * primary bot (패트). Reuses SlackChannel with different tokens and
 * JID prefix. Only processes messages that @mention this bot
 * (requireMention). Ignores messages that @mention the primary bot
 * (ignoreMentions).
 */

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { SlackChannel } from './slack.js';

registerChannel('slack-mat', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SLACK_MAT_BOT_TOKEN',
    'SLACK_MAT_APP_TOKEN',
    'MAT_ASSISTANT_NAME',
  ]);
  if (!envVars.SLACK_MAT_BOT_TOKEN || !envVars.SLACK_MAT_APP_TOKEN) {
    logger.info(
      'Slack Mat: SLACK_MAT_BOT_TOKEN or SLACK_MAT_APP_TOKEN not set, skipping',
    );
    return null;
  }

  return new SlackChannel({
    ...opts,
    config: {
      botTokenKey: 'SLACK_MAT_BOT_TOKEN',
      appTokenKey: 'SLACK_MAT_APP_TOKEN',
      jidPrefix: 'slack-mat',
      requireMention: true,
      triggerName: envVars.MAT_ASSISTANT_NAME || '매트',
    },
  });
});
