#!/usr/bin/env node
// Route eval (GenUI production run, criterion C8): does `resolveRoute`, with the CURRENT family
// registry, send the 25-item catalog corpus to families the corpus labels judge acceptable? The
// labels are not blind to Jev (see `provenance` in the labels file and README.md).
//
// MODE: profiler-proxy. This is NOT the production single-request router. The answers are rebuilt
// from the design profiler's output (spine, skin, family, archetype_<SPINE>) and carry no
// `pageKind` answer, so `resolveRoute` skips its pageKind check: production also asks pageKind and,
// when that answer is confident (>= 0.5) and disagrees with the winning family's page kind,
// reroutes to the best matching family or unroutes. The profiler's question wording also differs
// from the production router's.
//
//   node --experimental-strip-types evals/genui/8-route-eval.mjs                       # live
//   node --experimental-strip-types evals/genui/8-route-eval.mjs --replay <answers.json>
//   node --experimental-strip-types evals/genui/8-route-eval.mjs --profiles <dir>       # offline
//   node --experimental-strip-types evals/genui/8-route-eval.mjs --replay <answers.json> \
//     --threshold 0.5,0.45,0.4 --spine-share 0.25,0.2                                   # sweep
//
// Live mode re-profiles the corpus with Jev by running
// `packages/agency-fast-lane/scripts/profile-catalog.ts --out <run>/catalog` (25 Jev calls, the
// key comes from ZS Vault inside that script; the catalog database is read-only), then turns each
// written profile back into the Choice answers `resolveRoute` takes and saves them as
// `<run>/answers.json`. `--replay` re-scores a saved answers file with no Jev call; `--profiles`
// builds the answers from an existing `profiles/` directory with no Jev call.
//
// Scoring against `fixtures/route-corpus-labels.json`: an item is correct when it routed to one
// of its `acceptableFamilies`, or stayed unrouted when that list is empty or the label sets
// `unroutedAcceptable: true` (labels v2); it is illegal when it
// routed to one of its `illegalFamilies`. The run passes (exit 0) only when correct >= 20 of 25,
// the routed picks span >= 5 distinct families, and no pick is illegal. With more than one
// --threshold or --spine-share value it sweeps every combination on the same answers (plan B),
// prints one row each, and exits 0 when any combination passes.
//
// Every run writes `<run>/answers.json` (unless replaying) and `<run>/score.json` under
// `evals/genui/out/` (gitignored) or `--out <dir>`. The run directory must be new or empty. An item
// whose answers lack spine, skin or family is scored `missing` (wrong), never as unrouted.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FAST_LANE = path.join(REPO, 'packages/agency-fast-lane');
const LABELS = path.join(HERE, 'fixtures/route-corpus-labels.json');

export const PASS = { correct: 20, families: 5, illegal: 0 };
/** What this eval measures; printed in the header and written to score.json. */
export const MODE = 'profiler-proxy';
const MODE_NOTE = 'answers rebuilt from design-profiler output with no pageKind answer; the production single-request router also asks pageKind and reroutes or unroutes on a confident mismatch';
/** The answers `resolveRoute` cannot route without; an item missing any of them is scored `missing`. */
export const REQUIRED_ANSWERS = ['spine', 'skin', 'family'];
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_SPINE_SHARE = 0.25;

const choice = (judgment) => judgment && { type: 'choice', choice: judgment.choice, confidence: judgment.confidence, probabilities: judgment.probabilities };

/** The Choice answers `resolveRoute` takes, rebuilt from one saved design profile. Every
 * archetype answer the profile kept (`route.archetypes`) goes in; an older profile has only the
 * top spine's (`route.archetype`). */
export function answersFromProfile(profile) {
  const route = profile.route;
  const answers = { spine: choice(route.spine), skin: choice(route.skin), family: choice(route.family) };
  if (route.archetypes) {
    for (const [code, judgment] of Object.entries(route.archetypes)) answers[`archetype_${code}`] = choice(judgment);
  } else if (route.archetype && route.spine.choice !== 'none') {
    answers[`archetype_${route.spine.choice}`] = choice(route.archetype);
  }
  return answers;
}

