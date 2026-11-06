/**
 * Picks the models the link-page builder reads people with, in two lanes like the brief generator:
 * OpenRouter first (key from the daemon key store: env, saved key, then vault), the local `claude`
 * command on the owner's subscription second, else none (the page is then built from plain signals).
 * A failed OpenRouter call falls back to `claude`, a cancelled one does not.
 */
import { LlmError, createLlm } from '@mish/linkpage';
import { isLinkPageModelLaneChoice } from '@mish/contracts';
import type { LinkPageModelFallbackReason, LinkPageModelInfo, LinkPageModelLaneChoice } from '@mish/contracts';
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
  /** The owner's pick. 'claude-cli' never calls resolveKey; 'openrouter' never uses the CLI. Default 'auto'. */
  lane?: LinkPageModelLaneChoice;
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

/** An Llm that can say, after a build, which lane answered its calls. */
export interface ReportingLlm extends Llm {
  report: () => LinkPageModelInfo;
}

/** A fixed reason code for a failed OpenRouter call; the error text itself is never kept. */
export function fallbackReason(error: unknown): LinkPageModelFallbackReason {
  if (error instanceof LlmError) return error.code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'http-error';
}

/** The lane of every answered call is counted; one fallback is remembered (the first reason). */
function track(lanes: { openrouter?: Llm; claude?: Llm }, noKey: boolean, forced = false): ReportingLlm {
  let calls = 0;
  let failed: LinkPageModelFallbackReason | undefined;
  let last: 'openrouter' | 'claude-cli' | undefined;
  let reason: LinkPageModelFallbackReason | undefined = noKey && !forced ? 'no-key' : undefined;
  const answered = (lane: 'openrouter' | 'claude-cli') => { calls += 1; last = lane; };
  return {
    async json(request: LlmRequest) {
      if (lanes.openrouter) {
        try {
          const value = await lanes.openrouter.json(request);
          answered('openrouter');
          return value;
        } catch (error) {
          // A cancel, or a failure with nothing to fall back to, goes to the caller.
          if (cancelled(error) || !lanes.claude) {
            if (!cancelled(error) && forced) failed ??= fallbackReason(error);
            throw error;
          }
          reason ??= fallbackReason(error);
        }
      }
      const value = await lanes.claude!.json(request);
      answered('claude-cli');
      return value;
    },
    report() {
      if (forced && lanes.openrouter && !lanes.claude) {
        return calls > 0
          ? { lane: 'openrouter', model: LINKPAGE_OPENROUTER_MODEL, calls }
          : { lane: 'none', calls: 0, ...(failed ? { failed: { lane: 'openrouter' as const, reason: failed } } : {}) };
      }
      if (forced) return { lane: 'claude-cli', calls };
      const lane = last ?? (lanes.openrouter && !reason ? 'openrouter' : 'claude-cli');
      return {
        lane,
        ...(lane === 'openrouter' ? { model: LINKPAGE_OPENROUTER_MODEL } : {}),
        calls,
        ...(reason ? { fellBackFrom: { lane: 'openrouter' as const, reason } } : {}),
      };
    },
  };
}

export async function resolveLinkPageLlm(deps: ResolveLlmDeps): Promise<ReportingLlm | undefined> {
  const { fetch, findClaude = () => resolveOnPath('claude'), keyTimeoutMs = KEY_TIMEOUT_MS } = deps;
  const timed = fetchWithTimeout(deps.openRouterFetch ?? globalThis.fetch, deps.openRouterTimeoutMs ?? OPENROUTER_TIMEOUT_MS);
  const makeOpenRouter = deps.makeOpenRouter ?? ((apiKey: string) => createLlm({ apiKey, model: LINKPAGE_OPENROUTER_MODEL, fetch: timed }));
  const makeClaude = deps.makeClaude ?? ((executable: string) => createClaudeCliLlm({ fetch, executable }));
  const lane = deps.lane ?? 'auto';
  if (lane === 'claude-cli') {
    // Never touches the key store or OpenRouter.
    const only = findClaude();
    return only ? track({ claude: makeClaude(only) }, false, true) : undefined;
  }
  const apiKey = await boundedKey(deps.resolveKey, keyTimeoutMs);
  if (lane === 'openrouter') return apiKey ? track({ openrouter: makeOpenRouter(apiKey) }, false, true) : undefined;
  const claudePath = findClaude();
  const claude = claudePath ? makeClaude(claudePath) : undefined;
  if (!apiKey && !claude) return undefined;
  return track({ ...(apiKey ? { openrouter: makeOpenRouter(apiKey) } : {}), ...(claude ? { claude } : {}) }, !apiKey);
}

/** The daemon's default lane from OD_LINKPAGE_MODEL_LANE; anything unrecognised means 'auto'. */
export function linkPageLaneFromEnv(env: Record<string, string | undefined>): LinkPageModelLaneChoice {
  const value = env.OD_LINKPAGE_MODEL_LANE?.trim().toLowerCase();
  return isLinkPageModelLaneChoice(value) ? value : 'auto';
}
