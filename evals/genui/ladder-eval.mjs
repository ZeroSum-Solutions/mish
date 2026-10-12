#!/usr/bin/env node
/**
 * ladder-eval.mjs — criterion C14: the genui build ladder.
 *
 * Drives the LIVE daemon's `POST /api/agency/build` (`family: 'auto'`, so every build is routed
 * against the Website Shape Atlas — the point of the ladder is to see which of the nine spines
 * (`TL`, `PA`, `CO`, `SM`, `CS`, `LM`, `BA`, `TU`, `MI` — `packages/agency-fast-lane/src/atlas/
 * shape-atlas.json`) a fixed brief set routes to, and how latency holds up as batch size grows)
 * through sequential batches of increasing size ("rungs": 1, 2, 5, 20 builds by default) for each
 * provider in turn (`deepseek` then `cerebras`). The daemon accepts exactly one build at a time —
 * a second concurrent `POST /api/agency/build` answers `409 BUILD_BUSY` — so "batch of N" here
 * means N builds run one after another, not N in flight; the rung size only changes how many
 * builds are grouped into one reported step, not the concurrency (there is none).
 *
 * API surface (`apps/daemon/src/routes/agency-build.ts`, contract in
 * `packages/contracts/src/api/agency-build.ts`), as read directly from the daemon source on
 * 2026-09-23:
 *
 *   POST /api/agency/build
 *     body: { brief, family?: 'auto'|<id>, mode?: 'single'|'sections', verify?: 'strict'|
 *            'advisory'|'after'|'off', projectId?, projectName?, provider?: 'deepseek'|'cerebras',
 *            model? }
 *     -> 202 { build: AgencyBuildSnapshot }  (snapshot.status starts 'queued')
 *     -> 409 BUILD_BUSY { error: { code, message, details: { kind: 'agency-build-busy',
 *            activeId } } }  when another build is already running on this daemon
 *
 *   GET /api/agency/builds/:id
 *     -> 200 { build: AgencyBuildSnapshot }   — the polling shape; used here only as a fallback
 *            if the SSE stream drops, since SSE already carries the same terminal snapshot.
 *
 *   GET /api/agency/builds/:id/events        (SSE; `Accept: text/event-stream`)
 *     frames: `event: build-event\ndata: <AgencyBuildEvent>` for every progress event (route,
 *     project, unit, verify, preview, ...), then one final `event: status\ndata:
 *     <AgencyBuildSnapshot>` carrying the terminal snapshot. This is what this harness reads to
 *     completion, exactly like the bake-off harness below.
 *
 *   AgencyBuildStatus (terminal): 'done' | 'unrouted' | 'failed' | 'cancelled'.
 *   AgencyBuildRouteDecision (on the terminal snapshot's `.route`, `family: 'auto'` only):
 *     { decision: 'routed'|'unrouted', family?, probability?, spine?, pageKind? }. `spine` is the
 *     TOP spine answer. The spine the winning family was admitted from (`viaSpine`) can differ
 *     (a same-spine family admitted through a second spine above `spineShare`); this harness reads
 *     `route.viaSpine` when the daemon reports it and records null otherwise. A BUILD_FAILED
 *     snapshot can lack `route` altogether, so its spine is unknown, not "unrouted".
 *   AgencyBuildVerifyVerdict (on `.verify`, `verify: 'after'` builds only — otherwise verify
 *     counts, if any, come from the `verify` build-event's `.counts`):
 *     { status: 'pending'|'done'|'skipped', flagged: string[], ms? }.
 *
 * Daemon-call helpers (`daemonFetch`, `readBuildToCompletion`, local-origin handling) follow the
 * bake-off harness whose run is recorded in `docs/evals/2026-09-22-genui-bakeoff.md`. The daemon
 * is single-flight, so each rung is a strictly sequential run of N builds — no pool needed.
 *
 * Every route above requires a local-origin request (`requireLocalOrigin` in
 * `apps/daemon/src/origin-validation.ts`) — sending `Origin: <daemon origin>` satisfies it the
 * same way a same-origin browser request would, exactly as the bake-off harness does.
 *
 * Usage:
 *   node ladder-eval.mjs --daemon http://127.0.0.1:7456 --briefs ./briefs --out ./out \
 *     [--providers deepseek,cerebras] [--rungs 1,2,5,20] [--verify strict] [--mode sections] \
 *     [--dry-run]
 *
 * Briefs dir: `ladder-NN.txt` (plain-text brief body) with a REQUIRED sidecar `ladder-NN.json`
 * (`{ "expectedSpine": "TL" }`, one of the nine spine codes). A brief without a valid sidecar is
 * a usage error: an ungraded brief cannot count toward the routing check. Files are read once,
 * sorted by NN, and cycled (round-robin) to fill however many builds a rung needs.
 *
 * PASS requires (second-model ruling, 2026-09-24):
 *   - every provider in `--providers` produced rows (a listed provider with none fails);
 *   - zero failed builds. An unrouted build is a failed build (`failureClass: 'unrouted'`), never
 *     a skipped one, and a `done` build whose record carries no route at all is
 *     `unrouted-record`. Every failure is classified: unrouted / unrouted-record / BUILD_FAILED /
 *     VERIFY_FAILED / other;
 *   - the per-provider p50 limits (p50 and p95 are reported per provider);
 *   - every one of the nine spines expected by at least one brief;
 *   - every build with a known spine graded on `viaSpine ?? routedSpine` equal to its brief's
 *     expectedSpine (mismatches listed, both spines reported);
 *   - nine-spine coverage PER PROVIDER: each spine has at least one `ok`, correctly graded build
 *     on every provider that ran (gaps listed per provider).
 *
 * Output: `results.json` (every build's row + per-provider stats + the PASS/FAIL verdict) and
 * `REPORT.md` (the human-readable form of the same). Exit 0 on PASS, 1 on FAIL, 2 on usage error.
 *
 * The pure parts (`loadBriefs`, `grade`, `outcomeFromSnapshot`, `classifyFailure`, `gradedSpine`,
 * `summarizeProvider`, `countFailures`) are exported for `ladder-eval.test.mjs`; the CLI runs
 * only when this file is the entry point.
 *
 * Node built-ins only — no dependencies, per the eval harness convention this repo already uses.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** A brief-set problem the caller must fix; the CLI maps it to exit 2. */
