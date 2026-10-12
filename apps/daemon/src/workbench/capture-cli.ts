import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  encodeCaptureMetadataHeader, parseCaptureImportMetadata, parseCaptureList, parseCaptureView, parseReusableUnitManifest,
  parseUnitInsertRequest, parseUnitInsertReceipt, parseUnitInsertList, WORKBENCH_UNIT_ID_PATTERN, WORKBENCH_UNIT_INSERT_ID_PATTERN, parseUnitList, parseUnitSavePlan, parseUnitSaveRequest, WORKBENCH_CAPTURE_MAX_BYTES, WORKBENCH_CAPTURE_METADATA_HEADER,
} from '@mish/contracts';
import { mayForwardScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';
import type { WorkbenchCliOptions } from '../workbench-cli.js';

const CAPTURE_HELP = [
  'od workbench capture import --file <png|jpg|webp> --metadata-file <path|-> [--idempotency-key <key>] --json',
  'od workbench capture list --project <id> [--cursor <cursor>] --json',
  'od workbench capture show --project <id> --id <captureId> --json',
  'od workbench capture take --project <id> --json   (unsupported here: native capture needs the desktop browser canvas; import a file instead)',
  'Metadata: {"projectId":"p","captureMode":"upload","frame":{"width":1440,"height":900},"sourceUrl":"https://example.com/"}',
  'Optional: --workspace <id> --workspace-member <id> --daemon-url <url>',
  'Exit codes: 0 success; 2 invalid input; 3 refused by the daemon (400-422) or unsupported; 1 transport or server failure',
].join('\n');
const UNIT_HELP = [
  'od workbench unit plan --input-file <path|-> --json',
  'od workbench unit save --input-file <path|-> [--idempotency-key <key>] --json',
  'od workbench unit insert <unitId> --project <id> [--idempotency-key <key>] [--json]',
  'od workbench unit insertions <unitId> [--json]',
  'od workbench unit undo-insert <insertId> [--discard-edits] [--json]',
  'od workbench unit list --json',
  'od workbench unit show --id <unitId> --json',
  'Input: {"source":{"kind":"project","projectId":"p","entry":"index.html","paths":["index.html","styles.css"],"rootSelector":"#hero","expectedHashes":{…from plan…}},"kind":"section","name":"Hero","rightsDeclaration":{"basis":"user-owned","evidenceRefs":["…"],"notices":[]},"excludePaths":[]}',
  'Saving never installs dependencies; captured third-party files must be excluded or declared as yours for that exact path.',
  'Optional: --workspace <id> --workspace-member <id> --daemon-url <url>',
  'Exit codes: 0 success; 2 invalid input; 3 refused by the daemon (400-422); 1 transport or server failure',
].join('\n');

const CAPTURE_FLAGS: Record<string, string[]> = { import: ['--file', '--metadata-file', '--idempotency-key'], list: ['--project', '--cursor'], show: ['--project', '--id'], take: ['--project'] };
const UNIT_FLAGS: Record<string, string[]> = { plan: ['--input-file'], save: ['--input-file', '--idempotency-key'], list: [], show: ['--id'], insert: ['--project', '--idempotency-key'], 'undo-insert': ['--discard-edits'], insertions: [] };
const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

class CliInputError extends Error {}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function parseFlags(args: string[], allowedForCommand: string[], jsonRequired = true): Record<string, string> {
  const allowed = ['--workspace', '--workspace-member', '--daemon-url', ...allowedForCommand];
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (Object.hasOwn(flags, flag)) throw new CliInputError(`Duplicate option: ${flag}`);
    if (flag === '--json') { flags[flag] = 'true'; continue; }
    if (flag === '--discard-edits' && allowedForCommand.includes(flag)) { flags[flag] = 'true'; continue; }
    if (!allowed.includes(flag)) throw new CliInputError(`Unknown option: ${flag}`);
    const value = args[++i];
    if (value === undefined || (value.startsWith('--') && value !== '-')) throw new CliInputError(`${flag} requires a value`);
    flags[flag] = value;
  }
  if (jsonRequired && !flags['--json']) throw new CliInputError('--json is required');
  if ('--workspace' in flags !== '--workspace-member' in flags) throw new CliInputError('Pass --workspace and --workspace-member together');
  return flags;
}

