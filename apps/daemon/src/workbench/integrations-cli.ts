import { readFile } from 'node:fs/promises';
import { parseConnectorInventory, parseIntegrationRoster, parseIntegrationRosterEntry, parseLicenceDraft, parseLicenceRecordSnapshot } from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';

export interface IntegrationsCliOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  write?: (value: unknown) => void;
}
export const INTEGRATIONS_HELP = [
  'od integrations status|test <id> [--daemon-url <url>] --json',
  'od workbench integrations [--daemon-url <url>] --json',
  'od workbench connector inventory get [--daemon-url <url>] --json',
  'od workbench licence get|set --source react-bits [--expected-revision <n> --input-file <path|->] [--daemon-url <url>] --json',
].join('\n');

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
type Command = { kind: 'test'; id: string } | { kind: 'roster' } | { kind: 'inventory' } | { kind: 'licence-get'; source: string } | { kind: 'licence-set'; source: string; expectedRevision: number; inputFile: string };
function parse(args: string[]): { command: Command; daemonUrl: string | undefined } {
  const [head, ...rest] = args;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const valued = ['--daemon-url', '--source', '--expected-revision', '--input-file'];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) { positional.push(token); continue; }
    if (token in flags) throw new Error(`Duplicate option: ${token}`);
    if (token === '--json') { flags[token] = 'true'; continue; }
    if (!valued.includes(token)) throw new Error(`Unknown option: ${token}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    flags[token] = value;
  }
  if (!flags['--json']) throw new Error('--json is required');
  const daemonUrl = flags['--daemon-url'];
  const only = (allowed: string[]) => { for (const flag of Object.keys(flags)) if (![...allowed, '--json', '--daemon-url'].includes(flag)) throw new Error(`Unknown option: ${flag}`); };
  if (head === 'integrations' && (positional.length === 0 || positional.join(' ') === 'status')) { only([]); return { command: { kind: 'roster' }, daemonUrl }; }
  if (head === 'integrations' && positional.length === 2 && positional[0] === 'test' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(positional[1]!)) { only([]); return { command: { kind: 'test', id: positional[1]! }, daemonUrl }; }
  if (head === 'connector' && positional.join(' ') === 'inventory get') { only([]); return { command: { kind: 'inventory' }, daemonUrl }; }
  if (head === 'licence' && positional.length === 1 && ['get', 'set'].includes(positional[0]!)) {
    const source = flags['--source'];
    if (!source) throw new Error('--source is required');
    if (positional[0] === 'get') { only(['--source']); return { command: { kind: 'licence-get', source }, daemonUrl }; }
    only(['--source', '--expected-revision', '--input-file']);
    const raw = flags['--expected-revision'];
    if (!raw || !/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--expected-revision must be a nonnegative integer');
    if (!flags['--input-file']) throw new Error('--input-file is required');
    return { command: { kind: 'licence-set', source, expectedRevision: Number(raw), inputFile: flags['--input-file'] }, daemonUrl };
  }
  throw new Error('Use workbench integrations, connector inventory get, or licence get|set');
}

/**
 * Same endpoints and DTOs as Settings. An agent run's OD_TOOL_TOKEN is sent, so a
 * cooperative agent's licence write is refused; a same-user process that drops the token
 * is not blocked, and its write is recorded with the `cli` or `http` surface label.
 */
export async function runIntegrationsCli(args: string[], options: IntegrationsCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  let parsed: ReturnType<typeof parse>;
  let body: string | undefined;
  try {
    parsed = parse(args);
    if (parsed.command.kind === 'licence-set') {
      const file = parsed.command.inputFile;
      const text = file === '-' ? await (options.readStdin ?? stdinText)() : await readFile(file, 'utf8');
      body = JSON.stringify({ expectedRevision: parsed.command.expectedRevision, draft: parseLicenceDraft(JSON.parse(text)) });
    }
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message : 'Invalid input' } });
    return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: parsed.daemonUrl ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const { command } = parsed;
    const path = command.kind === 'test' ? `/api/workbench/integrations/${encodeURIComponent(command.id)}/test` : command.kind === 'roster' ? '/api/workbench/integrations'
      : command.kind === 'inventory' ? '/api/workbench/connectors/inventory'
        : `/api/workbench/licences/${encodeURIComponent(command.source)}`;
    const response = await fetchWithScopedToolToken(`${baseUrl}${path}`, {
      method: command.kind === 'test' ? 'POST' : command.kind === 'licence-set' ? 'PUT' : 'GET',
      // x-od-client is a label the daemon records as the write surface, not authentication.
      headers: { 'x-od-client': 'cli', ...(body ? { 'content-type': 'application/json' } : {}), },
      ...(body ? { body } : {}),
    }, env);
    const value: unknown = await response.json();
    if (!response.ok) {
      if (!value || typeof value !== 'object' || !('error' in value)) throw new Error('Malformed daemon error response');
      write({ status: response.status, ...value });
      return response.status === 400 ? 2 : [401, 403, 404, 409, 422].includes(response.status) ? 3 : 1;
    }
    write(command.kind === 'test' ? parseIntegrationRosterEntry(value) : command.kind === 'roster' ? parseIntegrationRoster(value) : command.kind === 'inventory' ? parseConnectorInventory(value) : parseLicenceRecordSnapshot(value));
    return command.kind === 'test' && parseIntegrationRosterEntry(value).runtime?.workflow.lastTest?.outcome === 'failed' ? 1 : 0;
  } catch {
    write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid workbench response' } });
    return 1;
  }
}
