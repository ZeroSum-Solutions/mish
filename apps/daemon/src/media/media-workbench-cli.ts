import { randomUUID } from 'node:crypto';
import { parseMediaGalleryQuery } from '@mish/contracts';

import { resolveDaemonUrl } from '../daemon-url.js';

/**
 * `od media cancel|retry|gallery|place|reuse|unlink` — the CLI half of AC-R10.1 and
 * AC-R10.2. Each command calls the same HTTP endpoint the UI does and prints
 * the endpoint's JSON body, one line, on stdout.
 *
 * Exit codes: 0 success, 2 invalid request (local validation or HTTP 400),
 * 1 any other refusal (403/404/409/422/5xx), 3 daemon unreachable.
 */

export const MEDIA_WORKBENCH_SUBCOMMANDS = ['cancel', 'retry', 'gallery', 'place', 'reuse', 'unlink'] as const;

export type MediaWorkbenchSubcommand = (typeof MEDIA_WORKBENCH_SUBCOMMANDS)[number];

export function isMediaWorkbenchSubcommand(value: string): value is MediaWorkbenchSubcommand {
  return (MEDIA_WORKBENCH_SUBCOMMANDS as readonly string[]).includes(value);
}

export const MEDIA_WORKBENCH_HELP = `Media workbench (all print one JSON line):
  od media cancel <taskId> [--json]
  od media retry <taskId> [--idempotency-key <key>] [--json]
      Starts a NEW task linked to <taskId>, under a fresh output name. A key
      is generated when omitted; pass the same key to replay a retry safely.
  Edits join a version chain only when generated with --parent <taskId>.
  od media gallery --project <id> [--kind image|video|audio] [--status <s,...>]
                   [--provider <id>] [--from <ms|ISO>] [--to <ms|ISO>]
                   [--limit <1-100>] [--cursor <c>] [--include-unlinked] [--json]
  od media gallery --project <id> --entry <taskId> [--json]
  od media place <entryId> --project <source> [--target <project>] [--output <file>]
                 [--idempotency-key <key>] [--json]
      Copies verified bytes into the target (defaults to source); never overwrites a file.
  od media reuse <entryId> --project <source> --target <project> [--output <file>]
                 [--idempotency-key <key>] [--json]
  od media unlink <entryId> --project <id> [--json]
Common: [--daemon-url <url>] [--workspace <id> --workspace-member <id>]`;

const VALUE_FLAGS: Record<MediaWorkbenchSubcommand, readonly string[]> = {
  cancel: [],
  retry: ['idempotency-key'],
  gallery: ['project', 'kind', 'status', 'provider', 'from', 'to', 'limit', 'cursor', 'entry'],
  place: ['project', 'target', 'output', 'idempotency-key'],
  reuse: ['project', 'target', 'output', 'idempotency-key'],
  unlink: ['project'],
};
const COMMON_VALUE_FLAGS = ['daemon-url', 'workspace', 'workspace-member'];
const BOOLEAN_FLAGS = ['json', 'include-unlinked', 'help', 'h'];

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

class UsageError extends Error {}