async function readJsonInput(source: string | undefined, options: WorkbenchCliOptions): Promise<unknown> {
  if (!source) throw new CliInputError('An input file is required');
  const text = source === '-' ? await (options.readStdin ?? stdinText)() : await readFile(source, 'utf8');
  try { return JSON.parse(text); } catch { throw new CliInputError('Input is not valid JSON'); }
}

async function request(flags: Record<string, string>, options: WorkbenchCliOptions, method: string, pathName: string, init: { headers?: Record<string, string>; body?: string | Uint8Array; projectId?: string } = {}) {
  const env = options.env ?? process.env;
  const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
  const headers: Record<string, string> = {
    'x-od-client': 'cli',
    ...(env.OD_TOOL_TOKEN && mayForwardScopedToolToken(baseUrl, env.OD_TOOL_TOKEN_ISSUER_ORIGIN) ? { authorization: `Bearer ${env.OD_TOOL_TOKEN}` } : {}),
    ...(init.projectId ? { 'x-od-project-id': init.projectId } : {}),
    ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    ...init.headers,
  };
  const response = await fetch(`${baseUrl}${pathName}`, { method, redirect: 'error', headers, ...(init.body ? { body: init.body } : {}) });
  const body: unknown = await response.json();
  return { status: response.status, ok: response.ok, body };
}

function refusal(write: (value: unknown) => void, status: number, body: unknown): number {
  if (!body || typeof body !== 'object' || !('error' in body)) throw new Error('Malformed daemon error response');
  write({ status, ...body });
  return status >= 400 && status < 500 ? 3 : 1;
}

/** `od workbench capture …` — same /api/workbench/captures endpoints as the web capture panel. */
export async function runCaptureCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { write({ usage: CAPTURE_HELP }); return args.length === 0 ? 2 : 0; }
  const command = args[0]!;
  let flags: Record<string, string>;
  let upload: { bytes: Buffer; mediaType: string; metadata: ReturnType<typeof parseCaptureImportMetadata> } | null = null;
  try {
    if (!Object.hasOwn(CAPTURE_FLAGS, command)) throw new CliInputError('Use capture import, list, show or take');
    flags = parseFlags(args, CAPTURE_FLAGS[command]!);
    if (command === 'take') {
      write({ error: { code: 'unsupported-capability', message: 'Native capture runs in the desktop browser canvas (Save capture for reuse). From the CLI, import a screenshot file instead.' } });
      return 3;
    }
    if ((command === 'list' || command === 'show') && !flags['--project']) throw new CliInputError(`${command} requires --project`);
    if (command === 'show' && !flags['--id']) throw new CliInputError('show requires --id');
    if (command === 'import') {
      const file = flags['--file'];
      if (!file) throw new CliInputError('import requires --file');
      const mediaType = MEDIA[path.extname(file).toLowerCase()];
      if (!mediaType) throw new CliInputError('The capture file must be .png, .jpg, .jpeg or .webp');
      const info = await stat(file);
      if (!info.isFile() || info.size > WORKBENCH_CAPTURE_MAX_BYTES) throw new CliInputError(`The capture file must be a regular file of at most ${WORKBENCH_CAPTURE_MAX_BYTES} bytes`);
      const metadata = parseCaptureImportMetadata(await readJsonInput(flags['--metadata-file'], options));
      upload = { bytes: await readFile(file), mediaType, metadata };
    }
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid input' } });
    return 2;
  }
  try {
    let result;
    if (upload) {
      const projectId = upload.metadata.projectId;
      result = await request(flags, options, 'POST', `/api/workbench/captures?projectId=${encodeURIComponent(projectId)}`, {
        projectId, body: new Uint8Array(upload.bytes),
        headers: { 'content-type': upload.mediaType, [WORKBENCH_CAPTURE_METADATA_HEADER]: encodeCaptureMetadataHeader(upload.metadata), 'idempotency-key': flags['--idempotency-key'] ?? `cli-${randomUUID()}` },
      });
      if (!result.ok) return refusal(write, result.status, result.body);
      write(parseCaptureView(result.body)); return 0;
    }
    const projectId = flags['--project']!;
    if (command === 'list') {
      result = await request(flags, options, 'GET', `/api/workbench/captures?projectId=${encodeURIComponent(projectId)}${flags['--cursor'] ? `&cursor=${encodeURIComponent(flags['--cursor'])}` : ''}`, { projectId });
      if (!result.ok) return refusal(write, result.status, result.body);
      write(parseCaptureList(result.body)); return 0;
    }
    result = await request(flags, options, 'GET', `/api/workbench/captures/${encodeURIComponent(flags['--id']!)}?projectId=${encodeURIComponent(projectId)}`, { projectId });
    if (!result.ok) return refusal(write, result.status, result.body);
    write(parseCaptureView(result.body)); return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid workbench response' } }); return 1; }
}

