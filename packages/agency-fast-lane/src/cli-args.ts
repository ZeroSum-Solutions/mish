/**
 * Fast-lane CLI argument parsing: the `parseArgs` table, plus the synchronous validation that
 * turns `values` into a typed, validated options object, including the legacy `--verify jev` /
 * `--verify-strict` → `--verify-mode` mapping (`resolveVerifyPolicy`). All of this already ran
 * entirely before any async work (file reads, network calls) in `src/cli.ts`'s `runCli`; moving it
 * here changes nothing about when any check fires relative to the others — only where the code
 * that does it lives.
 *
 * `CliExit` (and the `fail` helper built on it) is defined here rather than in `cli.ts`, since this
 * is the first module in the call chain that needs to throw one; `cli.ts` and `src/cli-report.ts`
 * both import it from here rather than each carrying their own copy.
 */

import { parseArgs } from 'node:util';
import type { ProviderName } from './deepseek.ts';
import { EFFECT_PLACEMENT_IDS, type EffectsInput } from './effects.ts';
import { resolveVerifyPolicy } from './verify-policy.ts';

/**
 * Thrown internally to unwind to one exit code without calling `process.exit` mid-function, so
 * `main` (in `cli.ts`) stays callable from a test. `message`, when non-empty, is printed to
 * `deps.stderr` by the catch in `main`; a code whose explanation was already printed via
 * `deps.stdout` (the routing and strict-failure paths) throws with no message, so it is not
 * printed twice.
 */
export class CliExit extends Error {
  readonly code: number;
  constructor(code: number, message = '') {
    super(message);
    this.code = code;
  }
}

export function fail(message: string): never {
  throw new CliExit(1, message);
}

/**
 * Parses `argv` and validates every flag that can be checked without touching the filesystem, the
 * network, or `deps` — everything from `--provider` through `--max-retries`, plus the resolved
 * `--verify-mode`. Throws `CliExit` (usage errors at exit 1; the `--verify-strict` /
 * `--verify-mode` conflict at exit 2, since it is part of the same fail-closed verification
 * contract as a failed strict gate, not a generic argument-shape mistake) on the first invalid
 * value. `values` is returned alongside the derived fields for the handful of flags `runCli` still
 * reads directly (`daemon`, `project`, `name`, `dry-run`, `out-dir`, `report`, `model`, `package`,
 * `debug-dir`, `lock`, `asset`, `archive`, `entry`, `spine`, `previous`) without needing their own
 * validation.
 */
