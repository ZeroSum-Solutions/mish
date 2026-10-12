import { readFile } from 'node:fs/promises';
import {
  isBriefTransformerLane, type BriefTransformerStatusResponse,
  parseDesignBriefPreview, parsePreviewDesignBriefRequest, parseAttachDesignBriefRequest, parseCreateDesignBriefRequest, parseDesignBriefRecordView, parsePatchDesignBriefRequest, parseRunDesignBriefBinding,
  type DesignBriefRecordView, type RunDesignBriefBinding,
} from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../../daemon-url.js';
import type { WorkbenchCliOptions } from '../../workbench-cli.js';

const HELP = [
  'od workbench transform [--project <id>] --prompt-file <path|-> [--input-file <path|->] [--wait-ms <n>] --json',
  '  Without --project, returns a stateless preview held only by the caller. With --project, saves a project brief.',
  'od workbench brief attach --project <id> --input-file <path|-> --json',
  '  Attach the accepted preview JSON after creating a project; returns accepted revision 2.',
  '  Improve prompt without generating. --input-file JSON: {"selectedReferenceRefs":[…],"overrides":{…},"contextRevision":n}',
  'od workbench brief show|cancel --project <id> --brief <id> --json',
  'od workbench brief edit --project <id> --brief <id> --expected-revision <n> --input-file <path|-> --json',
  '  --input-file JSON: {"edits":{"design.color":"…","sections":["Hero: …"]},"referenceDecisions":[{"id":"chg_1","status":"accepted"}]}',
  'od workbench brief accept --project <id> --brief <id> --expected-revision <n> --json',
  'od workbench brief transformer [--set claude|terra] --json',
  '  Which model writes Improve prompt briefs (Settings → Labs). terra = GPT Terra on OpenRouter, falling back to claude.',
  'Generate with the accepted brief: od run start --project <id> --prompt-file <path|-> --brief <id> --brief-revision <n> --brief-hash <sha256>',
  'Optional: --workspace <id> --workspace-member <id> --daemon-url <url>',
].join('\n');

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** `od run start` flags → the optional `brief` on POST /api/runs. All three flags or none. */
export function runDesignBriefBindingFromFlags(flags: Record<string, unknown>): RunDesignBriefBinding | null {
  const values = [flags.brief, flags['brief-revision'], flags['brief-hash']];
  if (values.every(value => value === undefined)) return null;
  if (values.some(value => typeof value !== 'string' || !value)) throw new Error('Pass --brief, --brief-revision and --brief-hash together');
  return parseRunDesignBriefBinding({ id: flags.brief, revision: Number(flags['brief-revision']), hash: flags['brief-hash'] });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runBriefCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.includes('--help') || args.includes('-h')) { write({ usage: HELP }); return 0; }
  const readStdin = options.readStdin ?? stdinText;
  const readSource = async (source: string) => (source === '-' ? readStdin() : readFile(source, 'utf8'));
  const command = args[0] === 'transform' ? 'transform' : args[0] === 'brief' ? args[1] : undefined;
  const rest = args.slice(args[0] === 'transform' ? 1 : 2);
  let flags: Record<string, string>;
  let request: { method: string; path: string; body?: unknown };
  let waitMs = 120_000;
  try {
    if (!command || !['transform', 'show', 'cancel', 'edit', 'accept', 'attach', 'transformer'].includes(command)) throw new Error();
    const allowed = ['--project', '--workspace', '--workspace-member', '--daemon-url', ...({
      transform: ['--prompt-file', '--input-file', '--wait-ms'], attach: ['--input-file'], show: ['--brief'], cancel: ['--brief'],
      edit: ['--brief', '--expected-revision', '--input-file'], accept: ['--brief', '--expected-revision'], transformer: ['--set'],
    } as Record<string, string[]>)[command]!];
    flags = {};
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]!;
      if (Object.hasOwn(flags, flag)) throw new Error();
      if (flag === '--json') { flags[flag] = 'true'; continue; }
      if (!allowed.includes(flag)) throw new Error();
      const value = rest[++i];
      if (!value || value.trim() !== value || (value.startsWith('--') && value !== '-') || /\p{Cc}/u.test(value)) throw new Error();
      flags[flag] = value;
    }
    if (!flags['--json'] || (command !== 'transform' && command !== 'transformer' && !flags['--project']) || Boolean(flags['--workspace']) !== Boolean(flags['--workspace-member'])) throw new Error();
    if (flags['--prompt-file'] === '-' && flags['--input-file'] === '-') throw new Error();
    const briefPath = () => { if (!flags['--brief']) throw new Error(); return `/api/workbench/briefs/${encodeURIComponent(flags['--brief'])}`; };
    const expected = () => { const raw = flags['--expected-revision']; if (!raw || !/^[1-9][0-9]*$/u.test(raw)) throw new Error(); return Number(raw); };
    if (command === 'transformer') {
      const lane = flags['--set'];
      if (lane !== undefined && !isBriefTransformerLane(lane)) throw new Error();
      // The same single-field write the Labs row makes; the status read follows.
      request = lane ? { method: 'PUT', path: '/api/app-config', body: { improvePromptTransformer: lane } } : { method: 'GET', path: '/api/workbench/briefs/transformer' };
    } else if (command === 'transform') {
      if (!flags['--prompt-file']) throw new Error();
      if (flags['--wait-ms'] !== undefined) { if (!/^[0-9]{1,7}$/u.test(flags['--wait-ms'])) throw new Error(); waitMs = Number(flags['--wait-ms']); }
      const originalText = (await readSource(flags['--prompt-file'])).trim();
      const inputText = flags['--input-file'] ? (await readSource(flags['--input-file'])).trim() : '';
      const input = inputText ? JSON.parse(inputText) as Record<string, unknown> : {};
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      request = flags['--project']
        ? { method: 'POST', path: '/api/workbench/briefs', body: parseCreateDesignBriefRequest({ ...input, projectId: flags['--project'], originalText }) }
        : { method: 'POST', path: '/api/workbench/briefs/preview', body: parsePreviewDesignBriefRequest({ ...input, originalText }) };
    } else if (command === 'attach') {
      if (!flags['--input-file']) throw new Error();
      request = { method: 'POST', path: '/api/workbench/briefs/attach', body: parseAttachDesignBriefRequest({ projectId: flags['--project'], preview: JSON.parse(await readSource(flags['--input-file'])) }) };
    } else if (command === 'show') request = { method: 'GET', path: briefPath() };
    else if (command === 'cancel') request = { method: 'POST', path: `${briefPath()}/cancel` };
    else if (command === 'accept') request = { method: 'PATCH', path: briefPath(), body: parsePatchDesignBriefRequest({ expectedRevision: expected(), accept: true }) };
    else {
      if (!flags['--input-file']) throw new Error();
      const input = JSON.parse(await readSource(flags['--input-file'])) as Record<string, unknown>;
      request = { method: 'PATCH', path: briefPath(), body: parsePatchDesignBriefRequest({ ...input, expectedRevision: expected() }) };
    }
  } catch {
    write({ error: { code: 'invalid-cli-input', message: 'Pass --project and --json, a nonempty prompt or input file, a positive expected revision and paired workspace authority flags; see --help' } });
    return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const headers: Record<string, string> = {
      ...(flags['--project'] ? { 'x-od-project-id': flags['--project'] } : {}),
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    };
    const call = async (method: string, pathName: string, body?: unknown): Promise<{ status: number; ok: boolean; body: unknown }> => {
      const response = await fetchWithScopedToolToken(`${baseUrl}${pathName}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
      return { status: response.status, ok: response.ok, body: await response.json() };
    };
    let result = await call(request.method, request.path, request.body);
    if (!result.ok) {
      if (!result.body || typeof result.body !== 'object' || !('error' in result.body)) throw new Error();
      write({ ...result.body, status: result.status });
      return result.status === 400 ? 2 : [401, 403, 404, 409, 422].includes(result.status) ? 3 : 1;
    }
    if (command === 'transformer') {
      if (request.method === 'PUT') {
        result = await call('GET', '/api/workbench/briefs/transformer');
        if (!result.ok) throw new Error();
      }
      const status = (result.body as BriefTransformerStatusResponse | null)?.status;
      if (!status || !isBriefTransformerLane(status.lane)) throw new Error();
      write({ status });
      return 0;
    }
    if (command === 'transform' && !flags['--project']) {
      write(parseDesignBriefPreview(result.body));
      return 0;
    }
    let record: DesignBriefRecordView = parseDesignBriefRecordView(result.body);
    if (record.projectId !== flags['--project']) throw new Error();
    // Transform waits for the brief (it never starts a run); other commands answer at once.
    const deadline = Date.now() + waitMs;
    while (command === 'transform' && record.status === 'pending' && Date.now() < deadline) {
      await sleep(250);
      result = await call('GET', `/api/workbench/briefs/${encodeURIComponent(record.id)}`);
      if (!result.ok) throw new Error();
      record = parseDesignBriefRecordView(result.body);
    }
    write(record);
    return 0;
  } catch {
    write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid design brief response' } });
    return 1;
  }
}
