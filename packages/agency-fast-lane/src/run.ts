/**
 * The fast lane orchestrator.
 *
 * Spine in, brief in. The model fills the editable text, either in one streamed call
 * (`single`) or in one concurrent call per unit (`sections`). Every unit that lands is merged
 * into the spine, validated and rendered by the family compiler in-process, and saved to the
 * project, so the canvas paints progressively. A unit the validator refuses, or that came back
 * with text missing, is repaired once with the validator's message.
 */

import { RenderQualityError, type RenderQualityReport } from './render-quality.ts';
import { duplicateVariableItems } from './sparse-content.ts';
import { addUsage, transportRetryReasonOf, type ModelCall, type ModelRequest, type ModelResponse, type TransportRetryReason, type Usage } from './deepseek.ts';
import type { ArtifactManifest, FamilyPackage, RenderResult } from './family.ts';
import { assertPageBudget, mergeEffectsResult, renderWithEffects, resultOfPlan, type EffectPlan, type EffectsResult } from './effects.ts';
import { templateChromePaths } from './template-chrome.ts';
import { briefHoursRowsQuote, claimRepairHint, hoursLabelRepairHint, hoursNullRepairHint, withoutUntracedClaims } from './repair-hints.ts';
import { deterministicExactDateFlags } from './exact-date.ts';
import { deterministicHoursNullFlags, normalizeHoursRowSeparator } from './hours-label.ts';
import { collectFaithfulnessSlots, deterministicAttributionFlags, deterministicClaimFlags, deterministicCommercialWordFlags, deterministicContactFlags, deterministicDestinationFlags, deterministicHoursLabelFlags, deterministicProperNounFlags, deterministicQuoteFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags, mergeFlagsByMaxProbability, type FaithfulnessChecker, type FaithfulnessCheckResult, type FaithfulnessSlot, type FlaggedSlot } from './jev.ts';
import { HOURS_LABEL_PLACEHOLDER, HOURS_ROW_PLACEHOLDER, SYSTEM_PROMPT, buildUserPrompt, isHoursPlaceholder } from './prompt.ts';
import { applySectionDrops, droppedSectionIds, withoutDroppedSections } from './sections.ts';
import type { ProjectPublisher } from './publish.ts';
import { altTextPathsFor, exactDatePathsFor, arrayMinimaFor, arrayMinimaPathsOf, atomKindsFor, droppableListPathsFor, clipToLimits, contactPathsFor, destinationPathsFor, editableTemplate, fromModelShape, getAtPath, hoursGroupsFor, hoursLabelPathsFor, hoursNullPathsFor, hoursRowValuePathsFor, isObject, siblingPathsFor, labelPathsFor, limitsFor, mergeAtPath, mockPathsFor, personNamePathsFor, quotePathsFor, shapeOfPaths, nullablePathsOf, pathLabel, softLimits, toModelShape, traceablePathsFor, unchangedTextPaths, unitsOf, type ContactKind, type Json, type JsonObject, type MergeReport, type Unit } from './spine.ts';

import { SectionStream, parseJsonObject } from './stream.ts';
import {
  fillSectionAdapter,
  fixtureSectionIdsOf,
  resolveAnchorOffset,
  resolveDesignDirection,
  resolveSectionAdapter,
  SectionSelectionRefusedError,
  wrapFamilyPackageForOverlay,
  type DesignDirection,
  type SectionAdapter,
  type SectionSelection,
} from './section-overlay.ts';
import type { CompositionResult } from './block-compose.ts';
import { publicSectionEntryId } from './cult-public-ids.ts';

export type FastLaneMode = 'single' | 'sections';

/**
 * Why a faithfulness check did not complete, as the `verify` EVENT reports it.
 *
 * A fixed code, never the underlying message. The event is public — `buildSite` widens it into
 * `BuildEvent` and 6b streams it to a browser — and the message behind a skip is whatever the
 * transport, the platform or a third-party service put in it. `RunReport.verify.skipped` keeps the
 * detail for the operator running the build, where it is already sanitised at the source
 * (`jevErrorMessage`) and goes no further than a console summary and a `--report` file.
 *
 * Which code applies follows from how `createJevChecker` reports each failure, which is not
 * symmetrical and is worth stating rather than re-deriving: it THROWS when Jev answers the first
 * batch with an error (`jevErrorMessage(status)`, already sanitised), and RETURNS a `skipped`
 * result when the request could not be completed at all — a dropped socket, a timeout. So a throw
 * means Jev was reached and said no, and a returned skip means it was not reached. The one seam is
 * a later batch answering non-2xx after earlier ones succeeded: the checker returns that rather
 * than throwing, so it is reported as unavailable although Jev did answer. It is a two-value code
 * for an operator's triage, not a protocol, and that case keeps the rest of the check's findings.
 */
export type VerifySkipReason =
  /** The request could not be completed: a network failure, a timeout, a batch that never landed. */
  | 'jev-unavailable'
  /** Jev was reached and answered with an error. */
  | 'jev-refused'
  /**
   * `verifyAfterPublish` only: the run's signal fired while the deferred check was still in
   * flight. The page has already published by this point — nothing to roll back — so the run
   * still completes normally; this is why the verdict is `skipped` rather than `done`, instead of
   * quietly reporting a check that never actually finished as if it had. Every other verify mode
   * still unwinds the whole run on a real cancellation (see `isRunCancellation` and the ordinary
   * verify block above), so this code never appears there.
   */
  | 'cancelled';

/**
 * Why a unit is being asked for again — a fixed classification, never the words of whatever
 * refused it.
 *
 * The `repair` event is part of this run's public event union, which `buildSite` widens into
 * `BuildEvent` and the daemon streams to a browser. The message behind a repair cannot go there:
 * a validator's complaint can quote the value it refused, a JSON parse error carries a snippet of
 * the raw answer, and a faithfulness repair names the fabricated slot text outright. All three are
 * model-generated content this package must not republish. The message is still available where it
 * is safe: it is what a run that finally gives up throws, and `onCall` hands the whole prompt and
 * answer to a debug sink that already sees everything.
 */
export type RepairReason =
  /** The family compiler refused the filled unit (bad markup, a value its schema does not allow). */
  | 'invalid'
  /** The answer left required text empty or missing. */
  | 'incomplete'
  /** The answer was not the shape the template asked for, or was not valid JSON at all. */
  | 'malformed'
  /** Jev flagged the unit for stating a fact the brief does not contain. */
  | 'unfaithful';

/** One fixed phrase per reason, for a caller that prints the event. Safe to show anywhere. */
export const REPAIR_REASON_TEXT: Record<RepairReason, string> = {
  invalid: 'the family compiler refused the filled unit',
  incomplete: 'required text came back empty',
  malformed: 'the answer was not the shape the template asked for',
  unfaithful: 'the answer states a fact the brief does not contain',
};

export type RunEvent =
  | { type: 'render-quality'; report: RenderQualityReport }
  | { type: 'assets'; count: number; ms: number }
  | { type: 'first-token'; ms: number }
  | { type: 'unit'; label: string; ms: number; repairs: number }
  | { type: 'merged'; label: string; ms: number }
  | { type: 'paint'; count: number; ms: number; label: string }
  | { type: 'repair'; label: string; reason: RepairReason }
  | { type: 'clipped'; label: string; paths: string[] }
  /**
   * A composed block's faithfulness repair answer was thrown away and the previous fill kept, so the
   * next check re-flags the same slots (B-113). `reason` is the fixed code (`malformed`: not
   * parseable; `invalid`: the block failed validation or cut a word). `detail` is the validator's
   * own message: generated text, so it stays server-side and is never copied to a client.
   */
  | { type: 'repair-discarded'; label: string; round: number; reason: RepairReason; detail: string }
  /**
   * A unit's model call hit a transport-class failure (a network reset before or after the first
   * byte, an undici `terminated`, an exhausted 429/5xx with no output consumed, or a pre-output
   * timeout — see `transportRetryReasonOf`) and `callModel` is retrying it fresh, to the SAME
   * provider, before giving up on the unit. `attempt` counts re-requests for this unit LABEL across
   * the whole build (its fill call and every later repair call together, not per `callModel`
   * invocation), 1 or 2 (see `TRANSPORT_RETRY_LIMIT`). Emitted for every re-request, including one
   * that used to be a provider's own silent internal retry (`build.ts` disables those on every
   * path). Never emitted for a refusal or a content error; for a failure after the stream had
   * already delivered a byte, only when `transportRetryReasonOf` recognizes the cause AND — for the
   * single-page call, the one whose `onDelta` merges mid-stream — nothing has merged yet this call
   * (`ModelRequest.hasMergedOutput`). Never a provider failover — see `failover.ts`.
   */
  | { type: 'transport-retry'; label: string; attempt: number; reason: TransportRetryReason }
  /**
   * `run.ts`'s `applyUnit` rewrote an hours-row slot's own merged text to a punctuation form the
   * unchanged deterministic hours gate already accepts for the SAME brief row — never a different
   * row, never a different day or time (see `normalizeHoursRowSeparator` and the paired
   * label/value prefix-strip, both in `applyUnit`). Emitted once per rewrite, so a reader can see
   * exactly which slot changed and how; counts toward nothing and hides nothing, the same as
   * `transport-retry`. The published text is still checked by the unchanged gate and by Jev.
   */
  | { type: 'hours-normalized'; label: string; path: string; before: string; after: string }
  /**
   * `flaggedPaths`/`remainingPaths` are the same slots as `flagged`/`remaining` (which stay
   * counts, for every existing caller that already reads them), as path labels — added for
   * `verifyAfterPublish`, whose caller (the daemon build job) has to remember exactly which slots
   * to re-fill on a later repair pass and has no other way to learn them mid-run. Populated on
   * every `verify` event, not only a deferred one, so nothing has to branch on `verifyAfterPublish`
   * to read them.
   */
  /**
   * `checked` counts fact slots only; `illustrative` counts the slots the family marks `x-mock`
   * (sample data shown under a visible caption), which the gate skips and never flags.
   */
  | { type: 'verify'; checked: number; illustrative: number; flagged: number; repaired: number; remaining: number; ms: number; skipped?: VerifySkipReason; flaggedPaths?: string[]; remainingPaths?: string[] }
  | { type: 'registered'; ms: number }
  /**
   * `verifyAfterPublish` only: the page has just been published (or, in a dry run, would have
   * been) and the faithfulness check has not run yet — see that option on `RunOptions`. `url` is
   * the registered project's id and entry path (`<projectId>/<entry>`), or, when there is no
   * publisher at all, just `entry`. Always the event right before `verify` in this mode; never
   * emitted in any other mode.
   */
  | { type: 'preview'; url: string; ms: number };

export type RunOptions = {
  pkg: FamilyPackage;
  brief: string;
  mode: FastLaneMode;
  entry: string;
  revision: number;
  model: ModelCall;
  modelName: string;
  /**
   * The model answering right now, when that can change mid-run: `build.ts` passes the failover
   * wrapper's `active()` here, so the published state note and the report name the secondary's
   * model after a failover rather than the primary's. Defaults to `modelName`.
   */
  activeModelName?: () => string;
  /** A recipe to re-target. Defaults to the package's reference recipe. */
  spine?: JsonObject;
  /**
   * The recipe this project is re-targeting FROM — its current, already-published manifest, or
   * whatever else the caller resolves as "what was here before this build" (see `build.ts` and
   * `cli.ts`'s `--previous`). When given, every text slot whose value is identical between this
   * and `spine` is folded into `lockedPaths` (via `unchangedTextPaths`), so a re-target that
   * changes 3 of 40 slots fills and verifies only those 3 plus any explicit `lockPaths` — never
   * the whole recipe. Absent on a first build (no prior recipe), where every slot still ships,
   * exactly as before this option existed.
   */
  previousRecipe?: JsonObject;
  /** Text slots to keep from the spine, as path labels such as `brand.name`. */
  lockPaths?: string[];
  /**
   * Optional sections to drop before the fill, by id (see `sections.ts`): each slot becomes `null`,
   * so the section gets no unit, no model call, no faithfulness slot and no markup, and its nav
   * slots are locked. Throws when an id is not optional in this family. A `null` the spine already
   * holds stays dropped whether or not it is listed here.
   */
  dropSections?: string[];
  /** Sections the spine holds `null` for that take the reference recipe's section back. */
  restoreSections?: string[];
  publisher?: ProjectPublisher;
  /** Faithfulness gate, run once after every unit is filled and merged, before registration —
   * unless `verifyAfterPublish` moves it, see there. */
  verify?: FaithfulnessChecker;
  /**
   * Fail closed: while `verify` finds any flag remaining, was skipped, or left a slot unchecked
   * as oversized, nothing is published — no project, no assets, no pages, no state files. On a
   * pass, `ensurePublisher` (never `publisher`) creates the project and everything is published
   * at once. Requires `verify` to be set; `publisher` is ignored during the run either way.
   */
  strict?: boolean;
  /**
   * The verify-after-render play (`--verify-mode after`, `verify-policy.ts`): publish first, check
   * second, never blocking. With this set, the fill's own faithfulness pass (the one every other
   * mode runs before registering) is skipped; instead, once the page is registered (or, dry run,
   * would have been), a `preview` event fires with the private preview's url, then ONE
   * faithfulness check runs and reports as the usual `verify` event and `RunReport.verify` — but
   * with no in-run repair attempt: a flagged slot is left exactly as filled (`repaired: 0`,
   * `remaining` equal to `flagged`), because a caller that asked to publish before checking has
   * already decided a flag must not silently rewrite what it just published. Re-filling flagged
   * slots is a distinct, later pass — see `POST /api/agency/builds/:id/repair` in the daemon. A
   * failure of the check itself (Jev unreachable, or the run cancelled while the check was still
   * in flight — `skipReason: 'cancelled'`, see `VerifySkipReason`) is folded into `verify.skipped`
   * rather than thrown, because by this point the page is already published and this option's
   * whole point is that a check failure must never undo that: `POST /api/agency/builds/:id/cancel`
   * is effectively a no-op once the deferred check has started — nothing is left to roll back, and
   * the build still finishes and reports `done`. Mutually exclusive with `strict` by construction
   * (`build.ts` derives both from one `VerifyMode` string) — never validated here.
   */
  verifyAfterPublish?: boolean;
  /**
   * Called only on a strict pass, once, to create (or resolve) the project to publish to.
   * `created` tells the deferred publish whether this run made the project (so a failure after
   * this point should delete it again) or reused one given by the caller (so it should not).
   */
  ensurePublisher?: () => Promise<{ publisher: ProjectPublisher; created: boolean }>;
  onEvent?: (event: RunEvent) => void;
  /** Receives every prompt and raw answer, for debugging a refused unit. */
  onCall?: (call: { label: string; attempt: number; prompt: string; answer: string }) => void;
  /** Technical repairs per unit: a refused, incomplete or malformed answer is asked for again this
   * often. Default 2 (see `runFastLane`'s own default below), raised from 1 after a live G8 build
   * matrix run (repo pre-1dc67a1135, wrenfield x cerebras) hit a unit whose one technical repair
   * attempt ALSO came back with a required field empty and failed the whole build. A replay of 29
   * more builds against the same brief and provider did not reproduce that double failure: 3 of the
   * 29 had one unit (trust once, wrenfield-footer twice) whose first answer came back incomplete,
   * and each was fixed by its first repair; no unit needed a second. (The #123 commit message says
   * 33 replay builds; the saved replay has 29.) So the second attempt is a bounded safety margin
   * against an occasional empty or malformed answer, not a measured fix. The daemon (the only
   * caller that reaches this path live) never overrides this option, so its default is what every
   * live build gets. The requirement itself (non-empty, valid, faithful text) is unchanged; this
   * only gives the model one more chance to meet it before the build gives up. */
  maxRepairs?: number;
  /**
   * Faithfulness repair rounds (default 2), a budget separate from `maxRepairs`. Each round asks
   * every flagged unit once to delete, null or neutrally reword its flagged slots — every other
   * path stays locked — and then runs a fresh check. The loop stops as soon as a check comes back
   * with nothing flagged. A round's answer that fails technical validation may still use the
   * `maxRepairs` budget. The same value bounds `sectionSelection`'s own gate (see
   * `fillSectionAdapter`'s option of the same name in `section-overlay.ts`); has no extra effect
   * without a `sectionSelection`.
   */
  maxFaithfulnessRounds?: number;
  /**
   * The whole fill-and-repair phase's deadline, in ms from the start of the run (default
   * `DEFAULT_FILL_DEADLINE_MS`): every model call — the fill, each technical repair and each
   * faithfulness repair — is aborted once it passes, and the run fails with `UnitDeadlineError`
   * naming the unit whose call was cut off. A provider that stops answering can no longer hold a
   * build open until its own transport timeout.
   */
  deadlineMs?: number;
  /** One model call's own time limit, in ms (default `DEFAULT_CALL_TIMEOUT_MS`); see `deadlineMs`. */
  callTimeoutMs?: number;
  /**
   * How many extra fresh attempts a transport-class failure earns the SAME unit, to the same
   * provider, before `callModel` gives up on it (default 2, capped at 2 regardless of this
   * value). This is the ONE budget for the whole build: it is shared across a unit's fill call
   * and every later repair call for that same unit (tracked by `request.label` in a build-wide
   * map, not reset per `callModel` invocation) — see `TRANSPORT_RETRY_LIMIT`'s own doc. A caller
   * that passes an explicit `--max-retries` (`cli.ts`) sets this, not the provider's own internal
   * retry count, which is always 0: `build.ts` never lets a model caller retry silently
   * underneath this budget, on any path.
   */
  transportRetryLimit?: number;
  /**
   * Cancels the run. It reaches every model call and every daemon write, and is checked between
   * the run's steps, so an abort ends the run at the next await rather than at the next timeout.
   * The run then throws an `AbortError` — but only once every unit still in flight has settled and
   * every save already on the wire has finished, because a caller that deletes the project it
   * created on a cancellation must never race a write that is still arriving.
   */
  signal?: AbortSignal;
  now?: () => number;
  /**
   * One selectable section on top of this build's fixed family recipe (design decision §2/§3:
   * <private-notes>/mishh-genui-production/motionsites/sol-design.md).
   * Site families only (a family whose recipe carries `sections` in the shape
   * `wrapFamilyPackageForOverlay` reads); an unknown entry id, an unknown direction id, or an
   * absent/ambiguous anchor throws `SectionSelectionRefusedError` (`section-overlay.ts`) rather
   * than silently skipping the selection. Filled once, verified against `brief` only, and
   * composed into `latest`/the published page after the family's own fill+verify has completed —
   * see `section-overlay.ts`'s module doc for why this is one dedicated call rather than one unit
   * folded into the page-level call.
   */
  sectionSelection?: SectionSelection;
  /**
   * Untrusted layout/typography/motion cues (e.g. text fetched from a MotionSites prompt) passed
   * to the section's own fill prompt as guidance only. Never reaches `verify`, never appears in
   * `RunReport`, and never reaches `onCall` (below), a build record, a debug dir or a log: the
   * section fill prompt is built as two separate strings (`section-overlay.ts`'s
   * `adapterPrompts`) — the one actually sent to the model transport, and the one `onCall`
   * receives, in which the guidance block's content is always replaced by the fixed marker
   * `DESIGN_REFERENCE_WITHHELD_MARKER` ("[design reference withheld]"). See
   * `tests/section-overlay-design-reference.test.ts` for the standing proof and
   * `section-overlay.ts`'s module doc comment on the boundary this option must never cross.
   */
  designReference?: string;
  /** Model call for the section fill, when it should differ from `model` (e.g. a different
   * failover target). Defaults to `model`. */
  sectionOverlayModel?: ModelCall;
  /**
   * The effect plan (`effects.ts`, decided by `build.ts`'s `planEffects` before the fill). Passed
   * to EVERY render — the spine render, each progressive paint, the strict publish — and, with a
   * `sectionSelection`, applied after the selected section composes: the overlay's wrapper hands
   * the plan to the family compiler, and the page budget is enforced on the composed page
   * (`renderWithEffects`). The compiler emits all effect markup.
   */
  effects?: EffectPlan;
  /** The decision's own result (skips, `jevSkipped`, mode), which `RunReport.effects` merges the
   * final render's report into. Defaults to one derived from `effects` alone. */
  effectsDecision?: EffectsResult;
};

