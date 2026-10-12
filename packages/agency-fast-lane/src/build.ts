/**
 * `buildSite`: one client brief becomes one built — and, unless this is a dry run, published —
 * Agency Site page.
 *
 * This is the fast lane's build step, lifted out of `src/cli.ts`'s `runCli` so that something
 * other than a terminal (the daemon's build job, next) can run it. It owns exactly what `runCli`
 * owned between the Jev credential preflight and `runFastLane` returning: the one shared cached
 * Jev resolver, the preflight itself, `--family auto` routing, creating or reusing the project,
 * the model caller, the faithfulness checker, the provider's one-at-a-time run lock, and the run.
 * Everything that is a terminal's own business — parsing flags, printing stamped lines,
 * `--out-dir`, `--report`, `--debug-dir` — stays in the CLI, which is now an adapter around this
 * function.
 *
 * Inputs are prepared by the caller rather than derived from flags here: the loaded family
 * package, the entry file name, the already-parsed spine, the locked paths and the debug
 * callback. Routing is the one step that cannot work that way, because the family is what decides
 * the package directory and the entry name, so those family-dependent inputs arrive through
 * `prepare(family)` — called once, after a routed decision, with the family this build will
 * actually use.
 *
 * Progress is a closed event union (`BuildEvent`): `RunEvent` exactly as `runFastLane` emits it,
 * plus the two decisions taken before the run starts (`route`, `project`) and the one wait that
 * can precede it (`lock-wait`). A caller renders those however it likes; this module never prints.
 *
 * Cancellation is end to end. `input.signal` reaches the router, the checker, every model call and
 * every publisher write; an abort makes whichever layer is waiting throw an `AbortError`, which
 * this function catches. It finishes the clean-up — in-flight writes have already settled inside
 * `runFastLane` — and returns `{ outcome: 'cancelled' }` rather than rejecting, so a cancelled
 * build is an outcome its caller handles, not an error it has to classify. A build that created
 * its own project deletes it again; a project the caller supplied is left exactly as it was.
 *
 * No credential ever leaves this module: `deps.resolveJevCredential` and `deps.resolveModelKey`
 * are called at use time by the router, the checker and the model caller themselves, and no key
 * appears in an event, in a result, or in an error message.
 */

import { PROVIDERS, type CallerOptions, type ModelCall, type ProviderName } from './deepseek.ts';
import { createFailoverCaller, createRecordingCaller, type FailoverReason, type ProviderUse } from './failover.ts';
import type { FamilyPackage } from './family.ts';
import { resolveJevKey, type FaithfulnessChecker, type JevCheckerOptions, type JevKeyResolver } from './jev.ts';
import { acquireRunLock } from './lock.ts';
import { DaemonHttpError, ensureProject, newProjectId, projectPublisher, type ProjectPublisher } from './publish.ts';
import type { FamilyRegistry, ShapeAtlas } from './atlas.ts';
import { createJevRouter, shouldRetryRoute, type JevRouter, type JevRouterOptions, type RouteDecision } from './route.ts';
import { PublishRollbackError, runFastLane, type FastLaneMode, type RunEvent, type RunOptions, type RunReport } from './run.ts';
import { decideSections, optionalSectionsOf, type JevSectionJudgeOptions, type SectionDecision, type SectionHints, type SectionJudge, type SectionSkipReason } from './sections.ts';
import type { JsonObject } from './spine.ts';
import { preflightJevCredential, type VerifyMode } from './verify-policy.ts';
import type { SectionSelection } from './section-overlay.ts';
import { listDesignDirectionMoods } from './section-overlay.ts';
import { autoCoverage, planShowsHours, BlockPlanReplayError, checkBlockPlan, DEFAULT_BLOCK_THRESHOLD, COMPOSED_FAMILY, SPINES, type BlockCatalog, type BlockPlan, type BlockPlanner, type CompositionFallback, type CompositionMode, type JevBlockPlannerOptions } from './block-plan.ts';
import type { BlockSupportReceipt } from './block-support.ts';
import { composeBlocks, CompositionVerifyError, type CompositionResult } from './block-compose.ts';
import { RenderQualityError } from './render-quality.ts';
import { briefHoursClauseRows } from './hours-label.ts';
export { RenderQualityError } from './render-quality.ts';
export { CompositionVerifyError } from './block-compose.ts';
import type { BuildDesignKit } from './kit-direction.ts';
/** Re-exported so the daemon derives a picked kit's direction through the `./build` entry it
 * already imports (no new package subpath for the packaged prebundle to learn). */
export { kitDirection, KitDirectionError, type BuildDesignKit, type KitDirectionErrorCode } from './kit-direction.ts';
import { decideEffects, PageTooLargeError, type EffectCatalog, type EffectDecision, type EffectJudge, type EffectsInput, type JevEffectJudgeOptions } from './effects.ts';
import { internalSectionEntryId, publicSectionEntryId } from './cult-public-ids.ts';

/** Re-exported so a caller of `buildSite` (the daemon's `POST /api/agency/build` route) can name
 * `BuildInput.sectionSelection`'s type without its own subpath import of `./section-overlay.ts`. */
export type { SectionSelection } from './section-overlay.ts';

/**
 * Everything a build reports as it happens: the run's own events, plus the three things that
 * happen around the run rather than inside it — which family the brief routed to, which project
 * the output goes to, and a wait on another process's provider lock.
 */
export type BuildEvent =
  | RunEvent
  | { type: 'route'; decision: RouteDecision }
  | { type: 'project'; projectId: string; created: boolean }
  | { type: 'lock-wait'; provider: ProviderName; pid: number | undefined }
  /**
   * The optional-section decision, taken once per build before the fill (see `sections.ts`).
   * `skipped` is the fixed code for why Jev could not answer (every section then kept).
   */
  | { type: 'sections'; kept: string[]; dropped: string[]; source: SectionDecision['source']; skipped?: SectionSkipReason; warnings?: string[]; ms: number }
  /**
   * The effect plan settled, once per build before the fill (see `effects.ts`): `applied` is the
   * number of effects the plan carries, `skipped` the placements it leaves bare. The ids, and what
   * the final render really applied, are on `RunReport.effects`. Counts only — never Jev answers.
   */
  | { type: 'effects'; applied: number; skipped: number; ms: number }
  /** The primary provider failed before any output and every later call goes to `to`. See
   * `failover.ts` for which failures qualify. Emitted at most once per build. */
  | { type: 'failover'; from: ProviderName; to: ProviderName; reason: FailoverReason }
  /**
   * `composition: 'blocks' | 'auto'` only, once per build, before the fill: the plan a composed
   * page will be built from, or why the family route runs instead. Ids and fixed codes only.
   */
  | { type: 'composition'; result: CompositionResult; ms: number };

