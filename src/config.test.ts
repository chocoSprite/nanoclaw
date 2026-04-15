import { describe, it, expect } from 'vitest';

import {
  getGroupBotName,
  MAT_ASSISTANT_NAME,
  PAT_ASSISTANT_NAME,
} from './config.js';

describe('getGroupBotName', () => {
  it('returns mat name for slack-mat: JIDs', () => {
    expect(getGroupBotName('slack-mat:C0APYRWQRFH')).toBe(MAT_ASSISTANT_NAME);
  });

  it('returns pat name for slack: JIDs', () => {
    expect(getGroupBotName('slack:C0AQFDF3EBS')).toBe(PAT_ASSISTANT_NAME);
  });

  it('returns pat name for WhatsApp / Telegram / Discord JIDs (no mat lane there yet)', () => {
    expect(getGroupBotName('1234567@g.us')).toBe(PAT_ASSISTANT_NAME);
    expect(getGroupBotName('tg:12345')).toBe(PAT_ASSISTANT_NAME);
    expect(getGroupBotName('dc:67890')).toBe(PAT_ASSISTANT_NAME);
  });

  it('does not mismatch similar-looking prefixes', () => {
    // Guard against future JID schemes that start with "slack-" but aren't mat
    expect(getGroupBotName('slack-review:C999')).toBe(PAT_ASSISTANT_NAME);
    expect(getGroupBotName('slack-matcha:C999')).toBe(PAT_ASSISTANT_NAME);
  });
});
