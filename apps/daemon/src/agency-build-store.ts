/**
 * Disk persistence for the fast-lane build registry (`routes/agency-build.ts`).
 *
 * `registerAgencyBuildRoutes` keeps its job registry in memory — an `AbortController` and a
 * listener `Set` cannot be serialised, and were never meant to be. What IS meant to survive a
 * restart is everything a read endpoint can already show a client (the `AgencyBuildSnapshot`),
 * plus the inputs `POST /api/agency/builds/:id/fork` needs to start a new build from a saved one:
 * the brief, family, mode and verify mode the original request carried.
 *
 * The fork inputs are kept in a field SEPARATE from `snapshot`, never merged into it. The
 * snapshot is the public DTO every read endpoint answers with, and `api/agency-build.ts`'s module
 * docblock is explicit that no client ever sees the caller's brief. Persisting the brief here is
 * an internal daemon-storage decision — a plain string written to this daemon's own data
 * directory, the same place the design index's profiles live — not a change to what a GET
 * response carries: `list`/`get`/hydration below only ever read `.snapshot` back out for a
 * client, and nothing but the fork route reads `.fork`.
 *
 * Same shape as `design-index-store.ts`: every read re-parses the file so a hand-edited or
 * partially-written record is dropped rather than crashing the daemon, every write is atomic
 * (temp file + rename, like `packages/agency-fast-lane/src/design-index.ts`'s `saveDesignIndex`),
 * and every operation is put on one in-process promise chain so two concurrent saves cannot each
 * read the same file and have the second's `rename` drop the first's.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgencyBuildBlockPlan, AgencyBuildComposition, AgencyBuildSnapshot, AgencyBuildStatus, AgencyEffectsInput, AgencySectionSelectionInput } from '@open-design/contracts';
import { AGENCY_BUILD_HISTORY_LIMIT, parseAgencyEffectsInput, parseAgencyEffectsResult } from '@open-design/contracts';
import { parseSectionSelectionShape } from './agency-build-section-selection.js';

/** The closed set `AgencyBuildStatus` allows, kept in step with it by hand — same discipline as
 * `routes/agency-build.ts`'s `REPAIR_REASONS`. A hand-edited or otherwise malformed status string
 * must not reach `isTerminal` (in `routes/agency-build.ts`): that check treats anything it does
 * not recognise as terminal, which would serve a made-up status to a client as if it were real. */
const KNOWN_BUILD_STATUSES = new Set<AgencyBuildStatus>([
  'queued', 'routing', 'building', 'verifying', 'publishing', 'done', 'unrouted', 'failed', 'cancelled',
]);

function isKnownStatus(value: unknown): value is AgencyBuildStatus {
  return typeof value === 'string' && KNOWN_BUILD_STATUSES.has(value as AgencyBuildStatus);
}

/** What `POST /api/agency/builds/:id/fork` needs to start a new build from a saved one. Never a
 * field of `AgencyBuildSnapshot`, and never served by a GET endpoint. */
