/**
 * Picks the models the link-page builder reads people with, in two lanes like the brief generator:
 * OpenRouter first (key from the daemon key store: env, saved key, then vault), the local `claude`
 * command on the owner's subscription second, else none (the page is then built from plain signals).
 * A failed OpenRouter call falls back to `claude`, a cancelled one does not.
 */
import { createLlm } from '@mish/linkpage';
import type { Llm, LlmRequest } from '@mish/linkpage';
import { createClaudeCliLlm } from '@mish/linkpage/node';
import { resolveOnPath } from '../runtimes/executables.js';
import type { LinkPageFetch } from './safe-fetch.js';

/**
 * Pinned on purpose. The style-from-photos step sends pictures, so the model must read images;
 * `createModelCaller` (the brief lane) is text-only, so @mish/linkpage's own client carries the
 * call. Claude Sonnet 5.5 sees images, answers JSON mode cleanly, and is the model the `claude`
 * lane runs, so both lanes read people alike. The brief's GPT Terra pin was measured on text only.
 */
export const LINKPAGE_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';

const KEY_TIMEOUT_MS = 5_000;
const OPENROUTER_TIMEOUT_MS = 60_000;

export interface ResolveLlmDeps {
  /** The daemon key store's OpenRouter lookup. Rejecting means no key. Never logged here. */
  resolveKey: () => Promise<string>;
  fetch: LinkPageFetch;
  findClaude?: () => string | null;
  keyTimeoutMs?: number;
  /** Test seams: build each lane's client. */
  makeOpenRouter?: (apiKey: string) => Llm;
  /** Gets the resolved path of the `claude` program, so the lane runs the one that was found. */
  makeClaude?: (executable: string) => Llm;
  /** The fetch under the OpenRouter client (default: global fetch) and its time limit. */
  openRouterFetch?: typeof globalThis.fetch;
  openRouterTimeoutMs?: number;
}

/** A fetch that gives up after `ms`, so a stalled provider falls back instead of hanging the build. */
export function fetchWithTimeout(base: typeof globalThis.fetch, ms: number): typeof globalThis.fetch {
  return ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const timeout = AbortSignal.timeout(ms);
    return base(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  }) as typeof globalThis.fetch;
}

/** The key, or undefined when there is none or the lookup stalls past its deadline. */
async function boundedKey(lookup: () => Promise<string>, ms: number): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const key = await Promise.race([
      Promise.resolve().then(lookup),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('openrouter key timeout')), ms); }),
    ]);
    return key.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const cancelled = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** OpenRouter first, `claude` when it fails (never on a cancel). */
function withFallback(primary: Llm, fallback: Llm): Llm {
  return {
    async json(request: LlmRequest) {
      try {
        return await primary.json(request);
      } catch (error) {
        if (cancelled(error)) throw error;
        return fallback.json(request);
      }
    },
  };
}

export async function resolveLinkPageLlm(deps: ResolveLlmDeps): Promise<Llm | undefined> {
  const { fetch, findClaude = () => resolveOnPath('claude'), keyTimeoutMs = KEY_TIMEOUT_MS } = deps;
  const timed = fetchWithTimeout(deps.openRouterFetch ?? globalThis.fetch, deps.openRouterTimeoutMs ?? OPENROUTER_TIMEOUT_MS);
  const makeOpenRouter = deps.makeOpenRouter ?? ((apiKey: string) => createLlm({ apiKey, model: LINKPAGE_OPENROUTER_MODEL, fetch: timed }));
  const makeClaude = deps.makeClaude ?? ((executable: string) => createClaudeCliLlm({ fetch, executable }));
  const apiKey = await boundedKey(deps.resolveKey, keyTimeoutMs);
  const claudePath = findClaude();
  const claude = claudePath ? makeClaude(claudePath) : undefined;
  if (apiKey) {
    const openrouter = makeOpenRouter(apiKey);
    return claude ? withFallback(openrouter, claude) : openrouter;
  }
  return claude;
}
