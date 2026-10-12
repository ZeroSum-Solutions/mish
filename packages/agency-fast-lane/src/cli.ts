/**
 * agency-fast-lane CLI.
 *
 *   node --experimental-strip-types src/cli.ts --family maben --brief brief.md \
 *     [--mode sections|single] [--spine recipe.json] [--previous recipe.json] \
 *     [--revision 1] [--entry maben-r1.html] \
 *     [--daemon http://127.0.0.1:57830] [--project <id> | --name "Client"] [--dry-run] \
 *     [--out-dir NEW-dir] [--report report.json] [--provider deepseek|cerebras] [--model id] \
 *     [--package dir] [--lock brand.name ...] [--asset wordmark=client-wordmark.png ...] \
 *     [--max-retries 2] [--debug-dir dir] [--verify-mode strict|advisory|after|off] [--archive] \
 *     [--verify-threshold 0.85] [--route-only] [--route-threshold 0.5] [--route-min-transfer 2] \
 *     [--route-spine-share 0.25] [--verify jev] [--verify-strict] [--keep <section-id> ...] \
 *     [--drop <section-id> ...] [--effects auto|off] [--effect <placement>=<id|none> ...]
 *
 * `--verify-mode` defaults to `strict` for a build: the fill and the Jev faithfulness check run
 * entirely in memory, and only a clean pass (the check ran, nothing left `remaining`, nothing
 * `oversized`, nothing `skipped`) creates the project and publishes it, in one deferred batch. A
 * failing run registers nothing and exits 2. `--verify-mode advisory` keeps the old shape — the
 * check still runs, but a flag never blocks publishing, only prints loudly. `--verify-mode after`
 * publishes FIRST — a `preview` event fires as soon as the page is registered — and only then runs
 * the check once, with no in-run repair; a flag is reported (`verify` event, `report.verify`) but
 * left exactly as filled, because the page is already live and a caller that asked to publish
 * before checking does not want it silently rewritten (see `run.ts`'s `verifyAfterPublish` and the
 * daemon's `POST /api/agency/builds/:id/repair`, which is the actual repair pass for this mode).
 * `--verify-mode off` skips the check entirely. `resolveVerifyPolicy` (`src/verify-policy.ts`) is
 * the single source of truth for turning these flags, plus the legacy `--verify jev` / `--verify-strict` pair kept
 * working for one release, into the effective mode; see that module for the exact mapping.
 *
 * Every mode but `off` needs a Jev credential, resolved by `createJevCredentialResolver`
 * (`TYPESAFE_API_KEY` in the environment first, then the local vault) and cached once per run:
 * the same resolved credential backs the `--family auto` router, the preflight, and the
 * faithfulness checker, so a run never reads it twice. For any build that is not `--route-only`,
 * the preflight runs before the router call and before any model call, and fails closed (exit 2,
 * a clear message, never the key itself) if the credential cannot be resolved. `--route-only`
 * never builds and is exempt: it still needs Jev to route, but that failure is routing's own to
 * report, not this preflight's.
 *
 * `--family auto` runs the ROUTE step first: one Jev request classifies the brief against the
 * Website Shape Atlas, and `resolveRoute` picks the bundled family to build with. Unrouted (no
 * spine Jev is confident of, or the top family pick is below `--route-threshold`) prints the
 * reason and the ranked candidates and exits 3, building nothing — it never falls back to a
 * guess. `--route-only` implies `--family auto`, never builds or touches the daemon, and exits 0
 * either way (routed or unrouted) once it has printed and (with `--report`) written the decision.
 *
 * The CLI body lives in `main(argv, deps)`, exported for `tests/cli.test.ts`: `deps` defaults to
 * the real model/Jev/daemon integrations and `console.log`/`console.error`, and a test overrides
 * whichever of those it needs to fake (a model caller factory, Jev resolver/checker/router
 * factories, the daemon `fetch`, or the stdout/stderr writers) while exercising the same argument
 * parsing, policy resolution and orchestration a real invocation uses. `main` returns an exit code
 * rather than calling `process.exit` itself, so a test can assert on it directly; only the bin
 * entry at the bottom of this file (guarded so importing this module never runs it) calls
 * `process.exit` (via `src/process-exit.ts`) and registers the process-level
 * `unhandledRejection`/`uncaughtException` handlers.
 *
 * `runCli` below is an adapter around `buildSite` (`src/build.ts`), which owns the build itself —
 * the preflight, routing, the project, the model caller, the checker, the provider lock and the
 * run — so that the daemon can run the same build without a terminal. What is left here is what
 * only a terminal needs: argument parsing and verify-policy resolution (`src/cli-args.ts`), the
 * inputs a build has to be handed ready-made (`prepare` below: entry name, package, asset
 * overrides, spine, `--previous`, the `--out-dir` claim and the `--debug-dir` dump), turning every
 * `BuildEvent` into the stamped line it has always printed, the `--report` body and console
 * summary (`src/cli-report.ts`), and the exit codes (`src/process-exit.ts` for the exit
 * coordinator).
 *
 * `--previous recipe.json` names the recipe a re-target is FROM — typically the project's
 * current, already-published recipe (its `recipe.json`, same shape `--out-dir` writes out) —
 * while `--spine` names what it is re-targeting TO. Every text slot identical between the two is
 * folded into the locked set alongside `--lock`, so a re-target that changes a few slots fills
 * and verifies only those, not the whole recipe. See `RunOptions.previousRecipe`
 * (`src/run.ts`) and `unchangedTextPaths` (`src/spine.ts`) for the mechanism.
 */

