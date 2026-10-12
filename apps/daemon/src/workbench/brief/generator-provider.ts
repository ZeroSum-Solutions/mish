import { createModelCaller, type CallerOptions, type ModelCall, type ProviderName } from '@mish/agency-fast-lane/deepseek';
import { reportedModelId, type BriefGenerator } from './generator.js';
import { DESIGN_BRIEF_MODEL_JSON_SCHEMA } from './prompt.js';

/**
 * For lanes without schema enforcement: the schema rides in the system prompt.
 * Without the explicit shape line they flatten {value, basis} fields to bare strings.
 */
export function withSchemaInstructions(system: string): string {
  const shape = 'Every field with "value" and "basis" in the schema is an object such as {"value": "Local families", "basis": "assumed"} or {"value": null, "basis": "assumed"}, never a bare string. Include every required key.';
  return `${system}\n${shape}\nReturn one JSON object that matches this JSON schema exactly:\n${JSON.stringify(DESIGN_BRIEF_MODEL_JSON_SCHEMA)}`;
}

export interface ProviderBriefGeneratorOptions {
  provider: ProviderName;
  model?: string;
  apiKey?: CallerOptions['apiKey'];
  /** Injected in tests; defaults to the fast lane's OpenAI-compatible streaming caller. */
  call?: ModelCall;
  timeoutMs?: number;
}

/**
 * The transformer on a metered OpenAI-compatible lane (DeepSeek, Cerebras).
 * These lanes have JSON mode but no schema enforcement, so the schema rides in
 * the system prompt and the service's validation and single repair still gate
 * the answer. User text leaves the machine for that vendor: wiring one into
 * the product is a data-handling decision, not only a speed one.
 */
export function createProviderBriefGenerator(options: ProviderBriefGeneratorOptions): BriefGenerator {
  const call = options.call ?? createModelCaller({
    provider: options.provider, ...(options.model ? { model: options.model } : {}), ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    timeoutMs: options.timeoutMs ?? 60_000, maxRetries: 1, temperature: 0.2,
  });
  return {
    id: options.provider, modelId: options.model ?? options.provider, billingLane: `metered-${options.provider}`, maxInputChars: 100_000,
    async available() { return { available: true }; },
    async generate(input, signal) {
      const response = await call({ system: withSchemaInstructions(input.system), user: input.user, signal });
      // The transport reports no model id; never infer one from the request.
      return { text: response.text, reportedModel: null };
    },
  };
}

/** GPT Terra on OpenRouter, pinned to the model the 2026-10-10 eval measured (the `~openai/gpt-terra-latest` alias resolved to it). */
export const BRIEF_TERRA_MODEL = 'openai/gpt-5.6-terra';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterBriefGeneratorOptions {
  /** Resolves the OpenRouter key (daemon key store: env, saved key, then vault). Rejecting means no key. */
  apiKey: () => Promise<string>;
  model?: string;
  timeoutMs?: number;
  /** Bound on the key lookup, which can reach the vault; a stalled lookup must not hold a preview. */
  keyTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Resolves the key or rejects at the deadline or on cancellation, whatever the lookup is waiting on. */
function boundedKey(apiKey: () => Promise<string>, ms: number, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const finish = (settle: () => void) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); settle(); };
    const onAbort = () => finish(() => reject(signal!.reason ?? new Error('aborted')));
    const timer = setTimeout(() => finish(() => reject(new Error('openrouter key timeout'))), ms);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    let lookup: Promise<string>;
    try { lookup = Promise.resolve(apiKey()); } catch (error) { lookup = Promise.reject(error); }
    lookup.then(key => finish(() => resolve(key)), error => finish(() => reject(error)));
  });
}

/**
 * The transformer on OpenRouter. Like the other metered lanes it has JSON mode
 * but no schema enforcement, so the schema rides in the system prompt. The
 * reported model is the one OpenRouter says it ran. Errors are status-only:
 * the provider body never leaves this function.
 */
export function createOpenRouterBriefGenerator(options: OpenRouterBriefGeneratorOptions): BriefGenerator {
  const model = options.model ?? BRIEF_TERRA_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const keyTimeoutMs = options.keyTimeoutMs ?? 5_000;
  // One lookup in flight at a time: a hung vault read cannot be cancelled, so later calls wait on the
  // same lookup instead of each spawning another that outlives its deadline.
  let pendingKey: Promise<string> | null = null;
  const lookupKey = () => (pendingKey ??= Promise.resolve().then(options.apiKey).finally(() => { pendingKey = null; }));
  return {
    id: 'openrouter', modelId: model, billingLane: 'metered-openrouter', maxInputChars: 100_000,
    async available() {
      try { return (await boundedKey(lookupKey, keyTimeoutMs)).trim() ? { available: true } : { available: false, reason: 'No OpenRouter key is configured', recovery: 'Add an OpenRouter key, or Improve prompt uses Claude.' }; }
      catch { return { available: false, reason: 'No OpenRouter key is configured', recovery: 'Add an OpenRouter key, or Improve prompt uses Claude.' }; }
    },
    async generate(input, signal) {
      const key = (await boundedKey(lookupKey, keyTimeoutMs, signal)).trim();
      const response = await fetchImpl(OPENROUTER_CHAT_URL, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 8_000, reasoning: { effort: 'low' },
          messages: [{ role: 'system', content: withSchemaInstructions(input.system) }, { role: 'user', content: input.user }],
        }),
      });
      if (!response.ok) throw new Error(`openrouter ${response.status}`);
      let body: { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
      try { body = await response.json() as typeof body; } catch { throw new Error('openrouter invalid response'); }
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('openrouter empty answer');
      return { text, reportedModel: reportedModelId(body.model), requestedModel: model };
    },
  };
}
