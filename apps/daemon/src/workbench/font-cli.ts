import { readFile } from 'node:fs/promises';
import { parseFontCheckRequest, parseFontCheckResponse, FONT_STYLES } from '@mish/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';

export interface FontCliOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  write?: (value: unknown) => void;
}
export const FONT_CHECK_USAGE = 'od workbench font-check --ref <refKey> [--prompt-file <path|->] [--weights 400,700] [--styles normal,italic] [--subsets latin,cyrillic] [--project <id>] [--daemon-url <url>] [--workspace <id> --workspace-member <id>] --json';
const FLAGS = ['--ref', '--prompt-file', '--weights', '--styles', '--subsets', '--project', '--daemon-url', '--workspace', '--workspace-member'];
const csv = (value: string | undefined) => value === undefined ? undefined : value.split(',').map(part => part.trim()).filter(Boolean);
async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** AC-R11.2 CLI parity with the canvas specimen checks: same endpoint, DTO and refusal codes. */
export async function runFontCheckCli(args: string[], options: FontCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { write({ usage: FONT_CHECK_USAGE }); return 0; }
  const flags: Record<string, string> = {};
  let request: ReturnType<typeof parseFontCheckRequest>;
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (flag in flags) throw new Error(`Duplicate option: ${flag}`);
      if (flag === '--json') { flags[flag] = 'true'; continue; }
      if (!FLAGS.includes(flag)) throw new Error(`Unknown option: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      flags[flag] = value;
    }
    if (!flags['--json']) throw new Error('--json is required');
    if (!flags['--ref']) throw new Error('font-check requires --ref');
    if ('--workspace' in flags !== '--workspace-member' in flags || ('--workspace' in flags && (!flags['--workspace']!.trim() || !flags['--workspace-member']!.trim()))) throw new Error('Pass --workspace and --workspace-member together with nonempty values');
    const weights = csv(flags['--weights'])?.map(value => { if (!/^\d{1,4}$/.test(value)) throw new Error('--weights takes comma-separated numbers'); return Number(value); });
    const styles = csv(flags['--styles']);
    if (styles?.some(style => !(FONT_STYLES as readonly string[]).includes(style))) throw new Error('--styles takes normal and/or italic');
    const file = flags['--prompt-file'];
    const text = file === undefined ? '' : file === '-' ? await (options.readStdin ?? stdinText)() : await readFile(file, 'utf8');
    request = parseFontCheckRequest({ refKey: flags['--ref'], text, ...(flags['--project'] ? { projectId: flags['--project'] } : {}), ...(weights ? { weights } : {}), ...(styles ? { styles } : {}), ...(flags['--subsets'] ? { subsets: csv(flags['--subsets']) } : {}) });
  } catch (error) { write({ error: { code: 'invalid-cli-input', message: error instanceof Error ? error.message : 'Invalid input' } }); return 2; }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/, '');
    const headers = {
      'content-type': 'application/json',
      ...(request.projectId ? { 'x-od-project-id': request.projectId } : {}),
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'].trim(), 'x-od-workspace-member-id': flags['--workspace-member']!.trim() } : {}),
    };
    const response = await fetchWithScopedToolToken(`${baseUrl}/api/workbench/fonts/check`, { method: 'POST', headers, body: JSON.stringify(request) }, env);
    const body: unknown = await response.json();
    if (!response.ok) {
      if (!body || typeof body !== 'object' || !('error' in body)) throw new Error('Malformed daemon error response');
      write({ status: response.status, ...body });
      return response.status === 400 ? 2 : [401, 403, 404, 409, 422].includes(response.status) ? 3 : 1;
    }
    write(parseFontCheckResponse(body));
    return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid font check response' } }); return 1; }
}
