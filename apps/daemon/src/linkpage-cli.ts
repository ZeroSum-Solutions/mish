// `od linkpage …` — the CLI surface for the daemon's link-page API (`routes/linkpage.ts`; contract in
// `packages/contracts/src/api/linkpage.ts`). Same endpoints the web surface will call.
//
//   od linkpage build --config <file|-> [--json]
//   od linkpage list [--json]
//   od linkpage get <slug> [--json]
//   od linkpage render <slug> --out <dir> [--origin <url>] [--json]
//   od linkpage asset <slug> <file> [--name <name>] [--json]
//   od linkpage publish <slug> [--origin <url>] [--track-base <url>] [--json]
//   od linkpage delete <slug> [--json]
//
// Kept in its own module so it is testable without importing cli.ts (whose SUBCOMMAND_MAP dispatches
// at import time). Process effects (stdin, files) are injected; `cli.ts` supplies the real ones.

import path from 'node:path';
import {
  isLinkPageAssetName,
  isLinkPageSlug,
  parseLinkPageBuildRequest,
  parseLinkPagePublishRequest,
} from '@mish/contracts';
import type {
  LinkPageAssetResponse,
  LinkPageBuildResponse,
  LinkPageDeleteResponse,
  LinkPageExportResponse,
  LinkPageGetResponse,
  LinkPageListResponse,
  LinkPagePublishResult,
} from '@mish/contracts';
import { isLoopbackHostname } from './http/local-daemon-request.js';

export const LINKPAGE_USAGE = [
  'Usage: od linkpage build --config <file|-> [--json] [--daemon-url <url>]',
  '       od linkpage list [--json]',
  '       od linkpage get <slug> [--json]',
  '       od linkpage render <slug> --out <dir> [--origin <url>] [--json]',
  '       od linkpage asset <slug> <file> [--name <name>] [--json]',
  '       od linkpage publish <slug> [--origin <url>] [--track-base <url>] [--json]',
  '       od linkpage delete <slug> [--json]',
].join('\n');

export const LINKPAGE_HELP = `${LINKPAGE_USAGE}

Build a creator's link page from the places they already have online, then keep, render and export it.

  build    Read --config (a JSON file, or - for stdin) and build the page. The config is
           { "slug": "sam", "sources": [{ "connector": "website", "ref": "https://example.com" }],
             "options": { "name", "headline", "bio", "avatar", "theme", "links", "signup" },
             "connectedAccounts": { "instagram": "<Composio connected-account id>" }, "save": true }.
           Connectors: website, substack, instagram, tiktok, manual.
  list     List saved pages.
  get      Print one saved page.
  render   Write the site (index.html, llms.txt, links.json, spec.json, assets/) into --out.
  asset    Upload a picture (png, jpeg, webp or gif, at most 2 MB) that ships with the page; use
           the printed path (assets/<name>) as options.avatar or in the spec.
  publish  List the files ready to deploy, with --origin (the public address) and --track-base.
           Hosting is a later step: nothing is uploaded and 'published' is false.
  delete   Delete a saved page.

Options:
  --json                Print the daemon response as JSON.
  --daemon-url <url>    Override the local daemon address.`;

export interface LinkpageCliOptions {
  resolveBaseUrl: (daemonUrl: string | undefined) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Reads a file, or stdin for `-`. */
  readConfig: (source: string) => Promise<string>;
  /** Reads a binary file (for `asset`). */
  readBinary?: (file: string) => Promise<Buffer>;
  /** Writes `bytes` to `<dir>/<relativePath>`, creating folders. */
  writeFile: (dir: string, relativePath: string, bytes: Buffer) => Promise<void>;
}

export interface LinkpageCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Parsed {
  command: string;
  positional: string[];
  json: boolean;
  config?: string;
  out?: string;
  origin?: string;
  trackBase?: string;
  name?: string;
  daemonUrl?: string;
}

