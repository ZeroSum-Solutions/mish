import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  parseReviewRunList, parseReviewRunView, parseRunMechanicalReviewRequest, parseStartReviewRunRequest, parseVerificationBundle, parseVerificationBundleList, renderVerificationBundleText, resolveDefaultReviewEntry,
  type ReviewEvidenceLocale, type ReviewRunView, type StartReviewRunRequest,
} from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';
import type { WorkbenchCliOptions } from '../workbench-cli.js';

/**
 * J4-01: `od workbench review start`'s input file used to need an explicit
 * `snapshot.entry`, or fall through to the contract's hardcoded
 * `index.html` default — the same bug the web Start form had. This mirrors
 * the web form's default (`resolveReviewEntryDefault` in
 * `WorkbenchReviewPanel.tsx`): the project's currently open file (the
 * daemon's soft `/api/active` channel) when it is HTML, else the project's
 * first HTML file, else the entry of the project's last review run. Every
 * fetch here is best-effort — a daemon hiccup while resolving a *default*
 * must never turn into a CLI failure, so any error or unresolved tier falls
 * back to the historical `index.html`.
 */
async function resolveCliDefaultReviewEntry(project: string, resolve: { flagUrl: string | null; env: NodeJS.ProcessEnv; workspace?: string | undefined; workspaceMember?: string | undefined }): Promise<string> {
  try {
    const baseUrl = (await resolveDaemonUrl({ flagUrl: resolve.flagUrl, env: resolve.env })).replace(/\/$/, '');
    const headers: Record<string, string> = {
      'x-od-project-id': project,
      ...(resolve.workspace ? { 'x-od-workspace-id': resolve.workspace, 'x-od-workspace-member-id': resolve.workspaceMember! } : {}),
    };
    const activeFileName = await fetchWithScopedToolToken(`${baseUrl}/api/active`, { headers }, resolve.env)
      .then(response => (response.ok ? response.json() as Promise<{ active?: boolean; projectId?: string; fileName?: string | null }> : null))
      .then(active => (active?.active && active.projectId === project && typeof active.fileName === 'string' ? active.fileName : null))
      .catch(() => null);
    const projectFileNames = await fetchWithScopedToolToken(`${baseUrl}/api/projects/${encodeURIComponent(project)}/files`, { headers }, resolve.env)
      .then(response => (response.ok ? response.json() as Promise<{ files?: { name: string; type?: string }[] }> : null))
      .then(body => (body?.files ?? []).filter(file => file.type !== 'dir').map(file => file.name))
      .catch(() => [] as string[]);
    const lastRunEntry = await fetchWithScopedToolToken(`${baseUrl}/api/workbench/projects/${encodeURIComponent(project)}/reviews`, { headers }, resolve.env)
      .then(response => (response.ok ? response.json() as Promise<{ runs?: { entry: string }[] }> : null))
      .then(body => body?.runs?.[0]?.entry ?? null)
      .catch(() => null);
    return resolveDefaultReviewEntry({ activeFileName, projectFileNames, lastRunEntry }) ?? 'index.html';
  } catch {
    return 'index.html';
  }
}

const HELP = [
  'od workbench review run --project <id> [--entry <path>] [--allow-host <host>]... [--lang en] --json',
  'od workbench review list --project <id> --json',
  'od workbench review get --project <id> --bundle <id> [--lang en] --json',
  'od workbench review start --project <id> --input-file <path|-> [--allow-host <host>]... [--idempotency-key <key>] [--wait] --json',
  'od workbench review show --project <id> --run <id> --json',
  'od workbench review cancel --project <id> --run <id> --json',
  'od workbench review accept|dismiss <finding> --project <id> --run <id> --json',
  'Accept / Dismiss records an advisory decision with who/when; it never edits, publishes or clears required checks.',
  'od workbench review runs --project <id> --json',
  'od review is an alias for od workbench review; all commands and options are identical.',
  'Input file for start: {"snapshot":{"entry":"index.html","versionId":null},"scope":{"kind":"all"},"rubricRevision":0,"reviewerPlan":{"reviewers":[{"role":"jev-text","required":true}]}}',
  '--allow-host (repeatable, run and start): an exact public hostname, optionally with :port, the evidence worker may fetch over https for this run. Default: none; external requests stay blocked and the affected checks inconclusive. No wildcards, IP addresses or local names.',
  '--lang (run, get): also print `text`, every reason, recovery, summary, observation and measured detail rendered from the evidence template table in that locale. The bundle itself stays structured.',
  'Optional: --workspace <id> --workspace-member <id> --daemon-url <url>',
  'Accept / Dismiss without a workspace pair records actor local-user after project write authorization. In directory-backed workspace mode, the membership directory verifies the supplied pair before recording a workspace-member actor.',
  'accept|dismiss applies to optional advisory judgments only and records who (local-user or workspace-member) and when; the outcome is not recomputed.',
  'A required check or required judgment cannot be accepted or dismissed: the daemon refuses with 409 (exit 3). Failures stay failed, and a run with an open required judgment or manual check stays inconclusive (exit 5).',
  'Exit codes (one meaning each): 0 success or passed; 4 review failed; 5 review inconclusive; 130 run cancelled by a user; 75 run interrupted (restart, timeout, superseded); 124 --wait gave up while the run was still going; 2 invalid input; 3 refused by the daemon (401, 403, 404, 409, 429); 1 transport or server failure',
].join('\n');

