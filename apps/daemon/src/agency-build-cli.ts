// `od agency build` — the CLI surface for the daemon's fast-lane build job (dual-track rule;
// design 2026-09-20 §6.5). It drives exactly the endpoints the Route panel's Build button drives:
// `POST /api/agency/build`, the SSE stream, and `POST /api/agency/builds/:id/cancel`. With
// `--agui` it follows `GET .../:id/agui` (the AG-UI view the Build panel reads) instead of
// `/events`, and prints each AG-UI event as one JSON line.
//
// Kept in its own module (not inline in cli.ts) so it stays unit-testable without triggering
// cli.ts's import-time SUBCOMMAND_MAP dispatch — mirrors `agency-config-cli.ts`.
//
// The lines it prints are the fast-lane CLI's own stamped lines (`packages/agency-fast-lane/
// src/cli.ts`), so a build watched from `od` reads exactly like a build run from the package. It
// can only print what the daemon sends, and the daemon sends no generated text: a repair carries
// a reason code, a failure carries one of five fixed sentences.

import type {
  AgencyBuildBusyDetails,
  AgencyBuildComposition,
  AgencyBuildEvent,
  AgencyBuildForkRequest,
  AgencyBuildRequest,
  AgencyBuildResponse,
  AgencyFamiliesResponse,
  AgencyOutputScope,
  AgencyBuildSnapshot,
  AgencyEffectsInput,
  AgencyEffectsResult,
  AgencyFamilyEffectsResponse,
  AgencySectionPlacement,
  AgencySectionSelectionInput,
  ApiErrorResponse,
} from '@open-design/contracts';
import { AGENCY_EFFECT_PLACEMENT_IDS, parseAgencyEffectsInput } from '@open-design/contracts';

/**
 * Exit codes. 0-3 are the fast-lane CLI's own meanings; 4 is this surface's addition.
 *
 * The package CLI collapses a cancelled build into 1 because nothing can cancel it — it passes no
 * signal at all. Here a person can, and a script that asked for the build has to be able to tell
 * "I stopped it" from "it broke": a cancelled build is nobody's bug and should not page anyone.
 * So `cancelled` gets 4, which no fast-lane code uses.
 */
export const EXIT = {
  done: 0,
  /** The build ran and failed. */
  failed: 1,
  /** A usage error, and the two refusals a person has to act on before retrying. */
  usage: 2,
  /** Routing found no family. A decision, not a failure. */
  unrouted: 3,
  /** Somebody stopped the build — this process on Ctrl-C, or another caller. */
  cancelled: 4,
} as const;

/**
 * How long Ctrl-C waits for the daemon to confirm the build stopped.
 *
 * The wait exists because a cancelled build still has work to do: F6a waits for an in-flight
 * project create and rolls it back, and the terminal frame is what says it finished. The BOUND
 * exists because a terminal is not a place to hang: a daemon that stops answering must not hold
 * the person's shell, and the build's own rollback deadlines are well inside this.
 */
const CANCEL_CONFIRM_TIMEOUT_MS = 30_000;