export class BriefSetError extends Error {}

// ---- CLI args --------------------------------------------------------------

function usageError(msg) {
  console.error(`error: ${msg}`);
  console.error(`
Usage:
  node ladder-eval.mjs --daemon <url> --briefs <dir> --out <dir>
    [--providers deepseek,cerebras] [--rungs 1,2,5,20] [--verify strict|advisory|after|off]
    [--mode single|sections] [--dry-run]
`);
  process.exit(2);
}

let DAEMON;
let ORIGIN;
let BRIEFS_DIR;
let OUT_DIR;
let PROVIDERS;
let RUNGS;
let VERIFY;
let MODE;
let DRY_RUN;

function configure() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        daemon: { type: 'string' },
        briefs: { type: 'string' },
        out: { type: 'string' },
        providers: { type: 'string', default: 'deepseek,cerebras' },
        rungs: { type: 'string', default: '1,2,5,20' },
        verify: { type: 'string' },
        mode: { type: 'string', default: 'sections' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    usageError(String(e.message || e));
  }

  if (values.help) {
    console.log(`Usage:
  node ladder-eval.mjs --daemon <url> --briefs <dir> --out <dir>
    [--providers deepseek,cerebras] [--rungs 1,2,5,20] [--verify strict|advisory|after|off]
    [--mode single|sections] [--dry-run]`);
    process.exit(0);
  }

  if (!values.daemon) usageError('--daemon <url> is required');
  if (!values.briefs) usageError('--briefs <dir> is required');
  if (!values.out) usageError('--out <dir> is required');

  DAEMON = values.daemon.replace(/\/$/, '');
  try {
    ORIGIN = new URL(DAEMON).origin;
  } catch {
    usageError(`--daemon is not a valid URL: ${values.daemon}`);
  }
  BRIEFS_DIR = path.resolve(values.briefs);
  OUT_DIR = path.resolve(values.out);
  PROVIDERS = values.providers.split(',').map((s) => s.trim()).filter(Boolean);
  RUNGS = values.rungs.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  VERIFY = values.verify; // undefined -> daemon default ('strict')
  MODE = values.mode;
  DRY_RUN = values['dry-run'];

  if (PROVIDERS.length === 0) usageError('--providers must name at least one provider');
  if (!PROVIDERS.every((p) => p === 'deepseek' || p === 'cerebras')) usageError(`--providers must be deepseek and/or cerebras, got: ${values.providers}`);
  if (RUNGS.length === 0) usageError('--rungs must name at least one positive integer batch size');
  if (VERIFY !== undefined && !['strict', 'advisory', 'after', 'off'].includes(VERIFY)) usageError(`--verify must be one of strict, advisory, after, off, got: ${VERIFY}`);
  if (MODE !== 'single' && MODE !== 'sections') usageError(`--mode must be single or sections, got: ${MODE}`);
  if (!existsSync(BRIEFS_DIR)) usageError(`--briefs directory does not exist: ${BRIEFS_DIR}`);
}

