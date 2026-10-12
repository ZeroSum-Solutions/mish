// `od pack install|list|remove|auth` (Licensed Pack plan, Phase 1 item 2):
// the CLI half of the install surface. It calls the same /api/packs routes as
// Settings → Licensed packs (routes/packs.ts); nothing here touches the packs
// folder directly. `od pack digest` is the one local-only subcommand: it
// hashes the author's own files (pack-digest.ts) and sends nothing.
//
// Kept out of cli.ts so it is unit-testable without cli.ts's import-time
// SUBCOMMAND_MAP dispatch (same reason as cult-add-cli.ts). cli.ts's `runPack`
// only prints the result and exits.
//
// Rules:
//   - A local path is resolved against the CLI's cwd and must exist before
//     the POST (exit 2). The daemon reads it from its own disk, so a local
//     path aimed at a non-loopback daemon is refused with a hint (exit 2).
//   - The GitHub token is read from stdin only (`auth set --stdin`); `--token`
//     or a positional token exits 2 before any request. The token goes only
//     into the POST body: never argv, a URL, stdout or stderr.
//   - Human output prints phase names and byte counts, never URLs.
//   - Exit codes: 0 ok, 1 the daemon refused or failed, 2 usage.
//   - `--prompt-file` does not apply: no subcommand takes a prompt.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  classifyPackSource,
  PACK_ERROR_MESSAGES,
  parsePackApiError,
  parsePackGithubAccessStatus,
  parsePackListResponse,
  type InstalledPackSummary,
  type PackApiErrorCode,
  type PackGithubAccessStatus,
  type PackInstallRequest,
} from '@open-design/contracts';

import { isLoopbackHostname } from '../http/local-daemon-request.js';
import { computePackDigest, describeMismatch } from './pack-digest.js';

export interface PackCliOptions {
  /** The daemon base URL for an optional `--daemon-url` value. */
  resolveBaseUrl: (daemonUrl: string | undefined) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Reads all of stdin (the token for `auth set --stdin`). */
  readStdin?: () => Promise<string>;
  cwd?: string;
}

export interface PackCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const PACK_USAGE = `Usage:
  od pack install <github:owner/repo[@version] | path.tgz | folder> [--sha256 <hex>] [--force] [--json]
      Install a pack. There is no default source. github:<owner>/<repo>@<version>
      installs tag pack@<version>; with no @version, the highest pack@ tag.
      A local .tgz needs its sha256 (--sha256, or a <file>.sha256 beside it);
      a folder needs the sha256 of its pack.json (--sha256). Missing or
      mismatched fails closed. od pack digest prints either one.
  od pack digest <folder | path.tgz> [--json]
      Print the sha256 a local install needs, without the daemon. For a folder:
      the digest of its pack.json, after checking every files[] entry against
      the disk. For a .tgz: the file's sha256 (save it as <file>.sha256).
  od pack list [--json]
      List installed packs.
  od pack remove <id> [--json]
      Remove an installed pack.
  od pack auth status [--json]
      Show which GitHub access the daemon uses (stored, env, gh-cli or none).
  od pack auth set --stdin [--json]
      Store a GitHub token read from stdin (never from argv), for example:
      gh auth token --hostname github.com | od pack auth set --stdin
  od pack auth clear [--json]
      Forget the stored token.

Options:
  --force               Replace the same version with other bytes, or downgrade.
  --sha256 <hex>        Expected sha256 for a local archive or folder.
  --json                Machine-readable output.
  --daemon-url <url>    Override the daemon HTTP base.

The same actions live in Settings → Licensed packs.`;

interface Flags {
  positional: string[];
  json: boolean;
  force: boolean;
  stdin: boolean;
  sha256?: string;
  daemonUrl?: string;
  help: boolean;
}

const VALUE_FLAGS = new Set(['--sha256', '--daemon-url']);
const BOOLEAN_FLAGS = new Set(['--json', '--force', '--stdin', '--help', '-h']);
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const TOKEN_FLAG_RE = /^--token(?:=|$)/;
const STDIN_MAX_BYTES = 16 * 1024;