const FLAGS = {
  run: ['--entry', '--allow-host', '--lang'], list: [], get: ['--bundle', '--lang'],
  accept: ['--run'], dismiss: ['--run'], start: ['--input-file', '--allow-host', '--idempotency-key', '--wait'], show: ['--run'], cancel: ['--run'], runs: [],
} as const;
const BOOLEAN_FLAGS = new Set(['--json', '--wait']);
const REPEATABLE_FLAGS = new Set(['--allow-host']);
type Command = keyof typeof FLAGS;
const WAIT_LIMIT_MS = 16 * 60_000;

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Exit code for a finished collect-review run (technical-spec "Operations, concurrency and errors"). */
export function reviewRunExitCode(view: ReviewRunView): number {
  const { operation, outcome } = view.run;
  if (operation.status === 'interrupted') return operation.interruptReason === 'user-cancelled' ? 130 : 75;
  return outcome === 'passed' ? 0 : outcome === 'failed' ? 4 : 5;
}

/** `od workbench review …` — same /api endpoints and DTOs as the web UI. */
export async function runReviewCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.includes('--help') || args.includes('-h')) { write({ usage: HELP }); return 0; }
  const command = args[0] as Command;
  const flags: Record<string, string> = {};
  const allowHosts: string[] = [];
  let body: unknown;
  let findingId: string | undefined;
  try {
    if (!Object.hasOwn(FLAGS, command ?? '')) throw new Error('Use review run, list, get, start, show, cancel, runs, accept or dismiss');
    const allowed: string[] = ['--project', '--workspace', '--workspace-member', '--daemon-url', ...FLAGS[command]];
    const decision = command === 'accept' || command === 'dismiss';
    if (decision) {
      findingId = args[1];
      if (!findingId || findingId.startsWith('--') || findingId.trim() !== findingId || findingId.length > 120 || /\p{Cc}/u.test(findingId)) throw new Error('accept/dismiss requires a finding id');
      body = { action: command };
    }
    for (let i = decision ? 2 : 1; i < args.length; i++) {
      const flag = args[i]!;
      if (Object.hasOwn(flags, flag)) throw new Error(`Duplicate option: ${flag}`);
      if (flag === '--json') { flags[flag] = 'true'; continue; }
      if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
      if (BOOLEAN_FLAGS.has(flag)) { flags[flag] = 'true'; continue; }
      const value = args[++i];
      if (!value || (value.startsWith('--')) || (!REPEATABLE_FLAGS.has(flag) && value.trim() !== value) || /\p{Cc}/u.test(value)) throw new Error(`${flag} requires a value`);
      // Repeatable values are validated by the request contract, so a bad host names its reason.
      if (REPEATABLE_FLAGS.has(flag)) { allowHosts.push(value); continue; }
      flags[flag] = value;
    }
    if (!flags['--json']) throw new Error('--json is required');
    if (!flags['--project']) throw new Error('--project is required');
    if (Boolean(flags['--workspace']) !== Boolean(flags['--workspace-member'])) throw new Error('Pass --workspace and --workspace-member together');
    if (command === 'get' && !flags['--bundle']) throw new Error('get requires --bundle');
    if (flags['--lang'] !== undefined && flags['--lang'] !== 'en') throw new Error('--lang is en');
    if ((command === 'show' || command === 'cancel' || decision) && !flags['--run']) throw new Error(`${command} requires --run`);
    const egress = allowHosts.length ? { egress: { allowHosts } } : {};
    if (command === 'run') {
      // J4-01 round 2: an omitted --entry used to silently take the
      // contract's hardcoded index.html default here too (the `start`
      // path's own fix did not cover `run`). Resolve the same default.
      const entry = flags['--entry'] ?? await resolveCliDefaultReviewEntry(flags['--project']!, { flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env: options.env ?? process.env, ...(flags['--workspace'] ? { workspace: flags['--workspace'], workspaceMember: flags['--workspace-member'] } : {}) });
      body = parseRunMechanicalReviewRequest({ entry, ...egress });
    }
    if (command === 'start') {
      const file = flags['--input-file'];
      if (!file) throw new Error('start requires --input-file <path|->');
      const text = file === '-' ? await (options.readStdin ?? stdinText)() : await readFile(file, 'utf8');
      const input: unknown = JSON.parse(text);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The input file must hold a JSON object');
      const named = (input as { projectId?: unknown }).projectId;
      if (named !== undefined && named !== flags['--project']) throw new Error('The input file names a different project');
      if (allowHosts.length && (input as { egress?: unknown }).egress !== undefined) throw new Error('Pass the egress allow-list either in the input file or with --allow-host, not both');
      // J4-01: an input file that omits snapshot.entry used to silently take
      // the contract's hardcoded `index.html` default. Resolve the same
      // smart default the web Start form uses instead.
      const snapshot = (input as { snapshot?: { entry?: unknown } }).snapshot;
      const resolvedInput: Record<string, unknown> = typeof snapshot?.entry === 'string' && snapshot.entry.length > 0
        ? input as Record<string, unknown>
        : {
          ...(input as Record<string, unknown>),
          snapshot: { ...(snapshot ?? {}), entry: await resolveCliDefaultReviewEntry(flags['--project']!, { flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env: options.env ?? process.env, ...(flags['--workspace'] ? { workspace: flags['--workspace'], workspaceMember: flags['--workspace-member'] } : {}) }) },
        };
      body = parseStartReviewRunRequest({ ...resolvedInput, ...egress, projectId: flags['--project'] }) satisfies StartReviewRunRequest;
    }
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error && error.message ? error.message.slice(0, 500) : 'Invalid input' } }); return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/, '');
    const project = flags['--project']!;
    const headers = {
      'x-od-project-id': project,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(command === 'start' ? { 'idempotency-key': flags['--idempotency-key'] ?? `cli-${randomUUID()}` } : {}),
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    };
    const base = `${baseUrl}/api/workbench/projects/${encodeURIComponent(project)}/review`;
    const runUrl = (id: string) => `${baseUrl}/api/workbench/reviews/${encodeURIComponent(id)}`;
    const url = command === 'accept' || command === 'dismiss' ? `${runUrl(flags['--run']!)}/findings/${encodeURIComponent(findingId!)}/decision` : command === 'run' ? `${base}/mechanical`
      : command === 'list' ? `${base}/bundles`
        : command === 'get' ? `${base}/bundles/${encodeURIComponent(flags['--bundle']!)}`
          : command === 'start' ? `${baseUrl}/api/workbench/reviews`
            : command === 'show' ? runUrl(flags['--run']!)
              : command === 'cancel' ? `${runUrl(flags['--run']!)}/cancel`
                : `${baseUrl}/api/workbench/projects/${encodeURIComponent(project)}/reviews`;
    const method = ['run', 'start', 'cancel', 'accept', 'dismiss'].includes(command) ? 'POST' : 'GET';
    const response = await fetchWithScopedToolToken(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    const payload: unknown = await response.json();
    if (!response.ok) {
      if (!payload || typeof payload !== 'object' || !('error' in payload)) throw new Error('Malformed daemon error response');
      write({ ...payload, status: response.status });
      return response.status === 400 || response.status === 422 ? 2 : [401, 403, 404, 409, 429].includes(response.status) ? 3 : 1;
    }
    if (command === 'list') { const list = parseVerificationBundleList(payload); if (list.projectId !== project) throw new Error(); write(list); return 0; }
    if (command === 'runs') { const list = parseReviewRunList(payload); if (list.projectId !== project) throw new Error(); write(list); return 0; }
    if (command === 'start' || command === 'show' || command === 'cancel' || command === 'accept' || command === 'dismiss') {
      let view = parseReviewRunView(payload);
      if (view.run.projectId !== project) throw new Error('Response is for another project');
      if (command === 'start' && flags['--wait']) {
        const until = Date.now() + WAIT_LIMIT_MS;
        while (view.run.outcome === null && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const next = await fetchWithScopedToolToken(runUrl(view.run.id), { headers: { ...headers, 'content-type': 'application/json' } }, env);
          if (!next.ok) throw new Error('The run could not be read while waiting');
          view = parseReviewRunView(await next.json());
        }
        write(view);
        return view.run.outcome === null ? 124 : reviewRunExitCode(view);
      }
      write(view);
      return 0;
    }
    const bundle = parseVerificationBundle(payload);
    if (bundle.projectId !== project) throw new Error('Response is for another project');
    const lang = flags['--lang'] as ReviewEvidenceLocale | undefined;
    write(lang ? { ...bundle, text: renderVerificationBundleText(bundle, lang) } : bundle);
    if (command === 'get') return 0;
    return bundle.outcome === 'passed' ? 0 : bundle.outcome === 'failed' ? 4 : 5;
  } catch {
    write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid review response' } }); return 1;
  }
}
