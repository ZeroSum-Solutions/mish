import { readFile } from 'node:fs/promises';
import {
  parseAdoptionOperationResponse, parseApplyAdoptionRequest, parseCatalogueAdoptionRequest, parseCatalogueAdoptionResponse, parseCatalogueSaveRequest,
  parseCatalogueSavedUnitDeleteResponse, parseCatalogueSavedUnitResponse, parseCatalogueSavedUnitsResponse, parsePrepareAdoptionRequest, parsePrepareAdoptionResponse,
  parseWorkbenchAdoptionStatusResponse,
} from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../../daemon-url.js';

export interface AdoptionCliOptions {
  baseUrl?: string; env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>; write?: (value: unknown) => void;
}
const USAGE = [
  'od workbench adoption prepare --request-file <path|-> --json',
  'od workbench adoption catalogue-prepare --ref <refKey> --project <id> --entry <path> [--target-dir <path>] [--accept-replacement <sha256>] [--saved-unit <id>] --json',
  'od workbench adoption catalogue-save --project <id> --operation <applyOperationId> --json',
  'od workbench adoption catalogue-saved --ref <refKey> --json',
  'od workbench adoption catalogue-saved delete <id> --json',
  'od workbench adoption plan --plan <id> --json',
  'od workbench adoption apply --plan <id> --digest <sha256> --json',
  'od workbench adoption show --operation <id> --json',
  'od workbench adoption undo --operation <id> --json',
  'od workbench adoption status --json',
  'Common: [--daemon-url <url>] [--workspace <id> --workspace-member <id>]',
].join('\n');
type Command = 'prepare' | 'catalogue-prepare' | 'catalogue-save' | 'catalogue-saved' | 'catalogue-saved-delete' | 'plan' | 'apply' | 'show' | 'undo' | 'status';
const FLAGS: Record<Command, readonly string[]> = {
  prepare: ['--request-file'], 'catalogue-prepare': ['--ref', '--project', '--entry'], 'catalogue-save': ['--project', '--operation'], 'catalogue-saved': ['--ref'], 'catalogue-saved-delete': ['--id'], plan: ['--plan'], apply: ['--plan', '--digest'], show: ['--operation'], undo: ['--operation'], status: [],
};
const OPTIONAL_FLAGS: Partial<Record<Command, readonly string[]>> = { 'catalogue-prepare': ['--target-dir', '--accept-replacement', '--saved-unit'] };
class CliInputError extends Error {}

