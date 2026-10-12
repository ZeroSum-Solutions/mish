import { postSystemOne, type JevKeyResolver } from '@mish/agency-fast-lane/jev';
import type { BriefGroundingChecker, BriefGroundingResult, BriefJudgment } from './grounding.js';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** TypeSafe accepts at most 32 questions per request; larger checks split and run in parallel. */
const MAX_QUESTIONS = 32;
/** A claim stays stated only when Jev is this sure every assertion is entailed. Lower is a gap the user confirms. */
export const JEV_SUPPORTED_MIN = 0.85;
/** Below this, a non-supported claim is "needs confirmation", never "the opposite". */
const CONTRADICTED_MIN = 0.5;
/** A yes/no between this and JEV_SUPPORTED_MIN is not a decision; the model checker takes over. */
const NO_MAX = 0.15;
/** Well under TypeSafe's per-request context ceiling; larger input goes to the fallback checker. */
const MAX_INPUT_CHARS = 60_000;
/** Pinned like the fast lane's other Jev callers, so a model release cannot shift the thresholds silently. */
export const JEV_GROUNDING_MODEL = 'jev-1.13.0';

const CLAIM_CRITERIA = {
  supported: 'Every assertion in the claim is stated in the description or is a faithful paraphrase of it.',
  unsupported: 'At least one assertion is absent from the description, invented, merely plausible, or needs confirmation.',
  contradicted: 'The description says the opposite of at least one assertion, including negations, exclusions, quantities, conditions or scope.',
} as const;

const REASONS: Record<Exclude<BriefJudgment['status'], 'supported'>, string> = {
  unsupported: 'Your description does not state all of this.',
  contradicted: 'Your description says the opposite of part of this.',
};

/** Jev declined a judgment it cannot make (extracting client typography); the caller's fallback should run. */
export class JevGroundingDeferredError extends Error {
  constructor(reason: string) { super(reason); this.name = 'JevGroundingDeferredError'; }
}

type Question = { type: 'choice' | 'noul'; instructions: string; criteria?: unknown };

export interface JevBriefGroundingCheckerOptions {
  apiKey: JevKeyResolver;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** A Choice answer over exactly the claim criteria, each a probability, summing to about one. Anything else is a provider fault. */
function claimJudgment(answer: unknown): BriefJudgment {
  const value = answer as { type?: unknown; probabilities?: Record<string, unknown> } | undefined;
  const probabilities = value?.probabilities;
  if (value?.type !== 'choice' || !probabilities || typeof probabilities !== 'object') throw new Error('Invalid Jev claim answer');
  const keys = Object.keys(CLAIM_CRITERIA) as Array<keyof typeof CLAIM_CRITERIA>;
  if (!keys.every(key => probability(probabilities[key]))) throw new Error('Invalid Jev claim answer');
  const p = (key: keyof typeof CLAIM_CRITERIA) => probabilities[key] as number;
  const total = keys.reduce((sum, key) => sum + p(key), 0);
  if (total < 0.95 || total > 1.05) throw new Error('Invalid Jev claim answer');
  if (p('supported') >= JEV_SUPPORTED_MIN) return { status: 'supported', reason: 'Your description states this.' };
  const status = p('contradicted') >= CONTRADICTED_MIN && p('contradicted') > p('unsupported') && p('contradicted') > p('supported') ? 'contradicted' : 'unsupported';
  return { status, reason: REASONS[status] };
}

function noul(answer: unknown): number {
  const value = answer as { type?: unknown; noul?: unknown } | undefined;
  if (value?.type !== 'noul' || !probability(value.noul)) throw new Error('Invalid Jev yes/no answer');
  return value.noul;
}

/**
 * Runs `work` under its own controller: the caller's cancellation and the
 * deadline both abort it, and the result rejects at once even while `work`
 * waits on something unabortable such as a key lookup. A late settlement of
 * `work` is always handled. The caller's signal stays untouched for the fallback.
 */
function bounded<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const finish = (settle: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); settle(); };
    const onAbort = () => { controller.abort(signal.reason); finish(() => reject(signal.reason ?? new Error('aborted'))); };
    const timer = setTimeout(() => { controller.abort(new Error('jev timeout')); finish(() => reject(new Error('jev timeout'))); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    work(controller.signal).then(result => finish(() => resolve(result)), error => finish(() => reject(error)));
  });
}

/** Fixed reason codes for the fallback log: never an error message, which can carry provider text. */
export function groundingFallbackReason(error: unknown): string {
  if (error instanceof JevGroundingDeferredError) return 'deferred: client typography needs model extraction';
  const message = error instanceof Error ? error.message : '';
  if (/^jev \d{3}$/u.test(message)) return message;
  if (message === 'jev timeout') return 'timeout';
  if (message === 'Grounding input exceeds the Jev budget') return 'input over budget';
  if (message.startsWith('Invalid Jev') || message === 'Jev answer missing') return 'invalid answer';
  return 'unavailable';
}

