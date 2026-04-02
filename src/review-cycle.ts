/**
 * Review Cycle Orchestration
 *
 * After the dev agent (패트) completes, automatically triggers the review agent (매트).
 * If the reviewer says REVISE, feeds feedback back to the dev agent. Repeats until
 * DONE or maxRounds reached. Aborts if user sends a new message (pendingMessages).
 */

import { ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup, ReviewConfig } from './types.js';

// ── Verdict Parsing ──────────────────────────────────────────────

export type Verdict = 'done' | 'revise';

export interface ParsedVerdict {
  verdict: Verdict;
  feedback: string; // Full review text (used as dev agent's next prompt on REVISE)
}

/**
 * Parse the review agent's output for a VERDICT line.
 * Falls back to 'done' if no verdict found (don't block on unparseable output).
 */
export function parseVerdict(text: string): ParsedVerdict {
  const match = text.match(/VERDICT:\s*(DONE|REVISE)/i);
  if (!match) {
    logger.warn('No VERDICT found in review output, treating as DONE');
    return { verdict: 'done', feedback: text };
  }
  return {
    verdict: match[1].toLowerCase() as Verdict,
    feedback: text,
  };
}

// ── Review Cycle ─────────────────────────────────────────────────

export interface ReviewCycleOpts {
  /** The dev group that produced the output */
  devGroup: RegisteredGroup;
  /** JID of the dev channel (e.g. "slack:C999") */
  devJid: string;
  /** Review config from the dev group */
  reviewConfig: ReviewConfig;
  /** The review group to run */
  reviewGroup: RegisteredGroup;
  /** The dev agent's output text that triggered the review */
  devOutput: string;
  /** Run an agent and return its collected output text */
  runAgentFn: (
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput: (output: ContainerOutput) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  /** Send a message to the channel as a specific bot */
  sendAsReviewBot: (text: string) => Promise<void>;
  sendAsDevBot: (text: string) => Promise<void>;
  /** Check if user has sent new messages (should abort cycle) */
  hasPendingMessages: () => boolean;
}

export interface ReviewCycleResult {
  rounds: number;
  finalVerdict: Verdict | 'aborted' | 'error';
}

/**
 * Run the dev↔review cycle.
 *
 * Flow:
 *   1. Send dev output to review agent
 *   2. Parse verdict
 *   3. If REVISE → send feedback to dev agent → goto 1
 *   4. If DONE or maxRounds → stop
 *   5. If user message detected → abort
 */
export async function startReviewCycle(
  opts: ReviewCycleOpts,
): Promise<ReviewCycleResult> {
  const { reviewConfig, reviewGroup, devGroup } = opts;
  let currentDevOutput = opts.devOutput;
  let rounds = 0;

  while (rounds < reviewConfig.maxRounds) {
    // Check for user intervention before starting review
    if (opts.hasPendingMessages()) {
      logger.info(
        { group: devGroup.name, rounds },
        'Review cycle aborted: user message pending',
      );
      return { rounds, finalVerdict: 'aborted' };
    }

    rounds++;
    logger.info(
      { group: devGroup.name, round: rounds, maxRounds: reviewConfig.maxRounds },
      'Review cycle: starting review round',
    );

    // ── Run review agent ──
    const reviewPrompt = rounds === 1
      ? `다음은 개발 에이전트의 작업 결과입니다. 리뷰해주세요.\n\n---\n\n${currentDevOutput}`
      : `개발 에이전트가 이전 리뷰 피드백을 반영하여 수정했습니다. 다시 리뷰해주세요.\n\n---\n\n${currentDevOutput}`;

    let reviewOutput = '';
    const reviewResult = await opts.runAgentFn(
      reviewGroup,
      reviewPrompt,
      reviewConfig.reviewJid,
      async (output) => {
        if (output.result) {
          const text =
            typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
          const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          if (cleaned) {
            reviewOutput += (reviewOutput ? '\n' : '') + cleaned;
            await opts.sendAsReviewBot(cleaned);
          }
        }
      },
    );

    if (reviewResult === 'error') {
      logger.error({ group: devGroup.name, round: rounds }, 'Review agent failed');
      return { rounds, finalVerdict: 'error' };
    }

    if (!reviewOutput) {
      logger.warn({ group: devGroup.name, round: rounds }, 'Review agent produced no output');
      return { rounds, finalVerdict: 'done' };
    }

    // ── Parse verdict ──
    const { verdict, feedback } = parseVerdict(reviewOutput);
    logger.info(
      { group: devGroup.name, round: rounds, verdict },
      'Review verdict received',
    );

    if (verdict === 'done') {
      return { rounds, finalVerdict: 'done' };
    }

    // ── REVISE: check for user intervention before dev round ──
    if (opts.hasPendingMessages()) {
      logger.info(
        { group: devGroup.name, rounds },
        'Review cycle aborted: user message pending before dev round',
      );
      return { rounds, finalVerdict: 'aborted' };
    }

    // ── Run dev agent with review feedback ──
    const devPrompt = `리뷰 에이전트의 피드백입니다. 지적된 사항을 수정해주세요.\n\n---\n\n${feedback}`;

    let devOutput = '';
    const devResult = await opts.runAgentFn(
      devGroup,
      devPrompt,
      opts.devJid,
      async (output) => {
        if (output.result) {
          const text =
            typeof output.result === 'string'
              ? output.result
              : JSON.stringify(output.result);
          const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          if (cleaned) {
            devOutput += (devOutput ? '\n' : '') + cleaned;
            await opts.sendAsDevBot(cleaned);
          }
        }
      },
    );

    if (devResult === 'error') {
      logger.error({ group: devGroup.name, round: rounds }, 'Dev agent failed during revision');
      return { rounds, finalVerdict: 'error' };
    }

    currentDevOutput = devOutput || currentDevOutput;
  }

  // Max rounds reached
  logger.warn(
    { group: devGroup.name, rounds },
    'Review cycle: max rounds reached',
  );
  return { rounds, finalVerdict: 'done' };
}
