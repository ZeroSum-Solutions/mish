import { readFile } from 'node:fs/promises';
import { parseResourceDetailResponse, parseResourceSearchRequest, parseResourceSearchResponse } from '@mish/contracts';
import { runIntakeCli } from './workbench/intake-cli.js';
import { runModelCli } from './workbench/model-cli.js';
import { runContextCli } from './workbench/context-cli.js';
import { runAdoptionCli } from './workbench/placement/adoption-cli.js';
import { runReviewCli } from './workbench/review-cli.js';
import { FONT_CHECK_USAGE, runFontCheckCli } from './workbench/font-cli.js';
import { runRecipeCli } from './workbench/recipes/recipe-cli.js';
import { INTEGRATIONS_HELP, runIntegrationsCli } from './workbench/integrations-cli.js';
import { CONNECTOR_HELP, runConnectorCli } from './workbench/connectors/connector-cli.js';
import { OWNED_IMPORT_HELP, runOwnedImportCli } from './workbench/owned-imports/owned-imports-cli.js';
import { runCaptureCli, runUnitCli } from './workbench/capture-cli.js';
import { runCaptureDraftCli } from './workbench/capture-draft-cli.js';
import { runBriefCli } from './workbench/brief/cli.js';
import { fetchWithScopedToolToken, resolveDaemonUrl } from './daemon-url.js';

