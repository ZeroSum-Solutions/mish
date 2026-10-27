import type { FetchFn, Llm, LlmRequest } from './types.ts';

// A small client for asking a model for JSON through OpenRouter. Pass `fetch` in tests; nothing else is global.

interface OpenRouterReply {
  error?: { message?: string };
  choices?: { message?: { content?: string } }[];
}

const URL_ = 'https://openrouter.ai/api/v1/chat/completions';

// The model sometimes wraps its JSON in a ```json fence even when told not to.
export function parse(text: unknown): unknown {
  const body = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('the model did not answer with valid JSON');
  }
}

export interface LlmOptions {
  apiKey?: string;
  model?: string;
  fetch?: FetchFn;
}

export function createLlm({ apiKey, model = 'anthropic/claude-sonnet-5.5', fetch = globalThis.fetch }: LlmOptions = {}): Llm {
  if (!apiKey) throw new Error('an OpenRouter apiKey is required');
  return {
    // images are https URLs, sent after the text.
    async json({ system, user, images = [] }: LlmRequest): Promise<unknown> {
      const content = [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
      const res = await fetch(URL_, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Mishmash link page' },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content }],
        }),
      });
      const out = (await res.json().catch(() => ({}))) as OpenRouterReply;
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${out.error?.message || 'request failed'}`);
      // OpenRouter can answer 200 and still report a failure in the body.
      if (out.error) throw new Error(`OpenRouter: ${out.error.message || 'request failed'}`);
      return parse(out.choices?.[0]?.message?.content);
    },
  };
}
