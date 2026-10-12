import { readFile } from 'node:fs/promises';
import {
  parsePutProjectDesignContext, parsePutProjectRubric, parsePutWorkbenchPreferences,
  parseProjectDesignContextSnapshot, parseProjectRubricSnapshot, parseWorkbenchPreferencesSnapshot,
} from '@open-design/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';
import type { WorkbenchCliOptions } from '../workbench-cli.js';

const HELP = 'od workbench context|rubric get|set --project <id> [--revision <n>] [--input-file <path|-> --expected-revision <n>] --json\nod workbench preferences get|set --project <id> [--revision <n>] [--context on|off --expected-revision <n>] --json\nOptional: --workspace <id> --workspace-member <id> --daemon-url <url>';
async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
function safeRevision(value: string | undefined, positive: boolean): number {
  if (!value || !(positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/).test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid revision');
  return Number(value);
}
/** Source helper; shared od dispatch is registered by the integration owner. */
export async function runContextCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.includes('--help') || args.includes('-h')) { write({ usage: HELP }); return 0; }
  const [family, command] = args;
  let flags: Record<string, string>; let input: unknown; let revision: number | undefined;
  try {
    if (!['context', 'rubric', 'preferences'].includes(family ?? '') || (command !== 'get' && command !== 'set')) throw new Error();
    flags = {};
    const allowed = ['--project', '--workspace', '--workspace-member', '--daemon-url', ...(command === 'get' ? ['--revision'] : ['--expected-revision', ...(family === 'preferences' ? ['--context'] : ['--input-file'])])];
    for (let i = 2; i < args.length; i++) {
      const flag = args[i]!;
      if (Object.hasOwn(flags, flag)) throw new Error();
      if (flag === '--json') { flags[flag] = 'true'; continue; }
      if (!allowed.includes(flag)) throw new Error();
      const value = args[++i]; if (!value || value.trim() !== value || value.startsWith('--') || /\p{Cc}/u.test(value)) throw new Error();
      flags[flag] = value;
    }
    if (!flags['--json'] || !flags['--project'] || Boolean(flags['--workspace']) !== Boolean(flags['--workspace-member'])) throw new Error();
    if (command === 'get' && flags['--revision'] !== undefined) revision = safeRevision(flags['--revision'], true);
    if (command === 'set') {
      const expectedRevision = safeRevision(flags['--expected-revision'], false);
      if (family === 'preferences') {
        if (!['on', 'off'].includes(flags['--context'] ?? '')) throw new Error();
        input = parsePutWorkbenchPreferences({ expectedRevision, useProjectContext: flags['--context'] === 'on' });
      } else {
        const path = flags['--input-file']; if (!path) throw new Error();
        const text = path === '-' ? await (options.readStdin ?? stdinText)() : await readFile(path, 'utf8');
        const draft: unknown = JSON.parse(text);
        input = family === 'context' ? parsePutProjectDesignContext({ expectedRevision, draft }) : parsePutProjectRubric({ expectedRevision, draft });
      }
    }
  } catch { write({ error: { code: 'invalid-cli-input', message: 'Pass project scope, a complete draft and a safe revision; use paired workspace authority flags' } }); return 2; }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/, '');
    const headers = {
      'content-type': 'application/json', 'x-od-project-id': flags['--project']!,
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    };
    const url = `${baseUrl}/api/workbench/projects/${encodeURIComponent(flags['--project']!)}/${family}${revision === undefined ? '' : `?revision=${revision}`}`;
    const response = await fetchWithScopedToolToken(url, { method: command === 'get' ? 'GET' : 'PUT', headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, env);
    const body: unknown = await response.json();
    if (!response.ok) {
      if (!body || typeof body !== 'object' || !('error' in body)) throw new Error();
      write({ ...body, status: response.status });
      return response.status === 400 ? 2 : [401, 403, 404, 409, 422].includes(response.status) ? 3 : 1;
    }
    const snapshot = family === 'context' ? parseProjectDesignContextSnapshot(body) : family === 'rubric' ? parseProjectRubricSnapshot(body) : parseWorkbenchPreferencesSnapshot(body);
    if (snapshot.projectId !== flags['--project'] || (revision !== undefined && snapshot.revision !== revision)) throw new Error();
    write(snapshot); return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid project record response' } }); return 1; }
}
