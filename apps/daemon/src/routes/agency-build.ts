import { randomUUID } from 'node:crypto';
import { publicBlockSupport, publicBlockPlanner } from './agency-build-support.js';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type {
  AgencyBuildEvent,
  AgencyBuildFailure,
  AgencyBuildForkRequest,
  AgencyBuildListItem,
  AgencyBuildListResponse,
  AgencyBuildProviderUse,
  AgencyBuildRepairReason,
  AgencyBuildRepairResponse,
  AgencyBuildResponse,
  AgencyBuildRouteDecision,
  AgencyBuildSnapshot,
  AgencyBuildStatus,
  AgencyBuildSummary,
  AgencyBuildRenderQuality,
  AgencyRenderQualityCheck,
  AgencyBuildBusyDetails,
  AgencyBuildBlockPlan,
  AgencyBuildComposition,
  AgencyBuildCompositionResult,
  AgencyBuildVerifyVerdict,
  AgencyEffectsInput,
  AgencyEffectsResult,
  AgencyFamiliesResponse,
  AgencyFamilyEffectsResponse,
  AgencyFamilySectionsResponse,
  AgencyOutputScope,
  AgencySectionPlacement,
  AgencySectionSelectionInput,
  ApiErrorCode,
  PageKind,
} from '@mish/contracts';
import {
  AGENCY_BUILD_HISTORY_LIMIT,
  AGENCY_BUILD_MAX_SECTION_HINTS,
  AGENCY_EFFECT_PLACEMENT_IDS,
  AGENCY_ROUTE_MAX_CHARS,
  agencyEffectHintsRefusal,
  parseAgencyEffectsInput,
  parseAgencyEffectsResult,
  parseAgencyFamilyEffectsResponse,
} from '@mish/contracts';
import type { FamilyRegistry, ShapeAtlas } from '@mish/agency-fast-lane/atlas';
import { outputScopeOf } from '@mish/agency-fast-lane/atlas';
import type { FamilyPackage } from '@mish/agency-fast-lane/family';
import type {
  BuildDeps,
  BuildEvent,
  BuildResult,
  EffectCatalog,
  SectionSelection,
  buildSite as buildSiteFn,
} from '@mish/agency-fast-lane/build';
import { familyEffectsResponse } from '@mish/agency-fast-lane/build';
import type { BuildDesignKit } from '@mish/agency-fast-lane/build';
import { buildProvenanceOf, DaemonHttpError, failedUnitOf, JevCredentialError, RenderQualityError, PageTooLargeError, REPAIR_REASON_TEXT, UnitDeadlineError, UnitRefusedError } from '@mish/agency-fast-lane/build';
import { ProviderHttpError, ProviderKeyError, ProviderKeyUnreadableError, type ProviderName } from '@mish/agency-fast-lane/deepseek';
import { ProviderFailoverError } from '@mish/agency-fast-lane/failover';
import { repairLockPaths } from '@mish/agency-fast-lane/jev';
import { optionalSectionsOf } from '@mish/agency-fast-lane/sections';
import { listComposableAdapterIds, resolveDesignDirection, resolveSectionAdapter, SectionSelectionRefusedError } from '@mish/agency-fast-lane/section-overlay';
import { BlockPlanReplayError, blockCatalogFrom, COMPOSED_FAMILY, COMPOSITION_FALLBACKS, COMPOSITION_MODES, type BlockCatalog } from '@mish/agency-fast-lane/block-plan';
import { ComposedPageTooLargeError, CompositionVerifyError, type CompositionResult } from '@mish/agency-fast-lane/block-compose';
import { mishPackGeneration } from '../mish-packs/overlay.js';
import { cultInventoryData } from '../cult-data.js';
import { fastLanePackGeneration } from '@mish/agency-fast-lane/pack-overlay';
import { sectionCatalogData } from '../section-catalog-data.js';
import { AgencyJevConfigUnreadableError, AgencyModelKeyUnavailableError, type AgencyJevKeyStore } from '../storage/agency-config.js';
import { cultInternalId, cultPublicId } from '../cult-public-ids.js';
import type { RouteDeps } from '../server-context.js';
import type { AgencyBuildForkSeed, PersistedAgencyBuild } from '../agency-build-store.js';
import { createAgencyBuildStore } from '../agency-build-store.js';
import { DESIGN_SYSTEM_ID_MAX_CHARS, resolveAgencyDesignKit, type AgencyDesignKitDeps } from './agency-build-kit.js';
import { parseSectionSelectionShape } from '../agency-build-section-selection.js';
import { fetchMotionSitesDesignReference } from '../motionsites/design-reference.js';
import { MotionSitesLoginRequiredError, MotionSitesPaidAccessRequiredError, MotionSitesUpstreamError } from '../motionsites/errors.js';
import {
  encodeAgencyBuildEvent,
  type AgencyBuildAguiCursor,
  type AgencyBuildAguiMeta,
  type AguiEvent,
} from '@mish/agui-adapter';

/**
 * The fast-lane build job (`docs/plans/2026-09-20-follow-ups-design.md` §6.4, and §8 "6b").
 *
 * A build is not a physical Run. It is a deterministic generator with its own closed event union
 * and no transcript, so it gets a daemon-owned job registry with SSE instead of the Run registry,
 * the analytics lifecycle and the chat surface — see §6.2 for the decision and for the path back
 * if a build ever has to appear in chat. Nothing here starts a physical Run.
 *
 * Every endpoint is local same-origin only, not just the one that starts a build: a build spends
 * model credit, and a page on another origin must not be able to start one, watch one, or learn
 * which projects this daemon has made.
 *
 * The registry is in memory for LIVE control — the one-at-a-time lock, SSE listeners, cancellation
 * — none of which can survive a restart and none of which tries to. What DOES survive is the build
 * history: `agency-build-store.ts` persists every build's snapshot to `buildsFile` on creation and
 * again on every terminal transition, bounded by `AGENCY_BUILD_HISTORY_LIMIT`. `hydrated` (below)
 * reloads that file before any request is answered; a build the file still shows mid-flight is
 * rewritten `failed` with a fixed sentence, since the process that was running it is gone. See
 * `packages/contracts/src/api/agency-build.ts`'s module docblock for the client-facing version of
 * this rule, and `POST .../:id/fork` for what makes the surviving history actionable.
 *
 * Two rules the DTO mapping exists to enforce, both from the same source as `/api/agency/route`'s:
 * no client ever sees the caller's brief, the model's output, or an upstream body. A `repair`
 * event's message quotes the text that was refused, a strict gate's reason names the slots that
 * fabricated, and a thrown error can carry anything at all — so the public event carries a label
 * and a fixed code, and every error is one of five fixed sentences with the real one logged
 * server-side against the build id.
 */

/** The model key this daemon needs could not be read. Mapped to `MODEL_UNAVAILABLE`; carries no
 * detail of its own, so the secret store's message (which names the entry it tried) stays here. */
export class ModelKeyUnavailableError extends Error {
  constructor() {
    super('model key unavailable');
    this.name = 'ModelKeyUnavailableError';
  }
}

/**
 * Wraps the store's `resolveModelKey` for a build. Only a genuinely missing key becomes
 * `ModelKeyUnavailableError`, which the fast lane treats as a missing key and may fail over on.
 * Anything else — above all an unreadable stored config — becomes `ProviderKeyUnreadableError`:
 * the fast lane never fails over on it, so a working second provider cannot hide a broken file.
 * Neither error carries the store's own message, which names the entry it tried.
 */
function buildModelKeyResolver(resolve: (provider: ProviderName) => Promise<string>): (provider: ProviderName) => Promise<string> {
  return async (provider) => {
    try {
      return await resolve(provider);
    } catch (error) {
      if (error instanceof AgencyModelKeyUnavailableError) throw new ModelKeyUnavailableError();
      // The store's error rides along as `cause` for the daemon's own debugging; nothing reads its
      // message into a log line or a response (see `keyStoreFaultLabel`).
      throw new ProviderKeyUnreadableError(provider, error);
    }
  };
}

/**
 * A log-safe label for a key-store rejection: the error's class name and its `code`, each only
 * when it looks like an identifier. Never the message, which can name a path, a vault entry or a
 * slice of the file that holds the key.
 */
export function keyStoreFaultLabel(error: unknown): string {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const name = error instanceof Error && identifier.test(error.name) ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  return typeof code === 'string' && identifier.test(code) ? `${name} ${code}` : name;
}

/**
 * The log line for a key or credential failure, or `undefined` for any other error. Shared by a
 * build's settlement and a repair's catch so neither ever logs a key resolver's raw `cause`.
 */
export function keyFaultLogLine(error: unknown): string | undefined {
  if (error instanceof ProviderKeyUnreadableError) return `could not read the ${error.provider} key: ${keyStoreFaultLabel(error.cause)}`;
  if (error instanceof ModelKeyUnavailableError || error instanceof ProviderKeyError) return 'could not read the model key';
  if (error instanceof JevCredentialError) return 'could not read the Jev credential';
  return undefined;
}

export interface AgencyBuildDeps {
  /** The Website Shape Atlas and family registry a `family: 'auto'` build routes against. Passed
   * as objects, never loaded here: the packaged daemon is an esbuild prebundle where the fast
   * lane's own file loaders resolve inside the bundle. Same rule as the design index. */
  atlas: ShapeAtlas;
  registry: FamilyRegistry;
  /** Resolves the TypeSafe key: environment, then the key stored through Settings, then the
   * machine's secret store. The same store `/api/agency/route` reads. */
  jevKeyStore: AgencyJevKeyStore;
  /** This daemon's own base URL, which is what a build publishes through. It is a ref rather than
   * a string because the port is only known after the listener binds. */
  daemonUrlRef: { current: string };
  /** The fast lane's build step. Injected so a test never reaches a model, Jev or a project. */
  runBuild: typeof buildSiteFn;
  /** What `runBuild` needs besides the daemon's own HTTP, which this module supplies per build so
   * every self-call carries the initiating request's scope. */
  buildDeps: Omit<BuildDeps, 'daemonFetch'>;
  /** Loads the routed family's package, as `prepare` hands it over. */
  loadPackage: (family: string) => Promise<FamilyPackage>;
  /**
   * The GenUI catalog manifest (`genuiCatalog.manifest` from `@mish/genui-catalog/data`,
   * bundle-safe literals) that effect kinds, names and bytes are read from. Threaded to every build
   * as `BuildInput.effectCatalog`, and read by `familyEffectsResponse` for
   * `GET /api/agency/families/:family/effects` and for checking a request's explicit ids. Omitted
   * (a test harness), a `none`-policy family allows no component and names fall back to ids.
   */
  effectCatalog?: EffectCatalog;
  /** `<RUNTIME_DATA_DIR>/agency-builds/index.json`. A missing file is an empty history, exactly
   * like the design index's `indexFile`. */
  buildsFile: string;
  /** The reviewed blocks a `composition: 'blocks' | 'auto'` build composes from. Defaults to the
   * bundled section catalog and Cult inventory JSON (bundle-safe static imports, never a file read
   * relative to the fast lane); injected by tests. */
  loadBlockCatalog?: () => Promise<BlockCatalog>;
  /** Reads the installed design kits a request's `designSystemId` names (`agency-build-kit.ts`).
   * Omitted (a test harness), every `designSystemId` is refused as not installed. */
  designKits?: AgencyDesignKitDeps;
}

let bundledBlockCatalog: { generation: number; catalog: Promise<BlockCatalog> } | undefined;

/** The block catalog from this daemon's bundled JSON (plus any installed pack's rows), restricted
 * to ids the adapter registry resolves. Built once per pack generation. */
function defaultBlockCatalog(): Promise<BlockCatalog> {
  const generation = mishPackGeneration() * 1_000_003 + fastLanePackGeneration();
  if (bundledBlockCatalog?.generation !== generation) {
    bundledBlockCatalog = {
      generation,
      catalog: (async () => blockCatalogFrom(
        sectionCatalogData() as unknown as Parameters<typeof blockCatalogFrom>[0],
        cultInventoryData() as unknown as Parameters<typeof blockCatalogFrom>[1],
        // Composable ids only (G9 dry run): see the fast lane's `composeRefusalFor`.
        await listComposableAdapterIds(),
      ))(),
    };
  }
  return bundledBlockCatalog.catalog;
}

/** A Cult entry's public id (`cult:<slug>`); any other id, or one already public, unchanged. */
function publicEntryId(id: string): string {
  return cultPublicId(id) ?? id;
}

/**
 * A snapshot with every Cult entry id it carries in public form: the section overlay's entry, a
 * composition's blocks, and its events' composition blocks and unit labels. A build reports public
 * ids already; this also covers a snapshot saved before public ids existed, so an older build is
 * served the same way. Idempotent.
 */
export function publicSnapshotIds(snapshot: AgencyBuildSnapshot): AgencyBuildSnapshot {
  const overlay = snapshot.sectionOverlay;
  const composition = snapshot.composition;
  return {
    ...snapshot,
    ...(overlay ? { sectionOverlay: { ...overlay, entryId: publicEntryId(overlay.entryId) } } : {}),
    ...(composition ? { composition: publicCompositionIds(composition) } : {}),
    ...(Array.isArray(snapshot.events) ? { events: snapshot.events.map(publicEventIds) } : {}),
  };
}

function publicEventIds<E extends { label?: string; composition?: AgencyBuildCompositionResult }>(event: E): E {
  return {
    ...event,
    ...(typeof event.label === 'string' ? { label: publicEntryId(event.label) } : {}),
    ...(event.composition ? { composition: publicCompositionIds(event.composition) } : {}),
  };
}

function publicCompositionIds(result: AgencyBuildCompositionResult): AgencyBuildCompositionResult {
  const { supportGate: originalSupportGate, planner: originalPlanner, ...rest } = result;
  const planner = publicBlockPlanner(originalPlanner);
  const supportGate = originalSupportGate ? publicBlockSupport(originalSupportGate, publicEntryId) : undefined;
  return {
    ...rest,
    ...(planner ? { planner } : {}),
    ...(result.blocks ? { blocks: result.blocks.map(publicEntryId) } : {}),
    ...(result.budgetDropped ? { budgetDropped: result.budgetDropped.map(publicEntryId) } : {}),
    ...(supportGate ? { supportGate } : {}),
  };
}

/**
 * The public copy of a composition decision: every field named, none spread, so a field added
 * to the fast lane's `CompositionResult` cannot reach a client unread. Ids and fixed codes only;
 * a Cult block is named by its public id (the fast lane plans with internal ones).
 */
export function toCompositionDto(result: CompositionResult): AgencyBuildCompositionResult {
  const supportGate = result.supportGate ? publicBlockSupport(result.supportGate, publicEntryId) : undefined;
  const planner = publicBlockPlanner(result.planner);
  return {
    requested: result.requested,
    used: result.used,
    ...(result.spine !== undefined ? { spine: result.spine } : {}),
    ...(result.directionId !== undefined ? { directionId: result.directionId } : {}),
    ...(result.blocks ? { blocks: result.blocks.map(publicEntryId) } : {}),
    ...(result.source !== undefined ? { source: result.source } : {}),
    ...(planner ? { planner } : {}),
    ...(supportGate ? { supportGate } : {}),
    ...(result.fallback !== undefined && COMPOSITION_FALLBACKS.includes(result.fallback) ? { fallback: result.fallback } : {}),
    ...(result.budgetDropped ? { budgetDropped: result.budgetDropped.map(publicEntryId) } : {}),
    // Composed pages declare no placements: the only effects value a client may see.
    ...(result.effects?.mode === 'off' && result.effects.reason === 'no-placements' ? { effects: { mode: 'off' as const, reason: 'no-placements' as const } } : {}),
    ...(result.designKit ? { designKit: { id: result.designKit.id, title: result.designKit.title, applied: result.designKit.applied } } : {}),
  };
}