// The atlas's own nine spine codes (`packages/agency-fast-lane/src/atlas/shape-atlas.json`, read
// 2026-09-23). Fixed here rather than re-read from the atlas file at run time: the ladder brief
// set is meant to target this fixed roster, and a harness that quietly re-derived a shrunk or
// grown list from a future atlas edit would silently change what "all nine spines" means without
// anyone deciding that on purpose.
const NINE_SPINES = ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'];

// The bar this eval is graded against (task spec, criterion C14).
const PASS_BAR = {
  zeroFailed: true,
  cerebrasP50Ms: 4000,
  deepseekP50Ms: 6000,
  allNineSpines: true,
  spinesMatched: true,
  perProviderCoverage: true,
};

/**
 * The failure classes a summary counts, in report order. `unrouted-record` is a `done` build
 * whose record carries no route at all (no top spine, no admitted spine): it cannot be graded, so
 * it fails instead of passing as "no mismatch".
 */
export const FAILURE_CLASSES = ['unrouted', 'unrouted-record', 'BUILD_FAILED', 'VERIFY_FAILED', 'other'];

/**
 * Pure: why a finished build row failed, or null when it passed. An unrouted build (status or
 * route decision) is a failure of its own class; a done build with no route information is
 * `unrouted-record`; the daemon's error code names the rest. A dry-run row (`status: 'skipped'`)
 * attempted nothing and is never a failure.
 */
export function classifyFailure(row) {
  if (row.status === 'skipped') return null;
  if (row.ok) return row.routedSpine == null && row.viaSpine == null ? 'unrouted-record' : null;
  if (row.status === 'unrouted' || row.routeDecision === 'unrouted') return 'unrouted';
  if (row.errorClass === 'BUILD_FAILED' || row.errorClass === 'VERIFY_FAILED') return row.errorClass;
  return 'other';
}

/** Pure: the spine a row is graded on — the winning family's admitted spine, else the top one. */
export function gradedSpine(row) {
  return row.viaSpine ?? row.routedSpine ?? null;
}

/**
 * Pure: the row fields read from a build's terminal snapshot. `ok` needs status `done` AND a
 * route with a spine; an unrouted build is `ok: false` with `failureClass: 'unrouted'`, and a done
 * build whose record lost its route is `ok: false` with `failureClass: 'unrouted-record'`.
 */
export function outcomeFromSnapshot(snapshot) {
  const out = {
    status: snapshot.status,
    routedFamily: snapshot.family ?? snapshot.route?.family ?? null,
    routedSpine: snapshot.route?.spine ?? null,
    viaSpine: snapshot.route?.viaSpine ?? null,
    routeDecision: snapshot.route?.decision ?? null,
    ...(snapshot.error ? { errorClass: snapshot.error.code } : {}),
    ok: snapshot.status === 'done',
  };
  out.failureClass = classifyFailure(out);
  if (out.failureClass !== null) out.ok = false;
  return out;
}

/** Pure: whether a row counts as failed (not ok, or ok but unroutable on the record). */
function isFailed(row) {
  return (row.failureClass ?? classifyFailure(row)) !== null;
}

/** Pure: failure counts by class (every class present, 0 when none). */
export function countFailures(rows) {
  const counts = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0]));
  for (const r of rows) {
    const c = r.failureClass ?? classifyFailure(r);
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}

// ---- Briefs -----------------------------------------------------------------

/**
 * Loads `ladder-NN.txt` + sidecar `ladder-NN.json` (`{ expectedSpine }`) pairs from the briefs
 * dir, sorted by NN ascending. Every brief needs a readable sidecar whose `expectedSpine` is one of
 * the nine spine codes; otherwise this throws `BriefSetError` naming every bad brief, because an
 * ungraded brief would let the routing check pass without being checked.
 */
