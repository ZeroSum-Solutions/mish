// `od build-on-brand` — the CLI half of the flagship "client brief → working first draft"
// (docs/plans/2026-10-09-flagship/plan.md). It calls the same daemon routes the Design Index
// "First draft" card calls: `POST /api/build-on-brand` (and `/plan` for --dry-run),
// `GET /api/runs/:id` to follow the run, `GET /api/projects/:id/site-check`, and the existing
// `GET /api/projects/:id/archive` for export.
//
// Kept out of cli.ts (like agency-build-cli.ts) so it is testable without cli.ts's import-time
// SUBCOMMAND_MAP dispatch. cli.ts owns only the process effects: streams and the exit code.

import {
  BUILD_ON_BRAND_PAGE_COUNT_MAX,
  BUILD_ON_BRAND_PAGE_COUNT_MIN,
  isBuildOnBrandReferenceUrl,
  type BuildOnBrandRequest,
  type BuildOnBrandResult,
  type SiteCheckResult,
} from '@mish/contracts';

/** Exit codes (spec §CLI). */
export const BUILD_ON_BRAND_EXIT = {
  done: 0,
  failed: 1,
  usage: 2,
  checkFailed: 3,
  cancelled: 4,
} as const;

export interface BuildOnBrandCliIo {
  baseUrl: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  fetch?: typeof fetch;
  /** Poll interval while following a run (ms). */
  pollMs?: number;
}

const STRING_FLAGS = new Set([
  'design-system', 'brief', 'brief-file', 'prompt-file', 'url', 'pages', 'name', 'agent', 'model',
  'spine', 'family', 'keep', 'drop', 'section', 'project', 'out', 'daemon-url',
  'design-brief', 'design-brief-revision', 'design-brief-hash',
]);
const BOOLEAN_FLAGS = new Set(['no-library', 'dry-run', 'no-wait', 'json', 'help', 'h']);

export const BUILD_ON_BRAND_HELP = `Usage:
  od build-on-brand --design-system <id> (--brief "<text>" | --brief-file <path|-> | --prompt-file <path|-> | --url <https://…>)
                    [--pages 3|4|5] [--no-library] [--name <name>] [--agent <id>] [--model <m>]
                    [--spine <code>] [--family <id>] [--keep <section,...>] [--drop <section,...>] [--section <entryId,...>]
                    [--dry-run] [--no-wait] [--json] [--daemon-url <url>]
  od build-on-brand project --design-system <id> [--name <name>] [--brief "<text>"] [--json]
  od build-on-brand --design-system <id> --brief-file <path|-> --project <id>
                    --design-brief <briefId> --design-brief-revision <n> --design-brief-hash <sha256>
  od build-on-brand check  --project <id> [--json]
  od build-on-brand export --project <id> --out <site.zip>

Turns a client brief into a working first draft: a ${BUILD_ON_BRAND_PAGE_COUNT_MIN}–${BUILD_ON_BRAND_PAGE_COUNT_MAX} page site on an installed design kit,
built by one agent run. Same daemon routes as Design Index → Route → First draft.

  --design-system <id>   Installed, published design kit (required). Draft kits are refused.
  --brief "<text>"       The client brief, inline.
  --brief-file <path|->  Read the brief from a file, or stdin with "-".
  --prompt-file <path|-> Same as --brief-file (repository-wide long-prompt form).
  --url <https://…>      A public reference page, read for structure only (no copy, no images).
  --pages 3|4|5          Page count (default 4).
  --no-library           Kit components only: no catalogue sections.
  --spine/--family       The Design Index route (from \`od agency route --json\`).
  --keep/--drop          Family optional sections to keep or drop (comma separated ids).
  --section <entryId>    Insertable catalogue sections to use (from \`od sections list\`).
  --project + --design-brief*  Improve prompt (step 4): build in the project made by
                         \`od build-on-brand project\`, bound to the brief accepted there with
                         \`od workbench transform\` and \`od workbench brief accept\`.
  --dry-run              Show the plan; create nothing.
  --no-wait              Print the started build and exit; do not follow the run.
  --json                 Machine-readable output (ND-JSON while following a run).

Exit codes: 0 done and the site check passed; 1 the run failed; 2 usage error or refusal
(no agent runtime, kit not installed or a draft, reference refused); 3 done but the site check
failed; 4 cancelled.

Deploy the result with: od deploy <projectId> --file index.html --provider vercel-self`;

