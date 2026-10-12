import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { parseResourceDetailResponse } from '@mish/contracts';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../../daemon-url.js';

export interface RecipeCliOptions { baseUrl?: string; env?: NodeJS.ProcessEnv; write?: (value: unknown) => void }
const USAGE = [
  'od workbench recipe preview --ref <refKey> --out <path> [--force] --json',
  'Common: [--daemon-url <url>] [--workspace <id> --workspace-member <id>]',
  'Discover recipes with `od workbench search --category motion --json` and React95 kit templates with a windows95 query; apply with `od workbench adoption catalogue-prepare`.',
  'Writes any item\'s isolated HTML preview (GSAP recipes, React95 kit templates) exactly as the canvas renders it.',
].join('\n');
class CliInputError extends Error {
  constructor(message: string, readonly code = 'invalid-cli-input') { super(message); }
}

function parse(args: string[]): Record<string, string> {
  const [command, ...rest] = args;
  if (command !== 'preview') throw new CliInputError('Use recipe preview');
  const allowed = ['--ref', '--out', '--daemon-url', '--workspace', '--workspace-member'];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag in flags) throw new CliInputError(`Duplicate option: ${flag}`);
    if (flag === '--json' || flag === '--force') { flags[flag] = 'true'; continue; }
    if (!allowed.includes(flag)) throw new CliInputError(`Unknown option: ${flag}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new CliInputError(`${flag} requires a value`);
    flags[flag] = value;
  }
  if (!flags['--json']) throw new CliInputError('--json is required');
  for (const flag of ['--ref', '--out']) if (!flags[flag]) throw new CliInputError(`preview requires ${flag}`);
  if (('--workspace' in flags) !== ('--workspace-member' in flags)) throw new CliInputError('Pass --workspace and --workspace-member together');
  return flags;
}

/**
 * `od workbench recipe preview`: the CLI side of the canvas Enlarge preview
 * (AC-R08.5). It reads the resource through the same inspect endpoint, follows
 * only the server-issued same-origin preview URL, and writes the exact
 * self-contained document the canvas renders. It never executes it.
 */
export async function runRecipeCli(args: string[], options: RecipeCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) { write({ usage: USAGE }); return args.length ? 0 : 2; }
  let flags: Record<string, string>;
  try { flags = parse(args); } catch (error) {
    write({ error: { code: 'invalid-cli-input', message: error instanceof CliInputError ? error.message : 'Invalid recipe request' } });
    return 2;
  }
  // The output is created exclusively unless --force, and never written through a symlink.
  try {
    const existing = await lstat(flags['--out']!).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing?.isSymbolicLink()) throw new CliInputError('--out is a symbolic link; choose a regular file path', 'output-symlink');
    if (existing && !existing.isFile()) throw new CliInputError('--out exists and is not a regular file', 'output-exists');
    if (existing && !flags['--force']) throw new CliInputError('--out already exists; pass --force to replace it', 'output-exists');
  } catch (error) {
    write({ error: { code: error instanceof CliInputError ? error.code : 'invalid-cli-input', message: error instanceof Error ? error.message : 'Invalid output path' } });
    return 2;
  }
  try {
    const env = options.env ?? process.env;
    const baseUrl = (await resolveDaemonUrl({ flagUrl: flags['--daemon-url'] ?? options.baseUrl ?? null, env })).replace(/\/$/u, '');
    const headers: Record<string, string> = {
      ...(flags['--workspace'] ? { 'x-od-workspace-id': flags['--workspace'], 'x-od-workspace-member-id': flags['--workspace-member']! } : {}),
    };
    const detailResponse = await fetchWithScopedToolToken(`${baseUrl}/api/workbench/resources/${encodeURIComponent(flags['--ref']!)}`, { headers }, env);
    const detailBody: unknown = await detailResponse.json();
    if (!detailResponse.ok) { write({ status: detailResponse.status, ...(detailBody as object) }); return detailResponse.status === 400 ? 2 : 3; }
    const { resource } = parseResourceDetailResponse(detailBody);
    const preview = resource.previewCapability;
    if (!preview.available || preview.kind !== 'html' || !preview.url?.startsWith('/')) {
      write({ status: 422, error: { code: 'VALIDATION_FAILED', message: 'This item has no isolated HTML preview', details: { kind: 'recipe', reason: preview.reason ?? 'preview-unavailable' } } });
      return 3;
    }
    const response = await fetchWithScopedToolToken(`${baseUrl}${preview.url}`, { headers, redirect: 'error' }, env);
    if (!response.ok) {
      write({ status: response.status, ...((await response.json().catch(() => ({ error: { code: 'preview-failed' } }))) as object) });
      return 3;
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('unsupported-preview-content');
    const html = await response.text();
    // O_EXCL refuses a file that appeared since the check; O_NOFOLLOW refuses a symlink swapped in since then.
    const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = constants;
    await writeFile(flags['--out']!, html, { encoding: 'utf8', flag: O_WRONLY | O_CREAT | O_NOFOLLOW | (flags['--force'] ? O_TRUNC : O_EXCL) });
    write({
      refKey: resource.refKey, itemId: resource.ref.itemId, path: flags['--out'], bytes: Buffer.byteLength(html),
      sha256: createHash('sha256').update(html).digest('hex'), contentSecurityPolicy: response.headers.get('content-security-policy'),
    });
    return 0;
  } catch { write({ error: { code: 'transport-or-server-failure', message: 'Unable to read a valid recipe preview' } }); return 1; }
}