export function parseFastLaneArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      family: { type: 'string' },
      brief: { type: 'string' },
      mode: { type: 'string', default: 'sections' },
      spine: { type: 'string' },
      previous: { type: 'string' },
      revision: { type: 'string', default: '1' },
      entry: { type: 'string' },
      daemon: { type: 'string', default: 'http://127.0.0.1:57830' },
      project: { type: 'string' },
      name: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'out-dir': { type: 'string' },
      report: { type: 'string' },
      provider: { type: 'string', default: 'deepseek' },
      model: { type: 'string' },
      package: { type: 'string' },
      'max-repairs': { type: 'string', default: '1' },
      // Sets `RunOptions.transportRetryLimit` (capped at 2 there, so this default already matches
      // the effective cap — see `build.ts`'s own doc on `maxRetries`, and `run.ts`'s callModel).
      'max-retries': { type: 'string', default: '2' },
      'debug-dir': { type: 'string' },
      lock: { type: 'string', multiple: true, default: [] },
      asset: { type: 'string', multiple: true, default: [] },
      verify: { type: 'string' },
      'verify-mode': { type: 'string' },
      'verify-threshold': { type: 'string' },
      'verify-strict': { type: 'boolean', default: false },
      archive: { type: 'boolean', default: false },
      'route-only': { type: 'boolean', default: false },
      'route-threshold': { type: 'string' },
      'route-min-transfer': { type: 'string' },
      'route-spine-share': { type: 'string' },
      keep: { type: 'string', multiple: true, default: [] },
      drop: { type: 'string', multiple: true, default: [] },
      effects: { type: 'string' },
      effect: { type: 'string', multiple: true, default: [] },
    },
  });

  const provider: ProviderName = values.provider === 'deepseek' || values.provider === 'cerebras' ? values.provider : fail('--provider must be deepseek or cerebras');
  const routeOnly = values['route-only'] ?? false;
  if (routeOnly && values.family !== undefined && values.family !== 'auto') fail('--route-only implies --family auto; do not pass a different --family');
  const requestedFamily = routeOnly ? 'auto' : (values.family ?? fail('--family is required'));
  if (requestedFamily === 'auto' && values.spine !== undefined) fail('--family auto cannot be combined with --spine: the spine recipe already fixes the family');
  if (requestedFamily === 'auto' && values.package !== undefined) fail('--family auto cannot be combined with --package: pass an explicit --family id instead');
  if (values.previous !== undefined && values.spine === undefined) fail('--previous names what a re-target is FROM; pass --spine for what it is re-targeting TO');
  const briefPath = values.brief ?? fail('--brief <file> is required');
  const mode = values.mode === 'sections' ? 'sections' : values.mode === 'single' ? 'single' : fail('--mode must be single or sections');
  const revision = Number(values.revision);
  if (!Number.isInteger(revision) || revision < 1) fail('--revision must be a positive integer');
  const maxRepairs = Number(values['max-repairs']);
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) fail('--max-repairs must be a non-negative integer');
  if (values.verify !== undefined && values.verify !== 'jev') fail('--verify must be jev');
  const verifyStrict = values['verify-strict'] ?? false;
  let verifyModeArg: 'strict' | 'advisory' | 'after' | 'off' | undefined;
  if (values['verify-mode'] !== undefined) {
    if (values['verify-mode'] !== 'strict' && values['verify-mode'] !== 'advisory' && values['verify-mode'] !== 'after' && values['verify-mode'] !== 'off') fail('--verify-mode must be strict, advisory, after, or off');
    verifyModeArg = values['verify-mode'];
  }
  // `resolveVerifyPolicy` is the single source of truth for turning `--verify-mode` plus the legacy
  // `--verify jev` / `--verify-strict` pair into one effective mode; see src/verify-policy.ts. A
  // conflicting request (`--verify-strict` naming a different mode than `--verify-mode`) is a usage
  // error worth exit 2, the same code a failed strict gate uses, since it is part of the same
  // fail-closed verification contract rather than a generic argument-shape mistake.
  const verifyPolicy = resolveVerifyPolicy({ verifyMode: verifyModeArg, legacyVerifyJev: values.verify === 'jev', legacyVerifyStrict: verifyStrict, routeOnly });
  if ('error' in verifyPolicy) throw new CliExit(2, verifyPolicy.error);
  const verifyMode = verifyPolicy.mode;
  let verifyThreshold: number | undefined;
  if (values['verify-threshold'] !== undefined) {
    verifyThreshold = Number(values['verify-threshold']);
    if (!Number.isFinite(verifyThreshold) || verifyThreshold < 0 || verifyThreshold > 1) fail('--verify-threshold must be a number between 0 and 1');
  }
  let routeThreshold: number | undefined;
  if (values['route-threshold'] !== undefined) {
    routeThreshold = Number(values['route-threshold']);
    if (!Number.isFinite(routeThreshold) || routeThreshold < 0 || routeThreshold > 1) fail('--route-threshold must be a number between 0 and 1');
  }
  let routeMinTransfer: number | undefined;
  if (values['route-min-transfer'] !== undefined) {
    routeMinTransfer = Number(values['route-min-transfer']);
    if (!Number.isFinite(routeMinTransfer) || routeMinTransfer < 0 || routeMinTransfer > 3) fail('--route-min-transfer must be a number between 0 and 3');
  }
  let routeSpineShare: number | undefined;
  if (values['route-spine-share'] !== undefined) {
    routeSpineShare = Number(values['route-spine-share']);
    if (!Number.isFinite(routeSpineShare) || routeSpineShare < 0 || routeSpineShare > 1) fail('--route-spine-share must be a number between 0 and 1');
  }
  const maxRetries = Number(values['max-retries']);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) fail('--max-retries must be a non-negative integer');
  const sectionHints = parseSectionHints(values.keep, values.drop);
  const effects = parseEffectFlags(values.effects, values.effect);

  return {
    values,
    provider,
    routeOnly,
    requestedFamily,
    briefPath,
    mode,
    revision,
    maxRepairs,
    verifyMode,
    verifyThreshold,
    routeThreshold,
    routeMinTransfer,
    routeSpineShare,
    maxRetries,
    sectionHints,
    effects,
  };
}

/**
 * `--effects auto|off` and `--effect <placement>=<id|none>` (repeatable): the build's
 * `BuildInput.effects`. `--effect` names an id per placement, and every placement it does not name
 * stays `auto`; it cannot be combined with `--effects off`. Whether the family allows an id there
 * is only known once the family is, so that is checked later (skipped as `not-allowed`).
 */
export function parseEffectFlags(mode: string | undefined, pairs: readonly string[]): EffectsInput | undefined {
  if (mode !== undefined && mode !== 'auto' && mode !== 'off') fail('--effects must be auto or off');
  if (pairs.length === 0) return mode as 'auto' | 'off' | undefined;
  if (mode === 'off') fail('--effects off cannot be combined with --effect');
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) fail(`--effect expects <placement>=<id|none>, received ${pair}`);
    const placement = pair.slice(0, separator);
    const id = pair.slice(separator + 1);
    if (!(EFFECT_PLACEMENT_IDS as readonly string[]).includes(placement)) fail(`--effect: ${placement} is not a placement (${EFFECT_PLACEMENT_IDS.join(', ')})`);
    // `none` is the "no effect here" sentinel, never a component; a placement id is never one either.
    if (id !== 'none' && (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || (EFFECT_PLACEMENT_IDS as readonly string[]).includes(id))) fail(`--effect ${placement}: ${id} is not a component id`);
    if (Object.hasOwn(record, placement)) fail(`--effect names ${placement} twice`);
    record[placement] = id;
  }
  return record;
}

/**
 * `--keep <id>` / `--drop <id>` (repeatable): explicit keep/drop hints for optional sections,
 * which override the Jev keep/drop request (see `src/sections.ts`). An id named by both is a usage
 * error; whether an id is optional is only known once the family is, so that is checked later.
 */
export function parseSectionHints(keep: readonly string[], drop: readonly string[]): Record<string, 'keep' | 'drop'> | undefined {
  const hints: Record<string, 'keep' | 'drop'> = {};
  for (const id of keep) hints[id] = 'keep';
  for (const id of drop) {
    if (hints[id] === 'keep') fail(`--keep and --drop both name section ${id}`);
    hints[id] = 'drop';
  }
  for (const id of Object.keys(hints)) if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail(`--keep/--drop: ${id} is not a section id`);
  return Object.keys(hints).length > 0 ? hints : undefined;
}

export type ParsedCliArgs = ReturnType<typeof parseFastLaneArgs>;