function parseArgs(args: string[]): Flags | { error: string } {
  const flags: Flags = { positional: [], json: false, force: false, stdin: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (TOKEN_FLAG_RE.test(arg)) {
      return { error: 'the token is read from stdin only: pipe it to `od pack auth set --stdin`' };
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (typeof value !== 'string' || value.length === 0) return { error: `${name} needs a value` };
      if (name === '--sha256') flags.sha256 = value;
      else flags.daemonUrl = value;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--json') flags.json = true;
      else if (arg === '--force') flags.force = true;
      else if (arg === '--stdin') flags.stdin = true;
      else flags.help = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      return { error: `unknown flag: ${shown(arg)}` };
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

/** An argument as it may be echoed in an error: never something shaped like a token. */
function shown(arg: string): string {
  return /gh[pousr]_|github_pat_/i.test(arg) || arg.length > 80 ? '<redacted>' : arg;
}

function out(code: number, stdout = '', stderr = ''): PackCliResult {
  return { code, stdout, stderr };
}

function usage(message: string): PackCliResult {
  return out(2, '', `${message}\n${PACK_USAGE}\n`);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > STDIN_MAX_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorLine(code: PackApiErrorCode | string, message: string): string {
  return `[pack] error ${code}: ${message}\n`;
}

/** A failed non-SSE response as `{code, message}`, with the fixed message when the body is not a pack error. */
async function readError(response: Response): Promise<{ code: PackApiErrorCode; message: string; body: string }> {
  const body = await response.text().catch(() => '');
  let parsed: ReturnType<typeof parsePackApiError> = null;
  try {
    parsed = parsePackApiError(JSON.parse(body));
  } catch {
    parsed = null;
  }
  const code: PackApiErrorCode = parsed?.code ?? (response.status === 404 ? 'PACK_NOT_FOUND' : 'INTERNAL_ERROR');
  return { code, message: parsed?.message ?? PACK_ERROR_MESSAGES[code], body };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function describeContents(pack: InstalledPackSummary): string {
  return pack.contents
    .map((entry) => `${entry.kind}${entry.id ? `:${entry.id}` : ''}${typeof entry.count === 'number' ? ` (${entry.count})` : ''}`)
    .join(', ');
}

interface SseFrame {
  event: string;
  data: unknown;
}

/** Read `event:`/`data:` frames from an SSE body; comment frames (keepalive) are skipped. */
async function readSse(body: ReadableStream<Uint8Array>, onFrame: (frame: SseFrame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const raw of block.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) return;
    try {
      onFrame({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      onFrame({ event, data: null });
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      flush(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}

function resolveLocalSource(source: string, cwd: string): string {
  if (source === '~') return homedir();
  if (source.startsWith('~/')) return path.join(homedir(), source.slice(2));
  return path.resolve(cwd, source);
}

function isLoopbackBase(baseUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** A daemon URL a GitHub token may be sent to: loopback http(s), or any https. */
export function isTokenSafeBase(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export async function runPackCli(args: string[], options: PackCliOptions): Promise<PackCliResult> {
  const parsed = parseArgs(args);
  if ('error' in parsed) return usage(parsed.error);
  const flags = parsed;
  const [sub, ...rest] = flags.positional;
  if (!sub) return flags.help ? out(0, `${PACK_USAGE}\n`) : out(2, `${PACK_USAGE}\n`);
  if (sub === 'help' || flags.help) return out(0, `${PACK_USAGE}\n`);

  const fetchImpl = options.fetchImpl ?? fetch;
  const cwd = options.cwd ?? process.cwd();
  const base = async () => (await options.resolveBaseUrl(flags.daemonUrl)).replace(/\/$/, '');
  const call = async (pathname: string, init?: RequestInit): Promise<Response | PackCliResult> => {
    const baseUrl = await base();
    try {
      return await fetchImpl(`${baseUrl}${pathname}`, init);
    } catch {
      return out(1, '', '[pack] the daemon is not reachable; start it or pass --daemon-url\n');
    }
  };

  switch (sub) {
    case 'install': {
      if (rest.length !== 1) return usage('od pack install needs exactly one source');
      if (flags.stdin) return usage('--stdin applies to od pack auth set only');
      if (flags.sha256 !== undefined && !SHA256_RE.test(flags.sha256)) return usage('--sha256 must be 64 hex characters');
      const raw = rest[0]!;
      const body: PackInstallRequest = { source: raw };
      if (classifyPackSource(raw) !== 'github') {
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
          return usage('a pack source is github:owner/repo[@version], a .tgz file or a pack folder');
        }
        const local = resolveLocalSource(raw, cwd);
        if (!existsSync(local)) return usage(`no such file or folder: ${shown(raw)}`);
        if (!isLoopbackBase(await base())) {
          return usage(
            'a local pack is read from the daemon machine\'s disk, and this daemon is not on this machine: copy the archive to that host and run od pack install there',
          );
        }
        body.source = local;
      }
      if (flags.force) body.force = true;
      if (flags.sha256 !== undefined) body.sha256 = flags.sha256.toLowerCase();
      return installRequest(call, body, flags.json, raw);
    }
    case 'digest': {
      if (rest.length !== 1) return usage('od pack digest needs exactly one pack folder or .tgz file');
      const raw = rest[0]!;
      const local = resolveLocalSource(raw, cwd);
      if (!existsSync(local)) return usage(`no such file or folder: ${shown(raw)}`);
      return digestCommand(raw, local, flags.json);
    }
    case 'list': {
      if (rest.length > 0) return usage('od pack list takes no arguments');
      const response = await call('/api/packs');
      if (!(response instanceof Response)) return response;
      if (!response.ok) {
        const error = await readError(response);
        return flags.json ? out(1, `${error.body}\n`) : out(1, '', errorLine(error.code, error.message));
      }
      const text = await response.text();
      if (flags.json) return out(0, `${text}\n`);
      let list: ReturnType<typeof parsePackListResponse> = null;
      try {
        list = parsePackListResponse(JSON.parse(text));
      } catch {
        list = null;
      }
      if (!list) return out(1, '', '[pack] the daemon returned an unexpected pack list\n');
      if (list.packs.length === 0) {
        return out(
          0,
          [
            'No licensed packs installed.',
            '  A folder or .tgz: od pack install <folder | path.tgz> --sha256 <hex>  (od pack digest prints the hex)',
            '  A GitHub repo:    od pack install github:<owner>/<repo>@<version>',
            '',
          ].join('\n'),
        );
      }
      const lines = list.packs.map((pack) => {
        const head = `${pack.id}@${pack.version || '?'}  ${pack.status}  ${pack.title}`;
        const detail = [
          pack.contents.length > 0 ? `  contents: ${describeContents(pack)}` : null,
          pack.licenceScope ? `  licence: ${pack.licenceScope}` : null,
          pack.source ? `  source: ${pack.source}` : null,
          pack.problem ? `  problem: ${pack.problem}` : null,
        ].filter(Boolean);
        return [head, ...detail].join('\n');
      });
      return out(0, `${lines.join('\n')}\n`);
    }
    case 'remove': {
      if (rest.length !== 1) return usage('od pack remove needs exactly one pack id');
      const response = await call(`/api/packs/${encodeURIComponent(rest[0]!)}`, { method: 'DELETE' });
      if (!(response instanceof Response)) return response;
      const text = await response.text();
      if (!response.ok) {
        let error = { code: 'INTERNAL_ERROR' as PackApiErrorCode, message: PACK_ERROR_MESSAGES.INTERNAL_ERROR };
        try {
          error = parsePackApiError(JSON.parse(text)) ?? error;
        } catch {
          // keep the fixed fallback
        }
        return flags.json ? out(1, `${text}\n`) : out(1, '', errorLine(error.code, error.message));
      }
      if (flags.json) return out(0, `${text}\n`);
      const removed = JSON.parse(text) as { id: string; removedVersion: string };
      return out(0, `[pack] removed ${removed.id}${removed.removedVersion ? `@${removed.removedVersion}` : ''}\n`);
    }
    case 'auth': {
      // Sol hold (PR #191, BLOCK 1): a token request goes only to a vetted
      // daemon URL, and never follows a redirect (fetch would resend the body).
      const tokenCall: Call = async (pathname, init) => {
        const baseUrl = await base();
        try {
          return await fetchImpl(`${baseUrl}${pathname}`, { ...init, redirect: 'error' });
        } catch {
          return out(1, '', '[pack] the daemon is not reachable, or it answered with a redirect, which a token request never follows\n');
        }
      };
      const action = rest[0];
      if ((action === 'set' || action === 'clear') && !isTokenSafeBase(await base())) {
        return usage(
          'od pack auth set and clear only talk to a daemon on this machine (127.0.0.1, ::1 or localhost) or over https://; check --daemon-url and OD_DAEMON_URL',
        );
      }
      return runAuth(rest, flags, tokenCall, options.readStdin ?? defaultReadStdin);
    }
    default:
      return usage(`unknown subcommand: od pack ${shown(sub)}`);
  }
}

type Call = (pathname: string, init?: RequestInit) => Promise<Response | PackCliResult>;

/** A path as a teammate can paste it back into a shell. */
function shellArg(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What to run next after an install error, when the CLI knows something the daemon's fixed text cannot. */
function installHint(code: string, typedSource: string): string | null {
  const local = classifyPackSource(typedSource) !== 'github';
  if (local && (code === 'DIGEST_REQUIRED' || code === 'INTEGRITY_MISMATCH')) {
    return `[pack] hint: get the sha256 with: od pack digest ${shellArg(shown(typedSource))}`;
  }
  if (code === 'AUTH_REQUIRED') return '[pack] hint: gh auth token --hostname github.com | od pack auth set --stdin';
  return null;
}

async function digestCommand(typed: string, absPath: string, asJson: boolean): Promise<PackCliResult> {
  const result = await computePackDigest(absPath);
  if (asJson) return out(result.ok ? 0 : 1, json(result));
  if (result.ok && result.kind === 'archive') {
    return out(0, `${result.sha256}\n`, `[pack] archive sha256; save it beside the archive as ${path.basename(absPath)}.sha256, or pass it with --sha256\n`);
  }
  if (result.ok) {
    return out(
      0,
      `${result.sha256}\n`,
      `[pack] ${result.id}@${result.version}: every listed file matches. Install with: od pack install ${shellArg(shown(typed))} --sha256 ${result.sha256}\n`,
    );
  }
  if ('code' in result) return out(1, '', errorLine(result.code, result.message));
  const lines = result.mismatches.map((mismatch) => `[pack] ${describeMismatch(mismatch)}`);
  return out(
    1,
    '',
    `${lines.join('\n')}\n[pack] ${result.id}@${result.version}: update files[] in pack.json to match, then run od pack digest again\n`,
  );
}

async function installRequest(call: Call, body: PackInstallRequest, asJson: boolean, typedSource: string): Promise<PackCliResult> {
  const response = await call('/api/packs/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!(response instanceof Response)) return response;
  if (!response.ok || !response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const error = await readError(response);
    const result = { code: error.code, message: error.message, warnings: [] as string[] };
    const hint = installHint(error.code, typedSource);
    return asJson
      ? out(1, json({ ok: false, result, events: [] }))
      : out(1, '', `${errorLine(error.code, error.message)}${hint ? `${hint}\n` : ''}`);
  }
  const events: SseFrame[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let final: SseFrame | null = null;
  let lastPhase = '';
  await readSse(response.body, (frame) => {
    events.push(frame);
    const data = (frame.data ?? {}) as Record<string, unknown>;
    if (frame.event === 'progress') {
      const phase = typeof data.phase === 'string' ? data.phase : '...';
      const bytes = typeof data.bytes === 'number' ? data.bytes : null;
      const total = typeof data.totalBytes === 'number' ? data.totalBytes : null;
      if (phase !== lastPhase || bytes !== null) {
        stdout.push(`[pack] ${phase}${bytes !== null ? ` ${formatBytes(bytes)}${total !== null ? ` / ${formatBytes(total)}` : ''}` : ''}`);
      }
      lastPhase = phase;
    } else if (frame.event === 'success' || frame.event === 'error') {
      final = frame;
    }
  });
  const finalFrame = final as SseFrame | null;
  const ok = finalFrame?.event === 'success';
  if (asJson) return out(ok ? 0 : 1, json({ ok, result: finalFrame?.data ?? null, events }));
  const data = (finalFrame?.data ?? {}) as Record<string, unknown>;
  if (ok) {
    const pack = data.pack as InstalledPackSummary;
    stdout.push(`[pack] ${String(data.outcome)} ${pack.id}@${pack.version} (${pack.status})`);
    for (const warning of Array.isArray(data.warnings) ? data.warnings : []) stdout.push(`[pack] warning: ${String(warning)}`);
  } else if (finalFrame) {
    const code = typeof data.code === 'string' ? data.code : 'INTERNAL_ERROR';
    const message = typeof data.message === 'string' ? data.message : PACK_ERROR_MESSAGES.INTERNAL_ERROR;
    stderr.push(errorLine(code, message).trimEnd());
    const hint = installHint(code, typedSource);
    if (hint) stderr.push(hint);
  } else {
    stderr.push('[pack] the install stream ended without a result');
  }
  return out(ok ? 0 : 1, stdout.length ? `${stdout.join('\n')}\n` : '', stderr.length ? `${stderr.join('\n')}\n` : '');
}

function describeAccess(status: PackGithubAccessStatus): string {
  switch (status.source) {
    case 'stored':
      return 'GitHub access: a stored token (Settings → Licensed packs or od pack auth set)';
    case 'env':
      return 'GitHub access: GH_TOKEN / GITHUB_TOKEN from the daemon environment';
    case 'gh-cli':
      return 'GitHub access: the gh CLI login (gh auth token)';
    default:
      return 'GitHub access: not configured. Run gh auth login, or: gh auth token --hostname github.com | od pack auth set --stdin';
  }
}

async function runAuth(rest: string[], flags: Flags, call: Call, readStdin: () => Promise<string>): Promise<PackCliResult> {
  const [action, ...extra] = rest;
  const respond = async (response: Response | PackCliResult): Promise<PackCliResult> => {
    if (!(response instanceof Response)) return response;
    if (!response.ok) {
      const error = await readError(response);
      return flags.json ? out(1, `${error.body}\n`) : out(1, '', errorLine(error.code, error.message));
    }
    const text = await response.text();
    let status: PackGithubAccessStatus | null = null;
    try {
      status = parsePackGithubAccessStatus(JSON.parse(text));
    } catch {
      status = null;
    }
    if (!status) return out(1, '', '[pack] the daemon returned an unexpected GitHub access status\n');
    return flags.json ? out(0, json(status)) : out(0, `${describeAccess(status)}\n`);
  };
  switch (action) {
    case 'status':
      if (extra.length > 0) return usage('od pack auth status takes no arguments');
      return respond(await call('/api/packs/github-access'));
    case 'set': {
      // Never echo `extra`: it may be the token.
      if (extra.length > 0) return usage('the token is read from stdin only: pipe it to `od pack auth set --stdin`');
      if (!flags.stdin) return usage('od pack auth set reads the token from stdin: add --stdin');
      const token = (await readStdin()).trim();
      if (!token) return usage('no token on stdin');
      return respond(
        await call('/api/packs/github-access', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        }),
      );
    }
    case 'clear':
      if (extra.length > 0) return usage('od pack auth clear takes no arguments');
      return respond(await call('/api/packs/github-access', { method: 'DELETE' }));
    default:
      return usage('od pack auth needs status, set --stdin or clear');
  }
}
