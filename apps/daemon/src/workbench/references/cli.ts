import { readFile } from 'node:fs/promises';
import { parseDesignBrief, parseReferenceFanoutRequest, parseReferenceFanoutResponse } from '@mish/contracts';
import { mayForwardScopedToolToken, resolveDaemonUrl } from '../../daemon-url.js';
import type { WorkbenchCliOptions } from '../../workbench-cli.js';

export const REFERENCES_HELP = 'od references fanout --brief-file <path|-> [--daemon-url <url>] --json';
async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
/** Accept plain description, fanout request JSON, or the exact structured DesignBrief. */
function briefInput(text: string) {
  if (!text.trim().startsWith('{')) return parseReferenceFanoutRequest({ brief: text });
  const value: unknown = JSON.parse(text);
  if (value && typeof value === 'object' && 'schema' in value && value.schema === 'design-brief/1') {
    const brief = parseDesignBrief(value);
    return parseReferenceFanoutRequest({ brief: brief.originalText, ...(brief.sections.length ? { sections: brief.sections.map((section, index) => ({ id: `section-${index + 1}`, name: section.name, purpose: section.purpose })) } : {}) });
  }
  return parseReferenceFanoutRequest(value);
}
/** HTTP/UI/od parity. A degraded report is returned intact and exits 3 so scripts can notice. */
export async function runReferencesCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { write({ usage: REFERENCES_HELP }); return 0; }
  let body: string, daemonUrl: string | undefined;
  try {
    if (args[0] !== 'fanout') throw new Error('Use references fanout');
    const flags: Record<string, string> = {};
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!;
      if (flag in flags) throw new Error(`Duplicate option: ${flag}`);
      if (flag === '--json') { flags[flag] = 'true'; continue; }
      if (!['--brief-file', '--daemon-url'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      flags[flag] = value;
    }
    if (!flags['--json']) throw new Error('--json is required');
    const file = flags['--brief-file']; if (!file) throw new Error('--brief-file is required');
    body = JSON.stringify(briefInput(file === '-' ? await (options.readStdin ?? stdinText)() : await readFile(file, 'utf8')));
    daemonUrl = flags['--daemon-url'];
  } catch {
    write({ error: { code: 'invalid-cli-input', message: `Invalid reference input; ${REFERENCES_HELP}. JSON may contain a fanout request or DesignBrief with up to eight sections.` } }); return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: daemonUrl ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const forwardToken = env.OD_TOOL_TOKEN && mayForwardScopedToolToken(baseUrl, env.OD_TOOL_TOKEN_ISSUER_ORIGIN);
    const response = await fetch(`${baseUrl}/api/workbench/references/fanout`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(forwardToken ? { authorization: `Bearer ${env.OD_TOOL_TOKEN}` } : {}) }, body });
    const value: unknown = await response.json();
    if (!response.ok) {
      if (!value || typeof value !== 'object' || !('error' in value)) throw new Error('Invalid daemon error');
      write({ status: response.status, ...value });
      return response.status === 400 ? 2 : [429, 504].includes(response.status) ? 75 : [401, 403, 404, 409, 422].includes(response.status) ? 3 : 1;
    }
    const result = parseReferenceFanoutResponse(value); write(result); return result.degraded ? 3 : 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid reference report' } }); return 1; }
}
export async function runReferences(args: string[]): Promise<void> { process.exitCode = await runReferencesCli(args); }