/**
 * The plan a composed build ran with, from its composition decision; `undefined` otherwise. The
 * decision names Cult blocks by public id; the plan a fork replays keeps the internal ids the
 * block catalog is keyed on (the fast lane also accepts either).
 */
function planOf(result: AgencyBuildCompositionResult | undefined): AgencyBuildBlockPlan | undefined {
  if (!result || result.used !== 'blocks' || !result.spine || !result.directionId || !result.blocks) return undefined;
  return { spine: result.spine, directionId: result.directionId, blocks: result.blocks.map(cultInternalId) };
}

export interface RegisterAgencyBuildRoutesDeps extends RouteDeps<'http' | 'paths'> {
  agencyBuild: AgencyBuildDeps;
}

/**
 * The revision a daemon build uses, and the provider a request falls back to when it names none.
 * The CLI takes both `provider` and `revision` as flags; the API offers `provider` on
 * `POST /api/agency/build` (see `AgencyBuildRequest.provider`) but not `revision` — a build
 * started from the Route panel has nowhere to say "revision 2", so revision stays the CLI's own
 * default and the two surfaces build the same page from the same brief.
 */
const DEFAULT_PROVIDER: ProviderName = 'deepseek';
const DEFAULT_REVISION = 1;

/**
 * The per-page-kind fill default from the 2026-09-22 bake-off
 * (`docs/evals/2026-09-22-genui-bakeoff.md`, run 2026-09-22): across 90 builds, Cerebras
 * `gpt-oss-120b` had the lowest preview p50 for all three page kinds the run measured — site
 * (1470 ms), app (1074 ms) and dashboard (1134 ms) — against DeepSeek's `deepseek-v4-flash`; none
 * of the models cleared the report's flagged-rate bar, so each winner is the lowest p50 with that
 * caveat, not an unqualified pass. Keyed by family id rather than page kind because that is what
 * a build actually carries. The seven other registered site families were not in that run and
 * keep falling back to `DEFAULT_PROVIDER`, same as before this table existed.
 */
const DEFAULT_MODEL_BY_FAMILY: Readonly<Record<string, { provider: ProviderName; model?: string }>> = {
  'marketing-site': { provider: 'cerebras', model: 'gpt-oss-120b' },
  'app-shell': { provider: 'cerebras', model: 'gpt-oss-120b' },
  'crm-dashboard': { provider: 'cerebras', model: 'gpt-oss-120b' },
  // The SM, CS and MI page kinds (M4) are HyperUI page kinds like the three above and were not
  // in the bake-off; they take the same site-kind winner rather than the generic default.
  listings: { provider: 'cerebras', model: 'gpt-oss-120b' },
  publication: { provider: 'cerebras', model: 'gpt-oss-120b' },
  nonprofit: { provider: 'cerebras', model: 'gpt-oss-120b' },
  // docs-hub (CS.02) is the same kind of HyperUI page kind as publication (CS.01); same reasoning.
  'docs-hub': { provider: 'cerebras', model: 'gpt-oss-120b' },
  // restaurant (BA.02) was not in the bake-off. `model` is genuinely optional on this table's own
  // type above (`{ provider: ProviderName; model?: string }`), so omitting it here typechecks.
  // The provider is spelled out as 'deepseek' — the same literal `DEFAULT_PROVIDER` is assigned
  // to a few lines above this table — so restaurant reads as a deliberate choice rather than a
  // family someone forgot to add. `apps/daemon/tests/agency-build-provider.test.ts` ("family:
  // restaurant … resolves identically to a family the table does not mention at all") sends a
  // build request for family 'restaurant' with no explicit provider and checks the resulting
  // call has provider 'deepseek' and model undefined — the same pair a family entirely absent
  // from this table gets from `defaultModelFor`'s `?? { provider: DEFAULT_PROVIDER }` fallback,
  // which that same test file checks for family 'watson'. Both assertions live in that one test
  // file; neither depends on anything outside it.
  restaurant: { provider: 'deepseek' },
  // community (M11, LM.03) was not in that run either; it takes DeepSeek explicitly, model named,
  // so this table stays the one place every family's fill provider and model are both named.
  community: { provider: 'deepseek', model: 'deepseek-flash' },
};

/**
 * The fill provider (and, for a bake-off winner, its model) a request should get for `family`
 * when it names no provider of its own — `DEFAULT_MODEL_BY_FAMILY`'s entry, or `DEFAULT_PROVIDER`
 * with no model override for every family that table does not mention.
 */
function defaultModelFor(family: string): { provider: ProviderName; model?: string } {
  return DEFAULT_MODEL_BY_FAMILY[family] ?? { provider: DEFAULT_PROVIDER };
}

/** The fast lane's own family id rule (`loadFamilyPackage`), checked before anything is loaded. */
const FAMILY_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Where one family's package lives, under the daemon's bundled-plugins root.
 *
 * The atlas and the registry reach a packaged daemon as an inlined module; the family packages
 * cannot, and must not try. `loadFamilyPackage` imports each family's compiler through
 * `pathToFileURL` — a dynamic path esbuild cannot follow — and reads the recipe, the schema and
 * the approved asset bytes from disk. They are runtime FILES, shipped by `tools/pack`'s
 * `BUNDLED_RESOURCE_TREES` into `<resourceRoot>/plugins/_official` and found again through the
 * daemon's `BUNDLED_PLUGINS_DIR`, which resolves to the workspace tree in a dev run.
 *
 * The fast lane's own `defaultPackageDir` must NOT be used here: it builds its path from
 * `import.meta.dirname`, which inside the prebundle is the bundle's own directory, so a packaged
 * daemon would answer 202 and then fail every build at `prepare` time. Proved both ways in
 * `tools/pack/tests/prebundle/fast-lane-data.test.ts`.
 */
export function familyPackageDir(bundledPluginsRoot: string, family: string): string {
  return path.join(bundledPluginsRoot, 'examples', `agency-${family}`);
}

const MODES = ['single', 'sections'] as const;
const VERIFY_MODES = ['strict', 'advisory', 'after', 'off'] as const;
const PROVIDER_NAMES = ['deepseek', 'cerebras'] as const satisfies readonly ProviderName[];
/** `AgencyBuildRequest.model`'s own limit: long enough for any real provider model id, short
 * enough that a client cannot use it to smuggle an unbounded string into a build record. */
const MODEL_MAX_CHARS = 120;

/**
 * Adds `next` (a repair's providers) onto `current` (the build's), keeping first-use order: a
 * provider/model already listed gains the new sections, a new one is appended.
 */
function mergeProviderUses(current: AgencyBuildProviderUse[] | undefined, next: AgencyBuildProviderUse[]): AgencyBuildProviderUse[] {
  const merged = (current ?? []).map((use) => ({ ...use, ...(use.sections ? { sections: [...use.sections] } : {}) }));
  for (const use of next) {
    const existing = merged.find((candidate) => candidate.provider === use.provider && candidate.model === use.model);
    if (!existing) {
      merged.push({ ...use, ...(use.sections ? { sections: [...use.sections] } : {}) });
      continue;
    }
    for (const section of use.sections ?? []) {
      existing.sections ??= [];
      if (!existing.sections.includes(section)) existing.sections.push(section);
    }
  }
  return merged;
}

/**
 * `BUILD_FAILED`'s message: a classifier over the error's TYPE, never a copy of its free text.
 *
 * The first version of this read the caught error's first line, on the theory that a build's own
 * stderr is not captured by the runtime log and that line was the only place the cause could
 * surface. That was unsafe in general, not only for an HTTP response body: a model-refusal error
 * can just as easily carry the brief and the model's own generated text in `.message`, and a build
 * failure snapshot must never echo either (`docs/plans/2026-09-22-generative-ui-design.md`'s
 * no-echo rule, and this module's own docblock above). So nothing here ever reads `.message` — a
 * known error class maps to a fixed sentence built only from its own STRUCTURED fields (a status
 * code, a route, a provider name, a slot path — never a string the model or a brief wrote), and
 * anything else, known or not, gets the same plain sentence it always could have carried safely.
 * `console.error` alongside every call site still keeps the full error for the daemon's own log.
 */
function buildFailureMessage(error: unknown): string {
  // Both providers failed. The one exception to "never read `.message`": `ProviderFailoverError`'s
  // constructor builds it from its structured `attempts` only (provider names, status codes, fixed
  // phrases), never from a response body or model text, so it is safe to copy as-is.
  if (error instanceof ProviderFailoverError) {
    return `the build failed (ProviderFailoverError): ${error.message}`;
  }
  if (error instanceof ProviderHttpError) return `the build failed: ${error.provider} answered ${error.status}`;
  if (error instanceof DaemonHttpError) return `the build failed: the daemon answered ${error.status} on ${error.route}`;
  // The final page did not fit the page budget with no effect on it: a fixed code and two counts.
  if (error instanceof PageTooLargeError) return `the build failed (${error.code}): the page is ${error.bytes} bytes, at or over the ${error.limit}-byte limit`;
  if (error instanceof ComposedPageTooLargeError) return `the build failed (${error.code}): the composed page is ${error.bytes} bytes with one body block left, at or over the ${error.limit}-byte limit`;
  // `reason` is `checkBlockPlan`'s sentence: catalog ids, spine codes and fixed phrases only.
  if (error instanceof BlockPlanReplayError) return `the build failed (${error.code}): ${error.reason}`;
  if (error instanceof CompositionVerifyError) return `the build failed (${error.code}): a composed page needs verify "strict"`;
  return 'the build failed';
}

/**
 * The diagnostic half of a `BUILD_FAILED` record: the phase it stopped in and, when the fast lane
 * ran out of repairs on a unit, that unit, its reason code, the slot path and the last validation
 * error. Built only from `UnitRefusedError`'s structured fields (whose `slot`/`rule` the fast lane
 * already allowlisted), never from `.message` — the same rule as `buildFailureMessage`.
 */
export function buildFailureDetail(error: unknown, step: AgencyBuildFailure['step']): AgencyBuildFailure {
  // A model call cut off by the build deadline or its own time limit: the unit, and a fixed
  // sentence built from the error's structured fields only.
  if (error instanceof UnitDeadlineError) {
    return { step, unit: error.unit, reason: 'deadline', lastError: `${error.unit}: the model did not answer within the ${error.scope === 'call' ? 'per-call time limit' : 'build deadline'}` };
  }
  if (!(error instanceof UnitRefusedError)) {
    // A provider or transport failure the fast lane let through: still name the unit whose call
    // failed when it recorded one (`failedUnitOf`), never the error's own message.
    const unit = failedUnitOf(error);
    return unit === undefined ? { step } : { step, unit, reason: 'transport', lastError: `${unit}: the model provider failed` };
  }
  const reason = repairReason(error.reason);
  const at = error.slot !== undefined ? ` at ${error.slot}` : '';
  const rule = error.rule !== undefined ? ` (${error.rule})` : '';
  return {
    step,
    unit: error.unit,
    reason,
    ...(error.slot !== undefined ? { slot: error.slot } : {}),
    lastError: `${error.unit}: ${REPAIR_REASON_TEXT[reason]}${at}${rule}`,
  };
}

/**
 * Turns a build's furthest CONFIRMED phase into a failure step.
 *
 * `lastPhase` (`BuildJob.lastPhase`) is never the daemon-internal `job.snapshot.status`: that
 * field is advanced to `'routing'` the moment the background run starts, before the fast lane has
 * emitted anything, so reading it here would label a build that failed before its first phase
 * event as `'routing'` — a phase it never actually reached. `lastPhase` instead starts at
 * `'queued'` and only ever moves via `record()`'s own `advance(job.lastPhase, phaseOf(event))`,
 * so it always names the last phase an ACTUAL `BuildEvent` proved, never one assumed ahead of it.
 * Chose a dedicated `'queued'` step over folding early failures into `'routing'`: `'queued'` was
 * already part of `AgencyBuildFailure['step']` and `PHASE_ORDER`, so nothing but this function's
 * own fallback needed to change, and "queued" is the honest answer for "nothing has happened yet"
 * rather than a phase name the build never entered.
 *
 * `lastPhase` can only ever hold a `PHASE_ORDER` member (its only writes are `'queued'` at job
 * creation and `advance()`, which never leaves that set), so the `else` branch is unreachable in
 * practice. It reads `'queued'`, not `'publishing'`, so a value from outside that closed set is
 * never read as "got all the way to publishing" — the one thing a pre-publish failure must never
 * say.
 */
function failureStep(lastPhase: AgencyBuildStatus): AgencyBuildFailure['step'] {
  return PHASE_ORDER.includes(lastPhase) ? lastPhase as AgencyBuildFailure['step'] : 'queued';
}

/**
 * The headers a self-call has to carry for the daemon to answer it as the person who asked.
 *
 * `POST /api/projects` and the file routes decide what a request may touch from the workspace
 * identity pair and the authorization header; a build that dropped them would publish into
 * whatever ambient scope the daemon falls back to, which is not the scope that pressed the button.
 * This is the same pair `mcp-workspace-context.ts` and `od collab …` send.
 */
const SCOPE_HEADERS = ['authorization', 'x-od-workspace-id', 'x-od-workspace-member-id'] as const;

/** How far along a status is, so a build's phase only ever moves forwards. */
const PHASE_ORDER: AgencyBuildStatus[] = ['queued', 'routing', 'building', 'verifying', 'publishing'];

type Body = Record<string, unknown>;

/** A section id as family recipes write them; see each family contract's `ID`. */
const SECTION_ID = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * `designReferenceId`'s two recognized prefixes (`design-reference.ts`'s own
 * `ZEROSUM_KIT_ID_PREFIX`/`MOTIONSITES_PROMPT_ID_PREFIX`, mirrored here rather than imported so
 * this route's own request-shape validation has no dependency on that module's internals) — a
 * value with neither prefix can never resolve, so it is refused here rather than reaching
 * `fetchMotionSitesDesignReference` only to fail with an internal-error-shaped message (delta
 * audit round 1 finding 10). `\S+` rather than `.+` after the prefix (round 2 finding 2): a
 * catalog id is never whitespace, so `"motionsites-prompt: "` (a colon and a trailing space, no
 * real id) must not pass as a well-formed-looking value that only fails downstream.
 */
const DESIGN_REFERENCE_ID_PATTERN = /^(motionsites-prompt|zerosum-kit):\S+$/;
/** A generous but real bound: `designReferenceId` is a short catalog id, never a document. */
const DESIGN_REFERENCE_ID_MAX_CHARS = 200;
/**
 * `designReferenceText`'s bound (delta audit finding 9): the same class of cap as the brief
 * (`AGENCY_ROUTE_MAX_CHARS`) — it flows into the same section fill prompt, so an unbounded value
 * is exactly as much of a cost/abuse surface as an unbounded brief would be.
 */
const DESIGN_REFERENCE_TEXT_MAX_CHARS = AGENCY_ROUTE_MAX_CHARS;

/** Shape + bound checks shared by the fresh-build and fork routes for `designReferenceId`/
 * `designReferenceText` — never existence (that is `resolveDesignReferenceText`'s own fetch). */
function validateDesignReferenceShape(id: unknown, text: unknown): { error: string } | undefined {
  if (id !== undefined) {
    if (typeof id !== 'string') return { error: 'designReferenceId must be a string' };
    if (id.length > DESIGN_REFERENCE_ID_MAX_CHARS) {
      return { error: `designReferenceId must be at most ${DESIGN_REFERENCE_ID_MAX_CHARS} characters` };
    }
    if (!DESIGN_REFERENCE_ID_PATTERN.test(id)) {
      return { error: 'designReferenceId must start with "motionsites-prompt:" or "zerosum-kit:"' };
    }
  }
  if (text !== undefined) {
    if (typeof text !== 'string') return { error: 'designReferenceText must be a string' };
    if (text.length > DESIGN_REFERENCE_TEXT_MAX_CHARS) {
      return { error: `designReferenceText must be at most ${DESIGN_REFERENCE_TEXT_MAX_CHARS} characters` };
    }
  }
  return undefined;
}

