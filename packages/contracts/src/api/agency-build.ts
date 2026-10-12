/**
 * The fast-lane build job API.
 *
 * `POST /api/agency/build`             start one build; answers 202 with a `queued` snapshot
 * `GET  /api/agency/builds`            the builds this daemon still remembers, newest first
 * `GET  /api/agency/families`          the bundled families, each with its page kind and output scope
 * `GET  /api/agency/builds/:id`        one snapshot, events included
 * `GET  /api/agency/builds/:id/events` SSE: the events so far, then live ones, then one `status`
 * `GET  /api/agency/builds/:id/agui`   SSE: the same build as AG-UI events (see the
 *                                       `AgencyBuildAgui*` types at the end of this file)
 * `POST /api/agency/builds/:id/cancel` ask the build to stop; answers 202 with the snapshot
 * `POST /api/agency/builds/:id/fork`   "start from this build": a new build with a saved build's
 *                                       family, brief and options, publishing to a NEW project
 * `POST /api/agency/builds/:id/repair` `verify: 'after'` only: re-fills every slot the deferred
 *                                       check flagged (every other slot locked), re-verifies just
 *                                       those, and answers 200 with what changed
 *
 * `verify: 'after'` (the verify-after-render play): the build publishes BEFORE the faithfulness
 * check runs, so its own preview appears sooner, and the check's verdict lands on the build's
 * `verify` field once the check completes — `pending` from the moment the page publishes, `done`
 * (with the flagged slot paths) or `skipped` (the check itself could not run) once the background
 * check resolves, which can be well after this endpoint's own 202 response returned. Nothing here
 * waits on it: a client watching `GET .../:id` or the SSE stream sees `verify` update in place.
 * `POST .../:id/repair` is the only thing that acts on a `done` verdict with flagged paths.
 *
 * Every endpoint is local same-origin only: a build spends model credit and writes a project.
 *
 * WHAT SURVIVES A RESTART, honestly: `GET /api/agency/builds` and `GET /api/agency/builds/:id`
 * DO survive — `apps/daemon/src/agency-build-store.ts` persists every build's snapshot to
 * `<RUNTIME_DATA_DIR>/agency-builds/index.json` on creation and again on every terminal
 * transition, bounded by `AGENCY_BUILD_HISTORY_LIMIT`, and the daemon reloads that file before it
 * answers any build request. What does NOT survive is anything live: a build the file still shows
 * mid-flight when the daemon starts is rewritten `failed` with a fixed sentence — the process that
 * was running it is gone, so it is never shown as running and never resumed. The one-at-a-time
 * lock, the SSE listeners, and cancellation are all in-memory only and reset on every restart. A
 * 404 from `/api/agency/builds/:id` still is not proof the build never happened — it may simply be
 * older than the history limit.
 *
 * `POST .../:id/fork` is what makes that surviving history actionable rather than archival: given
 * a saved build's id, it starts a NEW build using that build's family, brief and options (the
 * caller may override the brief text), publishing into a new project. It answers exactly like
 * `POST /api/agency/build` — 202 with the new build's queued snapshot, the same busy/lock rules —
 * and refuses with `BUILD_NOT_FORKABLE` when the saved build never finished and published a
 * project, or when the project it made was rolled back: forking either would repeat an unproven
 * bet rather than start from a working one.
 *
 * These DTOs are a SANITISED view of the fast lane's own types, not a mirror of them. The fast
 * lane's `RunEvent` can carry the model's output — a repair's message quotes the text that was
 * refused (`packages/agency-fast-lane/src/run.ts`, `RepairReason`) — and the brief, the recipe and
 * any upstream response body are likewise the daemon's alone. Nothing here has a field they could
 * travel in: an event carries a label, fixed codes and counts; an error carries a fixed sentence
 * chosen from a closed set of codes. Keep it that way — a field added here is a field somebody
 * will fill.
 */

import type { ApiErrorCode } from '../errors.js';
import type { PageKind } from './design-index.js';

/**
 * What a family's output is (C16). `site`: a working page. `static-prototype`: an app or dashboard
 * family's page, whose navigation, forms and controls are NOT wired — family pages ship
 * `script-src 'none'`. Derived from the family registry's `pageKind` in one place (the fast lane's
 * `outputScopeOf`), and carried by the export too: the page ends with a visible "Static prototype"
 * note and its artifact manifest sets `metadata.agencySite.outputScope`.
 */
export type AgencyOutputScope = 'site' | 'static-prototype';

/** How many builds the daemon keeps in memory before the oldest is dropped. */
export const AGENCY_BUILD_HISTORY_LIMIT = 50;

/**
 * Where a build is.
 *
 * The five running states are derived from the build's own events and only ever move forwards:
 * `queued` until the job starts, `routing` until the brief has a family, `building` while the
 * model fills the page, `verifying` while Jev grades it, `publishing` while the project is
 * written. The four terminal states are the build's outcome — `done` and `unrouted` are answers,
 * `failed` and `cancelled` are not.
 */
export type AgencyBuildStatus =
  | 'queued'
  | 'routing'
  | 'building'
  | 'verifying'
  | 'publishing'
  | 'done'
  | 'unrouted'
  | 'failed'
  | 'cancelled';

/** Why a unit had to be asked for again. The fast lane's `RepairReason`, which is a fixed code. */
export type AgencyBuildRepairReason = 'invalid' | 'incomplete' | 'malformed' | 'unfaithful';

/**
 * Why a `BUILD_FAILED` build stopped on a unit: a spent repair budget (a repair reason), the
 * fill-and-repair deadline or a model call's own time limit (`deadline`), or a provider/transport
 * failure while that unit's model call was open (`transport`).
 */
export type AgencyBuildFailureReason = AgencyBuildRepairReason | 'deadline' | 'transport';

/** The build's own progress events, in the order they happened. `seq` is also the SSE event id. */
export type AgencyBuildEventType =
  | 'route'
  | 'project'
  | 'lock-wait'
  | 'sections'
  /** The effect plan settled: `label` is `"<applied> applied, <skipped> skipped"`; the ids are on
   * the snapshot's `effects`. Carries no Jev answer text. At most once per build. */
  | 'effects'
  | 'render-quality'
  | 'assets'
  | 'first-token'
  | 'unit'
  | 'merged'
  | 'paint'
  | 'repair'
  | 'clipped'
  | 'verify'
  | 'registered'
  | 'preview'
  /** The primary fill provider failed before any output; `label` is the provider now used and
   * `reason` is an `AgencyBuildFailoverReason`. At most once per build. */
  | 'failover'
  /** `composition: 'blocks' | 'auto'` only, once, before the fill: the block plan the page is
   * composed from, or the fixed reason the family route runs instead — see `composition`. */
  | 'composition'
  /** A unit's model call hit a transport-class failure and is being retried fresh, to the SAME
   * provider, before the build gives up on it — never a failover. `label` is the unit, `attempt`
   * counts re-requests for that unit across the WHOLE build (its fill call and every later repair
   * call together, not per model call), 1 or 2. `reason` is an `AgencyBuildTransportRetryReason`.
   * See the fast lane's `run.ts`. */
  | 'transport-retry'
  /** A unit's own merged text was rewritten to a punctuation form the unchanged deterministic
   * hours gate already accepts for the SAME brief row — never a different row, day or time.
   * `path`/`before`/`after` name exactly which slot changed and how, unlike `clipped.paths`,
   * because this rewrite is itself the fact worth showing (an owner-ruled content normalization,
   * not an incidental detail of a unit that already has its own label). See the fast lane's
   * `normalizeHoursRowSeparator` in `run.ts`. Counts toward nothing and hides nothing. */
  | 'hours-normalized'
  /** A composed block's faithfulness repair answer was thrown away and the previous fill kept.
   * `label` is the block, `reason` an `AgencyBuildRepairReason` (`malformed` or `invalid`). The
   * validator's own message stays in the daemon log (B-113). */
  | 'repair-discarded';