export interface AgencyBuildForkSeed {
  brief: string;
  family: string;
  mode: 'single' | 'sections';
  verify: 'strict' | 'advisory' | 'after' | 'off';
  /** The fill provider this build ran with, already defaulted — never `undefined` on a record
   * this daemon wrote itself. Carried so `/fork` and a post-restart repair reuse the same
   * provider the original build used, rather than silently falling back to the daemon default. */
  provider: 'deepseek' | 'cerebras';
  /** The model override this build ran with, when the request named one. */
  model?: string;
  /** The `AgencyBuildRequest.failover` this build ran with, already defaulted to `true` — never
   * `undefined` on a record this daemon wrote itself. Carried so `/fork` and a post-restart
   * repair reuse the same setting the original build used, same rule as `provider`. */
  failover?: boolean;
  /** The request's optional-section hints, when it sent any. Absent on older records, whose fork
   * simply asks Jev again. */
  sections?: Record<string, 'keep' | 'drop'>;
  /** This build's `sectionSelection`, when it had one — carried so `/fork` rebuilds with the same
   * section overlay by default. Never the section's filled text, only the selection itself. */
  sectionSelection?: AgencySectionSelectionInput;
  /**
   * The catalog id of this build's design reference, when it had one — NEVER the fetched text
   * (`sol-design.md` §2: "Keep only the reference ID in fork history and fetch again for a
   * fork."). A fork with no override re-fetches this id fresh; it never reuses text from the
   * original build. A build whose reference came from `designReferenceText` (caller-supplied,
   * no catalog id) carries nothing here — that text is never persisted at all, so a fork of such
   * a build simply has no reference to re-apply unless it names its own.
   */
  designReferenceId?: string;
  /** The requested composition when it was not `family` (absent means `family`). */
  composition?: AgencyBuildComposition;
  /** A composed build's plan (ids only, never filled text), so `/fork` and a repair replay the
   * same page instead of asking Jev for a new plan. */
  blockPlan?: AgencyBuildBlockPlan;
  /** The request's `effects`, when it named one — `auto`, `off`, or placement → component id /
   * `none`. Absent means the build took the default, so a fork takes the default again. Ids only;
   * never an effect's CSS or script. */
  effects?: AgencyEffectsInput;
  /** The design kit the request named (`AgencyBuildRequest.designSystemId`) — the id only. A fork
   * re-reads the kit and wears its then-approved revision, or is refused. */
  designSystemId?: string;
}

/** One build as this store keeps it: the public snapshot, plus the fork seed when this daemon
 * has one for it. `fork` is missing for a record an older schema wrote without it — dropped by
 * `canFork`, not thrown. */
export interface PersistedAgencyBuild {
  snapshot: AgencyBuildSnapshot;
  fork?: AgencyBuildForkSeed;
}

export interface AgencyBuildStore {
  /** Upserts one build by `record.snapshot.id`, in place at its existing position when it has
   * one — same rule as `design-index-store.ts`'s replace-in-place `add` — then keeps only the
   * newest `AGENCY_BUILD_HISTORY_LIMIT` records, oldest dropped first. */
  save(record: PersistedAgencyBuild): Promise<void>;
  /** Everything on disk, oldest first — the order `pruneHistory`'s in-memory `Map` keeps, and the
   * order `GET /api/agency/builds` reverses to answer newest first. */
  load(): Promise<PersistedAgencyBuild[]>;
  /** Resolves once every `save`/`load` queued on this store's serialized chain so far has
   * settled (success or failure) — the real completion signal for "no write from this store is
   * still touching disk right now". `routes/agency-build.ts`'s `persist()` calls `save()`
   * fire-and-forget, so a caller that needs to know the background write is done (a test
   * removing the store's directory, for instance) awaits this instead of guessing with a delay
   * or a retry loop. Never rejects, matching `chain` itself, which only ever holds a
   * settled-either-way promise. */
  idle(): Promise<void>;
}

type StoredIndex = { schema: 'agency-builds/1'; builds: PersistedAgencyBuild[] };

function emptyIndex(): StoredIndex {
  return { schema: 'agency-builds/1', builds: [] };
}

/**
 * Validates a stored fork seed and returns the normalized shape, or `undefined` when it is
 * unusable. `provider` is filled in as `'deepseek'` when it is MISSING — a record persisted
 * before this field existed carried no provider at all, and `'deepseek'` was this daemon's only
 * provider before that change, so that is the value the build actually ran with. Dropping the
 * seed instead would silently make every such build unforkable and unrepairable forever, for a
 * field the daemon itself never asked the original request about.
 *
 * A `provider` that IS present but not one of the two known values is a different failure — data
 * corruption, a hand-edit, or a future value this build does not understand — and still drops the
 * whole seed, same as any other malformed field (`sanitizeEntry`'s rule).
 */
