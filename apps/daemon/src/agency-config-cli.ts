// `od agency config <status|set|clear|repair>` — the CLI surface for the daemon's own TypeSafe (Jev)
// credential and, with `--provider deepseek|cerebras|openrouter`, the fast lane's fill-model keys. Per AGENTS.md "Capability exposure (UI/CLI dual-track)" it drives exactly the
// endpoints the Settings card drives: `GET` and `PUT /api/agency/config`, and
// `POST /api/agency/config/repair` for `repair --confirm`, which sets an unreadable key file aside
// (renamed to `agency-config.json.corrupt-<timestamp>`, never deleted) so the next save starts
// fresh. Saves never do that on their own: they refuse and keep the file's bytes.
//
// Kept in its own module (not inline in cli.ts) so it stays unit-testable without triggering
// cli.ts's import-time SUBCOMMAND_MAP dispatch — mirrors artifacts-cli.ts / handoff-cli.ts.
//
// The key travels on stdin and nowhere else. `--key` is recognised only so it can be refused by
// name: argv is visible in shell history, in `ps` output and in CI logs, and a convenience flag
// here would quietly undo the reason the subcommand exists. Nothing this module returns contains
// the key — the daemon does not send it back, and the key that was read is never echoed.

import type { AgencyConfigRepairResponse, AgencyJevConfigResponse, AgencyModelProvider } from '@open-design/contracts';
import { AGENCY_MODEL_PROVIDERS } from '@open-design/contracts';

export type AgencyConfigCliResult =
  /** Print `stdout` verbatim and exit 0. */
  | { kind: 'ok'; stdout: string }
  /** Print the subcommand help and exit with `code`. */
  | { kind: 'help'; code: number }
  /** Print each line to stderr and exit 2. */
  | { kind: 'usage'; stderr: string[] }
  /** A non-2xx daemon answer, handed back for the caller's shared structured-error path. */
  | { kind: 'http-failure'; response: Response };

export interface AgencyConfigCliOptions {
  /** Reads the whole of stdin. Injected so a test never has to own the real fd. */
  readStdin: () => Promise<string>;
  /** Resolves the daemon HTTP base, honouring `--daemon-url` when one was given. */
  resolveBaseUrl: (daemonUrl: string | undefined) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const SUBCOMMANDS = ['status', 'set', 'clear', 'repair'] as const;
const USAGE = 'Usage: od agency config <status|set|clear> [--provider deepseek|cerebras|openrouter] [--json] | od agency config repair --confirm [--json]';
const REPAIR_USAGE = 'Usage: od agency config repair --confirm   (renames an unreadable key file aside; never deletes it)';
const SET_USAGE = 'Usage: od agency config set [--provider deepseek|cerebras|openrouter] --key-stdin   (the key is read from stdin)';

interface ParsedFlags {
  json: boolean;
  keyStdin: boolean;
  confirm: boolean;
  daemonUrl?: string;
  /** Absent means the Jev key. */
  provider?: AgencyModelProvider;
}

const PROVIDER_LABEL: Record<AgencyModelProvider, string> = { deepseek: 'DeepSeek', cerebras: 'Cerebras', openrouter: 'OpenRouter' };

/**
 * A deliberately small parser: three flags, and `--key` recognised purely to refuse it. Bringing
 * cli.ts's general `parseFlags` here would mean importing cli.ts, which dispatches on import.
 */
function parseFlags(args: string[]): ParsedFlags | { error: string[] } {
  const flags: ParsedFlags = { json: false, keyStdin: false, confirm: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const [name, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (name === '--key') {
      // Named, not echoed: the value is already in this process's argv, and repeating it into
      // stderr would put it somewhere a CI log keeps.
      return {
        error: [
          'od agency config set does not take the key on the command line, where a shell history would keep it.',
          'Pipe it in instead: printf %s "$KEY" | od agency config set --key-stdin',
        ],
      };
    }
    if (name === '--json') flags.json = true;
    else if (name === '--key-stdin') flags.keyStdin = true;
    else if (name === '--confirm') flags.confirm = true;
    else if (name === '--provider') {
      const value = inlineValue ?? args[i + 1];
      if (!(AGENCY_MODEL_PROVIDERS as string[]).includes(value ?? '')) {
        return { error: ['--provider must be deepseek, cerebras or openrouter', USAGE] };
      }
      flags.provider = value as AgencyModelProvider;
      if (inlineValue === undefined) i += 1;
    } else if (name === '--daemon-url') {
      const value = inlineValue ?? args[i + 1];
      if (typeof value !== 'string' || value.length === 0) return { error: [`${name} needs a value`] };
      flags.daemonUrl = value;
      if (inlineValue === undefined) i += 1;
    } else return { error: [`unknown flag: ${arg}`, USAGE] };
  }
  return flags;
}

/**
 * One row per key; `configured: false` prints as plainly as `true`. No row carries a key.
 *
 * The Jev rows come first and are byte-for-byte the output this command printed before the model
 * keys existed (`Jev\t<status>` then `Source\t<source>`), so a script that parsed that still
 * matches. The model rows follow as `<Provider>\t<status>\t<source>`.
 */
function renderStatus(status: AgencyJevConfigResponse): string {
  const configuredOf = (entry: { configured?: unknown } | undefined) => (entry?.configured === true ? 'configured' : 'not configured');
  const sourceOf = (entry: { source?: unknown } | undefined) => (typeof entry?.source === 'string' ? entry.source : 'unset');
  // An older daemon answers without `models`; its model rows then read "not configured".
  const models = (status?.models ?? {}) as Partial<AgencyJevConfigResponse['models']>;
  const jev = `Jev\t${configuredOf(status)}\nSource\t${sourceOf(status)}\n`;
  return `${jev}${AGENCY_MODEL_PROVIDERS.map((provider) => `${PROVIDER_LABEL[provider]}\t${configuredOf(models[provider])}\t${sourceOf(models[provider])}\n`).join('')}`;
}

export async function runAgencyConfigCli(
  args: string[],
  options: AgencyConfigCliOptions,
): Promise<AgencyConfigCliResult> {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    return { kind: 'help', code: args.length === 0 ? 2 : 0 };
  }

  const sub = args[0]!;
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    return { kind: 'usage', stderr: [`unknown subcommand: od agency config ${sub}`, USAGE] };
  }

