/**
 * Picks the models the link-page builder reads people with. Lanes: OpenRouter (key from the daemon
 * key store: env, saved key, then vault), DeepSeek (same store; text only, no vision), and the local
 * `claude` command on the owner's subscription. 'auto' tries OpenRouter; with no OpenRouter key it
 * uses DeepSeek for text; the Claude CLI is the fallback for any failure and the only photo reader
 * when OpenRouter is absent. With no lane at all the page is built from plain signals. A failed
 * metered call falls back to `claude`, a cancelled one does not.
 */
import { LlmError, createLlm } from '@mish/linkpage';
import { isLinkPageModelLaneChoice } from '@mish/contracts';
import type { LinkPageMeteredLane, LinkPageModelFallbackReason, LinkPageModelInfo, LinkPageModelLaneChoice } from '@mish/contracts';
import type { Llm, LlmRequest } from '@mish/linkpage';
import { createClaudeCliLlm } from '@mish/linkpage/node';
import { PROVIDERS, ProviderHttpError, ProviderKeyError, createModelCaller, isCallerTimeout } from '@mish/agency-fast-lane/deepseek';
import { resolveOnPath } from '../runtimes/executables.js';
import type { LinkPageFetch } from './safe-fetch.js';

/**
 * Pinned on purpose. The style-from-photos step sends pictures, so the model must read images;
 * `createModelCaller` (the brief lane) is text-only, so @mish/linkpage's own client carries the
 * call. Claude Sonnet 5.5 sees images, answers JSON mode cleanly, and is the model the `claude`
 * lane runs, so both lanes read people alike. The brief's GPT Terra pin was measured on text only.
 */
export const LINKPAGE_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';

/** The fast lane's DeepSeek model, so both lanes move together. Text only: DeepSeek has no vision here. */
export const LINKPAGE_DEEPSEEK_MODEL = PROVIDERS.deepseek.defaultModel;

/** The warning a photo step gets on a lane that cannot see. Fixed text. */
export const DEEPSEEK_TEXT_ONLY_MESSAGE = 'DeepSeek reads text only; photo style was skipped';

/** Baseten's OpenAI-compatible endpoint. Overridable with OD_BASETEN_BASE_URL. */
export const LINKPAGE_BASETEN_BASE_URL = 'https://inference.baseten.co/v1';

const KEY_TIMEOUT_MS = 5_000;
const OPENROUTER_TIMEOUT_MS = 60_000;
const DEEPSEEK_TIMEOUT_MS = 60_000;
const BASETEN_TIMEOUT_MS = 60_000;

export interface ResolveLlmDeps {
  /** The daemon key store's OpenRouter lookup. Rejecting means no key. Never logged here. */
  resolveKey: () => Promise<string>;
  fetch: LinkPageFetch;
  findClaude?: () => string | null;
  keyTimeoutMs?: number;
  /** The owner's pick. 'claude-cli' never reads a key; 'openrouter' and 'deepseek' never use the CLI. Default 'auto'. */
  lane?: LinkPageModelLaneChoice;
  /** The daemon key store's DeepSeek lookup. Rejecting means no key. Never logged here. Absent: no DeepSeek lane. */
  resolveDeepSeekKey?: () => Promise<string>;
  /** The daemon key store's Baseten lookup. Rejecting means no key. Never logged here. Absent: no Baseten lane. */
  resolveBasetenKey?: () => Promise<string>;
  /** The Baseten model id (OD_BASETEN_MODEL). No default is verified, so unset means the lane reports 'model-not-set'. */
  basetenModel?: string | undefined;
  /** Default `LINKPAGE_BASETEN_BASE_URL`. */
  basetenBaseUrl?: string | undefined;
  basetenFetch?: typeof globalThis.fetch;
  basetenTimeoutMs?: number;
  makeBaseten?: (apiKey: string) => Llm;
  /** Test seams: build each lane's client. */
  makeOpenRouter?: (apiKey: string) => Llm;
  makeDeepSeek?: (apiKey: string) => Llm;
  /** The fetch under the DeepSeek client (default: global fetch), its time limit and retry count. */
  deepSeekFetch?: typeof globalThis.fetch;
  deepSeekTimeoutMs?: number;
  deepSeekMaxRetries?: number;
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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('key lookup timeout')), ms); }),
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