export function loadBriefs(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^ladder-\d+\.txt$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (files.length === 0) throw new BriefSetError(`no ladder-NN.txt briefs found under ${dir}`);

  const problems = [];
  const briefs = files.map((file) => {
    const n = file.match(/\d+/)[0];
    const id = `ladder-${n}`;
    const txtPath = path.join(dir, file);
    const jsonPath = path.join(dir, `${id}.json`);
    const brief = readFileSync(txtPath, 'utf8');
    let expectedSpine = null;
    if (!existsSync(jsonPath)) {
      problems.push(`${file}: no sidecar ${path.basename(jsonPath)}`);
    } else {
      try {
        const sidecar = JSON.parse(readFileSync(jsonPath, 'utf8'));
        if (typeof sidecar.expectedSpine === 'string' && NINE_SPINES.includes(sidecar.expectedSpine)) {
          expectedSpine = sidecar.expectedSpine;
        } else {
          problems.push(`${path.basename(jsonPath)}: expectedSpine must be one of ${NINE_SPINES.join(', ')}`);
        }
      } catch (e) {
        problems.push(`${path.basename(jsonPath)}: not valid JSON (${String(e.message || e)})`);
      }
    }
    return { id, file, txtPath, brief, expectedSpine };
  });
  if (problems.length > 0) throw new BriefSetError(`invalid brief set under ${dir}:\n  ${problems.join('\n  ')}`);
  return briefs;
}

/**
 * Pure: the PASS/FAIL verdict for a finished (non-dry) run.
 *
 * - `zeroFailed`: every build reached `done` with a route (unrouted and unrouted-record count as
 *   failed).
 * - `allProvidersRan`: every provider in `providers` produced at least one row. A listed provider
 *   with no rows is a failure, never a vacuous pass.
 * - `cerebrasP50` / `deepseekP50`: that provider's p50 is under its bar (null when not run).
 * - `allNineSpines`: every one of the nine spines is some brief's expectedSpine AND at least one
 *   build of such a brief ran.
 * - `spinesMatched`: every build whose spine is known is graded on `viaSpine ?? routedSpine` and
 *   equals its brief's expectedSpine. A build with no known spine (unrouted, or failed before the
 *   route was kept) is not a mismatch: it already fails `zeroFailed` under its failure class.
 * - `perProviderCoverage`: for every provider listed OR seen in the rows, each of the nine spines
 *   has at least one `ok` build whose graded spine is that spine and matches the expectedSpine.
 * `overall` needs every applicable check true.
 */
export function grade({ rows, briefs, providers }) {
  // Every listed provider and every provider that actually produced rows is graded.
  const graded = [...new Set([...providers, ...rows.map((r) => r.provider).filter(Boolean)])];
  const perProvider = {};
  for (const provider of graded) perProvider[provider] = summarizeProvider(rows.filter((r) => r.provider === provider));
  const providersWithoutRows = providers.filter((provider) => perProvider[provider].n === 0);

  const expectedSpines = [...new Set(briefs.map((b) => b.expectedSpine).filter(Boolean))].sort();
  const exercised = new Set(rows.map((r) => r.expectedSpine).filter(Boolean));
  const missingSpines = NINE_SPINES.filter((s) => !expectedSpines.includes(s) || !exercised.has(s));
  const mismatches = rows
    .filter((r) => gradedSpine(r) !== null && gradedSpine(r) !== r.expectedSpine)
    .map((r) => ({ seq: r.seq, provider: r.provider, briefId: r.briefId, expectedSpine: r.expectedSpine, routedSpine: r.routedSpine ?? null, viaSpine: r.viaSpine ?? null }));
  const spinesCoveredOverall = [...new Set(rows.map(gradedSpine).filter(Boolean))].sort();
  const totalFailed = rows.filter(isFailed).length;
  const failures = countFailures(rows);
  const coverage = {};
  const coverageGaps = [];
  for (const provider of graded) {
    coverage[provider] = perProvider[provider].coverage;
    for (const spine of NINE_SPINES) if (coverage[provider][spine] === 0) coverageGaps.push({ provider, spine });
  }

  const pass = {
    zeroFailed: totalFailed === 0,
    allProvidersRan: providers.length > 0 && providersWithoutRows.length === 0,
    cerebrasP50: providers.includes('cerebras') ? typeof perProvider.cerebras.p50 === 'number' && perProvider.cerebras.p50 < PASS_BAR.cerebrasP50Ms : null,
    deepseekP50: providers.includes('deepseek') ? typeof perProvider.deepseek.p50 === 'number' && perProvider.deepseek.p50 < PASS_BAR.deepseekP50Ms : null,
    allNineSpines: missingSpines.length === 0,
    spinesMatched: rows.length > 0 && mismatches.length === 0,
    perProviderCoverage: graded.length > 0 && coverageGaps.length === 0,
  };
  // A `--providers deepseek` run is not penalised for cerebras never having been asked to build.
  pass.overall = Object.values(pass).every((c) => c === null || c === true);
  return { perProvider, providersWithoutRows, spinesCoveredOverall, missingSpines, mismatches, totalFailed, failures, coverage, coverageGaps, pass };
}