/** Why a build switched fill provider. The fast lane's `FailoverReason`, a fixed code. */
export type AgencyBuildFailoverReason = 'rate-limited' | 'server-error' | 'timeout' | 'network' | 'key-unavailable';

/** Why a `transport-retry` event fired. The fast lane's `TransportRetryReason`, a fixed code —
 * never a copy of a provider's own error text. */
export type AgencyBuildTransportRetryReason = 'ECONNRESET' | 'ETIMEDOUT' | 'ECONNREFUSED' | 'UND_ERR_SOCKET' | 'terminated' | 'http-5xx' | 'http-429' | 'network';

/**
 * One progress event, as a client sees it.
 *
 * Every field is optional but `seq`, `at` and `type`, because the union on the daemon's side is
 * twelve differently-shaped members and a client renders the ones it recognises. What matters is
 * what is NOT here: no message, no error text, no path list, no html, no recipe.
 */
export interface AgencyBuildEvent {
  /** Checked page structure, separate from factual verification. No generated text. */
  renderQuality?: AgencyBuildRenderQuality;
  /** 1-based, gapless, and the SSE `id` of this event, so a reconnect can resume from it. */
  seq: number;
  at: string;
  type: AgencyBuildEventType;
  /** The unit, paint or slot this event is about (`hero`, `registered`). Never model output. */
  label?: string;
  /** Milliseconds since the build started, as the fast lane stamps its own lines. */
  ms?: number;
  /** `assets`: how many were uploaded. `paint`: which paint this was. */
  count?: number;
  /** `unit`: how many repairs that unit needed. */
  repairs?: number;
  /**
   * Why, as a fixed code — never a message.
   *
   * Two vocabularies share the field, and `type` says which one applies: on a `repair` it is an
   * `AgencyBuildRepairReason` (why the unit was asked for again); on a `verify` it is why the
   * faithfulness check could not run at all, and its absence there means the check DID run —
   * `'cancelled'` is `verify: 'after'` only, the one case where the check was still in flight when
   * the build was told to stop (see `POST .../:id/cancel`'s doc comment). No other event type sets
   * it, except `failover`, where it is an `AgencyBuildFailoverReason`. One field rather than two
   * because a client reads `type` first anyway, and a second optional code would only be empty
   * on every event but one.
   */
  reason?: AgencyBuildRepairReason | 'jev-unavailable' | 'jev-refused' | 'cancelled' | AgencyBuildFailoverReason | AgencyBuildTransportRetryReason;
  /** `transport-retry`: which attempt this is (1 or 2 — see `AgencyBuildEventType`'s doc). */
  attempt?: number;
  /** `hours-normalized`: the slot's path label, and its text before and after the rewrite. */
  path?: string;
  before?: string;
  after?: string;
  /**
   * `verify`: what the faithfulness check found. `checked` counts fact slots; `illustrative`
   * counts the filled sample-data slots the family marks `x-mock` (shown under a visible caption),
   * which the check skips. `illustrative` is required, and `0` when nothing was skipped, so a
   * missing count is never read as "none skipped". A build persisted before the count existed can
   * still lack it at runtime; clients show that as "not reported", never as `0`.
   */
  counts?: { checked: number; illustrative: number; flagged: number; repaired: number; remaining: number };
  /** `route`: whether the brief found a family. */
  decision?: 'routed' | 'unrouted';
  /** `route`: the family it found. `project`: nothing — see `projectId`. */
  family?: string;
  /** `route`: that family's output scope — see `AgencyOutputScope`. */
  outputScope?: AgencyOutputScope;
  /** `project`: which project the output goes to. */
  projectId?: string;
  /** `project`: whether this build created that project or was given it. */
  created?: boolean;
  /** `preview`: the private preview's url — `verify: 'after'` only, the moment the page has
   * published (or, no project at all, would have) and before the deferred check has run. */
  url?: string;
  /**
   * `sections`: the optional-section decision, taken once before the fill. Section ids are the
   * family recipe's own fixed ids (`reviews`, `watson-about`), never model output. `sectionSource`
   * says who decided: `jev` (the keep/drop request answered), `hint` (the request's `sections`
   * decided and Jev decided nothing: it was not asked, or — with `reason` set — could not answer),
   * `brief` (only a section's own precondition decided: a testimonial section the brief gives no
   * quote for), or `default` (nothing decided, so every section was kept). When Jev could not
   * answer, `reason` is `jev-unavailable` and every unhinted section was kept.
   */
  keptSections?: string[];
  droppedSections?: string[];
  sectionSource?: 'jev' | 'hint' | 'brief' | 'default';
  /** `composition`: the decision — block ids, spine, direction and fixed codes only. */
  composition?: AgencyBuildCompositionResult;
}

/**
 * How a build composes its page (`AgencyBuildRequest.composition`). `family` (the default) is the
 * family route: one family's fixed recipe. `blocks` asks Jev for a spine, one design direction and
 * an ordered list of 3 to 7 reviewed insertable blocks (one hero first, one footer last when the
 * spine has one, no section kind twice except features) and composes them as one page; it falls
 * back to the family route with a fixed reason when Jev cannot plan. `auto` composes only when
 * the routed spine has at least three reviewed blocks that cover a hero, a body section and a cta
 * or footer; otherwise the family route runs and the build records why.
 */
export type AgencyBuildComposition = 'family' | 'blocks' | 'auto';

/** Why a `blocks`/`auto` build ran the family route instead. Fixed codes only. */
export type AgencyCompositionFallback =
  | 'jev-key-missing' | 'jev-unreachable' | 'jev-timeout' | 'jev-unauthorized' | 'jev-rate-limited' | 'jev-http-error' | 'jev-bad-answer'
  | 'no-spine' | 'spine-below-threshold' | 'no-coverage' | 'too-few-blocks' | 'planner-unavailable' | 'family-named'
  /** `auto`: the model's own `spine`/`family`/`skin` answer was itself malformed or named a
   * family the registry does not list — its spine is untrusted too, so `auto` refuses to compose
   * from it (mirrors the fast lane's `CompositionFallback`). */
  | 'route-invalid'
  /** `auto`: the brief states opening hours, the route found a family, and no planned block shows
   * hours — the family's page keeps them (mirrors the fast lane's `CompositionFallback`). */
  | 'hours-not-covered';

/** A composed page's plan: ids only, in page order. Kept on the build so a fork or a repair
 * replays the same page instead of asking Jev again. */
export interface AgencyBuildBlockPlan {
  spine: string;
  directionId: string;
  blocks: string[];
}