/** A fixed reason code for a failed metered call; the error text itself is never kept. */
export function fallbackReason(error: unknown): LinkPageModelFallbackReason {
  if (error instanceof LlmError) return error.code;
  if (error instanceof ProviderKeyError) return 'no-key';
  if (error instanceof ProviderHttpError) {
    if (error.status === 402) return 'out-of-credits';
    if (error.status === 401) return 'bad-key';
    return 'http-error';
  }
  if (isCallerTimeout(error) || (error instanceof Error && error.name === 'TimeoutError')) return 'timeout';
  return 'http-error';
}

function parseJson(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    throw new LlmError('invalid-output', 'the model did not answer with valid JSON');
  }
}

/** JSON in, JSON out on the fast lane's DeepSeek caller. Text only: a request with pictures never reaches it. */
function createDeepSeekLlm(options: { apiKey: string; fetchImpl: typeof globalThis.fetch; timeoutMs: number; maxRetries: number }): Llm {
  const call = createModelCaller({
    provider: 'deepseek', model: LINKPAGE_DEEPSEEK_MODEL, apiKey: async () => options.apiKey,
    fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, temperature: 0.2,
  });
  return {
    async json({ system, user }: LlmRequest) {
      return parseJson((await call({ system, user })).text);
    },
  };
}

type LaneName = LinkPageMeteredLane | 'claude-cli';
interface Lane { name: LaneName; llm: Llm; textOnly?: boolean; model?: string }

const laneModel = (lane: Lane): string | undefined =>
  lane.model ?? (lane.name === 'openrouter' ? LINKPAGE_OPENROUTER_MODEL : lane.name === 'deepseek' ? LINKPAGE_DEEPSEEK_MODEL : undefined);

/** A Baseten lane with no model id: every call fails with a fixed code and no request is made. */
const modelNotSetLlm: Llm = { json: async () => { throw new LlmError('model-not-set', 'no Baseten model is set'); } };

/**
 * Calls go down the chain in order. A text-only lane is passed over for calls with pictures; when
 * nothing left can see, the photo step is skipped with a fixed message. The lane of every answered
 * call is counted; one fallback is remembered (the first failure, else the missing-OpenRouter-key note).
 */
function track(chain: Lane[], noKey: boolean, forced = false): ReportingLlm {
  let calls = 0;
  let failed: { lane: LinkPageMeteredLane; reason: LinkPageModelFallbackReason } | undefined;
  let fell: { lane: LinkPageMeteredLane; reason: LinkPageModelFallbackReason } | undefined;
  let last: LaneName | undefined;
  return {
    async json(request: LlmRequest) {
      const wantsPhotos = (request.images?.length ?? 0) > 0;
      const eligible = chain.filter((lane) => !(wantsPhotos && lane.textOnly));
      if (eligible.length === 0) throw new Error(DEEPSEEK_TEXT_ONLY_MESSAGE);
      for (const [index, lane] of eligible.entries()) {
        try {
          const value = await lane.llm.json(request);
          calls += 1;
          last = lane.name;
          return value;
        } catch (error) {
          const metered = lane.name !== 'claude-cli';
          // A cancel, or a failure with nothing to fall back to, goes to the caller.
          if (cancelled(error) || index === eligible.length - 1) {
            if (!cancelled(error) && forced && metered) failed ??= { lane: lane.name as LinkPageMeteredLane, reason: fallbackReason(error) };
            throw error;
          }
          if (metered) fell ??= { lane: lane.name as LinkPageMeteredLane, reason: fallbackReason(error) };
        }
      }
      throw new Error('no model lane answered');
    },
    report() {
      const first = chain[0]!;
      if (forced && first.name !== 'claude-cli') {
        const model = laneModel(first);
        return calls > 0
          ? { lane: first.name, ...(model ? { model } : {}), calls }
          : { lane: 'none', calls: 0, ...(failed ? { failed } : {}) };
      }
      if (forced) return { lane: 'claude-cli', calls };
      const lane = last ?? first.name;
      const model = laneModel(chain.find((l) => l.name === lane) ?? first);
      const from = fell ?? (noKey ? { lane: 'openrouter' as const, reason: 'no-key' as const } : undefined);
      return { lane, ...(model ? { model } : {}), calls, ...(from ? { fellBackFrom: from } : {}) };
    },
  };
}