// ---- Daemon calls (as in the bake-off harness; see docs/evals) ---------------

/** Every route in `apps/daemon/src/routes/agency-build.ts` requires a local-origin request —
 * `requireLocalOrigin` reads `Origin`/`Host`; sending `Origin` as the daemon's own origin
 * satisfies `isLocalSameOrigin` the same way a same-origin browser request would. */
function daemonFetch(pathname, opts = {}) {
  return fetch(new URL(pathname, DAEMON), {
    ...opts,
    headers: { Origin: ORIGIN, ...(opts.headers ?? {}) },
  });
}

async function startBuild({ brief, provider, projectName }) {
  const body = {
    brief,
    family: 'auto',
    mode: MODE,
    projectName,
    provider,
    ...(VERIFY !== undefined ? { verify: VERIFY } : {}),
  };
  const res = await daemonFetch('/api/agency/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (res.status !== 202) {
    const code = json?.error?.code ?? `HTTP_${res.status}`;
    const message = json?.error?.message ?? `POST /api/agency/build -> ${res.status}`;
    throw Object.assign(new Error(message), { errorClass: code });
  }
  return json.build.id;
}

/**
 * Reads the build's SSE stream (`GET /api/agency/builds/:id/events`) to completion: every
 * `build-event` frame (recorded via `onEvent`) and the terminal `status` frame, whose payload IS
 * the build's final `AgencyBuildSnapshot`. Frames are `id: <n>\nevent: <name>\ndata: <json>\n\n`;
 * this is a plain line reader over the fetch body (node:built-ins only), not an SSE client
 * library, the same reader the bake-off harness used.
 */