export type UnitReport = { label: string; ms: number; firstTokenMs?: number; repairs: number };

export type RunReport = {
  family: string;
  mode: FastLaneMode;
  model: string;
  entry: string;
  revision: number;
  projectId?: string;
  timings: {
    assetsMs?: number;
    firstTokenMs?: number;
    firstPaintMs?: number;
    finalPaintMs?: number;
    registeredMs?: number;
    totalMs: number;
  };
  calls: number;
  repairs: number;
  /** Total transport-level retries (rate limits, transient server errors) across every call. */
  retries: number;
  paints: number;
  usage: Usage;
  applied: number;
  missing: string[];
  /** Nullable slots the model answered with null: a fact the brief does not state. */
  nulled: string[];
  /** Text slots cut at a word boundary after the model overran a limit twice. */
  truncated: string[];
  /** Optional sections this page does not render (`null` in the recipe), by id. */
  droppedSections?: string[];
  units: UnitReport[];
  recipeDigest: string;
  recipe: Json;
  html: string;
  manifest: ArtifactManifest;
  approvedAssets: RenderResult['approvedAssets'];
  /** Structural output checks; separate from factual verification and visual evaluation. */
  renderQuality?: RenderQualityReport;
  verify?: {
    provider: 'jev';
    checked: number;
    /** Filled slots the family marks `x-mock` (illustrative sample data): skipped, never flagged. */
    illustrative: number;
    flagged: string[];
    repaired: number;
    remaining: string[];
    ms: number;
    skipped?: string;
    /** Paths left unchecked because they were too large for Jev even alone with the brief. */
    oversized?: string[];
    /**
     * Composed pages: the published text of each slot in `remaining` (capped), so a failed build
     * says what was flagged, not only where. Generated text: server-side only (B-113).
     */
    remainingTexts?: Array<{ path: string; text: string }>;
  };
  /**
   * Set only when `strict` was requested: whether the gate passed and, on a run, why it did not.
   * `checked` is set on a pass, explicitly, even when it is 0 (every editable path locked or
   * already null, so nothing needed checking) — a strict pass is never left to imply verify saw
   * something.
   */
  strict?: { passed: boolean; reason?: string; checked?: number };
  /** Set only when `options.sectionSelection` was given. `flagged`/`remaining` are the section's
   * own faithfulness slots (see `verify` above for the base recipe's); `designReference` is never
   * present here or anywhere else in this report — see `RunOptions.designReference`. */
  sectionOverlay?: { entryId: string; directionId: string; placement: SectionSelection['placement']; flagged: string[]; remaining: string[] };
  /**
   * Set when the build asked for `composition: 'blocks' | 'auto'` (`block-plan.ts`): the plan a
   * composed page was built from (`used: 'blocks'`, from `block-compose.ts`), or the fixed reason
   * the family route ran instead (`used: 'family'`, `fallback`). Absent for `family` builds.
   */
  composition?: CompositionResult;
  /** Set when `options.effects` or `options.effectsDecision` was given: the decision merged with
   * what the final render actually applied. Ids, counts and fixed codes only. */
  effects?: EffectsResult;
};

type Outcome = { ok: true } | { ok: false; reason: RepairReason; error: string };

/** One faithfulness check, plus the fixed code for why it did not complete, if it did not. */
type CheckAttempt = FaithfulnessCheckResult & { skipReason?: VerifySkipReason };

/**
 * Whether an error is this run's cancellation rather than a failure worth reporting. The same rule
 * `buildSite` applies: the platform's own abort error, or this run's signal having fired.
 */
function isRunCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * One faithfulness check attempt against `checker`, folding a thrown failure into a `skipped`
 * result rather than letting it reject — except a cancellation, which still unwinds the run (see
 * `isRunCancellation`). Shared by the ordinary (pre-publish) verify block and `verifyAfterPublish`'s
 * deferred one, so the skip/cancel handling cannot drift between the two.
 */
/**
 * Families whose compiler copies and fixtures have been checked clean against
 * `deterministicCommercialWordFlags` — the exact-match commercial-word check (stock, shipping,
 * free, sale, discount, warranty, guarantee, rated, review, and their `POLARITY_WORDS`-rescued
 * negations) extended, per a fourth audit pass, to EVERY faithfulness slot of the family, not
 * only review quotes. Unlike `deterministicClaimFlags` (numeric claim tokens — prices, percents,
 * ratings), which is safe to run unconditionally across every bundled family since a genuinely
 * new number is always suspicious regardless of family, a commercial WORD appearing legitimately
 * in some other family's own fixed chrome or reference copy has not been swept for this
 * specifically — wiring it on unconditionally risks the exact same false-positive class
 * `LINK_HONESTY_FAMILIES` was scoped to avoid. Opt a family in only once checked.
 */
const COMMERCIAL_WORD_FAMILIES: ReadonlySet<string> = new Set(['storefront']);

/**
 * G6 (claim and name honesty in every family): `deterministicSentenceClaimFlags` used to run only
 * for the allowlisted `SENTENCE_CLAIM_FAMILIES` ('storefront', 'practice', 'guide') — every other
 * registered family's free-prose slots (a hero, a description, a CTA) had no deterministic check
 * standing between an invented claim-bearing sentence and a published page; only Jev's own
 * probabilistic judgment stood there, the same gap the allowlist was built to close for
 * storefront/practice/guide one family at a time. That allowlist is gone: this is now the SAME
 * unconditional, fail-closed-by-default shape `deterministicClaimFlags` already has (see this
 * file's own history on that constant) — a NEW family gets the check the moment it registers,
 * with no opt-in step to remember. Any false positive this surfaces belongs to the family's OWN
 * contract (an `x-label` chrome field that should have been excluded, a nullable atom, a slot that
 * should carry its own `x-verify` marker) — never to loosening `TRACEABLE_STOPWORDS` or any other
 * shared list; see `FAMILY-BRIEF.md`'s "Shared gate rule" for why that door stays shut after two
 * past drifts. `withAdapterDeterministicGates` already ran this check unconditionally for every
 * section-overlay/composed-page fill; this closes the same gap for the base page's own fill.
 */

/**
 * A path whose last segment is a nav LINK field (`links`, `links[N]`) — the ONLY shape a fifth
 * audit pass confirmed can legitimately echo the page's own section structure (a footer link
 * literally named "Shipping and returns" echoing storefront's own `shipping-returns` section
 * heading). `cta`/`ctaLabel` are deliberately excluded from this path-shape test: those are real
 * rendered purchase-button copy (the header CTA, the buy-preorder button), not section chrome,
 * and the same audit pass found that exempting them let a strict fill publish "Free shipping" or
 * "Lifetime warranty" on a buy button with zero repair triggered, since `deterministicClaimFlags`
 * alone never sees a claim with no number in it. Even a `links`/`links[N]` path is only actually
 * exempt when `navLinkMatchesSectionHeading` (below) confirms its VALUE is the page's own section
 * name — see that function's doc for why the path shape alone is not enough either.
 */
function isNavLinkPath(path: string): boolean {
  return /\.links(\[\d+\])?$/.test(path);
}

/**
 * True when `slot` is a nav-link path (`isNavLinkPath`) whose OWN VALUE literally is one of the
 * page's own rendered section headings (from `headingTexts`, collected from every `.heading`-
 * suffixed slot in the same build). A live Cerebras build proved the path-shape test alone was
 * too broad: `deterministicCommercialWordFlags` flagged a footer link reading "Shipping and
 * returns" — an honest structural label echoing the page's own `shipping-returns` section
 * heading, not a commercial claim — and exhausted its repair budget on a slot that was never a
 * fact to begin with. But a nav link's text is model-authored copy like any other slot: nothing
 * stops a fill from putting invented commercial wording ("Free shipping today") in a link the
 * model chooses not to name after any real section. Comparing the link's actual value against the
 * build's own section headings (rather than trusting the path shape blindly) keeps the escape
 * hatch scoped to the one case it exists for.
 */
function navLinkMatchesSectionHeading(slot: FaithfulnessSlot, headingTexts: ReadonlySet<string>): boolean {
  return isNavLinkPath(slot.path) && headingTexts.has(normalizeForLabelCompare(slot.text));
}

/** Trim, lowercase and collapse whitespace — used only to compare a nav link's text against a
 * section heading's text; not a general-purpose text normalizer. */
function normalizeForLabelCompare(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Every `text.heading` value anywhere in `recipe`, normalized with `normalizeForLabelCompare` —
 * the set `navLinkMatchesSectionHeading` checks a nav link's value against. Walks the RAW recipe
 * JSON directly rather than reading a `.heading`-suffixed path out of `checkSlots` (an earlier
 * version of this function did exactly that, and it was wrong): a round-9 re-audit found the
 * storefront schema marks `shipping-returns.heading` `x-label: true`, and an unchanged label is
 * dropped by `templateChromePaths`/`gateSlots` before `checkSlots` is ever built — so the ONE
 * section heading this whole mechanism exists to recognize ("Shipping and returns") was never in
 * `checkSlots` to begin with, and the nav-link exemption silently stopped firing for the exact
 * case a fourth audit pass added it for. A heading's own text is already public, rendered page
 * copy either way (chrome or not), so reading it straight from the recipe carries no faithfulness
 * risk of its own — it is used here only to decide whether a DIFFERENT slot (a nav link) is
 * exempt, never checked as a fact itself by this function.
 */
function headingTextsOf(recipe: Json): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (node: Json): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isObject(node)) return;
    const text = (node as JsonObject).text;
    if (isObject(text) && typeof (text as JsonObject).heading === 'string') out.add(normalizeForLabelCompare((text as JsonObject).heading as string));
    for (const value of Object.values(node)) walk(value as Json);
  };
  walk(recipe);
  return out;
}

function makeCheckOnce(
  checker: FaithfulnessChecker,
  brief: string,
  signal: AbortSignal | undefined,
  personNamePaths: ReadonlySet<string> = new Set(),
  quotePaths: ReadonlySet<string> = new Set(),
  family: string = '',
  contactPaths: ReadonlyMap<string, ContactKind> = new Map(),
  traceablePaths: ReadonlySet<string> = new Set(),
  // Added for `practice`. Appended after every existing positional argument rather than reusing
  // one of the slots above, so an existing call site that has not yet adopted these two checks
  // keeps compiling and behaving exactly as before (both default to the empty set, under which
  // `deterministicDestinationFlags`/`deterministicHoursLabelFlags` flag nothing at all).
  destinationPaths: ReadonlySet<string> = new Set(),
  hoursLabelPaths: ReadonlySet<string> = new Set(),
  // G6: slots the family schema marks `x-alt-text` — image alt text and photo captions, exempt
  // ONLY from the two checks below (`deterministicSentenceClaimFlags`/`deterministicProperNounFlags`),
  // never from Jev or any other deterministic check. See `spine.ts`'s `altTextPathsFor` for why
  // this is its own marker, not `x-mock`.
  altTextPaths: ReadonlySet<string> = new Set(),
  // G8 dry run: `x-verify: 'exact-date'` slots (halcyon's event dates) — checked by
  // `exact-date.ts`'s whole-value equality to a brief date INSTEAD of the two prose checks below,
  // which can never pass a verbatim abbreviated date. See `spine.ts`'s `exactDatePathsFor`.
  exactDatePaths: ReadonlySet<string> = new Set(),
  // G8 final: hours-label path -> its row's value path (`x-hours-value`), read from `recipe` (the
  // value may be template chrome and so absent from `checkSlots`). See `hours-label.ts`.
  hoursRowValuePaths: ReadonlyMap<string, string> = new Map(),
  // PR #137: each hours group's label paths (`x-hours-group`: every row or none), and the
  // `x-verify: 'hours-null'` slots (always null). See `hours-label.ts`.
  hoursGroups: ReadonlyMap<string, readonly string[]> = new Map(),
  hoursNullPaths: ReadonlySet<string> = new Set(),
) {
  return async (checkSlots: FaithfulnessSlot[], sectionHeadingTexts: ReadonlySet<string> = new Set(), recipe?: Json): Promise<CheckAttempt> => {
    // Deterministic checks, independent of Jev: computed first and merged into whatever Jev
    // returns (including a skip or a thrown error — a fact Jev never got to judge must still be
    // flagged), never gated on the LLM call's own success. See `deterministicAttributionFlags`
    // and `deterministicQuoteFlags`'s own docs for why these cannot be LLM-judgment-only.
    //
    // `deterministicClaimFlags` runs on EVERY slot (`allSlotPaths`), for every family — a fourth
    // audit pass found price, shipping, hero and description slots were entirely outside the
    // deterministic gate on a live build (only `x-verify: quote` slots were ever checked), so a
    // strict build whose Jev score landed under the repair threshold could publish an invented
    // price or rating anywhere on the page. `deterministicCommercialWordFlags` is the same idea
    // for commercial WORDS rather than numbers, scoped to `COMMERCIAL_WORD_FAMILIES` — see that
    // constant's own docblock for why it is not unconditional the way the numeric check is.
    const allSlotPaths = new Set(checkSlots.map((slot) => slot.path));
    // A fifth audit pass narrowed the nav-label exemption from a path-shape test to a value test:
    // only a `.links`/`.links[N]` slot whose OWN TEXT literally is one of this build's own section
    // headings is exempt (`navLinkMatchesSectionHeading`) — `cta`/`ctaLabel` are never exempt (see
    // `isNavLinkPath`'s doc), and a link that does not name a real section stays checked like any
    // other slot. `sectionHeadingTexts` is a PARAMETER, not computed from `checkSlots` here — see
    // `headingTextsOf`'s own docblock for why reading it from `checkSlots` was the actual round-9
    // regression (a chrome-excluded heading is invisible to `checkSlots` but must not be invisible
    // to this comparison).
    // See `deterministicProperNounFlags`'s call below for why this excludes every path already
    // covered by a dedicated, more specialized deterministic check, PLUS `altTextPaths` (image
    // alt text/photo captions — see `spine.ts`'s `altTextPathsFor` for why this is scoped out of
    // the generic prose heuristic specifically, not out of Jev or any other deterministic check).
    // G8 final: `hoursLabelPaths` is NOT excluded here any more. The hours-label marker only ADDS
    // the row check (`hours-label.ts`); an hours label still faces this gate like any other prose,
    // so marking a slot can never turn a proper-noun flag into a pass.
    const properNounPaths = new Set([...allSlotPaths].filter((path) => (
      !personNamePaths.has(path) && !quotePaths.has(path) && !traceablePaths.has(path)
      && !destinationPaths.has(path) && !contactPaths.has(path)
      && !altTextPaths.has(path) && !exactDatePaths.has(path)
    )));
    // Same `altTextPaths` exclusion for the sentence-claim gate — an alt-text/caption field is
    // still checked by every OTHER deterministic gate above (`deterministicClaimFlags`,
    // `deterministicContactFlags`, …) and by Jev itself; only these two G6 checks skip it.
    const sentenceClaimPaths = new Set([...allSlotPaths].filter((path) => !altTextPaths.has(path) && !exactDatePaths.has(path)));
    const deterministicFlags = [
      ...deterministicAttributionFlags(brief, checkSlots, personNamePaths),
      ...deterministicQuoteFlags(brief, checkSlots, quotePaths),
      ...deterministicTraceableFlags(brief, checkSlots, traceablePaths),
      // Added for `practice` (see `spine.ts`'s `destinationPathsFor`/`hoursLabelPathsFor` for why
      // these are their own markers rather than folded into an existing one).
      ...deterministicDestinationFlags(brief, checkSlots, destinationPaths),
      // The hours table is judged whole: an incremental run's locks keep unchanged labels out of
      // `checkSlots`, and a group judged on part of its rows flags a correct table (Sol r2 W1).
      ...deterministicHoursLabelFlags(brief, withRecipeHoursSlots(checkSlots, hoursLabelPaths, recipe), hoursLabelPaths, hoursRowValuePaths, (path) => (recipe === undefined ? undefined : textAtPathLabel(recipe, path)), hoursGroups),
      ...deterministicHoursNullFlags(checkSlots, hoursNullPaths),
      ...deterministicClaimFlags(brief, checkSlots, allSlotPaths),
      // A round-10 audit pass (storefront-r6-grok.md FIX 5) found a buy URL, email or hyphenated
      // phone was never required to occur in the brief at all — `dishonestLinks` only checks a
      // link resolves to SOMETHING real, never that it is the BRIEF'S OWN; see
      // `deterministicContactFlags`'s own docblock.
      ...deterministicContactFlags(brief, checkSlots, contactPaths),
      // A round-11 audit pass (storefront-r7-grok.md, item B — "stop adding phrasings one at a
      // time") replaced the open-vocabulary approach with a structural one: every claim-bearing
      // SENTENCE (a digit, a number word, a currency/percent/star mark, or a commercial stem) in
      // a free-prose slot must fully trace to the brief. G6 removed the old opt-in allowlist
      // (`SENTENCE_CLAIM_FAMILIES`) that used to scope this to storefront/practice/guide — this
      // now runs unconditionally, for every registered family, the same shape
      // `deterministicClaimFlags` above already has.
      ...deterministicSentenceClaimFlags(brief, checkSlots, sentenceClaimPaths),
      ...deterministicExactDateFlags(brief, checkSlots, exactDatePaths),
      // G6: every capitalized proper-noun token in free prose (not sentence-initial, not
      // `x-label` chrome — both already excluded from `checkSlots` itself) must appear in the
      // brief or the bundled ESDB wordlist — see `deterministicProperNounFlags`'s own docblock.
      // Unconditional for every family, same as the sentence-claim gate above. Scoped to
      // `properNounPaths`, not `allSlotPaths`: `personNamePaths`/`quotePaths`/`traceablePaths`/
      // `destinationPaths`/`contactPaths` already carry their OWN dedicated, stricter
      // deterministic check for exactly this kind of atom (a name, a quote, a practical fact, a
      // destination, a contact detail) — this generic prose heuristic is not tuned for those
      // specialized shapes. G8 final: hours-row day labels are NOT in that list any more (see
      // `properNounPaths` above): their row check is added on top, so a day abbreviation such as
      // "Mon" still flags here, and the fill prompt asks for the brief's own day words instead.
      // A false positive this surfaces elsewhere belongs to the family's own contract (add the
      // slot to one of those marker sets, or exclude it as chrome) — never to widening the shared
      // wordlist or stopword lists.
      ...deterministicProperNounFlags(brief, checkSlots, properNounPaths),
      // A round-11 audit pass FIX item found this exact-match denylist check collides with the
      // Porter-stemmed `deterministicTraceableFlags` now covering the SAME slots (shipping-
      // returns' body, item A): "ships" in the brief correctly licenses "shipping" on the page
      // under plain stemming, but this check's own unstemmed exact-match rule (needed elsewhere
      // to stop a "stocking" collision — see `COMMERCIAL_DENYLIST_WORDS`'s own docblock) does not
      // know that and flags "shipping" anyway. `traceablePaths` is excluded from this check's
      // scope: a slot marked traceable already gets a STRICTER, full-content-word-stemmed trace,
      // so this narrower single-word check adds no coverage there, only a stemming false
      // positive the traceable check itself does not have.
      ...(COMMERCIAL_WORD_FAMILIES.has(family)
        ? deterministicCommercialWordFlags(
            brief,
            checkSlots,
            new Set(checkSlots.filter((slot) => !navLinkMatchesSectionHeading(slot, sectionHeadingTexts) && !traceablePaths.has(slot.path)).map((slot) => slot.path)),
          )
        : []),
    ];
    // When Jev and a deterministic check both flag the same path, keep the HIGHER probability —
    // see `jev.ts`'s `mergeFlagsByMaxProbability` docblock for why "Jev already has this path so
    // skip it" is wrong (it can keep a softer LLM score over a deterministic check's certainty).
    const mergeAttribution = (flagged: import('./jev.ts').FlaggedSlot[]): import('./jev.ts').FlaggedSlot[] =>
      mergeFlagsByMaxProbability(flagged, deterministicFlags);
    // Give Jev the same narrow context the deterministic hours-row gate already has, for exactly
    // its slots — see `noulQuestion`'s own docblock for the G8 final root cause this answers (an
    // hours-row day range or status names none of the fact categories Jev's own generic question
    // asks about, and Jev's judgment on them was noisy searching the whole brief for a shape the
    // rubric never names). Every other slot's question is unchanged.
    // Round 2 audit (Sol FIX): the context used to pre-assert what the candidate text is NOT
    // ("never a contact detail, price, award, credential or place") before Jev had judged it, and
    // named a "<days> <status>" shape the rule itself rejects (a bare-space reorder — see
    // `HOURS_LABEL_RULE`). Neutral now: it states only what the slot is FOR — this group's rows of
    // the brief's own opening-hours clause — and the two forms the rule actually accepts, without
    // asserting anything about what the candidate contains.
    const hoursContext = hoursLabelPaths.size === 0 ? undefined
      : `Context: this text fills an hours-row slot on the page — a day range, a status word, or a combined row built from ONE row of the brief's own opening-hours clause, either in that row's own word order or as "<days>, <status>" when the row itself states the status first. Check it only against that clause, not the rest of the brief: ${briefHoursRowsQuote(brief)}`;
    // Every slot in `checkSlots` is still sent, unchanged in count and text — this only attaches
    // `context` to the ones `hoursLabelPaths` names, it never removes or reorders a slot.
    const contextualizedSlots = hoursContext === undefined ? checkSlots
      : checkSlots.map((slot) => (hoursLabelPaths.has(slot.path) ? { ...slot, context: hoursContext } : slot));
    try {
      const result = await checker.checkFaithfulness({ brief, slots: contextualizedSlots });
      // A returned skip is the checker saying it could not complete the request — see
      // `VerifySkipReason` for why that is the unreachable case and a throw is the answered one.
      const merged = { ...result, flagged: mergeAttribution(result.flagged) };
      return merged.skipped === undefined ? merged : { ...merged, skipReason: 'jev-unavailable' };
    } catch (error) {
      // A cancellation is not an advisory skip and must not be turned into one. The caller decides
      // what to do with a cancellation from here — the ordinary block lets it unwind the run, and
      // `verifyAfterPublish` never re-throws past the point the page has already published.
      if (isRunCancellation(error, signal)) throw error;
      // A throw is Jev having answered with an error; the message is already sanitised. The
      // deterministic attribution check ran independently above and still applies — an invented
      // name is flagged whether or not the LLM judge itself was reachable.
      return { flagged: deterministicFlags, ms: 0, calls: 0, skipped: error instanceof Error ? error.message : String(error), skipReason: 'jev-refused' };
    }
  };
}

