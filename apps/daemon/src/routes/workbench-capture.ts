import type { Express, Request, Response } from 'express';
import {
  captureImportMetadataSchema, unitInsertRequestSchema, unitUndoInsertRequestSchema, unitSaveRequestSchema, createCaptureDraftRequestSchema,
  WORKBENCH_CAPTURE_MAX_BYTES, WORKBENCH_CAPTURE_MEDIA_TYPES, WORKBENCH_CAPTURE_METADATA_HEADER, WORKBENCH_CAPTURE_METADATA_MAX_BYTES,
  type WorkbenchDeclarationSurface,
} from '@mish/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { requestWithWorkspaceNavigationScope, resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { validateLocalDaemonRequest } from '../http/local-daemon-request.js';
import { ProjectContextError } from '../workbench/project-context.js';
import { CaptureError, type CaptureService } from '../workbench/capture/capture-service.js';
import { mapPlacementFailure } from '../workbench/placement/runtime-status.js';
import { UnitInsertInterrupted, UnitInsertEditedConflict } from '../workbench/units/unit-insert.js';
import { UnitError, type UnitService } from '../workbench/units/unit-service.js';
import { CaptureDraftError, type CaptureDraftService } from '../workbench/capture/draft-service.js';

export interface RegisterWorkbenchCaptureRoutesDeps {
  http: Pick<RouteDeps<'http'>['http'], 'sendApiError'>;
  authorizeProjectRequest: AuthorizeProjectRequest;
  /** Throws ProjectContextError(403) for an unknown project, like the context routes. */
  assertProject(projectId: string): void;
  captures: CaptureService;
  units: UnitService;
  drafts?: CaptureDraftService;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;
const CODE_BY_STATUS: Record<number, string> = { 400: 'BAD_REQUEST', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 410: 'NOT_FOUND', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'VALIDATION_FAILED' };
/** Served bytes are inert: never sniffed, never scripted, never framed by the app origin. */
const INERT_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, no-store',
};

class BodyTooLarge extends Error {}

/**
 * Where a declaration was written. `od` sends `x-od-client: cli`; the web app's
 * same-origin fetches carry `sec-fetch-site: same-origin`. A label from request
 * metadata, recorded so a write is visible, never authentication.
 */
export function declarationSurface(req: Request): WorkbenchDeclarationSurface {
  if (String(req.get('x-od-client') ?? '').toLowerCase() === 'cli') return 'cli';
  if (req.get('sec-fetch-site') === 'same-origin') return 'web';
  return 'http';
}
/** The parse-failure shape both contract schemas report. */
interface SchemaFailure { issues: Array<{ code: string; path: PropertyKey[]; message: string }> }

