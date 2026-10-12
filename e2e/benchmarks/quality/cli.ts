import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './api.ts';
import { selectCases } from './cases.ts';
import { verifyFiles, verifyJudgments } from './packet.ts';
import { runBenchmark } from './run.ts';
import { captureRun, CAPTURE_PROTOCOL_DIGEST } from './capture.ts';
import { judgeRun, DEFAULT_JUDGE_MODEL, parseRubric, JUDGE_PROTOCOL_DIGEST, requireSubscription, requireCodexSubscription, reviewerSettings, CODEX_JUDGE_MODEL } from './judge.ts';
import { scoreBenchmark, preflightBaseline, type Packet } from './score.ts';
import { writeReport, writeHumanSheet } from './report.ts';
import { startStub } from './stub.ts';
import { humanAgreement } from './calibration.ts';
import { writeFile } from 'node:fs/promises';
import type { BenchmarkRun, Captures, Judgments } from './types.ts';
import { COMPARE_HELP, compareMain } from './compare-cli.ts';
import { builderFor } from './builders/index.ts';
const help = `Usage (from repository root):
  grade (below) scores one build path against the agency bar; compare judges designs pairwise:
${COMPARE_HELP}

  pnpm --filter @mish/e2e exec tsx benchmarks/quality/cli.ts run --daemon http://127.0.0.1:PORT --out NEW_DIR --agent ID --model ID [--kit ID] [--case dental] [--baseline DIR]
  pnpm --filter @mish/e2e exec tsx benchmarks/quality/cli.ts run --stub --out NEW_DIR
  pnpm --filter @mish/e2e exec tsx benchmarks/quality/cli.ts capture|judge|score --out DIR
Options: --builder build-on-brand|agency-build (default build-on-brand), --judge-model ID, --codex-judge-model gpt-6.1-sol, --measurement-baseline, --capture-only, --human-ratings FILE (repeatable), --rubric FILE, --timeout-ms N, --threshold 0..4 (advisory deltas only), --gate
Run creates builds, captures every page and judges/reports them. Services belong to the caller.
Stub creates synthetic files and uses a stub judge, but still renders with Chromium. No provider calls.
Score compares saved judgments to --baseline. New or worsened mechanical failures and missing or stale evidence exit 1; quality deltas are advisory.
--measurement-baseline permits a complete baseline with failed mechanical checks and keeps them visible.
--capture-only writes the blind human sheet before judging.
--gate also refuses synthetic or placeholder evidence. Speed has no target.`;
const load = async <T>(out: string, file: string): Promise<T> => JSON.parse(await readFile(join(out, file), 'utf8')) as T;
async function main() {
  if (process.argv[2] === 'compare') { await compareMain(process.argv.slice(3)); return; }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    daemon: { type: 'string' }, out: { type: 'string' }, case: { type: 'string' }, kit: { type: 'string' },
    agent: { type: 'string' }, model: { type: 'string' }, 'judge-model': { type: 'string', default: DEFAULT_JUDGE_MODEL },
    'codex-judge-model': {type:'string',default:CODEX_JUDGE_MODEL}, 'measurement-baseline':{type:'boolean'}, 'capture-only':{type:'boolean'}, 'human-ratings':{type:'string',multiple:true},
    rubric: { type: 'string', default: fileURLToPath(new URL('../../../docs/quality/agency-bar.md', import.meta.url)) },
    'timeout-ms': { type: 'string', default: '1800000' }, threshold: { type: 'string', default: '0' }, baseline: { type: 'string' },
    stub: { type: 'boolean' }, gate: { type: 'boolean' }, help: { type: 'boolean' }, builder: { type: 'string', default: 'build-on-brand' },
  } });
  if (values.help) { process.stdout.write(`${help}\n`); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !values.out || !['run', 'capture', 'judge', 'score'].includes(command ?? '')) throw new Error(help);
  if(values['measurement-baseline']&&!values.baseline) throw new Error('--measurement-baseline requires --baseline');
  if(values['capture-only']&&command!=='run') throw new Error('--capture-only is a run option');
  if (values.builder === 'chat-run') throw new Error('chat-run builds from a brief; use compare --writers');
  if (values.builder !== 'build-on-brand' && values.baseline) throw new Error('A --baseline packet was built with build-on-brand; compare other builders with compare --build');
  const reviewers=reviewerSettings(values['judge-model']!,values['codex-judge-model']!);
  const baselinePolicy=values['measurement-baseline']?'measurement' as const:'passing' as const;
  const out = resolve(values.out); const timeoutMs = Number(values['timeout-ms']); const threshold = Number(values.threshold);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(threshold) || threshold < 0 || threshold > 4) throw new Error('Invalid timeout or regression threshold');
  const baseline: Packet | undefined = values.baseline ? { run: await load<BenchmarkRun>(resolve(values.baseline), 'run.json'), captures: await load<Captures>(resolve(values.baseline), 'captures.json'), judgments: await load<Judgments>(resolve(values.baseline), 'judgments.json') } : undefined;
  if (baseline) { await verifyFiles(resolve(values.baseline!), baseline.run, baseline.captures); await verifyJudgments(resolve(values.baseline!),baseline.judgments,baseline.run,baseline.captures); }
  let run: BenchmarkRun;
  if (command === 'run') {
    if (values.stub && values.daemon) throw new Error('Choose --stub or --daemon');
    if (!values.stub && (!values.daemon || !values.agent || !values.model)) throw new Error('Live run requires explicit daemon, agent and model');
    if (!values.stub && parseRubric(await readFile(resolve(values.rubric!), 'utf8')).status !== 'approved') throw new Error('Lead must approve agency-bar.md before a live baseline');
    if (!values.stub && !values['capture-only']) { await requireSubscription(process.cwd(), timeoutMs); await requireCodexSubscription(process.cwd(), timeoutMs); }
    if (baseline) preflightBaseline(baseline, { fixtureDigest: digest(JSON.stringify(selectCases(values.case, values.kit))), settings: { agent: values.agent ?? 'stub', model: values.model ?? 'stub', pageCount: 4, useLibrary: true }, mode: values.stub ? 'stub' : 'live', rubricDigest: digest(await readFile(resolve(values.rubric!), 'utf8')), requestedModel: values['judge-model']!, judgeProtocolDigest: JUDGE_PROTOCOL_DIGEST, captureProtocolDigest: CAPTURE_PROTOCOL_DIGEST, reviewers, sampleCount:3, baselinePolicy });
    const stub = values.stub ? await startStub() : null;
    try {
      run = await runBenchmark({ daemon: stub?.url ?? values.daemon!, out, agent: values.agent ?? 'stub', model: values.model ?? 'stub', timeoutMs, mode: stub ? 'stub' : 'live', builder: builderFor(values.builder!),
        ...(values.case ? { caseId: values.case } : {}), ...(values.kit ? { kitId: values.kit } : {}),
        headers: process.env.OD_TOOL_TOKEN ? { authorization: `Bearer ${process.env.OD_TOOL_TOKEN}` } : {},
      });
    } finally { await stub?.close(); }
  } else run = await load<BenchmarkRun>(out, 'run.json');
  const captures = command === 'run' || command === 'capture' ? await captureRun(out, run) : await load<Captures>(out, 'captures.json');
  if (command === 'capture' || values['capture-only']) { await writeHumanSheet(out,{runId:run.runId,fixtureDigest:run.fixtureDigest,mode:run.mode,caseIds:run.cases.map(c=>c.caseId),rubricDigest:digest(await readFile(resolve(values.rubric!),'utf8'))},captures,parseRubric(await readFile(resolve(values.rubric!),'utf8'))); process.stdout.write(`Saved ${captures.facts.length} captures.\n`); if (captures.facts.some(fact => fact.error)) process.exitCode = 1; return; }
  const judgments = command === 'run' || command === 'judge' ? await judgeRun(out, run, captures, { rubricPath: resolve(values.rubric!), model: values['judge-model']!, codexModel:values['codex-judge-model']!, timeoutMs, stub: !!values.stub }) : await load<Judgments>(out, 'judgments.json');
  await verifyFiles(out, run, captures);
  await verifyJudgments(out,judgments,run,captures);
  const score = scoreBenchmark(run, captures, judgments, baseline, threshold, baselinePolicy);
  await writeReport(out, score, captures, judgments);
  if(values['human-ratings']) {
    const human=await Promise.all(values['human-ratings'].map(async file=>JSON.parse(await readFile(resolve(file),'utf8')) as unknown));
    const agreement=humanAgreement(human,score,judgments.judgedAt);
    await writeFile(join(out,'human-agreement.json'),JSON.stringify(agreement,null,2));
  }
  process.stdout.write(`Saved ${score.mode} report and human-check.html to ${out}; ${score.regressions.length} criterion regression(s).\n`);
  if (!score.passed || (values.gate && !score.gateEligible)) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed'}\n`); process.exitCode = 1; });