/** Synthetic flagged-slot path for a dishonest href `dishonestLinks` reports — not a real recipe
 * path (no unit in the page owns "a link"), so the faithfulness repair loop's per-unit mapping
 * never matches it and it always survives to `remaining`, correctly fail-closing a strict build
 * the same way any other unrepairable flag does. Distinct per href so two dishonest links are two
 * separate flags, not one that disappears once either is fixed. */
function linkHonestyPath(href: string): string {
  return `__link_honesty__[${JSON.stringify(href)}]`;
}

/**
 * Every bundled site family's compiler copy carries the same shared `sections.ts` (so
 * `pkg.checkLinkHonesty` is defined for all of them). This USED to be scoped to an allowlist
 * (`LINK_HONESTY_FAMILIES`, originally just `['storefront']`) while several families still shipped
 * `href="#"` placeholder links in nav/footer chrome that predated the gate. G5 (link honesty in
 * every bundled family) swept every family's templates and reference fixtures clean of that
 * placeholder pattern — see `link-honesty-all-families.test.ts`, which renders every family in
 * the registry and asserts `dishonestLinks` returns nothing — so the check now runs live for
 * every family unconditionally: the only remaining gate is whether the family's compiler copy
 * exposes `checkLinkHonesty` at all (`undefined` only for a hand-built test package, or a copy
 * that predates the gate entirely).
 */

/**
 * Folds `pkg.checkLinkHonesty`'s findings on the CURRENT rendered page into an already-computed
 * flagged-slot list, via `mergeFlagsByMaxProbability` so a link flag never displaces a stronger
 * Jev/deterministic flag on some other path (they never collide in practice, since link paths are
 * synthetic, but the same merge helper keeps this rule in exactly one place). Runs for every
 * family whose compiler copy defines `checkLinkHonesty` (all of them, as of G5) — no allowlist.
 */
function mergeLinkHonesty(flagged: FlaggedSlot[], html: string, checkLinkHonesty: ((html: string) => string[]) | undefined): FlaggedSlot[] {
  if (!checkLinkHonesty) return flagged;
  const dishonest = checkLinkHonesty(html).map((href) => ({ path: linkHonestyPath(href), probability: 1 }));
  return mergeFlagsByMaxProbability(flagged, dishonest);
}

/**
 * Wraps a `FaithfulnessChecker` with the SAME deterministic gates the base page's own fill gets
 * from `makeCheckOnce` — `deterministicClaimFlags` and `deterministicCommercialWordFlags` — for
 * `fillSectionAdapter`'s two callers: the section-overlay fill (below, `sectionSelection`) and the
 * composed Cult-block page (`block-compose.ts`). A round-9 audit pass (storefront-r5-grok.md
 * NOTE: "Optional section-overlay fills call Jev only … and never the deterministic gates") found
 * BOTH callers pass `fillSectionAdapter` the raw checker from `options.verify` untouched, so a
 * section fill's own invented price, discount or stock claim was checked by Jev's own
 * probabilistic judgment alone — none of the deterministic checks the base page's fill already
 * gets. `fillSectionAdapter`'s own strict/repair loop is untouched by this wrapper and already
 * fails closed on whatever `flagged` carries, exactly as it does for a flag Jev raised itself, so
 * wiring the gates in here is the entire fix: no new fail-closed logic is needed at either call
 * site.
 *
 * Unlike `makeCheckOnce`, `deterministicCommercialWordFlags` runs UNCONDITIONALLY here, not scoped
 * to `COMMERCIAL_WORD_FAMILIES` — a round-10 audit pass (storefront-r6-grok.md BLOCK 3) found the
 * composed Cult-block page's `family` for this purpose is `COMPOSED_FAMILY` ('composed'), which
 * `COMMERCIAL_WORD_FAMILIES` (scoped to `'storefront'` only) never contains, so a strict composed
 * page still published "Free shipping", "Sold out." or "Lifetime warranty" whenever Jev itself
 * missed it. `COMMERCIAL_WORD_FAMILIES`'s own docblock explains why the BASE PAGE check stays an
 * opt-in allowlist (several bundled families ship pre-existing `href="#"` chrome that predates
 * that gate and would false-positive on unrelated legacy content); no such legacy surface exists
 * here — every adapter fill is fresh, small, model-authored text with no reference fixture to
 * collide with — so there is no equivalent reason to scope it per family for this narrower path.
 * `family` is kept as a parameter (used by the caller for context/telemetry, and future-proofs a
 * gate that does need per-family scoping) even though this one gate no longer reads it.
 *
 * `deterministicAttributionFlags`/`deterministicQuoteFlags` are called too, with empty path sets:
 * every current `SectionAdapter` (`ctas-1`, `feature-grids-1`, `sections-1`) declares only
 * `plain`/`phone`/`email`/`address` atoms and no `items`/`text` field that is a reviewer name or a
 * customer quote, so both are a documented no-op today — exactly like `makeCheckOnce`'s own
 * defaults when a family passes no marker paths. They are still wired in, not left out, so a
 * future adapter that adds one is covered without another audit pass finding the same gap again.
 *
 * A round-10 audit pass (FIX 4) also found deterministic flags computed AFTER `checker.checkFaithfulness`
 * resolved would be silently dropped if that call threw: the whole wrapped `checkFaithfulness`
 * promise would reject with the raw error, never reaching the merge below, exactly the failure
 * mode `makeCheckOnce` already guards against with its own try/catch. Flags are now computed
 * first, unconditionally, and a thrown checker error is folded into a `skipped` result carrying
 * them — never rethrown, and never silently empty.
 */