const ASSET_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const VALUE_FLAGS = new Set(['--config', '--out', '--origin', '--track-base', '--name', '--daemon-url']);

function parseArgs(args: string[]): Parsed | string {
  const parsed: Parsed = { command: args[0] ?? '', positional: [], json: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') parsed.json = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = args[++i];
      if (value === undefined || (value.startsWith('-') && value !== '-')) return `${arg} needs a value`;
      if (arg === '--config') parsed.config = value;
      else if (arg === '--out') parsed.out = value;
      else if (arg === '--origin') parsed.origin = value;
      else if (arg === '--track-base') parsed.trackBase = value;
      else if (arg === '--name') parsed.name = value;
      else parsed.daemonUrl = value;
    } else if (arg.startsWith('-') && arg !== '-') return `unknown option ${arg}`;
    else parsed.positional.push(arg);
  }
  return parsed;
}

/** A relative path from the daemon that stays inside the output folder. */
function safeRelative(file: string): string | null {
  if (!file || path.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => part === '..' || part === '' || part === '.')) return null;
  return file;
}

export async function runLinkpageCli(args: string[], options: LinkpageCliOptions): Promise<LinkpageCliResult> {
  const out = (code: number, stdout = '', stderr = ''): LinkpageCliResult => ({ code, stdout, stderr });
  const usage = (message: string) => out(2, '', `${message}\n${LINKPAGE_USAGE}\n`);
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) return out(0, `${LINKPAGE_HELP}\n`);
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') return usage(parsed);
  const { command, positional, json } = parsed;

  const needSlug = (): string | null => (positional.length === 1 && isLinkPageSlug(positional[0]) ? positional[0]! : null);
  let request: { method: string; path: string; body?: unknown; raw?: { bytes: Buffer; contentType: string } };
  let slug: string | null = null;
  switch (command) {
    case 'build': {
      if (!parsed.config || positional.length) return usage('build needs --config <file|->');
      let text: string;
      try {
        text = await options.readConfig(parsed.config);
      } catch (error) {
        return out(1, '', `Could not read the config: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return out(2, '', 'The config is not valid JSON.\n');
      }
      const checked = parseLinkPageBuildRequest(raw);
      if (!checked.ok) return out(2, '', `The config is not valid: ${checked.error}\n`);
      request = { method: 'POST', path: '/api/linkpages/build', body: checked.value };
      break;
    }
    case 'list':
      if (positional.length) return usage('list takes no arguments');
      request = { method: 'GET', path: '/api/linkpages' };
      break;
    case 'get':
    case 'delete':
    case 'render': {
      slug = needSlug();
      if (!slug) return usage(`${command} needs one slug (lowercase letters, numbers and dashes)`);
      if (command === 'render' && !parsed.out) return usage('render needs --out <dir>');
      const query = command === 'render' && parsed.origin ? `?origin=${encodeURIComponent(parsed.origin)}` : '';
      request = command === 'render'
        ? { method: 'GET', path: `/api/linkpages/${slug}/export${query}` }
        : { method: command === 'get' ? 'GET' : 'DELETE', path: `/api/linkpages/${slug}` };
      break;
    }
    case 'asset': {
      if (positional.length !== 2 || !isLinkPageSlug(positional[0])) return usage('asset needs a slug and a picture file');
      slug = positional[0]!;
      const file = positional[1]!;
      const name = parsed.name ?? path.basename(file);
      const type = ASSET_TYPES[path.extname(name).toLowerCase()];
      if (!isLinkPageAssetName(name) || !type) return usage('the picture name must be letters, numbers, dashes or underscores, ending .png, .jpg, .webp or .gif');
      let bytes: Buffer;
      try {
        bytes = await (options.readBinary ?? (async () => { throw new Error('reading files is not available'); }))(file);
      } catch (error) {
        return out(1, '', `Could not read the picture: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      request = { method: 'PUT', path: `/api/linkpages/${slug}/assets/${encodeURIComponent(name)}`, raw: { bytes, contentType: type } };
      break;
    }
    case 'publish': {
      slug = needSlug();
      if (!slug) return usage('publish needs one slug (lowercase letters, numbers and dashes)');
      const checked = parseLinkPagePublishRequest({ ...(parsed.origin ? { origin: parsed.origin } : {}), ...(parsed.trackBase ? { trackBase: parsed.trackBase } : {}) });
      if (!checked.ok) return usage(checked.error);
      request = { method: 'POST', path: `/api/linkpages/${slug}/publish`, body: checked.value };
      break;
    }
    default:
      return usage(`unknown command "${command}"`);
  }

  try {
    const base = await options.resolveBaseUrl(parsed.daemonUrl);
    const url = new URL(request.path, base);
    if (!isLoopbackHostname(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return out(2, '', 'od linkpage requires a local daemon URL.\n');
    }
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.timeout(command === 'build' ? 300_000 : 30_000),
      ...(request.raw
        ? { headers: { 'content-type': request.raw.contentType }, body: new Uint8Array(request.raw.bytes) }
        : request.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (body as { error?: { message?: string } | string } | null)?.error;
      const text = typeof message === 'string' ? message : message?.message ?? `HTTP ${response.status}`;
      return out(1, json ? `${JSON.stringify(body)}\n` : '', `od linkpage ${command} failed: ${text}\n`);
    }

    if (command === 'render') {
      const exported = body as LinkPageExportResponse;
      const written: string[] = [];
      for (const file of exported.files) {
        const rel = safeRelative(file.path);
        if (!rel) return out(1, '', `The daemon sent an unsafe file path: ${file.path}\n`);
        await options.writeFile(parsed.out!, rel, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
        written.push(rel);
      }
      return out(0, json ? `${JSON.stringify({ slug: exported.slug, out: parsed.out, files: written })}\n` : `Wrote ${written.length} files to ${parsed.out}\n${written.map((f) => `  ${f}`).join('\n')}\n`);
    }
    if (json) return out(0, `${JSON.stringify(body, null, 2)}\n`);
    switch (command) {
      case 'build': {
        const built = body as LinkPageBuildResponse;
        const lines = [`Built ${built.spec.slug}: ${built.spec.profile.name}${built.saved ? ' (saved)' : ' (not saved)'}`];
        for (const warning of built.warnings) lines.push(`  warning: ${warning}`);
        for (const need of built.needs) lines.push(`  login: ${need.platform}: ${need.why}`);
        return out(0, `${lines.join('\n')}\n`);
      }
      case 'list': {
        const { pages } = body as LinkPageListResponse;
        return out(0, pages.length ? `${pages.map((p) => `${p.slug}\t${p.name}\t${p.updatedAt}`).join('\n')}\n` : 'No link pages yet.\n');
      }
      case 'get': {
        const { page } = body as LinkPageGetResponse;
        return out(0, `${page.slug}: ${page.spec.profile.name}\n${page.spec.profile.headline ? `${page.spec.profile.headline}\n` : ''}${page.spec.blocks.length} blocks, updated ${page.updatedAt}\n`);
      }
      case 'asset': {
        const asset = body as LinkPageAssetResponse;
        return out(0, `Uploaded ${asset.name} (${asset.bytes} bytes). Use "${asset.path}" as the avatar or in the spec.\n`);
      }
      case 'publish': {
        const result = body as LinkPagePublishResult;
        return out(0, `${result.files.length} files ready to deploy${result.url ? ` at ${result.url}` : ''} (not published: no host is connected yet)\n${result.files.map((f) => `  ${f}`).join('\n')}\n`);
      }
      default: {
        const { slug: gone } = body as LinkPageDeleteResponse;
        return out(0, `Deleted ${gone}\n`);
      }
    }
  } catch (error) {
    return out(1, '', `od linkpage ${command} failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
