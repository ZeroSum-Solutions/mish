/** Post-picker recovery. Receipts contain ids, probabilities and fixed codes, never brief text. */
import { checkBlockPlan, compatibleWith, MAX_BLOCKS, pickForRole, shortlistBlocks, type AskedPlan, type BlockCatalog, type BlockPlan, type JevBlockPlannerOptions } from './block-plan.ts';
import { postSystemOne } from './jev.ts';
import { validateChoiceAnswer } from './route.ts';
import { sectionSkipReasonForStatus, type SectionSkipReason } from './sections.ts';

export const DEFAULT_SUPPORT_THRESHOLD = 0.8;
type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } };
export type BlockSupportReceipt = {
  threshold: number;
  added: Array<{ kind: string; id: string; reason: 'jev-brief-support' | 'faq-brief-signal'; probability?: number }>;
  removed: Array<{ kind: 'faq'; id: string; reason: 'faq-no-brief-signal' }>;
  decisions: Array<{ kind: string; probability?: number; reason: 'below-threshold' | 'supported' | 'capacity' | 'faq-brief-signal' | 'faq-no-brief-signal' }>;
  skipped?: SectionSkipReason | 'invalid-plan';
};

const NEEDS: Record<string, string> = {
  pricing: 'states actual prices or describes named plans (a day pass without a price is insufficient)',
  testimonials: 'supplies customer quotes or named clients (an endorsement is not required)',
  'reviews-ratings': 'gives reviews or ratings',
  team: 'names people who are members of its team, including named partners in a professional firm',
  'blog-articles': 'names articles, posts or updates',
  'timeline-roadmap': 'gives milestones or a roadmap',
  integrations: 'names tools or products it works with',
  'logo-wall': 'names client organizations or external partner organizations (people who are partners in the firm do not count)',
  specifications: 'gives specifications to compare',
  'plan-comparison': 'compares plans',
};

/** Additive signals only: a question/policy request or supplied answers, never a topic word. */
export function briefNeedsFaq(brief: string): boolean {
  const topic = String.raw`(?:faqs?|frequently\s+asked(?:\s+questions)?|common\s+questions|questions?\s+section|what\s+to\s+expect|q\s*&\s*a)`;
  const refusal = new RegExp(String.raw`\b(?:(?:no|without|omit|exclude|avoid|skip|leave\s+out|no\s+need\s+for|(?:do not|don't|does not|doesn't|not)\s+(?:include|want|add|show|use|need))\s+(?:(?:the|an?|any|our)\s+)?${topic}|${topic}(?:\s+(?:section|page))?\s+(?:is\s+)?not\s+(?:needed|wanted|required))\b`, 'i');
  if (refusal.test(brief)) return false;
  const target = String.raw`(?:${topic}|questions?|polic(?:y|ies)|insurance)(?:\s+(?:content|section))?`;
  const omission = new RegExp(String.raw`\b(?:no|without|omit|exclude|avoid|(?:do not|don't|does not|doesn't|not)\s+(?:include|want|add|show|use|need))\s+(?:an?\s+)?${target}(?:\s*(?:and|or|,\s*(?:and|or))\s+(?:an?\s+)?${target})*\b`, 'gi');
  const cleaned = brief.replace(omission, '');
  const policies = cleaned.matchAll(/\b(?:cancellation|refund|returns?|booking|insurance|privacy)\s+polic(?:y|ies)\s*:\s*([^.;\n]+)/gi);
  const suppliedPolicy = [...policies].some((match) => !/\b(?:links?|footer|navigation|url)\b/i.test(match[1]));
  const requests = cleaned.matchAll(/\b(?:explain|describe|answer|include|show|add)\s+(?:our\s+|the\s+)?(?:cancellation|refund|returns?|booking|insurance|privacy)\s+polic(?:y|ies)\b([^.;\n]*)/gi);
  const requestedPolicy = [...requests].some((match) => !/\b(?:links?|footer|navigation|url)\b/i.test(match[1]));
  return /\b(?:faqs?|frequently\s+asked|common\s+questions|what\s+to\s+expect|q\s*&\s*a)\b/i.test(cleaned)
    || /\b(?:insurance\s+(?:we\s+)?accept|(?:we\s+)?(?:do\s+not\s+|don't\s+)?accept\s+insurance)\b/i.test(cleaned)
    || suppliedPolicy || requestedPolicy
    || /\b(?:can\s+(?:i|we)|how\s+(?:do|can)\s+(?:i|we)|when\s+can\s+(?:i|we)|where\s+can\s+(?:i|we))\s+(?:book|cancel|pay|return|reserve|schedule|join|enrol|register|order|contact|reschedule)\b[^?\n]{0,160}\?/i.test(cleaned)
    || /\bdo\s+you\s+(?:accept|offer|take|have|provide|allow)\b[^?\n]{0,100}\b(?:refunds?|insurance|returns?|parking|appointments?|bookings?|walk-ins?|delivery|shipping|trials?|support|pets?|groups?)\b[^?\n]{0,60}\?/i.test(cleaned)
    || /\bhow\s+much\b[^?\n]{0,100}\b(?:cost|price|charge)\b[^?\n]{0,60}\?/i.test(cleaned);
}

/** Enforce the shared deadline even if a transport or body reader ignores its abort signal. */
export async function withinBlockPlanDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); signal.throwIfAborted(); }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** One independent yes/no question per missing candidate type, with no catalog descriptions. */
export function buildBlockSupportQuestions(plan: BlockPlan, catalog: BlockCatalog): Record<string, NoulQuestion> {
  const chosen = new Set(plan.blocks.map((id) => catalog.blocks.find((block) => block.id === id)?.sectionKind));
  const questions: Record<string, NoulQuestion> = {};
  for (const role of shortlistBlocks(catalog, plan.spine)) {
    if (role.required || role.kind === 'faq' || chosen.has(role.kind)) continue;
    const needs = NEEDS[role.kind] ?? `supplies content for a ${role.kind} section`;
    questions[`support_${role.role.replace(/_2$/, '')}`] = {
      type: 'noul', instructions: `Does \`brief\` support a ${role.kind} section? Judge supplied content only, independently of any block design.`,
      criteria: { true: `The brief ${needs}. The content belongs to the requested page.`, false: 'The content is absent, negated, or only describes a competitor. Do not infer or invent content.' },
    };
  }
  return questions;
}

