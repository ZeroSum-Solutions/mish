/**
 * Build on brand — the flagship "client brief → working first draft" capability
 * (docs/plans/2026-10-09-flagship/plan.md, docs/plans/2026-10-09-build-on-brand/spec.md).
 *
 *   POST /api/build-on-brand/plan        dry run: validate and plan, nothing is created
 *   POST /api/build-on-brand             validate → plan → stage → one agent run (202)
 *   GET  /api/projects/:id/site-check    the post-build site check
 *
 * Every refusal happens before any project, fetch or run: 400 for shape, 422
 * `DESIGN_SYSTEM_NOT_INSTALLED` for a kit that cannot carry a build, 503 `AGENT_UNAVAILABLE` when
 * no agent runtime can run it, 4xx `REFERENCE_URL_REFUSED` for a reference that is not public or
 * cannot be read. The run goes through the daemon's single run-start choke point, supplied by
 * the server as `createProjectAndRun`. No catalogue Apply and no adoption executor.
 *
 * `od build-on-brand` (build-on-brand-cli.ts) and the Design Index "First draft" card both call
 * these routes (root AGENTS.md, "Capability exposure").
 */
import type { Express, Request, Response } from 'express';
import {
  buildOnBrandProjectRequestSchema,
  buildOnBrandRequestSchema,
  type BuildOnBrandDesignBrief,
  type BuildOnBrandKitRefusalReason,
  type BuildOnBrandParsedRequest,
  type BuildOnBrandPlan,
  type BuildOnBrandReferenceDigest,
  type DesignBrief,
  type DesignSystemSummary,
  designSystemSelectability,
} from '@open-design/contracts';
import type { SectionCatalogEntry } from '@open-design/contracts/api/section-catalog';
import type { HttpDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { digestReferenceHtml } from '../build-on-brand/structure-digest.js';
import { planBuildOnBrand } from '../build-on-brand/plan.js';
import { checkBuiltSite, type SiteFiles } from '../build-on-brand/site-check.js';
import { runMessage, stagedFiles, type StagedInsert } from '../build-on-brand/stage.js';

/** `body` is null when the page was larger than `REFERENCE_MAX_BYTES` and reading stopped. */
export type BuildOnBrandReferenceFetcher = (url: URL) => Promise<{ status: number; contentType: string; body: string | null }>;

export interface BuildOnBrandKitAssets {
  /** Revision hashed from the same captured bytes used below. */
  revision: string;
  designMd: string | null;
  tokensCss: string | null;
  hasComponentsManifest: boolean;
}

export interface BuildOnBrandAgentChoice {
  agentId: string;
  agentName: string;
}

export interface BuildOnBrandStartInput {
  req: Request;
  name: string;
  designSystemId: string;
  agentId: string;
  model?: string;
  message: string;
  files: Record<string, string>;
  /** Run in this existing, empty first-draft project (Improve prompt) instead of a new one. */
  projectId?: string;
  /** The accepted design brief, resolved by the daemon; the run composes it (B8-1). */
  designBrief?: DesignBrief;
}

export interface BuildOnBrandProjectFacts {
  designSystemId: string | null;
  intent: string | null;
  /** True once any root `.html` page exists: the project already holds a draft. */
  hasPages: boolean;
}

export interface RegisterBuildOnBrandRoutesDeps {
  http: Pick<HttpDeps, 'sendApiError' | 'isLocalSameOrigin' | 'resolvedPortRef'>;
  /** Project read authority for the site check (same gate as the other project-scoped GETs). */
  authorizeProjectRequest: AuthorizeProjectRequest;
  listKits: () => Promise<DesignSystemSummary[]>;
  disabledKitIds: () => Promise<readonly string[]>;
  readKitAssets: (id: string) => Promise<BuildOnBrandKitAssets>;
  /**
   * The agent this build runs on: the requested one, else the configured one, else the first
   * available one. `null` when none is installed — the route answers 503 `AGENT_UNAVAILABLE`.
   */
  resolveAgent: (requested: string | undefined) => Promise<BuildOnBrandAgentChoice | null>;
  assertPublicUrl: (url: string) => Promise<void>;
  referenceFetcher: BuildOnBrandReferenceFetcher;
  /** Insertable catalogue entries the daemon can render. */
  catalog: () => readonly SectionCatalogEntry[];
  renderInsert: (ref: string) => Promise<StagedInsert | null>;
  /** Creates the project bound to the kit, writes `files`, and starts ONE run through the choke point. */
  createProjectAndRun: (input: BuildOnBrandStartInput) => Promise<{ projectId: string; conversationId: string; runId: string }>;
  /** Makes the empty project bound to the kit that an Improve-prompt brief is written into. */
  createEmptyProject: (input: { req: Request; name: string; designSystemId: string }) => Promise<{ projectId: string }>;
  readBuildProject: (projectId: string) => Promise<BuildOnBrandProjectFacts | null>;
  /**
   * The exact accepted brief revision (B8-1 `resolveForRun`). Throws an error carrying
   * `status`/`code` for a brief that is missing, not accepted or stale.
   */
  resolveDesignBrief: (binding: BuildOnBrandDesignBrief) => Promise<DesignBrief>;
  /** Root `.html` and every `.css` of a project, or null for an unknown project. */
  readSiteFiles: (projectId: string) => Promise<SiteFiles | null>;
}

/** The reference fetcher must stop reading past this many bytes (see `readCappedText`). */
export const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;

/** The one line a person needs when no agent runtime can run the build. */
export const AGENT_UNAVAILABLE_FIX =
  'No agent runtime is available. Install Claude Code (npm i -g @anthropic-ai/claude-code, then run `claude` once to sign in) or choose an installed agent in Settings → Agents.';

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * Why a kit cannot carry a build, or null when it can. Whether a kit is selectable for generation
 * (a draft is not) comes from the shared `designSystemSelectability` rule, so this route, the
 * picker, the CLI and every other generation route refuse the same kits.
 */
export function kitRefusalReason(summary: DesignSystemSummary | undefined, disabled: readonly string[]): BuildOnBrandKitRefusalReason | 'disabled' | null {
  if (!summary) return 'not-installed';
  const selectability = designSystemSelectability(summary);
  if (!selectability.selectable) return selectability.reason;
  if (disabled.includes(summary.id)) return 'disabled';
  return null;
}

const KIT_REFUSAL_MESSAGES: Record<BuildOnBrandKitRefusalReason | 'disabled', string> = {
  'not-installed': 'That design system is not installed. Pick an installed kit, or install it from the library first.',
  draft: 'That design system is still a draft. Publish it first; a draft kit is never used for generation.',
  unreviewed: 'That design system is Unreviewed. Inspect and approve its current revision before generation.',
  'design-md-missing': 'That design system has no readable DESIGN.md or tokens.css, so a build cannot be bound to it.',
  disabled: 'That design system is turned off in Settings. Turn it on, or pick another kit.',
};

export function registerBuildOnBrandRoutes(app: Express, deps: RegisterBuildOnBrandRoutesDeps): void {
  const { sendApiError, isLocalSameOrigin, resolvedPortRef } = deps.http;

  const requireLocalOrigin = (req: Request, res: Response): boolean => {
    if (isLocalSameOrigin(req, resolvedPortRef.current)) return true;
    sendApiError(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
    return false;
  };

  const parse = (body: unknown): BuildOnBrandParsedRequest => {
    const parsed = buildOnBrandRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      throw new Refusal(400, 'BAD_REQUEST', issues[0] ? `${issues[0].path || 'request'}: ${issues[0].message}` : 'invalid request', { issues });
    }
    return parsed.data;
  };

  const resolveKit = async (id: string) => {
    const [kits, disabled] = await Promise.all([deps.listKits(), deps.disabledKitIds()]);
    const summary = kits.find((kit) => kit.id === id);
    const reason = kitRefusalReason(summary, disabled);
    if (reason) throw new Refusal(422, 'DESIGN_SYSTEM_NOT_INSTALLED', KIT_REFUSAL_MESSAGES[reason], { reason, designSystemId: id });
    let assets: BuildOnBrandKitAssets;
    try { assets = await deps.readKitAssets(id); }
    catch {
      throw new Refusal(422, 'DESIGN_SYSTEM_NOT_INSTALLED', KIT_REFUSAL_MESSAGES['design-md-missing'], { reason: 'design-md-missing', designSystemId: id });
    }
    if (assets.revision !== summary!.approval?.revision) {
      throw new Refusal(422, 'DESIGN_SYSTEM_NOT_INSTALLED', KIT_REFUSAL_MESSAGES.unreviewed, { reason: 'unreviewed', designSystemId: id });
    }
    if (!assets.tokensCss?.trim() || !assets.designMd?.trim()) {
      throw new Refusal(422, 'DESIGN_SYSTEM_NOT_INSTALLED', KIT_REFUSAL_MESSAGES['design-md-missing'], { reason: 'design-md-missing', designSystemId: id });
    }
    return { summary: summary!, assets: { ...assets, tokensCss: assets.tokensCss, designMd: assets.designMd } };
  };

  const readReference = async (referenceUrl: string): Promise<{ digest: BuildOnBrandReferenceDigest; warnings: string[] }> => {
    try {
      await deps.assertPublicUrl(referenceUrl);
    } catch {
      throw new Refusal(422, 'REFERENCE_URL_REFUSED', 'The reference URL is not a public web address. Use a public http(s) page, or build from the brief alone.');
    }
    let response: Awaited<ReturnType<BuildOnBrandReferenceFetcher>>;
    try {
      response = await deps.referenceFetcher(new URL(referenceUrl));
    } catch {
      throw new Refusal(422, 'REFERENCE_URL_REFUSED', 'The reference page could not be read. Check the address, or build from the brief alone.');
    }
    if (response.status < 200 || response.status >= 300 || !/html/iu.test(response.contentType) || response.body === null || response.body.length > REFERENCE_MAX_BYTES) {
      throw new Refusal(422, 'REFERENCE_URL_REFUSED', 'The reference page could not be read as HTML. Check the address, or build from the brief alone.', { status: response.status });
    }
    return digestReferenceHtml(response.body ?? '');
  };

  /** Validate → kit → (agent) → reference → plan → inserts. Nothing is written. */
  const prepare = async (body: unknown, needAgent: boolean) => {
    const request = parse(body);
    const kit = await resolveKit(request.designSystemId);
    const agent = needAgent ? await deps.resolveAgent(request.agentId) : null;
    if (needAgent && !agent) throw new Refusal(503, 'AGENT_UNAVAILABLE', AGENT_UNAVAILABLE_FIX, { fix: AGENT_UNAVAILABLE_FIX });
    const reference = request.referenceUrl ? await readReference(request.referenceUrl) : null;
    const planned = planBuildOnBrand({
      request,
      kit: { id: kit.summary.id, title: kit.summary.title, hasComponentsManifest: kit.assets.hasComponentsManifest },
      ...(reference ? { digest: reference.digest } : {}),
      catalog: request.useLibrary ? deps.catalog() : [],
    });
    const warnings = [...(reference?.warnings ?? []), ...planned.warnings];
    const { plan, inserts } = await stageInserts(planned.plan, warnings);
    return { request, kit, agent, plan, inserts, warnings };
  };

  /** Render every catalogue section; one that cannot render falls back to the kit. */
  const stageInserts = async (plan: BuildOnBrandPlan, warnings: string[]) => {
    const inserts: StagedInsert[] = [];
    const failed = new Set<string>();
    for (const page of plan.pages) {
      for (const section of page.sections) {
        if (section.source !== 'catalog' || !section.ref || failed.has(section.ref) || inserts.some((insert) => insert.ref === section.ref)) continue;
        const rendered = await deps.renderInsert(section.ref).catch(() => null);
        if (rendered) inserts.push(rendered);
        else failed.add(section.ref);
      }
    }
    if (failed.size === 0) return { plan, inserts };
    for (const ref of failed) warnings.push(`Section "${ref}" could not be rendered; the kit covers it instead.`);
    const fixed: BuildOnBrandPlan = {
      ...plan,
      pages: plan.pages.map((page) => ({
        ...page,
        sections: page.sections.map((section) => (section.ref && failed.has(section.ref) ? { role: section.role, source: 'kit' as const } : section)),
      })),
    };
    return { plan: fixed, inserts };
  };

  const fail = (res: Response, error: unknown) => {
    if (error instanceof Refusal) {
      sendApiError(res, error.status, error.code, error.message, error.details ? { details: error.details } : undefined);
      return;
    }
    console.error('[build-on-brand] failed', error);
    sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : 'build on brand failed');
  };

  const warningsField = (warnings: string[]) => (warnings.length > 0 ? { warnings: warnings.slice(0, 20).map((w) => w.slice(0, 500)) } : {});

  /** The brief's project must be an empty first-draft project on the same kit; then resolve the brief. */
  const bindDesignBrief = async (binding: BuildOnBrandDesignBrief, kitId: string) => {
    const project = await deps.readBuildProject(binding.projectId);
    if (!project) throw new Refusal(404, 'PROJECT_NOT_FOUND', 'The project that holds this design brief does not exist.');
    if (project.intent !== 'build-on-brand' || project.designSystemId !== kitId || project.hasPages) {
      throw new Refusal(409, 'CONFLICT', 'The design brief belongs to a project that is not an empty first draft on this kit. Make a new first-draft project and improve the prompt there.');
    }
    let designBrief: DesignBrief;
    try {
      designBrief = await deps.resolveDesignBrief(binding);
    } catch (error) {
      const failure = error as { status?: unknown; code?: unknown; message?: unknown };
      if (typeof failure.status === 'number' && typeof failure.code === 'string') {
        throw new Refusal(failure.status, failure.code, String(failure.message ?? 'design brief refused'));
      }
      throw error;
    }
    return { projectId: binding.projectId, designBrief };
  };

  app.post('/api/build-on-brand/project', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const parsed = buildOnBrandProjectRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new Refusal(400, 'BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid request');
      const kit = await resolveKit(parsed.data.designSystemId);
      const created = await deps.createEmptyProject({
        req,
        name: parsed.data.name ?? projectNameOf(parsed.data.brief ?? ''),
        designSystemId: kit.summary.id,
      });
      res.status(201).json({ projectId: created.projectId });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/build-on-brand/plan', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const { plan, warnings } = await prepare(req.body, false);
      res.status(200).json({ plan, ...warningsField(warnings) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/build-on-brand', async (req, res) => {
    if (!requireLocalOrigin(req, res)) return;
    try {
      const { request, kit, agent, plan, inserts, warnings } = await prepare(req.body, true);
      const bound = request.designBrief ? await bindDesignBrief(request.designBrief, kit.summary.id) : null;
      const brief = request.brief?.trim() ?? '';
      const stageInput = {
        brief,
        plan,
        ...(kit.summary.title ? { kitTitle: kit.summary.title } : {}),
        tokensCss: kit.assets.tokensCss,
        inserts,
        warnings,
        ...(request.route ? { route: request.route } : {}),
      };
      const started = await deps.createProjectAndRun({
        req,
        name: request.name ?? projectNameOf(brief),
        designSystemId: kit.summary.id,
        agentId: agent!.agentId,
        ...(request.model ? { model: request.model } : {}),
        message: runMessage(stageInput),
        files: stagedFiles(stageInput),
        ...(bound ? { projectId: bound.projectId, designBrief: bound.designBrief } : {}),
      });
      res.status(202).json({ ...started, plan, ...warningsField(warnings) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/projects/:id/site-check', async (req, res) => {
    try {
      const projectId = String(req.params.id ?? '');
      if (!await deps.authorizeProjectRequest(req, res, projectId, { mode: 'read' })) return;
      const files = await deps.readSiteFiles(projectId);
      if (!files) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      res.status(200).json(checkBuiltSite(files));
    } catch (error) {
      fail(res, error);
    }
  });
}

/** A short project name from the brief's first line. */
export function projectNameOf(brief: string): string {
  const first = brief.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? '';
  const clipped = first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
  return clipped ? `First draft · ${clipped}` : 'First draft';
}

/**
 * A response body as text, reading no more than `maxBytes`: a reference host cannot make the
 * daemon buffer an unbounded body. Over the cap the read stops and `null` is returned.
 */
export async function readCappedText(response: globalThis.Response, maxBytes = REFERENCE_MAX_BYTES): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