/** Read every `profiles/*.json` into an answers file body. */
export function answersFromProfilesDir(dir) {
  const items = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const profile = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    const id = profile.source?.id ?? file.replace(/\.json$/, '');
    items[id] = { model: profile.model, at: profile.at, answers: answersFromProfile(profile) };
  }
  const models = [...new Set(Object.values(items).map((item) => item.model).filter(Boolean))];
  return { version: 1, generatedAt: new Date().toISOString(), profilesDir: dir, models, items };
}

/** Why an item's saved answers cannot be scored, or null when every required answer is a choice. */
export function incompleteAnswers(answers) {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return 'answers are not an object';
  const absent = REQUIRED_ANSWERS.filter((key) => {
    const answer = answers[key];
    return answer === null || typeof answer !== 'object' || typeof answer.choice !== 'string' || answer.probabilities === null || typeof answer.probabilities !== 'object';
  });
  return absent.length ? `answers lack ${absent.join(', ')}` : null;
}

/** Refuse an `--out` directory that already holds files, so a run can never read a profile or
 * answers file left there by an earlier run. */
export function assertFreshOutDir(dir) {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`--out ${dir} is not empty; pass a new directory so no earlier run's profiles are read`);
  }
}

/**
 * Score one routing configuration. `resolve(answers, options)` is `resolveRoute` bound to the
 * atlas and registry. Pure: returns the counts and one row per labelled item.
 */
