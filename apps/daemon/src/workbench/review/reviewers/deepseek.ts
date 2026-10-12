import { createModelCaller, ProviderHttpError, ProviderKeyError, ProviderKeyUnreadableError, type ModelCall } from '@mish/agency-fast-lane/deepseek';
import type { ReviewerReasonCode } from '@mish/contracts';
import { textReviewerSplit } from './abstain.js';
import { buildReviewPrompt, parseVerdicts } from './prompt.js';
import { ReviewerCallError, type ReviewerAdapter, type ReviewerResult } from './types.js';

export const DEEPSEEK_REVIEW_MODEL = 'deepseek-flash';

export interface DeepSeekReviewerOptions {
  /** Resolves the DeepSeek key through the daemon's existing key store (env, stored, vault). */
  apiKey: () => Promise<string>;
  keyConfigured?: () => Promise<boolean>;
  /** Injected in tests; production builds the approved metered caller. */
  call?: ModelCall;
  timeoutMs?: number;
}

/** The closed cause of a failed DeepSeek call (the provider's own message is never kept). */
function deepSeekFailureCode(error: unknown): ReviewerReasonCode {
  if (error instanceof ProviderKeyError || error instanceof ProviderKeyUnreadableError) return 'key-missing';
  if (error instanceof ProviderHttpError) return error.status === 401 || error.status === 403 ? 'provider-auth-rejected' : 'provider-error';
  return 'provider-unreachable';
}

/** DeepSeek V4.1 Flash adversarial reviewer through the approved metered adapter (one call per run). */
export function createDeepSeekReviewer(options: DeepSeekReviewerOptions): ReviewerAdapter {
  const call = options.call ?? createModelCaller({ provider: 'deepseek', model: DEEPSEEK_REVIEW_MODEL, apiKey: options.apiKey, timeoutMs: options.timeoutMs ?? 300_000, maxTokens: 4_000, temperature: 0, maxRetries: 1 });
  return {
    role: 'deepseek-adversarial', provider: 'deepseek', modelId: DEEPSEEK_REVIEW_MODEL, adapterVersion: 'deepseek-review/2', billingLane: 'deepseek-metered',
    async availability() {
      if (options.keyConfigured && !await options.keyConfigured()) return { available: false, reason: 'No DeepSeek key is configured', recovery: 'Add the DeepSeek key in Settings, or deselect DeepSeek Flash for this run.', code: 'key-missing' };
      return { available: true };
    },
    plannedCalls: input => (textReviewerSplit(input).asked.length ? 1 : 0),
    async review(input, signal): Promise<ReviewerResult> {
      // R03: copy-quality judgments, and visual-style judgments without measured facts, are abstentions, never asked.
      const { asked, abstained } = textReviewerSplit(input);
      if (!asked.length) return { verdicts: abstained, rawOutput: '', inputMode: 'text' };
      const askedInput = { ...input, checks: asked };
      const prompt = buildReviewPrompt('deepseek-adversarial', askedInput);
      let text: string;
      try { text = (await call({ ...prompt, signal, label: 'workbench-review' })).text; } catch (error) {
        if (signal.aborted) throw error;
        throw new ReviewerCallError('DeepSeek Flash did not answer', 'Check the DeepSeek key and network, then run the review again.', deepSeekFailureCode(error));
      }
      const { verdicts } = parseVerdicts(text, askedInput);
      return { verdicts: [...verdicts, ...abstained], rawOutput: text, inputMode: 'text' };
    },
  };
}