export interface WorkbenchCliOptions {
  baseUrl?: string;
  componentsMode?: 'rank' | 'list';
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  write?: (value: unknown) => void;
}
const HELP = 'od workbench intake --help\nod workbench transform --help\nod workbench brief --help\nod workbench adoption --help\nod workbench model --help\nod workbench review --help\nod workbench recipe --help\nod workbench capture --help\nod workbench draft-from-capture --help\nod workbench unit --help\nod workbench context|rubric|preferences --help\nod workbench search [--prompt-file <path|->] [--project <id>] [--context on|off] [--category <category>] [--limit <n>] [--cursor <cursor>] [--daemon-url <url>] [--workspace <id> --workspace-member <id>] --json\nod workbench inspect --ref <refKey> [--project <id>] [--daemon-url <url>] [--workspace <id> --workspace-member <id>] --json\nod workbench preview --ref <refKey> [--project <id>] [--daemon-url <url>] [--workspace <id> --workspace-member <id>] [--json]\n' + FONT_CHECK_USAGE + '\n' + INTEGRATIONS_HELP + '\n' + CONNECTOR_HELP + '\n' + OWNED_IMPORT_HELP;
/** The JSON form of GET /api/workbench/resources/:refKey/preview: the same specimen the Enlarge view renders. */
type TokenSpecimenBody = { ref: unknown; refKey: string; title: string; category: string; tokens: Array<{ name: string; value: string }>; notes: string[] };
function parseTokenSpecimenBody(body: unknown): TokenSpecimenBody {
  const value = body as Partial<TokenSpecimenBody> | null;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string');
  if (!value || typeof value !== 'object' || typeof value.refKey !== 'string' || typeof value.title !== 'string' || typeof value.category !== 'string' || !strings(value.notes)
    || !Array.isArray(value.tokens) || !value.tokens.every(token => token && typeof token.name === 'string' && typeof token.value === 'string')) throw new Error('Malformed preview response');
  return value as TokenSpecimenBody;
}
/** Short terminal table; control characters are stripped so token text cannot drive the terminal. */
function tokenTable(specimen: TokenSpecimenBody): string {
  const clean = (text: string) => text.replace(/[\p{Cc}\u2028\u2029]/gu, ' ');
  const width = Math.min(40, Math.max(...specimen.tokens.map(token => clean(token.name).length), 4));
  return [`${clean(specimen.title)} (${clean(specimen.category)})`, ...specimen.tokens.map(token => `${clean(token.name).padEnd(width)}  ${clean(token.value)}`)].join('\n');
}
async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
function parseArgs(args: string[]): { command: 'search' | 'inspect' | 'preview'; flags: Record<string,string> } {
  const [command,...rest] = args;
  if (command !== 'search' && command !== 'inspect' && command !== 'preview') throw new Error('Use workbench search, inspect or preview');
  const allowed = ['--daemon-url','--workspace','--workspace-member', ...(command === 'search' ? ['--prompt-file','--project','--context','--category','--limit','--cursor','--kit','--kit-source'] : ['--ref','--project'])];
  const flags: Record<string,string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag in flags) throw new Error(`Duplicate option: ${flag}`);
    if (flag === '--show-all' && command === 'search') { flags[flag] = 'true'; continue; }
    if (flag === '--json') { flags[flag] = 'true'; continue; }
    if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    flags[flag] = value;
  }
  // preview prints a short token table without --json; search and inspect are JSON-only.
  if (!flags['--json'] && command !== 'preview') throw new Error('--json is required');
  if (command !== 'search' && !flags['--ref']) throw new Error(`${command} requires --ref`);
  if (command === 'search' && flags['--context'] && !['on','off'].includes(flags['--context'])) throw new Error('--context must be on or off');
  if ('--workspace' in flags || '--workspace-member' in flags) {
    if (!flags['--workspace']?.trim() || !flags['--workspace-member']?.trim()) throw new Error('Pass --workspace and --workspace-member together with nonempty values');
    flags['--workspace'] = flags['--workspace']!.trim();
    flags['--workspace-member'] = flags['--workspace-member']!.trim();
  }
  return { command, flags };
}
/** UI and CLI share endpoint DTOs and refusal codes. No browser or source-acquisition action. */
export async function runWorkbenchCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  if (['context', 'rubric', 'preferences'].includes(args[0] ?? '')) return runContextCli(args, options);
  if (args[0] === 'model') return runModelCli(args.slice(1), options);
  if (args[0] === 'intake') return runIntakeCli(args.slice(1), options);
  if (args[0] === 'adoption') return runAdoptionCli(args.slice(1), options);
  if (args[0] === 'review') return runReviewCli(args.slice(1), options);
  if (args[0] === 'font-check') return runFontCheckCli(args.slice(1), options);
  if (args[0] === 'recipe') return runRecipeCli(args.slice(1), options);
  if (args[0] === 'connector' && ['search', 'detail', 'select'].includes(args[1] ?? '')) return runConnectorCli(args.slice(1), options);
  if (args[0] === 'import') return runOwnedImportCli(args.slice(1), options);
  if (['integrations', 'connector', 'licence'].includes(args[0] ?? '')) return runIntegrationsCli(args, options);
  if (args[0] === 'capture') return runCaptureCli(args.slice(1), options);
  if (args[0] === 'draft-from-capture') return runCaptureDraftCli(args.slice(1), options);
  if (args[0] === 'unit') return runUnitCli(args.slice(1), options);
  if (args[0] === 'transform' || args[0] === 'brief') return runBriefCli(args, options);
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 1 && ['--help','-h'].includes(args[0]!)) { write({ usage: HELP }); return 0; }
  let parsed: ReturnType<typeof parseArgs>;
  let request: ReturnType<typeof parseResourceSearchRequest> | undefined;
  try {
    parsed = parseArgs(args);
    const { command, flags } = parsed;
    if (command === 'search') {
      const path = flags['--prompt-file'];
      // Empty-query discovery is required for complete local-inventory paging.
      const query = path === undefined ? '' : path === '-' ? await (options.readStdin ?? stdinText)() : await readFile(path,'utf8');
      request = parseResourceSearchRequest({ query, ...(options.componentsMode || flags['--kit'] || flags['--show-all'] ? { componentPicker: { ...(flags['--kit'] ? { kitId: flags['--kit'] } : {}), ...(flags['--kit-source'] ? { kitSourceId: flags['--kit-source'] } : {}), showAll: flags['--show-all'] === 'true', mode: options.componentsMode ?? 'rank' } } : {}), ...(flags['--project'] ? {projectId: flags['--project']} : {}), ...(flags['--context'] ? { useProjectContext: flags['--context'] === 'on' } : {}), facets: flags['--category'] ? {category: flags['--category']} : {}, ...(flags['--limit'] ? {limit:Number(flags['--limit'])} : {}), ...(flags['--cursor'] ? {cursor:flags['--cursor']} : {}) });
    }
  } catch (error) { write({ error: { code:'invalid-cli-input', message:error instanceof Error ? error.message : 'Invalid input' } }); return 2; }
  try {
    const { command, flags } = parsed;
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({flagUrl:flags['--daemon-url'] ?? options.baseUrl ?? null,env})).replace(/\/$/,'');
    const projectId = flags['--project'];
    const headers = {
      ...(command === 'search' ? {'content-type':'application/json'} : {}),
      ...(command === 'preview' ? {accept:'application/json'} : {}),
      ...(projectId ? {'x-od-project-id':projectId} : {}),
      ...(flags['--workspace'] ? {'x-od-workspace-id':flags['--workspace'], 'x-od-workspace-member-id':flags['--workspace-member']!} : {}),
    };
    const url = command === 'search' ? `${baseUrl}/api/workbench/${options.componentsMode ? `components/${options.componentsMode}` : 'resources/search'}` : `${baseUrl}/api/workbench/resources/${encodeURIComponent(flags['--ref']!)}${command === 'preview' ? '/preview' : ''}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
    const response = await fetchWithScopedToolToken(url, { method: command === 'search' ? 'POST' : 'GET', headers, ...(request ? {body:JSON.stringify(request)} : {}) }, env);
    const body: unknown = await response.json();
    if (!response.ok) {
      if (!body || typeof body !== 'object' || !('error' in body)) throw new Error('Malformed daemon error response');
      write({status:response.status,...body});
      return response.status === 400 ? 2 : [401,403,404,409,422].includes(response.status) ? 3 : 1;
    }
    if (command === 'preview') {
      const specimen = parseTokenSpecimenBody(body);
      write(flags['--json'] ? specimen : tokenTable(specimen));
      return 0;
    }
    write(command === 'search' ? parseResourceSearchResponse(body) : parseResourceDetailResponse(body));
    return 0;
  } catch { write({error:{code:'transport-or-server-failure',message:'Unable to read a valid workbench response'}}); return 1; }
}
export async function runWorkbench(args: string[]): Promise<void> { process.exitCode = await runWorkbenchCli(args); }