export type BuildResult =
  /**
   * `provider`/`model` are the last provider that answered: the secondary after a failover.
   * `providers` is every provider/model that answered any call, in first-use order, with the
   * sections each one filled — in `sections` mode a build can take output from both providers.
   */
  | { outcome: 'built'; family: string; route?: RouteDecision; projectId?: string; provider: ProviderName; model: string; providers: ProviderUse[]; report: RunReport }
  | { outcome: 'unrouted'; route: RouteDecision; composition?: CompositionResult }
  | { outcome: 'cancelled'; family?: string; projectId?: string }
  /**
   * The build failed after publishing had begun, and removing the project it had created failed
   * too, so a partly-written project is still on the daemon. It is an outcome rather than an
   * exception because the caller has to be able to name that project: it is the one thing here
   * that a person now has to deal with. `message` names the project and both failures, and carries
   * no model-generated text.
   */
  | ({ outcome: 'rollback-failed'; family: string; projectId: string; message: string } & Partial<BuildProvenance>);

/**
 * Which providers answered a build that then FAILED: the same `provider`/`model`/`providers` a
 * `built` result carries. A `sections` build can take one provider's answer and then lose another
 * section to both providers failing, and the failed record still has to say who wrote the part
 * that was accepted. Present only when at least one call answered.
 */
export type BuildProvenance = { provider: ProviderName; model: string; providers: ProviderUse[] };

/**
 * Provenance of builds that threw, keyed by the thrown error. A side table rather than a property
 * on the error: the error may be a caller's own object (a transport rejection, a daemon error),
 * and nothing here should change what it serializes to or what its message says.
 */
const failedProvenance = new WeakMap<object, BuildProvenance>();

/** The providers that answered before `buildSite` threw `error`, if any answered. */
export function buildProvenanceOf(error: unknown): BuildProvenance | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const found = failedProvenance.get(error);
  return found ? { ...found, providers: found.providers.map((use) => ({ ...use, ...(use.sections ? { sections: [...use.sections] } : {}) })) } : undefined;
}

/**
 * Records `provenance` as the providers that answered before `error` ended a build, and returns the
 * same error. `buildSite` calls it on every failure after a call answered; a host that wraps or
 * fakes a build (a test, a retrying caller) uses it to hand the same record on.
 */
export function withBuildProvenance<E>(error: E, provenance: BuildProvenance): E {
  if (typeof error === 'object' && error !== null) failedProvenance.set(error, provenance);
  return error;
}

type ProviderLedgerView = { providers(): ProviderUse[]; answered(): { provider: ProviderName; model: string } | undefined };

function provenanceOf(ledger: ProviderLedgerView | undefined): BuildProvenance | undefined {
  const used = ledger?.answered();
  if (!ledger || !used) return undefined;
  return { provider: used.provider, model: used.model, providers: ledger.providers() };
}

/**
 * The family-dependent inputs a caller hands over once the family is known. Everything here is
 * already loaded, parsed and validated: `buildSite` reads no file and validates no flag.
 */
export type PreparedBuild = {
  pkg: FamilyPackage;
  entry: string;
  /** A recipe to re-target, already parsed and checked to be a JSON object. */
  spine?: JsonObject;
  /** The recipe this build is re-targeting FROM, already parsed and checked to be a JSON object.
   * See `RunOptions.previousRecipe` for what it unlocks. */
  previousRecipe?: JsonObject;
  /** Text slots to keep from that spine, as path labels such as `brand.name`. */
  lockPaths?: string[];
  onCall?: RunOptions['onCall'];
};

