// `od packs install|list|remove`: the CLI half of the Mish packs surface. It calls the same
// /api/mish-packs routes as Settings -> Packs; nothing here touches the packs folder directly.
//
// Kept out of cli.ts so it is unit-testable without that file's import-time dispatch.
//
// Rules:
//   - A local path is resolved against the CLI's cwd and must exist before the POST (exit 2). The
//     daemon reads it from its own disk, so a path aimed at a non-loopback daemon is refused.
//   - Exit codes: 0 ok, 1 the daemon refused or could not be reached, 2 usage.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { MishPackInstallResponse, MishPackRemoveResponse, MishPacksListResponse, MishPackSummary } from '@mish/contracts';

import { isLoopbackHostname } from '../http/local-daemon-request.js';

export interface MishPacksCliOptions {
  resolveBaseUrl: (daemonUrl: string | undefined) => Promise<string>;
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface MishPacksCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const MISH_PACKS_USAGE = `Usage:
  od packs install <folder | file.zip> [--json]
      Install a Mish pack from a folder or a .zip on this machine. The pack
      restores private catalogues, kits, skills, design systems, saved projects,
      design-index profiles and MCP server entries. Installing the same pack id
      again replaces it; if the new version fails, the old one is put back.
  od packs list [--json]
      List installed packs and what each one provides.
  od packs remove <id> [--json]
      Remove an installed pack and what its install added. A copy you changed
      is moved to a backup folder; a saved project you used stays yours.

Options:
  --json                Machine-readable output.
  --daemon-url <url>    Override the daemon HTTP base.

A pack is a folder with mish-pack.json at its top level. The same actions live
in Settings -> Packs. MISH_PACKS_DIR may name a read-only folder of packs that
load at start without an install. See docs/packs.md.`;

interface Flags {
  positional: string[];
  json: boolean;
  daemonUrl?: string;
  help: boolean;
}

function parseArgs(args: string[]): Flags | { error: string } {
  const flags: Flags = { positional: [], json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name === '--daemon-url') {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (typeof value !== 'string' || value.length === 0) return { error: '--daemon-url needs a value' };
      flags.daemonUrl = value;
    } else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-') && arg !== '-') return { error: `unknown flag: ${arg.length > 80 ? '<long>' : arg}` };
    else flags.positional.push(arg);
  }
  return flags;
}

const out = (code: number, stdout = '', stderr = ''): MishPacksCliResult => ({ code, stdout, stderr });
const usage = (message: string): MishPacksCliResult => out(2, '', `${message}\n${MISH_PACKS_USAGE}\n`);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function describe(pack: MishPackSummary): string {
  const parts = pack.provides.map((entry) => (entry.items === null ? entry.resource : `${entry.resource} (${entry.items})`));
  if (pack.mcpServerIds.length > 0) parts.push(`mcp: ${pack.mcpServerIds.join(', ')}`);
  if (pack.envKeys.length > 0) parts.push(`env: ${pack.envKeys.join(', ')}`);
  return parts.join('; ') || 'nothing';
}

function packLines(pack: MishPackSummary): string {
  const lines = [`${pack.id}\t${pack.version}\t${pack.origin}\t${pack.name}`, `  provides: ${describe(pack)}`];
  const unset = pack.requiredEnv.filter((entry) => !entry.set).map((entry) => entry.name);
  if (unset.length > 0) lines.push(`  set these environment variables for its MCP servers: ${unset.join(', ')}`);
  for (const warning of pack.warnings) lines.push(`  note: ${warning}`);
  return `${lines.join('\n')}\n`;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === 'string' ? body.error.code : 'ERROR';
    const message = typeof body.error?.message === 'string' ? body.error.message : `the daemon answered ${response.status}`;
    return `[packs] error ${code}: ${message}\n`;
  } catch {
    return `[packs] error: the daemon answered ${response.status}\n`;
  }
}

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

export async function runMishPacksCli(args: string[], options: MishPacksCliOptions): Promise<MishPacksCliResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cwd = options.cwd ?? process.cwd();
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') return out(0, `${MISH_PACKS_USAGE}\n`);
  const flags = parseArgs(rest);
  if ('error' in flags) return usage(flags.error);
  if (flags.help) return out(0, `${MISH_PACKS_USAGE}\n`);
  if (sub !== 'install' && sub !== 'list' && sub !== 'remove') return usage(`unknown subcommand: ${sub.length > 40 ? '<long>' : sub}`);

  let source: string | undefined;
  let id: string | undefined;
  if (sub === 'install') {
    if (flags.positional.length !== 1) return usage('od packs install takes one folder or .zip path');
    source = path.resolve(cwd, expandHome(flags.positional[0]!));
    if (!existsSync(source)) return usage(`no file or folder at ${source}`);
  } else if (sub === 'remove') {
    if (flags.positional.length !== 1) return usage('od packs remove takes one pack id');
    id = flags.positional[0]!;
  } else if (flags.positional.length > 0) {
    return usage('od packs list takes no arguments');
  }

  let base: string;
  try {
    base = await options.resolveBaseUrl(flags.daemonUrl);
  } catch {
    return out(1, '', '[packs] error: the Mish daemon is not running. Start the app, then run this again.\n');
  }
  if (sub === 'install' && !isLoopbackHostname(new URL(base).hostname)) {
    return usage('the daemon reads the pack from its own disk, so a local path needs a daemon on this machine');
  }

  try {
    if (sub === 'list') {
      const response = await fetchImpl(`${base}/api/mish-packs`);
      if (!response.ok) return out(1, '', await readError(response));
      const body = (await response.json()) as MishPacksListResponse;
      if (flags.json) return out(0, json(body));
      if (body.packs.length === 0) return out(0, `No packs installed. Install one with: od packs install <folder | file.zip>\n`);
      return out(0, body.packs.map(packLines).join(''));
    }
    if (sub === 'install') {
      const response = await fetchImpl(`${base}/api/mish-packs/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (!response.ok) return out(1, '', await readError(response));
      const body = (await response.json()) as MishPackInstallResponse;
      if (flags.json) return out(0, json(body));
      return out(0, `${body.replaced ? 'Replaced' : 'Installed'} pack ${body.pack.id} ${body.pack.version}\n${packLines(body.pack)}`);
    }
    const response = await fetchImpl(`${base}/api/mish-packs/${encodeURIComponent(id!)}`, { method: 'DELETE' });
    if (!response.ok) return out(1, '', await readError(response));
    const body = (await response.json()) as MishPackRemoveResponse;
    return out(0, flags.json ? json(body) : `Removed pack ${body.removed}\n`);
  } catch {
    return out(1, '', '[packs] error: could not reach the Mish daemon\n');
  }
}