function parseArgs(sub: MediaWorkbenchSubcommand, args: string[]): ParsedArgs {
  const valueFlags = new Set([...VALUE_FLAGS[sub], ...COMMON_VALUE_FLAGS]);
  const out: ParsedArgs = { positionals: [], flags: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq >= 0 ? eq : undefined);
    if (name in out.flags) throw new UsageError(`duplicate option --${name}`);
    if (BOOLEAN_FLAGS.includes(name) && eq < 0) {
      out.flags[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new UsageError(`unknown option --${name} for od media ${sub}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
      throw new UsageError(`--${name} requires a value`);
    }
    out.flags[name] = value;
  }
  return out;
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export interface MediaWorkbenchCliOptions {
  env?: NodeJS.ProcessEnv;
  write?: (value: unknown) => void;
  fetchImpl?: typeof fetch;
}

export async function runMediaWorkbenchCli(
  sub: MediaWorkbenchSubcommand,
  args: string[],
  options: MediaWorkbenchCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const fetchImpl = options.fetchImpl ?? fetch;
  const invalid = (message: string, details?: Record<string, unknown>) => {
    write({ error: { code: 'BAD_REQUEST', message, ...(details ? { details } : {}) } });
    return 2;
  };

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(sub, args);
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err));
  }
  const { flags, positionals } = parsed;
  if (flags.help || flags.h) {
    write({ usage: MEDIA_WORKBENCH_HELP });
    return 0;
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const workspace = stringFlag(flags, 'workspace')?.trim();
  const member = stringFlag(flags, 'workspace-member')?.trim();
  if (Boolean(workspace) !== Boolean(member)) {
    return invalid('pass --workspace and --workspace-member together');
  }
  if (workspace && member) {
    headers['x-od-workspace-id'] = workspace;
    headers['x-od-workspace-member-id'] = member;
  }

  const project = stringFlag(flags, 'project') ?? env.OD_PROJECT_ID;
  const enc = encodeURIComponent;
  let method: 'GET' | 'POST' = 'POST';
  let route: string;
  let body: unknown;

  switch (sub) {
    case 'cancel':
    case 'retry': {
      const taskId = positionals[0];
      if (!taskId) return invalid(`usage: od media ${sub} <taskId>`);
      route = `/api/media/tasks/${enc(taskId)}/${sub}`;
      body = {};
      if (sub === 'retry') {
        headers['idempotency-key'] = stringFlag(flags, 'idempotency-key') ?? `od-cli-${randomUUID()}`;
      }
      break;
    }
    case 'gallery': {
      if (!project) return invalid('--project is required (or set OD_PROJECT_ID)');
      const entry = stringFlag(flags, 'entry');
      if (entry) {
        method = 'GET';
        route = `/api/projects/${enc(project)}/media/gallery/${enc(entry)}`;
        break;
      }
      const raw: Record<string, unknown> = {};
      for (const name of ['kind', 'status', 'provider', 'from', 'to', 'limit', 'cursor']) {
        const value = stringFlag(flags, name);
        if (value !== undefined) raw[name] = value;
      }
      if (flags['include-unlinked']) raw.includeUnlinked = '1';
      // Same validator the daemon runs, so a bad filter fails before any call.
      const query = parseMediaGalleryQuery(raw);
      if (!query.ok) return invalid(query.message, { field: query.field });
      const search = new URLSearchParams(Object.entries(raw).map(([k, v]): [string, string] => [k, String(v)]));
      method = 'GET';
      route = `/api/projects/${enc(project)}/media/gallery${search.size > 0 ? `?${search}` : ''}`;
      break;
    }
    case 'place':
    case 'reuse': {
      const entryId = positionals[0];
      const target = stringFlag(flags, 'target') ?? (sub === 'place' ? project : undefined);
      if (!entryId || !project || !target) {
        return invalid(`usage: od media ${sub} <entryId> --project <source>${sub === 'reuse' ? ' --target <project>' : ''}`);
      }
      route = `/api/projects/${enc(project)}/media/gallery/${enc(entryId)}/${sub}`;
      // One key per invocation, so a transport retry never makes a second copy.
      headers['idempotency-key'] = stringFlag(flags, 'idempotency-key') ?? `od-cli-${randomUUID()}`;
      const output = stringFlag(flags, 'output');
      body = { targetProjectId: target, ...(output ? { output } : {}) };
      break;
    }
    case 'unlink': {
      const entryId = positionals[0];
      if (!entryId || !project) return invalid('usage: od media unlink <entryId> --project <id>');
      route = `/api/projects/${enc(project)}/media/gallery/${enc(entryId)}/unlink`;
      body = {};
      break;
    }
  }

  const base = (await resolveDaemonUrl({ flagUrl: stringFlag(flags, 'daemon-url') ?? null })).replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${base}${route}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    write({ error: { code: 'MEDIA_DISPATCHER_UNREACHABLE', message: 'the local daemon could not be reached' } });
    return 3;
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: { code: 'INTERNAL_ERROR', message: `daemon ${response.status}` } };
  }
  write(payload);
  if (response.ok) return 0;
  return response.status === 400 ? 2 : 1;
}