async function readBuildToCompletion(buildId, onEvent) {
  const res = await daemonFetch(`/api/agency/builds/${buildId}/events`, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`GET /api/agency/builds/${buildId}/events -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let statusSnapshot;
  readLoop: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let eventName = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
      }
      if (dataLines.length === 0) continue;
      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      if (eventName === 'build-event') onEvent(data);
      else if (eventName === 'status') {
        statusSnapshot = data;
        break readLoop;
      }
    }
  }
  try {
    reader.cancel();
  } catch {
    // Stream already ended on the terminal frame; cancelling a done reader is a no-op.
  }
  if (!statusSnapshot) throw new Error('the event stream ended before a terminal status frame arrived');
  return statusSnapshot;
}

/**
 * Fallback poll (`GET /api/agency/builds/:id`) for the rare case the SSE stream drops before the
 * terminal frame arrives without throwing (a closed-but-not-done body). Not the primary path —
 * SSE already carries the terminal snapshot — but the daemon API investigation this harness is
 * built on names polling explicitly, so it is wired in as the fallback rather than left unused.
 */
async function pollUntilTerminal(buildId, { intervalMs = 500, timeoutMs = 120_000 } = {}) {
  const TERMINAL = new Set(['done', 'unrouted', 'failed', 'cancelled']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await daemonFetch(`/api/agency/builds/${buildId}`);
    if (res.ok) {
      const json = await res.json();
      if (TERMINAL.has(json.build?.status)) return json.build;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`build ${buildId} did not reach a terminal status within ${timeoutMs}ms of polling`);
}

// ---- One build ----------------------------------------------------------------

async function runOneBuild({ provider, rung, seq, brief }) {
  const row = {
    seq,
    provider,
    rung,
    briefId: brief.id,
    briefFile: brief.file,
    expectedSpine: brief.expectedSpine,
  };
  const t0 = Date.now();
  if (DRY_RUN) {
    row.dryRun = true;
    row.wallMs = 0;
    row.status = 'skipped';
    // Dry-run rows are neither pass nor fail (nothing was attempted) — `ok: true` here only
    // keeps the plan-summary table from reading as "every build failed"; `summarizeProvider`'s
    // failed count is meaningless in dry-run mode regardless, since `pass.*` is null throughout.
    row.ok = true;
    console.log(`[dry] ${provider} rung=${rung} seq=${seq} brief=${brief.id} expectedSpine=${brief.expectedSpine ?? '?'}`);
    return row;
  }
  try {
    const projectName = `ladder-eval-${provider}-r${rung}-${brief.id}-${t0}`;
    const buildId = await startBuild({ brief: brief.brief, provider, projectName });
    row.buildId = buildId;

    let verifyEventCounts;
    let snapshot;
    try {
      snapshot = await readBuildToCompletion(buildId, (event) => {
        if (event.type === 'verify' && event.counts) verifyEventCounts = event.counts;
      });
    } catch (sseErr) {
      // SSE dropped before the terminal frame — fall back to polling rather than losing the row.
      console.warn(`[warn] ${provider}/${brief.id}: SSE read failed (${String(sseErr.message || sseErr)}); falling back to polling`);
      snapshot = await pollUntilTerminal(buildId);
    }

    row.wallMs = Date.now() - t0;
    Object.assign(row, outcomeFromSnapshot(snapshot));
    // The terminal snapshot never carries the model id back — it is a deliberately sanitised DTO
    // (see the doc comment atop `packages/contracts/src/api/agency-build.ts`). `provider` (which
    // this harness DID choose) is recorded on the row already; `model` stays whatever the daemon
    // defaulted to for that provider/family pair and is not observable from this API.
    row.verify = snapshot.verify ?? null;
    row.verifyEventCounts = verifyEventCounts ?? null;
  } catch (err) {
    row.wallMs = Date.now() - t0;
    row.status = 'error';
    row.ok = false;
    row.errorClass = err.errorClass ?? 'HARNESS_ERROR';
    row.errorMessage = String(err.message || err).slice(0, 500);
    row.failureClass = classifyFailure(row);
  }
  console.log(
    `${row.ok ? 'ok ' : row.status === 'unrouted' ? 'UNR' : 'ERR'} ${provider.padEnd(9)} rung=${String(rung).padStart(2)} seq=${String(seq).padStart(2)} ` +
      `${brief.id.padEnd(10)} expected=${String(brief.expectedSpine ?? '?').padEnd(3)} routed=${String(row.routedSpine ?? '-').padEnd(3)} via=${String(row.viaSpine ?? '-').padEnd(3)} ` +
      `status=${String(row.status).padEnd(9)} ${row.wallMs}ms ${row.failureClass ?? ''}${row.errorClass && row.errorClass !== row.failureClass ? ` ${row.errorClass}` : ''}`,
  );
  return row;
}

// ---- Stats --------------------------------------------------------------------

/** Nearest-rank (lower) quantile, not interpolated: index floor(p × (n − 1)) of the sorted times. */
function quantile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.floor(p * (sortedMs.length - 1)));
  return sortedMs[idx];
}

/** Pure: one provider's (or rung's) counts, latency, failure classes and spine coverage. */
export function summarizeProvider(rows) {
  const wallMs = rows.map((r) => r.wallMs).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const failed = rows.filter(isFailed);
  const spinesCovered = [...new Set(rows.map(gradedSpine).filter(Boolean))].sort();
  // Coverage: ok builds per spine that were graded correctly (graded spine = expected spine).
  const coverage = Object.fromEntries(NINE_SPINES.map((spine) => [spine, 0]));
  for (const r of rows) if (!isFailed(r) && r.ok && r.expectedSpine && gradedSpine(r) === r.expectedSpine) coverage[r.expectedSpine] += 1;
  return {
    n: rows.length,
    ok: rows.length - failed.length,
    failed: failed.length,
    failures: countFailures(rows),
    p50: quantile(wallMs, 0.5),
    p95: quantile(wallMs, 0.95),
    spinesCovered,
    coverage,
  };
}

// ---- Main -----------------------------------------------------------------

async function main() {
  configure();
  let briefs;
  try {
    briefs = loadBriefs(BRIEFS_DIR);
  } catch (e) {
    if (e instanceof BriefSetError) usageError(e.message);
    throw e;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    `ladder-eval: daemon=${DAEMON} briefs=${briefs.length} providers=${PROVIDERS.join(',')} rungs=${RUNGS.join(',')} ` +
      `mode=${MODE} verify=${VERIFY ?? '(daemon default: strict)'}${DRY_RUN ? ' [dry-run]' : ''}`,
  );

  const rows = [];
  let briefCursor = 0;
  let seq = 0;
  for (const provider of PROVIDERS) {
    for (const rung of RUNGS) {
      console.log(`\n-- ${provider} rung ${rung} (${rung} build${rung === 1 ? '' : 's'}, sequential) --`);
      for (let i = 0; i < rung; i++) {
        const brief = briefs[briefCursor % briefs.length];
        briefCursor++;
        seq++;
        // Sequential by construction: the daemon holds one build at a time (a second concurrent
        // POST answers 409 BUILD_BUSY), so this loop never overlaps two builds even though it
        // could technically fire the next POST before awaiting the previous build's completion.
        const row = await runOneBuild({ provider, rung, seq, brief });
        rows.push(row);
      }
    }
  }

  const graded = grade({ rows, briefs, providers: PROVIDERS });
  const { perProvider, providersWithoutRows, spinesCoveredOverall, missingSpines, mismatches, totalFailed, failures, coverage, coverageGaps } = graded;
  const pass = DRY_RUN
    ? { zeroFailed: null, allProvidersRan: null, cerebrasP50: null, deepseekP50: null, allNineSpines: null, spinesMatched: null, perProviderCoverage: null, overall: null }
    : graded.pass;

  const results = {
    generatedAt: new Date().toISOString(),
    daemon: DAEMON,
    briefsDir: BRIEFS_DIR,
    providers: PROVIDERS,
    rungs: RUNGS,
    mode: MODE,
    verify: VERIFY ?? 'strict (daemon default)',
    dryRun: DRY_RUN,
    briefCount: briefs.length,
    buildCount: rows.length,
    passBar: PASS_BAR,
    perProvider,
    spinesCoveredOverall,
    missingSpines,
    mismatches: DRY_RUN ? [] : mismatches,
    failures: DRY_RUN ? null : failures,
    coverage: DRY_RUN ? null : coverage,
    coverageGaps: DRY_RUN ? [] : coverageGaps,
    pass,
    rows,
  };
  writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

  // ---- REPORT.md -----------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  let md = `# Genui ladder eval — ${today}\n\n`;
  md += `Daemon: \`${DAEMON}\`. ${rows.length} build(s) across ${PROVIDERS.join(', ')}, rungs [${RUNGS.join(', ')}]`;
  md += DRY_RUN ? ' (**dry-run — nothing was sent to the daemon**).\n\n' : `, mode \`${MODE}\`, verify \`${VERIFY ?? 'strict (daemon default)'}\`.\n\n`;
  md += `Every build used \`family: 'auto'\` (routed against the Website Shape Atlas). The daemon holds one build at a time, so every rung ran strictly sequentially regardless of its batch size — batch size only changes how many builds are grouped into one reported step.\n\n`;

  md += `## Per-provider summary\n\n`;
  md += `| Provider | n | ok | failed | ${FAILURE_CLASSES.join(' | ')} | p50 (ms) | p95 (ms) | spines covered |\n|${'---|'.repeat(8 + FAILURE_CLASSES.length)}\n`;
  for (const provider of PROVIDERS) {
    const s = perProvider[provider];
    md += `| ${provider} | ${s.n} | ${s.ok} | ${s.failed} | ${FAILURE_CLASSES.map((c) => s.failures[c]).join(' | ')} | ${s.p50 ?? '-'} | ${s.p95 ?? '-'} | ${s.spinesCovered.join(', ') || '-'} |\n`;
  }

  if (!DRY_RUN) {
    md += `\n## Failures by class\n\n| Class | Builds |\n|---|---|\n`;
    for (const c of FAILURE_CLASSES) md += `| ${c} | ${failures[c]} |\n`;
    md += `| **total** | **${totalFailed}** |\n`;
  }

  md += `\n## Spine coverage\n\nAll nine spines: ${NINE_SPINES.join(', ')}. A build is graded on the spine its winning family was admitted from (\`viaSpine\`) when the daemon reports it, else on the top spine (\`routedSpine\`).\n\nCovered by graded results: ${spinesCoveredOverall.join(', ') || '(none)'}.\n`;
  if (missingSpines.length) md += `Not expected by any brief that ran: ${missingSpines.join(', ')}.\n`;
  if (!DRY_RUN) {
    md += `\n### Per provider (ok builds graded to the expected spine)\n\n| Provider | ${NINE_SPINES.join(' | ')} |\n|${'---|'.repeat(NINE_SPINES.length + 1)}\n`;
    for (const provider of PROVIDERS) md += `| ${provider} | ${NINE_SPINES.map((spine) => (coverage[provider][spine] === 0 ? '**0**' : coverage[provider][spine])).join(' | ')} |\n`;
    if (coverageGaps.length) md += `\nCoverage gaps: ${coverageGaps.map((g) => `${g.provider}/${g.spine}`).join(', ')}.\n`;
  }
  if (!DRY_RUN && mismatches.length) {
    md += `\n### Graded spine differs from expectedSpine\n\n| seq | provider | brief | expected | routed (top) | via (admitted) |\n|---|---|---|---|---|---|\n`;
    for (const m of mismatches) md += `| ${m.seq} | ${m.provider} | ${m.briefId} | ${m.expectedSpine} | ${m.routedSpine ?? '-'} | ${m.viaSpine ?? '-'} |\n`;
  }

  md += `\n## PASS/FAIL\n\n`;
  if (DRY_RUN) {
    md += `Dry run — no PASS/FAIL verdict (nothing was sent to the daemon).\n`;
  } else {
    const line = (label, ok, detail) => `- ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}\n`;
    md += line('every listed provider produced builds', pass.allProvidersRan, providersWithoutRows.length ? `no rows from ${providersWithoutRows.join(', ')}` : 'all ran');
    md += line('zero failed builds (unrouted and unrouted-record count as failed)', pass.zeroFailed, `${totalFailed} failed of ${rows.length}: ${FAILURE_CLASSES.map((c) => `${c} ${failures[c]}`).join(', ')}`);
    if (PROVIDERS.includes('cerebras')) md += line(`cerebras p50 < ${PASS_BAR.cerebrasP50Ms}ms`, pass.cerebrasP50, `p50 = ${perProvider.cerebras?.p50 ?? '-'}ms`);
    if (PROVIDERS.includes('deepseek')) md += line(`deepseek p50 < ${PASS_BAR.deepseekP50Ms}ms`, pass.deepseekP50, `p50 = ${perProvider.deepseek?.p50 ?? '-'}ms`);
    md += line('all nine spines expected by the briefs that ran', pass.allNineSpines, missingSpines.length ? `missing ${missingSpines.join(', ')}` : 'all present');
    md += line('every graded spine (viaSpine ?? routedSpine) matches its expectedSpine', pass.spinesMatched, `${mismatches.length} mismatch(es)`);
    md += line('each of the nine spines has an ok build on every provider', pass.perProviderCoverage, coverageGaps.length ? `gaps ${coverageGaps.map((g) => `${g.provider}/${g.spine}`).join(', ')}` : 'no gaps');
    md += `\n**Overall: ${pass.overall ? 'PASS' : 'FAIL'}**\n`;
  }

  md += `\n## Per-rung detail\n\n`;
  md += `| Provider | Rung | n | ok | failed | p50 (ms) | p95 (ms) |\n|---|---|---|---|---|---|---|\n`;
  for (const provider of PROVIDERS) {
    for (const rung of RUNGS) {
      const rungRows = rows.filter((r) => r.provider === provider && r.rung === rung);
      const s = summarizeProvider(rungRows);
      md += `| ${provider} | ${rung} | ${s.n} | ${s.ok} | ${s.failed} | ${s.p50 ?? '-'} | ${s.p95 ?? '-'} |\n`;
    }
  }

  md += `\n## Every build\n\n`;
  md += `| seq | provider | rung | brief | expected spine | routed spine (top) | via spine (admitted) | routed family | status | wall ms | failure | error |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    md += `| ${r.seq} | ${r.provider} | ${r.rung} | ${r.briefId} | ${r.expectedSpine ?? '-'} | ${r.routedSpine ?? '-'} | ${r.viaSpine ?? '-'} | ${r.routedFamily ?? '-'} | ${r.status} | ${r.wallMs ?? '-'} | ${r.failureClass ?? ''} | ${r.errorClass ?? ''}${r.errorMessage ? ` ${r.errorMessage}` : ''} |\n`;
  }

  writeFileSync(path.join(OUT_DIR, 'REPORT.md'), md);
  console.log(`\nWrote ${path.join(OUT_DIR, 'results.json')} and ${path.join(OUT_DIR, 'REPORT.md')}.`);

  if (DRY_RUN) {
    console.log('[dry] exiting 0 (dry-run never produces a PASS/FAIL verdict).');
    process.exit(0);
  }
  console.log(`\nFailures: ${FAILURE_CLASSES.map((c) => `${c} ${failures[c]}`).join(', ')}; coverage gaps: ${coverageGaps.length ? coverageGaps.map((g) => `${g.provider}/${g.spine}`).join(', ') : 'none'}`);
  console.log(`Overall: ${pass.overall ? 'PASS' : 'FAIL'}`);
  process.exit(pass.overall ? 0 : 1);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
