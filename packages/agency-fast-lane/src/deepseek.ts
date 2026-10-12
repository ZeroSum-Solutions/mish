/**
 * OpenAI-compatible streaming chat-completions caller for the fast lane, shared by every
 * provider in `PROVIDERS`.
 *
 * JSON mode is on: the model's whole output is the answer. Reasoning/thinking is turned off or
 * down per provider via `extraBody`. The API key is resolved into process memory when the first
 * call is made: `createProviderKeyResolver` takes the provider's environment variable
 * (`DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`) first and reads ZS Vault only when that is unset; the
 * daemon adds its own stored config between the two (`apps/daemon/src/storage/agency-config.ts`).
 * The key is never printed and never written to a file by this module.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SseParser } from './stream.ts';

export type Usage = { input: number; output: number; cachedRead: number };
export type ModelRequest = {
  system: string;
  user: string;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  /** Which part of the page this call fills (a unit label, or `page` for a whole-page call). Never
   * sent to the provider; `failover.ts` uses it to record which provider filled which section. */
  label?: string;
  /** Called once, synchronously, right before `run.ts`'s `callModel` retries this request after a
   * transport-class failure, before the retried attempt starts. A caller whose OWN `onDelta`
   * drives state that must not carry over into the retried attempt (single-page mode's per-call
   * `streamed`/`streamedOk` sets and its `SectionStream` parser, so a retried section is not
   * silently skipped as "already streamed" and no stale partial token leaks into the fresh
   * attempt) resets that state here. Never called on a caller's first attempt, never called once
   * `hasMergedOutput` (below) says a merge has happened, and never sent to the provider. */
  onRetry?: () => void;
  /**
   * Only a caller whose OWN `onDelta` merges output into shared, published state DURING the call
   * (single-page mode's stream parser merges each section into `working` as it closes, before this
   * call's promise resolves — see `run.ts`) needs this. Once it returns true, `run.ts`'s
   * `callModel` never retries the current failure, merged or not: there is no rollback of a mid-
   * call merge (round 2 audit, Opus B1 — a page-wide `working` snapshot/restore used to discard
   * OTHER units' concurrently-merged work when one unit retried, so it was removed instead of
   * scoped), so a call that has already merged something can only fail, not retry. A caller whose
   * `onDelta` never merges anything (every OTHER call in this codebase: a unit's fill, and every
   * technical or faithfulness repair, all merge only AFTER their `options.model(...)` call
   * resolves) omits this field entirely, which `callModel` reads as "never merged" — always safe
   * to retry, since nothing has changed yet.
   */
  hasMergedOutput?: () => boolean;
};
export type ModelResponse = { text: string; usage?: Usage; firstTokenMs?: number; ms: number; retries: number };
export type ModelCall = (request: ModelRequest) => Promise<ModelResponse>;

export type ProviderName = 'deepseek' | 'cerebras';

export type ProviderConfig = {
  baseURL: string;
  /** The environment variable that, when set, supplies the key without any vault read. */
  envKey: string;
  vaultKeyId: string;
  defaultModel: string;
  /** Merged into the request body last, so it can override anything above. */
  extraBody: Record<string, unknown>;
  /** One run at a time across processes (see lock.ts); for accounts with a per-minute token quota. */
  serializeRuns?: boolean;
};

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    vaultKeyId: 'deepseek_api_key',
    defaultModel: 'deepseek-flash',
    extraBody: { thinking: { type: 'disabled' } },
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    vaultKeyId: 'cerebras_api_key',
    // gpt-oss-120b is a reasoning model on Cerebras; reasoning_effort keeps it off the critical
    // path so the fast lane still gets a direct JSON answer.
    defaultModel: 'gpt-oss-120b',
    extraBody: { reasoning_effort: 'low' },
    // The account's tokens-per-minute quota, not the model, bounds throughput: five concurrent
    // sites returned 429 on four of them, one site at a time finishes in 0.8–2.5 s.
    serializeRuns: true,
  },
};