export async function supportBlockPlan(input: {
  brief: string; plan: BlockPlan; catalog: BlockCatalog; asked: AskedPlan; pickerAnswers: unknown;
  options: JevBlockPlannerOptions; request: Parameters<typeof postSystemOne>[0];
}): Promise<{ plan: BlockPlan; supportGate: BlockSupportReceipt; calls: number }> {
  const { plan, catalog, options } = input;
  options.signal?.throwIfAborted();
  const threshold = options.supportThreshold ?? DEFAULT_SUPPORT_THRESHOLD;
  const receipt: BlockSupportReceipt = { threshold, added: [], removed: [], decisions: [] };
  const questions = buildBlockSupportQuestions(plan, catalog);
  let calls = 0;
  const skip = (skipped: BlockSupportReceipt['skipped']) => ({ plan, supportGate: { ...receipt, added: [], removed: [], skipped }, calls });
  const scores = new Map<string, number>();
  if (Object.keys(questions).length > 0) {
    try {
      input.request.signal?.throwIfAborted();
      calls = 1;
      const work = postSystemOne({ ...input.request, state: { brief: input.brief }, questions });
      const response = input.request.signal ? await withinBlockPlanDeadline(work, input.request.signal) : await work;
      options.signal?.throwIfAborted();
      if (!response.ok) return skip(sectionSkipReasonForStatus(response.status));
      const body: unknown = JSON.parse(response.text);
      const answers = (body as { answers?: Record<string, { type?: unknown; noul?: unknown }> } | null)?.answers;
      for (const key of Object.keys(questions)) {
        const answer = answers?.[key];
        if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return skip('jev-bad-answer');
        scores.set(key, answer.noul);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof SyntaxError) return skip('jev-bad-answer');
      return skip(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'jev-timeout' : 'jev-unreachable');
    }
  }
  const byId = new Map(catalog.blocks.map((block) => [block.id, block]));
  options.signal?.throwIfAborted();
  const faq = briefNeedsFaq(input.brief);
  const blocks = [...plan.blocks];
  const chosen = new Set(blocks.map((id) => byId.get(id)?.sectionKind));
  for (const role of shortlistBlocks(catalog, plan.spine)) {
    if (role.required || chosen.has(role.kind)) continue;
    const probability = scores.get(`support_${role.role.replace(/_2$/, '')}`);
    if (role.kind !== 'faq' && probability === undefined) continue;
    const supported = role.kind === 'faq' ? faq : probability! >= threshold;
    const decision: BlockSupportReceipt['decisions'][number] = { kind: role.kind, ...(probability !== undefined ? { probability } : {}), reason: role.kind === 'faq' ? (faq ? 'faq-brief-signal' : 'faq-no-brief-signal') : (supported ? 'supported' : 'below-threshold') };
    receipt.decisions.push(decision);
    if (!supported) continue;
    if (blocks.length >= MAX_BLOCKS) { decision.reason = 'capacity'; continue; }
    const asked = input.asked.roles.find((candidate) => candidate.role === role.role);
    if (!asked) return skip('jev-bad-answer');
    const checked = validateChoiceAnswer((input.pickerAnswers as Record<string, unknown>)[asked.key], new Set(asked.options.keys()));
    if ('reason' in checked) return skip('jev-bad-answer');
    const id = pickForRole(asked, checked.answer, byId, plan.spine, 0)?.id
      ?? role.candidates.find((candidate) => { const block = byId.get(candidate); return block && compatibleWith(block, plan.spine); });
    if (!id || blocks.includes(id)) continue;
    const order = shortlistBlocks(catalog, plan.spine).map((candidate) => candidate.kind);
    const at = blocks.findIndex((block) => order.indexOf(byId.get(block)!.sectionKind) > order.indexOf(role.kind));
    blocks.splice(at < 0 ? blocks.length : at, 0, id);
    chosen.add(role.kind);
    receipt.added.push({ kind: role.kind, id, reason: role.kind === 'faq' ? 'faq-brief-signal' : 'jev-brief-support', ...(probability !== undefined ? { probability } : {}) });
  }
  const supportedPlan = { ...plan, blocks };
  const hasBody = blocks.some((id) => !['hero', 'footer', 'cta-band'].includes(byId.get(id)!.sectionKind));
  if (!hasBody || checkBlockPlan(supportedPlan, catalog, [plan.directionId])) return skip('invalid-plan');
  return { plan: supportedPlan, supportGate: receipt, calls };
}