function parse(input: string[]): { command: Command; flags: Record<string, string> } {
  // `catalogue-saved delete <id>` is the positional form of the internal `catalogue-saved-delete --id <id>`.
  const args = input[0] === 'catalogue-saved' && input[1] === 'delete' ? ['catalogue-saved-delete', '--id', input[2] ?? '', ...input.slice(3)] : input;
  const [command, ...rest] = args;
  if (!command || !(command in FLAGS)) throw new CliInputError('Use adoption prepare, catalogue-prepare, catalogue-save, catalogue-saved, plan, apply, show, undo or status');
  const allowed = ['--daemon-url', '--workspace', '--workspace-member', ...FLAGS[command as Command], ...(OPTIONAL_FLAGS[command as Command] ?? [])];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag in flags) throw new CliInputError(`Duplicate option: ${flag}`);
    if (flag === '--json') { flags[flag] = 'true'; continue; }
    if (!allowed.includes(flag)) throw new CliInputError(`Unknown option: ${flag}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
    flags[flag] = value;
  }
  if (!flags['--json'] && !['prepare', 'catalogue-prepare', 'apply'].includes(command)) throw new CliInputError('--json is required');
  for (const flag of FLAGS[command as Command]) if (!flags[flag]) throw new CliInputError(`${command} requires ${flag}`);
  if (('--workspace' in flags) !== ('--workspace-member' in flags)) throw new CliInputError('Pass --workspace and --workspace-member together');
  return { command: command as Command, flags };
}
async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** `od workbench adoption …`: the same `/api/workbench/adoption` endpoints and DTOs as the UI. */
export async function runAdoptionCli(args: string[], options: AdoptionCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`));
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) { write({ usage: USAGE }); return args.length ? 0 : 2; }
  let parsed: ReturnType<typeof parse>; let body: unknown;
  try {
    parsed = parse(args);
    const { command, flags } = parsed;
    if (command === 'prepare') {
      const source = flags['--request-file']!;
      body = parsePrepareAdoptionRequest(JSON.parse(source === '-' ? await (options.readStdin ?? stdinText)() : await readFile(source, 'utf8')));
    } else if (command === 'catalogue-prepare') {
      body = parseCatalogueAdoptionRequest({
        projectId: flags['--project'], refKey: flags['--ref'], entryPath: flags['--entry'],
        ...(flags['--target-dir'] ? { targetDir: flags['--target-dir'] } : {}), ...(flags['--accept-replacement'] ? { acceptReplacement: flags['--accept-replacement'] } : {}),
        ...(flags['--saved-unit'] ? { savedUnitId: flags['--saved-unit'] } : {}),
      });
    } else if (command === 'catalogue-save') {
      body = parseCatalogueSaveRequest({ projectId: flags['--project'], operationId: flags['--operation'] });
    } else if (command === 'apply') body = parseApplyAdoptionRequest({ planId: flags['--plan'], planDigest: flags['--digest'] });
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof CliInputError ? error.message : 'Invalid adoption request' } });
    return 2;
  }
  try {
    const { command, flags } = parsed;
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/, '');
    const route: readonly [string, string] = ({
      prepare: ['POST', '/prepare'] as const, 'catalogue-prepare': ['POST', '/catalogue/prepare'] as const, apply: ['POST', '/apply'] as const,
      'catalogue-save': ['POST', '/catalogue/save'] as const,
      'catalogue-saved': ['GET', `/catalogue/saved?refKey=${encodeURIComponent(flags['--ref'] ?? '')}`] as const,
      'catalogue-saved-delete': ['DELETE', `/catalogue/saved/${encodeURIComponent(flags['--id'] ?? '')}`] as const,
      plan: ['GET', `/plans/${encodeURIComponent(flags['--plan'] ?? '')}`] as const,
      show: ['GET', `/operations/${encodeURIComponent(flags['--operation'] ?? '')}`] as const,
      undo: ['POST', `/operations/${encodeURIComponent(flags['--operation'] ?? '')}/undo`] as const,
      status: ['GET', '/status'] as const,
    } satisfies Record<Command, readonly [string, string]>)[command];
    const headers: Record<string, string> = {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    };
    const response = await fetchWithScopedToolToken(`${baseUrl}/api/workbench/adoption${route[1]}`, { method: route[0], headers, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    const payload: unknown = await response.json();
    if (!response.ok) {
      if (!payload || typeof payload !== 'object' || !('error' in payload)) throw new Error('Malformed daemon error response');
      const error = (payload as { error?: unknown }).error;
      const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : null;
      const placement = details && typeof details === 'object' ? details as { kind?: unknown; reason?: unknown; gates?: unknown } : null;
      const gates = Array.isArray(placement?.gates) ? placement.gates.filter((gate): gate is string => typeof gate === 'string') : [];
      if (!flags['--json'] && response.status === 422 && (command === 'prepare' || command === 'catalogue-prepare' || command === 'apply')
        && (placement?.reason === 'adoption-executor-unprovisioned' || gates.includes('adoption-executor-unprovisioned'))) {
        write('Apply is off on this machine. Apply needs the placement helper, which is off here. Use Copy code, or start Mishh with apply enabled (see setup).');
        write(`Reason: ${String(placement?.reason ?? 'unsupported-capability')}${gates.length ? ` (${gates.join(', ')})` : ''}`);
        return 3;
      }
      write({ status: response.status, ...payload });
      return response.status === 400 ? 2 : [401, 403, 404, 409, 422].includes(response.status) ? 3 : 1;
    }
    write(command === 'status' ? parseWorkbenchAdoptionStatusResponse(payload)
      : command === 'catalogue-prepare' ? parseCatalogueAdoptionResponse(payload)
      : command === 'catalogue-save' ? parseCatalogueSavedUnitResponse(payload)
      : command === 'catalogue-saved' ? parseCatalogueSavedUnitsResponse(payload)
      : command === 'catalogue-saved-delete' ? parseCatalogueSavedUnitDeleteResponse(payload)
      : command === 'prepare' || command === 'plan' ? parsePrepareAdoptionResponse(payload) : parseAdoptionOperationResponse(payload));
    return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid adoption response' } }); return 1; }
}