export function withAdapterDeterministicGates(checker: FaithfulnessChecker, family: string, signal?: AbortSignal): FaithfulnessChecker {
  void family; // kept for future per-family scoping; see this function's own docblock.
  return {
    checkFaithfulness: async (input) => {
      const allPaths = new Set(input.slots.map((slot) => slot.path));
      const deterministicFlags = [
        ...deterministicAttributionFlags(input.brief, input.slots, new Set()),
        ...deterministicQuoteFlags(input.brief, input.slots, new Set()),
        ...deterministicClaimFlags(input.brief, input.slots, allPaths),
        ...deterministicSentenceClaimFlags(input.brief, input.slots, allPaths),
        // G6: same unconditional proper-noun gate `makeCheckOnce` now runs for the base page's
        // own fill — see that call site's own docblock. No marker-path exclusion is needed here:
        // an adapter fill never declares a `person-name`/`quote`/`traceable`/`destination`/
        // `hours-label` atom of its own (see this function's docblock above).
        ...deterministicProperNounFlags(input.brief, input.slots, allPaths),
        ...deterministicCommercialWordFlags(input.brief, input.slots, allPaths),
      ];
      try {
        const result = await checker.checkFaithfulness(input);
        return { ...result, flagged: mergeFlagsByMaxProbability(result.flagged, deterministicFlags) };
      } catch (error) {
        // A cancellation is not an advisory skip (see `isRunCancellation`'s own doc, used
        // identically by `makeCheckOnce`): it must keep unwinding the run, never look like a
        // completed-but-skipped check the deterministic flags above could paper over.
        if (isRunCancellation(error, signal)) throw error;
        return { flagged: deterministicFlags, ms: 0, calls: 0, skipped: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * A strict publish failed, and removing the project this run had just created failed too, so a
 * partly-written project is still on the daemon.
 *
 * It is its own class because no caller may treat it as an ordinary publish failure. Every other
 * failure in that block leaves the daemon as it found it; this one leaves state behind that only a
 * person can clear. A build cancelled at the same moment must report this rather than reporting
 * itself cancelled over the top of it — `cancelled` promises that nothing was left behind.
 */
export class PublishRollbackError extends Error {
  readonly projectId: string;
  constructor(projectId: string, message: string) {
    super(message);
    this.name = 'PublishRollbackError';
    this.projectId = projectId;
  }
}

/** The rejection a repair attempt is built from: the classification that goes to the event and to
 * a thrown error, and the message that goes to the model — and nowhere else. */
type Rejection = { reason: RepairReason; error: string };

/**
 * The error a spent repair budget throws: the unit, and the fixed sentence for why it was refused.
 *
 * Never the message behind it. That message is a validator echoing the value it rejected, a JSON
 * parse error carrying a snippet of the raw answer, or — for a faithfulness repair — the
 * fabricated slot text itself, and this error is as public as the event stream: the CLI prints it,
 * and 6b turns it into a daemon job failure. Nothing is lost by keeping it out. `onCall` receives
 * every prompt and every raw answer, which is what `--debug-dir` writes to disk, so the detail is
 * exactly one flag away for whoever is actually debugging the unit.
 */
function repairExhausted(unit: Unit, problem: Rejection): Error {
  return new UnitRefusedError(unit.label, problem);
}

/** A slot path as a family compiler writes one at the head of its message (`sections[8].text.phone`). */
const SLOT_PATH = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]{1,4}\]|\.[A-Za-z_][A-Za-z0-9_-]*){0,12}): (.*)$/s;
/**
 * The rule half of a compiler message, kept only when it cannot be carrying model text: lowercase
 * words, digits and plain punctuation, no quotes, at most 160 characters ("expected a phone
 * number", "at most 200 characters, received 201"). A message that quotes or echoes the refused
 * value fails this and is dropped, leaving the slot path alone.
 */
const SAFE_RULE = /^[a-z0-9 ,;:()+\-\u2013.]{1,160}$/;

/**
 * The structured half of a validation refusal: the slot path and the rule, each only when it
 * matches a shape that cannot carry model-generated text. `undefined` fields mean "not safe to
 * say", never "not known" — the full message stays in `onCall`/`--debug-dir` as before.
 */
export function refusalDetail(message: string): { slot?: string; rule?: string } {
  const match = SLOT_PATH.exec(message.trim());
  if (!match) return {};
  const rule = match[2]!.trim();
  return { slot: match[1]!, ...(SAFE_RULE.test(rule) ? { rule } : {}) };
}

/**
 * What a spent repair budget throws. `message` is the same fixed sentence as before
 * (`<unit>: <reason text>`); `unit`, `reason`, `slot` and `rule` are its structured fields, for a
 * caller (the daemon's failed build record) that has to say which slot failed and why without
 * reading free text. `slot`/`rule` come from `refusalDetail`, so they carry no model output.
 */
export class UnitRefusedError extends Error {
  readonly unit: string;
  readonly reason: RepairReason;
  readonly slot?: string;
  readonly rule?: string;
  constructor(unit: string, problem: Rejection) {
    super(`${unit}: ${REPAIR_REASON_TEXT[problem.reason]}`);
    this.name = 'UnitRefusedError';
    this.unit = unit;
    this.reason = problem.reason;
    const detail = problem.reason === 'invalid' || problem.reason === 'incomplete' ? refusalDetail(problem.error) : {};
    if (detail.slot !== undefined) this.slot = detail.slot;
    if (detail.rule !== undefined) this.rule = detail.rule;
  }
}

/** Default `RunOptions.deadlineMs`: the fill-and-repair phase of one build. The slowest build that
 * finished in the run-2 ladder took 41 s end to end, so this leaves about three times that. */
export const DEFAULT_FILL_DEADLINE_MS = 120_000;
/** Default `RunOptions.callTimeoutMs`: one model call. The slowest whole-page call seen was ~40 s. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/**
 * A model call was cut off: its own time limit (`scope: 'call'`) or the run's fill deadline
 * (`scope: 'build'`) passed first. `unit` is the unit label the call was filling (`page` for a
 * whole-page call). The message is fixed and carries no model output.
 */
export class UnitDeadlineError extends Error {
  readonly unit: string;
  readonly scope: 'call' | 'build';
  readonly ms: number;
  constructor(unit: string, scope: 'call' | 'build', ms: number) {
    super(`${unit}: the model did not answer within the ${scope === 'call' ? 'per-call time limit' : 'build deadline'} (${ms} ms)`);
    this.name = 'UnitDeadlineError';
    this.unit = unit;
    this.scope = scope;
    this.ms = ms;
  }
}

/** The unit whose model call threw each provider/transport error, recorded as it passes through. */
const failedUnits = new WeakMap<object, string>();

/**
 * The unit label whose model call threw `error` — a provider or transport failure the run let
 * through unchanged (its own class is kept, so a caller's `instanceof` checks still hold) — or
 * `undefined` when the error did not come from a model call. `UnitRefusedError` and
 * `UnitDeadlineError` carry their unit themselves.
 */
export function failedUnitOf(error: unknown): string | undefined {
  if (error instanceof UnitRefusedError || error instanceof UnitDeadlineError) return error.unit;
  return typeof error === 'object' && error !== null ? failedUnits.get(error) : undefined;
}

/**
 * Awaits every promise in a concurrent step and then throws the first failure, rather than letting
 * that failure unwind the run while its siblings are still calling the model or saving files.
 * `Promise.all`'s own behaviour orphans them, which a cancelled or rolled-back run cannot afford:
 * the project it created is deleted as soon as the run throws, and an orphaned write would still
 * be arriving at it. Which error wins is unchanged — the first one to reject, not the first in
 * argument order.
 */
async function settleAll(running: Array<Promise<unknown>>): Promise<void> {
  let failure: { error: unknown } | undefined;
  await Promise.all(running.map((promise) => promise.catch((error: unknown) => { failure ??= { error }; })));
  if (failure) throw failure.error;
}

/** The technical repair budget a family build uses when the caller names none (#123). A composed
 * build (`block-compose.ts`) uses the same default (G8 dry run: it used to fall through to
 * `fillSectionAdapter`'s own default of 1, so an overflowing block had one fewer try). */
export const DEFAULT_MAX_REPAIRS = 2;

export async function runFastLane(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const since = () => Math.round(now() - startedAt);
  const emit = options.onEvent ?? (() => {});
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const maxFaithfulnessRounds = options.maxFaithfulnessRounds ?? 2;
  const { pkg } = options;
  // Strict defers every daemon write until the gate passes (see the block after `verify` below);
  // holding `publisher` to undefined for the whole fill step reuses the existing no-publisher
  // paths (assetsUpload resolves to undefined, `drain` never calls the daemon) to guarantee it.
  const publisher = options.strict ? undefined : options.publisher;

  const base = structuredClone(options.spine ?? pkg.fixture);
  base.revision = options.revision;
  base.family = pkg.family;
  base.schemaVersion = pkg.fixture.schemaVersion ?? 2;
  // A `replace-optional` selection nulls its target family section FIRST, through the same
  // validated drop path every other optional-section drop uses (throws if the id is not actually
  // optional in this family) — the overlay's own section then takes that slot's place in the
  // page, per `sol-design.md` §2 ("replace-optional nulls an optional family section first; it
  // does not bypass required-section validation").
  const overlayDropSections = options.sectionSelection?.placement.mode === 'replace-optional' ? [options.sectionSelection.placement.targetSectionId] : [];
  const effectiveDropSections = overlayDropSections.length > 0 ? [...(options.dropSections ?? []), ...overlayDropSections] : options.dropSections;
  const droppedNavSlots = applySectionDrops(base, pkg.schema, pkg.fixture, effectiveDropSections, options.restoreSections);
  // PR #137 final ruling: an `x-verify: 'hours-null'` slot (halcyon's hero rail values) is always
  // null. It is set null in the spine and LOCKED, together with its row key (`x-hours-key`), so the
  // model never sees the pair, the gate never has to refuse it, and the page never shows the row.
  const hoursHiddenPaths = new Set<string>();
  for (const path of hoursNullPathsFor(pkg.schema, base)) {
    setNullAtPathLabel(base, path);
    hoursHiddenPaths.add(path);
  }
  for (const keyPath of siblingPathsFor(pkg.schema, base, 'hours-null', 'x-hours-key').values()) hoursHiddenPaths.add(keyPath);
  const droppedSections = droppedSectionIds(base, pkg.schema, pkg.fixture);
  // Every render of this page carries the effect plan (see `RunOptions.effects`). These are the
  // spine and fill renders, never final: the budget holds once, on `latest`, after the fill.
  const checkRendered = (render: RenderResult): RenderQualityReport | undefined => {
    const report = pkg.checkRenderQuality?.(render.html, render.manifest.metadata.agencySite.outputScope ?? 'site');
    if (report && !report.passed) {
      emit({ type: 'render-quality', report });
      throw new RenderQualityError(report);
    }
    return report;
  };
  const renderPage = (input: Json, entry: string) => {
    const rendered = renderWithEffects((i, e, o) => pkg.render(i, e, o), input, entry, options.effects, { final: false });
    checkRendered(rendered);
    return rendered;
  };
  const spineRender = renderPage(base, options.entry);
  // Fail fast on a structurally invalid selection (unknown entry/direction id, or an absent or
  // ambiguous anchor) before spending any fill effort — section ids are part of a family's fixed
  // structure and do not move as text is filled in, so checking against the still-unfilled
  // `spineRender.html` here is exactly as valid as checking the final render, and the anchor is
  // re-checked again (necessarily, since it needs the real HTML) right before publish. The
  // adapter/direction resolved here are kept in `sectionSelectionResolved` and reused verbatim
  // below (never re-resolved) — FIX 5, delta audit: one resolution per selection guarantees the
  // digest `wrapFamilyPackageForOverlay` computes always covers the exact adapter/direction object
  // this run actually filled and verified against.
  let sectionSelectionResolved: { adapter: SectionAdapter; direction: DesignDirection } | undefined;
  if (options.sectionSelection) {
    const adapter = await resolveSectionAdapter(options.sectionSelection.entryId);
    const direction = await resolveDesignDirection(options.sectionSelection.directionId);
    const fixtureSectionIds = fixtureSectionIdsOf(pkg);
    await resolveAnchorOffset(spineRender.html, fixtureSectionIds, options.sectionSelection.placement);
    sectionSelectionResolved = { adapter, direction };
  }
  // A re-target's own diff, folded in alongside the caller's explicit `--lock` paths: see
  // `unchangedTextPaths` for what counts as unchanged and why an unchanged path is safe to skip.
  const lockedPaths: ReadonlySet<string> = new Set([...(options.lockPaths ?? []), ...unchangedTextPaths(options.previousRecipe, base), ...droppedNavSlots, ...hoursHiddenPaths]);
  const template = editableTemplate(base, undefined, lockedPaths);
  if (!isObject(template)) throw new Error('spine has no editable text');
  const limits = limitsFor(pkg.schema, template);
  // Slots the family schema marks nullable: the model may answer them with null rather than
  // invent a contact detail or an award the brief never states.
  const atomKinds = atomKindsFor(pkg.schema, template);
  const nullablePaths = nullablePathsOf(atomKinds);
  // Contact atoms (emails, phones, links): the text is trimmed of the sentence punctuation a copy
  // out of the brief's prose picks up before the family compiler checks its format.
  const contactPaths = contactPathsFor(pkg.schema, template);
  // Slots the family schema marks `x-atom: 'person-name'`: a reviewer or testimonial's attributed
  // name. Checked deterministically against the brief in addition to (never instead of) Jev's own
  // judgment — see `jev.ts`'s `deterministicAttributionFlags`.
  const personNamePaths = personNamePathsFor(pkg.schema, template);
  // Slots the family schema marks `x-verify: 'quote'`: a testimonial or review quote, traced
  // deterministically against the brief's own words alongside Jev — see `jev.ts`'s
  // `deterministicQuoteFlags`.
  const quotePaths = quotePathsFor(pkg.schema, template);
  // Slots the family schema marks `x-verify: 'traceable'` (a round-10 audit pass, item 7 — a new
  // SHARED marker any family may adopt on a practical-fact row, a gallery label, a place card or
  // a descriptor): every stemmed content word traced deterministically against the brief
  // alongside Jev — see `jev.ts`'s `deterministicTraceableFlags`. No bundled family marks a slot
  // this way today; wired here unconditionally, like `personNamePaths`/`quotePaths`, so a family
  // that adds one is covered without any change to this file.
  const traceablePaths = traceablePathsFor(pkg.schema, template);
  // Slots the family schema marks `x-verify: 'destination'`: a book/contact destination the page
  // turns into a live link, traced deterministically against the brief's own URL/email/phone
  // alongside Jev — see `jev.ts`'s `deterministicDestinationFlags`. Added for `practice`.
  const destinationPaths = destinationPathsFor(pkg.schema, template);
  // Slots the family schema marks `x-verify: 'hours-label'`: an hours-row day label, traced
  // deterministically against the brief's own day tokens — see `jev.ts`'s
  // `deterministicHoursLabelFlags`. Added for `practice`.
  const hoursLabelPaths = hoursLabelPathsFor(pkg.schema, template);
  // G8 final: each hours label's row value slot (`x-hours-value`), for the row check.
  const hoursRowValuePaths = hoursRowValuePathsFor(pkg.schema, template);
  const hoursGroups = hoursGroupsFor(pkg.schema, template);
  const hoursNullPaths = hoursNullPathsFor(pkg.schema, template);
  // The same three read from the complete spine, locks ignored: what the deterministic hours gate
  // judges, so a table is never judged on part of its rows.
  const completeHoursLabelPaths = hoursLabelPathsFor(pkg.schema, base);
  const completeHoursRowValuePaths = hoursRowValuePathsFor(pkg.schema, base);
  const completeHoursGroups = hoursGroupsFor(pkg.schema, base);
  // The same hours metadata read from a COMPLETE recipe, locks ignored: what the post-repair
  // table check judges (see its use after the faithfulness loop).
  const completeHours = (recipe: Json) => {
    const labels = hoursLabelPathsFor(pkg.schema, recipe);
    const values = hoursRowValuePathsFor(pkg.schema, recipe);
    const groups = hoursGroupsFor(pkg.schema, recipe);
    const nullable = nullablePathsOf(atomKindsFor(pkg.schema, recipe));
    const slots = [...labels].flatMap((path) => { const text = textAtPathLabel(recipe, path); return typeof text === 'string' ? [{ path, text }] : []; });
    const flags = deterministicHoursLabelFlags(options.brief, slots, labels, values, (path) => textAtPathLabel(recipe, path), groups).map((flag) => flag.path);
    return { labels, values, groups, nullable, flags };
  };
  /** Every hours label the deterministic gate flags on the complete recipe. */
  const completeHoursFlags = (recipe: Json): string[] => completeHours(recipe).flags;
  /**
   * The value paths to null so no flagged hours row stays on the page: each flagged row's whole
   * group (or the row alone when it has none), only when every value there may be null, and only
   * values that are not null already. A group with a required value is left alone: its flags stand.
   */
  const hoursRowsToDrop = (recipe: Json, flaggedPaths: readonly string[]): string[] => {
    const { labels, values, groups, nullable, flags } = completeHours(recipe);
    // A row whose value is already null is not on the page: a flag on its hidden label must not
    // take the shown rows of its group down with it (Sol r3 W1).
    const shown = (path: string) => { const valuePath = values.get(path); return valuePath === undefined || textAtPathLabel(recipe, valuePath) !== null; };
    const flagged = new Set([...flaggedPaths.filter((path) => labels.has(path)), ...flags].filter(shown));
    const rowSets: string[][] = [];
    const grouped = new Set<string>();
    for (const members of groups.values()) {
      for (const path of members) grouped.add(path);
      if (members.some((path) => flagged.has(path))) rowSets.push([...members]);
    }
    for (const path of flagged) if (!grouped.has(path)) rowSets.push([path]);
    return rowSets.flatMap((rows) => {
      const valuePaths = rows.map((path) => values.get(path));
      if (valuePaths.some((path) => path === undefined || !nullable.has(path))) return [];
      return (valuePaths as string[]).filter((path) => textAtPathLabel(recipe, path) !== null);
    });
  };
  // Slots the family schema marks `x-alt-text`: image alt text and photo captions — see
  // `spine.ts`'s `altTextPathsFor` for why this is its OWN marker, exempt only from the two G6
  // sentence-claim/proper-noun checks, never from Jev or any other deterministic gate.
  const altTextPaths = altTextPathsFor(pkg.schema, template);
  // Slots the family schema marks `x-verify: 'exact-date'` — see `makeCheckOnce`'s own parameter.
  const exactDatePaths = exactDatePathsFor(pkg.schema, template);
  // The same, shaped for the prompt's EXACT DATES block (prompt.ts).
  const exactDateShape = shapeOfPaths(template, exactDatePaths, 'exact-date');
  // Slots the family schema marks `x-mock`: illustrative sample data under a visible caption. The
  // model still fills them; only the faithfulness gate skips them (see `collectFaithfulnessSlots`).
  const illustrativePaths = mockPathsFor(pkg.schema, template);
  // Slots the family schema declares template labels (`x-label`): the only slots template-chrome.ts
  // may treat as a label, and only while the fill leaves them exactly as the reference wrote them.
  const labelPaths = labelPathsFor(pkg.schema, template);
  // The same x-mock slots, shaped like the template for the prompt's SAMPLE block: the model is
  // told to write an example there, never to leave one empty (see prompt.ts).
  const sampleShape = shapeOfPaths(template, illustrativePaths, 'sample');
  // `traceablePaths`, shaped like the template for the prompt's TRACEABLE block: told which real-
  // fact slots are checked word-for-word against the brief afterward, the model reuses the
  // brief's own vocabulary there instead of paraphrasing (see prompt.ts's own doc on `traceable`
  // — a round-2 Grok audit found the prompt gave the model no way to know a slot faced this
  // stricter bar at all, so it paraphrased freely and then failed the deterministic check).
  const traceableShape = shapeOfPaths(template, traceablePaths, 'traceable');
  // G8 final: the hours-label slots, shaped for the prompt's HOURS LABELS block, and a masker that
  // swaps the reference page's own day labels in any TEMPLATE the model sees for a neutral
  // placeholder (see prompt.ts's `hoursLabels`).
  // A label with its own value slot shows the days-only placeholder and is named "hours-label"; a
  // combined slot (days and hours in one text) shows the days-and-hours placeholder and is named
  // "hours-row", so the model never drops a row's hours (PR #137 round 1, Opus BLOCK 1).
  const combinedHoursPaths = new Set([...hoursLabelPaths].filter((path) => !hoursRowValuePaths.has(path)));
  const separateHoursPaths = new Set([...hoursLabelPaths].filter((path) => hoursRowValuePaths.has(path)));
  const hoursValuePaths = hoursNullPaths;
  // Every NULLABLE value of an hours row (an hours value, and a nullable row value such as
  // halcyon's rail and visit values) shows null in TEMPLATE, never the reference page's text: a
  // row that is not a verbatim brief row can only pass as null (PR #137 verbatim ruling), and
  // the reference text there invited the model to keep a fact outside the brief's hours clause.
  const nullableHoursRowValues = new Set([...hoursNullPaths, ...[...hoursRowValuePaths.values()].filter((path) => nullablePaths.has(path))]);
  const hoursLabelShape = mergeShapes(mergeShapes(
    shapeOfPaths(template, separateHoursPaths, 'hours-label'),
    shapeOfPaths(template, combinedHoursPaths, 'hours-row'),
  ), shapeOfPaths(template, hoursNullPaths, 'hours-null'));
  // `only`: mask just these paths (a faithfulness repair masks the flagged hours slots only; the
  // hours slots it keeps locked show their accepted text, so the model has no placeholder to echo).
  const maskHoursLabels = (value: Json, at: string, only?: ReadonlySet<string>): Json => {
    const pick = (paths: ReadonlySet<string>) => (only === undefined ? paths : new Set([...paths].filter((path) => only.has(path))));
    // An hours value shows null (never the reference time: halcyon's reference rail time is wrong
    // for its own days): the model copies a row's hours there, or keeps null.
    const labelled = new Set([...pick(separateHoursPaths)].filter((path) => !nullableHoursRowValues.has(path)));
    return withNulls(withPlaceholders(withPlaceholders(value, at, labelled, HOURS_LABEL_PLACEHOLDER), at, pick(combinedHoursPaths), HOURS_ROW_PLACEHOLDER), at, pick(nullableHoursRowValues));
  };
  // The fewest items a repeatable array may honestly hold, wherever the family's own schema
  // allows fewer than the template shows (`items.min` in a family's slots.ts) — shaped for the
  // prompt's ARRAY MINIMA block, see `arrayMinimaFor`'s own doc for why this exists. Added for
  // `practice`.
  const arrayMinima = arrayMinimaFor(pkg.schema, template);
  // The same, flattened to a path -> minimum map: what mergeIntoSpine reads to trim the spine's
  // own array to the candidate's length (never below the family's minimum) instead of padding
  // extra positions out with no candidate to fill them, which would otherwise flag them missing.
  const arrayMinimaPaths = arrayMinimaPathsOf(arrayMinima);
  /** The fact slots the gate checks, and how many filled illustrative slots it skipped. */
  // Template chrome (a label left as the template wrote it, a bare unit token, the copyright line)
  // states nothing about the client and is skipped like a locked path — see template-chrome.ts.
  // It is excluded from both counts, so `illustrative` still counts `x-mock` slots only.
  const gateSlots = (recipe: Json) => {
    const skipped: ReadonlySet<string> = new Set([...lockedPaths, ...templateChromePaths(recipe, base, labelPaths)]);
    const slots = collectFaithfulnessSlots(recipe, skipped, illustrativePaths);
    return { slots, illustrative: collectFaithfulnessSlots(recipe, skipped).length - slots.length };
  };
  const units = unitsOf(template, limits);
  const brandUnit = units.find((unit) => unit.path[0] === 'brand');
  const sectionUnits = units.filter((unit) => unit.path[0] === 'sections');
  /** A streamed or final section is matched by its id, never by its position in the answer. */
  const sectionUnitFor = (section: Json | undefined): Unit | undefined => {
    const id = isObject(section) ? section.id : undefined;
    return typeof id === 'string' ? sectionUnits.find((unit) => unit.label === id) : undefined;
  };

  // The fill-and-repair deadline (see `RunOptions.deadlineMs`). Every model call goes through
  // `callModel`, which adds the deadline and the call's own limit to the caller's signal and turns
  // an abort that came from either into a `UnitDeadlineError` — never a cancellation.
  const deadlineMs = options.deadlineMs ?? DEFAULT_FILL_DEADLINE_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), deadlineMs);
  deadlineTimer.unref?.();
  // A unit's model call that fails on a transport-class error (a network reset before OR after the
  // first byte, an undici `terminated`, an exhausted 429/5xx that read no body, or a per-call
  // timeout that fired before any output — see `transportRetryReasonOf` and the pre-output check
  // below) gets this many extra fresh attempts, to the SAME provider, before `callModel` gives up
  // on the unit (G8 final on 857a46b982: halcyon x deepseek, ECONNRESET mid-request,
  // `--no-failover`). ONE budget covers this AND every provider-internal retry: `build.ts` sets
  // the model caller's own `maxRetries` to 0 on every path for exactly this reason (round 2 audit,
  // Sol B2: an explicit `--max-retries` used to also raise the PROVIDER's own internal budget,
  // stacking silent internal retries under this one), so nothing retries underneath this loop and
  // every attempt beyond the first is bounded and evented here. This is a retry of the whole unit
  // request, never a resumed stream and never a provider failover — see `failover.ts`, which this
  // never calls; a `ProviderFailoverError` is never one of the errors `transportRetryReasonOf`
  // classifies, so it always falls straight through to the throw below.
  //
  // The budget is per UNIT PER BUILD, not per `callModel` invocation: `transportRetriesByUnit`
  // tracks it by `request.label`, shared across a unit's fill call and every later repair call for
  // that same unit (round 2 audit, Sol B2: a `for` loop's own `attempt` variable used to reset on
  // every `callModel` call, so a unit could be retried 2 more times on EACH repair, unbounded
  // across a build). Capped at 2 regardless of `RunOptions.transportRetryLimit`.
  const TRANSPORT_RETRY_LIMIT = Math.min(options.transportRetryLimit ?? 2, 2);
  const TRANSPORT_RETRY_BACKOFF_MS = [250, 750];
  const transportRetriesByUnit = new Map<string, number>();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const callModel = async (request: ModelRequest & { label: string }): Promise<ModelResponse> => {
    for (;;) {
      const perCall = new AbortController();
      const callTimer = setTimeout(() => perCall.abort(), callTimeoutMs);
      callTimer.unref?.();
      const signal = AbortSignal.any([deadline.signal, perCall.signal, ...(options.signal ? [options.signal] : [])]);
      let byteReceivedThisAttempt = false;
      const wrappedRequest = request.onDelta === undefined ? request : {
        ...request,
        onDelta: (text: string) => {
          byteReceivedThisAttempt = true;
          request.onDelta!(text);
        },
      };
      try {
        if (deadline.signal.aborted) throw new UnitDeadlineError(request.label, 'build', deadlineMs);
        return await options.model({ ...wrappedRequest, signal });
      } catch (error) {
        if (error instanceof UnitDeadlineError || options.signal?.aborted === true) throw error;
        if (deadline.signal.aborted) throw new UnitDeadlineError(request.label, 'build', deadlineMs);
        // The caller's own per-call timeout fired. Before any output at all, that reads the same
        // as a transport failure (the provider never answered in time) and is worth the same
        // bounded retry; once output has started, a stall is left as a deadline — retrying would
        // risk duplicating what already streamed, the same rule `transportRetryReasonOf` already
        // applies to a failure after a byte has arrived.
        const preOutputTimeout = perCall.signal.aborted && !byteReceivedThisAttempt;
        const transportReason = preOutputTimeout ? 'ETIMEDOUT' as const : transportRetryReasonOf(error);
        // Round 2 audit (Opus B1): a global `working` snapshot/restore here — taken when ANY
        // unit's attempt starts, restored when THAT unit's attempt fails — throws away every OTHER
        // unit's already-merged work, because `sections` mode and the repair phases run several
        // units' `callModel` calls concurrently. There is no snapshot here any more. Instead:
        //   - `fillUnit`/`repairUnit` (sections mode, and every repair call in either mode) never
        //     merge anything into `working` until AFTER `options.model(...)` resolves — their own
        //     `onDelta` is only `noteFirstToken`, which touches no shared state. A failed attempt
        //     there has merged nothing, so retrying it is always safe with no rollback, concurrent
        //     units included: see the `sections`-mode and repair-phase race tests in run.test.ts.
        //   - The single-page call (`mode !== 'sections'`) is the one path whose `onDelta` merges
        //     mid-stream (`SectionStream` closes a section, `applyUnit` merges it into `working`
        //     immediately). `request.hasMergedOutput` lets THAT call site say so; once it does,
        //     this failure is never retried, merged or not — the build fails instead, exactly as it
        //     did before a transport retry existed for this path. Nothing here ever needs to undo a
        //     merge, because a merge that has already happened is never followed by a retry.
        const alreadyMerged = request.hasMergedOutput?.() ?? false;
        const used = transportRetriesByUnit.get(request.label) ?? 0;
        if (transportReason !== undefined && !alreadyMerged && used < TRANSPORT_RETRY_LIMIT) {
          transportRetriesByUnit.set(request.label, used + 1);
          request.onRetry?.();
          retries += 1;
          emit({ type: 'transport-retry', label: request.label, attempt: used + 1, reason: transportReason });
          await sleep(TRANSPORT_RETRY_BACKOFF_MS[used] ?? TRANSPORT_RETRY_BACKOFF_MS[TRANSPORT_RETRY_BACKOFF_MS.length - 1]);
          continue;
        }
        if (perCall.signal.aborted) throw new UnitDeadlineError(request.label, 'call', callTimeoutMs);
        if (typeof error === 'object' && error !== null && !failedUnits.has(error)) failedUnits.set(error, request.label);
        throw error;
      } finally {
        clearTimeout(callTimer);
      }
    }
  };

  let working: Json = base;
  let latest = spineRender;
  const usage: Usage = { input: 0, output: 0, cachedRead: 0 };
  const unitReports: UnitReport[] = [];
  const missingByUnit = new Map<string, string[]>();
  const nulledByUnit = new Map<string, string[]>();
  const truncated: string[] = [];
  let applied = 0;
  let calls = 0;
  let repairs = 0;
  let retries = 0;
  let paints = 0;
  let firstTokenMs: number | undefined;
  let firstPaintMs: number | undefined;
  let finalPaintMs: number | undefined;

  // The first save failure (assets or page) is kept here and thrown once the run is over, so a
  // daemon error fails `runFastLane` instead of surfacing as an unhandled rejection mid-stream.
  let saveError: unknown;
  const assetBytes = new Map<string, Buffer>();
  const assetsUpload = (async () => {
    if (!publisher) return undefined;
    const started = now();
    await settleAll(spineRender.approvedAssets.map(async (asset) => {
      const bytes = await pkg.readAsset(asset);
      assetBytes.set(asset.file, bytes);
      await publisher.saveFile(asset.destination, bytes, 'base64');
    }));
    const ms = Math.round(now() - started);
    emit({ type: 'assets', count: spineRender.approvedAssets.length, ms });
    return ms;
  })();

  assetsUpload.catch((error: unknown) => { saveError ??= error; });

  // One save at a time; a newer render replaces a waiting one instead of queueing behind it.
  let pending: { render: RenderResult; label: string } | null = null;
  let draining: Promise<void> | null = null;
  const drain = async () => {
    try {
      await assetsUpload;
      while (pending && saveError === undefined) {
        const next = pending;
        pending = null;
        if (publisher) await publisher.savePage(options.entry, next.render.html, next.render.manifest, next.label);
        // Strict holds `publisher` undefined for the whole fill step (see above), so this branch
        // never reaches the daemon there; counting it as a "paint" anyway would make `paints`,
        // `firstPaintMs` and `finalPaintMs` describe in-memory renders instead of what actually
        // reached the project. Strict's own paint (the one deferred save, on a pass) is counted
        // once, explicitly, after the gate — see the `options.strict` block below. Non-strict and
        // plain `--dry-run` (no publisher, `strict` unset) keep today's in-memory paint counting.
        if (!options.strict) {
          paints += 1;
          const ms = since();
          firstPaintMs ??= ms;
          finalPaintMs = ms;
          emit({ type: 'paint', count: paints, ms, label: next.label });
        }
      }
    } catch (error) {
      saveError ??= error;
    }
    draining = null;
  };
  const publish = (render: RenderResult, label: string) => {
    checkRendered(render);
    if (saveError !== undefined) return;
    pending = { render, label };
    draining ??= drain();
  };

  /** `locks` narrows one merge further than `lockedPaths`: a faithfulness repair may change only
   * the slots that were flagged, so every other path of the unit is locked for that answer. */
  const applyUnit = (unit: Unit, answer: Json | undefined, label: string, locks?: ReadonlySet<string>): Outcome => {
    const report: MergeReport = { applied: 0, missing: [], lockedPaths: locks ? new Set([...lockedPaths, ...locks]) : lockedPaths, nullablePaths, nulled: [], samplePaths: illustrativePaths, sampleKept: [], contactPaths, arrayMinima: arrayMinimaPaths };
    let merged = mergeAtPath(working, unit.path, answer, report);
    // G8 final on 857a46b982 (halcyon x cerebras VERIFY_FAILED, root cause): a combined hours row
    // reordered to match its neighbours' day-first style recurringly landed a bare space where a
    // comma belongs (see `normalizeHoursRowSeparator`'s own docblock). Fixing the punctuation here,
    // once, before anything reads this unit's own merged text, means every later reader — the
    // render, the deterministic gate, and Jev — sees the SAME corrected text; this never changes a
    // day or a status, and never touches a row that does not already exactly match one. Round 2
    // audit (Opus F1): `setTextAtPathLabel` copies every node on the path to the rewritten leaf
    // instead of mutating it in place — `merged` shares untouched substructure with `working` (and
    // with any earlier snapshot a caller still holds), and this owner-ruled rewrite must change
    // only its own copy, never a node another reference can still see.
    for (const path of combinedHoursPaths) {
      const text = textAtPathLabel(merged, path);
      if (typeof text === 'string') {
        const normalized = normalizeHoursRowSeparator(options.brief, text);
        if (normalized !== text) {
          merged = setTextAtPathLabel(merged, path, normalized);
          emit({ type: 'hours-normalized', label, path, before: text, after: normalized });
        }
      }
    }
    // Same live-sample finding, the SEPARATE label/value pair's own version: a value slot
    // recurringly repeated its own label's day text ahead of the status ("Wednesday-Friday
    // 11:00-18:00" in a value paired with label "Wednesday-Friday"), instead of the status alone.
    // Stripping a day prefix that already, exactly, matches this slot's OWN paired label is never a
    // guess: it only ever removes a proven duplicate, never invents or changes the status left
    // behind.
    for (const [labelPath, valuePath] of hoursRowValuePaths) {
      const labelText = textAtPathLabel(merged, labelPath);
      const valueText = textAtPathLabel(merged, valuePath);
      if (typeof labelText !== 'string' || typeof valueText !== 'string') continue;
      const prefix = `${labelText} `;
      if (valueText.toLowerCase().startsWith(prefix.toLowerCase())) {
        const stripped = valueText.slice(prefix.length).trim();
        if (stripped !== '') {
          merged = setTextAtPathLabel(merged, valuePath, stripped);
          emit({ type: 'hours-normalized', label, path: valuePath, before: valueText, after: stripped });
        }
      }
    }
    // PR #137 round 1 (Opus F3): an hours placeholder left in place is a failed answer in every
    // verify mode — the unit is asked again, and the text never reaches a page.
    const leaked = [...hoursLabelPaths].filter((path) => {
      const text = textAtPathLabel(merged, path);
      return typeof text === 'string' && isHoursPlaceholder(text);
    });
    if (leaked.length > 0) return { ok: false, reason: 'invalid', error: `${leaked.join(', ')}: still the template placeholder; replace it. ${hoursLabelRepairHint(options.brief)}` };
    const duplicates = duplicateVariableItems(merged, arrayMinima);
    if (duplicates.length > 0) return { ok: false, reason: 'invalid', error: `Duplicate filler in variable arrays: ${duplicates.join('; ')}. Return fewer distinct records within ARRAY MINIMA; do not repeat or invent an item.` };
    let render: RenderResult;
    try {
      render = renderPage(merged, options.entry);
    } catch (error) {
      if (error instanceof RenderQualityError) throw error;
      return { ok: false, reason: 'invalid', error: error instanceof Error ? error.message : String(error) };
    }
    working = merged;
    latest = render;
    applied += report.applied;
    missingByUnit.set(unit.label, report.missing);
    // A narrowed merge nulls only flagged slots; keep what earlier answers nulled in the same unit.
    // (A null slot is never checked, so it is never flagged and stays locked — and null — there.)
    nulledByUnit.set(unit.label, locks ? [...new Set([...(nulledByUnit.get(unit.label) ?? []), ...(report.nulled ?? [])])] : report.nulled ?? []);
    emit({ type: 'merged', label, ms: since() });
    publish(render, label);
    if (report.missing.length > 0) return { ok: false, reason: 'incomplete', error: `missing or empty values: ${report.missing.join(', ')}` };
    return { ok: true };
  };

  const noteFirstToken = () => {
    if (firstTokenMs !== undefined) return;
    firstTokenMs = since();
    emit({ type: 'first-token', ms: firstTokenMs });
  };

  const scopeOf = (unit: Unit) => `Fill the "${unit.label}" part of the page template`;
  const shaped = (value: Json | undefined, guide: Json) => (value === undefined ? undefined : toModelShape(value, guide));
  const promptTemplate = (unit: Unit) => toModelShape(maskHoursLabels(unit.template, pathLabel(unit.path)));
  const promptLimits = (unit: Unit) => shaped(softLimits(unit.limits), unit.template);
  const promptNullable = (unit: Unit) => shaped(getAtPath(atomKinds, unit.path), unit.template);
  const promptSample = (unit: Unit) => shaped(getAtPath(sampleShape, unit.path), unit.template);
  const promptArrayMinima = (unit: Unit) => shaped(getAtPath(arrayMinima, unit.path), unit.template);
  const promptTraceable = (unit: Unit) => shaped(getAtPath(traceableShape, unit.path), unit.template);
  const promptExactDates = (unit: Unit) => shaped(getAtPath(exactDateShape, unit.path), unit.template);
  // Only a unit that holds an hours label gets the HOURS LABELS block and its rule.
  const promptHoursLabels = (unit: Unit) => {
    const shape = getAtPath(hoursLabelShape, unit.path);
    return /"hours-(?:label|row)"/.test(JSON.stringify(shape ?? null)) ? shaped(shape, unit.template) : undefined;
  };
  // The prompt's own TEMPLATE lets the parser recover an answer broken only by stray `}` closers
  // (G8 dry run, halcyon x DeepSeek) — see `stream.ts`'s `withoutStrayClosers`.
  const restore = (unit: Unit, answer: string) => fromModelShape(parseJsonObject(answer, promptTemplate(unit)), unit.template);

  /**
   * Ask again for one unit with the validator's message, up to `budget` times. When the budget is
   * spent, cut any overrun at a word boundary and report it; anything else is fatal. `locks` keeps
   * every other slot of the unit as it is (a faithfulness repair); `standing` is an instruction
   * that must survive a technical retry, so it is appended to every later rejection message.
   */
  const repairUnit = async (unit: Unit, rejectedAnswer: string, rejection: Rejection, budget: number, extra: { locks?: ReadonlySet<string>; standing?: string; template?: Json; maskOnly?: ReadonlySet<string> } = {}): Promise<number> => {
    const { locks, standing } = extra;
    const repairTemplate = extra.template === undefined ? promptTemplate(unit) : toModelShape(maskHoursLabels(extra.template, pathLabel(unit.path), extra.maskOnly));
    let answer = rejectedAnswer;
    let problem = rejection;
    for (let attempt = 1; attempt <= budget; attempt += 1) {
      repairs += 1;
      // Only the classification leaves this function. `problem.error` goes to the model, and to
      // `onCall` with the prompt it is part of — never to the event, and never to the error this
      // throws when the budget runs out. See `RepairReason` and `repairExhausted`.
      emit({ type: 'repair', label: unit.label, reason: problem.reason });
      const prompt = buildUserPrompt({ brief: options.brief, template: repairTemplate, limits: promptLimits(unit), nullable: promptNullable(unit), sample: promptSample(unit), arrayMinima: promptArrayMinima(unit), traceable: promptTraceable(unit), exactDates: promptExactDates(unit), hoursLabels: promptHoursLabels(unit), scope: scopeOf(unit), rejected: { answer, error: problem.error } });
      const response = await callModel({ system: SYSTEM_PROMPT, user: prompt, onDelta: noteFirstToken, label: unit.label });
      calls += 1;
      addUsage(usage, response.usage);
      retries += response.retries;
      answer = response.text;
      options.onCall?.({ label: unit.label, attempt, prompt, answer });
      let outcome: Outcome;
      try {
        outcome = applyUnit(unit, restore(unit, answer), `repair:${unit.label}`, locks);
      } catch (parseError) {
        if (parseError instanceof RenderQualityError) throw parseError;
        outcome = { ok: false, reason: 'malformed', error: parseError instanceof Error ? parseError.message : String(parseError) };
      }
      if (outcome.ok) return attempt;
      // The standing rule is stated once per message: a validator message that already carries it
      // (the faithfulness rejection itself) is not given a second copy.
      problem = { reason: outcome.reason, error: standing === undefined || outcome.error.includes(standing) ? outcome.error : `${outcome.error}. ${standing}` };
    }
    let parsed: Json | undefined;
    try {
      parsed = restore(unit, answer);
    } catch {
      throw repairExhausted(unit, problem);
    }
    const paths: string[] = [];
    const clippedRaw = clipToLimits(parsed ?? null, unit.limits, paths, pathLabel(unit.path));
    // An hours value is never cut to fit: a clipped time is a different time ("Open daily except
    // Monday" -> "Open daily"). It becomes null instead (PR #137 round-2 ruling).
    const clipped = withNulls(clippedRaw ?? null, pathLabel(unit.path), new Set(paths.filter((path) => hoursValuePaths.has(path))));
    const outcome = paths.length > 0 ? applyUnit(unit, clipped, `clip:${unit.label}`, locks) : { ok: false as const, reason: problem.reason, error: problem.error };
    if (!outcome.ok) throw repairExhausted(unit, { reason: outcome.reason, error: outcome.error });
    truncated.push(...paths);
    emit({ type: 'clipped', label: unit.label, paths });
    return budget;
  };

  /**
   * For an `incomplete` rejection (`applyUnit` reported one or more required slots missing or
   * empty), narrow the repair the same way a faithfulness repair narrows to its flagged slots
   * (see the `unfaithful` branch below): lock every OTHER text slot of the unit to the answer
   * already accepted for it, and show the model that accepted neighbouring text in TEMPLATE, so
   * only the slots `applyUnit` actually named missing stay editable.
   *
   * Before this, a repair for `incomplete` re-asked the WHOLE unit again with the original,
   * unfilled TEMPLATE (`promptTemplate(unit)`, `repairUnit`'s own default) — no record of which
   * fields the first answer had already gotten right. That matters most for a unit whose brief
   * content is one long quote split across many tightly adjacent keys (`emmpo-talents`: a
   * two-paragraph quote spread across 14 text slots, by far the most of any emmpo unit) — the
   * model has no signal for exactly where the TEMPLATE's split points fall, so it can leave a
   * different slot of the same run empty on a second attempt just as easily as the first. G8
   * final 32f08a40cd (emmpo x cerebras) hit exactly that: `emmpo-talents` came back with a slot
   * empty on the fill AND on both technical repairs, and the build failed closed with its budget
   * spent. Locking the already-accepted fragments removes that repeated ambiguity: the model sees
   * precisely how the sentence already reads on either side of the gap and has nothing else it is
   * allowed to change.
   *
   * Returns `undefined` (repairUnit's own full re-ask) when there is nothing to narrow to: any
   * other rejection reason, or an `incomplete` one `missingByUnit` has no recorded paths for.
   * This never widens what a repair may change — locks only ever shrink the editable surface —
   * and the unit still spends the same `maxRepairs` budget either way.
   */
  const incompleteRepairScope = (unit: Unit, outcome: Outcome): { locks: ReadonlySet<string>; template: Json; maskOnly: ReadonlySet<string> } | undefined => {
    if (outcome.ok || outcome.reason !== 'incomplete') return undefined;
    const missingHere = missingByUnit.get(unit.label);
    if (!missingHere || missingHere.length === 0) return undefined;
    const missingSet = new Set(missingHere);
    const prefix = pathLabel(unit.path);
    const allPaths = slotPathsOf(getAtPath(working, unit.path) ?? null, prefix);
    if (![...missingSet].some((path) => allPaths.has(path))) return undefined;
    // Round 2 audit (Opus): a missing leaf under a VARIABLE-LENGTH list (`arrayMinimaPaths`: an
    // array whose family schema allows fewer items than the template, see `arrayMinimaFor`'s own
    // doc) must fall back to the full, unnarrowed re-ask instead of narrowing. The ARRAY MINIMA
    // convention tells the model it may drop items it has no brief facts for FROM THE END of such
    // a list; `mergeIntoSpine`'s trim (`hasLockedDescendant`) refuses to drop a tail item that
    // still holds ANY locked slot, on purpose — a locked slot means a repair specifically kept
    // that item, so trimming it would silently discard an answer the caller asked to preserve. A
    // narrowed 'incomplete' repair locks every OTHER slot of the missing item by construction, so
    // that guard then refuses to trim the very item the model would otherwise drop, leaving
    // "invent a fact" as its only way to answer. Repro (`practice`/`practice-services`, 3 items,
    // `items[2].title` empty): base 32f08a40cd recovers in one repair; narrowing failed it. So a
    // missing path under such a list skips narrowing entirely and repairs the whole unit, exactly
    // as before this feature existed — the model keeps the freedom to drop the item.
    for (const path of missingSet) {
      for (const ancestor of pathAncestorsOf(path)) {
        if (arrayMinimaPaths.has(ancestor)) return undefined;
      }
    }
    // Round 1 audit (Opus): a missing leaf inside a group the family lets be null as a whole (an
    // optional KPI card, a repeat item — see `atomKindsFor`'s group kind) must still let the model
    // answer null for that WHOLE group, exactly as the unnarrowed repair always could — the brief
    // may simply state no such content, which is a legitimate answer to "incomplete", not a fact
    // to invent. Locking every ancestor container of the missing leaf (as plain narrowing would)
    // blocks that: `mergeIntoSpine`'s whole-group-null branch itself checks `report.lockedPaths`
    // before honouring a candidate's `null`, so a locked ancestor makes the null answer as
    // impossible as leaving the leaf itself blank again. `crm-dashboard` recovers from an empty
    // optional-group slot in one (unnarrowed) repair on base 32f08a40cd; narrowing must not
    // regress that. So every ANCESTOR of a missing path stays unlocked — the whole group the
    // missing leaf sits in, all the way up to the unit's own root — while every OTHER slot this
    // unit holds (outside that ancestor chain) stays locked, same as before. A slot the model
    // still chooses to answer with text, not null, is unaffected: `mergeIntoSpine` only reads
    // `lockedPaths` for a string leaf or a whole nullable group, never to block ordinary object
    // recursion, so an unlocked ancestor changes nothing when the group is filled rather than
    // nulled — its still-locked sibling leaves keep their own accepted text regardless.
    const missingAncestors = new Set<string>();
    for (const path of missingSet) for (const ancestor of pathAncestorsOf(path)) missingAncestors.add(ancestor);
    const locks = new Set([...allPaths].filter((path) => !missingSet.has(path) && !missingAncestors.has(path)));
    const accepted = new Map<string, string | null>();
    for (const path of allPaths) {
      if (missingSet.has(path) || missingAncestors.has(path)) continue;
      const text = textAtPathLabel(working, path);
      if (typeof text === 'string' || text === null) accepted.set(path, text);
    }
    return { locks, template: withTexts(unit.template, prefix, accepted), maskOnly: missingSet };
  };

  const fillUnit = async (unit: Unit): Promise<void> => {
    const started = now();
    const prompt = buildUserPrompt({ brief: options.brief, template: promptTemplate(unit), limits: promptLimits(unit), nullable: promptNullable(unit), sample: promptSample(unit), arrayMinima: promptArrayMinima(unit), traceable: promptTraceable(unit), exactDates: promptExactDates(unit), hoursLabels: promptHoursLabels(unit), scope: scopeOf(unit) });
    const response = await callModel({ system: SYSTEM_PROMPT, user: prompt, onDelta: noteFirstToken, label: unit.label });
    calls += 1;
    addUsage(usage, response.usage);
    retries += response.retries;
    options.onCall?.({ label: unit.label, attempt: 0, prompt, answer: response.text });
    let outcome: Outcome;
    try {
      outcome = applyUnit(unit, restore(unit, response.text), unit.label);
    } catch (error) {
      if (error instanceof RenderQualityError) throw error;
      outcome = { ok: false, reason: 'malformed', error: error instanceof Error ? error.message : String(error) };
    }
    const unitRepairs = outcome.ok
      ? 0
      : await repairUnit(unit, response.text, { reason: outcome.reason, error: outcome.error }, maxRepairs, incompleteRepairScope(unit, outcome));
    const ms = Math.round(now() - started);
    unitReports.push({ label: unit.label, ms, firstTokenMs: response.firstTokenMs, repairs: unitRepairs });
    emit({ type: 'unit', label: unit.label, ms, repairs: unitRepairs });
  };

  let verify: RunReport['verify'];
  let sectionOverlay: RunReport['sectionOverlay'];

  // Every step below can be cancelled, and the run must leave nothing behind when it is: the
  // checks between the steps end the run at the next await instead of at the next timeout, and
  // the catch waits for the save queue and the asset upload to settle before the abort (or any
  // other failure) unwinds — a caller deleting a project it created must not race a write.
  try {
    options.signal?.throwIfAborted();
    if (options.mode === 'sections') {
      await settleAll(units.map((unit) => fillUnit(unit)));
    } else {
      const started = now();
      let stream = new SectionStream();
      const streamed = new Set<string>();
      const streamedOk = new Set<string>();
      // Round 2 audit (Opus B1, FIX): the only call whose `onDelta` merges into `working` mid-call
      // — every completed section `applyUnit` merges here, before this call's own promise settles.
      // Once that has happened even once, a transport failure on the REST of this call can never
      // be retried: there is no rollback any more (see `callModel`'s own doc), and retrying would
      // either duplicate a merged section or publish a page mixed from two different attempts. A
      // failure before the first merge is still retried exactly as any other unit's call is.
      let mergedAnything = false;
      // Only the sections this page renders: a dropped one (null) is never shown to the model.
      const pageTemplate = withoutDroppedSections(template, template) ?? template;
      // Masked before sections are dropped, so every hours-label path still names its own slot.
      const maskedPageTemplate = withoutDroppedSections(maskHoursLabels(template, ''), template) ?? pageTemplate;
      // Counted off the template the model is shown, so the number always matches what it sees.
      const shownSectionCount = isObject(pageTemplate) && Array.isArray(pageTemplate.sections) ? pageTemplate.sections.length : sectionUnits.length;
      const prompt = buildUserPrompt({
        brief: options.brief,
        template: toModelShape(maskedPageTemplate),
        limits: shaped(withoutDroppedSections(softLimits(limits), template), pageTemplate),
        nullable: shaped(withoutDroppedSections(atomKinds, template), pageTemplate),
        sample: shaped(withoutDroppedSections(sampleShape, template), pageTemplate),
        arrayMinima: shaped(withoutDroppedSections(arrayMinima, template), pageTemplate),
        traceable: shaped(withoutDroppedSections(traceableShape, template), pageTemplate),
        hoursLabels: shaped(withoutDroppedSections(hoursLabelShape, template), pageTemplate),
        scope: `Fill the whole page template. It has ${shownSectionCount} sections; return every one of them, in the same order, each with its "id"`,
      });
      const response = await callModel({
        system: SYSTEM_PROMPT,
        user: prompt,
        label: 'page',
        onDelta: (delta) => {
          noteFirstToken();
          for (const part of stream.push(delta)) {
            const unit = part.kind === 'brand' ? brandUnit : sectionUnitFor(part.value);
            if (!unit || streamed.has(unit.label)) continue;
            streamed.add(unit.label);
            // `applyUnit` merges into `working` whenever it renders at all, even when it goes on
            // to report `ok: false` for a missing field — see `applyUnit`'s own body. Either way
            // counts as "merged" here: `working` has changed, and no retry may follow it.
            mergedAnything = true;
            if (applyUnit(unit, fromModelShape(part.value, unit.template), `stream:${unit.label}`).ok) streamedOk.add(unit.label);
          }
        },
        // See `mergedAnything`'s own doc above: once it is true, `callModel` never retries this
        // call again, so `onRetry` below only ever runs before the first merge — clearing state
        // that is already empty. It stays for a failure that arrives before any section closes
        // (nothing streamed yet, so nothing to roll back), and to give the retried attempt a fresh
        // parser: its partial in-flight token belonged to the failed attempt's own byte stream.
        onRetry: () => {
          streamed.clear();
          streamedOk.clear();
          stream = new SectionStream();
        },
        hasMergedOutput: () => mergedAnything,
      });
      calls += 1;
      addUsage(usage, response.usage);
      retries += response.retries;
      options.onCall?.({ label: 'page', attempt: 0, prompt, answer: response.text });
      // The answer as a whole may be malformed even when several sections closed cleanly in the
      // stream. Those units stand; every other unit is repaired on its own.
      let full: Json | undefined;
      let pageError: string | undefined;
      try {
        full = parseJsonObject(response.text);
      } catch (error) {
        pageError = `page answer was not valid JSON (${error instanceof Error ? error.message : String(error)})`;
      }
      const answers = new Map<Unit, Json | undefined>();
      if (brandUnit && full !== undefined) answers.set(brandUnit, getAtPath(full, ['brand']));
      const answeredSections = full === undefined ? undefined : getAtPath(full, ['sections']);
      for (const section of Array.isArray(answeredSections) ? answeredSections : []) {
        const unit = sectionUnitFor(section);
        if (unit && !answers.has(unit)) answers.set(unit, section);
      }
      const failures: Array<{ unit: Unit; answer: string; rejection: Rejection }> = [];
      for (const unit of units) {
        const answer = answers.get(unit);
        if (answer === undefined && streamedOk.has(unit.label)) continue;
        const outcome = applyUnit(unit, fromModelShape(answer, unit.template), `final:${unit.label}`);
        if (outcome.ok) continue;
        // A unit with no answer at all fails because the page answer itself would not parse.
        const rejection: Rejection = answer === undefined && pageError !== undefined
          ? { reason: 'malformed', error: pageError }
          : { reason: outcome.reason, error: outcome.error };
        failures.push({ unit, answer: JSON.stringify(answer ?? null), rejection });
      }
      const repairing = failures.map((failure) => repairUnit(failure.unit, failure.answer, failure.rejection, maxRepairs));
      await settleAll(repairing);
      const repairedCounts = await Promise.all(repairing);
      const ms = Math.round(now() - started);
      for (const unit of units) {
        const failureIndex = failures.findIndex((failure) => failure.unit === unit);
        unitReports.push({ label: unit.label, ms, firstTokenMs: response.firstTokenMs, repairs: failureIndex >= 0 ? repairedCounts[failureIndex]! : 0 });
      }
    }
    options.signal?.throwIfAborted();
    // `verifyAfterPublish` moves this whole block to after registration — see the block below the
    // publish/strict logic near the end of this function, and the option's own doc comment.
    if (options.verify && !options.verifyAfterPublish) {
      const verifyStarted = now();
      const checkOnce = makeCheckOnce(options.verify, options.brief, options.signal, personNamePaths, quotePaths, pkg.family, contactPaths, traceablePaths, destinationPaths, completeHoursLabelPaths, altTextPaths, exactDatePaths, completeHoursRowValuePaths, completeHoursGroups, hoursNullPaths);
      // Folds `pkg.checkLinkHonesty` (when the family's compiler copy has it) into whatever
      // `checkOnce` returns, on the CURRENT rendered page — a dead or invented href is a
      // faithfulness flag exactly like an invented name or quote, feeding the same repair-then-
      // recheck loop and the same strict fail-closed `remaining` list below.
      const checkOnceWithLinks = async (checkSlots: FaithfulnessSlot[]): Promise<CheckAttempt> => {
        // `headingTextsOf(working)` reads the CURRENT recipe directly, not `checkSlots` — see
        // that function's own docblock for why a `checkSlots`-only reading missed a chrome-
        // excluded heading (the round-9 regression this call closes).
        const attempt = await checkOnce(checkSlots, headingTextsOf(working), working);
        const html = renderPage(working, options.entry).html;
        const withLinks = mergeLinkHonesty(attempt.flagged, html, pkg.checkLinkHonesty);
        // A variable-length list's own heading must not state a different size than the list shows
        // ("Six guides" over five cards), however the list got shorter: a first answer, a repair or
        // a removal (Sol review of #286, round 3). The heading is flagged so a repair can fix it.
        const countFlags = countClaimFlags(working, base).filter((path) => !withLinks.some((flag) => flag.path === path));
        return { ...attempt, flagged: [...withLinks, ...countFlags.map((path) => ({ path, probability: 1 }))] };
      };

      const { slots, illustrative } = gateSlots(working);
      const initial = await checkOnceWithLinks(slots);

      // Bounded faithfulness repair: at most `maxFaithfulnessRounds` rounds, each a repair of every
      // flagged unit followed by a fresh check, stopping as soon as a check flags nothing (or could
      // not complete). Each round rebuilds the flagged-unit map from its own check and locks every
      // path of the unit except the flagged ones, so a repair can only delete, null or neutrally
      // reword what was flagged — it can never touch a slot that already passed.
      let latestCheck: CheckAttempt = initial;
      let lastFlagged = initial.flagged.map((flag) => flag.path);
      // Every path any completed check flagged, in first-flagged order: a path first flagged in a
      // later round and then repaired counts as repaired too.
      const everFlagged = new Set(lastFlagged);
      let rounds = 0;
      while (latestCheck.skipped === undefined && latestCheck.flagged.length > 0 && rounds < maxFaithfulnessRounds) {
        rounds += 1;
        const bySlotPath = new Map(gateSlots(working).slots.map((slot) => [slot.path, slot.text]));
        const flaggedByUnit = new Map<Unit, Array<{ path: string; text: string }>>();
        for (const flag of latestCheck.flagged) {
          const unit = units.find((candidate) => {
            const prefix = pathLabel(candidate.path);
            return flag.path === prefix || flag.path.startsWith(`${prefix}.`) || flag.path.startsWith(`${prefix}[`);
          });
          if (!unit) continue;
          const list = flaggedByUnit.get(unit) ?? [];
          list.push({ path: flag.path, text: bySlotPath.get(flag.path) ?? '' });
          flaggedByUnit.set(unit, list);
        }
        if (flaggedByUnit.size === 0) break;

        // A repair attempt that still fails technical validation (e.g. neutral wording that does
        // not satisfy a field's own format, such as an email regex) must not fail the whole build:
        // the unit's text is left as repairUnit last committed it (unchanged, if every attempt was
        // refused), and the next check reports it. The faithfulness request is one attempt; the
        // technical budget (`maxRepairs`) is separate and only covers a refused answer to it.
        await settleAll([...flaggedByUnit.entries()].map(async ([unit, flags]) => {
          const rejectedAnswer = JSON.stringify(shaped(getAtPath(working, unit.path), unit.template));
          const rule = faithfulnessRepairError(flags, options.brief, hoursLabelPaths, (labelPath) => {
            const valuePath = hoursRowValuePaths.get(labelPath);
            return valuePath === undefined ? undefined : textAtPathLabel(working, valuePath);
          }, hoursNullPaths, (labelPath) => hoursRowValuePaths.get(labelPath));
          const flaggedHere = new Set(flags.map((flag) => flag.path));
          // A flagged leaf inside a repeatable array item (a provider's `name`, a review's
          // `quote`) unlocks its WHOLE item, not just that one leaf: without this, a repair that
          // rewrites the flagged field leaves its SIBLING fields (a `credential`, a `name`)
          // locked to whatever the spine already held — which, if the repaired field's new value
          // names a different identity than before, glues a fresh fact onto a stale one from a
          // different person at the same array position (round-3 Grok audit, `practice`).
          // Unlocking the whole item lets a genuine repair regenerate it as one coherent unit;
          // the next faithfulness check still re-verifies every one of its fields, so an
          // unfaithful sibling a model rewrites along the way is caught the same as any other
          // flagged slot.
          const flaggedItemContainers = new Set([...flaggedHere].map(itemContainerPrefix).filter((container): container is string => container !== undefined));
          // The model needs the same whole-item permission as the merge below; a leaf-only
          // instruction would tell it to preserve a mismatched sibling field we allow it to fix.
          const itemRepairScope = flaggedItemContainers.size === 0 ? ''
            : ` REPAIR SCOPE: You may rewrite the editable fields together within these flagged items to keep each item's fields coherent: ${[...flaggedItemContainers].join(', ')}. Keep every other item and every unflagged value outside these items unchanged. Existing locked values stay fixed. All rewritten fields must follow the same brief-support rules and will be verified again.`;
          const standing = `${FAITHFULNESS_RULE}${itemRepairScope}`;
          const rejection: Rejection = { reason: 'unfaithful', error: `${rule}${itemRepairScope}` };
          // A flagged hours label unlocks its row's value slot too: the fix may be to null the value.
          const hoursValuesHere = [...flaggedHere].flatMap((path) => { const valuePath = hoursRowValuePaths.get(path); return valuePath === undefined ? [] : [valuePath]; });
          const unlockAnchors = new Set([...flaggedHere, ...flaggedItemContainers, ...hoursValuesHere]);
          const covers = (group: string) => [...unlockAnchors].some((anchor) => group === anchor || group.startsWith(`${anchor}.`) || group.startsWith(`${anchor}[`));
          const locks = new Set([...slotPathsOf(getAtPath(working, unit.path) ?? null, pathLabel(unit.path))].filter((path) => !covers(path)));
          try {
            // Every hours slot shows its CURRENT text in the repair TEMPLATE: the accepted text where
            // this repair keeps it locked, the rejected text where it asks for a fix (the error
            // names the brief's rows). Never the reference example, and never a placeholder the
            // model could echo back (PR #137 round 2: a repair echoed "Days as in the brief").
            const repairTemplateJson = withTexts(templateWithoutUntracedClaims(unit, flaggedHere, options.brief), pathLabel(unit.path), new Map([...hoursLabelPaths]
              .flatMap((path) => {
                const text = textAtPathLabel(working, path);
                return typeof text === 'string' ? [[path, text] as const] : [];
              })));
            // A flagged hours label's nullable value shows null: when no brief row fits, null is the fix.
            const nullValuesHere = new Set(hoursValuesHere.filter((path) => nullablePaths.has(path)));
            await repairUnit(unit, rejectedAnswer, rejection, 1 + maxRepairs, { locks, standing, template: withNulls(repairTemplateJson, pathLabel(unit.path), nullValuesHere), maskOnly: new Set() });
          } catch (error) {
            // Only a spent technical budget is advisory — see the comment above. Everything else
            // unwinds the run: a cancellation, a provider or transport failure, a deadline, and any
            // unexpected error. None of those means "the validator refused the neutral wording".
            if (!(error instanceof UnitRefusedError)) throw error;
          }
        }));

        latestCheck = await checkOnceWithLinks(gateSlots(working).slots);
        if (latestCheck.skipped === undefined) {
          lastFlagged = latestCheck.flagged.map((flag) => flag.path);
          for (const path of lastFlagged) everFlagged.add(path);
        }
      }

      // Any doubt empties the row set (`hours-label.ts`): once the repairs are spent, an hours
      // table with a flagged row is dropped WHOLE when the family lets every value in it be null,
      // so the page shows the brief's rows or none, never a subset and never wrong ones. The table
      // is judged on the COMPLETE recipe: an incremental run's locks keep unchanged labels out of
      // the check's own slots, which would otherwise let a partial table pass unseen.
      if (latestCheck.skipped === undefined) {
        const droppedHoursValues = hoursRowsToDrop(working, latestCheck.flagged.map((flag) => flag.path));
        if (droppedHoursValues.length > 0) {
          for (const valuePath of droppedHoursValues) {
            working = withNullAtPathLabel(working, valuePath);
            // The deepest unit holding this path (a unit may be the row itself, or a section above it).
            const unit = units.filter((candidate) => { const prefix = pathLabel(candidate.path); return valuePath === prefix || valuePath.startsWith(`${prefix}.`) || valuePath.startsWith(`${prefix}[`); })
              .sort((a, b) => pathLabel(b.path).length - pathLabel(a.path).length)[0];
            if (unit) nulledByUnit.set(unit.label, [...new Set([...(nulledByUnit.get(unit.label) ?? []), valuePath])]);
          }
          latest = renderPage(working, options.entry);
          // Advisory runs save each render as it lands; the dropped rows must leave the saved page too.
          publish(latest, 'hours-dropped');
          latestCheck = await checkOnceWithLinks(gateSlots(working).slots);
          if (latestCheck.skipped === undefined) {
            lastFlagged = latestCheck.flagged.map((flag) => flag.path);
            for (const path of lastFlagged) everFlagged.add(path);
          }
        }
        // An item still flagged once the repairs are spent is removed from a list the family marks
        // droppable (`x-drop: 'items'`), while the list keeps at least its minimum: the page shows
        // fewer items, never an unsupported one, and the build does not fail over a list the brief
        // fills only partly (R1–R3, 2026-10-10). Opt-in, because a procedure with a middle step cut
        // out is worse than a refused build (Sol review of #286). A list of hours rows is all or
        // none, like every hours table. Locked content is never removed or shifted: a list with a
        // lock at or after its first flagged item is left whole. The fresh check below decides.
        if (latestCheck.skipped === undefined && latestCheck.flagged.length > 0) {
          const minima = arrayMinimaPathsOf(arrayMinimaFor(pkg.schema, working));
          const droppable = droppableListPathsFor(pkg.schema, working);
          const { labels: hoursLabels } = completeHours(working);
          const flaggedByList = new Map<string, Set<number>>();
          for (const flag of latestCheck.flagged) {
            const item = itemContainerPrefix(flag.path);
            const match = item === undefined ? null : /^(.*)\[(\d+)\]$/.exec(item);
            if (!match || !minima.has(match[1]!) || !droppable.has(match[1]!)) continue;
            const indexes = flaggedByList.get(match[1]!) ?? new Set<number>();
            indexes.add(Number(match[2]));
            flaggedByList.set(match[1]!, indexes);
          }
          let shortened = false;
          for (const [listPath, flaggedIndexes] of flaggedByList) {
            const list = getAtPath(working, labelSegments(listPath));
            if (!Array.isArray(list)) continue;
            const isHoursList = list.some((_, index) => [...hoursLabels].some((label) => label.startsWith(`${listPath}[${index}].`)));
            // An hours list drops all of its shown rows only when every shown row is flagged: a row the
            // check accepts is a brief-stated fact, and dropping it with the others would lose it.
            if (isHoursList && !list.every((item, index) => flaggedIndexes.has(index) || !isObject(item) || item.value === null)) continue;
            // A section whose own copy states the list's size ("Six guides") would contradict a
            // shortened list; leave it whole and let the flag stand (Sol review of #286, round 2).
            if (!isHoursList && statesCount(getAtPath(working, labelSegments(listPath.replace(/\.items$/, '.text'))), list.length)) continue;
            const removed = isHoursList ? list.map((_, index) => index) : [...flaggedIndexes];
            const firstRemoved = Math.min(...removed);
            const lockedFrom = (index: number) => [...lockedPaths].some((locked) => locked.startsWith(`${listPath}[${index}].`) || locked === `${listPath}[${index}]`);
            if (list.some((_, index) => index >= firstRemoved && lockedFrom(index))) continue;
            const kept = list.filter((_, index) => !removed.includes(index));
            if (kept.length === list.length || kept.length < minima.get(listPath)!) continue;
            working = withNodeAtPathLabel(working, listPath, kept);
            shortened = true;
          }
          if (shortened) {
            latest = renderPage(working, options.entry);
            publish(latest, 'unsupported-items-dropped');
            latestCheck = await checkOnceWithLinks(gateSlots(working).slots);
            if (latestCheck.skipped === undefined) {
              lastFlagged = latestCheck.flagged.map((flag) => flag.path);
              for (const path of lastFlagged) everFlagged.add(path);
            }
          }
        }
        // A dropped row is not on the page (every family with a nullable hours value renders a row
        // only when its value is non-null: restaurant's table, halcyon's visit block), so a flag on
        // its hidden label no longer guards anything a visitor sees.
        if (latestCheck.skipped === undefined) {
          const { values } = completeHours(working);
          const hidden = (path: string) => { const valuePath = values.get(path); return valuePath !== undefined && textAtPathLabel(working, valuePath) === null; };
          if (latestCheck.flagged.some((flag) => hidden(flag.path))) latestCheck = { ...latestCheck, flagged: latestCheck.flagged.filter((flag) => !hidden(flag.path)) };
        }
        // Whatever the check's own slots covered, a complete-recipe hours flag still standing is a
        // flag: strict refuses rather than publish a table that is not the brief's.
        if (latestCheck.skipped === undefined) {
          const { values } = completeHours(working);
          const hidden = (path: string) => { const valuePath = values.get(path); return valuePath !== undefined && textAtPathLabel(working, valuePath) === null; };
          const standing = completeHoursFlags(working).filter((path) => !hidden(path) && !latestCheck.flagged.some((flag) => flag.path === path));
          if (standing.length > 0) {
            latestCheck = { ...latestCheck, flagged: [...latestCheck.flagged, ...standing.map((path) => ({ path, probability: 1 }))] };
            for (const path of standing) everFlagged.add(path);
          }
        }
      }

      // A check that could not complete leaves the last known flags standing, never an empty list.
      const remaining = latestCheck.skipped !== undefined ? lastFlagged : latestCheck.flagged.map((flag) => flag.path);
      const flaggedPaths = [...everFlagged];
      const skipped = latestCheck.skipped;
      const skipReason = latestCheck.skipReason;
      const oversized = latestCheck.oversized;

      verify = {
        provider: 'jev',
        checked: slots.length,
        illustrative,
        flagged: flaggedPaths,
        repaired: flaggedPaths.filter((path) => !remaining.includes(path)).length,
        remaining,
        ms: Math.round(now() - verifyStarted),
        ...(skipped !== undefined ? { skipped } : {}),
        ...(oversized && oversized.length > 0 ? { oversized } : {}),
      };
      // The event carries the code, never the message behind it — see `VerifySkipReason`.
      emit({ type: 'verify', checked: verify.checked, illustrative: verify.illustrative, flagged: flaggedPaths.length, repaired: verify.repaired, remaining: remaining.length, ms: verify.ms, flaggedPaths, remainingPaths: remaining, ...(skipReason !== undefined ? { skipped: skipReason } : {}) });
    }
    options.signal?.throwIfAborted();
    // The selected section's own fill + faithfulness pass (brief only — `designReference` never
    // reaches `verify`, see `RunOptions.designReference`), after the base recipe's own fill and
    // verify have fully completed. A strict refusal (`SectionSelectionRefusedError`, thrown by
    // `fillSectionAdapter` when it is `strict` and facts remain unsupported after repair) is
    // caught below exactly like any other unit failure: nothing publishes.
    if (options.sectionSelection && sectionSelectionResolved) {
      const selection = options.sectionSelection;
      const { adapter, direction } = sectionSelectionResolved;
      const overlayModel: ModelCall = options.sectionOverlayModel ?? options.model;
      const fillResult = await fillSectionAdapter({
        adapter,
        brief: options.brief,
        designReference: options.designReference,
        model: overlayModel,
        // A round-9 audit pass found this call passing the RAW `options.verify` checker straight
        // through, so the deterministic claim/commercial-word gates the base page's own fill runs
        // (`makeCheckOnce`, above) never saw a section-overlay fill at all — see
        // `withAdapterDeterministicGates`'s own docblock for the exact failure and why wrapping
        // the checker here is sufficient (no change needed to `fillSectionAdapter`'s own
        // strict/repair loop).
        verify: options.verify ? withAdapterDeterministicGates(options.verify, pkg.family, options.signal) : options.verify,
        strict: options.strict,
        maxRepairs,
        maxFaithfulnessRounds,
        signal: options.signal,
        onCall: options.onCall,
      });
      calls += fillResult.calls;
      addUsage(usage, fillResult.usage);
      retries += fillResult.retries;
      const wrappedPkg = await wrapFamilyPackageForOverlay(pkg, selection, direction, adapter, fillResult.fill);
      // Sections first, then effects: the overlay's wrapper hands the compiler its splice as
      // `compose`, so the compiler applies (and budgets) the plan on the composed page, and
      // `renderWithEffects` refuses a composed page still at or over the limit.
      latest = renderWithEffects((i, e, o) => wrappedPkg.render(i, e, o), working, options.entry, options.effects);
      // The report names the entry by its public id; the internal one stays in this package.
      sectionOverlay = { entryId: publicSectionEntryId(adapter.id), directionId: direction.id, placement: selection.placement, flagged: fillResult.flagged, remaining: fillResult.remaining };
      publish(latest, 'section-overlay');
      // `dishonestLinks` (`mergeLinkHonesty`) was checked against the PRE-overlay page above
      // (`checkOnceWithLinks`), never against the page this overlay just spliced a section into —
      // a section adapter's own `links` are fixed at author time (see `SectionAdapter`'s doc), but
      // a strict storefront build must still fail closed on the actual page it is about to
      // publish, not a page it published a check against a moment before splicing more markup in.
      if (options.strict && pkg.checkLinkHonesty) {
        const dishonest = pkg.checkLinkHonesty(latest.html);
        if (dishonest.length > 0) {
          throw new SectionSelectionRefusedError(`Section overlay refused: dishonest link(s) on the composed page: ${dishonest.join(', ')}`);
        }
      }
    }
    // `latest` is the final page whichever path made it (the overlay's render above already held
    // it to the budget). Checked before the strict publish; a non-strict build's created project
    // is removed by `buildSite` on this error, so either way nothing stays published.
    assertPageBudget(latest.html);
    checkRendered(latest);
    options.signal?.throwIfAborted();
  } catch (error) {
    clearTimeout(deadlineTimer);
    const inFlight = draining;
    if (inFlight) await inFlight;
    await assetsUpload.catch(() => {});
    throw error;
  }

  const finalRenderQuality = checkRendered(latest);
  if (finalRenderQuality) emit({ type: 'render-quality', report: finalRenderQuality });

  // The fill-and-repair phase is over: nothing after this point calls the model.
  clearTimeout(deadlineTimer);
  await draining;
  if (saveError !== undefined) throw saveError;
  let assetsMs = await assetsUpload;

  let registeredMs: number | undefined;
  let registeredPublisher = publisher;
  let strict: RunReport['strict'];

  if (options.strict) {
    // A cancellation that lands between the gate and the publish still publishes nothing: strict
    // has written nothing at all up to here, and creating a project for a build nobody is waiting
    // for would be the one irreversible thing it does.
    options.signal?.throwIfAborted();
    const passed = strictPassed(verify);
    strict = passed ? { passed: true, checked: verify ? verify.checked : 0 } : { passed: false, reason: strictFailReason(verify) };
    const made = passed ? await options.ensurePublisher?.() : undefined;
    if (made) {
      const { publisher: realPublisher, created } = made;
      registeredPublisher = realPublisher;
      try {
        const uploadStarted = now();
        await settleAll(spineRender.approvedAssets.map(async (asset) => {
          const bytes = await pkg.readAsset(asset);
          assetBytes.set(asset.file, bytes);
          await realPublisher.saveFile(asset.destination, bytes, 'base64');
        }));
        assetsMs = Math.round(now() - uploadStarted);
        emit({ type: 'assets', count: spineRender.approvedAssets.length, ms: assetsMs });
        await realPublisher.savePage(options.entry, latest.html, latest.manifest, 'registered');
        paints += 1;
        const paintMs = since();
        firstPaintMs ??= paintMs;
        finalPaintMs = paintMs;
        emit({ type: 'paint', count: paints, ms: paintMs, label: 'registered' });
        await publishFinalState({ publisher: realPublisher, pkg, working, latest, approvedAssets: spineRender.approvedAssets, assetBytes, entry: options.entry, revision: options.revision, mode: options.mode, modelName: options.activeModelName?.() ?? options.modelName });
        registeredMs = since();
        emit({ type: 'registered', ms: registeredMs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A failure here leaves the daemon holding whatever the try block finished before it
        // threw. When this run just created the project, that partial state is ours alone to
        // clean up — nobody else has seen this project id yet — so it is deleted rather than left
        // for the caller to find. A `--project <id>` the caller supplied is never this run's to
        // delete: it may predate this run or be reused by something else, so it is left in place
        // and the error says the file set may be partial instead.
        if (created) {
          let deleteError: unknown;
          try {
            await realPublisher.deleteProject();
          } catch (err) {
            deleteError = err;
          }
          if (deleteError === undefined) {
            throw new Error(`strict publish failed after creating project ${realPublisher.projectId}; the new project was removed: ${message}`);
          }
          const deleteMessage = deleteError instanceof Error ? deleteError.message : String(deleteError);
          throw new PublishRollbackError(
            realPublisher.projectId,
            `strict publish failed after creating project ${realPublisher.projectId}, and removing it also failed (${deleteMessage}): ${message}`,
          );
        }
        throw new Error(`strict publish failed on project ${realPublisher.projectId}; it may hold a partial file set: ${message}`);
      }
    }
  } else if (publisher) {
    await publishFinalState({ publisher, pkg, working, latest, approvedAssets: spineRender.approvedAssets, assetBytes, entry: options.entry, revision: options.revision, mode: options.mode, modelName: options.activeModelName?.() ?? options.modelName });
    registeredMs = since();
    emit({ type: 'registered', ms: registeredMs });
  }

  // `verifyAfterPublish`: the page is published (or, no publisher at all, would have been — a
  // dry run still gets a preview event, `url` falling back to the entry name). The clock this
  // option exists for stops at the `preview` event; the faithfulness check below runs after it,
  // once, with no in-run repair — see the option's own doc comment on why a flag is left exactly
  // as filled here rather than fixed on the spot.
  if (options.verify && options.verifyAfterPublish) {
    const previewMs = since();
    const previewUrl = registeredPublisher ? `${registeredPublisher.projectId}/${options.entry}` : options.entry;
    emit({ type: 'preview', url: previewUrl, ms: previewMs });

    const verifyStarted = now();
    const checkOnce = makeCheckOnce(options.verify, options.brief, options.signal, personNamePaths, quotePaths, pkg.family, contactPaths, traceablePaths, destinationPaths, completeHoursLabelPaths, altTextPaths, exactDatePaths, completeHoursRowValuePaths, completeHoursGroups, hoursNullPaths);
    const { slots, illustrative } = gateSlots(working);
    let attempt: CheckAttempt;
    try {
      attempt = await checkOnce(slots, headingTextsOf(working), working);
      // Same link-honesty fold as the pre-publish block, against the page that actually
      // published (`latest.html`) rather than a fresh render — there is no repair here
      // (verifyAfterPublish never repairs, by design; see the option's own doc comment), only
      // reporting, so a dishonest link surfaces in `verify.remaining` for this mode too.
      attempt = { ...attempt, flagged: mergeLinkHonesty(attempt.flagged, latest.html, pkg.checkLinkHonesty) };
    } catch (error) {
      // The page already published; a check failure — cancellation included — must never look
      // like a failed build from here on, so it is folded into `verify.skipped` rather than
      // rethrown. See the option's doc comment. `checkOnce` (`makeCheckOnce`) already absorbs
      // every OTHER failure into its own returned `skipped` result and rethrows only a genuine
      // cancellation, so this catch is reached for that reason specifically — `skipReason` names
      // it explicitly (`'cancelled'`) rather than reporting a check that was still running as
      // `'jev-refused'`, so a build cancelled mid-check reads as cancelled, not as Jev failing.
      attempt = isRunCancellation(error, options.signal)
        ? { flagged: [], ms: 0, calls: 0, skipped: 'the run was cancelled while the deferred check was still running', skipReason: 'cancelled' }
        : { flagged: [], ms: 0, calls: 0, skipped: error instanceof Error ? error.message : String(error), skipReason: 'jev-refused' };
    }
    const flaggedPaths = attempt.flagged.map((flag) => flag.path);
    verify = {
      provider: 'jev',
      checked: slots.length,
      illustrative,
      flagged: flaggedPaths,
      repaired: 0,
      remaining: flaggedPaths,
      ms: Math.round(now() - verifyStarted),
      ...(attempt.skipped !== undefined ? { skipped: attempt.skipped } : {}),
      ...(attempt.oversized && attempt.oversized.length > 0 ? { oversized: attempt.oversized } : {}),
    };
    emit({ type: 'verify', checked: verify.checked, illustrative: verify.illustrative, flagged: flaggedPaths.length, repaired: 0, remaining: flaggedPaths.length, ms: verify.ms, flaggedPaths, remainingPaths: flaggedPaths, ...(attempt.skipReason !== undefined ? { skipped: attempt.skipReason } : {}) });
  }

  return {
    family: pkg.family,
    mode: options.mode,
    model: options.activeModelName?.() ?? options.modelName,
    entry: options.entry,
    revision: options.revision,
    projectId: registeredPublisher?.projectId,
    timings: { assetsMs, firstTokenMs, firstPaintMs, finalPaintMs, registeredMs, totalMs: since() },
    calls,
    repairs,
    retries,
    paints,
    usage,
    applied,
    missing: [...missingByUnit.values()].flat(),
    nulled: [...nulledByUnit.values()].flat(),
    truncated,
    ...(droppedSections.length > 0 ? { droppedSections } : {}),
    units: unitReports,
    recipeDigest: latest.manifest.metadata.agencySite.recipeDigest,
    recipe: working,
    html: latest.html,
    manifest: latest.manifest,
    approvedAssets: latest.approvedAssets,
    ...(pkg.checkRenderQuality ? { renderQuality: checkRendered(latest) } : {}),
    verify,
    ...(strict ? { strict } : {}),
    ...(sectionOverlay ? { sectionOverlay } : {}),
    ...(options.effects || options.effectsDecision
      ? { effects: mergeEffectsResult(options.effectsDecision ?? resultOfPlan(options.effects ?? { effects: [] }), options.effects, latest.effects) }
      : {}),
  };
}

/** Whether a strict run may publish: verify ran, nothing remains flagged, and nothing was left
 * unchecked as oversized. A skipped check (network failure, timeout) fails closed too. */
function strictPassed(verify: RunReport['verify']): boolean {
  return verify !== undefined && verify.skipped === undefined && verify.remaining.length === 0 && (verify.oversized === undefined || verify.oversized.length === 0);
}

function strictFailReason(verify: RunReport['verify']): string {
  if (verify === undefined) return 'verify did not run';
  if (verify.skipped !== undefined) return `verify was skipped: ${verify.skipped}`;
  if (verify.oversized && verify.oversized.length > 0) return `too large to check: ${verify.oversized.join(', ')}`;
  return `unresolved: ${verify.remaining.join(', ')}`;
}

/**
 * Publishes the fast lane's terminal artifacts for a project: the run's recipe, the approved
 * assets manifest, the human-readable state note, and every approved asset's bytes, all under
 * `agency-site-state/r<revision>/`. Shared by the progressive path (assets and pages already
 * saved as the fill ran) and the strict deferred path (everything saved here, once, after the
 * gate passes), so the two publish targets cannot drift apart.
 */
async function publishFinalState(params: {
  publisher: ProjectPublisher;
  pkg: FamilyPackage;
  working: Json;
  latest: RenderResult;
  approvedAssets: RenderResult['approvedAssets'];
  /** Structural output checks; separate from factual verification and visual evaluation. */
  renderQuality?: RenderQualityReport;
  assetBytes: Map<string, Buffer>;
  entry: string;
  revision: number;
  mode: FastLaneMode;
  modelName: string;
}): Promise<void> {
  const { publisher, pkg, working, latest, approvedAssets, assetBytes, entry, revision, mode, modelName } = params;
  const stateDir = `agency-site-state/r${revision}`;
  const digest = latest.manifest.metadata.agencySite.recipeDigest;
  const stateNote = [
    `# ${String((isObject(working) && isObject(working.brand) ? working.brand.name : undefined) ?? pkg.family)} — Agency Site state (registered r${revision})`,
    '',
    `Generated by the fast lane (${mode} mode, ${modelName}) on ${new Date().toISOString()}.`,
    '',
    `- Entry: \`${entry}\``,
    `- Family: ${pkg.family}, revision ${revision}`,
    `- Recipe digest: \`${digest}\``,
    `- Recipe: \`${stateDir}/recipe.json\`; approved assets: \`${stateDir}/approved-assets.json\`; asset files: \`${stateDir}/assets/\``,
    '',
    ...(latest.manifest.metadata.agencySite.outputScope === 'static-prototype'
      ? ['Output scope: static prototype. Navigation, forms and controls are not wired; the page says so in its footer.', '']
      : []),
    'Every business fact in this build comes from the brief given to the fast lane. Review before client use.',
    '',
  ].join('\n');
  await settleAll([
    publisher.saveFile(`${stateDir}/recipe.json`, `${JSON.stringify(working, null, 2)}\n`),
    publisher.saveFile(`${stateDir}/approved-assets.json`, `${JSON.stringify(pkg.manifest, null, 2)}\n`),
    publisher.saveFile('AGENCY-SITE-STATE.md', stateNote),
    ...approvedAssets.map((asset) => {
      const bytes = assetBytes.get(asset.file);
      return bytes ? publisher.saveFile(`${stateDir}/assets/${asset.file}`, bytes, 'base64') : Promise.resolve();
    }),
  ]);
}

/**
 * The rule every faithfulness repair states: remove the unsupported fact, never replace it. A
 * substitute number, date or name is just another invention, which is what the gate flagged.
 *
 * G8 dry run: the rule used to offer "rewrite the value in neutral wording" with "Ask for pricing"
 * as its example. For a claim-bearing sentence that is a trap — "pricing" is itself a claim word
 * the sentence gate traces, and a neutral paraphrase of a claim is still an untraced claim — so
 * the repair flagged again and did not converge in two rounds. The rule now offers the two moves
 * that do pass: the brief's own words for the fact, or no claim at all.
 */
export const FAITHFULNESS_RULE = 'Fix each flagged value: return null where NULLABLE names the value; otherwise either state the fact only in the brief\'s own words (copy the brief sentence quoted for it, shortened to fit, with no word added or swapped), or delete the claim and write a short label that has no number, date, time, price, amount, count, distance, award or sales word (free, price, order, ship, delivery, return, stock, sale, gift). Do not paraphrase a claim or swap in synonyms: a reworded claim is flagged again. Never replace it with a different number, date, time, price, amount, count, name, contact detail or quote. Change no other value unless its item\'s editable fields are explicitly allowed in REPAIR SCOPE.';

/**
 * The repair prompt for a unit whose flagged slots state a fact the brief does not contain: names
 * every flagged path with the text that triggered the flag and, when `brief` is given, what to
 * change (`repair-hints.ts`: the words the brief lacks and the brief's own closest sentences),
 * then states the rule once.
 */
export function faithfulnessRepairError(
  flags: Array<{ path: string; text: string }>,
  brief?: string,
  hoursLabelPaths: ReadonlySet<string> = new Set(),
  rowValueOf: (labelPath: string) => string | null | undefined = () => undefined,
  hoursValuePaths: ReadonlySet<string> = new Set(),
  hoursValuePathOf: (labelPath: string) => string | undefined = () => undefined,
): string {
  const named = flags.map((flag) => {
    const hint = brief === undefined ? ''
      : hoursLabelPaths.has(flag.path) ? `${hoursLabelRepairHint(brief)}${hoursValuePathOf(flag.path) === undefined ? '' : ` Its value slot is ${hoursValuePathOf(flag.path)}: if no row fits, return null there.`}`
        : hoursValuePaths.has(flag.path) ? hoursNullRepairHint()
          : claimRepairHint(brief, flag.text);
    return `${flag.path} states a fact the brief does not contain: "${flag.text}"${hint ? ` (${hint})` : ''}`;
  }).join('; ');
  return `${named}. ${FAITHFULNESS_RULE}`;
}

/**
 * `unit.template` with every flagged string slot's example text cut to the claim sentences the
 * brief supports (`repair-hints.ts`'s `withoutUntracedClaims`) — the TEMPLATE a faithfulness
 * repair shows, so the model is never handed the reference page's own unsupported claim to fall
 * back on. Shape and every other value are unchanged.
 */
function templateWithoutUntracedClaims(unit: Unit, flaggedPaths: ReadonlySet<string>, brief: string): Json {
  const prefix = pathLabel(unit.path);
  const out = structuredClone(unit.template);
  for (const flagged of flaggedPaths) {
    if (!flagged.startsWith(`${prefix}.`) && !flagged.startsWith(`${prefix}[`)) continue;
    const rest = flagged.slice(prefix.length);
    const segments = [...rest.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
    if (segments.length === 0) continue;
    const parent = getAtPath(out, segments.slice(0, -1));
    const last = segments[segments.length - 1]!;
    const value = getAtPath(out, segments);
    if (typeof value !== 'string') continue;
    const kept = withoutUntracedClaims(brief, value);
    if (Array.isArray(parent) && typeof last === 'number') parent[last] = kept;
    else if (isObject(parent) && typeof last === 'string') (parent as JsonObject)[last] = kept;
  }
  return out;
}

/** `value` (rooted at `at`) with the string leaves at `paths` replaced by null. */
function withNulls(value: Json, at: string, paths: ReadonlySet<string>): Json {
  if (typeof value === 'string') return paths.has(at) ? null : value;
  if (Array.isArray(value)) return value.map((item, index) => withNulls(item, `${at}[${index}]`, paths));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withNulls(child, at ? `${at}.${key}` : key, paths)]));
  return value;
}