/**
 * Validates a request's `sections` hints: a plain object of at most
 * `AGENCY_BUILD_MAX_SECTION_HINTS` section ids, each `keep` or `drop`. Whether an id is optional
 * is only known once the family is, so that is `buildSite`'s check (an unknown id is ignored with
 * a warning there), not this one. Returns the error sentence, or the hints.
 */
/** `AgencyBuildRequest.composition`: absent, or one of the three modes. */
/** `designSystemId`: absent, or a non-empty kit id of bounded length (resolved later). */
function parseDesignSystemId(value: unknown): { value?: string } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > DESIGN_SYSTEM_ID_MAX_CHARS) {
    return { error: `designSystemId must be a non-empty string of at most ${DESIGN_SYSTEM_ID_MAX_CHARS} characters` };
  }
  return { value: value.trim() };
}

function parseComposition(value: unknown): { value?: AgencyBuildComposition } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || !(COMPOSITION_MODES as readonly string[]).includes(value)) {
    return { error: `composition must be one of ${COMPOSITION_MODES.join(', ')}` };
  }
  return { value: value as AgencyBuildComposition };
}

/**
 * A composed page publishes only after a passing strict Jev check (Sol review 2026-09-25, finding
 * 2): `composition: 'blocks' | 'auto'` takes `verify: 'strict'` (the default) and nothing else.
 * Rejected rather than coerced, so a caller that asked for `after` or `off` learns it did not get
 * it. `undefined` when the pair is allowed.
 */
export function compositionVerifyError(composition: AgencyBuildComposition | undefined, verify: string): string | undefined {
  if (composition === undefined || composition === 'family' || verify === 'strict') return undefined;
  return `composition "${composition}" publishes only after a strict Jev check: verify must be "strict" (or omitted), not "${verify}"`;
}

function parseSectionHints(value: unknown): { hints?: Record<string, 'keep' | 'drop'> } | { error: string } {
  const parsed = parseHintValues(value, false);
  return parsed as { hints?: Record<string, 'keep' | 'drop'> } | { error: string };
}

/** A fork's `sections`: like `parseSectionHints`, plus `auto` (clear the saved hint for that id). */
function parseForkSectionHints(value: unknown): { hints?: Record<string, 'keep' | 'drop' | 'auto'> } | { error: string } {
  return parseHintValues(value, true);
}

function parseHintValues(value: unknown, allowAuto: boolean): { hints?: Record<string, 'keep' | 'drop' | 'auto'> } | { error: string } {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'sections must be an object of section id to keep or drop' };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > AGENCY_BUILD_MAX_SECTION_HINTS) return { error: `sections may name at most ${AGENCY_BUILD_MAX_SECTION_HINTS} section ids` };
  const hints: Record<string, 'keep' | 'drop' | 'auto'> = {};
  for (const [id, hint] of entries) {
    if (!SECTION_ID.test(id)) return { error: 'sections keys must be lowercase section ids' };
    if (hint !== 'keep' && hint !== 'drop' && !(allowAuto && hint === 'auto')) {
      return { error: allowAuto ? "sections values must be 'keep', 'drop' or 'auto'" : "sections values must be 'keep' or 'drop'" };
    }
    hints[id] = hint;
  }
  return entries.length > 0 ? { hints } : {};
}

// ---- sectionSelection / designReference validation (sol-design.md §2) ----------------------

/** Shape-checks `AgencyBuildRequest.sectionSelection` (via the shared `parseSectionSelectionShape`,
 * `agency-build-section-selection.ts` — also used by `agency-build-store.ts` to validate a
 * persisted fork seed) and then resolves its `entryId`/`directionId` against the fast lane's own
 * closed v1 roster (`resolveSectionAdapter`/`resolveDesignDirection`,
 * `@mish/agency-fast-lane/section-overlay`) — the same check `runFastLane` itself makes,
 * run here first so an unknown entry or direction is a 400 before any build starts, rather than a
 * mid-build failure. The placement's anchor (whether the resolved family actually declares the
 * named section id) is NOT checked here — the family may still be `auto` at this point, and
 * `runFastLane`'s own fail-fast check (`resolveAnchorOffset`, before any fill effort) is what
 * refuses an absent or ambiguous anchor once the family is known; that refusal surfaces as this
 * build's ordinary `BUILD_FAILED` outcome, the same as any other `SectionSelectionRefusedError`. */
async function parseSectionSelection(value: unknown): Promise<{ ok: true; value?: SectionSelection } | { ok: false; error: string }> {
  if (value === undefined) return { ok: true };
  const shape = parseSectionSelectionShape(value);
  if (!shape) return { ok: false, error: 'sectionSelection must be { entryId, placement: { mode, afterSectionId | targetSectionId }, directionId }' };
  // A Cult entry may arrive by the public id `od sections` prints (`cult:<slug>`); the build and
  // everything it stores use the internal id.
  const selection = { ...shape, entryId: cultInternalId(shape.entryId) };
  try {
    await resolveSectionAdapter(selection.entryId);
    await resolveDesignDirection(selection.directionId);
  } catch (error) {
    // The refusal names the entry it was given, the internal id; say it with the public one.
    const shown = cultPublicId(selection.entryId) ?? shape.entryId;
    if (error instanceof SectionSelectionRefusedError) return { ok: false, error: error.message.split(selection.entryId).join(shown) };
    throw error;
  }
  return { ok: true, value: selection };
}

// ---- effects validation (Sol ruling 2026-09-25, catalog-port/sol-wiring-ruling.md) ------------

/**
 * The daemon-side result of a build's effect plan, as the snapshot carries it: the fast lane's
 * `RunReport.effects` re-checked field by field (`parseAgencyEffectsResult`) so only ids, counts and
 * the fixed skip codes cross — a field added upstream is simply not copied, and a code outside the
 * closed sets drops the whole result rather than reaching a client as free text.
 */
function toEffectsDto(value: unknown): AgencyEffectsResult | undefined {
  return value === undefined ? undefined : parseAgencyEffectsResult(value);
}

/**
 * What a repair asks for: the effects the build actually applied, replayed as explicit ids, with
 * `none` on every other placement — so the repair re-renders the same components and never asks
 * Jev again (an unlisted placement would otherwise stay `auto`). `off` when the build applied
 * nothing, or its result is not on the snapshot (effects off, or a record older than effects).
 */
export function repairEffectsOf(result: AgencyEffectsResult | undefined): AgencyEffectsInput {
  if (!result || result.applied.length === 0) return 'off';
  const replay: Record<string, string> = {};
  for (const placement of AGENCY_EFFECT_PLACEMENT_IDS) replay[placement] = 'none';
  for (const entry of result.applied) replay[entry.placement] = entry.componentId;
  return replay;
}

/** `{ effects }` for a snapshot patch when the report carried a well-formed result, else `{}`. */
function effectsPatch(value: unknown): { effects?: AgencyEffectsResult } {
  const effects = toEffectsDto(value);
  return effects ? { effects } : {};
}

/**
 * Validates a request's `effects` (`AgencyBuildRequest.effects`, a fork's non-null override) —
 * the sibling of `parseSectionHints`. Answers the 400 sentence, or the value to build with
 * (`undefined` = omitted, so the build's own default applies: `auto` for a site family, `off` for
 * an app or dashboard page kind — `buildSite`'s call).
 *
 * Shape, the closed placement vocabulary and `AGENCY_BUILD_MAX_EFFECT_HINTS` are checked for every
 * family (`parseAgencyEffectsInput`). When `family` is NAMED, a record's ids are also checked
 * against that family's own allowlist (`offerOf`), so an id the family does not allow at a
 * placement is a 400 before any build starts. For `family: 'auto'` that check cannot run yet — the
 * family is only known after routing — and `buildSite` re-checks every hint against the routed
 * family's declaration, skipping a disallowed one as `not-allowed` rather than failing the build.
 * `offerOf` answers `undefined` for a family this daemon does not bundle; a load failure throws
 * and becomes the caller's 500.
 */
async function parseEffects(
  value: unknown,
  family: string,
  offerOf: (family: string) => Promise<AgencyFamilyEffectsResponse | undefined>,
): Promise<{ ok: true; value?: AgencyEffectsInput } | { ok: false; error: string }> {
  const parsed = parseAgencyEffectsInput(value);
  if (!parsed.ok) return parsed;
  const effects = parsed.value;
  if (effects === undefined) return { ok: true };
  if (typeof effects === 'string' || family === 'auto') return { ok: true, value: effects };
  const offer = await offerOf(family);
  if (!offer) return { ok: false, error: 'effects name components, but no bundled family has this id' };
  const refusal = agencyEffectHintsRefusal(effects, offer);
  return refusal ? { ok: false, error: refusal } : { ok: true, value: effects };
}

/** The two structured MotionSites access failures (`design-reference.ts`), mapped to this route's
 * `ApiErrorCode`/status — never a bare upstream 401/403, and never the prompt text itself (both
 * error classes carry only a fixed sentence and, for the paid-access case, a promptId and the
 * public upgrade URL). 401: the daemon holds no usable MotionSites connection at all — the same
 * meaning `GET /api/motionsites/connection`'s `not_connected`/`expired` states carry. 403: the
 * connection is good but this specific prompt is refused (a premium prompt on a free account, or
 * the free-tier allowance exhausted) — the caller IS "signed in", just not entitled to this one. */
function designReferenceFailure(error: unknown): { status: number; code: ApiErrorCode; message: string } | undefined {
  if (error instanceof MotionSitesLoginRequiredError) return { status: 401, code: 'MOTIONSITES_LOGIN_REQUIRED', message: error.message };
  if (error instanceof MotionSitesPaidAccessRequiredError) return { status: 403, code: 'MOTIONSITES_PAID_ACCESS_REQUIRED', message: error.message };
  if (error instanceof MotionSitesUpstreamError) return { status: 502, code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE', message: error.message };
  return undefined;
}

/**
 * Resolves a request's design reference — `designReferenceId` (fetched fresh, in memory only) or
 * caller-supplied `designReferenceText` — mutually exclusive, and only meaningful alongside a
 * `sectionSelection` (checked by the caller). Returns the text directly: nothing here writes it
 * anywhere, and neither does any caller of this function (the fetched/supplied string flows
 * straight into `startBuild`'s `designReference` input, which `buildSite`/`runFastLane` thread to
 * the section fill prompt only — see `RunOptions.designReference`'s own doc for the boundary).
 */
async function resolveDesignReferenceText(
  dataDirForFetch: string,
  designReferenceId: string | undefined,
  designReferenceText: string | undefined,
): Promise<{ ok: true; value?: string } | { ok: false; status: number; code: ApiErrorCode; message: string }> {
  if (designReferenceId !== undefined && designReferenceText !== undefined) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'designReferenceId and designReferenceText are mutually exclusive' };
  }
  if (designReferenceText !== undefined) return { ok: true, value: designReferenceText };
  if (designReferenceId === undefined) return { ok: true };
  try {
    const reference = await fetchMotionSitesDesignReference(dataDirForFetch, designReferenceId);
    return { ok: true, value: reference.text };
  } catch (error) {
    const mapped = designReferenceFailure(error);
    if (mapped) return { ok: false, ...mapped };
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) };
  }
}

/** One build, and everything watching it. */
interface BuildJob {
  snapshot: AgencyBuildSnapshot;
  controller: AbortController;
  /** Notified for every event and once more when the build ends. Empty when nobody is watching. */
  listeners: Set<(event: AgencyBuildEvent | null) => void>;
  done: boolean;
  /** What `/fork` needs to start a new build from this one. Set at creation for a build this
   * process started; carried over from disk for one hydrated at startup. Missing only for a
   * persisted record written before this field existed — `canFork` treats that the same as any
   * other build `/fork` may not use. Never part of `AgencyBuildSnapshot`: see `agency-build-store.ts`. */
  forkSeed?: AgencyBuildForkSeed;
  /**
   * True when the request that started this build named no `provider` AND `family` was `'auto'`
   * — `forkSeed.provider`/`.model` above were then set to the daemon default at job creation,
   * before the family (and so its own default) was known. `settle`'s `built` case uses this to
   * replace them with `defaultModelFor(result.family)` once the routed family is known, so a
   * later `/fork` or `/repair` on this build replays the provider it actually ran with rather
   * than a placeholder it never used. Never set for a build hydrated from disk — a restart loses
   * the distinction the same way it loses `recipe`, and `forkSeed`'s existing default stands. */
  providerDeferred?: boolean;
  /**
   * The recipe this build last published, in memory only — never part of `AgencyBuildSnapshot`
   * (a recipe carries brief-sourced business text, same rule as `forkSeed.brief`). Set once the
   * build reaches `built`; `POST .../:id/repair` reads it to know what to re-fill and re-publish,
   * and overwrites it with the repair's own recipe on success. Lost on a restart like every other
   * live-only field here — a `verify: 'after'` build repaired across a restart would need the
   * recipe fetched back from the published project instead; not built, since nothing in this
   * play needs it yet.
   */
  recipe?: unknown;
  /**
   * Set synchronously, before any `await`, for the duration of one `POST .../:id/repair` call on
   * this job, and cleared in a `finally` once that call answers. Two near-simultaneous repair
   * requests would otherwise both read the same `job.snapshot.verify`/`job.recipe` and pass the
   * precondition together — the second then republishes from the pre-first-repair recipe once it
   * finishes, silently reverting whatever the first one just fixed. The flag closes that window: a
   * second call sees it set (synchronously, so there is no `await` between the check and the set a
   * concurrent request could land inside) and answers `BUILD_REPAIR_IN_PROGRESS` instead of racing.
   */
  repairing?: boolean;
  /** The slot paths the latest `verify` event left flagged, live only. A strict build that fails
   * its gate records them as `failure.flaggedSlots` (the report's own list wins when present). */
  lastRemaining?: string[];
  /**
   * The furthest phase a real `BuildEvent` has proven for this build — `'queued'` until the first
   * one arrives, then only ever moved forward by `record()`'s own `advance(job.lastPhase,
   * phaseOf(event))`. Deliberately separate from `snapshot.status`, which `startBuild` advances to
   * `'routing'` synchronously before the run starts (so a client polling mid-build sees progress
   * rather than a stuck `'queued'`) — that head start is fine for display but wrong for a failure
   * record, which must name only a phase the build actually reached. `failureStep` reads this
   * field, never `snapshot.status`.
   */
  lastPhase: AgencyBuildStatus;
}

function isTerminal(status: AgencyBuildStatus): boolean {
  return !PHASE_ORDER.includes(status);
}

/**
 * Whether a saved build is something `POST .../:id/fork` may start from: it has to have finished
 * and published a project. A cancelled build — rolled back or not — a failed one, or an unrouted
 * one proved nothing about the brief, so forking it would just repeat the same unproven bet rather
 * than start from a working one.
 */
function canFork(snapshot: AgencyBuildSnapshot): boolean {
  return snapshot.status === 'done' && typeof snapshot.projectId === 'string';
}

/**
 * Why `POST .../:id/repair` would refuse `job` as `BUILD_NOT_REPAIRABLE`, one sentence naming the
 * specific cause — or `undefined` when the job is repairable right now. Checked fresh on every
 * call (never cached), and every cause is a distinct, mutually exclusive state, so a caller reading
 * the message can tell "try again shortly" (still `pending`) from "nothing to do here" (no flags)
 * from "this daemon lost its own working state" (recipe gone after a restart) apart.
 */
function repairNotReadyReason(job: BuildJob): string | undefined {
  const verdict = job.snapshot.verify;
  if (!verdict) return 'this build was not started with verify: "after", so it has no deferred verdict to repair';
  if (verdict.status === 'pending') return 'the deferred faithfulness check has not finished yet';
  if (verdict.status === 'skipped') return 'the deferred faithfulness check was skipped and never actually ran, so nothing is known to be flagged';
  if (verdict.flagged.length === 0) return 'the deferred check found nothing flagged; there is nothing to repair';
  if (!job.snapshot.family || !job.snapshot.projectId) return 'this build never published a project to repair';
  // Both `recipe` and `forkSeed` are live-only, in-memory fields (never persisted — see
  // `BuildJob.recipe`), so either can be missing for a build this daemon remembers from disk but
  // did not itself run: a restart since the build finished, or a record hydrated from an older
  // schema written before `forkSeed` existed.
  if (job.recipe === undefined) return 'the recipe this build published is no longer held in memory — most likely a daemon restart since it ran';
  if (!job.forkSeed) return 'this build has no remembered brief to re-fill from';
  return undefined;
}