/**
 * Grounding on TypeSafe Jev: one typed choice per claim, judged against the
 * original description only. Jev judges; it never writes brief content. When
 * the client names fonts and the transformer's typography is not confirmed
 * complete, or Jev is unsure, this throws `JevGroundingDeferredError` so the
 * model checker extracts them. Measured 0.1-0.2 s where the model turn it
 * replaces took about 4 s.
 */
export function createJevBriefGroundingChecker(options: JevBriefGroundingCheckerOptions): BriefGroundingChecker {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const model = options.model ?? JEV_GROUNDING_MODEL;
  // Short: on a hang the fallback model turn still has to run inside the user's wait.
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  async function check(input: Parameters<BriefGroundingChecker['check']>[0], signal: AbortSignal): Promise<BriefGroundingResult> {
    if (input.originalText.length + input.claims.reduce((total, claim) => total + claim.value.length, 0) > MAX_INPUT_CHARS) throw new Error('Grounding input exceeds the Jev budget');
    const typographyClaim = input.claims.some(claim => claim.id === 'design.typography');
    const questions: Array<[string, Question]> = [
      ...input.claims.map((claim, index): [string, Question] => [`claim_${index}`, {
        type: 'choice', criteria: CLAIM_CRITERIA,
        instructions: `Judge claims[${JSON.stringify(claim.id)}] against original_description only. Project context, references and world knowledge are not evidence. A section claim needs its name and purpose both supported.`,
      }]),
      ['names_font', { type: 'noul', instructions: 'Does original_description explicitly ask to use at least one named font family? A font the client only rejects or avoids does not count.' }],
      ...(typographyClaim ? [['typography_complete', { type: 'noul', instructions: 'Does claims["design.typography"] carry every typography requirement in original_description: each named font family with its role, and every explicit weight, style, size or exclusion?' }] as [string, Question]] : []),
    ];
    const state = { original_description: input.originalText, claims: Object.fromEntries(input.claims.map(claim => [claim.id, claim.value])) };
    const batches: Array<Array<[string, Question]>> = [];
    for (let start = 0; start < questions.length; start += MAX_QUESTIONS) batches.push(questions.slice(start, start + MAX_QUESTIONS));
    const answers: Record<string, unknown> = {};
    await Promise.all(batches.map(async batch => {
      const response = await postSystemOne({ endpoint, model, timeoutMs, fetchImpl, key: options.apiKey, state, questions: Object.fromEntries(batch), signal });
      // Status only: the body is third-party text and never leaves this function.
      if (!response.ok) throw new Error(`jev ${response.status}`);
      let body: { answers?: Record<string, unknown> };
      // A parse error message can quote the body; replace it.
      try { body = JSON.parse(response.text) as typeof body; } catch { throw new Error('Invalid Jev response'); }
      for (const [name] of batch) {
        if (!body.answers || !(name in body.answers)) throw new Error('Jev answer missing');
        answers[name] = body.answers[name];
      }
    }));
    const claims = input.claims.map((claim, index) => ({ id: claim.id, ...claimJudgment(answers[`claim_${index}`]) }));
    const namesFont = noul(answers.names_font);
    const supported = claims.some(claim => claim.id === 'design.typography' && claim.status === 'supported');
    const complete = typographyClaim ? noul(answers.typography_complete) : 0;
    // Named fonts must be carried, confirmed and complete; a stated typography (weights, exclusions) must be complete.
    if (namesFont > NO_MAX && (namesFont < JEV_SUPPORTED_MIN || !supported || complete < JEV_SUPPORTED_MIN)) throw new JevGroundingDeferredError('Client typography needs model extraction');
    if (supported && complete < JEV_SUPPORTED_MIN) throw new JevGroundingDeferredError('Client typography needs model extraction');
    // The transformer's own typography stands, judged like any other claim.
    return { claims, typography: null };
  }
  return {
    // The deadline covers key resolution too: a stalled vault lookup must not hold the preview lock.
    check: (input, signal) => bounded(primary => check(input, primary), signal, timeoutMs + 2_000),
  };
}

/**
 * Jev first; when it is unavailable (no key, network, bad answer) or defers,
 * the model turn still grounds the brief. `onFallback` gets a fixed reason
 * code, never an error message, so no provider body or key can reach a log.
 */
export function withGroundingFallback(primary: BriefGroundingChecker, fallback: BriefGroundingChecker, onFallback: (reason: string) => void = () => {}): BriefGroundingChecker {
  return {
    async check(input, signal) {
      try { return await primary.check(input, signal); } catch (error) {
        if (signal.aborted) throw error;
        onFallback(groundingFallbackReason(error));
        return fallback.check(input, signal);
      }
    },
  };
}