/** Replace named text/null leaves with accepted context, including explicit null answers. */
function withTexts(value: Json, at: string, texts: ReadonlyMap<string, string | null>): Json {
  if (typeof value === 'string' || value === null) return texts.has(at) ? texts.get(at)! : value;
  if (Array.isArray(value)) return value.map((item, index) => withTexts(item, `${at}[${index}]`, texts));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withTexts(child, at ? `${at}.${key}` : key, texts)]));
  return value;
}

/** Two marker shapes of the same template merged: a leaf keeps whichever side marks it. */
function mergeShapes(a: Json | undefined, b: Json | undefined): Json | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((item, index) => mergeShapes(item, b[index]) ?? {});
  if (isObject(a) && isObject(b)) {
    const out: JsonObject = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = mergeShapes(a[key], value) ?? value;
    return out;
  }
  return typeof a === 'string' ? a : b;
}

/** `value` (rooted at path label `at`) with every string leaf whose path is in `paths` replaced by
 * `placeholder`. Shape and every other value are unchanged. */
function withPlaceholders(value: Json, at: string, paths: ReadonlySet<string>, placeholder: string): Json {
  if (typeof value === 'string') return paths.has(at) ? placeholder : value;
  if (Array.isArray(value)) return value.map((item, index) => withPlaceholders(item, `${at}[${index}]`, paths, placeholder));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withPlaceholders(child, at ? `${at}.${key}` : key, paths, placeholder)]));
  return value;
}

