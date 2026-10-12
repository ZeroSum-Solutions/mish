import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { OWNED_IMPORT_LIMITS, parseOwnedImportList, parseOwnedImportRecord, parseOwnedImportRequest } from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../../daemon-url.js';

export interface OwnedImportCliOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  write?: (value: unknown) => void;
}
export const OWNED_IMPORT_HELP = [
  'od workbench import create --provider magic-patterns --name <name> --entry <relative path> --dir <export folder> [--exported-from <https url>] [--daemon-url <url>] --json',
  'od workbench import list [--daemon-url <url>] --json',
  'od workbench import show --id <importId> [--daemon-url <url>] --json',
  'Optional on each: --workspace <id> --workspace-member <id> (the import belongs to that member)',
].join('\n');

/** Regular files under the export folder, skipping hidden entries and symbolic links. */
async function readExport(root: string): Promise<{ path: string; contentBase64: string }[]> {
  const files: { path: string; contentBase64: string }[] = [];
  let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name), rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(full, rel); continue; }
      if (!entry.isFile() || !(await lstat(full)).isFile()) continue;
      const bytes = await readFile(full);
      total += bytes.length;
      if (files.length >= OWNED_IMPORT_LIMITS.files || total > OWNED_IMPORT_LIMITS.bytes) throw new Error('Export exceeds the import limits (64 files, 4 MiB)');
      files.push({ path: rel, contentBase64: bytes.toString('base64') });
    }
  };
  await walk(root, '');
  return files;
}

/** AC-R12.4 od surface over the same /api/workbench/imports routes as the canvas. */
export async function runOwnedImportCli(args: string[], options: OwnedImportCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const [command, ...rest] = args;
  let request: { method: 'GET' | 'POST'; path: string; body?: string } = { method: 'GET', path: '/api/workbench/imports' };
  let daemonUrl: string | undefined;
  let workspace: Record<string, string> = {};
  try {
    const valued: Record<string, string[]> = { create: ['--provider', '--name', '--entry', '--dir', '--exported-from'], list: [], show: ['--id'] };
    if (!command || !(command in valued)) throw new Error('Use import create, list or show');
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      if (token in flags) throw new Error(`Duplicate option: ${token}`);
      if (token === '--json') { flags[token] = 'true'; continue; }
      if (![...valued[command]!, '--daemon-url', '--workspace', '--workspace-member'].includes(token)) throw new Error(`Unknown option: ${token}`);
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      flags[token] = value;
    }
    if (!flags['--json']) throw new Error('--json is required');
    if (Boolean(flags['--workspace']) !== Boolean(flags['--workspace-member'])) throw new Error('Pass --workspace and --workspace-member together');
    daemonUrl = flags['--daemon-url'];
    workspace = flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {};
    if (command === 'show') {
      if (!flags['--id']) throw new Error('--id is required');
      request = { method: 'GET', path: `/api/workbench/imports/${encodeURIComponent(flags['--id'])}` };
    } else if (command === 'create') {
      for (const flag of ['--provider', '--name', '--entry', '--dir']) if (!flags[flag]) throw new Error(`${flag} is required`);
      const body = parseOwnedImportRequest({
        provider: flags['--provider'], name: flags['--name'], entryPath: flags['--entry'],
        ownership: { declaration: 'owner-provided-export', exportedFrom: flags['--exported-from'] ?? null },
        files: await readExport(flags['--dir']!),
      });
      request = { method: 'POST', path: '/api/workbench/imports', body: JSON.stringify(body) };
    }
  } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message : 'Invalid input' } });
    return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: daemonUrl ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const response = await fetchWithScopedToolToken(`${baseUrl}${request.path}`, {
      method: request.method, headers: { ...(request.body ? { 'content-type': 'application/json' } : {}), ...workspace, },
      ...(request.body ? { body: request.body } : {}),
    }, env);
    const value: unknown = await response.json();
    if (!response.ok) {
      if (!value || typeof value !== 'object' || !('error' in value)) throw new Error('Malformed daemon error response');
      write({ status: response.status, ...value });
      return response.status === 400 ? 2 : [401, 403, 404, 409, 413, 422].includes(response.status) ? 3 : 1;
    }
    write(command === 'list' ? parseOwnedImportList(value) : parseOwnedImportRecord(value));
    return 0;
  } catch {
    write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid import response' } });
    return 1;
  }
}