export function scoreRoutes(labels, answersFile, resolve, options = {}) {
  const rows = labels.items.map((label) => {
    const item = answersFile.items[label.id];
    const missingReason = item ? incompleteAnswers(item.answers) : 'item absent from the answers file';
    if (missingReason) return { id: label.id, family: null, decision: 'missing', acceptable: label.acceptableFamilies, unroutedAcceptable: label.unroutedAcceptable === true, correct: false, illegal: false, reason: missingReason };
    const policy = resolve(item.answers, options);
    const family = policy.decision === 'routed' ? policy.family.id : null;
    const correct = family ? label.acceptableFamilies.includes(family) : label.acceptableFamilies.length === 0 || label.unroutedAcceptable === true;
    const illegal = family ? label.illegalFamilies.includes(family) : false;
    return {
      id: label.id,
      family,
      probability: policy.family?.probability,
      decision: policy.decision,
      spine: policy.spine?.choice,
      reason: policy.reason,
      acceptable: label.acceptableFamilies,
      unroutedAcceptable: label.unroutedAcceptable === true,
      correct,
      illegal,
    };
  });
  const correct = rows.filter((row) => row.correct).length;
  const families = [...new Set(rows.map((row) => row.family).filter(Boolean))].sort();
  const illegal = rows.filter((row) => row.illegal).length;
  const passed = correct >= PASS.correct && families.length >= PASS.families && illegal <= PASS.illegal;
  return { total: labels.items.length, correct, families, illegal, passed, rows };
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
function numbers(raw, fallback, name) {
  if (raw === undefined) return [fallback];
  const values = raw.split(',').map((part) => Number(part.trim()));
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${name}: expected numbers from 0 to 1, comma-separated`);
  return values;
}

function profileLive(runDir, argv) {
  const catalogDir = path.join(runDir, 'catalog');
  const args = ['--experimental-strip-types', path.join(FAST_LANE, 'scripts/profile-catalog.ts'), '--out', catalogDir];
  const catalogDb = flag(argv, '--catalog-db');
  if (catalogDb) args.push('--catalog-db', catalogDb);
  console.log(`profiling the corpus live with Jev into ${catalogDir}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: FAST_LANE, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`profile-catalog.ts exited ${result.status ?? result.signal}`);
  console.log(`profiled in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return answersFromProfilesDir(path.join(catalogDir, 'profiles'));
}

function printScore(score, answersFile, options) {
  console.log(`correct: ${score.correct}/${score.total}`);
  console.log(`families selected: ${score.families.length} (${score.families.join(', ') || 'none'})`);
  console.log(`illegal: ${score.illegal}`);
  const missing = score.rows.filter((row) => row.decision === 'missing').length;
  if (missing) console.log(`missing answers: ${missing}/${score.total} (the run is incomplete; these count as wrong)`);
  console.log(`model: ${answersFile.models?.join(', ') || '(unknown)'}`);
  console.log(`policy: threshold ${options.threshold}, spineShare ${options.spineShare}`);
  for (const row of score.rows) {
    const mark = row.illegal ? 'ILLEGAL' : row.correct ? 'ok' : 'miss';
    if (row.decision === 'missing') {
      console.log(`  ${mark.padEnd(7)} ${row.id.padEnd(24)} (no answers: ${row.reason}; not evaluated, counted wrong)`);
      continue;
    }
    const picked = row.family ? `${row.family} p=${row.probability?.toFixed(2)}` : `unrouted (${row.reason ?? row.decision})`;
    console.log(`  ${mark.padEnd(7)} ${row.id.padEnd(24)} ${picked}  [acceptable: ${row.acceptable?.join(', ') || 'unrouted'}${row.unroutedAcceptable && row.acceptable?.length ? ' or unrouted' : ''}]`);
  }
  console.log(score.passed ? 'PASS' : `FAIL (needs correct >= ${PASS.correct}, families >= ${PASS.families}, illegal == ${PASS.illegal})`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { resolveRoute } = await import(pathToFileURL(path.join(FAST_LANE, 'src/route.ts')).href);
  const { loadAtlasData } = await import(pathToFileURL(path.join(FAST_LANE, 'src/atlas.ts')).href);
  const { atlas, registry } = await loadAtlasData();
  const labels = JSON.parse(readFileSync(flag(argv, '--labels') ?? LABELS, 'utf8'));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(flag(argv, '--out') ?? path.join(HERE, 'out', `route-${stamp}`));
  assertFreshOutDir(runDir);
  mkdirSync(runDir, { recursive: true });
  console.log(`mode: ${MODE} (${MODE_NOTE})`);

  let answersFile;
  const replay = flag(argv, '--replay');
  const profiles = flag(argv, '--profiles');
  if (replay) {
    answersFile = JSON.parse(readFileSync(replay, 'utf8'));
    console.log(`replaying ${replay} (no Jev calls)`);
  } else {
    answersFile = profiles ? answersFromProfilesDir(path.resolve(profiles)) : profileLive(runDir, argv);
    writeFileSync(path.join(runDir, 'answers.json'), `${JSON.stringify(answersFile, null, 2)}\n`);
    console.log(`saved answers to ${path.join(runDir, 'answers.json')}`);
  }

  const thresholds = numbers(flag(argv, '--threshold'), DEFAULT_THRESHOLD, '--threshold');
  const shares = numbers(flag(argv, '--spine-share'), DEFAULT_SPINE_SHARE, '--spine-share');
  const resolve = (answers, options) => resolveRoute(answers, atlas, registry, options);
  const runs = [];
  for (const threshold of thresholds) {
    for (const spineShare of shares) {
      const options = { threshold, spineShare };
      runs.push({ options, score: scoreRoutes(labels, answersFile, resolve, options) });
    }
  }

  if (runs.length === 1) {
    printScore(runs[0].score, answersFile, runs[0].options);
  } else {
    console.log(`sweep over ${runs.length} policies (model: ${answersFile.models?.join(', ') || '(unknown)'})`);
    console.log('threshold  spineShare  correct  families  illegal  pass');
    for (const { options, score } of runs) {
      console.log(`${String(options.threshold).padEnd(10)} ${String(options.spineShare).padEnd(11)} ${`${score.correct}/${score.total}`.padEnd(8)} ${String(score.families.length).padEnd(9)} ${String(score.illegal).padEnd(8)} ${score.passed ? 'yes' : 'no'}`);
    }
  }

  const summary = {
    at: new Date().toISOString(),
    mode: MODE,
    modeNote: MODE_NOTE,
    answers: replay ? path.resolve(replay) : path.join(runDir, 'answers.json'),
    labels: path.relative(REPO, flag(argv, '--labels') ?? LABELS),
    registryFamilies: registry.families.map((entry) => entry.family),
    models: answersFile.models ?? [],
    pass: PASS,
    runs,
  };
  writeFileSync(path.join(runDir, 'score.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`saved score to ${path.join(runDir, 'score.json')}`);
  process.exitCode = runs.some((run) => run.score.passed) ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