/** What a `blocks`/`auto` build decided. Mirrors the fast lane's `CompositionResult`. */
export interface AgencyBuildCompositionResult {
  requested: AgencyBuildComposition;
  used: 'blocks' | 'family';
  /** `used: 'blocks'`: the plan, in page order; `blocks` are section-catalog ids
   * (`cult:…`, `hyperui:…`), each published as `data-od-selected-section` on its wrapper. */
  spine?: string;
  directionId?: string;
  blocks?: string[];
  /** Who chose the plan: Jev, or a replay of a saved build's plan (a fork or a repair). */
  source?: 'jev' | 'replay';
  /** Attempted picker + support Jev calls and elapsed planning time, separate from fill calls. */
  planner?: { calls: number; ms: number };
  /** Post-picker recovery, before render-budget drops. Only ids, probabilities and fixed codes. */
  supportGate?: {
    threshold: number;
    added: Array<{ kind: string; id: string; reason: 'jev-brief-support' | 'faq-brief-signal'; probability?: number }>;
    removed: Array<{ kind: 'faq'; id: string; reason: 'faq-no-brief-signal' }>;
    decisions: Array<{ kind: string; probability?: number; reason: 'below-threshold' | 'supported' | 'capacity' | 'faq-brief-signal' | 'faq-no-brief-signal' }>;
    skipped?: 'jev-unreachable' | 'jev-timeout' | 'jev-unauthorized' | 'jev-rate-limited' | 'jev-http-error' | 'jev-bad-answer' | 'invalid-plan';
  };
  /** `used: 'family'` after `blocks`/`auto`: why the family route ran. */
  fallback?: AgencyCompositionFallback;
  /** Blocks the 200 KiB page budget dropped, from the end, in drop order. */
  budgetDropped?: string[];
  /** Composed pages declare no effect placements, so effects are always off for them. */
  effects?: { mode: 'off'; reason: 'no-placements' };
  /**
   * The design kit the request named (`AgencyBuildRequest.designSystemId`), and whether the page
   * wears it. `applied: true` only on a composed page, which takes every colour and font from the
   * kit's approved `tokens.css`; a build that ends on the family route keeps the family's own look
   * and says `applied: false`. Absent when no kit was named.
   */
  designKit?: AgencyBuildDesignKitReceipt;
}

/** See `AgencyBuildCompositionResult.designKit`. */
export interface AgencyBuildDesignKitReceipt {
  id: string;
  /** The kit's title when the build started, for display. */
  title?: string;
  applied: boolean;
}

/**
 * Why a named design kit cannot carry a fast-lane build — answered 422 before anything starts.
 * `DESIGN_SYSTEM_NOT_SELECTABLE`: the kit is not installed, still a draft, not approved at its
 * current revision, or turned off in Settings (`details.reason` names which).
 * `DESIGN_SYSTEM_TOKENS_UNUSABLE`: the kit's `tokens.css` does not declare the colour roles a
 * composed page needs (`--bg`, `--fg`, `--accent`) in a form the fast lane reads
 * (`details.reason`: `tokens-missing`, `missing-token`, `unsupported-color`, `unsafe-font`;
 * `details.token` names the token).
 */
export type AgencyBuildDesignKitRefusalCode = 'DESIGN_SYSTEM_NOT_SELECTABLE' | 'DESIGN_SYSTEM_TOKENS_UNUSABLE';

/**
 * Why a build ended badly. Fixed codes, and the daemon's message for each is fixed text:
 *
 * - `JEV_UNAVAILABLE`   the TypeSafe key could not be resolved, so nothing could be verified.
 * - `MODEL_UNAVAILABLE` the model provider's key could not be read at call time: missing on
 *                       every provider tried, or the stored key file is unreadable (its own
 *                       sentence; never failed over, so the broken file is not hidden).
 * - `VERIFY_FAILED`     a strict build did not pass the faithfulness gate; nothing was published.
 * - `ROLLBACK_FAILED`   the build could not remove a project it had created. `projectId` on the
 *                       snapshot names it, and it is the one failure a person must act on.
 * - `BUILD_FAILED`      anything else. The real error is logged server-side against the build id.
 */
export type AgencyBuildErrorCode =
  | 'JEV_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'BUILD_FAILED'
  | 'VERIFY_FAILED'
  | 'RENDER_QUALITY_FAILED'
  | 'ROLLBACK_FAILED';

/**
 * Where a `failed` build stopped, and on what — the diagnostic half of `error`, which stays one
 * fixed sentence. Every field is structured or allowlisted, so none can carry the brief or the
 * model's output: a slot path is a label of the family's own recipe, and `lastError` is built from
 * the unit label, a fixed reason sentence, the slot path and a validator rule that only survives
 * when it matches a no-quotes, lowercase shape (`UnitRefusedError`/`refusalDetail` in the fast
 * lane). The snapshot's own `route` names the spine, family and probability the build ran with.
 */
export interface AgencyBuildFailure {
  /** The phase the build had reached when it failed. */
  step: 'queued' | 'routing' | 'building' | 'verifying' | 'publishing';
  /** `BUILD_FAILED` on a unit: the unit the family compiler kept refusing, or whose model call
   * ran out of time or failed in transport (`page` for a whole-page call). */
  unit?: string;
  /** Why that unit failed: a repair reason code, `deadline` or `transport`. */
  reason?: AgencyBuildFailureReason;
  /** The slot path the compiler's last refusal named (`sections[8].text.phone`). */
  slot?: string;
  /** `BUILD_FAILED` from a spent repair budget: the last validation error, as
   * `<unit>: <reason sentence> at <slot> (<rule>)` — slot and rule only when safe to show. */
  lastError?: string;
  /** `VERIFY_FAILED`: the slot paths still flagged after the in-run repair. */
  flaggedSlots?: string[];
}

/** What the run did, in numbers. The fast lane's `RunReport` minus everything it generated. */
export interface AgencyBuildSummary {
  timings: { assetsMs?: number; firstTokenMs?: number; firstPaintMs?: number; finalPaintMs?: number; registeredMs?: number; totalMs: number };
  calls: number;
  repairs: number;
  retries: number;
  paints: number;
  applied: number;
  /** Counts, not path labels: how many slots the model left empty, and how many it nulled. */
  missing: number;
  nulled: number;
  /** Tokens, as the model caller counts them (the fast lane's own `Usage`). */
  usage: { input: number; output: number; cachedRead: number };
}

export type AgencyRenderQualityCheck = 'page-heading' | 'unique-ids' | 'form-labels' | 'link-destinations';
export interface AgencyBuildRenderQuality {
  passed: boolean;
  scope: AgencyOutputScope;
  checks: AgencyRenderQualityCheck[];
  issueCounts: Array<{ check: AgencyRenderQualityCheck; count: number }>;
}

/**
 * The deferred faithfulness verdict for a `verify: 'after'` build — absent for every other verify
 * mode, since only `after` publishes before the check runs and so has anything to report before
 * the build itself is `done`.
 *
 * `pending` is set the moment the `preview` event lands (the page has published, the check has
 * not run yet); `done` once the check completes, with the flagged slots as path labels (schema
 * identifiers such as `sections[1].text.heading`, never model-generated text — the Route panel
 * shows them as unverified); `skipped` when the check itself could not run (Jev unreachable,
 * cancelled) — `flagged` is empty in that case, since nothing was actually checked. `flagged`
 * shrinks in place as `POST .../:id/repair` re-verifies just those paths; it never grows on its
 * own after `done`.
 */
export interface AgencyBuildVerifyVerdict {
  status: 'pending' | 'done' | 'skipped';
  flagged: string[];
  ms?: number;
}

/** One fill provider/model that answered a build. `sections` are the unit labels it filled
 * (`page` for a whole-page call), in first-answer order; absent when none were labelled. */