export type BuildInput = {
  /**
   * The client brief, or a function that fetches it. A function is awaited AFTER the credential
   * preflight, which is what keeps the preflight first for a caller that has to go and get the
   * brief: the CLI reads it from a file, and a build that cannot verify must say so before a
   * missing file, a slow disk or anything else can answer first.
   */
  brief: string | (() => Promise<string>);
  /** A bundled family id, or `auto` to route the brief against the Website Shape Atlas first. */
  family: 'auto' | string;
  mode: FastLaneMode;
  revision: number;
  verify: VerifyMode;
  verifyThreshold?: number;
  routeOptions?: { threshold?: number; minTransfer?: number; spineShare?: number };
  /**
   * Supplies the Website Shape Atlas and family registry `family: 'auto'` routes against. Required
   * for `auto` and never called otherwise, so a named-family build loads nothing. It is a callback
   * for the same reason `brief` can be one: it runs after the credential preflight, not before.
   * There is deliberately no default — see `routeBuild` on why this module reads no file itself.
   */
  loadAtlas?: () => Promise<{ atlas: ShapeAtlas; registry: FamilyRegistry }>;
  /**
   * Omit to let `defaultModelFor` (or, failing that, `deepseek`) choose once the family is known.
   * A caller that already knows the family — every request but `family: 'auto'` with no provider
   * named — can simply resolve its own default and pass it here instead.
   */
  provider?: ProviderName;
  /** Defaults to the provider's own default model. Ignored (in favor of `defaultModelFor`'s
   * model, if any) when `provider` is omitted. */
  model?: string;
  /**
   * Chooses the fill provider (and, optionally, its model) when `provider` is omitted — called
   * once, with the family this build will actually use: the routed winner for `family: 'auto'`,
   * the requested id otherwise. It exists because that family is not known until the routing
   * above has run, so a per-family default (the bake-off winner — see
   * `docs/evals/2026-09-22-genui-bakeoff.md`, 2026-09-22) cannot always be resolved by the
   * caller before `buildSite` is invoked. Ignored when `provider` is given.
   */
  defaultModelFor?: (family: string) => { provider: ProviderName; model?: string };
  /**
   * The provider a pre-output 429/5xx, timeout, network error or missing key fails over to (see
   * `failover.ts`), with its own default model. Omitted means the other provider in `PROVIDERS`;
   * `null` (or the primary itself) turns failover off.
   */
  fallbackProvider?: ProviderName | null;
  maxRepairs?: number;
  /**
   * Sets `RunOptions.transportRetryLimit` (capped at 2 there): how many extra fresh attempts a
   * transport-class failure earns the SAME unit, to the same provider, shared across that unit's
   * fill call and every later repair call for it. Never a provider's own internal retry count —
   * that is always 0, on every path (see `primaryCall`/`secondaryCall`), so this is the only retry
   * budget a transport failure ever draws from.
   */
  maxRetries?: number;
  /** The fill-and-repair deadline and one model call's time limit, in ms; see `RunOptions`. */
  deadlineMs?: number;
  callTimeoutMs?: number;
  /** Where to publish. Absent means a dry run: nothing is created and nothing is written. */
  project?: { daemonUrl: string; projectId?: string; name?: string; archive?: boolean };
  /**
   * Called once with the family this build will use — the routed winner for `--family auto`, the
   * requested id otherwise — to hand over the inputs that depend on it. It is a callback rather
   * than a field because routing is what decides the family, and the package directory and entry
   * name are decided by the family in turn.
   */
  prepare: (family: string) => Promise<PreparedBuild>;
  /**
   * Explicit keep/drop per optional section id. Overrides the Jev keep/drop request, which is
   * never asked about a hinted id. An id the family does not mark optional is ignored with a
   * warning — with `family: 'auto'` the family is not known when the request is made.
   */
  sections?: SectionHints;
  /**
   * Whether to ask Jev which optional sections to drop. Default true. A repair passes false: it
   * re-fills a published recipe whose drops are already decided (its nulls stay dropped).
   */
  judgeSections?: boolean;
  /** One selectable section on top of this build's fixed family recipe — see
   * `RunOptions.sectionSelection` (`run.ts`) for the full contract. Threaded straight through. */
  sectionSelection?: SectionSelection;
  /** Untrusted design guidance for `sectionSelection`'s own fill — see
   * `RunOptions.designReference` (`run.ts`) for the in-memory-only rule this must never break.
   * Threaded straight through; `buildSite` itself never logs, stores or echoes it. */
  designReference?: string;
  /**
   * How the page is composed (`block-plan.ts`): `family` (the default) is the family route,
   * unchanged; `blocks` asks Jev for a block plan and composes it (`block-compose.ts`), falling
   * back to the family route with a fixed reason; `auto` composes only when the routed spine has
   * reviewed blocks that cover the page.
   */
  composition?: CompositionMode;
  /** A saved plan to replay instead of asking Jev (a fork or a repair of a composed build). It is
   * re-checked against today's catalog; a plan that no longer applies fails the build. */
  blockPlan?: BlockPlan;
  /**
   * The design kit a person picked (`kit-direction.ts`). A composed page takes the kit's direction
   * instead of the planner's built-in one; a build that ends on the family route cannot wear it.
   * Either way every composition result this build reports carries `designKit: { id, applied }`,
   * so the caller never has to guess whether the page wears the kit.
   */
  designKit?: BuildDesignKit;
  /** Supplies the block catalog; required for `blocks` and `auto`, never called for `family`.
   * The daemon passes its bundled JSON; the CLI `loadBlockCatalogFromSource`. */
  loadBlockCatalog?: () => Promise<BlockCatalog>;
  /**
   * Reviewed GenUI catalog components on the family's placements — see `EffectsInput` and
   * `effects.ts`. Omitted: `'auto'` when the family declares placements (every site family),
   * `'off'` when it declares none (the app and dashboard page kinds).
   */
  effects?: EffectsInput;
  /**
   * `true` when `effects` replays a saved build's applied ids (the daemon's repair): those ids are
   * reported with `source: 'repair'` instead of `hint`. Provenance only; every guard is the same.
   */
  effectsReplay?: boolean;
  /**
   * The GenUI catalog manifest the effect questions and guards read names, descriptions, kinds
   * and categories from. The daemon passes `genuiCatalog.manifest` from
   * `@open-design/genui-catalog/data`; the CLI passes `loadEffectCatalogFromSource()`. Given, never
   * loaded here — see `routeBuild` on why this module reads no file.
   */
  effectCatalog?: EffectCatalog;
  signal?: AbortSignal;
  onEvent?: (event: BuildEvent) => void;
};

export type BuildDeps = {
  createModelCaller: (options: CallerOptions) => ModelCall;
  createJevChecker: (options: JevCheckerOptions) => FaithfulnessChecker;
  createJevRouter: (options: JevRouterOptions) => JevRouter;
  /**
   * The optional-section keep/drop judge (`createJevSectionJudge`). Optional: without it, or with
   * `verify: 'off'`, every optional section is kept unless the request hints otherwise.
   */
  createSectionJudge?: (options: JevSectionJudgeOptions) => SectionJudge;
  /** The block planner (`createJevBlockPlanner`). Without it, `blocks`/`auto` fall back to the
   * family route (`planner-unavailable`) unless a saved plan is replayed. */
  createBlockPlanner?: (options: JevBlockPlannerOptions) => BlockPlanner;
  /**
   * The effect judge (`createJevEffectJudge`). Optional: without it, `auto` placements get no
   * effect and only explicit ids apply. Unlike the section judge it runs with `verify: 'off'`
   * too — automatic effects do not depend on the faithfulness gate.
   */
  createEffectJudge?: (options: JevEffectJudgeOptions) => EffectJudge;
  /** The raw, uncached Jev (TypeSafe) credential read; wrapped here in one cached resolver per
   * build, so routing, the preflight and the checker together read it at most once. */
  resolveJevCredential: () => Promise<string>;
  /** The model provider's key, read at call time by the model caller — never before, never here. */
  resolveModelKey: (provider: ProviderName) => Promise<string>;
  /** Used for every daemon HTTP call (`ensureProject`, `projectPublisher`). */
  daemonFetch: typeof fetch;
  /** Overrides the cross-process provider lock, for tests. */
  acquireRunLock?: typeof acquireRunLock;
};

/**
 * Thrown when a build that asked to be verified cannot resolve a Jev credential. It is a distinct
 * class because the CLI answers it with its own exit code (2, the fail-closed verification
 * contract's code) rather than the generic failure code, and `build.ts` must not import the CLI's
 * `CliExit` to say so.
 */
export class JevCredentialError extends Error {}

/**
 * Re-exported so a caller of `buildSite` can classify what it threw without a `./publish` subpath
 * of its own — this package curates its public surface, and a daemon build failure's message
 * (`buildFailureMessage` in `apps/daemon/src/routes/agency-build.ts`) needs `instanceof
 * DaemonHttpError` to build a status-only sentence rather than copy free text from `.message`.
 */
export { DaemonHttpError } from './publish.ts';

/** Re-exported so the daemon can record which unit and slot a build that ran out of repairs failed
 * on, from the error's structured fields rather than its message. */
export { UnitRefusedError, UnitDeadlineError, failedUnitOf, REPAIR_REASON_TEXT, DEFAULT_FILL_DEADLINE_MS, DEFAULT_CALL_TIMEOUT_MS } from './run.ts';

/** Re-exported for the same reason: the daemon injects the keep/drop judge into `BuildDeps` and
 * validates the `sections` hints a request carries. */
export { createJevSectionJudge, type SectionHint, type SectionHints } from './sections.ts';

/** Re-exported for the daemon: it injects the effect judge, serves the family placement endpoint
 * and names the effect types on its own records. */