/** Sets the leaf at a path label to null, in place (no-op when the path is absent). */
function setNullAtPathLabel(recipe: Json, label: string): void {
  const segments = [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
  const parent = getAtPath(recipe, segments.slice(0, -1));
  const last = segments[segments.length - 1];
  if (Array.isArray(parent) && typeof last === 'number' && last < parent.length) parent[last] = null;
  else if (isObject(parent) && typeof last === 'string' && last in parent) (parent as JsonObject)[last] = null;
}

/** The text (or null) at a path label such as `sections[3].items[0].value`; undefined when absent. */
function textAtPathLabel(recipe: Json, label: string): string | null | undefined {
  const segments = [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
  const value = getAtPath(recipe, segments);
  return typeof value === 'string' || value === null ? value : undefined;
}

/**
 * The string leaf at a path label, replaced with `text` — copy-on-write, never in place. Returns a
 * NEW root: every container from the root down to the leaf's own parent is a fresh shallow copy,
 * so nothing this touches is shared with `recipe` (or with anything else still holding a reference
 * to one of `recipe`'s nodes) afterward. `recipe` itself is never mutated. A no-op (returns `recipe`
 * unchanged, same reference) when the path is absent or not a string there already.
 *
 * Round 2 audit (Opus F1): the earlier in-place version mutated a node `mergeAtPath` may not have
 * cloned on this merge — a node still shared with `working`'s pre-merge state, or with any earlier
 * snapshot — which is exactly the "never mutated, only replaced" invariant every other merge point
 * in this file depends on. `applyUnit`'s own callers reassign their local `merged` from this
 * function's return value; nothing here mutates its argument.
 */
export function setTextAtPathLabel(recipe: Json, label: string, text: string): Json {
  return replaceStringLeaf(recipe, label, text);
}

function replaceStringLeaf(recipe: Json, label: string, text: string | null): Json {
  const segments = [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
  const rewrite = (node: Json, index: number): Json => {
    if (index === segments.length) return typeof node === 'string' ? text : node;
    const key = segments[index]!;
    if (Array.isArray(node) && typeof key === 'number') {
      if (key < 0 || key >= node.length) return node;
      const child = rewrite(node[key]!, index + 1);
      if (child === node[key]) return node;
      const copy = node.slice();
      copy[key] = child;
      return copy;
    }
    if (isObject(node) && typeof key === 'string' && key in node) {
      const child = rewrite((node as JsonObject)[key]!, index + 1);
      if (child === (node as JsonObject)[key]) return node;
      return { ...node, [key]: child };
    }
    return node;
  };
  return rewrite(recipe, 0);
}

/** `slots` plus every hours label `recipe` holds as text that `slots` leaves out (a locked one). */
function withRecipeHoursSlots(slots: readonly FaithfulnessSlot[], hoursLabelPaths: ReadonlySet<string>, recipe: Json | undefined): FaithfulnessSlot[] {
  if (recipe === undefined) return [...slots];
  const present = new Set(slots.map((slot) => slot.path));
  const missing = [...hoursLabelPaths].filter((path) => !present.has(path)).flatMap((path) => {
    const text = textAtPathLabel(recipe, path);
    return typeof text === 'string' ? [{ path, text }] : [];
  });
  return [...slots, ...missing];
}

/**
 * Heading slots (`heading`, `title`, `eyebrow`) of each section holding a variable-length list
 * (`minItems` < the spine's length) that state a size within the list's range other than its
 * current length. Headings only: body copy says "two ways" or "24/7" for reasons unrelated to the
 * list.
 */
function countClaimFlags(recipe: Json, spine: Json): string[] {
  const sections = isObject(recipe) && Array.isArray(recipe.sections) ? recipe.sections : [];
  const spineSections = isObject(spine) && Array.isArray(spine.sections) ? spine.sections : [];
  const flags: string[] = [];
  sections.forEach((section, index) => {
    if (!isObject(section) || !Array.isArray(section.items) || !isObject(section.text)) return;
    const full = spineSections[index];
    const length = section.items.length;
    const max = isObject(full) && Array.isArray(full.items) ? full.items.length : length;
    if (length >= max) return;
    for (const key of ['heading', 'title', 'eyebrow']) {
      const text = (section.text as JsonObject)[key];
      if (typeof text !== 'string') continue;
      const stated = statedListSizes(text).filter((n) => n >= 1 && n <= max && n !== length);
      if (stated.length > 0) flags.push(`sections[${index}].text.${key}`);
    }
  });
  return flags;
}

/**
 * The list sizes a text states: a whole small number (digits or an English word, 0–12) counting a
 * plural noun, at most one word apart, hyphenated words included ("Six guides", "5 quick steps",
 * "Six how-to guides"), or a bracketed count ("Guides (6)"). A number in a phrase ("One place to
 * start"), a version ("Loomwork 2.0 guides") or a compound ("Two-minute guides") is not a size
 * (Sol review of #286, rounds 4 and 5).
 */
function statedListSizes(text: string): number[] {
  const out: number[] = [];
  const pattern = /(?<![\w.:/-])(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+([a-z’'-]+)(?:\s+([a-z’'-]+))?/gi;
  for (const match of text.matchAll(pattern)) {
    if (!isPluralNoun(match[2]!) && !(match[3] !== undefined && isPluralNoun(match[3]))) continue;
    const token = match[1]!.toLowerCase();
    out.push(/^\d+$/.test(token) ? Number(token) : COUNT_WORDS.indexOf(token));
  }
  for (const match of text.matchAll(/\((\d{1,2})\)/g)) out.push(Number(match[1]));
  return out;
}

/** A word that reads as a regular English plural ("guides", "steps"), not "is", "us", "this" or "class". */
function isPluralNoun(word: string): boolean {
  const lower = word.toLowerCase();
  return lower.length >= 4 && lower.endsWith('s') && !/(?:ss|us|is)$/.test(lower);
}

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** Whether any text slot under `node` states `count`, as digits or as an English number word. */
function statesCount(node: Json | undefined, count: number): boolean {
  const word = COUNT_WORDS[count];
  const pattern = new RegExp(`\\b(?:${count}${word ? `|${word}` : ''})\\b`, 'i');
  const texts = (value: Json | undefined): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts) : isObject(value) ? Object.values(value).flatMap(texts) : [];
  return texts(node).some((text) => pattern.test(text));
}

/** A path label such as `sections[2].items` as `getAtPath` segments. */
function labelSegments(label: string): Array<string | number> {
  return [...label.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
}

/** `recipe` with the node at `label` replaced by `node`, copy-on-write; an absent path is a no-op. */
function withNodeAtPathLabel(recipe: Json, label: string, node: Json): Json {
  const segments = labelSegments(label);
  const rewrite = (current: Json, index: number): Json => {
    if (index === segments.length) return node;
    const key = segments[index]!;
    if (Array.isArray(current) && typeof key === 'number' && key >= 0 && key < current.length) {
      const copy = current.slice();
      copy[key] = rewrite(current[key]!, index + 1);
      return copy;
    }
    if (isObject(current) && typeof key === 'string' && key in current) return { ...current, [key]: rewrite((current as JsonObject)[key]!, index + 1) };
    return current;
  };
  return rewrite(recipe, 0);
}

/** `setTextAtPathLabel`'s null twin: one string leaf becomes null, copy-on-write; any other path is a no-op. */
function withNullAtPathLabel(recipe: Json, label: string): Json {
  return replaceStringLeaf(recipe, label, null);
}

/**
 * The nearest enclosing repeatable-array-item container of `path` — its text up to and including
 * the LAST `[N]` index segment, with the trailing `.field` component after it dropped (e.g.
 * `sections[3].items[0].name` -> `sections[3].items[0]`). `undefined` when `path` names no array
 * item at all (a top-level section field, or an item's own index position itself). Used to widen
 * a faithfulness repair's unlock set from a single flagged leaf to its WHOLE array item — see the
 * repair-locks comment above.
 */
function itemContainerPrefix(path: string): string | undefined {
  return /^(.*\[\d+\])\.[^.[\]]+$/.exec(path)?.[1];
}

/**
 * Every strict ancestor container path of `path` (in the same path-label grammar `pathLabel` and
 * `slotPathsOf` print), from its immediate parent up to (and past) the root it starts at — never
 * `path` itself. `incompleteRepairScope` uses this to find every candidate whole-group-null
 * position (`atomKindsFor`'s group kind) a missing leaf sits inside: only the caller (via
 * `report.nullablePaths`) knows which ancestor, if any, this family schema actually lets be
 * null, so every one of them is offered rather than guessed at here. A path past this unit's own
 * root (or the whole page root) is harmless to include: nothing else ever looks it up.
 */
function pathAncestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let rest = path;
  for (;;) {
    const match = /(\.[^.[\]]+|\[\d+\])$/.exec(rest);
    if (!match) break;
    rest = rest.slice(0, -match[0].length);
    if (rest === '') break;
    ancestors.push(rest);
  }
  return ancestors;
}

/**
 * Every path under `value` (text and null leaves, and the groups holding them), as path labels
 * rooted at `at`. A faithfulness repair locks each one that holds no flagged slot, so neither a
 * slot nor a whole nullable group it does not concern can change.
 */
function slotPathsOf(value: Json, at: string, out = new Set<string>()): Set<string> {
  out.add(at);
  if (Array.isArray(value)) {
    value.forEach((item, index) => slotPathsOf(item, `${at}[${index}]`, out));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) slotPathsOf(child, `${at}.${key}`, out);
  }
  return out;
}
