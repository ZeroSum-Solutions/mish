import { readFile } from 'node:fs/promises';
import { parseModelPreflightRequest, parseModelPreflightResult, type ModelPreflightRequest, parsePutSessionModel, parseSessionModelChoice, parseSessionModelSnapshot, type SessionModelChoice } from '@mish/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';
import type { WorkbenchCliOptions } from '../workbench-cli.js';

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export const MODEL_CHOICE_FLAGS = ['agent', 'model', 'byok-binding-json'] as const;
export function choiceFromCliFlags(flags: Record<string, unknown>): SessionModelChoice | undefined {
  if (!MODEL_CHOICE_FLAGS.some(key => flags[key] !== undefined)) return undefined;
  return parseSessionModelChoice({ agentId: flags.agent, modelId: flags.model, ...(flags['byok-binding-json'] !== undefined ? { byokBinding: JSON.parse(String(flags['byok-binding-json'])) } : {}) });
}
/** Create succeeded: retain its real identity even if the follow-up selection write fails. */
export async function applyCreatedSessionChoice(baseUrl: string, projectId: string, data: { conversation?: { id?: string } }, choice: SessionModelChoice | undefined, headers: Record<string, string>): Promise<{ model?: ReturnType<typeof parseSessionModelSnapshot>; partial?: { code: string; projectId: string; conversationId: string; status?: number } }> {
  if (!choice) return {};
  const conversationId = data.conversation?.id;
  if (!conversationId) throw new Error('Created conversation response has no identity');
  try {
    const response = await fetch(`${baseUrl}/api/workbench/sessions/${encodeURIComponent(conversationId)}/model`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json', 'x-od-project-id': projectId }, body: JSON.stringify({ ...choice, expectedRevision: 0 }) });
    if (!response.ok) return { partial: { code: 'session-model-create-partial', projectId, conversationId, status: response.status } };
    return { model: parseSessionModelSnapshot(await response.json()) };
  } catch { return { partial: { code: 'session-model-create-partial', projectId, conversationId } }; }
}
export async function runModelCli(args: string[], options: WorkbenchCliOptions): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.includes('--help') || args.includes('-h')) { write({ usage: 'od workbench model get|set --session <id> --project <id> [--agent <id> --model <id> --expected-revision <n> --byok-binding-json <public-json>] [--workspace <id> --workspace-member <id>] [--daemon-url <url>] --json\nod workbench model preflight --session <id> --project <id> --agent <id> --model <id> [--attachments-json <public-json-array>] [--byok-binding-json <public-json>] [--prompt-file <path|->] [--workspace <id> --workspace-member <id>] [--daemon-url <url>] --json' }); return 0; }
  let flags: Record<string, string>; let input: ReturnType<typeof parsePutSessionModel> | undefined; let attachments: unknown[] | undefined; let preflightRequest: ModelPreflightRequest | undefined;
  const command = args[0];
  try {
    if (command !== 'get' && command !== 'set' && command !== 'preflight') throw new Error();
    flags = {};
    const allowed = ['--session','--project','--workspace','--workspace-member','--daemon-url',
      ...(command === 'set' ? ['--agent','--model','--expected-revision','--byok-binding-json'] : []),
      ...(command === 'preflight' ? ['--agent','--model','--attachments-json','--prompt-file','--byok-binding-json'] : [])];
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!; if (flags[flag] !== undefined) throw new Error();
      if (flag === '--json') { flags[flag] = 'true'; continue; }
      if (!allowed.includes(flag)) throw new Error();
      const value = args[++i]; if (!value?.trim() || value.startsWith('--')) throw new Error(); flags[flag] = value.trim();
    }
    if (!flags['--json'] || !flags['--session'] || !flags['--project']) throw new Error();
    if (Boolean(flags['--workspace']) !== Boolean(flags['--workspace-member'])) throw new Error();
    if (command === 'set') {
      if (!/^(0|[1-9][0-9]*)$/.test(flags['--expected-revision'] ?? '')) throw new Error();
      input = parsePutSessionModel({ agentId: flags['--agent'], modelId: flags['--model'], expectedRevision: Number(flags['--expected-revision']), ...(flags['--byok-binding-json'] ? { byokBinding: JSON.parse(flags['--byok-binding-json']) } : {}) });
    }
    if (command === 'preflight') {
      if (!flags['--agent'] || !flags['--model']) throw new Error();
      if (flags['--attachments-json'] !== undefined) {
        const parsed: unknown = JSON.parse(flags['--attachments-json']);
        if (!Array.isArray(parsed)) throw new Error();
        attachments = parsed;
      }
      // Accepted for CLI-wide consistency (every prompt-consuming command
      // takes `--prompt-file <path|->`); preflight evaluates the candidate
      // model/attachments, not prompt content, so the text itself is only
      // read here to fail fast on a bad path, never forwarded to the daemon.
      // Validated through the shared contract so a credential-bearing binding is
      // rejected locally (never sent, never echoed), exactly as `set` does.
      preflightRequest = parseModelPreflightRequest({ agentId: flags['--agent'], modelId: flags['--model'], ...(attachments !== undefined ? { attachments } : {}), ...(flags['--byok-binding-json'] !== undefined ? { byokBinding: JSON.parse(flags['--byok-binding-json']) } : {}) });
      if (flags['--prompt-file'] !== undefined) {
        await (flags['--prompt-file'] === '-' ? (options.readStdin ?? stdinText)() : readFile(flags['--prompt-file'], 'utf8'));
      }
    }
  } catch { write({ error: { code: 'invalid-cli-input', message: 'Pass a complete public model choice, session/project scope and valid expected revision; credentials are not accepted here' } }); return 2; }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/, '');
    const headers = { 'content-type': 'application/json', 'x-od-project-id': flags['--project']!, ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}) };
    const path = command === 'preflight' ? '/preflight' : '';
    const method = command === 'get' ? 'GET' : command === 'preflight' ? 'POST' : 'PUT';
    const body = command === 'preflight'
      ? JSON.stringify(preflightRequest)
      : input ? JSON.stringify(input) : undefined;
    const response = await fetchWithScopedToolToken(`${baseUrl}/api/workbench/sessions/${encodeURIComponent(flags['--session']!)}/model${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }, env);
    const responseBody: unknown = await response.json();
    if (!response.ok) { write({ status: response.status, ...responseBody as object }); return response.status === 400 ? 2 : [401,403,404,409,422].includes(response.status) ? 3 : 1; }
    write(command === 'preflight' ? parseModelPreflightResult(responseBody) : parseSessionModelSnapshot(responseBody)); return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid session model response' } }); return 1; }
}