export {
  createJevEffectJudge,
  familyEffectsResponse,
  EFFECT_PLACEMENT_IDS,
  PageTooLargeError,
  PAGE_TOO_LARGE,
  type EffectCatalog,
  type EffectPlan,
  type EffectsInput,
  type EffectsResult,
  type FamilyEffectsResponse,
} from './effects.ts';

export type RouteBuildInput = {
  brief: string;
  atlas: ShapeAtlas;
  registry: FamilyRegistry;
  jevKey: JevKeyResolver;
  options?: BuildInput['routeOptions'];
  signal?: AbortSignal;
};

/**
 * The ROUTE step on its own: one Jev request classifies the brief against the Website Shape Atlas
 * and `resolveRoute` picks the family to build with. `buildSite` calls this for `--family auto`;
 * the CLI calls it directly for `--route-only`, which never builds and so never enters `buildSite`
 * at all — sharing this function is what keeps the two paths from drifting apart.
 *
 * The atlas and the registry are given, never loaded here. This module must not read a file: the
 * packaged mac and Windows daemons are esbuild prebundles that inline every workspace package, and
 * `atlas.ts` builds its default paths from `import.meta.dirname` — which, inlined, is the
 * prebundle's own directory, where no `atlas/` exists. A packaged `family: 'auto'` build would
 * ENOENT before it ever reached Jev. The daemon passes the objects from the generated, bundle-safe
 * `@open-design/agency-fast-lane/data` module, exactly as it already does for the design index;
 * the CLI runs from source and passes `loadAtlasData()`. See `tools/pack/tests/prebundle/`.
 */
export async function routeBuild(input: RouteBuildInput, deps: Pick<BuildDeps, 'createJevRouter'>): Promise<RouteDecision> {
  const router = deps.createJevRouter({ apiKey: input.jevKey, signal: input.signal });
  const request = {
    brief: input.brief,
    atlas: input.atlas,
    registry: input.registry,
    threshold: input.options?.threshold,
    minTransfer: input.options?.minTransfer,
    spineShare: input.options?.spineShare,
  };
  const first = await router.route(request);
  // Exactly one bounded retry, and only for a confident spine with no family admitted (see
  // `shouldRetryRoute`): the same request again, the same threshold. A second refusal stands as
  // the honest answer; a retry that cannot be made (network, timeout) leaves the first refusal
  // standing rather than failing a build that had a decision. Cancellation still propagates.
  if (!shouldRetryRoute(first)) return { ...first, routeAttempts: 1 };
  let second: RouteDecision;
  const retryStarted = performance.now();
  try {
    input.signal?.throwIfAborted();
    second = await router.route(request);
  } catch (error) {
    if (isCancellation(error, input.signal)) throw error;
    // The retry was sent, so it counts as an attempt and its wall time counts in `ms`. It returned
    // no usage, so `usage` stays the first request's: the only tokens anyone reported.
    const retryMs = Math.round(performance.now() - retryStarted);
    return { ...first, ms: first.ms + retryMs, routeAttempts: 2, warnings: [...first.warnings, 'route retry failed; the first refusal stands'] };
  }
  const usage = first.usage && second.usage
    ? { input_tokens: first.usage.input_tokens + second.usage.input_tokens, output_tokens: first.usage.output_tokens + second.usage.output_tokens }
    : second.usage ?? first.usage;
  return { ...second, ms: first.ms + second.ms, ...(usage ? { usage } : {}), routeAttempts: 2 };
}

/**
 * Whether an error is a cancellation rather than a failure. The lower layers throw the platform's
 * own abort error (`name === 'AbortError'`, from `fetch` or `signal.throwIfAborted()`), but an
 * abort can also surface as a message from a layer that wrapped it — `runFastLane`'s strict
 * rollback, for one — so an aborted signal is taken as proof on its own. A model or Jev timeout is
 * a `TimeoutError`, never an `AbortError`, so it is not mistaken for a cancellation here.
 */