type Flags = Record<string, string | true>;

export class UsageError extends Error {}

export function parseBuildOnBrandArgs(argv: readonly string[]): { sub: 'build' | 'check' | 'export' | 'project'; flags: Flags } {
  let sub: 'build' | 'check' | 'export' | 'project' = 'build';
  const flags: Flags = {};
  const list: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      if (i === 0 && (arg === 'check' || arg === 'export' || arg === 'project')) {
        sub = arg;
        continue;
      }
      if (i === 0 && arg === 'help') {
        flags.help = true;
        continue;
      }
      throw new UsageError(`od build-on-brand: unexpected argument "${arg}". See --help.`);
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq >= 0 ? eq : undefined);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!STRING_FLAGS.has(key)) throw new UsageError(`od build-on-brand: unknown flag --${key}. See --help.`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new UsageError(`od build-on-brand: --${key} needs a value.`);
    if (key === 'keep' || key === 'drop' || key === 'section') {
      (list[key] ??= []).push(...value.split(',').map((part) => part.trim()).filter(Boolean));
      flags[key] = list[key]!.join(',');
      continue;
    }
    flags[key] = value;
  }
  return { sub, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Turns flags into the request body. Throws UsageError for anything the daemon would refuse with 400. */
export async function requestFromFlags(flags: Flags, io: Pick<BuildOnBrandCliIo, 'readStdin' | 'readFile'>): Promise<BuildOnBrandRequest> {
  const designSystemId = str(flags, 'design-system');
  if (!designSystemId) throw new UsageError('od build-on-brand: --design-system <id> is required (see `od design-systems list`).');
  const briefFile = str(flags, 'brief-file') ?? str(flags, 'prompt-file');
  let brief = str(flags, 'brief');
  if (briefFile) brief = briefFile === '-' ? await io.readStdin() : await io.readFile(briefFile);
  const url = str(flags, 'url');
  if (!brief?.trim() && !url) throw new UsageError('od build-on-brand: give a brief (--brief, --brief-file or --prompt-file) or a reference --url.');
  if (url && !isBuildOnBrandReferenceUrl(url)) throw new UsageError('od build-on-brand: --url must be an http(s) address without credentials.');
  const pagesText = str(flags, 'pages');
  let pageCount: number | undefined;
  if (pagesText !== undefined) {
    pageCount = Number(pagesText);
    if (!Number.isInteger(pageCount) || pageCount < BUILD_ON_BRAND_PAGE_COUNT_MIN || pageCount > BUILD_ON_BRAND_PAGE_COUNT_MAX) {
      throw new UsageError(`od build-on-brand: --pages must be ${BUILD_ON_BRAND_PAGE_COUNT_MIN}, 4 or ${BUILD_ON_BRAND_PAGE_COUNT_MAX}.`);
    }
  }
  const sections: Record<string, 'keep' | 'drop'> = {};
  for (const id of (str(flags, 'keep') ?? '').split(',').filter(Boolean)) sections[id] = 'keep';
  for (const id of (str(flags, 'drop') ?? '').split(',').filter(Boolean)) sections[id] = 'drop';
  const catalogEntryIds = (str(flags, 'section') ?? '').split(',').filter(Boolean);
  const spine = str(flags, 'spine');
  const family = str(flags, 'family');
  const hasRoute = Boolean(spine || family || Object.keys(sections).length > 0 || catalogEntryIds.length > 0);
  const briefId = str(flags, 'design-brief');
  const briefRevision = str(flags, 'design-brief-revision');
  const briefHash = str(flags, 'design-brief-hash');
  const briefProject = str(flags, 'project');
  let designBrief: BuildOnBrandRequest['designBrief'];
  if (briefId || briefRevision || briefHash) {
    const revision = Number(briefRevision);
    if (!briefId || !briefHash || !briefProject || !Number.isInteger(revision) || revision < 1) {
      throw new UsageError('od build-on-brand: pass --project, --design-brief, --design-brief-revision and --design-brief-hash together.');
    }
    designBrief = { projectId: briefProject, id: briefId, revision, hash: briefHash };
  } else if (briefProject) {
    throw new UsageError('od build-on-brand: --project needs --design-brief (a build without a brief makes its own project).');
  }
  return {
    ...(brief?.trim() ? { brief } : {}),
    ...(url ? { referenceUrl: url } : {}),
    designSystemId,
    ...(flags['no-library'] ? { useLibrary: false } : {}),
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(str(flags, 'name') ? { name: str(flags, 'name')! } : {}),
    ...(str(flags, 'agent') ? { agentId: str(flags, 'agent')! } : {}),
    ...(str(flags, 'model') ? { model: str(flags, 'model')! } : {}),
    ...(designBrief ? { designBrief } : {}),
    ...(hasRoute
      ? {
          route: {
            ...(spine ? { spine } : {}),
            ...(family ? { family } : {}),
            ...(Object.keys(sections).length > 0 ? { sections } : {}),
            ...(catalogEntryIds.length > 0 ? { catalogEntryIds } : {}),
          },
        }
      : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { error: { code: 'INTERNAL_ERROR', message: text.slice(0, 500) } };
  }
}

/** A daemon refusal: the JSON body on the last stderr line, after a one-line human fix. */
function reportRefusal(io: BuildOnBrandCliIo, body: unknown, json: boolean): number {
  const error = (body as { error?: { code?: string; message?: string; details?: { fix?: string } } } | null)?.error;
  if (!json) io.stderr(`${error?.details?.fix ?? error?.message ?? 'The daemon refused the build.'}\n`);
  io.stderr(`${JSON.stringify(body ?? { error: { code: 'INTERNAL_ERROR', message: 'empty response' } })}\n`);
  const refusal = ['AGENT_UNAVAILABLE', 'DESIGN_SYSTEM_NOT_INSTALLED', 'REFERENCE_URL_REFUSED', 'BAD_REQUEST', 'FORBIDDEN', 'CONFLICT', 'PROJECT_NOT_FOUND', 'brief-not-found', 'brief-not-accepted', 'brief-stale'];
  return refusal.includes(error?.code ?? '') ? BUILD_ON_BRAND_EXIT.usage : BUILD_ON_BRAND_EXIT.failed;
}

function summarise(result: BuildOnBrandResult): string {
  const pages = result.plan.pages.map((page) => page.file).join(', ');
  return [
    `Project   ${result.projectId}`,
    `Run       ${result.runId}`,
    `Kit       ${result.plan.designSystem.id}`,
    `Pages     ${pages}`,
    ...(result.warnings ?? []).map((warning) => `Warning   ${warning}`),
  ].join('\n');
}

function checkLines(check: SiteCheckResult): string {
  return check.rules.map((rule) => `${rule.ok ? 'pass' : 'FAIL'}  ${rule.id}  ${rule.detail}`).join('\n');
}

async function siteCheck(io: BuildOnBrandCliIo, projectId: string): Promise<{ ok: true; check: SiteCheckResult } | { ok: false; body: unknown }> {
  const doFetch = io.fetch ?? fetch;
  const response = await doFetch(`${io.baseUrl}/api/projects/${encodeURIComponent(projectId)}/site-check`);
  const body = await readJson(response);
  return response.ok ? { ok: true, check: body as SiteCheckResult } : { ok: false, body };
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled']);

async function follow(io: BuildOnBrandCliIo, result: BuildOnBrandResult, json: boolean): Promise<number> {
  const doFetch = io.fetch ?? fetch;
  let last = '';
  for (;;) {
    const response = await doFetch(`${io.baseUrl}/api/runs/${encodeURIComponent(result.runId)}`);
    const run = (await readJson(response)) as { status?: string; error?: string } | null;
    const status = run?.status ?? 'unknown';
    if (status !== last) {
      last = status;
      io.stdout(json ? `${JSON.stringify({ type: 'run', runId: result.runId, status })}\n` : `Run ${status}\n`);
    }
    if (TERMINAL.has(status)) {
      if (status !== 'succeeded') {
        if (!json && run?.error) io.stderr(`${run.error}\n`);
        return status === 'failed' ? BUILD_ON_BRAND_EXIT.failed : BUILD_ON_BRAND_EXIT.cancelled;
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, io.pollMs ?? 2000));
  }
  const checked = await siteCheck(io, result.projectId);
  if (!checked.ok) return reportRefusal(io, checked.body, json);
  io.stdout(json ? `${JSON.stringify({ type: 'site-check', projectId: result.projectId, ...checked.check })}\n` : `${checkLines(checked.check)}\n`);
  return checked.check.ok ? BUILD_ON_BRAND_EXIT.done : BUILD_ON_BRAND_EXIT.checkFailed;
}

/** Runs `od build-on-brand <argv>` and returns the exit code. */
export async function runBuildOnBrandCli(argv: readonly string[], io: BuildOnBrandCliIo): Promise<number> {
  let parsed: ReturnType<typeof parseBuildOnBrandArgs>;
  try {
    parsed = parseBuildOnBrandArgs(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return BUILD_ON_BRAND_EXIT.usage;
  }
  const { sub, flags } = parsed;
  if (flags.help || flags.h) {
    io.stdout(`${BUILD_ON_BRAND_HELP}\n`);
    return BUILD_ON_BRAND_EXIT.done;
  }
  const json = flags.json === true;
  const doFetch = io.fetch ?? fetch;

  if (sub === 'project') {
    const designSystemId = str(flags, 'design-system');
    if (!designSystemId) {
      io.stderr('od build-on-brand project: --design-system <id> is required.\n');
      return BUILD_ON_BRAND_EXIT.usage;
    }
    const response = await doFetch(`${io.baseUrl}/api/build-on-brand/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        designSystemId,
        ...(str(flags, 'name') ? { name: str(flags, 'name') } : {}),
        ...(str(flags, 'brief') ? { brief: str(flags, 'brief') } : {}),
      }),
    });
    const body = await readJson(response);
    if (!response.ok) return reportRefusal(io, body, json);
    const projectId = (body as { projectId: string }).projectId;
    io.stdout(json ? `${JSON.stringify(body)}\n` : `Project ${projectId}\nNext: od workbench transform --project ${projectId} --prompt-file <brief.md> --json\n`);
    return BUILD_ON_BRAND_EXIT.done;
  }

  if (sub === 'check' || sub === 'export') {
    const projectId = str(flags, 'project');
    if (!projectId) {
      io.stderr(`od build-on-brand ${sub}: --project <id> is required.\n`);
      return BUILD_ON_BRAND_EXIT.usage;
    }
    if (sub === 'check') {
      const checked = await siteCheck(io, projectId);
      if (!checked.ok) return reportRefusal(io, checked.body, json);
      io.stdout(json ? `${JSON.stringify(checked.check, null, 2)}\n` : `${checkLines(checked.check)}\n`);
      return checked.check.ok ? BUILD_ON_BRAND_EXIT.done : BUILD_ON_BRAND_EXIT.checkFailed;
    }
    const out = str(flags, 'out');
    if (!out) {
      io.stderr('od build-on-brand export: --out <site.zip> is required.\n');
      return BUILD_ON_BRAND_EXIT.usage;
    }
    const response = await doFetch(`${io.baseUrl}/api/projects/${encodeURIComponent(projectId)}/archive`);
    if (!response.ok) return reportRefusal(io, await readJson(response), json);
    await io.writeFile(out, new Uint8Array(await response.arrayBuffer()));
    io.stdout(json ? `${JSON.stringify({ projectId, out })}\n` : `Wrote ${out}\n`);
    return BUILD_ON_BRAND_EXIT.done;
  }

  let request: BuildOnBrandRequest;
  try {
    request = await requestFromFlags(flags, io);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n`);
    return BUILD_ON_BRAND_EXIT.usage;
  }

  const endpoint = flags['dry-run'] ? '/api/build-on-brand/plan' : '/api/build-on-brand';
  let response: Response;
  try {
    response = await doFetch(`${io.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    io.stderr(`Could not reach the Mishh Mashh daemon at ${io.baseUrl}. Start it with \`pnpm tools-dev\` or pass --daemon-url.\n`);
    return BUILD_ON_BRAND_EXIT.failed;
  }
  const body = await readJson(response);
  if (!response.ok) return reportRefusal(io, body, json);

  if (flags['dry-run']) {
    io.stdout(json ? `${JSON.stringify(body, null, 2)}\n` : `${JSON.stringify((body as { plan: unknown }).plan, null, 2)}\n`);
    return BUILD_ON_BRAND_EXIT.done;
  }
  const result = body as BuildOnBrandResult;
  if (flags['no-wait']) {
    io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : `${summarise(result)}\n`);
    return BUILD_ON_BRAND_EXIT.done;
  }
  io.stdout(json ? `${JSON.stringify({ type: 'started', ...result })}\n` : `${summarise(result)}\n`);
  return follow(io, result, json);
}