export async function resolveLinkPageLlm(deps: ResolveLlmDeps): Promise<ReportingLlm | undefined> {
  const { fetch, findClaude = () => resolveOnPath('claude'), keyTimeoutMs = KEY_TIMEOUT_MS } = deps;
  const timed = fetchWithTimeout(deps.openRouterFetch ?? globalThis.fetch, deps.openRouterTimeoutMs ?? OPENROUTER_TIMEOUT_MS);
  const makeOpenRouter = deps.makeOpenRouter ?? ((apiKey: string) => createLlm({ apiKey, model: LINKPAGE_OPENROUTER_MODEL, fetch: timed }));
  const makeDeepSeek = deps.makeDeepSeek ?? ((apiKey: string) => createDeepSeekLlm({
    apiKey, fetchImpl: deps.deepSeekFetch ?? globalThis.fetch, timeoutMs: deps.deepSeekTimeoutMs ?? DEEPSEEK_TIMEOUT_MS, maxRetries: deps.deepSeekMaxRetries ?? 1,
  }));
  const basetenModel = deps.basetenModel?.trim() || undefined;
  const makeBaseten = deps.makeBaseten ?? ((apiKey: string) => basetenModel
    ? createLlm({
      apiKey, model: basetenModel, baseUrl: deps.basetenBaseUrl?.trim() || LINKPAGE_BASETEN_BASE_URL, provider: 'Baseten', jsonMode: false,
      fetch: fetchWithTimeout(deps.basetenFetch ?? globalThis.fetch, deps.basetenTimeoutMs ?? BASETEN_TIMEOUT_MS),
    })
    : modelNotSetLlm);
  const makeClaude = deps.makeClaude ?? ((executable: string) => createClaudeCliLlm({ fetch, executable }));
  const lane = deps.lane ?? 'auto';
  if (lane === 'claude-cli') {
    // Never touches the key store or a metered lane.
    const only = findClaude();
    return only ? track([{ name: 'claude-cli', llm: makeClaude(only) }], false, true) : undefined;
  }
  if (lane === 'baseten') {
    // Only the Baseten key is read. Images go as image_url parts like the OpenRouter client.
    const key = deps.resolveBasetenKey ? await boundedKey(deps.resolveBasetenKey, keyTimeoutMs) : undefined;
    return key ? track([{ name: 'baseten', llm: makeBaseten(key), ...(basetenModel ? { model: basetenModel } : {}) }], false, true) : undefined;
  }
  if (lane === 'deepseek') {
    const key = deps.resolveDeepSeekKey ? await boundedKey(deps.resolveDeepSeekKey, keyTimeoutMs) : undefined;
    return key ? track([{ name: 'deepseek', llm: makeDeepSeek(key), textOnly: true }], false, true) : undefined;
  }
  const apiKey = await boundedKey(deps.resolveKey, keyTimeoutMs);
  if (lane === 'openrouter') return apiKey ? track([{ name: 'openrouter', llm: makeOpenRouter(apiKey) }], false, true) : undefined;
  // auto: OpenRouter; no OpenRouter key means DeepSeek for text (its key is not read otherwise); Claude CLI last.
  const chain: Lane[] = [];
  if (apiKey) {
    chain.push({ name: 'openrouter', llm: makeOpenRouter(apiKey) });
  } else {
    const deepSeekKey = deps.resolveDeepSeekKey ? await boundedKey(deps.resolveDeepSeekKey, keyTimeoutMs) : undefined;
    if (deepSeekKey) chain.push({ name: 'deepseek', llm: makeDeepSeek(deepSeekKey), textOnly: true });
  }
  const claudePath = findClaude();
  if (claudePath) chain.push({ name: 'claude-cli', llm: makeClaude(claudePath) });
  return chain.length > 0 ? track(chain, !apiKey) : undefined;
}

/** The daemon's default lane from OD_LINKPAGE_MODEL_LANE; anything unrecognised means 'auto'. */
export function linkPageLaneFromEnv(env: Record<string, string | undefined>): LinkPageModelLaneChoice {
  const value = env.OD_LINKPAGE_MODEL_LANE?.trim().toLowerCase();
  return isLinkPageModelLaneChoice(value) ? value : 'auto';
}