export interface AgencyBuildProviderUse {
  provider: 'deepseek' | 'cerebras';
  model: string;
  sections?: string[];
}

export interface AgencyBuildSnapshot {
  /** Structure/accessibility checks only; this does not claim visual design approval. */
  renderQuality?: AgencyBuildRenderQuality;
  id: string;
  status: AgencyBuildStatus;
  /** The family this build used, once routing has settled it. */
  family?: string;
  /** The family's output scope, as soon as the family is known (at the request for a named family,
   * at routing for `auto`). `static-prototype` means the page's controls are not wired. */
  outputScope?: AgencyOutputScope;
  /** Present when the build routed the brief itself (`family: 'auto'`). */
  route?: AgencyBuildRouteDecision;
  /** The project the output went to, or the one a failed rollback left behind. */
  projectId?: string;
  events: AgencyBuildEvent[];
  summary?: AgencyBuildSummary;
  error?: { code: AgencyBuildErrorCode; message: string };
  /** A `failed` build only: where it failed and on what — see `AgencyBuildFailure`. */
  failure?: AgencyBuildFailure;
  startedAt: string;
  finishedAt?: string;
  /** The LAST fill provider and model that answered — the failover target when the primary
   * failed. Set once the build is built and again by each repair that republishes; a repair or
   * fork still starts from the requested one. `providers` has the full list. */
  provider?: 'deepseek' | 'cerebras';
  model?: string;
  /** Every fill provider/model that produced output this build kept, in first-use order. In
   * `sections` mode calls run concurrently, so a build that fails over midway can hold sections
   * from both providers. A repair adds to it. Absent on builds that never reached the model. */
  providers?: AgencyBuildProviderUse[];
  /**
   * The effective `AgencyBuildRequest.failover` this build ran with — `true` (the default) unless
   * the request explicitly turned it off. Set once, at request time, and never changed by a
   * repair or a fork's own request (a fork always reuses the seed's setting, same as `provider`).
   * Absent on builds recorded before this field existed, which all ran with failover on.
   */
  failover?: boolean;
  /** `verify: 'after'` builds only — see `AgencyBuildVerifyVerdict`. Absent for `strict`/
   * `advisory`/`off`, whose own pass/fail already lands through `summary`/`error` before the
   * build ever reaches a terminal state. */
  verify?: AgencyBuildVerifyVerdict;
  /**
   * Set only when the request carried a `sectionSelection` and the build reached `done`
   * (`sol-design.md` §2/§3: <private-notes>/mishh-genui-production/
   * motionsites/sol-design.md). Mirrors `RunReport.sectionOverlay`
   * (`@open-design/agency-fast-lane`'s `run.ts`) exactly: `flagged`/`remaining` are the
   * selected section's own faithfulness slots, checked against the brief only. Never carries the
   * fetched `designReference` text — see `AgencyBuildRequest.designReferenceId`/
   * `designReferenceText`, neither of which this snapshot type has a field for at all.
   */
  sectionOverlay?: AgencySectionOverlayResult;
  /** Set when the request asked for `composition: 'blocks' | 'auto'`: the composed page's plan, or
   * the fixed reason the family route ran instead. A composed build's `family` is `composed`. */
  composition?: AgencyBuildCompositionResult;
  /**
   * What the build's effect plan did (Sol ruling 2026-09-25, catalog-port/sol-wiring-ruling.md):
   * which reviewed GenUI catalog components were applied to which family placements, and why the
   * rest were skipped. Present on every site build once the plan settled (`mode: 'off'` with
   * empty lists when effects were off). Ids, counts and fixed codes only — never Jev answers,
   * criteria prose or prompt text.
   */
  effects?: AgencyEffectsResult;
}

/** One selectable section's placement on top of a build's fixed family recipe. Mirrors
 * `@open-design/agency-fast-lane`'s `SectionPlacement` (`section-overlay.ts`) structurally. */
export type AgencySectionPlacement =
  | { mode: 'append'; afterSectionId: string }
  | { mode: 'replace-optional'; targetSectionId: string };

/**
 * `AgencyBuildRequest.sectionSelection` — one selectable section on top of a build's fixed family
 * recipe (`sol-design.md` §2). `entryId` is a `SectionCatalogEntry.id` (see
 * `./section-catalog.js`) whose `availability` is `"insertable"`; `directionId` is one of the
 * five built-in design directions. Both are validated against the catalog / direction list by
 * the daemon route, not merely checked for shape — an unknown or not-yet-reviewed id is a 400,
 * never a silently ignored selection.
 */
export interface AgencySectionSelectionInput {
  entryId: string;
  placement: AgencySectionPlacement;
  directionId: string;
}

/** What a successful `sectionSelection` build reports back, on `AgencyBuildSnapshot`. */
export interface AgencySectionOverlayResult {
  entryId: string;
  directionId: string;
  placement: AgencySectionPlacement;
  flagged: string[];
  remaining: string[];
}

/**
 * `AgencyBuildRequest.effects` — reviewed GenUI catalog components (`packages/genui-catalog`)
 * applied to a family's named placements (Sol ruling 2026-09-25). `'auto'` (the default for site
 * families) lets one Jev `choice` request pick a component or `none` per placement the family
 * declares; `'off'` applies none; a record names a component id (or `'none'`) per placement id,
 * and every unlisted placement stays `auto`. An explicit id still needs the family's allowlist
 * and a compatible host. At most `AGENCY_BUILD_MAX_EFFECT_HINTS` entries.
 */
export type AgencyEffectsInput = 'auto' | 'off' | Record<string, string>;

/** The fixed placement vocabulary a family may declare (`families/<family>/catalog.json`). */
export type AgencyEffectPlacementId =
  | 'hero-background' | 'hero-title' | 'eyebrow' | 'section-title' | 'card-surface' | 'nav'
  | 'section-reveal' | 'testimonials' | 'gallery' | 'cta';

export const AGENCY_EFFECT_PLACEMENT_IDS: ReadonlyArray<AgencyEffectPlacementId> = [
  'hero-background', 'hero-title', 'eyebrow', 'section-title', 'card-surface', 'nav',
  'section-reveal', 'testimonials', 'gallery', 'cta',
];

/** Why a placement got no effect. Fixed codes; never free text. */
export type AgencyEffectSkipReason =
  | 'none'            // Jev (or the caller) chose none
  | 'below-threshold' // Jev's confidence was under the auto threshold
  | 'not-allowed'     // the id is not in the family's allowlist for that placement
  | 'script-policy'   // a `js` component on a page whose CSP forbids scripts
  | 'byte-budget'     // dropped to keep the final page under the page budget
  | 'max-effects'     // the per-page or per-skin cap was reached
  | 'host-missing'    // the placement's host did not render (e.g. a dropped optional section)
  | 'host-occupied'   // the host already carries a `data-genui` component
  | 'incompatible';   // the component needs child markup the host does not have

/** Why no automatic effect was chosen at all: the one Jev request did not answer usably. */
export type AgencyEffectsJevSkip =
  | 'jev-key-missing' | 'jev-unreachable' | 'jev-timeout' | 'jev-unauthorized'
  | 'jev-rate-limited' | 'jev-http-error' | 'jev-bad-answer';

export interface AgencyEffectApplied {
  placement: AgencyEffectPlacementId;
  componentId: string;
  kind: 'css-only' | 'js';
  /**
   * `hint` = named in the request; `jev` = chosen by the one Jev request; `repair` = replayed from
   * a saved build (a repair, or recipe reconciliation), never re-decided. Provenance only: no
   * guard or policy reads it.
   */
  source: 'hint' | 'jev' | 'repair';
}