async function readRawBody(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) { req.resume(); throw new BodyTooLarge(); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) { req.resume(); throw new BodyTooLarge(); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * AC-R14.1 capture save/resume and AC-R14.3 reusable-unit plan/save. The web
 * panels and `od workbench capture|unit` call exactly these endpoints.
 */
export function registerWorkbenchCaptureRoutes(app: Express, deps: RegisterWorkbenchCaptureRoutesDeps): void {
  const fail = (res: Response, status: number, reason: string, message: string, extra: Record<string, unknown> = {}) =>
    deps.http.sendApiError(res, status, CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR', message, { details: { reason, ...extra } });
  const deny = (res: Response) => deps.http.sendApiError(res, 403, 'FORBIDDEN', 'Project scope is not authorized');

  async function projectScope(req: Request, res: Response, write: boolean, primary: unknown, navigation = false): Promise<string | null> {
    const values = [primary, req.query.projectId, req.get('x-od-project-id')].filter(value => value !== undefined);
    if (typeof primary !== 'string' || values.some(value => typeof value !== 'string' || !value || value.trim() !== value || /\p{Cc}/u.test(value)) || new Set(values).size !== 1) {
      fail(res, 400, 'project-scope-mismatch', 'Pass one matching project scope'); return null;
    }
    const workspace = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!workspace.ok) { deps.http.sendApiError(res, workspace.status, workspace.code, workspace.message); return null; }
    const safeResponse = { req, status() { return safeResponse; }, json() { return deny(res); } } as unknown as Response;
    if (!await deps.authorizeProjectRequest(req, safeResponse, primary, write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read', ...(navigation ? { allowNavigationQuery: true } : {}) })) return null;
    deps.assertProject(primary);
    return primary;
  }

  /** Units belong to a principal, not a project: the local daemon user or the claimed workspace member. */
  function principal(req: Request, res: Response, navigation = false): string | null {
    const local = validateLocalDaemonRequest(req);
    if (!local.ok) { deps.http.sendApiError(res, 403, 'FORBIDDEN', local.message); return null; }
    // An <img> cannot send headers; its workspace identity travels in the query.
    const scoped = navigation ? requestWithWorkspaceNavigationScope(req) : req;
    if (scoped === 'conflict') { fail(res, 400, 'workspace-scope-conflict', 'Workspace query and headers disagree'); return null; }
    const workspace = resolveOptionalLocalWorkspaceRequestAuthority(scoped);
    if (!workspace.ok) { deps.http.sendApiError(res, workspace.status, workspace.code, workspace.message); return null; }
    return workspace.context ? `workspace:${workspace.context.workspaceId}:${workspace.context.workspaceMemberId}` : 'local-daemon';
  }

  function handle(res: Response, error: unknown, extra: Record<string, unknown> = {}): void {
    if (error instanceof UnitInsertInterrupted) { handle(res, error.failure, { insertion: error.receipt }); return; }
    const placement = mapPlacementFailure(error);
    if (placement) { deps.http.sendApiError(res, placement.status, placement.code, placement.message, { details: { ...placement.details, ...extra }, retryable: Object.keys(extra).length ? false : placement.retryable }); return; }
    if (error instanceof ProjectContextError) deps.http.sendApiError(res, error.status, error.code, error.message);
    else if (error instanceof CaptureError) fail(res, error.status, error.code, error.message);
    else if (error instanceof CaptureDraftError) fail(res, error.status, error.code, error.message);
    else if (error instanceof UnitError) fail(res, error.status, error.code, error.message, { ...extra, ...(error.paths.length ? { paths: error.paths, ...(error instanceof UnitInsertEditedConflict ? { discardEditsAllowed: true } : {}) } : {}) });
    else deps.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Unable to complete the workbench capture request', Object.keys(extra).length ? { details: { reason: 'insert-incomplete', ...extra } } : {});
  }
  /** Shape errors are 400; a well-formed capture whose geometry contradicts itself is 422. */
  function invalid(res: Response, error: SchemaFailure, defaultReason: string): void {
    const fields = error.issues.slice(0, 50).map(issue => ({ path: issue.path.join('.'), message: issue.message.slice(0, 300) }));
    const geometry = error.issues.every(issue => issue.code === 'custom' && (issue.path[0] === 'region' || issue.path[0] === 'viewport'));
    if (geometry && error.issues.length) {
      const first = error.issues[0]!;
      fail(res, 422, first.path[0] === 'region' ? 'region-out-of-bounds' : 'viewport-required', first.message, { fields });
    } else fail(res, 400, defaultReason, 'The request does not match the contract', { fields });
  }
  /**
   * Rights are the user's to declare. A request carrying any Authorization
   * credential (an agent run's OD_TOOL_TOKEN bearer, or a deployment token) may
   * not record one. This stops cooperative agents; it is not a boundary against
   * a same-user process that calls loopback without a token, which is why every
   * declaration also records its surface.
   */
  const refuseAgentDeclaration = (req: Request, res: Response): boolean => {
    if (req.get('authorization') === undefined) return false;
    fail(res, 403, 'agent-declaration-refused', 'A rights declaration is recorded only from the web app or od run by you, never with an agent tool token');
    return true;
  };
  const key = (req: Request, res: Response): string | null => {
    const value = req.get('idempotency-key');
    if (!value || !IDEMPOTENCY_KEY.test(value)) { fail(res, 400, 'idempotency-key-required', 'Pass an Idempotency-Key header (letters, digits, . _ : -; up to 200)'); return null; }
    return value;
  };

  // ---- Captures (AC-R14.1) -------------------------------------------------

  app.post('/api/workbench/captures', async (req, res) => {
    try {
      const mediaType = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!(WORKBENCH_CAPTURE_MEDIA_TYPES as readonly string[]).includes(mediaType)) { req.resume(); fail(res, 415, 'unsupported-capture-type', 'A capture is a PNG, JPEG or WebP image'); return; }
      const header = req.get(WORKBENCH_CAPTURE_METADATA_HEADER) ?? '';
      if (!header || header.length > WORKBENCH_CAPTURE_METADATA_MAX_BYTES * 2) { req.resume(); fail(res, 400, 'capture-metadata-required', `Pass capture metadata as base64url JSON in ${WORKBENCH_CAPTURE_METADATA_HEADER}`); return; }
      let raw: unknown;
      try { raw = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { req.resume(); fail(res, 400, 'capture-metadata-invalid', 'Capture metadata is not base64url JSON'); return; }
      const parsed = captureImportMetadataSchema.safeParse(raw);
      if (!parsed.success) { req.resume(); invalid(res, parsed.error, 'invalid-capture-metadata'); return; }
      if (parsed.data.rightsDeclaration && refuseAgentDeclaration(req, res)) { req.resume(); return; }
      const projectId = await projectScope(req, res, true, parsed.data.projectId); if (!projectId) { req.resume(); return; }
      const idempotencyKey = key(req, res); if (!idempotencyKey) { req.resume(); return; }
      let body: Buffer;
      try { body = await readRawBody(req, WORKBENCH_CAPTURE_MAX_BYTES); } catch (error) {
        if (error instanceof BodyTooLarge) { fail(res, 413, 'capture-too-large', `A capture is at most ${WORKBENCH_CAPTURE_MAX_BYTES} bytes`); return; }
        throw error;
      }
      const result = await deps.captures.import({ metadata: parsed.data, body, mediaType, idempotencyKey, surface: declarationSurface(req) });
      res.status(result.created ? 201 : 200).json(result.view);
    } catch (error) { handle(res, error); }
  });

  app.get('/api/workbench/captures', async (req, res) => {
    try {
      const projectId = await projectScope(req, res, false, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      res.json(await deps.captures.list(projectId, cursor));
    } catch (error) { handle(res, error); }
  });

  app.get('/api/workbench/captures/:captureId', async (req, res) => {
    try {
      const projectId = await projectScope(req, res, false, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      res.json(await deps.captures.show(projectId, String(req.params.captureId)));
    } catch (error) { handle(res, error); }
  });

  app.get('/api/workbench/captures/:captureId/image', async (req, res) => {
    try {
      // An <img> cannot send headers: project and workspace authority travel in the query.
      const projectId = await projectScope(req, res, false, req.query.projectId, true); if (!projectId) return;
      const { record, bytes } = await deps.captures.image(projectId, String(req.params.captureId));
      res.set({ ...INERT_HEADERS, 'Content-Type': record.image.mediaType, 'Content-Disposition': 'inline' }).send(bytes);
    } catch (error) { handle(res, error); }
  });

  // ---- Reusable units (AC-R14.3) -------------------------------------------

  async function unitRequest(req: Request, res: Response) {
    const owner = principal(req, res); if (!owner) return null;
    const parsed = unitSaveRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) { invalid(res, parsed.error, 'invalid-unit-request'); return null; }
    if (parsed.data.source.kind === 'project' && !await projectScope(req, res, false, parsed.data.source.projectId)) return null;
    if (parsed.data.source.kind === 'draft' && deps.drafts) {
      const projectId = await deps.drafts.projectId(owner, parsed.data.source.draftId, parsed.data.source.revision);
      if (!await projectScope(req, res, false, projectId)) return null;
    }
    return { owner, request: parsed.data };
  }

  app.post('/api/workbench/units/plan', async (req, res) => {
    try {
      const input = await unitRequest(req, res); if (!input) return;
      res.json(await deps.units.plan(input.request, input.owner, declarationSurface(req)));
    } catch (error) { handle(res, error); }
  });

  app.post('/api/workbench/units', async (req, res) => {
    try {
      const input = await unitRequest(req, res); if (!input) return;
      if (input.request.rightsDeclaration && refuseAgentDeclaration(req, res)) return;
      const idempotencyKey = key(req, res); if (!idempotencyKey) return;
      const result = await deps.units.save(input.request, input.owner, idempotencyKey, declarationSurface(req));
      res.status(result.created ? 201 : 200).json(result.manifest);
    } catch (error) { handle(res, error); }
  });

  // AC-R14.4: authorise the destination write; saved units belong to the principal.
  app.post('/api/workbench/units/:unitId/insert', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const parsed = unitInsertRequestSchema.safeParse(req.body);
      if (!parsed.success) { invalid(res, parsed.error, 'invalid-unit-insert'); return; }
      if (!await projectScope(req, res, true, parsed.data.projectId)) return;
      const idempotencyKey = key(req, res); if (!idempotencyKey) return;
      const result = await deps.units.insert(owner, String(req.params.unitId), parsed.data, idempotencyKey);
      res.status(result.created ? 201 : 200).json(result.receipt);
    } catch (error) { handle(res, error); }
  });
  app.get('/api/workbench/units/:unitId/inserts', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const unit = await deps.units.show(owner, String(req.params.unitId));
      const found = await deps.units.listInsertions(owner, unit.unitId);
      const insertions = [];
      for (const receipt of found) {
        // A receipt is returned only while this principal can read its target. Suppress denied-target metadata.
        const safeResponse = { req, status() { return safeResponse; }, json() { return undefined; } } as unknown as Response;
        if (await deps.authorizeProjectRequest(req, safeResponse, receipt.projectId, { mode: 'read' })) insertions.push(receipt);
      }
      res.json({ insertions });
    } catch (error) { handle(res, error); }
  });
  app.get('/api/workbench/unit-inserts/:insertId', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const receipt = await deps.units.insertion(owner, String(req.params.insertId));
      if (!await projectScope(req, res, false, receipt.projectId)) return;
      res.json(receipt);
    } catch (error) { handle(res, error); }
  });
  app.post('/api/workbench/unit-inserts/:insertId/undo', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const receipt = await deps.units.insertion(owner, String(req.params.insertId));
      if (!await projectScope(req, res, true, receipt.projectId)) return;
      const parsed = unitUndoInsertRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) { invalid(res, parsed.error, 'invalid-unit-undo'); return; }
      res.json(await deps.units.undoInsert(owner, receipt.insertId, parsed.data));
    } catch (error) { handle(res, error); }
  });

  app.get('/api/workbench/units', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      res.json({ units: await deps.units.list(owner) });
    } catch (error) { handle(res, error); }
  });

  app.get('/api/workbench/units/:unitId', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      res.json(await deps.units.show(owner, String(req.params.unitId)));
    } catch (error) { handle(res, error); }
  });

  app.get('/api/workbench/units/:unitId/thumbnail', async (req, res) => {
    try {
      const owner = principal(req, res, true); if (!owner) return;
      res.set({ ...INERT_HEADERS, 'Content-Type': 'image/png', 'Content-Disposition': 'inline' }).send(await deps.units.thumbnail(owner, String(req.params.unitId)));
    } catch (error) { handle(res, error); }
  });

  // Stored unit source is returned as text for review and editing; it is never
  // served as an executable document from the app origin.
  app.get('/api/workbench/units/:unitId/files/*file', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const segments = (req.params as { file?: unknown }).file;
      const relPath = Array.isArray(segments) ? segments.join('/') : String(segments ?? '');
      const { bytes, mediaType } = await deps.units.file(owner, String(req.params.unitId), relPath);
      const text = mediaType.startsWith('text/');
      res.set({ ...INERT_HEADERS, 'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream', 'Content-Disposition': text ? 'inline' : 'attachment' }).send(bytes);
    } catch (error) { handle(res, error); }
  });

  // ---- Capture draft revisions (AC-R14.2) ---------------------------------
  app.post('/api/workbench/capture-drafts', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const parsed = createCaptureDraftRequestSchema.safeParse(req.body);
      if (!parsed.success) { invalid(res, parsed.error, 'invalid-draft-request'); return; }
      const projectId = await projectScope(req, res, true, parsed.data.projectId); if (!projectId) return;
      const idempotencyKey = key(req, res); if (!idempotencyKey) return;
      if (!deps.drafts) { fail(res, 422, 'unsupported-capability', 'Capture drafts are unavailable'); return; }
      const result = await deps.drafts.create(owner, parsed.data, idempotencyKey);
      res.set('Cache-Control', 'private, no-store').status(result.created ? 202 : 200).json(result.draft);
    } catch (error) { handle(res, error); }
  });
  app.get('/api/workbench/capture-drafts', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const projectId = await projectScope(req, res, false, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      if (!deps.drafts) { fail(res, 422, 'unsupported-capability', 'Capture drafts are unavailable'); return; }
      res.set('Cache-Control', 'private, no-store').json(await deps.drafts.list(owner, projectId));
    } catch (error) { handle(res, error); }
  });
  app.get('/api/workbench/capture-drafts/:draftId/revisions/:revision', async (req, res) => {
    try {
      const owner = principal(req, res); if (!owner) return;
      const projectId = await projectScope(req, res, false, req.query.projectId ?? req.get('x-od-project-id')); if (!projectId) return;
      const revision = Number(req.params.revision);
      if (!/^[1-9][0-9]*$/u.test(String(req.params.revision)) || !Number.isSafeInteger(revision)) { fail(res, 400, 'invalid-draft-revision', 'Pass a positive integer revision'); return; }
      if (!deps.drafts) { fail(res, 422, 'unsupported-capability', 'Capture drafts are unavailable'); return; }
      res.set('Cache-Control', 'private, no-store').json(await deps.drafts.read(owner, projectId, String(req.params.draftId), revision));
    } catch (error) { handle(res, error); }
  });
}
