import { readFile } from 'node:fs/promises';
import { parseConnectorDetailResponse, parseConnectorSelectionRequest, parseConnectorSearchRequest, parseConnectorSearchResponse } from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../../daemon-url.js';

export interface ConnectorCliOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  write?: (value: unknown) => void;
}
export const CONNECTOR_HELP = [
  'od workbench connector search --connector <id> --prompt-file <path|-> [--kind screens|flows|sections] [--platform ios|web] [--limit <n>] [--daemon-url <url>] --json',
  '  Mobbin needs --kind; screens and flows also need --platform. Other connectors take neither.',
  'od workbench connector select --connector mobbin --item <itemId> --captured-at <timestamp> [--daemon-url <url>] --json',
  'od workbench connector detail --connector <id> --item <itemId> [--daemon-url <url>] --json',
].join('\n');

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * AC-R12.2 od surface over the same POST /api/workbench/connectors/:id/search|detail
 * the canvas uses. Exit codes: 0 ok, 2 invalid input, 3 refused (sign-in, revoked,
 * unfrozen schema, missing daemon binding, unknown item), 75 transient (rate limit, timeout), 1 other failure.
 */
export async function runConnectorCli(args: string[], options: ConnectorCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const [command, ...rest] = args;
  let connector = '', body = '', daemonUrl: string | undefined;
  try {
    if (command !== 'search' && command !== 'detail' && command !== 'select') throw new Error('Use connector search, detail or select');
    const valued = command === 'search' ? ['--connector', '--prompt-file', '--kind', '--platform', '--limit', '--daemon-url'] : command === 'select' ? ['--connector', '--item', '--captured-at', '--daemon-url'] : ['--connector', '--item', '--daemon-url'];
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      if (token in flags) throw new Error(`Duplicate option: ${token}`);
      if (token === '--json') { flags[token] = 'true'; continue; }
      if (!valued.includes(token)) throw new Error(`Unknown option: ${token}`);
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      flags[token] = value;
    }
    if (!flags['--json']) throw new Error('--json is required');
    if (!flags['--connector']) throw new Error('--connector is required');
    connector = flags['--connector']; daemonUrl = flags['--daemon-url'];
    if (command === 'search') {
      const file = flags['--prompt-file'];
      if (!file) throw new Error('--prompt-file is required');
      const query = (file === '-' ? await (options.readStdin ?? stdinText)() : await readFile(file, 'utf8')).trim();
      const limit = flags['--limit'];
      if (limit !== undefined && !/^[1-9][0-9]?$/u.test(limit)) throw new Error('--limit must be a positive integer');
      const kind = flags['--kind'], platform = flags['--platform'];
      body = JSON.stringify(parseConnectorSearchRequest({ query, ...(limit ? { limit: Number(limit) } : {}), ...(kind ? { kind } : {}), ...(platform ? { platform } : {}) }));
    } else {
      if (!flags['--item']) throw new Error('--item is required');
      body = JSON.stringify(command === 'select' ? parseConnectorSelectionRequest({ itemId: flags['--item'], capturedAt: flags['--captured-at'] }) : { itemId: flags['--item'] });
    }
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message : 'Invalid input' } });
    return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: daemonUrl ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const response = await fetchWithScopedToolToken(`${baseUrl}/api/workbench/connectors/${encodeURIComponent(connector)}/${command}`, {
      method: 'POST', headers: { 'content-type': 'application/json', }, body,
    }, env);
    const value: unknown = await response.json();
    if (!response.ok) {
      if (!value || typeof value !== 'object' || !('error' in value)) throw new Error('Malformed daemon error response');
      write({ status: response.status, ...value });
      return response.status === 400 ? 2 : [429, 504].includes(response.status) ? 75 : [401, 403, 404, 409, 422].includes(response.status) ? 3 : 1;
    }
    write(command === 'search' ? parseConnectorSearchResponse(value) : parseConnectorDetailResponse(value));
    return 0;
  } catch {
    write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid connector response' } });
    return 1;
  }
}