/** `od workbench unit …` — same /api/workbench/units endpoints as the web unit panel. */
export async function runUnitCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { write({ usage: UNIT_HELP }); return args.length === 0 ? 2 : 0; }
  const command = args[0]!;
  let flags: Record<string, string>;
  let input: ReturnType<typeof parseUnitSaveRequest> | null = null;
  const insertion = command === 'insert' || command === 'undo-insert' || command === 'insertions';
  const id = insertion ? args[1] : undefined;
  try {
    if (!Object.hasOwn(UNIT_FLAGS, command)) throw new CliInputError('Use unit plan, save, list, show, insert or undo-insert');
    flags = parseFlags(insertion ? [command, ...args.slice(2)] : args, UNIT_FLAGS[command]!, !insertion);
    if (insertion && (!id || !(command === 'undo-insert' ? WORKBENCH_UNIT_INSERT_ID_PATTERN : WORKBENCH_UNIT_ID_PATTERN).test(id))) throw new CliInputError('Pass a valid unit or insertion ID');
    if (command === 'insert') parseUnitInsertRequest({ projectId: flags['--project'] });
    if (command === 'show' && !flags['--id']) throw new CliInputError('show requires --id');
    if (command === 'plan' || command === 'save') input = parseUnitSaveRequest(await readJsonInput(flags['--input-file'], options));
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid input' } });
    return 2;
  }
  try {
    if (command === 'insertions') {
      const result = await request(flags, options, 'GET', `/api/workbench/units/${encodeURIComponent(id!)}/inserts`);
      if (!result.ok) return refusal(write, result.status, result.body);
      write(parseUnitInsertList(result.body)); return 0;
    }
    if (insertion) {
      const result = await request(flags, options, 'POST', command === 'insert' ? `/api/workbench/units/${encodeURIComponent(id!)}/insert` : `/api/workbench/unit-inserts/${encodeURIComponent(id!)}/undo`, {
        ...(command === 'insert' ? { projectId: flags['--project'] } : {}),
        body: JSON.stringify(command === 'insert' ? parseUnitInsertRequest({ projectId: flags['--project'] }) : (flags['--discard-edits'] ? { discardEdits: true } : {})),
        headers: { 'content-type': 'application/json', ...(command === 'insert' ? { 'idempotency-key': flags['--idempotency-key'] ?? `cli-${randomUUID()}` } : {}) },
      });
      if (!result.ok) return refusal(write, result.status, result.body);
      write(parseUnitInsertReceipt(result.body)); return 0;
    }
    const projectId = input?.source.kind === 'project' ? input.source.projectId : undefined;
    if (command === 'plan' || command === 'save') {
      const result = await request(flags, options, 'POST', command === 'plan' ? '/api/workbench/units/plan' : '/api/workbench/units', {
        ...(projectId ? { projectId } : {}), body: JSON.stringify(input),
        headers: { 'content-type': 'application/json', ...(command === 'save' ? { 'idempotency-key': flags['--idempotency-key'] ?? `cli-${randomUUID()}` } : {}) },
      });
      if (!result.ok) return refusal(write, result.status, result.body);
      write(command === 'plan' ? parseUnitSavePlan(result.body) : parseReusableUnitManifest(result.body)); return 0;
    }
    if (command === 'list') {
      const result = await request(flags, options, 'GET', '/api/workbench/units');
      if (!result.ok) return refusal(write, result.status, result.body);
      write(parseUnitList(result.body)); return 0;
    }
    const result = await request(flags, options, 'GET', `/api/workbench/units/${encodeURIComponent(flags['--id']!)}`);
    if (!result.ok) return refusal(write, result.status, result.body);
    write(parseReusableUnitManifest(result.body)); return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid workbench response' } }); return 1; }
}