import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAtlasData } from './atlas.ts';
import { buildSite, JevCredentialError, routeBuild, type BuildEvent, type BuildResult, type PreparedBuild } from './build.ts';
import { CliExit, fail, parseFastLaneArgs } from './cli-args.ts';
import { buildReportBody, printRunSummary } from './cli-report.ts';
import { createModelCaller, createProviderKeyResolver, ProviderHttpError, vaultSecret, type CallerOptions, type ModelCall, type ProviderName } from './deepseek.ts';
import { defaultPackageDir, loadFamilyPackage } from './family.ts';
import { createJevChecker, resolveJevKey, type FaithfulnessChecker, type JevCheckerOptions } from './jev.ts';
import { installFatalHandlers, requestNormalExit } from './process-exit.ts';
import { DaemonHttpError } from './publish.ts';
import { createJevRouter, type JevRouter, type JevRouterOptions, type RouteDecision } from './route.ts';
import { createJevSectionJudge, type JevSectionJudgeOptions, type SectionJudge } from './sections.ts';
import { createJevEffectJudge, type EffectCatalog, type EffectJudge, type JevEffectJudgeOptions } from './effects.ts';
import { REPAIR_REASON_TEXT, type FastLaneMode } from './run.ts';
import { isObject, type Json } from './spine.ts';
import { createJevCredentialResolver } from './verify-policy.ts';
import { isComposedRecipe, publicRecipe } from './block-compose.ts';

export { installFatalHandlers, requestFatalExit, requestNormalExit } from './process-exit.ts';

/**
 * Everything `main` reaches out to the world through. A caller overrides only what it needs to
 * fake; everything else keeps the real, network/vault/daemon-touching default.
 */
