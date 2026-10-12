/**
 * Provider failover for the fast lane's model calls.
 *
 * `createFailoverCaller` wraps two model callers — a primary and a secondary provider — behind
 * one `ModelCall`. Each call goes to the primary first. The primary caller has already made its
 * own bounded retries (`createModelCaller`'s `maxRetries`) by the time it rejects; if it then
 * failed BEFORE any output, for a reason another provider could plausibly not share, the same
 * request is sent to the secondary instead:
 *
 * - `rate-limited`: HTTP 429;
 * - `server-error`: HTTP 5xx;
 * - `timeout`: the per-call deadline fired while the caller's own signal was still live;
 * - `network`: `fetch` itself rejected (no response at all);
 * - `key-unavailable`: the primary's key is missing (`ProviderKeyError`). An unreadable key store
 *   (`ProviderKeyUnreadableError`) is a fault to repair, not an absence, and never fails over.
 *
 * Never a failover: a cancellation (the caller's signal aborted), any failure after the first
 * streamed byte or delta (the text may already be on the caller's screen), an auth answer
 * (401/403) or any other 4xx, and schema or JSON problems — those never throw here at all; the
 * run's own repair loop handles them.
 *
 * The switch is sticky and happens once per wrapper: the first eligible failure runs
 * `beforeSecondary` (the build takes the secondary's run lock there) and emits `onFailover`; every
 * other call that fails the same way meanwhile waits for that same switch, and every later call
 * goes straight to the secondary. There is no fail-back.
 *
 * Calls run concurrently in `sections` mode, so one build can take output from BOTH providers:
 * a section answered by the primary stays, while another section's call fails over. `providers()`
 * therefore records every provider/model whose answer was returned to the caller, in first-use
 * order, with the request labels (sections) each one filled. `answered()` is the last of them.
 *
 * When the secondary fails too, the error is a `ProviderFailoverError` naming both outcomes —
 * status-only, never a response body. The one exception is both legs failing for a missing key:
 * that stays a `ProviderKeyError`, so a daemon still reports `MODEL_UNAVAILABLE` for it.
 */

import { failedAfterStreamBytes, isCallerTimeout, isTransportFailure, ProviderHttpError, ProviderKeyError, ProviderKeyUnreadableError, transportRetryReasonOf, type ModelCall, type ModelRequest, type ProviderName } from './deepseek.ts';

export { ProviderKeyError, ProviderKeyUnreadableError } from './deepseek.ts';

export type FailoverReason = 'rate-limited' | 'server-error' | 'timeout' | 'network' | 'key-unavailable';

/**
 * One provider's outcome in a failed failover. `refused` is a non-retryable HTTP answer (4xx).
 * `skipped` is the primary on a call made after an earlier call already switched to the secondary:
 * this call never asked the primary, so it names no status of its own.
 */
export type FailoverAttempt = { provider: ProviderName; reason: FailoverReason | 'refused' | 'skipped'; status?: number };

function describe(attempt: FailoverAttempt): string {
  if (attempt.reason === 'skipped') return `${attempt.provider} skipped after an earlier failover`;
  if (attempt.status !== undefined) return `${attempt.provider} answered ${attempt.status}`;
  if (attempt.reason === 'timeout') return `${attempt.provider} timed out`;
  if (attempt.reason === 'network') return `${attempt.provider} had a network error`;
  return `${attempt.provider} key unavailable`;
}

/** Both providers failed. `message` is e.g. `deepseek answered 429, then cerebras timed out`. */
export class ProviderFailoverError extends Error {
  readonly attempts: FailoverAttempt[];
  constructor(attempts: FailoverAttempt[]) {
    super(attempts.map(describe).join(', then '));
    this.name = 'ProviderFailoverError';
    this.attempts = attempts;
  }
}

export type FailoverLeg = { provider: ProviderName; model: string; call: ModelCall };

export type FailoverOptions = {
  primary: FailoverLeg;
  secondary: FailoverLeg;
  /** The build's own signal. An abort there is a cancellation, never a failover. */
  userSignal?: AbortSignal;
  /** Runs once, before the first request goes to the secondary. A rejection fails the calls. */
  beforeSecondary?: () => Promise<void>;
  /** Called once, when the switch happens. */
  onFailover?: (event: { from: ProviderName; to: ProviderName; reason: FailoverReason }) => void;
};

/** One provider/model that answered at least one call of a build. `sections` lists the request
 * labels it answered (deduplicated, first-answer order); absent when no call carried a label. */
export type ProviderUse = { provider: ProviderName; model: string; sections?: string[] };

export type ProviderLedger = {
  note(provider: ProviderName, model: string, label: string | undefined): void;
  /** Every provider/model that answered, in first-use order. */
  providers(): ProviderUse[];
  /** The provider/model of the most recent answer, if any call has answered yet. */
  answered(): { provider: ProviderName; model: string } | undefined;
};

