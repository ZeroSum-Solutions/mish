import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { BUILDER_IDS, type BuilderId } from './builders/index.ts';
import { compare, DEFAULT_REVIEWERS } from './compare.ts';
import { requireCodexSubscription, requireSubscription } from './subscription.ts';
import { PAIRWISE_JUDGE_MODEL } from './pairwise.ts';

export const COMPARE_HELP = `Usage (from the e2e package):
  pnpm exec tsx benchmarks/quality/cli.ts compare --writers original,claude,terra --daemon http://127.0.0.1:PORT --out NEW_DIR --agent ID --model ID [--case a,b] [--briefs DIR] [--reps N]
  pnpm exec tsx benchmarks/quality/cli.ts compare --build PREVIOUS_COMPARE_DIR --daemon http://127.0.0.1:PORT --out NEW_DIR --agent ID --model ID
Writers are label or label=lane (e.g. terra-plus=terra builds a second Terra arm, labelled terra-plus, on a daemon running a changed writer).
--reuse writer=DIR takes that writer's arm from an existing, verified arm packet instead of building it (one rep).
--resume continues an interrupted run in --out: finished arms and saved verdicts are reused; a half-built arm must be removed.
Options: --judge-parallel N (default 2), --builder chat-run|agency-build (default chat-run; writers need chat-run), --judge-model ID (default ${PAIRWISE_JUDGE_MODEL}), --codex-judge-model ID, --timeout-ms N
--writers builds each improve-prompt case once per writer per rep; "original" is the request alone. Briefs come from the daemon's
Improve prompt lanes (it switches its own app-config, so use an isolated runtime) or, with --briefs, from <dir>/<case>/<writer>.preview.json.
--build rebuilds a previous compare's arms from its frozen briefs on the current code and judges each against the stored design.
Judges: Claude Max and GPT-6.1 Sol vision on their subscriptions, blind, both orders. Writers on metered lanes (Terra via OpenRouter) cost cents.`;

export async function compareMain(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    writers: { type: 'string' }, build: { type: 'string' }, daemon: { type: 'string' }, out: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' },
    case: { type: 'string' }, briefs: { type: 'string' }, reps: { type: 'string', default: '1' }, builder: { type: 'string' },
    reuse: { type: 'string', multiple: true }, resume: { type: 'boolean' }, 'judge-parallel': { type: 'string', default: '2' },
    'judge-model': { type: 'string', default: PAIRWISE_JUDGE_MODEL }, 'codex-judge-model': { type: 'string', default: DEFAULT_REVIEWERS[1]!.model },
    'timeout-ms': { type: 'string', default: '2700000' }, help: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(`${COMPARE_HELP}\n`); return; }
  if (!values.daemon || !values.out || !values.agent || !values.model || !values.writers === !values.build) throw new Error(COMPARE_HELP);
  if (values.builder && !(BUILDER_IDS as readonly string[]).includes(values.builder)) throw new Error(`--builder must be one of ${BUILDER_IDS.join(', ')}`);
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid timeout');
  await requireSubscription(process.cwd(), 60_000); await requireCodexSubscription(process.cwd(), 60_000);
  const result = await compare({
    daemon: values.daemon, out: resolve(values.out), agent: values.agent, model: values.model, timeoutMs, reps: Number(values.reps),
    ...(values.writers ? { writers: values.writers.split(',').map(w => w.trim()).filter(Boolean) } : {}),
    ...(values.build ? { baseline: resolve(values.build) } : {}),
    ...(values.case ? { caseIds: values.case } : {}), ...(values.briefs ? { briefsDir: resolve(values.briefs) } : {}),
    ...(values.builder ? { builder: values.builder as BuilderId } : {}),
    ...(values.reuse ? { reuse: Object.fromEntries(values.reuse.map(spec => { const at = spec.indexOf('='); if (at < 1) throw new Error('--reuse takes writer=DIR'); return [spec.slice(0, at), resolve(spec.slice(at + 1))]; })) } : {}),
    resume: !!values.resume, judgeParallel: Number(values['judge-parallel']),
    reviewers: [{ id: 'claude', model: values['judge-model']! }, { id: 'codex', model: values['codex-judge-model']! }],
    headers: process.env.OD_TOOL_TOKEN ? { authorization: `Bearer ${process.env.OD_TOOL_TOKEN}` } : {},
  });
  const failed = result.arms.flatMap(a => a.cases).filter(c => c.status !== 'succeeded').length;
  process.stdout.write(`Saved compare-report.md and gallery.html to ${resolve(values.out)}; ${result.verdicts.length} pair verdict(s), ${failed} failed build(s), ${result.missing.length} pair(s) not judged, ${result.unjudgeable.length} design(s) without judgeable evidence.\n`);
  if (failed || result.missing.length || result.unjudgeable.length) process.exitCode = 1;
}
