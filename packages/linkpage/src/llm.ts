import type { FetchFn, Llm, LlmRequest } from './types.ts';

// A small client for asking a model for JSON through OpenRouter. Pass `fetch` in tests; nothing else is global.

interface OpenRouterReply {
  error?: { message?: string };
  choices?: { message?: { content?: string } }[];
}

const URL_ = 'https://openrouter.ai/api/v1/chat/completions';

// The model sometimes wraps its JSON in a ```json fence even when told not to.
/** Why a model call failed, as a fixed code. Never carries a response body, a key or a URL. */
export type LlmFailureCode = 'out-of-credits' | 'bad-key' | 'http-error' | 'invalid-output' | 'model-not-set';

export class LlmError extends Error {
  code: LlmFailureCode;
  status: number | undefined;
  constructor(code: LlmFailureCode, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

export function parse(text: unknown): unknown {
  const body = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    throw new LlmError('invalid-output', 'the model did not answer with valid JSON');
  }
}

export interface LlmOptions {
  apiKey?: string;
  model?: string;
  fetch?: FetchFn;
  /** Another OpenAI-compatible base URL (no trailing path), for example Baseten. Default: OpenRouter. */
  baseUrl?: string;
  /** The name used in error messages. Default 'OpenRouter'. */
  provider?: string;
  /** Send `response_format: json_object`. Default true; a provider that rejects it can turn it off. */
  jsonMode?: boolean;
}

export function createLlm({ apiKey, model = 'anthropic/claude-sonnet-5.5', fetch = globalThis.fetch, baseUrl, provider = 'OpenRouter', jsonMode = true }: LlmOptions = {}): Llm {
  if (!apiKey) throw new Error(`a ${provider} apiKey is required`);
  const endpoint = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/chat/completions` : URL_;
  return {
    // images are https URLs, sent after the text.
    async json({ system, user, images = [] }: LlmRequest): Promise<unknown> {
      const content = [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(baseUrl ? {} : { 'X-Title': 'Mish link page' }) },
        body: JSON.stringify({
          model,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [{ role: 'system', content: system }, { role: 'user', content }],
        }),
      });
      // The reply body is read for the answer only. Error text from it is never put in a message.
      const out = (await res.json().catch(() => ({}))) as OpenRouterReply;
      if (res.status === 402) throw new LlmError('out-of-credits', `${provider} is out of credits`, 402);
      if (res.status === 401) throw new LlmError('bad-key', `${provider} rejected the key`, 401);
      if (!res.ok) throw new LlmError('http-error', `${provider} answered ${res.status}`, res.status);
      // OpenRouter can answer 200 and still report a failure in the body.
      if (out.error) throw new LlmError('http-error', `${provider} reported an error`);
      return parse(out.choices?.[0]?.message?.content);
    },
  };
}