function normalizeForkSeed(value: unknown): AgencyBuildForkSeed | undefined {
  const seed = value as Partial<AgencyBuildForkSeed> | null | undefined;
  if (
    !seed
    || typeof seed.brief !== 'string'
    || typeof seed.family !== 'string'
    || (seed.mode !== 'single' && seed.mode !== 'sections')
    || (seed.verify !== 'strict' && seed.verify !== 'advisory' && seed.verify !== 'after' && seed.verify !== 'off')
    || (seed.model !== undefined && typeof seed.model !== 'string')
    || (seed.sections !== undefined && !isSectionHints(seed.sections))
    || (seed.failover !== undefined && typeof seed.failover !== 'boolean')
  ) {
    return undefined;
  }
  const provider = seed.provider === undefined ? 'deepseek' : seed.provider;
  if (provider !== 'deepseek' && provider !== 'cerebras') return undefined;
  // Missing on a record persisted before this field existed — those all ran with failover on,
  // same rule as `provider`'s own `'deepseek'` backfill above.
  const failover = seed.failover === undefined ? true : seed.failover;
  // A malformed `sectionSelection`/`designReferenceId` is dropped on its own (like `outputScope`
  // in `sanitizeEntry`) rather than taking the whole seed down — a record hand-edited to corrupt
  // just the overlay should still be forkable without its own build's brief/family/etc being lost.
  const sectionSelection = seed.sectionSelection === undefined ? undefined : parseSectionSelectionShape(seed.sectionSelection);
  const designReferenceId = typeof seed.designReferenceId === 'string' && seed.designReferenceId.length > 0 ? seed.designReferenceId : undefined;
  // Same rule: a malformed composition or plan is dropped alone. A fork of such a record asks for
  // a fresh decision (or builds the family route) rather than replaying a plan it cannot trust.
  const composition = seed.composition === 'blocks' || seed.composition === 'auto' ? seed.composition : undefined;
  const blockPlan = isBlockPlan(seed.blockPlan) ? { spine: seed.blockPlan.spine, directionId: seed.blockPlan.directionId, blocks: [...seed.blockPlan.blocks] } : undefined;
  // Same rule for `effects`: shape-checked with the request's own parser, dropped on its own when
  // malformed (the fork then takes the default) rather than taking the seed down.
  const effectsParsed = parseAgencyEffectsInput(seed.effects);
  const effects = effectsParsed.ok ? effectsParsed.value : undefined;
  // Same rule: a malformed kit id is dropped alone; the fork then builds without a kit.
  const designSystemId = typeof seed.designSystemId === 'string' && seed.designSystemId.trim().length > 0 && seed.designSystemId.length <= 200 ? seed.designSystemId : undefined;
  return {
    brief: seed.brief,
    family: seed.family,
    mode: seed.mode,
    verify: seed.verify,
    provider,
    failover,
    ...(typeof seed.model === 'string' ? { model: seed.model } : {}),
    ...(seed.sections !== undefined ? { sections: { ...seed.sections } } : {}),
    ...(sectionSelection ? { sectionSelection } : {}),
    ...(designReferenceId ? { designReferenceId } : {}),
    ...(composition ? { composition } : {}),
    ...(blockPlan ? { blockPlan } : {}),
    ...(effects !== undefined ? { effects } : {}),
    ...(designSystemId ? { designSystemId } : {}),
  };
}

// The planner's own bounds (`MIN_BLOCKS`..`MAX_BLOCKS` in block-plan.ts): a persisted plan the
// planner would refuse is dropped here, so a fork asks afresh instead of failing on replay.
const PLAN_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9/_-]{0,127}$/;

function isBlockPlan(value: unknown): value is AgencyBuildBlockPlan {
  const plan = value as Partial<AgencyBuildBlockPlan> | null | undefined;
  return !!plan
    && typeof plan.spine === 'string' && /^[A-Z]{2}$/.test(plan.spine)
    && typeof plan.directionId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(plan.directionId)
    && Array.isArray(plan.blocks) && plan.blocks.length >= 3 && plan.blocks.length <= 7
    && plan.blocks.every((id) => typeof id === 'string' && PLAN_ID.test(id));
}

function isSectionHints(value: unknown): value is Record<string, 'keep' | 'drop'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([id, hint]) => /^[a-z][a-z0-9-]{0,63}$/.test(id) && (hint === 'keep' || hint === 'drop'));
}