export interface AgencyEffectSkipped {
  placement: AgencyEffectPlacementId;
  componentId?: string;
  reason: AgencyEffectSkipReason;
}

/** What a build's effect plan did, on `AgencyBuildSnapshot.effects` and `RunReport.effects`. */
export interface AgencyEffectsResult {
  /** `explicit` when every applied effect came from the request; `mixed` when some did. */
  mode: 'auto' | 'off' | 'explicit' | 'mixed';
  applied: AgencyEffectApplied[];
  skipped: AgencyEffectSkipped[];
  jevSkipped?: AgencyEffectsJevSkip;
  /** Bytes the inlined CSS/JS and host attributes added to the final page. */
  bytesAdded: number;
}

/** One placement a family offers, as `GET /api/agency/families/:family/effects` lists it. */
export interface AgencyFamilyEffectPlacement {
  placement: AgencyEffectPlacementId;
  /** Which rendered element hosts it, for the picker's label (a section id, never markup). */
  host: string;
  allow: Array<{ id: string; name: string; kind: 'css-only' | 'js'; bytes: { js: number; css: number } }>;
}

export interface AgencyFamilyEffectsResponse {
  family: string;
  /** `none`: the page ships `script-src 'none'` and takes css-only effects; `hash`: a `js`
   * effect's exact inlined script is allowed by SHA-256; `inline`: the page already allows inline
   * scripts. */
  scriptPolicy: 'none' | 'hash' | 'inline';
  maxEffects: number;
  placements: AgencyFamilyEffectPlacement[];
}

export const AGENCY_BUILD_MAX_EFFECT_HINTS = 10;

/**
 * The routing answer, as the build reports it.
 *
 * Deliberately narrower than `/api/agency/route`'s full `RouteDecision`: a build's Route panel
 * already holds that decision, and what it needs from the build is only whether routing agreed
 * and which family won.
 */
export interface AgencyBuildRouteDecision {
  decision: 'routed' | 'unrouted';
  family?: string;
  /** Jev's confidence in the family it picked. */
  probability?: number;
  /** The spine code (`TL`), for a client that shows what was recognised: the top spine answer. */
  spine?: string;
  /** The spine the winning family was admitted from. It differs from `spine` when the family
   * reached through a runner-up spine (a spread spine call); grade a route on this, and report
   * `spine` beside it. Absent when unrouted, and on builds recorded before the field existed. */
  viaSpine?: string;
  /** The page kind Jev named in the route call, copied from the route decision's own `pageKind`.
   * Absent when it answered `none`, or gave no `pageKind` answer at all. */
  pageKind?: PageKind;
  /** How many Jev routing requests the decision took: 1, or 2 when a confident spine with no
   * admitted family earned the one bounded retry. Absent on builds recorded before the field. */
  routeAttempts?: number;
}

/** A row in `GET /api/agency/builds`: the snapshot without its event array, plus the explicit
 * keep/drop hints the build ran with (its request's `sections`), so a client can prefill a fork's
 * section controls. Absent when the build had no hints or the daemon no longer holds them. */
export type AgencyBuildListItem = Omit<AgencyBuildSnapshot, 'events'> & {
  sections?: Record<string, 'keep' | 'drop'>;
};

export interface AgencyBuildRequest {
  /** The client brief, plain text. Required, non-empty, at most `AGENCY_ROUTE_MAX_CHARS`. */
  brief: string;
  /** A bundled family id, or `auto` (the default) to route the brief against the Shape Atlas. */
  family?: 'auto' | string;
  /** How the page is filled: one call (`single`) or one per section (`sections`, the default). */
  mode?: 'single' | 'sections';
  /** Default `strict`: nothing is published unless Jev finds no fabrication. `after` publishes
   * first and checks in the background — see `AgencyBuildVerifyVerdict`. */
  verify?: 'strict' | 'advisory' | 'after' | 'off';
  /** Publish into this existing project instead of creating one. */
  projectId?: string;
  /** Names a newly created project. Ignored when `projectId` is given. */
  projectName?: string;
  /** The fill provider. Defaults to the daemon's own default (`deepseek`) when omitted. Kept on
   * the build so a repair after a daemon restart re-fills with the same provider the build used. */
  provider?: 'deepseek' | 'cerebras';
  /** Overrides the chosen provider's default model. Kept alongside `provider` for the same repair
   * reason. */
  model?: string;
  /**
   * Whether a pre-output 429/5xx, timeout, network error or missing key may fail over to the
   * other fill provider (`packages/agency-fast-lane/src/build.ts`'s `fallbackProvider`). Defaults
   * to `true` (today's behavior: the daemon's own default fallback). `false` turns failover off
   * for this build entirely — the primary provider's own failure ends the build rather than
   * retrying on the other provider. Kept on the build (`AgencyBuildSnapshot.failover`) so a
   * repair or fork reuses the same setting the original build ran with, same rule as `provider`.
   */
  failover?: boolean;
  /**
   * Explicit keep/drop per optional section id (the family's `x-optional` sections, such as
   * `reviews`). Overrides the build's one Jev keep/drop request, which is never asked about a
   * hinted id; an id the family does not mark optional is ignored. At most
   * `AGENCY_BUILD_MAX_SECTION_HINTS` entries. Kept on the build, so a fork reuses it.
   */
  sections?: Record<string, 'keep' | 'drop'>;
  /**
   * One selectable section on top of this build's fixed family recipe (`sol-design.md` §2/§3).
   * Site families only; refused (`BAD_REQUEST`) when `entryId` is unknown, not marked
   * `availability: "insertable"`, `placement` names an id the resolved family does not declare,
   * or `directionId` is not one of the five built-in directions.
   */
  sectionSelection?: AgencySectionSelectionInput;
  /**
   * A `SectionCatalogEntry.id` (a `motionsites-prompt:...` or `zerosum-kit:...` id) to fetch as
   * untrusted layout/typography/motion guidance for this one build's `sectionSelection` — never a
   * source of factual claims (`sol-design.md` §2). The daemon fetches its text in memory only,
   * for this one build: never persisted, logged, written to the build record, or present in an
   * SSE frame — only `designReferenceId` itself may be kept (e.g. in fork history), so a fork can
   * fetch it again later. A `motionsites-prompt:` id the signed-in user cannot open answers
   * `MOTIONSITES_LOGIN_REQUIRED` or `MOTIONSITES_PAID_ACCESS_REQUIRED` before the build starts.
   * Mutually exclusive with `designReferenceText`; both require `sectionSelection`.
   */
  designReferenceId?: string;
  /**
   * A design reference's text supplied directly by the caller (the `od agency build
   * --reference-file` surface — see docs/agency-site.md), used exactly like a fetched
   * `designReferenceId`'s text: in memory only, for this one build, never persisted or logged.
   * Mutually exclusive with `designReferenceId`; both require `sectionSelection`.
   */
  designReferenceText?: string;
  /** `family` (the default), `blocks` or `auto` — see `AgencyBuildComposition`. Kept on the build,
   * with the plan a composed build used, so a fork replays the same page. Cannot be combined with
   * `sectionSelection` (a composed page is already made of selected sections). */
  composition?: AgencyBuildComposition;
  /**
   * Reviewed GenUI catalog components on this build's family placements — see
   * `AgencyEffectsInput`. Omitted = `'auto'` for site families and `'off'` for app/dashboard
   * page kinds. Refused (`BAD_REQUEST`) when a record names an unknown placement, an id that is
   * not a component id, or more than `AGENCY_BUILD_MAX_EFFECT_HINTS` entries. A component the
   * family does not allow at that placement is refused (`BAD_REQUEST`) when `family` is named;
   * with `family: 'auto'` the family is only known after routing, so such an id is not refused:
   * the build skips it as `not-allowed` and reports that on `AgencyBuildSnapshot.effects`. Kept on
   * the build, so a fork reuses it.
   */
  effects?: AgencyEffectsInput;
  /**
   * An installed design kit for the page to wear (`DesignSystemSummary.id`). It must be published
   * and approved at its current revision, like every generation kit. The kit styles a composed
   * page, so `composition` defaults to `auto` when a kit is named and `family` is refused; a build
   * that still ends on the family route reports `composition.designKit.applied: false`. Refused
   * with an `AgencyBuildDesignKitRefusalCode` before the build starts. Kept on the build, so a
   * fork re-reads the kit's then-current approved revision.
   */
  designSystemId?: string;
}