export type CliDeps = {
  createModelCaller: (options: CallerOptions) => ModelCall;
  createJevChecker: (options: JevCheckerOptions) => FaithfulnessChecker;
  createJevRouter: (options: JevRouterOptions) => JevRouter;
  /** The optional-section keep/drop judge; see `BuildDeps.createSectionJudge`. */
  createSectionJudge?: (options: JevSectionJudgeOptions) => SectionJudge;
  /** The effect judge; see `BuildDeps.createEffectJudge`. */
  createEffectJudge?: (options: JevEffectJudgeOptions) => EffectJudge;
  /** The GenUI catalog manifest for effect names, kinds and categories; see `BuildInput.effectCatalog`. */
  loadEffectCatalog?: () => Promise<EffectCatalog | undefined>;
  /** The raw, uncached Jev (TypeSafe) credential read. `buildSite` wraps this in one cached
   * resolver (`resolveJevKey`) per run, so this is called at most once regardless of how many of
   * routing, the preflight and the checker end up needing it. */
  resolveJevCredential: () => Promise<string>;
  /** The model provider's key. Called by the model caller at call time, never up front. */
  resolveModelKey: (provider: ProviderName) => Promise<string>;
  /** Used for every daemon HTTP call (`ensureProject`, `projectPublisher`). */
  daemonFetch: typeof fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

const defaultDeps: CliDeps = {
  createModelCaller,
  createJevChecker,
  createJevRouter,
  createSectionJudge: createJevSectionJudge,
  createEffectJudge: createJevEffectJudge,
  loadEffectCatalog: loadEffectCatalogFromSource,
  resolveJevCredential: createJevCredentialResolver(process.env, () => vaultSecret('typesafe_api_key')),
  // `DEEPSEEK_API_KEY` / `CEREBRAS_API_KEY` first, then the vault — see `createProviderKeyResolver`.
  resolveModelKey: createProviderKeyResolver(process.env),
  daemonFetch: fetch,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

/** The shape `RunOptions.onCall` (`run.ts`) and `FillSectionAdapterOptions.onCall`
 * (`section-overlay.ts`) both hand a caller. Named here, once, rather than re-typed at each call
 * site that needs it (`createDebugDirOnCall` below, and any test that wants the same shape). */
export type CliOnCall = (call: { label: string; attempt: number; prompt: string; answer: string }) => void;

/**
 * The real `--debug-dir` writer: one `<index>-<label>-a<attempt>.{prompt,answer}.txt` pair per
 * call, under `debugDir` (already created by the caller). Exported so a test can call this EXACT
 * function against a real temp directory and assert on the real on-disk shape, rather than
 * re-implementing this logic inline (delta audit, BLOCK 1b: a copy of the writer proves the copy
 * is clean, not the writer).
 */
export function createDebugDirOnCall(debugDir: string): CliOnCall {
  let callIndex = 0;
  return (call) => {
    callIndex += 1;
    // A section-selection label carries the adapter id verbatim (`section:hyperui:marketing/
    // ctas/1` — see `section-overlay.ts`'s `fillSectionAdapter`), which contains `/`; every
    // other label this run ever produces does not. Replaced with `-` so the label is always
    // one flat filename stem — `path.join` below would otherwise read an embedded `/` as a
    // directory separator and try to write into a subdirectory that was never created.
    const safeLabel = call.label.replace(/[/\\]/g, '-');
    // Synchronous on purpose: a dump must survive the process failing right after the call.
    const stem = path.join(debugDir, `${String(callIndex).padStart(2, '0')}-${safeLabel}-a${call.attempt}`);
    writeFileSync(`${stem}.prompt.txt`, call.prompt);
    writeFileSync(`${stem}.answer.txt`, call.answer);
  };
}

/**
 * The GenUI catalog manifest, read from the workspace source tree (the CLI runs from source). The
 * daemon never calls this: it passes the bundle-safe `@open-design/genui-catalog/data` manifest.
 * A missing or unreadable file gives `undefined`, and auto effects then offer ids without
 * descriptions and treat every kind as `js` (the stricter guard).
 */
export async function loadEffectCatalogFromSource(): Promise<EffectCatalog | undefined> {
  const file = path.resolve(import.meta.dirname, '../../genui-catalog/catalog.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Json;
    return isObject(value) && Array.isArray(value.components) ? (value as unknown as EffectCatalog) : undefined;
  } catch {
    return undefined;
  }
}

async function runCli(argv: string[], deps: CliDeps): Promise<void> {
  const { values, provider, routeOnly, requestedFamily, briefPath, mode, revision, maxRepairs, verifyMode, verifyThreshold, routeThreshold, routeMinTransfer, routeSpineShare, maxRetries, sectionHints, effects } =
    parseFastLaneArgs(argv);

  const stamp = (ms: number) => `[${(ms / 1000).toFixed(2).padStart(6)}s]`;
  const routeOptions = { threshold: routeThreshold, minTransfer: routeMinTransfer, spineShare: routeSpineShare };

  const printRoute = (decision: RouteDecision) => {
    if (decision.decision === 'routed') {
      const winner = decision.family!;
      const basisLabel = winner.basis === 'exact' ? 'exact archetype' : winner.basis === 'same-spine' ? 'same spine' : 'compatible spine';
      const archetypeLabel = decision.archetype ? `${decision.archetype.id} ${decision.archetype.name}` : `${decision.spine.code} ${decision.spine.name}`;
      deps.stdout(`${stamp(decision.ms)} route: ${archetypeLabel} → ${winner.id} (p ${winner.probability.toFixed(2)}, ${basisLabel}, skin ${decision.skin.choice})`);
    } else {
      deps.stdout(`${stamp(decision.ms)} route: unrouted — ${decision.reason}`);
      for (const candidate of decision.candidates) {
        deps.stdout(`         candidate ${candidate.family} (p ${candidate.probability.toFixed(2)}, ${candidate.basis}, transfer ${candidate.transfer})`);
      }
    }
  };

  // Handed to `buildSite` unread: it reads the brief only after the credential preflight has
  // passed, so a build that cannot verify still reports that first — ahead of a missing brief
  // file, which would otherwise answer with its own error and a different exit code.
  const readBrief = () => readFile(briefPath, 'utf8');

  // --route-only never builds, whatever the outcome, so it never enters `buildSite` at all: it
  // runs the shared ROUTE step on its own and exits 0 once it has printed (and written) the
  // decision. `--route-only` always resolves to verify-mode off, so no preflight applies here and
  // a routing failure is reported by routing's own error path.
  if (routeOnly) {
    const { atlas, registry } = await loadAtlasData();
    const route = await routeBuild({ brief: await readBrief(), atlas, registry, jevKey: resolveJevKey(deps.resolveJevCredential), options: routeOptions }, deps);
    printRoute(route);
    if (values.report) await writeFile(values.report, `${JSON.stringify({ route }, null, 2)}\n`);
    throw new CliExit(0);
  }

  const onEvent = (event: BuildEvent) => {
    if (event.type === 'route') printRoute(event.decision);
    else if (event.type === 'project') deps.stdout(`project ${event.projectId}`);
    else if (event.type === 'lock-wait') deps.stdout(`waiting: another ${event.provider} run (pid ${event.pid}) holds the one-at-a-time lock`);
    else if (event.type === 'failover') deps.stdout(`failover: ${event.from} → ${event.to} (${event.reason})`);
    else if (event.type === 'assets') deps.stdout(`${stamp(event.ms)} assets: ${event.count} uploaded`);
    else if (event.type === 'first-token') deps.stdout(`${stamp(event.ms)} first token`);
    else if (event.type === 'unit') deps.stdout(`${stamp(event.ms)} unit ${event.label} done${event.repairs ? ` after ${event.repairs} repair(s)` : ''}`);
    else if (event.type === 'paint') deps.stdout(`${stamp(event.ms)} paint #${event.count} (${event.label})`);
    // The reason, not the message: the message behind a repair can quote the model's own output
    // (see `RepairReason`). A run that gives up throws the same fixed sentence, so nothing printed
    // here or on stderr carries generated text; `--debug-dir` is where the verbatim prompt and
    // answer go.
    else if (event.type === 'repair') deps.stdout(`         repair ${event.label}: ${REPAIR_REASON_TEXT[event.reason]}`);
    else if (event.type === 'clipped') deps.stdout(`         clipped ${event.label}: ${event.paths.join(', ')}`);
    else if (event.type === 'verify') deps.stdout(`${stamp(event.ms)} verify: checked ${event.checked}, illustrative ${event.illustrative}, flagged ${event.flagged}, repaired ${event.repaired}, remaining ${event.remaining}${event.skipped ? ` (skipped: ${event.skipped})` : ''}`);
    else if (event.type === 'render-quality') deps.stdout(event.report.passed ? `structure: passed ${event.report.checks.length} checks` : `structure: failed ${event.report.issues.length} issues`);
    else if (event.type === 'registered') deps.stdout(`${stamp(event.ms)} registered`);
    else if (event.type === 'preview') deps.stdout(`${stamp(event.ms)} preview: ${event.url}`);
    else if (event.type === 'sections') {
      deps.stdout(`${stamp(event.ms)} sections (${event.source}): dropped ${event.dropped.join(', ') || 'none'}; kept ${event.kept.join(', ') || 'none'}${event.skipped ? ` (jev skipped: ${event.skipped})` : ''}`);
      for (const warning of event.warnings ?? []) deps.stdout(`         sections: ${warning}`);
    }
    else if (event.type === 'effects') deps.stdout(`${stamp(event.ms)} effects: ${event.applied} planned, ${event.skipped} skipped`);
    else if (event.type === 'transport-retry') deps.stdout(`         transport-retry ${event.label}: attempt ${event.attempt} (${event.reason})`);
    else if (event.type === 'hours-normalized') deps.stdout(`         hours-normalized ${event.path}: ${JSON.stringify(event.before)} -> ${JSON.stringify(event.after)}`);
    // The fixed reason code only: `detail` is generated text and stays out of ordinary output (B-113).
    else if (event.type === 'repair-discarded') deps.stdout(`         repair-discarded ${event.label}: round ${event.round + 1} (${event.reason})`);
  };

  // Everything the build needs that depends on the family it will use, prepared here and handed
  // over ready-made: `buildSite` reads no file and validates no flag. It is a callback because the
  // family is only settled once `--family auto` has routed.
  let prepared: PreparedBuild | undefined;
  const prepare = async (family: string): Promise<PreparedBuild> => {
    const entry = values.entry ?? `${family}-r${revision}.html`;
    const packageDir = values.package ?? defaultPackageDir(family);

    const assetOverrides: Record<string, string> = {};
    for (const pair of values.asset) {
      const separator = pair.indexOf('=');
      if (separator <= 0) fail(`--asset expects id=path, received ${pair}`);
      assetOverrides[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
    // A local build directory must be new; claim it before any model or daemon call is made.
    const outDir = values['out-dir'];
    if (outDir) await mkdir(outDir).catch((error: NodeJS.ErrnoException) => fail(`--out-dir ${outDir}: ${error.code === 'EEXIST' ? 'already exists' : error.message}`));
    const pkg = await loadFamilyPackage(packageDir, family, assetOverrides);
    const spineValue = values.spine ? (JSON.parse(await readFile(values.spine, 'utf8')) as Json) : undefined;
    if (spineValue !== undefined && !isObject(spineValue)) fail('--spine must be a JSON object');
    const previousValue = values.previous ? (JSON.parse(await readFile(values.previous, 'utf8')) as Json) : undefined;
    if (previousValue !== undefined && !isObject(previousValue)) fail('--previous must be a JSON object');

    const debugDir = values['debug-dir'];
    if (debugDir) await mkdir(debugDir, { recursive: true });
    const onCall = debugDir ? createDebugDirOnCall(debugDir) : undefined;

    prepared = { pkg, entry, spine: spineValue, previousRecipe: previousValue, lockPaths: values.lock, onCall };
    return prepared;
  };

  const effectCatalog = await deps.loadEffectCatalog?.();
  let result: BuildResult;
  try {
    result = await buildSite({
      brief: readBrief,
      family: requestedFamily,
      mode: mode as FastLaneMode,
      revision,
      verify: verifyMode,
      verifyThreshold,
      routeOptions,
      // The CLI runs from source, where the package's own JSON is where its loaders expect it.
      // `buildSite` never loads it itself; see `routeBuild`.
      loadAtlas: loadAtlasData,
      provider,
      model: values.model,
      maxRepairs,
      maxRetries,
      // No project at all for a dry run: nothing is created and nothing is written.
      project: values['dry-run'] ? undefined : { daemonUrl: values.daemon, projectId: values.project, name: values.name, archive: values.archive },
      prepare,
      ...(sectionHints ? { sections: sectionHints } : {}),
      ...(effects !== undefined ? { effects } : {}),
      ...(effectCatalog ? { effectCatalog } : {}),
      onEvent,
    }, deps);
  } catch (error) {
    // The credential preflight is the one build failure with an exit code of its own: 2, the same
    // code a failed strict gate uses, since both are the fail-closed verification contract rather
    // than a generic runtime error.
    if (error instanceof JevCredentialError) throw new CliExit(2, error.message);
    throw error;
  }

  // An unrouted brief builds nothing — exit 3 (not 1: this is a routing decision, not a usage or
  // runtime error). The decision itself has already been printed by `onEvent`.
  if (result.outcome === 'unrouted') {
    if (values.report) await writeFile(values.report, `${JSON.stringify({ route: result.route }, null, 2)}\n`);
    throw new CliExit(3);
  }
  // A publish that failed and could not be rolled back has left a project on the daemon. It is a
  // build failure like any other here — exit 1 with the message on stderr, exactly as it read when
  // this was still an exception — but the message names the project a person has to deal with.
  if (result.outcome === 'rollback-failed') throw new CliExit(1, result.message);
  // The CLI passes no signal, so nothing here can cancel a build; the branch exists because
  // `BuildResult` allows the outcome for the callers that can (the daemon's build job).
  if (result.outcome === 'cancelled') throw new CliExit(1, 'the build was cancelled');

  const { report } = result;
  // `prepare` has run by the time a build reports itself built, so these are the inputs it used.
  const { pkg, entry } = prepared!;

  const outDir = values['out-dir'];
  if (outDir) {
    await writeFile(path.join(outDir, entry), report.html, { flag: 'wx' });
    await writeFile(path.join(outDir, `${entry}.artifact.json`), `${JSON.stringify(report.manifest, null, 2)}\n`, { flag: 'wx' });
    // A composed recipe is written as a project saves it: Cult blocks by public id.
    const recipe = isComposedRecipe(report.recipe) ? publicRecipe(report.recipe) : report.recipe;
    await writeFile(path.join(outDir, 'recipe.json'), `${JSON.stringify(recipe, null, 2)}\n`, { flag: 'wx' });
    for (const asset of report.approvedAssets) {
      await mkdir(path.dirname(path.join(outDir, asset.destination)), { recursive: true });
      await writeFile(path.join(outDir, asset.destination), await pkg.readAsset(asset), { flag: 'wx' });
    }
    deps.stdout(`local build: ${outDir}`);
  }

  const reportBody = buildReportBody(report, verifyMode, result.route);
  if (values.report) await writeFile(values.report, `${JSON.stringify(reportBody, null, 2)}\n`);

  printRunSummary({
    report,
    verifyMode,
    family: result.family,
    mode: mode as FastLaneMode,
    provider: result.provider,
    modelName: result.model,
    entry,
    revision,
    dryRun: values['dry-run'],
    stdout: deps.stdout,
  });
}

/**
 * Runs the CLI body against `argv` (as `process.argv.slice(2)` would give it) and returns the
 * process exit code, never calling `process.exit` itself. `deps` overrides default (real) pieces
 * of the world for a test; anything left out keeps its real default.
 */
export async function main(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const resolved: CliDeps = { ...defaultDeps, ...deps };
  try {
    await runCli(argv, resolved);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) {
      if (error.message) resolved.stderr(error.message);
      return error.code;
    }
    // A failed zsvault read (see vaultSecret in deepseek.ts) is sanitized at the source, but any
    // other escaping error could still carry sensitive detail as a non-enumerable-unsafe property
    // (or simply be long/noisy). Node's default uncaught-error printing inspects the whole error
    // object; cutting this down to the message only keeps that from happening here.
    resolved.stderr(error instanceof Error ? error.message : String(error));
    // `ProviderHttpError`/`DaemonHttpError` keep the response body off `.message` on purpose — see
    // both classes' docblocks — so a CLI user who needs it back gets it here, printed after the
    // status-only message rather than folded into it, and nowhere a machine reading `.message`
    // alone (a persisted build snapshot, `buildFailureMessage`) would ever see it.
    if ((error instanceof ProviderHttpError || error instanceof DaemonHttpError) && error.detail) {
      resolved.stderr(error.detail);
    }
    return 1;
  }
}

function isBinEntry(): boolean {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isBinEntry()) {
  installFatalHandlers();
  const code = await main(process.argv.slice(2));
  requestNormalExit(code);
}
