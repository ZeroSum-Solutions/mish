import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  createCaptureDraftRequestSchema, parseCaptureDraftList, parseCaptureDraftRevision, WORKBENCH_CAPTURE_DRAFT_ID_PATTERN,
  type CaptureDraftRevision, type CreateCaptureDraftRequest,
} from '@mish/contracts';
import { mayForwardScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';
import type { WorkbenchCliOptions } from '../workbench-cli.js';

export const CAPTURE_DRAFT_CLI_HELP = [
  'od workbench draft-from-capture create --input-file <path|-> [--prompt-file <path|->] [--idempotency-key <key>] [--wait] --json',
  'od workbench draft-from-capture list --project <id> --json',
  'od workbench draft-from-capture show --project <id> --id <draftId> --revision <positive integer> --json',
  'Input: {"projectId":"p","captureId":"cap_…","prompt":"Recreate the visible layout.","parent":{"draftId":"draft_…","revision":1}}',
  'The optional parent identifies the exact persisted revision to iterate. --wait polls that revision for at most two minutes.',
  '--prompt-file supplies plain-text instructions, overriding prompt in the JSON input. Only one input may use stdin.',
  'Optional: --workspace <id> --workspace-member <id> --daemon-url <url>',
  'Exit codes: 0 accepted or ready; 2 invalid input; 3 daemon refusal, failed draft or wait timeout; 1 transport/server failure',
].join('\n');
const FLAGS: Record<string, string[]> = { create: ['--input-file', '--prompt-file', '--idempotency-key'], list: ['--project'], show: ['--project', '--id', '--revision'] };
const KEY = /^[A-Za-z0-9._:-]{1,200}$/u;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_WAIT_POLLS = 120;

class CliInputError extends Error {}

function parseFlags(args: string[], command: string): Record<string, string> {
  if (!Object.hasOwn(FLAGS, command)) throw new CliInputError('Use draft-from-capture create, list or show');
  const allowed = [...FLAGS[command]!, '--workspace', '--workspace-member', '--daemon-url'];
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const name = args[i]!;
    if (Object.hasOwn(flags, name)) throw new CliInputError(`Duplicate option: ${name}`);
    if (name === '--json' || (name === '--wait' && command === 'create')) { flags[name] = 'true'; continue; }
    if (!allowed.includes(name)) throw new CliInputError(`Unknown option: ${name}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new CliInputError(`${name} requires a value`);
    flags[name] = value;
  }
  if (!flags['--json']) throw new CliInputError('--json is required');
  for (const field of ['--project', '--workspace', '--workspace-member']) {
    const value = flags[field];
    if (value !== undefined && (value !== value.trim() || /\p{Cc}/u.test(value) || value.length > 200)) throw new CliInputError(`${field} must be nonempty trimmed text without control characters`);
  }
  if ('--workspace' in flags !== '--workspace-member' in flags) throw new CliInputError('Pass --workspace and --workspace-member together');
  if (command !== 'create' && !flags['--project']) throw new CliInputError(`${command} requires --project`);
  if (command === 'show') {
    if (!WORKBENCH_CAPTURE_DRAFT_ID_PATTERN.test(flags['--id'] ?? '')) throw new CliInputError('show requires a valid --id');
    if (!/^[1-9][0-9]*$/u.test(flags['--revision'] ?? '') || !Number.isSafeInteger(Number(flags['--revision']))) throw new CliInputError('show requires a positive integer --revision');
  }
  if (flags['--idempotency-key'] && !KEY.test(flags['--idempotency-key'])) throw new CliInputError('Invalid --idempotency-key');
  return flags;
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES) throw new CliInputError('The input exceeds 128 KiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readText(source: string, options: WorkbenchCliOptions): Promise<string> {
  if (source !== '-') {
    const info = await stat(source);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new CliInputError('The input must be a regular file of at most 128 KiB');
  }
  const input = source === '-' ? await (options.readStdin ?? stdinText)() : await readFile(source, 'utf8');
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new CliInputError('The input exceeds 128 KiB');
  return input;
}

async function readInput(source: string | undefined, promptSource: string | undefined, options: WorkbenchCliOptions): Promise<CreateCaptureDraftRequest> {
  if (!source) throw new CliInputError('create requires --input-file');
  if (source === '-' && promptSource === '-') throw new CliInputError('--input-file and --prompt-file cannot both read stdin');
  const input = await readText(source, options);
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { throw new CliInputError('Input is not valid JSON'); }
  if (promptSource !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CliInputError('The input must be a draft request object');
    raw = { ...raw, prompt: await readText(promptSource, options) };
  }
  const parsed = createCaptureDraftRequestSchema.safeParse(raw);
  if (!parsed.success) throw new CliInputError('The input does not match the capture draft request contract');
  return parsed.data;
}

/** JSON-only transport parity with the workbench screenshot draft panel. */
export async function runCaptureDraftCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { write({ usage: CAPTURE_DRAFT_CLI_HELP }); return args.length === 0 ? 2 : 0; }
  const command = args[0]!;
  let flags: Record<string, string>;
  let input: CreateCaptureDraftRequest | undefined;
  try {
    flags = parseFlags(args, command);
    if (command === 'create') input = await readInput(flags['--input-file'], flags['--prompt-file'], options);
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid input' } }); return 2;
  }

  try {
    const env = options.env ?? process.env;
    const base = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const projectId = input?.projectId ?? flags['--project']!;
    const headers: Record<string, string> = {
      'x-od-client': 'cli', 'x-od-project-id': projectId,
      ...(env.OD_TOOL_TOKEN && mayForwardScopedToolToken(base, env.OD_TOOL_TOKEN_ISSUER_ORIGIN) ? { authorization: `Bearer ${env.OD_TOOL_TOKEN}` } : {}),
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    };
    const query = `?projectId=${encodeURIComponent(projectId)}`;
    const showPath = (draftId: string, revision: number) => `/api/workbench/capture-drafts/${encodeURIComponent(draftId)}/revisions/${revision}${query}`;
    const call = async (route: string, body?: CreateCaptureDraftRequest, timeoutMs = 10_000) => {
      const result = await fetch(`${base}${route}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'idempotency-key': flags['--idempotency-key'] ?? `cli-${randomUUID()}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload: unknown = await result.json();
      if (!result.ok) {
        if (!payload || typeof payload !== 'object' || !('error' in payload)) throw new Error('Malformed daemon refusal');
        write({ status: result.status, ...payload });
        return { refused: result.status >= 400 && result.status < 500 ? 3 : 1 };
      }
      return { payload };
    };
    if (command === 'list') {
      const result = await call(`/api/workbench/capture-drafts${query}`);
      if ('refused' in result) return result.refused!;
      const list = parseCaptureDraftList(result.payload);
      if (list.drafts.some(draft => draft.projectId !== projectId)) throw new Error('Project response mismatch');
      write(list); return 0;
    }
    const result = await call(command === 'create' ? '/api/workbench/capture-drafts' : showPath(flags['--id']!, Number(flags['--revision'])), input);
    if ('refused' in result) return result.refused!;
    let draft: CaptureDraftRevision = parseCaptureDraftRevision(result.payload);
    if (draft.projectId !== projectId || (input && draft.captureId !== input.captureId) || (command === 'show' && (draft.draftId !== flags['--id'] || draft.revision !== Number(flags['--revision'])))) throw new Error('Revision response mismatch');
    const identity = { draftId: draft.draftId, revision: draft.revision, captureId: draft.captureId };
    if (!flags['--wait']) { write(draft); return 0; }
    const deadline = Date.now() + 120_000;
    const timedOut = () => {
      write({ error: { code: 'draft-wait-timeout', message: 'Draft generation is still pending; resume with draft-from-capture show.', draftId: identity.draftId, revision: identity.revision, projectId } }); return 3;
    };
    for (let poll = 0; draft.status === 'pending' && poll < MAX_WAIT_POLLS && Date.now() < deadline; poll++) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      if (Date.now() >= deadline) return timedOut();
      let next: Awaited<ReturnType<typeof call>>;
      try { next = await call(showPath(identity.draftId, identity.revision), undefined, Math.min(10_000, deadline - Date.now())); }
      catch (error) { if (Date.now() >= deadline) return timedOut(); throw error; }
      if ('refused' in next) return next.refused!;
      draft = parseCaptureDraftRevision(next.payload);
      if (draft.projectId !== projectId || draft.draftId !== identity.draftId || draft.revision !== identity.revision || draft.captureId !== identity.captureId) throw new Error('Revision response mismatch');
    }
    if (draft.status === 'pending') return timedOut();
    write(draft); return draft.status === 'failed' ? 3 : 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid capture draft response' } }); return 1; }
}