/**
 * A non-2xx answer from the model provider.
 *
 * `message` is status-only (`cerebras 429`) — the response body is a third-party API's own
 * arbitrary text, and this error is what a daemon build's failure eventually surfaces to a
 * caller (see `buildFailureMessage` in `apps/daemon/src/routes/agency-build.ts`, which reads only
 * `.message`), so the body must never be IN `.message` to begin with. It survives on `.detail`
 * instead, for the one caller that explicitly wants it back: the CLI, which prints it on stderr
 * after the status-only message (see `main` in `cli.ts`).
 */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  /** Capped the same way the message this replaces always was — long enough to be useful on
   * stderr, short enough that a provider's error page cannot make this object unbounded. */
  readonly detail?: string;
  constructor(provider: string, status: number, detail?: string) {
    super(`${provider} ${status}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The provider's key could not be resolved. `createModelCaller` wraps any rejection from its
 * `apiKey` resolver in this class — except a `ProviderKeyUnreadableError`, see below — (the original stays on `cause`), so a caller — the failover
 * wrapper, the daemon's failure mapping — can tell a missing key from every other failure. The
 * message names the provider only; it never carries the resolver's own text.
 */
export class ProviderKeyError extends Error {
  readonly provider: ProviderName;
  constructor(provider: ProviderName, cause?: unknown) {
    super(`${provider} key unavailable`, { cause });
    this.name = 'ProviderKeyError';
    this.provider = provider;
  }
}

/**
 * The provider's key store exists but could not be read (a corrupt or unreadable stored config).
 * Unlike `ProviderKeyError`, this is a fault the operator has to repair, not an absence, so the
 * failover wrapper never switches provider on it: a usable second provider would otherwise hide
 * the broken file behind a successful build. A resolver throws this class itself;
 * `createModelCaller` passes it through unwrapped. The message names the provider only.
 */
export class ProviderKeyUnreadableError extends Error {
  readonly provider: ProviderName;
  constructor(provider: ProviderName, cause?: unknown) {
    super(`${provider} key store could not be read`, { cause });
    this.name = 'ProviderKeyUnreadableError';
    this.provider = provider;
  }
}

/** Errors a caller threw after at least one byte of the response stream had arrived. */
const failedMidStream = new WeakSet<object>();

/**
 * Whether `error` was thrown after part of the response stream had already arrived. Such a
 * failure is never retried here and never failed over (see `failover.ts`): the bytes already
 * streamed may have reached the caller's `onDelta`, and a second answer would duplicate them.
 */
export function failedAfterStreamBytes(error: unknown): boolean {
  return typeof error === 'object' && error !== null && failedMidStream.has(error);
}

/** Errors a caller threw because no response (or no byte of one) arrived: a transport failure. */
const transportFailures = new WeakSet<object>();

/**
 * Whether `error` is a transport failure that survived the caller's retries: `fetch` itself
 * rejected, or the stream broke before its first byte, while the request's signal was still live.
 */
export function isTransportFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && transportFailures.has(error);
}

function markTransportFailure(error: unknown): void {
  if (typeof error === 'object' && error !== null) transportFailures.add(error);
}

/** A fixed code for why a unit's model call is worth one bounded fresh retry to the SAME provider
 * at a higher layer (see `run.ts`'s `callModel`) — never a copy of a provider's own error text. */
export type TransportRetryReason = 'ECONNRESET' | 'ETIMEDOUT' | 'ECONNREFUSED' | 'UND_ERR_SOCKET' | 'terminated' | 'http-5xx' | 'http-429' | 'network';

const TRANSPORT_RETRY_ERROR_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET']);

/**
 * Whether `error` is a transport-class failure a caller MAY retry with a fresh request to the same
 * provider — "may", not "will": `run.ts`'s `callModel` is the one that decides whether a retry is
 * actually safe right now, and for a call whose `onDelta` merges output mid-stream it can refuse
 * one this function would otherwise allow (see `ModelRequest.hasMergedOutput`'s own doc). This
 * function classifies the ERROR only, never the caller's merge state, which it has no way to see.
 *
 * Qualifies: `fetch` itself rejected or the stream broke before any byte arrived
 * (`isTransportFailure`, walked through `.cause` for a network-reset code or undici's own
 * `TypeError: terminated`); an HTTP 429/5xx that exhausted this module's own retries without
 * reading a byte of the body (`ProviderHttpError`); OR a failure after the stream had already
 * delivered a byte (`failedAfterStreamBytes`), but ONLY when its cause chain names one of the
 * network-reset codes below or undici's `terminated` — an unrecognized error arriving mid-stream
 * might be a genuine content or parse problem this layer cannot tell apart from a network blip,
 * and only a network blip is safe to retry at all. Never a refusal or a content/validation error.
 */
export function transportRetryReasonOf(error: unknown): TransportRetryReason | undefined {
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return 'http-429';
    if (error.status >= 500 && error.status <= 599) return 'http-5xx';
    return undefined;
  }
  const preByte = isTransportFailure(error);
  const midStream = !preByte && failedAfterStreamBytes(error);
  if (!preByte && !midStream) return undefined;
  for (let cause: unknown = error; cause !== undefined && cause !== null; cause = (cause as { cause?: unknown }).cause) {
    if (cause instanceof TypeError && cause.message === 'terminated') return 'terminated';
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && TRANSPORT_RETRY_ERROR_CODES.has(code)) return code as TransportRetryReason;
  }
  // A pre-first-byte transport failure whose cause chain named none of the above codes: still a
  // fetch-level rejection or a pre-first-byte stream break by construction (see
  // `isTransportFailure`), so it qualifies as a retry, just under a generic code rather than a
  // specific one. A MID-stream failure gets no such fallback: without a recognized network-reset
  // code or undici's own "terminated", it might be a genuine content or parse problem this layer
  // cannot tell apart from a network blip, and only a network blip is worth even asking `run.ts`
  // to retry at all.
  return preByte ? 'network' : undefined;
}

/** Errors a caller threw because its own per-call deadline (`timeoutMs`) fired. */
const timeoutFailures = new WeakSet<object>();

/**
 * Whether `error` is the caller's own deadline firing (`timeoutMs`) while the request's signal was
 * still live. Tagged by the caller itself, so the classification never depends on the runtime's
 * choice of abort-reason class or `name`.
 */
export function isCallerTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && timeoutFailures.has(error);
}

function markTimeout(error: unknown): void {
  if (typeof error === 'object' && error !== null) timeoutFailures.add(error);
}

type ExecFileAsync = (file: string, args: string[], options?: { maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileAsync = promisify(execFile);

/**
 * One-shot ZS Vault read. The value stays in memory.
 *
 * `execFile` attaches `stdout`/`stderr` to the Error it rejects with on a non-zero exit, so a
 * `zsvault` failure after it has already printed the key would carry the key on the error object
 * itself. The catch below discards that error entirely and throws a fixed message instead, so the
 * key can never ride out on a caller's `console.error(err)` or default uncaught-error printing.
 */
export async function vaultSecret(id: string, exec: ExecFileAsync = execFileAsync): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec('zsvault', ['get', id], { maxBuffer: 64 * 1024 }));
  } catch {
    throw new Error(`failed to read ${id} from zsvault`);
  }
  const value = stdout.trim();
  if (!value) throw new Error(`zsvault returned no value for ${id}`);
  return value;
}

/**
 * The key resolution used when a caller supplies no `apiKey`: the provider's environment variable
 * (`PROVIDERS[p].envKey`) when it is set and non-blank, the vault otherwise. The vault is not read
 * at all when the environment supplies the key, so a machine with no `zsvault` works from the
 * environment alone.
 */
export function createProviderKeyResolver(
  env: Readonly<Record<string, string | undefined>>,
  readVault: (id: string) => Promise<string> = (id) => vaultSecret(id),
): (provider: ProviderName) => Promise<string> {
  return async (provider) => providerEnvKey(env, provider) || readVault(PROVIDERS[provider].vaultKeyId);
}

/**
 * The provider's key from the environment (`PROVIDERS[p].envKey`), trimmed; `''` when it is unset
 * or blank. The one env read for a fill-model key: the fast lane's resolver above and the daemon's
 * key store both use it, so their blank/trim semantics cannot drift apart.
 */
export function providerEnvKey(env: Readonly<Record<string, string | undefined>>, provider: ProviderName): string {
  return env[PROVIDERS[provider].envKey]?.trim() ?? '';
}

export function addUsage(total: Usage, part?: Usage): void {
  if (!part) return;
  total.input += part.input;
  total.output += part.output;
  total.cachedRead += part.cachedRead;
}

export type CallerOptions = {
  provider?: ProviderName;
  apiKey?: () => Promise<string>;
  model?: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Retries on a 429/500/502/503/504 or a network error before any byte of the stream arrived. */
  maxRetries?: number;
  /** Overrides the backoff wait, mainly so tests don't sit through real delays. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Longest wait between attempts; a larger retry-after would overflow Node's timer and fire at once. */
const MAX_BACKOFF_MS = 5 * 60_000;

/** `retry-after` as whole seconds, or an HTTP-date; undefined when neither parses. */
function parseRetryAfterMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/** Exponential backoff (1s, 2s, 4s, ...) with +/-25% jitter, unless a retry-after header overrides it. */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null | undefined): number {
  const fromHeader = retryAfterHeader ? parseRetryAfterMs(retryAfterHeader) : undefined;
  if (fromHeader !== undefined) return Math.min(fromHeader, MAX_BACKOFF_MS);
  const base = 1000 * 2 ** attempt;
  const jitter = base * 0.25;
  return Math.min(base + (Math.random() * 2 - 1) * jitter, MAX_BACKOFF_MS);
}

/** Waits `ms`, or rejects as soon as `signal` aborts — never lets an abort wait out the backoff. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type UsageEvent = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

export function createModelCaller(options: CallerOptions = {}): ModelCall {
  const providerName = options.provider ?? 'deepseek';
  const provider = PROVIDERS[providerName];
  const model = options.model ?? provider.defaultModel;
  const baseURL = (options.baseURL ?? provider.baseURL).replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;
  let cachedKey: Promise<string> | undefined;
  const resolveKey = options.apiKey ?? (() => createProviderKeyResolver(process.env)(providerName));
  // Any rejection is a missing key (`ProviderKeyError`, failover-eligible) except an unreadable
  // key store, which the resolver marks itself and which passes through as-is (never a failover).
  const key = () => (cachedKey ??= resolveKey().catch((error: unknown) => {
    if (error instanceof ProviderKeyUnreadableError) throw error;
    throw new ProviderKeyError(providerName, error);
  }));

  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  return async (request) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await attempt(request, timeout);
    } catch (error) {
      // The deadline fired and the caller's own signal did not: tag it as a timeout.
      if (timeout.aborted && !request.signal?.aborted) markTimeout(error);
      throw error;
    }
  };

  async function attempt(request: ModelRequest, timeout: AbortSignal): Promise<ModelResponse> {
    const started = performance.now();
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = {
      model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      max_tokens: options.maxTokens ?? 16_384,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...provider.extraBody,
    };
    const authorization = `Bearer ${await key()}`;

    let retries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        // No byte of any response arrived at all; safe to retry like any other transient failure.
        if (signal.aborted) throw error;
        if (retries >= maxRetries) {
          markTransportFailure(error);
          throw error;
        }
        retries += 1;
        await sleep(backoffDelayMs(retries - 1, undefined), signal);
        continue;
      }
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        if (RETRYABLE_STATUSES.has(response.status) && retries < maxRetries) {
          retries += 1;
          await sleep(backoffDelayMs(retries - 1, response.headers.get('retry-after')), signal);
          continue;
        }
        throw new ProviderHttpError(providerName, response.status, detail.slice(0, 500));
      }

      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let text = '';
      let usage: Usage | undefined;
      let firstTokenMs: number | undefined;
      let byteReceived = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          byteReceived = true;
          for (const data of parser.push(decoder.decode(value, { stream: true }))) {
            let event: { choices?: Array<{ delta?: { content?: string } }>; usage?: UsageEvent };
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = event.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              if (firstTokenMs === undefined) firstTokenMs = Math.round(performance.now() - started);
              text += delta;
              request.onDelta?.(delta);
            }
            if (event.usage) {
              usage = {
                input: event.usage.prompt_tokens ?? 0,
                output: event.usage.completion_tokens ?? 0,
                cachedRead: event.usage.prompt_cache_hit_tokens ?? event.usage.prompt_tokens_details?.cached_tokens ?? 0,
              };
            }
          }
        }
      } catch (error) {
        // Once a byte of the stream has arrived, retrying would duplicate partial output — surface
        // the error as-is instead.
        if (!byteReceived && !signal.aborted && retries < maxRetries) {
          retries += 1;
          await sleep(backoffDelayMs(retries - 1, undefined), signal);
          continue;
        }
        if (byteReceived && typeof error === 'object' && error !== null) failedMidStream.add(error);
        else if (!signal.aborted) markTransportFailure(error);
        throw error;
      }
      return { text, usage, firstTokenMs, ms: Math.round(performance.now() - started), retries };
    }
  }
}