export function createProviderLedger(): ProviderLedger {
  const entries: Array<{ provider: ProviderName; model: string; sections: string[] }> = [];
  let last: { provider: ProviderName; model: string } | undefined;
  return {
    note(provider, model, label) {
      let entry = entries.find((candidate) => candidate.provider === provider && candidate.model === model);
      if (!entry) {
        entry = { provider, model, sections: [] };
        entries.push(entry);
      }
      if (label !== undefined && !entry.sections.includes(label)) entry.sections.push(label);
      last = { provider, model };
    },
    providers: () => entries.map(({ provider, model, sections }) => ({ provider, model, ...(sections.length > 0 ? { sections: [...sections] } : {}) })),
    answered: () => (last ? { ...last } : undefined),
  };
}

/** One leg with no failover, recording its answers the same way `createFailoverCaller` does. */
export function createRecordingCaller(leg: FailoverLeg): ModelCall & Pick<ProviderLedger, 'providers' | 'answered'> {
  const ledger = createProviderLedger();
  const call = (async (request: ModelRequest) => {
    const response = await leg.call(request);
    ledger.note(leg.provider, leg.model, request.label);
    return response;
  }) as ModelCall & Pick<ProviderLedger, 'providers' | 'answered'>;
  call.providers = ledger.providers;
  call.answered = ledger.answered;
  return call;
}

export type FailoverCaller = ModelCall & Pick<ProviderLedger, 'providers' | 'answered'> & {
  /** The leg new calls go to now: the secondary once the switch has happened. */
  active(): { provider: ProviderName; model: string };
};

/**
 * Classifies a rejection from one leg. `undefined` means "not eligible": rethrow as-is.
 * `streamed` is whether this request's `onDelta` fired. `signals` are every signal whose abort is
 * a cancellation — the build's own and the request's — so either one aborted means no failover.
 */
export function failoverReason(error: unknown, streamed: boolean, ...signals: Array<AbortSignal | undefined>): FailoverReason | undefined {
  if (signals.some((signal) => signal?.aborted)) return undefined;
  if (streamed || failedAfterStreamBytes(error)) return undefined;
  // A broken key store is surfaced, never masked by a working second provider.
  if (error instanceof ProviderKeyUnreadableError) return undefined;
  if (error instanceof ProviderKeyError) return 'key-unavailable';
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return 'rate-limited';
    if (error.status >= 500) return 'server-error';
    return undefined;
  }
  // The caller's own deadline fired (the caller tags these; see `isCallerTimeout`).
  if (isCallerTimeout(error)) return 'timeout';
  // No response arrived at all (the caller tags these; see `isTransportFailure`).
  if (isTransportFailure(error)) return 'network';
  return undefined;
}

function attemptOf(provider: ProviderName, error: unknown, reason: FailoverReason | undefined): FailoverAttempt | undefined {
  if (error instanceof ProviderHttpError) return { provider, reason: reason ?? 'refused', status: error.status };
  if (reason) return { provider, reason };
  return undefined;
}