  const flags = parseFlags(args.slice(1));
  if ('error' in flags) return { kind: 'usage', stderr: flags.error };

  const doFetch = options.fetchImpl ?? fetch;
  const base = await options.resolveBaseUrl(flags.daemonUrl);

  let response: Response;
  if (sub === 'repair') {
    // Moving a credential file is deliberate: no `--confirm`, no request.
    if (!flags.confirm) return { kind: 'usage', stderr: [REPAIR_USAGE] };
    if (flags.provider) return { kind: 'usage', stderr: ['repair acts on the whole key file and takes no --provider', REPAIR_USAGE] };
    response = await doFetch(`${base}/api/agency/config/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    if (!response.ok) return { kind: 'http-failure', response };
    const repaired = (await response.json()) as AgencyConfigRepairResponse;
    if (flags.json) return { kind: 'ok', stdout: `${JSON.stringify(repaired, null, 2)}\n` };
    const line = repaired.repaired && typeof repaired.movedTo === 'string'
      ? `Set the unreadable key file aside as ${repaired.movedTo}. Save the keys again.\n`
      : 'Nothing to repair: the key file is readable or absent.\n';
    return { kind: 'ok', stdout: `${line}${renderStatus(repaired)}` };
  }
  if (sub === 'status') {
    response = await doFetch(`${base}/api/agency/config`);
  } else {
    let body: { apiKey: string } | { clear: true };
    if (sub === 'clear') {
      body = { clear: true };
    } else {
      if (!flags.keyStdin) return { kind: 'usage', stderr: [SET_USAGE] };
      const apiKey = (await options.readStdin()).trim();
      if (!apiKey) return { kind: 'usage', stderr: ['od agency config set read an empty key from stdin.'] };
      body = { apiKey };
    }
    // `provider` moves the write from the Jev key to that fill model's key.
    const scoped = flags.provider ? { provider: flags.provider, ...body } : body;
    response = await doFetch(`${base}/api/agency/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scoped),
    });
  }

  if (!response.ok) return { kind: 'http-failure', response };
  const data = (await response.json()) as AgencyJevConfigResponse;
  return {
    kind: 'ok',
    stdout: flags.json ? `${JSON.stringify(data, null, 2)}\n` : renderStatus(data),
  };
}