function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export async function buildSite(input: BuildInput, deps: BuildDeps): Promise<BuildResult> {
  const emit = input.onEvent ?? (() => {});
  const strict = input.verify === 'strict';
  const verifyAfterPublish = input.verify === 'after';
  // A composed page publishes only after a passing strict Jev check (Sol review 2026-09-25,
  // finding 2). The daemon route and the CLI reject the combination before a build starts; this
  // is the same rule for every other caller, before any model or Jev call.
  if ((input.composition ?? 'family') !== 'family' && !strict) throw new CompositionVerifyError(input.verify);

  // One shared, cached credential resolver for the whole build: the `--family auto` router, the
  // preflight just below, and the faithfulness checker all take this same resolver, so at most one
  // of them ever actually reads the credential (environment or vault).
  const jevKey = resolveJevKey(deps.resolveJevCredential);

  // Every mode but `off` needs the credential before any model or router call, and fails closed
  // when it cannot be resolved — a build is entitled to learn its credential is broken before it
  // spends the model call that the check would grade, not after.
  // Intended exception to the keep-all fallback: strict/advisory/after need Jev for the gate anyway, so no key aborts here; 'off' skips this and keeps every unhinted section.
  if (input.verify !== 'off') {
    const preflight = await preflightJevCredential(input.verify, jevKey);
    if (!preflight.ok) throw new JevCredentialError(preflight.error);
  }

  let family: string | undefined;
  let route: RouteDecision | undefined;
  /** The project this build is publishing to, once it exists, whether this build made it, and the
   * create that made it — held so the clean-up can wait for it to settle before undoing it. */
  let made: CreatedProject | undefined;
  let releaseRunLock: (() => void) | undefined;
  let releaseOnExit: (() => void) | undefined;
  let releaseSecondaryLock: (() => void) | undefined;
  /** The create's own rejection, kept so the catch can tell it from every later failure. */
  let createFailure: unknown;
  /** Who has answered so far — read by the catch, so a failed build keeps its provenance. */
  let ledger: ProviderLedgerView | undefined;

  try {
    const brief = typeof input.brief === 'string' ? input.brief : await input.brief();

    const compositionMode: CompositionMode = input.composition ?? 'family';
    const compositionStarted = performance.now();
    const compositionMs = () => Math.round(performance.now() - compositionStarted);
    let blockCatalog: BlockCatalog | undefined;
    if (compositionMode !== 'family') {
      if (!input.loadBlockCatalog) throw new Error(`composition '${compositionMode}' needs loadBlockCatalog: the reviewed blocks a page is composed from`);
      blockCatalog = await input.loadBlockCatalog();
    }
    /** The plan this build composes, once decided; `undefined` means the family route. */
    let composed: DecidedPlan | undefined;
    let compositionFallback: CompositionFallback | undefined;
    let planner: CompositionResult['planner'];
    if (compositionMode === 'blocks') {
      const decided = await decideBlockPlan(input, deps, brief, jevKey, blockCatalog!, undefined);
      planner = decided.planner;
      if ('plan' in decided) composed = decided;
      else compositionFallback = decided.fallback;
    }

    if (!composed && input.family === 'auto') {
      if (!input.loadAtlas) throw new Error("family 'auto' needs loadAtlas: the atlas and registry this brief is routed against");
      const { atlas, registry } = await input.loadAtlas();
      route = await routeBuild({ brief, atlas, registry, jevKey, options: input.routeOptions, signal: input.signal }, deps);
      // The router records failed votes as unrouted, including a transport abort. A cancelled
      // build still ends cancelled, before composition, generation or publication can proceed.
      input.signal?.throwIfAborted();
      emit({ type: 'route', decision: route });
      if (compositionMode === 'auto') {
        // `auto` composes only for a spine the reviewed blocks cover; the route's own top spine
        // decides, so there is no second spine question — which is why its confidence must clear
        // the planner's spine threshold here (Sol review round 4): a weak spine never picks a
        // composed page. A VALIDLY unrouted brief (every answer well-formed; Jev honestly said no
        // family fits, or none cleared the threshold) with a confident, covered spine can still
        // compose — that is the point of `auto`. But `resolveRoute` rejecting the model's OWN
        // `family` (or `spine`/`skin`) answer as malformed — including a family id the registry
        // does not list, e.g. a family still being built on another branch — means that answer set
        // was never trustworthy in the first place, and `route.spine` came from the very same
        // rejected response. Composing from an untrusted spine would be worse than the unrouted
        // family answer it came with (Grok review, t25c): treat it the same as no spine at all.
        if ((route.reason ?? '').startsWith('malformed answer')) {
          compositionFallback = 'route-invalid';
        } else {
          const spine = route.spine.code;
          if (!SPINES.some((candidate) => candidate.code === spine)) compositionFallback = 'no-spine';
          else if (!(route.spine.confidence >= DEFAULT_BLOCK_THRESHOLD)) compositionFallback = 'spine-below-threshold';
          else if (!autoCoverage(blockCatalog!, spine)) compositionFallback = 'no-coverage';
          else {
            const decided = await decideBlockPlan(input, deps, brief, jevKey, blockCatalog!, spine);
            planner = decided.planner;
            // A routed brief that states its hours keeps its family when no planned block can
            // show them (Devin, 2026-10-10: a dental brief's hours had no section on the page).
            if ('plan' in decided && route.decision === 'routed' && briefHoursClauseRows(brief).length > 0 && !planShowsHours(blockCatalog!, decided.plan)) compositionFallback = 'hours-not-covered';
            else if ('plan' in decided) composed = decided;
            else compositionFallback = decided.fallback;
          }
        }
      }
      // Unrouted is a decision, not a failure: no spine Jev is confident of, or no family above
      // the threshold. Nothing is built and nothing reaches the daemon — never a guess.
      if (!composed && route.decision !== 'routed') {
        const composition = compositionFallback ? withKit(fallbackResult(compositionMode, compositionFallback, planner), input.designKit, false) : undefined;
        if (composition) emit({ type: 'composition', result: composition, ms: compositionMs() });
        return { outcome: 'unrouted', route, ...(composition ? { composition } : {}) };
      }
      if (!composed) family = route.family!.id;
    } else if (!composed) {
      family = input.family;
      if (compositionMode === 'auto') compositionFallback = 'family-named';
    }

    let familyComposition: CompositionResult | undefined;
    if (composed) {
      family = COMPOSED_FAMILY;
      emit({
        type: 'composition',
        result: withKit({ requested: compositionMode, used: 'blocks', spine: composed.plan.spine, directionId: composed.plan.directionId, blocks: [...composed.plan.blocks], source: composed.source, ...(composed.planner ? { planner: composed.planner } : {}), ...(composed.supportGate ? { supportGate: composed.supportGate } : {}) }, input.designKit, true),
        ms: compositionMs(),
      });
    } else if (compositionFallback) {
      familyComposition = withKit(fallbackResult(compositionMode, compositionFallback, planner), input.designKit, false);
      emit({ type: 'composition', result: familyComposition, ms: compositionMs() });
    }
    // Both branches above settle it; the assertion is for the type checker only.
    family = family!;

    // Resolved here, rather than read straight off `input`, because `family` is only settled by
    // this point — the routed winner for `auto`, above. See `BuildInput.defaultModelFor`.
    const defaulted = input.provider === undefined ? input.defaultModelFor?.(family) : undefined;
    const provider: ProviderName = input.provider ?? defaulted?.provider ?? 'deepseek';
    const modelOverride = input.model ?? defaulted?.model;

    // A composed page belongs to no family package: nothing to prepare.
    const prepared = composed ? undefined : await input.prepare(family);
    const entry = prepared ? prepared.entry : `${COMPOSED_FAMILY}-r${input.revision}.html`;

    let publisher: ProjectPublisher | undefined;
    let ensurePublisher: RunOptions['ensurePublisher'];
    if (input.project) {
      const target = input.project;
      // A given project id is reused without creating one; anything else creates a new project.
      // A strict build's deferred publish needs to know which happened, so it deletes only a
      // project this build made — never one the caller supplied — if publishing then fails.
      const created = !target.projectId;
      const makePublisher = async (): Promise<{ publisher: ProjectPublisher; created: boolean }> => {
        // The id is settled, and recorded as this build's, BEFORE the create request goes out.
        // `POST /api/projects` takes the id from the client, so this is what gives a cancelled
        // build something to roll back — the daemon may well commit the project after the build
        // has stopped waiting for the answer.
        const projectId = target.projectId ?? newProjectId();
        // Deliberately NOT cancellable, and held rather than only awaited: the create runs under
        // its own deadline (see `ensureProject`), and the clean-up waits for this exact promise to
        // settle before it rolls back, so the DELETE can never overtake the create it is undoing.
        const creating = ensureProject({
          daemonUrl: target.daemonUrl,
          projectId: target.projectId,
          id: projectId,
          name: target.name ?? `${family} fast lane`,
          archive: target.archive,
          fetchImpl: deps.daemonFetch,
        });
        made = {
          publisher: projectPublisher({ daemonUrl: target.daemonUrl, projectId, fetchImpl: deps.daemonFetch, signal: input.signal }),
          created,
          creating,
        };
        try {
          await creating;
        } catch (error) {
          createFailure = error;
          throw error;
        }
        emit({ type: 'project', projectId, created });
        return made;
      };
      // Strict defers project creation (and every other daemon write) until the gate passes, so
      // the publisher is not built up front: `ensurePublisher` is handed to `runFastLane` instead
      // and called only on a pass. A non-strict build keeps publishing progressively.
      if (strict) ensurePublisher = makePublisher;
      else publisher = (await makePublisher()).publisher;
    }

    const modelName = modelOverride ?? PROVIDERS[provider].defaultModel;
    const acquire = deps.acquireRunLock ?? acquireRunLock;
    const fallback = fallbackFor(provider, input.fallbackProvider);
    // Round 2 audit (Sol B2): this used to default to 0 only with no fallback, and an explicit
    // `--max-retries` used to raise it again on EITHER path — either way, a provider-internal retry
    // could happen silently underneath `run.ts`'s own bounded, evented retry, stacking up to 3
    // requests it never saw a chance to log (G8 final root cause (b): a mid-stream reset could
    // exhaust this layer's own budget, 5+ seconds of backoff, before `callModel` ever saw the
    // failure). It is now always 0, on every path: `run.ts`'s `callModel` is the ONE budget for a
    // transport-class failure, provider-internal or not, and `input.maxRetries` (an explicit
    // `--max-retries`) instead sets THAT budget (`RunOptions.transportRetryLimit`, capped at 2) —
    // see the call into `runFastLane` below.
    const primaryCall = deps.createModelCaller({
      provider,
      model: modelName,
      apiKey: () => deps.resolveModelKey(provider),
      maxRetries: 0,
    });
    const recording = createRecordingCaller({ provider, model: modelName, call: primaryCall });
    let model: ModelCall = recording;
    let active = () => ({ provider, model: modelName });
    ledger = recording;
    if (fallback) {
      const fallbackModel = PROVIDERS[fallback].defaultModel;
      // Created on first use, so a build that never fails over never builds a second caller.
      let secondaryCall: ModelCall | undefined;
      const failover = createFailoverCaller({
        primary: { provider, model: modelName, call: primaryCall },
        secondary: {
          provider: fallback,
          model: fallbackModel,
          call: (request) => (secondaryCall ??= deps.createModelCaller({
            provider: fallback,
            model: fallbackModel,
            apiKey: () => deps.resolveModelKey(fallback),
            // Same rule as `primaryCall` above: always 0, `run.ts`'s `callModel` owns the budget.
            maxRetries: 0,
          }))(request),
        },
        userSignal: input.signal,
        beforeSecondary: async () => {
          if (!PROVIDERS[fallback].serializeRuns) return;
          const release = await acquire(fallback, {
            signal: input.signal,
            onWait: (pid) => emit({ type: 'lock-wait', provider: fallback, pid }),
          });
          releaseSecondaryLock = release;
          process.on('exit', release);
        },
        onFailover: (event) => emit({ type: 'failover', ...event }),
      });
      model = failover;
      active = failover.active;
      ledger = failover;
    }
    const verify: FaithfulnessChecker | undefined = input.verify !== 'off'
      ? deps.createJevChecker({ apiKey: jevKey, threshold: input.verifyThreshold, signal: input.signal })
      : undefined;

    if (PROVIDERS[provider].serializeRuns) {
      releaseRunLock = await acquire(provider, {
        signal: input.signal,
        onWait: (pid) => emit({ type: 'lock-wait', provider, pid }),
      });
      // A `process.exit` mid-build would otherwise leave the lock file behind for the next run to
      // time out on. The listener is removed again in the `finally` below, so a long-lived host
      // that runs many builds does not accumulate one per build.
      releaseOnExit = releaseRunLock;
      process.on('exit', releaseOnExit);
    }

    // Both decisions run before the fill, side by side: each is one Jev request at most, and
    // neither reads the other. Effects run after routing, so a routed skin is known. A composed page
    // belongs to no family package and declares no placements: it plans neither, and reports
    // effects `off` (its composition result carries the fixed reason `no-placements`).
    const [sections, effects] = prepared
      ? await Promise.all([
        planSections(input, deps, brief, prepared, jevKey, emit),
        planEffects(input, deps, brief, prepared, route, jevKey, emit),
      ])
      : [undefined, OFF_EFFECTS];

    const report = composed
      ? await composeBlocks({
        plan: composed.plan,
        planSource: composed.source,
        ...(composed.planner ? { planner: composed.planner } : {}),
        ...(composed.supportGate ? { supportGate: composed.supportGate } : {}),
        requested: compositionMode,
        kinds: composed.kinds,
        brief,
        mode: input.mode,
        entry,
        revision: input.revision,
        model,
        modelName,
        activeModelName: () => active().model,
        // Strict only (checked at the top of `buildSite`): the checker exists and nothing is saved
        // until every block has passed it.
        verify: verify!,
        strict,
        ensurePublisher,
        onEvent: emit,
        ...(input.maxRepairs !== undefined ? { maxRepairs: input.maxRepairs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.designKit ? { designKit: input.designKit } : {}),
      })
      : await runFastLane({
      pkg: prepared!.pkg,
      brief,
      mode: input.mode,
      entry: prepared!.entry,
      revision: input.revision,
      model,
      modelName,
      activeModelName: () => active().model,
      spine: prepared!.spine,
      previousRecipe: prepared!.previousRecipe,
      lockPaths: prepared!.lockPaths,
      dropSections: sections!.dropped,
      restoreSections: sections!.restored,
      publisher,
      verify,
      strict,
      verifyAfterPublish,
      ensurePublisher,
      // An explicit `--max-retries` sets `run.ts`'s shared per-unit transport-retry budget, not any
      // provider's own internal retry count (see `primaryCall`/`secondaryCall` above) — capped at 2
      // there regardless of what is passed here.
      ...(input.maxRetries !== undefined ? { transportRetryLimit: input.maxRetries } : {}),
      onEvent: emit,
      onCall: prepared!.onCall,
      maxRepairs: input.maxRepairs,
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      ...(input.callTimeoutMs !== undefined ? { callTimeoutMs: input.callTimeoutMs } : {}),
      signal: input.signal,
      ...(input.sectionSelection !== undefined ? { sectionSelection: input.sectionSelection } : {}),
      ...(input.designReference !== undefined ? { designReference: input.designReference } : {}),
      effects: effects.plan,
      effectsDecision: effects.result,
    });
    if (familyComposition) report.composition = familyComposition;
    if (composed && !report.effects) report.effects = { ...OFF_EFFECTS.result, applied: [], skipped: [] };

    const used = ledger.answered() ?? active();
    return {
      outcome: 'built',
      family,
      ...(route ? { route } : {}),
      ...(report.projectId !== undefined ? { projectId: report.projectId } : {}),
      provider: used.provider,
      model: used.model,
      providers: ledger.providers(),
      report,
    };
  } catch (error) {
    const provenance = provenanceOf(ledger);
    // Checked before the cancellation classifier, and whatever the signal says: a build that was
    // cancelled AND left a project behind has to report the project. The abort is usually what
    // caused the publish to fail in the first place, so the two arrive together.
    if (error instanceof PublishRollbackError) {
      return { outcome: 'rollback-failed', family: family ?? input.family, projectId: error.projectId, message: error.message, ...provenance };
    }
    const cancelled = isCancellation(error, input.signal);
    // A create that did not complete leaves the same ambiguity whether or not anyone cancelled:
    // the daemon may still commit it, and the id exists nowhere a caller can reach — a rejection
    // carries a message, not a project. So that failure gets the clean-up too, and if the id
    // cannot be accounted for afterwards it is reported rather than thrown away.
    const ambiguousCreate = error === createFailure && createFateOf(error) === 'unknown';
    // Output validation can fail after a non-strict build created its project and saved valid
    // drafts. Remove that abandoned new project before rethrowing either output failure; strict
    // has not created one, and cleanUpAbandoned preserves a caller-supplied project.
    const invalidOutput = error instanceof PageTooLargeError || error instanceof RenderQualityError;
    if (!cancelled && provenance) withBuildProvenance(error, provenance);
    if (!cancelled && !ambiguousCreate && !invalidOutput) throw error;

    const cleanUp = await cleanUpAbandoned(made);
    // A clean-up that could not finish is reported the same way a strict rollback failure is: the
    // project it could not account for is the one thing a person now has to deal with, and it
    // would be lost in a plain rejection.
    if (cleanUp.status === 'failed') {
      return { outcome: 'rollback-failed', family: family ?? input.family, projectId: cleanUp.projectId, message: cleanUp.message, ...provenance };
    }
    // Rolled back cleanly. A build nobody cancelled has still failed, and says so as it always did.
    if (!cancelled) throw error;
    return { outcome: 'cancelled', ...(family !== undefined ? { family } : {}), ...(cleanUp.projectId !== undefined ? { projectId: cleanUp.projectId } : {}) };
  } finally {
    releaseRunLock?.();
    if (releaseOnExit) process.off('exit', releaseOnExit);
    if (releaseSecondaryLock) {
      releaseSecondaryLock();
      process.off('exit', releaseSecondaryLock);
    }
  }
}

/** The failover target for `primary`, or undefined when failover is off. See `fallbackProvider`. */
function fallbackFor(primary: ProviderName, requested: ProviderName | null | undefined): ProviderName | undefined {
  if (requested === null || requested === primary) return undefined;
  if (requested !== undefined) return requested;
  return (Object.keys(PROVIDERS) as ProviderName[]).find((name) => name !== primary);
}

/**
 * The optional-section decision for one build: hints first, then one Jev keep/drop request for the
 * rest — unless verify is off, the caller asked not to judge (a repair), or no judge was injected,
 * in which case every unhinted section is kept. Emits one `sections` event when the family has any
 * optional section. Never throws for Jev's own failures; a cancellation propagates.
 */
async function planSections(
  input: BuildInput,
  deps: BuildDeps,
  brief: string,
  prepared: PreparedBuild,
  jevKey: JevKeyResolver,
  emit: (event: BuildEvent) => void,
): Promise<SectionDecision> {
  const spine = prepared.spine ?? prepared.pkg.fixture;
  const optional = optionalSectionsOf(prepared.pkg.schema, spine, prepared.pkg.fixture);
  const judging = input.verify !== 'off' && input.judgeSections !== false && deps.createSectionJudge !== undefined;
  const judge = judging ? deps.createSectionJudge!({ apiKey: jevKey, ...(input.signal ? { signal: input.signal } : {}) }) : undefined;
  const decision = await decideSections({ brief, optional, ...(input.sections ? { hints: input.sections } : {}), ...(judge ? { judge } : {}) });
  if (optional.length > 0) {
    emit({ type: 'sections', kept: decision.kept, dropped: decision.dropped, source: decision.source, ...(decision.skipped !== undefined ? { skipped: decision.skipped } : {}), ...(decision.warnings.length > 0 ? { warnings: decision.warnings } : {}), ms: decision.ms });
  }
  return decision;
}

/** The decision for a page with no placements and no named ids: nothing planned, reported `off`. */
const OFF_EFFECTS: EffectDecision = { plan: { effects: [] }, result: { mode: 'off', applied: [], skipped: [], bytesAdded: 0 }, ms: 0 };

/**
 * The effect decision for one build (see `effects.ts`): hints first, then one Jev request for the
 * family's other placements, then the guards. A family that declares no placements, with no ids
 * named, plans nothing and emits no event; its page renders exactly as before effects existed and
 * reports `mode: 'off'`. Never throws for Jev's own failures; a cancellation propagates.
 */
async function planEffects(
  input: BuildInput,
  deps: BuildDeps,
  brief: string,
  prepared: PreparedBuild,
  route: RouteDecision | undefined,
  jevKey: JevKeyResolver,
  emit: (event: BuildEvent) => void,
): Promise<EffectDecision> {
  const declaration = prepared.pkg.effects ?? null;
  const requested: EffectsInput = input.effects ?? (declaration ? 'auto' : 'off');
  // No placements and no named ids: nothing to decide and nothing to announce. The report still
  // says `off`, so every build's snapshot carries `effects`.
  if (!declaration && typeof requested !== 'object') return { plan: { effects: [] }, result: { ...OFF_EFFECTS.result, applied: [], skipped: [] }, ms: 0 };
  const judge = requested !== 'off' && deps.createEffectJudge
    ? deps.createEffectJudge({ apiKey: jevKey, ...(input.signal ? { signal: input.signal } : {}) })
    : undefined;
  const decision = await decideEffects({
    input: requested,
    declaration,
    ...(input.effectCatalog ? { catalog: input.effectCatalog } : {}),
    ...(route ? { skin: { choice: route.skin.choice, confidence: route.skin.confidence } } : {}),
    brief,
    ...(judge ? { judge } : {}),
    ...(input.effectsReplay ? { hintSource: 'repair' as const } : {}),
  });
  emit({ type: 'effects', applied: decision.plan.effects.length, skipped: decision.result.skipped.length, ms: decision.ms });
  return decision;
}

/**
 * What a failed create proves about whether the project exists.
 *
 * Only the daemon answering "no" is proof: a 4xx is a decision about the request itself — read,
 * refused, nothing written. 408 and 429 are the exceptions to that, because they are the daemon
 * asking to be asked again rather than saying what became of this attempt. Everything else leaves
 * no evidence at all: a 5xx is the daemon failing part-way through and not saying how far it got,
 * and a dropped socket or a deadline is the client losing sight of a request the daemon may well
 * still be finishing. Anything that is not proof is `unknown`, and `unknown` is rolled back.
 */
type CreateFate = 'committed' | 'refused' | 'unknown';

function createFateOf(error: unknown): 'refused' | 'unknown' {
  if (!(error instanceof DaemonHttpError)) return 'unknown';
  if (error.status < 400 || error.status >= 500) return 'unknown';
  return error.status === 408 || error.status === 429 ? 'unknown' : 'refused';
}

/** A project this build created, the publisher for it, and the create request that made it. */
type CreatedProject = { publisher: ProjectPublisher; created: boolean; creating: Promise<string> };

/** What the clean-up after a cancelled build managed to do. `clean` means nothing was left behind
 * that this build is answerable for — `projectId` is then set only for a project the caller
 * supplied, which is left exactly as it was. `failed` means a project is still on the daemon. */
type CleanUp = { status: 'clean'; projectId?: string } | { status: 'failed'; projectId: string; message: string };

/**
 * Clean-up after a build that has stopped: cancelled, failed while creating its project, or
 * refused its final page as over the byte budget (`PageTooLargeError`).
 *
 * A project this build created is this build's alone to remove: nobody else has seen its id, and
 * leaving a half-written site behind is worse than leaving nothing. A project the caller supplied
 * may predate this build or be shared with something else, so it is never deleted — only reported
 * back. In-flight writes have already settled by the time this runs (`runFastLane` awaits them
 * before it rethrows), so the delete cannot race a save still on the wire.
 *
 * Nor can it race the create. The create was never cancellable, so it is still running or already
 * finished, and either way it is awaited here first. That is what makes the rollback safe rather
 * than merely likely: the daemon inserts a project only after a stretch of async validation, so a
 * DELETE sent while the POST is still in flight can be answered — truthfully — with 404 for a
 * project that lands a moment later.
 *
 * Waiting cannot be unbounded, so the create has its own deadline. If it fires — or the socket
 * drops, or the daemon answers 5xx — the create's fate is unknown: it may still commit. The
 * rollback is attempted anyway, and if it finds nothing that is NOT proof there is nothing, so it
 * is reported as a failed clean-up with the id, for a caller that can retry or log it, rather than
 * as a clean ending. Only an authoritative refusal (see `CreateFate`) is taken at its word.
 *
 * Strict is not exempt. It defers project creation until the gate passes, so its create happens
 * inside `runFastLane` — and when the create itself is what was cancelled, `runFastLane` never
 * reached the publish it rolls back from and has no publisher to roll back with. This build does.
 * When `runFastLane` DID roll back, the second delete is harmless, because a rollback tolerates a
 * project that is already gone (see `rollbackProject`).
 */
async function cleanUpAbandoned(made: CreatedProject | undefined): Promise<CleanUp> {
  if (!made) return { status: 'clean' };
  if (!made.created) return { status: 'clean', projectId: made.publisher.projectId };

  const projectId = made.publisher.projectId;
  let createFate: CreateFate;
  try {
    await made.creating;
    createFate = 'committed';
  } catch (error) {
    createFate = createFateOf(error);
  }

  try {
    // The rollback's retries are there to wait out a create whose fate is unknown. Here the create
    // has already been waited for, so when it definitely committed — or definitely did not — one
    // answer is the whole answer, and a 404 means somebody else (`runFastLane`'s own strict
    // rollback, usually) has already removed it.
    const removed = await made.publisher.deleteProject(createFate === 'unknown' ? {} : { retries: 0 });
    if (removed === 'deleted' || createFate !== 'unknown') return { status: 'clean' };
    return {
      status: 'failed',
      projectId,
      message: `project ${projectId} was being created when the build stopped, the create never completed, and the rollback found no such project; whether it was created is unknown`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      projectId,
      message: `the build stopped after creating project ${projectId}, and removing it again failed: ${message}`,
    };
  }
}

/** A decided block plan, with who chose it and each block's section kind, in page order. */
type DecidedPlan = { plan: BlockPlan; source: 'jev' | 'replay'; kinds: string[]; planner?: CompositionResult['planner']; supportGate?: BlockSupportReceipt };

function fallbackResult(requested: CompositionMode, fallback: CompositionFallback, planner?: CompositionResult['planner']): CompositionResult {
  return { requested, used: 'family', fallback, ...(planner ? { planner } : {}) };
}

/** A composition result with the picked kit's receipt, when a kit was picked. */
function withKit(result: CompositionResult, kit: BuildDesignKit | undefined, applied: boolean): CompositionResult {
  return kit ? { ...result, designKit: { id: kit.id, title: kit.title, applied } } : result;
}

/**
 * The block plan for one build: a replayed plan (re-checked against today's catalog; one that no
 * longer applies throws, so a fork never silently becomes a different page), else the picker and post-picker support gate
 * through the injected planner. Jev's own failures come back as a fixed fallback code; only a
 * cancellation propagates.
 */
async function decideBlockPlan(
  input: BuildInput,
  deps: BuildDeps,
  brief: string,
  jevKey: JevKeyResolver,
  catalog: BlockCatalog,
  spine: string | undefined,
): Promise<DecidedPlan | { fallback: CompositionFallback; planner?: CompositionResult['planner'] }> {
  const kindsOf = (plan: BlockPlan) => plan.blocks.map((id) => catalog.blocks.find((entry) => entry.id === id)?.sectionKind ?? 'unclassified');
  if (input.blockPlan) {
    const directions = (await listDesignDirectionMoods()).map((direction) => direction.id);
    // A saved plan names Cult blocks by their public id (what a build reports) or, from an older
    // build, the internal one; the catalog is keyed on the internal id.
    const saved = { ...input.blockPlan, blocks: input.blockPlan.blocks.map(internalSectionEntryId) };
    const problem = checkBlockPlan(saved, catalog, directions);
    if (problem) throw new BlockPlanReplayError(problem.replace(/cult:[a-z0-9-]+/g, publicSectionEntryId));
    const plan = { spine: saved.spine, directionId: saved.directionId, blocks: [...saved.blocks] };
    return { plan, source: 'replay', kinds: kindsOf(plan) };
  }
  if (!deps.createBlockPlanner) return { fallback: 'planner-unavailable' };
  const planner = deps.createBlockPlanner({ apiKey: jevKey, ...(input.signal ? { signal: input.signal } : {}) });
  const judged = await planner.plan({ brief, catalog, ...(spine !== undefined ? { spine } : {}) });
  const plannerReceipt = { calls: judged.calls, ms: judged.ms };
  if ('fallback' in judged) return { fallback: judged.fallback, planner: plannerReceipt };
  return { plan: judged.plan, source: 'jev', planner: plannerReceipt, kinds: kindsOf(judged.plan), ...(judged.supportGate ? { supportGate: judged.supportGate } : {}) };
}