/** One optional section of a family: what a keep/drop control offers before a build. */
export interface AgencyFamilyOptionalSection {
  /** The section id a `sections` hint names (the family reference recipe's own fixed id). */
  id: string;
  /** The section type (`reviews`, `testimonials`). */
  type: string;
  /** The family's short English description of the section (`x-optional.label`). */
  label: string;
}

/**
 * `GET /api/agency/families/:family/sections` — the family's optional sections, in page order.
 * Empty when the family has none. 404 `NOT_FOUND` for a family this daemon does not bundle.
 */
export interface AgencyFamilySectionsResponse {
  family: string;
  /** The family's output scope, so a client can label it before a build starts. */
  outputScope: AgencyOutputScope;
  sections: AgencyFamilyOptionalSection[];
}

/** One bundled family, as `GET /api/agency/families` lists it. */
export interface AgencyFamilySummary {
  family: string;
  pageKind: PageKind;
  outputScope: AgencyOutputScope;
}

/** `GET /api/agency/families` — every family this daemon bundles, in registry order. */
export interface AgencyFamiliesResponse {
  families: AgencyFamilySummary[];
}

/** The most `sections` hints one build request may carry. */
export const AGENCY_BUILD_MAX_SECTION_HINTS = 32;

export interface AgencyBuildResponse {
  build: AgencyBuildSnapshot;
}

export interface AgencyBuildListResponse {
  builds: AgencyBuildListItem[];
}

/** `409 BUILD_BUSY` names the build already running, so a client can attach to it instead. */
export interface AgencyBuildBusyDetails {
  kind: 'agency-build-busy';
  activeId: string;
}

/**
 * `POST /api/agency/builds/:id/fork` — "start from this build". Every other input a build needs
 * (family, mode, verify) travels with the saved build itself; only the brief and the section
 * hints may be overridden, because they are what a person revisiting a saved build is likely to
 * want to change.
 */
export interface AgencyBuildForkRequest {
  /** Replaces the saved build's brief text. Omit to reuse it verbatim. */
  brief?: string;
  /**
   * Keep/drop hints merged over the saved build's own `sections`, id by id (an id named here
   * wins). `auto` removes the saved hint for that id, so Jev decides it again. Validated like
   * `AgencyBuildRequest.sections`; the merged set may hold at most
   * `AGENCY_BUILD_MAX_SECTION_HINTS` ids.
   */
  sections?: Record<string, 'keep' | 'drop' | 'auto'>;
  /**
   * Replaces the saved build's `sectionSelection`. Omit to reuse it verbatim; `null` clears it
   * (the fork builds with no section overlay even if the original had one).
   */
  sectionSelection?: AgencySectionSelectionInput | null;
  /**
   * Replaces the saved build's `effects`. Omit to reuse it verbatim; `null` resets it to the
   * default (`'auto'`), so Jev decides again for this fork.
   */
  effects?: AgencyEffectsInput | null;
  /**
   * Replaces the saved build's `designReferenceId` (re-fetched fresh for this fork — a fork never
   * reuses a previously fetched reference's text, only its id; `sol-design.md` §2: "fetch again
   * for a fork"). Omit to reuse the saved id; `null` clears it. Mutually exclusive with
   * `designReferenceText`.
   */
  designReferenceId?: string | null;
  /** Replaces the saved build's design reference with caller-supplied text for this fork only —
   * never persisted, same as `AgencyBuildRequest.designReferenceText`. Mutually exclusive with
   * `designReferenceId`. */
  designReferenceText?: string | null;
  /** Replaces the saved build's composition. Omit to reuse it: a composed build's fork then
   * replays the saved block plan exactly (no new Jev plan). Naming one asks for a fresh decision. */
  composition?: AgencyBuildComposition;
}

/** `POST /api/agency/builds/:id/fork` answers 202 with the new build's queued snapshot — the same
 * shape `POST /api/agency/build` answers with. */
export type AgencyBuildForkResponse = AgencyBuildResponse;

/**
 * `POST /api/agency/builds/:id/repair` — the repair pass for a `verify: 'after'` build whose
 * deferred check flagged something. Takes no body: what to repair is exactly the build's own
 * `verify.flagged`, never a caller-chosen path list, so a client cannot ask this endpoint to
 * touch a slot the check never flagged. "Only the flagged slots are re-sent" means only those are
 * RE-GENERATED — every other slot is locked and passed through unchanged; the published page file
 * is still rewritten whole (the daemon has no per-slot patch to a published HTML file), so a
 * repair's own publish step touches the same project files a normal build's does, not just the
 * flagged fragment. Refuses `BUILD_NOT_REPAIRABLE` when the build was not `verify: 'after'`, its
 * check has not finished (`verify.status` still `pending`), was `skipped`, or nothing is flagged;
 * refuses `BUILD_REPAIR_IN_PROGRESS` when a repair for this build is already running — the second
 * of two concurrent calls never gets to publish over the first's still-in-flight result.
 * Synchronous: the response IS the outcome, not a queued job like `POST /api/agency/build` — a
 * repair only ever re-fills the slots this one build already named, which is bounded work.
 */
export type AgencyBuildRepairRequest = Record<string, never>;

/** `repaired`/`remaining` are both path labels drawn from the build's own `verify.flagged` at the
 * moment this call started — `repaired` is what the re-fill and re-check cleared, `remaining` is
 * what is still flagged. The build's own `verify.flagged` is updated to `remaining` in place. */
export interface AgencyBuildRepairResponse {
  repaired: string[];
  remaining: string[];
}

/** The codes `POST /api/agency/build`, the build reads, `POST .../:id/fork`, and
 * `POST .../:id/repair` add to the shared envelope. */
export type AgencyBuildApiErrorCode = Extract<ApiErrorCode, 'BUILD_BUSY' | 'BUILD_NOT_FOUND' | 'BUILD_NOT_FORKABLE' | 'BUILD_NOT_REPAIRABLE' | 'BUILD_REPAIR_IN_PROGRESS'>;

// ---- The AG-UI view of a build (`GET /api/agency/builds/:id/agui`) ----------------------------

/**
 * The steps an AG-UI build stream reports, in the order a build normally reaches them. `deploy`
 * is reserved for a later deploy step and is never sent today: a build has no deploy phase
 * (deploying is `routes/deploy.ts`'s job).
 *
 * Steps come from the build's events, not from `AgencyBuildSnapshot.status`: a `verify: 'after'`
 * build publishes BEFORE it verifies, so its stream reports `publish` and then a second `verify`.
 */