/** Resolves after `ms`, without keeping the process alive on its own. */
function after(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export const AGENCY_BUILD_STRING_FLAGS = [
  'brief', 'prompt-file', 'family', 'verify', 'mode', 'name', 'project', 'from', 'keep', 'drop', 'auto',
  // Selectable-section overlay (sol-design.md §2/§3): --section names the catalog entry
  // (GET /api/sections), exactly one of --after/--replace places it, --direction picks one of
  // the five built-in design directions. --reference names a designReferenceId (a
  // motionsites-prompt:… or zerosum-kit:… catalog id, fetched server-side); --reference-file
  // reads local design-guidance text instead (sent as designReferenceText). Deliberately NOT
  // named --prompt-file: that flag already means "read the brief from a file" on this command.
  'section', 'after', 'replace', 'direction', 'reference', 'reference-file',
  // Block composition (`AgencyBuildRequest.composition`): family (the default), blocks or auto.
  // --provider names the fill provider (`AgencyBuildRequest.provider`), so a proof can pin one.
  'composition', 'provider',
  // An installed, approved design kit for a composed page to wear (`AgencyBuildRequest.designSystemId`).
  'design-system',
  // Effects (Sol ruling 2026-09-25): --effects auto|off, and --effect <placement>=<id|none>,
  // repeatable — the caller re-scans argv for every --effect (`effectAssignments`), since the flag
  // parser keeps only the last value of a repeated key.
  'effects', 'effect',
] as const;
export const AGENCY_BUILD_BOOLEAN_FLAGS = ['json', 'no-wait', 'agui', 'no-failover'] as const;

const MODES = ['single', 'sections'];
const VERIFY_MODES = ['strict', 'advisory', 'after', 'off'];
const COMPOSITIONS = ['family', 'blocks', 'auto'];
const PROVIDERS = ['deepseek', 'cerebras'];

export const AGENCY_BUILD_USAGE =
  'Usage: od agency build (--brief "<text>" | --prompt-file <path|-> | --from <buildId>) [--family auto|<id>]\n'
  + '                      [--verify strict|advisory|after|off] [--mode single|sections] [--name <project name>]\n'
  + '                      [--project <id>] [--keep <section-id,...>] [--drop <section-id,...>]\n'
  + '                      [--auto <section-id,...> (with --from)] [--json | --no-wait | --agui]\n'
  + '                      [--section <entryId> (--after <sectionId> | --replace <optionalSectionId>) --direction <directionId>]\n'
  + '                      [--reference <motionsitesPromptId> | --reference-file <path|->]\n'
  + '                      [--composition family|blocks|auto] [--provider deepseek|cerebras] [--no-failover]\n'
  + '                      [--design-system <kitId>]\n'
  + '                      [--effects auto|off] [--effect <placement>=<componentId|none> ...]';

export interface AgencyBuildCliOptions {
  /** The daemon HTTP base, already resolved and without a trailing slash. */
  baseUrl: string;
  /** The brief, already read from `--brief` or `--prompt-file` by the caller. */
  brief: string | null;
  /**
   * `--reference-file <path|->`'s contents, already read by the caller (same convention as
   * `brief`/`--prompt-file`) — sent as `designReferenceText`, never persisted or logged by this
   * module or the daemon route it calls. `undefined` when `--reference-file` was not given;
   * `validate` refuses combining it with `--reference`.
   */
  designReferenceText?: string;
  /**
   * Every `--effect <placement>=<id|none>` value, in argv order, already re-scanned by the caller
   * (`cli.ts`'s `repeatableFlagValues`). When absent, `flags.effect` (one string, or a list) is
   * read instead.
   */
  effectAssignments?: string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Registers the Ctrl-C handler. Injected so a test can drive it without a real signal. */
  onInterrupt: (handler: () => void) => void;
  fetchImpl?: typeof fetch;
  /** Overrides `CANCEL_CONFIRM_TIMEOUT_MS`, for a test that must not wait thirty seconds. */
  cancelTimeoutMs?: number;
}

type Flags = Record<string, unknown>;

/** `[  1.23s]`, the fast lane's own stamp. */
function stamp(ms: number | undefined): string {
  return `[${((ms ?? 0) / 1000).toFixed(2).padStart(6)}s]`;
}

/**
 * One progress line, in the fast-lane CLI's format.
 *
 * `merged` prints nothing there and prints nothing here: every merge is followed by the paint that
 * shows it. A `repair` prints its reason code rather than the fast lane's phrase for it, because
 * the phrase lives in the package's `run.ts`, which the daemon does not import — and the code says
 * the same thing without a second copy of the wording to keep in step.
 */
/** C16: what `od` prints for a family whose output is a static prototype. */
export const STATIC_PROTOTYPE_LABEL = 'static prototype: navigation and controls are not wired';

/** The scope suffix a family line carries: empty for a site, the label for a static prototype. */
export function outputScopeSuffix(scope: AgencyOutputScope | undefined): string {
  return scope === 'static-prototype' ? ` (${STATIC_PROTOTYPE_LABEL})` : '';
}

/** `od agency families`: one line per family — id, page kind, output scope. */
export function familiesLines(response: AgencyFamiliesResponse): string[] {
  return response.families.map((entry) => `${entry.family}\t${entry.pageKind}\t${entry.outputScope === 'static-prototype' ? STATIC_PROTOTYPE_LABEL : 'site'}`);
}

const PAGE_KINDS: ReadonlySet<string> = new Set(['site', 'app', 'dashboard']);
const OUTPUT_SCOPES: ReadonlySet<string> = new Set(['site', 'static-prototype']);

/**
 * Validates a `GET /api/agency/families` body. A malformed answer is an error with a reason,
 * never an empty listing: `od agency families` exits nonzero on it rather than reporting
 * "no families" for a daemon that answered something it should not have.
 */
export function parseFamiliesResponse(data: unknown): { ok: true; value: AgencyFamiliesResponse } | { ok: false; reason: string } {
  const families = (data as { families?: unknown } | null)?.families;
  if (!Array.isArray(families)) return { ok: false, reason: 'expected a families array' };
  for (const [index, entry] of families.entries()) {
    const candidate = entry as { family?: unknown; pageKind?: unknown; outputScope?: unknown } | null;
    if (typeof candidate?.family !== 'string' || candidate.family.length === 0) return { ok: false, reason: `families[${index}]: missing family id` };
    if (typeof candidate.pageKind !== 'string' || !PAGE_KINDS.has(candidate.pageKind)) return { ok: false, reason: `families[${index}] (${candidate.family}): invalid pageKind` };
    if (typeof candidate.outputScope !== 'string' || !OUTPUT_SCOPES.has(candidate.outputScope)) return { ok: false, reason: `families[${index}] (${candidate.family}): invalid outputScope` };
  }
  return { ok: true, value: { families } as AgencyFamiliesResponse };
}

function lineFor(event: AgencyBuildEvent): string | undefined {
  switch (event.type) {
    case 'route':
      return event.decision === 'routed'
        ? `${stamp(event.ms)} route: ${event.family}${outputScopeSuffix(event.outputScope)}`
        : `${stamp(event.ms)} route: unrouted`;
    case 'project':
      return `project ${event.projectId}`;
    case 'lock-wait':
      return `waiting: another ${event.label} run holds the one-at-a-time lock`;
    case 'sections':
      return `${stamp(event.ms)} sections (${event.sectionSource ?? 'default'}): dropped ${event.droppedSections?.join(', ') || 'none'}`
        + (event.reason ? ` (skipped: ${event.reason})` : '');
    case 'effects':
      return `${stamp(event.ms)} effects: ${event.label ?? 'settled'}`;
    case 'render-quality':
      return event.renderQuality?.passed
        ? `structure: passed ${event.renderQuality.checks.length} checks`
        : `structure: failed ${event.renderQuality?.issueCounts.reduce((count, issue) => count + issue.count, 0) ?? 0} issues`;
    case 'assets':
      return `${stamp(event.ms)} assets: ${event.count} uploaded`;
    case 'first-token':
      return `${stamp(event.ms)} first token`;
    case 'unit':
      return `${stamp(event.ms)} unit ${event.label} done${event.repairs ? ` after ${event.repairs} repair(s)` : ''}`;
    case 'paint':
      return `${stamp(event.ms)} paint #${event.count} (${event.label})`;
    case 'repair':
      return `         repair ${event.label}: ${event.reason}`;
    case 'clipped':
      return `         clipped ${event.label}`;
    case 'verify': {
      const counts = event.counts;
      if (!counts) return `${stamp(event.ms)} verify: skipped`;
      return `${stamp(event.ms)} verify: checked ${counts.checked}, flagged ${counts.flagged}, `
        + `repaired ${counts.repaired}, remaining ${counts.remaining}`
        + (typeof counts.illustrative !== 'number'
          ? ', illustrative not reported'
          : counts.illustrative > 0 ? `, illustrative ${counts.illustrative} (sample data, not fact-checked)` : '')
        + (event.reason ? ` (skipped: ${event.reason})` : '');
    }
    case 'registered':
      return `${stamp(event.ms)} registered`;
    case 'failover':
      return `failover: now using ${event.label} (${event.reason})`;
    case 'composition':
      return compositionLine(event);
    default:
      return undefined;
  }
}

/**
 * The failed build's diagnostic lines — the same `route` and `failure` fields
 * `GET /api/agency/builds/:id` serves, so the endpoint, this command and the web build panel show
 * one answer. Empty for any build that did not fail.
 */
export function failureLines(snapshot: AgencyBuildSnapshot): string[] {
  if (snapshot.status !== 'failed') return [];
  const lines: string[] = [];
  const route = snapshot.route;
  if (route) {
    const probability = route.probability !== undefined ? ` p=${route.probability.toFixed(2)}` : '';
    const via = route.viaSpine !== undefined ? ` via ${route.viaSpine}` : '';
    lines.push(`route: spine ${route.spine ?? '-'}, family ${route.family ?? '-'}${via}${probability}`);
  }
  const failure = snapshot.failure;
  if (failure) {
    lines.push(`failed at: ${failure.step}`);
    if (failure.flaggedSlots && failure.flaggedSlots.length > 0) lines.push(`flagged slots: ${failure.flaggedSlots.join(', ')}`);
    if (failure.lastError) lines.push(`last error: ${failure.lastError}`);
  }
  return lines;
}

/** The composition decision as one line: the chosen blocks in page order, or why the family
 * route ran. Ids and fixed codes only, like the event itself. */
export function compositionLine(event: AgencyBuildEvent): string | undefined {
  const composition = event.composition;
  if (!composition) return undefined;
  const kit = composition.designKit
    ? `; design kit ${composition.designKit.title ?? composition.designKit.id} ${composition.designKit.applied ? 'applied' : 'not applied (the family route keeps its own look)'}`
    : '';
  if (composition.used === 'blocks') {
    const source = composition.source === 'replay' ? ', replayed' : '';
    return `${stamp(event.ms)} composition: blocks (${composition.spine ?? '-'}, ${composition.directionId ?? '-'}${source}): ${(composition.blocks ?? []).join(', ')}${kit}`;
  }
  return `${stamp(event.ms)} composition: family route (fallback: ${composition.fallback ?? 'none'})${kit}`;
}

function exitFor(status: AgencyBuildSnapshot['status']): number {
  if (status === 'done') return EXIT.done;
  if (status === 'unrouted') return EXIT.unrouted;
  if (status === 'cancelled') return EXIT.cancelled;
  return EXIT.failed;
}

function forkIdFlag(flags: Flags): string | undefined {
  return typeof flags.from === 'string' && flags.from.length > 0 ? flags.from : undefined;
}

/**
 * `--from <buildId>` is its own start path (`POST .../:id/fork`), which carries its own family,
 * mode and verify from the saved build — so a brief is required only WITHOUT it, and `--family`/
 * `--mode`/`--verify` still validate as flags (a person may pass one by habit) even though
 * `requestBody` never reads them on the fork path.
 */
function validate(flags: Flags, brief: string | null, effectAssignments: string[] | undefined): string[] | undefined {
  if (forkIdFlag(flags) === undefined && (typeof brief !== 'string' || brief.trim().length === 0)) {
    return [AGENCY_BUILD_USAGE];
  }
  const mode = flags.mode;
  if (mode !== undefined && (typeof mode !== 'string' || !MODES.includes(mode))) {
    return [`--mode must be one of ${MODES.join(', ')}`];
  }
  const verify = flags.verify;
  if (verify !== undefined && (typeof verify !== 'string' || !VERIFY_MODES.includes(verify))) {
    return [`--verify must be one of ${VERIFY_MODES.join(', ')}`];
  }
  const composition = flags.composition;
  if (composition !== undefined && (typeof composition !== 'string' || !COMPOSITIONS.includes(composition))) {
    return [`--composition must be one of ${COMPOSITIONS.join(', ')}`];
  }
  if (composition !== undefined && composition !== 'family' && flags.section !== undefined) {
    return ['--composition blocks|auto cannot be combined with --section'];
  }
  // A composed page publishes only after a passing strict Jev check (the route's own rule).
  if (composition !== undefined && composition !== 'family' && verify !== undefined && verify !== 'strict') {
    return ['--composition blocks|auto publishes only after a strict Jev check: --verify must be strict (or omitted)'];
  }
  const designSystem = flags['design-system'];
  if (designSystem !== undefined) {
    if (typeof designSystem !== 'string' || designSystem.trim().length === 0) return ['--design-system needs a kit id (see od design-systems list)'];
    if (forkIdFlag(flags) !== undefined) return ['--design-system cannot be combined with --from: a fork re-reads the kit its build used'];
    if (composition === 'family') return ['--design-system styles a composed page: use --composition auto|blocks (or omit it)'];
    if (flags.section !== undefined) return ['--design-system cannot be combined with --section'];
  }
  const provider = flags.provider;
  if (provider !== undefined && (typeof provider !== 'string' || !PROVIDERS.includes(provider))) {
    return [`--provider must be one of ${PROVIDERS.join(', ')}`];
  }
  if (provider !== undefined && forkIdFlag(flags) !== undefined) {
    return ['--provider cannot be combined with --from: a fork keeps the saved build\'s provider'];
  }
  if (flags['no-failover'] === true && forkIdFlag(flags) !== undefined) {
    return ['--no-failover cannot be combined with --from: a fork keeps the saved build\'s failover setting'];
  }
  // `--agui` is its own output format (one AG-UI event per line) and needs the stream to follow,
  // so it cannot share stdout with `--json` or skip the stream with `--no-wait`.
  if (flags.agui === true && (flags.json === true || flags['no-wait'] === true)) {
    return ['--agui cannot be combined with --json or --no-wait'];
  }
  const hints = sectionHints(flags);
  if (typeof hints === 'string') return [hints];
  if (flags.auto !== undefined && forkIdFlag(flags) === undefined) {
    return ['--auto clears a saved build\'s section hint, so it needs --from <buildId>'];
  }
  const selection = sectionSelectionFromFlags(flags);
  if (typeof selection === 'string') return [selection];
  const effects = effectsFromFlags(flags, effectAssignments);
  if (typeof effects === 'object' && 'error' in effects) return [effects.error];
  if (flags.reference !== undefined && flags['reference-file'] !== undefined) {
    return ['--reference and --reference-file are mutually exclusive'];
  }
  if ((flags.reference !== undefined || flags['reference-file'] !== undefined) && selection === undefined) {
    return ['--reference / --reference-file only apply alongside --section'];
  }
  return undefined;
}

/**
 * `--effects auto|off` and `--effect <placement>=<id|none>` (repeatable) → the request's
 * `effects`. `--effect` alone (or with `--effects auto`) names components for those placements and
 * leaves every other placement to auto; `--effects off` with any `--effect` is a contradiction.
 * Returns `undefined` when neither flag was given (the daemon's default applies), the value, or
 * `{ error }`. Whether a family allows an id is the daemon's call once the family is known — this
 * checks shape only, with the same parser the daemon uses.
 */
export function effectsFromFlags(flags: Flags, effectAssignments?: string[]): AgencyEffectsInput | undefined | { error: string } {
  const mode = flags.effects;
  if (mode !== undefined && mode !== 'auto' && mode !== 'off') return { error: '--effects must be auto or off' };
  const assignments = effectAssignments
    ?? (typeof flags.effect === 'string' ? [flags.effect] : Array.isArray(flags.effect) ? flags.effect.filter((value): value is string => typeof value === 'string') : []);
  if (flags.effect !== undefined && typeof flags.effect !== 'string' && !Array.isArray(flags.effect)) {
    return { error: '--effect takes <placement>=<componentId|none>' };
  }
  if (assignments.length === 0) return mode;
  if (mode === 'off') return { error: '--effects off cannot be combined with --effect' };
  const hints: Record<string, string> = {};
  for (const assignment of assignments) {
    const at = assignment.indexOf('=');
    const placement = at > 0 ? assignment.slice(0, at).trim() : '';
    const id = at > 0 ? assignment.slice(at + 1).trim() : '';
    if (!placement || !id) return { error: '--effect takes <placement>=<componentId|none>' };
    if (!(AGENCY_EFFECT_PLACEMENT_IDS as ReadonlyArray<string>).includes(placement)) {
      return { error: `--effect: placement must be one of ${AGENCY_EFFECT_PLACEMENT_IDS.join(', ')}` };
    }
    if (hints[placement] !== undefined && hints[placement] !== id) return { error: `--effect names placement ${placement} twice` };
    hints[placement] = id;
  }
  const parsed = parseAgencyEffectsInput(hints);
  if (!parsed.ok) return { error: `--effect: ${parsed.error}` };
  return parsed.value;
}

/** `--effects`/`--effect` as request fields, shared by a fresh build and a `--from` fork. */
function effectsFields(flags: Flags, effectAssignments: string[] | undefined): { effects?: AgencyEffectsInput } {
  const effects = effectsFromFlags(flags, effectAssignments);
  return effects !== undefined && (typeof effects === 'string' || !('error' in effects)) ? { effects: effects as AgencyEffectsInput } : {};
}

/** A byte count as `od` prints one: `900 B`, `4.1 KB`. */
function bytesLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * `od agency effects <family>`: a header naming the script policy and per-page cap, then one line
 * per placement — placement, host, and each allowed component with its kind and bytes. A family
 * with no placements says so in one line.
 */
export function familyEffectsLines(response: AgencyFamilyEffectsResponse): string[] {
  if (response.placements.length === 0) return [`${response.family} offers no effect placements`];
  const lines = [
    `${response.family}: script policy ${response.scriptPolicy}, at most ${response.maxEffects} effect(s) per page`,
    'placement\thost\tallowed',
  ];
  for (const entry of response.placements) {
    const allowed = entry.allow.length === 0
      ? '-'
      : entry.allow.map((component) => `${component.id} (${component.kind}, js ${bytesLabel(component.bytes.js)}, css ${bytesLabel(component.bytes.css)})`).join(', ');
    lines.push(`${entry.placement}\t${entry.host}\t${allowed}`);
  }
  return lines;
}

/**
 * The build's effects result, as `od agency build` prints it after the outcome: the counts, then
 * one line per applied component (placement → id, kind, who chose it) and per skipped placement
 * (its fixed reason code). Nothing when the snapshot carries no result.
 */
export function effectsLines(effects: AgencyEffectsResult | undefined): string[] {
  if (!effects) return [];
  const lines = [`effects (${effects.mode}): ${effects.applied.length} applied, ${effects.skipped.length} skipped`
    + (effects.jevSkipped ? ` (auto skipped: ${effects.jevSkipped})` : '')];
  for (const entry of effects.applied) lines.push(`  applied ${entry.placement} -> ${entry.componentId} (${entry.kind}, ${entry.source})`);
  for (const entry of effects.skipped) lines.push(`  skipped ${entry.placement}${entry.componentId ? ` (${entry.componentId})` : ''}: ${entry.reason}`);
  return lines;
}

/**
 * `--section <entryId>` with exactly one of `--after <sectionId>` (append) or
 * `--replace <optionalSectionId>` (replace-optional), plus `--direction <directionId>`
 * (`sol-design.md` §2/§3). Returns `undefined` when `--section` was not given at all — the
 * request then carries no `sectionSelection`, exactly as before this flag existed — the usage
 * error string, or the validated selection. Existence of `entryId`/`directionId` against the
 * live catalog/direction list is the daemon's own call (`GET /api/sections` and
 * `POST /api/agency/build`'s own validation), not this function's — it only checks shape.
 */
function sectionSelectionFromFlags(flags: Flags): AgencySectionSelectionInput | string | undefined {
  if (flags.section === undefined) return undefined;
  if (typeof flags.section !== 'string' || flags.section.length === 0) return '--section requires a section entry id';
  const after = flags.after;
  const replace = flags.replace;
  if ((after === undefined) === (replace === undefined)) {
    return '--section requires exactly one of --after <sectionId> or --replace <optionalSectionId>';
  }
  if (typeof flags.direction !== 'string' || flags.direction.length === 0) {
    return '--section requires --direction <directionId>';
  }
  let placement: AgencySectionPlacement;
  if (after !== undefined) {
    if (typeof after !== 'string' || after.length === 0) return '--after requires a section id';
    placement = { mode: 'append', afterSectionId: after };
  } else {
    if (typeof replace !== 'string' || replace.length === 0) return '--replace requires an optional section id';
    placement = { mode: 'replace-optional', targetSectionId: replace };
  }
  return { entryId: flags.section, placement, directionId: flags.direction };
}

/**
 * `--keep a,b` / `--drop c` (and, with `--from`, `--auto d`): explicit hints for the family's
 * optional sections, sent as the request's `sections`. `auto` clears a saved build's hint so Jev
 * decides that section again. Returns the hints, `undefined` when no flag was given, or the usage
 * error. Whether an id is optional is the daemon's call once the family is known.
 */
function sectionHints(flags: Flags): Record<string, 'keep' | 'drop' | 'auto'> | string | undefined {
  const hints: Record<string, 'keep' | 'drop' | 'auto'> = {};
  for (const hint of ['keep', 'drop', 'auto'] as const) {
    const value = flags[hint];
    if (value === undefined) continue;
    if (typeof value !== 'string') return `--${hint} takes a comma-separated list of section ids`;
    for (const id of value.split(',').map((part) => part.trim()).filter(Boolean)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) return `--${hint}: ${id} is not a section id`;
      if (hints[id] !== undefined && hints[id] !== hint) return `--${hints[id]} and --${hint} both name section ${id}`;
      hints[id] = hint;
    }
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/**
 * The `sectionSelection`/`designReferenceId`/`designReferenceText` fields shared by a fresh
 * build's request body and a `--from` fork's — factored out so the two never drift on how
 * `--section`/`--reference`/`--reference-file` become request fields. `designReferenceText` is
 * `options.designReferenceText` (already read from `--reference-file` by the caller, `cli.ts`),
 * not read here: this module stays pure of file I/O, matching `brief`'s own convention.
 */
function sectionOverlayFields(flags: Flags, designReferenceText: string | undefined): Pick<AgencyBuildRequest, 'sectionSelection' | 'designReferenceId' | 'designReferenceText'> {
  const selection = sectionSelectionFromFlags(flags);
  const sectionSelection = typeof selection === 'object' ? selection : undefined;
  return {
    ...(sectionSelection ? { sectionSelection } : {}),
    ...(typeof flags.reference === 'string' && flags.reference.length > 0 ? { designReferenceId: flags.reference } : {}),
    ...(designReferenceText !== undefined ? { designReferenceText } : {}),
  };
}

function requestBody(flags: Flags, brief: string, designReferenceText: string | undefined, effectAssignments: string[] | undefined): AgencyBuildRequest {
  const family = typeof flags.family === 'string' && flags.family.length > 0 ? flags.family : 'auto';
  // `--mode` is left out rather than defaulted, so the daemon's own default is the only one.
  const mode = typeof flags.mode === 'string' ? flags.mode as 'single' | 'sections' : undefined;
  const verify = typeof flags.verify === 'string' ? flags.verify as 'strict' | 'advisory' | 'after' | 'off' : 'strict';
  // `validate` refuses `--auto` without `--from`, so a fresh build's hints are keep/drop only.
  const hints = sectionHints(flags) as Record<string, 'keep' | 'drop'> | string | undefined;
  return {
    brief,
    family,
    verify,
    ...(mode !== undefined ? { mode } : {}),
    ...(typeof flags.name === 'string' ? { projectName: flags.name } : {}),
    ...(typeof flags.project === 'string' ? { projectId: flags.project } : {}),
    ...(typeof hints === 'object' ? { sections: hints } : {}),
    ...sectionOverlayFields(flags, designReferenceText),
    ...(typeof flags.composition === 'string' ? { composition: flags.composition as AgencyBuildComposition } : {}),
    ...(typeof flags['design-system'] === 'string' ? { designSystemId: flags['design-system'].trim() } : {}),
    ...(typeof flags.provider === 'string' ? { provider: flags.provider as 'deepseek' | 'cerebras' } : {}),
    // Omitted (not `false`) keeps the daemon's own default (`true`) — same omit-for-default rule
    // every other flag here follows.
    ...(flags['no-failover'] === true ? { failover: false } : {}),
    ...effectsFields(flags, effectAssignments),
  };
}

/**
 * The two refusals that are the person's to resolve, not the daemon's to retry: no Jev key on this
 * machine, and a build already running. Both exit 2 with the daemon's own fixed sentence, so a
 * script can tell them from a build that ran and failed (1) and from one nothing covers (3).
 */
function refusal(status: number, body: ApiErrorResponse['error'] | undefined): string[] | undefined {
  if (status === 503 && body?.code === 'JEV_UNAVAILABLE') return [body.message];
  if (status === 409 && body?.code === 'BUILD_BUSY') {
    const details = body.details as AgencyBuildBusyDetails | undefined;
    return [body.message, ...(details?.activeId ? [`the running build is ${details.activeId}`] : [])];
  }
  // The two `--from` refusals: an id this daemon does not remember, and one it remembers but
  // cannot start a new project from (never finished and published one, or that project was
  // rolled back). Both are the caller's to fix, not the daemon's to retry — same exit as usage.
  if (status === 404 && body?.code === 'BUILD_NOT_FOUND') return [body.message];
  if (status === 409 && body?.code === 'BUILD_NOT_FORKABLE') return [body.message];
  // `--section`/`--reference`'s own preflight refusals (`sol-design.md` §2): an unknown or
  // not-yet-reviewed entry/direction id is `BAD_REQUEST` (falls through to the generic path
  // below); a MotionSites reference the signed-in user cannot open is one of these two — the
  // daemon's own fixed sentence names which, and never the prompt text. Same exit as usage: the
  // person has to sign in or upgrade before retrying, this command cannot do either for them.
  if (status === 401 && body?.code === 'MOTIONSITES_LOGIN_REQUIRED') return [body.message];
  if (status === 403 && body?.code === 'MOTIONSITES_PAID_ACCESS_REQUIRED') return [body.message];
  // The MotionSites endpoint itself failed (transport error, malformed response) — transient,
  // never the prompt text, and worth its own line rather than falling through to the generic
  // structured-error path (delta audit finding 3).
  if (status === 502 && body?.code === 'MOTIONSITES_UPSTREAM_UNAVAILABLE') return [body.message];
  return undefined;
}

/**
 * Runs the subcommand and returns the exit code. Never calls `process.exit` itself.
 *
 * A non-2xx start that is neither refusal is handed back as `{ httpFailure }` so the caller can
 * use cli.ts's shared structured-error path, which every other subcommand's daemon failures take.
 */
export async function runAgencyBuildCli(
  flags: Flags,
  options: AgencyBuildCliOptions,
): Promise<number | { httpFailure: Response }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const usage = validate(flags, options.brief, options.effectAssignments);
  if (usage) {
    for (const line of usage) options.stderr(line);
    return EXIT.usage;
  }

  // `--from <buildId>` is "start from this build": the same endpoint the Route panel's "Start
  // from this build" action and `AgencyBuildForkRequest` back. Everything but the brief travels
  // with the saved build; `--brief`/`--prompt-file` here override only its text, per `validate`,
  // and `--keep`/`--drop`/`--auto` merge over its saved section hints.
  const forkId = forkIdFlag(flags);
  const startUrl = forkId !== undefined
    ? `${options.baseUrl}/api/agency/builds/${encodeURIComponent(forkId)}/fork`
    : `${options.baseUrl}/api/agency/build`;
  const forkHints = sectionHints(flags);
  const startBody: AgencyBuildForkRequest | AgencyBuildRequest = forkId !== undefined
    ? {
      ...(options.brief ? { brief: options.brief } : {}),
      ...(typeof forkHints === 'object' ? { sections: forkHints } : {}),
      ...sectionOverlayFields(flags, options.designReferenceText),
      ...(typeof flags.composition === 'string' ? { composition: flags.composition as AgencyBuildComposition } : {}),
      ...effectsFields(flags, options.effectAssignments),
    }
    : requestBody(flags, options.brief!, options.designReferenceText, options.effectAssignments);

  const started = await fetchImpl(startUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(startBody),
  });
  if (!started.ok) {
    const text = await started.text();
    let parsed: ApiErrorResponse | undefined;
    try {
      parsed = text ? JSON.parse(text) as ApiErrorResponse : undefined;
    } catch {
      parsed = undefined;
    }
    const refused = refusal(started.status, parsed?.error);
    if (refused) {
      for (const line of refused) options.stderr(line);
      return EXIT.usage;
    }
    // Re-wrap the body so the caller's shared path can read it again.
    return { httpFailure: new Response(text, { status: started.status, headers: started.headers }) };
  }

  const { build } = await started.json() as AgencyBuildResponse;
  if (flags['no-wait'] === true) {
    options.stdout(build.id);
    return EXIT.done;
  }

  // `--agui` follows the AG-UI view of the same build (`GET .../:id/agui`) instead of `/events`.
  const agui = flags.agui === true;
  const events = `${options.baseUrl}/api/agency/builds/${encodeURIComponent(build.id)}/${agui ? 'agui' : 'events'}`;
  const stream = await fetchImpl(events, { headers: { accept: 'text/event-stream' } });
  if (!stream.ok || !stream.body) {
    return { httpFailure: stream };
  }

  // Ctrl-C asks the daemon to stop the build and keeps reading: the build still has to roll back
  // the project it may have created, and the terminal frame is what says it did. Registering a
  // handler is also what stops the default SIGINT from killing the process mid-rollback.
  //
  // The wait is bounded. `cancelTimedOut` never settles on its own, so racing every read against
  // it costs nothing until Ctrl-C starts its timer — and once it has, the race fires even while a
  // read is blocked on a daemon that has stopped answering.
  let cancelling: Promise<unknown> | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let stopWaiting!: () => void;
  const cancelTimedOut = new Promise<'cancel-timeout'>((resolve) => {
    stopWaiting = () => resolve('cancel-timeout');
  });
  options.onInterrupt(() => {
    if (cancelling) return;
    // The `catch` is part of the assignment on purpose, not a convenience. When the confirm wait
    // times out this promise is abandoned unawaited, and an unhandled rejection from a daemon
    // that died mid-request would take the process down with a non-zero code of Node's choosing —
    // turning a cancellation the person asked for into a crash.
    cancelling = fetchImpl(`${options.baseUrl}/api/agency/builds/${encodeURIComponent(build.id)}/cancel`, { method: 'POST' })
      .catch(() => undefined);
    confirmTimer = setTimeout(stopWaiting, options.cancelTimeoutMs ?? CANCEL_CONFIRM_TIMEOUT_MS);
    confirmTimer.unref?.();
  });

  const json = flags.json === true;
  let final: AgencyBuildSnapshot | undefined;
  /** `--agui`: the status the terminal AG-UI event reported. */
  let aguiFinal: AgencyBuildSnapshot['status'] | undefined;
  /** A frame this CLI could not read. The stream is no longer trustworthy, so the follow ends. */
  let malformed = false;
  let unconfirmed = false;
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** Parses one frame's payload, or marks the stream unreadable. Never throws. */
  const parse = <T>(payload: string): T | undefined => {
    try {
      return JSON.parse(payload) as T;
    } catch {
      malformed = true;
      return undefined;
    }
  };

  const handleFrame = (frame: string) => {
    let name = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    const payload = data.join('\n');
    if (!payload) return;
    if (agui) {
      // One AG-UI event per stdout line, exactly as the daemon sent it (re-serialised compactly).
      // The terminal event decides the exit code; nothing is printed besides the events.
      if (name !== 'message') return;
      const frame = parse<{ type?: unknown; result?: { status?: unknown } }>(payload);
      if (!frame || typeof frame.type !== 'string') {
        malformed = true;
        return;
      }
      options.stdout(JSON.stringify(frame));
      if (frame.type === 'RUN_ERROR') aguiFinal = 'failed';
      if (frame.type === 'RUN_FINISHED') {
        const status = frame.result?.status;
        aguiFinal = typeof status === 'string' ? status as AgencyBuildSnapshot['status'] : 'done';
      }
      return;
    }
    if (name === 'status') {
      final = parse<AgencyBuildSnapshot>(payload);
      return;
    }
    if (name !== 'build-event' || json) return;
    const event = parse<AgencyBuildEvent>(payload);
    if (!event) return;
    const line = lineFor(event);
    if (line) options.stdout(line);
  };

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), cancelTimedOut]);
      if (next === 'cancel-timeout') {
        unconfirmed = true;
        break;
      }
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separator).trim();
        buffer = buffer.slice(separator + 2);
        if (frame.length > 0 && !frame.startsWith(':')) handleFrame(frame);
      }
      if (malformed) break;
    }
    if (!malformed && !unconfirmed && buffer.trim().length > 0 && !buffer.trim().startsWith(':')) {
      handleFrame(buffer.trim());
    }
  } finally {
    if (confirmTimer) clearTimeout(confirmTimer);
    await reader.cancel().catch(() => undefined);
  }
  // The cancel POST is waited for so the command does not exit while the request is still on the
  // wire — but it is bounded for the same reason the stream wait is. A daemon that has stopped
  // answering must not hold the person's shell on either of the two requests. When the confirm
  // wait already timed out, the daemon has had its whole allowance and this is not waited on at
  // all; the request is `catch`-ed at the call site, so abandoning it rejects nothing.
  if (cancelling && !unconfirmed) {
    await Promise.race([cancelling, after(options.cancelTimeoutMs ?? CANCEL_CONFIRM_TIMEOUT_MS)]);
  }

  // A frame this CLI cannot read is a broken stream, not a broken build: it says so in one fixed
  // line and never lets a parse error out as a stack trace.
  if (malformed) {
    options.stderr('the build stream sent a frame this command could not read');
    return EXIT.failed;
  }
  if (unconfirmed) {
    options.stderr('the build was cancelled, but the daemon did not confirm it stopped');
    return EXIT.cancelled;
  }
  if (agui) {
    if (!aguiFinal) {
      options.stderr('the build stream ended before the build did');
      return EXIT.failed;
    }
    return exitFor(aguiFinal);
  }
  if (!final) {
    options.stderr('the build stream ended before the build did');
    return EXIT.failed;
  }
  if (json) {
    options.stdout(JSON.stringify(final, null, 2));
    return exitFor(final.status);
  }
  if (final.error) options.stderr(final.error.message);
  for (const line of failureLines(final)) options.stderr(line);
  // A project id on anything but `done` is one the build did not finish with and did not remove:
  // a rollback that failed, or a project the caller supplied. Saying "leftover" is what tells a
  // person it is theirs to deal with. A snapshot without one names nothing, because the daemon
  // drops the id when the rollback succeeded.
  const project = final.projectId
    ? (final.status === 'done' ? ` — project ${final.projectId}` : ` — leftover project ${final.projectId}`)
    : '';
  options.stdout(`${final.status}${project}`);
  for (const line of effectsLines(final.effects)) options.stdout(line);
  // C16: a static prototype's build says so last, whatever the outcome, so nobody ships it as a
  // working app by mistake. `--json` carries the same answer as `outputScope`.
  if (final.outputScope === 'static-prototype') options.stdout(STATIC_PROTOTYPE_LABEL);
  return exitFor(final.status);
}
