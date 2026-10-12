// C10 eval: the faithfulness gate's false-positive rate once `x-mock` sample-data slots are
// excluded, on ten fixed briefs per application page kind.
//
// Live mode drives a running daemon's build path one build at a time, in `strict` verify mode by
// default (the gate repairs what it flags and publishes nothing it cannot clear; a build it stops
// ends VERIFY_FAILED). It records per build the `verify` event counts (`checked` = fact slots,
// `illustrative` = skipped x-mock slots, `flagged`, `remaining`), the error code, and the caption
// evidence: it fetches the published recipe and HTML and checks that every x-mock slot the gate
// skipped sits in a section with a visible `data-od-mock="caption"`. `--verify after` (the Route
// panel's path: publish first, check later, no repair) is kept for diagnosis only: it records the
// flagged paths and their text, but it can never pass C10, and the script says so. It spends model
// credit: run it only on purpose, after the daemon was rebuilt from this branch.
//
// `--rescore <dir|rows.json>` spends nothing: it re-scores saved bake-off reports
// (`report-*.json` rows from `6-bakeoff.mjs`, which predate `illustrative`) by removing every
// x-mock path from their `checked` count and their flagged list. It is a pre-check, not the proof.
//
// The pass rule lives in xmock-score.mjs: per kind, 10/10 builds `done`, flagged rate below 5 %,
// no x-mock path flagged, and zero unlabelled fabricated claims (no flagged or remaining fact slot,
// no VERIFY_FAILED build, every skipped x-mock slot captioned). A live run passes only in `strict`
// mode. Exit 0 on pass, 1 when the run fails, 2 on a usage error.
//
// Usage:
//   node evals/genui/7-xmock-eval.mjs [--briefs evals/genui/briefs/faithfulness] [--verify strict|after]
//     [--model cerebras/gpt-oss-120b] [--daemon http://127.0.0.1:57830] [--out result.json] [--dry]
//   node evals/genui/7-xmock-eval.mjs --rescore <dir-with-report-*.json | rows.json> [--model <id>] [--out result.json]
//
// Needs Node 24 (it imports the fast lane's TypeScript `spine.ts` directly for `mockPathsFor`).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_VERIFY_MODE, KINDS, REQUIRED_BUILDS, VERIFY_MODES, captionEvidence, familyFacts, liveBuildOutcome, overallPass, publishedEntry, recipeMockPaths, rescoreRow, summarize, summarizeKinds } from './xmock-score.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const BRIEFS_PER_KIND = REQUIRED_BUILDS;
const VERIFY_POLL_MS = 500;
const VERIFY_POLL_TIMEOUT_MS = 90_000;

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: node evals/genui/7-xmock-eval.mjs [--briefs <dir>] [--verify strict|after] [--model provider/model] [--daemon <url>] [--out <file>] [--dry]');
  console.error('       node evals/genui/7-xmock-eval.mjs --rescore <dir|rows.json> [--model <id>] [--out <file>]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Family schema and mock paths
// ---------------------------------------------------------------------------

function loadFamily(kind) {
  const pkgDir = path.join(REPO, 'plugins/_official/examples', `agency-${kind}`);
  return {
    schema: JSON.parse(readFileSync(path.join(pkgDir, 'compiler/scripts/families', kind, 'recipe.schema.json'), 'utf8')),
    fixture: JSON.parse(readFileSync(path.join(pkgDir, 'families', kind, 'recipe.json'), 'utf8')),
  };
}
const facts = familyFacts(loadFamily);

/** The x-mock paths of one recipe (a nulled group has none), or the package recipe's when absent. */
function mockPaths(kind, recipe) {
  const fam = facts(kind);
  return recipe ? recipeMockPaths(fam.schema, recipe) : fam.fixtureMock;
}

function textAt(recipe, pathLabel) {
  if (!recipe) return null;
  let node = recipe;
  for (const part of pathLabel.match(/[^.[\]]+/g) ?? []) {
    if (node === null || typeof node !== 'object') return null;
    node = Array.isArray(node) ? node[Number(part)] : node[part];
  }
  return typeof node === 'string' ? node : null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function printTable(kinds) {
  console.log('kind             builds  ok  checked  illustr.  flagged   rate    vfail  unlabelled  pass');
  for (const [kind, k] of Object.entries(kinds)) {
    const rate = k.rate === null ? '   -  ' : `${(k.rate * 100).toFixed(2).padStart(5)} %`;
    console.log(`${kind.padEnd(16)} ${String(k.builds).padStart(6)} ${String(k.ok).padStart(3)} ${String(k.checked).padStart(8)} ${String(k.illustrative).padStart(9)} ${String(k.flagged).padStart(8)}  ${rate}  ${String(k.verifyFailed).padStart(5)}  ${String(k.unlabelledClaims).padStart(10)}  ${k.pass ? 'yes' : 'NO'}`);
    for (const failure of k.failures) console.log(`  ${kind}: ${failure}`);
  }
}

function writeResult(result, outArg) {
  const out = outArg ? path.resolve(outArg) : path.join(os.tmpdir(), `xmock-eval-${new Date().toISOString().slice(0, 10)}`, 'result.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`result: ${out}`);
}

function repoSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// --rescore
// ---------------------------------------------------------------------------

function readSavedRows(source) {
  if (statSync(source).isDirectory()) {
    return readdirSync(source)
      .filter((name) => /^report-.*\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(path.join(source, name), 'utf8')));
  }
  const rows = JSON.parse(readFileSync(source, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${source}: expected a JSON array of rows`);
  return rows;
}

function rescore(source, values) {
  const rows = readSavedRows(source).map((saved) => rescoreRow(saved, facts)).filter((row) => !values.model || row.model === values.model || row.model?.endsWith(`/${values.model}`));
  if (rows.length === 0) usage(`no rows to rescore in ${source}${values.model ? ` for model ${values.model}` : ''}`);
  const kinds = summarizeKinds(rows, { live: false });
  for (const kind of KINDS) {
    const kindRows = rows.filter((row) => row.kind === kind);
    const byModel = {};
    for (const model of [...new Set(kindRows.map((row) => row.model))].sort()) {
      const { flaggedSlots: _slots, flaggedPaths: _paths, ...rest } = summarize(kindRows.filter((row) => row.model === model), { live: false });
      byModel[model] = rest;
    }
    const sources = {};
    for (const row of kindRows) sources[row.illustrativeSource ?? 'unscorable'] = (sources[row.illustrativeSource ?? 'unscorable'] ?? 0) + 1;
    kinds[kind] = { ...kinds[kind], excludedAsMock: kindRows.reduce((sum, row) => sum + row.excludedAsMock, 0), illustrativeSources: sources, byModel };
  }
  const unscorable = rows.filter((row) => row.illustrativeSource === undefined).map((row) => ({ kind: row.kind, brief: row.brief, model: row.model, error: row.error }));
  const result = { mode: 'rescore', source: path.resolve(source), repoSha: repoSha(), model: values.model ?? 'all', kinds, unscorable, pass: overallPass(kinds) };
  printTable(kinds);
  for (const [kind, k] of Object.entries(kinds)) {
    for (const [model, m] of Object.entries(k.byModel)) {
      console.log(`  ${kind} ${model}: checked ${m.checked}, flagged ${m.flagged}, rate ${m.rate === null ? '-' : `${(m.rate * 100).toFixed(2)} %`}`);
    }
    console.log(`  ${kind} illustrative count from: ${Object.entries(k.illustrativeSources).map(([src, n]) => `${src} ${n}`).join(', ') || 'none'}`);
  }
  writeResult(result, values.out);
  process.exit(result.pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

/** `<kind>-NN.txt` with a sidecar `<kind>-NN.json`, flat in `dir` or under `dir/<kind>/`. */
function loadBriefs(dir) {
  const briefs = [];
  for (const kind of KINDS) {
    const kindDir = existsSync(path.join(dir, kind)) ? path.join(dir, kind) : dir;
    const files = readdirSync(kindDir).filter((name) => new RegExp(`^${kind}-\\d{2}\\.txt$`).test(name)).sort();
    for (const file of files) {
      const id = file.replace(/\.txt$/, '');
      const sidecarFile = path.join(kindDir, `${id}.json`);
      const sidecar = existsSync(sidecarFile) ? JSON.parse(readFileSync(sidecarFile, 'utf8')) : {};
      briefs.push({ kind, id, text: readFileSync(path.join(kindDir, file), 'utf8').trim(), sidecar });
    }
  }
  return briefs;
}

function daemonClient(base) {
  const origin = new URL(base).origin;
  // Every agency route requires a local-origin request; the daemon's own origin satisfies it.
  const call = (pathname, opts = {}) => fetch(new URL(pathname, base), { ...opts, headers: { Origin: origin, ...(opts.headers ?? {}) } });
  return {
    async start(body) {
      const res = await call('/api/agency/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status !== 202) throw new Error(`POST /api/agency/build -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return (await res.json()).build.id;
    },
    /** Reads the SSE stream to its terminal `status` frame; `build-event` frames go to `onEvent`. */
    async follow(buildId, onEvent) {
      const res = await call(`/api/agency/builds/${buildId}/events`, { headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`GET /api/agency/builds/${buildId}/events -> ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let name = 'message';
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (data.length === 0) continue;
          let payload;
          try {
            payload = JSON.parse(data.join('\n'));
          } catch {
            continue;
          }
          if (name === 'build-event') onEvent(payload);
          else if (name === 'status') {
            await reader.cancel().catch(() => {});
            return payload;
          }
        }
      }
      throw new Error('the event stream ended before a terminal status frame');
    },
    async settledVerify(buildId, verify) {
      const deadline = Date.now() + VERIFY_POLL_TIMEOUT_MS;
      let current = verify;
      while (current?.status === 'pending' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
        const res = await call(`/api/agency/builds/${buildId}`);
        if (!res.ok) break;
        current = (await res.json()).build?.verify;
      }
      return current;
    },
    /**
     * One published project file as text: `{ body }`, or `{ error }` naming what failed. Never
     * throws and never returns a bare null, so a failed read always reaches the row.
     */
    async raw(projectId, file) {
      const where = `/api/projects/${encodeURIComponent(projectId)}/raw/${file.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const res = await call(where);
        if (!res.ok) return { error: `GET ${file} -> ${res.status}` };
        return { body: await res.text() };
      } catch (error) {
        return { error: `GET ${file} failed: ${String(error?.message ?? error).slice(0, 200)}` };
      }
    },
  };
}

/**
 * Reads what a done build published: the build record (`AGENCY-SITE-STATE.md`) names the entry
 * page and the state revision, so neither is hardcoded here; then the recipe and the page.
 * Returns `{ recipe, html, entry }` or `{ error }` (with whatever was read before it failed).
 */
async function readPublished(client, projectId) {
  if (!projectId) return { error: 'done build has no projectId' };
  const note = await client.raw(projectId, 'AGENCY-SITE-STATE.md');
  if (note.error) return { error: `build record not read: ${note.error}` };
  const published = publishedEntry(note.body);
  if (!published) return { error: 'build record does not state the entry and revision' };
  const recipeFile = await client.raw(projectId, `agency-site-state/r${published.revision}/recipe.json`);
  if (recipeFile.error) return { error: `recipe not read: ${recipeFile.error}`, entry: published.entry };
  let recipe;
  try {
    recipe = JSON.parse(recipeFile.body);
  } catch {
    return { error: 'recipe is not valid JSON', entry: published.entry };
  }
  const page = await client.raw(projectId, published.entry);
  if (page.error) return { error: `page not read: ${page.error}`, recipe, entry: published.entry };
  return { recipe, html: page.body, entry: published.entry };
}

async function live(values) {
  const briefsDir = path.resolve(values.briefs ?? path.join(REPO, 'evals/genui/briefs/faithfulness'));
  const [provider, ...rest] = (values.model ?? 'cerebras/gpt-oss-120b').split('/');
  const model = rest.join('/');
  if (!provider || !model) usage('--model must be provider/model, e.g. cerebras/gpt-oss-120b');
  const daemon = values.daemon ?? process.env.OD_DAEMON_URL ?? 'http://127.0.0.1:57830';
  const verifyMode = values.verify ?? DEFAULT_VERIFY_MODE;
  if (!VERIFY_MODES.includes(verifyMode)) usage(`--verify must be one of ${VERIFY_MODES.join(', ')}, got: ${verifyMode}`);
  if (verifyMode !== 'strict') {
    console.warn(`warning: --verify ${verifyMode} publishes before the gate runs and never repairs, so this run can NEVER pass C10 (exit 1). Use it for diagnosis only; the proof run is --verify strict.`);
  }
  const briefs = loadBriefs(briefsDir);
  for (const kind of KINDS) {
    const count = briefs.filter((brief) => brief.kind === kind).length;
    if (count !== BRIEFS_PER_KIND) usage(`${briefsDir}: expected ${BRIEFS_PER_KIND} ${kind} briefs, found ${count}`);
  }
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
  const planned = limit ? briefs.slice(0, limit) : briefs;
  if (values.dry) {
    for (const brief of planned) console.log(`[dry] ${brief.id} -> family ${brief.kind}, ${provider}/${model}, verify:'${verifyMode}', mode:'sections'`);
    console.log(`[dry] ${planned.length} builds planned against ${daemon}; nothing was run.`);
    return;
  }

  const client = daemonClient(daemon);
  const projectByKind = {};
  const rows = [];
  for (const brief of planned) {
    const row = { kind: brief.kind, brief: brief.id, ok: false, checked: 0, illustrative: 0, flaggedSlots: [] };
    try {
      const buildId = await client.start({
        brief: brief.text,
        family: brief.kind,
        mode: 'sections',
        verify: verifyMode,
        provider,
        model,
        ...(projectByKind[brief.kind] ? { projectId: projectByKind[brief.kind] } : { projectName: `xmock-eval-${brief.kind}` }),
      });
      row.buildId = buildId;
      let counts;
      const snapshot = await client.follow(buildId, (event) => {
        if (event.type === 'verify' && event.counts) counts = event.counts;
      });
      if (snapshot.projectId) projectByKind[brief.kind] ??= snapshot.projectId;
      const verify = verifyMode === 'after' ? await client.settledVerify(buildId, snapshot.verify) : undefined;
      row.status = snapshot.status;
      if (verify) row.verifyStatus = verify.status;
      Object.assign(row, liveBuildOutcome({ snapshot, verify, counts, verifyMode }));
      // A strict build the gate stopped published nothing, so there is no page to read. Every done
      // build gets caption evidence or an explicit `evidence: 'missing'` with the reason.
      let recipe = null;
      let mock = new Set();
      if (snapshot.status === 'done') {
        const read = await readPublished(client, snapshot.projectId);
        recipe = read.recipe;
        if (recipe) mock = mockPaths(brief.kind, recipe);
        Object.assign(row, read.error
          ? { evidence: 'missing', evidenceError: read.error, mockSlots: mock.size }
          : captionEvidence(recipe, read.html, mock));
        if (read.entry) row.publishedEntry = read.entry;
      }
      const captioned = row.evidence === 'present'
        ? new Set([...mock].filter((p) => !(row.uncaptionedMock ?? []).includes(p)))
        : new Set();
      const claims = (brief.sidecar.claims ?? []).map((claim) => String(claim.value).toLowerCase());
      // Only fact slots are listed for review; a flagged x-mock path is an exclusion bug instead.
      // An uncaptioned x-mock slot is no sample data to a reader, so a flag there is a fact flag.
      row.flaggedSlots = (verify?.flagged ?? []).filter((p) => !captioned.has(p)).map((p) => {
        const text = textAt(recipe, p);
        // A hint for the reviewer only: flagged text that repeats a brief claim is a false positive.
        const repeatsBriefClaim = text !== null && claims.some((claim) => claim && text.toLowerCase().includes(claim));
        return { brief: brief.id, path: p, text, repeatsBriefClaim };
      });
      row.mockViolations = (verify?.flagged ?? []).filter((p) => mock.has(p));
    } catch (error) {
      row.error = String(error?.message ?? error).slice(0, 500);
    }
    rows.push(row);
    console.log(`${row.ok ? 'ok ' : 'ERR'} ${brief.id.padEnd(20)} checked ${String(row.checked).padStart(3)}  illustrative ${String(row.illustrative).padStart(3)}  flagged ${row.flaggedCount ?? row.flaggedSlots.length}  remaining ${row.remaining ?? '-'}  uncaptioned ${row.evidence === 'present' ? row.uncaptionedMock.length : `? (${row.evidenceError ?? 'no evidence'})`}${row.errorCode ? `  ${row.errorCode}` : ''}${row.error ? `  ${row.error}` : ''}`);
  }

  const kinds = summarizeKinds(rows, { live: true });
  const result = {
    mode: 'live',
    verifyMode,
    daemon,
    repoSha: repoSha(),
    model: `${provider}/${model}`,
    briefsPerKind: BRIEFS_PER_KIND,
    kinds,
    pass: overallPass(kinds, { verifyMode }),
    ...(verifyMode === 'strict' ? {} : { notProvable: `verify mode ${verifyMode} cannot pass C10` }),
    builds: rows,
  };
  printTable(kinds);
  writeResult(result, values.out);
  process.exit(result.pass ? 0 : 1);
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        briefs: { type: 'string' },
        model: { type: 'string' },
        daemon: { type: 'string' },
        out: { type: 'string' },
        rescore: { type: 'string' },
        dry: { type: 'boolean' },
        verify: { type: 'string' },
      },
    });
  } catch (error) {
    return usage(error.message);
  }
})();

if (values.rescore) rescore(values.rescore, values);
else await live(values);