/**
 * Re-validates one stored entry on every read, the same discipline `design-index-store.ts`'s
 * `sanitizeIndex` applies to a stored `DesignProfile`: a record missing even an id is worthless
 * and is dropped rather than handed back half-formed, a status outside the closed set is just as
 * worthless (see `isKnownStatus`), and a malformed `fork` is dropped on its own (the snapshot is
 * still good) rather than taking the whole entry down. So is a malformed `outputScope`.
 */
function sanitizeEntry(entry: unknown): PersistedAgencyBuild | undefined {
  const snapshot = (entry as { snapshot?: unknown } | null | undefined)?.snapshot as
    | AgencyBuildSnapshot
    | undefined;
  if (!snapshot || typeof snapshot.id !== 'string' || !isKnownStatus(snapshot.status)) return undefined;
  // An output scope outside the closed set is dropped, not served; hydration re-derives it from
  // the family (`routes/agency-build.ts`, `withScope`).
  if (snapshot.outputScope !== undefined && snapshot.outputScope !== 'site' && snapshot.outputScope !== 'static-prototype') {
    const { outputScope: _dropped, ...rest } = snapshot;
    return sanitizeEntry({ ...(entry as object), snapshot: rest });
  }
  // A stored effects result is re-checked like a fresh one (`parseAgencyEffectsResult`): a
  // malformed one is dropped on its own, never served with a code outside the closed sets.
  let checked = snapshot;
  if (snapshot.effects !== undefined) {
    const effects = parseAgencyEffectsResult(snapshot.effects);
    const { effects: _stored, ...rest } = snapshot;
    checked = effects ? { ...rest, effects } : rest;
  }
  const fork = (entry as { fork?: unknown } | null | undefined)?.fork;
  const normalizedFork = normalizeForkSeed(fork);
  return { snapshot: checked, ...(normalizedFork ? { fork: normalizedFork } : {}) };
}

async function readIndex(file: string): Promise<StoredIndex> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    const stored = Array.isArray((raw as { builds?: unknown } | null)?.builds)
      ? (raw as { builds: unknown[] }).builds
      : [];
    const builds: PersistedAgencyBuild[] = [];
    for (const entry of stored) {
      const sanitized = sanitizeEntry(entry);
      if (sanitized) builds.push(sanitized);
    }
    return { schema: 'agency-builds/1', builds };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
    throw error;
  }
}

/** Atomic write: the full JSON lands in a sibling temp file first, then `rename` swaps it into
 * place in one filesystem operation, so a reader (or a crash mid-write) never sees a truncated or
 * partially-written file. The temp name carries the pid and a timestamp so two concurrent writers
 * never collide on the temp file itself — same rule as `saveDesignIndex`. */
async function writeIndex(file: string, index: StoredIndex): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpFile, `${JSON.stringify(index, null, 2)}\n`);
  await rename(tmpFile, file);
}

export function createAgencyBuildStore(file: string): AgencyBuildStore {
  let chain: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    // `chain.then(work, work)` runs the next operation whether the previous one resolved or
    // rejected, so one failed save never wedges every later one; `chain` itself only ever holds a
    // settled-either-way promise. Same pattern as `design-index-store.ts`'s `serialize`.
    const next = chain.then(work, work);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    save(record) {
      return serialize(async () => {
        const index = await readIndex(file);
        const at = index.builds.findIndex((entry) => entry.snapshot.id === record.snapshot.id);
        const builds = [...index.builds];
        if (at >= 0) builds[at] = record;
        else builds.push(record);
        while (builds.length > AGENCY_BUILD_HISTORY_LIMIT) builds.shift();
        await writeIndex(file, { schema: 'agency-builds/1', builds });
      });
    },

    load() {
      return serialize(async () => (await readIndex(file)).builds);
    },

    idle() {
      // `chain` is read at CALL time, not captured earlier: it is reassigned on every `save`/
      // `load`, so this always waits for whatever is the most recently queued operation at the
      // moment a caller asks, not a stale snapshot from when the store was created.
      return chain.then(() => undefined, () => undefined);
    },
  };
}
