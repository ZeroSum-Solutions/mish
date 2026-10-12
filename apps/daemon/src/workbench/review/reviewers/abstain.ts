// R03: checks a text-only reviewer (Jev, DeepSeek) cannot judge from what it
// receives. It answers them uncertain with a closed abstain reason instead of
// guessing, and never spends a provider call on them.
import type { ReviewerInput, ReviewerVerdict } from './types.js';
import { isVisualFactsId } from '../evidence-detail.js';

export const INSUFFICIENT_VISUAL = 'Insufficient evidence for visual style: no measured visual facts were available and this reviewer reads text, not screenshots, so it did not score this check.';
export const INSUFFICIENT_TEXT = 'Insufficient evidence for copy: this reviewer sees page copy only as length and hash tokens, so it did not score this copy-quality check.';

/**
 * Splits a text reviewer's checks into those it can be asked and its abstentions:
 * a copy-quality judgment always abstains (copy never leaves the daemon as text),
 * and a judgment about the rendered look abstains when no visual-<width> facts exist.
 */
export function textReviewerSplit(input: ReviewerInput): { asked: ReviewerInput['checks']; abstained: ReviewerVerdict[] } {
  const hasVisualFacts = input.evidence.some(item => isVisualFactsId(item.id));
  const asked: ReviewerInput['checks'] = []; const abstained: ReviewerVerdict[] = [];
  for (const check of input.checks) {
    if (check.copy) abstained.push({ checkId: check.checkId, verdict: 'uncertain', probability: null, evidenceRefs: [], abstain: 'insufficient-text-evidence', rationale: INSUFFICIENT_TEXT });
    else if (check.visual && !hasVisualFacts) abstained.push({ checkId: check.checkId, verdict: 'uncertain', probability: null, evidenceRefs: [], abstain: 'insufficient-visual-evidence', rationale: INSUFFICIENT_VISUAL });
    else asked.push(check);
  }
  return { asked, abstained };
}