export function createFailoverCaller(options: FailoverOptions): FailoverCaller {
  const { primary, secondary, userSignal } = options;
  const ledger = createProviderLedger();
  /** A cancellation from either the build's signal or this request's own. */
  const cancelled = (request: ModelRequest) => Boolean(userSignal?.aborted || request.signal?.aborted);
  let switched = false;
  let switching: Promise<void> | undefined;
  /** What made the switch happen: the primary's side of any later `ProviderFailoverError`. */
  let switchAttempt: FailoverAttempt | undefined;
  /**
   * Waits for `beforeSecondary` (shared: the lock is taken once however many calls fail at once),
   * then commits the switch — unless this request was cancelled while it waited. The check sits
   * between the wait and the commit, so a cancellation during the wait leaves `switched` unset,
   * emits no `failover` event, and a later call on the wrapper still goes to the primary.
   *
   * Answers whether the switch is committed, and separately whether THIS call is the one that
   * committed it (`committing`) — round 3 audit (Opus B1, reproduced): `sections` mode fires
   * several units' calls essentially at once, so several of them can independently discover the
   * primary is down and each reach here concurrently. Only ONE of them actually flips `switched`
   * from false to true (the `!switched` check below, reached one at a time since they all await
   * the SAME `switching` promise); every other one arrives to find it already true. `committing`
   * distinguishes that one call — the only one for which "there is no known-good secondary yet" is
   * actually true — from every other concurrent call, which is functionally in the same position
   * as a call that arrived after the switch was already fully established: see `callSecondary`'s
   * own use of this for why that distinction is the one that matters for retry eligibility.
   */
  const switchToSecondary = async (reason: FailoverReason, attempt: FailoverAttempt, request: ModelRequest): Promise<{ committed: boolean; committing: boolean }> => {
    switching ??= (async () => {
      await options.beforeSecondary?.();
    })();
    try {
      await switching;
    } catch (error) {
      // The wait itself failed (e.g. the lock wait was aborted): a cancellation ends the call
      // with the primary's own error, anything else is surfaced.
      if (cancelled(request)) return { committed: false, committing: false };
      throw error;
    }
    if (cancelled(request)) return { committed: false, committing: false };
    let committing = false;
    if (!switched) {
      switchAttempt = attempt;
      switched = true;
      committing = true;
      options.onFailover?.({ from: primary.provider, to: secondary.provider, reason });
    }
    return { committed: true, committing };
  };

  /**
   * `primaryAttempt` is what made the switch happen (it decides the both-keys-missing case);
   * `sticky` means this call itself never asked the primary, so the error names the primary as
   * skipped rather than repeating an earlier call's outcome — purely a message-formatting concern.
   * `retryable` is the separate, retry-eligibility concern: false only for the ONE call that
   * committed the switch (see `switchToSecondary`'s own doc) — for every other call, including a
   * concurrent racer that also asked the primary itself, the secondary is functionally already the
   * established leg by the time this call reaches it.
   */
  const callSecondary = async (request: ModelRequest, primaryAttempt: FailoverAttempt, sticky: boolean, retryable: boolean) => {
    // Tracked per call, and per leg. Safe even though the leg retries internally: the caller only
    // retries before the first byte of a response arrives, so a delta can never be followed by a
    // retry within this same call.
    let streamed = false;
    try {
      const response = await secondary.call({ ...request, onDelta: (text) => { streamed = true; request.onDelta?.(text); } });
      ledger.note(secondary.provider, secondary.model, request.label);
      return response;
    } catch (error) {
      if (cancelled(request) || streamed || failedAfterStreamBytes(error)) throw error;
      // Round 3 audit (Opus B1, reproduced): `build.ts` sets every provider's own internal retry
      // count to 0, on purpose — `run.ts`'s `callModel` is meant to be the one retry budget. But
      // wrapping a transport-class secondary failure in `ProviderFailoverError` (never retried, see
      // `transportRetryReasonOf`'s own doc) left the secondary with an effective budget of 0 —
      // worse than before this PR, when `createModelCaller`'s own default gave it 3. For any call
      // OTHER than the one that committed the switch (`retryable`), a transport-class failure here
      // is a retry-worthy blip like any other provider's transient failure, not a sign there is no
      // viable provider at all — rethrown RAW, so `callModel`'s per-unit budget retries it on the
      // SAME (secondary) provider and emits its own `transport-retry` event. The committing call
      // itself still wraps: it is the one call for which the secondary has not been tried at all
      // yet, so both legs failing there really does mean no leg has worked — and `callModel`'s
      // budget is scoped to "retry the same request again," never "try a new provider." A refusal
      // or other non-transport secondary failure still wraps either way.
      if (retryable && transportRetryReasonOf(error) !== undefined) throw error;
      const reason = failoverReason(error, streamed, userSignal, request.signal);
      const secondaryAttempt = attemptOf(secondary.provider, error, reason);
      if (!secondaryAttempt) throw error;
      // A key missing on both sides is a configuration problem, not a provider outage.
      if (primaryAttempt.reason === 'key-unavailable' && error instanceof ProviderKeyError) throw error;
      const primarySide: FailoverAttempt = sticky ? { provider: primary.provider, reason: 'skipped' } : primaryAttempt;
      throw new ProviderFailoverError([primarySide, secondaryAttempt]);
    }
  };

  const call = (async (request: ModelRequest) => {
    if (switched) return callSecondary(request, switchAttempt!, true, true);
    // Per call; see `callSecondary` for why the leg's internal retries cannot make this stale.
    let streamed = false;
    try {
      const response = await primary.call({ ...request, onDelta: (text) => { streamed = true; request.onDelta?.(text); } });
      ledger.note(primary.provider, primary.model, request.label);
      return response;
    } catch (error) {
      // Both signals: a request-only cancellation racing a primary 5xx must not switch providers.
      const reason = failoverReason(error, streamed, userSignal, request.signal);
      if (!reason) throw error;
      const attempt = attemptOf(primary.provider, error, reason)!;
      // The switch may wait on the secondary's run lock; a cancellation meanwhile ends this call
      // with the primary's own error, and the switch is not committed.
      const outcome = await switchToSecondary(reason, attempt, request);
      if (!outcome.committed) throw error;
      return callSecondary(request, attempt, false, !outcome.committing);
    }
  }) as FailoverCaller;

  call.active = () => (switched ? { provider: secondary.provider, model: secondary.model } : { provider: primary.provider, model: primary.model });
  call.providers = ledger.providers;
  call.answered = ledger.answered;
  return call;
}
