/**
 * Picks the model the link-page builder reads people with: the local `claude` command on the
 * owner's own subscription when it is installed, else OpenRouter when OPENROUTER_API_KEY is set,
 * else none (the page is then built from plain signals alone).
 */
import { createLlm } from '@mish/linkpage';
import type { Llm } from '@mish/linkpage';
import { createClaudeCliLlm } from '@mish/linkpage/node';
import { resolveOnPath } from '../runtimes/executables.js';
import type { LinkPageFetch } from './safe-fetch.js';

export interface ResolveLlmDeps {
  env: NodeJS.ProcessEnv;
  fetch: LinkPageFetch;
  findClaude?: () => string | null;
}

export function resolveLinkPageLlm({ env, fetch, findClaude = () => resolveOnPath('claude') }: ResolveLlmDeps): Llm | undefined {
  if (findClaude()) return createClaudeCliLlm({ fetch });
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (apiKey) return createLlm({ apiKey });
  return undefined;
}