export type AgencyBuildAguiStepName = 'route' | 'fill' | 'verify' | 'publish' | 'deploy';

/** `CUSTOM.name` of the frame that carries each `AgencyBuildEvent` unchanged. */
export const AGENCY_BUILD_AGUI_EVENT_NAME = 'od.agency-build.event';

/**
 * What the build was asked to do, as the AG-UI stream reports it.
 *
 * `briefChars` is the ONLY trace of the brief: the brief itself never reaches a client (see this
 * file's module docblock), so the stream says how long it was and nothing else. `provider` is
 * `null` while a `family: 'auto'` build has not routed yet and named no provider — its default
 * depends on the family routing picks — and the terminal frames fill it in.
 */
export interface AgencyBuildAguiInput {
  family: string;
  mode: 'single' | 'sections';
  verify: 'strict' | 'advisory' | 'after' | 'off';
  provider: 'deepseek' | 'cerebras' | null;
  model: string | null;
  briefChars: number;
  /** The requested composition, when the build asked for one (absent means `family`). */
  composition?: AgencyBuildComposition;
}

/** One fill unit, as its events describe it. Every field is a number the fast lane stamped. */
export interface AgencyBuildAguiUnit {
  /** `unit`: when the unit finished, and how many repairs it needed. */
  ms?: number;
  repairs?: number;
  /** `merged`: when the unit was merged into the page. */
  merged?: number;
}

/**
 * The optional-section decision, from the build's `sections` event: which of the family's
 * optional sections the page kept and which it left out, and who decided (see
 * `AgencyBuildEvent.sectionSource`). Section ids are the family recipe's fixed ids, never model
 * output. `reason` is `jev-unavailable` when Jev could not answer and every unhinted section was kept.
 */
export interface AgencyBuildAguiSections {
  kept: string[];
  dropped: string[];
  source: 'jev' | 'hint' | 'brief' | 'default';
  reason: AgencyBuildEvent['reason'] | null;
}

/**
 * The shared state an AG-UI build stream keeps in step: `STATE_SNAPSHOT` sends it whole, every
 * `STATE_DELTA` is an RFC 6902 patch against it. Every key is always present (`null` when there
 * is nothing yet), so a patch can `replace` any of them without an `add` first.
 *
 * Built only from `AgencyBuildEvent`, `AgencyBuildSnapshot` and `AgencyBuildAguiInput`, so it can
 * carry nothing those do not: no brief, no model output, no upstream body.
 */
export interface AgencyBuildAguiState {
  build: { id: string; status: AgencyBuildStatus; startedAt: string; finishedAt: string | null };
  input: AgencyBuildAguiInput;
  route: AgencyBuildRouteDecision | null;
  /** The family's output scope once the family is known — `null` while an `auto` build routes. */
  outputScope: AgencyOutputScope | null;
  projectId: string | null;
  /** Keyed by unit label. */
  units: Record<string, AgencyBuildAguiUnit>;
  /** The latest paint count. */
  paints: number;
  repairs: Array<{ label: string; reason: AgencyBuildRepairReason }>;
  /** Labels of units the model overran. */
  clipped: string[];
  /** The optional-section decision, once the `sections` event has landed. */
  sections: AgencyBuildAguiSections | null;
  /** The latest `verify` event. */
  verify: {
    ms: number | null;
    counts: { checked: number; flagged: number; repaired: number; remaining: number } | null;
    reason: AgencyBuildEvent['reason'] | null;
  } | null;
  /** `verify: 'after'` only — see `AgencyBuildVerifyVerdict`. The flagged paths arrive with the
   * terminal frames, when the snapshot carries them. */
  verdict: AgencyBuildVerifyVerdict | null;
  previewUrl: string | null;
  /** Milliseconds (and the asset count) the build's events stamped: `routeMs`, `assetsMs`,
   * `assets`, `firstTokenMs`, `registeredMs`. */
  timings: Record<string, number>;
  error: { code: AgencyBuildErrorCode; message: string } | null;
  /** A failed build's diagnostic detail — the snapshot's `failure`, set by the terminal frames.
   * Optional on the wire: a stream from a daemon that predates it carries none. */
  failure?: AgencyBuildFailure | null;
  summary: AgencyBuildSummary | null;
  /** Every fill provider/model that produced output — the snapshot's `providers`, set by the
   * terminal frames (empty until then, and for a build that never reached the model). The live
   * switch itself arrives as the `failover` event. */
  providers: AgencyBuildProviderUse[];
  /** The composition decision, once its event has landed (`null` until then, and for a `family`
   * build). Optional on the wire: a stream from a daemon that predates it carries none. */
  composition?: AgencyBuildCompositionResult | null;
  /** What the build's effect plan did — the snapshot's `effects`, set by the terminal frames
   * (ids, counts and fixed codes only). Optional on the wire, like `failure`: a stream from a
   * daemon that predates effects carries none. */
  effects?: AgencyEffectsResult | null;
  /** Fixed structure-check codes and counts. Optional for older streams. */
  renderQuality?: AgencyBuildRenderQuality | null;
}

// ---- Runtime parsers for the effects DTOs --------------------------------------------------
//
// Shared by the daemon route (request validation, store hydration, snapshot mapping), `od agency
// build` / `od agency effects`, and the web Build panel, so the three surfaces agree on one shape.
// Every parser field-picks: a value that passes carries only the fields named here, never extra
// keys a caller or a stored record happened to hold. Error sentences are fixed text plus, at
// most, a placement id from the closed vocabulary — never the caller's own string echoed back.

/**
 * A GenUI catalog component id, as `packages/genui-catalog` writes them (`shiny-text`). `none` (the
 * "no effect here" sentinel an input record may carry in its place) and the placement ids are
 * reserved and never match.
 */
export const AGENCY_EFFECT_COMPONENT_ID = new RegExp(
  // Built from the placement constant so a new placement id is reserved here too. The ids are
  // `[a-z-]` only, so none needs escaping.
  `^(?!(?:${['none', ...AGENCY_EFFECT_PLACEMENT_IDS].join('|')})$)[a-z][a-z0-9-]{0,63}$`,
);