/**
 * The phase an event proves the build has reached, or `undefined` when it proves nothing.
 *
 * `project` is the one event whose meaning depends on when it arrives. A strict build defers
 * creating its project until the gate passes, so its `project` event IS the publish starting; an
 * advisory build creates the project before the first model call, where it means nothing of the
 * sort. Taking the maximum phase rather than the latest one settles it: an early `project` cannot
 * pull the build forward past `routing`, because `publishing` only wins once nothing later can
 * lower it — and by the time a build is building, `project` is publishing.
 */
function phaseOf(event: BuildEvent): AgencyBuildStatus | undefined {
  switch (event.type) {
    case 'route': return 'building';
    case 'lock-wait': return undefined;
    case 'verify': return 'verifying';
    case 'project':
    case 'assets':
    case 'registered':
    case 'preview': return 'publishing';
    default: return 'building';
  }
}

/** The later of two running phases. A terminal status is never overwritten. */
function advance(current: AgencyBuildStatus, next: AgencyBuildStatus | undefined): AgencyBuildStatus {
  if (next === undefined || isTerminal(current)) return current;
  return PHASE_ORDER.indexOf(next) > PHASE_ORDER.indexOf(current) ? next : current;
}

/**
 * The public DTO for one of the fast lane's events.
 *
 * Written as an exhaustive switch rather than a spread of the source event, so a field added to
 * `BuildEvent` upstream cannot arrive here unread: a new member fails the `never` check below, and
 * a new field on an existing member is simply not copied. `repair.reason` and `verify.skipped` are
 * fixed codes; `clipped.paths` is deliberately dropped, because a slot path is a detail of what
 * the model overran and the event's label already says which unit it was. `hours-normalized` is
 * the deliberate exception: its whole point is showing exactly which slot an owner-ruled content
 * normalization touched and how, so `path`/`before`/`after` travel through unchanged.
 */
function toEventDto(event: BuildEvent, seq: number, at: string): AgencyBuildEvent {
  const base = { seq, at, type: event.type } as const;
  switch (event.type) {
    case 'route':
      return {
        ...base,
        ms: event.decision.ms,
        decision: event.decision.decision,
        ...(event.decision.family ? { family: event.decision.family.id } : {}),
      };
    case 'project':
      return { ...base, projectId: event.projectId, created: event.created };
    case 'lock-wait':
      return { ...base, label: event.provider };
    case 'sections':
      // Ids only. `skipped` (a sanitised message) becomes the fixed code, and `warnings` stay
      // server-side: they name hint ids the request sent, which the client already knows.
      return {
        ...base,
        ms: event.ms,
        keptSections: event.kept,
        droppedSections: event.dropped,
        sectionSource: event.source,
        ...(event.skipped !== undefined ? { reason: 'jev-unavailable' as const } : {}),
      };
    case 'render-quality':
      return { ...base, renderQuality: toRenderQualityDto(event.report) };
    case 'effects':
      // Counts only, as the fixed label the contract names; the applied/skipped ids travel on the
      // snapshot's `effects` once the build settles. Never a Jev answer or its criteria.
      return { ...base, ms: event.ms, label: `${event.applied} applied, ${event.skipped} skipped` };
    case 'assets':
      return { ...base, ms: event.ms, count: event.count };
    case 'first-token':
      return { ...base, ms: event.ms };
    case 'unit':
      return { ...base, label: event.label, ms: event.ms, repairs: event.repairs };
    case 'merged':
      return { ...base, label: event.label, ms: event.ms };
    case 'paint':
      return { ...base, label: event.label, ms: event.ms, count: event.count };
    case 'repair':
      return { ...base, label: event.label, reason: repairReason(event.reason) };
    case 'clipped':
      return { ...base, label: event.label };
    case 'verify':
      return {
        ...base,
        ms: event.ms,
        counts: { checked: event.checked, illustrative: event.illustrative, flagged: event.flagged, repaired: event.repaired, remaining: event.remaining },
        ...(event.skipped ? { reason: event.skipped } : {}),
      };
    case 'registered':
      return { ...base, ms: event.ms };
    case 'preview':
      return { ...base, ms: event.ms, url: event.url };
    case 'failover':
      return { ...base, label: event.to, reason: event.reason };
    case 'composition':
      return { ...base, ms: event.ms, composition: toCompositionDto(event.result) };
    case 'transport-retry':
      return { ...base, label: event.label, attempt: event.attempt, reason: event.reason };
    case 'hours-normalized':
      return { ...base, label: event.label, path: event.path, before: event.before, after: event.after };
    case 'repair-discarded':
      return { ...base, label: event.label, reason: repairReason(event.reason) };
    default: {
      // No cast and no synthetic frame: a member added to `BuildEvent` upstream must be a compile
      // error here, so somebody decides what a client may see of it. At runtime this cannot be
      // reached, and a `throw` is caught by the build's own failure path rather than escaping.
      const unreachable: never = event;
      void unreachable;
      // The message is fixed and carries no part of the event: it ends up in the build's failure
      // path and in this daemon's log, and an event nothing here maps is exactly the one whose
      // payload nobody has checked for generated text.
      throw new Error('unmapped build event');
    }
  }
}

/**
 * A repair's reason, re-checked against the closed public set before it is copied.
 *
 * `RepairReason` is the fast lane's own union and the two are kept in step by hand, so a code
 * added there and not here must not reach a client as an unknown string — a client's switch would
 * fall through it silently, and this DTO's whole rule is that only named values cross. An
 * unrecognised code becomes `invalid`, the most conservative of the four: something was wrong with
 * the unit and it was asked for again.
 */
const REPAIR_REASONS: AgencyBuildRepairReason[] = ['invalid', 'incomplete', 'malformed', 'unfaithful'];

function repairReason(reason: string): AgencyBuildRepairReason {
  return REPAIR_REASONS.includes(reason as AgencyBuildRepairReason) ? reason as AgencyBuildRepairReason : 'invalid';
}

const RENDER_QUALITY_CHECKS: AgencyRenderQualityCheck[] = ['page-heading', 'unique-ids', 'form-labels', 'link-destinations'];