const EFFECT_SKIP_REASONS: ReadonlySet<string> = new Set<AgencyEffectSkipReason>([
  'none', 'below-threshold', 'not-allowed', 'script-policy', 'byte-budget', 'max-effects',
  'host-missing', 'host-occupied', 'incompatible',
]);
const EFFECTS_JEV_SKIPS: ReadonlySet<string> = new Set<AgencyEffectsJevSkip>([
  'jev-key-missing', 'jev-unreachable', 'jev-timeout', 'jev-unauthorized', 'jev-rate-limited',
  'jev-http-error', 'jev-bad-answer',
]);
const EFFECTS_MODES: ReadonlySet<string> = new Set<AgencyEffectsResult['mode']>(['auto', 'off', 'explicit', 'mixed']);
const SCRIPT_POLICIES: ReadonlySet<string> = new Set<AgencyFamilyEffectsResponse['scriptPolicy']>(['none', 'hash', 'inline']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isAgencyEffectPlacementId(value: unknown): value is AgencyEffectPlacementId {
  return typeof value === 'string' && (AGENCY_EFFECT_PLACEMENT_IDS as ReadonlyArray<string>).includes(value);
}

/**
 * Shape-checks `AgencyBuildRequest.effects` (and a fork's non-null `effects`). `undefined` and an
 * empty record both mean "omitted" (`value: undefined`), so the build's own default applies.
 * Whether a named id is allowed at its placement is a question about one family, answered by
 * `agencyEffectHintsRefusal` once the family is known.
 */
export function parseAgencyEffectsInput(value: unknown):
  | { ok: true; value: AgencyEffectsInput | undefined }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === 'auto' || value === 'off') return { ok: true, value };
  if (!isPlainRecord(value)) {
    return { ok: false, error: "effects must be 'auto', 'off', or an object of placement id to component id or 'none'" };
  }
  const entries = Object.entries(value);
  if (entries.length > AGENCY_BUILD_MAX_EFFECT_HINTS) {
    return { ok: false, error: `effects may name at most ${AGENCY_BUILD_MAX_EFFECT_HINTS} placements` };
  }
  const hints: Record<string, string> = {};
  for (const [placement, id] of entries) {
    if (!isAgencyEffectPlacementId(placement)) {
      return { ok: false, error: `effects keys must be placement ids: ${AGENCY_EFFECT_PLACEMENT_IDS.join(', ')}` };
    }
    if (typeof id !== 'string' || (id !== 'none' && !AGENCY_EFFECT_COMPONENT_ID.test(id))) {
      return { ok: false, error: `effects.${placement} must be a catalog component id or 'none'` };
    }
    hints[placement] = id;
  }
  return { ok: true, value: entries.length > 0 ? hints : undefined };
}

/**
 * Why `hints` cannot run on the family `offer` describes, as one fixed sentence naming the
 * placement — or `undefined` when every named id is in that placement's allowlist. `'none'` is
 * always accepted for a known placement: it asks for nothing.
 */
export function agencyEffectHintsRefusal(hints: Record<string, string>, offer: AgencyFamilyEffectsResponse): string | undefined {
  for (const [placement, id] of Object.entries(hints)) {
    if (id === 'none') continue;
    const offered = offer.placements.find((entry) => entry.placement === placement);
    if (!offered) return `family ${offer.family} offers no effect at placement ${placement}`;
    if (!offered.allow.some((component) => component.id === id)) {
      return `family ${offer.family} does not allow that component at placement ${placement}`;
    }
  }
  return undefined;
}

/**
 * A stored or received `AgencyEffectsResult`, field-picked and checked against the closed code
 * sets — or `undefined` when any part is malformed (the whole result is dropped, never served
 * half-checked).
 */
export function parseAgencyEffectsResult(value: unknown): AgencyEffectsResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (typeof value.mode !== 'string' || !EFFECTS_MODES.has(value.mode)) return undefined;
  if (!Array.isArray(value.applied) || !Array.isArray(value.skipped) || !isCount(value.bytesAdded)) return undefined;
  const applied: AgencyEffectApplied[] = [];
  for (const entry of value.applied) {
    if (!isPlainRecord(entry) || !isAgencyEffectPlacementId(entry.placement)) return undefined;
    if (typeof entry.componentId !== 'string' || !AGENCY_EFFECT_COMPONENT_ID.test(entry.componentId)) return undefined;
    if (entry.kind !== 'css-only' && entry.kind !== 'js') return undefined;
    if (entry.source !== 'hint' && entry.source !== 'jev' && entry.source !== 'repair') return undefined;
    applied.push({ placement: entry.placement, componentId: entry.componentId, kind: entry.kind, source: entry.source });
  }
  const skipped: AgencyEffectSkipped[] = [];
  for (const entry of value.skipped) {
    if (!isPlainRecord(entry) || !isAgencyEffectPlacementId(entry.placement)) return undefined;
    if (typeof entry.reason !== 'string' || !EFFECT_SKIP_REASONS.has(entry.reason)) return undefined;
    if (entry.componentId !== undefined && (typeof entry.componentId !== 'string' || !AGENCY_EFFECT_COMPONENT_ID.test(entry.componentId))) return undefined;
    skipped.push({
      placement: entry.placement,
      reason: entry.reason as AgencyEffectSkipReason,
      ...(typeof entry.componentId === 'string' ? { componentId: entry.componentId } : {}),
    });
  }
  if (value.jevSkipped !== undefined && (typeof value.jevSkipped !== 'string' || !EFFECTS_JEV_SKIPS.has(value.jevSkipped))) return undefined;
  return {
    mode: value.mode as AgencyEffectsResult['mode'],
    applied,
    skipped,
    ...(typeof value.jevSkipped === 'string' ? { jevSkipped: value.jevSkipped as AgencyEffectsJevSkip } : {}),
    bytesAdded: value.bytesAdded,
  };
}

/**
 * Validates a `GET /api/agency/families/:family/effects` body. A malformed answer is an error with
 * a reason, never an empty listing — `od agency effects` exits nonzero on it and the Build panel
 * offers no per-placement pickers, rather than showing a family as offering nothing.
 */
export function parseAgencyFamilyEffectsResponse(value: unknown):
  | { ok: true; value: AgencyFamilyEffectsResponse }
  | { ok: false; reason: string } {
  if (!isPlainRecord(value)) return { ok: false, reason: 'expected an object' };
  if (typeof value.family !== 'string' || value.family.length === 0) return { ok: false, reason: 'missing family id' };
  if (typeof value.scriptPolicy !== 'string' || !SCRIPT_POLICIES.has(value.scriptPolicy)) return { ok: false, reason: 'invalid scriptPolicy' };
  if (!isCount(value.maxEffects)) return { ok: false, reason: 'invalid maxEffects' };
  if (!Array.isArray(value.placements)) return { ok: false, reason: 'expected a placements array' };
  const placements: AgencyFamilyEffectPlacement[] = [];
  for (const [index, entry] of value.placements.entries()) {
    if (!isPlainRecord(entry) || !isAgencyEffectPlacementId(entry.placement)) return { ok: false, reason: `placements[${index}]: invalid placement` };
    if (typeof entry.host !== 'string') return { ok: false, reason: `placements[${index}]: missing host` };
    if (!Array.isArray(entry.allow)) return { ok: false, reason: `placements[${index}]: expected an allow array` };
    const allow: AgencyFamilyEffectPlacement['allow'] = [];
    for (const [at, component] of entry.allow.entries()) {
      const where = `placements[${index}].allow[${at}]`;
      if (!isPlainRecord(component) || typeof component.id !== 'string' || !AGENCY_EFFECT_COMPONENT_ID.test(component.id)) return { ok: false, reason: `${where}: invalid id` };
      if (typeof component.name !== 'string') return { ok: false, reason: `${where}: missing name` };
      if (component.kind !== 'css-only' && component.kind !== 'js') return { ok: false, reason: `${where}: invalid kind` };
      const bytes = component.bytes;
      if (!isPlainRecord(bytes) || !isCount(bytes.js) || !isCount(bytes.css)) return { ok: false, reason: `${where}: invalid bytes` };
      allow.push({ id: component.id, name: component.name, kind: component.kind, bytes: { js: bytes.js, css: bytes.css } });
    }
    placements.push({ placement: entry.placement, host: entry.host, allow });
  }
  return {
    ok: true,
    value: { family: value.family, scriptPolicy: value.scriptPolicy as AgencyFamilyEffectsResponse['scriptPolicy'], maxEffects: value.maxEffects, placements },
  };
}