/** Copy fixed codes and counts only. Generated IDs, reasons and other text stay server-side. */
function toRenderQualityDto(value: unknown): AgencyBuildRenderQuality {
  const invalid = () => { throw new Error('invalid render quality report'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (typeof raw.passed !== 'boolean' || (raw.scope !== 'site' && raw.scope !== 'static-prototype') || !Array.isArray(raw.checks) || !Array.isArray(raw.issues)) return invalid();
  const checks = raw.checks;
  if (checks.some((check) => !RENDER_QUALITY_CHECKS.includes(check as AgencyRenderQualityCheck)) || new Set(checks).size !== checks.length) return invalid();
  const counts = new Map<AgencyRenderQualityCheck, number>();
  for (const issue of raw.issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return invalid();
    const check = (issue as Record<string, unknown>).check;
    if (!RENDER_QUALITY_CHECKS.includes(check as AgencyRenderQualityCheck) || !checks.includes(check)) return invalid();
    const known = check as AgencyRenderQualityCheck;
    counts.set(known, (counts.get(known) ?? 0) + 1);
  }
  if (raw.passed !== (raw.issues.length === 0)) return invalid();
  return { passed: raw.passed, scope: raw.scope, checks: [...checks] as AgencyRenderQualityCheck[], issueCounts: [...counts].map(([check, count]) => ({ check, count })) };
}

/** The run's numbers. `missing` and `nulled` become counts: the fast lane reports them as slot
 * path lists, and a path label is a detail of the recipe this endpoint does not publish. */
function toSummary(report: Extract<BuildResult, { outcome: 'built' }>['report']): AgencyBuildSummary {
  return {
    timings: report.timings,
    calls: report.calls,
    repairs: report.repairs,
    retries: report.retries,
    paints: report.paints,
    applied: report.applied,
    missing: report.missing.length,
    nulled: report.nulled.length,
    usage: { input: report.usage.input, output: report.usage.output, cachedRead: report.usage.cachedRead },
  };
}

function toRouteDto(decision: {
  decision: 'routed' | 'unrouted';
  family?: { id: string; probability: number; viaSpine?: string };
  spine: { code: string };
  pageKind?: { choice: PageKind | 'none'; confidence: number };
  routeAttempts?: number;
}): AgencyBuildRouteDecision {
  return {
    decision: decision.decision,
    spine: decision.spine.code,
    ...(decision.family ? { family: decision.family.id, probability: decision.family.probability } : {}),
    ...(decision.family?.viaSpine !== undefined ? { viaSpine: decision.family.viaSpine } : {}),
    ...(decision.pageKind && decision.pageKind.choice !== 'none' ? { pageKind: decision.pageKind.choice } : {}),
    ...(decision.routeAttempts !== undefined ? { routeAttempts: decision.routeAttempts } : {}),
  };
}

/**
 * What an AG-UI build stream reports about the build's input. Built from `forkSeed` without the
 * brief — `briefChars` is its only trace, per the module docblock's no-brief rule. The provider is
 * `null` while `providerDeferred` says the seed still holds a placeholder; a build hydrated from a
 * record without a seed reports what its snapshot knows.
 */
/**
 * The `seq` a reconnecting client already has, from its `Last-Event-ID`: the id of the last event
 * it received, so a resume sends only `seq > from`. Only a complete, safe, positive decimal integer
 * counts — `parseInt` would read `2junk` as 2 and silently skip events 1 and 2. Anything else
 * (absent, malformed, zero, too large) replays from the start: resending is safe, skipping is not.
 */
export function lastEventIdOf(header: string | undefined): number {
  if (typeof header !== 'string' || !/^[0-9]+$/.test(header.trim())) return 0;
  const value = Number(header.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function aguiMeta(job: BuildJob): AgencyBuildAguiMeta {
  const seed = job.forkSeed;
  // `settle` replaces the placeholder only when the build ends `done`; until then, and on any
  // other outcome, the seed's provider is a guess this stream does not repeat.
  const deferred = job.providerDeferred === true && job.snapshot.status !== 'done';
  return {
    buildId: job.snapshot.id,
    startedAt: job.snapshot.startedAt,
    outputScope: job.snapshot.outputScope ?? null,
    input: {
      family: seed?.family ?? job.snapshot.family ?? 'auto',
      mode: seed?.mode ?? 'sections',
      verify: seed?.verify ?? 'strict',
      provider: seed && !deferred ? seed.provider : null,
      model: seed && !deferred ? seed.model ?? null : null,
      briefChars: seed?.brief.length ?? 0,
      ...(seed?.composition && seed.composition !== 'family' ? { composition: seed.composition } : {}),
    },
  };
}

export function registerAgencyBuildRoutes(app: Express, ctx: RegisterAgencyBuildRoutesDeps) {
  const { isLocalSameOrigin, resolvedPortRef, sendApiError, createSseResponse } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;
  const { atlas, registry, jevKeyStore, daemonUrlRef, runBuild, buildDeps, loadPackage, effectCatalog, buildsFile } = ctx.agencyBuild;
  const loadBlockCatalog = ctx.agencyBuild.loadBlockCatalog ?? defaultBlockCatalog;
  const designKits = ctx.agencyBuild.designKits;

  const store = createAgencyBuildStore(buildsFile);

  /** C16: a family's output scope, from the registry this daemon routes against — the fast lane's
   * `outputScopeOf`, the one place the label is derived. `undefined` for a family it does not list. */
  const scopeOf = (family: string | undefined): AgencyOutputScope | undefined =>
    family === undefined || family === 'auto' ? undefined : outputScopeOf(registry, family);
  /** Sets `outputScope` on a snapshot whose family is known and which does not carry it yet. */
  const withScope = (snapshot: AgencyBuildSnapshot): AgencyBuildSnapshot => {
    const scope = scopeOf(snapshot.family);
    return scope && snapshot.outputScope !== scope ? { ...snapshot, outputScope: scope } : snapshot;
  };

  /** Newest last, oldest first — the order `agency-build-store.ts` keeps its file in too. Bounded
   * by `AGENCY_BUILD_HISTORY_LIMIT` in memory AND on disk, but no longer wiped by a restart: see
   * `hydrated` below. */
  const jobs = new Map<string, BuildJob>();
  let activeId: string | undefined;

  /** Every `startBuild` detached task (build, fork, or repair-triggering build — the `void
   * (async () => { ... })()` below) that has not yet run its `settle`/`settleError`/`finally`
   * to completion. A caller that only awaits the POST response (the 202 is sent before this task
   * even starts `runBuild`) has no way to know whether `persist()` has been CALLED yet, let alone
   * finished writing — this is what `idle()` below waits on first, so it can be sure every
   * `persist()` any of these tasks will ever call has already been enqueued on the store before
   * it drains the store itself. */
  const inFlightBuilds = new Set<Promise<void>>();

  /** The fixed sentence for a build the store still shows mid-flight when this daemon starts: the
   * process that was running it is gone, and nothing here resumes a build or shows one as running
   * that it did not itself start. */
  const INTERRUPTED_MESSAGE = 'the daemon restarted while this build was running';

  /**
   * Loads whatever `agency-build-store.ts` has on disk before this daemon answers any build
   * request. Every handler below awaits this first, so a build saved by an earlier process is in
   * `jobs` before a client can see a falsely empty list or a false 404 for it.
   *
   * A record still in a running phase means the daemon stopped before `finish()` ever ran for it,
   * so the terminal `save()` that would have recorded its real outcome never happened either. It
   * is rewritten `failed` here, once, and that rewrite is itself persisted so a second restart does
   * not have to repeat the reasoning. Never rejects: a store that cannot be read leaves `jobs`
   * empty rather than blocking every future request on a daemon that cannot fix its own disk.
   */
  const hydrated: Promise<void> = (async () => {
    let persisted: PersistedAgencyBuild[];
    try {
      persisted = await store.load();
    } catch (error) {
      console.error('[agency-build] could not load persisted builds:', error);
      return;
    }
    for (const record of persisted) {
      const interrupted = !isTerminal(record.snapshot.status);
      const snapshot: AgencyBuildSnapshot = interrupted
        ? {
            ...record.snapshot,
            status: 'failed',
            finishedAt: record.snapshot.finishedAt ?? new Date().toISOString(),
            error: { code: 'BUILD_FAILED', message: INTERRUPTED_MESSAGE },
          }
        : record.snapshot;
      // A record saved before output scopes existed (or with one the store dropped as malformed)
      // gets it from its family here, so every served snapshot with a family carries one.
      // A record saved before public Cult ids is served with them, like a new build.
      const scoped = publicSnapshotIds(withScope(snapshot));
      // Persist when hydration changed the record: an interrupted build rewritten `failed`, or a
      // completed one that just gained its `outputScope` (C16) — the backfill must be true on disk,
      // not only in memory.
      const changed = interrupted || JSON.stringify(scoped) !== JSON.stringify(snapshot);
      jobs.set(scoped.id, {
        snapshot: scoped,
        // A hydrated job is always `done: true` (either already terminal, or just rewritten
        // `failed` above), so `record()` never runs on it and `lastPhase` is never read for it —
        // `'queued'` here is only a type-satisfying placeholder, not a claim about how far the
        // build actually got before the restart.
        lastPhase: 'queued',
        controller: new AbortController(),
        listeners: new Set(),
        done: true,
        ...(record.fork ? { forkSeed: record.fork } : {}),
      });
      if (changed) {
        // Awaited, unlike `persist()` below: `hydrated` is what every handler already awaits
        // before touching `jobs`, so this is the one save that gets to finish before the daemon
        // answers anything — the rewrite-to-`failed` this file's docblock promises should be true
        // on disk, not merely in memory, by the time a client can ask. A failure here still only
        // logs: an unwritable store must not make the daemon refuse every request forever.
        try {
          await store.save({ snapshot: scoped, ...(record.fork ? { fork: record.fork } : {}) });
        } catch (error) {
          console.error(`[agency-build] ${snapshot.id} could not be re-saved${interrupted ? ' as failed' : ' after hydration updated it'}:`, error);
        }
      }
    }
  })();

  /**
   * Fire-and-forget: a persistence failure must not fail the request it rides along with. It is
   * logged, and every endpoint keeps answering from the in-memory registry regardless.
   *
   * The record is copied out of `job` at CALL time, not read by reference: `job.snapshot` is a
   * live object `record()`/`finish()` keep mutating in place while this save sits queued on
   * `store`'s serialized chain, and `events` is a live array `record()` pushes onto the same way.
   * A save must persist the build exactly as it stood at the moment something happened to it —
   * queued, or just-finished — not whatever the object happens to look like when its turn on the
   * chain arrives.
   */
  const persist = (job: BuildJob) => {
    const snapshot: AgencyBuildSnapshot = { ...job.snapshot, events: [...job.snapshot.events] };
    void store.save({ snapshot, ...(job.forkSeed ? { fork: job.forkSeed } : {}) })
      .catch((error) => console.error(`[agency-build] ${job.snapshot.id} could not be persisted:`, error));
  };

  const fail = (res: Response, status: number, code: ApiErrorCode, message: string) =>
    sendApiError(res, status, code, message);

  /** The approved kit `req` may wear (its own Workspace scope — a fork re-checks with the forking
   * request's scope), `undefined` when none was named, or `null` once the refusal has been
   * answered (422, before any lock is taken). */
  const resolveKit = async (req: Request, res: Response, id: string | undefined): Promise<BuildDesignKit | undefined | null> => {
    if (id === undefined) return undefined;
    const resolved = designKits
      ? await resolveAgencyDesignKit(designKits, req, id)
      : { ok: false as const, code: 'DESIGN_SYSTEM_NOT_SELECTABLE' as const, message: 'That design system is not installed. Pick an installed kit.', details: { designSystemId: id, reason: 'not-installed' } };
    if (resolved.ok) return resolved.kit;
    sendApiError(res, 422, resolved.code, resolved.message, { details: resolved.details });
    return null;
  };

  /** Whether this daemon bundles `family` — the registry it routes against lists it. */
  const isBundledFamily = (family: string): boolean =>
    FAMILY_ID.test(family) && registry.families.some((entry) => entry.family === family);

  /**
   * One family's effects offer from its loaded package (the fast lane's `familyEffectsResponse`
   * over `effectCatalog`), re-checked with the shared parser so what the endpoint serves and what a
   * request is validated against are one shape. A package with no declaration offers nothing.
   * Throws when the package cannot be loaded or the offer is malformed — a daemon fault.
   */
  const effectsOfferOf = async (family: string): Promise<AgencyFamilyEffectsResponse> => {
    const pkg = await loadPackage(family);
    const raw = familyEffectsResponse(pkg, effectCatalog);
    const parsed = parseAgencyFamilyEffectsResponse(raw);
    if (!parsed.ok) throw new Error(`family ${family} effects offer is malformed: ${parsed.reason}`);
    return parsed.value;
  };

  /** `parseEffects`'s lookup: `undefined` for a family this daemon does not bundle. */
  const effectsOfferFor = async (family: string): Promise<AgencyFamilyEffectsResponse | undefined> =>
    isBundledFamily(family) ? effectsOfferOf(family) : undefined;

  /** Every build endpoint, not only the one that starts a build. See the module docblock. */
  const requireLocalOrigin = (req: Request, res: Response): boolean => {
    if (isLocalSameOrigin(req, resolvedPortRef.current)) return true;
    fail(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
    return false;
  };

  const jobOr404 = (req: Request, res: Response): BuildJob | undefined => {
    const job = jobs.get(String(req.params.id ?? ''));
    if (!job) {
      fail(res, 404, 'BUILD_NOT_FOUND', 'no build with that id');
      return undefined;
    }
    return job;
  };

  /**
   * Drops the oldest builds once the history is over its limit.
   *
   * A Map iterator's own `done` flag is its exhaustion, not the job's, so the job is read from
   * the map: a build somebody may still be watching is never evicted, and neither is the one just
   * created. With one build at a time only the newest can be running, but the rule is the one
   * that holds whatever the concurrency turns out to be.
   */
  const pruneHistory = (keepId: string) => {
    while (jobs.size > AGENCY_BUILD_HISTORY_LIMIT) {
      const oldest = jobs.keys().next();
      if (oldest.done || oldest.value === keepId) break;
      if (jobs.get(oldest.value)?.done === false) break;
      jobs.delete(oldest.value);
    }
  };

  /** The snapshot as `GET /api/agency/builds` serves it: everything but the event array. */
  const toListItem = (job: BuildJob): AgencyBuildListItem => {
    const { events: _events, ...rest } = job.snapshot;
    // The hints the build ran with, so a client can prefill a fork's section controls.
    return job.forkSeed?.sections ? { ...rest, sections: { ...job.forkSeed.sections } } : rest;
  };

  /**
   * `fetch` for this build's self-calls, carrying the initiating request's workspace and auth
   * scope. Built per build from the request that started it, because that request is the only
   * place the scope exists — the background run has no request of its own.
   */
  const scopedFetch = (req: Request): typeof fetch => {
    const scope: Record<string, string> = {};
    for (const name of SCOPE_HEADERS) {
      const value = req.get(name);
      if (typeof value === 'string' && value.length > 0) scope[name] = value;
    }
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(scope)) headers.set(name, value);
      return fetch(input, { ...init, headers });
    };
  };

  const record = (job: BuildJob, event: BuildEvent) => {
    if (job.done) return;
    const dto = toEventDto(event, job.snapshot.events.length + 1, new Date().toISOString());
    if (event.type === 'route' && event.decision.family) {
      const scope = scopeOf(event.decision.family.id);
      if (scope) {
        dto.outputScope = scope;
        job.snapshot.outputScope = scope;
      }
    }
    if (dto.renderQuality) job.snapshot.renderQuality = dto.renderQuality;
    job.snapshot.events.push(dto);
    job.snapshot.status = advance(job.snapshot.status, phaseOf(event));
    // `job.lastPhase` tracks only what real events have proven — see its doc comment on `BuildJob`
    // — so it advances from the same `phaseOf(event)` but never from `startBuild`'s early bump of
    // `snapshot.status` to `'routing'`.
    job.lastPhase = advance(job.lastPhase, phaseOf(event));
    if (event.type === 'route' && event.decision.family) job.snapshot.family = event.decision.family.id;
    // The route lands on the snapshot as soon as it is decided, not only in `settle`: a build that
    // then THROWS (`settleError`) must still say which spine and family it ran with.
    if (event.type === 'route') job.snapshot.route = toRouteDto(event.decision);
    if (event.type === 'verify') job.lastRemaining = [...(event.remainingPaths ?? [])];
    // Ordinary logs keep repair diagnostics without generated text (B-113).
    if (event.type === 'repair-discarded') console.error(`[agency-build] ${job.snapshot.id} ${event.label} faithfulness repair ${event.round + 1} discarded (${repairReason(event.reason)})`);
    if (event.type === 'project') job.snapshot.projectId = event.projectId;
    if (event.type === 'composition') {
      if (dto.composition) job.snapshot.composition = dto.composition;
      // A composed page belongs to no family; it is always a working `site` page.
      if (event.result.used === 'blocks') {
        job.snapshot.family = COMPOSED_FAMILY;
        job.snapshot.outputScope = 'site';
      }
    }
    // `preview` only ever fires for `verify: 'after'` (`run.ts`'s `verifyAfterPublish`), so it is
    // what starts this build's deferred verdict — the page has published, the check has not run
    // yet. The `verify` event that follows it completes that SAME verdict; a `verify` event with
    // no preceding `preview` (every other verify mode) leaves `job.snapshot.verify` untouched, so
    // a strict/advisory build never grows a field the API contract says only `after` carries.
    if (event.type === 'preview') job.snapshot.verify = { status: 'pending', flagged: [] };
    if (event.type === 'verify' && job.snapshot.verify !== undefined) {
      job.snapshot.verify = event.skipped !== undefined
        ? { status: 'skipped', flagged: [], ms: event.ms }
        : { status: 'done', flagged: event.remainingPaths ?? [], ms: event.ms };
    }
    for (const listener of job.listeners) listener(dto);
  };

  /**
   * Ends the job with its outcome, releases the one-at-a-time lock, and wakes every watcher one
   * last time. Idempotent: the FIRST outcome wins, so a later failure on the way out — a `settle`
   * that threw after finishing, the guard in the run's `finally` — cannot rewrite what happened.
   */
  const finish = (job: BuildJob, patch: Partial<AgencyBuildSnapshot> & { status: AgencyBuildStatus }) => {
    if (job.done) return;
    Object.assign(job.snapshot, patch, { finishedAt: new Date().toISOString() });
    const scope = scopeOf(job.snapshot.family);
    if (scope) job.snapshot.outputScope = scope;
    job.done = true;
    if (activeId === job.snapshot.id) activeId = undefined;
    persist(job);
    for (const listener of job.listeners) listener(null);
  };

  /**
   * Turns whatever the build ended as into a snapshot.
   *
   * A strict build that did not pass its gate returns `built` with `report.strict.passed` false
   * and nothing published — the fast lane treats the gate as an outcome, not an exception — so it
   * is checked before the report is taken as a success.
   */
  const settle = (job: BuildJob, result: BuildResult) => {
    switch (result.outcome) {
      case 'built': {
        const { report } = result;
        if (report.strict?.passed === false) {
          // Generated remaining text stays out of ordinary logs (B-113).
          const remainingCount = (report.verify?.remaining ?? job.lastRemaining ?? []).length;
          console.error(`[agency-build] ${job.snapshot.id} did not pass the strict verify gate (VERIFY_FAILED; remaining=${remainingCount})`);
          finish(job, {
            status: 'failed',
            family: result.family,
            ...(result.route ? { route: toRouteDto(result.route) } : {}),
            provider: result.provider,
            model: result.model,
            providers: result.providers,
            summary: toSummary(report),
            ...(report.renderQuality ? { renderQuality: toRenderQualityDto(report.renderQuality) } : {}),
            ...(report.composition ? { composition: toCompositionDto(report.composition) } : {}),
            error: { code: 'VERIFY_FAILED', message: 'the build did not pass the faithfulness check and nothing was published' },
            // Slot paths, the same labels a `verify: 'after'` verdict already publishes.
            failure: { step: 'verifying', flaggedSlots: [...(report.verify?.remaining ?? job.lastRemaining ?? [])] },
          });
          return;
        }
        // `providerDeferred` (`family: 'auto'` with no provider named) means `forkSeed` above
        // still holds the placeholder it was given before routing ran. `result.family` is now the
        // routed winner, so this replaces it with the SAME resolution `runBuild` itself made via
        // `defaultModelFor` (see `BuildJob.providerDeferred`) — a later `/fork` or `/repair`
        // reuses the provider this build actually ran with, not the placeholder it never used.
        if (job.providerDeferred && job.forkSeed) {
          const resolved = defaultModelFor(result.family);
          job.forkSeed = { ...job.forkSeed, provider: resolved.provider, ...(resolved.model !== undefined ? { model: resolved.model } : {}) };
        }
        // `POST .../:id/repair` needs the recipe this build actually published — see
        // `BuildJob.recipe`. Set on every successful build, not only `verify: 'after'`: a plain
        // build has `job.snapshot.verify` left `undefined` (no `preview` event ever fired for
        // it), so the repair endpoint's own precondition already refuses anything but a
        // `verify: 'after'` build with a `done` verdict — keeping `recipe` unconditional here
        // costs nothing and avoids a second special case.
        job.recipe = report.recipe;
        const composition = report.composition ? toCompositionDto(report.composition) : undefined;
        // A composed build's plan travels with its fork seed, so a fork (and a repair) replays the
        // same page instead of asking Jev for a new plan.
        const plan = planOf(composition);
        if (plan && job.forkSeed) job.forkSeed = { ...job.forkSeed, blockPlan: plan };
        // The provider and model that actually answered — the failover target when the primary
        // failed. `forkSeed` keeps the requested primary, so a repair or fork tries it again.
        finish(job, {
          status: 'done',
          family: result.family,
          ...(result.route ? { route: toRouteDto(result.route) } : {}),
          ...(result.projectId !== undefined ? { projectId: result.projectId } : {}),
          provider: result.provider,
          model: result.model,
          providers: result.providers,
          summary: toSummary(report),
          ...(report.renderQuality ? { renderQuality: toRenderQualityDto(report.renderQuality) } : {}),
          // Mirrors `RunReport.sectionOverlay` structurally (`AgencySectionOverlayResult`) — never
          // the fetched/supplied `designReference` text, which `RunReport` has no field for at all.
          // The entry is named by its public id (`cult:<slug>`), never the internal inventory id.
          ...(report.sectionOverlay ? { sectionOverlay: { ...report.sectionOverlay, entryId: publicEntryId(report.sectionOverlay.entryId) } } : {}),
          ...(composition ? { composition } : {}),
          ...(plan ? { outputScope: 'site' as const } : {}),
          // `RunReport.effects`, re-checked field by field (`toEffectsDto`): ids, counts and fixed
          // skip codes only.
          ...effectsPatch(report.effects),
        });
        return;
      }
      case 'unrouted':
        finish(job, { status: 'unrouted', route: toRouteDto(result.route), ...(result.composition ? { composition: toCompositionDto(result.composition) } : {}) });
        return;
      case 'cancelled':
        // The `project` event put an id on the snapshot while the build was running, and a
        // cancelled build usually removes that project again. `buildSite` reports a project here
        // only when one SURVIVED — a project the caller supplied, which it never deletes — so an
        // outcome without one means the rollback succeeded and the id names nothing. Leaving it
        // on the snapshot makes `GET /api/agency/builds` list a project whose own GET is 404, the
        // CLI print it, and the Route panel offer to open it.
        if (result.projectId === undefined) delete job.snapshot.projectId;
        finish(job, {
          status: 'cancelled',
          ...(result.family !== undefined ? { family: result.family } : {}),
          ...(result.projectId !== undefined ? { projectId: result.projectId } : {}),
        });
        return;
      case 'rollback-failed':
        // The message names the project and both failures; it is fixed text, but it is the fast
        // lane's text and this endpoint answers with its own. The project id is what matters, and
        // it travels on the snapshot where a client can act on it.
        console.error(`[agency-build] ${job.snapshot.id} left project ${result.projectId} behind: ${result.message}`);
        finish(job, {
          status: 'failed',
          family: result.family,
          projectId: result.projectId,
          ...(result.provider !== undefined && result.model !== undefined && result.providers !== undefined
            ? { provider: result.provider, model: result.model, providers: result.providers }
            : {}),
          error: { code: 'ROLLBACK_FAILED', message: 'the build failed and the project it created could not be removed' },
        });
        return;
      default: {
        // An outcome this daemon does not know is a contract change, and the assignment below is
        // the compile error that says so. It still FINISHES the job: an outcome added upstream
        // must never be able to leave the one-at-a-time lock held until a restart.
        const unreachable: never = result;
        console.error(`[agency-build] ${job.snapshot.id} ended with an outcome this daemon does not know`, unreachable);
        finish(job, { status: 'failed', error: { code: 'BUILD_FAILED', message: 'the build failed' } });
      }
    }
  };

  /** Every failure that is not an outcome. The real error is logged; the client gets a sentence. */
  const settleError = (job: BuildJob, error: unknown) => {
    // A `sections` build can take one provider's answer and then fail on another section (both
    // providers down, say). The failed record still names who wrote the accepted part.
    const provenance = buildProvenanceOf(error);
    const keyFault = keyFaultLogLine(error);
    // `ProviderKeyError` is what the fast lane's model caller turns a key-resolver rejection into
    // (the daemon's own `ModelKeyUnavailableError` rides on its `cause`), and what a failover
    // throws when neither provider has a key: both are the same fixed answer.
    if (error instanceof ModelKeyUnavailableError || error instanceof ProviderKeyError) {
      console.error(`[agency-build] ${job.snapshot.id} ${keyFault}`);
      finish(job, { status: 'failed', ...provenance, error: { code: 'MODEL_UNAVAILABLE', message: 'the model key is not available on this daemon' } });
      return;
    }
    // The key store failed (not "no key"): same code, never failed over (see failover.ts). The
    // response names the stored file only when the file is what failed; any other store fault gets
    // a generic sentence. The log carries the cause's class and code, never its message.
    if (error instanceof ProviderKeyUnreadableError) {
      const fileFault = error.cause instanceof AgencyJevConfigUnreadableError;
      console.error(`[agency-build] ${job.snapshot.id} ${keyFault}`);
      finish(job, {
        status: 'failed',
        ...provenance,
        error: {
          code: 'MODEL_UNAVAILABLE',
          message: fileFault
            ? 'the stored model key file could not be read on this daemon'
            : 'the model key store could not be read on this daemon',
        },
      });
      return;
    }
    if (error instanceof JevCredentialError) {
      console.error(`[agency-build] ${job.snapshot.id} ${keyFault}`);
      finish(job, { status: 'failed', ...provenance, error: { code: 'JEV_UNAVAILABLE', message: 'Jev is not available on this daemon' } });
      return;
    }
    if (error instanceof RenderQualityError) {
      if (job.snapshot.events.some((event) => event.type === 'project' && event.created === true)) delete job.snapshot.projectId;
      finish(job, {
        status: 'failed', ...provenance,
        renderQuality: toRenderQualityDto(error.report),
        error: { code: 'RENDER_QUALITY_FAILED', message: 'the page failed its structure checks' },
        failure: { step: failureStep(job.lastPhase) },
      });
      return;
    }
    console.error(`[agency-build] ${job.snapshot.id} failed:`, error);
    // `buildSite` removes a project it created before it rethrows `PageTooLargeError` (a removal
    // that fails is the `rollback-failed` outcome instead), so the id the `project` event put on
    // the snapshot names nothing. A project the caller supplied is never removed and stays.
    if (error instanceof PageTooLargeError && job.snapshot.events.some((event) => event.type === 'project' && event.created === true)) {
      delete job.snapshot.projectId;
    }
    finish(job, {
      status: 'failed',
      ...provenance,
      error: { code: 'BUILD_FAILED', message: buildFailureMessage(error) },
      failure: buildFailureDetail(error, failureStep(job.lastPhase)),
    });
  };

  // ---- Starting a build ------------------------------------------------------

  /**
   * Starts a build from already-validated inputs and answers 202 with its queued snapshot — the
   * body both `POST /api/agency/build` and `POST /api/agency/builds/:id/fork` send once each has
   * turned its own request into this shape. The Jev preflight, the one-at-a-time lock, the
   * background run and its settle/settleError/finally guard all live here once, so the two routes
   * cannot drift apart on what "starting a build" means.
   */
  const startBuild = async (
    req: Request,
    res: Response,
    input: {
      brief: string;
      family: string;
      mode: 'single' | 'sections';
      verify: 'strict' | 'advisory' | 'after' | 'off';
      /**
       * Already defaulted by the caller (`defaultModelFor(family)` when the request named none)
       * for every family known at request time — same rule as `mode`/`verify` above. Left
       * `undefined` only for `family: 'auto'` with no provider named, since that family is not
       * known until routing runs; `defaultModelFor` below is what resolves it then.
       */
      provider?: ProviderName;
      model?: string;
      /** Threaded to `runBuild` only alongside an `undefined` `provider` — see `provider` above
       * and `BuildInput.defaultModelFor`. */
      defaultModelFor?: (family: string) => { provider: ProviderName; model?: string };
      /**
       * Already defaulted to `true` by the caller — the effective `AgencyBuildRequest.failover`.
       * `false` is threaded to `runBuild` as `fallbackProvider: null` (`build.ts`'s own failover
       * switch); `true` passes nothing, so the daemon's own default fallback keeps applying.
       * Recorded on `job.snapshot.failover` and `job.forkSeed.failover` regardless, so a repair
       * or fork reuses the same setting.
       */
      failover: boolean;
      projectId?: string;
      projectName?: string;
      /** Explicit optional-section hints, already validated (`parseSectionHints`). */
      sections?: Record<string, 'keep' | 'drop'>;
      /** Already validated and resolved (`parseSectionSelection`) — entryId/directionId are known
       * to exist. */
      sectionSelection?: SectionSelection;
      /** The catalog id this build's design reference came from, if any — kept ONLY for
       * `forkSeed` (`sol-design.md` §2: "fetch again for a fork"). Never the fetched/supplied text. */
      designReferenceId?: string;
      /**
       * The design reference's own text, already resolved (`resolveDesignReferenceText`) from
       * either `designReferenceId` (fetched) or `designReferenceText` (caller-supplied) — in
       * memory for this call only. Threaded straight to `runBuild`'s `designReference`; never
       * assigned to `job.forkSeed`, `job.snapshot`, or anywhere else this function writes.
       */
      designReference?: string;
      /** `family` when omitted. Kept on `forkSeed` so a fork repeats it. */
      composition?: AgencyBuildComposition;
      /** A saved plan to replay (a fork of a composed build that did not name a composition). */
      blockPlan?: AgencyBuildBlockPlan;
      /** Already validated (`parseEffects`). `undefined` = omitted: `buildSite` applies its own
       * default (`auto` for a site family, `off` for an app or dashboard page kind). */
      effects?: AgencyEffectsInput;
      /** Already resolved (`resolveAgencyDesignKit`): the approved kit and its derived direction.
       * Only its id is kept on `forkSeed`, so a fork re-reads the kit's then-approved revision. */
      designKit?: BuildDesignKit;
    },
  ): Promise<void> => {
    const {
      brief, family, mode, verify, provider, model, defaultModelFor: resolveDefault, projectId, projectName, sections,
      sectionSelection, designReferenceId, designReference, composition, blockPlan, effects, failover, designKit,
    } = input;

    // Both `auto` and any mode but `off` need Jev, and a build is entitled to learn its
    // credential is broken before it spends the model call the check would grade. Nothing has
    // started at this point: no lock, no job, no id.
    if (verify !== 'off' || family === 'auto') {
      try {
        await jevKeyStore.resolveKey();
      } catch {
        fail(res, 503, 'JEV_UNAVAILABLE', 'Jev is not available on this daemon');
        return;
      }
    }

    // One build at a time. The provider's run lock is cross-process, so a second build would
    // only queue behind the first — holding a project id and a model key while it waited.
    if (activeId !== undefined) {
      sendApiError(res, 409, 'BUILD_BUSY', 'a build is already running on this daemon', {
        details: { kind: 'agency-build-busy', activeId } satisfies AgencyBuildBusyDetails,
      });
      return;
    }

    const id = randomUUID();
    // A named family's output scope is known now; an `auto` build learns it at routing.
    const initialScope = scopeOf(family);
    const job: BuildJob = {
      snapshot: { id, status: 'queued', events: [], startedAt: new Date().toISOString(), failover, ...(initialScope ? { outputScope: initialScope } : {}) },
      lastPhase: 'queued',
      controller: new AbortController(),
      listeners: new Set(),
      done: false,
      // What `/fork` would need to start a new build from THIS one, once it finishes. Set
      // regardless of outcome; `canFork` is what decides whether a client may actually use it.
      //
      // `provider` can still be `undefined` here (`family: 'auto'` with none named), and the
      // routed winner — so its own default — is not known yet. `DEFAULT_PROVIDER` is a placeholder
      // for that case, not a final answer: `settle`'s `built` case (see `providerDeferred` below)
      // replaces it with `defaultModelFor(result.family)` once routing has actually run, so the
      // seed a `/fork` or `/repair` reads back matches the provider this build really used.
      forkSeed: {
        brief, family, mode, verify, provider: provider ?? DEFAULT_PROVIDER, failover,
        ...(typeof model === 'string' ? { model } : {}),
        ...(sections ? { sections } : {}),
        ...(sectionSelection ? { sectionSelection } : {}),
        // Never `designReference` (the text) — only the id, so a later `/fork` re-fetches it
        // fresh rather than reusing this build's own fetched/supplied text. See the `startBuild`
        // input doc comment above.
        ...(designReferenceId ? { designReferenceId } : {}),
        ...(composition && composition !== 'family' ? { composition } : {}),
        ...(blockPlan ? { blockPlan } : {}),
        // Kept as the request named it, so a fork reuses it; omitted stays omitted, so a fork of
        // a default build gets the default again.
        ...(effects !== undefined ? { effects } : {}),
        ...(designKit ? { designSystemId: designKit.id } : {}),
      },
      providerDeferred: provider === undefined,
    };
    // From here on the one-at-a-time lock is HELD, and every path out of this handler has to
    // release it. `finish` is the only thing that does, so every failure below ends the job
    // rather than merely answering — a lock left behind answers 409 until the daemon restarts.
    let daemonFetch: typeof fetch;
    try {
      jobs.set(id, job);
      activeId = id;
      pruneHistory(id);
      persist(job);
      daemonFetch = scopedFetch(req);
      const body = { build: { ...job.snapshot, events: [] } } satisfies AgencyBuildResponse;
      res.status(202).json(body);
    } catch (error) {
      // Nothing has run: the build is over before it began. The 202 may or may not have been
      // written, so the answer is only attempted when it has not.
      console.error(`[agency-build] ${id} could not be started:`, error);
      finish(job, { status: 'failed', error: { code: 'BUILD_FAILED', message: buildFailureMessage(error) } });
      if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'the build could not be started');
      return;
    }

    // Tracked in `inFlightBuilds` (not merely `void`-ed) so `idle()` below can tell a caller that
    // only awaited the 202 — never polled this build to a terminal status — apart from a caller
    // that has actually seen every `persist()` call this task will ever make.
    const buildTask = (async () => {
      try {
        job.snapshot.status = advance(job.snapshot.status, 'routing');
        const result = await runBuild({
          brief,
          family,
          mode,
          revision: DEFAULT_REVISION,
          verify,
          // The generated, bundle-safe objects — never the fast lane's file loaders, which
          // resolve inside the prebundle in a packaged daemon. Same rule as the design index.
          loadAtlas: async () => ({ atlas, registry }),
          ...(provider !== undefined ? { provider } : {}),
          ...(typeof model === 'string' ? { model } : {}),
          // Only threaded through when `provider` is not already settled — `family: 'auto'` with
          // no provider named. `buildSite` calls this once it knows which family the brief
          // actually routed to, which is the earliest point a per-family default can apply.
          ...(resolveDefault !== undefined ? { defaultModelFor: resolveDefault } : {}),
          // `false` turns failover off entirely (`build.ts`'s `fallbackFor`: `null` means "no
          // fallback"). `true` passes nothing, so `buildSite`'s own default fallback still
          // applies — same omit-for-default rule every other field on this call follows.
          ...(failover === false ? { fallbackProvider: null } : {}),
          project: {
            // The daemon's real own URL, so a daemon bound to a Tailscale address or behind a
            // proxy publishes to itself rather than to a reconstructed loopback guess.
            daemonUrl: daemonUrlRef.current,
            ...(typeof projectId === 'string' ? { projectId } : {}),
            ...(typeof projectName === 'string' ? { name: projectName } : {}),
          },
          prepare: async (routed) => ({
            pkg: await loadPackage(routed),
            entry: `${routed}-r${DEFAULT_REVISION}.html`,
          }),
          ...(sections ? { sections } : {}),
          ...(sectionSelection ? { sectionSelection } : {}),
          // In memory for this call only — never assigned to `job`, `forkSeed`, or the snapshot.
          ...(designReference !== undefined ? { designReference } : {}),
          ...(composition && composition !== 'family' ? { composition, loadBlockCatalog } : {}),
          ...(blockPlan ? { blockPlan } : {}),
          ...(effects !== undefined ? { effects } : {}),
          ...(effectCatalog ? { effectCatalog } : {}),
          ...(designKit ? { designKit } : {}),
          signal: job.controller.signal,
          onEvent: (event) => record(job, event),
        }, {
          ...buildDeps,
          // Classified here rather than at the vault, so a build that cannot read its model key
          // says which key — and the store's own message, which names the entry it tried, stays
          // on this side of the boundary.
          resolveModelKey: buildModelKeyResolver(buildDeps.resolveModelKey),
          daemonFetch,
        });
        settle(job, result);
      } catch (error) {
        settleError(job, error);
      } finally {
        // The backstop for the lock. `settle` and `settleError` both finish the job, so this is
        // reached only if one of them threw on the way — but the cost of being wrong here is a
        // daemon that refuses every later build, so the guarantee is made rather than reasoned
        // about. There is deliberately no watchdog TIMER: a build that is genuinely still
        // running must not be declared over behind its own back, and cancellation is the
        // bounded way out — F6a threads the abort through generation, publishing and Jev, and
        // waits for an in-flight create before it rolls back.
        if (!job.done) {
          console.error(`[agency-build] ${id} ended without an outcome`);
          finish(job, { status: 'failed', error: { code: 'BUILD_FAILED', message: 'the build failed' } });
        }
      }
    })();
    inFlightBuilds.add(buildTask);
    void buildTask.finally(() => { inFlightBuilds.delete(buildTask); });
  };

  // ---- POST /api/agency/build ----------------------------------------------

  app.post('/api/agency/build', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    try {
      const request = (req.body ?? {}) as Body;
      const brief = request.brief;
      if (typeof brief !== 'string' || brief.trim().length === 0) {
        return fail(res, 400, 'BAD_REQUEST', 'brief is required');
      }
      if (brief.length > AGENCY_ROUTE_MAX_CHARS) {
        return fail(res, 400, 'BAD_REQUEST', `brief must be at most ${AGENCY_ROUTE_MAX_CHARS} characters`);
      }
      const family = request.family === undefined ? 'auto' : request.family;
      if (typeof family !== 'string' || (family !== 'auto' && !FAMILY_ID.test(family))) {
        return fail(res, 400, 'BAD_REQUEST', "family must be 'auto' or a lowercase family id");
      }
      const mode = request.mode === undefined ? 'sections' : request.mode;
      if (typeof mode !== 'string' || !MODES.includes(mode as (typeof MODES)[number])) {
        return fail(res, 400, 'BAD_REQUEST', `mode must be one of ${MODES.join(', ')}`);
      }
      const verify = request.verify === undefined ? 'strict' : request.verify;
      if (typeof verify !== 'string' || !VERIFY_MODES.includes(verify as (typeof VERIFY_MODES)[number])) {
        return fail(res, 400, 'BAD_REQUEST', `verify must be one of ${VERIFY_MODES.join(', ')}`);
      }
      // Named provider is validated but not yet defaulted: an omitted provider on a `family` this
      // daemon already knows (anything but `auto`) gets `defaultModelFor(family)` below, same as
      // it always got `DEFAULT_PROVIDER`; an omitted provider on `family: 'auto'` is left
      // unresolved for `startBuild` to hand `runBuild`, since the routed family — and so its
      // default — is not known until routing runs. See `defaultModelFor`.
      const providerNamed = request.provider !== undefined;
      if (providerNamed && (typeof request.provider !== 'string' || !PROVIDER_NAMES.includes(request.provider as (typeof PROVIDER_NAMES)[number]))) {
        return fail(res, 400, 'BAD_REQUEST', `provider must be one of ${PROVIDER_NAMES.join(', ')}`);
      }
      const provider: ProviderName | undefined = providerNamed
        ? (request.provider as ProviderName)
        : family === 'auto' ? undefined : defaultModelFor(family).provider;
      // Trimmed once, here — every later use (the build, `forkSeed`, a post-restart repair) reads
      // this same trimmed value, so a model id typed with stray whitespace cannot mismatch itself
      // between the request that started the build and the record that outlives it.
      let model: string | undefined;
      if (request.model !== undefined) {
        if (typeof request.model !== 'string') {
          return fail(res, 400, 'BAD_REQUEST', 'model must be a non-empty string');
        }
        const trimmedModel = request.model.trim();
        if (trimmedModel.length === 0) {
          return fail(res, 400, 'BAD_REQUEST', 'model must be a non-empty string');
        }
        if (trimmedModel.length > MODEL_MAX_CHARS) {
          return fail(res, 400, 'BAD_REQUEST', `model must be at most ${MODEL_MAX_CHARS} characters`);
        }
        model = trimmedModel;
      }
      // A request that named its own provider keeps exactly that pair — no model unless it named
      // one too, as before this table existed. Only a request that named neither gets the
      // family's model override, and only once the family is actually known.
      if (!providerNamed && model === undefined && family !== 'auto') {
        model = defaultModelFor(family).model;
      }
      if (request.failover !== undefined && typeof request.failover !== 'boolean') {
        return fail(res, 400, 'BAD_REQUEST', 'failover must be a boolean');
      }
      const failover = request.failover === undefined ? true : request.failover;
      if (request.projectId !== undefined && typeof request.projectId !== 'string') {
        return fail(res, 400, 'BAD_REQUEST', 'projectId must be a string');
      }
      if (request.projectName !== undefined && typeof request.projectName !== 'string') {
        return fail(res, 400, 'BAD_REQUEST', 'projectName must be a string');
      }
      const sectionHints = parseSectionHints(request.sections);
      if ('error' in sectionHints) return fail(res, 400, 'BAD_REQUEST', sectionHints.error);
      const effectsParsed = await parseEffects(request.effects, family, effectsOfferFor);
      if (!effectsParsed.ok) return fail(res, 400, 'BAD_REQUEST', effectsParsed.error);

      const selectionParsed = await parseSectionSelection(request.sectionSelection);
      if (!selectionParsed.ok) return fail(res, 400, 'BAD_REQUEST', selectionParsed.error);
      const sectionSelection = selectionParsed.value;

      const kitParsed = parseDesignSystemId(request.designSystemId);
      if ('error' in kitParsed) return fail(res, 400, 'BAD_REQUEST', kitParsed.error);
      const compositionParsed = parseComposition(request.composition);
      if ('error' in compositionParsed) return fail(res, 400, 'BAD_REQUEST', compositionParsed.error);
      // A kit styles a composed page, so naming one defaults the composition to `auto`.
      const composition = compositionParsed.value ?? (kitParsed.value !== undefined ? 'auto' : undefined);
      if (kitParsed.value !== undefined && composition === 'family') {
        return fail(res, 400, 'BAD_REQUEST', 'a designSystemId styles a composed page: composition must be "auto" or "blocks"');
      }
      if (composition !== undefined && composition !== 'family' && sectionSelection !== undefined) {
        return fail(res, 400, 'BAD_REQUEST', 'composition "blocks" and "auto" cannot be combined with a sectionSelection');
      }
      const compositionVerify = compositionVerifyError(composition, verify);
      if (compositionVerify) return fail(res, 400, 'BAD_REQUEST', compositionVerify);

      if ((request.designReferenceId !== undefined || request.designReferenceText !== undefined) && sectionSelection === undefined) {
        return fail(res, 400, 'BAD_REQUEST', 'designReferenceId/designReferenceText require a sectionSelection');
      }
      const referenceShape = validateDesignReferenceShape(request.designReferenceId, request.designReferenceText);
      if (referenceShape) return fail(res, 400, 'BAD_REQUEST', referenceShape.error);
      const designReferenceId = typeof request.designReferenceId === 'string' ? request.designReferenceId : undefined;
      const designReferenceText = typeof request.designReferenceText === 'string' ? request.designReferenceText : undefined;
      const referenceResolved = await resolveDesignReferenceText(RUNTIME_DATA_DIR, designReferenceId, designReferenceText);
      if (!referenceResolved.ok) return fail(res, referenceResolved.status, referenceResolved.code, referenceResolved.message);
      const kitResolved = await resolveKit(req, res, kitParsed.value);
      if (kitResolved === null) return;

      await startBuild(req, res, {
        brief,
        family,
        mode: mode as 'single' | 'sections',
        verify: verify as 'strict' | 'advisory' | 'after' | 'off',
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        // Only needed when `provider` above is still unresolved — see the comment on `providerNamed`.
        ...(provider === undefined ? { defaultModelFor } : {}),
        failover,
        ...(typeof request.projectId === 'string' ? { projectId: request.projectId } : {}),
        ...(typeof request.projectName === 'string' ? { projectName: request.projectName } : {}),
        ...(sectionHints.hints ? { sections: sectionHints.hints } : {}),
        ...(sectionSelection ? { sectionSelection } : {}),
        ...(designReferenceId !== undefined ? { designReferenceId } : {}),
        ...(referenceResolved.value !== undefined ? { designReference: referenceResolved.value } : {}),
        ...(composition !== undefined ? { composition } : {}),
        ...(effectsParsed.value !== undefined ? { effects: effectsParsed.value } : {}),
        ...(kitResolved ? { designKit: kitResolved } : {}),
      });
    } catch (err: unknown) {
      // The validation phase, before the lock is taken. Fixed text like every other answer here:
      // an exception's message is whatever threw it, and this is a public endpoint.
      console.error('[agency-build] a build could not be started:', err);
      if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'the build could not be started');
    }
  });

  // ---- POST /api/agency/builds/:id/fork --------------------------------------

  /**
   * "Start from this build": the same family, brief and options as a saved build, publishing to a
   * NEW project rather than the one that build already made. Answers exactly like `POST
   * /api/agency/build` — same 202 shape, same busy/lock rules — because it calls the same
   * `startBuild`. Local same-origin only, like every other route in this module.
   */
  app.post('/api/agency/builds/:id/fork', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const job = jobOr404(req, res);
    if (!job) return;
    if (!job.forkSeed || !canFork(job.snapshot)) {
      return fail(res, 409, 'BUILD_NOT_FORKABLE', 'this build has no publishable project to start from');
    }

    const request = (req.body ?? {}) as AgencyBuildForkRequest & Body;
    let brief = job.forkSeed.brief;
    if (request.brief !== undefined) {
      if (typeof request.brief !== 'string' || request.brief.trim().length === 0) {
        return fail(res, 400, 'BAD_REQUEST', 'brief must be a non-empty string');
      }
      if (request.brief.length > AGENCY_ROUTE_MAX_CHARS) {
        return fail(res, 400, 'BAD_REQUEST', `brief must be at most ${AGENCY_ROUTE_MAX_CHARS} characters`);
      }
      brief = request.brief;
    }
    // Hint overrides merge over the saved build's own hints, id by id; `auto` clears one.
    const override = parseForkSectionHints(request.sections);
    if ('error' in override) return fail(res, 400, 'BAD_REQUEST', override.error);
    let sections = job.forkSeed.sections;
    if (override.hints) {
      const merged: Record<string, 'keep' | 'drop'> = { ...job.forkSeed.sections };
      for (const [id, hint] of Object.entries(override.hints)) {
        if (hint === 'auto') delete merged[id];
        else merged[id] = hint;
      }
      sections = Object.keys(merged).length > 0 ? merged : undefined;
    }
    if (sections && Object.keys(sections).length > AGENCY_BUILD_MAX_SECTION_HINTS) {
      return fail(res, 400, 'BAD_REQUEST', `sections may name at most ${AGENCY_BUILD_MAX_SECTION_HINTS} section ids`);
    }

    // `sectionSelection`: `undefined` in the request reuses the saved build's own selection,
    // `null` clears it, and a value replaces it — re-validated exactly like a fresh build's
    // (`sol-design.md` §2: a fork is still refused for an entry/direction that stops existing).
    let sectionSelection = job.forkSeed.sectionSelection;
    if (request.sectionSelection === null) {
      sectionSelection = undefined;
    } else if (request.sectionSelection !== undefined) {
      const parsed = await parseSectionSelection(request.sectionSelection);
      if (!parsed.ok) return fail(res, 400, 'BAD_REQUEST', parsed.error);
      sectionSelection = parsed.value;
    }

    // `effects`: `undefined` reuses the saved build's own value, `null` resets it to the default
    // (omitted, so `buildSite` decides again), and a value replaces it — validated exactly like a
    // fresh build's, against the saved build's family.
    let effects = job.forkSeed.effects;
    if (request.effects === null) {
      effects = undefined;
    } else if (request.effects !== undefined) {
      let parsedEffects: Awaited<ReturnType<typeof parseEffects>>;
      try {
        parsedEffects = await parseEffects(request.effects, job.forkSeed.family, effectsOfferFor);
      } catch (error) {
        console.error('[agency-build] a fork\'s effects could not be checked:', error);
        return fail(res, 500, 'INTERNAL_ERROR', 'the build could not be started');
      }
      if (!parsedEffects.ok) return fail(res, 400, 'BAD_REQUEST', parsedEffects.error);
      effects = parsedEffects.value;
    }

    // `designReferenceId`/`designReferenceText`: `undefined` re-fetches the saved id fresh (never
    // the original build's own fetched text — `sol-design.md` §2: "fetch again for a fork"),
    // `null` clears it, and a value replaces it. Mutually exclusive, same as a fresh build.
    if (request.designReferenceId !== undefined && request.designReferenceText !== undefined
      && request.designReferenceId !== null && request.designReferenceText !== null) {
      return fail(res, 400, 'BAD_REQUEST', 'designReferenceId and designReferenceText are mutually exclusive');
    }
    // Four cases, checked in this order on purpose:
    //   1. A string on EITHER field always wins, before the `null` check below — a caller that
    //      sends `{ designReferenceId: null, designReferenceText: '<text>' }` (clearing the saved
    //      id while supplying fresh text, or vice versa) must have that string honored, not
    //      silently discarded because the sibling field happened to be `null` (delta audit round
    //      1 finding 11 — the previous `id === null || text === null` check fired first and
    //      dropped whichever field carried real content).
    //   2. Neither field is a string, and at least one is explicitly `null` — the caller cleared
    //      the reference; both stay undefined. This is the only remaining case that branch below
    //      handles, now that (1) runs first (round 2 finding 3: the comment used to describe both
    //      cases at once, back when the string check ran after it).
    //   3. Both fields are `undefined` — reuse the saved build's own id, marked
    //      `designReferenceFromSeed` so it skips the shape re-validation below (round 2 finding 1:
    //      a seed written before `validateDesignReferenceShape` existed, or by a version with a
    //      looser rule, must still be forkable — `resolveDesignReferenceText`'s own fetch is what
    //      surfaces any problem with an id nobody just typed).
    //   4. Anything else (a non-string, non-null, non-undefined value) is malformed.
    let designReferenceId: string | undefined;
    let designReferenceText: string | undefined;
    let designReferenceFromSeed = false;
    if (typeof request.designReferenceId === 'string') {
      designReferenceId = request.designReferenceId;
    } else if (typeof request.designReferenceText === 'string') {
      designReferenceText = request.designReferenceText;
    } else if (request.designReferenceId === null || request.designReferenceText === null) {
      // Cleared — leaves both undefined.
    } else if (request.designReferenceId === undefined && request.designReferenceText === undefined) {
      designReferenceId = job.forkSeed.designReferenceId;
      designReferenceFromSeed = true;
    } else {
      return fail(res, 400, 'BAD_REQUEST', 'designReferenceId and designReferenceText must be strings or null');
    }
    if ((designReferenceId !== undefined || designReferenceText !== undefined) && sectionSelection === undefined) {
      return fail(res, 400, 'BAD_REQUEST', 'designReferenceId/designReferenceText require a sectionSelection');
    }
    // Only a caller-supplied value is checked against the current shape rule. A seed-derived id
    // was already valid (or simply untouched) under whatever rule existed when the original build
    // ran; re-validating it here would make a fork of an old build fail closed for a schema this
    // route grew after that build was made, instead of letting the actual fetch decide (round 2
    // finding 1).
    if (!designReferenceFromSeed) {
      const referenceShape = validateDesignReferenceShape(designReferenceId, designReferenceText);
      if (referenceShape) return fail(res, 400, 'BAD_REQUEST', referenceShape.error);
    }
    const referenceResolved = await resolveDesignReferenceText(RUNTIME_DATA_DIR, designReferenceId, designReferenceText);
    if (!referenceResolved.ok) return fail(res, referenceResolved.status, referenceResolved.code, referenceResolved.message);

    // `composition`: omitted reuses the saved one and, for a composed build, replays its saved
    // plan exactly; naming one asks for a fresh decision (and `family` drops the plan).
    const compositionParsed = parseComposition(request.composition);
    if ('error' in compositionParsed) return fail(res, 400, 'BAD_REQUEST', compositionParsed.error);
    const composition = compositionParsed.value ?? job.forkSeed.composition;
    const blockPlan = compositionParsed.value === undefined ? job.forkSeed.blockPlan : undefined;
    if (composition !== undefined && composition !== 'family' && sectionSelection !== undefined) {
      return fail(res, 400, 'BAD_REQUEST', 'composition "blocks" and "auto" cannot be combined with a sectionSelection');
    }
    // A fork keeps the saved verify mode, so composing a build that was not strict is refused.
    const compositionVerify = compositionVerifyError(blockPlan ? 'blocks' : composition, job.forkSeed.verify);
    if (compositionVerify) return fail(res, 400, 'BAD_REQUEST', compositionVerify);
    // The saved kit is re-read: a fork wears the kit's approved revision today, or is refused.
    const forkKit = await resolveKit(req, res, composition === 'family' ? undefined : job.forkSeed.designSystemId);
    if (forkKit === null) return;

    await startBuild(req, res, {
      brief,
      family: job.forkSeed.family,
      mode: job.forkSeed.mode,
      verify: job.forkSeed.verify,
      provider: job.forkSeed.provider,
      // Not overridable from the fork request — same rule as `mode`/`verify`: a fork keeps the
      // saved build's failover setting.
      failover: job.forkSeed.failover ?? true,
      ...(typeof job.forkSeed.model === 'string' ? { model: job.forkSeed.model } : {}),
      // The saved build's own hints travel with the fork, like its mode and verify, under any
      // override the fork request names.
      ...(sections ? { sections } : {}),
      ...(sectionSelection ? { sectionSelection } : {}),
      ...(designReferenceId !== undefined ? { designReferenceId } : {}),
      ...(referenceResolved.value !== undefined ? { designReference: referenceResolved.value } : {}),
      // A replayed plan composes the same blocks, so the fork asks for `blocks` whatever the
      // original requested (`auto` might otherwise take the family route this time).
      ...(blockPlan ? { composition: 'blocks' as const, blockPlan } : composition !== undefined ? { composition } : {}),
      ...(effects !== undefined ? { effects } : {}),
      ...(forkKit ? { designKit: forkKit } : {}),
    });
  });

  // ---- Repair (verify: 'after' only) ----------------------------------------

  /**
   * The actual repair pass for the verify-after-render play (`docs/plans/2026-09-22-generative-
   * ui-design.md` §5.4): re-fills exactly the slots the build's own deferred check flagged, with
   * every other editable slot locked (`lockPaths`, the same mechanism `--lock`/`--previous`
   * already use), re-verifies just those, and updates the build's `verify` field in place.
   *
   * What to repair is never a caller-chosen list — it is always `job.snapshot.verify.flagged`, so
   * this endpoint cannot be asked to touch a slot the check never flagged. Refuses
   * `BUILD_NOT_REPAIRABLE` when the build was not `verify: 'after'` (`job.snapshot.verify` is
   * `undefined`), its check has not finished yet (`status` still `pending`), it was `skipped`, or
   * nothing is flagged — none of those states leave anything for this endpoint to do.
   *
   * Synchronous, unlike `POST /api/agency/build`: the response IS the outcome, because a repair
   * only ever re-fills the paths this one build already named, which is bounded work, not a new
   * open-ended job. It still goes through `runBuild` (the same injected fast-lane build step every
   * other route here uses) with `verify: 'advisory'`, targeting the SAME project by id — never a
   * new one — so a repair updates the project the build already published rather than forking it.
   */
  app.post('/api/agency/builds/:id/repair', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const job = jobOr404(req, res);
    if (!job) return;

    // Checked and set in the SAME synchronous stretch as the precondition below — nothing here
    // awaits before `job.repairing` is set, so two requests racing this handler cannot both read
    // `repairing: false` and proceed together. See `BuildJob.repairing`.
    if (job.repairing) {
      return fail(res, 409, 'BUILD_REPAIR_IN_PROGRESS', 'a repair for this build is already running');
    }

    const reason = repairNotReadyReason(job);
    if (reason) {
      return fail(res, 409, 'BUILD_NOT_REPAIRABLE', reason);
    }
    // `repairNotReadyReason` returning `undefined` proved every one of these is set.
    const verdict: AgencyBuildVerifyVerdict = job.snapshot.verify!;
    const family = job.snapshot.family!;
    const projectId = job.snapshot.projectId!;
    const recipe = job.recipe!;
    const forkSeed = job.forkSeed!;

    job.repairing = true;
    try {
      const flaggedPaths = verdict.flagged;
      // Every editable text path this recipe carries is locked except the flagged ones — the same
      // walk `collectFaithfulnessSlots` does for a fill's own check, so "every path this repair may
      // touch" and "every path a check would ever look at" cannot drift apart; see
      // `RunOptions.lockPaths` (the `--lock`/`--previous` mechanism). `repairLockPaths` also locks
      // every `x-mock` illustrative slot explicitly, from the family schema, even if a flag named
      // one: the repair must never re-generate sample data. The schema comes with the package, so
      // the lock list is built in `prepare`, once the package is loaded.
      // Only the flagged paths are RE-GENERATED, but the published page FILE is still rewritten
      // whole, the same as any other publish: there is no per-slot patch to a published HTML file.
      const entry = `${family}-r${DEFAULT_REVISION}.html`;
      // A composed build is strict-only (`compositionVerifyError`), so it never has a deferred
      // verdict to repair and never reaches this pass.

      let result: BuildResult;
      try {
        result = await runBuild({
          brief: forkSeed.brief,
          family,
          mode: forkSeed.mode,
          revision: DEFAULT_REVISION,
          // Advisory, not `after` or `strict`: this pass already knows exactly which slots to
          // re-verify (the ones it just re-filled), so it checks and, on a flag that survives its
          // own in-run repair, reports it — immediately, not deferred a second time.
          verify: 'advisory',
          // The provider (and model, when the original request named one) the build itself ran
          // with, carried on `forkSeed` — never `DEFAULT_PROVIDER` here, or a repair on a
          // `cerebras` build would silently re-fill with `deepseek`.
          provider: forkSeed.provider,
          ...(typeof forkSeed.model === 'string' ? { model: forkSeed.model } : {}),
          // Same setting the original build ran with (`forkSeed.failover`, defaulted like the
          // fork endpoint above) — a repair must not silently re-enable failover a build turned
          // off, or vice versa.
          ...(forkSeed.failover === false ? { fallbackProvider: null } : {}),
          // The SAME project, by id — never created, never a fork. `projectId` on the job proves
          // the original build already made (or was given) this project.
          project: { daemonUrl: daemonUrlRef.current, projectId },
          prepare: async (routed) => {
            const pkg = await loadPackage(routed);
            const lockPaths = repairLockPaths(recipe as Parameters<typeof repairLockPaths>[0], flaggedPaths, pkg.schema);
            return { pkg, entry, spine: recipe as never, lockPaths };
          },
          // The published recipe's drops are already decided: its null sections stay dropped and
          // no new keep/drop request is made.
          judgeSections: false,
          // Same for the effect plan: the components the build applied are replayed as explicit
          // ids (`repairEffectsOf`, from the persisted `snapshot.effects`), never re-decided by Jev.
          effects: repairEffectsOf(job.snapshot.effects),
          // A replay: the applied ids come back reported as `source: 'repair'`, not as request hints.
          effectsReplay: true,
          ...(effectCatalog ? { effectCatalog } : {}),
        }, {
          ...buildDeps,
          resolveModelKey: buildModelKeyResolver(buildDeps.resolveModelKey),
          daemonFetch: scopedFetch(req),
        });
      } catch (error) {
        // A key fault gets the same sanitised line a build's settlement logs: the resolver's
        // `cause` can carry a path or a slice of the key file, so only its class and code go out.
        const keyFault = keyFaultLogLine(error);
        if (keyFault !== undefined) console.error(`[agency-build] ${job.snapshot.id} repair failed: ${keyFault}`);
        else console.error(`[agency-build] ${job.snapshot.id} repair failed:`, error);
        return fail(res, 500, 'INTERNAL_ERROR', 'the repair could not run');
      }

      if (result.outcome !== 'built') {
        console.error(`[agency-build] ${job.snapshot.id} repair ended with outcome "${result.outcome}" instead of publishing`);
        return fail(res, 500, 'INTERNAL_ERROR', 'the repair did not complete');
      }

      const remaining = result.report.verify?.remaining ?? flaggedPaths;
      const repaired = flaggedPaths.filter((path) => !remaining.includes(path));
      job.recipe = result.report.recipe;
      job.snapshot.verify = { status: 'done', flagged: remaining, ...(result.report.verify ? { ms: result.report.verify.ms } : {}) };
      // The repair republished the page, so the snapshot names whoever answered THIS pass — the
      // failover target when the repair itself failed over. `forkSeed` still keeps the requested
      // primary, so the next repair or fork tries it first again.
      job.snapshot.provider = result.provider;
      job.snapshot.model = result.model;
      // Every provider that filled any part of the page stays listed; the repair's are added on.
      job.snapshot.providers = mergeProviderUses(job.snapshot.providers, result.providers);
      persist(job);

      const body: AgencyBuildRepairResponse = { repaired, remaining };
      res.json(body);
    } finally {
      job.repairing = false;
    }
  });

  // ---- Reads ---------------------------------------------------------------

  app.get('/api/agency/builds', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const builds = [...jobs.values()].map((job) => toListItem(job)).reverse();
    const body = { builds } satisfies AgencyBuildListResponse;
    res.json(body);
  });

  /**
   * A family's optional sections, for a client that offers keep/drop controls before a build (the
   * Build panel, `od agency sections`). Ids come from the family's reference recipe, never from a
   * brief or a model. Only a family the registry lists is loaded.
   */
  app.get('/api/agency/families/:family/sections', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    const family = String(req.params.family ?? '');
    if (!FAMILY_ID.test(family) || !registry.families.some((entry) => entry.family === family)) {
      return fail(res, 404, 'NOT_FOUND', 'no bundled family has this id');
    }
    let pkg: FamilyPackage;
    try {
      pkg = await loadPackage(family);
    } catch (error) {
      console.error('[agency-build] family package could not be loaded', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'the family package could not be read');
    }
    // The registry lists this family (checked above) and validates its pageKind at load, so a
    // missing scope is a daemon fault — answered as one, never sent as an unlabelled family.
    const outputScope = scopeOf(family);
    if (!outputScope) return fail(res, 500, 'INTERNAL_ERROR', `family ${family} has no output scope in the registry`);
    const sections = optionalSectionsOf(pkg.schema, pkg.fixture).map(({ id, type, label }) => ({ id, type, label }));
    const body = { family, outputScope, sections } satisfies AgencyFamilySectionsResponse;
    res.json(body);
  });

  /**
   * A family's effect placements and the reviewed GenUI components each allows, for a client that
   * offers per-placement pickers before a build (the Build panel's Effects block, `od agency
   * effects`). 404 for a family the registry does not list; empty `placements` for one whose
   * package declares no `effects` (app-shell, crm-dashboard). Ids, names, kinds and byte counts
   * only — never markup.
   */
  app.get('/api/agency/families/:family/effects', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    const family = String(req.params.family ?? '');
    if (!isBundledFamily(family)) return fail(res, 404, 'NOT_FOUND', 'no bundled family has this id');
    let body: AgencyFamilyEffectsResponse;
    try {
      body = await effectsOfferOf(family);
    } catch (error) {
      console.error('[agency-build] family effects could not be read', error);
      return fail(res, 500, 'INTERNAL_ERROR', 'the family package could not be read');
    }
    res.json(body satisfies AgencyFamilyEffectsResponse);
  });

  /**
   * Every bundled family with its page kind and output scope (C16), for a client that labels
   * static prototypes before a build (`od agency families`). Read from the registry only; no
   * package is loaded.
   */
  app.get('/api/agency/families', (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    const families: AgencyFamiliesResponse['families'] = [];
    for (const entry of registry.families) {
      // Same guarantee as `/sections`: a listed family always has a scope; if not, fail loudly.
      const outputScope = scopeOf(entry.family);
      if (!outputScope) return fail(res, 500, 'INTERNAL_ERROR', `family ${entry.family} has no output scope in the registry`);
      families.push({ family: entry.family, pageKind: entry.pageKind, outputScope });
    }
    const body = { families } satisfies AgencyFamiliesResponse;
    res.json(body);
  });

  app.get('/api/agency/builds/:id', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const job = jobOr404(req, res);
    if (!job) return;
    const body = { build: job.snapshot } satisfies AgencyBuildResponse;
    res.json(body);
  });

  /**
   * The event stream.
   *
   * Replay and live are handed over inside ONE synchronous stretch: the backlog is read and the
   * listener registered without an `await` between them, so no event can land in the gap and none
   * can be sent twice. `seq` is the SSE id, so a reconnecting client resumes exactly where it
   * stopped, and `Last-Event-ID` is honoured for that. A build that is already finished replays
   * everything and sends its terminal frame immediately.
   */
  app.get('/api/agency/builds/:id/events', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const job = jobOr404(req, res);
    if (!job) return;

    const from = lastEventIdOf(req.get('last-event-id'));

    const sse = createSseResponse(res);
    const end = () => {
      sse.send('status', job.snapshot);
      sse.end();
    };

    const listener = (event: AgencyBuildEvent | null) => {
      if (event === null) {
        job.listeners.delete(listener);
        end();
        return;
      }
      sse.send('build-event', event, event.seq);
    };

    for (const event of job.snapshot.events) {
      if (event.seq > from) sse.send('build-event', event, event.seq);
    }
    if (job.done) {
      end();
      return;
    }
    job.listeners.add(listener);
    res.on('close', () => job.listeners.delete(listener));
  });

  /**
   * The same build as AG-UI spec events (`RUN_STARTED`, `STEP_*`, `STATE_SNAPSHOT`, `STATE_DELTA`
   * as JSON Patch, `CUSTOM`, `RUN_FINISHED` / `RUN_ERROR`), encoded by `@mish/agui-adapter`.
   * A watch-only stream: it observes a build `POST /api/agency/build` already started.
   *
   * Same hand-over as `/events` — fold, replay and listener registration in ONE synchronous
   * stretch — and the same `Last-Event-ID`: the frames of one build event share its `seq`, and
   * only the LAST frame of that group carries it as the SSE id, so a dropped connection resumes
   * after a whole group. The start and terminal frames carry no id. A resume folds the events the
   * client already has into the `STATE_SNAPSHOT` and sends only the later ones.
   *
   * Every frame is written as the default SSE `message` event, so the payload's `type` is the
   * event type. The brief never appears: the stream's input carries `briefChars` only.
   */
  app.get('/api/agency/builds/:id/agui', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const job = jobOr404(req, res);
    if (!job) return;

    const from = lastEventIdOf(req.get('last-event-id'));

    const sse = createSseResponse(res);
    const sendGroup = (frames: AguiEvent[], id?: number) => {
      frames.forEach((frame, index) => {
        sse.send('message', frame, index === frames.length - 1 ? id : undefined);
      });
    };

    let cursor: AgencyBuildAguiCursor;
    const end = () => {
      const encoded = encodeAgencyBuildEvent({ kind: 'end', snapshot: job.snapshot, input: aguiMeta(job).input }, cursor);
      cursor = encoded.cursor;
      sendGroup(encoded.events);
      sse.end();
    };
    const emit = (event: AgencyBuildEvent) => {
      const encoded = encodeAgencyBuildEvent({ kind: 'event', event }, cursor);
      cursor = encoded.cursor;
      sendGroup(encoded.events, event.seq);
    };
    const listener = (event: AgencyBuildEvent | null) => {
      if (event === null) {
        job.listeners.delete(listener);
        end();
        return;
      }
      emit(event);
    };

    const started = encodeAgencyBuildEvent({
      kind: 'start',
      meta: aguiMeta(job),
      replayed: job.snapshot.events.filter((event) => event.seq <= from),
    });
    cursor = started.cursor;
    sendGroup(started.events);
    for (const event of job.snapshot.events) {
      if (event.seq > from) emit(event);
    }
    if (job.done) {
      end();
      return;
    }
    job.listeners.add(listener);
    res.on('close', () => job.listeners.delete(listener));
  });

  // ---- Cancel --------------------------------------------------------------

  /**
   * Asks the build to stop. Idempotent, and a finished build simply answers its final snapshot —
   * the caller wanted the build not to be running, and it is not.
   *
   * The abort is a request, not a kill: `buildSite` catches it, waits for a create it may have
   * started, removes a project it made, and returns `cancelled`. The job ends when that clean-up
   * has finished, which is why this answers 202 rather than the final state.
   *
   * CARVE-OUT — `verify: 'after'`: once the deferred faithfulness check has started, this abort is
   * effectively a no-op. The page has already published by then (that is the whole point of the
   * play), so there is nothing left to roll back, and unwinding the run mid-check would only throw
   * away a verdict for a page a client can already see. `run.ts`'s `verifyAfterPublish` therefore
   * folds a cancellation there into `verify.skipped` (`skipReason: 'cancelled'`) instead of
   * rethrowing — the build still finishes and reports `done`, and its `verify` field is `skipped`
   * rather than `done`, so a client can tell "cancelled before we knew" from "checked, nothing
   * flagged". Before the check starts, cancellation behaves exactly as documented above.
   */
  app.post('/api/agency/builds/:id/cancel', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    await hydrated;
    const job = jobOr404(req, res);
    if (!job) return;
    if (!job.done) job.controller.abort();
    const body = { build: job.snapshot } satisfies AgencyBuildResponse;
    res.status(202).json(body);
  });

  // Not consumed by the daemon itself (`server.ts` calls this for its side effect of mounting
  // routes), only by a caller that needs to know a background `persist()` write has actually
  // reached disk — a test removing this store's directory in its own cleanup, for instance.
  //
  // Waits for `inFlightBuilds` BEFORE the store: a caller that only awaited the 202 from
  // `POST /api/agency/build` (or `/fork`) — never polled the build to a terminal status — has no
  // guarantee `persist()` was even CALLED yet, since that 202 is sent before `startBuild`'s
  // detached task starts `runBuild`. Draining the store first would race that task exactly the
  // way `rmSync` used to race `persist()` itself. The loop repeats once more if either wait left
  // new work behind — a build that started (or a save that got enqueued) while this was waiting
  // on the other — so this always returns with both empty, not merely once-empty.
  const idle = async (): Promise<void> => {
    for (;;) {
      while (inFlightBuilds.size > 0) await Promise.allSettled([...inFlightBuilds]);
      await store.idle();
      if (inFlightBuilds.size === 0) return;
    }
  };
  return { idle };
}
